/* Central feature controls for SmoothOperator. */
(function () {
    const state = { docking: false, bridges: false, toilets: false, obstructions: false };
    let dockingLayer = null;
    let obstructionLayer = null;

    function getMap() { return window.map || window.__smoothOperatorMap || null; }

    // Shared marker style so every map layer reads as a distinct, professional
    // badge instead of everything defaulting to the same generic blue pin
    // (docking and toilets were previously indistinguishable at a glance).
    function makeBadgeIcon(emoji, bgColor) {
        return L.divIcon({
            className: "so-badge-icon",
            html: `<div class="so-badge" style="background:${bgColor}">${emoji}</div>`,
            iconSize: [26, 26],
            iconAnchor: [13, 13],
            popupAnchor: [0, -14],
        });
    }
    window.smoothOperatorMakeBadgeIcon = makeBadgeIcon;

    function setFeature(name, enabled) {
        state[name] = enabled;
        document.documentElement.dataset[`feature${name[0].toUpperCase()}${name.slice(1)}`] = enabled ? "on" : "off";
        const map = getMap();
        if (name === "docking" && dockingLayer && map) enabled ? dockingLayer.addTo(map) : map.removeLayer(dockingLayer);
        if (name === "obstructions" && obstructionLayer && map) enabled ? obstructionLayer.addTo(map) : map.removeLayer(obstructionLayer);
        const tool = document.getElementById(`${name}-tool`);
        if (tool) tool.hidden = !enabled;
        window.dispatchEvent(new CustomEvent(`smoothoperator:${name}`, { detail: { enabled } }));
        window.dispatchEvent(new CustomEvent("smoothoperator:feature", { detail: { name, enabled } }));
    }

    function formatDistance(km) {
        if (!Number.isFinite(km) || km <= 0) return "—";
        return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
    }

    function formatTime(minutes) {
        if (!Number.isFinite(minutes) || minutes <= 0) return "—";
        const rounded = Math.max(1, Math.round(minutes));
        if (rounded < 60) return `${rounded} min`;
        const hours = Math.floor(rounded / 60), mins = rounded % 60;
        return mins ? `${hours} hr ${mins} min` : `${hours} hr`;
    }

    function updateRouteInfo(time, distance) {
        const distanceEl = document.getElementById("route-distance-value");
        const timeEl = document.getElementById("route-time-value");
        const statusEl = document.getElementById("route-info-status");
        if (!distanceEl || !timeEl || !statusEl) return;
        const hasRoute = Number.isFinite(distance) && distance > 0;
        distanceEl.textContent = formatDistance(distance);
        timeEl.textContent = formatTime(time);
        statusEl.textContent = hasRoute ? "Estimated travel time based on the route." : "Click the map to plan a route.";
        statusEl.classList.toggle("has-route", hasRoute);
    }

    function createControlPanel() {
        const panel = document.createElement("aside");
        panel.id = "feature-control-panel";
        panel.innerHTML = `
            <div class="feature-panel-header"><div><div class="feature-panel-title">SmoothOperator</div><div class="feature-panel-subtitle">Map functions</div></div><button id="feature-panel-toggle" class="feature-panel-collapse" aria-label="Collapse menu">›</button></div>
            <div class="feature-panel-body">
                <section class="route-info-card" aria-live="polite"><div class="feature-section-title">Route</div><div class="route-info-grid"><div><span class="route-info-label">Distance</span><strong id="route-distance-value">—</strong></div><div><span class="route-info-label">Estimated time</span><strong id="route-time-value">—</strong></div></div><div id="route-info-status" class="route-info-status">Click the map to plan a route.</div><div id="gps-remaining" class="gps-remaining" hidden><span class="gps-remaining-label">Remaining (live GPS)</span><div class="route-info-grid"><div><strong id="gps-remaining-distance">—</strong></div><div><strong id="gps-remaining-time">—</strong></div></div></div></section>
                <div class="feature-section-title">Map layers</div>
                <label class="feature-toggle"><span><span class="feature-icon">⚓</span> Docking locations</span><input type="checkbox" data-feature="docking"><i></i></label>
                <div id="docking-tool" class="feature-tool" hidden><div class="feature-status">Click a docking icon on the map for details.</div></div>
                <label class="feature-toggle"><span><span class="feature-icon">↕</span> Bridges</span><input type="checkbox" data-feature="bridges"><i></i></label>
                <div id="bridges-tool" class="feature-tool" hidden></div>
                <label class="feature-toggle"><span><span class="feature-icon">🚻</span> Public toilets</span><input type="checkbox" data-feature="toilets"><i></i></label>
                <div id="toilets-tool" class="feature-tool" hidden></div>
                <label class="feature-toggle"><span><span class="feature-icon">⚠</span> Construction & closures</span><input type="checkbox" data-feature="obstructions"><i></i></label>
                <div id="obstructions-tool" class="feature-tool" hidden><div id="obstructions-status" class="feature-status">Loading live notices…</div><div id="obstructions-results" class="feature-results"></div></div>
            </div>`;
        document.body.appendChild(panel);
        panel.querySelectorAll("input[data-feature]").forEach(input => input.addEventListener("change", e => setFeature(e.target.dataset.feature, e.target.checked)));
        panel.querySelector("#feature-panel-toggle").addEventListener("click", () => { panel.classList.toggle("collapsed"); panel.querySelector("#feature-panel-toggle").textContent = panel.classList.contains("collapsed") ? "‹" : "›"; });
        setupDockingLayer();
        updateRouteInfo(0, 0);
    }

    function setupDockingLayer() {
        fetch("data/rondvaartopenafstapplekken.geojson")
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(data => {
                const locations = (data.features || []).filter(f => {
                    const name = String(f.properties?.Name || "").trim();
                    return f.geometry?.type === "Point" && !/^Verdwenen:/i.test(name);
                });
                const map = getMap();
                if (!map || !window.L) return;
                const layer = L.layerGroup();
                locations.forEach(feature => {
                    const [lng, lat] = feature.geometry.coordinates;
                    const name = feature.properties?.Name || "Docking location";
                    const description = feature.properties?.description || "";
                    const popup = `<div class="docking-popup"><b>${escapeHtml(name)}</b>${description ? `<div>${sanitizeDescription(description)}</div>` : ""}</div>`;
                    L.marker([lat, lng], { title: name, icon: makeBadgeIcon("⚓", "#0891b2") })
                        .bindTooltip(name, { direction: "top", offset: [0, -13] })
                        .bindPopup(popup)
                        .addTo(layer);
                });
                dockingLayer = layer;
                if (state.docking) layer.addTo(map);
            })
            .catch(error => console.error("Could not load docking locations", error));
    }

    function sanitizeDescription(value) {
        const temp = document.createElement("div");
        temp.innerHTML = String(value ?? "");
        temp.querySelectorAll("script, iframe, object, embed").forEach(node => node.remove());
        // The docking dataset was exported from Google My Maps, whose <img> hotlinks
        // (mymaps.usercontent.google.com) are session-scoped and reliably fail to
        // load outside the My Maps viewer, leaving a broken-image icon in the popup.
        temp.querySelectorAll("img").forEach(node => {
            const src = node.getAttribute("src") || "";
            if (/usercontent\.google\.com/i.test(src)) node.remove();
        });
        temp.querySelectorAll("*").forEach(node => [...node.attributes].forEach(attr => {
            if (/^on/i.test(attr.name) || attr.name.toLowerCase() === "srcdoc") node.removeAttribute(attr.name);
            if ((attr.name === "src" || attr.name === "href") && /^javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
        }));
        return temp.innerHTML;
    }

    function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch])); }

    function updateGpsStatus(remaining) {
        const box = document.getElementById("gps-remaining");
        const distanceEl = document.getElementById("gps-remaining-distance");
        const timeEl = document.getElementById("gps-remaining-time");
        if (!box || !distanceEl || !timeEl) return;
        if (!remaining) { box.hidden = true; return; }
        if (remaining.offRoute) {
            box.hidden = false;
            distanceEl.textContent = "Off route";
            timeEl.textContent = Number.isFinite(remaining.distanceFromRoute) ? `${Math.round(remaining.distanceFromRoute)} m away` : "—";
            return;
        }
        box.hidden = false;
        distanceEl.textContent = formatDistance(remaining.remainingDistance);
        timeEl.textContent = formatTime(remaining.remainingTime);
    }

    window.smoothOperatorUpdateGpsStatus = updateGpsStatus;
    window.smoothOperatorRegisterLayer = function (name, layer) {
        if (name === "docking" && !dockingLayer) dockingLayer = layer;
        if (name === "obstructions") obstructionLayer = layer;
        const map = getMap();
        if (state[name] && layer && map) layer.addTo(map);
    };
    window.smoothOperatorFeatureEnabled = name => !!state[name];
    window.smoothOperatorUpdateRouteInfo = updateRouteInfo;
    document.addEventListener("DOMContentLoaded", createControlPanel);
})();
