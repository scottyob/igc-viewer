const ZOOM = 9;
const TILE_PX = 256;

const tileCache = new Map<string, Promise<ImageData | null>>();
const tileDataCache = new Map<string, ImageData | null>();

function toTileXY(lon: number, lat: number): [number, number] {
  const n = 2 ** ZOOM;
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return [x, y];
}

function toPixelOffset(lon: number, lat: number): [number, number] {
  const n = 2 ** ZOOM;
  const fx = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const fy = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return [Math.floor((fx % 1) * TILE_PX), Math.floor((fy % 1) * TILE_PX)];
}

function loadTile(tx: number, ty: number): Promise<ImageData | null> {
  const key = `${tx},${ty}`;
  if (tileDataCache.has(key)) return Promise.resolve(tileDataCache.get(key) ?? null);

  const cached = tileCache.get(key);
  if (cached) return cached;

  const promise = new Promise<ImageData | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = TILE_PX;
      canvas.height = TILE_PX;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
      tileDataCache.set(key, imageData);
      resolve(imageData);
    };
    img.onerror = () => {
      tileDataCache.set(key, null);
      resolve(null);
    };
    img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${tx}/${ty}.png`;
  });
  tileCache.set(key, promise);
  return promise;
}

function sampleElevation(imageData: ImageData, px: number, py: number): number {
  const i = (py * TILE_PX + px) * 4;
  const { data } = imageData;
  return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
}

export async function sampleTerrainElevationM(lat: number, lon: number): Promise<number | null> {
  const [tx, ty] = toTileXY(lon, lat);
  const imageData = await loadTile(tx, ty);
  if (!imageData) return null;
  const [px, py] = toPixelOffset(lon, lat);
  return sampleElevation(imageData, px, py);
}

export function sampleCachedTerrainElevationM(lat: number, lon: number): number | null {
  const [tx, ty] = toTileXY(lon, lat);
  const imageData = tileDataCache.get(`${tx},${ty}`);
  if (!imageData) return null;
  const [px, py] = toPixelOffset(lon, lat);
  return sampleElevation(imageData, px, py);
}

function offsetLatLon(lat: number, lon: number, eastMeters: number, northMeters: number): { lat: number; lon: number } {
  const metersPerDegLat = 111_000;
  const metersPerDegLon = metersPerDegLat * Math.max(0.2, Math.cos(lat * Math.PI / 180));
  return {
    lat: lat + northMeters / metersPerDegLat,
    lon: lon + eastMeters / metersPerDegLon,
  };
}

export async function sampleTerrainBoundsInRadiusM(
  lat: number,
  lon: number,
  radiusM: number,
): Promise<{ center: number; min: number; max: number } | null> {
  const center = await sampleTerrainElevationM(lat, lon);
  if (center === null) return null;

  const samples: Array<{ lat: number; lon: number }> = [{ lat, lon }];
  const ringCount = Math.max(2, Math.min(5, Math.ceil(radiusM / 900)));
  for (let ring = 1; ring <= ringCount; ring++) {
    const ringRadius = (radiusM * ring) / ringCount;
    const segments = Math.max(8, Math.min(28, Math.ceil((2 * Math.PI * ringRadius) / 700)));
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      samples.push(offsetLatLon(lat, lon, Math.cos(a) * ringRadius, Math.sin(a) * ringRadius));
    }
  }

  const elevations = (await Promise.all(samples.map((p) => sampleTerrainElevationM(p.lat, p.lon))))
    .filter((v): v is number => v !== null);
  if (elevations.length === 0) return null;

  return {
    center,
    min: Math.min(...elevations),
    max: Math.max(...elevations),
  };
}
