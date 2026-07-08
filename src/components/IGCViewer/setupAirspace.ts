import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  Raycaster,
  Scene,
  ShapeUtils,
  Vector2,
  Vector3,
} from 'three';
import { Line2NodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { llaToECEF } from './igc';
import { sampleTerrainElevationM } from './terrainElevation';
import { clearAirspaceOverlay, setAirspaceOverlay } from './airspaceOverlay';
import type { Airspace } from './parseAirspace';

export interface AirspaceFile {
  id: string;
  filename: string;
  rawText: string;
  airspaces: readonly Airspace[];
}

export interface AirspacePick {
  airspace: Airspace;
  fileId: string;
  distance: number;
}

// Ground zones (SFC–SFC) are painted onto the terrain via the tile-shader
// overlay texture — no geometry. Volumetric zones (published floor/ceiling)
// render as extruded prisms.
const OVERLAY_TARGET_M_PER_PX = 3;
const OVERLAY_MAX_TEXTURE_PX = 4096;
const OVERLAY_MARGIN_M = 200;
const OVERLAY_FILL_ALPHA = 0.42;
const OVERLAY_STROKE_ALPHA = 0.9;

const PRISM_GROUND_BLEED_M = 80;
const UNLIMITED_CEILING_AGL_M = 6000;
const PRISM_FILL_OPACITY = 0.18;
const OUTLINE_OPACITY = 0.85;
const OUTLINE_LINEWIDTH_PX = 1.5;

export function airspaceColor(cls: string): number {
  const c = cls.toUpperCase();
  if (c === 'R' || c === 'P' || c === 'Q' || c === 'DANGER') return 0xff453a; // restricted / no-land
  if (c === 'W') return 0x32d74b;                                            // wave window / LZ
  if (c === 'GP' || c === 'GSEC') return 0xff9f0a;
  if (c === 'CTR' || c === 'C' || c === 'D') return 0x0a84ff;
  if (c === 'A' || c === 'B') return 0xbf5af2;
  return 0x98989d;
}

export function airspaceClassLabel(cls: string): string {
  switch (cls.toUpperCase()) {
    case 'R': return 'Restricted / No-land';
    case 'P': return 'Prohibited';
    case 'Q': return 'Danger';
    case 'W': return 'Wave window / LZ';
    case 'GP': return 'Glider prohibited';
    case 'CTR': return 'Control zone';
    case 'A': case 'B': case 'C': case 'D': case 'E': case 'F': case 'G':
      return `Class ${cls.toUpperCase()}`;
    default: return cls;
  }
}

function dedupePoints(points: readonly { lat: number; lon: number }[]): { lat: number; lon: number }[] {
  const out: { lat: number; lon: number }[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.lat - p.lat) < 1e-9 && Math.abs(last.lon - p.lon) < 1e-9) continue;
    out.push(p);
  }
  if (out.length > 1) {
    const first = out[0], last = out[out.length - 1];
    if (Math.abs(first.lat - last.lat) < 1e-9 && Math.abs(first.lon - last.lon) < 1e-9) out.pop();
  }
  return out;
}

function isGroundZone(a: Airspace): boolean {
  return a.floor.ref === 'sfc' && a.ceiling.ref === 'sfc';
}

function cssColor(hex: number, alpha: number): string {
  return `rgba(${(hex >> 16) & 0xff},${(hex >> 8) & 0xff},${hex & 0xff},${alpha})`;
}

