import { initViewer } from './components/IGCViewer/viewer';
import { createTimeline } from './components/IGCViewer/setupTimeline';
import { detectAndParse } from './components/IGCViewer/parseLandmarks';
import { looksLikeOpenAir, parseOpenAir } from './components/IGCViewer/parseAirspace';
import { airspaceClassLabel, airspaceColor } from './components/IGCViewer/setupAirspace';
import type { MapTileSource } from './components/IGCViewer/mapOverlay';
import { formatAltitudeM } from './components/IGCViewer/formatUnits';
import { sampleTerrainElevationM } from './components/IGCViewer/terrainElevation';
import { llaToECEF } from './components/IGCViewer/igc';
import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  ColorManagement,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera as ThreePerspectiveCamera,
  Scene,
  Shape,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector3,
  Vector4,
} from 'three';
import type { BufferGeometry, Material, PerspectiveCamera } from 'three';
import type { AltitudeMarkerMode, HeightCalculationMode, LandmarkEntry, TrackEntry, TrailLengthMode, UnitMode } from './components/IGCViewer/types';

export type { AltitudeMarkerMode, HeightCalculationMode, LandmarkEntry, TrackEntry, FlightTrack, IGCPoint, TailMode, TrailLengthMode, UnitMode, ViewerOptions } from './components/IGCViewer/types';
export type { LandmarkFile, AirspaceFile } from './components/IGCViewer/viewer';
export type { Airspace, AirspaceAltitude } from './components/IGCViewer/parseAirspace';
export type { IGCTask, TaskWaypoint, TurnpointType } from './components/IGCViewer/parseTask';

const SHADOW_CSS = `
:host {
  display: block;
  width: 100%;
  height: 100%;
}

/* ── Root ─────────────────────────────────────────────────────────────── */
.igc-root {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
  background: #000;
}

.igc-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* ── Drop overlay ─────────────────────────────────────────────────────── */
.igc-drop-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  pointer-events: none;
}
.igc-drop-overlay[hidden] { display: none; }

.igc-drop-hint {
  border: 2px dashed rgba(255, 255, 255, 0.55);
  border-radius: 12px;
  padding: 32px 48px;
  color: #fff;
  text-align: center;
  font-size: 1.1rem;
  font-weight: 500;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  letter-spacing: 0.02em;
}

/* ── Corner buttons ─────────────────────────────────────────────────── */
.igc-file-btn {
  position: absolute;
  width: 44px;
  height: 44px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: 50%;
  transition: opacity 0.2s;
  opacity: 0.85;
  z-index: 10;
}
.igc-file-btn  { top: 16px; left: 16px; }
.igc-file-btn:hover { opacity: 1; }
.igc-file-btn svg {
  display: block;
  width: 100%;
  height: 100%;
}

/* ── Map tiles button + menu ──────────────────────────────────────────── */
.igc-tiles-btn {
  position: absolute;
  top: 68px;
  left: 16px;
  width: 44px;
  height: 44px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: 50%;
  transition: opacity 0.2s;
  opacity: 0.85;
  z-index: 10;
}
.igc-tiles-btn:hover { opacity: 1; }
.igc-tiles-btn svg { width: 100%; height: 100%; display: block; }

.igc-tiles-menu {
  position: absolute;
  top: 68px;
  left: 68px;
  z-index: 30;
  min-width: 230px;
  background: rgba(12, 12, 20, 0.95);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  padding: 8px 0;
  font-size: 12px;
  color: rgba(255,255,255,0.85);
}
.igc-tiles-menu-label {
  padding: 4px 14px 6px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255,255,255,0.35);
}
.igc-tiles-source {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  cursor: pointer;
  user-select: none;
}
.igc-tiles-source:hover { background: rgba(255,255,255,0.08); }
.igc-tiles-source input[type="radio"] {
  width: 13px;
  height: 13px;
  accent-color: #50c8ff;
  flex-shrink: 0;
  cursor: pointer;
}
.igc-tiles-custom { padding: 6px 14px 4px; }
.igc-tiles-custom input[type="text"] {
  width: 100%;
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 4px;
  color: rgba(255,255,255,0.85);
  font-size: 11px;
  padding: 5px 7px;
  outline: none;
}
.igc-tiles-custom input[type="text"]:focus { border-color: #50c8ff; }
.igc-tiles-opacity {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px 4px;
  border-top: 1px solid rgba(255,255,255,0.08);
  margin-top: 6px;
}
.igc-tiles-opacity input[type="range"] { flex: 1; accent-color: #50c8ff; }

.igc-map-attribution {
  position: absolute;
  right: calc(var(--igc-sidebar-w, 0px) + 8px);
  bottom: 144px;
  z-index: 15;
  font-size: 10px;
  color: rgba(255,255,255,0.75);
  background: rgba(0,0,0,0.45);
  border-radius: 3px;
  padding: 2px 6px;
  pointer-events: none;
}
@media (max-width: 900px) {
  .igc-map-attribution { bottom: 104px; }
}

/* ── Timeline (bottom bar) ────────────────────────────────────────────── */
.igc-timeline {
  position: absolute;
  left: 0;
  right: var(--igc-sidebar-w, 0px);
  bottom: 0;
  height: 140px;
  background: rgba(8, 8, 16, 0.92);
  backdrop-filter: blur(10px);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: none;
  flex-direction: column;
  z-index: 20;
  user-select: none;
}
.igc-timeline.igc-timeline--active { display: flex; }

/* Toolbar row */
.igc-tl-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 0;
  height: 38px;
  flex-shrink: 0;
  position: relative;
}

.igc-tl-pilot-name {
  flex: 1;
  color: rgba(255,255,255,0.6);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.igc-tl-local-time {
  flex-shrink: 0;
  min-width: 84px;
  color: rgba(255,255,255,0.82);
  font-size: 10px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Settings button + menu */
.igc-tl-settings-wrap {
  position: relative;
  flex-shrink: 0;
}

.igc-tl-settings-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: rgba(255,255,255,0.08);
  border-radius: 6px;
  color: rgba(255,255,255,0.55);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5px;
  transition: background 0.15s, color 0.15s;
}
.igc-tl-settings-btn:hover,
.igc-tl-settings-btn.active { background: rgba(255,255,255,0.18); color: #fff; }
.igc-tl-settings-btn svg { width: 100%; height: 100%; }

.igc-tl-settings-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  background: rgba(18, 18, 28, 0.97);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  padding: 6px 0;
  min-width: 172px;
  box-shadow: 0 -4px 20px rgba(0,0,0,0.5);
  z-index: 30;
}
.igc-tl-settings-menu[hidden] { display: none; }

.igc-tl-setting-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 14px;
  cursor: pointer;
  font-size: 13px;
  color: rgba(255,255,255,0.8);
  transition: background 0.12s;
  user-select: none;
}
.igc-tl-setting-row:hover { background: rgba(255,255,255,0.07); }
.igc-tl-setting-row input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: #50c8ff;
  flex-shrink: 0;
  cursor: pointer;
}

/* Scrubber column: chart above, time axis below */
.igc-tl-scrubber {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 12px 6px;
  flex: 1;
  min-height: 0;
}

.igc-tl-track {
  flex: 1;
  position: relative;
  min-height: 0;
  cursor: crosshair;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(255,255,255,0.04);
}

.igc-tl-time-axis {
  position: relative;
  height: 34px;
  flex-shrink: 0;
  overflow: hidden;
  border-top: 1px solid rgba(255,255,255,0.08);
  background:
    linear-gradient(to bottom, rgba(255,255,255,0.08), rgba(255,255,255,0.01) 35%),
    linear-gradient(to bottom, rgba(10,14,24,0.92), rgba(6,9,18,0.78));
}
.igc-tl-axis-label {
  position: absolute;
  transform: translateX(-50%);
  bottom: 3px;
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: rgba(255,255,255,0.94);
  font-family: ui-monospace, monospace;
  white-space: nowrap;
  line-height: 1;
  text-shadow: 0 1px 2px rgba(0,0,0,0.92);
  background: rgba(3, 6, 12, 0.42);
  z-index: 2;
}
.igc-tl-axis-label--flight {
  bottom: 17px;
  color: #f5fbff;
  background: rgba(11, 18, 32, 0.88);
  box-shadow: 0 0 0 1px rgba(80, 200, 255, 0.24);
}
.igc-tl-axis-label--start {
  transform: none;
}
.igc-tl-axis-label--end {
  transform: translateX(-100%);
}
.igc-tl-axis-tick {
  position: absolute;
  bottom: 18px;
  width: 1px;
  background: rgba(255,255,255,0.4);
  transform: translateX(-50%);
  z-index: 1;
}
.igc-tl-axis-tick--minor {
  height: 6px;
  opacity: 0.9;
}
.igc-tl-axis-tick--hour {
  height: 12px;
  background: rgba(255,255,255,0.82);
}

.igc-tl-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.igc-tl-cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #e74c3c;
  transform: translateX(-50%);
  pointer-events: none;
  box-shadow: 0 0 8px rgba(231, 76, 60, 0.7);
}

/* ── Desktop sidebar ──────────────────────────────────────────────────── */
.igc-sidebar {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 280px;
  background: rgba(8, 8, 16, 0.92);
  backdrop-filter: blur(10px);
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  display: none;
  flex-direction: column;
  z-index: 20;
  overflow: hidden;
  transition: width 0.2s ease;
}
.igc-sidebar.collapsed { width: 40px; }

@media (min-width: 901px) {
  .igc-sidebar.igc-sidebar--active { display: flex; }
}

.igc-root { --igc-sidebar-w: 0px; }

@media (min-width: 901px) {
  .igc-root:has(.igc-sidebar.igc-sidebar--active:not(.collapsed)) { --igc-sidebar-w: 280px; }
  .igc-root:has(.igc-sidebar.igc-sidebar--active.collapsed)       { --igc-sidebar-w: 40px; }
}

.igc-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 40px;
  padding: 0 8px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0;
}

.igc-sidebar-toggle {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border: none;
  background: rgba(255,255,255,0.08);
  border-radius: 6px;
  color: rgba(255,255,255,0.6);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  transition: background 0.15s;
}
.igc-sidebar-toggle:hover { background: rgba(255,255,255,0.18); color: #fff; }
.igc-sidebar-toggle svg { width: 100%; height: 100%; }

.igc-tracks-visibility-all {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 4px;
  color: rgba(255,255,255,0.45);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  transition: background 0.15s, color 0.15s;
}
.igc-tracks-visibility-all:hover { background: rgba(255,255,255,0.14); color: #fff; }
.igc-tracks-visibility-all svg { width: 100%; height: 100%; }
.igc-tracks-visibility-all[hidden] { display: none; }
.igc-sb-tracks-toggle .igc-sb-chevron { margin-left: auto; }

.igc-sidebar-content {
  flex: 1;
  overflow-y: auto;
}
.igc-sidebar.collapsed .igc-sidebar-content { display: none; }

/* ── Sidebar sections ─────────────────────────────────────────────────── */
.igc-sb-section {
  border-bottom: 1px solid rgba(255,255,255,0.06);
}

.igc-sb-section-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  background: none;
  border: none;
  cursor: pointer;
  color: rgba(255,255,255,0.55);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  transition: color 0.15s;
}
.igc-sb-section-btn:hover { color: rgba(255,255,255,0.85); }

.igc-sb-section-hdr {
  padding: 10px 14px 6px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: rgba(255,255,255,0.55);
}

.igc-sb-chevron {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  transition: transform 0.18s ease;
}
.igc-sb-section-btn.collapsed .igc-sb-chevron { transform: rotate(-90deg); }

.igc-sb-section-body {
  overflow: hidden;
}
.igc-sb-section-body.collapsed { display: none; }

/* Stats table */
.igc-stats {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 7px 10px;
  margin: 0;
  padding: 6px 14px 14px;
}
.igc-stats dt {
  font-size: 11px;
  color: rgba(255,255,255,0.4);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  align-self: center;
}
.igc-stats dd {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255,255,255,0.9);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.igc-dbg-stats dd {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  font-weight: 500;
  color: rgba(255,255,255,0.7);
}

/* Tracks list */
.igc-track-search {
  position: relative;
  margin: 8px 14px 2px;
}
.igc-track-search[hidden] { display: none; }
.igc-track-search svg {
  position: absolute;
  left: 9px;
  top: 50%;
  width: 13px;
  height: 13px;
  transform: translateY(-50%);
  color: rgba(255,255,255,0.38);
  pointer-events: none;
}
.igc-track-search-input {
  width: 100%;
  height: 26px;
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 999px;
  background: rgba(0,0,0,0.24);
  color: rgba(255,255,255,0.82);
  padding: 0 9px 0 28px;
  font: 12px system-ui, sans-serif;
  outline: none;
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.28);
}
.igc-track-search-input::placeholder { color: rgba(255,255,255,0.38); }
.igc-track-search-input:focus {
  border-color: rgba(80,200,255,0.36);
  background: rgba(0,0,0,0.34);
}
.igc-tracks-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 16px 10px 18px;
  max-height: 232px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.22) rgba(255,255,255,0.04);
}
.igc-tracks-list::-webkit-scrollbar { width: 7px; }
.igc-tracks-list::-webkit-scrollbar-track {
  background: rgba(255,255,255,0.035);
  border-radius: 999px;
}
.igc-tracks-list::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.18);
  border-radius: 999px;
  border: 2px solid rgba(9,9,14,0.95);
}
.igc-tracks-list::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255,0.3);
}

.igc-track-row-wrap {
  position: relative;
  min-height: 34px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 24px 24px;
  align-items: center;
  gap: 4px;
}
.igc-track-row-wrap.track-hidden .igc-track-row { opacity: 0.45; }
.igc-track-row {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  min-width: 0;
  min-height: 34px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 7px;
  border: 1px solid rgba(255,255,255,0);
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
  color: rgba(255,255,255,0.95);
  cursor: pointer;
  overflow: hidden;
  text-align: left;
  font: inherit;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}
.igc-track-row:hover {
  background: rgba(255,255,255,0.07);
}
.igc-track-row.active {
  background: rgba(255,255,255,0.12);
  border-color: rgba(255,255,255,0.22);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.32);
}
.igc-track-color {
  position: relative;
  width: 4px;
  min-height: 22px;
  align-self: stretch;
  flex: 0 0 4px;
  border-radius: 999px;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.35), 0 1px 4px rgba(0,0,0,0.36);
}
.igc-track-color::after {
  content: "";
  position: absolute;
  inset: -4px -5px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0);
  pointer-events: none;
}
.igc-track-row-wrap.tracking .igc-track-color::after {
  border-color: rgba(255,255,255,0.74);
  animation: igcTrackingPulse 1.15s ease-out infinite;
}

@keyframes igcTrackingPulse {
  0% {
    opacity: 0.95;
    transform: scaleY(0.85) scaleX(0.8);
    box-shadow: 0 0 0 0 rgba(255,255,255,0.4);
  }
  70% {
    opacity: 0.2;
    transform: scaleY(1.35) scaleX(1.9);
    box-shadow: 0 0 0 5px rgba(255,255,255,0);
  }
  100% {
    opacity: 0;
    transform: scaleY(1.45) scaleX(2.1);
    box-shadow: 0 0 0 6px rgba(255,255,255,0);
  }
}
.igc-track-rank {
  flex: 0 0 30px;
  width: 30px;
  color: rgba(255,255,255,0.26);
  font-size: 10px;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-align: right;
  white-space: nowrap;
}
.igc-track-row:hover .igc-track-rank,
.igc-track-row.active .igc-track-rank {
  color: rgba(255,255,255,0.42);
}
.igc-track-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.igc-track-name,
.igc-track-detail {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.igc-track-name {
  color: rgba(255,255,255,0.82);
  font-size: 12px;
  font-weight: 650;
  line-height: 1.15;
}
.igc-track-detail {
  color: rgba(255,255,255,0.42);
  font-size: 10px;
  font-weight: 500;
  line-height: 1.1;
}
.igc-track-row-wrap.active .igc-track-name {
  color: rgba(255,255,255,0.96);
}

.igc-track-remove {
  width: 24px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid rgba(255,255,255,0);
  border-radius: 6px;
  background: rgba(255,255,255,0.03);
  color: rgba(255,255,255,0.68);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s, border-color 0.12s;
}
.igc-track-remove svg {
  width: 12px;
  height: 12px;
  display: block;
}
.igc-track-row-wrap:hover .igc-track-remove,
.igc-track-remove:focus-visible {
  opacity: 1;
}
.igc-track-remove:hover {
  background: rgba(210, 40, 56, 0.96);
  border-color: rgba(255,255,255,0.18);
  color: #fff;
}

.igc-track-visibility {
  width: 24px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid rgba(255,255,255,0);
  border-radius: 6px;
  background: rgba(255,255,255,0.03);
  color: rgba(255,255,255,0.68);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s, border-color 0.12s;
}
.igc-track-visibility svg {
  width: 14px;
  height: 14px;
  display: block;
}
.igc-track-row-wrap:hover .igc-track-visibility,
.igc-track-visibility:focus-visible,
.igc-track-row-wrap.track-hidden .igc-track-visibility {
  opacity: 1;
}
.igc-track-row-wrap.track-hidden .igc-track-visibility {
  color: rgba(255,255,255,0.42);
}
.igc-track-visibility:hover {
  background: rgba(255,255,255,0.14);
  border-color: rgba(255,255,255,0.18);
  color: #fff;
}

/* ── Track score badge ───────────────────────────────────────────────── */
.igc-track-score {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  background: rgba(255,255,255,0.1);
  border-radius: 10px;
  padding: 1px 5px;
  color: rgba(255,255,255,0.6);
  white-space: nowrap;
  line-height: 1.5;
}
.igc-track-score.igc-score-full {
  background: rgba(0,230,118,0.22);
  color: #00e676;
}

/* ── Track context menu ──────────────────────────────────────────────── */
.igc-track-ctx-menu {
  position: fixed;
  z-index: 1000;
  background: rgba(14,14,22,0.97);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  padding: 4px 0;
  min-width: 160px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.55);
  font-size: 13px;
}
.igc-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  cursor: pointer;
  color: rgba(255,255,255,0.82);
  transition: background 0.1s;
  user-select: none;
}
.igc-ctx-item:hover { background: rgba(255,255,255,0.08); }
.igc-ctx-item.disabled { opacity: 0.4; cursor: default; pointer-events: none; }
.igc-ctx-item svg { width: 14px; height: 14px; flex-shrink: 0; }
.igc-ctx-check { width: 14px; height: 14px; flex-shrink: 0; color: #50c8ff; }

/* ── Landmarks sidebar file list ─────────────────────────────────────── */
.igc-lf-empty {
  padding: 8px 14px;
  font-size: 11px;
  color: rgba(255,255,255,0.35);
}
.igc-lf-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 14px 5px 10px;
  border-top: 1px solid rgba(255,255,255,0.04);
}
.igc-lf-name {
  flex: 1;
  font-size: 11px;
  color: rgba(255,255,255,0.8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.igc-lf-count {
  font-size: 10px;
  color: rgba(255,255,255,0.38);
  white-space: nowrap;
  flex-shrink: 0;
}
.igc-lf-btn {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: rgba(255,255,255,0.45);
  cursor: pointer;
  padding: 3px;
  border-radius: 3px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.igc-lf-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
.igc-lf-btn svg { width: 100%; height: 100%; }

/* ── Airspace tooltip ─────────────────────────────────────────────────── */
.igc-airspace-tip {
  position: absolute;
  z-index: 40;
  pointer-events: none;
  background: rgba(0,0,0,0.82);
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 6px;
  padding: 6px 10px;
  max-width: 260px;
  font-size: 11px;
  line-height: 1.45;
  color: rgba(255,255,255,0.85);
}
.igc-airspace-tip-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  font-size: 12px;
  color: #fff;
}
.igc-airspace-tip-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}
.igc-airspace-tip-meta { color: rgba(255,255,255,0.6); }

/* ── View settings controls ───────────────────────────────────────────── */
.igc-vs-fancy-details {
  border-top: 1px solid rgba(255,255,255,0.04);
  transition: opacity 0.15s;
}
.igc-vs-fancy-details.igc-details--off {
  opacity: 0.35;
  pointer-events: none;
}
.igc-vs-fancy-details > .igc-setting-group:first-child { border-top: none; }

.igc-setting-group {
  padding: 6px 14px 10px;
  border-top: 1px solid rgba(255,255,255,0.04);
}
.igc-setting-group:first-child { border-top: none; }

.igc-sg-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255,255,255,0.3);
  margin-bottom: 6px;
}

.igc-sr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  color: rgba(255,255,255,0.75);
  cursor: pointer;
  user-select: none;
}
.igc-sr input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: #50c8ff;
  flex-shrink: 0;
  cursor: pointer;
}
.igc-sr--col {
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  cursor: default;
}

.igc-slider-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.igc-slider-row input[type="range"] {
  flex: 1;
  accent-color: #50c8ff;
  cursor: pointer;
}
.igc-vs-exposure-val {
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  font-family: ui-monospace, monospace;
  min-width: 28px;
  text-align: right;
}

/* ── Timeline settings extras ─────────────────────────────────────────── */
.igc-tl-setting-row--stack {
  align-items: stretch;
  flex-direction: column;
  gap: 6px;
}

.igc-tl-range-mode {
  width: 100%;
  min-height: 30px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 6px;
  background: rgba(255,255,255,0.06);
  overflow: hidden;
}
.igc-tl-range-mode--2 {
  grid-template-columns: repeat(2, 1fr);
}
.igc-tl-range-mode--4 {
  grid-template-columns: repeat(4, 1fr);
}

.igc-tl-range-option {
  min-width: 0;
  height: 30px;
  padding: 0 7px;
  border: none;
  border-left: 1px solid rgba(255,255,255,0.11);
  background: transparent;
  color: rgba(255,255,255,0.66);
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}
.igc-tl-range-option:first-child {
  border-left: none;
}
.igc-tl-range-option:hover {
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.92);
}
.igc-tl-range-option.active {
  background: rgba(80, 200, 255, 0.22);
  color: #fff;
  box-shadow: inset 0 0 0 1px rgba(80, 200, 255, 0.28);
}

/* ── Mobile adjustments ───────────────────────────────────────────────── */
@media (max-width: 900px) {
  .igc-timeline { height: 100px; }
  .igc-tl-controls { height: 34px; padding: 4px 8px 0; gap: 4px; }
  .igc-tl-local-time { min-width: 70px; font-size: 10px; }
  .igc-tl-scrubber { padding: 3px 8px 5px; gap: 2px; }
  .igc-tl-time-axis { height: 28px; }
  .igc-tl-axis-label { bottom: 2px; font-size: 10px; padding: 1px 3px; }
  .igc-tl-axis-label--flight { bottom: 14px; }
  .igc-tl-axis-tick { bottom: 14px; }
}
`;

