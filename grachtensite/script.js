// Map configuration
const AMSTERDAM_COORDS = [52.3676, 4.9041];
const ZOOM_LEVEL = 13;
const GPS_ENABLED = true;
const OFF_ROUTE_THRESHOLD_M = 50;
const MAX_WAYPOINT_SNAP_DISTANCE_M = 75;
const CARTO_API_KEY = "cb1_3oo5_1_76722dcb63ab79f7aeb9c12c";

// Only features explicitly classified as navigable canals are allowed into
// the routing graph. Nothing else can become a route edge.
const NAVIGABLE_FCLASSES = new Set(["canal"]);

let canalSegments = [];
let currentRoutePath = [];
let currentRouteTotal = { time: 0, distance: 0 };
let gpsWatchId = null;
let gpsMarker = null;
let gpsActive = false;
let drivenLine = null;
let canalGraph = { nodes: [], edges: [], adjacency: [] };
let routeLine = null;
let canalGraphReady = false;
let canalGraphError = null;
let canalGraphPromise = null;

function isNavigableCanal(feature) {
    const fclass = String(feature?.properties?.fclass || "").toLowerCase();
    return NAVIGABLE_FCLASSES.has(fclass);
}

function getNodeIndex(nodes, lat, lng) {
    const tolerance = 0.0000015;
    for (let i = 0; i < nodes.length; i++) {
        if (Math.abs(nodes[i].lat - lat) <= tolerance && Math.abs(nodes[i].lng - lng) <= tolerance) return i;
    }
    nodes.push({ lat, lng });
    return nodes.length - 1;
}

function addGraphEdge(edges, from, to, distance, segment, speed_kmh, blocked, baseEdgeId) {
    edges.push({ from, to, distance, segment, speed_kmh, blocked: Boolean(blocked), baseEdgeId });
}

function buildCanalGraph(features) {
    const nodes = [];
    const edges = [];

    features.filter(isNavigableCanal).forEach(feature => {
        const geometry = feature.geometry;
        const properties = feature.properties || {};
        const speed = Number(properties.speed_kmh) > 0 ? Number(properties.speed_kmh) : 6;
        const onewayValue = String(properties.oneway ?? "").trim().toLowerCase();
        const isBidirectional = onewayValue === "" || onewayValue === "no" || onewayValue === "false" || onewayValue === "0";
        const lines = geometry?.type === "MultiLineString"
            ? geometry.coordinates
            : geometry?.type === "LineString"
                ? [geometry.coordinates]
                : [];

        lines.forEach(line => {
            for (let i = 0; i < line.length - 1; i++) {
                const a = { lat: line[i][1], lng: line[i][0] };
                const b = { lat: line[i + 1][1], lng: line[i + 1][0] };
                const ia = getNodeIndex(nodes, a.lat, a.lng);
                const ib = getNodeIndex(nodes, b.lat, b.lng);
                const dist = latLngDistance(a, b);
                if (!dist || ia === ib) continue;

                // Both directions of the same physical segment share baseEdgeId.
                // That lets waypoint insertion split the physical segment safely.
                const baseEdgeId = edges.length;
                addGraphEdge(edges, ia, ib, dist, [a, b], speed, false, baseEdgeId);
                if (isBidirectional) {
                    addGraphEdge(edges, ib, ia, dist, [b, a], speed, false, baseEdgeId);
                }
            }
        });
    });

    canalGraph = { nodes, edges, adjacency: buildAdjacency(nodes.length, edges) };
    canalGraphReady = nodes.length > 0 && edges.length > 0;
    return canalGraph;
}

function buildAdjacency(nodeCount, edges) {
    const adjacency = Array.from({ length: nodeCount }, () => []);
    edges.forEach((edge, edgeIndex) => {
        if (edge.from >= 0 && edge.from < nodeCount) adjacency[edge.from].push(edgeIndex);
    });
    return adjacency;
}

function findClosestNode(latlng) {
    let min = Infinity, idx = -1;
    canalGraph.nodes.forEach((n, i) => {
        const d = latLngDistance(latlng, n);
        if (d < min) { min = d; idx = i; }
    });
    return idx;
}

