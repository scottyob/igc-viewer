import { Mesh, Vector2, Vector3 } from 'three';
import type { CanvasTexture, Material, Object3D, Texture } from 'three';
import { MeshBasicNodeMaterial, MeshLambertNodeMaterial } from 'three/webgpu';
import { materialColor } from 'three/tsl';
import { createOverlayColorNode, overlayVersion, projectEcefToFrame, rasterizeOverlayRect } from './airspaceOverlay';
import type { OverlayHandle } from './airspaceOverlay';
import {
  assembleMapRasterFromCache,
  buildMapRaster,
  createMapOverlayColorNode,
  ecefToGeodetic,
  geodeticToMercatorUnit,
  mapOverlayVersion,
} from './mapOverlay';
import type { MapOverlayHandle, MapRaster } from './mapOverlay';

type MeshMats = Material | Material[];

interface MeshEntry {
  basic: MeshMats;
  lambert: MeshMats;
  airspaceHandles: OverlayHandle[];
  airspaceTexture: CanvasTexture | null;
  airspaceVersion: number;
  mapHandles: MapOverlayHandle[];
  mapTexture: CanvasTexture | null;
  mapVersion: number;
  mapGen: number;
  geometryDisposed: boolean;
}

// Stores both material variants per mesh so we can swap without re-creating.
const meshMaterials = new WeakMap<Mesh, MeshEntry>();

const corner = new Vector3();
const corner2D = new Vector2();

function copyMap(source: Material): Texture | null {
  return ('map' in source ? (source as { map: Texture | null }).map : null);
}

function makeMaterial(
  source: Material,
  kind: 'basic' | 'lambert',
  airspaceHandles: OverlayHandle[],
  mapHandles: MapOverlayHandle[],
): Material {
  const mat = kind === 'basic' ? new MeshBasicNodeMaterial() : new MeshLambertNodeMaterial();
  mat.map = copyMap(source);
  // Map raster paints under the airspace zones.
  const mapOverlay = createMapOverlayColorNode(materialColor);
  const airspaceOverlay = createOverlayColorNode(mapOverlay.colorNode);
  mat.colorNode = airspaceOverlay.colorNode;
  mapHandles.push(mapOverlay.handle);
  airspaceHandles.push(airspaceOverlay.handle);
  return mat;
}

/** World-space bounding-box corners of a tile mesh, via callback. */
function forEachFootprintCorner(mesh: Mesh, cb: (worldCorner: Vector3) => void): void {
  const geometry = mesh.geometry;
  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  mesh.updateWorldMatrix(true, false);
  for (let i = 0; i < 8; i++) {
    corner.set(
      (i & 1) === 0 ? bb.min.x : bb.max.x,
      (i & 2) === 0 ? bb.min.y : bb.max.y,
      (i & 4) === 0 ? bb.min.z : bb.max.z,
    ).applyMatrix4(mesh.matrixWorld);
    cb(corner);
  }
}

/**
 * Rasterize the airspace overlay for one tile mesh at that tile's footprint,
 * so overlay resolution tracks tile LOD. Cheap: runs only when a tile loads
 * or the airspace zone set changes.
 */
function updateMeshAirspace(mesh: Mesh, entry: MeshEntry): void {
  entry.airspaceVersion = overlayVersion();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  forEachFootprintCorner(mesh, (p) => {
    if (projectEcefToFrame(p, corner2D) === null) return;
    minX = Math.min(minX, corner2D.x); maxX = Math.max(maxX, corner2D.x);
    minY = Math.min(minY, corner2D.y); maxY = Math.max(maxY, corner2D.y);
  });

  const raster = minX <= maxX ? rasterizeOverlayRect(minX, minY, maxX, maxY) : null;
  entry.airspaceTexture?.dispose();
  entry.airspaceTexture = raster?.texture ?? null;
  for (const h of entry.airspaceHandles) {
    if (raster) h.setTile(raster.texture, raster.centerX, raster.centerY, raster.halfW, raster.halfH);
    else h.disable();
  }
}

/** Fetch + assemble the map raster for one tile mesh's footprint. A synchronous
 *  seed from already-cached tiles (usually the parent tile's, coarser zoom)
 *  shows instantly so LOD churn never blinks the overlay off. */
function updateMeshMap(mesh: Mesh, entry: MeshEntry): void {
  const version = mapOverlayVersion();
  entry.mapVersion = version;
  const gen = ++entry.mapGen;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  forEachFootprintCorner(mesh, (p) => {
    const geo = ecefToGeodetic(p);
    const m = geodeticToMercatorUnit(geo.latRad, geo.lonRad);
    minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x);
    minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
  });

  const apply = (raster: MapRaster | null) => {
    entry.mapTexture?.dispose();
    entry.mapTexture = raster?.texture ?? null;
    for (const h of entry.mapHandles) {
      if (raster) h.setTile(raster.texture, raster.minX, raster.minY, raster.maxX, raster.maxY);
      else h.disable();
    }
  };

  const seed = assembleMapRasterFromCache(minX, minY, maxX, maxY);
  if (seed) apply(seed);

  void buildMapRaster(minX, minY, maxX, maxY).then((raster) => {
    const stale = entry.geometryDisposed || gen !== entry.mapGen || version !== mapOverlayVersion();
    if (stale || (raster && seed && raster.signature === seed.signature)) {
      // Stale, or the seed was already assembled from the same tiles.
      raster?.texture.dispose();
      return;
    }
    if (!raster && seed) return; // keep the coarse seed rather than blanking
    apply(raster);
  });
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
      const airspaceHandles: OverlayHandle[] = [];
      const mapHandles: MapOverlayHandle[] = [];
      let basic: MeshMats;
      let lambert: MeshMats;

      if (Array.isArray(prev)) {
        basic   = prev.map(m => makeMaterial(m, 'basic', airspaceHandles, mapHandles));
        lambert = prev.map(m => makeMaterial(m, 'lambert', airspaceHandles, mapHandles));
        prev.forEach(m => m.dispose());
      } else {
        basic   = makeMaterial(prev, 'basic', airspaceHandles, mapHandles);
        lambert = makeMaterial(prev, 'lambert', airspaceHandles, mapHandles);
        prev.dispose();
      }

      const entry: MeshEntry = {
        basic, lambert,
        airspaceHandles, airspaceTexture: null, airspaceVersion: -1,
        mapHandles, mapTexture: null, mapVersion: -1, mapGen: 0,
        geometryDisposed: false,
      };
      meshMaterials.set(obj, entry);
      // Tile unload disposes the geometry — release the overlay rasters with it.
      obj.geometry.addEventListener('dispose', () => {
        entry.geometryDisposed = true;
        entry.airspaceTexture?.dispose();
        entry.airspaceTexture = null;
        entry.mapTexture?.dispose();
        entry.mapTexture = null;
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
  // overlays when a tile first appears or the overlay sources change.
  syncGroup(group: Object3D): void {
    const target = this.fancyMode;
    const airspaceV = overlayVersion();
    const mapV = mapOverlayVersion();
    group.traverse(obj => {
      if (!(obj instanceof Mesh)) return;
      const entry = meshMaterials.get(obj);
      if (!entry) return;

      if (entry.airspaceVersion !== airspaceV) updateMeshAirspace(obj, entry);
      if (entry.mapVersion !== mapV) updateMeshMap(obj, entry);

      const want = target ? entry.lambert : entry.basic;
      if (obj.material === want) return;
      obj.material = want;
      obj.castShadow = target;
      obj.receiveShadow = target;
    });
  }
}
