(function() {
    if (window.AKPointDatePickerUtils) return;

    function pad2(value) {
        return String(value).padStart(2, '0');
    }

    function formatDate(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function formatParts(year, month, day) {
        return year + '-' + pad2(month) + '-' + pad2(day);
    }

    function parseDate(value) {
        var text = String(value || '').slice(0, 10);
        var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
        if (!match) return null;
        return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }

    function addDays(date, days) {
        var next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        next.setDate(next.getDate() + Number(days || 0));
        return next;
    }

    function addMonths(date, months) {
        var next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        next.setMonth(next.getMonth() + Number(months || 0));
        return next;
    }

    function daysInMonth(year, month) {
        return new Date(year, month, 0).getDate();
    }

    function mondayOffset(year, month) {
        var day = new Date(year, month - 1, 1).getDay();
        return day === 0 ? 6 : day - 1;
    }

    function orderedRange(state) {
        var start = state && state.start ? state.start : '';
        var end = state && state.end ? state.end : start;
        if (start && end && start > end) return { start: end, end: start };
        return { start: start, end: end };
    }

    function normalizeDataRange(range) {
        return {
            start: range && range.start ? String(range.start).slice(0, 10) : '',
            end: range && range.end ? String(range.end).slice(0, 10) : ''
        };
    }

    function clampRange(range, start, end) {
        var min = range && range.start ? range.start : '';
        var max = range && range.end ? range.end : '';
        var s = start || '';
        var e = end || s;
        if (min && s && s < min) s = min;
        if (max && s && s > max) s = max;
        if (min && e && e < min) e = min;
        if (max && e && e > max) e = max;
        return { start: s, end: e };
    }

    function clampCalendarMonth(range, year, month) {
        var y = Number(year || new Date().getFullYear());
        var m = Number(month || (new Date().getMonth() + 1));
        while (m < 1) {
            y -= 1;
            m += 12;
        }
        while (m > 12) {
            y += 1;
            m -= 12;
        }
        var min = range && range.start ? String(range.start).slice(0, 7) : '';
        var max = range && range.end ? String(range.end).slice(0, 7) : '';
        var current = y + '-' + pad2(m);
        if (min && current < min) {
            y = Number(min.slice(0, 4));
            m = Number(min.slice(5, 7));
        }
        if (max && current > max) {
            y = Number(max.slice(0, 4));
            m = Number(max.slice(5, 7));
        }
        return { year: y, month: m };
    }

    function quickRange(type, dataRange) {
        var max = dataRange && dataRange.end ? parseDate(dataRange.end) : new Date();
        var end = max || new Date();
        var start = end;
        if (type === 'yesterday') {
            start = addDays(end, -1);
            end = addDays(end, -1);
        } else if (type === '7d') {
            start = addDays(end, -6);
        } else if (type === 'month') {
            start = new Date(end.getFullYear(), end.getMonth(), 1);
        } else if (type === 'half-year') {
            start = addMonths(end, -6);
            start.setDate(start.getDate() + 1);
        } else if (type === 'year') {
            start = new Date(end.getFullYear(), 0, 1);
        }
        return clampRange(dataRange || {}, formatDate(start), formatDate(end));
    }

    function yearList(state) {
        var range = state && state.dataRange ? state.dataRange : {};
        var fallbackYear = state && state.calendarYear ? Number(state.calendarYear) : new Date().getFullYear();
        var minYear = range.start ? Number(String(range.start).slice(0, 4)) : fallbackYear;
        var maxYear = range.end ? Number(String(range.end).slice(0, 4)) : fallbackYear;
        if (!isFinite(minYear)) minYear = fallbackYear;
        if (!isFinite(maxYear)) maxYear = fallbackYear;
        if (minYear > maxYear) {
            var tmp = minYear;
            minYear = maxYear;
            maxYear = tmp;
        }
        var years = [];
        for (var year = minYear; year <= maxYear; year++) years.push(year);
        return years.length ? years : [fallbackYear];
    }

    window.AKPointDatePickerUtils = {
        pad2: pad2,
        formatDate: formatDate,
        formatParts: formatParts,
        parseDate: parseDate,
        addDays: addDays,
        addMonths: addMonths,
        daysInMonth: daysInMonth,
        mondayOffset: mondayOffset,
        orderedRange: orderedRange,
        normalizeDataRange: normalizeDataRange,
        clampRange: clampRange,
        clampCalendarMonth: clampCalendarMonth,
        quickRange: quickRange,
        yearList: yearList
    };
})();
