import { ColorManagement, Object3D, Scene } from 'three';
import type { PerspectiveCamera } from 'three';
import { GlobeControls } from '3d-tiles-renderer';
import { WebGPURenderer } from 'three/webgpu';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRenderer = any;

export function createControls(
  scene: Scene,
  camera: PerspectiveCamera,
  canvas: HTMLCanvasElement,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tiles: any,
) {
  const controls = new GlobeControls(scene, camera, canvas);
  controls.setEllipsoid(tiles.ellipsoid, tiles.group);
  controls.enableDamping = true;

  // 3d-tiles-renderer's default pivot indicator uses ShaderMaterial, which
  // WebGPURenderer cannot compile in node render passes. The controls keep
  // their actual pivot state separately, so replace only the visual marker.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalPivot = (controls as any).pivotMesh;
  originalPivot?.removeFromParent?.();
  originalPivot?.dispose?.();
  const pivotPlaceholder = new Object3D();
  pivotPlaceholder.visible = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pivotPlaceholder as any).raycast = () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pivotPlaceholder as any).dispose = () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (controls as any).pivotMesh = pivotPlaceholder;

  // adjustHeight snaps the camera to terrain height. We defer it until the user first
  // interacts so the camera doesn't jump when tiles load during the initial fly-in.
  controls.adjustHeight = false;
  controls.addEventListener('start', () => { controls.adjustHeight = true; });

  // The pivot mesh (orbit target indicator) is rendered in a separate overlay scene so
  // it bypasses post-processing — putting it through TAA causes visible ghosting because
  // the pivot moves every frame and the velocity buffer can't track it correctly.
  const overlayScene = new Scene();
  controls.addEventListener('start', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pivot = (controls as any).pivotMesh;
    if (pivot?.parent != null) {
      overlayScene.add(pivot);
    }
  });

  function update(): void {
    controls.update();
  }

  function renderOverlay(renderer: WebGPURenderer, camera: PerspectiveCamera): void {
    // Render the overlay on top of the post-processed frame without clearing it.
    // We also temporarily set outputColorSpace to the working space so the pivot mesh
    // colours aren't double-converted (the pipeline's output is already in display space).
    const savedOutputColorSpace = renderer.outputColorSpace;
    (renderer as AnyRenderer).autoClearColor = false;
    renderer.outputColorSpace = ColorManagement.workingColorSpace;
    renderer.render(overlayScene, camera);
    (renderer as AnyRenderer).autoClearColor = true;
    renderer.outputColorSpace = savedOutputColorSpace;
  }

  function dispose(): void {
    controls.dispose();
  }

  return { controls, overlayScene, update, renderOverlay, dispose };
}
