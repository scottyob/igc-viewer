import {
  CanvasTexture,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  SRGBColorSpace,
  Vector2,
} from 'three';
import type { Vector3 } from 'three';
import { atan, float, log, mix, positionWorld, sqrt, texture, uniform, vec2 } from 'three/tsl';

/**
 * Raster map overlays (OpenStreetMap, thermal.kk7.ch, any XYZ tile server)
 * painted onto the terrain inside the tile material shader. Each loaded 3D
 * tile gets a small canvas assembled from the slippy tiles covering its
 * footprint, at a zoom matched to the 3D tile's size — so overlay sharpness
 * tracks tile LOD, exactly like the airspace overlay.
 *
 * Mapping is Web Mercator: the shader computes geodetic lat/lon from the
 * fragment's ECEF position (Bowring's method) and remaps to each 3D tile's
 * mercator rectangle. Exact at any elevation, valid globally.
 */

export interface MapTileSource {
  id: string;
  label: string;
  /** XYZ URL template with {z}, {x}, {y} placeholders ({-y} for TMS south-origin Y). */
  template: string;
  maxZoom: number;
  attribution: string;
}

// Listed in stacking order: earlier sources draw first (underneath).
export const MAP_TILE_SOURCES: MapTileSource[] = [
  {
    id: 'osm',
    label: 'OpenStreetMap',
    template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  },
  {
    // kk7 serves TMS-scheme tiles (south-origin Y) — hence {-y}.
    id: 'kk7-thermals',
    label: 'Thermals (kk7)',
    template: 'https://thermal.kk7.ch/tiles/thermals_all_all/{z}/{x}/{-y}.png?src=github.com/scottyob/igc-viewer',
    maxZoom: 12,
    attribution: 'thermal.kk7.ch',
  },
  {
    id: 'kk7-skyways',
    label: 'Skyways (kk7)',
    template: 'https://thermal.kk7.ch/tiles/skyways_all_all/{z}/{x}/{-y}.png?src=github.com/scottyob/igc-viewer',
    maxZoom: 12,
    attribution: 'thermal.kk7.ch',
  },
  {
    // Transparent roads-only reference layer, designed for overlaying imagery.
    // Rural coverage runs out above z15 — deeper views upscale z15 tiles.
    id: 'esri-roads',
    label: 'Roads',
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 15,
    attribution: 'Esri, HERE, Garmin',
  },
];

const MAX_GRID_TILES = 3;       // per axis per 3D tile (≤ 3×3 slippy tiles per raster)
const TILE_PX = 256;
const CACHE_MAX_TILES = 400;
const MAX_MERC_LAT = 85.05112878;

// ── State ────────────────────────────────────────────────────────────────

// Roads are on by default — a transparent reference layer that helps orient
// without obscuring the imagery.
let activeSources: MapTileSource[] = MAP_TILE_SOURCES.filter((s) => s.id === 'esri-roads');
let version = 0;
const opacityU = uniform(0.75);

export function mapOverlayVersion(): number {
  return version;
}

/** Replace the set of active overlay layers (kept in MAP_TILE_SOURCES stacking order, unknown ids last). */
export function setActiveMapSources(sources: MapTileSource[]): void {
  const order = (s: MapTileSource) => {
    const i = MAP_TILE_SOURCES.findIndex((p) => p.id === s.id);
    return i === -1 ? MAP_TILE_SOURCES.length : i;
  };
  activeSources = [...sources].sort((a, b) => order(a) - order(b));
  version++;
}

export function getActiveMapSources(): readonly MapTileSource[] {
  return activeSources;
}

export function setMapOverlayOpacity(v: number): void {
  opacityU.value = Math.min(1, Math.max(0, v));
}

export function getMapOverlayOpacity(): number {
  return opacityU.value as number;
}

// ── Slippy tile fetch cache (LRU) ────────────────────────────────────────

interface TileCacheEntry {
  promise: Promise<ImageBitmap | null>;
  resolved: boolean;
  bitmap: ImageBitmap | null;
}