function latLngDistance(a, b) {
    const r = Math.PI / 180, R = 6371000;
    const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const la = a.lat * r, lb = b.lat * r;
    const v = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(la) * Math.cos(lb);
    return R * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(1 - v));
}

function closestPointOnSegment(p, a, b) {
    const dx = b.lng - a.lng, dy = b.lat - a.lat;
    if (dx === 0 && dy === 0) return { lat: a.lat, lng: a.lng, t: 0 };
    const tRaw = ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy);
    const t = Math.max(0, Math.min(1, tRaw));
    return { lat: a.lat + t * dy, lng: a.lng + t * dx, t };
}

// Snap directly to a graph edge. This means a waypoint can only ever land on
// geometry that is itself part of the navigable routing network.
function snapToNearestCanal(latlng) {
    let best = null;

    canalGraph.edges.forEach((edge, edgeIndex) => {
        const a = edge.segment[0];
        const b = edge.segment[1];
        const projected = closestPointOnSegment(latlng, a, b);
        const point = { lat: projected.lat, lng: projected.lng };
        const distance = latLngDistance(latlng, point);

        if (!best || distance < best.distance) {
            best = {
                latlng: point,
                distance,
                edgeIndex,
                baseEdgeId: edge.baseEdgeId,
                t: projected.t
            };
        }
    });

    if (!best || best.distance > MAX_WAYPOINT_SNAP_DISTANCE_M) return null;
    return best;
}

class MinHeap {
    constructor() { this.items = []; }

    push(item) {
        const a = this.items;
        a.push(item);
        let i = a.length - 1;
        while (i > 0) {
            const p = Math.floor((i - 1) / 2);
            if (a[p].distance <= a[i].distance) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }

    pop() {
        const a = this.items;
        if (!a.length) return null;
        const root = a[0];
        const last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            while (true) {
                const left = i * 2 + 1;
                const right = left + 1;
                let smallest = i;
                if (left < a.length && a[left].distance < a[smallest].distance) smallest = left;
                if (right < a.length && a[right].distance < a[smallest].distance) smallest = right;
                if (smallest === i) break;
                [a[i], a[smallest]] = [a[smallest], a[i]];
                i = smallest;
            }
        }
        return root;
    }
}

function makeRoutingGraphWithWaypoints(snappedWaypoints) {
    const nodes = canalGraph.nodes.map(n => ({ lat: n.lat, lng: n.lng }));
    const edges = [];
    const waypointNodes = [];
    const groups = new Map();

    snappedWaypoints.forEach((snap, waypointIndex) => {
        const sourceEdge = canalGraph.edges[snap.edgeIndex];
        if (!sourceEdge) return;

        const nodeId = nodes.length;
        nodes.push({ lat: snap.latlng.lat, lng: snap.latlng.lng, virtual: true });
        const item = {
            waypointIndex,
            nodeId,
            edgeIndex: snap.edgeIndex,
            baseEdgeId: sourceEdge.baseEdgeId,
            t: snap.t,
            point: snap.latlng,
            startNode: sourceEdge.from,
            endNode: sourceEdge.to,
            startPoint: sourceEdge.segment[0],
            endPoint: sourceEdge.segment[1],
            speed_kmh: sourceEdge.speed_kmh
        };
        waypointNodes.push(item);
        const key = String(sourceEdge.baseEdgeId);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    });

    const splitBaseIds = new Set(waypointNodes.map(w => w.baseEdgeId));

    // Preserve every untouched original canal edge exactly as it exists in the
    // base graph. Affected segments are rebuilt below so a route cannot bypass
    // a waypoint using the unsplit original edge.
    canalGraph.edges.forEach(edge => {
        if (!splitBaseIds.has(edge.baseEdgeId)) {
            edges.push({ ...edge, segment: edge.segment.map(p => ({ ...p })) });
        }
    });

    groups.forEach(group => {
        // snapToNearestCanal always selects the forward edge first when the
        // forward/reverse geometries overlap, so t is measured consistently.
        group.sort((a, b) => a.t - b.t);
        const first = canalGraph.edges.find(e => e.baseEdgeId === group[0].baseEdgeId);
        if (!first) return;

        const forward = canalGraph.edges.find(e => e.baseEdgeId === group[0].baseEdgeId && e.from === first.from && e.to === first.to);
        const reverse = canalGraph.edges.find(e => e.baseEdgeId === group[0].baseEdgeId && e.from === first.to && e.to === first.from);
        const ordered = [
            { node: first.from, point: first.segment[0] },
            ...group.map(w => ({ node: w.nodeId, point: w.point })),
            { node: first.to, point: first.segment[1] }
        ];

        for (let i = 0; i < ordered.length - 1; i++) {
            const a = ordered[i], b = ordered[i + 1];
            const distance = latLngDistance(a.point, b.point);
            if (!distance) continue;
            const speed = first.speed_kmh || 6;

            if (forward) {
                edges.push({ from: a.node, to: b.node, distance, segment: [a.point, b.point], speed_kmh: speed, blocked: Boolean(forward.blocked), baseEdgeId: first.baseEdgeId });
            }
            if (reverse) {
                edges.push({ from: b.node, to: a.node, distance, segment: [b.point, a.point], speed_kmh: speed, blocked: Boolean(reverse.blocked), baseEdgeId: first.baseEdgeId });
            }
        }
    });

    return { nodes, edges, adjacency: buildAdjacency(nodes.length, edges), waypointNodes };
}

