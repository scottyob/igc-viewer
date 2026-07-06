import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import type { BufferAttribute, InterleavedBufferAttribute, Material, Quaternion } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute } from 'three/tsl';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { Line2NodeMaterial } from 'three/webgpu';
import type { GlobeControls } from '3d-tiles-renderer';
import { llaToECEF, parseIGC, parseFlightDate, parsePilotName, parseGliderType, parseTimezoneOffset, atLocalEvening } from './igc';
import type { FlightTrack, IGCPoint, TailMode, TrailLengthMode } from './types';

const PERSON_COLORS = [
  new Color(0x00e676),
  new Color(0x448aff),
  new Color(0xff6d00),
  new Color(0xd500f9),
  new Color(0x00e5ff),
  new Color(0xff1744),
  new Color(0x76ff03),
  new Color(0xffea00),
];

const C_SINK  = new Color(0xff1744);
const C_ZERO  = new Color(0xffeb3b);
const C_CLIMB = new Color(0x00e676);

function climbRateColor(rateMps: number): Color {
  const t = (Math.max(-5, Math.min(5, rateMps)) + 5) / 10;
  if (t < 0.5) return C_SINK.clone().lerp(C_ZERO, t * 2);
  return C_ZERO.clone().lerp(C_CLIMB, (t - 0.5) * 2);
}

function trailLengthSecondsFor(mode: TrailLengthMode): number | null {
  if (mode === '10m') return 600;
  if (mode === '5m') return 300;
  if (mode === '30s') return 30;
  return null;
}

// Smallest index i such that pts[i].time >= time (lower bound), clamped to the array.
function findFirstIndexAtOrAfter(pts: IGCPoint[], time: number): number {
  if (time <= pts[0].time) return 0;
  if (time > pts[pts.length - 1].time) return pts.length - 1;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].time < time) lo = mid + 1; else hi = mid;
  }
  return lo;
}

let nextPilotIndex = 0;
let nextTrackId = 1;

export interface TrackManagerOptions {
  onTrackSelected: (track: FlightTrack | null, initialDate: Date | null) => void;
  getGroundElevation: (lat: number, lon: number, altHint: number) => number | null;
}

const CURTAIN_SECONDS = 30;
const CURTAIN_SAMPLES = 32;
const CURTAIN_VERTICES_PER_SEGMENT = 6;
const CURTAIN_MAX_VERTICES = (CURTAIN_SAMPLES - 1) * CURTAIN_VERTICES_PER_SEGMENT;
const CURTAIN_GROUND_LOOKUPS_PER_FRAME = 4;
const CURTAIN_NULL_GROUND_RETRY_MS = 1500;
const CURTAIN_GROUND_EXTENSION_METERS = 80;

type CurtainSample = { time: number; lat: number; lon: number; alt: number };
type LoadedTrack = {
  track: FlightTrack;
  initialDate: Date;
  line: Line2;
  curtain: Mesh;
  ecefPositions: Float32Array;
  personColors: Float32Array;
  climbColors: Float32Array;
  color: Color;
  dynamicSegmentIndex: number | null;
  windowActive: boolean;
  // Stable references to LineGeometry's own attributes. Windowed trails rewrite
  // the first N instances in place so WebGPU keeps reading the updated data.
  fullStartAttr: BufferAttribute | InterleavedBufferAttribute;
  fullEndAttr: BufferAttribute | InterleavedBufferAttribute;
};

const PILOT_FLY_MIN_DISTANCE = 650;
const PILOT_FLY_MAX_DISTANCE = 2200;
const PILOT_INITIAL_FOCUS_DISTANCE = 6000;
const PILOT_FLY_TERRAIN_SAMPLES = 16;
const PILOT_FLY_PATH_SAMPLES = 4;
const PILOT_FLY_DIRECT_MS = 900;
const PILOT_FLY_UNKNOWN_TERRAIN_CLEARANCE = 450;
const PILOT_FLY_KNOWN_TERRAIN_CLEARANCE = 180;
const TRACKING_FOLLOW_STIFFNESS = 3.8;
const TRACKING_ORBIT_RADIANS_PER_PIXEL = 0.006;
const TRACKING_ELEVATION_RADIANS_PER_PIXEL = 0.004;
const TRACKING_MIN_ELEVATION = 3 * Math.PI / 180;
const TRACKING_MAX_ELEVATION = 72 * Math.PI / 180;
const TRACKING_MIN_HORIZONTAL_DISTANCE = 80;
const TRACKING_MIN_DISTANCE = 180;
const TRACKING_MAX_DISTANCE = PILOT_INITIAL_FOCUS_DISTANCE;
const TRACKING_ZOOM_WHEEL_SCALE = 0.0012;

type PilotFocusTarget = {
  position: Vector3;
  quaternion: Quaternion;
  up: Vector3;
  lookAt: Vector3;
  angle: number;
  // Camera-to-pilot orbit radius, not ground-plane distance.
  distance: number;
  elevation: number;
};

