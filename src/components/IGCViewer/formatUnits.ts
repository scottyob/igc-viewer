import type { UnitMode } from './types';

const METERS_TO_FEET = 3.28084;
const METERS_TO_MILES = 1 / 1609.344;

export function usesImperialAltitude(units: UnitMode): boolean {
  return units !== 'metric';
}

export function usesImperialDistance(units: UnitMode): boolean {
  return units === 'imperial';
}

export function formatAltitudeM(meters: number, units: UnitMode): string {
  if (usesImperialAltitude(units)) {
    return `${Math.round(meters * METERS_TO_FEET).toLocaleString()} ft`;
  }
  return `${Math.round(meters).toLocaleString()} m`;
}

export function formatDistanceM(meters: number, units: UnitMode): string {
  if (usesImperialDistance(units)) {
    return `${(meters * METERS_TO_MILES).toFixed(1)} mi`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatVerticalSpeedMps(mps: number, units: UnitMode): string {
  if (usesImperialAltitude(units)) {
    return `${Math.round(mps * METERS_TO_FEET * 60).toLocaleString()} ft/min`;
  }
  return `${mps.toFixed(1)} m/s`;
}