const tileCache = new Map<string, TileCacheEntry>();

function fetchTile(url: string): TileCacheEntry {
  const cached = tileCache.get(url);
  if (cached) {
    // Refresh LRU position.
    tileCache.delete(url);
    tileCache.set(url, cached);
    return cached;
  }
  const entry: TileCacheEntry = { promise: Promise.resolve(null), resolved: false, bitmap: null };
  entry.promise = fetch(url, { mode: 'cors' })
    .then((r) => (r.ok ? r.blob() : null))
    .then((blob) => (blob ? createImageBitmap(blob) : null))
    .catch(() => null)
    .then((bitmap) => {
      entry.bitmap = bitmap;
      entry.resolved = true;
      return bitmap;
    });
  tileCache.set(url, entry);
  if (tileCache.size > CACHE_MAX_TILES) {
    const oldest = tileCache.keys().next().value;
    if (oldest !== undefined) tileCache.delete(oldest);
  }
  return entry;
}

/** Cached-and-settled bitmap lookup; undefined = not fetched or still in flight. */
function cachedTile(url: string): ImageBitmap | null | undefined {
  const entry = tileCache.get(url);
  return entry?.resolved ? entry.bitmap : undefined;
}

// ── Geodesy ──────────────────────────────────────────────────────────────

const WGS84_A = 6378137.0;
const WGS84_B = 6356752.314245;
const WGS84_E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
const WGS84_EP2 = (WGS84_A * WGS84_A) / (WGS84_B * WGS84_B) - 1;

/** ECEF → geodetic lat/lon (radians) via Bowring's method (single iteration). */
export function ecefToGeodetic(p: Vector3): { latRad: number; lonRad: number } {
  const pxy = Math.sqrt(p.x * p.x + p.y * p.y);
  const theta = Math.atan2(p.z * WGS84_A, pxy * WGS84_B);
  const sin3 = Math.sin(theta) ** 3;
  const cos3 = Math.cos(theta) ** 3;
  return {
    latRad: Math.atan2(p.z + WGS84_EP2 * WGS84_B * sin3, pxy - WGS84_E2 * WGS84_A * cos3),
    lonRad: Math.atan2(p.y, p.x),
  };
}

/** Geodetic (radians) → mercator unit coords: X,Y ∈ [0,1] at zoom 0, Y grows southward. */
export function geodeticToMercatorUnit(latRad: number, lonRad: number): Vector2 {
  const clampedLat = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, latRad * 180 / Math.PI)) * Math.PI / 180;
  return new Vector2(
    (lonRad + Math.PI) / (2 * Math.PI),
    (Math.PI - Math.asinh(Math.tan(clampedLat))) / (2 * Math.PI),
  );
}

// ── Per-material shader node ─────────────────────────────────────────────

const emptyTexture = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
emptyTexture.needsUpdate = true;

export interface MapOverlayHandle {
  /** Present the raster over the mercator-unit rectangle [minX,minY]–[maxX,maxY]. */
  setTile(tex: CanvasTexture, minX: number, minY: number, maxX: number, maxY: number): void;
  disable(): void;
}

