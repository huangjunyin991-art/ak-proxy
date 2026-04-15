(function() {
    'use strict';

    if (window.self !== window.top) return;
    if (window.AKIMClientLoaded) return;
    window.AKIMClientLoaded = true;

    const API_ROOT = window.location.origin;
    const HTTP_ROOT = `${API_ROOT}/im/api`;

    const state = {
        allowed: false,
        loading: false,
        ready: false,
        username: '',
        displayName: '',
        sessions: [],
        activeConversationId: 0,
        activeMessages: [],
        ws: null,
        open: false,
        view: 'sessions',
        newSessionTarget: '',
        newSessionError: '',
        lastReadSentByConversation: {},
        actionSheetOpen: false,
        actionSheetMessageId: 0,
        actionSheetConversationId: 0,
        actionSheetCanRecall: false,
        actionSheetDraftText: '',
        recalledDraftByMessageId: {},
        inputValue: ''
    };

    let root = null;
    let panel = null;
    let sessionList = null;
    let messageList = null;
    let statusLine = null;
    let inputEl = null;
    let newSessionInputEl = null;
    let sendBtn = null;
    let actionSheetEl = null;
    let actionSheetRecallBtn = null;
    let actionSheetCancelBtn = null;

    function getCookie(name) {
        try {
            const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
            return match ? decodeURIComponent(match[1]) : '';
        } catch (e) {
            return '';
        }
    }

    function pickUsernameFromObject(target) {
        if (!target || typeof target !== 'object') return '';
        const candidates = [
            target.UserName,
            target.username,
            target.Account,
            target.account,
            target.Name,
            target.name
        ];
        for (let i = 0; i < candidates.length; i++) {
            const value = String(candidates[i] || '').trim();
            if (value) return value.toLowerCase();
        }
        return '';
    }

    function getCanonicalUsername() {
        try {
            if (window.APP && APP.USER && APP.USER.MODEL) {
                const value = pickUsernameFromObject(APP.USER.MODEL);
                if (value) return value;
            }
        } catch (e) {}
        try {
            if (window.USER_MODEL) {
                const value = pickUsernameFromObject(window.USER_MODEL);
                if (value) return value;
            }
        } catch (e) {}
        try {
            const raw = localStorage.getItem('AK_user_model') || sessionStorage.getItem('AK_user_model');
            if (raw) {
                const value = pickUsernameFromObject(JSON.parse(raw));
                if (value) return value;
            }
        } catch (e) {}
        try {
            const userDataRaw = localStorage.getItem('UserData') || sessionStorage.getItem('UserData');
            if (userDataRaw) {
                const value = pickUsernameFromObject(JSON.parse(userDataRaw));
                if (value) return value;
            }
        } catch (e) {}
        try {
            const loginResultRaw = localStorage.getItem('ak_login_result') || sessionStorage.getItem('ak_login_result');
            if (loginResultRaw) {
                const parsed = JSON.parse(loginResultRaw);
                const value = pickUsernameFromObject(parsed && parsed.UserData && typeof parsed.UserData === 'object' ? parsed.UserData : null);
                if (value) return value;
            }
        } catch (e) {}
        return String(getCookie('ak_username') || '').trim().toLowerCase();
    }

    function buildRequestHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        const username = getCanonicalUsername();
        if (username) headers['X-AK-Username'] = username;
        return headers;
    }

    function buildWsUrl() {
        const baseUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/im/ws`;
        try {
            const finalUrl = new URL(baseUrl);
            const username = getCanonicalUsername();
            if (username) finalUrl.searchParams.set('username', username);
            return finalUrl.toString();
        } catch (e) {
            return baseUrl;
        }
    }

    function request(url, options) {
        return fetch(url, Object.assign({
            credentials: 'same-origin',
            headers: buildRequestHeaders()
        }, options || {})).then(function(resp) {
            return resp.json().then(function(data) {
                if (!resp.ok) {
                    throw new Error((data && data.message) || 'request_failed');
                }
                return data;
            });
        });
    }

    function ensureRoot() {
        if (root) return;
        root = document.createElement('div');
        root.id = 'ak-im-root';
        root.innerHTML = `
            <style>
                #ak-im-root{display:none;position:fixed;left:calc(50% + 46px);top:calc(env(safe-area-inset-top, 0px) - 10px);z-index:2147483643;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
                #ak-im-root.ak-visible{display:block}
                #ak-im-root.ak-im-open{z-index:2147483647}
                #ak-im-root .ak-im-launcher{width:56px;height:56px;border:none;border-radius:999px;background:transparent;color:rgba(233,244,255,.84);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;position:relative;transition:color .18s ease,transform .18s ease,filter .18s ease,opacity .18s ease}
                #ak-im-root .ak-im-launcher svg{position:relative;z-index:1;width:30px;height:30px;transition:filter .18s ease}
                #ak-im-root .ak-im-launcher:hover,#ak-im-root .ak-im-launcher.is-open{transform:translateY(-1px);color:#fff0c0}
                #ak-im-root .ak-im-launcher:hover svg,#ak-im-root .ak-im-launcher.is-open svg{filter:drop-shadow(0 0 10px rgba(255,213,100,.32)) drop-shadow(0 0 4px rgba(255,240,192,.22))}
                @keyframes ak-im-icon-green-flash{0%,100%{filter:drop-shadow(0 0 8px rgba(7,193,96,.34)) drop-shadow(0 0 3px rgba(52,211,153,.22))}50%{filter:drop-shadow(0 0 14px rgba(52,211,153,.44)) drop-shadow(0 0 6px rgba(7,193,96,.28))}}
                #ak-im-root .ak-im-launcher.has-unread{color:#56c57b}
                #ak-im-root .ak-im-launcher.has-unread svg{animation:ak-im-icon-green-flash 1.8s ease-in-out infinite}
                #ak-im-root .ak-im-launcher-badge{position:absolute;top:8px;right:8px;min-width:9px;width:9px;height:9px;border-radius:999px;background:linear-gradient(180deg,#ff2f43 0%,#f30023 100%);box-shadow:0 0 8px rgba(255,39,66,.24);border:1px solid rgba(255,140,150,.22);display:none}
                #ak-im-root .ak-im-launcher.has-unread .ak-im-launcher-badge{display:block}
                #ak-im-root .ak-im-shell{display:none;position:fixed;inset:0;background:#ededed;overflow:hidden}
                #ak-im-root.ak-im-open .ak-im-shell{display:block}
                #ak-im-root.ak-im-open .ak-im-launcher{opacity:0;pointer-events:none;transform:scale(.96)}
                #ak-im-root .ak-im-screen{display:none;position:absolute;inset:0;flex-direction:column;min-height:0}
                #ak-im-root.ak-view-sessions .ak-im-session-screen{display:flex}
                #ak-im-root.ak-view-chat .ak-im-chat-screen{display:flex}
                #ak-im-root.ak-view-compose .ak-im-compose-screen{display:flex}
                #ak-im-root .ak-im-topbar{height:calc(56px + env(safe-area-inset-top, 0px));padding:calc(env(safe-area-inset-top, 0px) + 8px) 12px 8px;display:grid;grid-template-columns:52px 1fr 52px;align-items:center;background:#ededed;border-bottom:1px solid rgba(15,23,42,.06);box-sizing:border-box}
                #ak-im-root .ak-im-topbar-title,#ak-im-root .ak-im-topbar-title-wrap{text-align:center;min-width:0}
                #ak-im-root .ak-im-topbar-title{font-size:17px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-chat-title{font-size:17px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-chat-subtitle{margin-top:2px;font-size:11px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-nav-btn{height:34px;border:none;background:transparent;color:#111827;padding:0 8px;font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:10px}
                #ak-im-root .ak-im-nav-btn svg{width:20px;height:20px;stroke:currentColor}
                #ak-im-root .ak-im-nav-btn.ak-im-new{justify-self:end;font-size:15px;color:#1f2937}
                #ak-im-root .ak-im-session-page{flex:1;display:flex;flex-direction:column;min-height:0;background:#f7f7f7}
                #ak-im-root .ak-im-search-bar{padding:8px 12px;background:#ededed;border-bottom:1px solid rgba(15,23,42,.04)}
                #ak-im-root .ak-im-search-pill{height:36px;border-radius:12px;background:#ffffff;color:#6b7280;display:flex;align-items:center;justify-content:center;font-size:12px}
                #ak-im-root .ak-im-session-list{flex:1;overflow:auto;background:#ffffff}
                #ak-im-root .ak-im-session-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border:none;border-bottom:1px solid rgba(15,23,42,.05);background:#fff;cursor:pointer;position:relative}
                #ak-im-root .ak-im-session-item.ak-active{background:#f0fdf4}
                #ak-im-root .ak-im-session-avatar{width:48px;height:48px;border-radius:14px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-session-body{min-width:0;flex:1;display:grid;grid-template-columns:1fr auto;grid-template-areas:'name time' 'preview unread';align-items:center;column-gap:10px;row-gap:4px}
                #ak-im-root .ak-im-session-title{grid-area:name;font-size:16px;font-weight:500;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-session-time{grid-area:time;font-size:11px;color:#9ca3af;white-space:nowrap}
                #ak-im-root .ak-im-session-preview{grid-area:preview;font-size:13px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-session-unread{grid-area:unread;justify-self:end;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#ef4444;color:#fff;font-size:11px;display:none;align-items:center;justify-content:center}
                #ak-im-root .ak-im-session-unread.visible{display:inline-flex}
                #ak-im-root .ak-im-message-list{flex:1;overflow:auto;padding:14px 12px 10px;background:#ebebeb;display:flex;flex-direction:column;gap:14px}
                #ak-im-root .ak-im-empty{margin:auto;color:#94a3b8;font-size:13px;text-align:center;padding:28px 24px;line-height:1.6;white-space:pre-line}
                #ak-im-root .ak-im-time-divider{text-align:center;font-size:11px;color:#9ca3af;line-height:1.4}
                #ak-im-root .ak-im-message-row{display:flex;align-items:flex-start;gap:8px;max-width:100%}
                #ak-im-root .ak-im-message-row.ak-self{flex-direction:row-reverse}
                #ak-im-root .ak-im-avatar{width:34px;height:34px;border-radius:10px;background:#d1d5db;color:#374151;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-avatar{background:#7fd88a;color:#ffffff}
                #ak-im-root .ak-im-message-main{display:flex;flex-direction:column;max-width:min(78%, 420px)}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-message-main{align-items:flex-end}
                #ak-im-root .ak-im-bubble{padding:10px 12px;border-radius:8px;background:#ffffff;color:#111827;word-break:break-word;white-space:pre-wrap;box-shadow:0 1px 1px rgba(15,23,42,.04);font-size:15px;line-height:1.45}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-bubble{background:#95ec69}
                #ak-im-root .ak-im-meta{margin-top:4px;font-size:11px;color:#9ca3af;line-height:1.4}
                #ak-im-root .ak-im-composer{padding:8px 10px calc(8px + env(safe-area-inset-bottom, 0px));border-top:1px solid rgba(15,23,42,.06);display:flex;align-items:flex-end;gap:8px;background:#f7f7f7}
                #ak-im-root .ak-im-input-wrap{flex:1;min-height:36px;display:flex;align-items:flex-end;background:#ffffff;border-radius:8px;border:1px solid rgba(15,23,42,.08);padding:7px 10px}
                #ak-im-root .ak-im-input{width:100%;resize:none;border:none;outline:none;background:transparent;min-height:22px;max-height:120px;font-size:15px;line-height:1.45;color:#111827}
                #ak-im-root .ak-im-send{height:36px;border:none;border-radius:8px;padding:0 16px;background:#07c160;color:#ffffff;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .18s ease,transform .18s ease}
                #ak-im-root .ak-im-send:disabled{opacity:.42;cursor:not-allowed}
                #ak-im-root .ak-im-status{padding:0 12px calc(8px + env(safe-area-inset-bottom, 0px));background:#f7f7f7;font-size:11px;color:#9ca3af}
                #ak-im-root .ak-im-status:empty{display:none}
                #ak-im-root .ak-im-chat-subtitle:empty{display:none}
                #ak-im-root .ak-im-compose-page{flex:1;background:#f7f7f7;padding:22px 16px calc(24px + env(safe-area-inset-bottom, 0px));display:flex;flex-direction:column;gap:14px}
                #ak-im-root .ak-im-compose-card{background:#ffffff;border-radius:18px;padding:18px 16px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                #ak-im-root .ak-im-compose-label{font-size:13px;line-height:1.6;color:#6b7280}
                #ak-im-root .ak-im-compose-input{margin-top:12px;width:100%;height:48px;border:none;border-radius:12px;background:#f3f4f6;padding:0 14px;font-size:16px;color:#111827;outline:none;box-sizing:border-box}
                #ak-im-root .ak-im-compose-input:focus{background:#ffffff;box-shadow:0 0 0 2px rgba(7,193,96,.16) inset}
                #ak-im-root .ak-im-compose-tip{margin-top:10px;font-size:12px;line-height:1.6;color:#9ca3af}
                #ak-im-root .ak-im-compose-error{color:#ef4444}
                #ak-im-root .ak-im-compose-actions{display:flex;gap:10px;margin-top:auto}
                #ak-im-root .ak-im-compose-btn{flex:1;height:44px;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer}
                #ak-im-root .ak-im-compose-btn-secondary{background:#e5e7eb;color:#374151}
                #ak-im-root .ak-im-compose-btn-primary{background:#07c160;color:#ffffff}
                #ak-im-root .ak-im-compose-btn:disabled{opacity:.42;cursor:not-allowed}
                #ak-im-root .ak-im-system-row{align-self:center;background:rgba(0,0,0,.06);color:#6b7280;font-size:12px;line-height:1.6;padding:6px 10px;border-radius:999px;max-width:78%;text-align:center}
                #ak-im-root .ak-im-system-row a{color:#07c160;text-decoration:none;margin-left:6px;font-size:12px}
                #ak-im-root .ak-im-system-row a:active{opacity:.7}
                #ak-im-root .ak-im-action-sheet{display:none;position:fixed;inset:0;z-index:2147483648}
                #ak-im-root .ak-im-action-sheet.visible{display:block}
                #ak-im-root .ak-im-action-mask{position:absolute;inset:0;background:rgba(0,0,0,.18)}
                #ak-im-root .ak-im-action-panel{position:absolute;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom, 0px));background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 16px 36px rgba(0,0,0,.18)}
                #ak-im-root .ak-im-action-btn{width:100%;height:52px;border:none;background:#ffffff;color:#111827;font-size:16px;font-weight:600;cursor:pointer}
                #ak-im-root .ak-im-action-btn + .ak-im-action-btn{border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-action-btn.danger{color:#ef4444}
                #ak-im-root .ak-im-action-btn:disabled{opacity:.45;cursor:not-allowed}
                @media (max-width: 640px){#ak-im-root{left:calc(50% + 42px);top:calc(env(safe-area-inset-top, 0px) - 10px)}#ak-im-root .ak-im-topbar{grid-template-columns:48px 1fr 56px}#ak-im-root .ak-im-session-avatar{width:44px;height:44px;border-radius:12px}#ak-im-root .ak-im-message-main{max-width:78%}}
            </style>
            <button class="ak-im-launcher" type="button" aria-label="内部聊天">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6.25 6.15C6.25 4.96 7.21 4 8.4 4H13.05C14.24 4 15.2 4.96 15.2 6.15V9.85C15.2 11.04 14.24 12 13.05 12H10.15L7.45 14.08C7.17 14.3 6.75 14.1 6.75 13.75V12H6.25V6.15Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="9.45" cy="8" r="0.8" fill="currentColor"/>
                    <circle cx="11.95" cy="8" r="0.8" fill="currentColor"/>
                    <path d="M14.15 8.55H16.2C17.39 8.55 18.35 9.51 18.35 10.7V13.15C18.35 14.34 17.39 15.3 16.2 15.3H15.05V16.55C15.05 16.89 14.66 17.09 14.39 16.89L12.55 15.55" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>
                </svg>
                <span class="ak-im-launcher-badge" aria-hidden="true"></span>
            </button>
            <div class="ak-im-shell">
                <div class="ak-im-screen ak-im-session-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-close" type="button" aria-label="关闭内部聊天">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title">内部聊天</div>
                        <button class="ak-im-nav-btn ak-im-new" type="button" data-im-action="new">发起</button>
                    </div>
                    <div class="ak-im-session-page">
                        <div class="ak-im-search-bar"><div class="ak-im-search-pill">点击右上角发起单聊</div></div>
                        <div class="ak-im-session-list"></div>
                    </div>
                </div>
                <div class="ak-im-screen ak-im-chat-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-back" type="button" aria-label="返回会话列表">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title-wrap"><div class="ak-im-chat-title">内部聊天</div><div class="ak-im-chat-subtitle">选择一个会话开始单聊</div></div>
                        <button class="ak-im-nav-btn ak-im-chat-close" type="button" aria-label="关闭内部聊天">关闭</button>
                    </div>
                    <div class="ak-im-message-list"></div>
                    <div class="ak-im-composer"><div class="ak-im-input-wrap"><textarea class="ak-im-input" placeholder="输入消息"></textarea></div><button class="ak-im-send" type="button">发送</button></div>
                    <div class="ak-im-status"></div>
                </div>
                <div class="ak-im-screen ak-im-compose-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-compose-back" type="button" aria-label="返回会话列表">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title">发起聊天</div>
                        <button class="ak-im-nav-btn ak-im-compose-close" type="button" aria-label="关闭发起聊天">取消</button>
                    </div>
                    <div class="ak-im-compose-page">
                        <div class="ak-im-compose-card">
                            <div class="ak-im-compose-label">请输入要发起聊天的账号 username</div>
                            <input class="ak-im-compose-input" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="例如：hjy574139" />
                            <div class="ak-im-compose-tip">输入对方账号后开始单聊</div>
                        </div>
                        <div class="ak-im-compose-actions">
                            <button class="ak-im-compose-btn ak-im-compose-btn-secondary" type="button" data-im-action="compose-cancel">返回</button>
                            <button class="ak-im-compose-btn ak-im-compose-btn-primary" type="button" data-im-action="compose-submit">开始聊天</button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="ak-im-action-sheet" aria-hidden="true" inert>
                <div class="ak-im-action-mask"></div>
                <div class="ak-im-action-panel">
                    <button class="ak-im-action-btn danger" type="button" data-im-action="recall">撤回</button>
                    <button class="ak-im-action-btn" type="button" data-im-action="cancel">取消</button>
                </div>
            </div>
        `;
        document.body.appendChild(root);
        panel = root.querySelector('.ak-im-shell');
        sessionList = root.querySelector('.ak-im-session-list');
        messageList = root.querySelector('.ak-im-message-list');
        statusLine = root.querySelector('.ak-im-status');
        inputEl = root.querySelector('.ak-im-input');
        newSessionInputEl = root.querySelector('.ak-im-compose-input');
        sendBtn = root.querySelector('.ak-im-send');
        actionSheetEl = root.querySelector('.ak-im-action-sheet');
        actionSheetRecallBtn = root.querySelector('[data-im-action="recall"]');
        actionSheetCancelBtn = root.querySelector('[data-im-action="cancel"]');
        root.querySelector('.ak-im-launcher').addEventListener('click', function() {
            state.open = true;
            if (state.view !== 'compose' && !state.activeConversationId) state.view = 'sessions';
            render();
        });
        root.querySelector('.ak-im-close').addEventListener('click', function() {
            closeActionSheet();
            state.open = false;
            state.view = 'sessions';
            render();
        });
        root.querySelector('.ak-im-back').addEventListener('click', function() {
            closeActionSheet();
            state.view = 'sessions';
            render();
        });
        root.querySelector('.ak-im-chat-close').addEventListener('click', function() {
            closeActionSheet();
            state.open = false;
            state.view = 'sessions';
            render();
        });
        root.querySelector('.ak-im-compose-back').addEventListener('click', closeComposeView);
        root.querySelector('.ak-im-compose-close').addEventListener('click', closeComposeView);
        root.querySelector('[data-im-action="new"]').addEventListener('click', startDirectSession);
        root.querySelector('[data-im-action="compose-cancel"]').addEventListener('click', closeComposeView);
        root.querySelector('[data-im-action="compose-submit"]').addEventListener('click', submitDirectSession);
        sendBtn.addEventListener('click', sendCurrentMessage);
        inputEl.addEventListener('input', function() {
            state.inputValue = inputEl.value || '';
            syncInputHeight();
            syncComposerState();
        });
        newSessionInputEl.addEventListener('input', function() {
            state.newSessionTarget = newSessionInputEl.value || '';
            if (state.newSessionError) state.newSessionError = '';
            renderComposeView();
        });
        newSessionInputEl.addEventListener('keydown', function(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                submitDirectSession();
            }
        });
        inputEl.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendCurrentMessage();
            }
        });
        actionSheetEl.querySelector('.ak-im-action-mask').addEventListener('click', function() {
            closeActionSheet();
        });
        actionSheetCancelBtn.addEventListener('click', function() {
            closeActionSheet();
        });
        actionSheetRecallBtn.addEventListener('click', function() {
            if (!state.actionSheetCanRecall || !state.actionSheetMessageId) return;
            recallMessage(state.actionSheetMessageId, state.actionSheetConversationId, state.actionSheetDraftText);
        });
        syncInputHeight();
        syncComposerState();
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, function(char) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char;
        });
    }

    function formatTime(value) {
        if (!value) return '';
        try {
            return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            return '';
        }
    }

    function formatSessionTime(value) {
        if (!value) return '';
        try {
            const date = new Date(value);
            if (isNaN(date.getTime())) return '';
            const now = new Date();
            if (date.toDateString() === now.toDateString()) {
                return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            }
            return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
        } catch (e) {
            return '';
        }
    }

    function getActiveSession() {
        return state.sessions.find(function(item) {
            return Number(item && item.conversation_id || 0) === Number(state.activeConversationId || 0);
        }) || null;
    }

    function getSessionDisplayName(item) {
        return String(item && (item.peer_display_name || item.peer_username || '内部聊天') || '内部聊天').trim();
    }

    function getSessionPreview(item) {
        return String(item && item.last_message_preview || '').trim() || '暂无消息';
    }

    function getAvatarText(value) {
        const raw = String(value || '').replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, '').trim();
        if (!raw) return '聊';
        return raw.slice(0, 2).toUpperCase();
    }

    function getUnreadCount(item) {
        return Number(item && (item.unread_count || item.unread || 0) || 0);
    }

    function shouldAutoMarkRead(conversationId) {
        return !!state.open && state.view === 'chat' && Number(state.activeConversationId || 0) === Number(conversationId || 0) && document.visibilityState !== 'hidden';
    }

    function canRecallMessage(item) {
        if (!item || typeof item !== 'object') return false;
        if (String(item.status || '').toLowerCase() === 'recalled') return false;
        if (String(item.sender_username || '') !== String(state.username || '')) return false;
        try {
            const sentAt = new Date(item.sent_at);
            if (isNaN(sentAt.getTime())) return false;
            return (Date.now() - sentAt.getTime()) <= 60 * 1000;
        } catch (e) {
            return false;
        }
    }

    function openActionSheet(messageItem) {
        if (!actionSheetEl) return;
        state.actionSheetOpen = true;
        state.actionSheetMessageId = Number(messageItem && messageItem.id || 0);
        state.actionSheetConversationId = Number(messageItem && messageItem.conversation_id || state.activeConversationId || 0);
        state.actionSheetCanRecall = canRecallMessage(messageItem);
        state.actionSheetDraftText = String(messageItem && (messageItem.content || messageItem.content_preview || '') || '');
        actionSheetRecallBtn.disabled = !state.actionSheetCanRecall;
        actionSheetEl.removeAttribute('inert');
        actionSheetEl.classList.add('visible');
        actionSheetEl.setAttribute('aria-hidden', 'false');
    }

    function closeActionSheet() {
        if (!actionSheetEl) return;
        const activeElement = document.activeElement;
        if (activeElement && actionSheetEl.contains(activeElement) && typeof activeElement.blur === 'function') {
            activeElement.blur();
        }
        state.actionSheetOpen = false;
        state.actionSheetMessageId = 0;
        state.actionSheetConversationId = 0;
        state.actionSheetCanRecall = false;
        state.actionSheetDraftText = '';
        actionSheetEl.classList.remove('visible');
        actionSheetEl.setAttribute('inert', '');
        actionSheetEl.setAttribute('aria-hidden', 'true');
    }

    function renderComposeView() {
        if (!root || !newSessionInputEl) return;
        const tipEl = root.querySelector('.ak-im-compose-tip');
        const submitBtn = root.querySelector('[data-im-action="compose-submit"]');
        newSessionInputEl.value = state.newSessionTarget;
        submitBtn.disabled = !String(state.newSessionTarget || '').trim();
        tipEl.classList.toggle('ak-im-compose-error', !!state.newSessionError);
        tipEl.textContent = state.newSessionError || '输入对方账号后开始单聊';
    }

    function focusComposeInput() {
        if (!newSessionInputEl) return;
        setTimeout(function() {
            if (!newSessionInputEl) return;
            newSessionInputEl.focus();
            try {
                const length = newSessionInputEl.value.length;
                newSessionInputEl.setSelectionRange(length, length);
            } catch (e) {}
        }, 0);
    }

    function closeComposeView() {
        closeActionSheet();
        state.newSessionError = '';
        state.newSessionTarget = '';
        state.view = 'sessions';
        render();
    }

    function syncInputHeight() {
        if (!inputEl) return;
        inputEl.style.height = '22px';
        const nextHeight = Math.min(Math.max(inputEl.scrollHeight, 22), 120);
        inputEl.style.height = `${nextHeight}px`;
    }

    function syncComposerState() {
        if (!inputEl || !sendBtn) return;
        const canSend = !!state.activeConversationId;
        inputEl.disabled = !canSend;
        inputEl.placeholder = canSend ? '输入消息' : '先选择一个会话';
        sendBtn.disabled = !canSend || !String(inputEl.value || '').trim();
    }

    function render() {
        if (!root) return;
        const activeSession = getActiveSession();
        const showChat = !!activeSession && state.view === 'chat';
        const showCompose = state.view === 'compose';
        root.classList.toggle('ak-visible', !!state.allowed);
        root.classList.toggle('ak-im-open', !!state.open);
        root.classList.toggle('ak-view-sessions', !showChat && !showCompose);
        root.classList.toggle('ak-view-chat', !!showChat);
        root.classList.toggle('ak-view-compose', !!showCompose);
        root.querySelector('.ak-im-launcher').classList.toggle('is-open', !!state.open);
        root.querySelector('.ak-im-launcher').classList.toggle('has-unread', state.sessions.some(function(item) {
            return getUnreadCount(item) > 0;
        }));
        statusLine.textContent = '';
        sessionList.innerHTML = '';
        if (!state.sessions.length) {
            const empty = document.createElement('div');
            empty.className = 'ak-im-empty';
            empty.textContent = state.allowed ? '暂无会话\n点击右上角“发起”开始单聊' : '当前账号未开通聊天';
            sessionList.appendChild(empty);
        } else {
            state.sessions.forEach(function(item) {
                const node = document.createElement('div');
                node.className = 'ak-im-session-item' + (item.conversation_id === state.activeConversationId ? ' ak-active' : '');
                const unreadCount = getUnreadCount(item);
                node.innerHTML = '<div class="ak-im-session-avatar">' + escapeHtml(getAvatarText(getSessionDisplayName(item))) + '</div>' +
                    '<div class="ak-im-session-body">' +
                        '<div class="ak-im-session-title">' + escapeHtml(getSessionDisplayName(item)) + '</div>' +
                        '<div class="ak-im-session-time">' + escapeHtml(formatSessionTime(item.last_message_at || item.updated_at || item.created_at)) + '</div>' +
                        '<div class="ak-im-session-preview">' + escapeHtml(getSessionPreview(item)) + '</div>' +
                        '<div class="ak-im-session-unread' + (unreadCount > 0 ? ' visible' : '') + '">' + escapeHtml(unreadCount > 99 ? '99+' : String(unreadCount || '')) + '</div>' +
                    '</div>';
                node.addEventListener('click', function() {
                    state.activeConversationId = item.conversation_id;
                    state.view = 'chat';
                    state.activeMessages = [];
                    loadMessages(item.conversation_id);
                    render();
                });
                sessionList.appendChild(node);
            });
        }
        syncComposerState();
        syncInputHeight();
        renderMessages();
        renderComposeView();
        if (showChat) markRead(state.activeConversationId);
        if (state.open && state.view === 'compose') focusComposeInput();
    }

    function renderMessages() {
        const headerTitle = root.querySelector('.ak-im-chat-title');
        const headerSubtitle = root.querySelector('.ak-im-chat-subtitle');
        const activeSession = getActiveSession();
        headerTitle.textContent = activeSession ? getSessionDisplayName(activeSession) : '内部聊天';
        headerSubtitle.textContent = '';
        messageList.innerHTML = '';
        if (!state.activeConversationId) {
            const empty = document.createElement('div');
            empty.className = 'ak-im-empty';
            empty.textContent = state.allowed ? '选择一个会话\n开始内部单聊' : '当前账号未开通聊天';
            messageList.appendChild(empty);
            return;
        }
        if (!state.activeMessages.length) {
            const empty = document.createElement('div');
            empty.className = 'ak-im-empty';
            empty.textContent = '还没有消息\n发一条试试';
            messageList.appendChild(empty);
            return;
        }
        state.activeMessages.forEach(function(item) {
            const isSelf = item.sender_username === state.username;
            const isRecalled = String(item.status || '').toLowerCase() === 'recalled';
            if (isRecalled) {
                const systemRow = document.createElement('div');
                systemRow.className = 'ak-im-system-row';
                const systemText = isSelf ? '你撤回了一条消息' : '对方撤回了一条消息';
                const draftText = String(state.recalledDraftByMessageId[item.id] || '').trim();
                systemRow.textContent = systemText;
                if (isSelf && draftText) {
                    const link = document.createElement('a');
                    link.href = 'javascript:void(0)';
                    link.textContent = '重新编辑';
                    link.addEventListener('click', function(event) {
                        event.preventDefault();
                        event.stopPropagation();
                        inputEl.value = draftText;
                        state.inputValue = draftText;
                        state.view = 'chat';
                        state.open = true;
                        syncInputHeight();
                        syncComposerState();
                        try { inputEl.focus(); } catch (e) {}
                    });
                    systemRow.appendChild(link);
                }
                messageList.appendChild(systemRow);
                return;
            }
            const wrapper = document.createElement('div');
            const displayName = isSelf ? (state.displayName || state.username || '我') : (activeSession ? getSessionDisplayName(activeSession) : (item.sender_username || '对方'));
            const metaText = isSelf && item.read ? '对方已读' : '';
            wrapper.innerHTML = '<div class="ak-im-time-divider">' + escapeHtml(formatTime(item.sent_at)) + '</div>' +
                '<div class="ak-im-message-row ' + (isSelf ? 'ak-self' : 'ak-peer') + '">' +
                    '<div class="ak-im-avatar">' + escapeHtml(getAvatarText(displayName)) + '</div>' +
                    '<div class="ak-im-message-main">' +
                        '<div class="ak-im-bubble">' + escapeHtml(item.content || item.content_preview || '') + '</div>' +
                        (metaText ? '<div class="ak-im-meta">' + escapeHtml(metaText) + '</div>' : '') +
                    '</div>' +
                '</div>';
            if (isSelf) {
                const bubble = wrapper.querySelector('.ak-im-bubble');
                if (bubble) {
                    let pressTimer = null;
                    const startPress = function(event) {
                        if (!canRecallMessage(item)) return;
                        if (pressTimer) clearTimeout(pressTimer);
                        pressTimer = setTimeout(function() {
                            openActionSheet(item);
                        }, 420);
                    };
                    const cancelPress = function() {
                        if (pressTimer) {
                            clearTimeout(pressTimer);
                            pressTimer = null;
                        }
                    };
                    bubble.addEventListener('pointerdown', startPress);
                    bubble.addEventListener('pointerup', cancelPress);
                    bubble.addEventListener('pointercancel', cancelPress);
                    bubble.addEventListener('pointerleave', cancelPress);
                    bubble.addEventListener('contextmenu', function(event) {
                        event.preventDefault();
                        if (!canRecallMessage(item)) return;
                        openActionSheet(item);
                    });
                }
            }
            messageList.appendChild(wrapper);
        });
        messageList.scrollTop = messageList.scrollHeight;
    }

    function loadBootstrap() {
        return request(`${HTTP_ROOT}/bootstrap`).then(function(data) {
            state.allowed = !!(data && data.allowed);
            state.ready = true;
            state.username = String((data && data.username) || '').trim();
            state.displayName = String((data && data.display_name) || state.username || '').trim();
            if (!state.allowed) {
                render();
                return null;
            }
            ensureWebSocket();
            return loadSessions();
        }).catch(function() {
            state.allowed = false;
            state.ready = true;
            render();
            return null;
        });
    }

    function loadSessions() {
        return request(`${HTTP_ROOT}/sessions`).then(function(data) {
            state.sessions = Array.isArray(data && data.items) ? data.items : [];
            render();
            return null;
        }).catch(function() {
            render();
            return null;
        });
    }

    function loadMessages(conversationId) {
        return request(`${HTTP_ROOT}/messages?conversation_id=${encodeURIComponent(conversationId)}`).then(function(data) {
            state.activeMessages = Array.isArray(data && data.items) ? data.items : [];
            render();
            markRead(conversationId);
            return null;
        }).catch(function() {
            render();
            return null;
        });
    }

    function startDirectSession() {
        if (!state.allowed) return;
        state.newSessionError = '';
        state.newSessionTarget = '';
        state.view = 'compose';
        render();
    }

    function submitDirectSession() {
        if (!state.allowed) return;
        const target = String(state.newSessionTarget || '').trim();
        if (!target) {
            state.newSessionError = '请输入要发起聊天的账号 username';
            renderComposeView();
            focusComposeInput();
            return;
        }
        request(`${HTTP_ROOT}/sessions/direct`, {
            method: 'POST',
            body: JSON.stringify({ target_username: target })
        }).then(function(data) {
            state.activeConversationId = Number((data && data.conversation_id) || 0);
            state.view = 'chat';
            state.activeMessages = [];
            state.newSessionTarget = '';
            state.newSessionError = '';
            return loadSessions().then(function() {
                return loadMessages(state.activeConversationId);
            });
        }).catch(function(error) {
            state.newSessionError = error && error.message ? error.message : '发起会话失败';
            renderComposeView();
            focusComposeInput();
        });
    }

    function sendCurrentMessage() {
        if (!state.allowed || !state.activeConversationId) return;
        const content = String((inputEl && inputEl.value) || '').trim();
        if (!content) return;
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'im.message.send',
                payload: {
                    conversation_id: state.activeConversationId,
                    content: content
                }
            }));
            inputEl.value = '';
            state.inputValue = '';
            syncInputHeight();
            syncComposerState();
            return;
        }
        request(`${HTTP_ROOT}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                conversation_id: state.activeConversationId,
                content: content
            })
        }).then(function() {
            inputEl.value = '';
            state.inputValue = '';
            syncInputHeight();
            syncComposerState();
            return loadMessages(state.activeConversationId).then(loadSessions);
        }).catch(function(error) {
            window.alert(error && error.message ? error.message : '发送失败');
        });
    }

    function recallMessage(messageId, conversationId, draftText) {
        closeActionSheet();
        const mid = Number(messageId || 0);
        const cid = Number(conversationId || 0);
        if (!mid || !cid) return;
        const draft = String(draftText || '').trim();
        if (draft) state.recalledDraftByMessageId[mid] = draft;
        request(`${HTTP_ROOT}/messages/recall`, {
            method: 'POST',
            body: JSON.stringify({ message_id: mid })
        }).then(function(data) {
            const item = data && data.item ? data.item : null;
            if (item && item.id) {
                applyMessageRecalled(item);
            }
            loadSessions();
        }).catch(function(error) {
            window.alert(error && error.message ? error.message : '撤回失败');
        });
    }

    function applyMessageRecalled(item) {
        if (!item || !item.id) return;
        const cid = Number(item.conversation_id || 0);
        if (!cid) return;
        if (Number(cid) === Number(state.activeConversationId || 0)) {
            const next = [];
            state.activeMessages.forEach(function(current) {
                if (!current || Number(current.id || 0) !== Number(item.id || 0)) {
                    next.push(current);
                    return;
                }
                next.push(Object.assign({}, current, {
                    status: 'recalled',
                    content: '',
                    content_preview: '[消息已撤回]'
                }));
            });
            state.activeMessages = next;
            renderMessages();
        }
    }

    function clearSessionUnread(conversationId) {
        const targetConversationId = Number(conversationId || 0);
        if (!targetConversationId || !Array.isArray(state.sessions) || !state.sessions.length) return;
        let changed = false;
        state.sessions = state.sessions.map(function(item) {
            if (!item || Number(item.conversation_id || 0) !== targetConversationId) return item;
            const unreadCount = getUnreadCount(item);
            if (unreadCount <= 0) return item;
            changed = true;
            return Object.assign({}, item, {
                unread_count: 0,
                unread: 0
            });
        });
        if (changed) render();
    }

    function markRead(conversationId) {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        const targetConversationId = Number(conversationId || state.activeConversationId || 0);
        if (!targetConversationId || !shouldAutoMarkRead(targetConversationId) || !state.activeMessages.length) return;
        let lastPeerMessage = null;
        for (let index = state.activeMessages.length - 1; index >= 0; index -= 1) {
            const candidate = state.activeMessages[index];
            if (candidate && candidate.sender_username !== state.username) {
                lastPeerMessage = candidate;
                break;
            }
        }
        if (!lastPeerMessage || !lastPeerMessage.seq_no) return;
        const lastSeqNo = Number(lastPeerMessage.seq_no || 0);
        if (!lastSeqNo) return;
        const previousMarkedSeqNo = Number(state.lastReadSentByConversation[targetConversationId] || 0);
        if (lastSeqNo <= previousMarkedSeqNo) return;
        state.lastReadSentByConversation[targetConversationId] = lastSeqNo;
        state.ws.send(JSON.stringify({
            type: 'im.message.read',
            payload: {
                conversation_id: targetConversationId,
                seq_no: lastSeqNo
            }
        }));
        clearSessionUnread(targetConversationId);
    }

    function ensureWebSocket() {
        if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
        try {
            state.ws = new WebSocket(buildWsUrl());
            state.ws.addEventListener('message', function(event) {
                try {
                    const data = JSON.parse(event.data || '{}');
                    if (data.type === 'im.message.created') {
                        const item = data.payload || null;
                        if (!item || !item.conversation_id) return;
                        if (Number(item.conversation_id) === Number(state.activeConversationId)) {
                            state.activeMessages.push(item);
                            renderMessages();
                            if (item.sender_username !== state.username) markRead(item.conversation_id);
                        }
                        loadSessions();
                        return;
                    }
                    if (data.type === 'im.message.read') {
                        const payload = data.payload || null;
                        if (payload && Number(payload.conversation_id || 0) > 0) {
                            loadSessions();
                        }
                        if (payload && Number(payload.conversation_id || 0) === Number(state.activeConversationId || 0)) {
                            loadMessages(state.activeConversationId);
                        }
                        return;
                    }
                    if (data.type === 'im.message.recalled') {
                        const payload = data.payload || null;
                        if (payload && payload.id) {
                            applyMessageRecalled(payload);
                            loadSessions();
                        }
                    }
                } catch (e) {}
            });
            state.ws.addEventListener('close', function() {
                state.ws = null;
                setTimeout(function() {
                    if (state.allowed) ensureWebSocket();
                }, 1500);
            });
        } catch (e) {}
    }

    function init() {
        ensureRoot();
        render();
        loadBootstrap();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.AKIMClient = {
        open: function() { state.open = true; if (!state.activeConversationId) state.view = 'sessions'; render(); },
        close: function() { closeActionSheet(); state.open = false; state.view = 'sessions'; render(); },
        reloadSessions: loadSessions
    };
})();
