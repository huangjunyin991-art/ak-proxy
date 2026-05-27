(function() {
    'use strict';

    if (window.AKRiskIsolationPanelLoaded) return;
    window.AKRiskIsolationPanelLoaded = true;

    var state = {
        loading: false,
        saving: false,
        loaded: false,
        loadStarted: false,
        role: '',
        subName: '',
        subAdmins: [],
        selectedSubAdmin: '',
        dropdownQuery: '',
        selectedInitial: '',
        ready: false,
        page404Enabled: true,
        showIsolatedOnly: false,
        search: '',
        total: 0,
        isolatedTotal: 0,
        rows: []
    };
    var STYLE_ID = 'akRiskIsolationPanelStyle';
    var dropdownDocumentHandlerBound = false;
    var searchTimer = null;
    var readyRetryTimer = null;
    var searchComposing = false;
    var dropdownComposing = false;

    function token() {
        return sessionStorage.getItem('admin_token') || '';
    }

    function mount() {
        return document.getElementById('riskIsolationPanelMount');
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>'"]/g, function(ch) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[ch] || ch;
        });
    }

    function jsArg(value) {
        return JSON.stringify(String(value == null ? '' : value));
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
        return fetch('/admin/api/risk-isolation' + path, {
            headers: { 'Authorization': 'Bearer ' + token() },
            credentials: 'same-origin'
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error || body.success === false) throw new Error(body.message || body.detail || '风险隔离接口请求失败');
                return body;
            });
        });
    }

    function apiPost(path, payload) {
        return fetch('/admin/api/risk-isolation' + path, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token(),
                'Content-Type': 'application/json'
            },
            credentials: 'same-origin',
            body: JSON.stringify(payload || {})
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error || body.success === false) throw new Error(body.message || body.detail || '风险隔离接口请求失败');
                return body;
            });
        });
    }

    function isSuperAdmin() {
        return state.role === 'super_admin';
    }

    function fmtTime(value) {
        if (!value) return '-';
        try {
            return new Date(value.replace(' ', 'T')).toLocaleString();
        } catch (e) {
            return value;
        }
    }

    function firstInitial(value) {
        var text = String(value || '').trim();
        if (!text) return '#';
        var ch = text.charAt(0);
        var upper = ch.toUpperCase();
        if (upper >= 'A' && upper <= 'Z') return upper;
        var map = {
            '赵':'Z','钱':'Q','孙':'S','李':'L','周':'Z','吴':'W','郑':'Z','王':'W','冯':'F','陈':'C','褚':'C','卫':'W','蒋':'J','沈':'S','韩':'H','杨':'Y','朱':'Z','秦':'Q','尤':'Y','许':'X','何':'H','吕':'L','施':'S','张':'Z','孔':'K','曹':'C','严':'Y','华':'H','金':'J','魏':'W','陶':'T','姜':'J','谢':'X','邹':'Z','喻':'Y','柏':'B','窦':'D','章':'Z','云':'Y','苏':'S','潘':'P','葛':'G','范':'F','彭':'P','郎':'L','鲁':'L','韦':'W','昌':'C','马':'M','苗':'M','凤':'F','花':'H','方':'F','俞':'Y','任':'R','袁':'Y','柳':'L','鲍':'B','史':'S','唐':'T','费':'F','廉':'L','薛':'X','雷':'L','贺':'H','倪':'N','汤':'T','罗':'L','毕':'B','郝':'H','安':'A','常':'C','于':'Y','傅':'F','齐':'Q','康':'K','伍':'W','余':'Y','顾':'G','孟':'M','黄':'H','萧':'X','尹':'Y','姚':'Y','邵':'S','汪':'W','毛':'M','狄':'D','米':'M','贝':'B','明':'M','成':'C','戴':'D','宋':'S','庞':'P','熊':'X','纪':'J','舒':'S','屈':'Q','项':'X','祝':'Z','董':'D','梁':'L','杜':'D','阮':'R','蓝':'L','席':'X','季':'J','麻':'M','强':'Q','贾':'J','路':'L','江':'J','童':'T','颜':'Y','郭':'G','梅':'M','林':'L','钟':'Z','徐':'X','邱':'Q','骆':'L','高':'G','夏':'X','蔡':'C','田':'T','胡':'H','凌':'L','万':'W','卢':'L','莫':'M','房':'F','解':'X','应':'Y','宗':'Z','丁':'D','宣':'X','邓':'D','洪':'H','包':'B','左':'Z','石':'S','崔':'C','吉':'J','龚':'G','程':'C','邢':'X','裴':'P','陆':'L','翁':'W','惠':'H','曲':'Q','家':'J','封':'F','靳':'J','松':'S','段':'D','富':'F','巫':'W','乌':'W','焦':'J','巴':'B','侯':'H','全':'Q','班':'B','秋':'Q','仲':'Z','宫':'G','宁':'N','仇':'Q','栾':'L','甘':'G','厉':'L','祖':'Z','武':'W','符':'F','刘':'L','景':'J','詹':'Z','束':'S','龙':'L','叶':'Y','司':'S','黎':'L','白':'B','怀':'H','蒲':'P','从':'C','索':'S','赖':'L','卓':'Z','屠':'T','蒙':'M','池':'C','乔':'Q','党':'D','翟':'Z','谭':'T','劳':'L','姬':'J','申':'S','扶':'F','冉':'R','雍':'Y','桑':'S','桂':'G','牛':'N','寿':'S','边':'B','燕':'Y','冀':'J','尚':'S','温':'W','庄':'Z','柴':'C','阎':'Y','艾':'A','鱼':'Y','向':'X','古':'G','易':'Y','廖':'L'
        };
        return map[ch] || '#';
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
            '#riskIsolationPanelMount{display:block}',
            '.ri-wrap{display:flex;flex-direction:column;gap:16px}',
            '.ri-card{border:1px solid var(--border);border-radius:16px;background:linear-gradient(135deg,var(--bg-card),rgba(255,71,87,.05));padding:16px}',
            '.ri-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}.ri-title{color:var(--accent);font-size:18px;font-weight:800}.ri-desc{color:var(--text-secondary);font-size:12px;margin-top:4px;line-height:1.5}',
            '.ri-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.ri-stat{border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.035);padding:14px}.ri-stat.clickable{cursor:pointer;transition:border-color .16s ease,background .16s ease,box-shadow .16s ease}.ri-stat.clickable:hover,.ri-stat.active{border-color:rgba(0,212,255,.42);background:rgba(0,212,255,.08);box-shadow:0 0 18px rgba(0,212,255,.1)}.ri-stat-label{font-size:12px;color:var(--text-secondary)}.ri-stat-value{font-size:24px;font-weight:800;color:var(--accent);margin-top:5px}',
            '.ri-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.ri-toolbar>.ri-scope-dropdown{flex:0 0 260px}.ri-toolbar>.ri-switch{flex:0 0 auto}.ri-toolbar>.ri-input{flex:1 1 280px;max-width:460px}.ri-toolbar>.ri-btn{flex:0 0 auto;width:auto}',
            '.ri-input{min-height:42px;border:1px solid rgba(57,126,255,.38);border-radius:12px;padding:0 12px;color:#fff;background:linear-gradient(180deg,rgba(5,15,30,.98),rgba(8,20,38,.98));font-size:14px;font-weight:800;outline:none}.ri-input::placeholder{color:rgba(170,200,235,.72)}.ri-input:focus{border-color:#27d8ff;box-shadow:0 0 0 3px rgba(0,212,255,.12),0 10px 24px rgba(0,0,0,.22)}',
            '.ri-switch{min-height:42px;border:1px solid rgba(57,126,255,.42);border-radius:12px;padding:0 12px;color:#fff;background:linear-gradient(180deg,rgba(5,15,30,.98),rgba(8,20,38,.98));display:flex;align-items:center;gap:9px;font-size:13px;font-weight:900;cursor:pointer;box-shadow:0 6px 16px rgba(0,0,0,.2)}.ri-switch input{position:absolute;opacity:0;pointer-events:none}.ri-switch-track{width:38px;height:20px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.12);position:relative;transition:all .16s ease}.ri-switch-track:before{content:"";position:absolute;width:16px;height:16px;left:2px;top:2px;border-radius:50%;background:rgba(230,242,255,.86);transition:transform .16s ease}.ri-switch input:checked+.ri-switch-track{background:linear-gradient(135deg,#00d4ff,#00b8d4);border-color:rgba(39,216,255,.68);box-shadow:0 0 14px rgba(0,212,255,.2)}.ri-switch input:checked+.ri-switch-track:before{transform:translateX(18px);background:#fff}.ri-switch-text{white-space:nowrap}',
            '.ri-scope-dropdown{position:relative;width:260px;min-width:220px;max-width:300px;z-index:80}.ri-scope-trigger{width:100%;min-height:42px;border:1px solid rgba(57,126,255,.42);border-radius:12px;padding:0 12px 0 14px;color:#fff;background:linear-gradient(180deg,rgba(5,15,30,.98),rgba(8,20,38,.98));font-size:14px;font-weight:900;line-height:1.2;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;outline:none;box-shadow:0 6px 16px rgba(0,0,0,.2)}.ri-scope-trigger:focus{border-color:#27d8ff;box-shadow:0 0 0 3px rgba(0,212,255,.12),0 8px 22px rgba(0,0,0,.24)}',
            '.ri-scope-caret{width:8px;height:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);font-size:0;line-height:0;margin-right:2px;opacity:.9;transition:transform .16s ease}.ri-scope-dropdown.open .ri-scope-caret{transform:rotate(225deg);margin-top:5px}',
            '.ri-scope-menu{position:absolute;left:0;right:auto;top:calc(100% - 1px);display:none;width:min(320px,calc(100vw - 32px));overflow:hidden;border:1px solid rgba(57,126,255,.5);border-top:0;border-radius:0 0 14px 14px;background:linear-gradient(180deg,#06162b,#172234);box-shadow:0 18px 38px rgba(0,0,0,.48),0 0 0 2px rgba(39,216,255,.06);z-index:120}.ri-scope-dropdown.open .ri-scope-menu{display:block}',
            '.ri-scope-search{padding:8px;border-bottom:1px solid rgba(255,255,255,.08)}.ri-scope-search input{width:100%;box-sizing:border-box;min-height:32px;border:1px solid rgba(57,126,255,.38);border-radius:10px;background:rgba(0,0,0,.18);color:#fff;padding:0 10px;font-size:12px;font-weight:800;outline:none}.ri-scope-search input::placeholder{color:rgba(170,200,235,.7)}',
            '.ri-scope-alpha{display:grid;grid-template-columns:repeat(9,1fr);gap:2px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.06);background:rgba(0,0,0,.1)}.ri-alpha-item{min-height:18px;border:0;border-radius:6px;background:transparent;color:rgba(220,235,255,.76);font-size:10px;font-weight:900;line-height:18px;cursor:pointer}.ri-alpha-item:hover,.ri-alpha-item.active{background:rgba(45,108,223,.78);color:#fff}',
            '.ri-scope-body{display:block;max-height:240px}.ri-scope-list{max-height:240px;overflow:auto;padding:4px;background:rgba(4,14,28,.72)}.ri-scope-option{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:38px;border:1px solid rgba(57,126,255,.18);border-radius:10px;background:rgba(6,18,34,.78);color:#f4f8ff;padding:0 10px 0 12px;margin:0 0 4px 0;font-size:14px;font-weight:800;cursor:pointer;text-align:left;opacity:1;visibility:visible}.ri-scope-option:hover,.ri-scope-option.active{border-color:rgba(45,108,223,.48);background:rgba(45,108,223,.24);color:#fff}.ri-scope-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;font-weight:850;opacity:1}.ri-scope-count{font-size:12px;font-weight:800;color:rgba(214,232,255,.82);opacity:1}.ri-scope-empty{padding:22px 16px;color:rgba(220,235,255,.68);font-weight:800;text-align:center}',
            '.ri-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(1,8,18,.74);backdrop-filter:blur(12px);z-index:9999}.ri-modal.open{display:flex}.ri-modal-card{width:min(520px,100%);border:1px solid rgba(39,216,255,.3);border-radius:20px;background:linear-gradient(145deg,rgba(8,20,38,.98),rgba(5,14,28,.98));box-shadow:0 26px 70px rgba(0,0,0,.58),0 0 0 1px rgba(255,255,255,.05);overflow:hidden}.ri-modal-head{padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.ri-modal-title{font-size:18px;font-weight:900;color:#fff}.ri-modal-desc{margin-top:6px;color:rgba(208,226,247,.72);font-size:13px;line-height:1.55}.ri-modal-close{width:34px;height:34px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(255,255,255,.05);color:rgba(230,242,255,.86);font-size:20px;line-height:1;cursor:pointer}.ri-modal-body{padding:18px 20px 8px}.ri-modal-label{display:block;color:rgba(230,242,255,.86);font-size:13px;font-weight:900;margin-bottom:8px}.ri-modal-input{width:100%;min-height:92px;box-sizing:border-box;border:1px solid rgba(57,126,255,.4);border-radius:14px;background:linear-gradient(180deg,rgba(5,15,30,.98),rgba(8,20,38,.98));color:#fff;padding:12px 14px;font-size:14px;font-weight:800;line-height:1.55;resize:vertical;outline:none}.ri-modal-input::placeholder{color:rgba(170,200,235,.62)}.ri-modal-input:focus{border-color:#27d8ff;box-shadow:0 0 0 3px rgba(0,212,255,.13)}.ri-modal-foot{padding:16px 20px 20px;display:flex;justify-content:flex-end;gap:10px}.ri-modal-btn{border:1px solid transparent;border-radius:13px;min-width:92px;min-height:42px;padding:0 18px;color:#fff;font-size:14px;font-weight:900;cursor:pointer}.ri-modal-btn.cancel{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12);color:rgba(230,242,255,.82)}.ri-modal-btn.confirm{background:linear-gradient(135deg,#00d4ff,#00b8d4);box-shadow:0 12px 24px rgba(0,212,255,.2)}.ri-modal-input-wrap.hidden{display:none}',
            '.ri-btn{border:1px solid transparent;border-radius:12px;min-height:42px;padding:0 14px;font-size:14px;font-weight:900;letter-spacing:.01em;white-space:nowrap;cursor:pointer;color:#fff}.ri-btn:disabled{opacity:.55;cursor:not-allowed}.ri-btn.secondary{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12)}.ri-btn.cyan{background:linear-gradient(135deg,#00d4ff,#00b8d4);box-shadow:0 10px 22px rgba(0,212,255,.18)}.ri-btn.danger{background:linear-gradient(135deg,#ff4757,#c44569);box-shadow:0 10px 22px rgba(255,71,87,.18)}.ri-btn.success{background:linear-gradient(135deg,#00b894,#00cec9);box-shadow:0 10px 22px rgba(0,184,148,.18)}',
            '.ri-table-wrap{overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;overscroll-behavior-y:auto;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.02);position:relative}.ri-table{width:max-content;min-width:980px;border-collapse:separate;border-spacing:0}.ri-table th,.ri-table td{border-bottom:1px solid rgba(255,255,255,.07);padding:8px 10px;text-align:left;white-space:nowrap}.ri-table th{position:sticky;top:0;z-index:20;color:var(--accent);background:var(--bg-secondary);font-size:11px}.ri-table td{font-size:12px;line-height:1.25;color:var(--text-primary);background:var(--bg-card)}.ri-table th:first-child,.ri-table td:first-child{position:sticky;left:0;width:120px;min-width:120px;max-width:120px;z-index:12;background:var(--bg-card)}.ri-table th:first-child{z-index:30;background:var(--bg-secondary)}.ri-table tr:last-child td{border-bottom:0}.ri-table .ri-btn{min-height:34px;border-radius:10px;padding:0 12px;font-size:12px}',
            '.ri-empty{text-align:center;color:var(--text-secondary);padding:28px!important}.ri-pill{display:inline-flex;border-radius:999px;padding:2px 7px;font-size:11px;font-weight:800}.ri-pill.on{color:#ffb8bf;background:rgba(255,71,87,.14);border:1px solid rgba(255,71,87,.3)}.ri-pill.off{color:#55efc4;background:rgba(0,184,148,.13);border:1px solid rgba(0,184,148,.28)}.ri-cards{display:none!important;gap:10px}.ri-user-card{border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.035);padding:12px}.ri-user-card.ri-muted{color:var(--text-secondary);text-align:center}.ri-user-head{display:flex;justify-content:space-between;gap:8px;align-items:center}.ri-user-name{font-weight:900;color:#fff}.ri-user-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}.ri-user-label{color:var(--text-secondary);font-size:11px}.ri-user-value{color:var(--text-primary);font-size:12px;word-break:break-all}',
            '@media(max-width:760px){.ri-card{padding:12px}.ri-stats{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.ri-stat{padding:10px 8px}.ri-stat-label{font-size:11px;white-space:nowrap}.ri-stat-value{font-size:18px}.ri-toolbar{align-items:flex-start}.ri-toolbar>.ri-scope-dropdown{flex:0 1 260px}.ri-toolbar>.ri-input{flex:1 1 220px;max-width:none}.ri-scope-dropdown{width:260px;min-width:0}.ri-scope-menu{width:min(320px,calc(100vw - 32px));max-width:none}.ri-table{min-width:980px}}',
            '@media(max-width:560px){.ri-stats{gap:6px}.ri-stat{padding:9px 6px;border-radius:12px}.ri-stat-label{font-size:10px}.ri-stat-value{font-size:16px;margin-top:4px}.ri-toolbar{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;align-items:center}.ri-toolbar>.ri-scope-dropdown{grid-column:1 / 3;flex:none;width:100%;max-width:none}.ri-toolbar>.ri-switch{grid-column:3;flex:none;justify-content:center;padding:0 8px}.ri-toolbar>.ri-input{grid-column:1;flex:none;width:100%;max-width:none;min-width:0}.ri-toolbar>.ri-btn{grid-column:auto;flex:none;padding:0 10px;font-size:12px}.ri-scope-dropdown{width:100%;max-width:none}.ri-scope-menu{width:100%;min-width:100%}.ri-modal{padding:12px}.ri-modal-head,.ri-modal-body,.ri-modal-foot{padding-left:16px;padding-right:16px}.ri-modal-foot{display:grid;grid-template-columns:1fr 1fr}.ri-modal-btn{width:100%;min-width:0}}'
        ].join('');
        document.head.appendChild(style);
    }

    function scheduleAccountSearch(value) {
        state.search = String(value || '').trim();
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function() {
            loadAccounts();
        }, 260);
    }

    function buildShell() {
        var root = mount();
        if (!root) return;
        injectStyle();
        if (root.dataset.riskIsolationShell === '1') return;
        root.dataset.riskIsolationShell = '1';
        root.innerHTML = '<div class="ri-wrap">' +
            '<section class="ri-card"><div class="ri-head"><div><div class="ri-title">风险隔离</div><div class="ri-desc">隔离白名单玩家后，该玩家登录将被拦截；可通过 404 页面开关控制是否跳转 404 页面。</div></div></div></section>' +
            '<section class="ri-stats"><div class="ri-stat clickable" id="riTotalCard" data-ri-stat-filter="all"><div class="ri-stat-label">当前范围玩家</div><div class="ri-stat-value" id="riTotal">-</div></div><div class="ri-stat clickable" id="riIsolatedCard" data-ri-stat-filter="isolated"><div class="ri-stat-label">已隔离玩家</div><div class="ri-stat-value" id="riIsolatedTotal">-</div></div><div class="ri-stat"><div class="ri-stat-label">当前范围</div><div class="ri-stat-value" id="riScopeLabel" style="font-size:16px;line-height:1.5;">-</div></div></section>' +
            '<section class="ri-card"><div class="ri-toolbar"><div class="ri-scope-dropdown" id="riSubAdminDropdown" style="display:none;"><button type="button" class="ri-scope-trigger" id="riSubAdminTrigger"><span id="riSubAdminTriggerText">全部白名单</span><span class="ri-scope-caret">⌄</span></button><div class="ri-scope-menu" id="riSubAdminMenu"></div></div><label class="ri-switch" title="开启后被隔离用户登录会跳转404页面"><input type="checkbox" id="riPage404Switch"><span class="ri-switch-track"></span><span class="ri-switch-text">404页面</span></label><input class="ri-input" id="riSearch" placeholder="模糊搜索账号 / 姓名 / 添加人"><button class="ri-btn cyan" id="riIsolateAllBtn">一键隔离当前范围</button><button class="ri-btn cyan" id="riReleaseScopeBtn">一键恢复当前范围</button></div></section>' +
            '<section class="ri-card"><div class="ri-table-wrap" data-ak-sticky-table data-ak-sticky-table-min-width="980" data-ak-sticky-first-column-min="120" data-ak-sticky-first-column-max="180"><table class="ri-table"><thead><tr><th>账号</th><th>姓名</th><th>添加人</th><th>到期时间</th><th>隔离状态</th><th>隔离人</th><th>隔离时间</th><th>操作</th></tr></thead><tbody id="riTableBody"><tr><td colspan="8" class="ri-empty">加载中...</td></tr></tbody></table></div><div class="ri-cards" id="riCardList"></div></section>' +
            '<div class="ri-modal" id="riActionModal"><div class="ri-modal-card"><div class="ri-modal-head"><div><div class="ri-modal-title" id="riModalTitle">风险隔离确认</div><div class="ri-modal-desc" id="riModalDesc"></div></div><button type="button" class="ri-modal-close" id="riModalClose">×</button></div><div class="ri-modal-body"><div class="ri-modal-input-wrap" id="riModalInputWrap"><label class="ri-modal-label" for="riModalReason">隔离原因（可选）</label><textarea class="ri-modal-input" id="riModalReason" rows="3" placeholder="填写原因，便于后续审计追踪"></textarea></div></div><div class="ri-modal-foot"><button type="button" class="ri-modal-btn cancel" id="riModalCancel">取消</button><button type="button" class="ri-modal-btn confirm" id="riModalConfirm">确定</button></div></div></div>' +
        '</div>';
        bindEvents();
        requestAnimationFrame(refreshStickyTable);
    }

    function bindEvents() {
        var root = mount();
        var searchInput = document.getElementById('riSearch');
        var subDropdown = document.getElementById('riSubAdminDropdown');
        var subTrigger = document.getElementById('riSubAdminTrigger');
        var page404Switch = document.getElementById('riPage404Switch');
        var isolateAllBtn = document.getElementById('riIsolateAllBtn');
        var releaseScopeBtn = document.getElementById('riReleaseScopeBtn');
        var totalCard = document.getElementById('riTotalCard');
        var isolatedCard = document.getElementById('riIsolatedCard');
        if (searchInput) {
            searchInput.oncompositionstart = function() {
                searchComposing = true;
            };
            searchInput.oncompositionend = function() {
                searchComposing = false;
                scheduleAccountSearch(searchInput.value);
            };
            searchInput.oninput = function(event) {
                if (searchComposing || event.isComposing) return;
                scheduleAccountSearch(searchInput.value);
            };
        }
        if (subTrigger && subDropdown) subTrigger.onclick = function(event) {
            event.stopPropagation();
            if (state.loading) return;
            subDropdown.classList.toggle('open');
            var input = document.getElementById('riSubAdminSearch');
            if (subDropdown.classList.contains('open') && input) setTimeout(function() { input.focus(); }, 0);
        };
        if (subDropdown) subDropdown.onclick = function(event) {
            var option = event.target.closest('[data-ri-sub-admin]');
            var alpha = event.target.closest('[data-ri-letter]');
            if (alpha) {
                event.stopPropagation();
                state.selectedInitial = alpha.getAttribute('data-ri-letter') || '';
                renderSubAdmins();
                return;
            }
            if (!option) return;
            event.stopPropagation();
            state.selectedSubAdmin = option.getAttribute('data-ri-sub-admin') || '';
            subDropdown.classList.remove('open');
            renderSubAdmins();
            loadAccounts();
        };
        if (!dropdownDocumentHandlerBound) {
            document.addEventListener('click', closeSubAdminDropdown);
            dropdownDocumentHandlerBound = true;
        }
        if (page404Switch) page404Switch.onchange = function() {
            if (!isSuperAdmin()) {
                syncPage404Switch();
                notify('仅系统总管理员可修改404页面开关', 'error');
                return;
            }
            togglePage404(page404Switch.checked);
        };
        if (totalCard) totalCard.onclick = function() {
            state.showIsolatedOnly = false;
            renderRows();
        };
        if (isolatedCard) isolatedCard.onclick = function() {
            if ((state.isolatedTotal || 0) <= 0) return;
            state.showIsolatedOnly = true;
            renderRows();
        };
        if (isolateAllBtn) isolateAllBtn.onclick = isolateAll;
        if (releaseScopeBtn) releaseScopeBtn.onclick = releaseScope;
        if (root && root.dataset.riskIsolationActionsBound !== '1') {
            root.addEventListener('click', function(event) {
                var button = event.target.closest('[data-ri-action]');
                if (!button || !root.contains(button)) return;
                var username = button.getAttribute('data-ri-username') || '';
                var action = button.getAttribute('data-ri-action') || '';
                if (!username) return;
                if (action === 'isolate') isolateUser(username);
                if (action === 'release') releaseUser(username);
            });
            root.dataset.riskIsolationActionsBound = '1';
        }
    }

    function refreshStickyTable() {
        var wrap = document.querySelector('#riskIsolationPanelMount .ri-table-wrap');
        if (!wrap) return;
        if (window.AKStickyTable && typeof window.AKStickyTable.enhance === 'function') {
            window.AKStickyTable.enhance(wrap);
        }
    }

    function closeSubAdminDropdown() {
        var dropdown = document.getElementById('riSubAdminDropdown');
        if (dropdown) dropdown.classList.remove('open');
    }

    function updateHeader() {
        var totalEl = document.getElementById('riTotal');
        var isolatedEl = document.getElementById('riIsolatedTotal');
        var scopeEl = document.getElementById('riScopeLabel');
        var totalCard = document.getElementById('riTotalCard');
        var isolatedCard = document.getElementById('riIsolatedCard');
        if (totalEl) totalEl.textContent = String(state.total || 0);
        if (isolatedEl) isolatedEl.textContent = String(state.isolatedTotal || 0);
        if (scopeEl) scopeEl.textContent = isSuperAdmin() ? (state.selectedSubAdmin ? state.selectedSubAdmin : '全部白名单') : (state.subName || '当前子管理员');
        if (totalCard) totalCard.classList.toggle('active', !state.showIsolatedOnly);
        if (isolatedCard) {
            isolatedCard.classList.toggle('active', !!state.showIsolatedOnly);
            isolatedCard.classList.toggle('clickable', (state.isolatedTotal || 0) > 0);
        }
    }

    function filteredSubAdmins() {
        var query = String(state.dropdownQuery || '').trim().toLowerCase();
        var initial = state.selectedInitial || '';
        return (state.subAdmins || []).filter(function(item) {
            var name = String(item.name || '');
            var bound = String(item.bound_username || '');
            if (initial && firstInitial(name) !== initial) return false;
            if (!query) return true;
            return name.toLowerCase().indexOf(query) >= 0 || bound.toLowerCase().indexOf(query) >= 0;
        });
    }

    function renderSubAdmins() {
        var dropdown = document.getElementById('riSubAdminDropdown');
        var triggerText = document.getElementById('riSubAdminTriggerText');
        var menu = document.getElementById('riSubAdminMenu');
        if (!dropdown || !triggerText || !menu) return;
        if (!isSuperAdmin()) {
            dropdown.style.display = '';
            triggerText.textContent = '全体白名单';
            menu.innerHTML = '<div class="ri-scope-body"><div class="ri-scope-list"><button type="button" class="ri-scope-option active" data-ri-sub-admin=""><span class="ri-scope-name">全体白名单</span><span class="ri-scope-count">(' + escapeHtml(String(state.isolatedTotal || 0)) + '/' + escapeHtml(String(state.total || 0)) + ')</span></button></div></div>';
            return;
        }
        dropdown.style.display = '';
        var selectedName = state.selectedSubAdmin || '';
        var selectedItem = (state.subAdmins || []).filter(function(item) {
            return item.name === selectedName;
        })[0];
        var list = filteredSubAdmins();
        var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
        triggerText.textContent = selectedItem ? selectedItem.name : '全部白名单';
        menu.innerHTML = '<div class="ri-scope-search"><input id="riSubAdminSearch" value="' + escapeHtml(state.dropdownQuery || '') + '" placeholder="搜索子管理员 / 绑定账号"></div>' +
            '<div class="ri-scope-alpha"><button type="button" class="ri-alpha-item' + (!state.selectedInitial ? ' active' : '') + '" data-ri-letter="">全</button>' +
            letters.map(function(letter) {
                return '<button type="button" class="ri-alpha-item' + (state.selectedInitial === letter ? ' active' : '') + '" data-ri-letter="' + letter + '">' + letter + '</button>';
            }).join('') +
            '</div><div class="ri-scope-body"><div class="ri-scope-list">' +
            '<button type="button" class="ri-scope-option' + (!selectedName ? ' active' : '') + '" data-ri-sub-admin=""><span class="ri-scope-name">全部白名单</span><span class="ri-scope-count">(' + escapeHtml(String(state.isolatedTotal || 0)) + '/' + escapeHtml(String(state.total || 0)) + ')</span></button>' +
            (list.length ? list.map(function(item) {
                var name = String(item.name || '');
                var active = name === selectedName ? ' active' : '';
                var count = (item.isolated_count || 0) + '/' + (item.active_count || 0);
                return '<button type="button" class="ri-scope-option' + active + '" data-ri-sub-admin="' + escapeHtml(name) + '"><span class="ri-scope-name">' + escapeHtml(name) + '</span><span class="ri-scope-count">(' + escapeHtml(count) + ')</span></button>';
            }).join('') : '<div class="ri-scope-empty">没有匹配的子管理员</div>') +
            '</div></div>';
        var searchInput = document.getElementById('riSubAdminSearch');
        if (searchInput) {
            searchInput.onclick = function(event) { event.stopPropagation(); };
            searchInput.oncompositionstart = function(event) {
                event.stopPropagation();
                dropdownComposing = true;
            };
            searchInput.oncompositionend = function(event) {
                event.stopPropagation();
                dropdownComposing = false;
                state.dropdownQuery = event.target.value;
                renderSubAdmins();
            };
            searchInput.oninput = function(event) {
                if (dropdownComposing || event.isComposing) return;
                state.dropdownQuery = event.target.value;
                renderSubAdmins();
                var nextInput = document.getElementById('riSubAdminSearch');
                if (nextInput) {
                    nextInput.focus();
                    nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
                }
            };
        }
    }

    function renderRows() {
        var tbody = document.getElementById('riTableBody');
        var cardList = document.getElementById('riCardList');
        if (state.showIsolatedOnly && (state.isolatedTotal || 0) <= 0) state.showIsolatedOnly = false;
        updateHeader();
        var rows = state.showIsolatedOnly
            ? (state.rows || []).filter(function(row) { return !!row.isolated; })
            : (state.rows || []);
        if (!rows.length) {
            var emptyText = state.showIsolatedOnly ? '当前范围暂无已隔离玩家' : '当前范围暂无白名单玩家';
            if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="ri-empty">' + emptyText + '</td></tr>';
            if (cardList) cardList.innerHTML = '<div class="ri-user-card ri-muted">' + emptyText + '</div>';
            requestAnimationFrame(refreshStickyTable);
            return;
        }
        if (tbody) {
            tbody.innerHTML = rows.map(function(row) {
                var usernameAttr = escapeHtml(row.username);
                var action = row.isolated
                    ? '<button class="ri-btn success" data-ri-action="release" data-ri-username="' + usernameAttr + '">解除</button>'
                    : '<button class="ri-btn danger" data-ri-action="isolate" data-ri-username="' + usernameAttr + '">隔离</button>';
                return '<tr><td style="font-weight:800;">' + escapeHtml(row.username) + '</td><td>' + escapeHtml(row.nickname || '-') + '</td><td>' + escapeHtml(row.added_by === 'super_admin' ? '系统总管理' : (row.added_by || '-')) + '</td><td>' + escapeHtml(fmtTime(row.expire_time)) + '</td><td>' + statusPill(row.isolated) + '</td><td>' + escapeHtml(row.isolated_by || '-') + '</td><td>' + escapeHtml(fmtTime(row.isolated_at)) + '</td><td>' + action + '</td></tr>';
            }).join('');
        }
        if (cardList) {
            cardList.innerHTML = rows.map(function(row) {
                var usernameAttr = escapeHtml(row.username);
                var action = row.isolated
                    ? '<button class="ri-btn success" data-ri-action="release" data-ri-username="' + usernameAttr + '">解除隔离</button>'
                    : '<button class="ri-btn danger" data-ri-action="isolate" data-ri-username="' + usernameAttr + '">隔离玩家</button>';
                return '<div class="ri-user-card"><div class="ri-user-head"><div class="ri-user-name">' + escapeHtml(row.username) + '</div>' + statusPill(row.isolated) + '</div><div class="ri-user-grid"><div><div class="ri-user-label">姓名</div><div class="ri-user-value">' + escapeHtml(row.nickname || '-') + '</div></div><div><div class="ri-user-label">添加人</div><div class="ri-user-value">' + escapeHtml(row.added_by === 'super_admin' ? '系统总管理' : (row.added_by || '-')) + '</div></div><div><div class="ri-user-label">到期时间</div><div class="ri-user-value">' + escapeHtml(fmtTime(row.expire_time)) + '</div></div><div><div class="ri-user-label">隔离人</div><div class="ri-user-value">' + escapeHtml(row.isolated_by || '-') + '</div></div></div>' + action + '</div>';
            }).join('');
        }
        requestAnimationFrame(refreshStickyTable);
    }

    function statusPill(isolated) {
        return isolated ? '<span class="ri-pill on">已隔离</span>' : '<span class="ri-pill off">正常</span>';
    }

    function setBusy(busy) {
        state.loading = !!busy;
        if (busy) closeSubAdminDropdown();
        ['riIsolateAllBtn', 'riReleaseScopeBtn', 'riSubAdminTrigger', 'riSearch', 'riPage404Switch'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.disabled = !!busy;
        });
        var page404Switch = document.getElementById('riPage404Switch');
        if (page404Switch && !isSuperAdmin()) page404Switch.disabled = true;
    }

    function scopePayload() {
        return isSuperAdmin() ? { sub_admin: state.selectedSubAdmin || '' } : {};
    }

    function syncPage404Switch() {
        var page404Switch = document.getElementById('riPage404Switch');
        if (page404Switch) {
            page404Switch.checked = !!state.page404Enabled;
            page404Switch.disabled = !isSuperAdmin() || !!state.loading;
        }
    }

    function togglePage404(enabled) {
        var previous = !!state.page404Enabled;
        state.page404Enabled = !!enabled;
        syncPage404Switch();
        return apiPost('/page_404', { enabled: state.page404Enabled }).then(function(data) {
            state.page404Enabled = data.enabled !== false;
            syncPage404Switch();
            notify(state.page404Enabled ? '已启用404页面' : '已关闭404页面', 'success');
        }).catch(function(err) {
            state.page404Enabled = previous;
            syncPage404Switch();
            notify(err.message || '保存404页面开关失败', 'error');
        });
    }

    function loadStatus() {
        return api('/status').then(function(data) {
            state.role = data.role || sessionStorage.getItem('admin_role') || '';
            state.subName = data.sub_name || sessionStorage.getItem('admin_role_name') || '';
            state.ready = data.ready !== false;
            state.page404Enabled = data.page_404_enabled !== false;
            if (!isSuperAdmin()) {
                state.subAdmins = [];
                state.selectedSubAdmin = '';
            }
            syncPage404Switch();
            renderSubAdmins();
            if (isSuperAdmin()) return loadSubAdminScopes();
        });
    }

    function loadSubAdminScopes() {
        return api('/sub_admin_scopes').then(function(data) {
            state.subAdmins = data.rows || [];
            renderSubAdmins();
        });
    }

    function renderInitializing() {
        updateHeader();
        var tbody = document.getElementById('riTableBody');
        var cardList = document.getElementById('riCardList');
        if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="ri-empty">风险隔离模块初始化中，请稍候...</td></tr>';
        if (cardList) cardList.innerHTML = '<div class="ri-user-card ri-muted">风险隔离模块初始化中，请稍候...</div>';
        requestAnimationFrame(refreshStickyTable);
    }

    function waitUntilReady() {
        if (readyRetryTimer) clearTimeout(readyRetryTimer);
        renderInitializing();
        readyRetryTimer = setTimeout(function() {
            loadStatus().then(function() {
                if (state.ready) {
                    loadAccounts();
                } else {
                    waitUntilReady();
                }
            }).catch(function(err) {
                notify(err.message || '风险隔离模块初始化状态检查失败', 'error');
            });
        }, 500);
    }

    function loadAccounts() {
        state.loadStarted = true;
        if (!state.ready) {
            waitUntilReady();
            return Promise.resolve();
        }
        setBusy(true);
        var params = new URLSearchParams({ limit: '200', offset: '0' });
        if (state.search) params.append('search', state.search);
        if (isSuperAdmin() && state.selectedSubAdmin) params.append('sub_admin', state.selectedSubAdmin);
        return api('/accounts?' + params.toString()).then(function(data) {
            state.total = data.total || 0;
            state.isolatedTotal = data.isolated_total || 0;
            state.rows = data.rows || [];
            state.loaded = true;
            renderSubAdmins();
            renderRows();
        }).catch(function(err) {
            notify(err.message || '加载风险隔离列表失败', 'error');
        }).finally(function() {
            setBusy(false);
        });
    }

    function showRiskIsolationModal(config) {
        return new Promise(function(resolve) {
            var modal = document.getElementById('riActionModal');
            var title = document.getElementById('riModalTitle');
            var desc = document.getElementById('riModalDesc');
            var inputWrap = document.getElementById('riModalInputWrap');
            var reasonInput = document.getElementById('riModalReason');
            var closeBtn = document.getElementById('riModalClose');
            var cancelBtn = document.getElementById('riModalCancel');
            var confirmBtn = document.getElementById('riModalConfirm');
            if (!modal || !title || !desc || !inputWrap || !reasonInput || !closeBtn || !cancelBtn || !confirmBtn) {
                resolve({ confirmed: false, reason: '' });
                return;
            }
            title.textContent = config.title || '风险隔离确认';
            desc.textContent = config.desc || '';
            confirmBtn.textContent = config.confirmText || '确定';
            cancelBtn.textContent = config.cancelText || '取消';
            reasonInput.value = '';
            inputWrap.classList.toggle('hidden', config.reason !== true);
            modal.classList.add('open');
            function cleanup() {
                modal.classList.remove('open');
                closeBtn.onclick = null;
                cancelBtn.onclick = null;
                confirmBtn.onclick = null;
                modal.onclick = null;
                document.removeEventListener('keydown', onKeyDown);
            }
            function finish(confirmed) {
                var reason = reasonInput.value.trim();
                cleanup();
                resolve({ confirmed: confirmed, reason: reason });
            }
            function onKeyDown(event) {
                if (event.key === 'Escape') finish(false);
            }
            closeBtn.onclick = function() { finish(false); };
            cancelBtn.onclick = function() { finish(false); };
            confirmBtn.onclick = function() { finish(true); };
            modal.onclick = function(event) {
                if (event.target === modal) finish(false);
            };
            document.addEventListener('keydown', onKeyDown);
            if (config.reason === true) setTimeout(function() { reasonInput.focus(); }, 0);
            else setTimeout(function() { confirmBtn.focus(); }, 0);
        });
    }

    function isolateUser(username) {
        return showRiskIsolationModal({
            title: '隔离玩家',
            desc: '确认隔离玩家 [' + username + '] 吗？隔离后该玩家调用登录将直接跳转到404页面！',
            confirmText: '确认隔离',
            reason: true
        }).then(function(result) {
            if (!result.confirmed) return;
            setBusy(true);
            return apiPost('/isolate', Object.assign(scopePayload(), { usernames: [username], reason: result.reason })).then(function(data) {
                notify(data.message || '已隔离');
                return loadStatus().then(loadAccounts);
            }).catch(function(err) {
                notify(err.message || '隔离失败', 'error');
            }).finally(function() {
                setBusy(false);
            });
        });
    }

    function releaseUser(username) {
        return showRiskIsolationModal({
            title: '解除风险隔离',
            desc: '确认解除玩家 [' + username + '] 的风险隔离吗？',
            confirmText: '确认解除'
        }).then(function(result) {
            if (!result.confirmed) return;
            setBusy(true);
            return apiPost('/release', Object.assign(scopePayload(), { usernames: [username] })).then(function(data) {
                notify(data.message || '已解除');
                return loadStatus().then(loadAccounts);
            }).catch(function(err) {
                notify(err.message || '解除失败', 'error');
            }).finally(function() {
                setBusy(false);
            });
        });
    }

    function isolateAll() {
        var label = isSuperAdmin() ? (state.selectedSubAdmin || '全部白名单') : (state.subName || '当前子管理员');
        return showRiskIsolationModal({
            title: '批量隔离当前范围',
            desc: '确认隔离 [' + label + '] 当前范围内全部白名单玩家吗？',
            confirmText: '确认隔离',
            reason: true
        }).then(function(result) {
            if (!result.confirmed) return;
            setBusy(true);
            return apiPost('/isolate_scope', Object.assign(scopePayload(), { reason: result.reason })).then(function(data) {
                notify(data.message || '已批量隔离');
                return loadStatus().then(loadAccounts);
            }).catch(function(err) {
                notify(err.message || '批量隔离失败', 'error');
            }).finally(function() {
                setBusy(false);
            });
        });
    }

    function releaseScope() {
        var label = isSuperAdmin() ? (state.selectedSubAdmin || '全部白名单') : (state.subName || '当前子管理员');
        return showRiskIsolationModal({
            title: '批量恢复当前范围',
            desc: '确认恢复 [' + label + '] 当前范围内全部已隔离玩家吗？',
            confirmText: '确认恢复'
        }).then(function(result) {
            if (!result.confirmed) return;
            setBusy(true);
            return apiPost('/release_scope', scopePayload()).then(function(data) {
                notify(data.message || '已恢复当前范围');
                return loadStatus().then(loadAccounts);
            }).catch(function(err) {
                notify(err.message || '恢复当前范围失败', 'error');
            }).finally(function() {
                setBusy(false);
            });
        });
    }

    function start() {
        buildShell();
        if (!state.loadStarted || !state.loaded) {
            loadStatus().then(function() {
                return loadAccounts();
            }).catch(function(err) {
                state.loadStarted = false;
                notify(err.message || '风险隔离模块不可用', 'error');
            });
            return;
        }
        renderSubAdmins();
        renderRows();
    }

    window.AKRiskIsolationPanel = {
        start: start,
        isolateUser: isolateUser,
        releaseUser: releaseUser,
        reload: function() { return loadStatus().then(loadAccounts); }
    };
})();
