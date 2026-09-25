# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An interactive web-based canal route planner for Amsterdam, built for professional waterway operators. Users click points on a map; the app snaps them to the nearest navigable canal and finds the shortest path using Dijkstra's algorithm. Travel time is calculated per-segment using speed properties on each canal feature. Around that core route, the app surfaces the operational context a real operator needs: docking locations, bridges, public toilets, and live fairway closures/restrictions.

## Running the App

```bash
cd grachtensite
python3 server_api.py
# Open http://localhost:8000
```

`server_api.py` is the only server in this repo (a previous `server.py` with a different, narrower set of routes was removed as dead code — see "2026-09-24 cleanup" below). It's a minimal Python HTTP server built on `http.server` (stdlib only, no `pip install` needed) that:
- serves every file in this directory statically (including everything under `data/`), with CORS headers so the frontend can fetch local GeoJSON, and
- exposes `/api/obstructions`, `/api/obstructions/all`, and `/api/obstructions/live` for closures/restrictions (see "Live obstructions" below).

On Windows, `start_server.bat` does the same thing.

## Data Setup

The frontend reads static GeoJSON files from `grachtensite/data/`, all fetched directly by the browser (no backend round-trip):

- `Amsterdamcanals.geojson` — canal network with `speed_kmh` and `oneway` properties. Only features with `fclass == "canal"` are used for routing.
- `rondvaartopenafstapplekken.geojson` — docking/boarding locations (loaded by `ui_controls.js`)
- `bridges.geojson` — bridge locations + type (fixed/movable) (loaded by `bridge_search.js`)
- `toilets.geojson` — public toilet locations (loaded by `toilet_search.js`)
- `obstructions.json` — local obstruction store used by the `/api/obstructions*` CRUD endpoints (auto-created by `obstructions.py` if missing)

If the canal/docking data needs to be regenerated from raw OSM data:
```bash
cd grachtensite
python3 filter_canals.py          # filters raw OSM data to Amsterdam bounding box
python3 update_amstel_speed.py    # patches speed_kmh on Amstel canal segments
python3 create_routing_graph.py   # builds a NetworkX graph (used for testing; output not consumed by frontend)
```
Python dependencies for those three: `shapely`, `networkx`, `geopandas`, `fuzzywuzzy`.

If `bridges.geojson` / `toilets.geojson` need to be refreshed from their official sources:
```bash
cd grachtensite
python3 tools/refresh_bridges.py   # Gemeente Amsterdam open data (civieleconstructies/brug)
python3 tools/refresh_toilets.py   # Gemeente Amsterdam open data (Openbare toiletten)
```
Both are stdlib-only and safe to re-run; they overwrite the files in `data/`. Bridge/toilet locations are physical infrastructure that essentially never moves, which is why these are baked static files instead of a live fetch — see "2026-09-24 cleanup" for why that matters.

## Architecture

Routing logic lives entirely in the browser (`grachtensite/script.js`, ~580 lines). There is no routing backend.

**Startup flow:**
1. `initLeafletMap()` initialises the Leaflet map and wires up click handlers, and calls `initGPS()` to attach the GPS button's click listener.
2. `loadCanalRoutes()` fetches `Amsterdamcanals.geojson`, then calls `buildCanalGraph()` — converts GeoJSON LineStrings into an in-memory graph: `{ nodes: [{lat, lng}], edges: [{from, to, distance, segment, speed_kmh}] }`.
3. `ui_controls.js` builds the feature control panel (top-right) and loads the docking-locations layer; `bridge_search.js` and `toilet_search.js` each load their own static GeoJSON layer independently; `live_routing.js` starts polling `/api/obstructions/live` every 60s.

**User interaction → route:**
1. Map click → `snapToNearestCanal()` → snaps directly onto the nearest routing-graph edge (not just the nearest node), so a click near the middle of a long canal segment still lands accurately.
2. When ≥2 points exist → `makeRoutingGraphWithWaypoints()` splits the canal graph at each snapped waypoint (inserting a virtual node and rebuilding just the affected edges) so a route can never bypass a waypoint by cutting across the unsplit original edge, then `dijkstraShortestPath()` runs between consecutive waypoints.
3. `drawRoute()` renders a red polyline; `updateRouteInfo()` populates the sidebar with distance and `distance / speed_kmh * 60` travel time.

