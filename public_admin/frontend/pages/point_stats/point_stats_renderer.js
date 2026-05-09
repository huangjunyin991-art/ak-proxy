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

    function renderSummary(state) {
        var active = activeStats(state);
        var items = [
            ['记录数', active ? active.total_records : null, ''],
            ['总收入', active ? active.total_income : null, 'income'],
            ['总支出', active ? active.total_expense : null, 'expense'],
            ['净变化', active ? active.net_change : null, active ? amountTone(active.net_change).trim() : ''],
            ['当前余额', active && active.current_balance != null ? active.current_balance : null, '']
        ];
        return items.map(function(item) {
            return '<div class="ps-rt-stat ' + item[2] + '"><b>' + (item[1] == null ? '-' : number(item[1])) + '</b><span>' + item[0] + '</span></div>';
        }).join('');
    }

    function renderTabs(state) {
        return state.types.map(function(type) {
            return '<button class="ps-rt-view-tab' + (type === state.pointType ? ' active' : '') + '" data-action="point-type" data-point-type="' + html(type) + '">' + html(type) + '</button>';
        }).join('');
    }

    function recordDirection(record) {
        return Number(record.operation_type || 0) === 1 ? '收入' : '支出';
    }

    function renderDetailTable(records) {
        if (!records || !records.length) return '<div class="ps-empty compact">暂无明细</div>';
        return '<div class="ps-rt-detail-wrap"><table class="ps-detail-table"><thead><tr><th>时间</th><th>方向</th><th>金额</th><th>余额</th><th>类型</th><th>描述</th></tr></thead><tbody>' + records.map(function(record) {
            var isIncome = Number(record.operation_type || 0) === 1;
            var tone = isIncome ? 'income' : 'expense';
            return '<tr><td>' + html(time(record.time || record.record_time || record.saved_at)) + '</td><td class="' + tone + '">' + recordDirection(record) + '</td><td class="' + tone + '">' + signedAmount(record.amount, record.operation_type) + '</td><td>' + (record.balance == null ? '-' : number(record.balance)) + '</td><td>' + html(record.type_name_cn || record.type_name || '-') + '</td><td>' + html(record.description || '-') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    function renderCategories(state) {
        var rows = state.payload && Array.isArray(state.payload.categories) ? state.payload.categories : [];
        if (!rows.length) return '<tr><td colspan="6" class="ps-empty">请选择账号查看分类统计，或当前账号暂无统计数据。</td></tr>';
        return rows.map(function(item) {
            var name = item.name || '未分类';
            var expanded = state.expandedCategory === name;
            return '<tr class="ps-category-row"><td><button class="ps-rt-btn primary ps-expand-btn" data-action="toggle-category" data-name="' + html(name) + '">' + (expanded ? '收起' : '展开') + '</button>' + html(name) + '</td><td>' + number(item.count) + '</td><td class="income">' + number(item.income) + '</td><td class="expense">' + number(item.expense) + '</td><td class="' + amountTone(item.net).trim() + '">' + number(item.net) + '</td><td>' + number((item.records || []).length) + '</td></tr>' + (expanded ? '<tr class="ps-detail-row"><td colspan="6">' + renderDetailTable(item.records || []) + '</td></tr>' : '');
        }).join('');
    }

    function renderLeaderboard(state) {
        var rows = state.payload && Array.isArray(state.payload.leaderboard) ? state.payload.leaderboard : [];
        if (!rows.length) return '<tr><td colspan="6" class="ps-empty">暂无账号排行</td></tr>';
        return rows.map(function(item, index) {
            return '<tr><td>TOP ' + (index + 1) + '</td><td><button class="ps-rank-link" data-action="rank-account" data-username="' + html(item.username || '') + '">' + html(item.username || '-') + '</button></td><td>' + number(item.total_records) + '</td><td class="income">' + number(item.total_income) + '</td><td class="expense">' + number(item.total_expense) + '</td><td class="' + amountTone(item.net_change).trim() + '">' + number(item.net_change) + '</td></tr>';
        }).join('');
    }

    function render(state) {
        var current = state.username ? html(state.username) : '全局排行';
        var badgeText = state.error ? '异常' : state.loading ? '读取中' : state.syncing ? '同步中' : state.username ? '账号视图' : '全局视图';
        return '<div class="ps-rt-root' + ((state.loading || state.syncing) ? ' is-busy' : '') + '"><section class="ps-rt-hero"><div class="ps-rt-hero-top"><div class="ps-rt-title"><strong>点数统计</strong><span>查看 EP/SP/TP/RP 历史流水、分类统计、账号排行和展开明细。</span></div><span class="ps-rt-cache-badge">' + html(badgeText) + '</span></div><div class="ps-rt-account-action-row"><div class="ps-account-wrap"><label class="ps-rt-field"><span>账号</span><input class="ps-rt-input ps-account-input" data-role="account-input" value="' + html(state.accountQuery) + '" placeholder="搜索账号 / 姓名" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">' + renderOptions(state) + '</label></div><div class="ps-rt-action-row"><button class="ps-rt-btn" data-action="load"' + (state.loading ? ' disabled' : '') + '>' + (state.loading ? '读取中' : '读取缓存') + '</button><button class="ps-rt-btn primary" data-action="sync"' + (state.syncing ? ' disabled' : '') + '>' + (state.syncing ? '同步中' : '同步流水') + '</button><button class="ps-rt-btn" data-action="clear-account">清空账号</button></div></div><div class="ps-rt-cache-line ' + (state.error ? 'error' : 'info') + '">' + html(state.status) + '</div></section><section class="ps-rt-stats">' + renderSummary(state) + '</section><section class="ps-rt-controls"><div class="ps-rt-view-tabs">' + renderTabs(state) + '</div></section><section class="ps-rt-path-panel"><div class="ps-rt-scheme-note"><span>' + html(state.pointType) + ' 历史记录</span><span class="meta">' + current + '</span></div><div class="ps-rt-table-wrap"><table><thead><tr><th>统计项</th><th>数量</th><th>收入</th><th>支出</th><th>净变化</th><th>明细</th></tr></thead><tbody>' + renderCategories(state) + '</tbody></table></div></section><section class="ps-rt-path-panel"><div class="ps-rt-scheme-note"><span>账号排行</span><span class="meta">按净变化排序 · ' + html(state.pointType) + '</span></div><div class="ps-rt-table-wrap"><table><thead><tr><th>排名</th><th>账号</th><th>记录数</th><th>收入</th><th>支出</th><th>净变化</th></tr></thead><tbody>' + renderLeaderboard(state) + '</tbody></table></div></section></div>';
    }

    window.AKPointStatsRenderer = {
        render: render
    };
})();
