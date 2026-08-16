(function() {
    if (window.AKSellLedgerRenderer) return;
    function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function num(value) { return Number(value || 0).toLocaleString('zh-CN'); }
    function time(value) { return value ? String(value).replace('T', ' ').slice(0, 19) : '--'; }
    function source(value) { return value === 'admin_web' ? '网页挂卖' : (value === 'ak_sell_api' ? '自动挂卖' : (value === 'public_rpc' ? '普通RPC' : value || '--')); }
    function stateText(value) {
        var map = {
            success: '已确认成功',
            confirmed: '已确认成功',
            rejected: '上游拒绝',
            failed: '请求失败',
            unknown: '结果未知',
            pending_confirmation: '待余额确认',
            checking: '确认中',
            expired: '确认过期',
            auth_expired: '登录态失效',
            dispatched: '已派发',
            rpc_response: '已收到响应',
            success_unresolved_account: '成功但账号未识别'
        };
        return map[value] || value || '--';
    }
    function stateClass(value) {
        if (value === 'success' || value === 'confirmed') return 'ok';
        if (value === 'unknown' || value === 'pending_confirmation' || value === 'checking' || value === 'dispatched' || value === 'rpc_response') return 'warn';
        if (value === 'rejected' || value === 'failed' || value === 'expired' || value === 'auth_expired') return 'bad';
        return 'muted';
    }
    function render(state) {
        var data = state.data || {}, summary = data.summary || {}, attemptSummary = data.attempt_summary || {}, config = data.config || {}, pagination = data.pagination || {};
        var rows = Array.isArray(data.rows) ? data.rows : [];
        var attempts = Array.isArray(data.attempts) ? data.attempts : [];
        var adminControls = data.is_super_admin ? '<div class="ak-ledger-retention"><span>保留天数</span><input data-field="retention" type="number" min="1" max="3650" value="' + esc(config.retention_days || 365) + '"><button data-action="save-config">保存</button><button class="ak-ledger-clean" data-action="cleanup">清理过期</button></div>' : '';
        var attemptRows = attempts.length ? attempts.map(function(row) {
            var detail = [];
            if (row.trace_id) detail.push('trace ' + row.trace_id);
            if (row.exit_name) detail.push(row.exit_name);
            if (row.status_code) detail.push('HTTP ' + row.status_code);
            if (row.upstream_ms) detail.push(row.upstream_ms + 'ms');
            if (row.last_stage) detail.push(row.last_stage);
            return '<tr><td>' + esc(time(row.updated_at || row.created_at)) + '</td><td><strong>' + esc(row.account || '--') + '</strong></td><td>' + esc(row.sub_account_name || row.sub_account_id || '主账号') + '</td><td class="ak-ledger-amount">' + esc(row.amount || '--') + '</td><td>' + esc(row.endpoint || '--') + '</td><td><span class="ak-ledger-source">' + esc(source(row.source)) + '</span></td><td><span class="ak-ledger-state ak-ledger-state-' + esc(stateClass(row.state)) + '">' + esc(stateText(row.state)) + '</span></td><td>' + esc(row.message || '--') + '</td><td class="ak-ledger-trace">' + esc(detail.join(' · ') || '--') + '</td></tr>';
        }).join('') : '<tr><td colspan="9" class="ak-ledger-empty">暂无挂卖追踪</td></tr>';
        var table = rows.length ? rows.map(function(row) {
            return '<tr><td>' + esc(time(row.sold_at)) + '</td><td><strong>' + esc(row.account || '--') + '</strong></td><td>' + esc(row.sub_account_name || row.sub_account_id || '主账号') + '</td><td class="ak-ledger-amount">' + esc(row.amount || '--') + '</td><td>' + esc(row.endpoint || '--') + '</td><td><span class="ak-ledger-source">' + esc(source(row.source)) + '</span></td><td>' + esc(row.message || '出售成功') + '</td></tr>';
        }).join('') : '<tr><td colspan="7" class="ak-ledger-empty">暂无卖出记录</td></tr>';
        return '<div class="ak-ledger-root">' +
            '<header class="ak-ledger-header"><h2>AK流水</h2><button class="ak-ledger-refresh" data-action="refresh" title="刷新流水">↻ <span>刷新</span></button></header>' +
            (state.error ? '<div class="ak-ledger-alert">' + esc(state.error) + '</div>' : '') +
            '<section class="ak-ledger-metrics"><div><span>卖出记录</span><strong>' + num(summary.records) + '</strong></div><div><span>卖出 AK</span><strong>' + num(summary.amount) + '</strong></div><div><span>待确认</span><strong>' + num(attemptSummary.pending) + '</strong></div><div><span>今日记录</span><strong>' + num(summary.today_records) + '</strong></div></section>' +
            '<section class="ak-ledger-toolbar"><label>账号<input data-field="account" value="' + esc(state.filters.account || '') + '" placeholder="筛选账号"></label><label>来源<select data-field="source"><option value="">全部来源</option><option value="admin_web" ' + (state.filters.source === 'admin_web' ? 'selected' : '') + '>网页挂卖</option><option value="ak_sell_api" ' + (state.filters.source === 'ak_sell_api' ? 'selected' : '') + '>自动挂卖</option><option value="public_rpc" ' + (state.filters.source === 'public_rpc' ? 'selected' : '') + '>普通RPC</option></select></label><button class="ak-ledger-query" data-action="query">查询</button>' + adminControls + '</section>' +
            '<section class="ak-ledger-section"><div class="ak-ledger-section-title"><h3>挂卖追踪</h3><span>最近 50 条请求，超时也会显示在这里</span></div><div class="ak-ledger-table-wrap"><table><thead><tr><th>更新时间</th><th>账号</th><th>子账号</th><th>数量</th><th>接口</th><th>来源</th><th>状态</th><th>提示</th><th>链路</th></tr></thead><tbody>' + attemptRows + '</tbody></table></div></section>' +
            '<section class="ak-ledger-section"><div class="ak-ledger-section-title"><h3>确认成功流水</h3><span>即时成功或余额补确认成功后写入</span></div>' +
            '<section class="ak-ledger-table-wrap"><table><thead><tr><th>卖出时间</th><th>账号</th><th>子账号</th><th>数量</th><th>接口</th><th>来源</th><th>上游提示</th></tr></thead><tbody>' + table + '</tbody></table></section>' +
            '</section>' +
            '<div class="ak-ledger-pagination"><span>第 ' + num(pagination.page || 1) + ' / ' + num(pagination.total_pages || 1) + ' 页，共 ' + num(pagination.total || 0) + ' 条</span><div><button data-action="prev" ' + ((pagination.page || 1) <= 1 ? 'disabled' : '') + '>上一页</button><button data-action="next" ' + ((pagination.page || 1) >= (pagination.total_pages || 1) ? 'disabled' : '') + '>下一页</button></div></div>' +
            '<div class="ak-ledger-note">所有管理员共享同一份流水与保留天数。清理只在总管理员手动确认后执行。</div></div>';
    }
    window.AKSellLedgerRenderer = { render: render };
})();