const SHADOW_HTML = `
<div class="igc-root">
  <canvas class="igc-canvas"></canvas>
  <div class="igc-airspace-tip" hidden></div>

  <div class="igc-drop-overlay" hidden>
    <div class="igc-drop-hint">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 19V5m0 0-4 4m4-4 4 4"/>
        <rect x="3" y="14" width="18" height="7" rx="2"/>
      </svg>
      <span>Drop IGC file to load track</span>
    </div>
  </div>

  <input type="file" class="igc-file-input" accept=".igc,.wpt,.cup,.txt,.openair,.air" multiple hidden>
  <button class="igc-tiles-btn" title="Map overlay tiles">
    <svg viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
      <circle cx="22" cy="22" r="20" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>
      <path d="M22 12 32 17.5 22 23 12 17.5z" fill="#fff" opacity="0.9"/>
      <path d="M12 22.5 22 28 32 22.5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" opacity="0.65"/>
      <path d="M12 27.5 22 33 32 27.5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" opacity="0.4"/>
    </svg>
  </button>
  <div class="igc-tiles-menu" hidden>
    <div class="igc-tiles-menu-label">Map overlay</div>
    <div class="igc-tiles-sources"></div>
    <div class="igc-tiles-custom">
      <input type="text" class="igc-tiles-custom-input" placeholder="Custom: https://…/{z}/{x}/{y}.png" spellcheck="false" autocomplete="off">
    </div>
    <div class="igc-tiles-opacity">
      <span>Opacity</span>
      <input type="range" class="igc-tiles-opacity-input" min="10" max="100" value="75">
    </div>
  </div>
  <div class="igc-map-attribution" hidden></div>
  <button class="igc-file-btn" title="Open IGC file">
    <svg viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
      <circle cx="22" cy="22" r="20" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>
      <path d="M22 14v10m0-10-4 4m4-4 4 4" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <path d="M13 28h18" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </button>

  <div class="igc-timeline">
    <div class="igc-tl-controls">
      <span class="igc-tl-pilot-name"></span>
      <span class="igc-tl-local-time"></span>
      <div class="igc-tl-settings-wrap">
        <button class="igc-tl-settings-btn" title="Settings">
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
          </svg>
        </button>
        <div class="igc-tl-settings-menu" hidden>
          <div class="igc-tl-setting-row igc-tl-setting-row--stack">
            <span>Range</span>
            <div class="igc-tl-range-mode" role="group" aria-label="Timeline range">
              <button type="button" class="igc-tl-range-option" data-range-mode="current">Track</button>
              <button type="button" class="igc-tl-range-option" data-range-mode="fullDay">Day</button>
              <button type="button" class="igc-tl-range-option active" data-range-mode="allTracks">All</button>
            </div>
          </div>
          <label class="igc-tl-setting-row">
            <input type="checkbox" class="igc-tracking-mode">
            <span>Tracking</span>
          </label>
        </div>
      </div>
    </div>
    <div class="igc-tl-scrubber">
      <div class="igc-tl-track">
        <canvas class="igc-tl-canvas"></canvas>
        <div class="igc-tl-cursor"></div>
      </div>
      <div class="igc-tl-time-axis"></div>
    </div>
  </div>

  <div class="igc-sidebar">
    <div class="igc-sidebar-header">
      <button class="igc-sidebar-toggle" title="Collapse panel"></button>
    </div>
    <div class="igc-sidebar-content">
      <section class="igc-sb-section">
        <button class="igc-sb-section-btn igc-sb-tracks-toggle">
          <span>Tracks</span>
          <span class="igc-tracks-visibility-all" role="button" tabindex="0" title="Hide all tracks" aria-label="Hide all tracks" hidden></span>
          <svg class="igc-sb-chevron" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
          </svg>
        </button>
        <div class="igc-sb-section-body">
          <div class="igc-track-search" hidden>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <circle cx="7" cy="7" r="4.2"></circle>
              <path d="M10.2 10.2 13.5 13.5" stroke-linecap="round"></path>
            </svg>
            <input class="igc-track-search-input" type="search" placeholder="Search pilots" autocomplete="off" spellcheck="false">
          </div>
          <div class="igc-tracks-list" role="list"></div>
        </div>
      </section>
      <section class="igc-sb-section">
        <button class="igc-sb-section-btn igc-sb-landmarks-toggle collapsed">
          <span>Landmarks</span>
          <svg class="igc-sb-chevron" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
          </svg>
        </button>
        <div class="igc-sb-section-body collapsed">
          <div class="igc-landmark-files"></div>
        </div>
      </section>
      <section class="igc-sb-section">
        <button class="igc-sb-section-btn igc-sb-airspace-toggle collapsed">
          <span>Airspace</span>
          <svg class="igc-sb-chevron" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
          </svg>
        </button>
        <div class="igc-sb-section-body collapsed">
          <div class="igc-airspace-files"></div>
        </div>
      </section>
      <section class="igc-sb-section">
        <button class="igc-sb-section-btn igc-sb-flight-toggle">
          <span>Flight Info</span>
          <svg class="igc-sb-chevron" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
          </svg>
        </button>
        <div class="igc-sb-section-body">
          <dl class="igc-stats">
            <dt>Pilot</dt>      <dd class="igc-stat-pilot">—</dd>
            <dt>Date</dt>       <dd class="igc-stat-date">—</dd>
            <dt>Duration</dt>   <dd class="igc-stat-duration">—</dd>
            <dt>Distance</dt>   <dd class="igc-stat-distance">—</dd>
            <dt>Max alt</dt>    <dd class="igc-stat-maxalt">—</dd>
            <dt>Max climb</dt>  <dd class="igc-stat-maxclimb">—</dd>
            <dt class="igc-stat-task-row" hidden>Task start</dt>  <dd class="igc-stat-task-row igc-stat-taskstart" hidden>—</dd>
            <dt class="igc-stat-task-row" hidden>Task length</dt> <dd class="igc-stat-task-row igc-stat-tasklength" hidden>—</dd>
          </dl>
        </div>
      </section>
      <section class="igc-sb-section">
        <button class="igc-sb-section-btn igc-sb-viewoptions-toggle collapsed">
          <span>View Options</span>
          <svg class="igc-sb-chevron" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
          </svg>
        </button>
        <div class="igc-sb-section-body collapsed">
          <div class="igc-setting-group">
            <div class="igc-sg-label">Units</div>
            <div class="igc-tl-range-mode" role="group" aria-label="Units">
              <button type="button" class="igc-tl-range-option active" data-unit-mode="mixed">Mixed</button>
              <button type="button" class="igc-tl-range-option" data-unit-mode="imperial">Imperial</button>
              <button type="button" class="igc-tl-range-option" data-unit-mode="metric">Metric</button>
            </div>
          </div>
          <div class="igc-setting-group">
            <div class="igc-sg-label">Altitude Marker</div>
            <div class="igc-tl-range-mode igc-tl-range-mode--2" role="group" aria-label="Altitude marker">
              <button type="button" class="igc-tl-range-option active" data-altitude-marker="asl">ASL</button>
              <button type="button" class="igc-tl-range-option" data-altitude-marker="agl">AGL</button>
            </div>
          </div>
          <div class="igc-setting-group">
            <div class="igc-sg-label">Height Calculation</div>
            <div class="igc-tl-range-mode igc-tl-range-mode--2" role="group" aria-label="Height calculation">
              <button type="button" class="igc-tl-range-option active" data-height-calculation="simplified">Simple</button>
              <button type="button" class="igc-tl-range-option" data-height-calculation="vector">Vector</button>
            </div>
          </div>
          <div class="igc-setting-group">
            <div class="igc-sg-label">Trail Length</div>
            <div class="igc-tl-range-mode igc-tl-range-mode--4" role="group" aria-label="Trail length">
              <button type="button" class="igc-tl-range-option" data-trail-length="all">All</button>
              <button type="button" class="igc-tl-range-option active" data-trail-length="10m">10 min</button>
              <button type="button" class="igc-tl-range-option" data-trail-length="5m">5 min</button>
              <button type="button" class="igc-tl-range-option" data-trail-length="30s">30 sec</button>
            </div>
          </div>
          <div class="igc-setting-group">
            <label class="igc-sr"><span>Full trail of selected</span><input type="checkbox" class="igc-vs-full-trail-selected"></label>
          </div>
        </div>
      </section>
      <section class="igc-sb-section">
        <button class="igc-sb-section-btn igc-sb-settings-toggle collapsed">
          <span>View Settings</span>
          <svg class="igc-sb-chevron" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
          </svg>
        </button>
        <div class="igc-sb-section-body collapsed">
          <div class="igc-setting-group">
            <label class="igc-sr"><span>Fancy lighting</span><input type="checkbox" class="igc-vs-fancy-lighting"></label>
          </div>
          <div class="igc-vs-fancy-details">
            <div class="igc-setting-group">
              <div class="igc-sg-label">Atmosphere</div>
              <label class="igc-sr"><span>Transmittance</span>   <input type="checkbox" class="igc-vs-transmittance"  checked></label>
              <label class="igc-sr"><span>Inscattering</span>    <input type="checkbox" class="igc-vs-inscattering"   checked></label>
              <label class="igc-sr"><span>Show ground</span>     <input type="checkbox" class="igc-vs-showground"></label>
              <label class="igc-sr"><span>Raymarch scatter</span><input type="checkbox" class="igc-vs-raymarch"      checked></label>
            </div>
            <div class="igc-setting-group">
              <div class="igc-sg-label">Shadow Length</div>
              <label class="igc-sr"><span>Enable</span><input type="checkbox" class="igc-vs-shadow-length" checked></label>
              <label class="igc-sr"><span>Display</span><input type="checkbox" class="igc-vs-shadow-display"></label>
            </div>
            <div class="igc-setting-group">
              <div class="igc-sg-label">Tone Mapping</div>
              <label class="igc-sr"><span>Auto exposure</span><input type="checkbox" class="igc-vs-auto-exposure"></label>
              <div class="igc-sr igc-sr--col">
                <span>Exposure</span>
                <div class="igc-slider-row">
                  <input type="range" class="igc-vs-exposure" min="0.1" max="100" step="0.1" value="3">
                  <span class="igc-vs-exposure-val">3.0</span>
                </div>
              </div>
            </div>
          </div>
          <div class="igc-setting-group">
            <div class="igc-sg-label">Camera</div>
            <dl class="igc-stats igc-dbg-stats">
              <dt>Altitude</dt><dd class="igc-dbg-alt">—</dd>
              <dt>Lat</dt>     <dd class="igc-dbg-lat">—</dd>
              <dt>Lon</dt>     <dd class="igc-dbg-lon">—</dd>
              <dt>FPS</dt>     <dd class="igc-dbg-fps">—</dd>
            </dl>
          </div>
        </div>
      </section>
    </div>
  </div>
</div>
`;

