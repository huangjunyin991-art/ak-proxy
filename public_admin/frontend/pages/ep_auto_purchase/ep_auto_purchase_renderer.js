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
        if (state === 'pending') return ['\u5f85\u63d0\u4ea4', 'is-wait'];
        if (state === 'sending') return ['\u63d0\u4ea4\u4e2d', 'is-wait'];
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
                '<td>' + number(item.unique_listings_discovered) + '</td>' +
                '<td class="ak-ep-success-number">' + number(item.purchase_successes) + '</td>' +
                '<td>' + escapeHtml(shortTime(item.last_poll_at)) + '</td>' +
                '<td class="ak-ep-error-cell">' + escapeHtml(item.last_error || '--') + '</td>' +
            '</tr>';
        }).join('');
    }

    function renderOrderRows(rows, hasTradingPassword, confirmingSid) {
        var items = Array.isArray(rows) ? rows : [];
        if (!items.length) return '<tr class="ak-ep-empty-row"><td colspan="8" class="ak-ep-empty">暂无购买记录</td></tr>';
        return items.map(function(item) {
            var meta = orderMeta(item.state);
            var paymentState = String(item.payment_state || 'pending');
            var action = '<span class="ak-ep-payment is-not-applicable">--</span>';
            if (item.state === 'success') {
                if (paymentState === 'confirmed') {
                    action = '<button type="button" class="ak-ep-payment is-paid" disabled><i>✓</i>已付款</button>';
                } else if (paymentState === 'confirming' || String(confirmingSid || '') === String(item.sid || '')) {
                    action = '<span class="ak-ep-payment is-confirming"><i></i>确认中</span>';
                } else if (paymentState === 'unknown') {
                    action = '<span class="ak-ep-payment is-unknown">结果未知</span>';
                } else if (!hasTradingPassword) {
                    action = '<button type="button" class="ak-ep-confirm-payment is-disabled" disabled title="请先设置交易密码">确认付款</button>';
                } else {
                    action = '<button type="button" class="ak-ep-confirm-payment" data-action="confirm-payment" data-sid="' + escapeHtml(item.sid) + '">确认付款</button>';
                }
            }
            return '<tr>' +
                '<td><strong>#' + escapeHtml(item.sid) + '</strong></td>' +
                '<td>' + escapeHtml(item.buyer_account || '--') + '</td>' +
                '<td>' + escapeHtml(item.seller_account || '--') + '</td>' +
                '<td>' + escapeHtml(item.ep_amount || '--') + '</td>' +
                '<td><span class="ak-ep-state ' + meta[1] + '">' + meta[0] + '</span></td>' +
                '<td>' + escapeHtml(item.message || '--') + '</td>' +
                '<td>' + escapeHtml(shortTime(item.claimed_at)) + '</td>' +
                '<td>' + action + '</td>' +
            '</tr>';
        }).join('');
    }

    function renderCredentialRows(rows, loading) {
        var items = Array.isArray(rows) ? rows : [];
        if (!items.length) {
            return '<tr class="ak-ep-credential-empty"><td colspan="4">尚未添加抢分账号</td></tr>';
        }
        return items.map(function(item, index) {
            var hasInput = !!String(item.password || '');
            var hasSaved = !!item.has_password;
            var stateClass = hasInput ? 'is-pending' : (hasSaved ? 'is-saved' : 'is-missing');
            var stateText = hasInput ? '待更新' : (hasSaved ? '已有密码' : '需要密码');
            var placeholder = hasSaved ? '留空使用已保存密码' : '请输入登录密码';
            return '<tr data-account-row data-index="' + index + '">' +
                '<td data-label="账号"><input class="ak-ep-row-input" data-field="account" type="text" value="' + escapeHtml(item.account || '') + '" placeholder="账号" autocomplete="off" spellcheck="false" aria-label="抢分账号" ' + (loading ? 'disabled' : '') + '></td>' +
                '<td data-label="登录密码"><input class="ak-ep-row-input" data-field="password" type="password" value="' + escapeHtml(item.password || '') + '" placeholder="' + placeholder + '" autocomplete="new-password" aria-label="登录密码" ' + (loading ? 'disabled' : '') + '></td>' +
                '<td data-label="密码状态"><span class="ak-ep-credential-state ' + stateClass + '" data-password-state><i></i>' + stateText + '</span></td>' +
                '<td class="ak-ep-row-action"><button type="button" class="ak-ep-remove-account" data-action="remove-account" data-index="' + index + '" title="删除账号" aria-label="删除账号" ' + (loading ? 'disabled' : '') + '>' +
                    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></td>' +
            '</tr>';
        }).join('');
    }

    function render(state) {
        var data = state.data || {};
        var config = data.config || {};
        var savedRows = Array.isArray(config.account_rows) ? config.account_rows : [];
        var accountRows = Array.isArray(state.draftAccounts) ? state.draftAccounts : savedRows;
        if (!accountRows.length && Array.isArray(config.accounts)) {
            accountRows = config.accounts.map(function(account) {
                return { account: account, password: '', has_password: false };
            });
        }
        var statuses = Array.isArray(data.accounts) ? data.accounts : [];
        var summary = data.summary || {};
        var totalPolls = statuses.reduce(function(total, item) { return total + Number(item.total_polls || 0); }, 0);
        var listings = statuses.reduce(function(total, item) { return total + Number(item.unique_listings_discovered || 0); }, 0);
        var enabled = !!config.enabled;
        var loading = !!state.loading;
        var current = String(config.current_account || '');
        return '<div class="ak-ep-root">' +
            '<header class="ak-ep-toolbar">' +
                '<div class="ak-ep-heading"><h2>EP 自动抢购</h2></div>' +
                '<span class="ak-ep-run-state ' + (enabled ? 'is-running' : '') + '"><i></i>' + (enabled ? '运行中' : '已停用') + '</span>' +
            '</header>' +
            (state.error ? '<div class="ak-ep-alert" role="alert">' + escapeHtml(state.error) + '</div>' : '') +
            '<section class="ak-ep-workspace">' +
                '<div class="ak-ep-config-pane">' +
                    '<div class="ak-ep-pane-title"><strong>执行配置</strong><span>全局任务</span></div>' +
                    '<div class="ak-ep-config-grid">' +
                        '<div class="ak-ep-account-editor"><div class="ak-ep-editor-heading"><div><strong>抢分账号</strong><span>按表格顺序轮转</span></div>' +
                            '<button type="button" class="ak-ep-add-account" data-action="add-account" ' + (loading ? 'disabled' : '') + '>' +
                                '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>添加账号</span></button></div>' +
                            '<div class="ak-ep-credential-table-wrap"><table class="ak-ep-credential-table"><thead><tr><th>账号</th><th>登录密码</th><th>密码状态</th><th></th></tr></thead><tbody>' + renderCredentialRows(accountRows, loading) + '</tbody></table></div></div>' +
                        '<div class="ak-ep-control-row"><div class="ak-ep-control-fields"><div class="ak-ep-field"><label for="akEpTradingPassword">交易密码</label><input id="akEpTradingPassword" data-field="trading-password" type="password" autocomplete="new-password" placeholder="' + (config.has_trading_password ? '留空使用已保存密码' : '请输入交易密码') + '" ' + (loading ? 'disabled' : '') + '><span class="ak-ep-secret-status ' + (config.has_trading_password ? 'is-set' : '') + '">' + (config.has_trading_password ? '已设置' : '未设置') + '</span></div><div class="ak-ep-field ak-ep-interval-field"><label for="akEpInterval">抢分间隔</label><div class="ak-ep-number-input">' +
                            '<input id="akEpInterval" data-field="interval" type="number" min="0.001" step="0.001" inputmode="decimal" value="' + escapeHtml(config.interval_seconds || 1) + '" ' + (loading ? 'disabled' : '') + '><span>秒</span></div></div></div>' +
                            '<div class="ak-ep-actions">' +
                                '<label class="ak-ep-toggle"><input type="checkbox" data-field="enabled" ' + (enabled ? 'checked' : '') + ' ' + (loading ? 'disabled' : '') + '><span></span><b>自动抢购</b></label>' +
                                '<button type="button" class="ak-ep-save" data-action="save" ' + (loading ? 'disabled' : '') + '>' +
                                    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h12l2 2v14H5z"/><path d="M8 4v6h8V4"/><path d="M8 20v-6h8v6"/></svg><span>保存配置</span></button>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="ak-ep-summary-pane">' +
                    '<div class="ak-ep-pane-title"><strong>运行摘要</strong><span>' + (enabled ? '任务已启用' : '任务未启用') + '</span></div>' +
                    '<div class="ak-ep-metrics">' +
                        '<div class="ak-ep-metric"><span>轮转账号</span><strong>' + number(accountRows.length) + '</strong></div>' +
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
                '<div class="ak-ep-table-wrap"><table><thead><tr><th>订单</th><th>抢分账号</th><th>挂卖账号</th><th>EP</th><th>结果</th><th>信息</th><th>时间</th><th>操作</th></tr></thead><tbody>' + renderOrderRows(data.orders, !!config.has_trading_password, state.confirmingSid) + '</tbody></table></div></section>' +
        '</div>';
    }

    window.AKEPAutoPurchaseRenderer = { render: render };
})();
