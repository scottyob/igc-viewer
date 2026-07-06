# igc-viewer

3D flight-track viewer for IGC files, Google Photorealistic 3D Tiles, Three.js WebGPU, and optional waypoint/place-of-interest overlays.

## Requirements

- Node 22.12 or newer for local development/builds.
- A browser with WebGPU support.
- A Google Maps Platform API key with the Map Tiles API enabled.
- Track and landmark URLs must be same-origin or CORS-enabled.

## Install

```sh
npm install igc-viewer three
```

Astro users should already have `astro` installed. Other bundlers must be able to import TypeScript source from package exports.

## Astro Usage

```astro
---
import IGCViewer from 'igc-viewer/astro';

const tracks = [
  { url: '/tracks/task-01.igc', label: 'Task 01' },
  { url: '/tracks/task-02.igc', label: 'Task 02' },
];

const landmarks = [
  { url: '/places/waypoints.cup', label: 'Waypoints' },
  { url: '/places/landouts.wpt', label: 'Landouts' },
];
---

<div style="height: 100vh">
  <IGCViewer
    googleApiKey={import.meta.env.PUBLIC_GOOGLE_MAPS_API_KEY}
    tracks={tracks}
    landmarks={landmarks}
  />
</div>
```

## Web Component Usage

Importing the package defines `<igc-viewer>`.

```ts
import 'igc-viewer';
```

```html
<igc-viewer
  google-api-key="YOUR_GOOGLE_MAPS_API_KEY"
  tracks='[{"url":"/tracks/task-01.igc","label":"Task 01"}]'
  landmarks='[{"url":"/places/waypoints.cup","label":"Waypoints"}]'
></igc-viewer>
```

Give the element or a parent container an explicit size:

```css
igc-viewer {
  display: block;
  width: 100%;
  height: 100vh;
}
```

## Data Inputs

`tracks` is an array of IGC files:

```ts
type TrackEntry = {
  url: string;
  label: string;
};
```

`landmarks` is an array of place/waypoint files. `.cup` and `.wpt` are supported.

```ts
type LandmarkEntry = {
  url: string;
  label?: string;
};
```

Users can also drag and drop `.igc`, `.cup`, and `.wpt` files into the viewer at runtime.

## Local Development

```sh
npm install
astro dev --background
npm run build
```

Set `PUBLIC_GOOGLE_MAPS_API_KEY` in `.env` for the demo page.

## Package Entry Points

- `igc-viewer`: registers the framework-agnostic web component.
- `igc-viewer/astro`: Astro wrapper component.
- `igc-viewer/types`: exported TypeScript data types.
