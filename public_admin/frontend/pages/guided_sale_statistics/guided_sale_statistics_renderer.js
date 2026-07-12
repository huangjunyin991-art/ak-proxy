(function() {
    if (window.AKGuidedSaleStatisticsRenderer) return;

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function number(value) {
        return Number(value || 0).toLocaleString('zh-CN');
    }

    function accountOptions(accounts, selected) {
        var rows = Array.isArray(accounts) ? accounts : [];
        if (!rows.length) return '<div class="ak-gss-account-empty">暂无可用账号</div>';
        return rows.map(function(item) {
            var username = String(item.username || '').trim();
            var nickname = String(item.nickname || '').trim();
            var isSelected = username.toLowerCase() === String(selected || '').toLowerCase();
            return '<button type="button" class="ak-gss-account-option' + (isSelected ? ' is-selected' : '') + '" data-action="choose-account" data-account="' + escapeHtml(username) + '" role="option" aria-selected="' + String(isSelected) + '">' +
                '<span class="ak-gss-account-option-main">' + escapeHtml(username) + '</span>' +
                (nickname ? '<span class="ak-gss-account-option-sub">' + escapeHtml(nickname) + '</span>' : '') +
                '<span class="ak-gss-account-check" aria-hidden="true"></span>' +
            '</button>';
        }).join('');
    }

    function jobMap(jobs) {
        var map = {};
        (Array.isArray(jobs) ? jobs : []).forEach(function(job) {
            map[String(job.target_account || '').toLowerCase()] = job;
        });
        return map;
    }

    function renderAccountRows(accounts, jobs) {
        var map = jobMap(jobs);
        var rows = Array.isArray(accounts) ? accounts : [];
        if (!rows.length) return '<tr><td colspan="3" class="ak-gss-empty">暂无白名单账号</td></tr>';
        return rows.map(function(account) {
            var username = String(account.username || '');
            var job = map[username.toLowerCase()];
            var done = job && job.state === 'completed';
            return '<tr>' +
                '<td><strong>' + escapeHtml(username) + '</strong>' + (account.nickname ? '<span class="ak-gss-nickname">' + escapeHtml(account.nickname) + '</span>' : '') + '</td>' +
                '<td><span class="ak-gss-status ' + (done ? 'is-done' : 'is-pending') + '">' + (done ? '已完成' : '待获取') + '</span></td>' +
                '<td class="ak-gss-number">' + (done ? number(job.matched_count) : '--') + '</td>' +
            '</tr>';
        }).join('');
    }

    function renderRows(rows) {
        var list = Array.isArray(rows) ? rows : [];
        if (!list.length) return '<tr><td colspan="3" class="ak-gss-empty">暂无已匹配的子账号</td></tr>';
        return list.map(function(row) {
            return '<tr><td>' + escapeHtml(row.target_account) + '</td><td><strong>' + escapeHtml(row.child_account) + '</strong></td><td>' + escapeHtml(row.create_time || '--') + '</td></tr>';
        }).join('');
    }

    function runStateLabel(run) {
        var labels = {
            waiting_notice: '等待离线',
            scanning: '正在扫描',
            completed: '已完成',
            expired: '缓存已过期'
        };
        return labels[String(run && run.state || '')] || '准备中';
    }

    function renderNotice(run, source) {
        var account = escapeHtml(source || '未选择账号');
        if (!run || run.state === 'expired') {
            return '<section class="ak-gss-notice is-idle">' +
                '<div class="ak-gss-notice-copy"><span class="ak-gss-eyebrow">最近一次指导销售</span><h2>尚未读取公告</h2><p>来源账号：' + account + '</p></div>' +
                '<span class="ak-gss-notice-state">待获取</span>' +
            '</section>';
        }
        if (!run.title) {
            return '<section class="ak-gss-notice">' +
                '<div class="ak-gss-notice-copy"><span class="ak-gss-eyebrow">最近一次指导销售</span><h2>正在读取公告</h2><p>来源账号：' + account + '</p></div>' +
                '<span class="ak-gss-notice-state">' + escapeHtml(runStateLabel(run)) + '</span>' +
            '</section>';
        }
        var period = run.target_line || [run.start_date_label, run.end_date_label].filter(Boolean).join(' 至 ');
        return '<section class="ak-gss-notice is-ready">' +
            '<div class="ak-gss-notice-copy"><span class="ak-gss-eyebrow">最近一次指导销售</span><h2>第 ' + number(run.sale_count) + ' 次指导销售</h2><p>注册区间 ' + escapeHtml(period || '--') + '</p></div>' +
            '<div class="ak-gss-notice-meta"><span class="ak-gss-notice-state">' + escapeHtml(runStateLabel(run)) + '</span><span>来源 ' + account + '</span></div>' +
        '</section>';
    }

    function renderPicker(accounts, source, inputValue, open, loading) {
        var value = inputValue == null ? source : inputValue;
        return '<div class="ak-gss-account-picker' + (open ? ' is-open' : '') + '">' +
            '<div class="ak-gss-account-control">' +
                '<input type="text" data-field="source_account" value="' + escapeHtml(value || '') + '" placeholder="输入公告来源账号" autocomplete="off" spellcheck="false" aria-label="公告来源账号" ' + (loading ? 'disabled' : '') + '>' +
                '<button type="button" class="ak-gss-picker-toggle" data-action="toggle-account-menu" title="选择公告来源账号" aria-label="选择公告来源账号" ' + (loading ? 'disabled' : '') + '><span aria-hidden="true"></span></button>' +
            '</div>' +
            '<div class="ak-gss-account-menu" role="listbox">' +
                '<div class="ak-gss-account-menu-head"><span>可用账号</span><span>' + number((accounts || []).length) + '</span></div>' +
                '<div class="ak-gss-account-list">' + accountOptions(accounts, source) + '<div class="ak-gss-account-no-match" hidden>没有匹配的账号</div></div>' +
            '</div>' +
        '</div>';
    }

    function render(state) {
        var data = state.data || {};
        var summary = data.summary || {};
        var run = data.run || null;
        var policy = data.policy || {};
        var loading = !!state.loading;
        var source = String(state.sourceAccount || '');
        var inputValue = state.accountInput == null ? source : state.accountInput;
        return '' +
            '<div class="ak-gss-root">' +
                '<section class="ak-gss-toolbar">' +
                    '<div class="ak-gss-title"><span>指导销售统计</span><small>公告解析与白名单子账号扫描</small></div>' +
                    '<div class="ak-gss-actions">' +
                        renderPicker(data.accounts, source, inputValue, state.pickerOpen, loading) +
                        '<button type="button" class="ak-gss-btn primary" data-action="start" ' + (loading ? 'disabled' : '') + '>获取公告</button>' +
                        '<button type="button" class="ak-gss-icon-btn" data-action="refresh" title="刷新当前账号数据" aria-label="刷新当前账号数据" ' + (loading ? 'disabled' : '') + '><span class="ak-gss-refresh-icon" aria-hidden="true"></span></button>' +
                    '</div>' +
                '</section>' +
                (state.error ? '<div class="ak-gss-error" role="alert">' + escapeHtml(state.error) + '</div>' : '') +
                renderNotice(run, source) +
                '<section class="ak-gss-metrics">' +
                    '<div><span>白名单账号</span><strong>' + number(summary.whitelist_accounts) + '</strong></div>' +
                    '<div><span>已完成</span><strong>' + number(summary.completed_accounts) + '</strong></div>' +
                    '<div><span>待获取</span><strong>' + number(summary.pending_accounts) + '</strong></div>' +
                    '<div><span>命中子账号</span><strong>' + number(summary.matched_subaccounts) + '</strong></div>' +
                '</section>' +
                '<section class="ak-gss-section">' +
                    '<div class="ak-gss-section-head"><h3>白名单扫描状态</h3><span>' + number(summary.completed_accounts) + ' / ' + number(summary.whitelist_accounts) + '</span></div>' +
                    '<div class="ak-gss-table-wrap"><table><thead><tr><th>白名单账号</th><th>状态</th><th>命中子账号</th></tr></thead><tbody>' + renderAccountRows(data.accounts, data.jobs) + '</tbody></table></div>' +
                '</section>' +
                '<section class="ak-gss-section">' +
                    '<div class="ak-gss-section-head"><h3>周期内子账号</h3><span>' + number(summary.matched_subaccounts) + ' 条</span></div>' +
                    '<div class="ak-gss-table-wrap"><table><thead><tr><th>白名单账号</th><th>子账号</th><th>注册时间</th></tr></thead><tbody>' + renderRows(data.rows) + '</tbody></table></div>' +
                '</section>' +
                (data.is_super_admin ? '<section class="ak-gss-policy"><label for="akGssCacheDays">缓存保留天数</label><input id="akGssCacheDays" type="number" min="1" max="365" data-field="cache_days" value="' + escapeHtml(policy.cache_retention_days || 30) + '"><button type="button" class="ak-gss-btn" data-action="save-policy">保存</button></section>' : '') +
            '</div>';
    }

    window.AKGuidedSaleStatisticsRenderer = { render: render };
})();
