# SmoothOperator — Amsterdam Canal Route Planner

A web-based operational planning tool for Amsterdam's canals: click points on the map to get a canal-only route (Dijkstra shortest path, respecting one-way canals and per-segment speed limits), then layer on docking locations, bridges, public toilets, and live fairway closures around that route.

## Features

- **Canal-only routing**: routes are built exclusively from navigable canal geometry, snapped to the nearest canal edge and never bypassing a waypoint — no road/land fallback.
- **Route distance & time**: computed from the actual canal network's `speed_kmh` per segment.
- **Live GPS tracking**: shows your position and remaining distance/time along the planned route as you move.
- **Map layers** (toggle panel, top-right): docking locations, bridges, public toilets, and live construction/closures — each as clickable icons with a popup, not a search box.
- **Live fairway restrictions**: closures and restrictions are pulled from Rijkswaterstaat (via the public GrachtAlert sync) every 60 seconds and automatically block affected canal segments, rerouting any active route around them.

## Getting Started

```bash
cd grachtensite
python3 server_api.py
```
Then open `http://localhost:8000`. Run it through this local server rather than opening `index.html` directly — the app needs to fetch local GeoJSON files, which browsers block over `file://`.

## Map Libraries Used

- **Leaflet** — the map itself, markers, and routing overlay
- **MapLibre GL JS** — loaded but not yet wired up (see `initMapLibreMap()` in `script.js`)
- **OpenStreetMap** tiles (via CartoDB Voyager)

## File Structure

```
grachtensite/
├── index.html              # Main HTML file
├── script.js               # Map init, canal graph, Dijkstra routing, GPS tracking
├── ui_controls.js          # Feature toggle panel + route info readout
├── feature_layer_bridge.js # Wires the docking layer into the feature panel
├── live_routing.js         # Polls live fairway restrictions, blocks/reroutes
├── bridge_search.js        # Bridges layer (static data/bridges.geojson)
├── toilet_search.js        # Public toilets layer (static data/toilets.geojson)
├── styles.css, ui_controls.css
├── server_api.py           # Local dev server + /api/obstructions* endpoints
├── obstructions.py         # Local obstruction store
├── live_rws_feed.py        # Live fairway-notice fetch/normalize
├── tools/                  # Scripts to regenerate the static data/ files
└── data/                   # Static GeoJSON: canals, docks, bridges, toilets
```

See `CLAUDE.md` for the full architecture, data provenance, and known limitations.

## Customization

### Changing the Map Center
Edit the `AMSTERDAM_COORDS` constant in `script.js`:
```javascript
const AMSTERDAM_COORDS = [52.3676, 4.9041]; // [latitude, longitude]
```

### Refreshing bridge/toilet data
```bash
python3 tools/refresh_bridges.py
python3 tools/refresh_toilets.py
```

## Browser Support

Works in all modern browsers that support ES6+ JavaScript and the Geolocation API (for live GPS tracking).