function dijkstraShortestPath(startIdx, endIdx, graph = canalGraph) {
    const n = graph.nodes.length;
    if (startIdx < 0 || endIdx < 0 || startIdx >= n || endIdx >= n || !n) {
        return { path: [], totalDistance: Infinity, totalTime: 0 };
    }
    if (startIdx === endIdx) return { path: [], totalDistance: 0, totalTime: 0 };

    const distance = Array(n).fill(Infinity);
    const prev = Array(n).fill(null);
    const heap = new MinHeap();
    distance[startIdx] = 0;
    heap.push({ node: startIdx, distance: 0 });

    while (true) {
        const current = heap.pop();
        if (!current) break;
        if (current.distance !== distance[current.node]) continue;
        if (current.node === endIdx) break;

        const outgoing = graph.adjacency[current.node] || [];
        for (const edgeIndex of outgoing) {
            const edge = graph.edges[edgeIndex];
            if (edge.blocked || !Number.isFinite(edge.distance)) continue;
            const nextDistance = current.distance + edge.distance;
            if (nextDistance < distance[edge.to]) {
                distance[edge.to] = nextDistance;
                prev[edge.to] = { node: current.node, edge };
                heap.push({ node: edge.to, distance: nextDistance });
            }
        }
    }

    if (!Number.isFinite(distance[endIdx])) {
        return { path: [], totalDistance: Infinity, totalTime: 0 };
    }

    const path = [];
    let node = endIdx;
    let totalTime = 0;
    while (node !== startIdx) {
        const previous = prev[node];
        if (!previous) return { path: [], totalDistance: Infinity, totalTime: 0 };
        path.unshift(previous.edge);
        const edge = previous.edge;
        totalTime += (edge.distance / 1000) / (edge.speed_kmh || 6) * 60;
        node = previous.node;
    }

    return { path, totalDistance: distance[endIdx] / 1000, totalTime };
}

function drawRoute(map, path) {
    if (routeLine) map.removeLayer(routeLine);
    if (!path.length) return;

    const latlngs = [];
    path.forEach(edge => {
        const start = [edge.segment[0].lat, edge.segment[0].lng];
        const end = [edge.segment[1].lat, edge.segment[1].lng];
        if (!latlngs.length || latlngs[latlngs.length - 1][0] !== start[0] || latlngs[latlngs.length - 1][1] !== start[1]) {
            latlngs.push(start);
        }
        latlngs.push(end);
    });

    routeLine = L.polyline(latlngs, { color: "red", weight: 5, opacity: 0.9 }).addTo(map);
}

function updateRouteInfo(time, distance) {
    if (window.smoothOperatorUpdateRouteInfo) window.smoothOperatorUpdateRouteInfo(time, distance);
    window.dispatchEvent(new CustomEvent("smoothoperator:routeUpdated", { detail: { time, distance, path: currentRoutePath } }));
}

