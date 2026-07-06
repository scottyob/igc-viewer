import type { PerspectiveCamera } from 'three';
import { Scene, Vector3 } from 'three';
import { context } from 'three/tsl';
import { WebGPURenderer } from 'three/webgpu';
import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI,
} from '@takram/three-atmosphere';
import {
  AtmosphereContext,
  AtmosphereLight,
} from '@takram/three-atmosphere/webgpu';
import { CascadedShadowMapsNode } from '@takram/three-geospatial/webgpu';

// 50 km covers a typical paragliding flight area without blowing the shadow map texel budget.
const CSM_FAR = 50000;

export function createAtmosphere(scene: Scene, renderer: WebGPURenderer, camera: PerspectiveCamera) {
  const atmosphereContext = new AtmosphereContext();
  atmosphereContext.camera = camera;
  // Match the 3DTilesRenderer-Shadows story defaults.
  atmosphereContext.showGround = false;
  // Inject the atmosphere context into the renderer's node context so that AtmosphereLight,
  // AerialPerspectiveNode, etc. can all read the same sun/moon direction and LUT state.
  renderer.contextNode = context({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(renderer.contextNode as any).value,
    getAtmosphere: () => atmosphereContext,
  });

  const sunLight = new AtmosphereLight();
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 1024;
  sunLight.shadow.mapSize.height = 1024;
  sunLight.shadow.camera.near = 0;
  sunLight.shadow.camera.far = CSM_FAR * 4;
  const csmShadowNode = new CascadedShadowMapsNode(sunLight, {
    cascades: 3,
    maxFar: CSM_FAR,
    lightMargin: CSM_FAR * 2,
  });
  csmShadowNode.fade = true;
  // The shadowNode assignment tells the renderer to use CSM for this light's depth pass.
  // It lives on shadow (not the light) because the WebGPU node pipeline looks it up there.
  // The type cast is needed because Three's TS types don't expose shadowNode yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sunLight.shadow as unknown as any).shadowNode = csmShadowNode;
  scene.add(sunLight);

  function update(date: Date, observerECEF: Vector3): void {
    const matrixECIToECEF = getECIToECEFRotationMatrix(
      date,
      atmosphereContext.matrixECIToECEF.value,
    );
    getSunDirectionECI(date, atmosphereContext.sunDirectionECEF.value, observerECEF)
      .applyMatrix4(matrixECIToECEF);
    getMoonDirectionECI(date, atmosphereContext.moonDirectionECEF.value, observerECEF)
      .applyMatrix4(matrixECIToECEF);
  }

  function dispose(): void {
    atmosphereContext.dispose();
    sunLight.dispose();
  }

  return { atmosphereContext, sunLight, csmShadowNode, update, dispose };
}
