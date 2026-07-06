import type { PerspectiveCamera } from 'three';
import { Scene } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  UpdateOnChangePlugin,
} from '3d-tiles-renderer/three/plugins';
import { WebGPURenderer } from 'three/webgpu';
import { CascadedShadowMapsNode } from '@takram/three-geospatial/webgpu';
import { TileMaterialPlugin } from './tileMaterial';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTilesRenderer = any;

export function createTiles(
  scene: Scene,
  camera: PerspectiveCamera,
  renderer: WebGPURenderer,
  googleApiKey: string,
) {
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');

  const tiles: AnyTilesRenderer = new TilesRenderer('https://tile.googleapis.com/v1/3dtiles/root.json');
  const auth = { session: '' };

  // Google's 3D Tiles API requires a session token on every tile request after the first.
  // The token is embedded in the root.json response — we extract it once and cache it here.
  // Tile requests that arrive before the fetch resolves work fine without the token;
  // the session is just an optimisation that avoids repeated auth round-trips.
  fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${googleApiKey}`)
    .then(r => r.text())
    .then(text => {
      const m = text.match(/[?&]session=([^&"\\]+)/);
      if (m) auth.session = m[1];
    })
    .catch(() => {});

  tiles.registerPlugin({
    preprocessURL: (url: string) => {
      const base = url.includes('://') ? url : `https://tile.googleapis.com${url}`;
      const u = new URL(base);
      u.searchParams.set('key', googleApiKey);
      // root.json must NOT get a session param — it's the request that returns the session.
      const isRoot = u.pathname === '/v1/3dtiles/root.json';
      if (auth.session && !u.searchParams.has('session') && !isRoot) {
        u.searchParams.set('session', auth.session);
      }
      return u.toString();
    },
  });

  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new UpdateOnChangePlugin());
  const tileMaterialPlugin = new TileMaterialPlugin();
  tiles.registerPlugin(tileMaterialPlugin);

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);

  function setResolution(camera: PerspectiveCamera, renderer: WebGPURenderer): void {
    tiles.setResolutionFromRenderer(camera, renderer);
  }

  function update(camera: PerspectiveCamera, renderer: WebGPURenderer, csmShadowNode?: CascadedShadowMapsNode): void {
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);

    // When fancy lighting is on, also register the outermost CSM shadow camera so that tiles
    // visible only in the shadow frustum are loaded (prevents holes in shadow maps).
    if (csmShadowNode != null) {
      const csmLights: AnyTilesRenderer[] = (csmShadowNode as unknown as { lights: AnyTilesRenderer[] }).lights;
      if (csmLights.length > 0) {
        const last = csmLights[csmLights.length - 1];
        if (last?.shadow != null) {
          tiles.setCamera(last.shadow.camera);
          tiles.setResolution(last.shadow.camera, last.shadow.mapSize.x, last.shadow.mapSize.y);
        }
      }
    }

    tiles.update();
  }

  // cb(true) = downloads started; cb(false) = all downloads+parses finished
  function onTilesLoadChange(cb: (loading: boolean) => void): () => void {
    const onStart = () => cb(true);
    const onEnd   = () => cb(false);
    tiles.addEventListener('tiles-load-start', onStart);
    tiles.addEventListener('tiles-load-end',   onEnd);
    return () => {
      tiles.removeEventListener('tiles-load-start', onStart);
      tiles.removeEventListener('tiles-load-end',   onEnd);
    };
  }

  function setFancyMode(enabled: boolean): void {
    tileMaterialPlugin.setFancyMode(enabled, tiles.group);
  }

  // Called every frame — cheap early-out when all visible tiles already have the right material.
  function syncMaterials(): void {
    tileMaterialPlugin.syncGroup(tiles.group);
  }

  function dispose(): void {
    tiles.dispose();
    dracoLoader.dispose();
  }

  return { tiles, setResolution, update, setFancyMode, syncMaterials, dispose, onTilesLoadChange };
}