function setRouteStatus(message) {
    const status = document.getElementById("route-info-status");
    if (status) status.textContent = message;
}

document.addEventListener("DOMContentLoaded", function () {
    initLeafletMap();
    initMapLibreMap();
});

function initLeafletMap() {
    const leafletMap = L.map("map").setView(AMSTERDAM_COORDS, ZOOM_LEVEL);
    window.map = leafletMap;
    window.__smoothOperatorMap = leafletMap;
    L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(CARTO_API_KEY)}`, { attribution: "© OpenStreetMap contributors © CARTO", maxZoom: 19, subdomains: "abcd" }).addTo(leafletMap);

    canalGraphPromise = loadCanalRoutes(leafletMap, L.layerGroup());
    let selectedPoints = [];
    const markerLayer = L.layerGroup().addTo(leafletMap);
    const routePointIcon = L.icon({ iconUrl: "boat.png", iconSize: [44, 44], iconAnchor: [22, 44], popupAnchor: [0, -36] });

    // A boater looking at the map needs to see which pin is the start and
    // which is the destination without clicking each one -- so route markers
    // carry an always-visible label, not just a click-to-open popup.
    function labelForIndex(index, total) {
        if (index === 0) return "Start";
        if (index === total - 1) return "Destination";
        return `Stop ${index}`;
    }

    function rebuildMarkers() {
        markerLayer.clearLayers();
        return selectedPoints.map((point, idx) => {
            const label = labelForIndex(idx, selectedPoints.length);
            return L.marker(point.latlng, { icon: routePointIcon })
                .addTo(markerLayer)
                .bindTooltip(label, { permanent: true, direction: "top", offset: [0, -38], className: "so-point-label" })
                .bindPopup(label);
        });
    }

    async function drawFullRoute() {
        if (selectedPoints.length < 2) {
            if (routeLine) { leafletMap.removeLayer(routeLine); routeLine = null; }
            currentRoutePath = [];
            currentRouteTotal = { time: 0, distance: 0 };
            updateRouteInfo(0, 0);
            return;
        }
        if (!canalGraphReady) {
            try { await canalGraphPromise; } catch (_) {}
        }
        if (!canalGraphReady) {
            updateRouteInfo(0, 0);
            setRouteStatus("Canal routing data could not be loaded.");
            return;
        }

        const snappedWaypoints = selectedPoints.map(point => point.routingSnap);
        if (snappedWaypoints.some(snap => !snap)) {
            updateRouteInfo(0, 0);
            setRouteStatus("One or more waypoints are not on a navigable canal.");
            return;
        }

        const routingGraph = makeRoutingGraphWithWaypoints(snappedWaypoints);
        const waypointNodes = routingGraph.waypointNodes.sort((a, b) => a.waypointIndex - b.waypointIndex);
        let fullPath = [], totalDistance = 0, totalTime = 0;

        for (let i = 0; i < waypointNodes.length - 1; i++) {
            const startIdx = waypointNodes[i].nodeId;
            const endIdx = waypointNodes[i + 1].nodeId;
            const result = dijkstraShortestPath(startIdx, endIdx, routingGraph);

            if (!Number.isFinite(result.totalDistance)) {
                if (routeLine) { leafletMap.removeLayer(routeLine); routeLine = null; }
                currentRoutePath = [];
                currentRouteTotal = { time: 0, distance: 0 };
                updateRouteInfo(0, 0);
                setRouteStatus(`No navigable canal route found between points ${i + 1} and ${i + 2}.`);
                return;
            }

            fullPath = fullPath.concat(result.path);
            totalDistance += result.totalDistance;
            totalTime += result.totalTime;
        }

        currentRoutePath = fullPath;
        currentRouteTotal = { time: totalTime, distance: totalDistance };
        drawRoute(leafletMap, fullPath);
        updateRouteInfo(totalTime, totalDistance);
        setRouteStatus(`Canal route ready: ${totalDistance.toFixed(2)} km`);
    }

    async function addWaypoint(latlng) {
        if (!canalGraphReady) {
            setRouteStatus("Loading canal routing data…");
            try { await canalGraphPromise; } catch (_) {}
            if (!canalGraphReady) { setRouteStatus("Canal routing data could not be loaded."); return false; }
        }

        const routingSnap = snapToNearestCanal(latlng);
        if (!routingSnap) {
            setRouteStatus(`Click within ${MAX_WAYPOINT_SNAP_DISTANCE_M} m of a navigable canal.`);
            return false;
        }

        const snapped = routingSnap.latlng;
        const selectedPoint = { latlng: snapped, routingSnap };
        selectedPoints.push(selectedPoint);
        rebuildMarkers();
        setRouteStatus(`${labelForIndex(selectedPoints.length - 1, selectedPoints.length)} snapped ${Math.round(routingSnap.distance)} m to the canal.`);
        await drawFullRoute();
        return true;
    }

    function resetRoute() {
        selectedPoints = [];
        markerLayer.clearLayers();
        if (routeLine) { leafletMap.removeLayer(routeLine); routeLine = null; }
        currentRoutePath = [];
        currentRouteTotal = { time: 0, distance: 0 };
        if (GPS_ENABLED && typeof stopGPS === "function") stopGPS(leafletMap);
        updateRouteInfo(0, 0);
        setRouteStatus("");
    }

    leafletMap.on("click", e => addWaypoint(e.latlng));

    const resetBtn = document.getElementById("reset-route-btn");
    if (resetBtn) resetBtn.addEventListener("click", resetRoute);

    // Exposed so a "demo route" UI (or anything else) can place waypoints
    // programmatically through the exact same snap/route/draw path as a
    // real map click, rather than duplicating that logic.
    window.smoothOperatorRouting = {
        addWaypoint: (lat, lng) => addWaypoint(L.latLng(lat, lng)),
        reset: resetRoute,
        flyTo: (lat, lng, zoom) => leafletMap.flyTo([lat, lng], zoom || leafletMap.getZoom()),
    };

    const undoBtn = document.getElementById("undo-route-btn");
    if (undoBtn) undoBtn.addEventListener("click", () => {
        if (selectedPoints.length) {
            selectedPoints.pop();
            rebuildMarkers();
            drawFullRoute();
        }
    });
    if (GPS_ENABLED && typeof initGPS === "function") initGPS(leafletMap);
    console.log("Leaflet map initialized");
}

function loadGeoJSONData(map) {
    return loadCanalRoutes(map, L.layerGroup());
}

function loadCanalRoutes(map, layer) {
    return fetch("data/Amsterdamcanals.geojson", { cache: "no-store" })
        .then(r => { if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`); return r.json(); })
        .then(data => {
            const navigableFeatures = (data.features || []).filter(isNavigableCanal);
            canalSegments = navigableFeatures.map(feature => {
                const geometry = feature.geometry;
                const lines = geometry?.type === "MultiLineString" ? geometry.coordinates : geometry?.type === "LineString" ? [geometry.coordinates] : [];
                return lines.map(line => line.map(c => [c[1], c[0]]));
            }).flat();

            buildCanalGraph(navigableFeatures);

            // Keep navigable canals in the routing graph, but do not render them.
            // The map should remain visually clean; the calculated route is the
            // only canal geometry shown to the user.
            //
            // IMPORTANT: Do not remove or filter navigableFeatures above. They are
            // still required by buildCanalGraph() for snapping and routing.
            console.log(`Loaded ${canalGraph.nodes.length} navigable canal routing nodes and ${canalGraph.edges.length} routing edges.`);
            return canalGraph;
        })
        .catch(error => {
            canalGraphError = error;
            canalGraphReady = false;
            console.error("Error loading Amsterdam canal routes:", error);
            throw error;
        });
}

