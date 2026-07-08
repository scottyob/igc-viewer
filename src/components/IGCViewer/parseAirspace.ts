export type AirspaceAltitudeRef = 'msl' | 'agl' | 'sfc' | 'fl' | 'unlimited';

export interface AirspaceAltitude {
  raw: string;
  /** MSL metres for 'msl'/'fl'; metres above ground for 'agl'; 0 for 'sfc'/'unlimited'. */
  meters: number;
  ref: AirspaceAltitudeRef;
}

export interface Airspace {
  /** OpenAir class code from the AC record (R, Q, P, W, A–G, CTR, GP, …). */
  cls: string;
  name: string;
  floor: AirspaceAltitude;
  ceiling: AirspaceAltitude;
  points: { lat: number; lon: number }[];
  /** Original record lines for this airspace (comments included). */
  rawBlock: string;
}

const NM_TO_M = 1852;
const FT_TO_M = 0.3048;

// "42:9:55 N", "42:26.51 N", "42.14161 N" — degrees[:minutes[:seconds]] + hemisphere.
const COORD_PART = String.raw`(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?(?::(\d+(?:\.\d+)?))?\s*([NSns])`;
const COORD_RE = new RegExp(
  String.raw`${COORD_PART}[\s,]+` + COORD_PART.replace('[NSns]', '[EWew]'),
);

function parseCoordinate(text: string): { lat: number; lon: number } | null {
  const m = COORD_RE.exec(text);
  if (!m) return null;
  const toDeg = (d: string, min?: string, sec?: string) =>
    parseFloat(d) + (min ? parseFloat(min) / 60 : 0) + (sec ? parseFloat(sec) / 3600 : 0);
  const lat = toDeg(m[1], m[2], m[3]) * (m[4].toUpperCase() === 'S' ? -1 : 1);
  const lon = toDeg(m[5], m[6], m[7]) * (m[8].toUpperCase() === 'W' ? -1 : 1);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function parseAirspaceAltitude(raw: string): AirspaceAltitude {
  const text = raw.trim();
  const upper = text.toUpperCase();
  if (upper.includes('UNL')) return { raw: text, meters: 0, ref: 'unlimited' };

  const fl = /^FL\s*(\d+(?:\.\d+)?)/.exec(upper);
  if (fl) return { raw: text, meters: parseFloat(fl[1]) * 100 * FT_TO_M, ref: 'fl' };

  const num = /(-?\d+(?:\.\d+)?)\s*(FT|F|M)?\b/.exec(upper);
  // No number (SFC, GND, or garbage like "sfcl") → surface.
  if (!num) return { raw: text, meters: 0, ref: 'sfc' };

  const value = parseFloat(num[1]);
  const meters = num[2] === 'M' ? value : value * FT_TO_M; // OpenAir default unit is feet
  const agl = /\b(AGL|GND|SFC|ASFC|AAGL)\b/.test(upper.slice(num.index + num[0].length));
  if (value === 0) return { raw: text, meters: 0, ref: 'sfc' };
  return { raw: text, meters, ref: agl ? 'agl' : 'msl' };
}

/** Great-circle destination point, good enough for the ≤50 km arcs OpenAir uses. */
function destination(lat: number, lon: number, bearingDeg: number, distM: number): { lat: number; lon: number } {
  const R = 6371000;
  const δ = distM / R;
  const θ = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180;
  const λ1 = lon * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: φ2 * 180 / Math.PI, lon: λ2 * 180 / Math.PI };
}

function bearingAndDistance(fromLat: number, fromLon: number, toLat: number, toLon: number): { bearing: number; distM: number } {
  const R = 6371000;
  const φ1 = fromLat * Math.PI / 180, φ2 = toLat * Math.PI / 180;
  const Δφ = (toLat - fromLat) * Math.PI / 180;
  const Δλ = (toLon - fromLon) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const distM = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const bearing = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  return { bearing, distM };
}

const ARC_STEP_DEG = 5;

