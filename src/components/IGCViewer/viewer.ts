import {
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  LinearFilter,
  Mesh,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
} from 'three';
import { mix, positionViewDirection, vec3 } from 'three/tsl';
import { Line2NodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { createRenderer } from './setupRenderer';
import { createAtmosphere } from './setupAtmosphere';
import { createPipeline } from './setupPipeline';
import { createTiles } from './setupTiles';
import { createControls } from './setupControls';
import { createTrackManager } from './setupTracks';
import { llaToECEF, haversineDistanceM } from './igc';
import { parseTask } from './parseTask';
import { detectAndParse } from './parseLandmarks';
import { looksLikeOpenAir, parseOpenAir } from './parseAirspace';
import { createAirspaceManager } from './setupAirspace';
import { sampleCachedTerrainElevationM, sampleTerrainBoundsInRadiusM, sampleTerrainElevationM } from './terrainElevation';
import type { IGCTask } from './parseTask';
import type { FlightTrack, HeightCalculationMode, ViewerOptions } from './types';
import type { Landmark } from './parseLandmarks';
import type { Airspace } from './parseAirspace';
import type { AirspaceFile, AirspacePick } from './setupAirspace';

export type { AltitudeMarkerMode, HeightCalculationMode, LandmarkEntry, TrackEntry, FlightTrack, TailMode, TrailLengthMode, UnitMode, ViewerOptions } from './types';
export type { Landmark } from './parseLandmarks';
export type { Airspace, AirspaceAltitude } from './parseAirspace';
export type { AirspaceFile, AirspacePick } from './setupAirspace';

export interface LandmarkFile {
  id: string;
  filename: string;
  rawText: string;
  landmarks: readonly Landmark[];
}

const groundCaster = new Raycaster();
const SHADOW_CAMERA_NEAR = 1;
const SHADOW_CAMERA_FAR = 50000;
const EARTH_MEAN_RADIUS_M = 6371000;
const TASK_OUTLINE_COLOR = 0x006eff;
const TASK_OUTLINE_OPACITY = 0.82;
const TASK_OUTLINE_LINEWIDTH_PX = 1;
const TASK_TOP_CLEARANCE_M = 200;
const TASK_GROUND_BLEED_M = 100;

// Parametric radius of the WGS84 ellipsoid at a given geodetic latitude.
function wgs84RadiusAt(latDeg: number): number {
  const a = 6378137.0, b = 6356752.314245;
  const φ = latDeg * Math.PI / 180;
  const cosφ = Math.cos(φ), sinφ = Math.sin(φ);
  return Math.sqrt(
    (Math.pow(a * a * cosφ, 2) + Math.pow(b * b * sinφ, 2)) /
    (Math.pow(a * cosφ,     2) + Math.pow(b * sinφ,     2)),
  );
}

function applyShadowSafeClip(camera: PerspectiveCamera): void {
  if (camera.near === SHADOW_CAMERA_NEAR && camera.far === SHADOW_CAMERA_FAR) return;
  camera.near = SHADOW_CAMERA_NEAR;
  camera.far = SHADOW_CAMERA_FAR;
  camera.updateProjectionMatrix();
}

function approxLatLonFromECEF(pos: Vector3): { lat: number; lon: number } {
  return {
    lat: Math.atan2(pos.z, Math.sqrt(pos.x * pos.x + pos.y * pos.y)) * 180 / Math.PI,
    lon: Math.atan2(pos.y, pos.x) * 180 / Math.PI,
  };
}

function raySphereIntersection(origin: Vector3, direction: Vector3, radiusM: number): Vector3 | null {
  const b = origin.dot(direction);
  const c = origin.lengthSq() - radiusM * radiusM;
  const disc = b * b - c;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const near = -b - sqrtDisc;
  const far = -b + sqrtDisc;
  const t = near > 0 ? near : far > 0 ? far : null;
  return t === null ? null : origin.clone().addScaledVector(direction, t);
}

export async function initViewer(options: ViewerOptions) {
  const { canvas, googleApiKey } = options;
  const container = canvas.parentElement!;
  const { clientWidth: initW, clientHeight: initH } = container;

  const { renderer } = await createRenderer(canvas);
  renderer.setSize(initW, initH, false);

  const scene = new Scene();
  // far=1.6e8 (160,000 km) keeps the moon visible; near=1 metre avoids z-fighting on tiles.
  const camera = new PerspectiveCamera(60, initW / initH, 1, 1.6e8);
  // Default view: San Francisco from ~2.5× Earth radius altitude.
  // Replaced by flyToPoints() as soon as the first IGC file loads.
  const sfLat = 37.7749 * Math.PI / 180;
  const sfLon = -122.4194 * Math.PI / 180;
  camera.position.set(
    Math.cos(sfLat) * Math.cos(sfLon),
    Math.cos(sfLat) * Math.sin(sfLon),
    Math.sin(sfLat),
  ).multiplyScalar(6.371e6 * 2.5);
  camera.lookAt(0, 0, 0);

  const atmosphere = createAtmosphere(scene, renderer, camera);
  const pipeline = createPipeline(scene, camera, renderer, atmosphere.csmShadowNode, atmosphere.atmosphereContext);
  const tilesHandle = createTiles(scene, camera, renderer, googleApiKey);

  // Gradient sky shown in non-fancy mode: pale blue at horizon, deep blue at zenith.
  // positionViewDirection.y ranges -1..1; we lift and clamp to 0..1 then gamma-curve it.
  const skyGradient = mix(
    vec3(0.72, 0.88, 0.97),
    vec3(0.10, 0.24, 0.62),
    positionViewDirection.y.add(0.1).clamp(0, 1).pow(0.6),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (scene as any).backgroundNode = skyGradient;
  const globeControls = createControls(scene, camera, renderer.domElement, tilesHandle.tiles);

  // --- Atmosphere clock ---
  let currentDate = new Date();

  // --- Fancy lighting ---
  let fancyLighting = false;
  let heightCalculationMode: HeightCalculationMode = 'simplified';

  // --- Playback state ---
  // flightDate is midnight UTC on the flight date; currentSeconds is seconds from midnight UTC.
  // Together they reconstruct the full UTC time: new Date(flightDate + currentSeconds * 1000).
  const playback = {
    playing: false,
    speed: 1,
    lastTs: -1,
    flightDate: null as Date | null,
    currentSeconds: 0,
    track: null as FlightTrack | null,
  };

  let onTrackChangeCallback: ((track: FlightTrack | null) => void) | null = null;
  let onTrackingChangeCallback: ((enabled: boolean) => void) | null = null;
  let cameraAltitudeAnimId: number | null = null;
  const postRenderCallbacks = new Set<() => void>();

  // --- Task ---
  let task: IGCTask | null = null;
  let masterTrackId: string | null = null;
  const taskObjects: Mesh[] = [];
  const taskScoringCache = new Map<string, (number | null)[]>(); // trackId → per-TP score times
  const igcTexts = new Map<string, string>(); // trackId → raw IGC text
  let onTaskChangeCallback: (() => void) | null = null;
  let taskBuildId = 0;

  function taskBasis(lat: number, lon: number): { east: Vector3; north: Vector3; up: Vector3 } {
    const φ = lat * Math.PI / 180;
    const λ = lon * Math.PI / 180;
    const up = new Vector3(
      Math.cos(φ) * Math.cos(λ),
      Math.cos(φ) * Math.sin(λ),
      Math.sin(φ),
    ).normalize();
    const east = new Vector3(-Math.sin(λ), Math.cos(λ), 0).normalize();
    const north = new Vector3().crossVectors(up, east).normalize();
    return { east, north, up };
  }

  function positionTaskObject(obj: Mesh, tp: IGCTask['scoreable'][number], centerAltitudeM: number): void {
    obj.position.copy(llaToECEF(tp.lat, tp.lon, centerAltitudeM));
    obj.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), taskBasis(tp.lat, tp.lon).up));
  }

  function estimateTaskBaseAltitudeM(tp: IGCTask['scoreable'][number], radiusM: number, sourceTrackId: string | null): number {
    const orderedTracks = tracks.getTracks().sort((a, b) => {
      if (a.id === sourceTrackId) return -1;
      if (b.id === sourceTrackId) return 1;
      return 0;
    });

    let nearestDistance = Infinity;
    let nearestAltitude = 0;
    let lowestAltitudeInside = Infinity;
    for (const track of orderedTracks) {
      for (const point of track.points) {
        const distance = haversineDistanceM(point.lat, point.lon, tp.lat, tp.lon);
        if (distance <= radiusM) lowestAltitudeInside = Math.min(lowestAltitudeInside, point.alt);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestAltitude = point.alt;
        }
      }
      if (lowestAltitudeInside !== Infinity) return lowestAltitudeInside;
    }

    return nearestAltitude;
  }

  function disposeTaskObject(obj: Mesh): void {
    scene.remove(obj);
    obj.geometry.dispose();
    if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
    else obj.material.dispose();
  }

  function clearTaskObjects(): void {
    for (const obj of taskObjects) disposeTaskObject(obj);
    taskObjects.length = 0;
  }

  function removeTaskZoneObjects(tpIndex: number): void {
    for (let i = taskObjects.length - 1; i >= 0; i--) {
      if (taskObjects[i].userData.tpIndex !== tpIndex) continue;
      disposeTaskObject(taskObjects[i]);
      taskObjects.splice(i, 1);
    }
  }

  function addTaskMesh(mesh: Mesh, tp: IGCTask['scoreable'][number], tpIndex: number, centerAltitudeM: number, part: 'fill' | 'outline'): void {
    positionTaskObject(mesh, tp, centerAltitudeM);
    mesh.frustumCulled = false;
    mesh.userData.tpIndex = tpIndex;
    mesh.userData.taskPart = part;
    scene.add(mesh);
    taskObjects.push(mesh);
  }

  function createTaskZoneObjects(
    tp: IGCTask['scoreable'][number],
    tpIndex: number,
    radiusM: number,
    bottomAltitudeM: number,
    topAltitudeM: number,
  ): void {
    const heightM = Math.max(1, topAltitudeM - bottomAltitudeM);
    const centerAltitudeM = bottomAltitudeM + heightM / 2;
    const fillMat = new MeshBasicNodeMaterial({
      color: 0x888888, transparent: true, opacity: 0.15, side: DoubleSide, depthTest: true, depthWrite: false,
    });
    addTaskMesh(new Mesh(new CylinderGeometry(radiusM, radiusM, heightM, 64, 1, true), fillMat), tp, tpIndex, centerAltitudeM, 'fill');

    const createOutlineMaterial = () => new Line2NodeMaterial({
      color: TASK_OUTLINE_COLOR,
      linewidth: TASK_OUTLINE_LINEWIDTH_PX,
      transparent: true,
      opacity: TASK_OUTLINE_OPACITY,
      depthTest: true,
      depthWrite: false,
    });

    const addTaskLine = (positions: number[]) => {
      const lineGeo = new LineGeometry();
      lineGeo.setPositions(positions);
      addTaskMesh(new Line2(lineGeo, createOutlineMaterial()), tp, tpIndex, centerAltitudeM, 'outline');
    };

    const halfHeight = heightM / 2;

    for (const y of [-halfHeight, halfHeight]) {
      const positions: number[] = [];
      const segments = 128;
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        positions.push(radiusM * Math.cos(angle), y, radiusM * Math.sin(angle));
      }
      addTaskLine(positions);
    }

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const x = radiusM * Math.cos(angle);
      const z = radiusM * Math.sin(angle);
      addTaskLine([x, -halfHeight, z, x, halfHeight, z]);
    }
  }

  function buildTaskObjects(t: IGCTask): void {
    const buildId = ++taskBuildId;
    clearTaskObjects();

    for (let i = 0; i < t.scoreable.length; i++) {
      const tp = t.scoreable[i];
      const r = tp.type === 'start'
        ? (tp.innerRadiusM > 0 ? tp.innerRadiusM : tp.outerRadiusM)
        : tp.outerRadiusM;
      if (r <= 0 || r > 500000) continue;

      const fallbackAltitudeM = estimateTaskBaseAltitudeM(tp, r, masterTrackId);
      createTaskZoneObjects(
        tp,
        i,
        r,
        fallbackAltitudeM - TASK_GROUND_BLEED_M,
        fallbackAltitudeM + TASK_TOP_CLEARANCE_M,
      );

      void sampleTerrainBoundsInRadiusM(tp.lat, tp.lon, r).then((terrain) => {
        if (terrain === null || buildId !== taskBuildId) return;
        removeTaskZoneObjects(i);
        createTaskZoneObjects(
          tp,
          i,
          r,
          terrain.min - TASK_GROUND_BLEED_M,
          terrain.max + TASK_TOP_CLEARANCE_M,
        );
      });
    }
  }

  function computeScoring(track: FlightTrack): (number | null)[] {
    if (!task) return [];
    const result: (number | null)[] = task.scoreable.map(() => null);
    let nextIdx = 0;
    for (const pt of track.points) {
      if (nextIdx >= task.scoreable.length) break;
      const tp = task.scoreable[nextIdx];
      const scoringR = tp.type === 'start'
        ? (tp.innerRadiusM > 0 ? tp.innerRadiusM : tp.outerRadiusM)
        : tp.outerRadiusM;
      if (haversineDistanceM(pt.lat, pt.lon, tp.lat, tp.lon) <= scoringR) {
        result[nextIdx] = pt.time;
        nextIdx++;
      }
    }
    return result;
  }

  function applyTask(t: IGCTask | null, sourceTrackId: string | null): void {
    task = t;
    masterTrackId = sourceTrackId;
    taskScoringCache.clear();
    if (t) {
      buildTaskObjects(t);
      for (const ft of tracks.getTracks()) {
        taskScoringCache.set(ft.id, computeScoring(ft));
      }
    } else {
      taskBuildId++;
      clearTaskObjects();
    }
    onTaskChangeCallback?.();
  }

  function updateTaskObjects(currentSeconds: number): void {
    if (taskObjects.length === 0) return;

    const activeId = tracks.getTrack()?.id ?? null;
    const scoreTimes = activeId ? (taskScoringCache.get(activeId) ?? []) : [];

    for (const obj of taskObjects) {
      const i: number = obj.userData.tpIndex;
      const scoredAt = scoreTimes[i] ?? null;
      const prevScoredAt = i === 0 ? -Infinity : (scoreTimes[i - 1] ?? null);
      const isScored = scoredAt !== null && scoredAt <= currentSeconds;
      const isPrevScored = i === 0 || (prevScoredAt !== null && (prevScoredAt as number) <= currentSeconds);
      const isActive = isPrevScored && !isScored;

      if (obj.userData.taskPart === 'fill') {
        const mat = obj.material as MeshBasicNodeMaterial;
        if (isScored) {
          mat.opacity = 0;
        } else if (isActive) {
          mat.color.setHex(0xff4400);
          mat.opacity = 0.12;
        } else {
          mat.color.setHex(0x888888);
          mat.opacity = 0.15;
        }
      } else {
        obj.visible = !isScored;
      }
    }
  }

  // --- Landmarks ---
  let landmarkFiles: LandmarkFile[] = [];
  let onLandmarksChangeCallback: (() => void) | null = null;
  const landmarkSprites = new Map<string, Sprite[]>(); // fileId → sprites

  const TARGET_LABEL_H_PX = 14;

  function makeLandmarkSprite(lm: Landmark): Sprite {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fontSize = 11;
    const padX = 6, padY = 3;

    const tmpCtx = document.createElement('canvas').getContext('2d')!;
    tmpCtx.font = `700 ${fontSize}px system-ui,sans-serif`;
    const codeW = tmpCtx.measureText(lm.code).width;
    const hasName = lm.name !== lm.code;
    tmpCtx.font = `${fontSize}px system-ui,sans-serif`;
    const nameW = hasName ? tmpCtx.measureText(lm.name).width + 5 : 0;

    const logW = Math.ceil(codeW + nameW + padX * 2);
    const logH = Math.ceil(fontSize + padY * 2);

    const canvas = document.createElement('canvas');
    canvas.width = logW * dpr;
    canvas.height = logH * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const r = 3;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(logW - r, 0);
    ctx.quadraticCurveTo(logW, 0, logW, r);
    ctx.lineTo(logW, logH - r);
    ctx.quadraticCurveTo(logW, logH, logW - r, logH);
    ctx.lineTo(r, logH);
    ctx.quadraticCurveTo(0, logH, 0, logH - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fill();

    ctx.font = `700 ${fontSize}px system-ui,sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.fillText(lm.code, padX, padY + fontSize * 0.82);

    if (hasName) {
      ctx.font = `${fontSize}px system-ui,sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillText(lm.name, padX + codeW + 5, padY + fontSize * 0.82);
    }

    const texture = new CanvasTexture(canvas);
    texture.generateMipmaps = false;
    texture.minFilter = LinearFilter;
    const material = new SpriteMaterial({ map: texture, depthTest: true, depthWrite: false, sizeAttenuation: false });
    const sprite = new Sprite(material);
    sprite.frustumCulled = false;
    sprite.center.set(0.5, 0); // bottom-center anchored at world position

    const ecef = llaToECEF(lm.lat, lm.lon, lm.elevM);
    sprite.position.copy(ecef).addScaledVector(ecef.clone().normalize(), 100);

    sprite.userData.logW = logW;
    sprite.userData.logH = logH;
    applyLandmarkSpriteScale(sprite, logW, logH);

    return sprite;
  }

  function applyLandmarkSpriteScale(sprite: Sprite, logW: number, logH: number) {
    const vpH = container.clientHeight || 800;
    // f = projMatrix[1][1] = 1/tan(fov/2); cancels the perspective divide so scaleX needs no aspect correction
    const f = camera.projectionMatrix.elements[5];
    const scaleY = (TARGET_LABEL_H_PX * 2) / (f * vpH);
    const scaleX = scaleY * (logW / logH);
    sprite.scale.set(scaleX, scaleY, 1);
  }

  function addLandmarkFileInternal(filename: string, rawText: string, lms: Landmark[]): void {
    const id = `${Date.now()}-${filename}`;
    const sprites = lms.map((lm) => {
      const s = makeLandmarkSprite(lm);
      scene.add(s);
      return s;
    });
    landmarkSprites.set(id, sprites);
    landmarkFiles = [...landmarkFiles, { id, filename, rawText, landmarks: lms }];
    onLandmarksChangeCallback?.();
  }

  // --- Airspace ---
  const airspace = createAirspaceManager(scene);
  let onAirspacesChangeCallback: (() => void) | null = null;
  const airspacePickRay = new Raycaster();

  function addAirspaceFileInternal(filename: string, rawText: string, zones: Airspace[]): void {
    airspace.addFile(filename, rawText, zones);
    onAirspacesChangeCallback?.();
  }

  function filenameFromUrl(url: string): string {
    try {
      const parsed = new URL(url, window.location.href);
      return decodeURIComponent(parsed.pathname.split('/').pop() || 'landmarks');
    } catch {
      return url.split('/').pop() || 'landmarks';
    }
  }

  // Ground elevation caching for the active track, throttled to once/sec.
  let cachedGroundElevation: number | null = null;
  let lastGroundCheckTs = -Infinity;
  const simplifiedGroundCache = new Map<string, { elevation: number | null; promise: Promise<void> | null }>();

  function simplifiedGroundKey(lat: number, lon: number): string {
    return `${lat.toFixed(5)},${lon.toFixed(5)}`;
  }

  function getSimplifiedGroundElevation(lat: number, lon: number): number | null {
    const key = simplifiedGroundKey(lat, lon);
    const cachedTileElevation = sampleCachedTerrainElevationM(lat, lon);
    if (cachedTileElevation !== null) {
      simplifiedGroundCache.set(key, { elevation: cachedTileElevation, promise: null });
      return cachedTileElevation;
    }

    const cached = simplifiedGroundCache.get(key);
    if (cached) return cached.elevation;

    const entry: { elevation: number | null; promise: Promise<void> | null } = { elevation: null, promise: null };
    entry.promise = sampleTerrainElevationM(lat, lon)
      .then((elevation) => { entry.elevation = elevation; })
      .catch(() => { entry.elevation = null; })
      .finally(() => { entry.promise = null; });
    simplifiedGroundCache.set(key, entry);
    return null;
  }

  function getGroundElevationForMode(lat: number, lon: number, altHint: number): number | null {
    return heightCalculationMode === 'vector'
      ? castGroundElevationFn(lat, lon, altHint)
      : getSimplifiedGroundElevation(lat, lon);
  }

  const tracks = createTrackManager(scene, camera, globeControls.controls, {
    getGroundElevation: getGroundElevationForMode,
    onTrackSelected: (track, initialDate) => {
      const hadTrack = playback.track !== null;
      currentDate = initialDate ?? new Date();
      playback.track = track;
      playback.flightDate = track?.date ?? null;
      if (!hadTrack) playback.currentSeconds = track?.start ?? 0;
      if (!track) playback.currentSeconds = 0;
      playback.playing = false;
      playback.lastTs = -1;
      cachedGroundElevation = null;
      lastGroundCheckTs = -Infinity;
      onTrackChangeCallback?.(track);
    },
  });

  function loadIGCTextWithTask(text: string, label?: string): void {
    tracks.loadIGCText(text, label, playback.currentSeconds);
    const loadedTrack = tracks.getTrack();
    if (!loadedTrack) return;

    igcTexts.set(loadedTrack.id, text);
    if (masterTrackId === null) {
      const parsed = parseTask(text);
      if (parsed) applyTask(parsed, loadedTrack.id);
    } else if (task) {
      taskScoringCache.set(loadedTrack.id, computeScoring(loadedTrack));
    }
  }

  async function zoomCameraToGroundClearance(clearanceM: number): Promise<void> {
    const lookDirection = new Vector3();
    camera.getWorldDirection(lookDirection);

    camera.updateMatrixWorld();
    tilesHandle.tiles.group.updateMatrixWorld(true);
    groundCaster.set(camera.position, lookDirection);
    const terrainHit = groundCaster.intersectObject(tilesHandle.tiles.group, true)[0]?.point.clone() ?? null;

    const focusPoint = terrainHit
      ?? raySphereIntersection(camera.position, lookDirection, EARTH_MEAN_RADIUS_M)
      ?? camera.position.clone().normalize().multiplyScalar(EARTH_MEAN_RADIUS_M);
    const { lat, lon } = approxLatLonFromECEF(focusPoint);

    let targetLookAt: Vector3;
    let targetPosition: Vector3;
    if (terrainHit) {
      const upAtHit = terrainHit.clone().normalize();
      targetLookAt = terrainHit;
      targetPosition = terrainHit.clone().addScaledVector(upAtHit, clearanceM);
    } else {
      const cachedTerrainAltitudeM = sampleCachedTerrainElevationM(lat, lon);
      const terrainAltitudeM = cachedTerrainAltitudeM ?? await sampleTerrainElevationM(lat, lon);
      const targetAltitudeM = (terrainAltitudeM ?? 0) + clearanceM;
      targetPosition = llaToECEF(lat, lon, targetAltitudeM);
      targetLookAt = llaToECEF(lat, lon, terrainAltitudeM ?? 0);
    }

    const up = targetPosition.clone().normalize();
    const northPole = new Vector3(0, 0, 1);
    let north = northPole.clone().sub(up.clone().multiplyScalar(northPole.dot(up)));
    if (north.lengthSq() < 1e-8) north.set(1, 0, 0);
    north.normalize();

    const scratch = new PerspectiveCamera(camera.fov, camera.aspect, camera.near, camera.far);
    scratch.position.copy(targetPosition);
    scratch.up.copy(north);
    scratch.lookAt(targetLookAt);
    scratch.updateMatrixWorld();

    if (cameraAltitudeAnimId !== null) cancelAnimationFrame(cameraAltitudeAnimId);
    const startPos = camera.position.clone();
    const startQuat = camera.quaternion.clone();
    const targetQuat = scratch.quaternion.clone();
    const t0 = performance.now();
    const durationMs = 700;
    globeControls.controls.enabled = false;

    const step = () => {
      const raw = Math.min((performance.now() - t0) / durationMs, 1);
      const ease = raw < 0.5 ? 4 * raw ** 3 : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      camera.position.copy(startPos.clone().lerp(targetPosition, ease));
      camera.up.copy(north);
      camera.quaternion.slerpQuaternions(startQuat, targetQuat, ease);
      camera.updateMatrixWorld();

      if (raw < 1) {
        cameraAltitudeAnimId = requestAnimationFrame(step);
      } else {
        cameraAltitudeAnimId = null;
        globeControls.controls.enabled = true;
        globeControls.controls.adjustHeight = true;
      }
    };

    cameraAltitudeAnimId = requestAnimationFrame(step);
  }

  // Load any tracks supplied via the `tracks` prop on component mount. The
  // first entry is the primary track: it loads first (so its task wins) and
  // is re-selected once the rest have loaded.
  let primaryTrackId: string | null = null;
  for (const entry of options.tracks ?? []) {
    try {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      loadIGCTextWithTask(text, entry.label);
      primaryTrackId ??= tracks.getTrack()?.id ?? null;
    } catch (err) {
      console.warn(`[IGC] failed to load track "${entry.label}":`, err);
    }
  }
  if (primaryTrackId !== null && tracks.getTrack()?.id !== primaryTrackId) {
    tracks.selectTrack(primaryTrackId, true, playback.currentSeconds);
  }

  // Load landmark/places-of-interest files supplied via public options.
  for (const entry of options.landmarks ?? []) {
    const filename = filenameFromUrl(entry.url);
    const label = entry.label ?? filename;
    try {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const landmarks = detectAndParse(filename, text);
      if (landmarks.length > 0) {
        addLandmarkFileInternal(label, text, landmarks);
      } else if (looksLikeOpenAir(text)) {
        const zones = parseOpenAir(text);
        if (zones.length > 0) addAirspaceFileInternal(label, text, zones);
      }
    } catch (err) {
      console.warn(`[IGC] failed to load landmarks "${label}":`, err);
    }
  }

  // Load airspace files supplied via public options.
  for (const entry of options.airspaces ?? []) {
    const label = entry.label ?? filenameFromUrl(entry.url);
    try {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const zones = parseOpenAir(text);
      if (zones.length > 0) addAirspaceFileInternal(label, text, zones);
    } catch (err) {
      console.warn(`[IGC] failed to load airspace "${label}":`, err);
    }
  }

  const resizeObserver = new ResizeObserver(() => {
    const rw = container.clientWidth;
    const rh = container.clientHeight;
    renderer.setSize(rw, rh, false);
    camera.aspect = rw / rh;
    camera.updateProjectionMatrix();
    tilesHandle.setResolution(camera, renderer);
    for (const sprites of landmarkSprites.values()) {
      for (const s of sprites) {
        applyLandmarkSpriteScale(s, s.userData.logW as number, s.userData.logH as number);
      }
    }
  });
  resizeObserver.observe(container);

  const observerECEF = new Vector3();

  function castGroundElevationFn(lat: number, lon: number, altHint: number): number | null {
    const a = 6378137.0, e2 = 6.69437999014e-3;
    const φ = lat * Math.PI / 180, λ = lon * Math.PI / 180;
    const sinφ = Math.sin(φ), cosφ = Math.cos(φ);
    const N = a / Math.sqrt(1 - e2 * sinφ * sinφ);
    const rayAlt = Math.max(altHint, 0) + 5000;
    const origin = new Vector3(
      (N + rayAlt) * cosφ * Math.cos(λ),
      (N + rayAlt) * cosφ * Math.sin(λ),
      (N * (1 - e2) + rayAlt) * sinφ,
    );
    groundCaster.set(origin, origin.clone().negate().normalize());
    const hits = groundCaster.intersectObject(tilesHandle.tiles.group, true);
    if (hits.length === 0) return null;
    return hits[0].point.length() - wgs84RadiusAt(lat);
  }

  renderer.setAnimationLoop((timestamp: number) => {
    // Advance playback clock each frame when playing.
    if (playback.playing && playback.lastTs >= 0 && playback.track !== null) {
      const dt = (timestamp - playback.lastTs) / 1000;
      const next = playback.currentSeconds + dt * playback.speed;
      if (next >= playback.track.end) {
        playback.currentSeconds = playback.track.end;
        playback.playing = false;
      } else {
        playback.currentSeconds = next;
      }
      if (playback.flightDate !== null) {
        currentDate = new Date(playback.flightDate.getTime() + playback.currentSeconds * 1000);
      }
    }
    playback.lastTs = timestamp;

    // Update tail draw range and ground spike.
    if (playback.track) {
      if (timestamp - lastGroundCheckTs > 1000) {
        const pos = tracks.getPilotPositionAt(playback.currentSeconds);
        if (pos) {
          cachedGroundElevation = getGroundElevationForMode(pos.lat, pos.lon, pos.alt);
          lastGroundCheckTs = timestamp;
        }
      }
      tracks.update(playback.currentSeconds, cachedGroundElevation);
    }
    updateTaskObjects(playback.currentSeconds);

    globeControls.update();
    // GlobeControls.update() adaptively sets camera near/far based on the horizon distance.
    // Only override when fancy lighting is on — CSM requires a fixed frustum for shadow maps.
    if (fancyLighting) {
      applyShadowSafeClip(camera);
    }
    camera.updateMatrixWorld();
    observerECEF.setFromMatrixPosition(camera.matrixWorld);
    atmosphere.update(currentDate, observerECEF);
    if (fancyLighting && (atmosphere.csmShadowNode as unknown as { mainFrustum?: unknown }).mainFrustum != null) {
      atmosphere.csmShadowNode.updateFrustums();
    }
    tilesHandle.update(camera, renderer, fancyLighting ? atmosphere.csmShadowNode : undefined);
    tilesHandle.syncMaterials();
    if (fancyLighting) {
      pipeline.render();
    } else {
      renderer.render(scene, camera);
    }
    // Overlay (pivot mesh) is rendered last, after pipeline, without post-processing.
    globeControls.renderOverlay(renderer, camera);
    for (const cb of postRenderCallbacks) cb();
  });

  return {
    tiles: tilesHandle.tiles,
    scene,
    camera,
    renderer,

    addPostRenderCallback(cb: () => void): () => void {
      postRenderCallbacks.add(cb);
      return () => {
        postRenderCallbacks.delete(cb);
      };
    },

    loadIGCText(text: string, label?: string) {
      loadIGCTextWithTask(text, label);
    },
    selectTrack(trackId: string) {
      return tracks.selectTrack(trackId, true, playback.currentSeconds);
    },
    removeTrack(trackId: string) {
      taskScoringCache.delete(trackId);
      igcTexts.delete(trackId);
      if (masterTrackId === trackId) masterTrackId = null;
      const removed = tracks.removeTrack(trackId);
      if (removed) onTrackingChangeCallback?.(tracks.isTracking());
      return removed;
    },
    getTrack: tracks.getTrack,
    getTracks: tracks.getTracks,
    setTrackVisible: tracks.setTrackVisible,
    isTrackVisible: tracks.isTrackVisible,
    getHeading: tracks.getHeading,
    resetNorthUp: tracks.resetNorthUp,
    zoomCameraToGroundClearance,
    setTailMode: tracks.setTailMode,
    setTrailLength: tracks.setTrailLength,
    setFullTrailForSelected: tracks.setFullTrailForSelected,
    setHeightCalculationMode(mode: HeightCalculationMode) {
      heightCalculationMode = mode;
      cachedGroundElevation = null;
      lastGroundCheckTs = -Infinity;
      tracks.clearGroundElevationCache();
    },
    setTracking(enabled: boolean) {
      const accepted = tracks.setTracking(enabled, playback.currentSeconds, cachedGroundElevation);
      onTrackingChangeCallback?.(tracks.isTracking());
      return accepted;
    },
    isTracking: tracks.isTracking,
    beginTrackingOrbit() {
      return tracks.beginTrackingOrbit(playback.currentSeconds);
    },
    adjustTrackingOrbit(deltaXPixels: number, deltaYPixels = 0) {
      tracks.adjustTrackingOrbit(deltaXPixels, deltaYPixels);
    },
    adjustTrackingZoom(deltaYPixels: number) {
      tracks.adjustTrackingZoom(deltaYPixels);
    },
    endTrackingOrbit: tracks.endTrackingOrbit,

    castGroundElevation: castGroundElevationFn,

    /** Returns the pilot's projected screen position (0..1 fractions) plus altitude.
     *  Returns null when no track is loaded; visible=false when the pilot is behind the camera. */
    getPilotScreenPos(): { x: number; y: number; alt: number; visible: boolean } | null {
      const pos = tracks.getPilotPositionAt(playback.currentSeconds);
      if (!pos) return null;
      const ndc = llaToECEF(pos.lat, pos.lon, pos.alt).project(camera);
      return { x: (ndc.x + 1) / 2, y: (1 - (ndc.y + 1) / 2), alt: pos.alt, visible: ndc.z < 1 };
    },

    getPilotScreenPositions(): Array<{ track: FlightTrack; x: number; y: number; lat: number; lon: number; alt: number; distance: number; visible: boolean }> {
      return tracks.getPilotPositionsAt(playback.currentSeconds)
        .filter(({ track }) => tracks.isTrackVisible(track.id))
        .map(({ track, lat, lon, alt }) => {
        const ecef = llaToECEF(lat, lon, alt);
        const ndc = ecef.clone().project(camera);
        return {
          track,
          x: (ndc.x + 1) / 2,
          y: (1 - (ndc.y + 1) / 2),
          lat,
          lon,
          alt,
          distance: camera.position.distanceTo(ecef),
          visible: ndc.z < 1,
        };
      });
    },

    /** Subscribe to track-load events so the UI can update when a file is dropped. */
    setOnTrackChange(cb: (track: FlightTrack | null) => void) {
      onTrackChangeCallback = cb;
      const track = tracks.getTrack();
      cb(track);
    },

    setOnTrackingChange(cb: (enabled: boolean) => void) {
      onTrackingChangeCallback = cb;
      cb(tracks.isTracking());
    },

    // --- Task API ---
    getTask(): IGCTask | null { return task; },
    getMasterTrackId(): string | null { return masterTrackId; },

    setMasterTrack(trackId: string): void {
      const rawText = igcTexts.get(trackId);
      if (!rawText) return;
      const parsed = parseTask(rawText);
      if (parsed) applyTask(parsed, trackId);
    },

    getTaskScoreAt(trackId: string, seconds: number): number {
      if (!task) return 0;
      const times = taskScoringCache.get(trackId) ?? [];
      return times.filter((t) => t !== null && t <= seconds).length;
    },

    /** UTC seconds at which `trackId` reached each scoreable turnpoint (null = not yet reached). */
    getTaskScoreTimes(trackId: string): (number | null)[] {
      if (!task) return [];
      return taskScoringCache.get(trackId) ?? [];
    },

    getDistanceToNextTPAt(trackId: string, seconds: number): number {
      if (!task) return Infinity;
      const times = taskScoringCache.get(trackId) ?? [];
      const nextIdx = times.findIndex((t) => t === null || t > seconds);
      if (nextIdx < 0) return Infinity;
      const tp = task.scoreable[nextIdx];
      const pos = tracks.getPilotPositionsAt(seconds).find((p) => p.track.id === trackId);
      if (!pos) return Infinity;
      return haversineDistanceM(pos.lat, pos.lon, tp.lat, tp.lon);
    },

    setOnTaskChange(cb: () => void): void {
      onTaskChangeCallback = cb;
    },

    /** Subscribe to tile-queue changes: cb(true) = loading started, cb(false) = all tiles settled. Returns a disposer. */
    onTilesLoadChange: tilesHandle.onTilesLoadChange,

    /** Live view settings — mutate atmosphere/shadow/tone-mapping nodes and signal the pipeline. */
    viewSettings: {
      setTransmittance(v: boolean) {
        pipeline.aerialNode.transmittance = v;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pipeline.renderPipeline as any).needsUpdate = true;
      },
      setInscattering(v: boolean) {
        pipeline.aerialNode.inscattering = v;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pipeline.renderPipeline as any).needsUpdate = true;
      },
      setShowGround(v: boolean) {
        atmosphere.atmosphereContext.showGround = v;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pipeline.renderPipeline as any).needsUpdate = true;
      },
      setRaymarchScattering(v: boolean) {
        atmosphere.atmosphereContext.raymarchScattering = v;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pipeline.renderPipeline as any).needsUpdate = true;
      },
      setShadowLength(v: boolean) {
        pipeline.enableShadowLength(v);
      },
      setDisplayShadowLength(v: boolean) {
        pipeline.setDisplayShadowLength(v);
      },
      setExposure(v: number) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const exposureNode = (pipeline.toneMappingNode as any).exposureNode;
        if (exposureNode) exposureNode.value = v;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pipeline.renderPipeline as any).needsUpdate = true;
      },
      setFancyLighting(enabled: boolean) {
        fancyLighting = enabled;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (renderer as any).shadowMap.enabled = enabled;
        pipeline.setColorScale(enabled ? 2 / 3 : 1.0);
        tilesHandle.setFancyMode(enabled);
        // Gradient sky only shows in non-fancy mode; fancy pipeline renders its own sky.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (scene as any).backgroundNode = enabled ? null : skyGradient;
        // When enabling: immediately clamp frustum for CSM.
        // When disabling: GlobeControls resumes managing near/far next frame.
        if (enabled) applyShadowSafeClip(camera);
      },
    },

    /** Playback controls exposed for the timeline UI. */
    playback: {
      seek(seconds: number) {
        const wholeSecond = Math.round(seconds);
        playback.currentSeconds = wholeSecond;
        if (playback.flightDate !== null) {
          currentDate = new Date(playback.flightDate.getTime() + wholeSecond * 1000);
        }
      },
      play() { playback.playing = true; },
      pause() { playback.playing = false; },
      setSpeed(s: number) { playback.speed = s; },
      isPlaying() { return playback.playing; },
      getCurrentSeconds() { return playback.currentSeconds; },
    },

    addLandmarkFile(filename: string, rawText: string, lms: Landmark[]) {
      addLandmarkFileInternal(filename, rawText, lms);
    },
    removeLandmarkFile(id: string) {
      const sprites = landmarkSprites.get(id);
      if (sprites) {
        for (const s of sprites) {
          scene.remove(s);
          (s.material as SpriteMaterial).map?.dispose();
          (s.material as SpriteMaterial).dispose();
        }
        landmarkSprites.delete(id);
      }
      landmarkFiles = landmarkFiles.filter((f) => f.id !== id);
      onLandmarksChangeCallback?.();
    },
    getLandmarkFiles(): readonly LandmarkFile[] {
      return landmarkFiles;
    },
    getLandmarks(): readonly Landmark[] {
      return landmarkFiles.flatMap((f) => f.landmarks as Landmark[]);
    },
    setOnLandmarksChange(cb: () => void) {
      onLandmarksChangeCallback = cb;
    },

    // --- Airspace API ---
    addAirspaceFile(filename: string, rawText: string, zones: Airspace[]) {
      addAirspaceFileInternal(filename, rawText, zones);
    },
    removeAirspaceFile(id: string) {
      airspace.removeFile(id);
      onAirspacesChangeCallback?.();
    },
    getAirspaceFiles(): readonly AirspaceFile[] {
      return airspace.getFiles();
    },
    setOnAirspacesChange(cb: () => void) {
      onAirspacesChangeCallback = cb;
    },

    /** Pick the airspace zone at normalized device coords (-1..1). Ground zones
     *  are resolved by intersecting the terrain and point-in-polygon testing. */
    pickAirspaceAtNDC(ndcX: number, ndcY: number): AirspacePick | null {
      airspacePickRay.setFromCamera(new Vector2(ndcX, ndcY), camera);
      const terrainHit = airspacePickRay.intersectObject(tilesHandle.tiles.group, true)[0] ?? null;
      return airspace.pick(airspacePickRay, terrainHit?.point ?? null, terrainHit?.distance ?? null);
    },

    dispose() {
      taskBuildId++;
      if (cameraAltitudeAnimId !== null) cancelAnimationFrame(cameraAltitudeAnimId);
      renderer.setAnimationLoop(null);
      postRenderCallbacks.clear();
      resizeObserver.disconnect();
      clearTaskObjects();
      for (const sprites of landmarkSprites.values()) {
        for (const s of sprites) {
          scene.remove(s);
          (s.material as SpriteMaterial).map?.dispose();
          (s.material as SpriteMaterial).dispose();
        }
      }
      airspace.dispose();
      tracks.dispose();
      globeControls.dispose();
      tilesHandle.dispose();
      pipeline.dispose();
      atmosphere.dispose();
      renderer.dispose();
    },
  };
}
