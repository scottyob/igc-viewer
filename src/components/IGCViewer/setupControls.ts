import { ColorManagement, Object3D, Scene } from 'three';
import type { PerspectiveCamera } from 'three';
import { GlobeControls } from '3d-tiles-renderer';
import { WebGPURenderer } from 'three/webgpu';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRenderer = any;

// Control-state constants mirrored from 3d-tiles-renderer's EnvironmentControls
// (the package does not export them).
const DRAG = 1;
const ROTATE = 2;
const ZOOM = 3;
const WAITING = 4;

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

  // ── Two-finger touch: simultaneous rotate + pinch zoom ─────────────────────
  // EnvironmentControls locks each two-finger gesture into either ZOOM or ROTATE,
  // picking whichever motion first crosses a ~2px threshold. On a touch screen
  // that race is effectively random and the losing motion is ignored for the rest
  // of the gesture. Instead, run every two-finger gesture in ROTATE (parallel drag
  // orbits/tilts) and feed the pinch component into zoomDelta on every move —
  // _updateZoom applies zoomDelta in any state, the same path wheel zoom takes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyControls = controls as any;
  const tracker = anyControls.pointerTracker;
  // The library registers its pointer handlers on this same root node in the
  // GlobeControls constructor, so listeners added below run after the library has
  // updated its tracker for the event.
  const rootNode = canvas.getRootNode() as Document | ShadowRoot;
  let lastPinchDistance: number | null = null;

  const isTwoFingerTouch = (): boolean =>
    tracker.isPointerTouch() && tracker.getPointerCount() === 2;

  // Safety net: if the library's own disambiguation still picks ZOOM, reroute it.
  const originalSetState = anyControls.setState.bind(controls);
  anyControls.setState = (state?: number, fireEvent?: boolean) => {
    originalSetState(state === ZOOM && isTwoFingerTouch() ? ROTATE : state, fireEvent);
  };

  const onRootPointerMove = () => {
    if (!controls.enabled || !isTwoFingerTouch()) {
      lastPinchDistance = null;
      return;
    }
    // Skip the disambiguation threshold: two fingers always rotate. WAITING is the
    // library's undecided two-finger state; DRAG remains from the first finger when
    // the two-finger raycast misses terrain or hits at too shallow an angle.
    if (anyControls.state === WAITING || anyControls.state === DRAG) {
      anyControls.setState(ROTATE);
    }
    const distance = tracker.getTouchPointerDistance();
    if (lastPinchDistance !== null) {
      anyControls.zoomDelta += distance - lastPinchDistance;
      anyControls.needsUpdate = true;
    }
    lastPinchDistance = distance;
  };

  // Any change to the set of active pointers invalidates the last pinch distance.
  // Capture phase so these still run when another handler stops propagation.
  const onRootPointerCountChange = () => {
    lastPinchDistance = null;
  };

  // iOS Safari cancels pointers on system gestures (edge swipes, rotation, …) but
  // the library only listens for pointerup/pointerleave — a cancelled pointer stays
  // in its tracker as a ghost finger, corrupting every gesture after it. Mirror the
  // library's pointerup handling for cancelled pointers it is tracking.
  const onRootPointerCancel = (event: Event) => {
    lastPinchDistance = null;
    const e = event as PointerEvent;
    if (!(e.pointerId in tracker.pointerPositions)) return;
    tracker.deletePointer(e);
    anyControls.resetState();
    anyControls.needsUpdate = true;
  };

  rootNode.addEventListener('pointermove', onRootPointerMove);
  rootNode.addEventListener('pointerdown', onRootPointerCountChange, true);
  rootNode.addEventListener('pointerup', onRootPointerCountChange, true);
  rootNode.addEventListener('pointercancel', onRootPointerCancel, true);

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
    rootNode.removeEventListener('pointermove', onRootPointerMove);
    rootNode.removeEventListener('pointerdown', onRootPointerCountChange, true);
    rootNode.removeEventListener('pointerup', onRootPointerCountChange, true);
    rootNode.removeEventListener('pointercancel', onRootPointerCancel, true);
    controls.dispose();
  }

  return { controls, overlayScene, update, renderOverlay, dispose };
}
