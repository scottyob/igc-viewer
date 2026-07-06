# IGC Viewer — Build Plan

Phases are sequential. Each phase should be working and visually verifiable before
moving to the next. Notes on decisions and risks are inline.

---

## Phase 1 — Project Scaffold ✓

**Goal:** Astro project with a blank Three.js canvas that loads Google Photorealistic
3D Tiles and shows the globe.

**Done:** Globe renders photorealistically, GlobeControls orbit works, compass widget
with north-reset, drag-and-drop IGC loading, altitude-gradient track line, camera
fly-to animation on first load.

Key fixes during implementation:
- Inline `preprocessURL` for session token refresh
- `THREE.NoToneMapping` required for baked tile colours
- `adjustHeight = false` before tiles load avoids jitter

---

## Phase 2 — WebGPU Renderer + Atmosphere + Shadows ✓

**Goal:** Physically-based sky and lighting, cascaded shadows, full post-processing pipeline.

**Done:**
- Full rewrite from `WebGLRenderer` → `WebGPURenderer` (`three/webgpu`, `highPrecision = true`)
- `AtmosphereContext` from `@takram/three-atmosphere/webgpu` bound to renderer's `contextNode`
- `AtmosphereLight` (directional sun) + `AtmosphereLightNode` registered via `renderer.library.addLight`
- `CascadedShadowMapsNode`: 3 cascades, 50 km range, fade
- `TileMaterialPlugin`: replaces tile materials with `MeshLambertNodeMaterial`, enables cast/receive shadow
- Post-processing pipeline (TSL node graph, `RenderPipeline`):
  - MRT pass: output + `highpVelocity` + `viewZUnit`
  - `aerialPerspective` → `lensFlare` → `AgXToneMapping` → `temporalAntialias` → `dithering`
- `parseFlightDate` reads HFDTE from IGC → `currentDate` for sun position
- `atLocalEvening` sets default view time to 18:30 local solar time
- Stars rendered automatically by `AerialPerspectiveNode`'s internal `SkyNode`
- Precomputed atmosphere LUTs in `public/atmosphere/`

---

## Phase 3 — IGC Time Parsing + Single-Pilot Foundation

**Goal:** Parse time from B-records and model a single-pilot flight as a time-indexed
data structure that will drive the timeline UI and later the playback animation.

### Steps
- [x] Parse `HHMMSS` from cols 1–6 of each B-record; add `time: number` (seconds from
      midnight UTC) to `IGCPoint` in `types.ts`
- [x] Derive `flightStart` and `flightEnd` (UTC seconds) from first/last valid fix
- [x] Store current track as `FlightTrack` in `setupTracks.ts` — expose `getTrack()` via `viewer.ts`
- [x] Add file picker button (bottom-left, 44×44 px) as fallback for drag-drop on mobile
- [x] Expose `tracks` prop URL loading — fetch each URL and call `loadIGCText` on init

**Done when:** Loading an IGC file gives you the flight start/end times in the console
and the file-picker button works on mobile.

---

## Phase 4 — Timeline UI (Single Pilot)

**Goal:** Bottom bar with flight timeline and altitude charts. Desktop also gets a
collapsible right sidebar scaffold.

### Bottom bar (both platforms)

The bar spans the full width of the display below the 3D canvas.

- [ ] Left label: `0:00` (flight start), right label: flight duration (e.g. `1:23`)
- [ ] Full-width track showing total flight time
- [ ] **Red draggable cursor** showing current time position
  - Drag updates `currentTime`; `currentTime` is passed to `atmosphere.update()` each frame
    so the sun moves in real time as you scrub
- [ ] **Two stacked chart lanes** filling the width of the timeline bar:
  - **Top lane — terrain elevation** (metres above sea level at each GPS fix)
    - Elevation source decision: use Google Maps Elevation API (same key, batch up to 512
      points per request), falling back to a flat 0 m line if unavailable
    - Filled area chart, dark grey fill
  - **Bottom lane — pilot GPS altitude** (metres above sea level)
    - Filled area chart, coloured using the same blue→orange gradient as the track
  - Rendering: draw both as `<canvas>` charts overlaid on the scrubber background
  - The vertical gap between pilot altitude and terrain altitude is AGL height — visually
    obvious without needing an extra label
- [ ] Clicking anywhere in the bar seeks to that time (not just dragging the cursor)
- [ ] Play / pause button (space bar shortcut on desktop)
- [ ] Speed selector: 1×, 5×, 10×, 30×, 100×

### Desktop right sidebar

Only visible on screens ≥ 900 px wide. Hidden on mobile.

- [ ] Fixed-width panel on the right edge (default 280 px)
- [ ] Resizable: drag handle on the left edge of the panel
- [ ] Collapsible: chevron toggle button collapses to a thin icon strip
- [ ] For now, shows: pilot name, flight date, total distance, max altitude, max climb rate
      (derived from the loaded IGC file — no external data needed)
- [ ] Designed to grow in later phases (pilot list, analysis tools, etc.)

### Mobile layout

