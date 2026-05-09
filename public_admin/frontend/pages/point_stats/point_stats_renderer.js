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

    function renderSummary(state) {
        var active = activeStats(state);
        if (!active || Number(active.total_records || 0) === 0) {
            return ['记录数', '总收入', '总支出', '净变化', '当前余额'].map(function(label) {
                return '<div class="ps-summary-card"><strong>-</strong><span>' + label + '</span></div>';
            }).join('');
        }
        return [
            '<div class="ps-summary-card"><strong>' + number(active.total_records) + '</strong><span>记录数</span></div>',
            '<div class="ps-summary-card ps-income"><strong>' + number(active.total_income) + '</strong><span>总收入</span></div>',
            '<div class="ps-summary-card ps-expense"><strong>' + number(active.total_expense) + '</strong><span>总支出</span></div>',
            '<div class="ps-summary-card"><strong class="' + amountTone(active.net_change).trim() + '">' + number(active.net_change) + '</strong><span>净变化</span></div>',
            '<div class="ps-summary-card"><strong>' + (active.current_balance == null ? '-' : number(active.current_balance)) + '</strong><span>当前余额</span></div>'
        ].join('');
    }

    function renderTabs(state) {
        return state.types.map(function(type) {
            return '<button class="ps-type-tab' + (type === state.pointType ? ' active' : '') + '" data-action="point-type" data-point-type="' + html(type) + '">' + html(type) + '</button>';
        }).join('');
    }

    function renderOptions(state) {
        if (!state.accountDropdownOpen) return '';
        if (state.accountSearching) return '<div class="ps-account-menu active"><div class="ps-empty compact">搜索中...</div></div>';
        if (!state.accountOptions.length) return '<div class="ps-account-menu active"><div class="ps-empty compact">暂无匹配账号</div></div>';
        return '<div class="ps-account-menu active">' + state.accountOptions.map(function(item, index) {
            return '<button class="ps-account-option' + (index === state.selectedAccountIndex ? ' active' : '') + '" data-action="select-account" data-index="' + index + '"><span><b>' + html(item.real_name || item.username || '-') + '</b><small>' + html(item.username || '-') + '</small></span><em>' + number(item.point_record_count) + ' 条流水</em></button>';
        }).join('') + '</div>';
    }

    function renderLeaderboard(state) {
        var rows = state.payload && Array.isArray(state.payload.leaderboard) ? state.payload.leaderboard : [];
        if (!rows.length) return '<div class="ps-empty">暂无账号排行</div>';
        return rows.map(function(item) {
            return '<button class="ps-rank-card" data-action="rank-account" data-username="' + html(item.username || '') + '"><span class="ps-main-text"><b>' + html(item.username || '-') + '</b><small>' + html(item.point_type || '-') + ' · ' + number(item.total_records) + ' 条流水</small></span><span><em>收入</em><b class="ps-amount-income">' + number(item.total_income) + '</b></span><span><em>支出</em><b class="ps-amount-expense">' + number(item.total_expense) + '</b></span><span><em>净变化</em><b class="' + amountTone(item.net_change).trim() + '">' + number(item.net_change) + '</b></span></button>';
        }).join('');
    }

    function renderRecords(records) {
        if (!records || !records.length) return '<div class="ps-empty compact">暂无明细</div>';
        return '<div class="ps-record-list">' + records.map(function(record) {
            var isIncome = Number(record.operation_type || 0) === 1;
            var tone = isIncome ? 'ps-amount-income' : 'ps-amount-expense';
            return '<article class="ps-record-card"><span class="ps-main-text"><b>' + html(record.description || record.type_name_cn || record.type_name || '-') + '</b><small>' + time(record.time || record.record_time || record.saved_at) + '</small></span><span><em>方向</em><b class="' + tone + '">' + (isIncome ? '收入' : '支出') + '</b></span><span><em>金额</em><b class="' + tone + '">' + signedAmount(record.amount, record.operation_type) + '</b></span><span><em>余额</em><b>' + (record.balance == null ? '-' : number(record.balance)) + '</b></span><span><em>类型</em><b>' + html(record.type_name_cn || record.type_name || '-') + '</b></span></article>';
        }).join('') + '</div>';
    }

    function renderCategories(state) {
        var rows = state.payload && Array.isArray(state.payload.categories) ? state.payload.categories : [];
        if (!rows.length) return '<div class="ps-empty">请选择账号查看分类统计，或当前账号暂无统计数据。</div>';
        return rows.map(function(item) {
            var name = item.name || '未分类';
            var expanded = state.expandedCategory === name;
            return '<article class="ps-category-card"><div class="ps-category-head"><span class="ps-main-text"><b>' + html(name) + '</b><small>' + number((item.records || []).length) + ' 条可展开明细</small></span><span><em>记录数</em><b>' + number(item.count) + '</b></span><span><em>收入</em><b class="ps-amount-income">' + number(item.income) + '</b></span><span><em>支出</em><b class="ps-amount-expense">' + number(item.expense) + '</b></span><span><em>净变化</em><b class="' + amountTone(item.net).trim() + '">' + number(item.net) + '</b></span><button class="ps-toggle" data-action="toggle-category" data-name="' + html(name) + '">' + (expanded ? '收起' : '展开') + '</button></div>' + (expanded ? renderRecords(item.records || []) : '') + '</article>';
        }).join('');
    }

    function render(state) {
        var metaText = state.username ? html(state.username) + ' · ' + html(state.pointType) : '全局 · ' + html(state.pointType);
        return '<div class="ps-root"><section class="ps-hero"><div class="ps-hero-title"><div><strong>点数历史记录统计</strong><span>按账号与 EP/SP/TP/RP 查看已入库流水，写库只通过主动同步触发。</span></div><b>独立模块</b></div><div class="ps-toolbar"><div class="ps-account-search"><input class="ps-account-input" data-role="account-input" value="' + html(state.accountQuery) + '" placeholder="输入账号或姓名模糊搜索" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">' + renderOptions(state) + '</div><button class="ps-primary" data-action="sync"' + (state.syncing ? ' disabled' : '') + '>' + (state.syncing ? '同步中...' : '同步流水') + '</button><button class="ps-button" data-action="load"' + (state.loading ? ' disabled' : '') + '>' + (state.loading ? '读取中...' : '读取统计') + '</button><button class="ps-button" data-action="clear-account">清空账号</button></div><div class="ps-status' + (state.error ? ' error' : '') + '">' + html(state.status) + '</div></section><section class="ps-summary">' + renderSummary(state) + '</section><section class="ps-workspace"><aside class="ps-sidebar"><div class="ps-panel"><div class="ps-panel-head"><span>点数类型</span><em>切换当前流水类型</em></div><div class="ps-type-list">' + renderTabs(state) + '</div></div><div class="ps-panel"><div class="ps-panel-head"><span>账号排行</span><em>按净变化排序</em></div><div class="ps-rank-list">' + renderLeaderboard(state) + '</div></div></aside><main class="ps-main"><div class="ps-panel"><div class="ps-panel-head"><span>' + html(state.pointType) + ' 历史记录</span><em>' + metaText + '</em></div><div class="ps-category-list">' + renderCategories(state) + '</div></div></main></section></div>';
    }

    window.AKPointStatsRenderer = {
        render: render
    };
})();
