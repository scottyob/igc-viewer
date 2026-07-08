import { Mesh, Vector2, Vector3 } from 'three';
import type { CanvasTexture, Material, Object3D, Texture } from 'three';
import { MeshBasicNodeMaterial, MeshLambertNodeMaterial } from 'three/webgpu';
import { materialColor } from 'three/tsl';
import { createOverlayColorNode, overlayVersion, projectEcefToFrame, rasterizeOverlayRect } from './airspaceOverlay';
import type { OverlayHandle } from './airspaceOverlay';

type MeshMats = Material | Material[];

interface MeshEntry {
  basic: MeshMats;
  lambert: MeshMats;
  overlayHandles: OverlayHandle[];
  overlayTexture: CanvasTexture | null;
  overlayVersion: number;
}

// Stores both material variants per mesh so we can swap without re-creating.
const meshMaterials = new WeakMap<Mesh, MeshEntry>();

const corner = new Vector3();
const corner2D = new Vector2();

function copyMap(source: Material): Texture | null {
  return ('map' in source ? (source as { map: Texture | null }).map : null);
}

function makeBasic(source: Material, handles: OverlayHandle[]): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial();
  mat.map = copyMap(source);
  const overlay = createOverlayColorNode(materialColor);
  mat.colorNode = overlay.colorNode;
  handles.push(overlay.handle);
  return mat;
}

function makeLambert(source: Material, handles: OverlayHandle[]): MeshLambertNodeMaterial {
  const mat = new MeshLambertNodeMaterial();
  mat.map = copyMap(source);
  const overlay = createOverlayColorNode(materialColor);
  mat.colorNode = overlay.colorNode;
  handles.push(overlay.handle);
  return mat;
}

/**
 * Rasterize the airspace overlay for one tile mesh at that tile's footprint,
 * so overlay resolution tracks tile LOD. Cheap: runs only when a tile loads
 * or the airspace zone set changes.
 */
function updateMeshOverlay(mesh: Mesh, entry: MeshEntry): void {
  entry.overlayVersion = overlayVersion();

  const geometry = mesh.geometry;
  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;

  mesh.updateWorldMatrix(true, false);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    corner.set(
      (i & 1) === 0 ? bb.min.x : bb.max.x,
      (i & 2) === 0 ? bb.min.y : bb.max.y,
      (i & 4) === 0 ? bb.min.z : bb.max.z,
    ).applyMatrix4(mesh.matrixWorld);
    if (projectEcefToFrame(corner, corner2D) === null) break;
    minX = Math.min(minX, corner2D.x); maxX = Math.max(maxX, corner2D.x);
    minY = Math.min(minY, corner2D.y); maxY = Math.max(maxY, corner2D.y);
  }

  const raster = minX <= maxX ? rasterizeOverlayRect(minX, minY, maxX, maxY) : null;
  entry.overlayTexture?.dispose();
  entry.overlayTexture = raster?.texture ?? null;
  for (const h of entry.overlayHandles) {
    if (raster) h.setTile(raster.texture, raster.centerX, raster.centerY, raster.halfW, raster.halfH);
    else h.disable();
  }
}

// Replaces Google GLTF tile materials with paired Basic + Lambert variants.
// Basic is used when fancy lighting is off (matches original NoToneMapping look —
// no directional shading, no shadow seams). Lambert + shadows is used when fancy
// lighting is on.
export class TileMaterialPlugin {
  fancyMode = false;

  processTileModel(scene: { traverse: (cb: (obj: unknown) => void) => void }): void {
    scene.traverse(obj => {
      if (!(obj instanceof Mesh)) return;

      const prev = obj.material;
      const handles: OverlayHandle[] = [];
      let basic: MeshMats;
      let lambert: MeshMats;

      if (Array.isArray(prev)) {
        basic   = prev.map(m => makeBasic(m, handles));
        lambert = prev.map(m => makeLambert(m, handles));
        prev.forEach(m => m.dispose());
      } else {
        basic   = makeBasic(prev, handles);
        lambert = makeLambert(prev, handles);
        prev.dispose();
      }

      const entry: MeshEntry = { basic, lambert, overlayHandles: handles, overlayTexture: null, overlayVersion: -1 };
      meshMaterials.set(obj, entry);
      // Tile unload disposes the geometry — release the overlay raster with it.
      obj.geometry.addEventListener('dispose', () => {
        entry.overlayTexture?.dispose();
        entry.overlayTexture = null;
      });

      if (this.fancyMode) {
        obj.material = lambert;
        obj.castShadow = true;
        obj.receiveShadow = true;
      } else {
        obj.material = basic;
        obj.castShadow = false;
        obj.receiveShadow = false;
      }
    });
  }

  setFancyMode(enabled: boolean, group: Object3D): void {
    this.fancyMode = enabled;
    this.syncGroup(group);
  }

  // Called every frame to catch tiles that re-enter the group from the renderer's
  // cache without going through processTileModel again (3d-tiles-renderer reuses
  // parsed models when a tile scrolls out then back into view), and to refresh
  // airspace overlays when a tile first appears or the zone set changes.
  syncGroup(group: Object3D): void {
    const target = this.fancyMode;
    const version = overlayVersion();
    group.traverse(obj => {
      if (!(obj instanceof Mesh)) return;
      const entry = meshMaterials.get(obj);
      if (!entry) return;

      if (entry.overlayVersion !== version) updateMeshOverlay(obj, entry);

      const want = target ? entry.lambert : entry.basic;
      if (obj.material === want) return;
      obj.material = want;
      obj.castShadow = target;
      obj.receiveShadow = target;
    });
  }
}
