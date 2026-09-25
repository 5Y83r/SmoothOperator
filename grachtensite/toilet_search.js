/* Public toilet locations shown directly on the map.
 *
 * Data comes from Gemeente Amsterdam's official public-toilets open dataset,
 * baked into data/toilets.geojson (see CLAUDE.md for how to regenerate it).
 * This used to call a live "/api/toilets/nearby" endpoint that pointed at an
 * Overpass mirror and timed out on every request; it now reads the static
 * file directly, same as the docking-locations layer.
 */
(function () {
    let toiletLayer = null;

    function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch])); }
    function mapInstance() { return window.map || window.__smoothOperatorMap || null; }

    function createPopup(feature) {
        const p = feature.properties || {};
        const details = [];
        if (p.location) details.push(p.location);
        if (p.opening_hours) details.push(p.opening_hours);
        if (p.days_open) details.push(p.days_open);
        if (Number.isFinite(p.price_eur)) details.push(p.price_eur > 0 ? `€${p.price_eur.toFixed(2)} per use` : "Free");
        if (p.wheelchair_accessible) details.push("Wheelchair accessible");
        const source = p.source_url || "https://maps.amsterdam.nl/openbare_toiletten/?LANG=en";
        return `<div class="toilet-popup"><strong>${escapeHtml(p.name || "Public toilet")}</strong>${details.map(value => `<div>${escapeHtml(value)}</div>`).join("")}<div><a href="${escapeHtml(source)}" target="_blank" rel="noopener">Source: ${escapeHtml(p.source || "Municipality of Amsterdam")}</a></div></div>`;
    }

    async function loadToilets() {
        try {
            const response = await fetch("data/toilets.geojson", { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            const map = mapInstance();
            if (!map || typeof L === "undefined") return;

            toiletLayer = L.layerGroup();
            (payload.features || []).forEach(feature => {
                const coords = feature.geometry?.coordinates;
                if (!Array.isArray(coords) || coords.length < 2) return;
                const [lng, lat] = coords;
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
                const icon = window.smoothOperatorMakeBadgeIcon ? window.smoothOperatorMakeBadgeIcon("🚻", "#16a34a") : undefined;
                const name = feature.properties?.name || "Public toilet";
                L.marker([lat, lng], { title: name, icon })
                    .bindTooltip(name, { direction: "top", offset: [0, -13] })
                    .bindPopup(createPopup(feature))
                    .addTo(toiletLayer);
            });
            window.smoothOperatorRegisterLayer?.("toilets", toiletLayer);
            const status = document.getElementById("toilets-status");
            if (status) status.textContent = "Click a toilet icon on the map for details.";
        } catch (error) {
            console.error("Could not load public toilets", error);
            const status = document.getElementById("toilets-status");
            if (status) status.textContent = "Public toilet locations could not be loaded.";
        }
    }

    function createTool() {
        const tool = document.getElementById("toilets-tool");
        if (!tool) return;
        tool.innerHTML = '<div id="toilets-status" class="feature-status">Loading public toilets…</div>';
        loadToilets();
    }

    window.addEventListener("smoothoperator:toilets", event => {
        const map = mapInstance();
        if (!map) return;
        if (!event.detail.enabled && toiletLayer) toiletLayer.remove();
        else if (event.detail.enabled && toiletLayer) toiletLayer.addTo(map);
    });

    document.addEventListener("DOMContentLoaded", createTool);
})();