export function parseOpenAir(text: string): Airspace[] {
  const results: Airspace[] = [];
  const lines = text.split(/\r?\n/);

  let current: Partial<Airspace> & { points: { lat: number; lon: number }[]; blockLines: string[] } | null = null;
  // V-record state (applies to the following DA/DB/DC records).
  let varCenter: { lat: number; lon: number } | null = null;
  let varClockwise = true;

  const flush = () => {
    if (current && current.cls && current.points.length >= 3) {
      results.push({
        cls: current.cls,
        name: current.name ?? '',
        floor: current.floor ?? { raw: '', meters: 0, ref: 'sfc' },
        ceiling: current.ceiling ?? { raw: '', meters: 0, ref: 'sfc' },
        points: current.points,
        rawBlock: current.blockLines.join('\n'),
      });
    }
    current = null;
    varCenter = null;
    varClockwise = true;
  };

  const addArc = (centre: { lat: number; lon: number }, radiusM: number, startDeg: number, endDeg: number) => {
    if (!current) return;
    let sweep = varClockwise ? (endDeg - startDeg + 360) % 360 : -((startDeg - endDeg + 360) % 360);
    if (sweep === 0) sweep = varClockwise ? 360 : -360;
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP_DEG));
    for (let i = 0; i <= steps; i++) {
      current.points.push(destination(centre.lat, centre.lon, startDeg + (sweep * i) / steps, radiusM));
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (current) current.blockLines.push(rawLine);
    if (line.startsWith('*')) continue;

    const keyMatch = /^([A-Za-z]{1,2})\s+(.*)$/.exec(line);
    if (!keyMatch) continue;
    const key = keyMatch[1].toUpperCase();
    const value = keyMatch[2].trim();

    switch (key) {
      case 'AC':
        current?.blockLines.pop(); // this AC line belongs to the new block, not the old one
        flush();
        current = { cls: value.toUpperCase(), points: [], blockLines: [rawLine] };
        break;
      case 'AN':
        if (current) current.name = value;
        break;
      case 'AL':
        if (current) current.floor = parseAirspaceAltitude(value);
        break;
      case 'AH':
        if (current) current.ceiling = parseAirspaceAltitude(value);
        break;
      case 'DP': {
        const pt = parseCoordinate(value);
        if (current && pt) current.points.push(pt);
        break;
      }
      case 'V': {
        const xm = /^X\s*=\s*(.*)$/i.exec(value);
        if (xm) varCenter = parseCoordinate(xm[1]);
        const dm = /^D\s*=\s*([+-])/i.exec(value);
        if (dm) varClockwise = dm[1] === '+';
        break;
      }
      case 'DC': {
        const radius = parseFloat(value);
        if (current && varCenter && isFinite(radius)) addArc(varCenter, radius * NM_TO_M, 0, 360);
        break;
      }
      case 'DA': {
        // DA radius(nm), startAngle, endAngle
        const parts = value.split(',').map((p) => parseFloat(p));
        if (current && varCenter && parts.length >= 3 && parts.every(isFinite)) {
          addArc(varCenter, parts[0] * NM_TO_M, parts[1], parts[2]);
        }
        break;
      }
      case 'DB': {
        // DB coord1, coord2 — arc from coord1 to coord2 around V X centre
        if (current && varCenter) {
          const [c1, c2] = value.split(',').map((p) => parseCoordinate(p));
          if (c1 && c2) {
            const from = bearingAndDistance(varCenter.lat, varCenter.lon, c1.lat, c1.lon);
            const to = bearingAndDistance(varCenter.lat, varCenter.lon, c2.lat, c2.lon);
            addArc(varCenter, (from.distM + to.distM) / 2, from.bearing, to.bearing);
          }
        }
        break;
      }
      // AT (label position), AY (type, v2), SP/SB (pen/brush) — ignored.
    }
  }
  flush();

  return results;
}

/** Heuristic check that a text file is OpenAir airspace (used to route .txt files). */
export function looksLikeOpenAir(text: string): boolean {
  return /^\s*AC\s+\S/m.test(text) && /^\s*(DP|DC|DA|DB)\s+\S/m.test(text);
}