type CompassRenderer = {
  domElement: HTMLCanvasElement;
  autoClear: boolean;
  autoClearColor: boolean;
  outputColorSpace: string;
  clearDepth: () => void;
  getScissor: (target: Vector4) => Vector4;
  getScissorTest: () => boolean;
  getViewport: (target: Vector4) => Vector4;
  render: (scene: Scene, camera: PerspectiveCamera) => void;
  setScissor: {
    (x: Vector4): void;
    (x: number, y: number, width: number, height: number): void;
  };
  setScissorTest: (enabled: boolean) => void;
  setViewport: {
    (x: Vector4): void;
    (x: number, y: number, width: number, height: number): void;
  };
};

function renderSceneOverlay(renderer: CompassRenderer, scene: Scene, camera: PerspectiveCamera, clearDepth = false): void {
  const autoClearBefore = renderer.autoClear;
  const autoClearColorBefore = renderer.autoClearColor;
  const outputColorSpaceBefore = renderer.outputColorSpace;

  renderer.autoClear = false;
  renderer.autoClearColor = false;
  renderer.outputColorSpace = ColorManagement.workingColorSpace;
  if (clearDepth) renderer.clearDepth();

  try {
    renderer.render(scene, camera);
  } finally {
    renderer.outputColorSpace = outputColorSpaceBefore;
    renderer.autoClearColor = autoClearColorBefore;
    renderer.autoClear = autoClearBefore;
  }
}

function createThreeCompass(renderer: CompassRenderer, root: HTMLElement) {
  const scene = new Scene();
  const camera = new ThreePerspectiveCamera(32, 1, 0.1, 12);
  camera.position.set(0, -0.02, 4.2);
  camera.lookAt(0, 0, 0);

  const compassRoot = new Group();
  const rose = new Group();
  scene.add(compassRoot);
  compassRoot.add(rose);
  scene.add(new AmbientLight(0xfff4d6, 1.45));
  const keyLight = new DirectionalLight(0xffffff, 2.25);
  keyLight.position.set(1.2, 1.5, 3.5);
  scene.add(keyLight);
  const rimLight = new DirectionalLight(0xffd36a, 1.05);
  rimLight.position.set(-1.4, -1.0, 2.1);
  scene.add(rimLight);

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const textures: Array<{ dispose: () => void }> = [];

  const material = (color: number, opacity = 1, metalness = 0.18, roughness = 0.42) => {
    const mat = new MeshStandardMaterial({
      color,
      opacity,
      transparent: opacity < 1,
      metalness,
      roughness,
      side: DoubleSide,
    });
    materials.push(mat);
    return mat;
  };

  const mesh = (
    geometry: BufferGeometry,
    mat: Material,
    parent: { add: (object: Mesh) => void } = rose,
  ) => {
    geometries.push(geometry);
    const m = new Mesh(geometry, mat);
    parent.add(m);
    return m;
  };

  const shadow = mesh(new CircleGeometry(0.82, 72), material(0x000000, 0.24, 0, 1), scene);
  shadow.scale.set(1, 0.24, 1);
  shadow.position.set(0, -0.86, -0.46);

  const base = mesh(new CylinderGeometry(0.92, 0.92, 0.16, 96), material(0xf2dfaa, 1, 0.12, 0.35), compassRoot);
  base.rotation.x = Math.PI / 2;
  base.position.z = -0.05;

  const outerRim = mesh(new TorusGeometry(0.83, 0.065, 18, 112), material(0xd69a2e, 1, 0.42, 0.24), compassRoot);
  outerRim.position.z = 0.08;
  const innerRim = mesh(new TorusGeometry(0.58, 0.018, 12, 96), material(0x8f5f1f, 1, 0.36, 0.32), compassRoot);
  innerRim.position.z = 0.12;
  const centerWell = mesh(new CylinderGeometry(0.13, 0.13, 0.06, 48), material(0x2c1b10, 1, 0.25, 0.38), compassRoot);
  centerWell.rotation.x = Math.PI / 2;
  centerWell.position.z = 0.13;

  const gridMat = material(0x815820, 0.62, 0.18, 0.5);
  mesh(new BoxGeometry(1.18, 0.022, 0.035), gridMat, rose).position.z = 0.14;
  const crossB = mesh(new BoxGeometry(1.18, 0.022, 0.035), gridMat, rose);
  crossB.rotation.z = Math.PI / 2;
  crossB.position.z = 0.14;

  for (let i = 0; i < 32; i++) {
    const major = i % 4 === 0;
    const tick = mesh(
      new BoxGeometry(major ? 0.038 : 0.018, major ? 0.18 : 0.1, major ? 0.06 : 0.04),
      material(0x2d2116, major ? 0.95 : 0.7, 0.2, 0.38),
      rose,
    );
    const angle = (i / 32) * Math.PI * 2;
    tick.position.set(Math.sin(angle) * 0.76, Math.cos(angle) * 0.76, major ? 0.18 : 0.16);
    tick.rotation.z = -angle;
  }

  const arrowShape = new Shape();
  arrowShape.moveTo(0, 0.88);
  arrowShape.lineTo(-0.085, 0.28);
  arrowShape.lineTo(0, 0.39);
  arrowShape.lineTo(0.085, 0.28);
  arrowShape.lineTo(0, 0.88);
  const northArrow = mesh(
    new ExtrudeGeometry(arrowShape, { depth: 0.085, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2 }),
    material(0xff1f2d, 1, 0.16, 0.26),
    rose,
  );
  northArrow.position.z = 0.18;

  const tailShape = new Shape();
  tailShape.moveTo(0, -0.74);
  tailShape.lineTo(-0.065, -0.25);
  tailShape.lineTo(0, -0.34);
  tailShape.lineTo(0.065, -0.25);
  tailShape.lineTo(0, -0.74);
  const southTail = mesh(
    new ExtrudeGeometry(tailShape, { depth: 0.065, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 2 }),
    material(0xfff0ca, 1, 0.08, 0.3),
    rose,
  );
  southTail.position.z = 0.17;

  const pin = mesh(new CylinderGeometry(0.082, 0.082, 0.08, 40), material(0xffc859, 1, 0.48, 0.2), rose);
  pin.rotation.x = Math.PI / 2;
  pin.position.z = 0.28;

  function addLabel(text: string, x: number, y: number, color: string): void {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = '900 64px Georgia, Times New Roman, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(255,255,255,0.72)';
    ctx.strokeText(text, 64, 70);
    ctx.fillStyle = color;
    ctx.fillText(text, 64, 70);

    const texture = new CanvasTexture(c);
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    textures.push(texture);
    const mat = new SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
    materials.push(mat);
    const sprite = new Sprite(mat);
    sprite.position.set(x, y, 0.42);
    sprite.scale.set(0.62, 0.62, 1);
    rose.add(sprite);
  }

  addLabel('N', 0, 0.86, '#a51f1a');
  addLabel('E', 0.86, 0, '#27180e');
  addLabel('S', 0, -0.86, '#27180e');
  addLabel('W', -0.86, 0, '#27180e');

  const compassForward = new Vector3();
  const compassUp = new Vector3();
  const compassDown = new Vector3();
  const compassNorth = new Vector3();
  const compassRight = new Vector3();
  const compassScreenUp = new Vector3();
  const viewportBefore = new Vector4();
  const scissorBefore = new Vector4();
  const COMPASS_SIZE_PX = 78;
  const COMPASS_MARGIN_PX = 16;

  function sidebarWidthPx(): number {
    return Number.parseFloat(getComputedStyle(root).getPropertyValue('--igc-sidebar-w')) || 0;
  }

  function layout() {
    const canvas = renderer.domElement;
    const size = COMPASS_SIZE_PX;
    const x = Math.max(COMPASS_MARGIN_PX, canvas.clientWidth - sidebarWidthPx() - COMPASS_MARGIN_PX - size);
    const top = COMPASS_MARGIN_PX;
    const y = top;
    return { x, y, top, size };
  }

  function headingRad(viewCamera: PerspectiveCamera): number {
    compassUp.copy(viewCamera.position).normalize();
    compassNorth.set(0, 0, 1).addScaledVector(compassUp, -compassNorth.dot(compassUp));
    if (compassNorth.lengthSq() < 1e-10) {
      compassNorth.set(1, 0, 0).addScaledVector(compassUp, -compassNorth.dot(compassUp));
    }
    compassNorth.normalize();
    compassRight.set(1, 0, 0).applyQuaternion(viewCamera.quaternion).normalize();
    compassScreenUp.set(0, 1, 0).applyQuaternion(viewCamera.quaternion).normalize();
    return Math.atan2(compassNorth.dot(compassRight), compassNorth.dot(compassScreenUp));
  }

  return {
    render(viewCamera: PerspectiveCamera): void {
      rose.rotation.z = -headingRad(viewCamera);
      viewCamera.getWorldDirection(compassForward);
      compassUp.copy(viewCamera.position).normalize();
      compassDown.copy(compassUp).negate();
      const nadirAmount = Math.max(0, Math.min(1, compassForward.dot(compassDown)));
      compassRoot.rotation.x = (-74 * (1 - Math.pow(nadirAmount, 0.65)) * Math.PI) / 180;
      const { x, y, size } = layout();
      renderer.getViewport(viewportBefore);
      renderer.getScissor(scissorBefore);
      const scissorTestBefore = renderer.getScissorTest();
      try {
        renderer.setViewport(x, y, size, size);
        renderer.setScissor(x, y, size, size);
        renderer.setScissorTest(true);
        renderSceneOverlay(renderer, scene, camera, true);
      } finally {
        renderer.setViewport(viewportBefore);
        renderer.setScissor(scissorBefore);
        renderer.setScissorTest(scissorTestBefore);
      }
    },
    hitTest(clientX: number, clientY: number): boolean {
      const rect = renderer.domElement.getBoundingClientRect();
      const { x, top, size } = layout();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      return localX >= x && localX <= x + size && localY >= top && localY <= top + size;
    },
    dispose(): void {
      for (const texture of textures) texture.dispose();
      for (const mat of materials) mat.dispose();
      for (const geometry of geometries) geometry.dispose();
    },
  };
}

