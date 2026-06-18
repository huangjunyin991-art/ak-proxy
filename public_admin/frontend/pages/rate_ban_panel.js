(function() {
    'use strict';

    if (window.AKRateBanPanelLoaded) return;
    window.AKRateBanPanelLoaded = true;

    var state = {
        loading: false,
        saving: false,
        clearing: false,
        loaded: false,
        policy: null,
        runtime: null,
        available: true,
        message: '',
        rendered: false,
        shellKey: '',
        runtimeHtml: ''
    };
    var STYLE_ID = 'akRateBanPanelStyle';

    function token() {
        return sessionStorage.getItem('admin_token') || '';
    }

    function mount() {
        return document.getElementById('rateBanPanelMount');
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
        return fetch('/admin/api/rate-ban' + path, {
            headers: { 'Authorization': 'Bearer ' + token() },
            credentials: 'same-origin'
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error) throw new Error(body.message || body.detail || '限速封禁接口请求失败');
                return body;
            });
        });
    }

    function apiPost(path, payload) {
        return fetch('/admin/api/rate-ban' + path, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token(),
                'Content-Type': 'application/json'
            },
            credentials: 'same-origin',
            body: JSON.stringify(payload || {})
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error) throw new Error(body.message || body.detail || '限速封禁接口请求失败');
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

    function setText(id, value) {
        var el = document.getElementById(id);
        if (el) el.textContent = value == null ? '' : String(value);
    }

    function switchCard(id, title, desc, checked) {
        return '<label class="rb-toggle-card">' +
            '<input id="' + id + '" type="checkbox"' + (checked ? ' checked' : '') + '>' +
            '<span class="rb-switch-control" aria-hidden="true"></span>' +
            '<span class="rb-switch-copy"><strong>' + escapeHtml(title) + '</strong><small>' + escapeHtml(desc) + '</small></span>' +
        '</label>';
    }

    function numberField(id, label, desc, value, min, max) {
        return '<label class="rb-field">' +
            '<span>' + escapeHtml(label) + '</span>' +
            '<input id="' + id + '" class="rb-input" type="number" min="' + (min != null ? min : 0) + '"' + (max != null ? ' max="' + max + '"' : '') + '>' +
            '<small>' + escapeHtml(desc) + '</small>' +
        '</label>';
    }

    function ruleMeta(rule) {
        var id = String(rule && rule.id || '');
        var prefix = String(rule && rule.route_prefix || '');
        var meta = {
            badge: '通用接口',
            desc: '匹配该路径前缀的请求会进入限速统计，超过阈值后按策略封禁访问 IP。'
        };
        if (id.indexOf('license_credentials') === 0) {
            meta.badge = '管理面板软件授权';
            meta.desc = '管理面板软件的客户端登录、二级验证、Google 绑定和重置密码接口；不包含后台子管理员 Google 验证。';
        } else if (id.indexOf('license_activate') === 0 || prefix.indexOf('/activate') >= 0) {
            meta.badge = '管理面板软件激活';
            meta.desc = '管理面板软件首次绑定激活码和机器码的接口，默认超过 10 次/分钟封禁 IP 1 小时。';
        } else if (id.indexOf('license_verify') === 0 || prefix.indexOf('/verify') >= 0) {
            meta.badge = '管理面板软件校验';
            meta.desc = '管理面板软件启动或心跳时校验授权有效性的接口。';
        } else if (id.indexOf('license_consume') === 0) {
            meta.badge = '授权扣次';
            meta.desc = '按次授权消耗额度的接口。';
        } else if (id.indexOf('license_check_update') === 0 || prefix.indexOf('check-update') >= 0) {
            meta.badge = '更新检查';
            meta.desc = '管理面板软件检查新版本和下载信息的接口。';
        } else if (id === 'admin_api') {
            meta.badge = '管理员后台';
            meta.desc = '管理员后台 API 的整体限速保护。子管理员 Google 操作验证在 operation_auth 模块内单独处理。';
        } else if (id === 'im_api' || id === 'im_chat') {
            meta.badge = 'IM 业务';
            meta.desc = 'IM 聊天与 IM API 的请求限速保护。';
        } else if (id === 'notify_public') {
            meta.badge = '通知公开接口';
            meta.desc = '公开通知接口的请求限速保护。';
        }
        return meta;
    }

    function ruleCard(rule, index) {
        var enabled = rule.enabled !== false;
        var meta = ruleMeta(rule);
        var html = '<div class="rb-rule-card" id="rbRule' + escapeHtml(rule.id || index) + '" data-rule-index="' + index + '">' +
            '<div class="rb-rule-header">' +
                '<label class="rb-rule-toggle">' +
                    '<input type="checkbox" class="rb-rule-enabled" ' + (enabled ? 'checked' : '') + '>' +
                    '<span class="rb-switch-control"></span>' +
                '</label>' +
                '<div class="rb-rule-title">' +
                    '<div class="rb-rule-name-row"><strong>' + escapeHtml(rule.label || rule.id || '规则 ' + (index + 1)) + '</strong><span class="rb-rule-badge">' + escapeHtml(meta.badge) + '</span></div>' +
                    '<small>' + escapeHtml(rule.route_prefix || '/') + '</small>' +
                    '<p>' + escapeHtml(meta.desc) + '</p>' +
                '</div>' +
            '</div>' +
            '<div class="rb-rule-fields">' +
                numberField('rbRps' + index, '速率上限 (req/s)', '每秒允许的最大请求数', rule.requests_per_second, 1, 10000) +
                numberField('rbWindow' + index, '统计窗口 (秒)', '时间窗口内累计请求数', rule.window_seconds, 1, 3600) +
                numberField('rbWindowLimit' + index, '窗口总次数', '0 表示按每秒速率换算', rule.window_request_limit || 0, 0, 1000000) +
                numberField('rbBanSeconds' + index, '封禁时长（秒）', '0 表示使用全局基础时长', rule.ban_seconds || 0, 0, 86400 * 7) +
            '</div>' +
        '</div>';
        return html;
    }

    function renderRuntime() {
        var runtime = state.runtime || {};
        var recentBans = runtime.recent_bans || {};
        var banCount = Object.keys(recentBans).length;
        var banList = Object.keys(recentBans).slice(0, 5).map(function(ip) {
            var info = recentBans[ip] || {};
            return '<div class="rb-ban-item"><button type="button" class="rb-ban-ip" data-ip="' + escapeHtml(ip) + '">' + escapeHtml(ip) + '</button><small>' + escapeHtml(info.rule_id || '') + '</small><span class="rb-ban-dur">' + (info.duration_seconds ? Math.round(info.duration_seconds / 60) + 'min' : '-') + '</span></div>';
        }).join('');
        return '<div class="rb-metrics">' +
            '<div class="rb-metric"><strong>' + (runtime.tracked_ips || 0) + '</strong><span>追踪中的 IP</span></div>' +
            '<div class="rb-metric"><strong>' + banCount + '</strong><span>最近封禁记录</span></div>' +
        '</div>' +
        (banList ? '<div class="rb-ban-list"><div class="rb-ban-list-head">最近封禁</div>' + banList + '</div>' : '');
    }

    function renderStyles() {
        return [
            '#rateBanPanelMount{display:block}',
            '.rb-page{display:flex;flex-direction:column;gap:18px}',
            '.rb-hero{position:relative;overflow:hidden;border:1px solid rgba(0,212,255,.20);border-radius:22px;background:linear-gradient(135deg,rgba(6,18,34,.96),rgba(8,30,38,.92));padding:20px;box-shadow:0 18px 55px rgba(0,0,0,.22)}',
            '.rb-hero:after{display:none}',
            '.rb-hero-main{position:relative;z-index:1;display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap}',
            '.rb-eyebrow{color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}',
            '.rb-title{color:var(--text-primary);font-size:24px;font-weight:900;margin-top:4px}',
            '.rb-desc{color:var(--text-secondary);font-size:13px;line-height:1.65;margin-top:6px;max-width:760px}',
            '.rb-status-pill{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(0,212,255,.26);border-radius:999px;background:rgba(0,212,255,.10);color:var(--accent);padding:8px 12px;font-size:12px;font-weight:800;white-space:nowrap}',
            '.rb-status-pill.on{border-color:rgba(0,255,136,.28);background:rgba(0,255,136,.1);color:var(--accent-green)}',
            '.rb-dot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 14px currentColor}',
            '.rb-actions-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
            '#rateBanPanelMount .rb-btn{min-height:38px;border:0!important;border-radius:12px;padding:9px 16px;background:linear-gradient(135deg,var(--accent),var(--accent-green))!important;color:#001018!important;font-weight:900;cursor:pointer;box-shadow:0 12px 28px rgba(0,212,255,.18)!important;transition:transform .16s ease,filter .16s ease,box-shadow .16s ease}',
            '#rateBanPanelMount .rb-btn.secondary,#rateBanPanelMount .rb-btn.danger{background:linear-gradient(135deg,var(--accent),var(--accent-green))!important;color:#001018!important;border:0!important;box-shadow:0 12px 28px rgba(0,212,255,.18)!important}',
            '#rateBanPanelMount .rb-btn:hover{filter:brightness(1.04);transform:translateY(-1px);box-shadow:0 14px 32px rgba(0,212,255,.22)!important}',
            '.rb-btn:disabled{opacity:.55;cursor:not-allowed}',
            '.rb-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:18px}',
            '.rb-metric{border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.045);padding:14px;min-width:0}',
            '.rb-metric strong{display:block;color:var(--accent);font-size:24px;line-height:1;font-weight:900}',
            '.rb-metric span{display:block;margin-top:8px;color:var(--text-secondary);font-size:12px}',
            '.rb-ban-list{margin-top:14px;border:1px solid rgba(255,255,255,.07);border-radius:14px;background:rgba(0,0,0,.14);padding:10px 12px}',
            '.rb-ban-list-head{color:var(--text-secondary);font-size:11px;font-weight:800;margin-bottom:8px;letter-spacing:.08em;text-transform:uppercase}',
            '.rb-ban-item{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px}',
            '.rb-ban-item:last-child{border-bottom:none}',
            '.rb-ban-ip{appearance:none;border:0;background:transparent;color:var(--accent);font-weight:800;min-width:100px;text-align:left;cursor:pointer;padding:0}.rb-ban-ip:hover{text-decoration:underline;color:var(--accent-green)}',
            '.rb-ban-item small{color:var(--text-secondary);flex:1}',
            '.rb-ban-dur{color:var(--accent-yellow);font-size:11px}',
            '.rb-section-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px}',
            '.rb-section{grid-column:span 6;border:1px solid rgba(0,212,255,.14);border-radius:20px;background:linear-gradient(180deg,rgba(8,22,38,.90),rgba(6,16,30,.94));padding:16px;box-shadow:0 14px 40px rgba(0,0,0,.15)}',
            '.rb-section.wide{grid-column:span 12}',
            '.rb-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}',
            '.rb-section-title{color:var(--text-primary);font-size:17px;font-weight:900;margin-top:3px}',
            '.rb-section-copy{color:var(--text-secondary);font-size:12px;line-height:1.55;margin-top:4px}',
            '.rb-section-index{display:grid;place-items:center;min-width:34px;height:34px;border-radius:12px;background:rgba(0,212,255,.10);color:var(--accent);font-weight:900}',
            '.rb-control-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
            '.rb-rules-list{display:flex;flex-direction:column;gap:12px}',
            '.rb-rule-card{border:1px solid rgba(0,212,255,.16);border-radius:16px;background:rgba(0,212,255,.035);padding:14px}',
            '.rb-rule-header{display:flex;align-items:center;gap:12px;margin-bottom:12px}',
            '.rb-rule-toggle{position:relative;display:flex;align-items:center;cursor:pointer}',
            '.rb-rule-toggle input{position:absolute;opacity:0;width:0;height:0}',
            '.rb-switch-control{position:relative;width:46px;height:26px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.1);transition:background .2s,border-color .2s;display:inline-block;flex-shrink:0}',
            '.rb-switch-control:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#d8e5ec;box-shadow:0 2px 6px rgba(0,0,0,.28);transition:transform .2s,background .2s;display:block}',
            '.rb-rule-toggle input:checked+.rb-switch-control,.rb-toggle-card input:checked+.rb-switch-control{background:linear-gradient(135deg,var(--accent),var(--accent-green));border-color:rgba(0,255,136,.42)}.rb-rule-toggle input:checked+.rb-switch-control:after,.rb-toggle-card input:checked+.rb-switch-control:after{transform:translateX(20px);background:#fff}',
            '.rb-rule-title{min-width:0;flex:1}.rb-rule-name-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.rb-rule-title strong{display:block;color:var(--text-primary);font-size:14px}.rb-rule-title small{display:block;color:var(--text-secondary);font-size:12px;margin-top:2px}.rb-rule-title p{margin:7px 0 0;color:#8fb6c8;font-size:12px;line-height:1.55}.rb-rule-badge{display:inline-flex;align-items:center;min-height:22px;border:1px solid rgba(0,212,255,.24);border-radius:999px;padding:2px 8px;background:rgba(0,212,255,.08);color:var(--accent);font-size:11px;font-weight:900;white-space:nowrap}',
            '.rb-rule-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding-top:12px;border-top:1px solid rgba(255,255,255,.06)}',
            '.rb-field{display:flex;flex-direction:column;gap:7px;border:1px solid rgba(255,255,255,.07);border-radius:16px;background:rgba(0,0,0,.13);padding:10px 12px;min-width:0}.rb-field span{color:var(--text-primary);font-size:12px;font-weight:800}.rb-field small{color:var(--text-secondary);font-size:11px;line-height:1.35}',
            '.rb-input{width:100%;min-height:36px;border:1px solid rgba(255,255,255,.1);border-radius:11px;padding:8px 10px;color:var(--text-primary);background:rgba(2,10,18,.72);font-size:14px;outline:none}.rb-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,212,255,.13)}',
            '.rb-toggle-card{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:12px;min-height:72px;padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.045);cursor:pointer;transition:border-color .2s,background .2s,transform .2s}',
            '.rb-toggle-card:hover{border-color:rgba(0,212,255,.38);background:rgba(0,212,255,.07);transform:translateY(-1px)}.rb-toggle-card input{position:absolute;opacity:0;pointer-events:none}',
            '.rb-switch-copy strong{display:block;color:var(--text-primary);font-size:13px;line-height:1.25}.rb-switch-copy small{display:block;color:var(--text-secondary);font-size:11px;line-height:1.45;margin-top:4px}',
            '.rb-footer{position:sticky;bottom:0;z-index:3;display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:rgba(6,16,30,.92);backdrop-filter:blur(14px);padding:12px 14px;box-shadow:0 -12px 38px rgba(0,0,0,.18)}',
            '.rb-footer-copy strong{display:block;color:var(--text-primary);font-size:13px}.rb-footer-copy span{display:block;color:var(--text-secondary);font-size:12px;margin-top:3px}.rb-footer-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
            '.rb-unavailable{margin-top:14px;border:1px solid rgba(255,71,87,.25);border-radius:14px;background:rgba(255,71,87,.1);color:#ff8a96;padding:12px;font-size:13px}',
            '@media(max-width:1180px){.rb-section{grid-column:span 12}}',
            '@media(max-width:760px){.rb-hero{padding:16px}.rb-title{font-size:20px}.rb-control-grid,.rb-rule-fields,.rb-rule-fields{grid-template-columns:1fr}.rb-footer{position:relative}.rb-footer-actions{width:100%}.rb-footer-actions .rb-btn{flex:1}}'
        ].join('');
    }

    function ensureStyles() {
        var style = document.getElementById(STYLE_ID);
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
            (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = renderStyles();
    }

    function renderShell() {
        var policy = state.policy || {};
        var rules = policy.rules || [];
        var rulesHtml = rules.map(function(rule, i) {
            return ruleCard(rule, i);
        }).join('');

        return '<div class="rb-page">' +
            '<section class="rb-hero"><div class="rb-hero-main"><div><div class="rb-title">限速封禁策略中心</div><div class="rb-desc">统一管理后台管理接口和 IM 聊天接口的速率限制。超过配置的每秒上限后自动封禁对应 IP，支持按接口单独配置阈值和统计窗口。</div></div><div class="rb-actions-top"><div class="rb-status-pill" id="rbStatusPill"><span class="rb-dot"></span><span id="rbStatusText"></span></div><button class="rb-btn secondary" id="rbRefreshBtn">刷新</button></div></div><div class="rb-unavailable" id="rbUnavailableMessage" style="display:none"></div><div id="rbRuntimeBlock"></div></section>' +
            '<div class="rb-section-grid">' +
                '<section class="rb-section wide"><div class="rb-section-head"><div><div class="rb-section-title">受保护的接口规则</div><div class="rb-section-copy">勾选启用规则后，该前缀路径的请求将受到速率限制。超过阈值后自动封禁对应 IP。</div></div><div class="rb-section-index">01</div></div><div class="rb-rules-list">' + rulesHtml + '</div></section>' +
                '<section class="rb-section"><div class="rb-section-head"><div><div class="rb-section-title">全局设置</div><div class="rb-section-copy">控制限速封禁总开关和封禁时长。</div></div><div class="rb-section-index">02</div></div><div class="rb-control-grid">' +
                    switchCard('rbEnabled', '启用限速封禁', '关闭后所有速率限制暂停', policy.enabled !== false) +
                    switchCard('rbIgnoreLoopback', '忽略本机 IP', '避免本机调试被误封', policy.ignore_loopback !== false) +
                '</div></section>' +
                '<section class="rb-section"><div class="rb-section-head"><div><div class="rb-section-title">封禁时长</div><div class="rb-section-copy">触发限速封禁后的基础封禁时长。</div></div><div class="rb-section-index">03</div></div><div class="rb-control-grid">' +
                    numberField('rbBanBaseSeconds', '基础封禁时长（秒）', '默认 3600 秒', policy.ban_base_seconds, 60, 86400 * 7) +
                '</div></section>' +
            '</div>' +
            '<section class="rb-footer"><div class="rb-footer-copy"><strong>保存后立即应用到运行策略</strong><span>清空运行计数不会解除已经封禁的 IP。</span></div><div class="rb-footer-actions"><button class="rb-btn" id="rbSaveBtn">保存配置</button><button class="rb-btn danger" id="rbClearBtn">清空运行计数</button></div></section>' +
        '</div>';
    }

    function updateDynamicView() {
        var disabled = state.saving || state.loading;
        var policy = state.policy || {};
        var enabled = policy.enabled !== false;
        var statusPill = document.getElementById('rbStatusPill');
        var unavailable = document.getElementById('rbUnavailableMessage');
        var runtimeBlock = document.getElementById('rbRuntimeBlock');
        var refreshBtn = document.getElementById('rbRefreshBtn');
        var saveBtn = document.getElementById('rbSaveBtn');
        var clearBtn = document.getElementById('rbClearBtn');
        if (statusPill) statusPill.className = 'rb-status-pill' + (enabled ? ' on' : '');
        setText('rbStatusText', enabled ? '策略运行中' : '策略已停用');
        if (unavailable) {
            unavailable.style.display = state.available === false ? '' : 'none';
            unavailable.textContent = state.message || '限速封禁模块不可用';
        }
        if (runtimeBlock) {
            var runtimeHtml = renderRuntime();
            if (state.runtimeHtml !== runtimeHtml) {
                state.runtimeHtml = runtimeHtml;
                runtimeBlock.innerHTML = runtimeHtml;
            }
        }
        if (refreshBtn) refreshBtn.disabled = disabled;
        if (saveBtn) saveBtn.disabled = disabled;
        if (clearBtn) clearBtn.disabled = !!state.clearing;
    }

    function render() {
        var root = mount();
        if (!root) return;
        ensureStyles();
        var rules = state.policy && state.policy.rules || [];
        var shellKey = rules.map(function(rule) {
            return String(rule.id || '') + ':' + String(rule.route_prefix || '');
        }).join('|');
        if (!state.rendered || !root.querySelector('.rb-page') || state.shellKey !== shellKey) {
            root.innerHTML = renderShell();
            state.rendered = true;
            state.shellKey = shellKey;
            bindEvents();
        }
        updateDynamicView();
        fillPolicy();
    }

    function fillPolicy() {
        var p = state.policy || {};
        setInputChecked('rbEnabled', p.enabled !== false);
        setInputChecked('rbIgnoreLoopback', p.ignore_loopback !== false);
        setInputValue('rbBanBaseSeconds', p.ban_base_seconds || 3600);
        var rules = p.rules || [];
        rules.forEach(function(rule, i) {
            var enabledEl = document.querySelector('#rbRule' + escapeHtml(rule.id || i) + ' .rb-rule-enabled');
            var rpsEl = document.getElementById('rbRps' + i);
            var winEl = document.getElementById('rbWindow' + i);
            var limitEl = document.getElementById('rbWindowLimit' + i);
            var banEl = document.getElementById('rbBanSeconds' + i);
            if (enabledEl) enabledEl.checked = rule.enabled !== false;
            if (rpsEl) rpsEl.value = rule.requests_per_second || 10;
            if (winEl) winEl.value = rule.window_seconds || 60;
            if (limitEl) limitEl.value = rule.window_request_limit || 0;
            if (banEl) banEl.value = rule.ban_seconds || 0;
        });
    }

    function collectPolicy() {
        var p = state.policy || {};
        var rules = (p.rules || []).map(function(rule, i) {
            var ruleEl = document.getElementById('rbRule' + escapeHtml(rule.id || i));
            var enabledEl = ruleEl && ruleEl.querySelector('.rb-rule-enabled');
            var rpsEl = document.getElementById('rbRps' + i);
            var winEl = document.getElementById('rbWindow' + i);
            var limitEl = document.getElementById('rbWindowLimit' + i);
            var banEl = document.getElementById('rbBanSeconds' + i);
            return {
                id: rule.id,
                label: rule.label,
                route_prefix: rule.route_prefix,
                methods: rule.methods || [],
                requests_per_second: Number(rpsEl && rpsEl.value || 10),
                window_seconds: Number(winEl && winEl.value || 60),
                window_request_limit: Number(limitEl && limitEl.value || 0),
                ban_seconds: Number(banEl && banEl.value || 0),
                exclude_loopback: rule.exclude_loopback !== false,
                enabled: !!(enabledEl && enabledEl.checked)
            };
        });
        return {
            enabled: checkedValue('rbEnabled'),
            ignore_loopback: checkedValue('rbIgnoreLoopback'),
            ban_base_seconds: numberValue('rbBanBaseSeconds'),
            rules: rules
        };
    }

    function bindEvents() {
        var refreshBtn = document.getElementById('rbRefreshBtn');
        var saveBtn = document.getElementById('rbSaveBtn');
        var clearBtn = document.getElementById('rbClearBtn');
        if (refreshBtn) refreshBtn.onclick = function() { load(true); };
        if (saveBtn) saveBtn.onclick = save;
        if (clearBtn) clearBtn.onclick = clearRuntime;
        var runtimeBlock = document.getElementById('rbRuntimeBlock');
        if (runtimeBlock) {
            runtimeBlock.onclick = function(event) {
                var target = event.target && event.target.closest ? event.target.closest('.rb-ban-ip[data-ip]') : null;
                if (!target) return;
                var ip = target.getAttribute('data-ip') || '';
                if (ip && typeof window.showIpInfoModal === 'function') {
                    window.showIpInfoModal(ip);
                } else if (ip) {
                    notify('请在封禁列表中查看 IP 来源详情', 'info');
                }
            };
        }
    }

    function load(force) {
        if (state.loading) return;
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
            notify('限速封禁配置加载失败：' + error.message, 'error');
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
            notify('限速封禁配置已保存', 'success');
            return api('/status');
        }).then(function(body) {
            var item = body.item || {};
            state.runtime = item.runtime || {};
        }).catch(function(error) {
            notify('限速封禁配置保存失败：' + error.message, 'error');
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
            notify('限速封禁运行计数已清空', 'success');
        }).catch(function(error) {
            notify('清空运行计数失败：' + error.message, 'error');
        }).finally(function() {
            state.clearing = false;
            render();
        });
    }

    window.AKRateBanPanel = {
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

    if (document.querySelector('.tab.active[data-panel="rateBan"]')) {
        window.AKRateBanPanel.start();
    }
})();
