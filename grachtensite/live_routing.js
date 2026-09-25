/* Live fairway restrictions for SmoothOperator. */
(function () {
    const POLL_MS = 60 * 1000;
    const DEFAULT_BLOCK_RADIUS_M = 45;
    let lastNoticeSignature = "";
    let liveNotices = [];
    let restrictionLayer = null;

    if (window.L && !window.__smoothOperatorMapHooked) {
        const originalMap = L.map;
        L.map = function () {
            const map = originalMap.apply(this, arguments);
            window.__smoothOperatorMap = map;
            window.map = map;
            return map;
        };
        window.__smoothOperatorMapHooked = true;
    }

    function noticeCoordinates(notice) {
        const g = notice && notice.geometry;
        if (!g || !g.type || !g.coordinates) return [];
        if (g.type === "Point") return [{ lat: g.coordinates[1], lng: g.coordinates[0] }];
        if (g.type === "LineString") return g.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
        if (g.type === "MultiLineString") return g.coordinates.flat().map(c => ({ lat: c[1], lng: c[0] }));
        if (g.type === "Polygon") return g.coordinates.flat().map(c => ({ lat: c[1], lng: c[0] }));
        if (g.type === "MultiPolygon") return g.coordinates.flat(2).map(c => ({ lat: c[1], lng: c[0] }));
        return [];
    }

    function pointToSegmentDistanceMeters(p, a, b) {
        const latScale = 111320, lngScale = 111320 * Math.cos((p.lat * Math.PI) / 180);
        const px = p.lng * lngScale, py = p.lat * latScale, ax = a.lng * lngScale, ay = a.lat * latScale, bx = b.lng * lngScale, by = b.lat * latScale;
        const dx = bx - ax, dy = by - ay;
        if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }

    function edgeIsBlocked(edge, notice) {
        const coords = noticeCoordinates(notice);
        if (!coords.length || !edge || !edge.segment) return false;
        const a = edge.segment[0], b = edge.segment[1], radius = Number(notice.block_radius_m || DEFAULT_BLOCK_RADIUS_M);
        if (coords.length === 1) return pointToSegmentDistanceMeters(coords[0], a, b) <= radius;
        for (let i = 0; i < coords.length - 1; i++) {
            if (pointToSegmentDistanceMeters(a, coords[i], coords[i + 1]) <= radius || pointToSegmentDistanceMeters(b, coords[i], coords[i + 1]) <= radius || pointToSegmentDistanceMeters(coords[i], a, b) <= radius) return true;
        }
        return pointToSegmentDistanceMeters(coords[coords.length - 1], a, b) <= radius;
    }

    function applyRestrictions(notices) {
        if (typeof canalGraph === "undefined" || !Array.isArray(canalGraph.edges)) return 0;
        let blocked = 0;
        canalGraph.edges.forEach(edge => {
            edge.blocked = false;
            if (typeof edge._liveOriginalDistance !== "number") edge._liveOriginalDistance = edge.distance;
            edge.distance = edge._liveOriginalDistance;
            for (const notice of notices) {
                if (edgeIsBlocked(edge, notice)) { edge.blocked = true; edge.distance = Infinity; blocked++; break; }
            }
        });
        return blocked;
    }

    function renderRestrictionsOnMap() {
        const map = window.__smoothOperatorMap || window.map;
        if (!map || !window.L) return;
        if (!restrictionLayer) {
            restrictionLayer = L.layerGroup();
            if (window.smoothOperatorRegisterLayer) window.smoothOperatorRegisterLayer("obstructions", restrictionLayer);
        }
        restrictionLayer.clearLayers();
        if (!window.smoothOperatorFeatureEnabled || !window.smoothOperatorFeatureEnabled("obstructions")) return;
        liveNotices.forEach(notice => {
            const coords = noticeCoordinates(notice);
            if (!coords.length) return;
            const popup = `<b>${escapeHtml(notice.title)}</b><br>${escapeHtml(notice.type)}<br>${escapeHtml(notice.description || "")}`;
            const noticeName = notice.title || "Fairway notice";
            const alertIcon = window.smoothOperatorMakeBadgeIcon ? window.smoothOperatorMakeBadgeIcon("⚠", "#ea580c") : undefined;
            if (coords.length === 1) {
                L.circle(coords[0], { radius: Number(notice.block_radius_m || DEFAULT_BLOCK_RADIUS_M), color: "#ea580c", weight: 2, fillColor: "#f97316", fillOpacity: 0.18 }).bindPopup(popup).addTo(restrictionLayer);
                if (alertIcon) L.marker(coords[0], { icon: alertIcon }).bindTooltip(noticeName, { direction: "top", offset: [0, -13] }).bindPopup(popup).addTo(restrictionLayer);
            } else {
                L.polyline(coords.map(p => [p.lat, p.lng]), { color: "#ea580c", weight: 6, opacity: 0.75 }).bindPopup(popup).addTo(restrictionLayer);
                if (alertIcon) L.marker(coords[0], { icon: alertIcon }).bindTooltip(noticeName, { direction: "top", offset: [0, -13] }).bindPopup(popup).addTo(restrictionLayer);
            }
        });
    }

    function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }

    function renderStatus(blocked, fetchedAt, error) {
        const status = document.getElementById("obstructions-status");
        const results = document.getElementById("obstructions-results");
        if (!status) return;
        if (error) { status.textContent = "Live fairway restrictions are temporarily unavailable."; if (results) results.innerHTML = ""; return; }
        const time = fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : "unknown";
        status.textContent = `${liveNotices.length} notices · ${blocked} blocked route segments · updated ${time}`;
        if (results) results.innerHTML = liveNotices.slice(0, 8).map(n => `<div class="feature-result" title="${escapeHtml(n.description || "")}">${escapeHtml(n.title || "Fairway notice")}</div>`).join("") || '<div class="feature-empty">No active notices.</div>';
    }

    function rerouteCurrentRouteIfPossible() {
        if (typeof currentRoutePath === "undefined" || !Array.isArray(currentRoutePath) || !currentRoutePath.length) return;
        if (typeof findClosestNode !== "function" || typeof dijkstraShortestPath !== "function") return;
        const first = currentRoutePath[0], last = currentRoutePath[currentRoutePath.length - 1];
        if (!first || !last || !first.segment || !last.segment) return;
        const result = dijkstraShortestPath(findClosestNode(first.segment[0]), findClosestNode(last.segment[1]));
        if (!result.path.length) return;
        currentRoutePath = result.path;
        currentRouteTotal = { time: result.totalTime, distance: result.totalDistance };
        if (typeof routeLine !== "undefined" && routeLine && routeLine._map && typeof drawRoute === "function") drawRoute(routeLine._map, result.path);
        if (typeof updateRouteInfo === "function") updateRouteInfo(result.totalTime, result.totalDistance, [{ time: result.totalTime, distance: result.totalDistance }]);
    }

    async function refreshLiveRestrictions() {
        // Demo/venue networks can be slow or block the upstream feed outright.
        // Bound the wait so the panel fails fast with a clear message instead
        // of sitting on "Loading live notices..." indefinitely.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch("/api/obstructions/live", { cache: "no-store", signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            liveNotices = Array.isArray(payload.notices) ? payload.notices : [];
            const signature = JSON.stringify(liveNotices.map(n => [n.id, n.valid_from, n.valid_until, n.geometry]));
            const changed = signature !== lastNoticeSignature;
            lastNoticeSignature = signature;
            const blocked = applyRestrictions(liveNotices);
            renderRestrictionsOnMap();
            renderStatus(blocked, payload.fetched_at, null);
            if (changed) rerouteCurrentRouteIfPossible();
        } catch (error) {
            clearTimeout(timeoutId);
            const message = error.name === "AbortError" ? "timed out" : error.message;
            console.error("Live fairway restriction update failed", error);
            renderStatus(0, null, message);
        }
    }

    window.SmoothOperatorLive = { refresh: refreshLiveRestrictions, getNotices: () => liveNotices.slice() };
    window.addEventListener("smoothoperator:obstructions", event => { if (event.detail.enabled) renderRestrictionsOnMap(); else if (restrictionLayer) restrictionLayer.clearLayers(); });
    document.addEventListener("DOMContentLoaded", function () { setTimeout(refreshLiveRestrictions, 1000); setInterval(refreshLiveRestrictions, POLL_MS); });
})();
