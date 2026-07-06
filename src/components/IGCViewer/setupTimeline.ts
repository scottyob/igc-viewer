import type { FlightTrack } from './types';
import type { initViewer } from './viewer';
import { formatAltitudeM, formatDistanceM, formatVerticalSpeedMps } from './formatUnits';
import { sampleTerrainElevationM } from './terrainElevation';
import type { HeightCalculationMode, UnitMode } from './types';

type Viewer = Awaited<ReturnType<typeof initViewer>>;

const CASTS_PER_TICK = 3; // raycast attempts per animation frame

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeStats(pts: FlightTrack['points']) {
  let distM = 0;
  let maxAlt = -Infinity;
  let maxClimb = 0;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].alt > maxAlt) maxAlt = pts[i].alt;
    if (i > 0) {
      distM += haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon) * 1000;
      const dt = pts[i].time - pts[i - 1].time;
      if (dt > 0) {
        const climb = (pts[i].alt - pts[i - 1].alt) / dt;
        if (climb > maxClimb) maxClimb = climb;
      }
    }
  }
  return { distM, maxAlt, maxClimb };
}

// Per-sample terrain elevation with quality level.
// 'simplified' = decoded from AWS Terrarium PNG (~300 m/px at zoom 9)
// 'vector'     = intersected against loaded 3D tile geometry (sub-metre precision)
type TerrainSample = { elevation: number | null; res: HeightCalculationMode };
type DaylightWindow = { sunriseUtcSec: number; sunsetUtcSec: number } | null;
type TimeRangeMode = 'current' | 'fullDay' | 'allTracks';
type TimelineOptions = {
  onScrub?: (seconds: number) => void;
};

// Convert UTC seconds-from-midnight to "HH:MM" using a pre-resolved UTC offset (seconds).
// Using an explicit offset rather than lon/15 lets callers supply the civil timezone offset
// (rawOffset + dstOffset from the Timezone API), which correctly handles DST.
function utcSecToLocalHHMM(utcSec: number, offsetSec: number): string {
  const localSec = utcSec + offsetSec;
  const total = ((localSec % 86400) + 86400) % 86400;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function utcSecToLocalHourLabel(utcSec: number, offsetSec: number): string {
  const localSec = utcSec + offsetSec;
  const total = ((localSec % 86400) + 86400) % 86400;
  const h24 = Math.floor(total / 3600);
  return `${String(h24).padStart(2, '0')}:00`;
}

function utcSecToLocalAxisLabel(utcSec: number, offsetSec: number): string {
  const localSec = utcSec + offsetSec;
  const total = ((localSec % 86400) + 86400) % 86400;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function chooseHourLabelStep(rangeSec: number, axisWidthPx: number): number {
  const hoursVisible = Math.max(1, rangeSec / 3600);
  const pixelsPerHour = axisWidthPx / hoursVisible;
  if (pixelsPerHour >= 88) return 1;
  if (pixelsPerHour >= 52) return 2;
  if (pixelsPerHour >= 36) return 3;
  if (pixelsPerHour >= 28) return 4;
  if (pixelsPerHour >= 18) return 6;
  return 12;
}

function chooseMinorTickStep(rangeSec: number, axisWidthPx: number): number {
  const pixelsPer10Min = axisWidthPx / Math.max(1, rangeSec / 600);
  if (pixelsPer10Min >= 26) return 600;
  if (pixelsPer10Min >= 12) return 1800;
  return 3600;
}

function getDayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / 86400000);
}

function getDaylightWindow(date: Date | null, latDeg: number, rangeStartUtcSec: number): DaylightWindow {
  if (date == null || !isFinite(latDeg)) return null;

  const φ = latDeg * Math.PI / 180;
  const day = getDayOfYear(date);
  const declination = 23.44 * Math.PI / 180 * Math.sin((2 * Math.PI * (284 + day)) / 365);
  const cosHourAngle = -Math.tan(φ) * Math.tan(declination);

  if (cosHourAngle <= -1) {
    return { sunriseUtcSec: rangeStartUtcSec, sunsetUtcSec: rangeStartUtcSec + 86400 };
  }
  if (cosHourAngle >= 1) {
    return null;
  }

  const hourAngle = Math.acos(cosHourAngle);
  const daylightHours = (2 * hourAngle * 180) / (Math.PI * 15);
  const sunriseLocalHours = 12 - daylightHours / 2;
  const sunsetLocalHours = 12 + daylightHours / 2;

  return {
    sunriseUtcSec: rangeStartUtcSec + sunriseLocalHours * 3600,
    sunsetUtcSec: rangeStartUtcSec + sunsetLocalHours * 3600,
  };
}