type PilotHudIconKind = 'paraglider' | 'plane';
type PilotHudItem = {
  id: string;
  lat: number;
  lon: number;
  alt: number;
  visible: boolean;
  name: string;
  altText: string;
  color: string;
  textColor: string;
  icon: PilotHudIconKind;
  tracking: boolean;
  renderOrder: number;
};

type PilotHudEntry = {
  sprite: Sprite;
  material: SpriteMaterial;
  texture: CanvasTexture | null;
  hitAlpha: Uint8ClampedArray | null;
  hitWidth: number;
  hitHeight: number;
  key: string;
  width: number;
  height: number;
};

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawParagliderIcon(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.12, y + h * 0.34);
  ctx.quadraticCurveTo(x + w * 0.5, y + h * 0.02, x + w * 0.88, y + h * 0.34);
  ctx.stroke();
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.18, y + h * 0.38);
  ctx.lineTo(x + w * 0.44, y + h * 0.72);
  ctx.moveTo(x + w * 0.82, y + h * 0.38);
  ctx.lineTo(x + w * 0.56, y + h * 0.72);
  ctx.moveTo(x + w * 0.5, y + h * 0.72);
  ctx.lineTo(x + w * 0.5, y + h * 0.9);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + w * 0.5, y + h * 0.94, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlaneIcon(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(w / 24, h / 24);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(8, -10);
  ctx.lineTo(-4, -3);
  ctx.lineTo(-11, -6);
  ctx.lineTo(-13, -3);
  ctx.lineTo(-5, 2);
  ctx.lineTo(-3, 11);
  ctx.lineTo(1, 13);
  ctx.lineTo(3, 4);
  ctx.lineTo(10, 8);
  ctx.lineTo(13, 5);
  ctx.lineTo(5, -1);
  ctx.lineTo(12, -8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function createPilotHudTexture(item: PilotHudItem, shimmerPhase: number): {
  texture: CanvasTexture;
  width: number;
  height: number;
  hitAlpha: Uint8ClampedArray;
  hitWidth: number;
  hitHeight: number;
} {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const tagW = 31;
  const nameChars = Math.min(15, Math.max(6, item.name.length));
  const tagH = Math.min(190, Math.max(108, nameChars * 10 + 42));
  const altFont = '800 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d')!;
  measureCtx.font = altFont;
  const altW = Math.ceil(measureCtx.measureText(item.altText).width + 12);
  const altH = 18;
  const arrowH = 6;
  const topPad = 7;
  const sidePad = 9;
  const pilotGap = 7;
  const overlap = 4;
  const width = Math.ceil(Math.max(tagW, altW) + sidePad * 2);
  const height = Math.ceil(topPad + tagH + altH - overlap + arrowH + pilotGap);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * dpr);
  canvas.height = Math.ceil(height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const tagX = (width - tagW) / 2;
  const tagY = topPad;
  const altX = (width - altW) / 2;
  const altY = tagY + tagH - overlap;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 3;
  roundedRectPath(ctx, tagX, tagY, tagW, tagH, 5);
  ctx.clip();
  ctx.fillStyle = '#070807';
  ctx.fillRect(tagX, tagY, tagW, 29);
  ctx.fillStyle = item.color;
  ctx.fillRect(tagX, tagY + 29, tagW, tagH - 29);
  ctx.restore();

  ctx.save();
  roundedRectPath(ctx, tagX, tagY, tagW, tagH, 5);
  ctx.clip();
  const inset = ctx.createLinearGradient(tagX, tagY, tagX, tagY + tagH);
  inset.addColorStop(0, 'rgba(255,255,255,0.04)');
  inset.addColorStop(0.8, 'rgba(0,0,0,0)');
  inset.addColorStop(1, 'rgba(38,139,0,0.13)');
  ctx.fillStyle = inset;
  ctx.fillRect(tagX, tagY, tagW, tagH);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();
  if (item.tracking) {
    const shimmerX = tagX - tagW * 1.2 + shimmerPhase * tagW * 2.8;
    const shimmerOpacity = shimmerPhase < 0.28
      ? (shimmerPhase / 0.28) * 0.68
      : shimmerPhase < 0.62
        ? 0.68 - ((shimmerPhase - 0.28) / 0.34) * 0.34
        : 0.34 * (1 - ((shimmerPhase - 0.62) / 0.38));
    ctx.globalAlpha = Math.max(0, shimmerOpacity);
    ctx.translate(shimmerX, tagY + tagH / 2);
    ctx.rotate(12 * Math.PI / 180);
    const shine = ctx.createLinearGradient(-12, 0, 12, 0);
    shine.addColorStop(0, 'rgba(255,255,255,0)');
    shine.addColorStop(0.48, 'rgba(255,255,255,0.78)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine;
    ctx.fillRect(-12, -tagH, 24, tagH * 2);
  }
  ctx.restore();

  if (item.icon === 'plane') drawPlaneIcon(ctx, tagX + 5, tagY + 5, 21, 19, item.color);
  else drawParagliderIcon(ctx, tagX + 5, tagY + 5, 21, 19, item.color);

  ctx.save();
  ctx.translate(width / 2, tagY + 29 + (tagH - 29) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = '900 14px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = item.textColor;
  ctx.fillText(item.name.toUpperCase(), 0, 0);
  ctx.restore();

  ctx.save();
  if (item.tracking) {
    ctx.shadowColor = 'rgba(255,255,255,0.32)';
    ctx.shadowBlur = 12;
  }
  roundedRectPath(ctx, altX, altY, altW, altH, 4);
  ctx.fillStyle = 'rgba(0,0,0,0.88)';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = item.tracking ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(width / 2 - 4, altY + altH);
  ctx.lineTo(width / 2 + 4, altY + altH);
  ctx.lineTo(width / 2, altY + altH + arrowH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.88)';
  ctx.fill();
  ctx.restore();

  ctx.font = altFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(item.altText, width / 2, altY + altH / 2 + 0.5);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const hitAlpha = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 3, j = 0; i < imageData.length; i += 4, j++) {
    hitAlpha[j] = imageData[i];
  }

  const texture = new CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return { texture, width, height, hitAlpha, hitWidth: canvas.width, hitHeight: canvas.height };
}

function createPilotHudOverlay(renderer: CompassRenderer, camera: PerspectiveCamera, canvas: HTMLCanvasElement) {
  const overlayScene = new Scene();
  const entries = new Map<string, PilotHudEntry>();
  const hitPosition = new Vector3();

  function applyScale(entry: PilotHudEntry): void {
    const viewportHeight = Math.max(1, canvas.clientHeight || 1);
    const f = camera.projectionMatrix.elements[5] || 1;
    const scaleY = (entry.height * 2) / (f * viewportHeight);
    const scaleX = scaleY * (entry.width / entry.height);
    entry.sprite.scale.set(scaleX, scaleY, 1);
  }

  function ensureEntry(id: string): PilotHudEntry {
    let entry = entries.get(id);
    if (entry) return entry;
    const material = new SpriteMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
    });
    const sprite = new Sprite(material);
    sprite.center.set(0.5, 0);
    sprite.frustumCulled = false;
    overlayScene.add(sprite);
    entry = { sprite, material, texture: null, hitAlpha: null, hitWidth: 1, hitHeight: 1, key: '', width: 1, height: 1 };
    entries.set(id, entry);
    return entry;
  }

  function disposeEntry(entry: PilotHudEntry): void {
    overlayScene.remove(entry.sprite);
    entry.texture?.dispose();
    entry.material.dispose();
  }

  return {
    update(items: PilotHudItem[]): void {
      const activeIds = new Set<string>();
      const now = performance.now();
      for (const item of items) {
        activeIds.add(item.id);
        const entry = ensureEntry(item.id);
        const shimmerFrame = item.tracking ? Math.floor(((now % 1550) / 1550) * 96) : 0;
        const key = [
          item.name,
          item.altText,
          item.color,
          item.textColor,
          item.icon,
          item.tracking ? shimmerFrame : 'still',
        ].join('|');
        if (entry.key !== key) {
          const rendered = createPilotHudTexture(item, shimmerFrame / 96);
          entry.texture?.dispose();
          entry.texture = rendered.texture;
          entry.hitAlpha = rendered.hitAlpha;
          entry.hitWidth = rendered.hitWidth;
          entry.hitHeight = rendered.hitHeight;
          entry.width = rendered.width;
          entry.height = rendered.height;
          entry.material.map = rendered.texture;
          entry.material.needsUpdate = true;
          entry.key = key;
        }

        entry.sprite.position.copy(llaToECEF(item.lat, item.lon, item.alt));
        entry.sprite.visible = item.visible;
        entry.sprite.renderOrder = 9000 + item.renderOrder;
        applyScale(entry);
      }

      for (const [id, entry] of entries) {
        if (activeIds.has(id)) continue;
        disposeEntry(entry);
        entries.delete(id);
      }
    },
    hitTest(clientX: number, clientY: number): string | null {
      const rect = canvas.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      let bestId: string | null = null;
      let bestOrder = -Infinity;

      for (const [id, entry] of entries) {
        if (!entry.sprite.visible) continue;
        hitPosition.copy(entry.sprite.position).project(camera);
        if (hitPosition.z >= 1) continue;
        const x = ((hitPosition.x + 1) / 2) * rect.width;
        const y = (1 - (hitPosition.y + 1) / 2) * rect.height;
        const left = x - entry.width / 2;
        const right = x + entry.width / 2;
        const top = y - entry.height;
        const bottom = y;
        if (localX < left || localX > right || localY < top || localY > bottom) continue;
        if (entry.hitAlpha === null) continue;
        const hitX = Math.floor(((localX - left) / entry.width) * entry.hitWidth);
        const hitY = Math.floor(((localY - top) / entry.height) * entry.hitHeight);
        if (hitX < 0 || hitX >= entry.hitWidth || hitY < 0 || hitY >= entry.hitHeight) continue;
        if (entry.hitAlpha[hitY * entry.hitWidth + hitX] < 32) continue;
        if (entry.sprite.renderOrder < bestOrder) continue;
        bestId = id;
        bestOrder = entry.sprite.renderOrder;
      }

      return bestId;
    },
    render(): void {
      renderSceneOverlay(renderer, overlayScene, camera);
    },
    dispose(): void {
      for (const entry of entries.values()) disposeEntry(entry);
      entries.clear();
    },
  };
}

