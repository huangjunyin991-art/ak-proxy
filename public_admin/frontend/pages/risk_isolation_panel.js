(function() {
    'use strict';

    if (window.AKRiskIsolationPanelLoaded) return;
    window.AKRiskIsolationPanelLoaded = true;

    var state = {
        loading: false,
        saving: false,
        loaded: false,
        role: '',
        subName: '',
        subAdmins: [],
        selectedSubAdmin: '',
        dropdownQuery: '',
        selectedInitial: '',
        ready: false,
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
        style.textContent = '#riskIsolationPanelMount{display:block}.ri-wrap{display:flex;flex-direction:column;gap:16px}.ri-card{border:1px solid var(--border);border-radius:16px;background:linear-gradient(135deg,var(--bg-card),rgba(255,71,87,.05));padding:16px}.ri-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}.ri-title{color:var(--accent);font-size:18px;font-weight:800}.ri-desc{color:var(--text-secondary);font-size:12px;margin-top:4px;line-height:1.5}.ri-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.ri-stat{border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.035);padding:14px}.ri-stat-label{font-size:12px;color:var(--text-secondary)}.ri-stat-value{font-size:24px;font-weight:800;color:var(--accent);margin-top:5px}.ri-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.ri-input{min-height:38px;border:1px solid var(--border);border-radius:10px;padding:8px 10px;color:var(--text-primary);background:var(--bg-primary);font-size:13px;outline:none}.ri-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,212,255,.12)}.ri-scope-dropdown{position:relative;min-width:198px;z-index:20}.ri-scope-trigger{width:100%;min-height:40px;border:1px solid rgba(255,221,87,.82);border-radius:18px;padding:8px 14px 8px 18px;color:#fff;background:linear-gradient(180deg,rgba(6,18,34,.98),rgba(9,24,44,.98));font-size:18px;font-weight:800;line-height:1.2;display:flex;align-items:center;justify-content:space-between;gap:14px;cursor:pointer;outline:none;box-shadow:0 0 0 2px rgba(255,221,87,.08),0 10px 24px rgba(0,0,0,.28)}.ri-scope-trigger:focus{border-color:#ffdf5d;box-shadow:0 0 0 3px rgba(255,221,87,.18),0 10px 24px rgba(0,0,0,.28)}.ri-scope-caret{font-size:20px;line-height:1;transition:transform .16s ease}.ri-scope-menu{position:absolute;left:0;right:0;top:calc(100% - 1px);display:none;overflow:hidden;border:1px solid rgba(255,221,87,.82);border-top:0;border-radius:0 0 14px 14px;background:linear-gradient(180deg,rgba(9,24,44,.99),#242c39);box-shadow:0 16px 34px rgba(0,0,0,.42),0 0 0 2px rgba(255,221,87,.08);z-index:30}.ri-scope-dropdown.open .ri-scope-trigger{border-bottom-color:transparent;border-bottom-left-radius:0;border-bottom-right-radius:0;box-shadow:0 0 0 2px rgba(255,221,87,.08)}.ri-scope-dropdown.open .ri-scope-caret{transform:rotate(180deg)}.ri-scope-dropdown.open .ri-scope-menu{display:block}.ri-scope-option{width:100%;border:0;border-top:1px solid rgba(255,255,255,.05);background:transparent;color:#fff;padding:9px 20px;text-align:left;font-size:18px;font-weight:800;line-height:1.25;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer}.ri-scope-option:first-child{border-top:0}.ri-scope-option:hover,.ri-scope-option.active{background:#2d6cdf}.ri-scope-count{font-size:16px;color:#fff;font-weight:800;white-space:nowrap}.ri-btn{border:0;border-radius:10px;padding:9px 14px;background:linear-gradient(135deg,#00d4ff,#667eea);color:#fff;font-weight:700;cursor:pointer}.ri-btn.secondary{background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border)}.ri-btn.danger{background:linear-gradient(135deg,#ff4757,#ff6b81)}.ri-btn.success{background:linear-gradient(135deg,#00c851,#00ff88);color:#051018}.ri-btn:disabled,.ri-scope-trigger:disabled{opacity:.55;cursor:not-allowed}.ri-table-wrap{overflow-x:auto}.ri-table{width:100%;border-collapse:collapse;min-width:920px}.ri-table th,.ri-table td{padding:10px 12px;border-bottom:1px solid var(--border);text-align:left;font-size:13px}.ri-table th{color:var(--accent);font-weight:800;background:rgba(0,212,255,.04)}.ri-muted{color:var(--text-secondary)}.ri-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700}.ri-pill.on{background:rgba(255,71,87,.16);color:#ff6b81}.ri-pill.off{background:rgba(0,255,136,.12);color:#00ff88}.ri-empty{text-align:center;color:var(--text-secondary);padding:28px 0}.ri-cards{display:none}.ri-user-card{border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.035);padding:14px;display:flex;flex-direction:column;gap:10px}.ri-user-head{display:flex;justify-content:space-between;gap:10px}.ri-user-name{font-weight:800;color:var(--text-primary)}.ri-user-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.ri-user-label{font-size:11px;color:var(--text-secondary)}.ri-user-value{font-size:13px;color:var(--text-primary);word-break:break-all}@media(max-width:760px){.ri-table-wrap{display:none}.ri-cards{display:grid;gap:12px}.ri-toolbar{align-items:stretch}.ri-input,.ri-scope-dropdown,.ri-btn{width:100%}.ri-user-grid{grid-template-columns:1fr}}';
        style.textContent += '.ri-toolbar{gap:10px}.ri-input{min-height:56px;border-color:rgba(57,126,255,.38);border-radius:16px;padding:0 18px;background:linear-gradient(180deg,rgba(5,15,30,.98),rgba(8,20,38,.98));font-size:16px;font-weight:800;color:#fff}.ri-input::placeholder{color:rgba(170,200,235,.72)}.ri-input:focus{border-color:#27d8ff;box-shadow:0 0 0 3px rgba(0,212,255,.12),0 10px 24px rgba(0,0,0,.22)}.ri-scope-trigger{min-height:56px;border-color:rgba(57,126,255,.42);border-radius:16px;background:linear-gradient(180deg,rgba(5,15,30,.98),rgba(8,20,38,.98));font-weight:900;box-shadow:0 8px 22px rgba(0,0,0,.24)}.ri-scope-menu{right:auto;width:min(420px,calc(100vw - 36px));border-color:rgba(57,126,255,.5);border-radius:0 0 16px 16px;background:linear-gradient(180deg,#06162b,#172234);box-shadow:0 18px 38px rgba(0,0,0,.48),0 0 0 2px rgba(39,216,255,.06)}.ri-scope-search{padding:10px;border-bottom:1px solid rgba(255,255,255,.08)}.ri-scope-search input{width:100%;min-height:38px;border:1px solid rgba(57,126,255,.38);border-radius:12px;background:rgba(0,0,0,.18);color:#fff;padding:0 12px;font-weight:800;outline:none}.ri-scope-search input::placeholder{color:rgba(170,200,235,.7)}.ri-scope-body{display:grid;grid-template-columns:minmax(0,1fr)34px;max-height:360px}.ri-scope-list{overflow:auto;padding:4px 0}.ri-scope-alpha{border-left:1px solid rgba(255,255,255,.08);padding:4px 3px;display:grid;grid-template-rows:repeat(27,1fr);gap:1px;background:rgba(0,0,0,.12)}.ri-alpha-item{border:0;border-radius:6px;background:transparent;color:rgba(220,235,255,.76);font-size:10px;font-weight:900;cursor:pointer}.ri-alpha-item:hover,.ri-alpha-item.active{background:#2d6cdf;color:#fff}.ri-scope-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ri-scope-empty{padding:22px 16px;color:rgba(220,235,255,.68);font-weight:800;text-align:center}.ri-btn{border:1px solid transparent;border-radius:16px;min-height:56px;padding:0 20px;font-size:16px;font-weight:900;letter-spacing:.02em;box-shadow:0 10px 26px rgba(0,0,0,.28);transition:transform .14s ease,filter .14s ease,box-shadow .14s ease}.ri-btn:hover{transform:translateY(-1px);filter:brightness(1.08)}.ri-btn.secondary{background:linear-gradient(135deg,#1e90ff,#00d4ff);border-color:rgba(0,212,255,.46);color:#fff}.ri-btn.danger{background:linear-gradient(135deg,#ff2f55,#ff7a45);border-color:rgba(255,122,69,.45);color:#fff}.ri-btn.success{background:linear-gradient(135deg,#00c851,#00e5a8);border-color:rgba(0,229,168,.45);color:#052016}@media(max-width:760px){.ri-scope-menu{width:100%}}';
        style.textContent += '.ri-scope-dropdown{width:260px;min-width:220px;max-width:300px}.ri-scope-trigger{min-height:48px;border-radius:14px;padding:0 12px 0 14px;font-size:16px;font-weight:800;box-shadow:0 6px 16px rgba(0,0,0,.2)}.ri-scope-caret{font-size:16px}.ri-scope-menu{width:min(300px,calc(100vw - 32px));max-height:330px;border-color:rgba(57,126,255,.34);border-radius:0 0 14px 14px;background:linear-gradient(180deg,rgba(6,18,34,.98),rgba(11,24,41,.98));box-shadow:0 12px 28px rgba(0,0,0,.38)}.ri-scope-search{padding:8px}.ri-scope-search input{min-height:34px;border-radius:10px;font-size:13px;font-weight:700}.ri-scope-body{grid-template-columns:minmax(0,1fr)26px;max-height:276px;min-height:0}.ri-scope-list{max-height:276px;overflow:auto;padding:4px}.ri-scope-option{min-height:42px;border-radius:10px;padding:0 10px 0 12px;margin:0 0 4px 0;border-color:rgba(57,126,255,.18);font-size:15px;font-weight:800;box-shadow:none}.ri-scope-option:hover,.ri-scope-option.active{border-color:rgba(45,108,223,.48);background:rgba(45,108,223,.18)}.ri-scope-count{font-size:13px;font-weight:800;color:rgba(220,235,255,.72)}.ri-scope-alpha{display:flex;flex-direction:column;gap:2px;max-height:276px;overflow-y:auto;overflow-x:hidden;padding:4px 2px;border-left:1px solid rgba(255,255,255,.06);scrollbar-width:thin}.ri-alpha-item{min-height:18px;border-radius:8px;font-size:10px;line-height:18px;flex:0 0 auto;color:rgba(220,235,255,.68)}.ri-alpha-item:hover,.ri-alpha-item.active{background:rgba(45,108,223,.78);color:#fff}@media(max-width:760px){.ri-scope-dropdown{width:100%;max-width:none}.ri-scope-menu{width:100%}}';
        style.textContent += '.ri-scope-alpha{display:grid;grid-template-columns:repeat(9,1fr);gap:2px;padding:6px 8px;border-left:0;border-bottom:1px solid rgba(255,255,255,.06);background:rgba(0,0,0,.1);max-height:none;overflow:visible}.ri-alpha-item{min-height:18px;line-height:18px;border-radius:6px;font-size:10px}.ri-scope-body{display:block;max-height:220px}.ri-scope-list{max-height:220px}.ri-input{min-height:42px;border-radius:12px;padding:0 12px;font-size:14px}.ri-scope-trigger{min-height:42px;border-radius:12px;font-size:14px}.ri-scope-search input{min-height:30px;border-radius:9px;font-size:12px}.ri-btn{min-height:42px;border-radius:12px;padding:0 14px;font-size:14px}.ri-table th{padding:8px 10px;font-size:11px}.ri-table td{padding:8px 10px;font-size:12px;line-height:1.25}.ri-table .ri-btn{min-height:34px;border-radius:10px;padding:0 12px;font-size:12px}.ri-pill{padding:2px 7px;font-size:11px}.ri-card{padding:12px}.ri-toolbar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;align-items:start}.ri-toolbar>.ri-scope-dropdown,.ri-toolbar>.ri-input,.ri-toolbar>.ri-btn{width:100%;min-width:0;max-width:none}.ri-scope-dropdown{width:100%;min-width:0;max-width:none}.ri-scope-menu{left:0;right:auto;width:100%;min-width:100%;max-width:none}.ri-scope-caret{width:8px;height:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);font-size:0;line-height:0;margin-right:2px;opacity:.9}.ri-scope-dropdown.open .ri-scope-caret{transform:rotate(225deg);margin-top:5px}@media(max-width:980px){.ri-toolbar{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.ri-toolbar{grid-template-columns:1fr}}';
        style.textContent += '.ri-scope-option{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:38px;color:#f4f8ff;background:rgba(6,18,34,.78);opacity:1;visibility:visible}.ri-scope-option .ri-scope-name{color:#fff;font-weight:850;opacity:1}.ri-scope-option .ri-scope-count{color:rgba(214,232,255,.82);opacity:1}.ri-scope-list{background:rgba(4,14,28,.72)}.ri-scope-option:hover,.ri-scope-option.active{background:rgba(45,108,223,.24);color:#fff}.ri-scope-option:hover .ri-scope-name,.ri-scope-option.active .ri-scope-name{color:#fff}';
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
            '<section class="ri-card"><div class="ri-head"><div><div class="ri-title">风险隔离</div><div class="ri-desc">隔离白名单玩家后，该玩家调用 /RPC/Login 将直接得到 404；子管理员仅能管理自己名下白名单玩家。</div></div><button class="ri-btn secondary" id="riRefreshBtn">刷新</button></div></section>' +
            '<section class="ri-stats"><div class="ri-stat"><div class="ri-stat-label">当前范围玩家</div><div class="ri-stat-value" id="riTotal">-</div></div><div class="ri-stat"><div class="ri-stat-label">已隔离玩家</div><div class="ri-stat-value" id="riIsolatedTotal">-</div></div><div class="ri-stat"><div class="ri-stat-label">当前范围</div><div class="ri-stat-value" id="riScopeLabel" style="font-size:16px;line-height:1.5;">-</div></div></section>' +
            '<section class="ri-card"><div class="ri-toolbar"><div class="ri-scope-dropdown" id="riSubAdminDropdown" style="display:none;"><button type="button" class="ri-scope-trigger" id="riSubAdminTrigger"><span id="riSubAdminTriggerText">全部白名单</span><span class="ri-scope-caret">⌄</span></button><div class="ri-scope-menu" id="riSubAdminMenu"></div></div><input class="ri-input" id="riSearch" placeholder="模糊搜索账号 / 姓名 / 添加人"><button class="ri-btn danger" id="riIsolateAllBtn">一键隔离当前范围</button><button class="ri-btn success" id="riReleaseScopeBtn">一键恢复当前范围</button></div></section>' +
            '<section class="ri-card"><div class="ri-table-wrap"><table class="ri-table"><thead><tr><th>账号</th><th>姓名</th><th>添加人</th><th>到期时间</th><th>隔离状态</th><th>隔离人</th><th>隔离时间</th><th>操作</th></tr></thead><tbody id="riTableBody"><tr><td colspan="8" class="ri-empty">加载中...</td></tr></tbody></table></div><div class="ri-cards" id="riCardList"></div></section>' +
        '</div>';
        bindEvents();
    }

    function bindEvents() {
        var refreshBtn = document.getElementById('riRefreshBtn');
        var searchInput = document.getElementById('riSearch');
        var subDropdown = document.getElementById('riSubAdminDropdown');
        var subTrigger = document.getElementById('riSubAdminTrigger');
        var isolateAllBtn = document.getElementById('riIsolateAllBtn');
        var releaseScopeBtn = document.getElementById('riReleaseScopeBtn');
        if (refreshBtn) refreshBtn.onclick = function() { loadStatus().then(loadAccounts); };
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
        if (isolateAllBtn) isolateAllBtn.onclick = isolateAll;
        if (releaseScopeBtn) releaseScopeBtn.onclick = releaseScope;
    }

    function closeSubAdminDropdown() {
        var dropdown = document.getElementById('riSubAdminDropdown');
        if (dropdown) dropdown.classList.remove('open');
    }

    function updateHeader() {
        var totalEl = document.getElementById('riTotal');
        var isolatedEl = document.getElementById('riIsolatedTotal');
        var scopeEl = document.getElementById('riScopeLabel');
        if (totalEl) totalEl.textContent = String(state.total || 0);
        if (isolatedEl) isolatedEl.textContent = String(state.isolatedTotal || 0);
        if (scopeEl) scopeEl.textContent = isSuperAdmin() ? (state.selectedSubAdmin ? state.selectedSubAdmin : '全部白名单') : (state.subName || '当前子管理员');
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
            dropdown.style.display = 'none';
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
        updateHeader();
        var tbody = document.getElementById('riTableBody');
        var cardList = document.getElementById('riCardList');
        var rows = state.rows || [];
        if (!rows.length) {
            if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="ri-empty">当前范围暂无白名单玩家</td></tr>';
            if (cardList) cardList.innerHTML = '<div class="ri-user-card ri-muted">当前范围暂无白名单玩家</div>';
            return;
        }
        if (tbody) {
            tbody.innerHTML = rows.map(function(row) {
                var action = row.isolated
                    ? '<button class="ri-btn success" onclick="window.AKRiskIsolationPanel.releaseUser(' + jsArg(row.username) + ')">解除</button>'
                    : '<button class="ri-btn danger" onclick="window.AKRiskIsolationPanel.isolateUser(' + jsArg(row.username) + ')">隔离</button>';
                return '<tr><td style="font-weight:800;">' + escapeHtml(row.username) + '</td><td>' + escapeHtml(row.nickname || '-') + '</td><td>' + escapeHtml(row.added_by === 'super_admin' ? '系统总管理' : (row.added_by || '-')) + '</td><td>' + escapeHtml(fmtTime(row.expire_time)) + '</td><td>' + statusPill(row.isolated) + '</td><td>' + escapeHtml(row.isolated_by || '-') + '</td><td>' + escapeHtml(fmtTime(row.isolated_at)) + '</td><td>' + action + '</td></tr>';
            }).join('');
        }
        if (cardList) {
            cardList.innerHTML = rows.map(function(row) {
                var action = row.isolated
                    ? '<button class="ri-btn success" onclick="window.AKRiskIsolationPanel.releaseUser(' + jsArg(row.username) + ')">解除隔离</button>'
                    : '<button class="ri-btn danger" onclick="window.AKRiskIsolationPanel.isolateUser(' + jsArg(row.username) + ')">隔离玩家</button>';
                return '<div class="ri-user-card"><div class="ri-user-head"><div class="ri-user-name">' + escapeHtml(row.username) + '</div>' + statusPill(row.isolated) + '</div><div class="ri-user-grid"><div><div class="ri-user-label">姓名</div><div class="ri-user-value">' + escapeHtml(row.nickname || '-') + '</div></div><div><div class="ri-user-label">添加人</div><div class="ri-user-value">' + escapeHtml(row.added_by === 'super_admin' ? '系统总管理' : (row.added_by || '-')) + '</div></div><div><div class="ri-user-label">到期时间</div><div class="ri-user-value">' + escapeHtml(fmtTime(row.expire_time)) + '</div></div><div><div class="ri-user-label">隔离人</div><div class="ri-user-value">' + escapeHtml(row.isolated_by || '-') + '</div></div></div>' + action + '</div>';
            }).join('');
        }
    }

    function statusPill(isolated) {
        return isolated ? '<span class="ri-pill on">已隔离</span>' : '<span class="ri-pill off">正常</span>';
    }

    function setBusy(busy) {
        state.loading = !!busy;
        if (busy) closeSubAdminDropdown();
        ['riRefreshBtn', 'riIsolateAllBtn', 'riReleaseScopeBtn', 'riSubAdminTrigger', 'riSearch'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.disabled = !!busy;
        });
    }

    function scopePayload() {
        return isSuperAdmin() ? { sub_admin: state.selectedSubAdmin || '' } : {};
    }

    function loadStatus() {
        return api('/status').then(function(data) {
            state.role = data.role || sessionStorage.getItem('admin_role') || '';
            state.subName = data.sub_name || sessionStorage.getItem('admin_role_name') || '';
            state.ready = data.ready !== false;
            state.subAdmins = data.sub_admins || [];
            renderSubAdmins();
        });
    }

    function renderInitializing() {
        updateHeader();
        var tbody = document.getElementById('riTableBody');
        var cardList = document.getElementById('riCardList');
        if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="ri-empty">风险隔离模块初始化中，请稍候...</td></tr>';
        if (cardList) cardList.innerHTML = '<div class="ri-user-card ri-muted">风险隔离模块初始化中，请稍候...</div>';
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
        }, 1200);
    }

    function loadAccounts() {
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
            renderSubAdmins();
            renderRows();
        }).catch(function(err) {
            notify(err.message || '加载风险隔离列表失败', 'error');
        }).finally(function() {
            setBusy(false);
        });
    }

    function isolateUser(username) {
        var reason = window.prompt('隔离原因（可选）', '') || '';
        setBusy(true);
        return apiPost('/isolate', Object.assign(scopePayload(), { usernames: [username], reason: reason })).then(function(data) {
            notify(data.message || '已隔离');
            return loadStatus().then(loadAccounts);
        }).catch(function(err) {
            notify(err.message || '隔离失败', 'error');
        }).finally(function() {
            setBusy(false);
        });
    }

    function releaseUser(username) {
        if (!window.confirm('确定解除该玩家的风险隔离吗？')) return;
        setBusy(true);
        return apiPost('/release', Object.assign(scopePayload(), { usernames: [username] })).then(function(data) {
            notify(data.message || '已解除');
            return loadStatus().then(loadAccounts);
        }).catch(function(err) {
            notify(err.message || '解除失败', 'error');
        }).finally(function() {
            setBusy(false);
        });
    }

    function isolateAll() {
        var label = isSuperAdmin() ? (state.selectedSubAdmin || '全部白名单') : (state.subName || '当前子管理员');
        if (!window.confirm('确定隔离 [' + label + '] 当前范围内全部白名单玩家吗？')) return;
        var reason = window.prompt('隔离原因（可选）', '') || '';
        setBusy(true);
        return apiPost('/isolate_scope', Object.assign(scopePayload(), { reason: reason })).then(function(data) {
            notify(data.message || '已批量隔离');
            return loadStatus().then(loadAccounts);
        }).catch(function(err) {
            notify(err.message || '批量隔离失败', 'error');
        }).finally(function() {
            setBusy(false);
        });
    }

    function releaseScope() {
        var label = isSuperAdmin() ? (state.selectedSubAdmin || '全部白名单') : (state.subName || '当前子管理员');
        if (!window.confirm('确定恢复 [' + label + '] 当前范围内全部已隔离玩家吗？')) return;
        setBusy(true);
        return apiPost('/release_scope', scopePayload()).then(function(data) {
            notify(data.message || '已恢复当前范围');
            return loadStatus().then(loadAccounts);
        }).catch(function(err) {
            notify(err.message || '恢复当前范围失败', 'error');
        }).finally(function() {
            setBusy(false);
        });
    }

    function start() {
        buildShell();
        if (!state.loaded) {
            state.loaded = true;
            loadStatus().then(function() {
                if (state.ready) {
                    return loadAccounts();
                }
                waitUntilReady();
                return null;
            }).catch(function(err) {
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
