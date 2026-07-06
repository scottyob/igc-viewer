# IGC Viewer — Component Specification

A reusable Astro island component for previewing multiple paragliding/hang gliding IGC
track logs in photorealistic 3D space, with time-based playback.

---

## Tech Stack

| Concern                  | Library                                        |
|--------------------------|------------------------------------------------|
| 3D rendering             | `three`                                        |
| Photorealistic world     | `3d-tiles-renderer` + Google Photorealistic 3D Tiles |
| Globe math / atmosphere  | `@takram/three-geospatial` + `@takram/three-geospatial-atmosphere` |
| Sun position             | `suncalc`                                      |
| IGC parsing              | `igc-parser`                                   |
| 3D HTML labels           | Three.js `CSS2DRenderer`                       |
| Post-processing          | `postprocessing` (bloom on pilot position tips)|
| Framework                | Vanilla TypeScript (`client:only` Astro island)|

---

## Component API

```ts
<IGCViewer
  googleApiKey="YOUR_GOOGLE_MAPS_PLATFORM_KEY"
  tracks={[
    { url: "/flights/scott.igc", label: "Scott" },
    { url: "/flights/jane.igc",  label: "Jane" }
  ]}
/>
```

### Props

| Prop           | Type                              | Required | Description                                      |
|----------------|-----------------------------------|----------|--------------------------------------------------|
| `googleApiKey` | `string`                          | Yes      | Google Maps Platform key with Map Tiles API enabled |
| `tracks`       | `{ url: string, label: string }[]`| No       | Pre-loaded IGC files. Merges with any uploaded at runtime |

### Runtime input
File drag-drop or file picker lets users add IGC files at runtime. These merge into
the same track list as prop-supplied tracks.

### Scale
Designed for 6–30 simultaneous tracks. Degrades gracefully beyond that via adaptive
quality (see below).

---

## Atmospheric Rendering

IGC `B` records carry UTC timestamps. The component:

1. Extracts flight date + time + lat/lon from the IGC file
2. Uses `suncalc` to compute real sun azimuth and altitude for that moment
3. Passes the sun direction vector into `@takram/three-geospatial-atmosphere`

The sky, lighting, and shadow angles match the actual conditions of the flight.
Sun position advances in real time with the playback clock — a sunset flight
renders with golden-hour atmosphere that shifts as playback progresses.

**Risk:** `@takram/three-geospatial-atmosphere` night sky / stars needs verification.
A fallback `THREE.Points` starfield will be implemented if the library does not
handle the night case.

---

## Track Rendering

### Style
- 3D tubes with dual-layer colouring:
  - Per-pilot base colour (distinct, for identification across tracks)
  - Altitude gradient modulating brightness (warm amber at low altitude → cool blue/white at high)
- Current pilot position: glowing sphere with bloom post-processing effect
- Floating 3D label anchored above each pilot's sphere via `CSS2DRenderer`
  (HTML-based, stays readable at all zoom levels)

### Time trail (fade effect)
Implemented as a custom vertex shader — no per-frame geometry rebuild.

- Each tube vertex carries a `time` attribute (seconds since flight start)
- Fragment shader computes `alpha` based on `currentTime - vertexTime`:
  - Within last 60 seconds → full opacity
  - Older → linear fade to transparent
  - After `currentTime` → invisible
- Only the current-position sphere is rendered for vertices ahead of `currentTime`

### Performance
- Typical paragliding flight: 1 Hz × 5 hrs ≈ 18,000 points per track
- 30 tracks ≈ 540,000 points total
- Douglas-Peucker simplification at parse time (tolerance tuned to preserve soaring
  detail — thermals, glide transitions)
- Shader-driven fade means no geometry mutation per frame

---

## Playback System

- Global UTC clock, synced across all tracks
- Atmosphere sun position updates with clock
- **Controls:** Play / Pause / Speed (1×, 5×, 10×, 30×, 100×)
- **Scrubber:** seek to any point; displays local time-of-day for the flight
- Tracks not yet started are fully hidden
- Finished tracks show full faded history (acts as a breadcrumb of where they flew)

---

## Camera Modes

| Mode          | Behaviour                                                                 |
|---------------|---------------------------------------------------------------------------|
| Free orbit    | OrbitControls (mouse + touch). Default mode.                             |
| Follow pilot  | Camera trails behind/above selected pilot, smooth lerp. Tap label to enter. |
| Cinematic     | Auto-frames centroid of all active pilots; pulls back as the group spreads |

- On load: auto-fit camera to bounding box of all tracks
- Follow mode is the recommended default entry on mobile

---

## UI / HUD

### Desktop layout
- **Left panel:** pilot list — colour swatch, name, live altitude during playback
- **Bottom bar:** time scrubber + playback controls (play/pause, speed)
- **Top-right:** camera mode toggle buttons

### Mobile layout
- **Bottom sheet** (swipe up to expand): pilot list
- **Persistent bottom strip:** scrubber + play/pause + speed cycle button
- **Tap a floating 3D label** → enters follow mode for that pilot
- Touch gestures: pinch-to-zoom, two-finger pan, one-finger rotate (OrbitControls)
- All touch targets minimum 44 × 44 px

---

## Adaptive Quality

| Context                | Track rendering          | Tile LOD  | Bloom |
|------------------------|--------------------------|-----------|-------|
| Desktop                | Full tubes               | High      | Yes   |
| Mobile (detected)      | `Line2` fat lines        | Medium    | No    |
| Low FPS (< 30 fps)     | Lines + reduced segments | Reduced   | No    |

Device detection: `navigator.maxTouchPoints > 0` as initial signal; FPS monitor
adjusts dynamically after load.

---

## Known Implementation Risks

| Risk                                                      | Mitigation                                      |
|-----------------------------------------------------------|-------------------------------------------------|
| `@takram` atmosphere night/stars handling unknown         | Fallback `THREE.Points` starfield               |
| CSS2DRenderer labels conflict with bloom post-processing  | Render labels on a separate pass / above canvas |
| Google Tiles rural coverage may be low-res               | Acceptable — terrain mesh still grounds the scene |
| Tube geometry expensive for 30 tracks on first load      | Simplify at parse time; show load progress      |
