import {
  CanvasTexture,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from 'three';
import { mix, uniform, positionWorld, texture, vec2 } from 'three/tsl';

/**
 * Ground airspace zones are painted onto the terrain inside the tile material
 * shader. Every loaded tile that intersects a zone gets its own small overlay
 * texture rasterized over just that tile's footprint, so overlay sharpness
 * tracks tile LOD exactly — crisp up close, cheap far away. World position is
 * projected onto a shared tangent-plane frame (two dot products) and remapped
 * to each tile's rectangle, which makes the paint hug the photorealistic
 * surface at zero geometry / raycast cost.
 */

export interface OverlayZone2D {
  /** Polygon in tangent-frame metres (origin at the zone-set centroid). */
  poly: Vector2[];
  color: number;
  bboxMin: Vector2;
  bboxMax: Vector2;
}

export interface OverlaySource {
  originEcef: Vector3;
  east: Vector3;
  north: Vector3;
  zones: OverlayZone2D[];
  boundsMin: Vector2;
  boundsMax: Vector2;
}

const OVERLAY_MAX_TILE_PX = 512;
const OVERLAY_MIN_M_PER_PX = 0.5;
const OVERLAY_FILL_ALPHA = 0.42;
const OVERLAY_STROKE_ALPHA = 0.9;
const OVERLAY_STROKE_WIDTH_M = 5;

const emptyTexture = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
emptyTexture.needsUpdate = true;

// Tangent frame shared by every tile overlay (set when a source is installed).
const originU = uniform(new Vector3());
const eastU = uniform(new Vector3());
const northU = uniform(new Vector3());

let source: OverlaySource | null = null;
let version = 0;

export function overlayVersion(): number {
  return version;
}

export function setOverlaySource(next: OverlaySource | null): void {
  source = next;
  version++;
  if (next) {
    originU.value.copy(next.originEcef);
    eastU.value.copy(next.east);
    northU.value.copy(next.north);
  }
}

/** Project an ECEF point into the shared tangent frame (metres). */
export function projectEcefToFrame(p: Vector3, out: Vector2): Vector2 | null {
  if (!source) return null;
  const rx = p.x - source.originEcef.x;
  const ry = p.y - source.originEcef.y;
  const rz = p.z - source.originEcef.z;
  const { east, north } = source;
  return out.set(
    rx * east.x + ry * east.y + rz * east.z,
    rx * north.x + ry * north.y + rz * north.z,
  );
}

export interface OverlayHandle {
  /** Present the given raster over the frame-space rectangle. */
  setTile(tex: CanvasTexture, centerX: number, centerY: number, halfW: number, halfH: number): void;
  disable(): void;
}

/**
 * Build the color node + per-material uniforms for one tile material.
 * The node structure is identical across materials, so WebGPU pipelines are shared.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createOverlayColorNode(baseColor: any): { colorNode: any; handle: OverlayHandle } {
  const tileCenterU = uniform(new Vector2());
  const invHalfU = uniform(new Vector2(1, 1));
  const strengthU = uniform(0);

  const rel = positionWorld.sub(originU);
  const frame2D = vec2(rel.dot(eastU), rel.dot(northU));
  const centered = frame2D.sub(tileCenterU).mul(invHalfU); // -1..1 across the tile rect
  const sampleNode = texture(emptyTexture, centered.mul(0.5).add(0.5));
  const alpha = sampleNode.a.mul(strengthU);

  return {
    colorNode: mix(baseColor.rgb, sampleNode.rgb, alpha),
    handle: {
      setTile(tex, centerX, centerY, halfW, halfH) {
        sampleNode.value = tex;
        tileCenterU.value.set(centerX, centerY);
        invHalfU.value.set(1 / halfW, 1 / halfH);
        strengthU.value = 1;
      },
      disable() {
        sampleNode.value = emptyTexture;
        strengthU.value = 0;
      },
    },
  };
}

function cssColor(hex: number, alpha: number): string {
  return `rgba(${(hex >> 16) & 0xff},${(hex >> 8) & 0xff},${hex & 0xff},${alpha})`;
}

export interface OverlayRaster {
  texture: CanvasTexture;
  centerX: number;
  centerY: number;
  halfW: number;
  halfH: number;
}

/**
 * Rasterize the zones covering a frame-space rectangle (a tile's footprint).
 * Returns null when no zone touches it.
 */
export function rasterizeOverlayRect(minX: number, minY: number, maxX: number, maxY: number): OverlayRaster | null {
  if (!source) return null;
  if (maxX < source.boundsMin.x || minX > source.boundsMax.x) return null;
  if (maxY < source.boundsMin.y || minY > source.boundsMax.y) return null;

  const zones = source.zones.filter((z) =>
    maxX >= z.bboxMin.x && minX <= z.bboxMax.x && maxY >= z.bboxMin.y && minY <= z.bboxMax.y,
  );
  if (zones.length === 0) return null;

  const mPerPx = Math.max(OVERLAY_MIN_M_PER_PX, Math.max(maxX - minX, maxY - minY) / OVERLAY_MAX_TILE_PX);
  // Pad so linear filtering at the rect edge doesn't bleed a hard cut line.
  const pad = 2 * mPerPx;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const pxW = Math.max(2, Math.ceil((maxX - minX) / mPerPx));
  const pxH = Math.max(2, Math.ceil((maxY - minY) / mPerPx));
  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const ctx = canvas.getContext('2d')!;
  ctx.lineWidth = Math.max(1.25, OVERLAY_STROKE_WIDTH_M / mPerPx);
  ctx.lineJoin = 'round';

  // Canvas rows run top-down; texture v runs bottom-up (flipY) — north up.
  for (const z of zones) {
    ctx.beginPath();
    ctx.moveTo((z.poly[0].x - minX) / mPerPx, (maxY - z.poly[0].y) / mPerPx);
    for (let i = 1; i < z.poly.length; i++) {
      ctx.lineTo((z.poly[i].x - minX) / mPerPx, (maxY - z.poly[i].y) / mPerPx);
    }
    ctx.closePath();
    ctx.fillStyle = cssColor(z.color, OVERLAY_FILL_ALPHA);
    ctx.strokeStyle = cssColor(z.color, OVERLAY_STROKE_ALPHA);
    ctx.fill();
    ctx.stroke();
  }

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;

  return {
    texture: tex,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    halfW: (maxX - minX) / 2,
    halfH: (maxY - minY) / 2,
  };
}
