(function() {
    if (window.AKPointDatePickerController) return;

    var stateApi = window.AKPointDatePickerState;
    var utils = window.AKPointDatePickerUtils;

    function handleAction(state, actionNode) {
        if (!state || !actionNode || !stateApi || !utils) return { handled: false, changed: false };
        var action = actionNode.getAttribute('data-action');
        if (action === 'date-month-nav') {
            stateApi.setCalendarMonth(state, state.calendarYear, state.calendarMonth + Number(actionNode.getAttribute('data-dir') || 0));
            return { handled: true, changed: false };
        }
        if (action === 'date-year-toggle') {
            stateApi.setYearDropdownOpen(state, !state.yearDropdownOpen);
            return { handled: true, changed: false };
        }
        if (action === 'date-year-select') {
            stateApi.setCalendarMonth(state, Number(actionNode.getAttribute('data-year') || state.calendarYear), state.calendarMonth);
            stateApi.setYearDropdownOpen(state, false);
            return { handled: true, changed: false };
        }
        if (action === 'date-day') {
            var date = actionNode.getAttribute('data-date') || '';
            if (!date) return { handled: true, changed: false };
            if (state.pendingStart && state.pendingStart !== date) {
                stateApi.setRange(state, state.pendingStart, date, '');
            } else {
                stateApi.setRange(state, date, date, '');
                stateApi.setPendingStart(state, date);
            }
            return { handled: true, changed: true };
        }
        if (action === 'date-quick') {
            var quickKey = actionNode.getAttribute('data-range') || 'today';
            var range = stateApi.quickRange(state, quickKey);
            stateApi.setRange(state, range.start, range.end, quickKey);
            var endDate = utils.parseDate(range.end);
            if (endDate) stateApi.setCalendarMonth(state, endDate.getFullYear(), endDate.getMonth() + 1);
            return { handled: true, changed: true };
        }
        if (action === 'date-clear') {
            stateApi.clearRange(state);
            return { handled: true, changed: true };
        }
        return { handled: false, changed: false };
    }

    window.AKPointDatePickerController = {
        handleAction: handleAction
    };
})();
