(function() {
    if (window.AKEPAutoPurchaseRenderer) return;

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function number(value) { return Number(value || 0).toLocaleString('zh-CN'); }

    function shortTime(value) {
        var text = String(value || '').trim();
        return text ? text.replace('T', ' ').slice(0, 19) : '--';
    }

    function stateMeta(state) {
        var values = {
            ready: ['正常', 'is-ok'],
            waiting: ['用户优先', 'is-wait'],
            rate_limited: ['暂缓', 'is-warn'],
            error: ['异常', 'is-error'],
            idle: ['待运行', 'is-idle']
        };
        return values[state] || values.idle;
    }

    function orderMeta(state) {
        var values = {
            success: ['购买成功', 'is-ok'],
            rejected: ['未成交', 'is-warn'],
            unknown: ['结果未知', 'is-error'],
            claimed: ['已占位', 'is-wait']
        };
        return values[state] || [String(state || '未知'), 'is-idle'];
    }

    function renderAccountRows(rows) {
        var items = Array.isArray(rows) ? rows : [];
        if (!items.length) return '<tr class="ak-ep-empty-row"><td colspan="7" class="ak-ep-empty">尚未配置抢分账号</td></tr>';
        return items.map(function(item) {
            var meta = stateMeta(item.state);
            return '<tr>' +
                '<td><strong>' + escapeHtml(item.account) + '</strong></td>' +
                '<td><span class="ak-ep-state ' + meta[1] + '">' + meta[0] + '</span></td>' +
                '<td>' + number(item.total_polls) + '</td>' +
                '<td>' + number(item.listings_seen) + '</td>' +
                '<td class="ak-ep-success-number">' + number(item.purchase_successes) + '</td>' +
                '<td>' + escapeHtml(shortTime(item.last_poll_at)) + '</td>' +
                '<td class="ak-ep-error-cell">' + escapeHtml(item.last_error || '--') + '</td>' +
            '</tr>';
        }).join('');
    }

    function renderOrderRows(rows) {
        var items = Array.isArray(rows) ? rows : [];
        if (!items.length) return '<tr class="ak-ep-empty-row"><td colspan="7" class="ak-ep-empty">暂无购买记录</td></tr>';
        return items.map(function(item) {
            var meta = orderMeta(item.state);
            return '<tr>' +
                '<td><strong>#' + escapeHtml(item.sid) + '</strong></td>' +
                '<td>' + escapeHtml(item.buyer_account || '--') + '</td>' +
                '<td>' + escapeHtml(item.seller_account || '--') + '</td>' +
                '<td>' + escapeHtml(item.ep_amount || '--') + '</td>' +
                '<td><span class="ak-ep-state ' + meta[1] + '">' + meta[0] + '</span></td>' +
                '<td>' + escapeHtml(item.message || '--') + '</td>' +
                '<td>' + escapeHtml(shortTime(item.claimed_at)) + '</td>' +
            '</tr>';
        }).join('');
    }

    function render(state) {
        var data = state.data || {};
        var config = data.config || {};
        var accounts = Array.isArray(config.accounts) ? config.accounts : [];
        var statuses = Array.isArray(data.accounts) ? data.accounts : [];
        var summary = data.summary || {};
        var totalPolls = statuses.reduce(function(total, item) { return total + Number(item.total_polls || 0); }, 0);
        var listings = statuses.reduce(function(total, item) { return total + Number(item.listings_seen || 0); }, 0);
        var enabled = !!config.enabled;
        var loading = !!state.loading;
        var current = String(config.current_account || '');
        return '<div class="ak-ep-root">' +
            '<header class="ak-ep-toolbar">' +
                '<div class="ak-ep-heading"><h2>EP 自动抢购</h2><span>' + number(accounts.length) + ' 个轮转账号</span></div>' +
                '<span class="ak-ep-run-state ' + (enabled ? 'is-running' : '') + '"><i></i>' + (enabled ? '运行中' : '已停用') + '</span>' +
            '</header>' +
            (state.error ? '<div class="ak-ep-alert" role="alert">' + escapeHtml(state.error) + '</div>' : '') +
            '<section class="ak-ep-workspace">' +
                '<div class="ak-ep-config-pane">' +
                    '<div class="ak-ep-pane-title"><strong>执行配置</strong><span>全局任务</span></div>' +
                    '<div class="ak-ep-config-grid">' +
                        '<div class="ak-ep-field ak-ep-account-field"><label for="akEpAccounts">抢分账号</label>' +
                            '<textarea id="akEpAccounts" data-field="accounts" rows="3" spellcheck="false" autocomplete="off" placeholder="每行一个账号" ' + (loading ? 'disabled' : '') + '>' + escapeHtml(accounts.join('\n')) + '</textarea></div>' +
                        '<div class="ak-ep-field ak-ep-interval-field"><label for="akEpInterval">抢分间隔</label><div class="ak-ep-number-input">' +
                            '<input id="akEpInterval" data-field="interval" type="number" min="1" max="3600" step="1" value="' + escapeHtml(config.interval_seconds || 1) + '" ' + (loading ? 'disabled' : '') + '><span>秒</span></div></div>' +
                        '<div class="ak-ep-actions">' +
                            '<label class="ak-ep-toggle"><input type="checkbox" data-field="enabled" ' + (enabled ? 'checked' : '') + ' ' + (loading ? 'disabled' : '') + '><span></span><b>自动抢购</b></label>' +
                            '<button type="button" class="ak-ep-save" data-action="save" ' + (loading ? 'disabled' : '') + '>' +
                                '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h12l2 2v14H5z"/><path d="M8 4v6h8V4"/><path d="M8 20v-6h8v6"/></svg><span>保存配置</span></button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="ak-ep-summary-pane">' +
                    '<div class="ak-ep-pane-title"><strong>运行摘要</strong><span>' + (enabled ? '任务已启用' : '任务未启用') + '</span></div>' +
                    '<div class="ak-ep-metrics">' +
                        '<div class="ak-ep-metric"><span>轮转账号</span><strong>' + number(accounts.length) + '</strong></div>' +
                        '<div class="ak-ep-metric is-cyan"><span>累计轮询</span><strong>' + number(totalPolls) + '</strong></div>' +
                        '<div class="ak-ep-metric is-yellow"><span>发现挂单</span><strong>' + number(listings) + '</strong></div>' +
                        '<div class="ak-ep-metric is-green"><span>购买成功</span><strong>' + number(summary.successes) + '</strong></div>' +
                    '</div>' +
                    '<div class="ak-ep-scheduler"><div><span>当前账号</span><strong>' + escapeHtml(current || '等待轮转') + '</strong></div>' +
                        '<div><span>下次轮询</span><strong>' + escapeHtml(shortTime(config.next_poll_at)) + '</strong></div></div>' +
                '</div>' +
            '</section>' +
            '<section class="ak-ep-section"><header><h3>账号运行状态</h3><span>' + number(statuses.length) + ' 个账号</span></header>' +
                '<div class="ak-ep-table-wrap"><table><thead><tr><th>账号</th><th>状态</th><th>轮询</th><th>挂单</th><th>成交</th><th>最近轮询</th><th>最近异常</th></tr></thead><tbody>' + renderAccountRows(statuses) + '</tbody></table></div></section>' +
            '<section class="ak-ep-section"><header><h3>订单执行记录</h3><span>' + number(summary.orders) + ' 条</span></header>' +
                '<div class="ak-ep-table-wrap"><table><thead><tr><th>订单</th><th>抢分账号</th><th>挂卖账号</th><th>EP</th><th>结果</th><th>信息</th><th>时间</th></tr></thead><tbody>' + renderOrderRows(data.orders) + '</tbody></table></div></section>' +
        '</div>';
    }

    window.AKEPAutoPurchaseRenderer = { render: render };
})();
