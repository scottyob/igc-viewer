import { RedFormat, Scene } from 'three';
import type { PerspectiveCamera } from 'three';
import { bool, mrt, output, pass, toneMapping, uniform } from 'three/tsl';
import { RenderPipeline, WebGPURenderer } from 'three/webgpu';
import {
  aerialPerspective,
  AtmosphereContext,
  shadowLength,
  viewZUnit,
} from '@takram/three-atmosphere/webgpu';
import {
  CascadedShadowMapsNode,
  dithering,
  highpVelocity,
  lensFlare,
  temporalAntialias,
} from '@takram/three-geospatial/webgpu';
import { AgXPunchyToneMapping } from './agxToneMapping';

const DEMO_TONE_MAPPING_EXPOSURE = 35;

export function createPipeline(
  scene: Scene,
  camera: PerspectiveCamera,
  renderer: WebGPURenderer,
  csmShadowNode: CascadedShadowMapsNode,
  atmosphereContext: AtmosphereContext,
) {
  // Full post-processing chain (all steps are TSL node graph, not separate render passes):
  //   MRT scene render → shadowLength → aerialPerspective → lensFlare → AgX → TAA → dithering

  // samples:0 disables MSAA — TAA handles anti-aliasing temporally, and MSAA would
  // interfere with the velocity buffer used for reprojection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const passNode = pass(scene, camera, { samples: 0 }).setMRT(
    // MRT outputs: colour, per-pixel velocity (for TAA reprojection), view-space Z (for aerial haze depth)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mrt({ output, velocity: highpVelocity as any, viewZUnit } as any)
  );
  const colorNode = passNode.getTextureNode('output');
  const depthNode = passNode.getTextureNode('depth');
  const velocityNode = passNode.getTextureNode('velocity');
  const viewZUnitNode = passNode.getTextureNode('viewZUnit');
  // viewZUnit stores one channel (depth), so use RedFormat to avoid wasting GPU memory.
  viewZUnitNode.value.format = RedFormat;

  // shadowLength computes how much atmosphere lies in shadow along each view ray.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shadowLengthNode = shadowLength(csmShadowNode as any, viewZUnitNode);

  // Scale scene colour by 2/3 before aerial perspective so the atmosphere overlay
  // doesn't blow out the tile albedo — the LUTs assume a darker input range.
  // The npm package's helper forwards constructor args directly:
  // (color, depth, normal, shadowLength). The reference checkout wraps this
  // as (color, depth, shadowLength), so keep the normal slot explicitly empty.
  // colorScaleUniform lets callers switch to 1.0 when atmospheric effects are off
  // so the original tile brightness is preserved (the 2/3 factor was only needed for atmosphere).
  const colorScaleUniform = uniform(2 / 3);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aerialNode = aerialPerspective(colorNode.mul(colorScaleUniform) as any, depthNode as any, null, shadowLengthNode as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lensFlareNode = lensFlare(aerialNode as any);
  // Match the 3DTilesRenderer-Shadows story's toneMappingExposure override.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toneMappingNode = toneMapping(AgXPunchyToneMapping, DEMO_TONE_MAPPING_EXPOSURE, lensFlareNode as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taaNode = temporalAntialias(toneMappingNode as any, depthNode as any, velocityNode as any, camera);
  // Default alpha (0.05) keeps 95% history per frame — very smooth but blurry.
  // 0.1 halves the accumulation time while still providing effective anti-aliasing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (taaNode as any).temporalAlpha.value = 0.1;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderPipeline = new RenderPipeline(renderer as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalOutputNode = (taaNode as any).add(dithering);
  renderPipeline.outputNode = normalOutputNode;

  // Matches the demo's useTransientControl pattern for the shadowLength enable toggle.
  function enableShadowLength(v: boolean): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    aerialNode.shadowLengthNode = v ? (shadowLengthNode as any) : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const skyNode = (aerialNode as any).skyNode;
    if (skyNode != null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skyNode.shadowLengthNode = v ? (shadowLengthNode as any) : null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (renderPipeline as any).needsUpdate = true;
  }

  function setDisplayShadowLength(v: boolean): void {
    if (v) {
      // Match 3DTilesRenderer-Shadows exactly: display the light-shaft shadow
      // length channel as grayscale, scaled from atmosphere units to 10 km.
      // bool(true).select keeps normalOutputNode in the graph so switching back
      // doesn't require a recompile — matching the reference implementation approach.
      renderPipeline.outputNode = bool(true).select(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (shadowLengthNode as any).xxx
          .mul(1 / atmosphereContext.parameters.worldToUnit)
          .mul(0.0001), // 1 unit = 10 km
        normalOutputNode,
      );
    } else {
      renderPipeline.outputNode = normalOutputNode;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (renderPipeline as any).needsUpdate = true;
  }

  function setColorScale(v: number): void {
    colorScaleUniform.value = v;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (renderPipeline as any).needsUpdate = true;
  }

  function render(): void {
    renderPipeline.render();
  }

  function dispose(): void {
    renderPipeline.dispose();
    taaNode.dispose();
    lensFlareNode.dispose();
    aerialNode.dispose();
    shadowLengthNode.dispose();
    passNode.dispose();
  }

  return { renderPipeline, aerialNode, shadowLengthNode, toneMappingNode, render, dispose, enableShadowLength, setDisplayShadowLength, setColorScale };
}