- [ ] Bottom bar only — no right sidebar
- [ ] Charts are visible but smaller (64 px tall combined)
- [ ] All touch targets ≥ 44 × 44 px
- [ ] Bar collapses to 20 px strip via tap on a handle, with a pull-up gesture to re-open

**Done when:** You can scrub through a flight and the sun tracks across the sky. Charts
show terrain and altitude. Desktop sidebar shows basic flight stats.

---

## Phase 5 — Multi-Pilot Support

**Goal:** Load 6–30 IGC files simultaneously; each pilot is independently tracked.

### Steps
- [ ] Switch `setupTracks.ts` from replace-on-load to accumulate — each `loadIGCText`
      call adds a new track entry (clear-all button in sidebar)
- [ ] Per-pilot base colour: palette of 30 perceptually-distinct hues; assigned on load
- [ ] Track geometry uses pilot base colour tinted by altitude gradient
- [ ] Bottom bar timeline spans the union of all loaded flight windows
- [ ] Pilot list in right sidebar: colour swatch, name (from IGC `HFPLT`/`HFGTY`), live altitude
- [ ] **Active pilot** concept: one pilot is selected; bottom bar charts show that pilot's data
      — click sidebar row to switch
- [ ] Position sphere per pilot (small coloured sphere at current GPS fix for the clock time)
- [ ] `CSS2DObject` name tag above each pilot sphere (visible when zoomed in)
- [ ] Drag multiple IGC files in one drop to load them all at once

**Done when:** Drop five IGC files and see five coloured tracks; sidebar shows pilot
list; charts update when you click a different pilot.

---

## Phase 6 — Playback Animation + Time Trail Shader

**Goal:** Tracks animate over time with a fading trail effect.

### Steps
- [ ] Add `time` attribute (seconds from flight start) to each vertex in the track geometry
- [ ] Write TSL node shader for time-based alpha fade:
  - `vertexTime` attribute per point
  - `uniform float currentTime`
  - Alpha = 1.0 for the trailing 60 s window, linear fade for older, 0.0 for future
- [ ] Pilot sphere position interpolated between adjacent B-record fixes each frame
- [ ] Playback advances `currentTime` automatically when playing (respects speed multiplier)
- [ ] On mobile: use `Line2` (fat lines, no shader) instead of `TubeGeometry` to save fill rate

**Done when:** Tracks animate correctly, trail fades behind pilots, seeking jumps the
animation to the right position.

---

## Phase 7 — Camera Modes

**Goal:** Three distinct camera behaviours selectable by the user.

### Steps
- [ ] **Free orbit** (already working) — confirm touch gestures on mobile
- [ ] **Follow pilot:**
  - Disable GlobeControls while active
  - Each frame: compute position behind/above pilot heading vector
  - Smooth lerp camera position and lookAt toward pilot
  - Activate by clicking pilot name in sidebar or name tag in 3D view
- [ ] **Cinematic:**
  - Compute centroid of all active pilot positions at current time
  - Compute bounding sphere radius; pull camera back as radius grows
  - Slow auto-orbit around centroid
- [ ] Camera mode toggle buttons (top-right, desktop and mobile)
- [ ] Switching modes has no jarring jump (interpolate over 0.5 s)

**Done when:** All three modes work; switching is smooth; mobile defaults to follow
mode when a pilot is selected.

---

## Phase 8 — Mobile Polish + Adaptive Quality

**Goal:** Smooth experience on mid-range mobile hardware.

### Steps
- [ ] FPS monitor: if < 30 fps sustained for 3 s, reduce tile LOD and track segment count
- [ ] Verify pinch-to-zoom and pan feel natural (may need touch sensitivity tuning)
- [ ] Test on iOS Safari and Android Chrome
- [ ] Ensure no layout shift when bottom bar expands

**Done when:** Component is usable on a mid-range phone without frame drops.

---

## Phase 9 — Astro Integration + Export

**Goal:** Component is packaged cleanly for use in other Astro projects.

### Steps
- [ ] Document props in component JSDoc
- [ ] Confirm `client:only` island works correctly (no SSR errors)
- [ ] Add a demo Astro page with sample IGC files
- [ ] Verify Google API key is not bundled (env var pattern)
- [ ] README with setup instructions, API key config, prop reference

**Done when:** Copy the component into another Astro project and it works.

---

## Dependency Reference

```bash
npm install three 3d-tiles-renderer @takram/three-geospatial \
  @takram/three-atmosphere suncalc postprocessing

npm install -D @types/three @types/suncalc
```

Google Maps Platform: enable **Map Tiles API** + **Elevation API** in Google Cloud Console.

---

## Current Status

- [x] Phase 1 — Scaffold, globe, drag-drop track, camera fly-to, compass
- [x] Phase 2 — WebGPU renderer, atmosphere, CSM shadows, post-processing pipeline
- [x] Phase 3 — IGC time parsing + single-pilot data model
- [x] Phase 4 — Timeline UI (bottom bar + charts + desktop sidebar)
- [ ] Phase 5 — Multi-pilot support
- [ ] Phase 6 — Playback animation + time trail shader
- [ ] Phase 7 — Camera modes
- [ ] Phase 8 — Mobile polish + adaptive quality
- [ ] Phase 9 — Astro integration + export
