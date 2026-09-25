/* Boat profile + route compatibility summary.
 *
 * Lets the operator record their boat's dimensions once (saved locally in
 * the browser) and, whenever a route is planned, cross-references it
 * against the bridges dataset (data/bridges.geojson) to show how many
 * movable vs. fixed bridges the route crosses.
 *
 * Deliberately honest about what this can't tell you: the Gemeente
 * Amsterdam bridge dataset does not publish clearance height/width (see
 * CLAUDE.md "Known limitations"), so this never claims a route "fits" or
 * "doesn't fit" a boat. It surfaces the count and type of crossings so the
 * operator knows where to expect a bridge opening or to double-check
 * clearance on the official map, and it deliberately does not check canal
 * width either -- the source data has real width values for only a
 * fraction of segments, not enough to make that check meaningful.
 */
(function () {
    const STORAGE_KEY = "smoothOperatorBoatProfile";
    const BRIDGE_PROXIMITY_M = 20; // how close a bridge must be to a route segment to count as "on the route"

    let bridgeFeatures = null;
    let bridgeFeaturesPromise = null;
    let latestPath = [];
    let updateGeneration = 0;

    function loadProfile() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (_) {
            return {};
        }
    }

    function saveProfile(profile) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
        } catch (_) {
            // Best-effort only -- a private-browsing tab or blocked storage shouldn't break the app.
        }
    }

    async function loadBridgeFeatures() {
        if (bridgeFeatures) return bridgeFeatures;
        if (!bridgeFeaturesPromise) {
            bridgeFeaturesPromise = fetch("data/bridges.geojson", { cache: "no-store" })
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
                .then(payload => { bridgeFeatures = payload.features || []; return bridgeFeatures; })
                .catch(error => {
                    console.error("Route compatibility: could not load bridges", error);
                    bridgeFeatures = [];
                    return bridgeFeatures;
                });
        }
        return bridgeFeaturesPromise;
    }

    // Reuses the app's own point-to-segment helpers (script.js, global scope).
    function bridgeDistanceToPath(bridgeLatLng, path) {
        let min = Infinity;
        for (const edge of path) {
            const [a, b] = edge.segment;
            const closest = closestPointOnSegment(bridgeLatLng, a, b);
            const d = latLngDistance(bridgeLatLng, closest);
            if (d < min) min = d;
        }
        return min;
    }

    async function findBridgesOnRoute(path) {
        const features = await loadBridgeFeatures();
        if (!path.length || !features.length) return [];
        const onRoute = [];
        for (const feature of features) {
            const coords = feature.geometry?.coordinates;
            if (!Array.isArray(coords) || coords.length < 2) continue;
            const [lng, lat] = coords;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            const distance = bridgeDistanceToPath({ lat, lng }, path);
            if (distance <= BRIDGE_PROXIMITY_M) onRoute.push(feature);
        }
        return onRoute;
    }

    function renderSummary(bridgesOnRoute, hasRoute) {
        const el = document.getElementById("route-compat-summary");
        if (!el) return;

        if (!hasRoute) {
            el.innerHTML = '<div class="feature-status">Plan a route to see bridges it crosses.</div>';
            return;
        }
        if (!bridgesOnRoute) {
            el.innerHTML = '<div class="feature-status">Checking bridges on this route…</div>';
            return;
        }
        if (bridgesOnRoute.length === 0) {
            el.innerHTML = '<div class="feature-status">No mapped bridges within 20 m of this route.</div>';
            return;
        }

        const movable = bridgesOnRoute.filter(f => String(f.properties?.bridge_type || "").toLowerCase().includes("movable"));
        const fixed = bridgesOnRoute.filter(f => !String(f.properties?.bridge_type || "").toLowerCase().includes("movable"));

        el.innerHTML = `
            <div class="compat-counts">
                ${movable.length ? `<div class="compat-row"><span class="compat-dot compat-dot-movable"></span>${movable.length} movable bridge${movable.length === 1 ? "" : "s"} on this route — may need an opening; time and check with the operator.</div>` : ""}
                ${fixed.length ? `<div class="compat-row"><span class="compat-dot compat-dot-fixed"></span>${fixed.length} fixed bridge${fixed.length === 1 ? "" : "s"} on this route.</div>` : ""}
            </div>
            <div class="compat-note">Clearance height/width isn't in this dataset, so this can't say whether your boat fits — verify on the <a href="https://www.vaarweginformatie.nl/frp/geo/map?layers=BRIDGE" target="_blank" rel="noopener">official RWS bridge map</a>.</div>`;
    }

    async function handleRouteUpdate(path) {
        latestPath = path || [];
        const generation = ++updateGeneration;
        if (!latestPath.length) {
            renderSummary(null, false);
            return;
        }
        renderSummary(null, true);
        const bridges = await findBridgesOnRoute(latestPath);
        // Guard against a stale async response landing after a newer route replaced it.
        if (generation === updateGeneration) {
            renderSummary(bridges, true);
        }
    }

    function wireProfileInputs(profile) {
        const fields = ["length", "beam", "draft", "airdraft"];
        fields.forEach(field => {
            const input = document.getElementById(`boat-${field}`);
            if (!input) return;
            if (profile[field] != null) input.value = profile[field];
            input.addEventListener("input", () => {
                const current = loadProfile();
                current[field] = input.value === "" ? undefined : Number(input.value);
                saveProfile(current);
            });
        });
    }

    function createSection() {
        const panelBody = document.querySelector(".feature-panel-body");
        if (!panelBody) return;

        const profile = loadProfile();
        const section = document.createElement("div");
        section.className = "route-compat-section";
        section.innerHTML = `
            <div class="feature-section-title">Boat profile</div>
            <div class="boat-profile-grid">
                <label>Length (m)<input type="number" min="0" step="0.1" id="boat-length"></label>
                <label>Beam (m)<input type="number" min="0" step="0.1" id="boat-beam"></label>
                <label>Draft (m)<input type="number" min="0" step="0.1" id="boat-draft"></label>
                <label>Air draft (m)<input type="number" min="0" step="0.1" id="boat-airdraft"></label>
            </div>
            <div class="feature-section-title" style="margin-top:10px">Bridges on this route</div>
            <div id="route-compat-summary"><div class="feature-status">Plan a route to see bridges it crosses.</div></div>
        `;

        const demoSection = panelBody.querySelector(".demo-routes-section");
        const routeCard = panelBody.querySelector(".route-info-card");
        const anchor = demoSection || routeCard;
        if (anchor && anchor.nextSibling) {
            panelBody.insertBefore(section, anchor.nextSibling);
        } else if (anchor) {
            anchor.after(section);
        } else {
            panelBody.appendChild(section);
        }

        wireProfileInputs(profile);
    }

    window.addEventListener("smoothoperator:routeUpdated", event => {
        handleRouteUpdate(event.detail?.path || []);
    });

    document.addEventListener("DOMContentLoaded", createSection);
})();
