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
import type { Texture } from 'three';
import { mix, positionWorld, step, texture, uniform, vec2 } from 'three/tsl';

/**
 * Ground airspace zones are rasterized once into a single RGBA canvas and
 * composited onto the terrain inside the tile material shader. World position
 * is projected onto the region's tangent plane (dot products with the east /
 * north basis), which makes the overlay hug the photorealistic tiles exactly,
 * at zero geometry / raycast cost.
 */

const emptyTexture = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
emptyTexture.needsUpdate = true;

const centerU = uniform(new Vector3());
const eastU = uniform(new Vector3());
const northU = uniform(new Vector3());
const invHalfU = uniform(new Vector2(1, 1));
const strengthU = uniform(0);

// Centered tangent-plane coords in -1..1 across the overlay region.
const rel = positionWorld.sub(centerU);
const uc = rel.dot(eastU).mul(invHalfU.x);
const vc = rel.dot(northU).mul(invHalfU.y);
const overlaySample = texture(emptyTexture, vec2(uc, vc).mul(0.5).add(0.5));
const insideRegion = step(uc.abs(), 1).mul(step(vc.abs(), 1));
const overlayAlpha = overlaySample.a.mul(insideRegion).mul(strengthU);

let currentTexture: Texture = emptyTexture;

/** Wrap a material's base color node so airspace zones paint over the terrain. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withAirspaceOverlay(baseColor: any): any {
  return mix(baseColor.rgb, overlaySample.rgb, overlayAlpha);
}

export interface OverlayRegion {
  /** ECEF point at the centre of the overlay rectangle. */
  centerEcef: Vector3;
  eastEcef: Vector3;
  northEcef: Vector3;
  halfWidthM: number;
  halfHeightM: number;
}

export function setAirspaceOverlay(canvas: HTMLCanvasElement, region: OverlayRegion): void {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;

  if (currentTexture !== emptyTexture) currentTexture.dispose();
  currentTexture = tex;
  overlaySample.value = tex;

  centerU.value.copy(region.centerEcef);
  eastU.value.copy(region.eastEcef);
  northU.value.copy(region.northEcef);
  invHalfU.value.set(1 / region.halfWidthM, 1 / region.halfHeightM);
  strengthU.value = 1;
}

export function clearAirspaceOverlay(): void {
  if (currentTexture !== emptyTexture) currentTexture.dispose();
  currentTexture = emptyTexture;
  overlaySample.value = emptyTexture;
  strengthU.value = 0;
}
