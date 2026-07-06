export type TurnpointType = 'takeoff' | 'start' | 'turn' | 'finish' | 'landing';

export interface TaskWaypoint {
  type: TurnpointType;
  code: string;
  lat: number;
  lon: number;
  innerRadiusM: number;
  outerRadiusM: number;
}

export interface IGCTask {
  waypoints: TaskWaypoint[];
  scoreable: TaskWaypoint[]; // start + turns + finish
}

// C record format after the initial 'C':
//   pos 1-7:  DDMMmmm  lat digits (7 chars)
//   pos 8:    N/S
//   pos 9-16: DDDMMmmm lon digits (8 chars)
//   pos 17:   E/W
//   pos 18-24: inner radius metres (7 chars) — 0 for turns/finish
//   pos 25-31: outer radius metres (7 chars) — 9999999 = open for start
//   pos 32-43: open/close time + bearing (12 chars, ignored)
//   pos 44+:  label e.g. "STARTAREA WDLAUN"
// TAKEOFF/LANDING records have lat/lon = 0 and no numeric block; label at pos 18.

function parseCLatLon(line: string): { lat: number; lon: number } {
  const latRaw = parseInt(line.slice(1, 8), 10);
  const lonRaw = parseInt(line.slice(9, 17), 10);
  const lat = (Math.floor(latRaw / 100000) + (latRaw % 100000) / 60000) * (line[8] === 'S' ? -1 : 1);
  const lon = (Math.floor(lonRaw / 100000) + (lonRaw % 100000) / 60000) * (line[17] === 'W' ? -1 : 1);
  return { lat, lon };
}

function parseLabelAndType(label: string): { type: TurnpointType; code: string } {
  const up = label.toUpperCase();
  let type: TurnpointType = 'turn';
  let rest = label;
  if (up.startsWith('STARTAREA')) { type = 'start'; rest = label.slice(9); }
  else if (up.startsWith('TURNAREA')) { type = 'turn'; rest = label.slice(8); }
  else if (up.startsWith('FINISHAREA')) { type = 'finish'; rest = label.slice(10); }
  else if (up.startsWith('TAKEOFF')) { type = 'takeoff'; rest = ''; }
  else if (up.startsWith('LANDING')) { type = 'landing'; rest = ''; }
  const code = rest.trim().split(/\s+/)[0] ?? '';
  return { type, code };
}

export function parseTask(text: string): IGCTask | null {
  const cLines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.length < 2) continue;
    if (line[0] !== 'C') continue;
    // Exclude comment lines (C records start with a digit after C for real task records)
    if (!/^C[\d]/.test(line)) continue;
    cLines.push(line);
  }
  if (cLines.length < 3) return null;

  // First C line is the task declaration header — skip it.
  const waypoints: TaskWaypoint[] = [];
  for (const line of cLines.slice(1)) {
    const { lat, lon } = parseCLatLon(line);
    const isZero = lat === 0 && lon === 0;
    const labelStart = isZero ? 18 : 44;
    const rawLabel = line.slice(labelStart).trim();
    if (!rawLabel) continue;

    const { type, code } = parseLabelAndType(rawLabel);

    let innerRadiusM = 0;
    let outerRadiusM = 0;
    if (!isZero && line.length >= 32) {
      innerRadiusM = parseInt(line.slice(18, 25), 10) || 0;
      outerRadiusM = parseInt(line.slice(25, 32), 10) || 0;
    }

    waypoints.push({ type, code, lat, lon, innerRadiusM, outerRadiusM });
  }

  const scoreable = waypoints.filter((w) => w.type !== 'takeoff' && w.type !== 'landing');
  if (scoreable.length < 2) return null;

  return { waypoints, scoreable };
}