/** Even-odd point-in-polygon test in 2D. */
function pointInPolygon(x: number, y: number, poly: Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

interface GroundZone {
  fileId: string;
  airspace: Airspace;
  /** Polygon vertices in ECEF at zero elevation (elevation-invariant tangent projection). */
  ecefRing: Vector3[];
  /** Region tangent-plane coords; refreshed on every overlay redraw. */
  poly2D: Vector2[];
  areaM2: number;
}

interface PrismZone {
  fileId: string;
  airspace: Airspace;
  mesh: Mesh;
  outline: Line2;
}

interface OverlayRegionState {
  centerEcef: Vector3;   // ECEF of the overlay rectangle centre
  east: Vector3;
  north: Vector3;
  halfWidthM: number;
  halfHeightM: number;
  surfaceRadiusM: number; // for ray-sphere fallback picking when tiles aren't loaded
}

export function createAirspaceManager(scene: Scene) {
  let files: AirspaceFile[] = [];
  const liveFileIds = new Set<string>();
  const groundZones: GroundZone[] = [];
  const prismZones: PrismZone[] = [];
  const materialCache = new Map<number, { fill: MeshBasicNodeMaterial; line: Line2NodeMaterial }>();
  let region: OverlayRegionState | null = null;

  function materialsFor(cls: string) {
    const color = airspaceColor(cls);
    let cached = materialCache.get(color);
    if (!cached) {
      cached = {
        fill: new MeshBasicNodeMaterial({
          color, transparent: true, opacity: PRISM_FILL_OPACITY, side: DoubleSide, depthTest: true, depthWrite: false,
        }),
        line: new Line2NodeMaterial({
          color, linewidth: OUTLINE_LINEWIDTH_PX, transparent: true, opacity: OUTLINE_OPACITY, depthTest: true, depthWrite: false,
        }),
      };
      materialCache.set(color, cached);
    }
    return cached;
  }

  // ── Ground zones: rasterized overlay ─────────────────────────────────

  function redrawOverlay(): void {
    if (groundZones.length === 0) {
      region = null;
      clearAirspaceOverlay();
      return;
    }

    // Region basis: tangent plane at the centroid of all zone centres.
    const centroid = new Vector3();
    for (const z of groundZones) {
      const c = new Vector3();
      for (const v of z.ecefRing) c.add(v);
      centroid.addScaledVector(c, 1 / z.ecefRing.length);
    }
    centroid.multiplyScalar(1 / groundZones.length);
    const up = centroid.clone().normalize();
    const east = new Vector3(-centroid.y, centroid.x, 0).normalize();
    const north = new Vector3().crossVectors(up, east).normalize();

    // Project all rings into tangent-plane metres; collect bounds.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const rel = new Vector3();
    for (const z of groundZones) {
      z.poly2D = z.ecefRing.map((v) => {
        rel.copy(v).sub(centroid);
        const p = new Vector2(rel.dot(east), rel.dot(north));
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        return p;
      });
      z.areaM2 = Math.abs(ShapeUtils.area(z.poly2D));
    }
    minX -= OVERLAY_MARGIN_M; minY -= OVERLAY_MARGIN_M;
    maxX += OVERLAY_MARGIN_M; maxY += OVERLAY_MARGIN_M;

    const widthM = maxX - minX;
    const heightM = maxY - minY;
    const mPerPx = Math.max(OVERLAY_TARGET_M_PER_PX, Math.max(widthM, heightM) / OVERLAY_MAX_TEXTURE_PX);
    const pxW = Math.max(2, Math.ceil(widthM / mPerPx));
    const pxH = Math.max(2, Math.ceil(heightM / mPerPx));

    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    const ctx = canvas.getContext('2d')!;
    ctx.lineWidth = Math.min(3, Math.max(1.25, 15 / mPerPx));
    ctx.lineJoin = 'round';

    // Canvas rows run top-down; texture v runs bottom-up (flipY) — draw with north up.
    const toPx = (p: Vector2) => [(p.x - minX) / mPerPx, (maxY - p.y) / mPerPx] as const;
    for (const z of groundZones) {
      ctx.beginPath();
      const [x0, y0] = toPx(z.poly2D[0]);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < z.poly2D.length; i++) {
        const [x, y] = toPx(z.poly2D[i]);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      const color = airspaceColor(z.airspace.cls);
      ctx.fillStyle = cssColor(color, OVERLAY_FILL_ALPHA);
      ctx.strokeStyle = cssColor(color, OVERLAY_STROKE_ALPHA);
      ctx.fill();
      ctx.stroke();
    }

    // Shader uniforms describe the rectangle centre, not the tangent origin.
    const rectCenter2D = new Vector2((minX + maxX) / 2, (minY + maxY) / 2);
    const centerEcef = centroid.clone()
      .addScaledVector(east, rectCenter2D.x)
      .addScaledVector(north, rectCenter2D.y);
    // Shift zone polys so they share the rectangle-centre origin used for picking.
    for (const z of groundZones) {
      for (const p of z.poly2D) p.sub(rectCenter2D);
    }

    region = {
      centerEcef,
      east,
      north,
      halfWidthM: widthM / 2,
      halfHeightM: heightM / 2,
      surfaceRadiusM: centroid.length(),
    };
    setAirspaceOverlay(canvas, {
      centerEcef,
      eastEcef: east,
      northEcef: north,
      halfWidthM: widthM / 2,
      halfHeightM: heightM / 2,
    });
  }

  function addGroundZone(fileId: string, airspace: Airspace, points: { lat: number; lon: number }[]): void {
    groundZones.push({
      fileId,
      airspace,
      ecefRing: points.map((p) => llaToECEF(p.lat, p.lon, 0)),
      poly2D: [],
      areaM2: 0,
    });
  }

  /** Ground zone under an ECEF surface point (smallest zone wins on overlap). */
  function groundZoneAtEcef(point: Vector3): GroundZone | null {
    if (!region) return null;
    const rel = point.clone().sub(region.centerEcef);
    const x = rel.dot(region.east);
    const y = rel.dot(region.north);
    if (Math.abs(x) > region.halfWidthM || Math.abs(y) > region.halfHeightM) return null;
    let best: GroundZone | null = null;
    for (const z of groundZones) {
      if (z.poly2D.length >= 3 && pointInPolygon(x, y, z.poly2D)) {
        if (!best || z.areaM2 < best.areaM2) best = z;
      }
    }
    return best;
  }

  /** Ray → sphere at the region's surface radius; used when no tile terrain is loaded yet. */
  function raySurfaceFallback(raycaster: Raycaster): Vector3 | null {
    if (!region) return null;
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    const r = region.surfaceRadiusM;
    const b = o.dot(d);
    const c = o.lengthSq() - r * r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const sqrtDisc = Math.sqrt(disc);
    const t = -b - sqrtDisc > 0 ? -b - sqrtDisc : -b + sqrtDisc;
    return t > 0 ? o.clone().addScaledVector(d, t) : null;
  }

  // ── Volumetric zones: extruded prisms ────────────────────────────────

  async function buildPrismZone(fileId: string, airspace: Airspace, points: { lat: number; lon: number }[]): Promise<void> {
    const centerLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const centerLon = points.reduce((s, p) => s + p.lon, 0) / points.length;

    const elevations = (await Promise.all(
      [...points, { lat: centerLat, lon: centerLon }].map((p) => sampleTerrainElevationM(p.lat, p.lon).catch(() => null)),
    )).filter((v): v is number => v !== null);
    if (!liveFileIds.has(fileId)) return;
    const terrainMin = elevations.length > 0 ? Math.min(...elevations) : 0;
    const terrainMax = elevations.length > 0 ? Math.max(...elevations) : 0;

    const { floor, ceiling } = airspace;
    let floorM =
      floor.ref === 'sfc' ? terrainMin - PRISM_GROUND_BLEED_M :
      floor.ref === 'agl' ? terrainMin + floor.meters :
      floor.ref === 'unlimited' ? terrainMax + UNLIMITED_CEILING_AGL_M :
      floor.meters;
    if ((floor.ref === 'msl' || floor.ref === 'fl') && floorM <= terrainMin) floorM = terrainMin - PRISM_GROUND_BLEED_M;
    let ceilM =
      ceiling.ref === 'agl' ? terrainMax + ceiling.meters :
      ceiling.ref === 'unlimited' ? terrainMax + UNLIMITED_CEILING_AGL_M :
      ceiling.meters;
    if (ceilM <= floorM + 2) ceilM = terrainMax + PRISM_GROUND_BLEED_M;

    const centerEcef = llaToECEF(centerLat, centerLon, (floorM + ceilM) / 2);
    const up = centerEcef.clone().normalize();
    const east = new Vector3(-centerEcef.y, centerEcef.x, 0).normalize();
    const north = new Vector3().crossVectors(up, east).normalize();

    const n = points.length;
    const bottom: Vector3[] = [];
    const top: Vector3[] = [];
    for (const p of points) {
      bottom.push(llaToECEF(p.lat, p.lon, floorM).sub(centerEcef));
      top.push(llaToECEF(p.lat, p.lon, ceilM).sub(centerEcef));
    }

    const positions = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      positions.set([bottom[i].x, bottom[i].y, bottom[i].z], i * 3);
      positions.set([top[i].x, top[i].y, top[i].z], (n + i) * 3);
    }
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      indices.push(i, j, n + j, i, n + j, n + i);
    }
    const contour2d = top.map((v) => new Vector2(v.dot(east), v.dot(north)));
    for (const tri of ShapeUtils.triangulateShape(contour2d, [])) {
      indices.push(n + tri[0], n + tri[1], n + tri[2]);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);

    const { fill, line } = materialsFor(airspace.cls);
    const mesh = new Mesh(geometry, fill);
    mesh.position.copy(centerEcef);
    mesh.frustumCulled = false;
    mesh.userData.airspace = airspace;
    mesh.userData.fileId = fileId;

    const rim: number[] = [];
    for (let i = 0; i <= n; i++) {
      const v = top[i % n];
      rim.push(v.x, v.y, v.z);
    }
    const rimGeo = new LineGeometry();
    rimGeo.setPositions(rim);
    const outline = new Line2(rimGeo, line);
    outline.position.copy(centerEcef);
    outline.frustumCulled = false;

    scene.add(mesh, outline);
    prismZones.push({ fileId, airspace, mesh, outline });
  }

  function disposePrism(z: PrismZone): void {
    scene.remove(z.mesh, z.outline);
    z.mesh.geometry.dispose();
    z.outline.geometry.dispose();
    // Materials are shared via materialCache; disposed with the manager.
  }

  return {
    addFile(filename: string, rawText: string, airspaces: Airspace[]): AirspaceFile {
      const file: AirspaceFile = { id: `${Date.now()}-${filename}`, filename, rawText, airspaces };
      files = [...files, file];
      liveFileIds.add(file.id);
      for (const a of airspaces) {
        const points = dedupePoints(a.points);
        if (points.length < 3) continue;
        if (isGroundZone(a)) addGroundZone(file.id, a, points);
        else void buildPrismZone(file.id, a, points);
      }
      redrawOverlay();
      return file;
    },

    removeFile(id: string): void {
      liveFileIds.delete(id);
      for (let i = groundZones.length - 1; i >= 0; i--) {
        if (groundZones[i].fileId === id) groundZones.splice(i, 1);
      }
      for (let i = prismZones.length - 1; i >= 0; i--) {
        if (prismZones[i].fileId === id) {
          disposePrism(prismZones[i]);
          prismZones.splice(i, 1);
        }
      }
      files = files.filter((f) => f.id !== id);
      redrawOverlay();
    },

    getFiles(): readonly AirspaceFile[] {
      return files;
    },

    /**
     * Pick the airspace along a ray. `terrainPoint` is the tiles hit for this
     * ray (or null when no tile geometry is loaded there yet — then an
     * ellipsoid-sphere fallback approximates the ground point).
     */
    pick(raycaster: Raycaster, terrainPoint: Vector3 | null, terrainDistance: number | null): AirspacePick | null {
      let prismPick: AirspacePick | null = null;
      if (prismZones.length > 0) {
        const hit = raycaster.intersectObjects(prismZones.map((z) => z.mesh), false)[0];
        if (hit && (terrainDistance === null || hit.distance <= terrainDistance + 1)) {
          prismPick = {
            airspace: hit.object.userData.airspace as Airspace,
            fileId: hit.object.userData.fileId as string,
            distance: hit.distance,
          };
        }
      }

      const groundPoint = terrainPoint ?? raySurfaceFallback(raycaster);
      let groundPick: AirspacePick | null = null;
      if (groundPoint) {
        const zone = groundZoneAtEcef(groundPoint);
        if (zone) {
          groundPick = {
            airspace: zone.airspace,
            fileId: zone.fileId,
            distance: raycaster.ray.origin.distanceTo(groundPoint),
          };
        }
      }

      if (prismPick && groundPick) return prismPick.distance <= groundPick.distance ? prismPick : groundPick;
      return prismPick ?? groundPick;
    },

    dispose(): void {
      liveFileIds.clear();
      for (const z of prismZones) disposePrism(z);
      prismZones.length = 0;
      groundZones.length = 0;
      for (const mats of materialCache.values()) {
        mats.fill.dispose();
        mats.line.dispose();
      }
      materialCache.clear();
      files = [];
      clearAirspaceOverlay();
    },
  };
}
