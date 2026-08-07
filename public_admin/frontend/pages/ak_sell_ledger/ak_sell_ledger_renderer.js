(function() {
    if (window.AKSellLedgerRenderer) return;
    function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function num(value) { return Number(value || 0).toLocaleString('zh-CN'); }
    function time(value) { return value ? String(value).replace('T', ' ').slice(0, 19) : '--'; }
    function source(value) { return value === 'admin_web' ? '网页挂卖' : (value === 'ak_sell_api' ? '自动挂卖' : value || '--'); }
    function render(state) {
        var data = state.data || {}, summary = data.summary || {}, config = data.config || {}, pagination = data.pagination || {};
        var rows = Array.isArray(data.rows) ? data.rows : [];
        var adminControls = data.is_super_admin ? '<div class="ak-ledger-retention"><span>保留天数</span><input data-field="retention" type="number" min="1" max="3650" value="' + esc(config.retention_days || 365) + '"><button data-action="save-config">保存</button><button class="ak-ledger-clean" data-action="cleanup">清理过期</button></div>' : '';
        var table = rows.length ? rows.map(function(row) {
            return '<tr><td>' + esc(time(row.sold_at)) + '</td><td><strong>' + esc(row.account || '--') + '</strong></td><td>' + esc(row.sub_account_name || row.sub_account_id || '主账号') + '</td><td class="ak-ledger-amount">' + esc(row.amount || '--') + '</td><td>' + esc(row.endpoint || '--') + '</td><td><span class="ak-ledger-source">' + esc(source(row.source)) + '</span></td><td>' + esc(row.message || '出售成功') + '</td></tr>';
        }).join('') : '<tr><td colspan="7" class="ak-ledger-empty">暂无卖出记录</td></tr>';
        return '<div class="ak-ledger-root">' +
            '<header class="ak-ledger-header"><div><div class="ak-ledger-kicker">AK SELL LEDGER</div><h2>AK 卖出流水</h2><p>记录通过代理完成的成功挂卖，账号资料与登录凭据不会写入流水。</p></div><button class="ak-ledger-refresh" data-action="refresh" title="刷新流水">↻ <span>刷新</span></button></header>' +
            (state.error ? '<div class="ak-ledger-alert">' + esc(state.error) + '</div>' : '') +
            '<section class="ak-ledger-metrics"><div><span>卖出记录</span><strong>' + num(summary.records) + '</strong></div><div><span>卖出 AK</span><strong>' + num(summary.amount) + '</strong></div><div><span>涉及账号</span><strong>' + num(summary.accounts) + '</strong></div><div><span>今日记录</span><strong>' + num(summary.today_records) + '</strong></div></section>' +
            '<section class="ak-ledger-toolbar"><label>账号<input data-field="account" value="' + esc(state.filters.account || '') + '" placeholder="筛选账号"></label><label>来源<select data-field="source"><option value="">全部来源</option><option value="admin_web" ' + (state.filters.source === 'admin_web' ? 'selected' : '') + '>网页挂卖</option><option value="ak_sell_api" ' + (state.filters.source === 'ak_sell_api' ? 'selected' : '') + '>自动挂卖</option></select></label><button class="ak-ledger-query" data-action="query">查询</button>' + adminControls + '</section>' +
            '<section class="ak-ledger-table-wrap"><table><thead><tr><th>卖出时间</th><th>账号</th><th>子账号</th><th>数量</th><th>接口</th><th>来源</th><th>上游提示</th></tr></thead><tbody>' + table + '</tbody></table></section>' +
            '<div class="ak-ledger-pagination"><span>第 ' + num(pagination.page || 1) + ' / ' + num(pagination.total_pages || 1) + ' 页，共 ' + num(pagination.total || 0) + ' 条</span><div><button data-action="prev" ' + ((pagination.page || 1) <= 1 ? 'disabled' : '') + '>上一页</button><button data-action="next" ' + ((pagination.page || 1) >= (pagination.total_pages || 1) ? 'disabled' : '') + '>下一页</button></div></div>' +
            '<div class="ak-ledger-note">所有管理员共享同一份流水与保留天数。清理只在总管理员手动确认后执行。</div></div>';
    }
    window.AKSellLedgerRenderer = { render: render };
})();