const AUTO_EXPOSURE_DAY   = 3.0;
const AUTO_EXPOSURE_NIGHT = 9.0;
const AUTO_EXPOSURE_TRAN  = 3600; // 1-hour transition window

export function createTimeline(
  root: HTMLElement,
  viewer: Viewer,
  options: TimelineOptions = {},
): {
  showTrack: (track: FlightTrack) => void;
  clear: () => void;
  setAutoExposure: (enabled: boolean) => void;
  setHeightCalculationMode: (mode: HeightCalculationMode) => void;
  setUnitMode: (mode: UnitMode) => void;
  refresh: () => void;
  dispose: () => void;
} {

  const apiKey = (root.dataset.apiKey ?? '').trim();

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const timeline      = root.querySelector<HTMLElement>('.igc-timeline')!;
  const sidebar       = root.querySelector<HTMLElement>('.igc-sidebar')!;
  const pilotLabel    = root.querySelector<HTMLElement>('.igc-tl-pilot-name')!;
  const localTimeEl   = root.querySelector<HTMLElement>('.igc-tl-local-time')!;
  const trackEl       = root.querySelector<HTMLElement>('.igc-tl-track')!;
  const canvas        = root.querySelector<HTMLCanvasElement>('.igc-tl-canvas')!;
  const cursorEl      = root.querySelector<HTMLElement>('.igc-tl-cursor')!;
  const timeAxisEl    = root.querySelector<HTMLElement>('.igc-tl-time-axis')!;
  const sbToggle      = root.querySelector<HTMLElement>('.igc-sidebar-toggle')!;
  const settingsBtn   = root.querySelector<HTMLElement>('.igc-tl-settings-btn')!;
  const settingsMenu  = root.querySelector<HTMLElement>('.igc-tl-settings-menu')!;
  const rangeModeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-range-mode]'));

  const statPilot    = root.querySelector<HTMLElement>('.igc-stat-pilot')!;
  const statDate     = root.querySelector<HTMLElement>('.igc-stat-date')!;
  const statDuration = root.querySelector<HTMLElement>('.igc-stat-duration')!;
  const statDistance = root.querySelector<HTMLElement>('.igc-stat-distance')!;
  const statMaxAlt   = root.querySelector<HTMLElement>('.igc-stat-maxalt')!;
  const statMaxClimb = root.querySelector<HTMLElement>('.igc-stat-maxclimb')!;
  const statTaskStart  = root.querySelector<HTMLElement>('.igc-stat-taskstart')!;
  const statTaskLength = root.querySelector<HTMLElement>('.igc-stat-tasklength')!;
  const taskStatRows = Array.from(root.querySelectorAll<HTMLElement>('.igc-stat-task-row'));
  const exposureSlider = root.querySelector<HTMLInputElement>('.igc-vs-exposure');
  const exposureValEl  = root.querySelector<HTMLElement>('.igc-vs-exposure-val');

  // ── State ──────────────────────────────────────────────────────────────────
  let currentTrack: FlightTrack | null = null;
  let trackLat = 0;
  let trackLon = 0;
  let tzOffsetSec: number | null = null; // null until Timezone API responds; falls back to solar time
  let daylightWindow: DaylightWindow = null;
  let terrainSamples: TerrainSample[] | null = null;
  let sampledPoints: FlightTrack['points'] = [];
  let rafId = 0;
  let isDragging = false;
  let sidebarCollapsed = false;
  let timeRangeMode: TimeRangeMode = 'allTracks';
  let heightCalculationMode: HeightCalculationMode = 'simplified';
  let unitMode: UnitMode = 'mixed';
  let disposeTileLoad: (() => void) | null = null;
  let tilesLoading = false;
  let autoExposure = false;
  let lastAutoExp = -1;

  // ── Timezone offset ────────────────────────────────────────────────────────
  // Returns the civil UTC offset in seconds. Uses the value from the Timezone API
  // (rawOffset + dstOffset, which includes DST) once available; falls back to
  // the solar-time approximation lon/15h until then.
  function getOffsetSec(): number {
    return tzOffsetSec ?? (trackLon / 15) * 3600;
  }

  async function fetchTimezone(lat: number, lon: number, unixTimestamp: number): Promise<void> {
    if (!apiKey) return;
    try {
      const url = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lon}&timestamp=${unixTimestamp}&key=${apiKey}`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json() as { status: string; rawOffset?: number; dstOffset?: number };
      if (data.status === 'OK' && typeof data.rawOffset === 'number' && typeof data.dstOffset === 'number') {
        tzOffsetSec = data.rawOffset + data.dstOffset;
        if (currentTrack) {
          localTimeEl.textContent = `${utcSecToLocalHHMM(viewer.playback.getCurrentSeconds(), getOffsetSec())} local`;
          drawTimeAxis();
          updateTaskStats();
        }
      }
    } catch {
      // leave tzOffsetSec null; solar-time fallback remains active
    }
  }

  // ── Time range helpers ─────────────────────────────────────────────────────
  function getTimeRange(): [number, number] {
    if (!currentTrack) return [0, 86400];
    if (timeRangeMode === 'allTracks') {
      const tracks = viewer.getTracks();
      if (tracks.length > 0) {
        const start = Math.min(...tracks.map((track) => track.start));
        const end = Math.max(...tracks.map((track) => track.end));
        if (end > start) return [start, end];
      }
    }
    if (timeRangeMode === 'fullDay') {
      // Local midnight in UTC seconds for the civil day containing the flight
      // midpoint. Uses the Timezone API offset (includes DST) when available.
      const offset = getOffsetSec();
      const midpointUtc = (currentTrack.start + currentTrack.end) / 2;
      const localDayIndex = Math.floor((midpointUtc + offset) / 86400);
      const localMidnightUtc = localDayIndex * 86400 - offset;
      return [localMidnightUtc, localMidnightUtc + 86400];
    }
    return [currentTrack.start, currentTrack.end];
  }

  // Linear interpolation of GPS altitude at an arbitrary UTC second.
  // Returns null when t is outside the recorded flight window.
  function interpolateAltAtTime(t: number): number | null {
    if (!currentTrack) return null;
    const pts = currentTrack.points;
    if (t < pts[0].time || t > pts[pts.length - 1].time) return null;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].time <= t) lo = mid; else hi = mid;
    }
    const dt = pts[hi].time - pts[lo].time;
    if (dt === 0) return pts[lo].alt;
    return pts[lo].alt + (pts[hi].alt - pts[lo].alt) * (t - pts[lo].time) / dt;
  }

  // ── Settings button ────────────────────────────────────────────────────────
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !!settingsMenu.hidden;
    settingsMenu.hidden = !willOpen;
    settingsBtn.classList.toggle('active', willOpen);
  });

  const onDocClick = (e: MouseEvent) => {
    if (!settingsMenu.contains(e.target as Node) && e.target !== settingsBtn) {
      settingsMenu.hidden = true;
      settingsBtn.classList.remove('active');
    }
  };
  document.addEventListener('click', onDocClick);

  function setTimeRangeMode(mode: TimeRangeMode) {
    timeRangeMode = mode;
    rangeModeButtons.forEach((button) => {
      const active = button.dataset.rangeMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (currentTrack) {
      updateDaylightWindow();
      drawTimeAxis();
      resizeCanvas();
    }
  }

  rangeModeButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.rangeMode === timeRangeMode));
    button.addEventListener('click', () => {
      setTimeRangeMode((button.dataset.rangeMode as TimeRangeMode) ?? 'current');
    });
  });

  // ── Scrubber ───────────────────────────────────────────────────────────────
  function seekFromClientX(clientX: number) {
    if (!currentTrack) return;
    const rect = trackEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const [tStart, tEnd] = getTimeRange();
    const seconds = Math.round(tStart + frac * (tEnd - tStart));
    viewer.playback.seek(seconds);
    options.onScrub?.(seconds);
  }

  trackEl.addEventListener('mousedown', (e) => { isDragging = true; seekFromClientX(e.clientX); });

  const onMouseMove = (e: MouseEvent) => { if (isDragging) seekFromClientX(e.clientX); };
  const onMouseUp   = () => { isDragging = false; };
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup',   onMouseUp);

  trackEl.addEventListener('touchstart', (e) => { isDragging = true; seekFromClientX(e.touches[0].clientX); }, { passive: true });
  const onTouchMove = (e: TouchEvent) => { if (isDragging) seekFromClientX(e.touches[0].clientX); };
  const onTouchEnd  = () => { isDragging = false; };
  document.addEventListener('touchmove', onTouchMove, { passive: true });
  document.addEventListener('touchend',  onTouchEnd);

  // ── Sidebar collapse ───────────────────────────────────────────────────────
  function setSidebarCollapsed(collapsed: boolean) {
    sidebarCollapsed = collapsed;
    sidebar.classList.toggle('collapsed', collapsed);
    sbToggle.innerHTML = collapsed
      ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>`;
  }
  sbToggle.addEventListener('click', () => setSidebarCollapsed(!sidebarCollapsed));

  // ── Progressive raycast ────────────────────────────────────────────────────
  let castCursor = 0;

  function progressiveCast() {
    if (heightCalculationMode !== 'vector' || !terrainSamples || sampledPoints.length === 0 || !currentTrack || tilesLoading) return;

    const s = viewer.playback.getCurrentSeconds();
    const trackRange = currentTrack.end - currentTrack.start;
    const frac = trackRange > 0
      ? Math.max(0, Math.min(1, (s - currentTrack.start) / trackRange))
      : 0;
    const center = Math.round(frac * (sampledPoints.length - 1));
    const n = sampledPoints.length;

    let casts = 0;
    let redrawn = false;

    for (let d = 0; d <= Math.min(10, n) && casts < CASTS_PER_TICK; d++) {
      for (const sign of [-1, 1]) {
        if (casts >= CASTS_PER_TICK) break;
        const idx = center + sign * d;
        if (idx < 0 || idx >= n) continue;
        if (terrainSamples[idx].res === 'vector') continue;

        const pt = sampledPoints[idx];
        const elev = viewer.castGroundElevation(pt.lat, pt.lon, pt.alt);
        if (elev !== null) {
          const prev = terrainSamples[idx].elevation;
          terrainSamples[idx] = { elevation: elev, res: 'vector' };
          if (prev === null || Math.abs(elev - prev) > 0.5) redrawn = true;
        }
        casts++;
      }
    }

    for (let i = 0; i < 2 && castCursor < n; i++) {
      while (castCursor < n && terrainSamples[castCursor].res === 'vector') castCursor++;
      if (castCursor < n) {
        const pt = sampledPoints[castCursor];
        const elev = viewer.castGroundElevation(pt.lat, pt.lon, pt.alt);
        if (elev !== null) {
          const prev = terrainSamples[castCursor].elevation;
          terrainSamples[castCursor] = { elevation: elev, res: 'vector' };
          if (prev === null || Math.abs(elev - prev) > 0.5) redrawn = true;
        }
        castCursor++;
      }
    }

    if (redrawn) drawCharts();
  }

  // ── Auto exposure ──────────────────────────────────────────────────────────
  function computeAutoExposure(currentSec: number): number {
    if (!daylightWindow) return AUTO_EXPOSURE_DAY;
    const { sunriseUtcSec, sunsetUtcSec } = daylightWindow;
    if (currentSec < sunriseUtcSec) return AUTO_EXPOSURE_NIGHT;
    if (currentSec < sunriseUtcSec + AUTO_EXPOSURE_TRAN) {
      const t = (currentSec - sunriseUtcSec) / AUTO_EXPOSURE_TRAN;
      return AUTO_EXPOSURE_NIGHT + t * (AUTO_EXPOSURE_DAY - AUTO_EXPOSURE_NIGHT);
    }
    if (currentSec < sunsetUtcSec - AUTO_EXPOSURE_TRAN) return AUTO_EXPOSURE_DAY;
    if (currentSec < sunsetUtcSec) {
      const t = (currentSec - (sunsetUtcSec - AUTO_EXPOSURE_TRAN)) / AUTO_EXPOSURE_TRAN;
      return AUTO_EXPOSURE_DAY + t * (AUTO_EXPOSURE_NIGHT - AUTO_EXPOSURE_DAY);
    }
    return AUTO_EXPOSURE_NIGHT;
  }

  function applyAutoExposure(currentSec: number) {
    const exp = computeAutoExposure(currentSec);
    if (Math.abs(exp - lastAutoExp) < 0.05) return;
    lastAutoExp = exp;
    viewer.viewSettings.setExposure(exp);
    if (exposureSlider) exposureSlider.value = exp.toFixed(1);
    if (exposureValEl) exposureValEl.textContent = exp.toFixed(1);
  }

  function setAutoExposure(enabled: boolean) {
    autoExposure = enabled;
    lastAutoExp = -1; // force update on next apply
    if (enabled) applyAutoExposure(viewer.playback.getCurrentSeconds());
  }

  // ── rAF loop ───────────────────────────────────────────────────────────────
  function tick() {
    if (currentTrack) {
      const s = viewer.playback.getCurrentSeconds();
      const [tStart, tEnd] = getTimeRange();
      const range = tEnd - tStart;
      const frac = range > 0 ? (s - tStart) / range : 0;
      cursorEl.style.left = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      localTimeEl.textContent = `${utcSecToLocalHHMM(s, getOffsetSec())} local`;
      if (autoExposure) applyAutoExposure(s);
      progressiveCast();
    }
    rafId = requestAnimationFrame(tick);
  }

  // ── Time axis ──────────────────────────────────────────────────────────────
  function drawTimeAxis() {
    if (!currentTrack) return;
    const [tStart, tEnd] = getTimeRange();
    const range = tEnd - tStart;
    const axisWidth = Math.max(timeAxisEl.clientWidth, trackEl.clientWidth, 1);
    const labelStepSec = chooseHourLabelStep(range, axisWidth) * 3600;
    const minorTickStepSec = chooseMinorTickStep(range, axisWidth);
    const firstHour = Math.ceil(tStart / 3600) * 3600;
    const firstMinorTick = Math.ceil(tStart / minorTickStepSec) * minorTickStepSec;
    const timeToPct = (t: number) => ((t - tStart) / range) * 100;
    let html = '';

    for (let t = firstMinorTick; t <= tEnd; t += minorTickStepSec) {
      const pct = timeToPct(t);
      const isHour = t % 3600 === 0;
      if (isHour) {
        html += `<span class="igc-tl-axis-tick igc-tl-axis-tick--hour" style="left:${pct.toFixed(4)}%"></span>`;
      } else if (minorTickStepSec < 3600) {
        html += `<span class="igc-tl-axis-tick igc-tl-axis-tick--minor" style="left:${pct.toFixed(4)}%"></span>`;
      }
    }

    for (let t = firstHour; t <= tEnd; t += 3600) {
      if ((t - firstHour) % labelStepSec !== 0) continue;
      const pct = timeToPct(t);
      const alignClass = pct <= 4 ? ' igc-tl-axis-label--start' : pct >= 96 ? ' igc-tl-axis-label--end' : '';
      html += `<span class="igc-tl-axis-label${alignClass}" style="left:${pct.toFixed(4)}%">${utcSecToLocalHourLabel(t, getOffsetSec())}</span>`;
    }

    const flightStartPct = timeToPct(currentTrack.start);
    const flightEndPct = timeToPct(currentTrack.end);
    const startAlignClass = flightStartPct <= 4 ? ' igc-tl-axis-label--start' : flightStartPct >= 96 ? ' igc-tl-axis-label--end' : '';
    const endAlignClass = flightEndPct <= 4 ? ' igc-tl-axis-label--start' : flightEndPct >= 96 ? ' igc-tl-axis-label--end' : '';
    html += `<span class="igc-tl-axis-label igc-tl-axis-label--flight${startAlignClass}" style="left:${flightStartPct.toFixed(4)}%">${utcSecToLocalAxisLabel(currentTrack.start, getOffsetSec())}</span>`;
    html += `<span class="igc-tl-axis-label igc-tl-axis-label--flight${endAlignClass}" style="left:${flightEndPct.toFixed(4)}%">${utcSecToLocalAxisLabel(currentTrack.end, getOffsetSec())}</span>`;

    timeAxisEl.innerHTML = html;
  }

  function updateDaylightWindow() {
    if (!currentTrack) { daylightWindow = null; return; }
    // getDaylightWindow expresses sunrise/sunset as solar-time hours from solar midnight,
    // so its reference point must always be solar midnight (lon/15 offset), not civil midnight.
    const solarOffset = (trackLon / 15) * 3600;
    const midpointUtcSec = (currentTrack.start + currentTrack.end) / 2;
    const dayIndex = Math.floor((midpointUtcSec + solarOffset) / 86400);
    const solarMidnightUtc = dayIndex * 86400 - solarOffset;
    daylightWindow = getDaylightWindow(currentTrack.date, trackLat, solarMidnightUtc);
  }

  // ── Charts ─────────────────────────────────────────────────────────────────
  function drawCharts() {
    if (!currentTrack) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const [tStart, tEnd] = getTimeRange();
    const tRange = tEnd - tStart;
    const timeToX = (t: number) => ((t - tStart) / tRange) * (W - 1);

    if (timeRangeMode === 'fullDay' && daylightWindow != null) {
      const sunriseX = Math.max(0, Math.min(W - 1, timeToX(daylightWindow.sunriseUtcSec)));
      const sunsetX = Math.max(0, Math.min(W - 1, timeToX(daylightWindow.sunsetUtcSec)));
      if (sunriseX > 0) {
        ctx.fillStyle = 'rgba(6, 10, 18, 0.34)';
        ctx.fillRect(0, 0, sunriseX, H);
      }
      if (sunsetX > sunriseX) {
        const daylightGradient = ctx.createLinearGradient(0, 0, 0, H);
        daylightGradient.addColorStop(0, 'rgba(255, 219, 138, 0.12)');
        daylightGradient.addColorStop(1, 'rgba(160, 214, 255, 0.04)');
        ctx.fillStyle = daylightGradient;
        ctx.fillRect(sunriseX, 0, sunsetX - sunriseX, H);
      }
      if (sunsetX < W - 1) {
        ctx.fillStyle = 'rgba(6, 10, 18, 0.34)';
        ctx.fillRect(sunsetX, 0, W - sunsetX, H);
      }
    }

    if (timeRangeMode !== 'current') {
      const flightX0 = Math.max(0, Math.min(W - 1, timeToX(currentTrack.start)));
      const flightX1 = Math.max(0, Math.min(W - 1, timeToX(currentTrack.end)));
      if (flightX1 > flightX0) {
        ctx.fillStyle = 'rgba(80, 200, 255, 0.08)';
        ctx.fillRect(flightX0, 0, flightX1 - flightX0, H);
        ctx.strokeStyle = 'rgba(80, 200, 255, 0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(flightX0, 0);
        ctx.lineTo(flightX0, H);
        ctx.moveTo(flightX1, 0);
        ctx.lineTo(flightX1, H);
        ctx.stroke();
      }
    }

    if (timeRangeMode === 'current') {
      const flightX0 = Math.max(0, Math.min(W - 1, timeToX(currentTrack.start)));
      const flightX1 = Math.max(0, Math.min(W - 1, timeToX(currentTrack.end)));
      if (flightX1 > flightX0) {
        ctx.fillStyle = 'rgba(80, 200, 255, 0.05)';
        ctx.fillRect(flightX0, 0, flightX1 - flightX0, H);
      }
    }

    // Task waypoint markers for the active pilot.
    if (viewer.getTask()) {
      const drawWaypointLine = (t: number, color: string, lw: number) => {
        const x = timeToX(t);
        if (x < 0 || x > W - 1) return;
        ctx!.beginPath();
        ctx!.moveTo(x, 0);
        ctx!.lineTo(x, H);
        ctx!.strokeStyle = color;
        ctx!.lineWidth = lw;
        ctx!.stroke();
      };

      for (const t of viewer.getTaskScoreTimes(currentTrack.id)) {
        if (t !== null) drawWaypointLine(t, 'rgba(255, 214, 64, 0.475)', 2);
      }
    }

    // Pilot altitude per canvas column, null outside flight window
    const altCols: (number | null)[] = new Array(W);
    for (let x = 0; x < W; x++) {
      altCols[x] = interpolateAltAtTime(tStart + (x / (W - 1)) * tRange);
    }

    const hasTerrainData = terrainSamples !== null && terrainSamples.length > 1;

    // Y scale from all visible data
    let chartMin = Infinity, chartMax = -Infinity;
    for (const v of altCols) {
      if (v !== null) {
        if (v < chartMin) chartMin = v;
        if (v > chartMax) chartMax = v;
      }
    }
    if (hasTerrainData) {
      for (const s of terrainSamples!) {
        if (s.elevation === null) continue;
        if (s.elevation < chartMin) chartMin = s.elevation;
        if (s.elevation > chartMax) chartMax = s.elevation;
      }
    }
    if (!isFinite(chartMin)) return;

    const pad = (chartMax - chartMin) * 0.12 || 100;
    chartMin -= pad;
    const chartRange = (chartMax + pad) - chartMin;
    const toY = (v: number) => H - ((v - chartMin) / chartRange) * H;

    function strokePolyline(pts: Array<{ x: number; y: number } | null>, color: string, lw: number) {
      ctx!.beginPath();
      let down = false;
      for (const p of pts) {
        if (!p) { down = false; continue; }
        if (!down) { ctx!.moveTo(p.x, p.y); down = true; }
        else ctx!.lineTo(p.x, p.y);
      }
      ctx!.strokeStyle = color;
      ctx!.lineWidth = lw;
      ctx!.lineJoin = 'round';
      ctx!.stroke();
    }

    // Terrain — each sample mapped to its actual time position on the x-axis
    if (hasTerrainData) {
      const terrainPts = terrainSamples!.map((s, i) => {
        if (s.elevation === null) return null;
        const x = timeToX(sampledPoints[i].time);
        return (x >= -1 && x <= W + 1)
          ? { x, y: Math.max(0, Math.min(H, toY(s.elevation))) }
          : null;
      });
      strokePolyline(terrainPts, 'rgba(180, 160, 120, 0.9)', 1.5);
    }

    // Pilot altitude
    const altPts = altCols.map((v, x) =>
      v !== null ? { x, y: Math.max(0, Math.min(H, toY(v))) } : null,
    );
    strokePolyline(altPts, 'rgba(80, 200, 255, 1)', 2);
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio ?? 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    drawCharts();
    drawTimeAxis();
  }

  const canvasObserver = new ResizeObserver(resizeCanvas);
  canvasObserver.observe(canvas);

  let currentFetchId = 0;

  async function fetchTerrain(track: FlightTrack, fetchId: number) {
    const NUM_SAMPLES = 120;
    const step = Math.max(1, Math.floor(track.points.length / NUM_SAMPLES));
    const pts = track.points.filter((_, i) => i % step === 0).slice(0, 512);
    const elevations = await Promise.all(pts.map((p) => sampleTerrainElevationM(p.lat, p.lon)));

    if (fetchId !== currentFetchId) return;

    sampledPoints = pts;
    terrainSamples = elevations.map((elevation) => ({ elevation, res: 'simplified' as const }));

    castCursor = 0;
    resizeCanvas();
  }

  function updateTrackStats(): void {
    if (!currentTrack) return;
    const { distM, maxAlt, maxClimb } = computeStats(currentTrack.points);
    statDistance.textContent = formatDistanceM(distM, unitMode);
    statMaxAlt.textContent = formatAltitudeM(maxAlt, unitMode);
    statMaxClimb.textContent = `+${formatVerticalSpeedMps(maxClimb, unitMode)}`;
  }

  // ── Task stats (start time / route length) ─────────────────────────────────
  function updateTaskStats() {
    const task = viewer.getTask();
    taskStatRows.forEach((el) => { el.hidden = !task; });
    if (!task || !currentTrack) return;

    const times = viewer.getTaskScoreTimes(currentTrack.id);
    const startIdx = task.scoreable.findIndex((tp) => tp.type === 'start');
    const startTime = startIdx >= 0 ? times[startIdx] : null;
    statTaskStart.textContent = startTime != null
      ? `${utcSecToLocalHHMM(startTime, getOffsetSec())} local`
      : '—';

    let lengthM = 0;
    for (let i = 1; i < task.scoreable.length; i++) {
      const a = task.scoreable[i - 1];
      const b = task.scoreable[i];
      lengthM += haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;
    }
    statTaskLength.textContent = formatDistanceM(lengthM, unitMode);
  }

  // ── showTrack — called when a file is loaded ───────────────────────────────
  function showTrack(track: FlightTrack) {
    currentTrack   = track;
    trackLat       = track.points[Math.floor(track.points.length / 2)].lat;
    trackLon       = track.points[Math.floor(track.points.length / 2)].lon;
    tzOffsetSec    = track.tzOffsetSec; // use HFTZNTIMEZONE when present
    updateDaylightWindow();
    terrainSamples = null;
    sampledPoints  = [];
    castCursor     = 0;
    currentFetchId++;

    timeline.classList.add('igc-timeline--active');
    sidebar.classList.add('igc-sidebar--active');
    setSidebarCollapsed(false);

    pilotLabel.textContent = track.pilot || track.label;

    statPilot.textContent = track.pilot || '—';
    statDate.textContent  = track.date
      ? track.date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
      : '—';
    const dur = track.end - track.start;
    statDuration.textContent = (() => {
      const h = Math.floor(dur / 3600);
      const m = Math.floor((dur % 3600) / 60);
      const s = Math.floor(dur % 60);
      return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
    })();
    updateTrackStats();
    updateTaskStats();

    localTimeEl.textContent = `${utcSecToLocalHHMM(viewer.playback.getCurrentSeconds(), getOffsetSec())} local`;

    disposeTileLoad?.();
    disposeTileLoad = viewer.onTilesLoadChange((loading) => {
      tilesLoading = loading;
      if (!loading && heightCalculationMode === 'vector' && terrainSamples) {
        for (const s of terrainSamples) s.res = 'simplified';
        castCursor = 0;
      }
    });

    drawTimeAxis();
    requestAnimationFrame(resizeCanvas);
    fetchTerrain(track, currentFetchId);
    // Only hit the Timezone API when the IGC file didn't include HFTZNTIMEZONE.
    if (tzOffsetSec === null && track.date) {
      const unixTs = Math.floor(track.date.getTime() / 1000) + track.start;
      void fetchTimezone(trackLat, trackLon, unixTs);
    }

    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function clear() {
    currentTrack = null;
    terrainSamples = null;
    sampledPoints = [];
    castCursor = 0;
    currentFetchId++;
    disposeTileLoad?.();
    disposeTileLoad = null;
    timeline.classList.remove('igc-timeline--active');
    sidebar.classList.remove('igc-sidebar--active');
    pilotLabel.textContent = '';
    localTimeEl.textContent = '';
    timeAxisEl.innerHTML = '';
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    statPilot.textContent = '—';
    statDate.textContent = '—';
    statDuration.textContent = '—';
    statDistance.textContent = '—';
    statMaxAlt.textContent = '—';
    statMaxClimb.textContent = '—';
    taskStatRows.forEach((el) => { el.hidden = true; });
  }

  // ── dispose ────────────────────────────────────────────────────────────────
  function dispose() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    disposeTileLoad?.();
    canvasObserver.disconnect();
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup',   onMouseUp);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend',  onTouchEnd);
  }

  function refresh() {
    updateTrackStats();
    updateTaskStats();
    if (currentTrack) drawCharts();
  }

  function setHeightCalculationMode(mode: HeightCalculationMode): void {
    if (heightCalculationMode === mode) return;
    heightCalculationMode = mode;
    castCursor = 0;
    if (currentTrack) {
      currentFetchId++;
      terrainSamples = null;
      sampledPoints = [];
      drawCharts();
      void fetchTerrain(currentTrack, currentFetchId);
    }
  }

  function setUnitMode(mode: UnitMode): void {
    unitMode = mode;
    refresh();
  }
  return { showTrack, clear, setAutoExposure, setHeightCalculationMode, setUnitMode, refresh, dispose };
}