function parseJsonAttribute<T>(el: HTMLElement, name: string, fallback: T): T {
  const raw = el.getAttribute(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[IGC] ignoring invalid ${name} attribute:`, err);
    return fallback;
  }
}

class IGCViewerElement extends HTMLElement {
  #shadow: ShadowRoot;
  #viewer: Awaited<ReturnType<typeof initViewer>> | null = null;
  #timeline: ReturnType<typeof createTimeline> | null = null;
  #rafId = 0;
  #disposeCompass: (() => void) | null = null;
  #disposePilotHuds: (() => void) | null = null;
  #disposePostRender: (() => void) | null = null;
  #cleanupDrag: (() => void) | null = null;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: 'open' });
  }

  /** The underlying viewer instance (null until async init completes). */
  get viewer(): Awaited<ReturnType<typeof initViewer>> | null {
    return this.#viewer;
  }

  connectedCallback() {
    if (this.#shadow.childNodes.length > 0) return;
    this.#shadow.innerHTML = `<style>${SHADOW_CSS}</style>${SHADOW_HTML}`;
    void this.#init().catch((err: unknown) => {
      console.error('[IGC] failed to initialize viewer:', err);
    });
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.#rafId);
    this.#disposePostRender?.();
    this.#disposeCompass?.();
    this.#disposePilotHuds?.();
    this.#cleanupDrag?.();
    this.#timeline?.dispose();
    this.#viewer?.dispose();
    this.#disposeCompass = null;
    this.#disposePilotHuds = null;
    this.#disposePostRender = null;
    this.#viewer = null;
    this.#timeline = null;
    this.#shadow.innerHTML = '';
  }

  async #init() {
    const apiKey = this.getAttribute('google-api-key') ?? '';
    const tracks = parseJsonAttribute<TrackEntry[]>(this, 'tracks', []);
    const landmarks = parseJsonAttribute<LandmarkEntry[]>(this, 'landmarks', []);
    const airspaces = parseJsonAttribute<LandmarkEntry[]>(this, 'airspaces', []);
    const autoTracking = this.hasAttribute('auto-tracking');

    const root = this.#shadow.querySelector<HTMLElement>('.igc-root')!;
    root.dataset.apiKey = apiKey; // read by createTimeline for Timezone API calls

    const canvas  = root.querySelector<HTMLCanvasElement>('.igc-canvas')!;
    const overlay = root.querySelector<HTMLElement>('.igc-drop-overlay')!;
    const fileInput = root.querySelector<HTMLInputElement>('.igc-file-input')!;
    const fileBtn   = root.querySelector<HTMLButtonElement>('.igc-file-btn')!;

    const viewer = await initViewer({ canvas, googleApiKey: apiKey, tracks, landmarks, airspaces });
    this.#viewer = viewer;
    const compass3d = createThreeCompass(viewer.renderer, root);
    this.#disposeCompass = compass3d.dispose;
    const pilotHudOverlay = createPilotHudOverlay(viewer.renderer, viewer.camera, canvas);
    this.#disposePilotHuds = pilotHudOverlay.dispose;
    this.#disposePostRender = viewer.addPostRenderCallback(() => {
      pilotHudOverlay.render();
      compass3d.render(viewer.camera);
    });

    const dbgAlt = root.querySelector<HTMLElement>('.igc-dbg-alt')!;
    const dbgLat = root.querySelector<HTMLElement>('.igc-dbg-lat')!;
    const dbgLon = root.querySelector<HTMLElement>('.igc-dbg-lon')!;
    const dbgFps = root.querySelector<HTMLElement>('.igc-dbg-fps')!;

    let unitMode: UnitMode = 'mixed';
    let altitudeMarkerMode: AltitudeMarkerMode = 'asl';
    let heightCalculationMode: HeightCalculationMode = 'simplified';
    const markerGroundCache = new Map<string, { elevation: number | null; requestedAt: number }>();
    const markerGroundPending = new Set<string>();
    let lastCanvasPointer: { x: number; y: number; buttons: number } | null = null;
    let pilotHudCursorActive = false;
    let fpsThen = performance.now();
    let fpsCount = 0;

    const markerGroundKey = (mode: HeightCalculationMode, lat: number, lon: number): string =>
      `${mode}:${lat.toFixed(5)},${lon.toFixed(5)}`;

    function requestSimpleMarkerGround(lat: number, lon: number): number | null {
      const key = markerGroundKey('simplified', lat, lon);
      const cached = markerGroundCache.get(key);
      if (cached) return cached.elevation;
      if (!markerGroundPending.has(key)) {
        markerGroundPending.add(key);
        void sampleTerrainElevationM(lat, lon)
          .then((elevation) => {
            markerGroundCache.set(key, { elevation, requestedAt: performance.now() });
          })
          .catch(() => {
            markerGroundCache.set(key, { elevation: null, requestedAt: performance.now() });
          })
          .finally(() => {
            markerGroundPending.delete(key);
          });
      }
      return null;
    }

    function markerGroundElevation(lat: number, lon: number, altHint: number): number | null {
      if (heightCalculationMode === 'vector') {
        const key = markerGroundKey('vector', lat, lon);
        const now = performance.now();
        const cached = markerGroundCache.get(key);
        if (cached && now - cached.requestedAt < 1000) return cached.elevation;
        const elevation = viewer.castGroundElevation(lat, lon, altHint);
        markerGroundCache.set(key, { elevation, requestedAt: now });
        return elevation;
      }
      return requestSimpleMarkerGround(lat, lon);
    }

    function formatPilotMarker(sp: { lat: number; lon: number; alt: number }): string {
      if (altitudeMarkerMode === 'asl') return `${formatAltitudeM(sp.alt, unitMode)} ASL`;
      const ground = markerGroundElevation(sp.lat, sp.lon, sp.alt);
      if (ground === null) return `— AGL`;
      return `${formatAltitudeM(Math.max(0, sp.alt - ground), unitMode)} AGL`;
    }

    function setPilotHudCursor(active: boolean): void {
      if (pilotHudCursorActive === active) return;
      pilotHudCursorActive = active;
      canvas.style.cursor = active ? 'pointer' : '';
    }

    function refreshPilotHudCursor(): void {
      if (!lastCanvasPointer || lastCanvasPointer.buttons !== 0) {
        setPilotHudCursor(false);
        return;
      }
      setPilotHudCursor(pilotHudOverlay.hitTest(lastCanvasPointer.x, lastCanvasPointer.y) !== null);
    }

    const updateCompass = () => {
      const pos = viewer.camera.position;
      const r   = pos.length();
      const altM = r - 6_371_000;
      const lat  = Math.atan2(pos.z, Math.sqrt(pos.x * pos.x + pos.y * pos.y)) * 180 / Math.PI;
      const lon  = Math.atan2(pos.y, pos.x) * 180 / Math.PI;
      const altStr = altM >= 1_000_000
        ? `${(altM / 1_000_000).toFixed(0)} Mm`
        : altM >= 1_000
          ? `${(altM / 1_000).toFixed(1)} km`
          : `${Math.round(altM)} m`;
      dbgAlt.textContent = altStr;
      dbgLat.textContent = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`;
      dbgLon.textContent = `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;

      fpsCount++;
      const now = performance.now();
      if (now - fpsThen >= 500) {
        dbgFps.textContent = String(Math.round(fpsCount / ((now - fpsThen) / 1000)));
        fpsCount = 0;
        fpsThen = now;
      }

      const pilotScreenPositions = viewer.getPilotScreenPositions().sort((a, b) => b.distance - a.distance);
      const trackedPilotId = viewer.isTracking() ? viewer.getTrack()?.id ?? null : null;
      pilotHudOverlay.update(pilotScreenPositions.map((sp, stackIndex) => {
        const pilotName = getMapPilotName(sp.track);
        return {
          id: sp.track.id,
          lat: sp.lat,
          lon: sp.lon,
          alt: sp.alt,
          visible: sp.visible,
          name: pilotName,
          altText: formatPilotMarker(sp),
          color: sp.track.color,
          textColor: textColorForBg(sp.track.color),
          icon: getMapPilotIconKind(sp.track),
          tracking: sp.track.id === trackedPilotId,
          renderOrder: Math.min(18, 5 + stackIndex),
        };
      }));
      refreshPilotHudCursor();
      // Update track list sort + badges each frame (lightweight DOM update with FLIP animation)
      renderTracksList(viewer.getTrack()?.id ?? null, viewer.playback.getCurrentSeconds());

      this.#rafId = requestAnimationFrame(updateCompass);
    };
    const activateCompass = () => {
      if (viewer.isTracking()) {
        viewer.setTracking(false);
        syncTrackingUi();
      }
      void viewer.zoomCameraToGroundClearance(3000).catch((err) => console.warn('[IGC] failed to zoom compass view:', err));
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (!compass3d.hitTest(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      activateCompass();
    }, { capture: true });
    canvas.addEventListener('contextmenu', (e) => {
      if (!compass3d.hitTest(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, { capture: true });

    const readFileText = (file: File): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve((ev.target?.result as string) || '');
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
      });

    const loadFiles = async (fileList: FileList | File[]) => {
      let loadedTrack = false;
      for (const file of Array.from(fileList)) {
        const ext = file.name.split('.').pop()?.toLowerCase();
        const text = await readFileText(file);
        if (!text) continue;
        if (ext === 'wpt' || ext === 'cup') {
          const lms = detectAndParse(file.name, text);
          if (lms.length > 0) viewer.addLandmarkFile(file.name, text, lms);
          continue;
        }
        if (looksLikeOpenAir(text)) {
          const zones = parseOpenAir(text);
          if (zones.length > 0) {
            viewer.addAirspaceFile(file.name, text, zones);
            continue;
          }
        }
        if (ext === 'txt' || ext === 'openair' || ext === 'air') continue; // unparseable airspace text, not an IGC track
        viewer.loadIGCText(text, file.name);
        loadedTrack = true;
      }
      if (autoTracking && loadedTrack) {
        viewer.setTracking(true);
        syncTrackingUi();
      }
    };

    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files) void loadFiles(fileInput.files).catch((err) => console.warn('[IGC] failed to read file:', err));
      fileInput.value = '';
    });

    let dragCount = 0;
    const onDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) { dragCount++; overlay.hidden = false; }
    };
    const onDragLeave = () => {
      dragCount = Math.max(0, dragCount - 1);
      if (dragCount === 0) overlay.hidden = true;
    };
    const onDragOver  = (e: DragEvent) => e.preventDefault();
    const onDrop      = (e: DragEvent) => {
      e.preventDefault();
      dragCount = 0;
      overlay.hidden = true;
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) void loadFiles(files).catch((err) => console.warn('[IGC] failed to read file:', err));
    };
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('dragover',  onDragOver);
    document.addEventListener('drop',      onDrop);
    this.#cleanupDrag = () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('dragover',  onDragOver);
      document.removeEventListener('drop',      onDrop);
    };

    const timeline = createTimeline(root, viewer, {
      onScrub: () => {
        renderTracksList(viewer.getTrack()?.id ?? null, viewer.playback.getCurrentSeconds(), true);
      },
    });
    this.#timeline = timeline;

    // ── Landmarks sidebar wiring ─────────────────────────────────────────
    const landmarkFilesEl = root.querySelector<HTMLElement>('.igc-landmark-files')!;

    function renderLandmarkFiles() {
      const files = viewer.getLandmarkFiles();
      landmarkFilesEl.innerHTML = '';
      if (files.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'igc-lf-empty';
        empty.textContent = 'No landmarks loaded';
        landmarkFilesEl.append(empty);
        return;
      }
      for (const f of files) {
        const row = document.createElement('div');
        row.className = 'igc-lf-row';

        const name = document.createElement('span');
        name.className = 'igc-lf-name';
        name.title = f.filename;
        name.textContent = f.filename;

        const count = document.createElement('span');
        count.className = 'igc-lf-count';
        count.textContent = `${f.landmarks.length} pts`;

        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'igc-lf-btn';
        dlBtn.title = `Download ${f.filename}`;
        dlBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 10.5 4.5 7H7V3h2v4h2.5L8 10.5z"/><path d="M3 13h10v-1H3v1z"/></svg>`;
        dlBtn.addEventListener('click', () => {
          const blob = new Blob([f.rawText], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = f.filename;
          a.click();
          URL.revokeObjectURL(url);
        });

        const rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 'igc-lf-btn';
        rmBtn.title = `Remove ${f.filename}`;
        rmBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
        rmBtn.addEventListener('click', () => viewer.removeLandmarkFile(f.id));

        row.append(name, count, dlBtn, rmBtn);
        landmarkFilesEl.append(row);
      }
    }
    viewer.setOnLandmarksChange(renderLandmarkFiles);
    renderLandmarkFiles();

    // ── Airspace sidebar wiring ──────────────────────────────────────────
    const airspaceFilesEl = root.querySelector<HTMLElement>('.igc-airspace-files')!;

    function renderAirspaceFiles() {
      const files = viewer.getAirspaceFiles();
      airspaceFilesEl.innerHTML = '';
      if (files.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'igc-lf-empty';
        empty.textContent = 'No airspace loaded';
        airspaceFilesEl.append(empty);
        return;
      }
      for (const f of files) {
        const row = document.createElement('div');
        row.className = 'igc-lf-row';

        const name = document.createElement('span');
        name.className = 'igc-lf-name';
        name.title = f.filename;
        name.textContent = f.filename;

        const count = document.createElement('span');
        count.className = 'igc-lf-count';
        count.textContent = `${f.airspaces.length} zones`;

        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'igc-lf-btn';
        dlBtn.title = `Download ${f.filename}`;
        dlBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 10.5 4.5 7H7V3h2v4h2.5L8 10.5z"/><path d="M3 13h10v-1H3v1z"/></svg>`;
        dlBtn.addEventListener('click', () => {
          const blob = new Blob([f.rawText], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = f.filename;
          a.click();
          URL.revokeObjectURL(url);
        });

        const rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 'igc-lf-btn';
        rmBtn.title = `Remove ${f.filename}`;
        rmBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
        rmBtn.addEventListener('click', () => viewer.removeAirspaceFile(f.id));

        row.append(name, count, dlBtn, rmBtn);
        airspaceFilesEl.append(row);
      }
    }
    viewer.setOnAirspacesChange(renderAirspaceFiles);
    renderAirspaceFiles();

    // ── Airspace hover/tap tooltip ───────────────────────────────────────
    const airspaceTip = root.querySelector<HTMLElement>('.igc-airspace-tip')!;
    let airspaceTipPinned = false;
    let airspaceHoverRaf = 0;
    let airspaceHoverPos: { x: number; y: number } | null = null;

    const pickAirspaceAtClient = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
      return viewer.pickAirspaceAtNDC(ndcX, ndcY);
    };

    const showAirspaceTip = (pick: NonNullable<ReturnType<typeof viewer.pickAirspaceAtNDC>>, clientX: number, clientY: number) => {
      const zone = pick.airspace;
      airspaceTip.innerHTML = '';

      const nameEl = document.createElement('div');
      nameEl.className = 'igc-airspace-tip-name';
      const swatch = document.createElement('span');
      swatch.className = 'igc-airspace-tip-swatch';
      swatch.style.background = `#${airspaceColor(zone.cls).toString(16).padStart(6, '0')}`;
      const nameText = document.createElement('span');
      nameText.textContent = zone.name || '(unnamed)';
      nameEl.append(swatch, nameText);

      const metaEl = document.createElement('div');
      metaEl.className = 'igc-airspace-tip-meta';
      const floorRaw = zone.floor.raw || 'SFC';
      const ceilRaw = zone.ceiling.raw || 'SFC';
      const isGroundZone = zone.floor.ref === 'sfc' && zone.ceiling.ref === 'sfc';
      metaEl.textContent = isGroundZone
        ? `${airspaceClassLabel(zone.cls)} · ground zone`
        : `${airspaceClassLabel(zone.cls)} · ${floorRaw} – ${ceilRaw}`;

      airspaceTip.append(nameEl, metaEl);
      airspaceTip.hidden = false;

      const rootRect = root.getBoundingClientRect();
      let x = clientX - rootRect.left + 14;
      let y = clientY - rootRect.top + 14;
      x = Math.min(x, rootRect.width - airspaceTip.offsetWidth - 8);
      y = Math.min(y, rootRect.height - airspaceTip.offsetHeight - 8);
      airspaceTip.style.left = `${Math.max(4, x)}px`;
      airspaceTip.style.top = `${Math.max(4, y)}px`;
    };

    const processAirspaceHover = () => {
      airspaceHoverRaf = 0;
      if (!airspaceHoverPos || airspaceTipPinned) return;
      const pick = pickAirspaceAtClient(airspaceHoverPos.x, airspaceHoverPos.y);
      if (pick) showAirspaceTip(pick, airspaceHoverPos.x, airspaceHoverPos.y);
      else airspaceTip.hidden = true;
    };

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
      airspaceHoverPos = { x: e.clientX, y: e.clientY };
      if (!airspaceHoverRaf) airspaceHoverRaf = requestAnimationFrame(processAirspaceHover);
    });
    canvas.addEventListener('pointerleave', () => {
      airspaceHoverPos = null;
      if (!airspaceTipPinned) airspaceTip.hidden = true;
    });

    // Tap/click pins the tooltip (touch devices have no hover). Uses the same
    // press-release slop pattern as the pilot HUD so drags don't trigger it.
    let airspaceTapCandidate: { pointerId: number; x: number; y: number } | null = null;
    const AIRSPACE_TAP_SLOP_PX = 6;
    canvas.addEventListener('pointerdown', (e) => {
      airspaceTapCandidate = e.button === 0 ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY } : null;
    });
    canvas.addEventListener('pointerup', (e) => {
      const candidate = airspaceTapCandidate;
      airspaceTapCandidate = null;
      if (!candidate || candidate.pointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - candidate.x, e.clientY - candidate.y) > AIRSPACE_TAP_SLOP_PX) return;
      if (pilotHudOverlay.hitTest(e.clientX, e.clientY) !== null) return; // pilot HUD taps take priority
      const pick = pickAirspaceAtClient(e.clientX, e.clientY);
      if (pick) {
        showAirspaceTip(pick, e.clientX, e.clientY);
        airspaceTipPinned = true;
      } else {
        airspaceTipPinned = false;
        airspaceTip.hidden = true;
      }
    });
    canvas.addEventListener('pointercancel', () => {
      airspaceTapCandidate = null;
    });

    // ── Map overlay tiles menu ───────────────────────────────────────────
    const tilesBtn = root.querySelector<HTMLButtonElement>('.igc-tiles-btn')!;
    const tilesMenu = root.querySelector<HTMLElement>('.igc-tiles-menu')!;
    const tilesSourcesEl = root.querySelector<HTMLElement>('.igc-tiles-sources')!;
    const tilesCustomInput = root.querySelector<HTMLInputElement>('.igc-tiles-custom-input')!;
    const tilesOpacityInput = root.querySelector<HTMLInputElement>('.igc-tiles-opacity-input')!;
    const mapAttributionEl = root.querySelector<HTMLElement>('.igc-map-attribution')!;

    function renderTileSources() {
      const current = viewer.mapTiles.getSource();
      tilesSourcesEl.innerHTML = '';
      const options: Array<MapTileSource | null> = [null, ...viewer.mapTiles.getSources()];
      if (current && current.id === 'custom') options.push(current);
      for (const source of options) {
        const row = document.createElement('label');
        row.className = 'igc-tiles-source';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'igc-tiles-source';
        radio.checked = (source?.id ?? null) === (current?.id ?? null);
        radio.addEventListener('change', () => applyMapSource(source));
        const label = document.createElement('span');
        label.textContent = source?.label ?? 'None';
        row.append(radio, label);
        tilesSourcesEl.append(row);
      }
    }

    function applyMapSource(source: MapTileSource | null) {
      viewer.mapTiles.setSource(source);
      const attribution = source?.attribution ?? '';
      mapAttributionEl.hidden = attribution === '';
      mapAttributionEl.textContent = attribution;
      renderTileSources();
    }

    tilesBtn.addEventListener('click', () => {
      tilesMenu.hidden = !tilesMenu.hidden;
      if (!tilesMenu.hidden) renderTileSources();
    });
    this.#shadow.addEventListener('pointerdown', (e) => {
      if (tilesMenu.hidden) return;
      const path = e.composedPath();
      if (!path.includes(tilesMenu) && !path.includes(tilesBtn)) tilesMenu.hidden = true;
    });

    tilesCustomInput.addEventListener('change', () => {
      const template = tilesCustomInput.value.trim();
      if (!template) return;
      if (!template.includes('{z}') || !template.includes('{x}') || !template.includes('{y}')) {
        tilesCustomInput.setCustomValidity('Template must contain {z}, {x} and {y}');
        tilesCustomInput.reportValidity();
        return;
      }
      tilesCustomInput.setCustomValidity('');
      applyMapSource({ id: 'custom', label: 'Custom', template, maxZoom: 18, attribution: '' });
    });

    tilesOpacityInput.addEventListener('input', () => {
      viewer.mapTiles.setOpacity(Number(tilesOpacityInput.value) / 100);
    });

    renderTileSources();

    const tracksListEl = root.querySelector<HTMLElement>('.igc-tracks-list')!;
    const trackSearchWrap = root.querySelector<HTMLElement>('.igc-track-search')!;
    const trackSearchInput = root.querySelector<HTMLInputElement>('.igc-track-search-input')!;
    let lastSortOrder: string[] = [];
    let lastTracksRenderKey = '';
    let trackSearchQuery = '';

    // ── Track visibility (eye) toggles ───────────────────────────────────
    const EYE_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1.6 8s2.3-4.3 6.4-4.3S14.4 8 14.4 8s-2.3 4.3-6.4 4.3S1.6 8 1.6 8z" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.1"/></svg>`;
    const EYE_OFF_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1.6 8s2.3-4.3 6.4-4.3S14.4 8 14.4 8s-2.3 4.3-6.4 4.3S1.6 8 1.6 8z" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.1"/><path d="M2 14 14 2" stroke-linecap="round"/></svg>`;
    const allTracksVisBtn = root.querySelector<HTMLElement>('.igc-tracks-visibility-all')!;
    const hiddenTrackIds = new Set<string>();
    let lastAllTracksVisState = '';

    function setTrackHidden(trackId: string, hidden: boolean) {
      if (hidden) hiddenTrackIds.add(trackId);
      else hiddenTrackIds.delete(trackId);
      viewer.setTrackVisible(trackId, !hidden);
    }

    function syncAllTracksVisibilityBtn() {
      const allTracks = viewer.getTracks();
      const allHidden = allTracks.length > 0 && allTracks.every((track) => hiddenTrackIds.has(track.id));
      const state = `${allTracks.length === 0}|${allHidden}`;
      if (state === lastAllTracksVisState) return;
      lastAllTracksVisState = state;
      allTracksVisBtn.hidden = allTracks.length === 0;
      allTracksVisBtn.innerHTML = allHidden ? EYE_OFF_ICON : EYE_ICON;
      const title = allHidden ? 'Show all tracks' : 'Hide all tracks';
      allTracksVisBtn.title = title;
      allTracksVisBtn.setAttribute('aria-label', title);
    }

    function toggleAllTracksVisibility() {
      const anyVisible = viewer.getTracks().some((track) => !hiddenTrackIds.has(track.id));
      for (const track of viewer.getTracks()) setTrackHidden(track.id, anyVisible);
      syncAllTracksVisibilityBtn();
      lastTracksRenderKey = '';
      renderTracksList(viewer.getTrack()?.id ?? null, viewer.playback.getCurrentSeconds());
    }

    // The control lives inside the section-collapse button, so keep clicks from toggling the section.
    allTracksVisBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAllTracksVisibility();
    });
    allTracksVisBtn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      toggleAllTracksVisibility();
    });

    function getTrackName(track: ReturnType<typeof viewer.getTracks>[number]): string {
      return track.pilot || track.label || 'Track';
    }

    function getTrackDetail(track: ReturnType<typeof viewer.getTracks>[number]): string {
      const glider = (track.gliderType || '').trim();
      if (glider) return glider;
      const label = (track.label || '').trim();
      const pilot = (track.pilot || '').trim();
      return label && label !== pilot ? label : '';
    }

    function getMapPilotName(track: ReturnType<typeof viewer.getTracks>[number]): string {
      const name = getTrackName(track).replace(/\s+/g, ' ').trim();
      return name.length > 16 ? `${name.slice(0, 15).trimEnd()}…` : name;
    }

    function textColorForBg(hex: string): string {
      const v = hex.replace('#', '');
      const r = parseInt(v.slice(0, 2), 16);
      const g = parseInt(v.slice(2, 4), 16);
      const b = parseInt(v.slice(4, 6), 16);
      return (r * 0.299 + g * 0.587 + b * 0.114) > 150 ? '#111' : '#fff';
    }

    function getMapPilotIconKind(track: ReturnType<typeof viewer.getTracks>[number]): PilotHudIconKind {
      const searchable = `${track.pilot} ${track.label} ${track.gliderType}`.toLowerCase();
      return searchable.includes('plane') ? 'plane' : 'paraglider';
    }

    function formatOrdinal(value: number): string {
      const mod100 = value % 100;
      if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
      switch (value % 10) {
        case 1: return `${value}st`;
        case 2: return `${value}nd`;
        case 3: return `${value}rd`;
        default: return `${value}th`;
      }
    }

    function renderTracksList(activeTrackId: string | null, currentSeconds = 0, autoScrollActiveTrack = false) {
      syncAllTracksVisibilityBtn();
      const task = viewer.getTask();
      const trackingTrackId = viewer.isTracking() ? activeTrackId : null;
      const allTracks = viewer.getTracks();
      const normalizedQuery = trackSearchQuery.trim().toLowerCase();
      trackSearchWrap.hidden = allTracks.length <= 6;
      if (trackSearchWrap.hidden && trackSearchQuery !== '') {
        trackSearchQuery = '';
        trackSearchInput.value = '';
      }

      // Sort by score desc, then distance-to-next-TP asc when task is active
      const activeTrack = activeTrackId ? allTracks.find((track) => track.id === activeTrackId) ?? null : null;
      const filtered = normalizedQuery === ''
        ? allTracks
        : allTracks.filter((track) =>
          `${track.pilot} ${track.label} ${track.gliderType}`.toLowerCase().includes(normalizedQuery));
      const visibleTracks = activeTrack && !filtered.some((track) => track.id === activeTrack.id)
        ? [...filtered, activeTrack]
        : filtered;
      const sorted = [...visibleTracks].sort((a, b) => {
        if (!task) return 0;
        const sa = viewer.getTaskScoreAt(a.id, currentSeconds);
        const sb = viewer.getTaskScoreAt(b.id, currentSeconds);
        if (sb !== sa) return sb - sa;
        // Both finished the course: places lock in finish order, so flying
        // away after the last waypoint can't lose you your place.
        if (sa > 0 && sa === task.scoreable.length) {
          const fa = viewer.getTaskScoreTimes(a.id)[sa - 1] ?? Infinity;
          const fb = viewer.getTaskScoreTimes(b.id)[sa - 1] ?? Infinity;
          return fa - fb;
        }
        return (viewer.getDistanceToNextTPAt(a.id, currentSeconds) - viewer.getDistanceToNextTPAt(b.id, currentSeconds)) || 0;
      });

      const newOrder = sorted.map((t) => t.id);
      const orderChanged = newOrder.some((id, i) => id !== lastSortOrder[i]) || newOrder.length !== lastSortOrder.length;
      const scores = task ? sorted.map((track) => viewer.getTaskScoreAt(track.id, currentSeconds)) : [];
      const renderKey = [
        activeTrackId ?? '',
        trackingTrackId ?? '',
        task ? task.scoreable.length : 0,
        normalizedQuery,
        allTracks.length,
        ...sorted.flatMap((track, i) => [track.id, track.color, getTrackName(track), scores[i] ?? '', hiddenTrackIds.has(track.id) ? 'h' : '']),
      ].join('|');
      if (renderKey === lastTracksRenderKey) {
        if (activeTrackId && autoScrollActiveTrack) requestAnimationFrame(() => positionTrackInList(activeTrackId, 'auto', 'second-from-bottom'));
        return;
      }

      // Snapshot positions before DOM change (for FLIP)
      const prevRects = new Map<string, DOMRect>();
      if (orderChanged) {
        for (const el of tracksListEl.querySelectorAll<HTMLElement>('[data-track-id]')) {
          prevRects.set(el.dataset.trackId!, el.getBoundingClientRect());
        }
      }

      const items = sorted.map((track, trackIndex) => {
        const item = document.createElement('div');
        item.className = 'igc-track-row-wrap';
        item.classList.toggle('active',   track.id === activeTrackId);
        item.classList.toggle('tracking', track.id === trackingTrackId);
        item.classList.toggle('track-hidden', hiddenTrackIds.has(track.id));
        item.dataset.trackId = track.id;
        item.setAttribute('role', 'listitem');

        const name = getTrackName(track);
        const detail = getTrackDetail(track);

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'igc-track-row';
        row.classList.toggle('active', track.id === activeTrackId);
        row.dataset.trackId = track.id;
        row.title = detail ? `${name} - ${detail}` : name;

        const color = document.createElement('span');
        color.className = 'igc-track-color';
        color.style.backgroundColor = track.color;
        color.setAttribute('aria-hidden', 'true');

        const rank = document.createElement('span');
        rank.className = 'igc-track-rank';
        rank.textContent = formatOrdinal(trackIndex + 1);

        const meta = document.createElement('span');
        meta.className = 'igc-track-meta';

        const label = document.createElement('span');
        label.className = 'igc-track-name';
        label.textContent = name;
        meta.append(label);

        if (detail) {
          const detailEl = document.createElement('span');
          detailEl.className = 'igc-track-detail';
          detailEl.textContent = detail;
          meta.append(detailEl);
        }

        row.append(color, rank, meta);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'igc-track-remove';
        removeBtn.dataset.trackId = track.id;
        removeBtn.title = `Remove ${name}`;
        removeBtn.setAttribute('aria-label', `Remove ${name}`);
        removeBtn.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 4.2l7.6 7.6m0-7.6-7.6 7.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

        const trackHidden = hiddenTrackIds.has(track.id);
        const visBtn = document.createElement('button');
        visBtn.type = 'button';
        visBtn.className = 'igc-track-visibility';
        visBtn.dataset.trackId = track.id;
        const visTitle = trackHidden ? `Show ${name}` : `Hide ${name}`;
        visBtn.title = visTitle;
        visBtn.setAttribute('aria-label', visTitle);
        visBtn.innerHTML = trackHidden ? EYE_OFF_ICON : EYE_ICON;

        if (task) {
          const score = scores[trackIndex] ?? 0;
          const total = task.scoreable.length;
          const badge = document.createElement('span');
          badge.className = 'igc-track-score';
          if (score === total) badge.classList.add('igc-score-full');
          badge.textContent = `${score}/${total}`;
          row.append(badge);
        }

        item.append(row, visBtn, removeBtn);
        return item;
      });

      tracksListEl.replaceChildren(...items);
      lastSortOrder = newOrder;
      lastTracksRenderKey = renderKey;

      // FLIP: animate positions that changed
      if (orderChanged && prevRects.size > 0) {
        for (const el of tracksListEl.querySelectorAll<HTMLElement>('[data-track-id]')) {
          const prev = prevRects.get(el.dataset.trackId!);
          if (!prev) continue;
          const curr = el.getBoundingClientRect();
          const dy = prev.top - curr.top;
          if (Math.abs(dy) < 1) continue;
          el.style.transform = `translateY(${dy}px)`;
          el.style.transition = 'none';
          requestAnimationFrame(() => {
            el.style.transition = 'transform 0.35s ease';
            el.style.transform = '';
          });
        }
      }

      if (activeTrackId && autoScrollActiveTrack) {
        requestAnimationFrame(() => positionTrackInList(activeTrackId, 'auto', 'second-from-bottom'));
      }
    }

    function positionTrackInList(
      trackId: string,
      behavior: ScrollBehavior = 'smooth',
      placement: 'nearest' | 'center' | 'second-from-bottom' = 'nearest',
    ) {
      const el = tracksListEl.querySelector<HTMLElement>(`[data-track-id="${CSS.escape(trackId)}"]`);
      if (!el) return;
      const elTop = el.offsetTop;
      const elBottom = elTop + el.offsetHeight;
      let targetTop: number;
      if (placement === 'second-from-bottom') {
        const listStyle = getComputedStyle(tracksListEl);
        const gap = Number.parseFloat(listStyle.rowGap || listStyle.gap) || 0;
        const paddingBottom = Number.parseFloat(listStyle.paddingBottom) || 0;
        const oneRowBelow = el.offsetHeight + gap + paddingBottom;
        targetTop = elBottom - tracksListEl.clientHeight + oneRowBelow;
      } else if (placement === 'center') {
        targetTop = elTop + el.offsetHeight / 2 - tracksListEl.clientHeight / 2;
      } else {
        const margin = 12;
        const viewTop = tracksListEl.scrollTop;
        const viewBottom = viewTop + tracksListEl.clientHeight;
        const alreadyInView = elTop >= viewTop + margin && elBottom <= viewBottom - margin;
        if (alreadyInView) return;
        targetTop = elTop + el.offsetHeight / 2 - tracksListEl.clientHeight / 2;
      }
      const maxScroll = Math.max(0, tracksListEl.scrollHeight - tracksListEl.clientHeight);
      tracksListEl.scrollTo({ top: Math.min(Math.max(targetTop, 0), maxScroll), behavior });
    }

    trackSearchInput.addEventListener('input', () => {
      trackSearchQuery = trackSearchInput.value;
      lastTracksRenderKey = '';
      renderTracksList(viewer.getTrack()?.id ?? null, viewer.playback.getCurrentSeconds());
    });

    const selectPilotTrack = (trackId: string) => {
      if (trackId === viewer.getTrack()?.id) {
        viewer.setTracking(!viewer.isTracking());
        syncTrackingUi();
        return;
      }
      viewer.selectTrack(trackId);
      syncTrackingUi();
    };

    const selectPilotHudTrack = (trackId: string) => {
      if (viewer.isTracking()) {
        if (trackId !== viewer.getTrack()?.id) {
          viewer.selectTrack(trackId);
          syncTrackingUi();
        }
        return;
      }
      selectPilotTrack(trackId);
    };

    let pilotHudClickCandidate: { pointerId: number; trackId: string; x: number; y: number } | null = null;
    const PILOT_HUD_CLICK_SLOP_PX = 6;

    canvas.addEventListener('pointermove', (e) => {
      lastCanvasPointer = { x: e.clientX, y: e.clientY, buttons: e.buttons };
      refreshPilotHudCursor();
    });
    canvas.addEventListener('pointerleave', () => {
      lastCanvasPointer = null;
      setPilotHudCursor(false);
    });
    canvas.addEventListener('pointerdown', (e) => {
      lastCanvasPointer = { x: e.clientX, y: e.clientY, buttons: e.buttons };
      refreshPilotHudCursor();
      if (e.button !== 0) {
        pilotHudClickCandidate = null;
        return;
      }
      const trackId = pilotHudOverlay.hitTest(e.clientX, e.clientY);
      pilotHudClickCandidate = trackId === null
        ? null
        : { pointerId: e.pointerId, trackId, x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', (e) => {
      lastCanvasPointer = { x: e.clientX, y: e.clientY, buttons: e.buttons };
      const candidate = pilotHudClickCandidate;
      pilotHudClickCandidate = null;
      if (candidate && candidate.pointerId === e.pointerId) {
        const moved = Math.hypot(e.clientX - candidate.x, e.clientY - candidate.y);
        const releasedTrackId = moved <= PILOT_HUD_CLICK_SLOP_PX
          ? pilotHudOverlay.hitTest(e.clientX, e.clientY)
          : null;
        if (releasedTrackId === candidate.trackId) {
          e.preventDefault();
          selectPilotHudTrack(candidate.trackId);
        }
      }
      refreshPilotHudCursor();
    });
    canvas.addEventListener('pointercancel', (e) => {
      if (pilotHudClickCandidate?.pointerId === e.pointerId) pilotHudClickCandidate = null;
      lastCanvasPointer = null;
      setPilotHudCursor(false);
    });

    tracksListEl.addEventListener('click', (e) => {
      const visBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.igc-track-visibility');
      if (visBtn?.dataset.trackId) {
        setTrackHidden(visBtn.dataset.trackId, !hiddenTrackIds.has(visBtn.dataset.trackId));
        lastTracksRenderKey = '';
        renderTracksList(viewer.getTrack()?.id ?? null, viewer.playback.getCurrentSeconds());
        return;
      }
      const removeBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.igc-track-remove');
      if (removeBtn?.dataset.trackId) {
        hiddenTrackIds.delete(removeBtn.dataset.trackId);
        viewer.removeTrack(removeBtn.dataset.trackId);
        lastTracksRenderKey = '';
        renderTracksList(viewer.getTrack()?.id ?? null, viewer.playback.getCurrentSeconds());
        return;
      }
      const rowBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.igc-track-row');
      const rowWrap = (e.target as HTMLElement).closest<HTMLElement>('.igc-track-row-wrap');
      const trackId = rowBtn?.dataset.trackId ?? rowWrap?.dataset.trackId;
      if (!trackId) return;
      selectPilotTrack(trackId);
    });

    // ── Track right-click context menu ───────────────────────────────────
    let activeCtxMenu: HTMLElement | null = null;

    function closeCtxMenu() {
      activeCtxMenu?.remove();
      activeCtxMenu = null;
    }

    function showTrackContextMenu(x: number, y: number, trackId: string) {
      closeCtxMenu();
      const menu = document.createElement('div');
      menu.className = 'igc-track-ctx-menu';

      const isCurrentlyTracking = viewer.isTracking() && viewer.getTrack()?.id === trackId;

      const followItem = document.createElement('div');
      followItem.className = 'igc-ctx-item';
      followItem.innerHTML = isCurrentlyTracking
        ? `<svg class="igc-ctx-check" viewBox="0 0 16 16" fill="currentColor"><path d="M2 8.5l4 4 8-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Follow track`
        : `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="2.5"/><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>Follow track`;
      followItem.addEventListener('click', () => {
        selectPilotTrack(trackId);
        closeCtxMenu();
      });

      const useTaskItem = document.createElement('div');
      useTaskItem.className = 'igc-ctx-item';
      useTaskItem.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 2v4l2.5 2.5M2 8a6 6 0 1 0 12 0A6 6 0 0 0 2 8z"/></svg>Use Task`;
      useTaskItem.addEventListener('click', () => {
        viewer.setMasterTrack(trackId);
        closeCtxMenu();
      });

      menu.append(followItem, useTaskItem);

      // Position near click, keeping inside viewport
      menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
      menu.style.top  = `${Math.min(y, window.innerHeight - 100)}px`;
      root.append(menu);
      activeCtxMenu = menu;
    }

    tracksListEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const wrap = (e.target as HTMLElement).closest<HTMLElement>('.igc-track-row-wrap');
      const trackId = wrap?.dataset.trackId;
      if (!trackId) return;
      showTrackContextMenu(e.clientX, e.clientY, trackId);
    });

    root.addEventListener('pointerdown', (e) => {
      if (activeCtxMenu && !activeCtxMenu.contains(e.target as Node)) closeCtxMenu();
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeCtxMenu();
    });

    viewer.setOnTrackChange((track) => {
      if (track) timeline.showTrack(track);
      else timeline.clear();
      renderTracksList(track?.id ?? null, viewer.playback.getCurrentSeconds());
    });

    viewer.setOnTaskChange(() => {
      renderTracksList(viewer.getTrack()?.id ?? null, viewer.playback.getCurrentSeconds());
      timeline.refresh();
    });

    const trackingCheck = root.querySelector<HTMLInputElement>('.igc-tracking-mode')!;

    function syncTrackingUi() {
      trackingCheck.checked = viewer.isTracking();
      renderTracksList(viewer.getTrack()?.id ?? null, viewer.playback.getCurrentSeconds());
    }

    trackingCheck.addEventListener('change', () => {
      viewer.setTracking(trackingCheck.checked);
      syncTrackingUi();
    });
    viewer.setOnTrackingChange(syncTrackingUi);

    // Follow the pilot from the start when requested via the `auto-tracking` attribute.
    if (autoTracking && viewer.getTrack()) {
      viewer.setTracking(true);
      syncTrackingUi();
    }

    // Start with the selected track scrolled into view in the tracks list.
    renderTracksList(viewer.getTrack()?.id ?? null, viewer.playback.getCurrentSeconds(), true);

    let trackingOrbiting = false;
    let trackingOrbitPointerId: number | null = null;
    let trackingOrbitLastX = 0;
    let trackingOrbitLastY = 0;
    // Touch pinch-zoom while tracking: wheel zoom has no touch equivalent, so track
    // active touch points and convert pinch separation into tracking zoom.
    const trackingTouchPoints = new Map<number, { x: number; y: number }>();
    let trackingPinchLastDistance: number | null = null;
    // Pinch separation pixels feel weaker than wheel deltaY pixels; scale up so a
    // full-screen pinch spans a useful zoom range.
    const TRACKING_PINCH_ZOOM_SCALE = 3;
    // Touch double-tap releases tracking (mirrors the dblclick handler below, which
    // never fires for touch because the pointerdown handler calls preventDefault,
    // suppressing synthesized mouse events). Taps on a pilot label are excluded from
    // tap tracking, so a double-tap on a pilot label won't release tracking.
    const TRACKING_TAP_MAX_MS = 300;
    const TRACKING_TAP_SLOP_PX = 24;
    const TRACKING_DOUBLE_TAP_MS = 350;
    const TRACKING_DOUBLE_TAP_SLOP_PX = 64;
    let trackingTapStart: { pointerId: number; x: number; y: number; time: number } | null = null;
    let trackingLastTap: { x: number; y: number; time: number } | null = null;

    canvas.addEventListener('contextmenu', (e) => {
      if (!viewer.isTracking()) return;
      e.preventDefault();
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (!viewer.isTracking()) return;
      if (e.button !== 0 && e.button !== 2) return;
      // Drags starting on a pilot label orbit the camera like anywhere else; a
      // clean release still selects the pilot via the label click handler. That
      // handler listens in the bubble phase on this same canvas, and capture-phase
      // listeners run first at the target — so stopPropagation here would keep the
      // label press from ever reaching it.
      const onPilotLabel = e.button === 0 && pilotHudOverlay.hitTest(e.clientX, e.clientY) !== null;
      e.preventDefault();
      if (!onPilotLabel) e.stopPropagation();
      if (e.pointerType === 'touch') {
        trackingTouchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
        trackingPinchLastDistance = null;
        if (trackingTouchPoints.size === 1) {
          trackingTapStart = onPilotLabel
            ? null
            : { pointerId: e.pointerId, x: e.clientX, y: e.clientY, time: performance.now() };
        } else {
          // A second finger makes this a pinch, not a tap.
          trackingTapStart = null;
          trackingLastTap = null;
        }
      }
      if (!viewer.beginTrackingOrbit()) return;
      trackingOrbiting = true;
      // A second touch starts a pinch — keep the first finger as the orbit pointer.
      if (trackingTouchPoints.size <= 1) {
        trackingOrbitPointerId = e.pointerId;
        trackingOrbitLastX = e.clientX;
        trackingOrbitLastY = e.clientY;
      }
      canvas.setPointerCapture(e.pointerId);
    }, { capture: true });
    canvas.addEventListener('pointermove', (e) => {
      if (!trackingOrbiting) return;
      if (e.pointerType === 'touch' && trackingTouchPoints.has(e.pointerId)) {
        trackingTouchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (trackingTouchPoints.size === 2) {
          e.preventDefault();
          e.stopPropagation();
          const [p0, p1] = [...trackingTouchPoints.values()];
          const distance = Math.hypot(p1.x - p0.x, p1.y - p0.y);
          if (trackingPinchLastDistance !== null) {
            // Separation growing = zoom in = negative wheel delta.
            viewer.adjustTrackingZoom((trackingPinchLastDistance - distance) * TRACKING_PINCH_ZOOM_SCALE);
          }
          trackingPinchLastDistance = distance;
          return;
        }
      }
      if (trackingOrbitPointerId !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      const dx = e.clientX - trackingOrbitLastX;
      const dy = e.clientY - trackingOrbitLastY;
      trackingOrbitLastX = e.clientX;
      trackingOrbitLastY = e.clientY;
      viewer.adjustTrackingOrbit(dx, dy);
    });
    canvas.addEventListener('wheel', (e) => {
      if (!viewer.isTracking()) return;
      e.preventDefault();
      e.stopPropagation();
      viewer.adjustTrackingZoom(e.deltaY);
    }, { passive: false });
    canvas.addEventListener('dblclick', (e) => {
      if (!viewer.isTracking()) return;
      e.preventDefault();
      e.stopPropagation();
      viewer.setTracking(false);
      syncTrackingUi();
    });
    // Returns true when the pointer belonged to the tracking gesture and was handled.
    const releaseTrackingPointer = (e: PointerEvent): boolean => {
      const wasPinchTouch = e.pointerType === 'touch' && trackingTouchPoints.delete(e.pointerId);
      trackingPinchLastDistance = null;
      if (!trackingOrbiting) return false;
      if (trackingOrbitPointerId === e.pointerId) {
        const remaining = trackingTouchPoints.entries().next();
        if (!remaining.done) {
          // Orbit finger lifted mid-pinch — hand the orbit to the remaining finger.
          const [id, p] = remaining.value;
          trackingOrbitPointerId = id;
          trackingOrbitLastX = p.x;
          trackingOrbitLastY = p.y;
        } else {
          trackingOrbiting = false;
          trackingOrbitPointerId = null;
          viewer.endTrackingOrbit();
        }
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return true;
      }
      if (wasPinchTouch) {
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return true;
      }
      return false;
    };

    canvas.addEventListener('pointerup', (e) => {
      const tapStart = trackingTapStart;
      if (!releaseTrackingPointer(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!tapStart || tapStart.pointerId !== e.pointerId) return;
      trackingTapStart = null;
      const now = performance.now();
      const isTap = now - tapStart.time <= TRACKING_TAP_MAX_MS
        && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) <= TRACKING_TAP_SLOP_PX;
      if (!isTap) {
        trackingLastTap = null;
        return;
      }
      // Window runs from the first tap's release to the second tap's press.
      const isDoubleTap = trackingLastTap !== null
        && tapStart.time - trackingLastTap.time <= TRACKING_DOUBLE_TAP_MS
        && Math.hypot(tapStart.x - trackingLastTap.x, tapStart.y - trackingLastTap.y) <= TRACKING_DOUBLE_TAP_SLOP_PX;
      if (isDoubleTap) {
        trackingLastTap = null;
        viewer.setTracking(false);
        syncTrackingUi();
      } else {
        trackingLastTap = { x: e.clientX, y: e.clientY, time: now };
      }
    });
    canvas.addEventListener('pointercancel', (e) => {
      trackingTapStart = null;
      trackingLastTap = null;
      if (!releaseTrackingPointer(e)) return;
      e.stopPropagation();
    });

    function bindSectionToggle(btnSel: string) {
      const btn  = root.querySelector<HTMLButtonElement>(btnSel)!;
      const body = btn.nextElementSibling as HTMLElement;
      btn.addEventListener('click', () => {
        const collapsed = body.classList.toggle('collapsed');
        btn.classList.toggle('collapsed', collapsed);
      });
    }
    bindSectionToggle('.igc-sb-tracks-toggle');
    bindSectionToggle('.igc-sb-landmarks-toggle');
    bindSectionToggle('.igc-sb-airspace-toggle');
    bindSectionToggle('.igc-sb-flight-toggle');
    bindSectionToggle('.igc-sb-viewoptions-toggle');
    bindSectionToggle('.igc-sb-settings-toggle');

    const unitButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-unit-mode]'));
    unitButtons.forEach((button) => {
      button.addEventListener('click', () => {
        unitButtons.forEach((b) => b.classList.toggle('active', b === button));
        unitMode = (button.dataset.unitMode as UnitMode) ?? 'mixed';
        timeline.setUnitMode(unitMode);
        markerGroundCache.clear();
      });
    });

    const altitudeMarkerButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-altitude-marker]'));
    altitudeMarkerButtons.forEach((button) => {
      button.addEventListener('click', () => {
        altitudeMarkerButtons.forEach((b) => b.classList.toggle('active', b === button));
        altitudeMarkerMode = (button.dataset.altitudeMarker as AltitudeMarkerMode) ?? 'asl';
        markerGroundCache.clear();
      });
    });

    const heightCalculationButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-height-calculation]'));
    heightCalculationButtons.forEach((button) => {
      button.addEventListener('click', () => {
        heightCalculationButtons.forEach((b) => b.classList.toggle('active', b === button));
        heightCalculationMode = (button.dataset.heightCalculation as HeightCalculationMode) ?? 'simplified';
        markerGroundCache.clear();
        viewer.setHeightCalculationMode(heightCalculationMode);
        timeline.setHeightCalculationMode(heightCalculationMode);
      });
    });

    const trailLengthButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-trail-length]'));
    trailLengthButtons.forEach((button) => {
      button.addEventListener('click', () => {
        trailLengthButtons.forEach((b) => b.classList.toggle('active', b === button));
        viewer.setTrailLength((button.dataset.trailLength as TrailLengthMode) ?? '10m');
      });
    });

    const cbFullTrailSelected = root.querySelector<HTMLInputElement>('.igc-vs-full-trail-selected')!;
    cbFullTrailSelected.addEventListener('change', () => {
      viewer.setFullTrailForSelected(cbFullTrailSelected.checked);
    });

    const vs = viewer.viewSettings;
    const cbTransmittance = root.querySelector<HTMLInputElement>('.igc-vs-transmittance')!;
    const cbInscattering  = root.querySelector<HTMLInputElement>('.igc-vs-inscattering')!;
    const cbShowGround    = root.querySelector<HTMLInputElement>('.igc-vs-showground')!;
    const cbRaymarch      = root.querySelector<HTMLInputElement>('.igc-vs-raymarch')!;
    const cbShadowLength  = root.querySelector<HTMLInputElement>('.igc-vs-shadow-length')!;
    const cbShadowDisplay = root.querySelector<HTMLInputElement>('.igc-vs-shadow-display')!;

    cbTransmittance.addEventListener('change', () => vs.setTransmittance(cbTransmittance.checked));
    cbInscattering.addEventListener('change',  () => vs.setInscattering(cbInscattering.checked));
    cbShowGround.addEventListener('change',    () => vs.setShowGround(cbShowGround.checked));
    cbRaymarch.addEventListener('change',      () => vs.setRaymarchScattering(cbRaymarch.checked));
    cbShadowLength.addEventListener('change',  () => vs.setShadowLength(cbShadowLength.checked));
    cbShadowDisplay.addEventListener('change', () => vs.setDisplayShadowLength(cbShadowDisplay.checked));

    const exposureSlider = root.querySelector<HTMLInputElement>('.igc-vs-exposure')!;
    const exposureVal    = root.querySelector<HTMLElement>('.igc-vs-exposure-val')!;
    const autoExpCheck   = root.querySelector<HTMLInputElement>('.igc-vs-auto-exposure')!;
    let lastManualExposure = parseFloat(exposureSlider.value);
    exposureSlider.disabled = autoExpCheck.checked;

    exposureSlider.addEventListener('input', () => {
      const v = parseFloat(exposureSlider.value);
      lastManualExposure = v;
      exposureVal.textContent = v.toFixed(1);
      vs.setExposure(v);
    });
    autoExpCheck.addEventListener('change', () => {
      const enabled = autoExpCheck.checked;
      exposureSlider.disabled = enabled;
      if (enabled) {
        lastManualExposure = parseFloat(exposureSlider.value);
        timeline.setAutoExposure(true);
      } else {
        timeline.setAutoExposure(false);
        exposureSlider.value = String(lastManualExposure);
        exposureVal.textContent = lastManualExposure.toFixed(1);
        vs.setExposure(lastManualExposure);
      }
    });

    const fancyCheck   = root.querySelector<HTMLInputElement>('.igc-vs-fancy-lighting')!;
    const fancyDetails = root.querySelector<HTMLElement>('.igc-vs-fancy-details')!;

    function applyFancyLighting(enabled: boolean) {
      fancyDetails.classList.toggle('igc-details--off', !enabled);
      fancyDetails.querySelectorAll<HTMLInputElement>('input').forEach(i => { i.disabled = !enabled; });
      vs.setTransmittance(enabled && cbTransmittance.checked);
      vs.setInscattering(enabled && cbInscattering.checked);
      vs.setShowGround(enabled && cbShowGround.checked);
      vs.setRaymarchScattering(enabled && cbRaymarch.checked);
      vs.setShadowLength(enabled && cbShadowLength.checked);
      vs.setDisplayShadowLength(enabled && cbShadowDisplay.checked);
      vs.setFancyLighting(enabled);
      if (!enabled) {
        timeline.setAutoExposure(false);
        vs.setExposure(1.0);
      } else if (autoExpCheck.checked) {
        timeline.setAutoExposure(true);
      } else {
        vs.setExposure(lastManualExposure);
      }
    }

    fancyCheck.addEventListener('change', () => applyFancyLighting(fancyCheck.checked));
    applyFancyLighting(false);

	    updateCompass();
	  }
}

if (!customElements.get('igc-viewer')) {
  customElements.define('igc-viewer', IGCViewerElement);
}

export { IGCViewerElement };
export default IGCViewerElement;