One-way constraints come from the `oneway` property on GeoJSON features; variable speeds come from `speed_kmh`. Multi-stop routes concatenate shortest-path segments between consecutive waypoints. Only `fclass == "canal"` features ever enter the routing graph — there is no road/land fallback, so a route can never leave the water.

**Map layers panel** (`ui_controls.js` + `feature_layer_bridge.js`): a single toggle panel in the top-right controls four overlays — Docking locations, Bridges, Public toilets, Construction & closures — each rendered as clickable icons with a popup, not a search box. Toggling a layer on/off dispatches a `smoothoperator:<name>` event that the relevant script listens for. Each layer has its own colored badge icon (`makeBadgeIcon()` in `ui_controls.js`, exposed as `window.smoothOperatorMakeBadgeIcon`, used by `bridge_search.js`, `toilet_search.js`, and `live_routing.js`): ⚓ teal for docking, 🌉 purple for bridges, 🚻 green for toilets, ⚠ orange for closures — previously docking and toilets both used Leaflet's default blue pin and were indistinguishable on the map.

**Demo routes** (`demo_routes.js`): one-click preset routes (e.g. Anne Frank House → Rijksmuseum) for live demos, so presenting doesn't depend on clicking two precise points on a thin canal line in front of an audience. Each preset pair was individually verified (see the comment in the file) to snap onto the canal network and produce an actual routable path — several tried-and-rejected candidates near well-known landmarks failed to route because of one-way restrictions or network gaps in the dense old-center area, so don't swap these coordinates for others without re-verifying routability the same way.

**Named start/destination search** (`route_search.js`): a "Plan a trip" panel with Start/Destination text fields, as an alternative to clicking two points on the map. Typing searches this app's own data first (docking spot, bridge and toilet names — instant, no network call), then falls back to OpenStreetMap's public Nominatim geocoder scoped to an Amsterdam bounding box for a general address or landmark not already in those datasets; results are merged and deduplicated, each tagged with its source. Picking a suggestion places it through the same `window.smoothOperatorRouting.addWaypoint()` path a real map click uses, so it snaps to the canal network and draws the route identically. Whichever of the two fields is filled gets re-placed in order on every change, so this UI always plans a direct two-point trip — multi-stop routes still need clicking extra points on the map. Nominatim's public endpoint is a shared, rate-limited resource meant for light interactive use; fine for a demo, but a production deployment with real traffic would need a self-hosted or paid geocoder instead.

**Boat profile + route compatibility** (`route_compatibility.js`): lets the operator enter their boat's length/beam/draft/air-draft (saved in `localStorage`, since this is a self-hosted static site, not a Claude-hosted artifact preview where localStorage is restricted). On every route update it scans the route against `data/bridges.geojson` and reports how many movable vs. fixed bridges lie within ~20m of the route. It deliberately never claims a route "fits" the boat — clearance dimensions aren't in the dataset (see "Known limitations") — and deliberately skips canal-width/beam checking, since only 11 of 1086 canal segments in `Amsterdamcanals.geojson` carry a real (non-zero) `width` value and `buildCanalGraph()` doesn't currently carry `width` through to graph edges; that's not enough real coverage to justify a check that would look like it means something when it mostly wouldn't.

**Live obstructions** (`live_routing.js` + `server_api.py` + `live_rws_feed.py`): polls `/api/obstructions/live` every 60s, which proxies Rijkswaterstaat/Vaarweginformatie fairway notices via the public GrachtAlert sync (`api.grachtalert.nl`). Notices with geometry are matched against canal graph edges (point notices use a `block_radius_m`, default 45m; line/polygon notices block edges they intersect or come close to); matched edges get `blocked = true` and `distance = Infinity` so Dijkstra routes around them automatically, and any currently-drawn route is recalculated. This is the one layer that's genuinely live — closures change day to day, unlike bridges/toilets/docks.

**Live GPS tracking** (`script.js`, `initGPS`/`startGPSTracking`/`stopGPS`): the GPS button starts `navigator.geolocation.watchPosition`, draws a live position marker and a dashed trail of the boat's actual path, and feeds each position into `getRemainingFromPosition()` (distance/time remaining along the *planned* route, or "off route" if too far from it). The result is shown in a "Remaining (live GPS)" row in the route info panel. Reset also stops GPS tracking.

**MapLibre GL JS** is loaded via CDN but not wired up — there is a placeholder `initMapLibreMap()` function if a vector-tile layer is ever needed.

