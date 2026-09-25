/* One-click preset routes for live demos / pitches.
 *
 * Manually clicking two precise points on thin canal lines in front of an
 * audience is a real failure mode under demo pressure. These are real
 * Amsterdam landmarks, each verified (see tools/) to snap onto the canal
 * network and produce an actual routable path between the two endpoints --
 * not placeholder coordinates.
 */
(function () {
    const DEMO_ROUTES = [
        {
            label: "Anne Frank House → Rijksmuseum",
            a: [52.375550, 4.884142],
            b: [52.360938, 4.885735],
        },
        {
            label: "American Hotel → Café 't Smalle",
            a: [52.363677, 4.880859],
            b: [52.376650, 4.884386],
        },
        {
            label: "American Hotel → Gassan Diamonds",
            a: [52.363677, 4.880859],
            b: [52.369458, 4.904199],
        },
    ];

    async function runDemoRoute(route, button) {
        if (!window.smoothOperatorRouting) return;
        const buttons = document.querySelectorAll(".demo-route-btn");
        buttons.forEach(b => (b.disabled = true));
        const originalText = button.textContent;
        button.textContent = "Planning…";

        window.smoothOperatorRouting.reset();
        window.smoothOperatorRouting.flyTo((route.a[0] + route.b[0]) / 2, (route.a[1] + route.b[1]) / 2, 14);
        await new Promise(r => setTimeout(r, 350));
        await window.smoothOperatorRouting.addWaypoint(route.a[0], route.a[1]);
        await window.smoothOperatorRouting.addWaypoint(route.b[0], route.b[1]);

        button.textContent = originalText;
        buttons.forEach(b => (b.disabled = false));
    }

    function createSection() {
        const panelBody = document.querySelector(".feature-panel-body");
        if (!panelBody) return;

        const section = document.createElement("div");
        section.className = "demo-routes-section";
        section.innerHTML = `
            <div class="feature-section-title">Demo routes</div>
            <div class="demo-route-list">
                ${DEMO_ROUTES.map((route, i) => `<button type="button" class="demo-route-btn" data-index="${i}">${route.label}</button>`).join("")}
            </div>`;

        // Sits right below the Route card, above Map layers.
        const routeCard = panelBody.querySelector(".route-info-card");
        if (routeCard && routeCard.nextSibling) {
            panelBody.insertBefore(section, routeCard.nextSibling);
        } else {
            panelBody.appendChild(section);
        }

        section.querySelectorAll(".demo-route-btn").forEach(btn => {
            btn.addEventListener("click", () => runDemoRoute(DEMO_ROUTES[Number(btn.dataset.index)], btn));
        });
    }

    document.addEventListener("DOMContentLoaded", createSection);
})();
