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
            var pending = job && job.state === 'pending';
            var status = done ? '已完成' : (pending ? '等待离线' : '待扫描');
            return '<tr>' +
                '<td><strong>' + escapeHtml(username) + '</strong>' + (account.nickname ? '<span class="ak-gss-nickname">' + escapeHtml(account.nickname) + '</span>' : '') + '</td>' +
                '<td><span class="ak-gss-status ' + (done ? 'is-done' : 'is-pending') + '">' + status + '</span></td>' +
                '<td class="ak-gss-number">' + (done ? number(job.matched_count) : '--') + '</td>' +
            '</tr>';
        }).join('');
    }

    function renderRows(rows) {
        var list = Array.isArray(rows) ? rows : [];
        if (!list.length) return '<tr><td colspan="3" class="ak-gss-empty">暂无已匹配的子账号</td></tr>';
        var groups = {};
        list.forEach(function(row) {
            var account = String(row.target_account || '');
            if (!account) return;
            if (!groups[account]) groups[account] = [];
            groups[account].push(row);
        });
        return Object.keys(groups).sort().map(function(account) {
            var children = groups[account];
            var accounts = children.map(function(row) {
                return '<span>' + escapeHtml(row.child_account) + '</span>';
            }).join('');
            var dates = children.map(function(row) {
                return '<span>' + escapeHtml(row.create_time || '--') + '</span>';
            }).join('');
            return '<tr><td><strong>' + escapeHtml(account) + '</strong></td>' +
                '<td><div class="ak-gss-row-stack ak-gss-child-account">' + accounts + '</div></td>' +
                '<td><div class="ak-gss-row-stack ak-gss-child-time">' + dates + '</div></td></tr>';
        }).join('');
    }

    function guidancePeriod(notice) {
        var start = String(notice.start_date_label || '');
        var end = String(notice.end_date_label || '');
        if (start && end) return '注册时间 ' + start + ' - ' + end;
        return String(notice.target_line || '--');
    }

    function renderNotice(data) {
        var notice = data.notice || {};
        var configured = !!data.source_configured;
        if (!configured) {
            return '<section class="ak-gss-notice is-idle"><div class="ak-gss-notice-content"><span class="ak-gss-eyebrow">指导销售公告</span><h2>尚未配置公告来源账号</h2><p>' + (data.is_super_admin ? '配置后将为所有管理员共享公告缓存。' : '等待总管理员配置公告来源账号。') + '</p></div></section>';
        }
        if (!notice.available) {
            var failed = String(notice.error || '');
            var syncing = notice.state === 'refreshing';
            return '<section class="ak-gss-notice ' + (failed ? 'is-error' : 'is-syncing') + '"><div class="ak-gss-notice-content"><h2>' + (failed ? '公告同步失败' : (syncing ? '正在同步公告' : '正在准备公告')) + '</h2><p>' + escapeHtml(failed || (syncing ? '正在读取全局绑定账号的公告。' : '公告将在打开模块时自动同步。')) + '</p></div><span class="ak-gss-notice-state">' + (failed ? '同步失败' : (syncing ? '同步中' : '待同步')) + '</span></section>';
        }
        var updateError = String(notice.error || '');
        return '<section class="ak-gss-notice is-ready"><div class="ak-gss-notice-content"><h2>第 ' + number(notice.sale_count) + ' 次指导销售</h2><p class="ak-gss-notice-detail"><span>指导时间：</span><strong>' + escapeHtml(notice.guidance_time || '--') + '</strong></p><p class="ak-gss-notice-detail"><span>指导周期：</span><strong>' + escapeHtml(guidancePeriod(notice)) + '</strong></p>' + (updateError ? '<p class="ak-gss-notice-error">公告更新失败：' + escapeHtml(updateError) + '</p>' : '') + '</div><span class="ak-gss-notice-state ' + (updateError ? 'is-error' : '') + '">' + (updateError ? '更新失败' : (notice.fresh ? '已缓存' : '待更新')) + '</span></section>';
    }

    function renderSourceSetting(data, loading) {
        if (!data.is_super_admin) return '';
        var notice = data.notice || {};
        return '<div class="ak-gss-source-setting"><label for="akGssSourceAccount">全局绑定账号</label><input id="akGssSourceAccount" data-field="source_account" type="text" value="' + escapeHtml(notice.source_account || '') + '" placeholder="输入账号" autocomplete="off" spellcheck="false" ' + (loading ? 'disabled' : '') + '><button type="button" class="ak-gss-btn" data-action="save-source" ' + (loading ? 'disabled' : '') + '>保存</button></div>';
    }

    function render(state) {
        var data = state.data || {};
        var summary = data.summary || {};
        var policy = data.policy || {};
        var loading = !!state.loading;
        return '' +
            '<div class="ak-gss-root">' +
                '<section class="ak-gss-toolbar">' +
                    '<div class="ak-gss-title"><span>指导销售统计</span><small>公告共享缓存与白名单子账号扫描</small></div>' +
                    '<div class="ak-gss-actions">' + renderSourceSetting(data, loading) +
                        ((data.notice || {}).fresh ? '<button type="button" class="ak-gss-btn ak-gss-btn-primary" data-action="start-scan" ' + (loading ? 'disabled' : '') + '>扫描子账号</button>' : '') +
                    '</div>' +
                '</section>' +
                (state.error ? '<div class="ak-gss-error" role="alert">' + escapeHtml(state.error) + '</div>' : '') +
                renderNotice(data) +
                '<section class="ak-gss-metrics">' +
                    '<div><span>白名单账号</span><strong>' + number(summary.whitelist_accounts) + '</strong></div>' +
                    '<div><span>已完成</span><strong>' + number(summary.completed_accounts) + '</strong></div>' +
                    '<div><span>等待扫描</span><strong>' + number(summary.pending_accounts) + '</strong></div>' +
                    '<div><span>被指导账号</span><strong>' + number(summary.matched_subaccounts) + '</strong></div>' +
                '</section>' +
                '<section class="ak-gss-section">' +
                    '<div class="ak-gss-section-head"><h3>白名单扫描状态</h3><span>' + number(summary.completed_accounts) + ' / ' + number(summary.whitelist_accounts) + '</span></div>' +
                    '<div class="ak-gss-table-wrap"><table><thead><tr><th>白名单账号</th><th>状态</th><th>被指导账号</th></tr></thead><tbody>' + renderAccountRows(data.accounts, data.jobs) + '</tbody></table></div>' +
                '</section>' +
                '<section class="ak-gss-section">' +
                    '<div class="ak-gss-section-head"><h3>指导周期内子账号</h3><span>' + number(summary.matched_subaccounts) + ' 条</span></div>' +
                    '<div class="ak-gss-table-wrap"><table><thead><tr><th>白名单账号</th><th>子账号</th><th>注册时间</th></tr></thead><tbody>' + renderRows(data.rows) + '</tbody></table></div>' +
                '</section>' +
                (data.is_super_admin ? '<section class="ak-gss-policy"><label for="akGssCacheDays">扫描结果保留天数</label><input id="akGssCacheDays" type="number" min="1" max="365" data-field="cache_days" value="' + escapeHtml(policy.cache_retention_days || 30) + '"><button type="button" class="ak-gss-btn" data-action="save-policy">保存</button></section>' : '') +
            '</div>';
    }

    window.AKGuidedSaleStatisticsRenderer = { render: render };
})();
