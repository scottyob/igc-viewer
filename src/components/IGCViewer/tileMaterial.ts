import { Mesh } from 'three';
import type { Material, Object3D, Texture } from 'three';
import { MeshBasicNodeMaterial, MeshLambertNodeMaterial } from 'three/webgpu';

type MeshMats = Material | Material[];

// Stores both material variants per mesh so we can swap without re-creating.
const meshMaterials = new WeakMap<Mesh, { basic: MeshMats; lambert: MeshMats }>();

function copyMap(source: Material): Texture | null {
  return ('map' in source ? (source as { map: Texture | null }).map : null);
}

function makeBasic(source: Material): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial();
  mat.map = copyMap(source);
  return mat;
}

function makeLambert(source: Material): MeshLambertNodeMaterial {
  const mat = new MeshLambertNodeMaterial();
  mat.map = copyMap(source);
  return mat;
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
      let basic: MeshMats;
      let lambert: MeshMats;

      if (Array.isArray(prev)) {
        basic   = prev.map(m => makeBasic(m));
        lambert = prev.map(m => makeLambert(m));
        prev.forEach(m => m.dispose());
      } else {
        basic   = makeBasic(prev);
        lambert = makeLambert(prev);
        prev.dispose();
      }

      meshMaterials.set(obj, { basic, lambert });

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
  // parsed models when a tile scrolls out then back into view).
  syncGroup(group: Object3D): void {
    const target = this.fancyMode;
    group.traverse(obj => {
      if (!(obj instanceof Mesh)) return;
      const mats = meshMaterials.get(obj);
      if (!mats) return;
      const want = target ? mats.lambert : mats.basic;
      if (obj.material === want) return;
      obj.material = want;
      obj.castShadow = target;
      obj.receiveShadow = target;
    });
  }
}