/**
 * Build the map-overlay color node for one tile material. Node structure is
 * identical across materials so WebGPU pipelines stay shared.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMapOverlayColorNode(baseColor: any): { colorNode: any; handle: MapOverlayHandle } {
  const rectMinU = uniform(new Vector2());
  const rectInvSizeU = uniform(new Vector2(1, 1));
  const strengthU = uniform(0);

  // Geodetic latitude via Bowring (matches ecefToGeodetic above).
  const px = positionWorld.x, py = positionWorld.y, pz = positionWorld.z;
  const pxy = sqrt(px.mul(px).add(py.mul(py)));
  const theta = atan(pz.mul(WGS84_A), pxy.mul(WGS84_B));
  const sinT = theta.sin(), cosT = theta.cos();
  const lat = atan(
    pz.add(sinT.mul(sinT).mul(sinT).mul(WGS84_EP2 * WGS84_B)),
    pxy.sub(cosT.mul(cosT).mul(cosT).mul(WGS84_E2 * WGS84_A)),
  );
  const lon = atan(py, px);

  // Mercator unit coords (Y grows southward, matching slippy tile Y).
  const tanLat = lat.tan();
  const mercX = lon.add(Math.PI).div(2 * Math.PI);
  const mercY = float(Math.PI).sub(log(tanLat.add(sqrt(tanLat.mul(tanLat).add(1))))).div(2 * Math.PI);

  // v flipped: rect minY is the north edge = top canvas row = v 1 (flipY texture).
  const local = vec2(mercX, mercY).sub(rectMinU).mul(rectInvSizeU);
  const uv = vec2(local.x, float(1).sub(local.y));
  const overlaySample = texture(emptyTexture, uv);
  const alpha = overlaySample.a.mul(strengthU).mul(opacityU);

  return {
    colorNode: mix(baseColor.rgb, overlaySample.rgb, alpha),
    handle: {
      setTile(tex, minX, minY, maxX, maxY) {
        overlaySample.value = tex;
        rectMinU.value.set(minX, minY);
        rectInvSizeU.value.set(1 / (maxX - minX), 1 / (maxY - minY));
        strengthU.value = 1;
      },
      disable() {
        overlaySample.value = emptyTexture;
        strengthU.value = 0;
      },
    },
  };
}

// ── Per-3D-tile raster assembly ──────────────────────────────────────────

export interface MapRaster {
  texture: CanvasTexture;
  /** Layer/zoom composition key — identical signature means identical content. */
  signature: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface TileGrid {
  z: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  tiles: { url: string; tx: number; ty: number }[];
}

function gridForRect(source: MapTileSource, minX: number, minY: number, maxX: number, maxY: number, z: number): TileGrid {
  const n = 2 ** z;
  const x0 = Math.max(0, Math.floor(minX * n));
  const x1 = Math.min(n - 1, Math.floor(maxX * n));
  const y0 = Math.max(0, Math.floor(minY * n));
  const y1 = Math.min(n - 1, Math.floor(maxY * n));
  const tiles: TileGrid['tiles'] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      tiles.push({
        url: source.template
          .replace('{z}', String(z))
          .replace('{x}', String(tx))
          .replace('{-y}', String(n - 1 - ty)) // TMS south-origin Y
          .replace('{y}', String(ty)),
        tx, ty,
      });
    }
  }
  return { z, x0, x1, y0, y1, tiles };
}

/** Zoom so the footprint spans roughly MAX_GRID_TILES slippy tiles (capped by grid size). */
function targetZoom(source: MapTileSource, minX: number, minY: number, maxX: number, maxY: number): number {
  const span = Math.max(maxX - minX, maxY - minY);
  let z = Math.min(source.maxZoom, Math.max(0, Math.floor(Math.log2(MAX_GRID_TILES / span))));
  for (; z > 0; z--) {
    const n = 2 ** z;
    if (Math.floor(maxX * n) - Math.floor(minX * n) < MAX_GRID_TILES
      && Math.floor(maxY * n) - Math.floor(minY * n) < MAX_GRID_TILES) break;
  }
  return z;
}

interface LayerPlan {
  source: MapTileSource;
  grid: TileGrid;
}

function clampRect(minX: number, minY: number, maxX: number, maxY: number): [number, number, number, number] | null {
  // Slight pad so linear filtering at the rect edge doesn't bleed a hard cut.
  const padX = (maxX - minX) * 0.01;
  const padY = (maxY - minY) * 0.01;
  const cMinX = Math.max(0, minX - padX), cMinY = Math.max(0, minY - padY);
  const cMaxX = Math.min(1, maxX + padX), cMaxY = Math.min(1, maxY + padY);
  return cMaxX <= cMinX || cMaxY <= cMinY ? null : [cMinX, cMinY, cMaxX, cMaxY];
}

