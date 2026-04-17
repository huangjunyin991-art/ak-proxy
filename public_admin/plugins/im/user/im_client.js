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
        homeTab: 'chats',
        contacts: [],
        contactsLoaded: false,
        contactsLoading: false,
        contactsError: '',
        profile: null,
        profileLoaded: false,
        profileLoading: false,
        profileError: '',
        profileRefreshing: false,
        profileSaving: false,
        profileSaveError: '',
        profileAvatarHistory: [],
        profileAvatarHistoryLoaded: false,
        profileAvatarHistoryLoading: false,
        profileAvatarHistoryError: '',
        profileDraftNickname: '',
        profileDraftGender: 'unknown',
        profileDraftDirty: false,
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
        groupSettingsData: null,
        groupSettingsMembersExpanded: false,
        memberActionOpen: false,
        memberActionMode: '',
        memberActionConversationId: 0,
        memberActionKeyword: '',
        memberActionSelectedUsernames: [],
        memberActionSubmitting: false,
        memberActionError: '',
        dialogOpen: false,
        dialogTitle: '',
        dialogMessage: '',
        dialogConfirmText: '',
        dialogCancelText: '',
        dialogDanger: false,
        dialogShowCancel: true,
        dialogAction: '',
        dialogSubmitting: false,
        dialogPayload: null
    };

    let root = null;
    let panel = null;
    let sessionList = null;
    let contactsListEl = null;
    let profilePageEl = null;
    let profileSubpageBodyEl = null;
    let profileSubpageTitleEl = null;
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
    let groupInfoTitleEl = null;
    let memberActionPageEl = null;
    let memberActionBodyEl = null;
    let memberActionSearchEl = null;
    let memberActionTitleEl = null;
    let memberActionSubmitBtnEl = null;
    let dialogEl = null;
    let dialogTitleEl = null;
    let dialogMessageEl = null;
    let dialogCancelBtnEl = null;
    let dialogConfirmBtnEl = null;
    let sessionTopbarTitleEl = null;
    let sessionNewBtnEl = null;

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
                #ak-im-root.ak-view-group-info .ak-im-group-info-screen{display:flex}
                #ak-im-root.ak-view-member-action .ak-im-member-action-screen{display:flex}
                #ak-im-root.ak-view-profile-subpage .ak-im-profile-subpage-screen{display:flex}
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
                #ak-im-root .ak-im-nav-btn.is-hidden{opacity:0;pointer-events:none}
                #ak-im-root .ak-im-nav-btn svg{width:20px;height:20px;stroke:currentColor}
                #ak-im-root .ak-im-nav-btn.ak-im-new{justify-self:end;font-size:15px;color:#1f2937}
                #ak-im-root .ak-im-session-page{flex:1;display:flex;flex-direction:column;min-height:0;background:#f7f7f7}
                #ak-im-root .ak-im-home-panels{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
                #ak-im-root .ak-im-home-panel{display:none;flex:1;min-height:0;flex-direction:column}
                #ak-im-root .ak-im-home-panel.is-active{display:flex}
                #ak-im-root .ak-im-search-bar{padding:8px 12px;background:#ededed;border-bottom:1px solid rgba(15,23,42,.04)}
                #ak-im-root .ak-im-search-pill{height:36px;border-radius:12px;background:#ffffff;color:#6b7280;display:flex;align-items:center;justify-content:center;font-size:12px}
                #ak-im-root .ak-im-session-list{flex:1;overflow:auto;background:#ffffff}
                #ak-im-root .ak-im-session-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border:none;border-bottom:1px solid rgba(15,23,42,.05);background:#fff;cursor:pointer;position:relative}
                #ak-im-root .ak-im-session-item.ak-active{background:#f0fdf4}
                #ak-im-root .ak-im-session-item.is-pinned{background:#f7fcf7}
                #ak-im-root .ak-im-session-avatar{width:48px;height:48px;border-radius:14px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-avatar-photo{width:100%;height:100%;display:block;object-fit:cover}
                #ak-im-root .ak-im-session-avatar,#ak-im-root .ak-im-avatar,#ak-im-root .ak-im-member-avatar,#ak-im-root .ak-im-member-action-avatar,#ak-im-root .ak-im-contact-avatar,#ak-im-root .ak-im-profile-avatar,#ak-im-root .ak-im-avatar-cell{overflow:hidden}
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
                #ak-im-root .ak-im-contacts-list{flex:1;overflow:auto;background:#ffffff}
                #ak-im-root .ak-im-contact-item{width:100%;border:none;background:#ffffff;padding:13px 16px;display:flex;align-items:center;gap:12px;text-align:left;cursor:pointer}
                #ak-im-root .ak-im-contact-item + .ak-im-contact-item{border-top:1px solid rgba(15,23,42,.05)}
                #ak-im-root .ak-im-contact-avatar{width:46px;height:46px;border-radius:14px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-contact-body{min-width:0;flex:1}
                #ak-im-root .ak-im-contact-name{font-size:15px;font-weight:600;color:#111827;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-contact-meta{margin-top:3px;font-size:12px;color:#9ca3af;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-profile-page{flex:1;overflow:auto;padding:14px 12px calc(18px + env(safe-area-inset-bottom, 0px));background:#f7f7f7}
                #ak-im-root .ak-im-profile-card{background:#ffffff;border-radius:22px;padding:22px 18px 18px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                #ak-im-root .ak-im-profile-head{display:flex;flex-direction:column;align-items:center;text-align:center}
                #ak-im-root .ak-im-profile-avatar{width:88px;height:88px;border-radius:24px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;box-shadow:0 10px 22px rgba(7,193,96,.14)}
                #ak-im-root .ak-im-profile-name{margin-top:14px;font-size:20px;font-weight:700;color:#111827;line-height:1.3}
                #ak-im-root .ak-im-profile-username{margin-top:6px;font-size:13px;color:#9ca3af;line-height:1.4}
                #ak-im-root .ak-im-profile-meta{margin-top:8px;font-size:13px;color:#6b7280;line-height:1.5}
                #ak-im-root .ak-im-profile-entry-list{margin-top:12px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                #ak-im-root .ak-im-profile-entry{width:100%;border:none;background:#ffffff;padding:0 16px;min-height:58px;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;cursor:pointer;box-sizing:border-box}
                #ak-im-root .ak-im-profile-entry + .ak-im-profile-entry{border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-profile-entry-main{min-width:0;flex:1}
                #ak-im-root .ak-im-profile-entry-label{font-size:16px;font-weight:500;color:#111827;line-height:1.5}
                #ak-im-root .ak-im-profile-entry-meta{margin-top:4px;font-size:12px;color:#9ca3af;line-height:1.5}
                #ak-im-root .ak-im-profile-entry-arrow{color:#c7cdd8;font-size:20px;line-height:1;flex:0 0 auto}
                #ak-im-root .ak-im-profile-subpage-screen{background:#ededed}
                #ak-im-root .ak-im-profile-subpage-page{flex:1;overflow:auto;padding:12px 12px calc(16px + env(safe-area-inset-bottom, 0px));background:#f7f7f7}
                #ak-im-root .ak-im-profile-panel{background:#ffffff;border-radius:18px;padding:16px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                #ak-im-root .ak-im-profile-panel + .ak-im-profile-panel{margin-top:12px}
                #ak-im-root .ak-im-profile-subtitle{margin-top:8px;font-size:13px;color:#6b7280;line-height:1.6}
                #ak-im-root .ak-im-profile-primary-btn{margin-top:16px;width:100%;height:46px;border:none;border-radius:14px;background:#07c160;color:#ffffff;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 10px 22px rgba(7,193,96,.18)}
                #ak-im-root .ak-im-profile-primary-btn:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
                #ak-im-root .ak-im-profile-history-grid{margin-top:14px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
                #ak-im-root .ak-im-profile-history-item{background:#f8fafc;border-radius:16px;padding:12px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
                #ak-im-root .ak-im-profile-history-avatar{width:80px;height:80px;border-radius:22px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;overflow:hidden}
                #ak-im-root .ak-im-profile-history-time{font-size:12px;color:#6b7280;line-height:1.5}
                #ak-im-root .ak-im-profile-form{display:flex;flex-direction:column;gap:14px}
                #ak-im-root .ak-im-profile-form-group{display:flex;flex-direction:column}
                #ak-im-root .ak-im-profile-form-label{font-size:13px;color:#6b7280;line-height:1.5}
                #ak-im-root .ak-im-profile-form-input,#ak-im-root .ak-im-profile-form-select{margin-top:8px;width:100%;height:46px;border:none;border-radius:12px;background:#f3f4f6;padding:0 14px;font-size:15px;color:#111827;outline:none;box-sizing:border-box}
                #ak-im-root .ak-im-profile-form-input:focus,#ak-im-root .ak-im-profile-form-select:focus{background:#ffffff;box-shadow:0 0 0 2px rgba(7,193,96,.14) inset}
                #ak-im-root .ak-im-profile-form-help{margin-top:6px;font-size:12px;color:#9ca3af;line-height:1.6}
                #ak-im-root .ak-im-profile-placeholder{padding:28px 14px;color:#6b7280;font-size:13px;line-height:1.7;text-align:center}
                #ak-im-root .ak-im-profile-error{margin-bottom:12px;padding:11px 12px;border-radius:14px;background:rgba(239,68,68,.08);color:#dc2626;font-size:13px;line-height:1.6}
                #ak-im-root .ak-im-home-tabbar{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:8px 8px calc(8px + env(safe-area-inset-bottom, 0px));background:#ffffff;border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-home-tab-btn{border:none;background:transparent;min-height:56px;border-radius:14px;color:#6b7280;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer}
                #ak-im-root .ak-im-home-tab-btn svg{width:22px;height:22px;stroke:currentColor;fill:none}
                #ak-im-root .ak-im-home-tab-btn span{font-size:11px;line-height:1.2}
                #ak-im-root .ak-im-home-tab-btn.is-active{color:#07c160;background:rgba(7,193,96,.06)}
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
                #ak-im-root .ak-im-member-panel-body{overflow:auto;padding:14px 16px calc(14px + env(safe-area-inset-bottom, 0px))}
                #ak-im-root .ak-im-member-summary{padding:0 0 10px;font-size:13px;color:#6b7280;line-height:1.6}
                #ak-im-root .ak-im-member-list{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;padding:12px 0 0}
                #ak-im-root .ak-im-member-item{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:8px;padding:10px 6px 8px;border:none;border-radius:14px;background:#f8fafc;min-height:96px}
                #ak-im-root .ak-im-member-item.is-add{border:1px dashed rgba(79,70,229,.32);background:#ffffff;cursor:pointer}
                #ak-im-root .ak-im-member-item.is-add:active{opacity:.78}
                #ak-im-root .ak-im-member-avatar{width:46px;height:46px;border-radius:16px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-member-body{min-width:0;width:100%;text-align:center}
                #ak-im-root .ak-im-member-name{font-size:12px;color:#111827;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-member-username{display:none}
                #ak-im-root .ak-im-member-role{position:absolute;top:6px;right:6px;margin:0;height:18px;padding:0 6px;border-radius:999px;background:rgba(7,193,96,.12);color:#16a34a;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
                #ak-im-root .ak-im-member-loading,#ak-im-root .ak-im-member-error,#ak-im-root .ak-im-member-empty{padding:18px 16px;color:#6b7280;font-size:13px;line-height:1.6;text-align:center}
                #ak-im-root .ak-im-member-error{color:#ef4444}
                #ak-im-root .ak-im-chat-menu.is-hidden{opacity:0;pointer-events:none}
                #ak-im-root .ak-im-chat-menu svg{width:20px;height:20px;stroke:currentColor}
                #ak-im-root .ak-im-group-info-screen{background:#ededed}
                #ak-im-root .ak-im-group-info-page{flex:1;overflow:auto;background:#f7f7f7;padding:0 0 calc(16px + env(safe-area-inset-bottom, 0px))}
                #ak-im-root .ak-im-group-info-side{width:34px;height:34px;justify-self:end}
                #ak-im-root .ak-im-group-info-loading,#ak-im-root .ak-im-group-info-error,#ak-im-root .ak-im-group-info-empty{padding:28px 18px;color:#6b7280;font-size:13px;line-height:1.7;text-align:center}
                #ak-im-root .ak-im-group-info-error{color:#ef4444}
                #ak-im-root .ak-im-group-info-members{margin-top:12px;background:#ffffff;padding:18px 14px 12px}
                #ak-im-root .ak-im-group-info-members .ak-im-member-list{padding:0;gap:16px 10px}
                #ak-im-root .ak-im-group-info-members .ak-im-member-item{min-height:0;padding:0;border-radius:0;background:transparent}
                #ak-im-root .ak-im-group-info-members .ak-im-member-avatar{width:54px;height:54px;border-radius:14px;font-size:15px}
                #ak-im-root .ak-im-group-info-members .ak-im-member-item.is-add .ak-im-member-avatar{background:#ffffff;color:#9ca3af;border:1.5px dashed rgba(156,163,175,.65)}
                #ak-im-root .ak-im-group-info-members .ak-im-member-item.is-add{border:none}
                #ak-im-root .ak-im-group-info-members .ak-im-member-name{margin-top:2px;font-size:12px;color:#6b7280}
                #ak-im-root .ak-im-group-info-members .ak-im-member-role{top:-4px;right:4px}
                #ak-im-root .ak-im-group-info-more{width:100%;margin-top:16px;border:none;background:transparent;color:#6b7280;font-size:14px;line-height:1.5;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer}
                #ak-im-root .ak-im-group-info-more:active{opacity:.7}
                #ak-im-root .ak-im-group-info-section{margin-top:12px;background:#ffffff}
                #ak-im-root .ak-im-group-info-cell{width:100%;border:none;background:#ffffff;padding:0 16px;min-height:56px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-sizing:border-box}
                #ak-im-root .ak-im-group-info-cell + .ak-im-group-info-cell{border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-group-info-cell.is-action{cursor:pointer}
                #ak-im-root .ak-im-group-info-cell.is-danger .ak-im-group-info-cell-label{color:#ef4444}
                #ak-im-root .ak-im-group-info-cell-main{min-width:0;flex:1;display:flex;align-items:center;justify-content:space-between;gap:12px}
                #ak-im-root .ak-im-group-info-cell-label{font-size:16px;color:#111827;line-height:1.5;text-align:left}
                #ak-im-root .ak-im-group-info-cell-value{min-width:0;max-width:70%;font-size:14px;color:#9ca3af;line-height:1.5;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-group-info-cell-arrow{color:#c7cdd8;font-size:20px;line-height:1;flex:0 0 auto}
                #ak-im-root .ak-im-avatar-mosaic{width:100%;height:100%;background:#e5e7eb;padding:1px;box-sizing:border-box;border-radius:inherit;overflow:hidden}
                #ak-im-root .ak-im-avatar-mosaic.is-grid{display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);gap:1px}
                #ak-im-root .ak-im-avatar-mosaic.is-stack{display:flex;flex-direction:column-reverse;justify-content:flex-start;gap:1px}
                #ak-im-root .ak-im-avatar-mosaic.is-stack .ak-im-avatar-row{display:flex;justify-content:center;align-items:stretch;gap:1px;flex:1 1 0;min-height:0}
                #ak-im-root .ak-im-avatar-mosaic.is-stack .ak-im-avatar-cell{flex:0 0 calc((100% - 2px) / 3);max-width:calc((100% - 2px) / 3)}
                #ak-im-root .ak-im-avatar-mosaic .ak-im-avatar-cell{min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;font-size:9px;font-weight:700;line-height:1;overflow:hidden;padding:0}
                #ak-im-root .ak-im-avatar-mosaic.is-single{display:flex}
                #ak-im-root .ak-im-avatar-mosaic.is-single .ak-im-avatar-cell{font-size:16px;flex:1 1 auto}
                #ak-im-root .ak-im-group-info-hero{background:#ffffff;padding:20px 16px 16px;display:flex;flex-direction:column;align-items:center;gap:8px}
                #ak-im-root .ak-im-group-info-hero-avatar{width:72px;height:72px;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.06)}
                #ak-im-root .ak-im-group-info-hero-avatar .ak-im-avatar-mosaic .ak-im-avatar-cell{font-size:11px}
                #ak-im-root .ak-im-group-info-hero-avatar .ak-im-avatar-mosaic.is-single .ak-im-avatar-cell{font-size:22px}
                #ak-im-root .ak-im-group-info-hero-title{font-size:17px;font-weight:700;color:#111827;line-height:1.3;text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 12px}
                #ak-im-root .ak-im-group-info-hero-subtitle{font-size:12px;color:#6b7280;line-height:1.4}
                #ak-im-root .ak-im-session-avatar.is-mosaic{padding:0;background:transparent}
                #ak-im-root .ak-im-session-avatar.is-mosaic .ak-im-avatar-mosaic .ak-im-avatar-cell{font-size:9px}
                #ak-im-root .ak-im-member-action-screen{background:#ededed}
                #ak-im-root .ak-im-member-action-page{position:relative;flex:1;display:flex;flex-direction:column;min-height:0;background:#f7f7f7}
                #ak-im-root .ak-im-member-action-search{padding:10px 12px;background:#ededed;border-bottom:1px solid rgba(15,23,42,.04)}
                #ak-im-root .ak-im-member-action-search-input{width:100%;height:36px;border:none;border-radius:12px;background:#ffffff;padding:0 14px;font-size:14px;color:#111827;outline:none;box-sizing:border-box}
                #ak-im-root .ak-im-member-action-search-input:focus{box-shadow:0 0 0 2px rgba(7,193,96,.14) inset}
                #ak-im-root .ak-im-member-action-body{flex:1;overflow:auto;padding:12px 12px calc(92px + env(safe-area-inset-bottom, 0px));background:#f7f7f7}
                #ak-im-root .ak-im-member-action-section{background:#ffffff;border-radius:18px;padding:14px 14px 12px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                #ak-im-root .ak-im-member-action-section + .ak-im-member-action-section{margin-top:12px}
                #ak-im-root .ak-im-member-action-section-title{margin:0 0 10px;font-size:13px;font-weight:600;color:#374151;line-height:1.4}
                #ak-im-root .ak-im-member-action-selected-empty{padding:10px 2px;color:#9ca3af;font-size:13px;line-height:1.6}
                #ak-im-root .ak-im-member-action-chip-list{display:flex;flex-wrap:wrap;gap:8px}
                #ak-im-root .ak-im-member-action-chip{max-width:100%;border:none;background:#f0fdf4;color:#166534;min-height:32px;border-radius:999px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;cursor:pointer}
                #ak-im-root .ak-im-member-action-chip:active{opacity:.78}
                #ak-im-root .ak-im-member-action-chip-label{min-width:0;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:600}
                #ak-im-root .ak-im-member-action-chip-remove{font-size:14px;line-height:1}
                #ak-im-root .ak-im-member-action-list{display:flex;flex-direction:column}
                #ak-im-root .ak-im-member-action-row{width:100%;padding:12px 0;border:none;background:transparent;display:flex;align-items:center;gap:12px;text-align:left;cursor:pointer}
                #ak-im-root .ak-im-member-action-row + .ak-im-member-action-row{border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-member-action-row:disabled{cursor:not-allowed;opacity:1}
                #ak-im-root .ak-im-member-action-row.is-disabled .ak-im-member-action-name{color:#9ca3af}
                #ak-im-root .ak-im-member-action-row.is-disabled .ak-im-member-action-meta{color:#c7cdd8}
                #ak-im-root .ak-im-member-action-avatar{width:44px;height:44px;border-radius:14px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-member-action-main{min-width:0;flex:1}
                #ak-im-root .ak-im-member-action-name{font-size:15px;font-weight:600;color:#111827;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-member-action-meta{margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:#6b7280;line-height:1.4}
                #ak-im-root .ak-im-member-action-role{display:inline-flex;align-items:center;justify-content:center;height:18px;padding:0 6px;border-radius:999px;background:rgba(7,193,96,.12);color:#16a34a;font-size:10px;font-weight:700}
                #ak-im-root .ak-im-member-action-reason{color:#ef4444}
                #ak-im-root .ak-im-member-action-reason.is-muted{color:#9ca3af}
                #ak-im-root .ak-im-member-action-check{width:22px;height:22px;border-radius:999px;border:1.5px solid rgba(156,163,175,.6);display:inline-flex;align-items:center;justify-content:center;color:transparent;font-size:14px;font-weight:700;flex:0 0 auto;box-sizing:border-box}
                #ak-im-root .ak-im-member-action-check.is-selected{background:#07c160;border-color:#07c160;color:#ffffff}
                #ak-im-root .ak-im-member-action-check.is-disabled{border-style:dashed;background:#f3f4f6;color:transparent}
                #ak-im-root .ak-im-member-action-footer{position:absolute;left:0;right:0;bottom:0;padding:12px 12px calc(12px + env(safe-area-inset-bottom, 0px));background:linear-gradient(180deg,rgba(247,247,247,0) 0%,#f7f7f7 28%,#f7f7f7 100%)}
                #ak-im-root .ak-im-member-action-submit{width:100%;height:48px;border:none;border-radius:14px;background:#07c160;color:#ffffff;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 10px 24px rgba(7,193,96,.18)}
                #ak-im-root .ak-im-member-action-submit:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
                #ak-im-root .ak-im-member-action-error{margin-bottom:12px;padding:11px 12px;border-radius:14px;background:rgba(239,68,68,.08);color:#dc2626;font-size:13px;line-height:1.6}
                #ak-im-root .ak-im-member-action-empty{padding:28px 14px;color:#9ca3af;font-size:13px;line-height:1.7;text-align:center}
                #ak-im-root .ak-im-dialog{display:none;position:fixed;inset:0;z-index:2147483651}
                #ak-im-root .ak-im-dialog.visible{display:block}
                #ak-im-root .ak-im-dialog-mask{position:absolute;inset:0;background:rgba(0,0,0,.36)}
                #ak-im-root .ak-im-dialog-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(320px,calc(100vw - 40px));background:#ffffff;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.22);overflow:hidden}
                #ak-im-root .ak-im-dialog-content{padding:24px 20px 18px;text-align:center}
                #ak-im-root .ak-im-dialog-title{font-size:18px;font-weight:600;color:#111827;line-height:1.4}
                #ak-im-root .ak-im-dialog-message{margin-top:12px;font-size:14px;color:#6b7280;line-height:1.7;white-space:pre-line}
                #ak-im-root .ak-im-dialog-actions{display:flex;border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-dialog-actions.is-single .ak-im-dialog-btn + .ak-im-dialog-btn{display:none}
                #ak-im-root .ak-im-dialog-btn{flex:1;height:52px;border:none;background:#ffffff;color:#111827;font-size:16px;font-weight:500;cursor:pointer}
                #ak-im-root .ak-im-dialog-btn + .ak-im-dialog-btn{border-left:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-dialog-btn.is-danger{color:#ef4444;font-weight:600}
                #ak-im-root .ak-im-dialog-btn:disabled{opacity:.42;cursor:not-allowed}
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
                        <div class="ak-im-topbar-title ak-im-session-topbar-title">聊天</div>
                        <button class="ak-im-nav-btn ak-im-new" type="button" data-im-action="new">发起</button>
                    </div>
                    <div class="ak-im-session-page">
                        <div class="ak-im-home-panels">
                            <div class="ak-im-home-panel is-chats is-active" data-im-home-panel="chats">
                                <div class="ak-im-search-bar"><div class="ak-im-search-pill">点击右上角发起单聊</div></div>
                                <div class="ak-im-session-list"></div>
                            </div>
                            <div class="ak-im-home-panel" data-im-home-panel="contacts">
                                <div class="ak-im-contacts-list"></div>
                            </div>
                            <div class="ak-im-home-panel" data-im-home-panel="me">
                                <div class="ak-im-profile-page"></div>
                            </div>
                        </div>
                        <div class="ak-im-home-tabbar">
                            <button class="ak-im-home-tab-btn is-active" type="button" data-im-home-tab="chats" aria-label="聊天">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.75C6.5 5.78 7.28 5 8.25 5h7.5c.97 0 1.75.78 1.75 1.75v4.6c0 .97-.78 1.75-1.75 1.75h-3.42l-2.78 2.15c-.29.22-.7.02-.7-.34V13.1H8.25c-.97 0-1.75-.78-1.75-1.75v-4.6Z" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                <span>聊天</span>
                            </button>
                            <button class="ak-im-home-tab-btn" type="button" data-im-home-tab="contacts" aria-label="通讯录">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Zm-5.4 6.3c.42-2.44 2.66-4.2 5.4-4.2s4.98 1.76 5.4 4.2" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.2 7.6h.01M18.8 7.6h.01" stroke-width="2.2" stroke-linecap="round"/></svg>
                                <span>通讯录</span>
                            </button>
                            <button class="ak-im-home-tab-btn" type="button" data-im-home-tab="me" aria-label="我">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12.2a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Zm-6 6.8c.5-2.9 3.15-5 6-5s5.5 2.1 6 5" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                <span>我</span>
                            </button>
                        </div>
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
                <div class="ak-im-screen ak-im-group-info-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-group-info-back" type="button" aria-label="返回聊天页面">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title ak-im-group-info-title">聊天信息</div>
                        <div class="ak-im-group-info-side" aria-hidden="true"></div>
                    </div>
                    <div class="ak-im-group-info-page"></div>
                </div>
                <div class="ak-im-screen ak-im-member-action-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-member-action-back" type="button" aria-label="返回群信息页面">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title ak-im-member-action-title">选择成员</div>
                        <div class="ak-im-group-info-side" aria-hidden="true"></div>
                    </div>
                    <div class="ak-im-member-action-page">
                        <div class="ak-im-member-action-search"><input class="ak-im-member-action-search-input" type="search" inputmode="search" autocomplete="off" spellcheck="false" placeholder="搜索成员" /></div>
                        <div class="ak-im-member-action-body"></div>
                        <div class="ak-im-member-action-footer"><button class="ak-im-member-action-submit" type="button">确认</button></div>
                    </div>
                </div>
                <div class="ak-im-screen ak-im-profile-subpage-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-profile-subpage-back" type="button" aria-label="返回个人页">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title ak-im-profile-subpage-title">个人资料</div>
                        <div class="ak-im-group-info-side" aria-hidden="true"></div>
                    </div>
                    <div class="ak-im-profile-subpage-page"></div>
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
	        <div class="ak-im-dialog" aria-hidden="true" inert>
	            <div class="ak-im-dialog-mask"></div>
	            <div class="ak-im-dialog-panel">
	                <div class="ak-im-dialog-content"><div class="ak-im-dialog-title"></div><div class="ak-im-dialog-message"></div></div>
	                <div class="ak-im-dialog-actions"><button class="ak-im-dialog-btn" type="button" data-im-dialog="cancel">取消</button><button class="ak-im-dialog-btn is-danger" type="button" data-im-dialog="confirm">确定</button></div>
	            </div>
	        </div>
        `;
        document.body.appendChild(root);
        panel = root.querySelector('.ak-im-shell');
        sessionList = root.querySelector('.ak-im-session-list');
        contactsListEl = root.querySelector('.ak-im-contacts-list');
        profilePageEl = root.querySelector('.ak-im-profile-page');
        profileSubpageBodyEl = root.querySelector('.ak-im-profile-subpage-page');
        profileSubpageTitleEl = root.querySelector('.ak-im-profile-subpage-title');
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
	    settingsPanelEl = root.querySelector('.ak-im-group-info-screen');
	    settingsPanelBodyEl = root.querySelector('.ak-im-group-info-page');
	    chatMenuBtnEl = root.querySelector('.ak-im-chat-menu');
	    groupInfoTitleEl = root.querySelector('.ak-im-group-info-title');
	    memberActionPageEl = root.querySelector('.ak-im-member-action-screen');
	    memberActionBodyEl = root.querySelector('.ak-im-member-action-body');
	    memberActionSearchEl = root.querySelector('.ak-im-member-action-search-input');
	    memberActionTitleEl = root.querySelector('.ak-im-member-action-title');
	    memberActionSubmitBtnEl = root.querySelector('.ak-im-member-action-submit');
	    dialogEl = root.querySelector('.ak-im-dialog');
	    dialogTitleEl = root.querySelector('.ak-im-dialog-title');
	    dialogMessageEl = root.querySelector('.ak-im-dialog-message');
	    dialogCancelBtnEl = root.querySelector('[data-im-dialog="cancel"]');
	    dialogConfirmBtnEl = root.querySelector('[data-im-dialog="confirm"]');
	    sessionTopbarTitleEl = root.querySelector('.ak-im-session-topbar-title');
	    sessionNewBtnEl = root.querySelector('.ak-im-new');
        root.querySelector('.ak-im-launcher').addEventListener('click', function() {
            state.open = true;
            if (state.view !== 'compose' && !state.activeConversationId) state.view = 'sessions';
            render();
        });
        root.querySelector('.ak-im-close').addEventListener('click', function() {
            closeActionSheet();
            closeReadProgressPanel();
	        closeMemberPanel();
	        closeDialog({ silent: true, force: true });
	        closeSettingsPanel();
            state.open = false;
            state.view = 'sessions';
            render();
        });
        root.querySelector('.ak-im-back').addEventListener('click', function() {
            closeActionSheet();
            closeReadProgressPanel();
	        closeMemberPanel();
	        closeDialog({ silent: true, force: true });
	        closeSettingsPanel();
            state.view = 'sessions';
            render();
        });
        chatMenuBtnEl.addEventListener('click', function() {
            const activeSession = getActiveSession();
            if (!isGroupSession(activeSession)) return;
            openGroupMenu(activeSession);
        });
        chatTitleBtnEl.addEventListener('click', function() {
            const activeSession = getActiveSession();
            if (!isGroupSession(activeSession)) return;
            openSettingsPanel(activeSession);
        });
        root.querySelector('.ak-im-compose-back').addEventListener('click', closeComposeView);
        root.querySelector('.ak-im-compose-close').addEventListener('click', closeComposeView);
        root.querySelector('[data-im-action="new"]').addEventListener('click', startDirectSession);
        Array.prototype.forEach.call(root.querySelectorAll('[data-im-home-tab]'), function(button) {
            button.addEventListener('click', function() {
                switchHomeTab(button.getAttribute('data-im-home-tab'));
            });
        });
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
	    settingsPanelEl.querySelector('.ak-im-group-info-back').addEventListener('click', function() {
	        closeDialog({ silent: true, force: true });
	        closeSettingsPanel();
	    });
	    memberActionPageEl.querySelector('.ak-im-member-action-back').addEventListener('click', function() {
	        closeDialog({ silent: true, force: true });
	        closeMemberActionPage();
	    });
	    root.querySelector('.ak-im-profile-subpage-back').addEventListener('click', function() {
	        closeProfileSubpage();
	    });
	    memberActionSearchEl.addEventListener('input', function() {
	        state.memberActionKeyword = memberActionSearchEl.value || '';
	        renderMemberActionPage();
	    });
	    memberActionSubmitBtnEl.addEventListener('click', function() {
	        submitMemberActionPage();
	    });
	    dialogEl.querySelector('.ak-im-dialog-mask').addEventListener('click', function() {
	        closeDialog();
	    });
	    dialogCancelBtnEl.addEventListener('click', function() {
	        closeDialog();
	    });
	    dialogConfirmBtnEl.addEventListener('click', function() {
	        submitDialogAction();
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

    function getAvatarUrl(value) {
        return String(value || '').trim();
    }

    function buildAvatarImageMarkup(avatarUrl, altText) {
        const normalizedAvatarUrl = getAvatarUrl(avatarUrl);
        if (!normalizedAvatarUrl) return '';
        return '<img class="ak-im-avatar-photo" src="' + escapeHtml(normalizedAvatarUrl) + '" alt="' + escapeHtml(String(altText || '头像')) + '" loading="lazy" referrerpolicy="no-referrer">';
    }

    function buildAvatarInnerMarkup(avatarUrl, fallbackText, altText) {
        const imageMarkup = buildAvatarImageMarkup(avatarUrl, altText || fallbackText || '头像');
        if (imageMarkup) return imageMarkup;
        return escapeHtml(getAvatarText(fallbackText));
    }

    function buildAvatarBoxMarkup(className, avatarUrl, fallbackText, altText) {
        return '<div class="' + className + '">' + buildAvatarInnerMarkup(avatarUrl, fallbackText, altText) + '</div>';
    }

    function buildAvatarCellMarkup(avatarUrl, fallbackText, altText) {
        return '<span class="ak-im-avatar-cell">' + buildAvatarInnerMarkup(avatarUrl, fallbackText, altText) + '</span>';
    }

    function buildSessionAvatarMarkup(item) {
        if (isGroupSession(item)) {
            const previewMembers = Array.isArray(item && item.members_preview) ? item.members_preview : [];
            if (previewMembers.length) {
                return '<div class="ak-im-session-avatar is-mosaic">' + buildGroupAvatarMosaicMarkup(previewMembers, getSessionDisplayName(item)) + '</div>';
            }
        }
        const displayName = getSessionDisplayName(item);
        return buildAvatarBoxMarkup('ak-im-session-avatar', item && item.avatar_url, displayName, displayName + '头像');
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

    const GROUP_MEMBER_ROLE_WEIGHTS = { owner: 0, admin: 1 };

    function getGroupMemberRoleWeight(role) {
        const key = String(role || '').trim().toLowerCase();
        return key in GROUP_MEMBER_ROLE_WEIGHTS ? GROUP_MEMBER_ROLE_WEIGHTS[key] : 2;
    }

    function sortGroupMembersForDisplay(members) {
        const list = Array.isArray(members) ? members : [];
        const decorated = list.map(function(member, index) {
            return { member: member, weight: getGroupMemberRoleWeight(member && member.role), index: index };
        });
        decorated.sort(function(a, b) {
            if (a.weight !== b.weight) return a.weight - b.weight;
            return a.index - b.index;
        });
        return decorated.map(function(entry) { return entry.member; });
    }

    function buildGroupAvatarMosaicMarkup(members, fallbackText) {
        const list = (Array.isArray(members) ? members : []).slice(0, 9);
        if (!list.length) {
            return '<div class="ak-im-avatar-mosaic is-single" aria-hidden="true">' + buildAvatarCellMarkup('', fallbackText || '群', String(fallbackText || '群') + '头像') + '</div>';
        }
        if (list.length === 1) {
            const only = list[0];
            const onlyName = String(only && (only.display_name || only.username) || '').trim() || String(fallbackText || '群');
            return '<div class="ak-im-avatar-mosaic is-single" aria-hidden="true">' + buildAvatarCellMarkup(only && only.avatar_url, onlyName, onlyName + '头像') + '</div>';
        }
        const cells = list.map(function(member) {
            const display = String(member && (member.display_name || member.username) || '').trim() || '成员';
            return buildAvatarCellMarkup(member && member.avatar_url, display, display + '头像');
        });
        if (list.length >= 9) {
            return '<div class="ak-im-avatar-mosaic is-grid" aria-hidden="true">' + cells.join('') + '</div>';
        }
        const rows = [];
        for (let index = 0; index < cells.length; index += 3) {
            rows.push('<div class="ak-im-avatar-row">' + cells.slice(index, index + 3).join('') + '</div>');
        }
        return '<div class="ak-im-avatar-mosaic is-stack" aria-hidden="true">' + rows.join('') + '</div>';
    }

    function getAvatarText(value) {
        const raw = String(value || '').replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, '').trim();
        if (!raw) return '聊';
        if (/^[\u4e00-\u9fa5]+$/.test(raw)) {
            return raw.length <= 3 ? raw : raw.slice(-3);
        }
        if (/^[0-9a-zA-Z]+$/.test(raw)) {
            return raw.slice(0, 3).toUpperCase();
        }
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
        if (!sessionItem || !isGroupSession(sessionItem)) return;
        openSettingsPanel(sessionItem);
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
	    const roleLabel = role === 'owner' ? '群主' : (role === 'admin' ? '管理员' : '');
	    return '<div class="ak-im-member-item">' + buildAvatarBoxMarkup('ak-im-member-avatar', member && member.avatar_url, displayName || username || '成员', (displayName || username || '成员') + '头像') + '<div class="ak-im-member-body"><div class="ak-im-member-name">' + escapeHtml(displayName || username || '未知成员') + '</div></div>' + (roleLabel ? '<div class="ak-im-member-role">' + escapeHtml(roleLabel) + '</div>' : '') + '</div>';
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
	    const sortedMembers = sortGroupMembersForDisplay(members);
	    memberPanelBodyEl.innerHTML = '<div class="ak-im-member-summary">共 ' + escapeHtml(String(Number(detail.member_count || sortedMembers.length || 0))) + ' 人</div><div class="ak-im-member-list">' + (sortedMembers.length ? sortedMembers.map(function(member) {
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

	function getGroupMemberRoleLabel(role) {
	    const key = String(role || '').trim().toLowerCase();
	    if (key === 'owner') return '群主';
	    if (key === 'admin') return '管理员';
	    return '';
	}

	function getMemberDisplayName(member, fallbackText) {
	    const displayName = String(member && member.display_name || '').trim();
	    const username = String(member && member.username || '').trim();
	    return displayName || username || String(fallbackText || '成员');
	}

	function getMemberActionConfig(mode) {
	    if (mode === 'remove') {
	        return {
	            title: '移除成员',
	            selectedTitle: '已选择移除成员',
	            listTitle: '全部成员',
	            emptyText: '当前没有可移除的成员',
	            submitText: '确认移除',
	            submittingText: '正在移除...',
	            confirmTitle: '确认移除成员？',
	            confirmText: '移除',
	            errorMessage: '移除成员失败',
	            buildRequestBody: function(conversationId, usernames) {
	                return { conversation_id: conversationId, usernames: usernames };
	            },
	            requestUrl: `${HTTP_ROOT}/sessions/members/remove`,
	            buildConfirmMessage: function(candidates) {
	                return '移除后，这些成员将退出当前群聊。\n\n已选择：' + formatMemberActionCandidateSummary(candidates);
	            }
	        };
	    }
	    if (mode === 'clear_member_history') {
	        return {
	            title: '清空指定成员聊天记录',
	            selectedTitle: '已选择清空聊天记录成员',
	            listTitle: '全部成员',
	            emptyText: '当前没有可清空聊天记录的成员',
	            submitText: '确认清空',
	            submittingText: '正在清空...',
	            confirmTitle: '确认清空指定成员聊天记录？',
	            confirmText: '清空',
	            errorMessage: '清空指定成员聊天记录失败',
	            buildRequestBody: function(conversationId, usernames) {
	                return { conversation_id: conversationId, usernames: usernames };
	            },
	            requestUrl: `${HTTP_ROOT}/sessions/history/clear-member`,
	            buildConfirmMessage: function(candidates) {
	                return '将删除所选成员在本群发送过的全部消息。\n\n已选择：' + formatMemberActionCandidateSummary(candidates);
	            }
	        };
	    }
	    return null;
	}

	function buildMemberActionCandidates(detail, mode) {
	    const members = sortGroupMembersForDisplay(Array.isArray(detail && detail.members) ? detail.members : []);
	    const authorSet = {};
	    (Array.isArray(detail && detail.message_authors) ? detail.message_authors : []).forEach(function(item) {
	        const username = String(item && item.username || '').trim().toLowerCase();
	        if (username) authorSet[username] = true;
	    });
	    return members.map(function(member) {
	        const username = String(member && member.username || '').trim().toLowerCase();
	        const displayName = getMemberDisplayName(member, '成员');
	        const role = String(member && member.role || '').trim().toLowerCase();
	        let disabledReason = '';
	        if (!username) {
	            disabledReason = '账号无效';
	        } else if (mode === 'remove') {
	            if (role === 'owner') disabledReason = '群主不可移除';
	            else if (role === 'admin') disabledReason = '管理员不可移除';
	        } else if (mode === 'clear_member_history' && !authorSet[username]) {
	            disabledReason = '无聊天记录';
	        }
	        return {
	            username: username,
	            displayName: displayName,
	            avatarUrl: getAvatarUrl(member && member.avatar_url),
	            role: role,
	            roleLabel: getGroupMemberRoleLabel(role),
	            disabledReason: disabledReason,
	            selectable: !disabledReason,
	            searchText: (displayName + '\n' + username).toLowerCase()
	        };
	    });
	}

	function getActiveMemberActionDetail() {
	    const conversationId = Number(state.memberActionConversationId || 0);
	    if (!conversationId) return null;
	    if (Number(state.groupSettingsConversationId || 0) !== conversationId) return null;
	    return state.groupSettingsData;
	}

	function getMemberActionCandidates() {
	    const detail = getActiveMemberActionDetail();
	    if (!detail) return [];
	    return buildMemberActionCandidates(detail, state.memberActionMode);
	}

	function syncMemberActionSelection(candidates) {
	    const allowedMap = {};
	    (Array.isArray(candidates) ? candidates : []).forEach(function(candidate) {
	        if (candidate && candidate.selectable && candidate.username) allowedMap[candidate.username] = true;
	    });
	    const nextSelected = (Array.isArray(state.memberActionSelectedUsernames) ? state.memberActionSelectedUsernames : []).filter(function(username) {
	        return !!allowedMap[username];
	    });
	    if (nextSelected.length !== state.memberActionSelectedUsernames.length) {
	        state.memberActionSelectedUsernames = nextSelected;
	    }
	    return nextSelected;
	}

	function filterMemberActionCandidates(candidates, keyword) {
	    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
	    if (!normalizedKeyword) return Array.isArray(candidates) ? candidates : [];
	    return (Array.isArray(candidates) ? candidates : []).filter(function(candidate) {
	        return String(candidate && candidate.searchText || '').indexOf(normalizedKeyword) >= 0;
	    });
	}

	function formatMemberActionCandidateLabel(candidate) {
	    const displayName = String(candidate && candidate.displayName || '').trim();
	    const username = String(candidate && candidate.username || '').trim();
	    if (displayName && username && displayName.toLowerCase() !== username.toLowerCase()) {
	        return displayName + ' @' + username;
	    }
	    return displayName || username || '成员';
	}

	function formatMemberActionCandidateSummary(candidates) {
	    const names = (Array.isArray(candidates) ? candidates : []).map(function(candidate) {
	        return formatMemberActionCandidateLabel(candidate);
	    }).filter(Boolean);
	    if (!names.length) return '暂无成员';
	    if (names.length <= 3) return names.join('、');
	    return names.slice(0, 3).join('、') + ' 等 ' + names.length + ' 人';
	}

	function focusMemberActionSearch() {
	    if (!memberActionSearchEl) return;
	    setTimeout(function() {
	        if (!memberActionSearchEl || !state.memberActionOpen || state.view !== 'member_action') return;
	        memberActionSearchEl.focus();
	        try {
	            const length = memberActionSearchEl.value.length;
	            memberActionSearchEl.setSelectionRange(length, length);
	        } catch (e) {}
	    }, 0);
	}

	function openMemberActionPage(mode) {
	    const config = getMemberActionConfig(mode);
	    const conversationId = Number(state.groupSettingsConversationId || 0);
	    if (!config || !conversationId || !state.groupSettingsData) return;
	    state.memberActionOpen = true;
	    state.memberActionMode = mode;
	    state.memberActionConversationId = conversationId;
	    state.memberActionKeyword = '';
	    state.memberActionSelectedUsernames = [];
	    state.memberActionSubmitting = false;
	    state.memberActionError = '';
	    closeDialog({ silent: true, force: true });
	    state.view = 'member_action';
	    render();
	}

	function closeMemberActionPage(options) {
	    const silent = !!(options && options.silent);
	    const fallbackView = options && options.fallbackView ? options.fallbackView : (state.groupSettingsOpen ? 'group_info' : (state.activeConversationId ? 'chat' : 'sessions'));
	    state.memberActionOpen = false;
	    state.memberActionMode = '';
	    state.memberActionConversationId = 0;
	    state.memberActionKeyword = '';
	    state.memberActionSelectedUsernames = [];
	    state.memberActionSubmitting = false;
	    state.memberActionError = '';
	    if (state.view === 'member_action') state.view = fallbackView;
	    if (!silent) render();
	}

	function toggleMemberActionSelection(username) {
	    const normalized = String(username || '').trim().toLowerCase();
	    if (!normalized || state.memberActionSubmitting) return;
	    const selected = Array.isArray(state.memberActionSelectedUsernames) ? state.memberActionSelectedUsernames.slice() : [];
	    const index = selected.indexOf(normalized);
	    if (index >= 0) selected.splice(index, 1);
	    else selected.push(normalized);
	    state.memberActionSelectedUsernames = selected;
	    if (state.memberActionError) state.memberActionError = '';
	    renderMemberActionPage();
	}

	function renderMemberActionPage() {
	    if (!memberActionBodyEl || !memberActionSearchEl || !memberActionTitleEl || !memberActionSubmitBtnEl) return;
	    const isOpen = !!state.memberActionOpen;
	    const config = getMemberActionConfig(state.memberActionMode);
	    memberActionTitleEl.textContent = config ? config.title : '选择成员';
	    memberActionSearchEl.value = String(state.memberActionKeyword || '');
	    memberActionSearchEl.disabled = !isOpen || !!state.memberActionSubmitting;
	    if (!isOpen || !config) {
	        memberActionBodyEl.innerHTML = '';
	        memberActionSubmitBtnEl.disabled = true;
	        memberActionSubmitBtnEl.textContent = '确认';
	        return;
	    }
	    const candidates = getMemberActionCandidates();
	    const selectedUsernames = syncMemberActionSelection(candidates);
	    const candidateMap = {};
	    candidates.forEach(function(candidate) {
	        if (candidate && candidate.username) candidateMap[candidate.username] = candidate;
	    });
	    const selectedCandidates = selectedUsernames.map(function(username) {
	        return candidateMap[username] || null;
	    }).filter(Boolean);
	    const filteredCandidates = filterMemberActionCandidates(candidates, state.memberActionKeyword);
	    const selectedMarkup = selectedCandidates.length ? '<div class="ak-im-member-action-chip-list">' + selectedCandidates.map(function(candidate) {
	        return '<button class="ak-im-member-action-chip" type="button" data-im-member-chip="' + escapeHtml(candidate.username) + '"><span class="ak-im-member-action-chip-label">' + escapeHtml(formatMemberActionCandidateLabel(candidate)) + '</span><span class="ak-im-member-action-chip-remove" aria-hidden="true">×</span></button>';
	    }).join('') + '</div>' : '<div class="ak-im-member-action-selected-empty">暂未选择成员</div>';
	    const listMarkup = filteredCandidates.length ? '<div class="ak-im-member-action-list">' + filteredCandidates.map(function(candidate) {
	        const isSelected = selectedUsernames.indexOf(candidate.username) >= 0;
	        const reasonClass = candidate.disabledReason === '无聊天记录' ? ' is-muted' : '';
	        return '<button class="ak-im-member-action-row' + (candidate.selectable ? '' : ' is-disabled') + '" type="button" data-im-member-option="' + escapeHtml(candidate.username) + '"' + (candidate.selectable ? '' : ' disabled') + '>' +
	            buildAvatarBoxMarkup('ak-im-member-action-avatar', candidate.avatarUrl, candidate.displayName || candidate.username || '成员', (candidate.displayName || candidate.username || '成员') + '头像') +
	            '<div class="ak-im-member-action-main"><div class="ak-im-member-action-name">' + escapeHtml(candidate.displayName || candidate.username || '未知成员') + '</div>' +
	            '<div class="ak-im-member-action-meta"><span>@' + escapeHtml(candidate.username || 'unknown') + '</span>' +
	            (candidate.roleLabel ? '<span class="ak-im-member-action-role">' + escapeHtml(candidate.roleLabel) + '</span>' : '') +
	            (candidate.disabledReason ? '<span class="ak-im-member-action-reason' + reasonClass + '">' + escapeHtml(candidate.disabledReason) + '</span>' : '') +
	            '</div></div>' +
	            '<span class="ak-im-member-action-check' + (candidate.selectable ? (isSelected ? ' is-selected' : '') : ' is-disabled') + '">' + (isSelected ? '✓' : '') + '</span>' +
	        '</button>';
	    }).join('') + '</div>' : '<div class="ak-im-member-action-empty">' + escapeHtml(state.memberActionKeyword ? '没有匹配的成员' : config.emptyText) + '</div>';
	    memberActionBodyEl.innerHTML = (state.memberActionError ? '<div class="ak-im-member-action-error">' + escapeHtml(state.memberActionError) + '</div>' : '') +
	        '<div class="ak-im-member-action-section"><div class="ak-im-member-action-section-title">' + escapeHtml(config.selectedTitle + '（' + selectedCandidates.length + '）') + '</div>' + selectedMarkup + '</div>' +
	        '<div class="ak-im-member-action-section"><div class="ak-im-member-action-section-title">' + escapeHtml(config.listTitle) + '</div>' + listMarkup + '</div>';
	    Array.prototype.forEach.call(memberActionBodyEl.querySelectorAll('[data-im-member-option]'), function(button) {
	        button.addEventListener('click', function() {
	            toggleMemberActionSelection(button.getAttribute('data-im-member-option'));
	        });
	    });
	    Array.prototype.forEach.call(memberActionBodyEl.querySelectorAll('[data-im-member-chip]'), function(button) {
	        button.addEventListener('click', function() {
	            toggleMemberActionSelection(button.getAttribute('data-im-member-chip'));
	        });
	    });
	    memberActionSubmitBtnEl.disabled = !selectedCandidates.length || !!state.memberActionSubmitting;
	    memberActionSubmitBtnEl.textContent = state.memberActionSubmitting ? config.submittingText : (config.submitText + (selectedCandidates.length ? '（' + selectedCandidates.length + '）' : ''));
	}

	function openDialog(options) {
	    state.dialogOpen = true;
	    state.dialogTitle = String(options && options.title || '提示');
	    state.dialogMessage = String(options && options.message || '');
	    state.dialogConfirmText = String(options && options.confirmText || '确定');
	    state.dialogCancelText = String(options && options.cancelText || '取消');
	    state.dialogDanger = !!(options && options.danger);
	    state.dialogShowCancel = options && Object.prototype.hasOwnProperty.call(options, 'showCancel') ? !!options.showCancel : true;
	    state.dialogAction = String(options && options.action || '');
	    state.dialogSubmitting = false;
	    state.dialogPayload = options && options.payload ? options.payload : null;
	    renderDialog();
	}

	function closeDialog(options) {
	    const silent = !!(options && options.silent);
	    const force = !!(options && options.force);
	    if (state.dialogSubmitting && !force) return;
	    state.dialogOpen = false;
	    state.dialogTitle = '';
	    state.dialogMessage = '';
	    state.dialogConfirmText = '';
	    state.dialogCancelText = '';
	    state.dialogDanger = false;
	    state.dialogShowCancel = true;
	    state.dialogAction = '';
	    state.dialogSubmitting = false;
	    state.dialogPayload = null;
	    if (!silent) renderDialog();
	}

	function renderDialog() {
	    if (!dialogEl || !dialogTitleEl || !dialogMessageEl || !dialogCancelBtnEl || !dialogConfirmBtnEl) return;
	    const isOpen = !!state.dialogOpen;
	    const actionWrap = dialogEl.querySelector('.ak-im-dialog-actions');
	    dialogEl.classList.toggle('visible', isOpen);
	    if (!isOpen) {
	        const activeElement = document.activeElement;
	        if (activeElement && dialogEl.contains(activeElement) && typeof activeElement.blur === 'function') activeElement.blur();
	        dialogEl.setAttribute('inert', '');
	        dialogEl.setAttribute('aria-hidden', 'true');
	        if (actionWrap) actionWrap.classList.remove('is-single');
	        return;
	    }
	    dialogEl.removeAttribute('inert');
	    dialogEl.setAttribute('aria-hidden', 'false');
	    if (actionWrap) actionWrap.classList.toggle('is-single', !state.dialogShowCancel);
	    dialogTitleEl.textContent = state.dialogTitle || '提示';
	    dialogMessageEl.textContent = state.dialogMessage || '';
	    dialogCancelBtnEl.textContent = state.dialogCancelText || '取消';
	    dialogCancelBtnEl.style.display = state.dialogShowCancel ? '' : 'none';
	    dialogCancelBtnEl.disabled = !!state.dialogSubmitting;
	    dialogConfirmBtnEl.textContent = state.dialogConfirmText || '确定';
	    dialogConfirmBtnEl.disabled = !!state.dialogSubmitting;
	    dialogConfirmBtnEl.classList.toggle('is-danger', !!state.dialogDanger);
	}

	function showSettingsErrorDialog(message) {
	    openDialog({
	        title: '操作失败',
	        message: message,
	        confirmText: '我知道了',
	        showCancel: false,
	        danger: false
	    });
	}

	function executeSettingsDialogRequest(requestPromiseFactory, onSuccess, fallbackMessage, onError) {
	    state.dialogSubmitting = true;
	    renderDialog();
	    Promise.resolve().then(requestPromiseFactory).then(function() {
	        return typeof onSuccess === 'function' ? onSuccess() : null;
	    }).then(function() {
	        closeDialog({ silent: true, force: true });
	        render();
	    }).catch(function(error) {
	        const message = error && error.message ? error.message : fallbackMessage;
	        closeDialog({ silent: true, force: true });
	        if (typeof onError === 'function' && onError(message) === true) {
	            render();
	            return;
	        }
	        showSettingsErrorDialog(message);
	    });
	}

	function submitMemberActionPage() {
	    const config = getMemberActionConfig(state.memberActionMode);
	    const conversationId = Number(state.memberActionConversationId || 0);
	    if (!config || !conversationId) return;
	    const candidates = getMemberActionCandidates();
	    const selectedUsernames = syncMemberActionSelection(candidates);
	    const candidateMap = {};
	    candidates.forEach(function(candidate) {
	        if (candidate && candidate.username) candidateMap[candidate.username] = candidate;
	    });
	    const selectedCandidates = selectedUsernames.map(function(username) {
	        return candidateMap[username] || null;
	    }).filter(Boolean);
	    if (!selectedCandidates.length) {
	        state.memberActionError = '请至少选择一名成员';
	        renderMemberActionPage();
	        return;
	    }
	    state.memberActionError = '';
	    openDialog({
	        title: config.confirmTitle,
	        message: config.buildConfirmMessage(selectedCandidates),
	        confirmText: config.confirmText,
	        cancelText: '取消',
	        danger: true,
	        action: 'member_action_submit',
	        payload: {
	            mode: state.memberActionMode,
	            conversationId: conversationId,
	            usernames: selectedCandidates.map(function(candidate) { return candidate.username; })
	        }
	    });
	}

	function executeMemberActionRequest(payload) {
	    const mode = String(payload && payload.mode || '');
	    const conversationId = Number(payload && payload.conversationId || 0);
	    const config = getMemberActionConfig(mode);
	    const usernames = Array.isArray(payload && payload.usernames) ? payload.usernames : [];
	    if (!config || !conversationId || !usernames.length) {
	        closeDialog({ force: true });
	        return;
	    }
	    state.memberActionSubmitting = true;
	    renderMemberActionPage();
	    executeSettingsDialogRequest(function() {
	        return request(config.requestUrl, {
	            method: 'POST',
	            body: JSON.stringify(config.buildRequestBody(conversationId, usernames))
	        });
	    }, function() {
	        return refreshAfterSettingsAction(conversationId).then(function() {
	            closeMemberActionPage({ silent: true, fallbackView: 'group_info' });
	        });
	    }, config.errorMessage, function(message) {
	        state.memberActionSubmitting = false;
	        state.memberActionError = message;
	        renderMemberActionPage();
	        return true;
	    });
	}

	function executeClearHistoryRequest(conversationId) {
	    executeSettingsDialogRequest(function() {
	        return request(`${HTTP_ROOT}/sessions/history/clear`, {
	            method: 'POST',
	            body: JSON.stringify({ conversation_id: conversationId })
	        });
	    }, function() {
	        return refreshAfterSettingsAction(conversationId);
	    }, '清空全群聊天记录失败');
	}

	function executeHideGroupRequest(conversationId) {
	    executeSettingsDialogRequest(function() {
	        return request(`${HTTP_ROOT}/sessions/hide`, {
	            method: 'POST',
	            body: JSON.stringify({ conversation_id: conversationId })
	        });
	    }, function() {
	        closeSettingsPanel();
	        return loadSessions();
	    }, '隐藏本群失败');
	}

	function submitDialogAction() {
	    if (!state.dialogOpen || state.dialogSubmitting) return;
	    if (state.dialogAction === 'member_action_submit') {
	        executeMemberActionRequest(state.dialogPayload || null);
	        return;
	    }
	    if (state.dialogAction === 'clear_history') {
	        executeClearHistoryRequest(Number(state.dialogPayload && state.dialogPayload.conversationId || 0));
	        return;
	    }
	    if (state.dialogAction === 'hide_group') {
	        executeHideGroupRequest(Number(state.dialogPayload && state.dialogPayload.conversationId || 0));
	        return;
	    }
	    closeDialog();
	}

	function formatGroupInfoMemberText(member, fallbackText) {
	    const displayName = String(member && member.display_name || '').trim();
	    const username = String(member && member.username || '').trim();
	    if (displayName && username && displayName !== username) return displayName + ' @' + username;
	    return displayName || username || String(fallbackText || '暂无');
	}

	function formatGroupInfoCollectionText(members, emptyText) {
	    const names = (Array.isArray(members) ? members : []).map(function(member) {
	        return formatGroupInfoMemberText(member, '');
	    }).filter(Boolean);
	    if (!names.length) return String(emptyText || '暂无');
	    if (names.length <= 3) return names.join('、');
	    return names.slice(0, 3).join('、') + ' 等 ' + names.length + ' 人';
	}

	function buildGroupInfoCell(label, value, action, extraClass) {
	    const className = 'ak-im-group-info-cell' + (action ? ' is-action' : '') + (extraClass ? ' ' + extraClass : '');
	    const tagName = action ? 'button' : 'div';
	    return '<' + tagName + ' class="' + className + '"' + (action ? ' type="button" data-im-settings-action="' + action + '"' : '') + '>' +
	        '<div class="ak-im-group-info-cell-main"><div class="ak-im-group-info-cell-label">' + escapeHtml(label) + '</div>' +
	        (value ? '<div class="ak-im-group-info-cell-value">' + escapeHtml(value) + '</div>' : '') +
	        '</div>' + (action ? '<div class="ak-im-group-info-cell-arrow">›</div>' : '') + '</' + tagName + '>';
	}

	function renderSettingsPanel() {
	    if (!settingsPanelEl || !settingsPanelBodyEl) return;
	    const isOpen = !!state.groupSettingsOpen;
	    if (groupInfoTitleEl) groupInfoTitleEl.textContent = '聊天信息';
	    if (!isOpen) {
	        settingsPanelBodyEl.innerHTML = '';
	        return;
	    }
	    if (state.groupSettingsLoading) {
	        settingsPanelBodyEl.innerHTML = '<div class="ak-im-group-info-loading">正在加载群信息...</div>';
	        return;
	    }
	    if (state.groupSettingsError) {
	        settingsPanelBodyEl.innerHTML = '<div class="ak-im-group-info-error">' + escapeHtml(state.groupSettingsError) + '</div>';
	        return;
	    }
	    const detail = state.groupSettingsData;
	    if (!detail) {
	        settingsPanelBodyEl.innerHTML = '<div class="ak-im-group-info-empty">暂无可用的群信息</div>';
	        return;
	    }
	    const rawMembers = Array.isArray(detail.members) ? detail.members : [];
	    const members = sortGroupMembersForDisplay(rawMembers);
	    const admins = Array.isArray(detail.admins) ? detail.admins : [];
	    const authors = Array.isArray(detail.message_authors) ? detail.message_authors : [];
	    const canManage = !!detail.can_manage;
	    const memberCount = Math.max(0, Number(detail.member_count || members.length || 0) || 0);
	    const showAddMemberTile = canManage && memberCount <= 15;
	    const addMemberMarkup = showAddMemberTile ? '<button class="ak-im-member-item is-add" type="button" data-im-settings-action="add"><div class="ak-im-member-avatar">+</div><div class="ak-im-member-body"><div class="ak-im-member-name">添加</div></div></button>' : '';
	    const previewLimit = showAddMemberTile ? 19 : 20;
	    const membersExpanded = !!state.groupSettingsMembersExpanded;
	    const visibleMembers = membersExpanded ? members : members.slice(0, previewLimit);
	    const showMoreMembers = members.length > previewLimit;
	    const memberGridMarkup = (visibleMembers.length || addMemberMarkup) ? '<div class="ak-im-member-list">' + visibleMembers.map(formatSessionMember).join('') + addMemberMarkup + '</div>' : '<div class="ak-im-group-info-empty">当前群里还没有成员</div>';
	    const ownerText = formatGroupInfoMemberText(detail.owner || { username: detail.owner_username }, '暂无群主');
	    const adminsText = formatGroupInfoCollectionText(admins, '暂无群管理员');
	    const authorsText = formatGroupInfoCollectionText(authors, '暂无可清空聊天记录成员');
	    const statusText = detail.hidden_for_all ? '已对全员隐藏' : '正常显示';
	    if (groupInfoTitleEl) groupInfoTitleEl.textContent = '聊天信息(' + memberCount + ')';
	    const heroTitle = String(detail.conversation_title || '群聊');
	    const heroMosaicSource = members.length ? members : (detail.owner ? [detail.owner] : []);
	    const heroMarkup = '<div class="ak-im-group-info-hero">' +
	        '<div class="ak-im-group-info-hero-avatar">' + buildGroupAvatarMosaicMarkup(heroMosaicSource, heroTitle) + '</div>' +
	        '<div class="ak-im-group-info-hero-title">' + escapeHtml(heroTitle) + '</div>' +
	        '<div class="ak-im-group-info-hero-subtitle">群聊 · ' + memberCount + ' 人</div>' +
	    '</div>';
	    settingsPanelBodyEl.innerHTML = heroMarkup + '<div class="ak-im-group-info-members">' + memberGridMarkup + (showMoreMembers ? '<button class="ak-im-group-info-more" type="button" data-im-settings-action="toggle_members">' + escapeHtml(membersExpanded ? '收起群成员' : '更多群成员') + '<span aria-hidden="true">⌄</span></button>' : '') + '</div>' +
	        '<div class="ak-im-group-info-section">' +
	            buildGroupInfoCell('群聊名称', String(detail.conversation_title || '群聊')) +
	            buildGroupInfoCell('群主', ownerText) +
	            buildGroupInfoCell('群管理员', adminsText) +
	            buildGroupInfoCell('可清空聊天记录成员', authorsText) +
	            buildGroupInfoCell('群状态', statusText) +
	        '</div>' +
	        (canManage ? '<div class="ak-im-group-info-section">' +
	            buildGroupInfoCell('添加成员', '', 'add') +
	            buildGroupInfoCell('移除成员', '', 'remove') +
	            buildGroupInfoCell('清空指定成员聊天记录', '', 'clear_member_history') +
	            buildGroupInfoCell('清空全群聊天记录', '', 'clear_history', 'is-danger') +
	            buildGroupInfoCell('隐藏本群', '', 'hide_group', 'is-danger') +
	        '</div>' : '');
	    Array.prototype.forEach.call(settingsPanelBodyEl.querySelectorAll('[data-im-settings-action]'), function(button) {
	        button.addEventListener('click', function() {
	            const action = button.getAttribute('data-im-settings-action');
	            if (action === 'toggle_members') {
	                state.groupSettingsMembersExpanded = !state.groupSettingsMembersExpanded;
	                renderSettingsPanel();
	                return;
	            }
	            handleSettingsAction(action);
	        });
	    });
	}

	function closeSettingsPanel() {
	    closeDialog({ silent: true, force: true });
	    closeMemberActionPage({ silent: true, fallbackView: state.activeConversationId ? 'chat' : 'sessions' });
	    state.groupSettingsOpen = false;
	    state.groupSettingsLoading = false;
	    state.groupSettingsError = '';
	    state.groupSettingsConversationId = 0;
	    state.groupSettingsData = null;
	    state.groupSettingsMembersExpanded = false;
	    if (state.view === 'group_info') {
	        state.view = state.activeConversationId ? 'chat' : 'sessions';
	    }
	    render();
	}

	function loadGroupSettings(conversationId) {
	    const targetConversationId = Number(conversationId || 0);
	    if (!targetConversationId) return Promise.resolve(null);
	    state.groupSettingsLoading = true;
	    state.groupSettingsError = '';
	    state.groupSettingsConversationId = targetConversationId;
	    renderSettingsPanel();
	    return request(`${HTTP_ROOT}/sessions/group_profile?conversation_id=${encodeURIComponent(targetConversationId)}`).then(function(data) {
	        if (Number(state.groupSettingsConversationId || 0) !== targetConversationId) return null;
	        state.groupSettingsLoading = false;
	        state.groupSettingsData = data && data.item ? data.item : null;
	        renderSettingsPanel();
	        return state.groupSettingsData;
	    }).catch(function(error) {
	        if (Number(state.groupSettingsConversationId || 0) !== targetConversationId) return null;
	        state.groupSettingsLoading = false;
	        state.groupSettingsError = error && error.message ? error.message : '读取群信息失败';
	        renderSettingsPanel();
	        return null;
	    });
	}

	function openSettingsPanel(sessionItem) {
	    const conversationId = Number(sessionItem && sessionItem.conversation_id || state.activeConversationId || 0);
	    if (!conversationId || !isGroupSession(sessionItem || getActiveSession())) return;
	    closeActionSheet();
	    closeReadProgressPanel();
	    closeMemberPanel();
	    closeDialog({ silent: true, force: true });
	    closeMemberActionPage({ silent: true, fallbackView: 'group_info' });
	    state.groupSettingsOpen = true;
	    state.groupSettingsLoading = true;
	    state.groupSettingsError = '';
	    state.groupSettingsMembersExpanded = false;
	    state.groupSettingsData = null;
	    state.open = true;
	    state.view = 'group_info';
	    render();
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
	        openMemberActionPage('remove');
	        return;
	    }
	    if (action === 'clear_member_history') {
	        openMemberActionPage('clear_member_history');
	        return;
	    }
	    if (action === 'clear_history') {
	        openDialog({
	            title: '清空全群聊天记录？',
	            message: '清空后，本群现有聊天记录会立即对所有成员生效。',
	            confirmText: '清空',
	            cancelText: '取消',
	            danger: true,
	            action: 'clear_history',
	            payload: { conversationId: conversationId }
	        });
	        return;
	    }
	    if (action === 'hide_group') {
	        openDialog({
	            title: '隐藏本群？',
	            message: '隐藏后，本群会对所有成员生效。',
	            confirmText: '隐藏',
	            cancelText: '取消',
	            danger: true,
	            action: 'hide_group',
	            payload: { conversationId: conversationId }
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
	    openSettingsPanel(sessionItem);
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

    function normalizeHomeTab(tab) {
        const candidate = String(tab || '').trim().toLowerCase();
        if (candidate === 'contacts' || candidate === 'me') return candidate;
        return 'chats';
    }

    function getHomeTabTitle(tab) {
        const normalizedTab = normalizeHomeTab(tab);
        if (normalizedTab === 'contacts') return '通讯录';
        if (normalizedTab === 'me') return '我';
        return '聊天';
    }

    function normalizeProfileGender(value) {
        const candidate = String(value || '').trim().toLowerCase();
        if (candidate === 'male' || candidate === 'female') return candidate;
        return 'unknown';
    }

    function getProfileGenderLabel(value) {
        const gender = normalizeProfileGender(value);
        if (gender === 'male') return '男';
        if (gender === 'female') return '女';
        return '未设置';
    }

    function formatProfileHistoryTime(value) {
        if (!value) return '';
        try {
            const date = new Date(value);
            if (isNaN(date.getTime())) return '';
            return date.toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            return '';
        }
    }

    function isProfileSubpageView(view) {
        return view === 'profile_avatar' || view === 'profile_detail' || view === 'profile_settings';
    }

    function getProfileSubpageTitle(view) {
        if (view === 'profile_avatar') return '更换头像';
        if (view === 'profile_settings') return '设置';
        return '个人资料';
    }

    function syncProfileDraftFromProfile() {
        const profile = state.profile || null;
        state.profileDraftNickname = String(profile && (profile.nickname || profile.display_name || '') || state.displayName || '').trim();
        state.profileDraftGender = normalizeProfileGender(profile && profile.gender);
        state.profileDraftDirty = false;
    }

    function closeProfileSubpage() {
        closeDialog({ silent: true, force: true });
        state.profileSaveError = '';
        state.profileDraftDirty = false;
        if (isProfileSubpageView(state.view)) {
            state.homeTab = 'me';
            state.view = 'sessions';
        }
        render();
    }

    function openProfileSubpage(view) {
        if (!state.allowed) return;
        const nextView = isProfileSubpageView(view) ? view : 'profile_detail';
        closeActionSheet();
        closeReadProgressPanel();
        closeMemberPanel();
        closeDialog({ silent: true, force: true });
        state.open = true;
        state.homeTab = 'me';
        state.view = nextView;
        state.profileSaveError = '';
        if (!state.profileLoaded && !state.profileLoading) {
            loadProfile();
        }
        if (nextView === 'profile_detail') {
            syncProfileDraftFromProfile();
        }
        if (nextView === 'profile_avatar' && !state.profileAvatarHistoryLoaded && !state.profileAvatarHistoryLoading) {
            loadProfileAvatarHistory();
        }
        render();
    }

    function ensureHomeTabData(tab) {
        const normalizedTab = normalizeHomeTab(tab);
        if (!state.allowed) return;
        if (normalizedTab === 'contacts') {
            if (!state.contactsLoading && !state.contactsLoaded) loadContacts();
            return;
        }
        if (normalizedTab === 'me' && !state.profileLoading && !state.profileLoaded) {
            loadProfile();
        }
    }

    function switchHomeTab(tab) {
        state.homeTab = normalizeHomeTab(tab);
        state.view = 'sessions';
        ensureHomeTabData(state.homeTab);
        render();
    }

    function renderHomeShell() {
        if (!root) return;
        state.homeTab = normalizeHomeTab(state.homeTab);
        if (sessionTopbarTitleEl) {
            sessionTopbarTitleEl.textContent = getHomeTabTitle(state.homeTab);
        }
        if (sessionNewBtnEl) {
            sessionNewBtnEl.classList.toggle('is-hidden', state.homeTab !== 'chats');
        }
        const searchPill = root.querySelector('.ak-im-search-pill');
        if (searchPill) {
            if (state.homeTab === 'contacts') {
                searchPill.textContent = state.contactsLoading ? '正在同步同白名单通讯录' : '同白名单成员会显示在这里，点击可直接发起聊天';
            } else if (state.homeTab === 'me') {
                searchPill.textContent = '这里保留更换头像、个人资料、设置三个入口';
            } else {
                searchPill.textContent = state.sessions.length ? '长按会话可置顶，点击进入聊天' : '点击右上角发起单聊';
            }
        }
        Array.prototype.forEach.call(root.querySelectorAll('[data-im-home-tab]'), function(button) {
            button.classList.toggle('is-active', button.getAttribute('data-im-home-tab') === state.homeTab);
        });
        Array.prototype.forEach.call(root.querySelectorAll('[data-im-home-panel]'), function(panelNode) {
            panelNode.classList.toggle('is-active', panelNode.getAttribute('data-im-home-panel') === state.homeTab);
        });
    }

    function renderSessionList() {
        if (!root || !sessionList) return;
        sessionList.innerHTML = '';
        if (!state.sessions.length) {
            const empty = document.createElement('div');
            empty.className = 'ak-im-empty';
            empty.textContent = state.allowed ? '暂无会话\n点击右上角“发起”开始单聊' : '当前账号未开通聊天';
            sessionList.appendChild(empty);
            return;
        }
        state.sessions.forEach(function(item) {
            const node = document.createElement('div');
            node.className = 'ak-im-session-item' + (item.conversation_id === state.activeConversationId ? ' ak-active' : '') + (isSessionPinned(item) ? ' is-pinned' : '');
            const unreadCount = getUnreadCount(item);
            const subtitle = getSessionSubtitle(item);
            const previewText = subtitle ? (subtitle + ' · ' + getSessionPreview(item)) : getSessionPreview(item);
            const pinText = isSessionSystemPinned(item) ? '群置顶' : '置顶';
            node.innerHTML = buildSessionAvatarMarkup(item) +
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

    function renderContactsView() {
        if (!contactsListEl) return;
        contactsListEl.innerHTML = '';
        if (!state.allowed) {
            contactsListEl.innerHTML = '<div class="ak-im-empty">当前账号未开通聊天</div>';
            return;
        }
        if (state.contactsLoading) {
            contactsListEl.innerHTML = '<div class="ak-im-empty">正在加载通讯录...</div>';
            return;
        }
        if (state.contactsError) {
            contactsListEl.innerHTML = '<div class="ak-im-empty">' + escapeHtml(state.contactsError) + '</div>';
            return;
        }
        if (!state.contacts.length) {
            contactsListEl.innerHTML = '<div class="ak-im-empty">当前白名单暂无其他联系人</div>';
            return;
        }
        state.contacts.forEach(function(contact) {
            const username = String(contact && contact.username || '').trim();
            const displayName = String(contact && contact.display_name || '').trim() || username || '联系人';
            const node = document.createElement('button');
            node.type = 'button';
            node.className = 'ak-im-contact-item';
            node.innerHTML = buildAvatarBoxMarkup('ak-im-contact-avatar', contact && contact.avatar_url, displayName, displayName + '头像') +
                '<div class="ak-im-contact-body"><div class="ak-im-contact-name">' + escapeHtml(displayName) + '</div><div class="ak-im-contact-meta">@' + escapeHtml(username || 'unknown') + '</div></div>';
            node.addEventListener('click', function() {
                openDirectConversation(username);
            });
            contactsListEl.appendChild(node);
        });
    }

    function renderProfileView() {
        if (!profilePageEl) return;
        if (!state.allowed) {
            profilePageEl.innerHTML = '<div class="ak-im-empty">当前账号未开通聊天</div>';
            return;
        }
        const profile = state.profile || null;
        const displayName = String(profile && profile.display_name || state.displayName || state.username || '我').trim();
        const username = String(profile && profile.username || state.username || '').trim();
        const nickname = String(profile && profile.nickname || '').trim();
        const genderLabel = getProfileGenderLabel(profile && profile.gender);
        const avatarHistorySummary = state.profileAvatarHistoryLoading ? '正在同步头像历史' : (state.profileAvatarHistoryLoaded ? (state.profileAvatarHistory.length ? ('最近保留 ' + state.profileAvatarHistory.length + ' 个历史头像') : '切换头像后会在这里保留最近 10 个记录') : '可查看最近 10 个历史头像');
        profilePageEl.innerHTML = (state.profileError ? '<div class="ak-im-profile-error">' + escapeHtml(state.profileError) + '</div>' : '') +
            '<div class="ak-im-profile-card">' +
                '<div class="ak-im-profile-head">' +
                    buildAvatarBoxMarkup('ak-im-profile-avatar', profile && profile.avatar_url, displayName || username || '我', (displayName || username || '我') + '头像') +
                    '<div class="ak-im-profile-name">' + escapeHtml(displayName || '我') + '</div>' +
                    '<div class="ak-im-profile-username">@' + escapeHtml(username || 'unknown') + '</div>' +
                    '<div class="ak-im-profile-meta">' + escapeHtml((nickname ? ('昵称：' + nickname) : '可设置昵称') + ' · 性别：' + genderLabel) + '</div>' +
                '</div>' +
            '</div>' +
            '<div class="ak-im-profile-entry-list">' +
                '<button class="ak-im-profile-entry" type="button" data-im-profile-nav="profile_avatar">' +
                    '<div class="ak-im-profile-entry-main"><div class="ak-im-profile-entry-label">更换头像</div><div class="ak-im-profile-entry-meta">' + escapeHtml(avatarHistorySummary) + '</div></div>' +
                    '<div class="ak-im-profile-entry-arrow" aria-hidden="true">›</div>' +
                '</button>' +
                '<button class="ak-im-profile-entry" type="button" data-im-profile-nav="profile_detail">' +
                    '<div class="ak-im-profile-entry-main"><div class="ak-im-profile-entry-label">个人资料</div><div class="ak-im-profile-entry-meta">' + escapeHtml('昵称：' + (nickname || displayName || '未设置') + ' · 性别：' + genderLabel) + '</div></div>' +
                    '<div class="ak-im-profile-entry-arrow" aria-hidden="true">›</div>' +
                '</button>' +
                '<button class="ak-im-profile-entry" type="button" data-im-profile-nav="profile_settings">' +
                    '<div class="ak-im-profile-entry-main"><div class="ak-im-profile-entry-label">设置</div><div class="ak-im-profile-entry-meta">独立全屏设置页，后续设置项可继续扩展</div></div>' +
                    '<div class="ak-im-profile-entry-arrow" aria-hidden="true">›</div>' +
                '</button>' +
            '</div>';
        Array.prototype.forEach.call(profilePageEl.querySelectorAll('[data-im-profile-nav]'), function(button) {
            button.addEventListener('click', function() {
                openProfileSubpage(button.getAttribute('data-im-profile-nav'));
            });
        });
    }

    function renderProfileSubpage() {
        if (!profileSubpageBodyEl || !profileSubpageTitleEl) return;
        if (!isProfileSubpageView(state.view)) {
            profileSubpageTitleEl.textContent = '个人资料';
            profileSubpageBodyEl.innerHTML = '';
            return;
        }
        profileSubpageTitleEl.textContent = getProfileSubpageTitle(state.view);
        if (!state.allowed) {
            profileSubpageBodyEl.innerHTML = '<div class="ak-im-empty">当前账号未开通聊天</div>';
            return;
        }
        const profile = state.profile || null;
        const displayName = String(profile && profile.display_name || state.displayName || state.username || '我').trim();
        const username = String(profile && profile.username || state.username || '').trim();
        const nickname = String(profile && profile.nickname || '').trim();
        const genderLabel = getProfileGenderLabel(profile && profile.gender);
        const avatarStyle = String(profile && profile.avatar_style || 'thumbs').trim() || 'thumbs';
        if (state.view === 'profile_avatar') {
            const historyMarkup = state.profileAvatarHistoryLoading ? '<div class="ak-im-profile-placeholder">正在读取头像历史...</div>' : (state.profileAvatarHistoryError ? '<div class="ak-im-profile-error">' + escapeHtml(state.profileAvatarHistoryError) + '</div>' : (state.profileAvatarHistory.length ? '<div class="ak-im-profile-history-grid">' + state.profileAvatarHistory.map(function(item) {
                const historyTime = formatProfileHistoryTime(item.created_at) || '最近使用';
                return '<div class="ak-im-profile-history-item">' +
                    buildAvatarBoxMarkup('ak-im-profile-history-avatar', item.avatar_url, displayName || username || '我', '历史头像') +
                    '<div class="ak-im-profile-history-time">' + escapeHtml(historyTime) + '</div>' +
                '</div>';
            }).join('') + '</div>' : '<div class="ak-im-profile-placeholder">暂时还没有历史头像，切换一次后会在这里保留最近 10 个记录。</div>'));
            profileSubpageBodyEl.innerHTML = (state.profileError ? '<div class="ak-im-profile-error">' + escapeHtml(state.profileError) + '</div>' : '') +
                '<div class="ak-im-profile-panel">' +
                    '<div class="ak-im-profile-head">' +
                        buildAvatarBoxMarkup('ak-im-profile-avatar', profile && profile.avatar_url, displayName || username || '我', (displayName || username || '我') + '头像') +
                        '<div class="ak-im-profile-name">' + escapeHtml(displayName || '我') + '</div>' +
                        '<div class="ak-im-profile-username">@' + escapeHtml(username || 'unknown') + '</div>' +
                        '<div class="ak-im-profile-meta">DiceBear ' + escapeHtml(avatarStyle) + '</div>' +
                    '</div>' +
                    '<div class="ak-im-profile-subtitle">点击下方按钮会生成新的头像，并自动保留最近 10 个历史记录。</div>' +
                    '<button class="ak-im-profile-primary-btn" type="button" data-im-profile-action="refresh-avatar"' + (state.profileRefreshing ? ' disabled' : '') + '>' + escapeHtml(state.profileRefreshing ? '正在切换头像...' : '换一个头像') + '</button>' +
                '</div>' +
                '<div class="ak-im-profile-panel">' +
                    '<div class="ak-im-profile-entry-label">历史头像</div>' +
                    '<div class="ak-im-profile-subtitle">按时间倒序展示最近更换过的头像。</div>' +
                    historyMarkup +
                '</div>';
            const refreshBtn = profileSubpageBodyEl.querySelector('[data-im-profile-action="refresh-avatar"]');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', function() {
                    refreshProfileAvatar();
                });
            }
            return;
        }
        if (state.view === 'profile_detail') {
            const draftNickname = String(state.profileDraftNickname || '').trim();
            const draftGender = normalizeProfileGender(state.profileDraftGender);
            const draftGenderLabel = getProfileGenderLabel(draftGender);
            profileSubpageBodyEl.innerHTML = (state.profileSaveError ? '<div class="ak-im-profile-error">' + escapeHtml(state.profileSaveError) + '</div>' : '') +
                '<div class="ak-im-profile-panel">' +
                    '<div class="ak-im-profile-form">' +
                        '<div class="ak-im-profile-form-group">' +
                            '<label class="ak-im-profile-form-label" for="ak-im-profile-nickname">昵称</label>' +
                            '<input class="ak-im-profile-form-input" id="ak-im-profile-nickname" data-im-profile-field="nickname" type="text" autocomplete="off" spellcheck="false" value="' + escapeHtml(state.profileDraftNickname) + '" placeholder="请输入昵称" />' +
                            '<div class="ak-im-profile-form-help">保存后会同步显示在会话标题、群成员、消息发送者和个人资料中。</div>' +
                        '</div>' +
                        '<div class="ak-im-profile-form-group">' +
                            '<label class="ak-im-profile-form-label" for="ak-im-profile-gender">性别</label>' +
                            '<select class="ak-im-profile-form-select" id="ak-im-profile-gender" data-im-profile-field="gender">' +
                                '<option value="unknown"' + (draftGender === 'unknown' ? ' selected' : '') + '>未设置</option>' +
                                '<option value="male"' + (draftGender === 'male' ? ' selected' : '') + '>男</option>' +
                                '<option value="female"' + (draftGender === 'female' ? ' selected' : '') + '>女</option>' +
                            '</select>' +
                            '<div class="ak-im-profile-form-help" data-im-profile-preview>当前对外显示：' + escapeHtml((draftNickname || displayName || username || '我') + ' · ' + draftGenderLabel) + '</div>' +
                        '</div>' +
                        '<button class="ak-im-profile-primary-btn" type="button" data-im-profile-action="save-detail"' + (state.profileSaving ? ' disabled' : '') + '>' + escapeHtml(state.profileSaving ? '正在保存...' : '保存资料') + '</button>' +
                    '</div>' +
                '</div>';
            const nicknameInput = profileSubpageBodyEl.querySelector('[data-im-profile-field="nickname"]');
            const genderSelect = profileSubpageBodyEl.querySelector('[data-im-profile-field="gender"]');
            const previewEl = profileSubpageBodyEl.querySelector('[data-im-profile-preview]');
            const saveBtn = profileSubpageBodyEl.querySelector('[data-im-profile-action="save-detail"]');
            const updateDraftPreview = function() {
                if (!previewEl) return;
                const previewName = String(state.profileDraftNickname || '').trim() || displayName || username || '我';
                previewEl.textContent = '当前对外显示：' + previewName + ' · ' + getProfileGenderLabel(state.profileDraftGender);
            };
            if (nicknameInput) {
                nicknameInput.addEventListener('input', function() {
                    state.profileDraftNickname = nicknameInput.value || '';
                    state.profileDraftDirty = true;
                    updateDraftPreview();
                });
            }
            if (genderSelect) {
                genderSelect.addEventListener('change', function() {
                    state.profileDraftGender = genderSelect.value || 'unknown';
                    state.profileDraftDirty = true;
                    updateDraftPreview();
                });
            }
            if (saveBtn) {
                saveBtn.addEventListener('click', function() {
                    saveProfileDetail();
                });
            }
            return;
        }
        profileSubpageBodyEl.innerHTML = '<div class="ak-im-profile-panel">' +
            '<div class="ak-im-profile-head">' +
                buildAvatarBoxMarkup('ak-im-profile-avatar', profile && profile.avatar_url, displayName || username || '我', (displayName || username || '我') + '头像') +
                '<div class="ak-im-profile-name">' + escapeHtml(displayName || '我') + '</div>' +
                '<div class="ak-im-profile-username">@' + escapeHtml(username || 'unknown') + '</div>' +
            '</div>' +
            '<div class="ak-im-profile-subtitle">这里是新的全屏设置页入口，后续与 IM 个人相关的设置项会继续放在这里。</div>' +
        '</div>' +
        '<div class="ak-im-profile-panel">' +
            '<div class="ak-im-profile-entry-label">当前资料</div>' +
            '<div class="ak-im-profile-subtitle">昵称：' + escapeHtml(nickname || displayName || '未设置') + '</div>' +
            '<div class="ak-im-profile-subtitle">性别：' + escapeHtml(genderLabel) + '</div>' +
            '<div class="ak-im-profile-subtitle">账号：@' + escapeHtml(username || 'unknown') + '</div>' +
        '</div>';
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
        const showGroupInfo = state.view === 'group_info' && !!state.groupSettingsOpen;
        const showMemberAction = state.view === 'member_action' && !!state.memberActionOpen;
        const showProfileSubpage = isProfileSubpageView(state.view);
        root.classList.toggle('ak-visible', !!state.allowed);
        root.classList.toggle('ak-im-open', !!state.open);
        root.classList.toggle('ak-view-sessions', !showChat && !showCompose && !showGroupInfo && !showMemberAction && !showProfileSubpage);
        root.classList.toggle('ak-view-chat', !!showChat);
        root.classList.toggle('ak-view-compose', !!showCompose);
        root.classList.toggle('ak-view-group-info', !!showGroupInfo);
        root.classList.toggle('ak-view-member-action', !!showMemberAction);
        root.classList.toggle('ak-view-profile-subpage', !!showProfileSubpage);
        root.querySelector('.ak-im-launcher').classList.toggle('is-open', !!state.open);
        root.querySelector('.ak-im-launcher').classList.toggle('has-unread', state.sessions.some(function(item) {
            return getUnreadCount(item) > 0;
        }));
        renderHomeShell();
        statusLine.textContent = '';
        renderSessionList();
        renderContactsView();
        renderProfileView();
        renderProfileSubpage();
        syncComposerState();
        syncInputHeight();
        renderMessages();
        renderReadProgressPanel();
	    renderMemberPanel();
	    renderSettingsPanel();
	    renderMemberActionPage();
	    renderDialog();
        renderComposeView();
        if (showChat) markRead(state.activeConversationId);
        if (state.open && state.view === 'compose') focusComposeInput();
	    if (state.open && showMemberAction) focusMemberActionSearch();
    }

    function renderMessages() {
        const headerTitle = root.querySelector('.ak-im-chat-title');
        const headerSubtitle = root.querySelector('.ak-im-chat-subtitle');
	    const activeSession = getActiveSession();
	    const subtitleText = activeSession ? getSessionSubtitle(activeSession) : '';
        headerTitle.textContent = activeSession ? getSessionDisplayName(activeSession) : '内部聊天';
	    headerSubtitle.textContent = activeSession ? subtitleText : '';
	    if (chatTitleBtnEl) {
	        const canOpenGroupInfo = !!activeSession && isGroupSession(activeSession);
	        chatTitleBtnEl.disabled = !canOpenGroupInfo;
	        chatTitleBtnEl.classList.toggle('is-clickable', canOpenGroupInfo);
	        chatTitleBtnEl.setAttribute('aria-label', canOpenGroupInfo ? '打开群信息' : '聊天标题');
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
            const senderDisplayName = String(item && (item.sender_display_name || item.sender_username) || '').trim();
            const displayName = isSelf ? (state.displayName || senderDisplayName || state.username || '我') : (isGroupSession(activeSession) ? (senderDisplayName || item.sender_username || '群成员') : (activeSession ? getSessionDisplayName(activeSession) : (senderDisplayName || item.sender_username || '对方')));
            const metaText = summary && Number(summary.total_count || 0) > 0 ? ('已读 ' + Number(summary.read_count || 0) + '/' + Number(summary.total_count || 0)) : ((isSelf && item.read) ? '对方已读' : '');
            const senderText = !isSelf && isGroupSession(activeSession) ? String(senderDisplayName || item.sender_username || '').trim() : '';
	        const progressMarkup = buildReadProgressButtonMarkup(item, activeSession);
	        const avatarText = displayName || item.sender_username || '成员';
	        const avatarUrl = isSelf ? getAvatarUrl((state.profile && state.profile.avatar_url) || item.sender_avatar_url) : getAvatarUrl(item.sender_avatar_url);
	        const footerMarkup = (metaText || progressMarkup) ? '<div class="ak-im-message-footer">' +
	            (metaText ? '<div class="ak-im-meta">' + escapeHtml(metaText) + '</div>' : '') +
	            progressMarkup +
	        '</div>' : '';
            wrapper.innerHTML = '<div class="ak-im-time-divider">' + escapeHtml(formatTime(item.sent_at)) + '</div>' +
                '<div class="ak-im-message-row ' + (isSelf ? 'ak-self' : 'ak-peer') + '">' +
	                    buildAvatarBoxMarkup('ak-im-avatar', avatarUrl, avatarText, avatarText + '头像') +
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

    function normalizeProfileItem(item) {
        const username = String(item && item.username || state.username || '').trim().toLowerCase();
        const displayName = String(item && item.display_name || state.displayName || username || '').trim();
        return {
            username: username || String(state.username || '').trim().toLowerCase(),
            display_name: displayName || username || '我',
            nickname: String(item && item.nickname || '').trim(),
            gender: normalizeProfileGender(item && item.gender),
            avatar_style: String(item && item.avatar_style || 'thumbs').trim() || 'thumbs',
            avatar_url: getAvatarUrl(item && item.avatar_url)
        };
    }

    function normalizeProfileAvatarHistoryItem(item) {
        return {
            avatar_style: String(item && item.avatar_style || 'thumbs').trim() || 'thumbs',
            avatar_url: getAvatarUrl(item && item.avatar_url),
            created_at: String(item && item.created_at || '').trim()
        };
    }

    function applyProfileItem(item) {
        const profile = normalizeProfileItem(item);
        state.profile = profile;
        if (profile.username) state.username = profile.username;
        if (profile.display_name) state.displayName = profile.display_name;
        if (!state.profileDraftDirty || state.view !== 'profile_detail' || state.profileSaving) {
            syncProfileDraftFromProfile();
        }
        return profile;
    }

    function reloadProfileLinkedData() {
        const tasks = [loadSessions()];
        if (state.homeTab === 'contacts' || state.contactsLoaded) {
            tasks.push(loadContacts());
        }
        if (Number(state.activeConversationId || 0) > 0) {
            tasks.push(loadMessages(state.activeConversationId));
        }
        if (state.groupSettingsOpen && Number(state.groupSettingsConversationId || 0) > 0) {
            tasks.push(loadGroupSettings(state.groupSettingsConversationId));
        }
        if (state.memberPanelOpen && Number(state.memberPanelConversationId || 0) > 0) {
            const targetConversationId = Number(state.memberPanelConversationId || 0);
            state.memberPanelLoading = true;
            state.memberPanelError = '';
            renderMemberPanel();
            tasks.push(request(`${HTTP_ROOT}/sessions/members?conversation_id=${encodeURIComponent(targetConversationId)}`).then(function(data) {
                if (!state.memberPanelOpen || Number(state.memberPanelConversationId || 0) !== targetConversationId) return null;
                state.memberPanelLoading = false;
                state.memberPanelData = data && data.item ? data.item : null;
                renderMemberPanel();
                return state.memberPanelData;
            }).catch(function(error) {
                if (!state.memberPanelOpen || Number(state.memberPanelConversationId || 0) !== targetConversationId) return null;
                state.memberPanelLoading = false;
                state.memberPanelError = error && error.message ? error.message : '读取群成员失败';
                renderMemberPanel();
                return null;
            }));
        }
        return Promise.all(tasks);
    }

    function loadContacts() {
        if (!state.allowed) return Promise.resolve([]);
        state.contactsLoading = true;
        state.contactsError = '';
        render();
        return request(`${HTTP_ROOT}/contacts`).then(function(data) {
            state.contactsLoading = false;
            state.contactsLoaded = true;
            state.contactsError = '';
            state.contacts = Array.isArray(data && data.items) ? data.items : [];
            render();
            return state.contacts;
        }).catch(function(error) {
            state.contactsLoading = false;
            state.contactsLoaded = false;
            state.contactsError = error && error.message ? error.message : '读取通讯录失败';
            state.contacts = [];
            render();
            return [];
        });
    }

    function loadProfileAvatarHistory(force) {
        if (!state.allowed) return Promise.resolve([]);
        if (!force && state.profileAvatarHistoryLoaded && !state.profileAvatarHistoryLoading) {
            return Promise.resolve(state.profileAvatarHistory);
        }
        if (state.profileAvatarHistoryLoading) {
            return Promise.resolve(state.profileAvatarHistory);
        }
        state.profileAvatarHistoryLoading = true;
        state.profileAvatarHistoryError = '';
        render();
        return request(`${HTTP_ROOT}/profile/avatar/history`).then(function(data) {
            state.profileAvatarHistoryLoading = false;
            state.profileAvatarHistoryLoaded = true;
            state.profileAvatarHistoryError = '';
            state.profileAvatarHistory = Array.isArray(data && data.items) ? data.items.map(normalizeProfileAvatarHistoryItem) : [];
            render();
            return state.profileAvatarHistory;
        }).catch(function(error) {
            state.profileAvatarHistoryLoading = false;
            state.profileAvatarHistoryLoaded = false;
            state.profileAvatarHistoryError = error && error.message ? error.message : '读取头像历史失败';
            state.profileAvatarHistory = [];
            render();
            return [];
        });
    }

    function loadProfile() {
        if (!state.allowed) return Promise.resolve(null);
        state.profileLoading = true;
        state.profileError = '';
        render();
        return request(`${HTTP_ROOT}/profile`).then(function(data) {
            state.profileLoading = false;
            state.profileLoaded = true;
            state.profileError = '';
            applyProfileItem(data && data.item ? data.item : null);
            render();
            return state.profile;
        }).catch(function(error) {
            state.profileLoading = false;
            state.profileLoaded = false;
            state.profileError = error && error.message ? error.message : '读取个人资料失败';
            render();
            return null;
        });
    }

    function saveProfileDetail() {
        if (!state.allowed || state.profileSaving) return Promise.resolve(null);
        state.profileSaving = true;
        state.profileSaveError = '';
        render();
        return request(`${HTTP_ROOT}/profile`, {
            method: 'POST',
            body: JSON.stringify({
                nickname: String(state.profileDraftNickname || '').trim(),
                gender: normalizeProfileGender(state.profileDraftGender)
            })
        }).then(function(data) {
            state.profileLoaded = true;
            state.profileError = '';
            applyProfileItem(data && data.item ? data.item : null);
            state.profileSaving = false;
            state.profileSaveError = '';
            state.homeTab = 'me';
            state.view = 'sessions';
            render();
            return reloadProfileLinkedData().then(function() {
                render();
                return state.profile;
            });
        }).catch(function(error) {
            state.profileSaving = false;
            state.profileSaveError = error && error.message ? error.message : '保存个人资料失败';
            render();
            return null;
        });
    }

    function refreshProfileAvatar() {
        if (!state.allowed || state.profileRefreshing) return Promise.resolve(null);
        state.profileRefreshing = true;
        state.profileError = '';
        render();
        return request(`${HTTP_ROOT}/profile/avatar/refresh`, {
            method: 'POST',
            body: '{}'
        }).then(function(data) {
            state.profileRefreshing = false;
            state.profileLoaded = true;
            applyProfileItem(data && data.item ? data.item : null);
            render();
            const tasks = [reloadProfileLinkedData()];
            if (state.view === 'profile_avatar' || state.profileAvatarHistoryLoaded) {
                tasks.push(loadProfileAvatarHistory(true));
            }
            return Promise.all(tasks).then(function() {
                render();
                return state.profile;
            });
        }).catch(function(error) {
            state.profileRefreshing = false;
            state.profileError = error && error.message ? error.message : '切换头像失败';
            render();
            return null;
        });
    }

    function openDirectConversation(target, options) {
        if (!state.allowed) return Promise.resolve(null);
        const normalizedTarget = String(target || '').trim().toLowerCase();
        const onError = options && typeof options.onError === 'function' ? options.onError : null;
        if (!normalizedTarget) {
            const emptyMessage = '请输入要发起聊天的账号 username';
            if (onError) onError(emptyMessage);
            else window.alert(emptyMessage);
            return Promise.resolve(null);
        }
        return request(`${HTTP_ROOT}/sessions/direct`, {
            method: 'POST',
            body: JSON.stringify({ target_username: normalizedTarget })
        }).then(function(data) {
            const conversationId = Number((data && data.conversation_id) || 0);
            if (!conversationId) throw new Error('发起会话失败');
            state.activeConversationId = conversationId;
            state.view = 'chat';
            state.activeMessages = [];
            if (options && options.resetCompose) {
                state.newSessionTarget = '';
                state.newSessionError = '';
            }
            render();
            return loadSessions().then(function() {
                return loadMessages(conversationId);
            });
        }).catch(function(error) {
            const message = error && error.message ? error.message : '发起会话失败';
            if (onError) {
                onError(message);
                return null;
            }
            window.alert(message);
            return null;
        });
    }

    function loadBootstrap() {
        return request(`${HTTP_ROOT}/bootstrap`).then(function(data) {
            state.allowed = !!(data && data.allowed);
            state.ready = true;
            state.username = String((data && data.username) || '').trim().toLowerCase();
            state.displayName = String((data && data.display_name) || state.username || '').trim();
            state.contacts = [];
            state.contactsLoaded = false;
            state.contactsLoading = false;
            state.contactsError = '';
            state.profileLoaded = false;
            state.profileLoading = false;
            state.profileError = '';
            state.profileRefreshing = false;
            state.profileSaving = false;
            state.profileSaveError = '';
            state.profileAvatarHistory = [];
            state.profileAvatarHistoryLoaded = false;
            state.profileAvatarHistoryLoading = false;
            state.profileAvatarHistoryError = '';
            state.profileDraftNickname = '';
            state.profileDraftGender = 'unknown';
            state.profileDraftDirty = false;
            state.profile = state.username ? normalizeProfileItem({
                username: state.username,
                display_name: state.displayName,
                avatar_style: 'thumbs',
                avatar_url: data && data.avatar_url
            }) : null;
            syncProfileDraftFromProfile();
            if (!state.allowed) {
                state.sessions = [];
                state.activeConversationId = 0;
                state.activeMessages = [];
                render();
                return null;
            }
            ensureWebSocket();
            return loadSessions().then(function() {
                ensureHomeTabData(state.homeTab);
                return null;
            });
        }).catch(function() {
            state.allowed = false;
            state.ready = true;
            state.contacts = [];
            state.contactsLoaded = false;
            state.contactsLoading = false;
            state.contactsError = '';
            state.profile = null;
            state.profileLoaded = false;
            state.profileLoading = false;
            state.profileError = '';
            state.profileRefreshing = false;
            state.profileSaving = false;
            state.profileSaveError = '';
            state.profileAvatarHistory = [];
            state.profileAvatarHistoryLoaded = false;
            state.profileAvatarHistoryLoading = false;
            state.profileAvatarHistoryError = '';
            state.profileDraftNickname = '';
            state.profileDraftGender = 'unknown';
            state.profileDraftDirty = false;
            state.sessions = [];
            state.activeConversationId = 0;
            state.activeMessages = [];
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
        state.newSessionError = '';
        openDirectConversation(state.newSessionTarget, {
            resetCompose: true,
            onError: function(message) {
                state.newSessionError = message;
                renderComposeView();
                focusComposeInput();
            }
        }).catch(function() {
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
                        if (state.homeTab === 'contacts' || state.contactsLoaded) {
                            loadContacts();
                        }
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
        close: function() { closeActionSheet(); closeReadProgressPanel(); closeMemberPanel(); closeSettingsPanel(); state.open = false; state.view = 'sessions'; render(); },
        reloadSessions: loadSessions
    };
})();
