export interface TrackEntry {
  url: string;
  label: string;
}

export interface LandmarkEntry {
  url: string;
  label?: string;
}

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  googleApiKey: string;
  tracks?: TrackEntry[];
  landmarks?: LandmarkEntry[];
}

export interface IGCPoint {
  lat: number;
  lon: number;
  alt: number;
  time: number; // seconds from midnight UTC
}

export interface FlightTrack {
  id: string;
  color: string;
  points: IGCPoint[];
  label: string;
  pilot: string;
  gliderType: string;
  start: number;          // seconds from midnight UTC (first fix)
  end: number;            // seconds from midnight UTC (last fix)
  date: Date | null;
  tzOffsetSec: number | null; // from HFTZNTIMEZONE; null if not present in file
}

export type TailMode = 'person' | 'climbRate';
export type TrailLengthMode = 'all' | '10m' | '5m' | '30s';
export type UnitMode = 'mixed' | 'imperial' | 'metric';
export type AltitudeMarkerMode = 'asl' | 'agl';
export type HeightCalculationMode = 'simplified' | 'vector';