function signatureOf(plans: LayerPlan[]): string {
  return plans.map((p) => `${p.source.id}:${p.grid.z}`).join('|');
}

/** Composite every planned layer (in stacking order) into one canvas over `rect`. */
function assembleLayers(rect: [number, number, number, number], plans: LayerPlan[], bitmaps: (ImageBitmap | null)[][]): MapRaster {
  const [minX, minY, maxX, maxY] = rect;
  const rectW = maxX - minX;
  const rectH = maxY - minY;
  const zMax = Math.max(...plans.map((p) => p.grid.z));
  const pxPerUnit = 2 ** zMax * TILE_PX;
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(800, Math.max(2, Math.round(rectW * pxPerUnit)));
  canvas.height = Math.min(800, Math.max(2, Math.round(rectH * pxPerUnit)));
  const ctx = canvas.getContext('2d')!;

  // Canvas rows top-down = north to south, same direction as mercator Y.
  for (let p = 0; p < plans.length; p++) {
    const { grid } = plans[p];
    const n = 2 ** grid.z;
    for (let i = 0; i < grid.tiles.length; i++) {
      const bmp = bitmaps[p][i];
      if (!bmp) continue;
      const { tx, ty } = grid.tiles[i];
      const dx = ((tx / n - minX) / rectW) * canvas.width;
      const dy = ((ty / n - minY) / rectH) * canvas.height;
      const dw = (1 / n / rectW) * canvas.width;
      const dh = (1 / n / rectH) * canvas.height;
      ctx.drawImage(bmp, dx, dy, dw, dh);
    }
  }

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;

  return { texture: tex, signature: signatureOf(plans), minX, minY, maxX, maxY };
}

/**
 * Synchronous best-effort raster from tiles already in the cache. Each active
 * layer independently falls back to the nearest fully-settled coarser zoom
 * (usually the parent 3D tile's). Used to seed freshly loaded 3D tiles
 * instantly, so LOD churn never blinks the overlay off.
 */
export function assembleMapRasterFromCache(minX: number, minY: number, maxX: number, maxY: number): MapRaster | null {
  if (activeSources.length === 0) return null;
  const rect = clampRect(minX, minY, maxX, maxY);
  if (!rect) return null;

  const plans: LayerPlan[] = [];
  const bitmaps: (ImageBitmap | null)[][] = [];
  for (const source of activeSources) {
    const zTarget = targetZoom(source, ...rect);
    for (let z = zTarget; z >= Math.max(0, zTarget - 8); z--) {
      const grid = gridForRect(source, rect[0], rect[1], rect[2], rect[3], z);
      if (grid.tiles.length === 0) break;
      const level = grid.tiles.map((t) => cachedTile(t.url));
      if (level.some((b) => b === undefined)) continue; // level not fully settled
      plans.push({ source, grid });
      bitmaps.push(level as (ImageBitmap | null)[]);
      break;
    }
  }
  if (plans.length === 0) return null;
  return assembleLayers(rect, plans, bitmaps);
}

/**
 * Fetch + composite all active layers covering a mercator-unit rectangle.
 * Resolves null when no layers are active or nothing could be fetched.
 */
export async function buildMapRaster(minX: number, minY: number, maxX: number, maxY: number): Promise<MapRaster | null> {
  const sources = activeSources;
  const startVersion = version;
  if (sources.length === 0) return null;
  const rect = clampRect(minX, minY, maxX, maxY);
  if (!rect) return null;

  const plans: LayerPlan[] = sources.map((source) => ({
    source,
    grid: gridForRect(source, ...rect, targetZoom(source, ...rect)),
  }));
  const bitmaps = await Promise.all(
    plans.map((p) => Promise.all(p.grid.tiles.map((t) => fetchTile(t.url).promise))),
  );
  if (version !== startVersion) return null; // layer set changed while fetching
  if (bitmaps.every((level) => level.every((b) => b === null))) return null;
  return assembleLayers(rect, plans, bitmaps);
}
