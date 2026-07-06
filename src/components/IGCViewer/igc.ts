import { Vector3 } from 'three';
import type { IGCPoint } from './types';

// Converts WGS84 geodetic coordinates to Earth-Centered Earth-Fixed (ECEF) Cartesian.
// Three.js world space IS ECEF here — the globe sits at the origin, Z points to the north pole.
// a and e2 are the WGS84 ellipsoid semi-major axis and first eccentricity squared.
// N is the radius of curvature in the prime vertical at latitude φ.
export function llaToECEF(lat: number, lon: number, alt: number): Vector3 {
  const a = 6378137.0;
  const e2 = 0.00669437999014;
  const φ = lat * Math.PI / 180;
  const λ = lon * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(φ) ** 2);
  return new Vector3(
    (N + alt) * Math.cos(φ) * Math.cos(λ),
    (N + alt) * Math.cos(φ) * Math.sin(λ),
    (N * (1 - e2) + alt) * Math.sin(φ),
  );
}

// Parses IGC B-records (fix records) into lat/lon/alt/time points.
// B-record layout: B HHMMSSDDMMmmmN DDDMMmmmE V PPPPP GGGGG ...
//   cols 1–6:  time HHMMSS (UTC)
//   cols 7–13: latitude  DDMMmmm (degrees + decimal minutes × 1000, no separator)
//   cols 15–22: longitude DDDMMmmm (same encoding)
//   col 14/23: N/S and E/W hemisphere
//   col 24: 'A' = valid GPS fix, 'V' = invalid — skip invalid fixes
//   cols 25–29: pressure altitude (ignored), cols 30–34: GPS altitude (metres)
// The DDMMmmm → decimal degrees conversion: floor(raw/100000) + (raw%100000)/60000
// divides by 60000 (not 60) because the last 3 digits are thousandths of a minute.
export function parseIGC(text: string): IGCPoint[] {
  const points: IGCPoint[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line[0] !== 'B' || line.length < 35 || line[24] !== 'A') continue;
    const time =
      parseInt(line.slice(1, 3), 10) * 3600 +
      parseInt(line.slice(3, 5), 10) * 60 +
      parseInt(line.slice(5, 7), 10);
    const latRaw = parseInt(line.slice(7, 14), 10);
    const lat = (Math.floor(latRaw / 100000) + (latRaw % 100000) / 60000) * (line[14] === 'S' ? -1 : 1);
    const lonRaw = parseInt(line.slice(15, 23), 10);
    const lon = (Math.floor(lonRaw / 100000) + (lonRaw % 100000) / 60000) * (line[23] === 'W' ? -1 : 1);
    const alt = parseInt(line.slice(30, 35), 10);
    if (isFinite(time) && isFinite(lat) && isFinite(lon) && isFinite(alt)) {
      points.push({ lat, lon, alt, time });
    }
  }
  return points;
}

// HFDTE appears in two formats across logger firmware versions:
//   HFDTE DDMMYY  (original)
//   HFDTEDATE: DDMMYY  (newer)
// Returns midnight UTC on the flight date; caller adjusts to local solar time.
export function parseFlightDate(text: string): Date | null {
  const m = text.match(/^HFDTE(?:DATE:)?(\d{2})(\d{2})(\d{2})/m);
  if (!m) return null;
  const [, dd, mm, yy] = m;
  return new Date(Date.UTC(2000 + parseInt(yy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10)));
}

// Reads HFTZNTIME ZONE (UTC offset in hours) from the IGC header.
// Returns the offset in seconds, or null if the record is absent or unparseable.
// The value already includes DST because loggers record the current civil offset.
export function parseTimezoneOffset(text: string): number | null {
  const m = text.match(/^HFTZNTIME[- _]?ZONE:?\s*([-+]?\d+(?:\.\d+)?)/mi);
  if (!m) return null;
  const hours = parseFloat(m[1]);
  if (!isFinite(hours)) return null;
  return Math.round(hours * 3600);
}

// Horizontal distance between two WGS84 lat/lon points, in metres (Haversine formula).
export function haversineDistanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Reads HFPLT (pilot-in-charge) from the IGC header.
// HFPLT:Name, HFPLTPILOT:Name, and HFPLTPILOTINCHARGE:Name are supported across logger firmware versions.
export function parsePilotName(text: string): string {
  const m = text.match(/^HFPLT(?:PILOTINCHARGE|PILOT)?:?(.+)/mi);
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
}

export function parseGliderType(text: string): string {
  const m = text.match(/^HFGTY(?:GLIDERTYPE)?:?(.+)/mi);
  return m ? m[1].trim() : '';
}

// Returns a Date set to 6:30 pm local solar time at the given longitude.
// We use solar time (not timezone) so the sun angle looks correct for the location.
// The subtraction is correct: a positive (east) offset means local time is ahead of UTC,
// so to land at 18:30 local we need an earlier UTC hour (UTC = local − offset).
export function atLocalEvening(date: Date, longitudeDeg: number): Date {
  const utcMs = date.getTime();
  const localNoonOffsetMs = (longitudeDeg / 15) * 3600 * 1000;
  return new Date(utcMs + (18.5 * 3600 * 1000) - localNoonOffsetMs);
}