## Known limitations (intentionally not faked)

- **Bridge clearance (width/height)**: Gemeente Amsterdam's open bridge dataset gives location, type (fixed vs. movable) and material, but not clearance dimensions. Rather than invent numbers, the bridge popup says so explicitly and links to the official Rijkswaterstaat Vaarweginformatie bridge map. This is exactly the gap the project proposal names as future work (boat-aware routing needs real width/height/draft data); closing it needs either a licensed RWS dataset or manual survey, not a quick fix.
- **Toilet opening-hours text**: sourced verbatim (lightly translated) from the municipality's own free-text fields; some entries retain Dutch phrasing that a small dictionary-based translation didn't catch.

## 2026-09-24 pitch-readiness pass

A second pass the same day, on top of the cleanup below, adding demo/pitch-facing features (aimed at a business-idea pitch, so prioritizing things a live audience actually notices, without ever fabricating data):

- **Live-obstructions fetch hardening**: `refreshLiveRestrictions()` in `live_routing.js` now wraps its fetch in a 10-second `AbortController` timeout, so a slow/hung upstream feed degrades to a clear "temporarily unavailable" status instead of hanging the panel indefinitely — important for a live demo on unfamiliar wifi.
- **Demo routes** — see above.
- **Boat profile + route compatibility panel** — see above.
- **Distinct layer icons** — see "Map layers panel" above.
- **Named start/destination search** — see "Named start/destination search" above; added after the previous pass since clicking two precise points on the map turned out to be the actual question a boater would ask ("how do I even tell it where I'm going?").

## 2026-09-24 cleanup

A pass fixing several features that looked done but weren't (see the project's own "Vibe Coding Development Log" for how this kind of gap kept recurring):

- **Bridges and public toilets were completely broken in production.** Both called live backend endpoints (`/api/bridges`, `/api/toilets/nearby`) that fetched from `overpass-api.de` on every request; that host times out from this app's hosting provider (confirmed: both endpoints returned HTTP 502 in production). Both are now static files in `data/`, fetched directly by the browser exactly like the docking-locations layer already did, refreshed via `tools/refresh_bridges.py` / `tools/refresh_toilets.py` instead of on every page load. The toilets source is now Gemeente Amsterdam's official open dataset (the old code pointed at a URL that 404s — `THEMA=buurtvoorzieningen` should have been `THEMA=openbare_toiletten`); bridges now come from `civieleconstructies/brug` since the RWS HTML table the old scraper parsed now serves a 535-page PDF instead.
- **The GPS button did nothing.** `initGPS`/`stopGPS` were called but never defined, and nothing was wired to `#gps-btn`. Implemented (see "Live GPS tracking" above) — this also finally puts the already-written but previously-unused `getRemainingFromPosition()` to work.
- **Dutch UI strings in the obstructions panel** (`live_routing.js`) were translated to English, matching the rest of the interface (the dev log notes this was already redirected once for the rest of the UI, but the live-notices panel was added afterwards and missed it).
- **Dead code removed**: `obstructions.js` / `obstructions_integration.js` (superseded by `live_routing.js` + `feature_layer_bridge.js`, not linked from `index.html`), `index_live.html` / `index_integrated.html` (broken alternate entry points referencing the removed files/routes), `server.py` / `bridge_search.py` / `toilet_search.py` (superseded by `server_api.py` + `tools/`), an empty placeholder `amsterdam_brug_peilmerken.csv`, and an unused `leaflet-polylinedecorator` `<script>` tag that 404'd on every page load (the API it loads is never called anywhere in the codebase).
- **Docking popups sometimes showed a broken-image icon**: the docking dataset was originally exported from Google My Maps, whose `<img>` hotlinks (`mymaps.usercontent.google.com`) are session-scoped and don't load outside the My Maps viewer. `sanitizeDescription()` in `ui_controls.js` now strips those specifically.

Not touched in this pass (outside `grachtensite/`, not part of the deployed app, so lower risk/benefit to change without asking first): the Jupyter notebooks, the `.kml` file, `Grachtenproject/`, `geojsons/`, and `RoutePlanner-main.zip` at the repo root. `RoutePlanner-main.zip` in particular looks like an old version of this same project committed by accident — worth deleting if nobody's relying on it, but that's a call for the team rather than a silent cleanup.
