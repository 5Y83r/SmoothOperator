/* Named start/destination search, as an alternative to clicking the map.
 *
 * Two fields ("Start" / "Destination"). Typing searches two sources:
 *   1. This app's own data (docking spots, bridges, toilets by name) --
 *      instant, no network call.
 *   2. OpenStreetMap's public Nominatim geocoder, scoped to an Amsterdam
 *      bounding box, for a general address or landmark not already in this
 *      app's datasets.
 * Nominatim's public endpoint is a shared, rate-limited resource meant for
 * light interactive use -- fine for a demo/pitch, but a real production
 * deployment with real traffic would need a self-hosted or paid geocoder
 * instead. Not pretending otherwise here.
 *
 * Selecting a suggestion places it through the exact same
 * window.smoothOperatorRouting.addWaypoint() path a map click uses (see
 * script.js / demo_routes.js), so it snaps to the canal network and draws
 * the route the same way. Whichever of Start/Destination is filled gets
 * (re)placed in order every time either field changes, so this UI always
 * plans a direct two-point trip; multi-stop routes still require clicking
 * extra points on the map.
 */
(function () {
    const AMSTERDAM_VIEWBOX = "4.73,52.44,5.05,52.29"; // left,top,right,bottom (lon,lat,lon,lat)
    const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
    const MAX_LOCAL_RESULTS = 5;
    const MAX_GEOCODE_RESULTS = 5;
    const DEBOUNCE_MS = 450;
    const MIN_GEOCODE_CHARS = 3;

    const points = { start: null, destination: null }; // { lat, lng, label }
    let localPlaces = null;
    let localPlacesPromise = null;
    let geocodeAbort = null;

    function esc(v) {
        return String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }

    async function loadLocalPlaces() {
        if (localPlaces) return localPlaces;
        if (!localPlacesPromise) {
            localPlacesPromise = Promise.all([
                fetch("data/rondvaartopenafstapplekken.geojson").then(r => (r.ok ? r.json() : { features: [] })).catch(() => ({ features: [] })),
                fetch("data/bridges.geojson").then(r => (r.ok ? r.json() : { features: [] })).catch(() => ({ features: [] })),
                fetch("data/toilets.geojson").then(r => (r.ok ? r.json() : { features: [] })).catch(() => ({ features: [] })),
            ]).then(([docking, bridges, toilets]) => {
                const places = [];
                (docking.features || []).forEach(f => {
                    const name = String(f.properties?.Name || "").trim();
                    if (!name || /^Verdwenen:/i.test(name)) return;
                    const [lng, lat] = f.geometry?.coordinates || [];
                    if (Number.isFinite(lat) && Number.isFinite(lng)) places.push({ name, lat, lng, icon: "⚓", tag: "Docking" });
                });
                (bridges.features || []).forEach(f => {
                    const name = f.properties?.name;
                    const [lng, lat] = f.geometry?.coordinates || [];
                    if (name && Number.isFinite(lat) && Number.isFinite(lng)) places.push({ name, lat, lng, icon: "🌉", tag: "Bridge" });
                });
                (toilets.features || []).forEach(f => {
                    const name = f.properties?.name;
                    const [lng, lat] = f.geometry?.coordinates || [];
                    if (name && Number.isFinite(lat) && Number.isFinite(lng)) places.push({ name, lat, lng, icon: "🚻", tag: "Toilet" });
                });
                localPlaces = places;
                return places;
            });
        }
        return localPlacesPromise;
    }

    function searchLocal(query, places) {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        return places.filter(p => p.name.toLowerCase().includes(q)).slice(0, MAX_LOCAL_RESULTS);
    }

    async function searchGeocode(query) {
        if (query.trim().length < MIN_GEOCODE_CHARS) return [];
        if (geocodeAbort) geocodeAbort.abort();
        geocodeAbort = new AbortController();
        try {
            const url = `${NOMINATIM_URL}?format=jsonv2&q=${encodeURIComponent(query + ", Amsterdam")}&viewbox=${AMSTERDAM_VIEWBOX}&bounded=1&limit=${MAX_GEOCODE_RESULTS}`;
            const response = await fetch(url, { signal: geocodeAbort.signal, headers: { Accept: "application/json" } });
            if (!response.ok) return [];
            const results = await response.json();
            return (Array.isArray(results) ? results : [])
                .map(r => ({
                    name: (r.display_name || "").split(",").slice(0, 3).join(","),
                    lat: Number(r.lat),
                    lng: Number(r.lon),
                    icon: "📍",
                    tag: "OpenStreetMap",
                }))
                .filter(r => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng));
        } catch (error) {
            if (error.name !== "AbortError") console.error("Address search failed", error);
            return [];
        }
    }

    function dedupe(list) {
        const seen = new Set();
        const out = [];
        for (const item of list) {
            const key = `${item.name.toLowerCase()}|${item.lat.toFixed(4)}|${item.lng.toFixed(4)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(item);
        }
        return out;
    }

    function debounce(fn, ms) {
        let timer;
        return (...args) => new Promise(resolve => {
            clearTimeout(timer);
            timer = setTimeout(() => resolve(fn(...args)), ms);
        });
    }

    async function recomputeRoute() {
        if (!window.smoothOperatorRouting) return;
        window.smoothOperatorRouting.reset();
        const ordered = [points.start, points.destination].filter(Boolean);
        if (!ordered.length) return;
        if (ordered.length === 1) {
            window.smoothOperatorRouting.flyTo(ordered[0].lat, ordered[0].lng, 15);
        } else {
            window.smoothOperatorRouting.flyTo((ordered[0].lat + ordered[1].lat) / 2, (ordered[0].lng + ordered[1].lng) / 2, 14);
        }
        await new Promise(r => setTimeout(r, 250));
        for (const point of ordered) {
            // eslint-disable-next-line no-await-in-loop
            await window.smoothOperatorRouting.addWaypoint(point.lat, point.lng);
        }
    }

    function createFieldController(fieldName, els) {
        const { input, clearBtn, suggestions } = els;
        const debouncedGeocode = debounce(searchGeocode, DEBOUNCE_MS);
        let requestId = 0;

        function renderSuggestions(list) {
            if (!list.length) {
                suggestions.hidden = true;
                suggestions.innerHTML = "";
                return;
            }
            suggestions.hidden = false;
            suggestions.innerHTML = list
                .map((item, i) => `<button type="button" class="route-search-suggestion" data-index="${i}">
                    <span class="route-search-suggestion-icon">${item.icon}</span>
                    <span class="route-search-suggestion-text">
                        <span class="route-search-suggestion-name">${esc(item.name)}</span>
                        <span class="route-search-suggestion-tag">${esc(item.tag)}</span>
                    </span>
                </button>`)
                .join("");
            suggestions.querySelectorAll(".route-search-suggestion").forEach(btn => {
                btn.addEventListener("mousedown", e => {
                    e.preventDefault(); // keep focus so the subsequent blur doesn't hide the list first
                    selectPlace(list[Number(btn.dataset.index)]);
                });
            });
        }

        async function selectPlace(place) {
            points[fieldName] = { lat: place.lat, lng: place.lng, label: place.name };
            input.value = place.name;
            clearBtn.hidden = false;
            suggestions.hidden = true;
            suggestions.innerHTML = "";
            await recomputeRoute();
        }

        async function runSearch(query) {
            const myRequest = ++requestId;
            const places = await loadLocalPlaces();
            const local = searchLocal(query, places);
            if (myRequest !== requestId) return;
            renderSuggestions(local);
            const geocoded = await debouncedGeocode(query);
            if (myRequest !== requestId) return;
            renderSuggestions(dedupe([...local, ...geocoded]).slice(0, 8));
        }

        input.addEventListener("input", () => {
            clearBtn.hidden = input.value === "";
            if (points[fieldName] && input.value !== points[fieldName].label) points[fieldName] = null;
            const query = input.value.trim();
            if (query.length < 2) {
                suggestions.hidden = true;
                suggestions.innerHTML = "";
                return;
            }
            runSearch(query);
        });

        input.addEventListener("blur", () => {
            setTimeout(() => { suggestions.hidden = true; }, 100);
        });

        input.addEventListener("keydown", e => {
            if (e.key === "Escape") { suggestions.hidden = true; input.blur(); }
        });

        clearBtn.addEventListener("click", async () => {
            points[fieldName] = null;
            input.value = "";
            clearBtn.hidden = true;
            suggestions.hidden = true;
            suggestions.innerHTML = "";
            await recomputeRoute();
        });

        return {
            clear() {
                points[fieldName] = null;
                input.value = "";
                clearBtn.hidden = true;
                suggestions.hidden = true;
                suggestions.innerHTML = "";
            },
            setLabel(label) {
                input.value = label || "";
                clearBtn.hidden = !label;
            },
        };
    }

    function createSection() {
        const panelBody = document.querySelector(".feature-panel-body");
        if (!panelBody) return;

        const section = document.createElement("div");
        section.className = "route-search-section";
        section.innerHTML = `
            <div class="feature-section-title">Plan a trip</div>
            <div class="route-search-row">
                <div class="route-search-field">
                    <label for="route-search-start">Start</label>
                    <div class="route-search-input-wrap">
                        <input type="text" id="route-search-start" placeholder="Search a name or address…" autocomplete="off">
                        <button type="button" class="route-search-clear" data-field="start" aria-label="Clear start" hidden>×</button>
                    </div>
                    <div class="route-search-suggestions" id="route-search-start-suggestions" hidden></div>
                </div>
                <button type="button" class="route-search-swap" id="route-search-swap" aria-label="Swap start and destination" title="Swap start &amp; destination">⇅</button>
                <div class="route-search-field">
                    <label for="route-search-destination">Destination</label>
                    <div class="route-search-input-wrap">
                        <input type="text" id="route-search-destination" placeholder="Search a name or address…" autocomplete="off">
                        <button type="button" class="route-search-clear" data-field="destination" aria-label="Clear destination" hidden>×</button>
                    </div>
                    <div class="route-search-suggestions" id="route-search-destination-suggestions" hidden></div>
                </div>
            </div>
            <div class="route-search-note">Matches docking spots, bridges &amp; toilets in this app, plus general Amsterdam addresses via OpenStreetMap.</div>
        `;
        panelBody.insertBefore(section, panelBody.firstChild);

        const startCtrl = createFieldController("start", {
            input: section.querySelector("#route-search-start"),
            clearBtn: section.querySelector('.route-search-clear[data-field="start"]'),
            suggestions: section.querySelector("#route-search-start-suggestions"),
        });
        const destCtrl = createFieldController("destination", {
            input: section.querySelector("#route-search-destination"),
            clearBtn: section.querySelector('.route-search-clear[data-field="destination"]'),
            suggestions: section.querySelector("#route-search-destination-suggestions"),
        });

        section.querySelector("#route-search-swap").addEventListener("click", async () => {
            const startPoint = points.start, destPoint = points.destination;
            points.start = destPoint;
            points.destination = startPoint;
            startCtrl.setLabel(destPoint?.label);
            destCtrl.setLabel(startPoint?.label);
            await recomputeRoute();
        });

        // The map's own Reset/Undo buttons bypass this module's state; keep the
        // two named fields from showing a stale label after either is used.
        document.getElementById("reset-route-btn")?.addEventListener("click", () => {
            startCtrl.clear();
            destCtrl.clear();
        });
        document.getElementById("undo-route-btn")?.addEventListener("click", () => {
            startCtrl.clear();
            destCtrl.clear();
        });
    }

    document.addEventListener("DOMContentLoaded", createSection);
})();
