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

    function quotaIsExhaustedForButton(state) {
        var q = state.quota || {};
        if (q.isSuperAdmin) return false;
        var limit = q.limit == null ? 3 : Number(q.limit);
        var used = Number(q.usedCount || 0);
        if (used < limit) return false;
        var current = String(state.username || '').toLowerCase();
        if (!current) return true;
        return (q.usedAccounts || []).indexOf(current) < 0;
    }

    function renderQuotaLine(state) {
        var q = state.quota || {};
        if (q.isSuperAdmin) {
            return '<div class="ps-rt-quota-line super">超管：今日不限次数</div>';
        }
        var limit = q.limit == null ? 3 : Number(q.limit);
        var used = Number(q.usedCount || 0);
        var cls = used >= limit ? 'exhausted' : (used > 0 ? 'active' : '');
        return '<div class="ps-rt-quota-line ' + cls + '">今日 <b>' + used + '</b>/' + limit + ' 个账号</div>';
    }

    function rankClassOf(label) {
        var raw = String(label || 'M0').toUpperCase();
        if (raw.charAt(0) === 'A') {
            return 'a-rank level-5';
        }
        var n = parseInt(raw.slice(1), 10);
        if (!isFinite(n)) n = 0;
        if (n < 0) n = 0;
        if (n > 5) n = 5;
        return 'level-' + n;
    }

    function renderOptions(state) {
        if (!state.accountDropdownOpen) return '';
        if (state.accountSearching) return '<div class="ps-account-menu active"><div class="ps-empty compact">搜索中...</div></div>';
        if (!state.accountOptions.length) return '<div class="ps-account-menu active"><div class="ps-empty compact">暂无匹配账号</div></div>';
        return '<div class="ps-account-menu active">' + state.accountOptions.map(function(item, index) {
            var rankLabel = String(item.honor_name || 'M0').toUpperCase();
            var rankClass = rankClassOf(rankLabel);
            return '<button class="ps-account-option ' + rankClass + (index === state.selectedAccountIndex ? ' active' : '') + '" data-action="select-account" data-index="' + index + '">' +
                '<span class="ps-account-option-main"><b>' + html(item.username || '-') + '</b><small>' + html(item.real_name || '未记录姓名') + '</small></span>' +
                '<span class="ps-account-rank ' + rankClass + '">' + html(rankLabel) + '</span>' +
            '</button>';
        }).join('') + '</div>';
    }

    function renderSummary(state) {
        var active = activeStats(state);
        var items = [
            ['记录数', active ? active.total_records : null, ''],
            ['总收入', active ? active.total_income : null, 'income'],
            ['总支出', active ? active.total_expense : null, 'expense'],
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

    function renderDetailTable(records, category, page, pageSize) {
        if (!records || !records.length) return '<div class="ps-empty compact">暂无明细</div>';
        var total = records.length;
        var size = Math.max(1, parseInt(pageSize, 10) || 50);
        var totalPages = Math.max(1, Math.ceil(total / size));
        var current = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);
        var start = (current - 1) * size;
        var slice = records.slice(start, start + size);
        var nameAttr = html(category || '');
        var firstDisabled = current <= 1;
        var lastDisabled = current >= totalPages;
        var rangeFrom = total === 0 ? 0 : start + 1;
        var rangeTo = Math.min(start + size, total);
        var pager = '<div class="ps-detail-pager">' +
            '<div class="ps-detail-pager-btns">' +
            '<button class="ps-rt-btn" data-action="detail-page" data-name="' + nameAttr + '" data-target="first"' + (firstDisabled ? ' disabled' : '') + '>首页</button>' +
            '<button class="ps-rt-btn" data-action="detail-page" data-name="' + nameAttr + '" data-target="prev"' + (firstDisabled ? ' disabled' : '') + '>上一页</button>' +
            '<button class="ps-rt-btn primary" data-action="detail-page" data-name="' + nameAttr + '" data-target="next"' + (lastDisabled ? ' disabled' : '') + '>下一页</button>' +
            '<button class="ps-rt-btn" data-action="detail-page" data-name="' + nameAttr + '" data-target="last"' + (lastDisabled ? ' disabled' : '') + '>末页</button>' +
            '</div>' +
            '<span class="ps-detail-pager-info">共 ' + number(total) + ' 条，第 ' + number(current) + ' / ' + number(totalPages) + ' 页，当前显示 ' + number(rangeFrom) + '-' + number(rangeTo) + '</span>' +
            '</div>';
        var body = '<div class="ps-rt-detail-wrap"><table class="ps-detail-table"><thead><tr><th>时间</th><th>方向</th><th>金额</th><th>余额</th><th>类型</th><th>描述</th></tr></thead><tbody>' + slice.map(function(record) {
            var isIncome = Number(record.operation_type || 0) === 1;
            var tone = isIncome ? 'income' : 'expense';
            return '<tr><td>' + html(time(record.time || record.record_time || record.saved_at)) + '</td><td class="' + tone + '">' + recordDirection(record) + '</td><td class="' + tone + '">' + signedAmount(record.amount, record.operation_type) + '</td><td>' + (record.balance == null ? '-' : number(record.balance)) + '</td><td>' + html(record.type_name_cn || record.type_name || '-') + '</td><td>' + html(record.description_display || record.description || '-') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
        return body + pager;
    }

    function renderCategories(state) {
        var rows = state.payload && Array.isArray(state.payload.categories) ? state.payload.categories : [];
        if (!rows.length) return '<tr><td colspan="5" class="ps-empty">请选择账号查看分类统计，或当前账号暂无统计数据。</td></tr>';
        var pageSize = state.detailPageSize || 50;
        var pageMap = state.detailPageMap || {};
        return rows.map(function(item) {
            var name = item.name || '未分类';
            var expanded = state.expandedCategory === name;
            var page = pageMap[name] || 1;
            return '<tr class="ps-category-row"><td><button class="ps-rt-btn primary ps-expand-btn" data-action="toggle-category" data-name="' + html(name) + '">' + (expanded ? '收起' : '展开') + '</button>' + html(name) + '</td><td>' + number(item.count) + '</td><td class="income">' + number(item.income) + '</td><td class="expense">' + number(item.expense) + '</td><td class="' + amountTone(item.net).trim() + '">' + number(item.net) + '</td></tr>' + (expanded ? '<tr class="ps-detail-row"><td colspan="5">' + renderDetailTable(item.records || [], name, page, pageSize) + '</td></tr>' : '');
        }).join('');
    }

    function renderPanelMeta(state) {
        var payload = state.payload || {};
        var parts = [];
        if (payload.source) parts.push(payload.source === 'remote' ? '远端拉取' : '本地缓存');
        if (payload.saved != null) parts.push('保存 ' + number(payload.saved) + ' 条');
        if (payload.pages_fetched != null) parts.push('页数 ' + number(payload.pages_fetched));
        if (payload.stop_reason) parts.push(html(payload.stop_reason));
        if (!parts.length) parts.push(state.username ? html(state.username) : 'cache');
        return parts.join(' · ');
    }

    function render(state) {
        var btnDisabled = quotaIsExhaustedForButton(state);
        var btnLabel = state.syncing ? '拉取中' : (btnDisabled ? '额度已满' : '数据统计');
        var btnAttr = btnDisabled && !state.syncing ? ' disabled' : '';
        return [
            '<div class="ps-rt-root' + ((state.loading || state.syncing) ? ' is-busy' : '') + '">',
            '<section class="ps-rt-hero">',
            '<div class="ps-rt-account-action-row"><div class="ps-account-wrap"><label class="ps-rt-field"><input class="ps-rt-input ps-account-input" data-role="account-input" value="' + html(state.accountQuery) + '" placeholder="请输入账号" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></label>' + renderOptions(state) + '</div><div class="ps-rt-action-stack"><button class="ps-rt-btn primary" data-action="sync"' + btnAttr + '>' + html(btnLabel) + '</button>' + renderQuotaLine(state) + '</div></div>',
            '<div class="ps-rt-cache-line ' + (state.error ? 'error' : 'info') + '">' + html(state.status) + '</div>',
            '</section>',
            '<section class="ps-rt-stats">' + renderSummary(state) + '</section>',
            '<section class="ps-rt-view-shell"><section class="ps-rt-controls"><div class="ps-rt-view-tabs">' + renderTabs(state) + '</div></section>',
            '<section class="ps-rt-path-panel"><div class="ps-rt-table-wrap"><table><thead><tr><th>统计类型</th><th>数量</th><th>收入</th><th>支出</th><th>净变化</th></tr></thead><tbody>' + renderCategories(state) + '</tbody></table></div></section></section>',
            '</div>'
        ].join('');
    }

    window.AKPointStatsRenderer = {
        render: render
    };
})();
