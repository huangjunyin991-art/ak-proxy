(function() {
    if (window.AKPointStatsRenderer) return;

    function html(value) {
        if (typeof window.escapeHtml === 'function') return window.escapeHtml(value == null ? '' : String(value));
        return String(value == null ? '' : value).replace(/[&<>'"]/g, function(ch) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[ch];
        });
    }

    function number(value) {
        if (typeof window.formatNumber === 'function') return window.formatNumber(value);
        if (value === null || value === undefined || value === '') return '0';
        return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    }

    function time(value) {
        if (!value) return '-';
        return String(value).replace('T', ' ').slice(0, 16);
    }

    function amountTone(value) {
        var num = Number(value || 0);
        if (num > 0) return ' ps-amount-income';
        if (num < 0) return ' ps-amount-expense';
        return '';
    }

    function signedAmount(value, operationType) {
        var prefix = Number(operationType || 0) === 1 ? '+' : '-';
        return prefix + number(Math.abs(Number(value || 0)));
    }

    function activeStats(state) {
        var payload = state.payload || {};
        if (payload.active_stats) return payload.active_stats;
        return (payload.summary || []).find(function(item) { return item.point_type === state.pointType; }) || null;
    }

    function renderOptions(state) {
        if (!state.accountDropdownOpen) return '';
        if (state.accountSearching) return '<div class="ps-account-menu active"><div class="ps-empty compact">搜索中...</div></div>';
        if (!state.accountOptions.length) return '<div class="ps-account-menu active"><div class="ps-empty compact">暂无匹配账号</div></div>';
        return '<div class="ps-account-menu active">' + state.accountOptions.map(function(item, index) {
            return '<button class="ps-account-option' + (index === state.selectedAccountIndex ? ' active' : '') + '" data-action="select-account" data-index="' + index + '"><span><b>' + html(item.real_name || item.username || '-') + '</b><small>' + html(item.username || '-') + '</small></span><em>' + number(item.point_record_count) + ' 条流水</em></button>';
        }).join('') + '</div>';
    }

    function testPageTone(value) {
        var num = Number(value || 0);
        if (num > 0) return ' ps-income';
        if (num < 0) return ' ps-expense';
        return '';
    }

    function testPageLevel(index) {
        return ' level-' + (index % 5);
    }

    function testPageMetric(label, value, className) {
        return '<span class="ps-metric-chip"><span class="ps-metric-label">' + label + '</span><b class="ps-metric-value ' + (className || '') + '">' + value + '</b></span>';
    }

    function renderTestPageSummary(state) {
        var active = activeStats(state);
        var items = [
            ['记录', active ? active.total_records : null, ''],
            ['收入', active ? active.total_income : null, 'ps-income'],
            ['支出', active ? active.total_expense : null, 'ps-expense'],
            ['净变', active ? active.net_change : null, active ? testPageTone(active.net_change).trim() : ''],
            ['余额', active && active.current_balance != null ? active.current_balance : null, '']
        ];
        return items.map(function(item) {
            return '<div class="ps-mini-stat"><b class="' + item[2] + '">' + (item[1] == null ? '-' : number(item[1])) + '</b><span>' + item[0] + '</span></div>';
        }).join('');
    }

    function renderTestPageTabs(state) {
        return state.types.map(function(type) {
            return '<button class="ps-test-tab' + (type === state.pointType ? ' active' : '') + '" data-action="point-type" data-point-type="' + html(type) + '">' + html(type) + '</button>';
        }).join('');
    }

    function renderTestPageCategories(state) {
        var rows = state.payload && Array.isArray(state.payload.categories) ? state.payload.categories : [];
        if (!rows.length) return '<div class="ps-test-empty">请选择账号查看分类统计，或当前账号暂无统计数据。</div>';
        return '<div class="ps-path-list">' + rows.map(function(item, index) {
            var name = item.name || '未分类';
            var expanded = state.expandedCategory === name;
            var netClass = testPageTone(item.net).trim();
            return '<article class="ps-path-card' + testPageLevel(index) + '"><div class="ps-card-title"><span><b>' + html(name) + '</b><small>' + number((item.records || []).length) + ' 条可展开明细</small></span><button class="ps-card-action" data-action="toggle-category" data-name="' + html(name) + '">' + (expanded ? '收起' : '展开') + '</button></div><div class="ps-card-metrics">' + testPageMetric('记录', number(item.count), '') + testPageMetric('收入', number(item.income), 'ps-income') + testPageMetric('支出', number(item.expense), 'ps-expense') + testPageMetric('净变', number(item.net), netClass) + '</div>' + (expanded ? renderTestPageRecords(item.records || []) : '') + '</article>';
        }).join('') + '</div>';
    }

    function renderTestPageRecords(records) {
        if (!records || !records.length) return '<div class="ps-test-empty compact">暂无明细</div>';
        return '<div class="ps-test-record-list">' + records.map(function(record, index) {
            var isIncome = Number(record.operation_type || 0) === 1;
            var tone = isIncome ? 'ps-income' : 'ps-expense';
            return '<article class="ps-test-record level-' + (index % 5) + '"><span class="ps-record-main"><b>' + html(record.description || record.type_name_cn || record.type_name || '-') + '</b><small>' + time(record.time || record.record_time || record.saved_at) + '</small></span><div class="ps-card-metrics">' + testPageMetric(isIncome ? '收入' : '支出', signedAmount(record.amount, record.operation_type), tone) + testPageMetric('余额', record.balance == null ? '-' : number(record.balance), '') + testPageMetric('类型', html(record.type_name_cn || record.type_name || '-'), '') + '</div></article>';
        }).join('') + '</div>';
    }

    function renderTestPageLeaderboard(state) {
        var rows = state.payload && Array.isArray(state.payload.leaderboard) ? state.payload.leaderboard : [];
        if (!rows.length) return '<div class="ps-test-empty">暂无账号排行</div>';
        return '<div class="ps-path-list compact">' + rows.map(function(item, index) {
            var netClass = testPageTone(item.net_change).trim();
            return '<button class="ps-path-card ps-rank-card' + testPageLevel(index + 1) + '" data-action="rank-account" data-username="' + html(item.username || '') + '"><div class="ps-card-title"><span><b>' + html(item.username || '-') + '</b><small>' + html(item.point_type || state.pointType) + ' · ' + number(item.total_records) + ' 条流水</small></span><em>TOP ' + (index + 1) + '</em></div><div class="ps-card-metrics">' + testPageMetric('收入', number(item.total_income), 'ps-income') + testPageMetric('支出', number(item.total_expense), 'ps-expense') + testPageMetric('净变', number(item.net_change), netClass) + '</div></button>';
        }).join('') + '</div>';
    }

    function renderTestPage(state) {
        var current = state.username ? html(state.username) : '全局排行';
        var badgeText = state.error ? '异常' : state.loading ? '读取中' : state.syncing ? '同步中' : state.username ? '账号视图' : '全局视图';
        return '<div class="ps-app' + ((state.loading || state.syncing) ? ' is-busy' : '') + '"><section class="ps-topbar"><div class="ps-title-row"><h1>点数统计</h1><span class="ps-test-badge">' + html(badgeText) + '</span></div><div class="ps-status-line ' + (state.error ? 'error' : '') + '">' + html(state.status) + '</div><div class="ps-mini-stats">' + renderTestPageSummary(state) + '</div><div class="ps-test-controls"><div class="ps-search-wrap"><input class="ps-test-search ps-account-input" data-role="account-input" value="' + html(state.accountQuery) + '" placeholder="搜索账号 / 姓名" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">' + renderOptions(state) + '</div><div class="ps-test-actions"><button class="ps-test-btn" data-action="load"' + (state.loading ? ' disabled' : '') + '>' + (state.loading ? '读取中' : '读取') + '</button><button class="ps-test-btn primary" data-action="sync"' + (state.syncing ? ' disabled' : '') + '>' + (state.syncing ? '同步中' : '同步') + '</button><button class="ps-test-btn ghost" data-action="clear-account">清空</button></div></div><div class="ps-test-tabs">' + renderTestPageTabs(state) + '</div></section><section class="ps-test-panel"><div class="ps-test-panel-head"><span><b>' + html(state.pointType) + ' 分类流水</b><small>' + current + '</small></span><em>分类卡片</em></div>' + renderTestPageCategories(state) + '</section><section class="ps-test-panel"><div class="ps-test-panel-head"><span><b>账号排行</b><small>按净变化排序</small></span><em>' + html(state.pointType) + '</em></div>' + renderTestPageLeaderboard(state) + '</section></div>';
    }

    window.AKPointStatsRenderer = {
        render: renderTestPage
    };
})();
