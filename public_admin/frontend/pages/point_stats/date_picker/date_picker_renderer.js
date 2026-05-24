(function() {
    if (window.AKPointDatePickerRenderer) return;

    var utils = window.AKPointDatePickerUtils;

    function html(value) {
        if (typeof window.escapeHtml === 'function') return window.escapeHtml(value == null ? '' : String(value));
        return String(value == null ? '' : value).replace(/[&<>'"]/g, function(ch) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[ch];
        });
    }

    function render(state) {
        if (!utils || !state) return '';
        var year = Number(state.calendarYear || new Date().getFullYear());
        var month = Number(state.calendarMonth || (new Date().getMonth() + 1));
        var totalDays = utils.daysInMonth(year, month);
        var offset = utils.mondayOffset(year, month);
        var range = utils.orderedRange(state);
        var dataRange = state.dataRange || {};
        var hasDataRange = !!(dataRange.start && dataRange.end);
        var currentMonth = year + '-' + utils.pad2(month);
        var minMonth = hasDataRange ? String(dataRange.start).slice(0, 7) : '';
        var maxMonth = hasDataRange ? String(dataRange.end).slice(0, 7) : '';
        var prevDisabled = minMonth && currentMonth <= minMonth;
        var nextDisabled = maxMonth && currentMonth >= maxMonth;
        var rangeText = range.start ? (range.start === range.end ? range.start : range.start + ' 至 ' + range.end) : '全部日期';
        var dataText = hasDataRange ? dataRange.start + ' 至 ' + dataRange.end : '暂无缓存数据范围';
        var years = utils.yearList(state);
        var yearMenu = '<div class="ps-date-year-menu">' + years.map(function(item) {
            return '<button class="ps-date-year-option' + (item === year ? ' active' : '') + '" data-action="date-year-select" data-year="' + item + '">' + item + '</button>';
        }).join('') + '</div>';
        var dows = ['一', '二', '三', '四', '五', '六', '日'];
        var days = dows.map(function(day) {
            return '<div class="ps-date-dow">' + day + '</div>';
        }).join('') + Array.from({ length: 42 }, function(_, index) {
            var value = index - offset + 1;
            if (value < 1 || value > totalDays) return '<button class="ps-date-day dim" type="button"></button>';
            var date = utils.formatParts(year, month, value);
            var cls = '';
            var isActive = !!(range.start && (date === range.start || date === range.end));
            var isInRange = !!(range.start && date > range.start && date < range.end);
            if (isActive) cls += ' active';
            if (isInRange) cls += ' in-range';
            if (date === state.pendingStart) cls += ' pending';
            if (hasDataRange && (date < dataRange.start || date > dataRange.end) && !isActive && !isInRange) cls += ' out-data';
            return '<button class="ps-date-day' + cls + '" type="button" data-action="date-day" data-date="' + date + '">' + value + '</button>';
        }).join('');
        function quickButton(key, label) {
            return '<button class="' + (state.quickRange === key ? 'active' : '') + '" data-action="date-quick" data-range="' + key + '">' + label + '</button>';
        }
        return [
            '<section class="ps-date-picker">',
            '<div class="ps-date-side">',
            '<div class="ps-date-current"><small>当前筛选</small><b>' + html(rangeText) + '</b><span>数据库范围：' + html(dataText) + '</span></div>',
            '<div class="ps-date-quick-grid">',
            quickButton('today', '今天'),
            quickButton('yesterday', '昨天'),
            quickButton('7d', '近7天'),
            quickButton('month', '本月'),
            quickButton('half-year', '近半年'),
            quickButton('year', '本年'),
            '</div>',
            '<button class="ps-date-clear" data-action="date-clear">清除日期筛选</button>',
            '</div>',
            '<div class="ps-date-calendar">',
            '<div class="ps-date-head">',
            '<button class="ps-date-nav" data-action="date-month-nav" data-dir="-1"' + (prevDisabled ? ' disabled' : '') + '>‹</button>',
            '<div class="ps-date-year' + (state.yearDropdownOpen ? ' open' : '') + '"><button class="ps-date-year-btn" data-action="date-year-toggle">' + year + ' 年</button>' + yearMenu + '</div>',
            '<strong>' + month + ' 月</strong>',
            '<button class="ps-date-nav" data-action="date-month-nav" data-dir="1"' + (nextDisabled ? ' disabled' : '') + '>›</button>',
            '</div>',
            '<div class="ps-date-days">' + days + '</div>',
            '</div>',
            '</section>'
        ].join('');
    }

    window.AKPointDatePickerRenderer = {
        render: render
    };
})();