export function createTrackManager(
  scene: Scene,
  camera: PerspectiveCamera,
  controls: GlobeControls,
  options: TrackManagerOptions,
) {
  const { onTrackSelected, getGroundElevation } = options;
  const loadedTracks: LoadedTrack[] = [];
  let activeTrack: LoadedTrack | null = null;
  let flyAnimId: number | null = null;
  let resetAnimId: number | null = null;
  let trackingEnabled = false;
  let trackingAngle: number | null = null;
  let trackingDistance: number | null = null;
  let trackingElevation: number | null = null;
  let trackingLastUpdateTs = -1;
  let tailMode: TailMode = 'person';
  let trailLengthMode: TrailLengthMode = '10m';
  let fullTrailForSelected = false;
  let activePilotGroundElevation: number | null = null;
  let activePilotGroundSeconds = -Infinity;
  const curtainGroundCache = new Map<string, { alt: number | null; checkedAt: number }>();

  controls.addEventListener('start', () => {
    if (flyAnimId !== null) {
      cancelAnimationFrame(flyAnimId);
      flyAnimId = null;
      controls.enabled = !trackingEnabled;
    }
  });

  function disposeLoadedTrack(item: LoadedTrack): void {
    scene.remove(item.line);
    item.line.geometry.dispose();
    (item.line.material as Material).dispose();
    scene.remove(item.curtain);
    item.curtain.geometry.dispose();
    (item.curtain.material as Material).dispose();
  }

  function clearTracks(): void {
    for (const item of loadedTracks) disposeLoadedTrack(item);
    loadedTracks.length = 0;
    activeTrack = null;
    curtainGroundCache.clear();
    activePilotGroundElevation = null;
    activePilotGroundSeconds = -Infinity;
  }

  function localBasis(lat: number, lon: number) {
    const target = llaToECEF(lat, lon, 0);
    const up = target.clone().normalize();
    const northPole = new Vector3(0, 0, 1);
    let north = northPole.clone().sub(up.clone().multiplyScalar(northPole.dot(up)));
    if (north.lengthSq() < 1e-8) north.set(1, 0, 0);
    north.normalize();
    const east = new Vector3().crossVectors(north, up).normalize();
    return { up, north, east };
  }

  function offsetLatLon(lat: number, lon: number, eastMeters: number, northMeters: number): { lat: number; lon: number } {
    const metersPerDegLat = 111_000;
    const metersPerDegLon = metersPerDegLat * Math.max(0.2, Math.cos(lat * Math.PI / 180));
    return {
      lat: lat + northMeters / metersPerDegLat,
      lon: lon + eastMeters / metersPerDegLon,
    };
  }

  function clampTrackingElevation(elevation: number): number {
    return Math.max(TRACKING_MIN_ELEVATION, Math.min(TRACKING_MAX_ELEVATION, elevation));
  }

  function chooseOpenCameraAngle(pilot: { lat: number; lon: number; alt: number }, distance: number): number {
    let bestAngle = 0;
    let bestScore = Infinity;

    for (let i = 0; i < PILOT_FLY_TERRAIN_SAMPLES; i++) {
      const angle = (i / PILOT_FLY_TERRAIN_SAMPLES) * Math.PI * 2;
      const eastDir = Math.cos(angle);
      const northDir = Math.sin(angle);
      let maxTerrain = -Infinity;

      for (let s = 1; s <= PILOT_FLY_PATH_SAMPLES; s++) {
        const d = (distance * s) / PILOT_FLY_PATH_SAMPLES;
        const p = offsetLatLon(pilot.lat, pilot.lon, eastDir * d, northDir * d);
        const terrainAlt = getGroundElevation(p.lat, p.lon, pilot.alt) ?? pilot.alt;
        if (terrainAlt > maxTerrain) maxTerrain = terrainAlt;
      }

      if (maxTerrain < bestScore) {
        bestScore = maxTerrain;
        bestAngle = angle;
      }
    }

    return bestAngle;
  }

  function getPilotFocusTarget(
    track: FlightTrack,
    seconds: number,
    angleOverride: number | null = null,
    distanceOverride: number | null = null,
    elevationOverride: number | null = null,
    groundElevationOverride: number | null = null,
    distanceMultiplier = 1,
  ): PilotFocusTarget | null {
    const pilot = getPilotPositionForTrack(track, seconds, true);
    if (!pilot) return null;
    const pilotPos = pilot;

    const cachedActiveGroundAlt = track === activeTrack?.track
      && activePilotGroundElevation !== null
      && Math.abs(seconds - activePilotGroundSeconds) <= 1.5
      ? activePilotGroundElevation
      : null;
    const sampledGroundAlt = groundElevationOverride ?? cachedActiveGroundAlt ?? getGroundElevation(pilotPos.lat, pilotPos.lon, pilotPos.alt);
    const terrainKnown = sampledGroundAlt !== null;
    const groundAlt = sampledGroundAlt ?? Math.max(0, pilotPos.alt - 100);
    const agl = Math.max(0, pilotPos.alt - groundAlt);
    const baseHorizontalDistance = Math.max(PILOT_FLY_MIN_DISTANCE, Math.min(PILOT_FLY_MAX_DISTANCE, agl * 0.85 + 650));
    const fallbackHorizontalDistance = baseHorizontalDistance * distanceMultiplier;
    const requestedElevation = elevationOverride === null ? null : clampTrackingElevation(elevationOverride);
    const requestedOrbitDistance = distanceOverride ?? fallbackHorizontalDistance;
    const terrainSampleDistance = requestedElevation === null
      ? fallbackHorizontalDistance
      : Math.max(TRACKING_MIN_HORIZONTAL_DISTANCE, requestedOrbitDistance * Math.cos(requestedElevation));
    const angle = angleOverride ?? chooseOpenCameraAngle(pilotPos, terrainSampleDistance);
    const { up, north, east } = localBasis(pilotPos.lat, pilotPos.lon);
    const lookAtPos = llaToECEF(pilotPos.lat, pilotPos.lon, pilotPos.alt);
    const scratch = new PerspectiveCamera(camera.fov, camera.aspect, camera.near, camera.far);

    const dir = east.clone().multiplyScalar(Math.cos(angle)).addScaledVector(north, Math.sin(angle)).normalize();
    const sample = offsetLatLon(pilotPos.lat, pilotPos.lon, Math.cos(angle) * terrainSampleDistance, Math.sin(angle) * terrainSampleDistance);
    const sampledTerrainAlt = getGroundElevation(sample.lat, sample.lon, pilotPos.alt);
    const terrainAlt = sampledTerrainAlt ?? Math.max(groundAlt, pilotPos.alt);
    const terrainClearance = terrainKnown && sampledTerrainAlt !== null
      ? PILOT_FLY_KNOWN_TERRAIN_CLEARANCE
      : PILOT_FLY_UNKNOWN_TERRAIN_CLEARANCE;
    const minVerticalOffset = Math.max(80, terrainAlt + terrainClearance - pilotPos.alt);
    const baseVerticalOffset = Math.max(180, minVerticalOffset);
    let horizontalDistance: number;
    let verticalOffset: number;
    let orbitDistance: number;

    if (requestedElevation === null) {
      horizontalDistance = fallbackHorizontalDistance;
      const baseElevation = clampTrackingElevation(Math.atan2(baseVerticalOffset, horizontalDistance));
      verticalOffset = Math.max(baseVerticalOffset, horizontalDistance * Math.tan(baseElevation));
      orbitDistance = Math.hypot(horizontalDistance, verticalOffset);
    } else {
      orbitDistance = requestedOrbitDistance;
      verticalOffset = Math.max(minVerticalOffset, orbitDistance * Math.sin(requestedElevation));
      horizontalDistance = Math.sqrt(Math.max(0, orbitDistance ** 2 - verticalOffset ** 2));
      horizontalDistance = Math.max(TRACKING_MIN_HORIZONTAL_DISTANCE, horizontalDistance);
      orbitDistance = Math.hypot(horizontalDistance, verticalOffset);
    }

    const targetPos = lookAtPos
      .clone()
      .add(dir.multiplyScalar(horizontalDistance))
      .add(up.clone().multiplyScalar(verticalOffset));

    scratch.position.copy(targetPos);
    scratch.up.copy(up);
    scratch.lookAt(lookAtPos);
    scratch.updateMatrixWorld();
    return {
      position: targetPos,
      quaternion: scratch.quaternion.clone(),
      up,
      lookAt: lookAtPos,
      angle,
      distance: Math.max(TRACKING_MIN_DISTANCE, Math.min(TRACKING_MAX_DISTANCE, orbitDistance)),
      elevation: clampTrackingElevation(Math.atan2(verticalOffset, horizontalDistance)),
    };
  }

  function animateToFocusTarget(target: PilotFocusTarget, keepControlsDisabled = false): void {
    if (flyAnimId !== null) {
      cancelAnimationFrame(flyAnimId);
      flyAnimId = null;
    }

    const startPos = camera.position.clone();
    const startQuat = camera.quaternion.clone();
    const t0 = performance.now();
    controls.enabled = false;

    function step() {
      const raw = Math.min((performance.now() - t0) / PILOT_FLY_DIRECT_MS, 1);
      const ease = raw < 0.5 ? 4 * raw ** 3 : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      camera.position.copy(startPos.clone().lerp(target.position, ease));
      camera.up.copy(target.up);
      camera.quaternion.slerpQuaternions(startQuat, target.quaternion, ease);
      camera.updateMatrixWorld();

      if (raw < 1) {
        flyAnimId = requestAnimationFrame(step);
      } else {
        flyAnimId = null;
        controls.enabled = !keepControlsDisabled;
        controls.adjustHeight = true;
      }
    }
    flyAnimId = requestAnimationFrame(step);
  }

  function focusPilot(track: FlightTrack, seconds: number): void {
    if (resetAnimId !== null) { cancelAnimationFrame(resetAnimId); resetAnimId = null; }
    if (flyAnimId !== null) { cancelAnimationFrame(flyAnimId); flyAnimId = null; }

    const target = getPilotFocusTarget(track, seconds, null, PILOT_INITIAL_FOCUS_DISTANCE, TRACKING_MIN_ELEVATION);
    if (!target) return;
    animateToFocusTarget(target, trackingEnabled);
  }

  function syncTrackingFromCamera(seconds: number): void {
    if (!activeTrack) return;
    const pilot = getPilotPositionForTrack(activeTrack.track, seconds, true);
    if (!pilot) return;

    const { up, east, north } = localBasis(pilot.lat, pilot.lon);
    const lookAt = llaToECEF(pilot.lat, pilot.lon, pilot.alt);
    const offset = camera.position.clone().sub(lookAt);
    const eastOffset = offset.dot(east);
    const northOffset = offset.dot(north);
    const upOffset = offset.dot(up);
    const flatDistance = Math.hypot(eastOffset, northOffset);
    const orbitDistance = offset.length();

    if (flatDistance > 1) {
      trackingAngle = Math.atan2(northOffset, eastOffset);
      trackingDistance = Math.max(TRACKING_MIN_DISTANCE, Math.min(TRACKING_MAX_DISTANCE, orbitDistance));
      trackingElevation = clampTrackingElevation(Math.atan2(upOffset, flatDistance));
    }
  }

  function updateTrackingCamera(currentSeconds: number): void {
    if (!trackingEnabled || !activeTrack || flyAnimId !== null) return;

    const target = getPilotFocusTarget(
      activeTrack.track,
      currentSeconds,
      trackingAngle,
      trackingDistance,
      trackingElevation,
    );
    if (!target) return;

    trackingAngle = target.angle;
    trackingDistance = target.distance;
    const now = performance.now();
    const dt = trackingLastUpdateTs >= 0 ? Math.min((now - trackingLastUpdateTs) / 1000, 0.12) : 1 / 60;
    trackingLastUpdateTs = now;
    const alpha = 1 - Math.exp(-TRACKING_FOLLOW_STIFFNESS * dt);

    controls.enabled = false;
    camera.position.lerp(target.position, alpha);
    camera.up.copy(target.up);
    camera.quaternion.slerp(target.quaternion, alpha);
    camera.updateMatrixWorld();
  }

  function setTracking(
    enabled: boolean,
    seconds = activeTrack?.track.start ?? 0,
    groundElevation: number | null = null,
  ): boolean {
    if (enabled && !activeTrack) return false;
    trackingLastUpdateTs = -1;
    const preserveTrackingView = trackingEnabled;

    if (!enabled) {
      trackingEnabled = false;
      trackingAngle = null;
      trackingDistance = null;
      trackingElevation = null;
      if (flyAnimId !== null) {
        cancelAnimationFrame(flyAnimId);
        flyAnimId = null;
      }
      controls.enabled = true;
      controls.adjustHeight = true;
      return true;
    }

    const target = getPilotFocusTarget(
      activeTrack!.track,
      seconds,
      preserveTrackingView ? trackingAngle : null,
      preserveTrackingView ? trackingDistance : TRACKING_MAX_DISTANCE,
      preserveTrackingView ? trackingElevation : TRACKING_MIN_ELEVATION,
      groundElevation,
    );
    if (!target) return false;

    trackingEnabled = true;
    trackingAngle = target.angle;
    trackingDistance = target.distance;
    trackingElevation = target.elevation;
    controls.enabled = false;
    animateToFocusTarget(target, true);
    return true;
  }

  function beginTrackingOrbit(seconds: number): boolean {
    if (!trackingEnabled || !activeTrack) return false;
    if (flyAnimId !== null) {
      cancelAnimationFrame(flyAnimId);
      flyAnimId = null;
    }
    syncTrackingFromCamera(seconds);
    controls.enabled = false;
    return true;
  }

  function adjustTrackingOrbit(deltaXPixels: number, deltaYPixels = 0): void {
    if (!trackingEnabled || trackingAngle === null) return;
    trackingAngle -= deltaXPixels * TRACKING_ORBIT_RADIANS_PER_PIXEL;
    const currentElevation = trackingElevation ?? (25 * Math.PI / 180);
    trackingElevation = clampTrackingElevation(currentElevation + deltaYPixels * TRACKING_ELEVATION_RADIANS_PER_PIXEL);
  }

  function adjustTrackingZoom(deltaYPixels: number): void {
    if (!trackingEnabled) return;
    const currentDistance = trackingDistance ?? PILOT_FLY_MIN_DISTANCE;
    const nextDistance = currentDistance * Math.exp(deltaYPixels * TRACKING_ZOOM_WHEEL_SCALE);
    trackingDistance = Math.max(TRACKING_MIN_DISTANCE, Math.min(TRACKING_MAX_DISTANCE, nextDistance));
  }

  function endTrackingOrbit(): void {
    if (trackingEnabled) {
      trackingLastUpdateTs = -1;
      controls.enabled = false;
    }
  }

  function getPilotPositionForTrack(track: FlightTrack, seconds: number, clamp = false): { lat: number; lon: number; alt: number } | null {
    const pts = track.points;
    if (seconds < pts[0].time) return clamp ? { lat: pts[0].lat, lon: pts[0].lon, alt: pts[0].alt } : null;
    if (seconds > pts[pts.length - 1].time) {
      if (!clamp) return null;
      const last = pts[pts.length - 1];
      return { lat: last.lat, lon: last.lon, alt: last.alt };
    }
    if (seconds === pts[0].time) return { lat: pts[0].lat, lon: pts[0].lon, alt: pts[0].alt };
    if (seconds === pts[pts.length - 1].time) {
      const last = pts[pts.length - 1];
      return { lat: last.lat, lon: last.lon, alt: last.alt };
    }
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].time <= seconds) lo = mid; else hi = mid;
    }
    const dt = pts[hi].time - pts[lo].time;
    if (dt === 0) return { lat: pts[lo].lat, lon: pts[lo].lon, alt: pts[lo].alt };
    const t = (seconds - pts[lo].time) / dt;
    return {
      lat: pts[lo].lat + (pts[hi].lat - pts[lo].lat) * t,
      lon: pts[lo].lon + (pts[hi].lon - pts[lo].lon) * t,
      alt: pts[lo].alt + (pts[hi].alt - pts[lo].alt) * t,
    };
  }

  function getPilotPositionAt(seconds: number): { lat: number; lon: number; alt: number } | null {
    return activeTrack ? getPilotPositionForTrack(activeTrack.track, seconds, true) : null;
  }

  function getCurtainSamples(item: LoadedTrack, currentSeconds: number, pilotPos: { lat: number; lon: number; alt: number }): CurtainSample[] {
    const startSeconds = Math.max(item.track.start, currentSeconds - CURTAIN_SECONDS);
    const duration = currentSeconds - startSeconds;
    if (duration <= 0) return [{ time: currentSeconds, ...pilotPos }];

    const count = Math.max(2, Math.min(CURTAIN_SAMPLES, Math.ceil(duration) + 1));
    const samples: CurtainSample[] = [];

    for (let i = 0; i < count; i++) {
      const t = startSeconds + (duration * i) / (count - 1);
      const pos = i === count - 1 ? pilotPos : getPilotPositionForTrack(item.track, t);
      if (pos) samples.push({ time: t, ...pos });
    }

    return samples;
  }

  function getCurtainGroundElevation(
    trackId: string,
    sample: CurtainSample,
    currentSeconds: number,
    currentGroundElevation: number | null,
    now: number,
    budget: { remaining: number },
  ): number {
    const key = `${trackId}:${Math.round(sample.time)}`;
    const isCurrentSample = Math.abs(sample.time - currentSeconds) <= 0.5;

    if (isCurrentSample && currentGroundElevation !== null) {
      curtainGroundCache.set(key, { alt: currentGroundElevation, checkedAt: now });
      return currentGroundElevation;
    }

    const cached = curtainGroundCache.get(key);
    if (cached && (cached.alt !== null || now - cached.checkedAt < CURTAIN_NULL_GROUND_RETRY_MS)) {
      return cached.alt ?? 0;
    }

    if (budget.remaining <= 0) return cached?.alt ?? 0;
    budget.remaining--;

    const alt = getGroundElevation(sample.lat, sample.lon, sample.alt);
    curtainGroundCache.set(key, { alt, checkedAt: now });
    return alt ?? 0;
  }

  function curtainTopAltitude(sample: CurtainSample, groundAlt: number, currentSeconds: number): number {
    const age = Math.max(0, Math.min(CURTAIN_SECONDS, currentSeconds - sample.time));
    const recency = 1 - age / CURTAIN_SECONDS;
    return groundAlt + Math.max(0, sample.alt - groundAlt) * recency;
  }

  function curtainAlpha(sample: CurtainSample, currentSeconds: number): number {
    const age = Math.max(0, Math.min(CURTAIN_SECONDS, currentSeconds - sample.time));
    return Math.pow(1 - age / CURTAIN_SECONDS, 1.35) * 0.72;
  }

  function appendCurtainSegment(
    pos: Float32BufferAttribute,
    col: Float32BufferAttribute,
    alpha: Float32BufferAttribute,
    vertex: number,
    bottomA: Vector3,
    topA: Vector3,
    bottomB: Vector3,
    topB: Vector3,
    sampleAlphaA: number,
    sampleAlphaB: number,
    color: Color,
  ): number {
    const verts = [
      { p: bottomA, a: sampleAlphaA },
      { p: topA, a: 0 },
      { p: topB, a: 0 },
      { p: bottomA, a: sampleAlphaA },
      { p: topB, a: 0 },
      { p: bottomB, a: sampleAlphaB },
    ];

    for (const v of verts) {
      pos.setXYZ(vertex, v.p.x, v.p.y, v.p.z);
      col.setXYZ(vertex, color.r, color.g, color.b);
      alpha.setX(vertex, v.a);
      vertex++;
    }

    return vertex;
  }

  type LineInstanceAttribute = BufferAttribute | InterleavedBufferAttribute;

  function writeLineSegment(item: LoadedTrack, segmentIndex: number, start: Vector3, end: Vector3): void {
    item.fullStartAttr.setXYZ(segmentIndex, start.x, start.y, start.z);
    item.fullEndAttr.setXYZ(segmentIndex, end.x, end.y, end.z);
  }

  function markLinePositionsChanged(item: LoadedTrack): void {
    item.fullStartAttr.needsUpdate = true;
    item.fullEndAttr.needsUpdate = true;
  }

  function setLineSegmentEnd(item: LoadedTrack, segmentIndex: number, point: Vector3): void {
    item.fullEndAttr.setXYZ(segmentIndex, point.x, point.y, point.z);
    item.fullEndAttr.needsUpdate = true;
  }

  function restoreFullLineSegments(item: LoadedTrack): void {
    const segmentCount = item.track.points.length - 1;
    for (let s = 0; s < segmentCount; s++) {
      const a = s * 3;
      const b = (s + 1) * 3;
      item.fullStartAttr.setXYZ(s, item.ecefPositions[a], item.ecefPositions[a + 1], item.ecefPositions[a + 2]);
      item.fullEndAttr.setXYZ(s, item.ecefPositions[b], item.ecefPositions[b + 1], item.ecefPositions[b + 2]);
    }
    markLinePositionsChanged(item);
  }

  function markLineColorsChanged(startAttr: LineInstanceAttribute, endAttr: LineInstanceAttribute): void {
    startAttr.needsUpdate = true;
    endAttr.needsUpdate = true;
  }

  function writeWindowLineColors(
    startAttr: LineInstanceAttribute,
    endAttr: LineInstanceAttribute,
    segmentIndex: number,
    srcColors: Float32Array,
    startColorIndex: number,
    endColorIndex: number,
  ): void {
    const ca = startColorIndex * 3;
    const cb = endColorIndex * 3;
    startAttr.setXYZ(segmentIndex, srcColors[ca], srcColors[ca + 1], srcColors[ca + 2]);
    endAttr.setXYZ(segmentIndex, srcColors[cb], srcColors[cb + 1], srcColors[cb + 2]);
  }

  function restoreDynamicLineSegment(item: LoadedTrack): void {
    const segmentIndex = item.dynamicSegmentIndex;
    if (segmentIndex === null) return;
    const pointIndex = segmentIndex + 1;
    setLineSegmentEnd(
      item,
      segmentIndex,
      new Vector3(
        item.ecefPositions[pointIndex * 3],
        item.ecefPositions[pointIndex * 3 + 1],
        item.ecefPositions[pointIndex * 3 + 2],
      ),
    );
    item.dynamicSegmentIndex = null;
  }

  function update(currentSeconds: number, groundElevation: number | null): void {
    const now = performance.now();
    const budget = { remaining: CURTAIN_GROUND_LOOKUPS_PER_FRAME };
    if (activeTrack) {
      activePilotGroundElevation = groundElevation;
      activePilotGroundSeconds = currentSeconds;
    } else {
      activePilotGroundElevation = null;
      activePilotGroundSeconds = -Infinity;
    }

    for (const item of loadedTracks) {
      const { track, line, curtain, color } = item;
      const pts = track.points;

      // Find index of last visible point — each segment = one Line2 instance.
      let idx = 0;
      if (currentSeconds >= pts[pts.length - 1].time) {
        idx = pts.length - 1;
      } else if (currentSeconds > pts[0].time) {
        let lo = 0, hi = pts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (pts[mid].time <= currentSeconds) lo = mid; else hi = mid - 1;
        }
        idx = lo;
      }
      // Update curtain: bottom follows terrain, top grows from ground to the recent track.
      const pilotPos = getPilotPositionForTrack(track, currentSeconds, true);
      if (!pilotPos) {
        curtain.visible = false;
        continue;
      }

      restoreDynamicLineSegment(item);

      const trailSeconds = trailLengthSecondsFor(trailLengthMode);
      const useWindow = trailSeconds !== null && !(fullTrailForSelected && item === activeTrack);

      if (!useWindow) {
        if (item.windowActive) {
          restoreFullLineSegments(item);
          line.geometry.setColors(tailMode === 'person' ? item.personColors : item.climbColors);
          item.windowActive = false;
        }
        if (currentSeconds <= track.start) {
          line.geometry.instanceCount = 0;
        } else if (currentSeconds >= track.end || idx >= pts.length - 1) {
          line.geometry.instanceCount = pts.length - 1;
        } else {
          setLineSegmentEnd(item, idx, llaToECEF(pilotPos.lat, pilotPos.lon, pilotPos.alt));
          item.dynamicSegmentIndex = idx;
          line.geometry.instanceCount = idx + 1;
        }
      } else {
        item.windowActive = true;
        if (currentSeconds <= track.start) {
          line.geometry.instanceCount = 0;
        } else {
          const srcColors = tailMode === 'person' ? item.personColors : item.climbColors;
          // Exact time boundary of the trail's tail, clamped to launch — mirrors
          // how the curtain computes its own recency window.
          const windowStart = Math.max(track.start, currentSeconds - trailSeconds!);
          const startIdx = Math.min(findFirstIndexAtOrAfter(pts, windowStart), idx);
          const needsTailInterp = windowStart > track.start && pts[startIdx].time > windowStart;
          const includeTip = currentSeconds < track.end && idx < pts.length - 1;

          const vertices: Vector3[] = [];
          const colorIdxs: number[] = [];
          if (needsTailInterp) {
            const tailLL = getPilotPositionForTrack(track, windowStart, true)!;
            vertices.push(llaToECEF(tailLL.lat, tailLL.lon, tailLL.alt));
            colorIdxs.push(startIdx);
          }
          for (let i = startIdx; i <= idx; i++) {
            vertices.push(new Vector3(item.ecefPositions[i * 3], item.ecefPositions[i * 3 + 1], item.ecefPositions[i * 3 + 2]));
            colorIdxs.push(i);
          }
          if (includeTip) {
            vertices.push(llaToECEF(pilotPos.lat, pilotPos.lon, pilotPos.alt));
            colorIdxs.push(idx);
          }

          const segCount = vertices.length - 1;
          if (segCount < 1) {
            line.geometry.instanceCount = 0;
          } else {
            const colorStartAttr = line.geometry.attributes['instanceColorStart'] as LineInstanceAttribute;
            const colorEndAttr = line.geometry.attributes['instanceColorEnd'] as LineInstanceAttribute;
            for (let s = 0; s < segCount; s++) {
              const a = vertices[s];
              const b = vertices[s + 1];
              writeLineSegment(item, s, a, b);
              writeWindowLineColors(colorStartAttr, colorEndAttr, s, srcColors, colorIdxs[s], colorIdxs[s + 1]);
            }
            markLinePositionsChanged(item);
            markLineColorsChanged(colorStartAttr, colorEndAttr);
            line.geometry.instanceCount = segCount;
          }
        }
      }

      // Sync curtain color to current tail mode color.
      const c = tailMode === 'person'
        ? color
        : climbRateColor(idx > 0
          ? (pts[idx].alt - pts[idx - 1].alt) / Math.max(1, pts[idx].time - pts[idx - 1].time)
          : 0);
      const pos = curtain.geometry.attributes['position'] as Float32BufferAttribute;
      const col = curtain.geometry.attributes['color'] as Float32BufferAttribute;
      const alpha = curtain.geometry.attributes['alpha'] as Float32BufferAttribute;
      let vertex = 0;

      const samples = getCurtainSamples(item, currentSeconds, pilotPos);
      const groundAlts = samples.map((sample) =>
        getCurtainGroundElevation(
          track.id,
          sample,
          currentSeconds,
          item === activeTrack ? groundElevation : null,
          now,
          budget,
        ),
      );

      for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i];
        const b = samples[i + 1];
        const groundA = groundAlts[i];
        const groundB = groundAlts[i + 1];
        vertex = appendCurtainSegment(
          pos,
          col,
          alpha,
          vertex,
          llaToECEF(a.lat, a.lon, groundA - CURTAIN_GROUND_EXTENSION_METERS),
          llaToECEF(a.lat, a.lon, curtainTopAltitude(a, groundA, currentSeconds)),
          llaToECEF(b.lat, b.lon, groundB - CURTAIN_GROUND_EXTENSION_METERS),
          llaToECEF(b.lat, b.lon, curtainTopAltitude(b, groundB, currentSeconds)),
          curtainAlpha(a, currentSeconds),
          curtainAlpha(b, currentSeconds),
          c,
        );
      }

      curtain.geometry.setDrawRange(0, vertex);
      pos.needsUpdate = true;
      col.needsUpdate = true;
      alpha.needsUpdate = true;
      curtain.visible = vertex > 0;
    }

    updateTrackingCamera(currentSeconds);
  }

  function setTailMode(mode: TailMode): void {
    tailMode = mode;
    for (const item of loadedTracks) {
      // Windowed trails rebuild their color buffer from scratch every frame in
      // update(), so skip them here to avoid a length mismatch with the full array.
      if (item.windowActive) continue;
      item.line.geometry.setColors(mode === 'person' ? item.personColors : item.climbColors);
    }
  }

  function setTrailLength(mode: TrailLengthMode): void {
    trailLengthMode = mode;
  }

  function setFullTrailForSelected(enabled: boolean): void {
    fullTrailForSelected = enabled;
  }

  function clearGroundElevationCache(): void {
    curtainGroundCache.clear();
    activePilotGroundElevation = null;
    activePilotGroundSeconds = -Infinity;
  }

  function selectTrack(trackId: string, fly = true, focusSeconds = activeTrack?.track.start ?? 0): boolean {
    const selected = loadedTracks.find((item) => item.track.id === trackId);
    if (!selected) return false;

    activeTrack = selected;
    curtainGroundCache.clear();
    activePilotGroundElevation = null;
    activePilotGroundSeconds = -Infinity;

    if (trackingEnabled) {
      const target = getPilotFocusTarget(
        selected.track,
        focusSeconds,
        trackingAngle,
        trackingDistance,
        trackingElevation,
      );
      if (target) {
        trackingAngle = target.angle;
        trackingDistance = target.distance;
        trackingElevation = target.elevation;
        animateToFocusTarget(target, true);
      }
    } else if (fly) {
      focusPilot(selected.track, focusSeconds);
    }
    onTrackSelected(selected.track, selected.initialDate);
    return true;
  }

  function removeTrack(trackId: string): boolean {
    const index = loadedTracks.findIndex((item) => item.track.id === trackId);
    if (index < 0) return false;

    const [removed] = loadedTracks.splice(index, 1);
    const wasActive = activeTrack === removed;
    disposeLoadedTrack(removed);

    if (wasActive) {
      activeTrack = null;
      curtainGroundCache.clear();

      const fallback = loadedTracks[Math.min(index, loadedTracks.length - 1)] ?? null;
      if (fallback) {
        selectTrack(fallback.track.id);
      } else {
        setTracking(false);
        onTrackSelected(null, null);
      }
    }

    return true;
  }

  function loadTrackPoints(
    pts: IGCPoint[],
    label: string,
    pilot: string,
    gliderType: string,
    date: Date | null,
    tzOffsetSec: number | null,
    initialDate: Date,
    focusSeconds?: number,
  ): void {
    const trackColor = PERSON_COLORS[nextPilotIndex % PERSON_COLORS.length].clone();
    nextPilotIndex++;

    const positions = new Float32Array(pts.length * 3);
    const pCols     = new Float32Array(pts.length * 3);
    const cCols     = new Float32Array(pts.length * 3);

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const v = llaToECEF(p.lat, p.lon, p.alt);
      positions[i * 3]     = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;

      pCols[i * 3]     = trackColor.r;
      pCols[i * 3 + 1] = trackColor.g;
      pCols[i * 3 + 2] = trackColor.b;

      let rate = 0;
      if (i > 0) {
        const dt = pts[i].time - pts[i - 1].time;
        if (dt > 0) rate = (pts[i].alt - pts[i - 1].alt) / dt;
      }
      const cc = climbRateColor(rate);
      cCols[i * 3]     = cc.r;
      cCols[i * 3 + 1] = cc.g;
      cCols[i * 3 + 2] = cc.b;
    }

    // Line2 (WebGPU) for fat pixel-width track line with vertex colours.
    const lineGeo = new LineGeometry();
    lineGeo.setPositions(positions);
    lineGeo.setColors(tailMode === 'person' ? pCols : cCols);
    lineGeo.instanceCount = pts.length - 1;

    const fullStartAttr = lineGeo.getAttribute('instanceStart');
    const fullEndAttr = lineGeo.getAttribute('instanceEnd');

    const lineMat = new Line2NodeMaterial({
      linewidth: 3,
      vertexColors: true,
    });

    const line = new Line2(lineGeo, lineMat);
    line.frustumCulled = false;
    scene.add(line);

    // Faded curtain: bottom follows terrain, top rises into the recent track.
    const spikeGeo = new BufferGeometry();
    spikeGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(CURTAIN_MAX_VERTICES * 3), 3));
    spikeGeo.setAttribute('color',    new Float32BufferAttribute(new Float32Array(CURTAIN_MAX_VERTICES * 3), 3));
    spikeGeo.setAttribute('alpha', new Float32BufferAttribute(new Float32Array(CURTAIN_MAX_VERTICES), 1));
    spikeGeo.setDrawRange(0, 0);

    const spikeMat = new MeshBasicNodeMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    spikeMat.opacityNode = attribute('alpha', 'float');

    const curtain = new Mesh(spikeGeo, spikeMat);
    curtain.frustumCulled = false;
    curtain.visible = false;
    scene.add(curtain);

    const start = pts[0].time;
    const end = pts[pts.length - 1].time;
    const track: FlightTrack = {
      id: `track-${nextTrackId++}`,
      color: `#${trackColor.getHexString()}`,
      points: pts,
      label,
      pilot,
      gliderType,
      start,
      end,
      date,
      tzOffsetSec,
    };

    loadedTracks.push({
      track,
      initialDate,
      line,
      curtain,
      ecefPositions: positions,
      personColors: pCols,
      climbColors: cCols,
      color: trackColor,
      dynamicSegmentIndex: null,
      windowActive: false,
      fullStartAttr,
      fullEndAttr,
    });

    selectTrack(track.id, true, focusSeconds ?? start);
  }

  function loadIGCText(text: string, label = 'Unknown', focusSeconds?: number): void {
    const pts = parseIGC(text);
    if (pts.length < 2) return;
    const date = parseFlightDate(text);
    const pilot = parsePilotName(text);
    const gliderType = parseGliderType(text);
    const tzOffsetSec = parseTimezoneOffset(text);

    let viewDate: Date;
    if (date !== null && pts[0].time > 0) {
      viewDate = new Date(date.getTime() + pts[0].time * 1000);
    } else if (date !== null) {
      viewDate = atLocalEvening(date, pts[0].lon);
    } else {
      viewDate = new Date();
    }

    loadTrackPoints(pts, label, pilot, gliderType, date, tzOffsetSec, viewDate, focusSeconds);
  }

  function getHeading(): number {
    const normal = camera.position.clone().normalize();
    const northPole = new Vector3(0, 0, 1);
    const northInPlane = northPole.clone().sub(normal.clone().multiplyScalar(northPole.dot(normal)));
    if (northInPlane.lengthSq() < 1e-10) return 0;
    northInPlane.normalize();
    const east = new Vector3().crossVectors(northInPlane, normal).normalize();
    const camUp = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const upInPlane = camUp.clone().sub(normal.clone().multiplyScalar(camUp.dot(normal)));
    if (upInPlane.lengthSq() < 1e-10) return 0;
    upInPlane.normalize();
    return Math.atan2(upInPlane.dot(east), upInPlane.dot(northInPlane)) * 180 / Math.PI;
  }

  function resetNorthUp(): void {
    if (resetAnimId !== null) cancelAnimationFrame(resetAnimId);

    const normal = camera.position.clone().normalize();
    const northPole = new Vector3(0, 0, 1);
    let north = northPole.clone().sub(normal.clone().multiplyScalar(northPole.dot(normal)));
    if (north.lengthSq() < 1e-8) north.set(1, 0, 0);
    north.normalize();

    const scratch = new PerspectiveCamera();
    scratch.position.copy(camera.position);
    scratch.up.copy(north);
    scratch.lookAt(new Vector3(0, 0, 0));
    scratch.updateMatrixWorld();
    const targetQuat = scratch.quaternion.clone();
    const startQuat = camera.quaternion.clone();

    const DURATION = 600;
    const t0 = performance.now();
    controls.enabled = false;

    function step() {
      const raw = Math.min((performance.now() - t0) / DURATION, 1);
      const ease = raw < 0.5 ? 4 * raw ** 3 : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      camera.quaternion.slerpQuaternions(startQuat, targetQuat, ease);
      camera.up.copy(north);
      camera.updateMatrixWorld();
      if (raw < 1) {
        resetAnimId = requestAnimationFrame(step);
      } else {
        resetAnimId = null;
        controls.enabled = true;
      }
    }
    resetAnimId = requestAnimationFrame(step);
  }

  function getTrack(): FlightTrack | null {
    return activeTrack?.track ?? null;
  }

  function getTracks(): FlightTrack[] {
    return loadedTracks.map((item) => item.track);
  }

  function getPilotPositionsAt(seconds: number): Array<{ track: FlightTrack; lat: number; lon: number; alt: number }> {
    return loadedTracks.flatMap((item) => {
      const pos = getPilotPositionForTrack(item.track, seconds, true);
      return pos ? [{ track: item.track, ...pos }] : [];
    });
  }

  function dispose(): void {
    if (resetAnimId !== null) cancelAnimationFrame(resetAnimId);
    if (flyAnimId !== null) cancelAnimationFrame(flyAnimId);
    setTracking(false);
    clearTracks();
  }

  return {
    loadIGCText,
    selectTrack,
    removeTrack,
    getTrack,
    getTracks,
    getHeading,
    resetNorthUp,
    dispose,
    setTailMode,
    setTrailLength,
    setFullTrailForSelected,
    clearGroundElevationCache,
    update,
    getPilotPositionAt,
    getPilotPositionsAt,
    setTracking,
    isTracking: () => trackingEnabled,
    beginTrackingOrbit,
    adjustTrackingOrbit,
    adjustTrackingZoom,
    endTrackingOrbit,
  };
}
