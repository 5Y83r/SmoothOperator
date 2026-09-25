/* Show bridge positions and details on the map.
 *
 * Bridge locations and type (fixed/movable) come from Gemeente Amsterdam's
 * open civil-structures dataset, baked into data/bridges.geojson (see
 * CLAUDE.md for how to regenerate it). That dataset does not publish
 * clearance dimensions (width/height), so this layer is honest about that
 * gap instead of showing invented numbers: it links out to the official
 * Rijkswaterstaat Vaarweginformatie bridge map for current clearance and
 * opening-hours detail.
 */
(function () {
    let bridgeLayer = null;

    function esc(value) {
        return String(value ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }

    function mapInstance() { return window.map || window.__smoothOperatorMap || null; }

    function createPopup(bridge) {
        const p = bridge.properties || {};
        const isMovable = String(p.bridge_type || "").toLowerCase().includes("movable");
        return `<div class="bridge-popup">
            <strong>${esc(p.name || "Bridge")}</strong>
            <div>Type: <b>${esc(p.bridge_type || "Unknown")}</b>${isMovable ? " (may open on request)" : ""}</div>
            ${p.material ? `<div>Material: ${esc(p.material)}</div>` : ""}
            ${p.manager ? `<div>Managed by: ${esc(p.manager)}${p.manager_area ? ` – ${esc(p.manager_area)}` : ""}</div>` : ""}
            <div class="bridge-note">Clearance height/width isn't published in this dataset. Check the official map for current clearance and opening hours.</div>
            <div class="bridge-source"><a href="https://www.vaarweginformatie.nl/frp/geo/map?layers=BRIDGE" target="_blank" rel="noopener">Official clearance map: Rijkswaterstaat Vaarweginformatie</a></div>
            <div class="bridge-source"><a href="${esc(p.source_url || "https://api.data.amsterdam.nl/v1/civieleconstructies/brug/")}" target="_blank" rel="noopener">Source: ${esc(p.source || "Gemeente Amsterdam open data")}</a></div>
        </div>`;
    }

    function renderBridges(features) {
        const map = mapInstance();
        if (!map || typeof L === "undefined") return;
        if (!bridgeLayer) bridgeLayer = L.layerGroup();
        bridgeLayer.clearLayers();

        features.forEach(feature => {
            const coords = feature.geometry?.coordinates;
            if (!Array.isArray(coords) || coords.length < 2) return;
            const [lng, lat] = coords;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            const icon = window.smoothOperatorMakeBadgeIcon ? window.smoothOperatorMakeBadgeIcon("🌉", "#7c3aed") : undefined;
            const name = feature.properties?.name || "Bridge";
            (icon ? L.marker([lat, lng], { icon, title: name }) : L.circleMarker([lat, lng], { radius: 6, weight: 2, color: "#7c3aed", fillColor: "#a78bfa", fillOpacity: 0.9 }))
                .bindTooltip(name, { direction: "top", offset: [0, -13] })
                .bindPopup(createPopup(feature)).addTo(bridgeLayer);
        });

        window.smoothOperatorRegisterLayer?.("bridges", bridgeLayer);
    }

    async function loadBridges() {
        try {
            const response = await fetch("data/bridges.geojson", { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            renderBridges(payload.features || []);
            const status = document.getElementById("bridges-status");
            if (status) status.textContent = "Click a bridge on the map for details.";
        } catch (error) {
            console.error("Could not load bridges", error);
            const status = document.getElementById("bridges-status");
            if (status) status.textContent = "Bridge locations could not be loaded.";
        }
    }

    function createTool() {
        const tool = document.getElementById("bridges-tool");
        if (!tool) return;
        tool.innerHTML = '<div id="bridges-status" class="feature-status">Loading bridges…</div>';
        loadBridges();
    }

    window.addEventListener("smoothoperator:bridges", event => {
        if (!event.detail.enabled) {
            if (bridgeLayer) bridgeLayer.remove();
        } else if (bridgeLayer) {
            bridgeLayer.addTo(mapInstance());
        }
    });

    document.addEventListener("DOMContentLoaded", createTool);
})();
