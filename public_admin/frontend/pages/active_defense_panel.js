(function() {
    'use strict';

    if (window.AKActiveDefensePanelLoaded) return;
    window.AKActiveDefensePanelLoaded = true;

    var state = {
        loading: false,
        saving: false,
        clearing: false,
        loaded: false,
        policy: null,
        runtime: null,
        available: true,
        message: ''
    };

    function token() {
        return sessionStorage.getItem('admin_token') || '';
    }

    function mount() {
        return document.getElementById('activeDefensePanelMount');
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>'"]/g, function(ch) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[ch] || ch;
        });
    }

    function notify(message, type) {
        try {
            if (typeof showToast === 'function') {
                showToast(message, type || 'info');
                return;
            }
        } catch (e) {}
        window.alert(message);
    }

    function api(path) {
        return fetch('/admin/api/active-defense' + path, {
            headers: { 'Authorization': 'Bearer ' + token() },
            credentials: 'same-origin'
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error) throw new Error(body.message || body.detail || '主动防御接口请求失败');
                return body;
            });
        });
    }

    function apiPost(path, payload) {
        return fetch('/admin/api/active-defense' + path, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token(),
                'Content-Type': 'application/json'
            },
            credentials: 'same-origin',
            body: JSON.stringify(payload || {})
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error) throw new Error(body.message || body.detail || '主动防御接口请求失败');
                return body;
            });
        });
    }

    function numberValue(id) {
        var el = document.getElementById(id);
        return Number(el && el.value || 0);
    }

    function checkedValue(id) {
        var el = document.getElementById(id);
        return !!(el && el.checked);
    }

    function textValue(id) {
        var el = document.getElementById(id);
        return String(el && el.value || '').trim();
    }

    function setInputValue(id, value) {
        var el = document.getElementById(id);
        if (el) el.value = value == null ? '' : String(value);
    }

    function setInputChecked(id, value) {
        var el = document.getElementById(id);
        if (el) el.checked = !!value;
    }

    function switchCard(id, title, desc) {
        return '<label class="ad-switch-card">' +
            '<input id="' + id + '" type="checkbox">' +
            '<span class="ad-switch-control" aria-hidden="true"></span>' +
            '<span class="ad-switch-copy"><strong>' + escapeHtml(title) + '</strong><small>' + escapeHtml(desc) + '</small></span>' +
        '</label>';
    }

    function numberField(id, label, desc) {
        return '<label><span>' + escapeHtml(label) + '</span><input id="' + id + '" class="ad-input" type="number" min="0"><small>' + escapeHtml(desc) + '</small></label>';
    }

    function textField(id, label, desc) {
        return '<label><span>' + escapeHtml(label) + '</span><input id="' + id + '" class="ad-input" type="text"><small>' + escapeHtml(desc) + '</small></label>';
    }

    function renderRuntime() {
        var runtime = state.runtime || {};
        var lastBan = runtime.last_ban || {};
        return '<div class="ad-runtime-grid">' +
            '<div><strong>' + escapeHtml(runtime.login_short_interval_ips || 0) + '</strong><span>登录短间隔 IP</span></div>' +
            '<div><strong>' + escapeHtml(runtime.login_forget_403_ips || 0) + '</strong><span>忘记态403 IP</span></div>' +
            '<div><strong>' + escapeHtml(runtime.login_403_ips || 0) + '</strong><span>登录 403 IP</span></div>' +
            '<div><strong>' + escapeHtml(runtime.response_anomaly_ips || 0) + '</strong><span>响应异常 IP</span></div>' +
            '<div class="ad-runtime-last"><strong>' + escapeHtml(lastBan.ip || '-') + '</strong><span>' + escapeHtml(lastBan.reason || '暂无自动封禁记录') + '</span></div>' +
        '</div>';
    }

    function render() {
        var root = mount();
        if (!root) return;
        var disabled = state.saving || state.loading ? ' disabled' : '';
        root.innerHTML = '<style>' +
            '#activeDefensePanelMount{display:block}.ad-wrap{display:flex;flex-direction:column;gap:16px}.ad-card{border:1px solid var(--border);border-radius:16px;background:linear-gradient(135deg,var(--bg-card),rgba(0,212,255,.04));padding:16px}.ad-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}.ad-title{color:var(--accent);font-size:18px;font-weight:800}.ad-desc{color:var(--text-secondary);font-size:12px;margin-top:4px}.ad-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:14px}.ad-grid label{display:flex;flex-direction:column;gap:7px;color:var(--text-secondary);font-size:12px}.ad-grid label span{font-weight:700;color:var(--text-primary)}.ad-grid small{line-height:1.35}.ad-input{width:100%;min-height:38px;border:1px solid var(--border);border-radius:10px;padding:8px 10px;color:var(--text-primary);background:var(--bg-primary);font-size:13px;outline:none}.ad-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,212,255,.12)}.ad-switch-card{position:relative;display:grid!important;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:12px!important;min-height:58px;padding:10px 12px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.035);cursor:pointer;transition:border-color .2s,background .2s}.ad-switch-card:hover{border-color:rgba(0,212,255,.38);background:rgba(0,212,255,.06)}.ad-switch-card input{position:absolute;opacity:0;pointer-events:none}.ad-switch-control{position:relative;width:46px;height:26px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.1);box-shadow:inset 0 0 0 1px rgba(0,0,0,.12);transition:background .2s,border-color .2s,box-shadow .2s}.ad-switch-control:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#d8e5ec;box-shadow:0 2px 6px rgba(0,0,0,.28);transition:transform .2s,background .2s}.ad-switch-card input:checked+.ad-switch-control{border-color:rgba(0,255,136,.65);background:linear-gradient(135deg,#00d4ff,#00ff88);box-shadow:0 0 16px rgba(0,255,136,.18)}.ad-switch-card input:checked+.ad-switch-control:after{transform:translateX(20px);background:#fff}.ad-switch-copy{display:flex;flex-direction:column;gap:4px;min-width:0}.ad-switch-copy strong{color:var(--text-primary);font-size:13px;line-height:1.2}.ad-switch-copy small{color:var(--text-secondary);font-size:11px;line-height:1.35}.ad-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.ad-btn{border:0;border-radius:10px;padding:9px 14px;background:linear-gradient(135deg,var(--accent),#00b8d9);color:#061923;font-weight:800;cursor:pointer}.ad-btn.secondary{background:rgba(255,255,255,.08);color:var(--text-primary);border:1px solid var(--border)}.ad-btn:disabled{opacity:.55;cursor:not-allowed}.ad-runtime-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:14px}.ad-runtime-grid>div{border:1px solid rgba(255,255,255,.08);border-radius:12px;background:rgba(255,255,255,.035);padding:12px}.ad-runtime-grid strong{display:block;color:var(--accent);font-size:18px}.ad-runtime-grid span{display:block;color:var(--text-secondary);font-size:12px;margin-top:5px}.ad-runtime-last{grid-column:1/-1}.ad-unavailable{border-color:rgba(255,71,87,.35);color:var(--accent-red)}' +
        '</style>' +
        '<div class="ad-wrap">' +
            '<section class="ad-card">' +
                '<div class="ad-head"><div><div class="ad-title">主动防御配置</div><div class="ad-desc">集中管理登录短间隔、密码错误、登录403、HTTP 403/429 连续异常和封禁处罚策略。</div></div><button class="ad-btn secondary" id="adRefreshBtn"' + disabled + '>刷新</button></div>' +
                (state.available === false ? '<div class="ad-card ad-unavailable">' + escapeHtml(state.message || '主动防御模块不可用') + '</div>' : '') +
                '<div class="ad-grid">' +
                    switchCard('adEnabled', '启用主动防御', '关闭后所有主动防御自动封禁策略暂停') +
                    switchCard('adIgnoreLoopback', '忽略本机 IP', '避免本机调试和反向代理健康检查被误封') +
                    switchCard('adProgressiveBan', '启用梯度封禁', '同一 IP 多次触发时按封禁等级增加处罚时长') +
                    numberField('adBanBaseSeconds', '基础封禁时长（秒）', '默认 3600 秒') +
                    numberField('adBanMaxSeconds', '最大封禁时长（秒）', '默认 30 天') +
                '</div>' +
            '</section>' +
            '<section class="ad-card"><div class="ad-title">登录防护策略</div><div class="ad-grid">' +
                switchCard('adLoginShortEnabled', '启用登录短间隔防护', '请求登录接口过快时先阻断，连续命中后封禁') +
                switchCard('adLoginShortBlockEnabled', '短间隔先阻断', '开启后未达封禁阈值时返回 429') +
                numberField('adLoginMinInterval', '最小登录间隔（秒）', '默认 5 秒') +
                numberField('adLoginShortThreshold', '短间隔封禁阈值（次）', '默认 3 次') +
                switchCard('adPasswordFailureEnabled', '启用密码错误累计封禁', '同一 IP 对同一账号连续密码错误达到阈值后封禁') +
                numberField('adPasswordWindowHours', '密码错误统计窗口（小时）', '默认 24 小时，成功登录后重新累计') +
                numberField('adPasswordThreshold', '密码错误封禁阈值（次）', '默认 15 次') +
            '</div></section>' +
            '<section class="ad-card"><div class="ad-title">403 / 429 异常策略</div><div class="ad-grid">' +
                switchCard('adLogin403Enabled', '启用登录 403 防护', '登录忘记态403和同IP多账号403统一封禁') +
                numberField('adLogin403Window', '登录403统计窗口（秒）', '默认 60 秒') +
                numberField('adLogin403DistinctThreshold', '同IP多账号403阈值（个）', '默认 6 个账号') +
                numberField('adLoginForget403Threshold', '忘记态403连续阈值（次）', '默认 20 次') +
                switchCard('adResponseEnabled', '启用响应异常防护', '同一 IP 连续触发 HTTP 403/429 达阈值后封禁') +
                numberField('adResponseWindow', '响应异常保护窗口（秒）', '默认 60 秒') +
                numberField('adResponseThreshold', '响应异常连续阈值（次）', '默认 10 次') +
                textField('adResponseCodes', '监听状态码', '逗号分隔，默认 403,429') +
                switchCard('adResponseResetClean', '非异常响应重置计数', '开启后连续性更严格') +
                switchCard('adResponseApiOnly', '仅统计 API 路径', '关闭则统计全站响应') +
                switchCard('adResponseExcludeStatic', '排除静态资源', '避免 CSS/JS/图片 404 或 403 误判') +
            '</div></section>' +
            '<section class="ad-card"><div class="ad-head"><div><div class="ad-title">运行状态</div><div class="ad-desc">只展示内存运行态计数，清空不会解除已封禁 IP。</div></div></div>' + renderRuntime() + '<div class="ad-actions"><button class="ad-btn" id="adSaveBtn"' + disabled + '>保存配置</button><button class="ad-btn secondary" id="adClearBtn"' + (state.clearing ? ' disabled' : '') + '>清空运行计数</button></div></section>' +
        '</div>';
        bindEvents();
        fillPolicy();
    }

    function fillPolicy() {
        var p = state.policy || {};
        setInputChecked('adEnabled', p.enabled !== false);
        setInputChecked('adIgnoreLoopback', p.ignore_loopback !== false);
        setInputChecked('adProgressiveBan', p.progressive_ban_enabled !== false);
        setInputValue('adBanBaseSeconds', p.ban_base_seconds);
        setInputValue('adBanMaxSeconds', p.ban_max_seconds);
        setInputChecked('adLoginShortEnabled', p.login_short_interval_enabled !== false);
        setInputChecked('adLoginShortBlockEnabled', p.login_short_interval_block_enabled !== false);
        setInputValue('adLoginMinInterval', p.login_min_interval_seconds);
        setInputValue('adLoginShortThreshold', p.login_short_interval_ban_threshold);
        setInputChecked('adPasswordFailureEnabled', p.password_failure_enabled !== false);
        setInputValue('adPasswordWindowHours', p.password_failure_window_hours);
        setInputValue('adPasswordThreshold', p.password_failure_ban_threshold);
        setInputChecked('adLogin403Enabled', p.login_403_enabled !== false);
        setInputValue('adLogin403Window', p.login_403_window_seconds);
        setInputValue('adLogin403DistinctThreshold', p.login_403_distinct_account_threshold);
        setInputValue('adLoginForget403Threshold', p.login_forget_403_threshold);
        setInputChecked('adResponseEnabled', p.response_anomaly_enabled !== false);
        setInputValue('adResponseWindow', p.response_anomaly_window_seconds);
        setInputValue('adResponseThreshold', p.response_anomaly_threshold);
        setInputValue('adResponseCodes', Array.isArray(p.response_anomaly_status_codes) ? p.response_anomaly_status_codes.join(',') : '403,429');
        setInputChecked('adResponseResetClean', p.response_anomaly_reset_on_clean !== false);
        setInputChecked('adResponseApiOnly', !!p.response_anomaly_api_only);
        setInputChecked('adResponseExcludeStatic', p.response_anomaly_exclude_static !== false);
    }

    function collectPolicy() {
        return {
            enabled: checkedValue('adEnabled'),
            ignore_loopback: checkedValue('adIgnoreLoopback'),
            progressive_ban_enabled: checkedValue('adProgressiveBan'),
            ban_base_seconds: numberValue('adBanBaseSeconds'),
            ban_max_seconds: numberValue('adBanMaxSeconds'),
            login_short_interval_enabled: checkedValue('adLoginShortEnabled'),
            login_short_interval_block_enabled: checkedValue('adLoginShortBlockEnabled'),
            login_min_interval_seconds: numberValue('adLoginMinInterval'),
            login_short_interval_ban_threshold: numberValue('adLoginShortThreshold'),
            password_failure_enabled: checkedValue('adPasswordFailureEnabled'),
            password_failure_window_hours: numberValue('adPasswordWindowHours'),
            password_failure_ban_threshold: numberValue('adPasswordThreshold'),
            login_403_enabled: checkedValue('adLogin403Enabled'),
            login_403_window_seconds: numberValue('adLogin403Window'),
            login_403_distinct_account_threshold: numberValue('adLogin403DistinctThreshold'),
            login_forget_403_threshold: numberValue('adLoginForget403Threshold'),
            response_anomaly_enabled: checkedValue('adResponseEnabled'),
            response_anomaly_window_seconds: numberValue('adResponseWindow'),
            response_anomaly_threshold: numberValue('adResponseThreshold'),
            response_anomaly_status_codes: textValue('adResponseCodes').split(',').map(function(item) { return Number(String(item).trim()); }).filter(function(code) { return code >= 100 && code <= 599; }),
            response_anomaly_reset_on_clean: checkedValue('adResponseResetClean'),
            response_anomaly_api_only: checkedValue('adResponseApiOnly'),
            response_anomaly_exclude_static: checkedValue('adResponseExcludeStatic')
        };
    }

    function bindEvents() {
        var refreshBtn = document.getElementById('adRefreshBtn');
        var saveBtn = document.getElementById('adSaveBtn');
        var clearBtn = document.getElementById('adClearBtn');
        if (refreshBtn) refreshBtn.onclick = function() { load(true); };
        if (saveBtn) saveBtn.onclick = save;
        if (clearBtn) clearBtn.onclick = clearRuntime;
    }

    function load(force) {
        if (state.loading && !force) return;
        state.loading = true;
        render();
        api('/policy').then(function(body) {
            var item = body.item || {};
            state.policy = item.policy || {};
            state.runtime = item.runtime || {};
            state.available = item.available !== false;
            state.message = item.message || '';
            state.loaded = true;
        }).catch(function(error) {
            notify('主动防御配置加载失败：' + error.message, 'error');
        }).finally(function() {
            state.loading = false;
            render();
        });
    }

    function save() {
        if (state.saving) return;
        var payload = collectPolicy();
        state.saving = true;
        render();
        apiPost('/policy', payload).then(function(body) {
            state.policy = body.item || {};
            notify('主动防御配置已保存', 'success');
            return api('/status');
        }).then(function(body) {
            var item = body.item || {};
            state.runtime = item.runtime || {};
        }).catch(function(error) {
            notify('主动防御配置保存失败：' + error.message, 'error');
        }).finally(function() {
            state.saving = false;
            render();
        });
    }

    function clearRuntime() {
        if (state.clearing) return;
        state.clearing = true;
        render();
        apiPost('/runtime/clear', {}).then(function(body) {
            state.runtime = body.runtime || {};
            notify('主动防御运行计数已清空', 'success');
        }).catch(function(error) {
            notify('清空运行计数失败：' + error.message, 'error');
        }).finally(function() {
            state.clearing = false;
            render();
        });
    }

    window.AKActiveDefensePanel = {
        start: function() {
            if (!state.loaded) {
                load(false);
            } else {
                render();
            }
        },
        reload: function() {
            load(true);
        }
    };

    if (document.querySelector('.tab.active[data-panel="activeDefense"]')) {
        window.AKActiveDefensePanel.start();
    }
})();
