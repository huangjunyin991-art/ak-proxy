(function() {
    if (window.AKPointDatePicker) return;

    var stateApi = window.AKPointDatePickerState;
    var renderer = window.AKPointDatePickerRenderer;
    var controller = window.AKPointDatePickerController;

    function available() {
        return !!(stateApi && renderer && controller);
    }

    function createState() {
        if (!stateApi) return null;
        return stateApi.createState();
    }

    function syncDataRange(state, payload) {
        if (!stateApi || !state) return;
        stateApi.syncDataRange(state, payload);
    }

    function render(state) {
        if (!renderer || !state) return '';
        return renderer.render(state);
    }

    function handleAction(state, actionNode) {
        if (!controller || !state || !actionNode) return { handled: false, changed: false };
        return controller.handleAction(state, actionNode);
    }

    function getRequestParams(state) {
        if (!stateApi || !state) return { startDate: '', endDate: '' };
        return stateApi.getRequestParams(state);
    }

    window.AKPointDatePicker = {
        available: available,
        createState: createState,
        syncDataRange: syncDataRange,
        render: render,
        handleAction: handleAction,
        getRequestParams: getRequestParams
    };
})();
