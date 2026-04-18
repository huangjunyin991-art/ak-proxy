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
        profileAvatarHistoryActionId: 0,
        profileAvatarHistoryActionType: '',
        profileAvatarActionError: '',
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

    function assignShellElements(elements) {
        const nextElements = elements || {};
        root = nextElements.root || null;
        panel = nextElements.panel || null;
        sessionList = nextElements.sessionList || null;
        contactsListEl = nextElements.contactsListEl || null;
        profilePageEl = nextElements.profilePageEl || null;
        profileSubpageBodyEl = nextElements.profileSubpageBodyEl || null;
        profileSubpageTitleEl = nextElements.profileSubpageTitleEl || null;
        messageList = nextElements.messageList || null;
        statusLine = nextElements.statusLine || null;
        inputEl = nextElements.inputEl || null;
        newSessionInputEl = nextElements.newSessionInputEl || null;
        sendBtn = nextElements.sendBtn || null;
        actionSheetEl = nextElements.actionSheetEl || null;
        actionSheetRecallBtn = nextElements.actionSheetRecallBtn || null;
        actionSheetCancelBtn = nextElements.actionSheetCancelBtn || null;
        progressPanelEl = nextElements.progressPanelEl || null;
        progressPanelBodyEl = nextElements.progressPanelBodyEl || null;
        memberPanelEl = nextElements.memberPanelEl || null;
        memberPanelBodyEl = nextElements.memberPanelBodyEl || null;
        chatTitleBtnEl = nextElements.chatTitleBtnEl || null;
        settingsPanelEl = nextElements.settingsPanelEl || null;
        settingsPanelBodyEl = nextElements.settingsPanelBodyEl || null;
        chatMenuBtnEl = nextElements.chatMenuBtnEl || null;
        groupInfoTitleEl = nextElements.groupInfoTitleEl || null;
        memberActionPageEl = nextElements.memberActionPageEl || null;
        memberActionBodyEl = nextElements.memberActionBodyEl || null;
        memberActionSearchEl = nextElements.memberActionSearchEl || null;
        memberActionTitleEl = nextElements.memberActionTitleEl || null;
        memberActionSubmitBtnEl = nextElements.memberActionSubmitBtnEl || null;
        dialogEl = nextElements.dialogEl || null;
        dialogTitleEl = nextElements.dialogTitleEl || null;
        dialogMessageEl = nextElements.dialogMessageEl || null;
        dialogCancelBtnEl = nextElements.dialogCancelBtnEl || null;
        dialogConfirmBtnEl = nextElements.dialogConfirmBtnEl || null;
        sessionTopbarTitleEl = nextElements.sessionTopbarTitleEl || null;
        sessionNewBtnEl = nextElements.sessionNewBtnEl || null;
    }

    function collectFallbackShellElements(rootNode) {
        return {
            root: rootNode,
            panel: rootNode ? rootNode.querySelector('.ak-im-shell') : null,
            sessionList: rootNode ? rootNode.querySelector('.ak-im-session-list') : null,
            contactsListEl: rootNode ? rootNode.querySelector('.ak-im-contacts-list') : null,
            profilePageEl: rootNode ? rootNode.querySelector('.ak-im-profile-page') : null,
            profileSubpageBodyEl: rootNode ? rootNode.querySelector('.ak-im-profile-subpage-page') : null,
            profileSubpageTitleEl: rootNode ? rootNode.querySelector('.ak-im-profile-subpage-title') : null,
            messageList: rootNode ? rootNode.querySelector('.ak-im-message-list') : null,
            statusLine: rootNode ? rootNode.querySelector('.ak-im-status') : null,
            inputEl: rootNode ? rootNode.querySelector('.ak-im-input') : null,
            newSessionInputEl: rootNode ? rootNode.querySelector('.ak-im-compose-input') : null,
            sendBtn: rootNode ? rootNode.querySelector('.ak-im-send') : null,
            actionSheetEl: rootNode ? rootNode.querySelector('.ak-im-action-sheet') : null,
            actionSheetRecallBtn: rootNode ? rootNode.querySelector('[data-im-action="recall"]') : null,
            actionSheetCancelBtn: rootNode ? rootNode.querySelector('[data-im-action="cancel"]') : null,
            progressPanelEl: rootNode ? rootNode.querySelector('.ak-im-progress-sheet') : null,
            progressPanelBodyEl: rootNode ? rootNode.querySelector('.ak-im-progress-panel-body') : null,
            memberPanelEl: rootNode ? rootNode.querySelector('.ak-im-member-sheet') : null,
            memberPanelBodyEl: rootNode ? rootNode.querySelector('.ak-im-member-panel-body') : null,
            chatTitleBtnEl: rootNode ? rootNode.querySelector('.ak-im-chat-title-btn') : null,
            settingsPanelEl: rootNode ? rootNode.querySelector('.ak-im-group-info-screen') : null,
            settingsPanelBodyEl: rootNode ? rootNode.querySelector('.ak-im-group-info-page') : null,
            chatMenuBtnEl: rootNode ? rootNode.querySelector('.ak-im-chat-menu') : null,
            groupInfoTitleEl: rootNode ? rootNode.querySelector('.ak-im-group-info-title') : null,
            memberActionPageEl: rootNode ? rootNode.querySelector('.ak-im-member-action-screen') : null,
            memberActionBodyEl: rootNode ? rootNode.querySelector('.ak-im-member-action-body') : null,
            memberActionSearchEl: rootNode ? rootNode.querySelector('.ak-im-member-action-search-input') : null,
            memberActionTitleEl: rootNode ? rootNode.querySelector('.ak-im-member-action-title') : null,
            memberActionSubmitBtnEl: rootNode ? rootNode.querySelector('.ak-im-member-action-submit') : null,
            dialogEl: rootNode ? rootNode.querySelector('.ak-im-dialog') : null,
            dialogTitleEl: rootNode ? rootNode.querySelector('.ak-im-dialog-title') : null,
            dialogMessageEl: rootNode ? rootNode.querySelector('.ak-im-dialog-message') : null,
            dialogCancelBtnEl: rootNode ? rootNode.querySelector('[data-im-dialog="cancel"]') : null,
            dialogConfirmBtnEl: rootNode ? rootNode.querySelector('[data-im-dialog="confirm"]') : null,
            sessionTopbarTitleEl: rootNode ? rootNode.querySelector('.ak-im-session-topbar-title') : null,
            sessionNewBtnEl: rootNode ? rootNode.querySelector('.ak-im-new') : null
        };
    }

    function initShellModules() {
        initMessageManageModule();
        initSessionManageModule();
        initGroupManageModule();
        initOverlayModule();
    }

    function openShellPanel() {
        state.open = true;
        if (state.view !== 'compose' && !state.activeConversationId) state.view = 'sessions';
        render();
    }

    function showSessionsView(options) {
        closeActionSheet();
        closeReadProgressPanel();
        closeMemberPanel();
        closeSettingsPanel({ silent: true });
        if (options && options.closePanel) state.open = false;
        state.view = 'sessions';
        render();
    }

    function openActiveGroupMenu() {
        const activeSession = getActiveSession();
        if (!isGroupSession(activeSession)) return;
        openGroupMenu(activeSession);
    }

    function openActiveGroupSettings() {
        const activeSession = getActiveSession();
        if (!isGroupSession(activeSession)) return;
        openSettingsPanel(activeSession);
    }

    function handleComposerInput(value) {
        state.inputValue = value || '';
        syncInputHeight();
        syncComposerState();
    }

    function handleNewSessionInputChange(value) {
        state.newSessionTarget = value || '';
        if (state.newSessionError) state.newSessionError = '';
        renderComposeView();
    }

    function getProfileModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const profileModule = modules.profile;
        if (!profileModule || typeof profileModule.init !== 'function' || typeof profileModule.renderProfileSubpage !== 'function') return null;
        return profileModule;
    }

    function initProfileModule() {
        const profileModule = getProfileModule();
        if (!profileModule) return;
        profileModule.init({
            state: state,
            get elements() {
                return {
                    profileSubpageBodyEl: profileSubpageBodyEl,
                    profileSubpageTitleEl: profileSubpageTitleEl
                };
            },
            isProfileSubpageView: isProfileSubpageView,
            getProfileSubpageTitle: getProfileSubpageTitle,
            normalizeProfileGender: normalizeProfileGender,
            getProfileGenderLabel: getProfileGenderLabel,
            formatProfileHistoryTime: formatProfileHistoryTime,
            getAvatarUrl: getAvatarUrl,
            buildAvatarBoxMarkup: buildAvatarBoxMarkup,
            escapeHtml: escapeHtml,
            countProfileAvatarFavorites: countProfileAvatarFavorites,
            refreshProfileAvatar: refreshProfileAvatar,
            selectProfileAvatar: selectProfileAvatar,
            setProfileAvatarFavorite: setProfileAvatarFavorite,
            openProfileAvatarRemoveDialog: openProfileAvatarRemoveDialog,
            saveProfileDetail: saveProfileDetail
        });
    }

    function getAppShellModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const appShellModule = modules.appShell;
        if (!appShellModule || typeof appShellModule.init !== 'function' || typeof appShellModule.ensureRoot !== 'function' || typeof appShellModule.renderShell !== 'function') return null;
        return appShellModule;
    }

    function initAppShellModule() {
        const appShellModule = getAppShellModule();
        if (!appShellModule) return;
        appShellModule.init({
            getRoot: function() {
                return root;
            },
            onRootReady: function(elements) {
                assignShellElements(elements);
                initShellModules();
            },
            syncComposerLayout: function() {
                syncInputHeight();
                syncComposerState();
            },
            getShellState: getShellRenderState,
            bindOverlayEvents: bindOverlayEvents,
            onLauncherClick: openShellPanel,
            onCloseClick: function() {
                showSessionsView({ closePanel: true });
            },
            onBackClick: showSessionsView,
            onChatMenuClick: openActiveGroupMenu,
            onChatTitleClick: openActiveGroupSettings,
            onComposeBackClick: closeComposeView,
            onComposeCloseClick: closeComposeView,
            onNewSessionClick: startDirectSession,
            onHomeTabChange: switchHomeTab,
            onComposeCancelClick: closeComposeView,
            onComposeSubmitClick: submitDirectSession,
            onSendClick: sendCurrentMessage,
            onComposerInput: handleComposerInput,
            onComposerSubmit: sendCurrentMessage,
            onNewSessionInputChange: handleNewSessionInputChange,
            onMemberPanelClose: closeMemberPanel,
            onProfileSubpageBackClick: closeProfileSubpage
        });
    }

    function getOverlayModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const overlayModule = modules.overlay;
        if (!overlayModule || typeof overlayModule.init !== 'function') return null;
        return overlayModule;
    }

    function getSessionManageModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const sessionManageModule = modules.sessionManage;
        if (!sessionManageModule || typeof sessionManageModule.init !== 'function') return null;
        return sessionManageModule;
    }

    function initSessionManageModule() {
        const sessionManageModule = getSessionManageModule();
        if (!sessionManageModule) return;
        sessionManageModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            get elements() {
                return {
                    sessionList: sessionList
                };
            },
            request: request,
            render: render,
            escapeHtml: escapeHtml,
            formatSessionTime: formatSessionTime,
            closeActionSheet: closeActionSheet,
            closeReadProgressPanel: closeReadProgressPanel,
            closeMemberPanel: closeMemberPanel,
            closeSettingsPanel: closeSettingsPanel,
            openSessionActionSheet: openSessionActionSheet,
            loadMessages: loadMessages,
            buildAvatarBoxMarkup: buildAvatarBoxMarkup,
            buildGroupAvatarMosaicMarkup: buildGroupAvatarMosaicMarkup
        });
    }

    function getGroupManageModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const groupManageModule = modules.groupManage;
        if (!groupManageModule || typeof groupManageModule.init !== 'function') return null;
        return groupManageModule;
    }

    function initGroupManageModule() {
        const groupManageModule = getGroupManageModule();
        if (!groupManageModule) return;
        groupManageModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            request: request,
            render: render,
            escapeHtml: escapeHtml,
            getAvatarUrl: getAvatarUrl,
            openDialog: openDialog,
            closeDialog: closeDialog,
            renderDialog: renderDialog,
            renderSettingsPanel: renderSettingsPanel,
            renderMemberActionPage: renderMemberActionPage,
            openMemberActionPage: openMemberActionPage,
            closeMemberActionPage: closeMemberActionPage,
            closeSettingsPanel: closeSettingsPanel,
            loadSessions: loadSessions,
            loadMessages: loadMessages,
            sortGroupMembersForDisplay: sortGroupMembersForDisplay
        });
    }

    function getMessageManageModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const messageManageModule = modules.messageManage;
        if (!messageManageModule || typeof messageManageModule.init !== 'function') return null;
        return messageManageModule;
    }

    function initMessageManageModule() {
        const messageManageModule = getMessageManageModule();
        if (!messageManageModule) return;
        messageManageModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            get elements() {
                return {
                    messageList: messageList,
                    inputEl: inputEl,
                    chatTitleEl: root ? root.querySelector('.ak-im-chat-title') : null,
                    chatSubtitleEl: root ? root.querySelector('.ak-im-chat-subtitle') : null,
                    chatTitleBtnEl: chatTitleBtnEl,
                    chatMenuBtnEl: chatMenuBtnEl
                };
            },
            request: request,
            render: render,
            loadSessions: loadSessions,
            loadContacts: loadContacts,
            loadGroupSettings: loadGroupSettings,
            renderMemberPanel: renderMemberPanel,
            syncInputHeight: syncInputHeight,
            syncComposerState: syncComposerState,
            escapeHtml: escapeHtml,
            formatTime: formatTime,
            getAvatarUrl: getAvatarUrl,
            buildAvatarBoxMarkup: buildAvatarBoxMarkup,
            openActionSheet: openActionSheet,
            closeActionSheet: closeActionSheet,
            openReadProgressPanel: openReadProgressPanel,
            createWebSocket: function() {
                return new WebSocket(buildWsUrl());
            },
            getSessionManage: getSessionManageModule,
            getGroupManage: getGroupManageModule
        });
    }

    function handleActionSheetSecondaryAction() {
        if (state.actionSheetMode === 'group_menu') {
            closeActionSheet();
            openSettingsPanel(getActiveSession());
            return;
        }
        closeActionSheet();
    }

    function handleActionSheetPrimaryAction() {
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
    }

    function initOverlayModule() {
        const overlayModule = getOverlayModule();
        const sessionManageModule = getSessionManageModule();
        const groupManageModule = getGroupManageModule();
        if (!overlayModule) return;
        overlayModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            get elements() {
                return {
                    actionSheetEl: actionSheetEl,
                    actionSheetRecallBtn: actionSheetRecallBtn,
                    actionSheetCancelBtn: actionSheetCancelBtn,
                    progressPanelEl: progressPanelEl,
                    progressPanelBodyEl: progressPanelBodyEl,
                    settingsPanelEl: settingsPanelEl,
                    settingsPanelBodyEl: settingsPanelBodyEl,
                    groupInfoTitleEl: groupInfoTitleEl,
                    memberActionPageEl: memberActionPageEl,
                    memberActionBodyEl: memberActionBodyEl,
                    memberActionSearchEl: memberActionSearchEl,
                    memberActionTitleEl: memberActionTitleEl,
                    memberActionSubmitBtnEl: memberActionSubmitBtnEl,
                    dialogEl: dialogEl,
                    dialogTitleEl: dialogTitleEl,
                    dialogMessageEl: dialogMessageEl,
                    dialogCancelBtnEl: dialogCancelBtnEl,
                    dialogConfirmBtnEl: dialogConfirmBtnEl
                };
            },
            escapeHtml: escapeHtml,
            request: request,
            render: render,
            canRecallMessage: canRecallMessage,
            getActiveSession: getActiveSession,
            isGroupSession: isGroupSession,
            closeActionSheet: closeActionSheet,
            closeReadProgressPanel: closeReadProgressPanel,
            closeMemberPanel: closeMemberPanel,
            closeSettingsPanel: closeSettingsPanel,
            sessionManage: sessionManageModule,
            groupManage: groupManageModule,
            buildAvatarBoxMarkup: buildAvatarBoxMarkup,
            sortGroupMembersForDisplay: sortGroupMembersForDisplay,
            formatSessionMember: formatSessionMember,
            buildGroupAvatarMosaicMarkup: buildGroupAvatarMosaicMarkup,
            onActionSheetPrimary: handleActionSheetPrimaryAction,
            onActionSheetSecondary: handleActionSheetSecondaryAction,
            onDialogConfirm: submitDialogAction
        });
    }

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
        if (root && root.isConnected) return;
        if (root && !root.isConnected) root = null;
        const appShellModule = getAppShellModule();
        if (appShellModule) {
            appShellModule.ensureRoot();
            return;
        }
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
                #ak-im-root .ak-im-profile-history-section + .ak-im-profile-history-section{margin-top:18px}
                #ak-im-root .ak-im-profile-history-section-head{margin-top:14px;display:flex;align-items:center;justify-content:space-between;gap:12px}
                #ak-im-root .ak-im-profile-history-section-head .ak-im-profile-entry-label{font-size:18px;font-weight:700;line-height:1.35}
                #ak-im-root .ak-im-profile-history-section-count{font-size:13px;color:#94a3b8;font-weight:600;line-height:1.4;white-space:nowrap}
                #ak-im-root .ak-im-profile-history-grid{margin-top:14px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
                #ak-im-root .ak-im-profile-history-item{position:relative;min-height:188px;background:#f8fafc;border:1px solid #eef2f7;border-radius:18px;padding:14px 12px 16px;box-sizing:border-box}
                #ak-im-root .ak-im-profile-history-item.is-current{border-color:rgba(7,193,96,.26);box-shadow:0 10px 22px rgba(7,193,96,.08)}
                #ak-im-root .ak-im-profile-history-card{width:100%;border:none;background:transparent;padding:40px 0 0;display:flex;flex-direction:column;align-items:center;text-align:center;cursor:pointer;color:#0f172a}
                #ak-im-root .ak-im-profile-history-card:disabled{cursor:default;opacity:1}
                #ak-im-root .ak-im-profile-history-avatar{width:80px;height:80px;border-radius:22px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;overflow:hidden}
                #ak-im-root .ak-im-profile-history-current{position:absolute;top:10px;left:10px;display:inline-flex;align-items:center;justify-content:center;min-height:24px;padding:0 9px;border-radius:999px;background:#dcfce7;color:#166534;font-size:11px;font-weight:700;line-height:1;box-shadow:0 1px 2px rgba(22,101,52,.08)}
                #ak-im-root .ak-im-profile-history-remove{position:absolute;top:11px;right:11px;width:21px;height:21px;border:1px solid rgba(239,68,68,.18);border-radius:999px;background:#fee2e2;color:#dc2626;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:none}
                #ak-im-root .ak-im-profile-history-remove:disabled{opacity:.46;cursor:not-allowed;box-shadow:none}
                #ak-im-root .ak-im-profile-history-remove-mark{display:block;font-size:15px;font-weight:800;line-height:1;transform:translateY(-1px)}
                #ak-im-root .ak-im-profile-history-favorite{position:absolute;right:10px;bottom:12px;width:28px;height:28px;border:none;border-radius:999px;background:#ffffff;color:#94a3b8;font-size:16px;font-weight:700;line-height:1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 12px rgba(15,23,42,.08)}
                #ak-im-root .ak-im-profile-history-favorite.is-active{background:#fef3c7;color:#d97706}
                #ak-im-root .ak-im-profile-history-favorite:disabled{opacity:.46;cursor:not-allowed;box-shadow:none}
                #ak-im-root .ak-im-profile-history-time{font-size:12px;color:#6b7280;line-height:1.5}
                #ak-im-root .ak-im-profile-history-hint{margin-top:2px;font-size:12px;color:#94a3b8;line-height:1.45}
                #ak-im-root .ak-im-profile-history-item.is-current .ak-im-profile-history-hint{color:#16a34a;font-weight:600}
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
                #ak-im-root .ak-im-home-tab-btn svg{width:22px;height:22px;stroke:currentColor}
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
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.75C6.5 5.78 7.28 5 8.4 5H13.05C14.24 5 15.2 5.78 15.2 6.75V9.85C15.2 11.04 14.24 12 13.05 12H10.15L7.45 14.08C7.17 14.3 6.75 14.1 6.75 13.75V12H6.25V6.75Z" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
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
        assignShellElements(collectFallbackShellElements(root));
        initShellModules();
        root.querySelector('.ak-im-launcher').addEventListener('click', openShellPanel);
        root.querySelector('.ak-im-close').addEventListener('click', function() {
            showSessionsView({ closePanel: true });
        });
        root.querySelector('.ak-im-back').addEventListener('click', showSessionsView);
        chatMenuBtnEl.addEventListener('click', openActiveGroupMenu);
        chatTitleBtnEl.addEventListener('click', openActiveGroupSettings);
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
            handleComposerInput(inputEl.value || '');
        });
        newSessionInputEl.addEventListener('input', function() {
            handleNewSessionInputChange(newSessionInputEl.value || '');
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
	    bindOverlayEvents();
	    memberPanelEl.querySelector('.ak-im-member-mask').addEventListener('click', function() {
	        closeMemberPanel();
	    });
        memberPanelEl.querySelector('.ak-im-member-close').addEventListener('click', function() {
            closeMemberPanel();
        });
        root.querySelector('.ak-im-profile-subpage-back').addEventListener('click', closeProfileSubpage);
        syncInputHeight();
        syncComposerState();
    }

	function bindOverlayEvents() {
	    const overlayModule = getOverlayModule();
	    if (overlayModule && typeof overlayModule.bindEvents === 'function') {
	        overlayModule.bindEvents();
	        return;
	    }
	    actionSheetEl.querySelector('.ak-im-action-mask').addEventListener('click', function() {
	        closeActionSheet();
	    });
	    actionSheetCancelBtn.addEventListener('click', function() {
	        handleActionSheetSecondaryAction();
	    });
	    actionSheetRecallBtn.addEventListener('click', function() {
	        handleActionSheetPrimaryAction();
	    });
	    progressPanelEl.querySelector('.ak-im-progress-mask').addEventListener('click', function() {
	        closeReadProgressPanel();
	    });
	    progressPanelEl.querySelector('.ak-im-progress-close').addEventListener('click', function() {
	        closeReadProgressPanel();
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
	    settingsPanelEl.querySelector('.ak-im-group-info-back').addEventListener('click', function() {
	        closeSettingsPanel();
	    });
	    memberActionPageEl.querySelector('.ak-im-member-action-back').addEventListener('click', function() {
	        closeDialog({ silent: true, force: true });
	        closeMemberActionPage();
	    });
	    memberActionSearchEl.addEventListener('input', function() {
	        state.memberActionKeyword = memberActionSearchEl.value || '';
	        renderMemberActionPage();
	    });
	    memberActionSubmitBtnEl.addEventListener('click', function() {
	        submitMemberActionPage();
	    });
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
        const sessionManageModule = getSessionManageModule();
        if (sessionManageModule && typeof sessionManageModule.getActiveSession === 'function') {
            return sessionManageModule.getActiveSession();
        }
        return state.sessions.find(function(item) {
            return Number(item && item.conversation_id || 0) === Number(state.activeConversationId || 0);
        }) || null;
    }

    function isGroupSession(item) {
        const sessionManageModule = getSessionManageModule();
        if (sessionManageModule && typeof sessionManageModule.isGroupSession === 'function') {
            return sessionManageModule.isGroupSession(item);
        }
        return String(item && item.conversation_type || '').toLowerCase() === 'group';
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

    function canRecallMessage(item) {
        const messageManageModule = getMessageManageModule();
        if (messageManageModule && typeof messageManageModule.canRecallMessage === 'function') {
            return messageManageModule.canRecallMessage(item);
        }
        return false;
    }

    function updateActionSheetUI() {
        return;
    }

    function openActionSheet(messageItem) {
        const overlayModule = getOverlayModule();
        if (overlayModule && typeof overlayModule.openActionSheet === 'function') {
            overlayModule.openActionSheet(messageItem);
            return;
        }
        const messageId = Number(messageItem && messageItem.id || 0);
        if (!messageId || !canRecallMessage(messageItem)) return;
        if (window.confirm('撤回这条消息？')) {
            recallMessage(messageId, Number(messageItem && messageItem.conversation_id || state.activeConversationId || 0), String(messageItem && (messageItem.content || messageItem.content_preview || '') || ''));
        }
    }

    function openGroupMenu(sessionItem) {
        if (!sessionItem || !isGroupSession(sessionItem)) return;
        openSettingsPanel(sessionItem);
    }

    function openSessionActionSheet(sessionItem) {
        const overlayModule = getOverlayModule();
        if (overlayModule && typeof overlayModule.openSessionActionSheet === 'function') {
            overlayModule.openSessionActionSheet(sessionItem);
            return;
        }
        const sessionManageModule = getSessionManageModule();
        if (!sessionItem) return;
        const conversationId = Number(sessionItem.conversation_id || 0);
        const isSystemPinned = !!(sessionManageModule && typeof sessionManageModule.isSessionSystemPinned === 'function' ? sessionManageModule.isSessionSystemPinned(sessionItem) : false);
        if (!conversationId || !sessionManageModule || isSystemPinned) return;
        const nextPinned = !sessionManageModule.isSessionPinned(sessionItem);
        if (window.confirm(nextPinned ? '置顶这个会话？' : '取消置顶这个会话？')) {
            requestSessionPin(conversationId, nextPinned);
        }
    }

    function closeActionSheet() {
        const overlayModule = getOverlayModule();
        if (overlayModule && typeof overlayModule.closeActionSheet === 'function') {
            overlayModule.closeActionSheet();
            return;
        }
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
        return '';
    }

    function renderReadProgressPanel() {
        const overlayModule = getOverlayModule();
        if (overlayModule && typeof overlayModule.renderReadProgressPanel === 'function') {
            overlayModule.renderReadProgressPanel();
            return;
        }
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
        progressPanelBodyEl.innerHTML = '<div class="ak-im-progress-empty">消息读进度模块暂不可用，请刷新页面后重试</div>';
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
	    memberPanelBodyEl.innerHTML = '<div class="ak-im-member-summary">共 ' + escapeHtml(String(Number(detail.member_count || sortedMembers.length || 0))) + ' 人</div><div class="ak-im-member-list">' + (sortedMembers.length ? sortedMembers.map(formatSessionMember).join('') : '<div class="ak-im-member-empty">当前群里还没有成员</div>') + '</div>';
	}

	function getMemberActionConfig(mode) {
	    const groupManageModule = getGroupManageModule();
	    if (!groupManageModule || typeof groupManageModule.getMemberActionConfig !== 'function') return null;
	    return groupManageModule.getMemberActionConfig(mode);
	}

	function focusMemberActionSearch() {
	    const overlayModule = getOverlayModule();
	    if (overlayModule && typeof overlayModule.focusMemberActionSearch === 'function') {
	        overlayModule.focusMemberActionSearch();
	    }
	}

	function openMemberActionPage(mode) {
	    const overlayModule = getOverlayModule();
	    if (overlayModule && typeof overlayModule.openMemberActionPage === 'function') {
	        overlayModule.openMemberActionPage(mode);
	        return;
	    }
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
	    const overlayModule = getOverlayModule();
	    if (overlayModule && typeof overlayModule.closeMemberActionPage === 'function') {
	        overlayModule.closeMemberActionPage(options);
	        return;
	    }
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
	    const overlayModule = getOverlayModule();
	    if (overlayModule && typeof overlayModule.toggleMemberActionSelection === 'function') {
	        overlayModule.toggleMemberActionSelection(username);
	        return;
	    }
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
	    const overlayModule = getOverlayModule();
	    if (overlayModule && typeof overlayModule.renderMemberActionPage === 'function') {
	        overlayModule.renderMemberActionPage();
	        return;
	    }
	    if (!memberActionBodyEl || !memberActionSearchEl || !memberActionTitleEl || !memberActionSubmitBtnEl) return;
	    const isOpen = !!state.memberActionOpen;
	    const config = getMemberActionConfig(state.memberActionMode);
	    memberActionTitleEl.textContent = config ? config.title : '选择成员';
	    memberActionSearchEl.value = String(state.memberActionKeyword || '');
	    memberActionSearchEl.disabled = true;
	    memberActionSubmitBtnEl.disabled = true;
	    memberActionSubmitBtnEl.textContent = '确认';
	    memberActionBodyEl.innerHTML = isOpen && config ? '<div class="ak-im-member-action-empty">成员操作模块暂不可用，请刷新后重试</div>' : '';
	}

	    function openDialog(options) {
	    const overlayModule = getOverlayModule();
	    if (overlayModule && typeof overlayModule.openDialog === 'function') {
	        overlayModule.openDialog(options);
	        return;
	    }
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
	    const dialogText = [state.dialogTitle, state.dialogMessage].filter(Boolean).join('\n\n') || '请确认当前操作';
	    if (!state.dialogShowCancel) {
	        window.alert(dialogText);
	        submitDialogAction();
	        return;
	    }
	    if (window.confirm(dialogText)) {
	        submitDialogAction();
	        return;
	    }
	    closeDialog({ force: true });
	}

	function closeDialog(options) {
	    const overlayModule = getOverlayModule();
	    if (overlayModule && typeof overlayModule.closeDialog === 'function') {
	        overlayModule.closeDialog(options);
	        return;
	    }
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
	    const overlayModule = getOverlayModule();
	    if (overlayModule && typeof overlayModule.renderDialog === 'function') {
	        overlayModule.renderDialog();
	        return;
	    }
	    return;
	}

	function submitMemberActionPage() {
	    const groupManageModule = getGroupManageModule();
	    if (groupManageModule && typeof groupManageModule.submitMemberActionPage === 'function') {
	        groupManageModule.submitMemberActionPage();
	        return;
	    }
	    if (!state.memberActionOpen) return;
	    state.memberActionError = '成员操作模块暂不可用，请刷新后重试';
	    renderMemberActionPage();
	}

	function submitDialogAction() {
	    if (!state.dialogOpen || state.dialogSubmitting) return;
	    const groupManageModule = getGroupManageModule();
	    if (groupManageModule && typeof groupManageModule.handleDialogAction === 'function' && groupManageModule.handleDialogAction(state.dialogAction, state.dialogPayload || null)) {
	        return;
	    }
	    if (state.dialogAction === 'profile_avatar_remove') {
	        executeProfileAvatarRemoveRequest(Number(state.dialogPayload && state.dialogPayload.historyId || 0));
	        return;
	    }
	    closeDialog();
	}

	function renderSettingsPanel() {
	    const overlayModule = getOverlayModule();
	    if (overlayModule && typeof overlayModule.renderSettingsPanel === 'function') {
	        overlayModule.renderSettingsPanel();
	        return;
	    }
	    if (!settingsPanelEl || !settingsPanelBodyEl) return;
	    if (groupInfoTitleEl) groupInfoTitleEl.textContent = '聊天信息';
	    if (!state.groupSettingsOpen) {
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
	    settingsPanelBodyEl.innerHTML = '<div class="ak-im-group-info-empty">群设置模块暂不可用，请刷新后重试</div>';
	}

	function closeSettingsPanel(options) {
	    const overlayModule = getOverlayModule();
	    const silent = !!(options && options.silent);
	    if (overlayModule && typeof overlayModule.closeSettingsPanel === 'function') {
	        overlayModule.closeSettingsPanel(options);
	        return;
	    }
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
	    if (!silent) render();
	}

	function loadGroupSettings(conversationId) {
	    const groupManageModule = getGroupManageModule();
	    if (groupManageModule && typeof groupManageModule.loadGroupSettings === 'function') {
	        return groupManageModule.loadGroupSettings(conversationId);
	    }
	    const targetConversationId = Number(conversationId || 0);
	    if (!targetConversationId) return Promise.resolve(null);
	    state.groupSettingsLoading = false;
	    state.groupSettingsError = '群设置模块暂不可用，请刷新后重试';
	    state.groupSettingsConversationId = targetConversationId;
	    state.groupSettingsData = null;
	    renderSettingsPanel();
	    return Promise.resolve(null);
	}

	function openSettingsPanel(sessionItem) {
	    const overlayModule = getOverlayModule();
	    if (overlayModule && typeof overlayModule.openSettingsPanel === 'function') {
	        overlayModule.openSettingsPanel(sessionItem);
	        return;
	    }
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

    function closeReadProgressPanel() {
        const overlayModule = getOverlayModule();
        if (overlayModule && typeof overlayModule.closeReadProgressPanel === 'function') {
            overlayModule.closeReadProgressPanel();
            return;
        }
        state.readProgressOpen = false;
        state.readProgressLoading = false;
        state.readProgressError = '';
        state.readProgressMessageId = 0;
        state.readProgressData = null;
        renderReadProgressPanel();
    }

    function openReadProgressPanel(messageItem) {
        const overlayModule = getOverlayModule();
        if (overlayModule && typeof overlayModule.openReadProgressPanel === 'function') {
            overlayModule.openReadProgressPanel(messageItem);
            return;
        }
        const messageId = Number(messageItem && messageItem.id || 0);
        if (!messageId) return;
	    closeMemberPanel();
	    closeSettingsPanel({ silent: true });
        state.readProgressOpen = true;
        state.readProgressLoading = false;
        state.readProgressError = '';
        state.readProgressMessageId = messageId;
        state.readProgressData = null;
        renderReadProgressPanel();
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
        const sessionManageModule = getSessionManageModule();
        if (sessionManageModule && typeof sessionManageModule.requestSessionPin === 'function') {
            sessionManageModule.requestSessionPin(conversationId, pinned);
            return;
        }
        closeActionSheet();
        window.alert('会话模块暂不可用，请刷新后重试');
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

    function hasUnreadSessions() {
        const sessionManageModule = getSessionManageModule();
        return state.sessions.some(function(item) {
            if (sessionManageModule && typeof sessionManageModule.getUnreadCount === 'function') {
                return sessionManageModule.getUnreadCount(item) > 0;
            }
            return Number(item && (item.unread_count || item.unread || 0) || 0) > 0;
        });
    }

    function getHomeSearchPillText(tab) {
        const normalizedTab = normalizeHomeTab(tab);
        if (normalizedTab === 'contacts') {
            return state.contactsLoading ? '正在同步同白名单通讯录' : '同白名单成员会显示在这里，点击可直接发起聊天';
        }
        if (normalizedTab === 'me') {
            return '这里保留更换头像、个人资料、设置三个入口';
        }
        return state.sessions.length ? '长按会话可置顶，点击进入聊天' : '点击右上角发起单聊';
    }

    function getShellRenderState() {
        const activeSession = getActiveSession();
        const homeTab = normalizeHomeTab(state.homeTab);
        const showChat = !!activeSession && state.view === 'chat';
        const showCompose = state.view === 'compose';
        const showGroupInfo = state.view === 'group_info' && !!state.groupSettingsOpen;
        const showMemberAction = state.view === 'member_action' && !!state.memberActionOpen;
        const showProfileSubpage = isProfileSubpageView(state.view);
        state.homeTab = homeTab;
        return {
            allowed: !!state.allowed,
            open: !!state.open,
            showSessions: !showChat && !showCompose && !showGroupInfo && !showMemberAction && !showProfileSubpage,
            showChat: !!showChat,
            showCompose: !!showCompose,
            showGroupInfo: !!showGroupInfo,
            showMemberAction: !!showMemberAction,
            showProfileSubpage: !!showProfileSubpage,
            hasUnread: hasUnreadSessions(),
            homeTab: homeTab,
            homeTabTitle: getHomeTabTitle(homeTab),
            showSessionNewButton: homeTab === 'chats',
            searchPillText: getHomeSearchPillText(homeTab)
        };
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
        state.profileAvatarActionError = '';
        state.profileAvatarHistoryActionId = 0;
        state.profileAvatarHistoryActionType = '';
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
        state.profileAvatarActionError = '';
        state.profileAvatarHistoryActionId = 0;
        state.profileAvatarHistoryActionType = '';
        if (!state.profileLoaded && !state.profileLoading) {
            loadProfile();
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

    function renderHomeShell(shellState) {
        if (!root) return;
        const nextShellState = shellState || getShellRenderState();
        if (sessionTopbarTitleEl) {
            sessionTopbarTitleEl.textContent = nextShellState.homeTabTitle;
        }
        if (sessionNewBtnEl) {
            sessionNewBtnEl.classList.toggle('is-hidden', !nextShellState.showSessionNewButton);
        }
        const searchPill = root.querySelector('.ak-im-search-pill');
        if (searchPill) {
            searchPill.textContent = nextShellState.searchPillText;
        }
        Array.prototype.forEach.call(root.querySelectorAll('[data-im-home-tab]'), function(button) {
            button.classList.toggle('is-active', button.getAttribute('data-im-home-tab') === nextShellState.homeTab);
        });
        Array.prototype.forEach.call(root.querySelectorAll('[data-im-home-panel]'), function(panelNode) {
            panelNode.classList.toggle('is-active', panelNode.getAttribute('data-im-home-panel') === nextShellState.homeTab);
        });
    }

    function renderSessionList() {
        const sessionManageModule = getSessionManageModule();
        if (sessionManageModule && typeof sessionManageModule.renderSessionList === 'function') {
            sessionManageModule.renderSessionList();
            return;
        }
        if (!root || !sessionList) return;
        sessionList.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'ak-im-empty';
        empty.textContent = state.sessions.length ? '会话模块暂不可用，请刷新后重试' : (state.allowed ? '暂无会话\n点击右上角“发起”开始单聊' : '当前账号未开通聊天');
        sessionList.appendChild(empty);
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
        const favoriteCount = countProfileAvatarFavorites(state.profileAvatarHistory);
        const avatarHistorySummary = state.profileAvatarHistoryLoading ? '正在同步头像历史' : (state.profileAvatarHistoryLoaded ? (state.profileAvatarHistory.length ? (favoriteCount ? ('已收藏 ' + favoriteCount + ' 个头像，共保存 ' + state.profileAvatarHistory.length + ' 条记录') : ('最近保留 ' + state.profileAvatarHistory.length + ' 个历史头像')) : '切换头像后会在这里保留最近 10 个记录') : '可查看最近 10 个历史头像');
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

        function countProfileAvatarFavorites(items) {
            return (Array.isArray(items) ? items : []).reduce(function(total, item) {
                return total + (item && item.is_favorite ? 1 : 0);
            }, 0);
        }

        function renderProfileSubpage() {
            const profileModule = getProfileModule();
            if (profileModule) {
                profileModule.renderProfileSubpage();
                return;
            }
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
            profileSubpageBodyEl.innerHTML = '<div class="ak-im-profile-panel"><div class="ak-im-empty">个人资料模块暂不可用，请刷新页面后重试</div></div>';
        }

        function syncInputHeight() {
            if (!inputEl) return;
            inputEl.style.height = '22px';
            const nextHeight = Math.min(Math.max(inputEl.scrollHeight, 22), 120);
            inputEl.style.height = `${nextHeight}px`;
        }

        function syncComposerState() {
            if (!inputEl || !sendBtn) return;
            const hasConversation = !!state.activeConversationId;
            const hasMessageManage = !!getMessageManageModule();
            const canSend = hasConversation && hasMessageManage;
            inputEl.disabled = !canSend;
            inputEl.placeholder = hasConversation ? (hasMessageManage ? '输入消息' : '消息模块暂不可用') : '先选择一个会话';
            sendBtn.disabled = !canSend || !String(inputEl.value || '').trim();
        }

    function render() {
        if (!root) return;
        const shellState = getShellRenderState();
        const appShellModule = getAppShellModule();
        if (appShellModule && typeof appShellModule.renderShell === 'function') {
            appShellModule.renderShell(shellState);
        } else {
            root.classList.toggle('ak-visible', !!shellState.allowed);
            root.classList.toggle('ak-im-open', !!shellState.open);
            root.classList.toggle('ak-view-sessions', !!shellState.showSessions);
            root.classList.toggle('ak-view-chat', !!shellState.showChat);
            root.classList.toggle('ak-view-compose', !!shellState.showCompose);
            root.classList.toggle('ak-view-group-info', !!shellState.showGroupInfo);
            root.classList.toggle('ak-view-member-action', !!shellState.showMemberAction);
            root.classList.toggle('ak-view-profile-subpage', !!shellState.showProfileSubpage);
            const launcherEl = root.querySelector('.ak-im-launcher');
            if (launcherEl) {
                launcherEl.classList.toggle('is-open', !!shellState.open);
                launcherEl.classList.toggle('has-unread', !!shellState.hasUnread);
            }
            renderHomeShell(shellState);
        }
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
        if (state.open && state.view === 'compose') focusComposeInput();
	    if (state.open && shellState.showMemberAction) focusMemberActionSearch();
    }

    function renderMessages() {
        const messageManageModule = getMessageManageModule();
        if (messageManageModule && typeof messageManageModule.renderMessages === 'function') {
            messageManageModule.renderMessages();
            return;
        }
        const headerTitle = root ? root.querySelector('.ak-im-chat-title') : null;
        const headerSubtitle = root ? root.querySelector('.ak-im-chat-subtitle') : null;
	    const activeSession = getActiveSession();
	    const sessionManageModule = getSessionManageModule();
	    const activeSessionDisplayName = activeSession && sessionManageModule && typeof sessionManageModule.getSessionDisplayName === 'function' ? sessionManageModule.getSessionDisplayName(activeSession) : '内部聊天';
	    const subtitleText = activeSession && sessionManageModule && typeof sessionManageModule.getSessionSubtitle === 'function' ? sessionManageModule.getSessionSubtitle(activeSession) : '';
	    const canOpenGroupInfo = !!activeSession && isGroupSession(activeSession);
	    if (headerTitle) headerTitle.textContent = activeSession ? activeSessionDisplayName : '内部聊天';
	    if (headerSubtitle) headerSubtitle.textContent = activeSession ? subtitleText : '';
	    if (chatTitleBtnEl) {
	        chatTitleBtnEl.disabled = !canOpenGroupInfo;
	        chatTitleBtnEl.classList.toggle('is-clickable', canOpenGroupInfo);
	        chatTitleBtnEl.setAttribute('aria-label', canOpenGroupInfo ? '打开群信息' : '聊天标题');
	    }
	    if (chatMenuBtnEl) {
	        chatMenuBtnEl.disabled = !canOpenGroupInfo;
	        chatMenuBtnEl.classList.toggle('is-hidden', !canOpenGroupInfo);
	    }
        if (!messageList) return;
        messageList.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'ak-im-empty';
        empty.textContent = state.activeConversationId ? '消息模块暂不可用，请刷新页面后重试' : (state.allowed ? '选择一个会话\n开始内部单聊' : '当前账号未开通聊天');
        messageList.appendChild(empty);
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
            id: Number(item && item.id || 0),
            avatar_style: String(item && item.avatar_style || 'thumbs').trim() || 'thumbs',
            avatar_url: getAvatarUrl(item && item.avatar_url),
            is_favorite: !!(item && item.is_favorite),
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

    function runProfileAvatarHistoryAction(actionType, historyId, requestFactory, fallbackMessage, options) {
        if (!state.allowed || state.profileAvatarHistoryActionType) return Promise.resolve(null);
        const targetHistoryId = Number(historyId || 0);
        if (!targetHistoryId) return Promise.resolve(null);
        const config = options || {};
        state.profileAvatarActionError = '';
        state.profileAvatarHistoryActionId = targetHistoryId;
        state.profileAvatarHistoryActionType = String(actionType || '');
        render();
        return Promise.resolve().then(requestFactory).then(function(data) {
            state.profileAvatarHistoryActionId = 0;
            state.profileAvatarHistoryActionType = '';
            if (typeof config.onSuccess === 'function') config.onSuccess(data);
            const tasks = [];
            if (config.reloadLinkedData) tasks.push(reloadProfileLinkedData());
            if (state.view === 'profile_avatar' || state.profileAvatarHistoryLoaded) {
                tasks.push(loadProfileAvatarHistory(true));
            }
            if (!tasks.length) {
                render();
                return data;
            }
            return Promise.all(tasks).then(function() {
                render();
                return data;
            });
        }).catch(function(error) {
            state.profileAvatarHistoryActionId = 0;
            state.profileAvatarHistoryActionType = '';
            state.profileAvatarActionError = error && error.message ? error.message : fallbackMessage;
            render();
            return null;
        });
    }

    function selectProfileAvatar(historyId) {
        return runProfileAvatarHistoryAction('select', historyId, function() {
            return request(`${HTTP_ROOT}/profile/avatar/select`, {
                method: 'POST',
                body: JSON.stringify({ history_id: Number(historyId || 0) })
            });
        }, '切换历史头像失败', {
            onSuccess: function(data) {
                state.profileLoaded = true;
                state.profileError = '';
                applyProfileItem(data && data.item ? data.item : null);
            },
            reloadLinkedData: true
        });
    }

    function setProfileAvatarFavorite(historyId, favorite) {
        return runProfileAvatarHistoryAction('favorite', historyId, function() {
            return request(`${HTTP_ROOT}/profile/avatar/favorite`, {
                method: 'POST',
                body: JSON.stringify({
                    history_id: Number(historyId || 0),
                    favorite: !!favorite
                })
            });
        }, favorite ? '收藏头像失败' : '取消收藏失败');
    }

    function requestProfileAvatarRemove(historyId) {
        return runProfileAvatarHistoryAction('remove', historyId, function() {
            return request(`${HTTP_ROOT}/profile/avatar/remove`, {
                method: 'POST',
                body: JSON.stringify({ history_id: Number(historyId || 0) })
            });
        }, '删除头像失败');
    }

    function openProfileAvatarRemoveDialog(historyId) {
        const targetHistoryId = Number(historyId || 0);
        if (!targetHistoryId || state.profileAvatarHistoryActionType) return;
        openDialog({
            title: '删除头像',
            message: '删除后会从收藏或历史中移除；如果它正被当前使用，当前头像不会立即变化。',
            confirmText: '删除',
            cancelText: '取消',
            danger: true,
            action: 'profile_avatar_remove',
            payload: { historyId: targetHistoryId }
        });
    }

    function executeProfileAvatarRemoveRequest(historyId) {
        const targetHistoryId = Number(historyId || 0);
        if (!targetHistoryId) {
            closeDialog({ force: true });
            return;
        }
        state.dialogSubmitting = true;
        renderDialog();
        requestProfileAvatarRemove(targetHistoryId).then(function() {
            closeDialog({ silent: true, force: true });
            render();
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
        state.profileAvatarActionError = '';
        state.profileAvatarHistoryActionId = 0;
        state.profileAvatarHistoryActionType = '';
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
            state.profileAvatarHistoryActionId = 0;
            state.profileAvatarHistoryActionType = '';
            state.profileAvatarActionError = '';
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
            state.profileAvatarHistoryActionId = 0;
            state.profileAvatarHistoryActionType = '';
            state.profileAvatarActionError = '';
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
        const sessionManageModule = getSessionManageModule();
        if (sessionManageModule && typeof sessionManageModule.loadSessions === 'function') {
            return sessionManageModule.loadSessions();
        }
        state.sessions = [];
        if (Number(state.activeConversationId || 0) > 0) {
            state.activeConversationId = 0;
            state.activeMessages = [];
            closeReadProgressPanel();
	        closeMemberPanel();
	        closeSettingsPanel({ silent: true });
            if (state.view === 'chat') state.view = 'sessions';
        }
        render();
        return Promise.resolve(null);
    }

    function loadMessages(conversationId) {
        const messageManageModule = getMessageManageModule();
        if (messageManageModule && typeof messageManageModule.loadMessages === 'function') {
            return messageManageModule.loadMessages(conversationId);
        }
        state.activeMessages = [];
        render();
        return Promise.resolve(null);
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
        const messageManageModule = getMessageManageModule();
        if (messageManageModule && typeof messageManageModule.sendCurrentMessage === 'function') {
            return messageManageModule.sendCurrentMessage();
        }
        if (Number(state.activeConversationId || 0) > 0) {
            window.alert('消息模块暂不可用，请刷新页面后重试');
        }
        return Promise.resolve(null);
    }

    function recallMessage(messageId, conversationId, draftText) {
        const messageManageModule = getMessageManageModule();
        if (messageManageModule && typeof messageManageModule.recallMessage === 'function') {
            return messageManageModule.recallMessage(messageId, conversationId, draftText);
        }
        return Promise.resolve(null);
    }

    function markRead(conversationId) {
        const messageManageModule = getMessageManageModule();
        if (messageManageModule && typeof messageManageModule.markRead === 'function') {
            messageManageModule.markRead(conversationId);
        }
    }

    function ensureWebSocket() {
        const messageManageModule = getMessageManageModule();
        if (messageManageModule && typeof messageManageModule.ensureWebSocket === 'function') {
            messageManageModule.ensureWebSocket();
        }
    }

    function init() {
        initAppShellModule();
        ensureRoot();
        initProfileModule();
        render();
        loadBootstrap();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.AKIMClient = {
        open: openShellPanel,
        close: function() {
            showSessionsView({ closePanel: true });
        },
        reloadSessions: loadSessions
    };
})();
