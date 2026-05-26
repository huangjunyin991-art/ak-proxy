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
        return '<label class="ad-toggle-card">' +
            '<input id="' + id + '" type="checkbox">' +
            '<span class="ad-switch-control" aria-hidden="true"></span>' +
            '<span class="ad-switch-copy"><strong>' + escapeHtml(title) + '</strong><small>' + escapeHtml(desc) + '</small></span>' +
        '</label>';
    }

    function numberField(id, label, desc) {
        return '<label class="ad-field"><span>' + escapeHtml(label) + '</span><input id="' + id + '" class="ad-input" type="number" min="0"><small>' + escapeHtml(desc) + '</small></label>';
    }

    function textField(id, label, desc) {
        return '<label class="ad-field"><span>' + escapeHtml(label) + '</span><input id="' + id + '" class="ad-input" type="text"><small>' + escapeHtml(desc) + '</small></label>';
    }

    function renderMetric(label, value, tone) {
        return '<div class="ad-metric ' + escapeHtml(tone || '') + '"><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + '</span></div>';
    }

    function renderRuntime() {
        var runtime = state.runtime || {};
        var lastBan = runtime.last_ban || {};
        return '<div class="ad-metrics">' +
            renderMetric('登录短间隔 IP', runtime.login_short_interval_ips || 0, 'cyan') +
            renderMetric('忘记态 403 IP', runtime.login_forget_403_ips || 0, 'blue') +
            renderMetric('登录 403 IP', runtime.login_403_ips || 0, 'purple') +
            renderMetric('响应异常 IP', runtime.response_anomaly_ips || 0, 'orange') +
            '</div>' +
            '<div class="ad-last-ban"><div><span>最近自动封禁</span><strong>' + escapeHtml(lastBan.ip || '暂无') + '</strong></div><p>' + escapeHtml(lastBan.reason || '当前没有主动防御自动封禁记录') + '</p></div>';
    }

    function renderStyles() {
        return '<style>' + [
            '#activeDefensePanelMount{display:block}',
            '.ad-page{display:flex;flex-direction:column;gap:18px}',
            '.ad-hero{position:relative;overflow:hidden;border:1px solid rgba(0,212,255,.22);border-radius:22px;background:radial-gradient(circle at 0 0,rgba(0,255,204,.18),transparent 34%),linear-gradient(135deg,rgba(4,18,32,.96),rgba(5,31,45,.92));padding:20px;box-shadow:0 18px 55px rgba(0,0,0,.22)}',
            '.ad-hero:after{content:"";position:absolute;right:-80px;top:-80px;width:220px;height:220px;border-radius:50%;background:rgba(0,212,255,.12);filter:blur(8px)}',
            '.ad-hero-main{position:relative;z-index:1;display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap}',
            '.ad-eyebrow{color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}',
            '.ad-title{color:var(--text-primary);font-size:24px;font-weight:900;margin-top:4px}',
            '.ad-desc{color:var(--text-secondary);font-size:13px;line-height:1.65;margin-top:6px;max-width:760px}',
            '.ad-status-pill{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(0,255,136,.28);border-radius:999px;background:rgba(0,255,136,.1);color:var(--accent-green);padding:8px 12px;font-size:12px;font-weight:800;white-space:nowrap}',
            '.ad-status-pill.off{border-color:rgba(255,71,87,.32);background:rgba(255,71,87,.12);color:var(--accent-red)}',
            '.ad-dot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 14px currentColor}',
            '.ad-actions-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
            '.ad-btn{min-height:38px;border:0;border-radius:12px;padding:9px 16px;background:linear-gradient(135deg,var(--accent),#00ffcc);color:#00131c;font-weight:900;cursor:pointer;box-shadow:0 12px 28px rgba(0,212,255,.22)}',
            '.ad-btn.secondary{background:rgba(255,255,255,.06);color:var(--text-primary);border:1px solid rgba(255,255,255,.12);box-shadow:none}',
            '.ad-btn.danger{background:rgba(255,71,87,.12);color:#ff6b7a;border:1px solid rgba(255,71,87,.25);box-shadow:none}',
            '.ad-btn:disabled{opacity:.55;cursor:not-allowed}',
            '.ad-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:18px}',
            '.ad-metric{border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.045);padding:14px;min-width:0}',
            '.ad-metric strong{display:block;color:var(--accent);font-size:24px;line-height:1;font-weight:900}',
            '.ad-metric span{display:block;margin-top:8px;color:var(--text-secondary);font-size:12px}',
            '.ad-metric.blue strong{color:#55a3ff}.ad-metric.purple strong{color:#a55eea}.ad-metric.orange strong{color:#f7b731}',
            '.ad-last-ban{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(0,0,0,.16);padding:12px 14px}',
            '.ad-last-ban span{display:block;color:var(--text-secondary);font-size:12px}.ad-last-ban strong{display:block;color:var(--text-primary);font-size:16px;margin-top:3px}.ad-last-ban p{margin:0;color:var(--text-secondary);font-size:12px;line-height:1.5;text-align:right}',
            '.ad-section-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px}',
            '.ad-section{grid-column:span 6;border:1px solid rgba(0,212,255,.12);border-radius:20px;background:linear-gradient(180deg,rgba(10,33,49,.88),rgba(6,20,32,.94));padding:16px;box-shadow:0 14px 40px rgba(0,0,0,.15)}',
            '.ad-section.wide{grid-column:span 12}',
            '.ad-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}',
            '.ad-section-kicker{color:var(--accent);font-size:11px;font-weight:900;letter-spacing:.1em;text-transform:uppercase}',
            '.ad-section-title{color:var(--text-primary);font-size:17px;font-weight:900;margin-top:3px}',
            '.ad-section-copy{color:var(--text-secondary);font-size:12px;line-height:1.55;margin-top:4px}',
            '.ad-section-index{display:grid;place-items:center;min-width:34px;height:34px;border-radius:12px;background:rgba(0,212,255,.1);color:var(--accent);font-weight:900}',
            '.ad-control-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ad-control-grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}',
            '.ad-toggle-card{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:12px;min-height:72px;padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.045);cursor:pointer;transition:border-color .2s,background .2s,transform .2s}',
            '.ad-toggle-card:hover{border-color:rgba(0,212,255,.38);background:rgba(0,212,255,.07);transform:translateY(-1px)}.ad-toggle-card input{position:absolute;opacity:0;pointer-events:none}',
            '.ad-switch-control{position:relative;width:46px;height:26px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.1);transition:background .2s,border-color .2s}.ad-switch-control:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#d8e5ec;box-shadow:0 2px 6px rgba(0,0,0,.28);transition:transform .2s,background .2s}',
            '.ad-toggle-card input:checked+.ad-switch-control{background:linear-gradient(135deg,#00d4ff,#00ff88);border-color:rgba(0,255,136,.48)}.ad-toggle-card input:checked+.ad-switch-control:after{transform:translateX(20px);background:#fff}',
            '.ad-switch-copy strong{display:block;color:var(--text-primary);font-size:13px;line-height:1.25}.ad-switch-copy small{display:block;color:var(--text-secondary);font-size:11px;line-height:1.45;margin-top:4px}',
            '.ad-field{display:flex;flex-direction:column;gap:7px;border:1px solid rgba(255,255,255,.07);border-radius:16px;background:rgba(0,0,0,.13);padding:12px;min-width:0}.ad-field span{color:var(--text-primary);font-size:12px;font-weight:800}.ad-field small{color:var(--text-secondary);font-size:11px;line-height:1.35}',
            '.ad-input{width:100%;min-height:38px;border:1px solid rgba(255,255,255,.1);border-radius:11px;padding:8px 10px;color:var(--text-primary);background:rgba(2,10,18,.72);font-size:14px;outline:none}.ad-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,212,255,.13)}',
            '.ad-footer{position:sticky;bottom:0;z-index:3;display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:rgba(4,18,30,.92);backdrop-filter:blur(14px);padding:12px 14px;box-shadow:0 -12px 38px rgba(0,0,0,.18)}',
            '.ad-footer-copy strong{display:block;color:var(--text-primary);font-size:13px}.ad-footer-copy span{display:block;color:var(--text-secondary);font-size:12px;margin-top:3px}.ad-footer-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
            '.ad-unavailable{margin-top:14px;border:1px solid rgba(255,71,87,.25);border-radius:14px;background:rgba(255,71,87,.1);color:#ff8a96;padding:12px;font-size:13px}',
            '@media(max-width:1180px){.ad-section{grid-column:span 12}.ad-control-grid.three{grid-template-columns:repeat(2,minmax(0,1fr))}}',
            '@media(max-width:760px){.ad-hero{padding:16px}.ad-title{font-size:20px}.ad-metrics,.ad-control-grid,.ad-control-grid.three{grid-template-columns:1fr}.ad-last-ban{align-items:flex-start;flex-direction:column}.ad-last-ban p{text-align:left}.ad-footer{position:relative}.ad-footer-actions{width:100%}.ad-footer-actions .ad-btn{flex:1}}'
        ].join('') + '</style>';
    }

    function section(kicker, title, copy, index, body, wide) {
        return '<section class="ad-section' + (wide ? ' wide' : '') + '"><div class="ad-section-head"><div><div class="ad-section-kicker">' + escapeHtml(kicker) + '</div><div class="ad-section-title">' + escapeHtml(title) + '</div><div class="ad-section-copy">' + escapeHtml(copy) + '</div></div><div class="ad-section-index">' + escapeHtml(index) + '</div></div>' + body + '</section>';
    }

    function render() {
        var root = mount();
        if (!root) return;
        var disabled = state.saving || state.loading ? ' disabled' : '';
        var policy = state.policy || {};
        var enabled = policy.enabled !== false;
        root.innerHTML = renderStyles() +
            '<div class="ad-page">' +
                '<section class="ad-hero"><div class="ad-hero-main"><div><div class="ad-eyebrow">Active Defense</div><div class="ad-title">主动防御策略中心</div><div class="ad-desc">集中管理登录短间隔、密码错误、登录 403、HTTP 403/429 连续异常和自动封禁处罚。这里是策略入口，监控中心只保留观测职责。</div></div><div class="ad-actions-top"><div class="ad-status-pill' + (enabled ? '' : ' off') + '"><span class="ad-dot"></span>' + (enabled ? '策略运行中' : '策略已停用') + '</div><button class="ad-btn secondary" id="adRefreshBtn"' + disabled + '>刷新</button></div></div>' +
                (state.available === false ? '<div class="ad-unavailable">' + escapeHtml(state.message || '主动防御模块不可用') + '</div>' : '') + renderRuntime() + '</section>' +
                '<div class="ad-section-grid">' +
                    section('Global', '全局处罚规则', '控制主动防御总开关、本机豁免和自动封禁时长。', '01', '<div class="ad-control-grid three">' + switchCard('adEnabled', '启用主动防御', '关闭后所有主动防御自动封禁策略暂停') + switchCard('adIgnoreLoopback', '忽略本机 IP', '避免本机调试和健康检查被误封') + switchCard('adProgressiveBan', '启用梯度封禁', '同一 IP 多次触发时逐级增加处罚') + numberField('adBanBaseSeconds', '基础封禁时长（秒）', '默认 3600 秒') + numberField('adBanMaxSeconds', '最大封禁时长（秒）', '默认 30 天') + '</div>', true) +
                    section('Login', '登录防护策略', '处理登录接口短间隔请求和密码错误累计封禁。', '02', '<div class="ad-control-grid">' + switchCard('adLoginShortEnabled', '启用登录短间隔防护', '请求登录接口过快时先阻断，连续命中后封禁') + switchCard('adLoginShortBlockEnabled', '短间隔先阻断', '开启后未达封禁阈值时返回 429') + numberField('adLoginMinInterval', '最小登录间隔（秒）', '默认 5 秒') + numberField('adLoginShortThreshold', '短间隔封禁阈值（次）', '默认 3 次') + switchCard('adPasswordFailureEnabled', '启用密码错误累计封禁', '同一 IP 对同一账号连续密码错误达到阈值后封禁') + numberField('adPasswordWindowHours', '密码错误统计窗口（小时）', '默认 24 小时，成功登录后重新累计') + numberField('adPasswordThreshold', '密码错误封禁阈值（次）', '默认 15 次') + '</div>', false) +
                    section('Anomaly', '403 / 429 异常策略', '处理登录 403、多账号失败和接口响应异常。', '03', '<div class="ad-control-grid">' + switchCard('adLogin403Enabled', '启用登录 403 防护', '登录忘记态 403 和同 IP 多账号 403 统一封禁') + numberField('adLogin403Window', '登录 403 统计窗口（秒）', '默认 60 秒') + numberField('adLogin403DistinctThreshold', '同 IP 多账号 403 阈值（个）', '默认 6 个账号') + numberField('adLoginForget403Threshold', '忘记态 403 连续阈值（次）', '默认 20 次') + switchCard('adResponseEnabled', '启用响应异常防护', '同一 IP 连续触发 HTTP 403/429 达阈值后封禁') + numberField('adResponseWindow', '响应异常保护窗口（秒）', '默认 60 秒') + numberField('adResponseThreshold', '响应异常连续阈值（次）', '默认 10 次') + textField('adResponseCodes', '监听状态码', '逗号分隔，默认 403,429') + switchCard('adResponseResetClean', '非异常响应重置计数', '开启后连续性更严格') + switchCard('adResponseApiOnly', '仅统计 API 路径', '关闭则统计全站响应') + switchCard('adResponseExcludeStatic', '排除静态资源', '避免 CSS/JS/图片 404 或 403 误判') + '</div>', false) +
                '</div>' +
                '<section class="ad-footer"><div class="ad-footer-copy"><strong>保存后立即应用到运行策略</strong><span>清空运行计数不会解除已经封禁的 IP。</span></div><div class="ad-footer-actions"><button class="ad-btn" id="adSaveBtn"' + disabled + '>保存配置</button><button class="ad-btn danger" id="adClearBtn"' + (state.clearing ? ' disabled' : '') + '>清空运行计数</button></div></section>' +
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
