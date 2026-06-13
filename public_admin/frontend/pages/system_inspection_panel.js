(function() {
    'use strict';

    if (window.AKSystemInspectionPanelLoaded) return;
    window.AKSystemInspectionPanelLoaded = true;

    var state = {
        rendered: false,
        loading: false,
        data: null,
        error: ''
    };

    var STYLE_ID = 'akSystemInspectionPanelStyle';

    function token() {
        return sessionStorage.getItem('admin_token') || '';
    }

    function mount() {
        return document.getElementById('systemInspectionPanelMount');
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
        return fetch('/admin/api/system-inspection' + path, {
            headers: { 'Authorization': 'Bearer ' + token() },
            credentials: 'same-origin'
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error) throw new Error(body.message || body.detail || '系统巡检接口请求失败');
                return body;
            });
        });
    }

    function ensureStyles() {
        var style = document.getElementById(STYLE_ID);
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
            (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = [
            '.si-page{display:flex;flex-direction:column;gap:16px}',
            '.si-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;background:linear-gradient(135deg,var(--bg-card),rgba(0,212,255,.045));border:1px solid var(--border);border-radius:16px;padding:18px 20px}',
            '.si-title{display:flex;flex-direction:column;gap:6px}.si-title h3{margin:0;color:var(--accent);font-size:20px}.si-title p{margin:0;color:var(--text-secondary);font-size:13px;line-height:1.55}',
            '.si-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}#systemInspectionPanelMount .si-btn{border:0!important;background:linear-gradient(135deg,var(--accent),var(--accent-green))!important;color:#001018!important;border-radius:10px;padding:9px 12px;font-size:13px;font-weight:900;cursor:pointer;box-shadow:0 12px 28px rgba(0,212,255,.18)!important;transition:transform .16s ease,filter .16s ease,box-shadow .16s ease}#systemInspectionPanelMount .si-btn:hover{filter:brightness(1.04);transform:translateY(-1px);box-shadow:0 14px 32px rgba(0,212,255,.22)!important}#systemInspectionPanelMount .si-btn.primary{border-color:transparent;color:#001018;background:linear-gradient(135deg,var(--accent),var(--accent-green))}#systemInspectionPanelMount .si-btn:disabled{opacity:.55;cursor:not-allowed}',
            '.si-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.si-card{border:1px solid var(--border);border-radius:14px;padding:14px;background:var(--bg-card);min-height:86px}.si-card-label{font-size:12px;color:var(--text-secondary);margin-bottom:8px}.si-card-value{font-size:24px;font-weight:800;color:var(--text-primary)}.si-card-copy{font-size:12px;color:var(--text-secondary);line-height:1.5;margin-top:6px}',
            '.si-status{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:5px 10px;font-size:12px;font-weight:700;border:1px solid var(--border)}.si-status::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}.si-status.ok{color:#00ff88;background:rgba(0,255,136,.1);border-color:rgba(0,255,136,.24)}.si-status.warn{color:#f5cd60;background:rgba(245,205,96,.1);border-color:rgba(245,205,96,.28)}.si-status.error{color:#ff6b7a;background:rgba(255,71,87,.1);border-color:rgba(255,71,87,.3)}',
            '.si-empty,.si-error{border:1px dashed var(--border);border-radius:14px;padding:24px;text-align:center;color:var(--text-secondary);background:rgba(255,255,255,.025)}.si-error{color:#ff6b7a;border-color:rgba(255,71,87,.35);background:rgba(255,71,87,.06)}',
            '.si-section{border:1px solid var(--border);border-radius:14px;background:var(--bg-card);overflow:hidden}.si-section[open]{border-color:rgba(0,212,255,.32)}.si-section-summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;cursor:pointer}.si-section-summary::-webkit-details-marker{display:none}.si-section-name{display:flex;align-items:center;gap:10px;font-weight:800;color:var(--text-primary)}.si-section-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.si-caret{color:var(--text-secondary);transition:transform .18s}.si-section[open] .si-caret{transform:rotate(90deg)}',
            '.si-check-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;padding:0 16px 16px}.si-check{border:1px solid rgba(255,255,255,.08);border-radius:12px;background:rgba(255,255,255,.025);padding:13px;display:flex;flex-direction:column;gap:9px;min-width:0}.si-check-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.si-check-title{font-weight:800;color:var(--text-primary);font-size:14px}.si-check-message{color:var(--text-primary);font-size:13px;line-height:1.5}.si-check-suggestion{color:var(--text-secondary);font-size:12px;line-height:1.55;border-left:2px solid rgba(0,212,255,.4);padding-left:9px}.si-detail{display:flex;flex-wrap:wrap;gap:6px}.si-kv{font-size:11px;color:var(--text-secondary);border:1px solid rgba(255,255,255,.08);border-radius:999px;padding:3px 8px;background:rgba(255,255,255,.025);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '@media(max-width:760px){.si-hero{padding:16px}.si-actions{width:100%;display:grid;grid-template-columns:1fr 1fr}.si-actions .si-btn.primary{grid-column:1/-1}.si-check-list{grid-template-columns:1fr;padding:0 12px 12px}.si-section-summary{align-items:flex-start}.si-section-meta{justify-content:flex-end}}'
        ].join('');
    }

    function statusLabel(status) {
        if (status === 'ok') return '正常';
        if (status === 'error') return '异常';
        return '提醒';
    }

    function statusClass(status) {
        return status === 'ok' || status === 'error' ? status : 'warn';
    }

    function statusPill(status) {
        var cls = statusClass(status);
        return '<span class="si-status ' + cls + '">' + statusLabel(cls) + '</span>';
    }

    function formatTime(value) {
        if (!value) return '-';
        try {
            return new Date(value).toLocaleString();
        } catch (e) {
            return String(value || '-');
        }
    }

    function formatValue(value) {
        if (value == null || value === '') return '-';
        if (Array.isArray(value)) return value.join(' / ') || '-';
        if (typeof value === 'boolean') return value ? '是' : '否';
        if (typeof value === 'number') return Math.round(value * 100) / 100;
        return String(value);
    }

    function renderDetail(detail) {
        var payload = detail || {};
        var keys = Object.keys(payload).filter(function(key) {
            var value = payload[key];
            return value !== undefined && value !== null && value !== '';
        });
        if (!keys.length) return '';
        return '<div class="si-detail">' + keys.slice(0, 10).map(function(key) {
            return '<span class="si-kv">' + escapeHtml(key) + ': ' + escapeHtml(formatValue(payload[key])) + '</span>';
        }).join('') + '</div>';
    }

    function renderCheck(item) {
        return '<article class="si-check">' +
            '<div class="si-check-head"><div class="si-check-title">' + escapeHtml(item.title || '-') + '</div>' + statusPill(item.status) + '</div>' +
            '<div class="si-check-message">' + escapeHtml(item.message || '-') + '</div>' +
            renderDetail(item.detail) +
            (item.suggestion ? '<div class="si-check-suggestion">' + escapeHtml(item.suggestion) + '</div>' : '') +
            '<div class="si-card-copy">耗时 ' + escapeHtml(item.elapsed_ms || 0) + ' ms</div>' +
            '</article>';
    }

    function renderGroup(group) {
        var items = group.items || [];
        return '<details class="si-section" data-si-section="' + escapeHtml(group.name || '') + '">' +
            '<summary class="si-section-summary">' +
            '<div class="si-section-name"><span class="si-caret">›</span><span>' + escapeHtml(group.name || '其他') + '</span></div>' +
            '<div class="si-section-meta">' + statusPill(group.status) + '<span class="si-card-copy">' + items.length + ' 项</span></div>' +
            '</summary>' +
            '<div class="si-check-list">' + items.map(renderCheck).join('') + '</div>' +
            '</details>';
    }

    function renderResult() {
        if (state.loading) {
            return '<div class="si-empty">正在执行系统巡检...</div>';
        }
        if (state.error) {
            return '<div class="si-error">' + escapeHtml(state.error) + '</div>';
        }
        if (!state.data) {
            return '<div class="si-empty">点击“立即巡检”后开始检查基础服务、网络链路、缓存通知和最近风险。</div>';
        }
        var data = state.data || {};
        var summary = data.summary || {};
        var counts = summary.counts || {};
        return '<div class="si-summary">' +
            '<div class="si-card"><div class="si-card-label">整体状态</div><div class="si-card-value">' + statusPill(summary.status) + '</div><div class="si-card-copy">' + escapeHtml(summary.message || '系统巡检完成') + '</div></div>' +
            '<div class="si-card"><div class="si-card-label">正常 / 提醒 / 异常</div><div class="si-card-value">' + escapeHtml(counts.ok || 0) + ' / ' + escapeHtml(counts.warn || 0) + ' / ' + escapeHtml(counts.error || 0) + '</div><div class="si-card-copy">共 ' + escapeHtml(summary.total || 0) + ' 个检查项</div></div>' +
            '<div class="si-card"><div class="si-card-label">生成时间</div><div class="si-card-value" style="font-size:15px">' + escapeHtml(formatTime(data.generated_at)) + '</div><div class="si-card-copy">巡检耗时 ' + escapeHtml(data.elapsed_ms || 0) + ' ms</div></div>' +
            '</div>' +
            (data.groups || []).map(renderGroup).join('');
    }

    function render() {
        var root = mount();
        if (!root) return;
        ensureStyles();
        root.innerHTML = '<div class="si-page">' +
            '<section class="si-hero">' +
            '<div class="si-title"><h3>系统巡检</h3><p>按需检查关键服务、上游链路、缓存与通知状态。默认不自动巡检，避免给业务路径增加额外压力。</p></div>' +
            '<div class="si-actions"><button class="si-btn primary" id="siRunBtn">立即巡检</button><button class="si-btn" id="siExpandBtn">展开全部</button><button class="si-btn" id="siCollapseBtn">收起全部</button></div>' +
            '</section>' +
            '<div id="siResult">' + renderResult() + '</div>' +
            '</div>';
        state.rendered = true;
        bindEvents();
    }

    function bindEvents() {
        var runBtn = document.getElementById('siRunBtn');
        var expandBtn = document.getElementById('siExpandBtn');
        var collapseBtn = document.getElementById('siCollapseBtn');
        if (runBtn) {
            runBtn.disabled = !!state.loading;
            runBtn.onclick = function() { runInspection(); };
        }
        if (expandBtn) expandBtn.onclick = function() { setAllSections(true); };
        if (collapseBtn) collapseBtn.onclick = function() { setAllSections(false); };
    }

    function setAllSections(open) {
        Array.prototype.slice.call(document.querySelectorAll('#systemInspectionPanelMount details.si-section')).forEach(function(node) {
            node.open = !!open;
        });
    }

    function runInspection() {
        if (state.loading) return;
        state.loading = true;
        state.error = '';
        render();
        api('/run?t=' + Date.now()).then(function(body) {
            state.data = body;
            state.loading = false;
            render();
            notify('系统巡检完成', body && body.summary && body.summary.status === 'error' ? 'warning' : 'success');
        }).catch(function(err) {
            state.loading = false;
            state.error = err && err.message || '系统巡检失败';
            render();
            notify(state.error, 'error');
        });
    }

    function start() {
        render();
    }

    window.AKSystemInspectionPanel = {
        start: start,
        reload: runInspection
    };

    if (document.querySelector('.tab.active[data-panel="systemInspection"]')) {
        start();
    }
})();
