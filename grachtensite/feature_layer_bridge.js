/* Connect existing map layers to the central SmoothOperator feature panel. */
(function () {
    const originalLoadDockingLocations = window.loadDockingLocations;
    if (typeof originalLoadDockingLocations === "function") {
        window.loadDockingLocations = function (map, layer) {
            if (window.smoothOperatorRegisterLayer) {
                window.smoothOperatorRegisterLayer("docking", layer);
            }
            return originalLoadDockingLocations.apply(this, arguments);
        };
    }
})();
