import { PCFSoftShadowMap } from 'three';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { WebGPURenderer } from 'three/webgpu';
import { AtmosphereLight, AtmosphereLightNode } from '@takram/three-atmosphere/webgpu';
import { AgXPunchyToneMapping, agxPunchyToneMapping } from './agxToneMapping';

export async function createRenderer(canvas: HTMLCanvasElement): Promise<{ renderer: WebGPURenderer }> {
  if (!WebGPU.isAvailable()) {
    const message = 'WebGPU is not available; refusing to fall back to WebGL2 because this shadow pipeline requires WebGPU.';
    canvas.replaceWith(WebGPU.getErrorMessage());
    throw new Error(message);
  }

  const renderer = new WebGPURenderer({
    canvas,
    forceWebGL: false,
  } as unknown as ConstructorParameters<typeof WebGPURenderer>[0]);
  // Cap at 2× to avoid GPU overload on high-DPI displays (3× Retina renders 9× the pixels).
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  await renderer.init();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((renderer as any).backend?.isWebGPUBackend !== true) {
    throw new Error('Renderer initialized without the WebGPU backend.');
  }

  // ECEF coordinates are ~6 million metres from the origin, which exceeds float32 precision.
  // highPrecision promotes position calculations to float64 on the GPU.
  // Must be set after init() to take effect (the reference sets it in the post-init callback).
  renderer.highPrecision = true;

  // Shadow map settings must be applied after init() — WebGPU renderer initialises its
  // internal shadow system during init() and properties set before may be ignored.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (renderer as any).shadowMap.enabled = true;
  // PCFSoftShadowMap matches the reference <Canvas shadows> default (R3F sets this type).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (renderer as any).shadowMap.type = PCFSoftShadowMap;
  // transmitted shadows allow the post-processing pass to compute atmosphere shadow
  // length from CSM depth information.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (renderer as any).shadowMap.transmitted = true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (renderer.library as any).addToneMapping(agxPunchyToneMapping, AgXPunchyToneMapping);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (renderer.library as any).addLight(AtmosphereLightNode, AtmosphereLight);

  return { renderer };
}
