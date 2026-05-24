(function() {
    if (window.AKPointDatePickerState) return;

    var utils = window.AKPointDatePickerUtils;

    function createState() {
        var now = new Date();
        return {
            start: '',
            end: '',
            pendingStart: '',
            quickRange: '',
            dataRange: { start: '', end: '' },
            calendarYear: now.getFullYear(),
            calendarMonth: now.getMonth() + 1,
            yearDropdownOpen: false
        };
    }

    function syncDataRange(state, payload) {
        if (!state || !utils) return;
        var range = payload && payload.date_range ? payload.date_range : {};
        state.dataRange = utils.normalizeDataRange(range);
        if (!state.start && state.dataRange.end) {
            state.calendarYear = Number(state.dataRange.end.slice(0, 4));
            state.calendarMonth = Number(state.dataRange.end.slice(5, 7));
        }
    }

    function setRange(state, start, end, quickRange) {
        if (!state) return;
        state.start = start || '';
        state.end = end || start || '';
        if (state.start && state.end && state.start > state.end) {
            var tmp = state.start;
            state.start = state.end;
            state.end = tmp;
        }
        state.pendingStart = '';
        state.quickRange = quickRange || '';
        state.yearDropdownOpen = false;
    }

    function clearRange(state) {
        setRange(state, '', '', '');
    }

    function setPendingStart(state, value) {
        if (!state) return;
        state.pendingStart = value || '';
        if (state.pendingStart) state.quickRange = '';
    }

    function setCalendarMonth(state, year, month) {
        if (!state || !utils) return;
        var next = utils.clampCalendarMonth(state.dataRange, year || state.calendarYear, month || state.calendarMonth);
        state.calendarYear = next.year;
        state.calendarMonth = next.month;
    }

    function setYearDropdownOpen(state, open) {
        if (!state) return;
        state.yearDropdownOpen = !!open;
    }

    function quickRange(state, type) {
        if (!utils) return { start: '', end: '' };
        return utils.quickRange(type, state ? state.dataRange : {});
    }

    function getRequestParams(state) {
        return {
            startDate: state && state.start ? state.start : '',
            endDate: state && state.end ? state.end : ''
        };
    }

    window.AKPointDatePickerState = {
        createState: createState,
        syncDataRange: syncDataRange,
        setRange: setRange,
        clearRange: clearRange,
        setPendingStart: setPendingStart,
        setCalendarMonth: setCalendarMonth,
        setYearDropdownOpen: setYearDropdownOpen,
        quickRange: quickRange,
        getRequestParams: getRequestParams
    };
})();
