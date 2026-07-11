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
        var initial = '<option value="">选择公告查询账号</option>';
        return initial + rows.map(function(item) {
            var username = String(item.username || '').trim();
            var nickname = String(item.nickname || '').trim();
            var label = nickname ? username + ' · ' + nickname : username;
            return '<option value="' + escapeHtml(username) + '"' + (username === selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
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
        if (!list.length) return '<tr><td colspan="3" class="ak-gss-empty">暂无已完成数据</td></tr>';
        return list.map(function(row) {
            return '<tr><td>' + escapeHtml(row.target_account) + '</td><td><strong>' + escapeHtml(row.child_account) + '</strong></td><td>' + escapeHtml(row.create_time || '--') + '</td></tr>';
        }).join('');
    }

    function render(state) {
        var data = state.data || {};
        var summary = data.summary || {};
        var run = data.run || null;
        var policy = data.policy || {};
        var loading = !!state.loading;
        var source = String(state.sourceAccount || '');
        var announcement = run && run.state !== 'expired' ?
            '<div class="ak-gss-notice"><div><span class="ak-gss-eyebrow">最近指导销售</span><strong>' + escapeHtml(run.title || '公告已识别') + '</strong><span>' + escapeHtml(run.target_line || (run.start_date_label + ' 至 ' + run.end_date_label)) + '</span></div><div class="ak-gss-sale-count">第 ' + number(run.sale_count) + ' 次</div></div>' :
            '<div class="ak-gss-notice is-empty"><span>选择白名单账号后开始获取公告</span></div>';
        return '' +
            '<div class="ak-gss-root">' +
                '<section class="ak-gss-toolbar">' +
                    '<div class="ak-gss-title"><span>指导销售统计</span><small>结果自动补齐</small></div>' +
                    '<div class="ak-gss-actions">' +
                        '<select data-field="source_account" ' + (loading ? 'disabled' : '') + '>' + accountOptions(data.accounts, source) + '</select>' +
                        '<button type="button" class="ak-gss-btn primary" data-action="start" ' + (!source || loading ? 'disabled' : '') + '>获取</button>' +
                        '<button type="button" class="ak-gss-icon-btn" data-action="refresh" title="刷新">↻</button>' +
                    '</div>' +
                '</section>' +
                (state.error ? '<div class="ak-gss-error">' + escapeHtml(state.error) + '</div>' : '') +
                announcement +
                '<section class="ak-gss-metrics">' +
                    '<div><span>白名单账号</span><strong>' + number(summary.whitelist_accounts) + '</strong></div>' +
                    '<div><span>已完成</span><strong>' + number(summary.completed_accounts) + '</strong></div>' +
                    '<div><span>待获取</span><strong>' + number(summary.pending_accounts) + '</strong></div>' +
                    '<div><span>子账号命中</span><strong>' + number(summary.matched_subaccounts) + '</strong></div>' +
                '</section>' +
                '<section class="ak-gss-section">' +
                    '<div class="ak-gss-section-head"><h3>白名单扫描状态</h3></div>' +
                    '<div class="ak-gss-table-wrap"><table><thead><tr><th>白名单账号</th><th>状态</th><th>命中子账号</th></tr></thead><tbody>' + renderAccountRows(data.accounts, data.jobs) + '</tbody></table></div>' +
                '</section>' +
                '<section class="ak-gss-section">' +
                    '<div class="ak-gss-section-head"><h3>周期内子账号</h3></div>' +
                    '<div class="ak-gss-table-wrap"><table><thead><tr><th>白名单账号</th><th>子账号</th><th>注册时间</th></tr></thead><tbody>' + renderRows(data.rows) + '</tbody></table></div>' +
                '</section>' +
                (data.is_super_admin ? '<section class="ak-gss-policy"><label>缓存保留天数<input type="number" min="1" max="365" data-field="cache_days" value="' + escapeHtml(policy.cache_retention_days || 30) + '"></label><button type="button" class="ak-gss-btn" data-action="save-policy">保存</button></section>' : '') +
            '</div>';
    }

    window.AKGuidedSaleStatisticsRenderer = { render: render };
})();