function addFallbackMarkers(map) { console.log("GeoJSON data could not be loaded"); }
function initMapLibreMap() { console.log("MapLibre map ready for implementation"); }
function addCustomMarker(map, coordinates, popupContent) {
    if (map instanceof L.Map) {
        const marker = L.marker(coordinates).addTo(map);
        if (popupContent) marker.bindPopup(popupContent);
        return marker;
    }
}
window.MapUtils = { addCustomMarker, AMSTERDAM_COORDS, ZOOM_LEVEL };

// --- Live GPS tracking -------------------------------------------------
// Wires the GPS button to navigator.geolocation, draws a live position
// marker and a trail of where the boat has actually been, and feeds
// getRemainingFromPosition() (below) into the route info panel so the
// distance/time shown updates as the boat moves along the planned route.

function initGPS(map) {
    const btn = document.getElementById("gps-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
        if (gpsActive) stopGPS(map); else startGPSTracking(map);
    });
}

function startGPSTracking(map) {
    if (gpsActive) return;
    if (!("geolocation" in navigator)) {
        setRouteStatus("GPS is not supported in this browser.");
        return;
    }

    gpsActive = true;
    const btn = document.getElementById("gps-btn");
    if (btn) btn.classList.add("gps-active");

    if (!drivenLine) drivenLine = L.polyline([], { color: "#2e7d32", weight: 4, opacity: 0.85, dashArray: "2,8" });
    drivenLine.setLatLngs([]);
    drivenLine.addTo(map);

    gpsWatchId = navigator.geolocation.watchPosition(
        position => handleGpsPosition(map, position),
        error => {
            console.error("GPS error", error);
            setRouteStatus(`Could not get your location: ${error.message || "unknown error"}.`);
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
}

function handleGpsPosition(map, position) {
    const latlng = { lat: position.coords.latitude, lng: position.coords.longitude };

    if (!gpsMarker) {
        gpsMarker = L.circleMarker([latlng.lat, latlng.lng], { radius: 9, weight: 3, color: "#2e7d32", fillColor: "#4caf50", fillOpacity: 0.9 }).addTo(map);
    } else {
        gpsMarker.setLatLng([latlng.lat, latlng.lng]);
        if (!map.hasLayer(gpsMarker)) gpsMarker.addTo(map);
    }
    if (drivenLine) drivenLine.addLatLng([latlng.lat, latlng.lng]);

    const remaining = getRemainingFromPosition(latlng);
    if (window.smoothOperatorUpdateGpsStatus) window.smoothOperatorUpdateGpsStatus(remaining);
}

function stopGPS(map) {
    if (gpsWatchId !== null && "geolocation" in navigator) {
        navigator.geolocation.clearWatch(gpsWatchId);
    }
    gpsWatchId = null;
    gpsActive = false;

    const btn = document.getElementById("gps-btn");
    if (btn) btn.classList.remove("gps-active");
    if (gpsMarker && map.hasLayer(gpsMarker)) map.removeLayer(gpsMarker);
    if (drivenLine && map.hasLayer(drivenLine)) map.removeLayer(drivenLine);
    if (window.smoothOperatorUpdateGpsStatus) window.smoothOperatorUpdateGpsStatus(null);
}

function getRemainingFromPosition(latlng) {
    if (currentRoutePath.length === 0) return { offRoute: true };
    let bestDist = Infinity, bestEdgeIdx = -1, bestT = 0;
    currentRoutePath.forEach((edge, i) => {
        const a = edge.segment[0], b = edge.segment[1], dx = b.lng - a.lng, dy = b.lat - a.lat;
        let t = 0;
        if (dx !== 0 || dy !== 0) t = ((latlng.lng - a.lng) * dx + (latlng.lat - a.lat) * dy) / (dx * dx + dy * dy);
        t = Math.max(0, Math.min(1, t));
        const p = { lat: a.lat + t * dy, lng: a.lng + t * dx }, d = latLngDistance(latlng, p);
        if (d < bestDist) { bestDist = d; bestEdgeIdx = i; bestT = t; }
    });
    if (bestDist > OFF_ROUTE_THRESHOLD_M) return { offRoute: true, distanceFromRoute: bestDist };
    let remainingDistance = 0, remainingTime = 0;
    for (let i = bestEdgeIdx; i < currentRoutePath.length; i++) {
        const e = currentRoutePath[i], segDistance = e.distance || 0, fraction = i === bestEdgeIdx ? 1 - bestT : 1;
        remainingDistance += segDistance * fraction;
        remainingTime += (segDistance * fraction / 1000) / (e.speed_kmh || 6) * 60;
    }
    return { offRoute: false, distanceFromRoute: bestDist, remainingDistance: remainingDistance / 1000, remainingTime };
}
