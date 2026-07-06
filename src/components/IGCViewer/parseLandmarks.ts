export interface Landmark {
  code: string;
  name: string;
  lat: number;
  lon: number;
  elevM: number;
}

function parseWpt(text: string): Landmark[] {
  const lines = text.split(/\r?\n/);
  const results: Landmark[] = [];
  for (const line of lines.slice(4)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(',');
    if (fields.length < 15) continue;
    const code = fields[1].trim();
    if (!code) continue;
    const lat = parseFloat(fields[2]);
    const lon = parseFloat(fields[3]);
    if (isNaN(lat) || isNaN(lon)) continue;
    const rawName = fields[10].trim();
    const name = rawName && rawName !== code ? rawName : code;
    const elevFt = parseFloat(fields[14]);
    const elevM = isNaN(elevFt) ? 0 : elevFt * 0.3048;
    results.push({ code, name, lat, lon, elevM });
  }
  return results;
}

function parseCupLatLon(lat: string, lon: string): { lat: number; lon: number } | null {
  // lat: DDMMmmmN/S  lon: DDDMMmmmE/W
  if (lat.length < 2 || lon.length < 3) return null;
  const latHemi = lat.slice(-1);
  const lonHemi = lon.slice(-1);
  const latDeg = parseInt(lat.slice(0, 2), 10);
  const latMin = parseFloat(lat.slice(2, -1));
  const lonDeg = parseInt(lon.slice(0, 3), 10);
  const lonMin = parseFloat(lon.slice(3, -1));
  if (isNaN(latDeg) || isNaN(latMin) || isNaN(lonDeg) || isNaN(lonMin)) return null;
  const latDec = (latDeg + latMin / 60) * (latHemi === 'S' ? -1 : 1);
  const lonDec = (lonDeg + lonMin / 60) * (lonHemi === 'W' ? -1 : 1);
  return { lat: latDec, lon: lonDec };
}

function parseCupLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++;
      let val = '';
      while (i < line.length && line[i] !== '"') val += line[i++];
      i++; // closing quote
      fields.push(val);
      if (i < line.length && line[i] === ',') i++;
    } else {
      let val = '';
      while (i < line.length && line[i] !== ',') val += line[i++];
      fields.push(val);
      if (i < line.length) i++; // comma
    }
  }
  return fields;
}

function parseCup(text: string): Landmark[] {
  const lines = text.split(/\r?\n/);
  const results: Landmark[] = [];
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = parseCupLine(trimmed);
    // header: name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc
    if (fields.length < 6) continue;
    const name = fields[0].trim();
    const code = fields[1].trim();
    if (!code) continue;
    const ll = parseCupLatLon(fields[3], fields[4]);
    if (!ll) continue;
    const elevStr = fields[5].trim().toLowerCase();
    let elevM = 0;
    if (elevStr) {
      const val = parseFloat(elevStr);
      if (!isNaN(val)) {
        elevM = elevStr.endsWith('ft') ? val * 0.3048 : val;
      }
    }
    const displayName = name && name !== code ? name : code;
    results.push({ code, name: displayName, lat: ll.lat, lon: ll.lon, elevM });
  }
  return results;
}

export function detectAndParse(filename: string, text: string): Landmark[] {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'wpt') return parseWpt(text);
  if (ext === 'cup') return parseCup(text);
  return [];
}
