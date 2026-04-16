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
        inputValue: '',
        actionSheetMode: '',
        actionSheetSessionPinned: false,
        actionSheetSessionSystemPinned: false,
        readProgressOpen: false,
        readProgressLoading: false,
        readProgressError: '',
        readProgressMessageId: 0,
        readProgressData: null,
        memberPanelOpen: false,
        memberPanelLoading: false,
        memberPanelError: '',
        memberPanelConversationId: 0,
        memberPanelData: null,
        groupSettingsOpen: false,
        groupSettingsLoading: false,
        groupSettingsError: '',
        groupSettingsConversationId: 0,
        groupSettingsData: null
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
    let progressPanelEl = null;
    let progressPanelBodyEl = null;
    let memberPanelEl = null;
    let memberPanelBodyEl = null;
    let chatTitleBtnEl = null;
    let settingsPanelEl = null;
    let settingsPanelBodyEl = null;
    let chatMenuBtnEl = null;

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
                #ak-im-root .ak-im-chat-title-btn{width:100%;border:none;background:transparent;padding:0;margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:10px;min-width:0}
                #ak-im-root .ak-im-chat-title-btn.is-clickable{cursor:pointer}
                #ak-im-root .ak-im-chat-title-btn.is-clickable:active{opacity:.76}
                #ak-im-root .ak-im-chat-title-btn:disabled{cursor:default;opacity:1}
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
                #ak-im-root .ak-im-session-item.is-pinned{background:#f7fcf7}
                #ak-im-root .ak-im-session-avatar{width:48px;height:48px;border-radius:14px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-session-body{min-width:0;flex:1;display:grid;grid-template-columns:1fr auto;grid-template-areas:'name time' 'preview unread';align-items:center;column-gap:10px;row-gap:4px}
                #ak-im-root .ak-im-session-title{grid-area:name;display:flex;align-items:center;gap:6px;min-width:0;font-size:16px;font-weight:500;color:#111827}
                #ak-im-root .ak-im-session-title-text{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-session-pin-tag{display:none;align-items:center;justify-content:center;flex:0 0 auto;height:18px;padding:0 6px;border-radius:999px;background:rgba(15,23,42,.06);color:#4b5563;font-size:10px;font-weight:700}
                #ak-im-root .ak-im-session-pin-tag.visible{display:inline-flex}
                #ak-im-root .ak-im-session-pin-tag.is-system{background:rgba(7,193,96,.12);color:#07c160}
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
                #ak-im-root .ak-im-message-sender{margin-bottom:4px;padding:0 2px;font-size:11px;color:#6b7280;line-height:1.4}
                #ak-im-root .ak-im-bubble{padding:10px 12px;border-radius:8px;background:#ffffff;color:#111827;word-break:break-word;white-space:pre-wrap;box-shadow:0 1px 1px rgba(15,23,42,.04);font-size:15px;line-height:1.45}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-bubble{background:#95ec69}
                #ak-im-root .ak-im-message-footer{margin-top:4px;display:flex;align-items:center;gap:6px;min-height:22px}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-message-footer{justify-content:flex-end}
                #ak-im-root .ak-im-meta{font-size:11px;color:#9ca3af;line-height:1.4}
                #ak-im-root .ak-im-progress-btn{width:24px;height:24px;border:none;background:transparent;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;cursor:pointer;position:relative}
                #ak-im-root .ak-im-progress-ring{width:24px;height:24px;transform:rotate(-90deg);overflow:visible}
                #ak-im-root .ak-im-progress-track{fill:none;stroke:rgba(15,23,42,.1);stroke-width:2}
                #ak-im-root .ak-im-progress-value{fill:none;stroke:#16a34a;stroke-width:2;stroke-linecap:round;transition:stroke-dashoffset .18s ease}
                #ak-im-root .ak-im-progress-label{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:#16a34a;line-height:1;letter-spacing:-.02em}
                #ak-im-root .ak-im-progress-btn.is-complete .ak-im-progress-label{font-size:11px}
                #ak-im-root .ak-im-progress-btn:focus-visible{outline:none}
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
                #ak-im-root .ak-im-progress-sheet{display:none;position:fixed;inset:0;z-index:2147483649}
                #ak-im-root .ak-im-progress-sheet.visible{display:block}
                #ak-im-root .ak-im-progress-mask{position:absolute;inset:0;background:rgba(0,0,0,.22)}
                #ak-im-root .ak-im-progress-panel{position:absolute;left:0;right:0;bottom:0;background:#ffffff;border-radius:18px 18px 0 0;box-shadow:0 -12px 36px rgba(0,0,0,.18);max-height:min(72vh,560px);display:flex;flex-direction:column}
                #ak-im-root .ak-im-progress-header{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px;border-bottom:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-progress-title{font-size:16px;font-weight:600;color:#111827}
                #ak-im-root .ak-im-progress-close{height:32px;border:none;background:transparent;color:#6b7280;font-size:14px;cursor:pointer}
                #ak-im-root .ak-im-progress-panel-body{overflow:auto;padding-bottom:calc(14px + env(safe-area-inset-bottom, 0px))}
                #ak-im-root .ak-im-progress-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:14px 16px 6px}
                #ak-im-root .ak-im-progress-stat{background:#f8fafc;border-radius:14px;padding:12px 10px;text-align:center}
                #ak-im-root .ak-im-progress-stat-value{font-size:18px;font-weight:700;color:#111827;line-height:1.2}
                #ak-im-root .ak-im-progress-stat-label{margin-top:4px;font-size:12px;color:#6b7280;line-height:1.4}
                #ak-im-root .ak-im-progress-list{padding:8px 16px 18px}
                #ak-im-root .ak-im-progress-list-title{margin:0 0 8px;font-size:13px;font-weight:600;color:#374151;line-height:1.4}
                #ak-im-root .ak-im-progress-member{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-progress-member:last-child{border-bottom:none}
                #ak-im-root .ak-im-progress-member-name{font-size:14px;color:#111827;line-height:1.4}
                #ak-im-root .ak-im-progress-member-username{margin-left:8px;font-size:12px;color:#9ca3af;line-height:1.4}
                #ak-im-root .ak-im-progress-loading,#ak-im-root .ak-im-progress-error,#ak-im-root .ak-im-progress-empty{padding:18px 16px;color:#6b7280;font-size:13px;line-height:1.6;text-align:center}
                #ak-im-root .ak-im-progress-error{color:#ef4444}
                #ak-im-root .ak-im-member-sheet{display:none;position:fixed;inset:0;z-index:2147483650}
                #ak-im-root .ak-im-member-sheet.visible{display:block}
                #ak-im-root .ak-im-member-mask{position:absolute;inset:0;background:rgba(0,0,0,.22)}
                #ak-im-root .ak-im-member-panel{position:absolute;left:0;right:0;bottom:0;background:#ffffff;border-radius:18px 18px 0 0;box-shadow:0 -12px 36px rgba(0,0,0,.18);max-height:min(72vh,560px);display:flex;flex-direction:column}
                #ak-im-root .ak-im-member-header{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px;border-bottom:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-member-title{font-size:16px;font-weight:600;color:#111827}
                #ak-im-root .ak-im-member-close{height:32px;border:none;background:transparent;color:#6b7280;font-size:14px;cursor:pointer}
                #ak-im-root .ak-im-member-panel-body{overflow:auto;padding-bottom:calc(14px + env(safe-area-inset-bottom, 0px))}
                #ak-im-root .ak-im-member-summary{padding:14px 16px 6px;font-size:13px;color:#6b7280;line-height:1.6}
                #ak-im-root .ak-im-member-list{padding:0 16px 18px}
                #ak-im-root .ak-im-member-item{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-member-item:last-child{border-bottom:none}
                #ak-im-root .ak-im-member-avatar{width:36px;height:36px;border-radius:12px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-member-body{min-width:0;flex:1}
                #ak-im-root .ak-im-member-name{font-size:14px;color:#111827;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-member-username{margin-top:2px;font-size:12px;color:#9ca3af;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-member-role{margin-left:auto;flex:0 0 auto;height:18px;padding:0 6px;border-radius:999px;background:rgba(7,193,96,.12);color:#16a34a;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
                #ak-im-root .ak-im-member-loading,#ak-im-root .ak-im-member-error,#ak-im-root .ak-im-member-empty{padding:18px 16px;color:#6b7280;font-size:13px;line-height:1.6;text-align:center}
                #ak-im-root .ak-im-member-error{color:#ef4444}
                #ak-im-root .ak-im-chat-menu.is-hidden{opacity:0;pointer-events:none}
                #ak-im-root .ak-im-chat-menu svg{width:20px;height:20px;stroke:currentColor}
                #ak-im-root .ak-im-settings-sheet{display:none;position:fixed;inset:0;z-index:2147483651}
                #ak-im-root .ak-im-settings-sheet.visible{display:block}
                #ak-im-root .ak-im-settings-mask{position:absolute;inset:0;background:rgba(0,0,0,.22)}
                #ak-im-root .ak-im-settings-panel{position:absolute;left:0;right:0;bottom:0;background:#ffffff;border-radius:18px 18px 0 0;box-shadow:0 -12px 36px rgba(0,0,0,.18);max-height:min(72vh,560px);display:flex;flex-direction:column}
                #ak-im-root .ak-im-settings-header{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px;border-bottom:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-settings-title{font-size:16px;font-weight:600;color:#111827}
                #ak-im-root .ak-im-settings-close{height:32px;border:none;background:transparent;color:#6b7280;font-size:14px;cursor:pointer}
                #ak-im-root .ak-im-settings-panel-body{overflow:auto;padding:14px 16px calc(18px + env(safe-area-inset-bottom, 0px))}
                #ak-im-root .ak-im-settings-loading,#ak-im-root .ak-im-settings-error,#ak-im-root .ak-im-settings-empty{padding:18px 16px;color:#6b7280;font-size:13px;line-height:1.6;text-align:center}
                #ak-im-root .ak-im-settings-error{color:#ef4444}
                #ak-im-root .ak-im-settings-summary{padding:14px 16px;border-radius:16px;background:#f8fafc}
                #ak-im-root .ak-im-settings-summary-title{font-size:16px;font-weight:700;color:#111827;line-height:1.4}
                #ak-im-root .ak-im-settings-summary-meta{margin-top:6px;font-size:12px;color:#6b7280;line-height:1.6}
                #ak-im-root .ak-im-settings-section{margin-top:12px;padding:14px 16px;border:1px solid rgba(15,23,42,.06);border-radius:16px;background:#ffffff}
                #ak-im-root .ak-im-settings-section-title{font-size:14px;font-weight:700;color:#111827;line-height:1.4}
                #ak-im-root .ak-im-settings-section-desc{margin-top:6px;font-size:12px;color:#6b7280;line-height:1.6}
                #ak-im-root .ak-im-settings-chip-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
                #ak-im-root .ak-im-settings-chip{display:inline-flex;align-items:center;gap:6px;padding:8px 10px;border-radius:999px;background:#f3f4f6;color:#111827;font-size:12px;line-height:1.3}
                #ak-im-root .ak-im-settings-chip-role{color:#16a34a;font-weight:700}
                #ak-im-root .ak-im-settings-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
                #ak-im-root .ak-im-settings-btn{height:40px;border:none;border-radius:12px;background:#07c160;color:#ffffff;font-size:13px;font-weight:700;cursor:pointer}
                #ak-im-root .ak-im-settings-btn.secondary{background:#eef2ff;color:#3730a3}
                #ak-im-root .ak-im-settings-btn.danger{background:#ef4444;color:#ffffff}
                #ak-im-root .ak-im-settings-note{margin-top:12px;padding:12px 14px;border-radius:12px;background:#f8fafc;color:#6b7280;font-size:12px;line-height:1.6}
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
                        <button class="ak-im-topbar-title-wrap ak-im-chat-title-btn" type="button" aria-label="聊天标题" disabled><div class="ak-im-chat-title">内部聊天</div><div class="ak-im-chat-subtitle">选择一个会话开始单聊</div></button>
                        <button class="ak-im-nav-btn ak-im-chat-menu is-hidden" type="button" aria-label="群聊更多功能" disabled><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6" cy="12" r="1.7" fill="currentColor"></circle><circle cx="12" cy="12" r="1.7" fill="currentColor"></circle><circle cx="18" cy="12" r="1.7" fill="currentColor"></circle></svg></button>
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
            <div class="ak-im-progress-sheet" aria-hidden="true" inert>
                <div class="ak-im-progress-mask"></div>
                <div class="ak-im-progress-panel">
                    <div class="ak-im-progress-header"><div class="ak-im-progress-title">消息读进度</div><button class="ak-im-progress-close" type="button">关闭</button></div>
                    <div class="ak-im-progress-panel-body"></div>
                </div>
            </div>
	        <div class="ak-im-member-sheet" aria-hidden="true" inert>
	            <div class="ak-im-member-mask"></div>
	            <div class="ak-im-member-panel">
	                <div class="ak-im-member-header"><div class="ak-im-member-title">群成员</div><button class="ak-im-member-close" type="button">关闭</button></div>
	                <div class="ak-im-member-panel-body"></div>
	            </div>
	        </div>
	        <div class="ak-im-settings-sheet" aria-hidden="true" inert>
	            <div class="ak-im-settings-mask"></div>
	            <div class="ak-im-settings-panel">
	                <div class="ak-im-settings-header"><div class="ak-im-settings-title">群设置</div><button class="ak-im-settings-close" type="button">关闭</button></div>
	                <div class="ak-im-settings-panel-body"></div>
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
        progressPanelEl = root.querySelector('.ak-im-progress-sheet');
        progressPanelBodyEl = root.querySelector('.ak-im-progress-panel-body');
	    memberPanelEl = root.querySelector('.ak-im-member-sheet');
	    memberPanelBodyEl = root.querySelector('.ak-im-member-panel-body');
	    chatTitleBtnEl = root.querySelector('.ak-im-chat-title-btn');
	    settingsPanelEl = root.querySelector('.ak-im-settings-sheet');
	    settingsPanelBodyEl = root.querySelector('.ak-im-settings-panel-body');
	    chatMenuBtnEl = root.querySelector('.ak-im-chat-menu');
        root.querySelector('.ak-im-launcher').addEventListener('click', function() {
            state.open = true;
            if (state.view !== 'compose' && !state.activeConversationId) state.view = 'sessions';
            render();
        });
        root.querySelector('.ak-im-close').addEventListener('click', function() {
            closeActionSheet();
            closeReadProgressPanel();
	        closeMemberPanel();
	        closeSettingsPanel();
            state.open = false;
            state.view = 'sessions';
            render();
        });
        root.querySelector('.ak-im-back').addEventListener('click', function() {
            closeActionSheet();
            closeReadProgressPanel();
	        closeMemberPanel();
	        closeSettingsPanel();
            state.view = 'sessions';
            render();
        });
        chatMenuBtnEl.addEventListener('click', function() {
            const activeSession = getActiveSession();
            if (!isGroupSession(activeSession)) return;
            openGroupMenu(activeSession);
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
            if (state.actionSheetMode === 'group_menu') {
                closeActionSheet();
                openSettingsPanel(getActiveSession());
                return;
            }
            closeActionSheet();
        });
        actionSheetRecallBtn.addEventListener('click', function() {
            if (state.actionSheetMode === 'group_menu') {
                closeActionSheet();
                openMemberPanel(getActiveSession());
                return;
            }
            if (state.actionSheetMode === 'session') {
                if (!state.actionSheetConversationId || state.actionSheetSessionSystemPinned) return;
                requestSessionPin(state.actionSheetConversationId, !state.actionSheetSessionPinned);
                return;
            }
            if (!state.actionSheetCanRecall || !state.actionSheetMessageId) return;
            recallMessage(state.actionSheetMessageId, state.actionSheetConversationId, state.actionSheetDraftText);
        });
        progressPanelEl.querySelector('.ak-im-progress-mask').addEventListener('click', function() {
            closeReadProgressPanel();
        });
        progressPanelEl.querySelector('.ak-im-progress-close').addEventListener('click', function() {
            closeReadProgressPanel();
        });
	    memberPanelEl.querySelector('.ak-im-member-mask').addEventListener('click', function() {
	        closeMemberPanel();
	    });
	    memberPanelEl.querySelector('.ak-im-member-close').addEventListener('click', function() {
	        closeMemberPanel();
	    });
	    settingsPanelEl.querySelector('.ak-im-settings-mask').addEventListener('click', function() {
	        closeSettingsPanel();
	    });
	    settingsPanelEl.querySelector('.ak-im-settings-close').addEventListener('click', function() {
	        closeSettingsPanel();
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

    function isGroupSession(item) {
        return String(item && item.conversation_type || '').toLowerCase() === 'group';
    }

    function isSessionPinned(item) {
        return !!(item && (item.is_pinned || String(item.pin_type || '').toLowerCase() === 'manual' || String(item.pin_type || '').toLowerCase() === 'system'));
    }

    function isSessionSystemPinned(item) {
        return String(item && item.pin_type || '').toLowerCase() === 'system';
    }

    function getSessionDisplayName(item) {
        if (isGroupSession(item)) {
            return String(item && (item.conversation_title || item.peer_display_name || '内部群聊') || '内部群聊').trim();
        }
        return String(item && (item.peer_display_name || item.peer_username || '内部聊天') || '内部聊天').trim();
    }

    function getSessionSubtitle(item) {
        if (isGroupSession(item)) {
            const memberCount = Math.max(0, Number(item && item.member_count || 0) || 0);
            return memberCount > 0 ? ('群聊 · ' + memberCount + '人') : '群聊';
        }
        const peerUsername = String(item && item.peer_username || '').trim();
        return peerUsername ? ('账号：' + peerUsername) : '';
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

    function getMessageReadProgress(item) {
        return item && item.read_progress && typeof item.read_progress === 'object' ? item.read_progress : null;
    }

    function getProgressPercent(summary) {
        const percent = Number(summary && summary.progress_percent || 0) || 0;
        return Math.max(0, Math.min(100, Math.round(percent)));
    }

    function shouldShowReadProgress(item, activeSession) {
        const summary = getMessageReadProgress(item);
        if (!summary) return false;
        return !!activeSession;
    }

    function buildReadProgressButtonMarkup(item, activeSession) {
        const summary = getMessageReadProgress(item);
        if (!summary || !shouldShowReadProgress(item, activeSession)) return '';
        const percent = getProgressPercent(summary);
        const isComplete = !!summary.is_fully_read || percent >= 100;
        const label = isComplete ? '✓' : (percent + '%');
	    const radius = 9;
	    const circumference = 56.549;
	    const dashOffset = (circumference * (1 - (Math.max(0, Math.min(100, percent)) / 100))).toFixed(3);
	    const ariaLabel = isComplete ? '查看消息已读进度，已全部读完' : ('查看消息已读进度，当前 ' + percent + '%');
        return '<button class="ak-im-progress-btn' + (isComplete ? ' is-complete' : '') + '" type="button" aria-label="' + ariaLabel + '">' +
	            '<svg class="ak-im-progress-ring" viewBox="0 0 24 24" aria-hidden="true"><circle class="ak-im-progress-track" cx="12" cy="12" r="' + radius + '"></circle><circle class="ak-im-progress-value" cx="12" cy="12" r="' + radius + '" style="stroke-dasharray:' + circumference + ';stroke-dashoffset:' + dashOffset + '"></circle></svg>' +
	            '<span class="ak-im-progress-label">' + escapeHtml(label) + '</span>' +
        '</button>';
    }

    function updateActionSheetUI() {
        if (!actionSheetRecallBtn || !actionSheetCancelBtn) return;
        if (state.actionSheetMode === 'group_menu') {
            actionSheetRecallBtn.classList.remove('danger');
            actionSheetRecallBtn.textContent = '群成员';
            actionSheetRecallBtn.disabled = !state.actionSheetConversationId;
            actionSheetCancelBtn.textContent = '群设置';
            return;
        }
        if (state.actionSheetMode === 'session') {
            actionSheetRecallBtn.classList.remove('danger');
            if (state.actionSheetSessionSystemPinned) {
                actionSheetRecallBtn.textContent = '系统置顶';
                actionSheetRecallBtn.disabled = true;
            } else {
                actionSheetRecallBtn.textContent = state.actionSheetSessionPinned ? '取消置顶' : '置顶聊天';
                actionSheetRecallBtn.disabled = !state.actionSheetConversationId;
            }
            actionSheetCancelBtn.textContent = '取消';
            return;
        }
        actionSheetRecallBtn.classList.add('danger');
        actionSheetRecallBtn.textContent = '撤回';
        actionSheetRecallBtn.disabled = !state.actionSheetCanRecall;
        actionSheetCancelBtn.textContent = '取消';
    }

    function openActionSheet(messageItem) {
        if (!actionSheetEl) return;
        state.actionSheetMode = 'message';
        state.actionSheetOpen = true;
        state.actionSheetMessageId = Number(messageItem && messageItem.id || 0);
        state.actionSheetConversationId = Number(messageItem && messageItem.conversation_id || state.activeConversationId || 0);
        state.actionSheetCanRecall = canRecallMessage(messageItem);
        state.actionSheetDraftText = String(messageItem && (messageItem.content || messageItem.content_preview || '') || '');
        state.actionSheetSessionPinned = false;
        state.actionSheetSessionSystemPinned = false;
        updateActionSheetUI();
        actionSheetEl.removeAttribute('inert');
        actionSheetEl.classList.add('visible');
        actionSheetEl.setAttribute('aria-hidden', 'false');
    }

    function openGroupMenu(sessionItem) {
        if (!actionSheetEl || !sessionItem || !isGroupSession(sessionItem)) return;
        state.actionSheetMode = 'group_menu';
        state.actionSheetOpen = true;
        state.actionSheetMessageId = 0;
        state.actionSheetConversationId = Number(sessionItem.conversation_id || 0);
        state.actionSheetCanRecall = false;
        state.actionSheetDraftText = '';
        state.actionSheetSessionPinned = false;
        state.actionSheetSessionSystemPinned = false;
        updateActionSheetUI();
        actionSheetEl.removeAttribute('inert');
        actionSheetEl.classList.add('visible');
        actionSheetEl.setAttribute('aria-hidden', 'false');
    }

    function openSessionActionSheet(sessionItem) {
        if (!actionSheetEl || !sessionItem) return;
        state.actionSheetMode = 'session';
        state.actionSheetOpen = true;
        state.actionSheetMessageId = 0;
        state.actionSheetConversationId = Number(sessionItem.conversation_id || 0);
        state.actionSheetCanRecall = false;
        state.actionSheetDraftText = '';
        state.actionSheetSessionPinned = isSessionPinned(sessionItem);
        state.actionSheetSessionSystemPinned = isSessionSystemPinned(sessionItem);
        updateActionSheetUI();
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
        state.actionSheetMode = '';
        state.actionSheetSessionPinned = false;
        state.actionSheetSessionSystemPinned = false;
        updateActionSheetUI();
        actionSheetEl.classList.remove('visible');
        actionSheetEl.setAttribute('inert', '');
        actionSheetEl.setAttribute('aria-hidden', 'true');
    }

    function formatReadProgressMember(member) {
        const displayName = String(member && member.display_name || '').trim();
        const username = String(member && member.username || '').trim();
        if (displayName && username && displayName !== username) {
            return '<span class="ak-im-progress-member-name">' + escapeHtml(displayName) + '</span><span class="ak-im-progress-member-username">@' + escapeHtml(username) + '</span>';
        }
        return '<span class="ak-im-progress-member-name">' + escapeHtml(displayName || username || '未知成员') + '</span>';
    }

    function renderReadProgressPanel() {
        if (!progressPanelEl || !progressPanelBodyEl) return;
        const isOpen = !!state.readProgressOpen;
        progressPanelEl.classList.toggle('visible', isOpen);
        if (!isOpen) {
            const activeElement = document.activeElement;
            if (activeElement && progressPanelEl.contains(activeElement) && typeof activeElement.blur === 'function') {
                activeElement.blur();
            }
            progressPanelEl.setAttribute('inert', '');
            progressPanelEl.setAttribute('aria-hidden', 'true');
            progressPanelBodyEl.innerHTML = '';
            return;
        }
        progressPanelEl.removeAttribute('inert');
        progressPanelEl.setAttribute('aria-hidden', 'false');
        if (state.readProgressLoading) {
            progressPanelBodyEl.innerHTML = '<div class="ak-im-progress-loading">正在加载消息读进度...</div>';
            return;
        }
        if (state.readProgressError) {
            progressPanelBodyEl.innerHTML = '<div class="ak-im-progress-error">' + escapeHtml(state.readProgressError) + '</div>';
            return;
        }
        const detail = state.readProgressData;
        const summary = detail && detail.read_progress && typeof detail.read_progress === 'object' ? detail.read_progress : null;
        if (!detail || !summary) {
            progressPanelBodyEl.innerHTML = '<div class="ak-im-progress-empty">暂无可用的读进度数据</div>';
            return;
        }
        const unreadMembers = Array.isArray(detail.unread_members) ? detail.unread_members : [];
        const unreadList = unreadMembers.length ? unreadMembers.map(function(member) {
            return '<div class="ak-im-progress-member"><div>' + formatReadProgressMember(member) + '</div></div>';
        }).join('') : '<div class="ak-im-progress-empty">全部成员已读</div>';
        progressPanelBodyEl.innerHTML = '<div class="ak-im-progress-summary">' +
            '<div class="ak-im-progress-stat"><div class="ak-im-progress-stat-value">' + escapeHtml(String(getProgressPercent(summary))) + '%</div><div class="ak-im-progress-stat-label">已读进度</div></div>' +
            '<div class="ak-im-progress-stat"><div class="ak-im-progress-stat-value">' + escapeHtml(String(Number(summary.read_count || 0))) + '</div><div class="ak-im-progress-stat-label">已读人数</div></div>' +
            '<div class="ak-im-progress-stat"><div class="ak-im-progress-stat-value">' + escapeHtml(String(Number(summary.unread_count || 0))) + '</div><div class="ak-im-progress-stat-label">未读人数</div></div>' +
        '</div>' +
        '<div class="ak-im-progress-list"><h4 class="ak-im-progress-list-title">未读成员（共 ' + escapeHtml(String(Number(summary.unread_count || 0))) + ' 人）</h4>' + unreadList + '</div>';
    }

	function formatSessionMember(member) {
	    const displayName = String(member && member.display_name || '').trim();
	    const username = String(member && member.username || '').trim();
	    const role = String(member && member.role || '').trim().toLowerCase();
	    const roleLabel = role && role !== 'member' ? '<div class="ak-im-member-role">' + escapeHtml(role === 'owner' ? '群主' : role) + '</div>' : '';
	    return '<div class="ak-im-member-item"><div class="ak-im-member-avatar">' + escapeHtml(getAvatarText(displayName || username || '成员')) + '</div><div class="ak-im-member-body"><div class="ak-im-member-name">' + escapeHtml(displayName || username || '未知成员') + '</div><div class="ak-im-member-username">@' + escapeHtml(username || 'unknown') + '</div></div>' + roleLabel + '</div>';
	}

	function renderMemberPanel() {
	    if (!memberPanelEl || !memberPanelBodyEl) return;
	    const isOpen = !!state.memberPanelOpen;
	    memberPanelEl.classList.toggle('visible', isOpen);
	    if (!isOpen) {
	        const activeElement = document.activeElement;
	        if (activeElement && memberPanelEl.contains(activeElement) && typeof activeElement.blur === 'function') {
	            activeElement.blur();
	        }
	        memberPanelEl.setAttribute('inert', '');
	        memberPanelEl.setAttribute('aria-hidden', 'true');
	        memberPanelBodyEl.innerHTML = '';
	        return;
	    }
	    memberPanelEl.removeAttribute('inert');
	    memberPanelEl.setAttribute('aria-hidden', 'false');
	    if (state.memberPanelLoading) {
	        memberPanelBodyEl.innerHTML = '<div class="ak-im-member-loading">正在加载群成员...</div>';
	        return;
	    }
	    if (state.memberPanelError) {
	        memberPanelBodyEl.innerHTML = '<div class="ak-im-member-error">' + escapeHtml(state.memberPanelError) + '</div>';
	        return;
	    }
	    const detail = state.memberPanelData;
	    const members = Array.isArray(detail && detail.members) ? detail.members : [];
	    if (!detail) {
	        memberPanelBodyEl.innerHTML = '<div class="ak-im-member-empty">暂无可用的成员数据</div>';
	        return;
	    }
	    memberPanelBodyEl.innerHTML = '<div class="ak-im-member-summary">共 ' + escapeHtml(String(Number(detail.member_count || members.length || 0))) + ' 人</div><div class="ak-im-member-list">' + (members.length ? members.map(function(member) {
	        return formatSessionMember(member);
	    }).join('') : '<div class="ak-im-member-empty">当前群里还没有成员</div>') + '</div>';
	}

	function formatSettingsMemberChip(member) {
	    const displayName = String(member && member.display_name || '').trim() || String(member && member.username || '').trim() || '未知成员';
	    const username = String(member && member.username || '').trim();
	    const role = String(member && member.role || '').trim().toLowerCase();
	    const roleText = role === 'owner' ? '群主' : (role === 'admin' ? '管理员' : '成员');
	    return '<div class="ak-im-settings-chip"><span>' + escapeHtml(displayName + (username && displayName !== username ? ' @' + username : '')) + '</span><span class="ak-im-settings-chip-role">' + escapeHtml(roleText) + '</span></div>';
	}

	function renderSettingsPanel() {
	    if (!settingsPanelEl || !settingsPanelBodyEl) return;
	    const isOpen = !!state.groupSettingsOpen;
	    settingsPanelEl.classList.toggle('visible', isOpen);
	    if (!isOpen) {
	        const activeElement = document.activeElement;
	        if (activeElement && settingsPanelEl.contains(activeElement) && typeof activeElement.blur === 'function') {
	            activeElement.blur();
	        }
	        settingsPanelEl.setAttribute('inert', '');
	        settingsPanelEl.setAttribute('aria-hidden', 'true');
	        settingsPanelBodyEl.innerHTML = '';
	        return;
	    }
	    settingsPanelEl.removeAttribute('inert');
	    settingsPanelEl.setAttribute('aria-hidden', 'false');
	    if (state.groupSettingsLoading) {
	        settingsPanelBodyEl.innerHTML = '<div class="ak-im-settings-loading">正在加载群设置...</div>';
	        return;
	    }
	    if (state.groupSettingsError) {
	        settingsPanelBodyEl.innerHTML = '<div class="ak-im-settings-error">' + escapeHtml(state.groupSettingsError) + '</div>';
	        return;
	    }
	    const detail = state.groupSettingsData;
	    if (!detail) {
	        settingsPanelBodyEl.innerHTML = '<div class="ak-im-settings-empty">暂无可用的群设置信息</div>';
	        return;
	    }
	    const admins = Array.isArray(detail.admins) ? detail.admins : [];
	    const authors = Array.isArray(detail.message_authors) ? detail.message_authors : [];
	    const adminMarkup = admins.length ? admins.map(formatSettingsMemberChip).join('') : '<div class="ak-im-settings-empty">暂无群管理员</div>';
	    const authorMarkup = authors.length ? authors.map(formatSettingsMemberChip).join('') : '<div class="ak-im-settings-empty">暂无可删历史的消息发送者</div>';
	    const canManage = !!detail.can_manage;
	    settingsPanelBodyEl.innerHTML = '<div class="ak-im-settings-summary"><div class="ak-im-settings-summary-title">' + escapeHtml(String(detail.conversation_title || '群聊')) + '</div><div class="ak-im-settings-summary-meta">群聊 · ' + escapeHtml(String(Number(detail.member_count || 0))) + ' 人' + (detail.hidden_for_all ? ' · 已对全员隐藏' : '') + '</div></div>' +
	        '<div class="ak-im-settings-section"><div class="ak-im-settings-section-title">群管理员</div><div class="ak-im-settings-section-desc">管理员可以执行成员管理与全员生效操作。</div><div class="ak-im-settings-chip-list">' + adminMarkup + '</div></div>' +
	        '<div class="ak-im-settings-section"><div class="ak-im-settings-section-title">可删消息成员</div><div class="ak-im-settings-section-desc">这里显示当前有历史消息可清理的发送者。</div><div class="ak-im-settings-chip-list">' + authorMarkup + '</div></div>' +
	        (canManage ? '<div class="ak-im-settings-section"><div class="ak-im-settings-section-title">管理员操作</div><div class="ak-im-settings-section-desc">本版先使用系统弹窗输入账号，保证功能链路先打通。</div><div class="ak-im-settings-actions"><button class="ak-im-settings-btn" type="button" data-im-settings-action="add">添加成员</button><button class="ak-im-settings-btn secondary" type="button" data-im-settings-action="remove">移除成员</button><button class="ak-im-settings-btn secondary" type="button" data-im-settings-action="clear_member_history">删除指定成员消息</button><button class="ak-im-settings-btn danger" type="button" data-im-settings-action="clear_history">清空全群聊天记录</button><button class="ak-im-settings-btn danger" type="button" data-im-settings-action="hide_group">隐藏本群</button></div></div>' : '<div class="ak-im-settings-note">仅群管理员可执行添加成员、移除成员、删记录和隐藏群聊。</div>');
	    Array.prototype.forEach.call(settingsPanelBodyEl.querySelectorAll('[data-im-settings-action]'), function(button) {
	        button.addEventListener('click', function() {
	            handleSettingsAction(button.getAttribute('data-im-settings-action'));
	        });
	    });
	}

	function closeSettingsPanel() {
	    state.groupSettingsOpen = false;
	    state.groupSettingsLoading = false;
	    state.groupSettingsError = '';
	    state.groupSettingsConversationId = 0;
	    state.groupSettingsData = null;
	    renderSettingsPanel();
	}

	function loadGroupSettings(conversationId) {
	    const targetConversationId = Number(conversationId || 0);
	    if (!targetConversationId) return Promise.resolve(null);
	    state.groupSettingsLoading = true;
	    state.groupSettingsError = '';
	    state.groupSettingsConversationId = targetConversationId;
	    renderSettingsPanel();
	    return request(`${HTTP_ROOT}/sessions/settings?conversation_id=${encodeURIComponent(targetConversationId)}`).then(function(data) {
	        if (Number(state.groupSettingsConversationId || 0) !== targetConversationId) return null;
	        state.groupSettingsLoading = false;
	        state.groupSettingsData = data && data.item ? data.item : null;
	        renderSettingsPanel();
	        return state.groupSettingsData;
	    }).catch(function(error) {
	        if (Number(state.groupSettingsConversationId || 0) !== targetConversationId) return null;
	        state.groupSettingsLoading = false;
	        state.groupSettingsError = error && error.message ? error.message : '读取群设置失败';
	        renderSettingsPanel();
	        return null;
	    });
	}

	function openSettingsPanel(sessionItem) {
	    const conversationId = Number(sessionItem && sessionItem.conversation_id || state.activeConversationId || 0);
	    if (!conversationId || !isGroupSession(sessionItem || getActiveSession())) return;
	    closeReadProgressPanel();
	    closeMemberPanel();
	    state.groupSettingsOpen = true;
	    state.groupSettingsData = null;
	    renderSettingsPanel();
	    loadGroupSettings(conversationId);
	}

	function normalizePromptUsernames(value) {
	    return Array.from(new Set(String(value || '').split(/[\s,，;；\n\r]+/).map(function(item) {
	        return String(item || '').trim().toLowerCase();
	    }).filter(Boolean)));
	}

	function refreshAfterSettingsAction(conversationId) {
	    return loadSessions().then(function() {
	        if (Number(state.activeConversationId || 0) === Number(conversationId || 0)) {
	            return loadMessages(conversationId);
	        }
	        return null;
	    }).then(function() {
	        if (state.groupSettingsOpen && Number(state.groupSettingsConversationId || 0) === Number(conversationId || 0)) {
	            return loadGroupSettings(conversationId);
	        }
	        return null;
	    });
	}

	function handleSettingsAction(action) {
	    const conversationId = Number(state.groupSettingsConversationId || 0);
	    const detail = state.groupSettingsData;
	    if (!conversationId || !detail || !detail.can_manage) return;
	    if (action === 'add') {
	        const raw = window.prompt('输入要添加的账号，多个账号可用空格、逗号或换行分隔', '');
	        const usernames = normalizePromptUsernames(raw);
	        if (!usernames.length) return;
	        request(`${HTTP_ROOT}/sessions/members/add`, {
	            method: 'POST',
	            body: JSON.stringify({ conversation_id: conversationId, usernames: usernames })
	        }).then(function() {
	            return refreshAfterSettingsAction(conversationId);
	        }).catch(function(error) {
	            window.alert(error && error.message ? error.message : '添加成员失败');
	        });
	        return;
	    }
	    if (action === 'remove') {
	        const raw = window.prompt('输入要移除的成员账号，多个账号可用空格、逗号或换行分隔', '');
	        const usernames = normalizePromptUsernames(raw);
	        if (!usernames.length) return;
	        if (!window.confirm('确认移除这些成员吗？')) return;
	        request(`${HTTP_ROOT}/sessions/members/remove`, {
	            method: 'POST',
	            body: JSON.stringify({ conversation_id: conversationId, usernames: usernames })
	        }).then(function() {
	            return refreshAfterSettingsAction(conversationId);
	        }).catch(function(error) {
	            window.alert(error && error.message ? error.message : '移除成员失败');
	        });
	        return;
	    }
	    if (action === 'clear_member_history') {
	        const authorHint = (Array.isArray(detail.message_authors) ? detail.message_authors : []).map(function(item) {
	            return String(item && item.username || '').trim().toLowerCase();
	        }).filter(Boolean).join(', ');
	        const raw = window.prompt(authorHint ? ('输入要删除消息的成员账号\n可选：' + authorHint) : '输入要删除消息的成员账号', '');
	        const username = normalizePromptUsernames(raw)[0] || '';
	        if (!username) return;
	        if (!window.confirm('确认删除该成员在本群发送过的全部消息吗？')) return;
	        request(`${HTTP_ROOT}/sessions/history/clear-member`, {
	            method: 'POST',
	            body: JSON.stringify({ conversation_id: conversationId, username: username })
	        }).then(function() {
	            return refreshAfterSettingsAction(conversationId);
	        }).catch(function(error) {
	            window.alert(error && error.message ? error.message : '删除指定成员消息失败');
	        });
	        return;
	    }
	    if (action === 'clear_history') {
	        if (!window.confirm('确认清空本群全部聊天记录吗？此操作会对所有成员立即生效。')) return;
	        request(`${HTTP_ROOT}/sessions/history/clear`, {
	            method: 'POST',
	            body: JSON.stringify({ conversation_id: conversationId })
	        }).then(function() {
	            return refreshAfterSettingsAction(conversationId);
	        }).catch(function(error) {
	            window.alert(error && error.message ? error.message : '清空全群聊天记录失败');
	        });
	        return;
	    }
	    if (action === 'hide_group') {
	        if (!window.confirm('确认对所有成员隐藏本群吗？')) return;
	        request(`${HTTP_ROOT}/sessions/hide`, {
	            method: 'POST',
	            body: JSON.stringify({ conversation_id: conversationId })
	        }).then(function() {
	            closeSettingsPanel();
	            return loadSessions();
	        }).catch(function(error) {
	            window.alert(error && error.message ? error.message : '隐藏本群失败');
	        });
	    }
	}

    function closeReadProgressPanel() {
        state.readProgressOpen = false;
        state.readProgressLoading = false;
        state.readProgressError = '';
        state.readProgressMessageId = 0;
        state.readProgressData = null;
        renderReadProgressPanel();
    }

    function openReadProgressPanel(messageItem) {
        const messageId = Number(messageItem && messageItem.id || 0);
        if (!messageId) return;
	    closeMemberPanel();
	    closeSettingsPanel();
        state.readProgressOpen = true;
        state.readProgressLoading = true;
        state.readProgressError = '';
        state.readProgressMessageId = messageId;
        state.readProgressData = null;
        renderReadProgressPanel();
        request(`${HTTP_ROOT}/messages/read_progress?message_id=${encodeURIComponent(messageId)}`).then(function(data) {
            if (Number(state.readProgressMessageId || 0) !== messageId) return;
            state.readProgressLoading = false;
            state.readProgressData = data && data.item ? data.item : null;
            renderReadProgressPanel();
        }).catch(function(error) {
            if (Number(state.readProgressMessageId || 0) !== messageId) return;
            state.readProgressLoading = false;
            state.readProgressError = error && error.message ? error.message : '读取消息读进度失败';
            renderReadProgressPanel();
        });
    }

	function closeMemberPanel() {
	    state.memberPanelOpen = false;
	    state.memberPanelLoading = false;
	    state.memberPanelError = '';
	    state.memberPanelConversationId = 0;
	    state.memberPanelData = null;
	    renderMemberPanel();
	}

	function openMemberPanel(sessionItem) {
	    const conversationId = Number(sessionItem && sessionItem.conversation_id || state.activeConversationId || 0);
	    if (!conversationId || !isGroupSession(sessionItem || getActiveSession())) return;
	    closeActionSheet();
	    closeReadProgressPanel();
	    closeSettingsPanel();
	    state.memberPanelOpen = true;
	    state.memberPanelLoading = true;
	    state.memberPanelError = '';
	    state.memberPanelConversationId = conversationId;
	    state.memberPanelData = null;
	    renderMemberPanel();
	    request(`${HTTP_ROOT}/sessions/members?conversation_id=${encodeURIComponent(conversationId)}`).then(function(data) {
	        if (Number(state.memberPanelConversationId || 0) !== conversationId) return;
	        state.memberPanelLoading = false;
	        state.memberPanelData = data && data.item ? data.item : null;
	        renderMemberPanel();
	    }).catch(function(error) {
	        if (Number(state.memberPanelConversationId || 0) !== conversationId) return;
	        state.memberPanelLoading = false;
	        state.memberPanelError = error && error.message ? error.message : '读取群成员失败';
	        renderMemberPanel();
	    });
	}

    function requestSessionPin(conversationId, pinned) {
        const targetConversationId = Number(conversationId || 0);
        if (!targetConversationId) return;
        closeActionSheet();
        request(`${HTTP_ROOT}/sessions/pin`, {
            method: 'POST',
            body: JSON.stringify({ conversation_id: targetConversationId, pinned: !!pinned })
        }).then(function() {
            return loadSessions();
        }).catch(function(error) {
            window.alert(error && error.message ? error.message : '更新置顶状态失败');
        });
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
        const searchPill = root.querySelector('.ak-im-search-pill');
        if (searchPill) searchPill.textContent = state.sessions.length ? '长按会话可置顶，点击进入聊天' : '点击右上角发起单聊';
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
                node.className = 'ak-im-session-item' + (item.conversation_id === state.activeConversationId ? ' ak-active' : '') + (isSessionPinned(item) ? ' is-pinned' : '');
                const unreadCount = getUnreadCount(item);
                const subtitle = getSessionSubtitle(item);
                const previewText = subtitle ? (subtitle + ' · ' + getSessionPreview(item)) : getSessionPreview(item);
                const pinText = isSessionSystemPinned(item) ? '群置顶' : '置顶';
                node.innerHTML = '<div class="ak-im-session-avatar">' + escapeHtml(getAvatarText(getSessionDisplayName(item))) + '</div>' +
                    '<div class="ak-im-session-body">' +
                        '<div class="ak-im-session-title"><span class="ak-im-session-title-text">' + escapeHtml(getSessionDisplayName(item)) + '</span><span class="ak-im-session-pin-tag' + (isSessionPinned(item) ? ' visible' : '') + (isSessionSystemPinned(item) ? ' is-system' : '') + '">' + escapeHtml(pinText) + '</span></div>' +
                        '<div class="ak-im-session-time">' + escapeHtml(formatSessionTime(item.last_message_at || item.updated_at || item.created_at)) + '</div>' +
                        '<div class="ak-im-session-preview">' + escapeHtml(previewText) + '</div>' +
                        '<div class="ak-im-session-unread' + (unreadCount > 0 ? ' visible' : '') + '">' + escapeHtml(unreadCount > 99 ? '99+' : String(unreadCount || '')) + '</div>' +
                    '</div>';
                let pressTimer = null;
                let didOpenActionSheet = false;
                const startPress = function() {
                    if (pressTimer) clearTimeout(pressTimer);
                    pressTimer = setTimeout(function() {
                        didOpenActionSheet = true;
                        openSessionActionSheet(item);
                    }, 420);
                };
                const cancelPress = function() {
                    if (pressTimer) {
                        clearTimeout(pressTimer);
                        pressTimer = null;
                    }
                };
                node.addEventListener('click', function() {
                    if (didOpenActionSheet) {
                        didOpenActionSheet = false;
                        return;
                    }
                    closeActionSheet();
                    closeReadProgressPanel();
	                closeMemberPanel();
                    state.activeConversationId = item.conversation_id;
                    state.view = 'chat';
                    state.activeMessages = [];
                    loadMessages(item.conversation_id);
                    render();
                });
                node.addEventListener('pointerdown', startPress);
                node.addEventListener('pointerup', cancelPress);
                node.addEventListener('pointercancel', cancelPress);
                node.addEventListener('pointerleave', cancelPress);
                node.addEventListener('contextmenu', function(event) {
                    event.preventDefault();
                    didOpenActionSheet = true;
                    openSessionActionSheet(item);
                });
                sessionList.appendChild(node);
            });
        }
        syncComposerState();
        syncInputHeight();
        renderMessages();
        renderReadProgressPanel();
	    renderMemberPanel();
	    renderSettingsPanel();
        renderComposeView();
        if (showChat) markRead(state.activeConversationId);
        if (state.open && state.view === 'compose') focusComposeInput();
    }

    function renderMessages() {
        const headerTitle = root.querySelector('.ak-im-chat-title');
        const headerSubtitle = root.querySelector('.ak-im-chat-subtitle');
        const activeSession = getActiveSession();
	    const subtitleText = activeSession ? getSessionSubtitle(activeSession) : '';
        headerTitle.textContent = activeSession ? getSessionDisplayName(activeSession) : '内部聊天';
	    headerSubtitle.textContent = activeSession ? subtitleText : '';
	    if (chatTitleBtnEl) {
	        chatTitleBtnEl.disabled = true;
	        chatTitleBtnEl.classList.remove('is-clickable');
	        chatTitleBtnEl.setAttribute('aria-label', '聊天标题');
	    }
	    if (chatMenuBtnEl) {
	        const canOpenMenu = !!activeSession && isGroupSession(activeSession);
	        chatMenuBtnEl.disabled = !canOpenMenu;
	        chatMenuBtnEl.classList.toggle('is-hidden', !canOpenMenu);
	    }
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
            const summary = getMessageReadProgress(item);
            const displayName = isSelf ? (state.displayName || state.username || '我') : (isGroupSession(activeSession) ? (item.sender_username || '群成员') : (activeSession ? getSessionDisplayName(activeSession) : (item.sender_username || '对方')));
            const metaText = summary && Number(summary.total_count || 0) > 0 ? ('已读 ' + Number(summary.read_count || 0) + '/' + Number(summary.total_count || 0)) : ((isSelf && item.read) ? '对方已读' : '');
            const senderText = !isSelf && isGroupSession(activeSession) ? String(item.sender_username || '').trim() : '';
	        const progressMarkup = buildReadProgressButtonMarkup(item, activeSession);
	        const footerMarkup = (metaText || progressMarkup) ? '<div class="ak-im-message-footer">' +
	            (metaText ? '<div class="ak-im-meta">' + escapeHtml(metaText) + '</div>' : '') +
	            progressMarkup +
	        '</div>' : '';
            wrapper.innerHTML = '<div class="ak-im-time-divider">' + escapeHtml(formatTime(item.sent_at)) + '</div>' +
                '<div class="ak-im-message-row ' + (isSelf ? 'ak-self' : 'ak-peer') + '">' +
                    '<div class="ak-im-avatar">' + escapeHtml(getAvatarText(displayName)) + '</div>' +
                    '<div class="ak-im-message-main">' +
                        (senderText ? '<div class="ak-im-message-sender">' + escapeHtml(senderText) + '</div>' : '') +
                        '<div class="ak-im-bubble">' + escapeHtml(item.content || item.content_preview || '') + '</div>' +
	                        footerMarkup +
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
            const progressBtn = wrapper.querySelector('.ak-im-progress-btn');
            if (progressBtn) {
                progressBtn.addEventListener('click', function(event) {
                    event.preventDefault();
                    event.stopPropagation();
                    openReadProgressPanel(item);
                });
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
            if (Number(state.activeConversationId || 0) > 0) {
                const stillExists = state.sessions.some(function(item) {
                    return Number(item && item.conversation_id || 0) === Number(state.activeConversationId || 0);
                });
                if (!stillExists) {
                    state.activeConversationId = 0;
                    state.activeMessages = [];
                    closeReadProgressPanel();
	                closeMemberPanel();
	                closeSettingsPanel();
                    if (state.view === 'chat') state.view = 'sessions';
                }
            }
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
                        return;
                    }
                    if (data.type === 'im.session.updated') {
                        const payload = data.payload || null;
                        loadSessions();
                        if (payload && Number(payload.conversation_id || 0) > 0) {
                            const updatedConversationId = Number(payload.conversation_id || 0);
                            if (updatedConversationId === Number(state.activeConversationId || 0)) {
                                loadMessages(state.activeConversationId);
                            }
                            if (state.memberPanelOpen && Number(state.memberPanelConversationId || 0) === updatedConversationId) {
                                state.memberPanelLoading = true;
                                state.memberPanelError = '';
                                renderMemberPanel();
                                request(`${HTTP_ROOT}/sessions/members?conversation_id=${encodeURIComponent(updatedConversationId)}`).then(function(membersData) {
                                    if (!state.memberPanelOpen || Number(state.memberPanelConversationId || 0) !== updatedConversationId) return;
                                    state.memberPanelLoading = false;
                                    state.memberPanelData = membersData && membersData.item ? membersData.item : null;
                                    renderMemberPanel();
                                }).catch(function(error) {
                                    if (!state.memberPanelOpen || Number(state.memberPanelConversationId || 0) !== updatedConversationId) return;
                                    state.memberPanelLoading = false;
                                    state.memberPanelError = error && error.message ? error.message : '读取群成员失败';
                                    renderMemberPanel();
                                });
                            }
                            if (state.groupSettingsOpen && Number(state.groupSettingsConversationId || 0) === updatedConversationId) {
                                loadGroupSettings(updatedConversationId);
                            }
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
        close: function() { closeActionSheet(); closeReadProgressPanel(); state.open = false; state.view = 'sessions'; render(); },
        reloadSessions: loadSessions
    };
})();
