(function() {
    'use strict';

    if (window.self !== window.top) return;
    if (window.AKIMClientLoaded) return;
    window.AKIMClientLoaded = true;

    const API_ROOT = window.location.origin;
    const HTTP_ROOT = `${API_ROOT}/im/api`;
    const widgetAssetVersion = String(window.__AK_WIDGET_ASSET_VERSION__ || '').trim();
    const BOOTSTRAP_IDENTITY_RETRY_DELAYS = [120, 250, 500, 900, 1500, 2400, 3600];
    const BOOTSTRAP_REQUEST_RETRY_DELAYS = [800, 1800, 3200];
    const lazyModuleScriptConfigs = {
        profile: {
            selector: 'script[data-ak-im-user-plugin-profile="1"]',
            datasetKey: 'akImUserPluginProfile',
            src: `${API_ROOT}/chat/plugins/im/user/modules/im_profile.js`,
            errorMessage: '个人资料模块加载失败'
        },
        group: {
            selector: 'script[data-ak-im-user-plugin-group-manage="1"]',
            datasetKey: 'akImUserPluginGroupManage',
            src: `${API_ROOT}/chat/plugins/im/user/modules/im_group_manage.js`,
            errorMessage: '群设置模块加载失败'
        },
        groupCreate: {
            selector: 'script[data-ak-im-user-plugin-group-create="1"]',
            datasetKey: 'akImUserPluginGroupCreate',
            src: `${API_ROOT}/chat/plugins/im/user/modules/im_group_create.js`,
            errorMessage: '发起群聊模块加载失败'
        },
        groupTitle: {
            selector: 'script[data-ak-im-user-plugin-group-title="1"]',
            datasetKey: 'akImUserPluginGroupTitle',
            src: `${API_ROOT}/chat/plugins/im/user/modules/im_group_title.js`,
            errorMessage: '群名编辑模块加载失败'
        },
        groupAdmins: {
            selector: 'script[data-ak-im-user-plugin-group-admins="1"]',
            datasetKey: 'akImUserPluginGroupAdmins',
            src: `${API_ROOT}/chat/plugins/im/user/modules/im_group_admins.js`,
            errorMessage: '群管理员模块加载失败'
        },
        plus: {
            selector: 'script[data-ak-im-user-plugin-plus-entry-manage="1"]',
            datasetKey: 'akImUserPluginPlusEntryManage',
            src: `${API_ROOT}/chat/plugins/im/user/modules/im_plus_entry_manage.js`,
            errorMessage: '更多功能模块加载失败'
        },
        emoji: {
            selector: 'script[data-ak-im-user-plugin-emoji-manage="1"]',
            datasetKey: 'akImUserPluginEmojiManage',
            src: `${API_ROOT}/chat/plugins/im/user/modules/im_emoji_manage.js`,
            errorMessage: '表情模块加载失败'
        },
        image: {
            selector: 'script[data-ak-im-user-plugin-image-manage="1"]',
            datasetKey: 'akImUserPluginImageManage',
            src: `${API_ROOT}/chat/plugins/im/user/modules/im_image_manage.js`,
            errorMessage: '图片模块加载失败'
        },
        file: {
            selector: 'script[data-ak-im-user-plugin-file-manage="1"]',
            datasetKey: 'akImUserPluginFileManage',
            src: `${API_ROOT}/chat/plugins/im/user/modules/im_file_manage.js`,
            errorMessage: '文件模块加载失败'
        },
        location: {
            selector: 'script[data-ak-im-user-plugin-location-manage="1"]',
            datasetKey: 'akImUserPluginLocationManage',
            src: `${API_ROOT}/chat/plugins/im/user/modules/im_location_manage.js`,
            errorMessage: '位置模块加载失败'
        },
        voiceHold: {
            selector: 'script[data-ak-im-user-plugin-voice-hold-manage="1"]',
            datasetKey: 'akImUserPluginVoiceHoldManage',
            src: `${API_ROOT}/chat/plugins/im/user/modules/im_voice_hold_manage.js`,
            errorMessage: '语音模块加载失败'
	    },
	    social: {
	        selector: 'script[data-ak-im-user-plugin-social-manage="1"]',
	        datasetKey: 'akImUserPluginSocialManage',
	        src: `${API_ROOT}/chat/plugins/im/user/modules/social/im_social_manage.js`,
	        errorMessage: '社交模块加载失败'
        }
    };
    const lazyModuleLoadPromises = {};
    const lazyModuleInitState = {};
    const initialOpenRequest = getInitialOpenRequest();
    let initialOpenRequestConsumed = false;

    const state = {
        allowed: false,
        loading: false,
        ready: false,
        username: '',
        displayName: '',
        honorName: '',
        canAddFriend: false,
        homeTab: initialOpenRequest ? initialOpenRequest.tab : 'chats',
        contacts: [],
        contactsLoaded: false,
        contactsLoading: false,
        contactsError: '',
        contactSections: [],
        contactSearchKeyword: '',
        contactSearchMode: 'contacts',
        friendSearchResults: [],
        friendSearchLoading: false,
        friendSearchError: '',
        friendSearchActionUsername: '',
        blacklistItems: [],
        blacklistLoaded: false,
        blacklistLoading: false,
        blacklistError: '',
        blacklistActionUsername: '',
        profile: null,
        profileLoaded: false,
        profileLoading: false,
        profileError: '',
        profileRefreshing: false,
        profileAvatarUploading: false,
        profileAvatarUploadProgress: 0,
        profileSaving: false,
        profileSaveError: '',
        profileSettingsSaving: false,
        profileSettingsError: '',
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
        activeMessagesLoading: false,
        ws: null,
        open: !!initialOpenRequest,
        view: 'sessions',
        newSessionTarget: '',
        newSessionError: '',
        lastReadSentByConversation: {},
        actionSheetOpen: false,
        actionSheetMessageId: 0,
        actionSheetConversationId: 0,
        actionSheetCanRecall: false,
        actionSheetDraftText: '',
        actionSheetContactUsername: '',
        actionSheetCustomActions: [],
        recalledDraftByMessageId: {},
        inputValue: '',
        composerMode: 'text',
        voiceHoldSupported: true,
        voiceHoldState: 'idle',
        voiceHoldStatusText: '',
        emojiPanelOpen: false,
        plusPanelOpen: false,
        homeAddMenuOpen: false,
        emojiPanelTab: 'standard',
        emojiAssets: [],
        emojiAssetsLoaded: false,
        emojiAssetsLoading: false,
        emojiAssetsError: '',
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
        groupCreateTitle: '',
        groupCreateTitleError: '',
        groupCreateKeyword: '',
        groupCreateSelectedUsernames: [],
        groupCreateSubmitting: false,
        groupCreateError: '',
        groupTitleEditConversationId: 0,
        groupTitleEditValue: '',
        groupTitleEditOriginal: '',
        groupTitleEditSaving: false,
        groupTitleEditError: '',
        groupAdminsOpen: false,
        groupAdminsLoading: false,
        groupAdminsError: '',
        groupAdminsConversationId: 0,
        groupAdminsKeyword: '',
        groupAdminsActionUsername: '',
        dialogOpen: false,
        dialogTitle: '',
        dialogMessage: '',
        dialogConfirmText: '',
        dialogCancelText: '',
        dialogDanger: false,
        dialogShowCancel: true,
        dialogAction: '',
        dialogSubmitting: false,
        dialogPayload: null,
        externalPageOpen: false,
        externalPageProvider: '',
        externalPageTitle: '',
        externalPageReturnView: 'sessions',
        externalPageReturnHomeTab: 'chats',
        externalPagePayload: null
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
    let composerHoldBtnEl = null;
    let voiceHoldOverlayEl = null;
    let voiceHoldCardEl = null;
    let voiceHoldTimerEl = null;
    let voiceHoldMeterBarEls = null;
    let voiceHoldCancelZoneEl = null;
    let voiceHoldCancelLabelEl = null;
    let sendBtn = null;
    let composerVoiceBtnEl = null;
    let composerMicBtnEl = null;
    let composerEmojiBtnEl = null;
    let composerPlusBtnEl = null;
    let emojiSheetEl = null;
    let plusSheetEl = null;
    let emojiSheetTabsEl = null;
    let emojiSheetBodyEl = null;
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
    let groupCreateBodyEl = null;
    let groupCreateTitleInputEl = null;
    let groupCreateTitleTipEl = null;
    let groupCreateSearchInputEl = null;
    let groupCreateSubmitBtnEl = null;
    let groupTitleEditBodyEl = null;
    let groupTitleEditInputEl = null;
    let groupTitleEditSubmitBtnEl = null;
    let groupAdminsBodyEl = null;
    let meetingPublishBodyEl = null;
    let meetingPublishFooterEl = null;
    let meetingJoinBodyEl = null;
    let externalPageTitleEl = null;
    let externalPageBodyEl = null;
    let dialogEl = null;
    let dialogTitleEl = null;
    let dialogMessageEl = null;
    let dialogCancelBtnEl = null;
    let dialogConfirmBtnEl = null;
    let sessionTopbarTitleEl = null;
    let sessionNewBtnEl = null;
    let homeSearchTriggerBtnEl = null;
    let homeAddTriggerBtnEl = null;
    let homeAddMenuEl = null;
    let contactSearchBackBtnEl = null;
    let contactSearchInputEl = null;
    let contactSearchClearBtnEl = null;
    let contactSearchPageEl = null;
    let shellMode = 'none';
    let composerOutsideDismissBound = false;

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
        composerHoldBtnEl = nextElements.composerHoldBtnEl || null;
        voiceHoldOverlayEl = nextElements.voiceHoldOverlayEl || null;
        voiceHoldCardEl = nextElements.voiceHoldCardEl || null;
        voiceHoldTimerEl = nextElements.voiceHoldTimerEl || null;
        voiceHoldMeterBarEls = nextElements.voiceHoldMeterBarEls || [];
        voiceHoldCancelZoneEl = nextElements.voiceHoldCancelZoneEl || null;
        voiceHoldCancelLabelEl = nextElements.voiceHoldCancelLabelEl || null;
        sendBtn = nextElements.sendBtn || null;
        composerVoiceBtnEl = nextElements.composerVoiceBtnEl || null;
        composerMicBtnEl = nextElements.composerMicBtnEl || null;
        composerEmojiBtnEl = nextElements.composerEmojiBtnEl || null;
        composerPlusBtnEl = nextElements.composerPlusBtnEl || null;
        emojiSheetEl = nextElements.emojiSheetEl || null;
        plusSheetEl = nextElements.plusSheetEl || null;
        emojiSheetTabsEl = nextElements.emojiSheetTabsEl || null;
        emojiSheetBodyEl = nextElements.emojiSheetBodyEl || null;
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
        groupCreateBodyEl = nextElements.groupCreateBodyEl || null;
        groupCreateTitleInputEl = nextElements.groupCreateTitleInputEl || null;
        groupCreateTitleTipEl = nextElements.groupCreateTitleTipEl || null;
        groupCreateSearchInputEl = nextElements.groupCreateSearchInputEl || null;
        groupCreateSubmitBtnEl = nextElements.groupCreateSubmitBtnEl || null;
        groupTitleEditBodyEl = nextElements.groupTitleEditBodyEl || null;
        groupTitleEditInputEl = nextElements.groupTitleEditInputEl || null;
        groupTitleEditSubmitBtnEl = nextElements.groupTitleEditSubmitBtnEl || null;
        groupAdminsBodyEl = nextElements.groupAdminsBodyEl || null;
        meetingPublishBodyEl = nextElements.meetingPublishBodyEl || null;
        meetingPublishFooterEl = nextElements.meetingPublishFooterEl || null;
        meetingJoinBodyEl = nextElements.meetingJoinBodyEl || null;
        externalPageTitleEl = nextElements.externalPageTitleEl || null;
        externalPageBodyEl = nextElements.externalPageBodyEl || null;
        dialogEl = nextElements.dialogEl || null;
        dialogTitleEl = nextElements.dialogTitleEl || null;
        dialogMessageEl = nextElements.dialogMessageEl || null;
        dialogCancelBtnEl = nextElements.dialogCancelBtnEl || null;
        dialogConfirmBtnEl = nextElements.dialogConfirmBtnEl || null;
        sessionTopbarTitleEl = nextElements.sessionTopbarTitleEl || null;
        sessionNewBtnEl = nextElements.sessionNewBtnEl || null;
        homeSearchTriggerBtnEl = nextElements.homeSearchTriggerBtnEl || null;
        homeAddTriggerBtnEl = nextElements.homeAddTriggerBtnEl || null;
        homeAddMenuEl = nextElements.homeAddMenuEl || null;
        contactSearchBackBtnEl = nextElements.contactSearchBackBtnEl || null;
        contactSearchInputEl = nextElements.contactSearchInputEl || null;
        contactSearchClearBtnEl = nextElements.contactSearchClearBtnEl || null;
        contactSearchPageEl = nextElements.contactSearchPageEl || null;
    }

    function collectFallbackShellElements(rootNode) {
        return {
            root: rootNode,
            panel: null,
            sessionList: null,
            contactsListEl: null,
            profilePageEl: null,
            profileSubpageBodyEl: null,
            profileSubpageTitleEl: null,
            messageList: null,
            statusLine: null,
            inputEl: null,
            newSessionInputEl: null,
            composerHoldBtnEl: null,
            voiceHoldOverlayEl: null,
            voiceHoldCardEl: null,
            voiceHoldTimerEl: null,
            voiceHoldMeterBarEls: [],
            voiceHoldCancelZoneEl: null,
            voiceHoldCancelLabelEl: null,
            sendBtn: null,
            composerVoiceBtnEl: null,
            composerMicBtnEl: null,
            composerEmojiBtnEl: null,
            composerPlusBtnEl: null,
            emojiSheetEl: null,
            plusSheetEl: null,
            emojiSheetTabsEl: null,
            emojiSheetBodyEl: null,
            actionSheetEl: null,
            actionSheetRecallBtn: null,
            actionSheetCancelBtn: null,
            progressPanelEl: null,
            progressPanelBodyEl: null,
            memberPanelEl: null,
            memberPanelBodyEl: null,
            chatTitleBtnEl: null,
            settingsPanelEl: null,
            settingsPanelBodyEl: null,
            chatMenuBtnEl: null,
            groupInfoTitleEl: null,
            memberActionPageEl: null,
            memberActionBodyEl: null,
            memberActionSearchEl: null,
            memberActionTitleEl: null,
            memberActionSubmitBtnEl: null,
            groupCreateBodyEl: null,
            groupCreateTitleInputEl: null,
            groupCreateTitleTipEl: null,
            groupCreateSearchInputEl: null,
            groupCreateSubmitBtnEl: null,
            groupTitleEditBodyEl: null,
            groupTitleEditInputEl: null,
            groupTitleEditSubmitBtnEl: null,
            groupAdminsBodyEl: null,
            meetingPublishBodyEl: null,
            meetingPublishFooterEl: null,
            meetingJoinBodyEl: null,
            externalPageTitleEl: null,
            externalPageBodyEl: null,
            dialogEl: null,
            dialogTitleEl: null,
            dialogMessageEl: null,
            dialogCancelBtnEl: null,
            dialogConfirmBtnEl: null,
            sessionTopbarTitleEl: null,
            sessionNewBtnEl: null
        };
    }

    function isFallbackShellActive() {
        return shellMode === 'fallback';
    }

    function getFallbackElement(selector) {
        if (!root) return null;
        return root.querySelector(selector);
    }

    function createFallbackShellRoot() {
        const rootNode = document.createElement('div');
        const launcherEl = document.createElement('button');
        const badgeEl = document.createElement('span');
        const panelEl = document.createElement('div');
        const cardEl = document.createElement('div');
        const titleEl = document.createElement('div');
        const messageEl = document.createElement('div');
        const hintEl = document.createElement('div');
        const closeBtnEl = document.createElement('button');
        rootNode.id = 'ak-im-root';
        rootNode.setAttribute('data-im-shell-mode', 'fallback');
        rootNode.style.cssText = 'display:none;position:fixed;left:calc(50% + 46px);top:calc(env(safe-area-inset-top, 0px) - 10px);z-index:2147483643;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
        launcherEl.type = 'button';
        launcherEl.className = 'ak-im-launcher';
        launcherEl.setAttribute('data-im-fallback', 'launcher');
        launcherEl.setAttribute('aria-label', '内部聊天');
        launcherEl.textContent = 'IM';
        launcherEl.style.cssText = 'width:56px;height:56px;border:none;border-radius:999px;background:rgba(15,23,42,.72);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;position:relative;font-size:14px;font-weight:700;box-shadow:0 12px 28px rgba(15,23,42,.28)';
        badgeEl.setAttribute('data-im-fallback', 'badge');
        badgeEl.setAttribute('aria-hidden', 'true');
        badgeEl.style.cssText = 'display:none;position:absolute;top:10px;right:10px;width:9px;height:9px;border-radius:999px;background:#ef4444';
        launcherEl.appendChild(badgeEl);
        panelEl.setAttribute('data-im-fallback', 'panel');
        panelEl.style.cssText = 'display:none;position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.18);align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
        cardEl.style.cssText = 'width:min(320px,calc(100vw - 32px));background:#ffffff;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.22);padding:20px 18px 16px;box-sizing:border-box';
        titleEl.textContent = '聊天壳层模块未加载';
        titleEl.style.cssText = 'font-size:17px;font-weight:700;color:#111827;line-height:1.4';
        messageEl.setAttribute('data-im-fallback', 'message');
        messageEl.textContent = '请刷新页面后重试';
        messageEl.style.cssText = 'margin-top:10px;font-size:13px;color:#4b5563;line-height:1.7';
        hintEl.textContent = '当前只保留最小降级壳，避免页面崩溃';
        hintEl.style.cssText = 'margin-top:8px;font-size:12px;color:#9ca3af;line-height:1.6';
        closeBtnEl.type = 'button';
        closeBtnEl.setAttribute('data-im-fallback', 'close');
        closeBtnEl.textContent = '关闭';
        closeBtnEl.style.cssText = 'margin-top:16px;width:100%;height:42px;border:none;border-radius:12px;background:#111827;color:#ffffff;font-size:14px;font-weight:600;cursor:pointer';
        cardEl.appendChild(titleEl);
        cardEl.appendChild(messageEl);
        cardEl.appendChild(hintEl);
        cardEl.appendChild(closeBtnEl);
        panelEl.appendChild(cardEl);
        rootNode.appendChild(launcherEl);
        rootNode.appendChild(panelEl);
        launcherEl.addEventListener('click', openShellPanel);
        closeBtnEl.addEventListener('click', function() {
            showSessionsView({ closePanel: true });
        });
        panelEl.addEventListener('click', function(event) {
            if (event.target === panelEl) {
                showSessionsView({ closePanel: true });
            }
        });
        return rootNode;
    }

    function ensureFallbackRoot() {
        if (root && root.isConnected && isFallbackShellActive()) return;
        if (root && root.isConnected) {
            root.remove();
        }
        const fallbackRoot = createFallbackShellRoot();
        document.body.appendChild(fallbackRoot);
        assignShellElements(collectFallbackShellElements(fallbackRoot));
        shellMode = 'fallback';
        initShellModules();
    }

    function renderFallbackShell(shellState) {
        if (!root || !isFallbackShellActive()) return;
        const nextShellState = shellState || getShellRenderState();
        const launcherEl = getFallbackElement('[data-im-fallback="launcher"]');
        const badgeEl = getFallbackElement('[data-im-fallback="badge"]');
        const panelEl = getFallbackElement('[data-im-fallback="panel"]');
        const messageEl = getFallbackElement('[data-im-fallback="message"]');
        root.style.display = nextShellState.allowed ? 'block' : 'none';
        if (launcherEl) {
            launcherEl.style.opacity = nextShellState.open ? '0' : '1';
            launcherEl.style.pointerEvents = nextShellState.open ? 'none' : 'auto';
            launcherEl.style.transform = nextShellState.open ? 'scale(.96)' : 'scale(1)';
            launcherEl.style.color = nextShellState.hasUnread ? '#56c57b' : '#ffffff';
        }
        if (badgeEl) {
            badgeEl.style.display = nextShellState.hasUnread ? 'block' : 'none';
        }
        if (panelEl) {
            panelEl.style.display = nextShellState.open && nextShellState.allowed ? 'flex' : 'none';
        }
        if (messageEl) {
            if (!nextShellState.allowed) {
                messageEl.textContent = '当前账号未开通聊天';
            } else if (state.ready) {
                messageEl.textContent = '聊天壳层模块未加载，请刷新页面后重试';
            } else {
                messageEl.textContent = '正在等待聊天模块初始化';
            }
        }
    }

    function initShellModules() {
        initMessageManageModule();
        initSessionManageModule();
        initOverlayModule();
        initExternalPageModule();
        initMeetingManageModule();
    }

    function openShellPanel() {
        state.open = true;
        if (state.view !== 'compose' && !state.activeConversationId) {
            state.view = 'sessions';
            state.homeTab = 'chats';
            ensureHomeTabData(state.homeTab);
        }
        render();
    }

    function showSessionsView(options) {
        closeActionSheet();
        closeReadProgressPanel();
        closeMemberPanel();
        closeSettingsPanel({ silent: true });
        closeEmojiPicker({ silent: true });
        closePlusPanel({ silent: true });
        closeHomeAddMenu({ silent: true });
        closeGroupCreatePage({ silent: true });
        closeGroupTitleEditPage({ silent: true });
        closeGroupAdminsPage({ silent: true });
        closeExternalPage({ silent: true });
        state.contactSearchKeyword = '';
        state.composerMode = 'text';
        state.voiceHoldState = 'idle';
        state.voiceHoldStatusText = '';
        if (options && options.closePanel) state.open = false;
        state.view = 'sessions';
        render();
    }

    function isHomeTopActionTab(tab) {
        const normalizedTab = normalizeHomeTab(tab);
        return normalizedTab === 'chats' || normalizedTab === 'contacts' || normalizedTab === 'meetings';
    }

    function focusContactSearchInput() {
        if (!contactSearchInputEl) return;
        setTimeout(function() {
            if (!contactSearchInputEl || state.view !== 'contact_search') return;
            try {
                contactSearchInputEl.focus();
                if (typeof contactSearchInputEl.setSelectionRange === 'function') {
                    const value = String(contactSearchInputEl.value || '');
                    contactSearchInputEl.setSelectionRange(value.length, value.length);
                }
            } catch (e) {}
        }, 0);
    }

    function openContactSearch() {
        if (!state.allowed || !isHomeTopActionTab(state.homeTab)) return;
        closeActionSheet();
        closeReadProgressPanel();
        closeMemberPanel();
        closeSettingsPanel({ silent: true });
        closeEmojiPicker({ silent: true });
        closePlusPanel({ silent: true });
        closeHomeAddMenu({ silent: true });
        state.composerMode = 'text';
        state.voiceHoldState = 'idle';
        state.voiceHoldStatusText = '';
	    state.contactSearchMode = 'contacts';
        state.view = 'contact_search';
        if (!state.contactsLoaded && !state.contactsLoading) {
            loadContacts();
        }
        render();
        focusContactSearchInput();
    }

    function closeContactSearch(options) {
        const silent = !!(options && options.silent);
        state.contactSearchKeyword = '';
	    state.contactSearchMode = 'contacts';
	    state.friendSearchLoading = false;
	    state.friendSearchError = '';
	    state.friendSearchResults = [];
	    state.friendSearchActionUsername = '';
        if (state.view === 'contact_search') {
            state.view = 'sessions';
        }
        if (!silent) render();
    }

    function handleContactSearchInputChange(value) {
        state.contactSearchKeyword = String(value || '');
	    if (state.contactSearchMode === 'friend_add') {
	        ensureOptionalLazyModule('social').then(function(socialModule) {
	            if (socialModule && typeof socialModule.handleFriendSearchInputChange === 'function') {
	                socialModule.handleFriendSearchInputChange(state.contactSearchKeyword);
	                return;
	            }
	            render();
	        });
	        return;
	    }
        render();
    }

    function clearContactSearchInput() {
        if (!state.contactSearchKeyword) {
            focusContactSearchInput();
            return;
        }
        state.contactSearchKeyword = '';
        if (state.contactSearchMode === 'friend_add') {
            state.friendSearchLoading = false;
            state.friendSearchError = '';
            state.friendSearchResults = [];
            state.friendSearchActionUsername = '';
        }
        render();
        focusContactSearchInput();
    }

    function openAddFriendSearch() {
        if (!state.allowed) return;
        if (!state.canAddFriend) {
            openDialog({
                title: '提示',
                message: '仅 M3 及以上玩家可添加好友',
                confirmText: '知道了',
                showCancel: false
            });
            return;
        }
        ensureOptionalLazyModule('social').then(function(socialModule) {
            if (!socialModule) {
                openDialog({
                    title: '提示',
                    message: '添加朋友模块暂不可用，请刷新页面后重试',
                    confirmText: '知道了',
                    showCancel: false
                });
                return;
            }
            closeActionSheet();
            closeReadProgressPanel();
            closeMemberPanel();
            closeSettingsPanel({ silent: true });
            closeEmojiPicker({ silent: true });
            closePlusPanel({ silent: true });
            closeHomeAddMenu({ silent: true });
            state.composerMode = 'text';
            state.voiceHoldState = 'idle';
            state.voiceHoldStatusText = '';
            state.contactSearchMode = 'friend_add';
            state.contactSearchKeyword = '';
            state.friendSearchLoading = false;
            state.friendSearchError = '';
            state.friendSearchResults = [];
            state.friendSearchActionUsername = '';
            state.view = 'contact_search';
            render();
            focusContactSearchInput();
        });
    }

    function openStartGroupPlaceholder() {
        state.groupCreateError = '发起群聊模块暂不可用，请刷新页面后重试';
        state.view = 'group_create';
        state.open = true;
        render();
    }

    function openStartGroupPage() {
        if (!state.allowed) return;
        ensureOptionalLazyModule('groupCreate').then(function(groupCreateModule) {
            if (groupCreateModule && typeof groupCreateModule.openPage === 'function') {
                groupCreateModule.openPage();
                return;
            }
            openStartGroupPlaceholder();
        });
    }

    function closeGroupCreatePage(options) {
        const groupCreateModule = getGroupCreateModule();
        if (groupCreateModule && typeof groupCreateModule.closePage === 'function') {
            groupCreateModule.closePage(options);
            return;
        }
        const silent = !!(options && options.silent);
        if (state.groupCreateSubmitting) return;
        state.groupCreateTitle = '';
        state.groupCreateTitleError = '';
        state.groupCreateKeyword = '';
        state.groupCreateSelectedUsernames = [];
        state.groupCreateError = '';
        if (state.view === 'group_create') state.view = 'sessions';
        if (!silent) render();
    }

    function handleGroupCreateTitleInput(value) {
        const groupCreateModule = getGroupCreateModule();
        if (groupCreateModule && typeof groupCreateModule.setTitle === 'function') {
            groupCreateModule.setTitle(value);
            return;
        }
        state.groupCreateTitle = String(value || '');
        if (String(state.groupCreateTitle || '').trim()) state.groupCreateTitleError = '';
        state.groupCreateError = '';
        renderGroupCreatePage();
    }

    function handleGroupCreateSearchInput(value) {
        const groupCreateModule = getGroupCreateModule();
        if (groupCreateModule && typeof groupCreateModule.setKeyword === 'function') {
            groupCreateModule.setKeyword(value);
            return;
        }
        state.groupCreateKeyword = String(value || '');
        renderGroupCreatePage();
    }

    function submitGroupCreatePage() {
        const groupCreateModule = getGroupCreateModule();
        if (groupCreateModule && typeof groupCreateModule.submitPage === 'function') {
            groupCreateModule.submitPage();
        }
    }

    function openGroupTitleEditPage() {
        ensureOptionalLazyModule('groupTitle').then(function(groupTitleModule) {
            if (groupTitleModule && typeof groupTitleModule.openPage === 'function') {
                groupTitleModule.openPage();
                return;
            }
            state.groupTitleEditError = '群名编辑模块暂不可用，请刷新页面后重试';
            state.groupTitleEditValue = String(state.groupSettingsData && state.groupSettingsData.conversation_title || '');
            state.groupTitleEditOriginal = state.groupTitleEditValue;
            state.view = 'group_title_edit';
            render();
        });
    }

    function closeGroupTitleEditPage(options) {
        const groupTitleModule = getGroupTitleModule();
        if (groupTitleModule && typeof groupTitleModule.closePage === 'function') {
            groupTitleModule.closePage(options);
            return;
        }
        const silent = !!(options && options.silent);
        if (state.groupTitleEditSaving) return;
        state.groupTitleEditValue = '';
        state.groupTitleEditOriginal = '';
        state.groupTitleEditError = '';
        if (state.view === 'group_title_edit') state.view = state.groupSettingsOpen ? 'group_info' : (state.activeConversationId ? 'chat' : 'sessions');
        if (!silent) render();
    }

    function handleGroupTitleEditInput(value) {
        const groupTitleModule = getGroupTitleModule();
        if (groupTitleModule && typeof groupTitleModule.setValue === 'function') {
            groupTitleModule.setValue(value);
            return;
        }
        state.groupTitleEditValue = String(value || '');
        state.groupTitleEditError = '';
        renderGroupTitleEditPage();
    }

    function submitGroupTitleEditPage() {
        const groupTitleModule = getGroupTitleModule();
        if (groupTitleModule && typeof groupTitleModule.submitPage === 'function') {
            groupTitleModule.submitPage();
        }
    }

    function closeHomeAddMenu(options) {
        if (!state.homeAddMenuOpen) return;
        state.homeAddMenuOpen = false;
        if (!options || !options.silent) render();
    }

    function toggleHomeAddMenu() {
        if (!state.allowed || !isHomeTopActionTab(state.homeTab) || state.view !== 'sessions') return;
        closeActionSheet();
        closeReadProgressPanel();
        closeMemberPanel();
        closeSettingsPanel({ silent: true });
        closeEmojiPicker({ silent: true });
        closePlusPanel({ silent: true });
        state.composerMode = 'text';
        state.voiceHoldState = 'idle';
        state.voiceHoldStatusText = '';
        state.homeAddMenuOpen = !state.homeAddMenuOpen;
        render();
    }

    function shouldKeepHomeAddMenuOpen(target) {
        if (!target) return false;
        if (homeAddMenuEl && typeof homeAddMenuEl.contains === 'function' && homeAddMenuEl.contains(target)) {
            return true;
        }
        if (homeAddTriggerBtnEl && typeof homeAddTriggerBtnEl.contains === 'function' && homeAddTriggerBtnEl.contains(target)) {
            return true;
        }
        return false;
    }

    function openPublishMeetingFromHomeMenu() {
        const meetingModule = getMeetingManageModule();
        closeHomeAddMenu({ silent: true });
        state.homeTab = 'meetings';
        state.view = 'sessions';
        render();
        if (!meetingModule || typeof meetingModule.openPublish !== 'function') {
            openDialog({
                title: '提示',
                message: '会议功能暂不可用，请刷新页面后重试',
                confirmText: '知道了',
                showCancel: false
            });
            return;
        }
        if (state.meetingsLoaded && typeof meetingModule.markTabSeen === 'function') {
            meetingModule.markTabSeen();
        }
        if (state.meetingsLoading) {
            openDialog({
                title: '提示',
                message: '会议信息加载中，请稍后再试',
                confirmText: '知道了',
                showCancel: false
            });
            return;
        }
        const openPublish = function() {
            if (state.meetingsCanPublish) {
                meetingModule.openPublish();
                return;
            }
            openDialog({
                title: '提示',
                message: state.meetingsError ? ('会议信息加载失败：' + state.meetingsError) : '主群群主或管理员可发布会议',
                confirmText: '知道了',
                showCancel: false
            });
        };
        if (!state.meetingsLoaded && typeof meetingModule.loadMeetings === 'function') {
            meetingModule.loadMeetings().then(function() {
                openPublish();
            });
            return;
        }
        openPublish();
    }

    function closeMeetingPublishPage() {
        const meetingModule = getMeetingManageModule();
        if (meetingModule && typeof meetingModule.closePublish === 'function') {
            meetingModule.closePublish();
            return;
        }
        if (state.view === 'meeting_publish') state.view = 'sessions';
        render();
    }

    function closeMeetingJoinPage() {
        const meetingModule = getMeetingManageModule();
        if (meetingModule && typeof meetingModule.closeJoin === 'function') {
            meetingModule.closeJoin();
            return;
        }
        if (state.view === 'meeting_join') {
            state.homeTab = 'meetings';
            state.view = 'sessions';
        }
        render();
    }

    function getExternalPageModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const externalPageModule = modules.externalPage;
        if (!externalPageModule || typeof externalPageModule.init !== 'function') return null;
        return externalPageModule;
    }

    function initExternalPageModule() {
        const externalPageModule = getExternalPageModule();
        if (!externalPageModule) return;
        externalPageModule.init({
            state: state,
            get elements() {
                return {
                    externalPageTitleEl: externalPageTitleEl,
                    externalPageBodyEl: externalPageBodyEl
                };
            },
            render: render,
            escapeHtml: escapeHtml
        });
    }

    function openExternalPage(options) {
        const externalPageModule = getExternalPageModule();
        if (!externalPageModule || typeof externalPageModule.open !== 'function') return false;
        return !!externalPageModule.open(options || {});
    }

    function closeExternalPage(options) {
        const silent = !!(options && options.silent);
        if (state.view === 'external_page') {
            state.view = state.externalPageReturnView || 'sessions';
            state.homeTab = state.externalPageReturnHomeTab || state.homeTab;
        }
        state.externalPageOpen = false;
        state.externalPageProvider = '';
        state.externalPageTitle = '';
        state.externalPageReturnView = 'sessions';
        state.externalPageReturnHomeTab = 'chats';
        state.externalPagePayload = null;
        if (!silent) render();
    }

    function handleHomeAddMenuAction(action) {
        const actionKey = String(action || '').trim().toLowerCase();
        if (!actionKey) return;
        closeHomeAddMenu({ silent: true });
        render();
        if (actionKey === 'start_group') {
            openStartGroupPage();
            return;
        }
        if (actionKey === 'add_friend') {
            openAddFriendSearch();
            return;
        }
        if (actionKey === 'publish_meeting') {
            openPublishMeetingFromHomeMenu();
        }
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
        if (String(state.inputValue || '').trim()) closePlusPanel({ silent: true });
        syncInputHeight();
        syncComposerState();
    }

    function normalizeComposerMode(value) {
        return String(value || '').trim().toLowerCase() === 'voice' ? 'voice' : 'text';
    }

    function setComposerMode(mode, options) {
        const nextMode = normalizeComposerMode(mode);
        const silent = !!(options && options.silent);
        const shouldFocusInput = !!(options && options.focusInput);
        state.composerMode = nextMode;
        if (nextMode !== 'voice') {
            state.voiceHoldState = 'idle';
            state.voiceHoldStatusText = '';
        }
        if (nextMode === 'voice') {
            closeEmojiPicker({ silent: true });
            closePlusPanel({ silent: true });
            if (inputEl) {
                try {
                    inputEl.blur();
                } catch (e) {}
            }
        }
        if (!silent) {
            render();
        } else {
            syncComposerState();
        }
        if (shouldFocusInput && nextMode === 'text' && inputEl && !inputEl.disabled) {
            setTimeout(function() {
                try {
                    inputEl.focus();
                } catch (e) {}
            }, 0);
        }
    }

    function toggleComposerVoiceMode() {
        if (!state.activeConversationId) return;
        if (String(state.voiceHoldState || '').trim().toLowerCase() === 'sending') return;
        if (normalizeComposerMode(state.composerMode) === 'voice') {
            setComposerMode('text', { focusInput: true });
            return;
        }
        ensureLazyModule('voiceHold').then(function(voiceHoldModule) {
            if (!voiceHoldModule) throw new Error('语音模块暂不可用');
            setComposerMode('voice');
        }).catch(function(error) {
            window.alert(error && error.message ? error.message : '语音模块暂不可用');
        });
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
            buildDisplayNameWithHonorMarkup: buildDisplayNameWithHonorMarkup,
            formatUserDisplayText: formatUserDisplayText,
            escapeHtml: escapeHtml,
            countProfileAvatarFavorites: countProfileAvatarFavorites,
            refreshProfileAvatar: refreshProfileAvatar,
            uploadProfileAvatar: uploadProfileAvatar,
            selectProfileAvatar: selectProfileAvatar,
            setProfileAvatarFavorite: setProfileAvatarFavorite,
            openProfileAvatarRemoveDialog: openProfileAvatarRemoveDialog,
            saveProfileDetail: saveProfileDetail,
            saveProfileHonorVisibility: saveProfileHonorVisibility
        });
    }

	function getSocialModule() {
	    const modules = window.AKIMUserModules;
	    if (!modules || typeof modules !== 'object') return null;
	    const socialModule = modules.social;
	    if (!socialModule || typeof socialModule.init !== 'function') return null;
	    return socialModule;
	}

	function initSocialModule() {
	    const socialModule = getSocialModule();
	    if (!socialModule) return;
	    socialModule.init({
	        state: state,
	        httpRoot: HTTP_ROOT,
	        get elements() {
	            return {
	                contactsListEl: contactsListEl,
	                contactSearchPageEl: contactSearchPageEl,
	                profileSubpageBodyEl: profileSubpageBodyEl
	            };
	        },
	        request: request,
	        render: render,
	        escapeHtml: escapeHtml,
	        buildContactItemInnerMarkup: buildContactItemInnerMarkup,
	        getContactUsername: getContactUsername,
	        openDirectConversation: openDirectConversation,
	        openContactActionSheet: openContactActionSheet,
	        closeActionSheet: closeActionSheet,
	        closeContactSearch: closeContactSearch,
	        loadContacts: loadContacts,
	        loadSessions: loadSessions
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
                shellMode = 'full';
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
            onComposerVoiceToggleClick: toggleComposerVoiceMode,
            onComposerEmojiToggleClick: toggleEmojiPicker,
            onComposerPlusToggleClick: togglePlusPanel,
            onPlusActionClick: handlePlusPanelAction,
            onNewSessionInputChange: handleNewSessionInputChange,
            onMemberPanelClose: closeMemberPanel,
            onProfileSubpageBackClick: closeProfileSubpage,
            onHomeSearchClick: openContactSearch,
            onHomeAddClick: toggleHomeAddMenu,
            onHomeAddMenuAction: handleHomeAddMenuAction,
            onContactSearchBackClick: closeContactSearch,
            onContactSearchInputChange: handleContactSearchInputChange,
            onContactSearchClearClick: clearContactSearchInput,
            onGroupCreateBackClick: closeGroupCreatePage,
            onGroupCreateTitleInput: handleGroupCreateTitleInput,
            onGroupCreateSearchInput: handleGroupCreateSearchInput,
            onGroupCreateSubmitClick: submitGroupCreatePage,
            onGroupTitleEditBackClick: closeGroupTitleEditPage,
            onGroupTitleEditInput: handleGroupTitleEditInput,
            onGroupTitleEditSubmitClick: submitGroupTitleEditPage,
            onGroupAdminsBackClick: closeGroupAdminsPage,
            onMeetingPublishBackClick: closeMeetingPublishPage,
            onMeetingJoinBackClick: closeMeetingJoinPage,
            onExternalPageBackClick: closeExternalPage
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
            closeEmojiPicker: closeEmojiPicker,
            closeMemberPanel: closeMemberPanel,
            closeSettingsPanel: closeSettingsPanel,
            openSessionActionSheet: openSessionActionSheet,
            loadMessages: loadMessages,
            buildAvatarBoxMarkup: buildAvatarBoxMarkup,
            buildDisplayNameWithHonorMarkup: buildDisplayNameWithHonorMarkup,
            buildGroupAvatarMosaicMarkup: buildGroupAvatarMosaicMarkup
        });
    }

    function getMeetingManageModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const meetingManageModule = modules.meetingManage;
        if (!meetingManageModule || typeof meetingManageModule.init !== 'function') return null;
        return meetingManageModule;
    }

    function initMeetingManageModule() {
        const meetingManageModule = getMeetingManageModule();
        if (!meetingManageModule) return;
        meetingManageModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            get elements() {
                return {
                    meetingPublishBodyEl: meetingPublishBodyEl,
                    meetingPublishFooterEl: meetingPublishFooterEl,
                    meetingJoinBodyEl: meetingJoinBodyEl
                };
            },
            render: render,
            escapeHtml: escapeHtml,
            buildDisplayNameWithHonorMarkup: buildDisplayNameWithHonorMarkup,
            openExternalPage: openExternalPage,
            getRoot: function() { return root; }
        });
    }

    function getGroupManageModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const groupManageModule = modules.groupManage;
        if (!groupManageModule || typeof groupManageModule.init !== 'function') return null;
        return groupManageModule;
    }

    function getGroupCreateModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const groupCreateModule = modules.groupCreate;
        if (!groupCreateModule || typeof groupCreateModule.init !== 'function') return null;
        return groupCreateModule;
    }

    function getGroupTitleModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const groupTitleModule = modules.groupTitle;
        if (!groupTitleModule || typeof groupTitleModule.init !== 'function') return null;
        return groupTitleModule;
    }

    function getGroupAdminsModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const groupAdminsModule = modules.groupAdmins;
        if (!groupAdminsModule || typeof groupAdminsModule.init !== 'function') return null;
        return groupAdminsModule;
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
            buildDisplayNameWithHonorMarkup: buildDisplayNameWithHonorMarkup,
            formatUserDisplayText: formatUserDisplayText,
            buildContactItemInnerMarkup: buildContactItemInnerMarkup,
            getContactUsername: getContactUsername,
            loadContacts: loadContacts,
            loadSessions: loadSessions,
            loadMessages: loadMessages,
            sortGroupMembersForDisplay: sortGroupMembersForDisplay,
            openGroupTitleEditPage: openGroupTitleEditPage,
            openGroupAdminsPage: openGroupAdminsPage,
            getGroupAdminsModule: getGroupAdminsModule,
            ensureGroupAdminsModule: function() {
                return ensureOptionalLazyModule('groupAdmins');
            }
        });
    }

    function initGroupAdminsModule() {
        const groupAdminsModule = getGroupAdminsModule();
        if (!groupAdminsModule) return;
        groupAdminsModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            get elements() {
                return {
                    groupAdminsBodyEl: groupAdminsBodyEl,
                    actionSheetEl: actionSheetEl
                };
            },
            request: request,
            render: render,
            escapeHtml: escapeHtml,
            buildAvatarBoxMarkup: buildAvatarBoxMarkup,
            buildDisplayNameWithHonorMarkup: buildDisplayNameWithHonorMarkup,
            getAvatarUrl: getAvatarUrl,
            getActiveSession: getActiveSession,
            isGroupSession: isGroupSession,
            loadSessions: loadSessions,
            loadMessages: loadMessages,
            loadGroupSettings: loadGroupSettings,
            renderActionSheet: renderActionSheet,
            renderSettingsPanel: renderSettingsPanel,
            syncComposerState: syncComposerState,
            openDialog: openDialog,
            closeDialog: closeDialog,
            closeActionSheet: closeActionSheet,
            closeGroupAdminsPage: closeGroupAdminsPage,
            sortGroupMembersForDisplay: sortGroupMembersForDisplay
        });
    }

    function initGroupCreateModule() {
        const groupCreateModule = getGroupCreateModule();
        if (!groupCreateModule) return;
        groupCreateModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            get elements() {
                return {
                    groupCreateBodyEl: groupCreateBodyEl,
                    groupCreateTitleInputEl: groupCreateTitleInputEl,
                    groupCreateTitleTipEl: groupCreateTitleTipEl,
                    groupCreateSearchInputEl: groupCreateSearchInputEl,
                    groupCreateSubmitBtnEl: groupCreateSubmitBtnEl
                };
            },
            request: request,
            render: render,
            escapeHtml: escapeHtml,
            buildContactItemInnerMarkup: buildContactItemInnerMarkup,
            getContactUsername: getContactUsername,
            loadContacts: loadContacts,
            loadSessions: loadSessions,
            loadMessages: loadMessages,
            closeActionSheet: closeActionSheet,
            closeReadProgressPanel: closeReadProgressPanel,
            closeMemberPanel: closeMemberPanel,
            closeSettingsPanel: closeSettingsPanel,
            closeEmojiPicker: closeEmojiPicker,
            closePlusPanel: closePlusPanel,
            closeHomeAddMenu: closeHomeAddMenu
        });
    }

    function initGroupTitleModule() {
        const groupTitleModule = getGroupTitleModule();
        if (!groupTitleModule) return;
        groupTitleModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            get elements() {
                return {
                    groupTitleEditBodyEl: groupTitleEditBodyEl,
                    groupTitleEditInputEl: groupTitleEditInputEl,
                    groupTitleEditSubmitBtnEl: groupTitleEditSubmitBtnEl
                };
            },
            request: request,
            render: render,
            escapeHtml: escapeHtml,
            loadSessions: loadSessions,
            loadMessages: loadMessages,
            loadGroupSettings: loadGroupSettings
        });
    }

    function getMessageManageModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const messageManageModule = modules.messageManage;
        if (!messageManageModule || typeof messageManageModule.init !== 'function') return null;
        return messageManageModule;
    }

    function getImageModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const imageManageModule = modules.imageManage;
        if (!imageManageModule || typeof imageManageModule.init !== 'function') return null;
        return imageManageModule;
    }

    function getFileModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const fileManageModule = modules.fileManage;
        if (!fileManageModule || typeof fileManageModule.init !== 'function') return null;
        return fileManageModule;
    }

    function getPlusEntryModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const plusEntryManageModule = modules.plusEntryManage;
        if (!plusEntryManageModule || typeof plusEntryManageModule.init !== 'function') return null;
        return plusEntryManageModule;
    }

    function getEmojiModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const emojiManageModule = modules.emojiManage;
        if (!emojiManageModule || typeof emojiManageModule.init !== 'function') return null;
        return emojiManageModule;
    }

    function getLocationModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const locationManageModule = modules.locationManage;
        if (!locationManageModule || typeof locationManageModule.init !== 'function') return null;
        return locationManageModule;
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
            requestFormData: requestFormData,
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
            buildDisplayNameWithHonorMarkup: buildDisplayNameWithHonorMarkup,
            buildMessageBubbleMarkup: buildMessageBubbleMarkup,
            getMessageBubbleClassName: getMessageBubbleClassName,
            syncVoiceMessageBubbles: function() {
                const voiceHoldModule = getVoiceHoldModule();
                if (voiceHoldModule && typeof voiceHoldModule.syncMessageBubblePlaybackState === 'function') {
                    voiceHoldModule.syncMessageBubblePlaybackState();
                }
            },
            openActionSheet: openActionSheet,
            closeActionSheet: closeActionSheet,
            openReadProgressPanel: openReadProgressPanel,
            createWebSocket: function() {
                return new WebSocket(buildWsUrl());
            },
            getSessionManage: getSessionManageModule,
            getGroupManage: getGroupManageModule,
            getGroupAdmins: getGroupAdminsModule
        });
    }

    function applySentMessageItem(item) {
        const messageManageModule = getMessageManageModule();
        if (item && messageManageModule && typeof messageManageModule.upsertActiveMessage === 'function' && messageManageModule.upsertActiveMessage(item)) {
            if (typeof messageManageModule.renderMessages === 'function') {
                messageManageModule.renderMessages();
            } else {
                render();
            }
        }
        if (typeof loadSessions === 'function') {
            return loadSessions();
        }
        return Promise.resolve(item || null);
    }

    function insertLocalMessage(item) {
        const messageManageModule = getMessageManageModule();
        if (!item || !messageManageModule || typeof messageManageModule.insertLocalMessage !== 'function') return false;
        const changed = messageManageModule.insertLocalMessage(item);
        if (!changed) return false;
        if (typeof messageManageModule.renderMessages === 'function') {
            messageManageModule.renderMessages();
        } else {
            render();
        }
        return true;
    }

    function updateLocalMessage(tempId, patch) {
        const messageManageModule = getMessageManageModule();
        if (!messageManageModule || typeof messageManageModule.updateLocalMessage !== 'function') return false;
        const changed = messageManageModule.updateLocalMessage(tempId, patch);
        if (!changed) return false;
        if (typeof messageManageModule.renderMessages === 'function') {
            messageManageModule.renderMessages();
        } else {
            render();
        }
        return true;
    }

    function replaceLocalMessage(tempId, item) {
        const messageManageModule = getMessageManageModule();
        if (!messageManageModule || typeof messageManageModule.replaceLocalMessage !== 'function') return false;
        const changed = messageManageModule.replaceLocalMessage(tempId, item);
        if (!changed) return false;
        if (typeof messageManageModule.renderMessages === 'function') {
            messageManageModule.renderMessages();
        } else {
            render();
        }
        return true;
    }

    function removeLocalMessage(tempId) {
        const messageManageModule = getMessageManageModule();
        if (!messageManageModule || typeof messageManageModule.removeLocalMessage !== 'function') return false;
        const changed = messageManageModule.removeLocalMessage(tempId);
        if (!changed) return false;
        if (typeof messageManageModule.renderMessages === 'function') {
            messageManageModule.renderMessages();
        } else {
            render();
        }
        return true;
    }

    function initImageManageModule() {
        const imageModule = getImageModule();
        if (!imageModule) return;
        imageModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            request: request,
            requestFormData: requestFormData,
            escapeHtml: escapeHtml,
            applySentMessageItem: applySentMessageItem,
            insertLocalMessage: insertLocalMessage,
            updateLocalMessage: updateLocalMessage,
            replaceLocalMessage: replaceLocalMessage,
            removeLocalMessage: removeLocalMessage,
            loadSessions: loadSessions
        });
    }

    function initFileManageModule() {
        const fileModule = getFileModule();
        if (!fileModule) return;
        fileModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            requestFormData: requestFormData,
            escapeHtml: escapeHtml,
            applySentMessageItem: applySentMessageItem
        });
    }

    function initLocationModule() {
        const locationModule = getLocationModule();
        if (!locationModule) return;
        locationModule.init({
            state: state,
            request: request,
            escapeHtml: escapeHtml,
            sendLocationMessage: sendLocationMessage
        });
    }

    function initPlusEntryModule() {
        const plusEntryModule = getPlusEntryModule();
        if (!plusEntryModule) return;
        plusEntryModule.init({
            state: state,
            sendImageFile: sendImageFile,
            sendAttachmentFile: sendAttachmentFile,
            openLocationPicker: openLocationPicker
        });
    }

    function initEmojiManageModule() {
        const emojiModule = getEmojiModule();
        if (!emojiModule) return;
        emojiModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            get elements() {
                return {
                    root: root,
                    inputEl: inputEl,
                    composerEmojiBtnEl: composerEmojiBtnEl,
                    emojiSheetEl: emojiSheetEl,
                    emojiSheetTabsEl: emojiSheetTabsEl,
                    emojiSheetBodyEl: emojiSheetBodyEl
                };
            },
            request: request,
            render: render,
            escapeHtml: escapeHtml,
            syncInputHeight: syncInputHeight,
            syncComposerState: syncComposerState,
            sendCustomEmoji: sendCustomEmoji
        });
    }

    function getVoiceHoldModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const voiceHoldModule = modules.voiceHoldManage;
        if (!voiceHoldModule || typeof voiceHoldModule.init !== 'function') return null;
        return voiceHoldModule;
    }

    function initVoiceHoldModule() {
        const voiceHoldModule = getVoiceHoldModule();
        if (!voiceHoldModule) return;
        voiceHoldModule.init({
            state: state,
            httpRoot: HTTP_ROOT,
            get elements() {
                return {
                    root: root,
                    messageList: messageList,
                    composerHoldBtnEl: composerHoldBtnEl,
                    statusLine: statusLine,
                    voiceHoldOverlayEl: voiceHoldOverlayEl,
                    voiceHoldCardEl: voiceHoldCardEl,
                    voiceHoldTimerEl: voiceHoldTimerEl,
                    voiceHoldMeterBarEls: voiceHoldMeterBarEls,
                    voiceHoldCancelZoneEl: voiceHoldCancelZoneEl,
                    voiceHoldCancelLabelEl: voiceHoldCancelLabelEl
                };
            },
            syncComposerState: syncComposerState,
            sendVoiceMessage: sendVoiceMessage,
            escapeHtml: escapeHtml
        });
    }

    function withWidgetAssetVersion(url) {
        try {
            const finalUrl = new URL(String(url || ''), API_ROOT);
            if (widgetAssetVersion) finalUrl.searchParams.set('v', widgetAssetVersion);
            return finalUrl.toString();
        } catch (e) {
            return String(url || '');
        }
    }

    function getLazyModuleInstance(moduleKey) {
        if (moduleKey === 'profile') return getProfileModule();
        if (moduleKey === 'group') return getGroupManageModule();
        if (moduleKey === 'groupCreate') return getGroupCreateModule();
        if (moduleKey === 'groupTitle') return getGroupTitleModule();
        if (moduleKey === 'groupAdmins') return getGroupAdminsModule();
        if (moduleKey === 'plus') return getPlusEntryModule();
        if (moduleKey === 'emoji') return getEmojiModule();
        if (moduleKey === 'image') return getImageModule();
        if (moduleKey === 'file') return getFileModule();
        if (moduleKey === 'location') return getLocationModule();
        if (moduleKey === 'voiceHold') return getVoiceHoldModule();
	    if (moduleKey === 'social') return getSocialModule();
        return null;
    }

    function initLazyModule(moduleKey) {
        const moduleInstance = getLazyModuleInstance(moduleKey);
        if (!moduleInstance) return null;
        if (lazyModuleInitState[moduleKey]) return moduleInstance;
        if (moduleKey === 'profile') initProfileModule();
        else if (moduleKey === 'group') initGroupManageModule();
        else if (moduleKey === 'groupCreate') initGroupCreateModule();
        else if (moduleKey === 'groupTitle') initGroupTitleModule();
        else if (moduleKey === 'groupAdmins') initGroupAdminsModule();
        else if (moduleKey === 'plus') initPlusEntryModule();
        else if (moduleKey === 'emoji') initEmojiManageModule();
        else if (moduleKey === 'image') initImageManageModule();
        else if (moduleKey === 'file') initFileManageModule();
        else if (moduleKey === 'location') initLocationModule();
        else if (moduleKey === 'voiceHold') initVoiceHoldModule();
	    else if (moduleKey === 'social') initSocialModule();
        lazyModuleInitState[moduleKey] = true;
        return getLazyModuleInstance(moduleKey) || moduleInstance;
    }

    function loadLazyModuleScript(moduleKey) {
        const config = lazyModuleScriptConfigs[moduleKey];
        if (!config) return Promise.resolve(null);
        const existingModule = getLazyModuleInstance(moduleKey);
        if (existingModule) return Promise.resolve(existingModule);
        if (lazyModuleLoadPromises[moduleKey]) return lazyModuleLoadPromises[moduleKey];
        lazyModuleLoadPromises[moduleKey] = new Promise(function(resolve, reject) {
            const errorMessage = String(config.errorMessage || '模块加载失败');
            const finalize = function() {
                const moduleInstance = getLazyModuleInstance(moduleKey);
                if (!moduleInstance) {
                    reject(new Error(errorMessage));
                    return;
                }
                resolve(moduleInstance);
            };
            const handleError = function() {
                reject(new Error(errorMessage));
            };
            const existingScript = document.querySelector(config.selector);
            if (existingScript) {
                if (getLazyModuleInstance(moduleKey)) {
                    finalize();
                    return;
                }
                existingScript.addEventListener('load', finalize, { once: true });
                existingScript.addEventListener('error', handleError, { once: true });
                return;
            }
            const script = document.createElement('script');
            script.src = withWidgetAssetVersion(config.src);
            script.async = true;
            script.dataset[config.datasetKey] = '1';
            script.onload = finalize;
            script.onerror = handleError;
            (document.head || document.documentElement || document.body).appendChild(script);
        }).then(function(moduleInstance) {
            lazyModuleLoadPromises[moduleKey] = Promise.resolve(moduleInstance);
            return moduleInstance;
        }, function(error) {
            delete lazyModuleLoadPromises[moduleKey];
            throw error;
        });
        return lazyModuleLoadPromises[moduleKey];
    }

    function ensureLazyModule(moduleKey) {
        const moduleInstance = getLazyModuleInstance(moduleKey);
        if (moduleInstance && lazyModuleInitState[moduleKey]) {
            return Promise.resolve(moduleInstance);
        }
        return loadLazyModuleScript(moduleKey).then(function() {
            return initLazyModule(moduleKey);
        });
    }

    function ensureOptionalLazyModule(moduleKey) {
        return ensureLazyModule(moduleKey).catch(function() {
            return null;
        });
    }

    function ensureChatFeatureModules() {
        return Promise.all([
            ensureOptionalLazyModule('groupAdmins'),
            ensureOptionalLazyModule('voiceHold'),
            ensureOptionalLazyModule('emoji'),
            ensureOptionalLazyModule('image'),
            ensureOptionalLazyModule('file'),
            ensureOptionalLazyModule('location')
        ]);
    }

    function buildMessageBubbleMarkup(item) {
        const voiceHoldModule = getVoiceHoldModule();
        if (voiceHoldModule && typeof voiceHoldModule.buildMessageBubbleMarkup === 'function') {
            const voiceMarkup = voiceHoldModule.buildMessageBubbleMarkup(item);
            if (voiceMarkup) return voiceMarkup;
        }
        const imageModule = getImageModule();
        if (imageModule && typeof imageModule.buildMessageBubbleMarkup === 'function') {
            const imageMarkup = imageModule.buildMessageBubbleMarkup(item);
            if (imageMarkup) return imageMarkup;
        }
        const fileModule = getFileModule();
        if (fileModule && typeof fileModule.buildMessageBubbleMarkup === 'function') {
            const fileMarkup = fileModule.buildMessageBubbleMarkup(item);
            if (fileMarkup) return fileMarkup;
        }
        const locationModule = getLocationModule();
        if (locationModule && typeof locationModule.buildMessageBubbleMarkup === 'function') {
            const locationMarkup = locationModule.buildMessageBubbleMarkup(item);
            if (locationMarkup) return locationMarkup;
        }
        const emojiModule = getEmojiModule();
        if (emojiModule && typeof emojiModule.buildMessageBubbleMarkup === 'function') {
            const emojiMarkup = emojiModule.buildMessageBubbleMarkup(item);
            if (emojiMarkup) return emojiMarkup;
        }
        return escapeHtml(item && (item.content || item.content_preview || '') || '');
    }

    function getMessageBubbleClassName(item) {
        const voiceHoldModule = getVoiceHoldModule();
        if (voiceHoldModule && typeof voiceHoldModule.getMessageBubbleClassName === 'function') {
            const voiceClassName = voiceHoldModule.getMessageBubbleClassName(item);
            if (voiceClassName) return voiceClassName;
        }
        const imageModule = getImageModule();
        if (imageModule && typeof imageModule.getMessageBubbleClassName === 'function') {
            const imageClassName = imageModule.getMessageBubbleClassName(item);
            if (imageClassName) return imageClassName;
        }
        const fileModule = getFileModule();
        if (fileModule && typeof fileModule.getMessageBubbleClassName === 'function') {
            const fileClassName = fileModule.getMessageBubbleClassName(item);
            if (fileClassName) return fileClassName;
        }
        const locationModule = getLocationModule();
        if (locationModule && typeof locationModule.getMessageBubbleClassName === 'function') {
            const locationClassName = locationModule.getMessageBubbleClassName(item);
            if (locationClassName) return locationClassName;
        }
        const emojiModule = getEmojiModule();
        if (emojiModule && typeof emojiModule.getMessageBubbleClassName === 'function') {
            const emojiClassName = emojiModule.getMessageBubbleClassName(item);
            if (emojiClassName) return emojiClassName;
        }
        return '';
    }

    function renderEmojiPanel() {
        const emojiModule = getEmojiModule();
        if (emojiModule && typeof emojiModule.renderEmojiPanel === 'function') {
            emojiModule.renderEmojiPanel();
            return;
        }
        if (!emojiSheetEl) return;
        emojiSheetEl.classList.remove('is-open');
        emojiSheetEl.setAttribute('aria-hidden', 'true');
        emojiSheetEl.setAttribute('inert', '');
        if (emojiSheetTabsEl) emojiSheetTabsEl.innerHTML = '';
        if (emojiSheetBodyEl) emojiSheetBodyEl.innerHTML = '';
    }

    function renderPlusPanel() {
        if (!plusSheetEl) return;
        const shouldOpen = !!state.plusPanelOpen && state.view === 'chat' && !!state.activeConversationId && normalizeComposerMode(state.composerMode) !== 'voice';
        if (!shouldOpen) state.plusPanelOpen = false;
        plusSheetEl.classList.toggle('is-open', shouldOpen);
        if (!shouldOpen) {
            const activeElement = document.activeElement;
            if (activeElement && plusSheetEl.contains(activeElement) && typeof activeElement.blur === 'function') {
                activeElement.blur();
            }
            plusSheetEl.setAttribute('aria-hidden', 'true');
            plusSheetEl.setAttribute('inert', '');
            return;
        }
        plusSheetEl.setAttribute('aria-hidden', 'false');
        plusSheetEl.removeAttribute('inert');
    }

    function toggleEmojiPicker() {
        if (normalizeComposerMode(state.composerMode) === 'voice') {
            state.composerMode = 'text';
        }
        closePlusPanel({ silent: true });
        ensureLazyModule('emoji').then(function(emojiModule) {
            if (emojiModule && typeof emojiModule.togglePicker === 'function') {
                emojiModule.togglePicker();
                return;
            }
            throw new Error('表情模块暂不可用');
        }).catch(function(error) {
            render();
            window.alert(error && error.message ? error.message : '表情模块暂不可用');
        });
    }

    function closeEmojiPicker(options) {
        const emojiModule = getEmojiModule();
        if (emojiModule && typeof emojiModule.closePicker === 'function') {
            emojiModule.closePicker(options || null);
            return;
        }
        if (!state.emojiPanelOpen) return;
        state.emojiPanelOpen = false;
        if (!options || !options.silent) render();
    }

    function togglePlusPanel() {
        if (!state.activeConversationId) return;
        if (normalizeComposerMode(state.composerMode) === 'voice') {
            state.composerMode = 'text';
        }
        closeEmojiPicker({ silent: true });
        state.plusPanelOpen = !state.plusPanelOpen;
        if (state.plusPanelOpen && inputEl) {
            try {
                inputEl.blur();
            } catch (e) {}
        }
        render();
    }

    function closePlusPanel(options) {
        if (!state.plusPanelOpen) return;
        state.plusPanelOpen = false;
        if (!options || !options.silent) render();
    }

    function shouldKeepPlusPanelOpen(target) {
        if (!target) return false;
        if (plusSheetEl && typeof plusSheetEl.contains === 'function' && plusSheetEl.contains(target)) {
            return true;
        }
        if (composerPlusBtnEl && typeof composerPlusBtnEl.contains === 'function' && composerPlusBtnEl.contains(target)) {
            return true;
        }
        return false;
    }

    function shouldKeepEmojiPickerOpen(target) {
        if (!target) return false;
        if (emojiSheetEl && typeof emojiSheetEl.contains === 'function' && emojiSheetEl.contains(target)) {
            return true;
        }
        if (composerEmojiBtnEl && typeof composerEmojiBtnEl.contains === 'function' && composerEmojiBtnEl.contains(target)) {
            return true;
        }
        return false;
    }

    function handleComposerOutsideClick(event) {
        const target = event && event.target ? event.target : null;
        if (state.homeAddMenuOpen) {
            if (shouldKeepHomeAddMenuOpen(target)) return;
            closeHomeAddMenu();
            return;
        }
        if (state.plusPanelOpen) {
            if (shouldKeepPlusPanelOpen(target)) return;
            closePlusPanel();
            return;
        }
        if (state.emojiPanelOpen) {
            if (shouldKeepEmojiPickerOpen(target)) return;
            closeEmojiPicker();
        }
    }

    function bindComposerOutsideDismissEvents() {
        if (composerOutsideDismissBound || !document || typeof document.addEventListener !== 'function') return;
        document.addEventListener('click', handleComposerOutsideClick, true);
        composerOutsideDismissBound = true;
    }

    function handlePlusPanelAction(action) {
        const actionKey = String(action || '').trim().toLowerCase();
        const actionLabelMap = {
            camera: '拍照',
            album: '相册',
            file: '文件',
            location: '位置'
        };
        const actionLabel = actionLabelMap[actionKey] || '更多功能';
        closePlusPanel({ silent: true });
        ensureLazyModule('plus').then(function(plusEntryModule) {
            if (plusEntryModule && typeof plusEntryModule.handleAction === 'function') {
                plusEntryModule.handleAction(actionKey);
                render();
                return;
            }
            render();
            window.alert(actionLabel + '入口已预留，暂未接入真实功能');
        }).catch(function(error) {
            render();
            window.alert(error && error.message ? error.message : (actionLabel + '模块暂不可用'));
        });
    }

    function sendCustomEmoji(emojiAssetId, emojiCode) {
        const messageManageModule = getMessageManageModule();
        if (messageManageModule && typeof messageManageModule.sendCustomEmoji === 'function') {
            return messageManageModule.sendCustomEmoji(emojiAssetId, emojiCode);
        }
        return Promise.resolve(null);
    }

    function sendVoiceMessage(blob, meta) {
        const messageManageModule = getMessageManageModule();
        if (messageManageModule && typeof messageManageModule.sendVoiceMessage === 'function') {
            return messageManageModule.sendVoiceMessage(blob, meta);
        }
        return Promise.reject(new Error('语音发送模块暂不可用'));
    }

    function sendImageFile(file, meta) {
        return ensureLazyModule('image').then(function(imageModule) {
            if (imageModule && typeof imageModule.sendImageFile === 'function') {
                return imageModule.sendImageFile(file, meta);
            }
            return Promise.reject(new Error('图片发送模块暂不可用'));
        });
    }

    function sendAttachmentFile(file) {
        return ensureLazyModule('file').then(function(fileModule) {
            if (fileModule && typeof fileModule.sendAttachmentFile === 'function') {
                return fileModule.sendAttachmentFile(file);
            }
            return Promise.reject(new Error('文件发送模块暂不可用'));
        });
    }

    function sendLocationMessage(payload) {
        const messageManageModule = getMessageManageModule();
        if (!messageManageModule || typeof messageManageModule.sendMessagePayload !== 'function') {
            return Promise.reject(new Error('位置发送模块暂不可用'));
        }
        return messageManageModule.sendMessagePayload({
            message_type: 'location',
            content: JSON.stringify(payload || {})
        }, {
            resetComposer: false
        });
    }

    function openLocationPicker() {
        return ensureLazyModule('location').then(function(locationModule) {
            if (locationModule && typeof locationModule.openPicker === 'function') {
                return locationModule.openPicker();
            }
            return Promise.reject(new Error('位置模块暂不可用'));
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

    function handleActionSheetCustomAction(actionKey) {
        const groupAdminsModule = getGroupAdminsModule();
        if (groupAdminsModule && typeof groupAdminsModule.handleActionSheetAction === 'function') {
            groupAdminsModule.handleActionSheetAction(actionKey);
        }
    }

    function handleActionSheetPrimaryAction() {
        if (state.actionSheetMode === 'group_member' || state.actionSheetMode === 'group_mute_duration') {
            const actions = Array.isArray(state.actionSheetCustomActions) ? state.actionSheetCustomActions : [];
            handleActionSheetCustomAction(actions.length ? actions[0].key : '');
            return;
        }
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
	        if (state.actionSheetMode === 'contact_blacklist_add') {
	            const targetUsername = String(state.actionSheetContactUsername || '').trim().toLowerCase();
	            const socialModule = getSocialModule();
	            closeActionSheet();
	            if (targetUsername && socialModule && typeof socialModule.addToBlacklist === 'function') {
	                socialModule.addToBlacklist(targetUsername);
	            }
	            return;
	        }
	        if (state.actionSheetMode === 'contact_blacklist_remove') {
	            const targetUsername = String(state.actionSheetContactUsername || '').trim().toLowerCase();
	            const socialModule = getSocialModule();
	            closeActionSheet();
	            if (targetUsername && socialModule && typeof socialModule.removeFromBlacklist === 'function') {
	                socialModule.removeFromBlacklist(targetUsername);
	            }
	            return;
	        }
        if (!state.actionSheetCanRecall || !state.actionSheetMessageId) return;
        recallMessage(state.actionSheetMessageId, state.actionSheetConversationId, state.actionSheetDraftText);
    }

    function initOverlayModule() {
        const overlayModule = getOverlayModule();
        const sessionManageModule = getSessionManageModule();
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
            buildDisplayNameWithHonorMarkup: buildDisplayNameWithHonorMarkup,
            request: request,
            render: render,
            canRecallMessage: canRecallMessage,
            getActiveSession: getActiveSession,
            isGroupSession: isGroupSession,
            closeActionSheet: closeActionSheet,
            closeReadProgressPanel: closeReadProgressPanel,
            closeMemberPanel: closeMemberPanel,
            closeSettingsPanel: closeSettingsPanel,
            loadContacts: loadContacts,
            sessionManage: sessionManageModule,
            get groupManage() {
                return getGroupManageModule();
            },
            buildAvatarBoxMarkup: buildAvatarBoxMarkup,
	            getContactUsername: getContactUsername,
            sortGroupMembersForDisplay: sortGroupMembersForDisplay,
            formatSessionMember: formatSessionMember,
            buildGroupAvatarMosaicMarkup: buildGroupAvatarMosaicMarkup,
            onActionSheetPrimary: handleActionSheetPrimaryAction,
            onActionSheetSecondary: handleActionSheetSecondaryAction,
            onActionSheetCustom: handleActionSheetCustomAction,
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
        const cookieUsername = String(getCookie('ak_username') || '').trim().toLowerCase();
        if (cookieUsername) return cookieUsername;
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
        return '';
    }

    function buildRequestHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        const authHeaders = buildAuthHeaders();
        Object.keys(authHeaders).forEach(function(key) {
            headers[key] = authHeaders[key];
        });
        return headers;
    }

    function buildAuthHeaders() {
        const headers = {};
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

    function buildBootstrapUrl() {
        const url = `${HTTP_ROOT}/bootstrap`;
        try {
            const finalUrl = new URL(url);
            const username = getCanonicalUsername();
            if (username) finalUrl.searchParams.set('username', username);
            return finalUrl.toString();
        } catch (e) {
            return url;
        }
    }

    function waitMs(delay) {
        return new Promise(function(resolve) {
            setTimeout(resolve, delay);
        });
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

    function requestFormData(url, formData, options) {
        const requestOptions = Object.assign({
            credentials: 'same-origin',
            method: 'POST'
        }, options || {});
        const headers = Object.assign(buildAuthHeaders(), requestOptions.headers || {});
        const method = String(requestOptions.method || 'POST').trim().toUpperCase() || 'POST';
        const onUploadProgress = typeof requestOptions.onUploadProgress === 'function' ? requestOptions.onUploadProgress : null;
        return new Promise(function(resolve, reject) {
            const xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            xhr.withCredentials = requestOptions.credentials === 'include' || requestOptions.credentials === 'same-origin';
            Object.keys(headers).forEach(function(key) {
                const headerValue = headers[key];
                if (headerValue == null || headerValue === '') return;
                xhr.setRequestHeader(key, headerValue);
            });
            if (xhr.upload && onUploadProgress) {
                xhr.upload.onprogress = function(event) {
                    onUploadProgress({
                        loaded: Number(event && event.loaded || 0) || 0,
                        total: Number(event && event.total || 0) || 0,
                        lengthComputable: !!(event && event.lengthComputable),
                        percent: event && event.lengthComputable && Number(event.total || 0) > 0
                            ? Math.max(0, Math.min(100, Math.round((Number(event.loaded || 0) / Number(event.total || 1)) * 100)))
                            : 0
                    });
                };
            }
            xhr.onerror = function() {
                reject(new Error('network_error'));
            };
            xhr.onload = function() {
                let data = null;
                const rawText = String(xhr.responseText || '').trim();
                if (rawText) {
                    try {
                        data = JSON.parse(rawText);
                    } catch (e) {
                        data = null;
                    }
                }
                if (xhr.status < 200 || xhr.status >= 300) {
                    reject(new Error((data && data.message) || 'request_failed'));
                    return;
                }
                resolve(data || {});
            };
            xhr.send(formData);
        });
    }

    function ensureRoot() {
        if (root && !root.isConnected) {
            assignShellElements({});
        }
        const appShellModule = getAppShellModule();
        if (appShellModule) {
            if (root && root.isConnected && shellMode === 'full') return;
            if (root && root.isConnected && isFallbackShellActive()) {
                root.remove();
                assignShellElements({});
            }
            appShellModule.ensureRoot();
            return;
        }
        ensureFallbackRoot();
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

    function normalizeHonorName(value) {
        return String(value || '').trim();
    }

    function normalizeHonorLevelCode(value) {
        const upper = String(value || '').trim().toUpperCase();
        if (!upper) return '';
        const exactMatch = upper.match(/^(M[0-5]|A[1-5])$/);
        if (exactMatch) return exactMatch[1];
        const fuzzyMatch = upper.match(/(?:^|[^A-Z0-9])(M[0-5]|A[1-5])(?:$|[^A-Z0-9])/);
        return fuzzyMatch ? fuzzyMatch[1] : '';
    }

    function canUseAddFriendByHonorName(honorName) {
        const levelCode = normalizeHonorLevelCode(honorName);
        if (!levelCode) return false;
        if (levelCode.charAt(0) === 'A') return true;
        return levelCode.charAt(0) === 'M' && Number(levelCode.slice(1)) >= 3;
    }

    function getHonorBadgeModule() {
        const modules = window.AKIMUserModules;
        if (!modules || typeof modules !== 'object') return null;
        const honorBadgeModule = modules.honorBadge;
        if (!honorBadgeModule || typeof honorBadgeModule.buildBadgeMarkup !== 'function') return null;
        return honorBadgeModule;
    }

    function buildHonorBadgeMarkup(honorName, className) {
        const normalizedHonorName = normalizeHonorName(honorName);
        if (!normalizedHonorName) return '';
        const badgeClassName = String(className || 'ak-im-honor-badge').trim() || 'ak-im-honor-badge';
        const honorBadgeModule = getHonorBadgeModule();
        if (honorBadgeModule) {
            const richMarkup = honorBadgeModule.buildBadgeMarkup(normalizedHonorName, badgeClassName);
            if (typeof richMarkup === 'string' && richMarkup) {
                return richMarkup;
            }
        }
        return '<span class="' + badgeClassName + '">' + escapeHtml(normalizedHonorName) + '</span>';
    }

    function buildDisplayNameWithHonorMarkup(displayName, honorName, fallbackText, options) {
        const resolvedDisplayName = String(displayName || fallbackText || '').trim() || String(fallbackText || '未知用户');
        const settings = options || {};
        const wrapperClassName = String(settings.wrapperClassName || 'ak-im-name-with-honor').trim() || 'ak-im-name-with-honor';
        const textClassName = String(settings.textClassName || 'ak-im-name-text').trim() || 'ak-im-name-text';
        const badgeClassName = String(settings.badgeClassName || 'ak-im-honor-badge').trim() || 'ak-im-honor-badge';
        return '<span class="' + wrapperClassName + '"><span class="' + textClassName + '">' + escapeHtml(resolvedDisplayName) + '</span>' + buildHonorBadgeMarkup(honorName, badgeClassName) + '</span>';
    }

    function formatUserDisplayText(displayName, username, honorName, fallbackText) {
        const normalizedUsername = String(username || '').trim();
        const resolvedDisplayName = String(displayName || normalizedUsername || fallbackText || '未知成员').trim() || String(fallbackText || '未知成员');
        const normalizedHonorName = normalizeHonorName(honorName);
        const primaryText = normalizedHonorName ? (resolvedDisplayName + ' [' + normalizedHonorName + ']') : resolvedDisplayName;
        if (normalizedUsername && resolvedDisplayName.toLowerCase() !== normalizedUsername.toLowerCase()) {
            return primaryText + ' @' + normalizedUsername;
        }
        return primaryText;
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
        if (list.length === 2) {
            return '<div class="ak-im-avatar-mosaic is-duo" aria-hidden="true">' + cells.join('') + '</div>';
        }
        if (list.length === 3) {
            return '<div class="ak-im-avatar-mosaic is-trio" aria-hidden="true"><div class="ak-im-avatar-row is-top">' + cells[0] + '</div><div class="ak-im-avatar-row is-bottom">' + cells.slice(1).join('') + '</div></div>';
        }
        if (list.length === 4) {
            return '<div class="ak-im-avatar-mosaic is-quad" aria-hidden="true">' + cells.join('') + '</div>';
        }
        if (list.length >= 9) {
            return '<div class="ak-im-avatar-mosaic is-grid" aria-hidden="true">' + cells.join('') + '</div>';
        }
        const rows = [];
        for (let index = 0; index < cells.length; index += 3) {
            rows.push('<div class="ak-im-avatar-row is-count-' + Math.min(3, cells.length - index) + '">' + cells.slice(index, index + 3).join('') + '</div>');
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

    function renderActionSheet() {
        const overlayModule = getOverlayModule();
        if (overlayModule && typeof overlayModule.renderActionSheet === 'function') {
            overlayModule.renderActionSheet();
        }
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

    function openContactActionSheet(contactItem, mode) {
        const targetUsername = getContactUsername(contactItem);
        const actionMode = mode === 'contact_blacklist_remove' ? 'contact_blacklist_remove' : 'contact_blacklist_add';
        if (!targetUsername) return;
        const overlayModule = getOverlayModule();
        if (overlayModule && typeof overlayModule.openContactActionSheet === 'function') {
            overlayModule.openContactActionSheet(contactItem, actionMode);
            return;
        }
        const socialModule = getSocialModule();
        if (!socialModule) return;
        if (actionMode === 'contact_blacklist_remove') {
            if (window.confirm('将该联系人移出黑名单？') && typeof socialModule.removeFromBlacklist === 'function') {
                socialModule.removeFromBlacklist(targetUsername);
            }
            return;
        }
        if (window.confirm('将该联系人加入黑名单？') && typeof socialModule.addToBlacklist === 'function') {
            socialModule.addToBlacklist(targetUsername);
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
        state.actionSheetContactUsername = '';
        state.actionSheetCustomActions = [];
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
        progressPanelBodyEl.innerHTML = isOpen && '<div class="ak-im-progress-empty">消息读进度模块暂不可用，请刷新页面后重试</div>' || '';
    }

	function formatSessionMember(member) {
	    const displayName = String(member && member.display_name || '').trim();
	    const username = String(member && member.username || '').trim();
	    const honorName = normalizeHonorName(member && member.honor_name);
	    const role = String(member && member.role || '').trim().toLowerCase();
	    const roleLabel = role === 'owner' ? '群主' : (role === 'admin' ? '管理员' : '');
	    const memberName = displayName || username || '未知成员';
	    const honorBadgeMarkup = '<div class="ak-im-member-honor">' + (honorName ? buildHonorBadgeMarkup(honorName, 'ak-im-honor-badge ak-im-member-honor-badge') : '') + '</div>';
	    return '<button class="ak-im-member-item" type="button" data-im-member-username="' + escapeHtml(username.toLowerCase()) + '">' + honorBadgeMarkup + buildAvatarBoxMarkup('ak-im-member-avatar', member && member.avatar_url, displayName || username || '成员', (displayName || username || '成员') + '头像') + '<div class="ak-im-member-body"><div class="ak-im-member-name">' + escapeHtml(memberName) + '</div></div>' + (roleLabel ? '<div class="ak-im-member-role">' + escapeHtml(roleLabel) + '</div>' : '') + '</button>';
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
        closeGroupAdminsPage({ silent: true });
	    closeMemberActionPage({ silent: true, fallbackView: state.activeConversationId ? 'chat' : 'sessions' });
	    state.groupSettingsOpen = false;
	    state.groupSettingsLoading = false;
	    state.groupSettingsError = '';
	    state.groupSettingsConversationId = 0;
	    state.groupSettingsData = null;
	    state.groupSettingsMembersExpanded = false;
	    if (state.view === 'group_info' || state.view === 'group_title_edit' || state.view === 'group_admins') {
	        state.view = state.activeConversationId ? 'chat' : 'sessions';
	    }
	    if (!silent) render();
	}

	function loadGroupSettings(conversationId) {
	    const targetConversationId = Number(conversationId || 0);
	    if (!targetConversationId) return Promise.resolve(null);
	    return ensureOptionalLazyModule('group').then(function() {
	        const groupManageModule = getGroupManageModule();
	        if (groupManageModule && typeof groupManageModule.loadGroupSettings === 'function') {
	            return groupManageModule.loadGroupSettings(targetConversationId);
	        }
	        state.groupSettingsLoading = false;
	        state.groupSettingsError = '群设置模块暂不可用，请刷新后重试';
	        state.groupSettingsConversationId = targetConversationId;
	        state.groupSettingsData = null;
	        renderSettingsPanel();
	        return null;
	    });
	}

    function openGroupAdminsPage() {
        const conversationId = Number(state.groupSettingsConversationId || state.activeConversationId || 0);
        if (!conversationId) return;
        ensureOptionalLazyModule('groupAdmins').then(function(groupAdminsModule) {
            if (groupAdminsModule && typeof groupAdminsModule.openPage === 'function') {
                groupAdminsModule.openPage(conversationId);
                return;
            }
            state.groupAdminsOpen = true;
            state.groupAdminsLoading = false;
            state.groupAdminsError = '群管理员模块暂不可用，请刷新页面后重试';
            state.groupAdminsConversationId = conversationId;
            state.groupAdminsKeyword = '';
            state.view = 'group_admins';
            render();
        });
    }

    function closeGroupAdminsPage(options) {
        const groupAdminsModule = getGroupAdminsModule();
        if (groupAdminsModule && typeof groupAdminsModule.closePage === 'function') {
            groupAdminsModule.closePage(options);
            return;
        }
        const silent = !!(options && options.silent);
        state.groupAdminsOpen = false;
        state.groupAdminsLoading = false;
        state.groupAdminsError = '';
        state.groupAdminsConversationId = 0;
        state.groupAdminsKeyword = '';
        state.groupAdminsActionUsername = '';
        if (state.view === 'group_admins') state.view = state.groupSettingsOpen ? 'group_info' : (state.activeConversationId ? 'chat' : 'sessions');
        if (!silent) render();
    }

	function openSettingsPanel(sessionItem) {
	    const targetSession = sessionItem || getActiveSession();
	    const conversationId = Number(targetSession && targetSession.conversation_id || state.activeConversationId || 0);
	    if (!conversationId || !isGroupSession(targetSession)) return;
	    Promise.all([ensureOptionalLazyModule('group'), ensureOptionalLazyModule('groupAdmins')]).then(function() {
	        const overlayModule = getOverlayModule();
	        if (overlayModule && typeof overlayModule.openSettingsPanel === 'function') {
	            overlayModule.openSettingsPanel(targetSession);
	            return;
	        }
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
	    });
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
        closeEmojiPicker({ silent: true });
        closePlusPanel({ silent: true });
        closeHomeAddMenu({ silent: true });
        state.newSessionError = '';
        state.newSessionTarget = '';
        state.composerMode = 'text';
        state.view = 'sessions';
        render();
    }

    function normalizeHomeTab(tab) {
        const candidate = String(tab || '').trim().toLowerCase();
        if (candidate === 'contacts' || candidate === 'me' || candidate === 'meetings') return candidate;
        return 'chats';
    }

    function getHomeTabTitle(tab) {
        const normalizedTab = normalizeHomeTab(tab);
        if (normalizedTab === 'contacts') return '通讯录';
        if (normalizedTab === 'meetings') return '会议';
        if (normalizedTab === 'me') return '我';
        return '聊天';
    }

    function hasUnreadSessions() {
        return getUnreadSessionTotal() > 0;
    }

    function getUnreadSessionTotal() {
        const sessionManageModule = getSessionManageModule();
        return state.sessions.reduce(function(sum, item) {
            let unreadCount = 0;
            if (sessionManageModule && typeof sessionManageModule.getUnreadCount === 'function') {
                unreadCount = Number(sessionManageModule.getUnreadCount(item) || 0);
            } else {
                unreadCount = Number(item && (item.unread_count || item.unread || 0) || 0);
            }
            return sum + Math.max(0, unreadCount);
        }, 0);
    }

    function getHomeSearchPillText(tab) {
        const normalizedTab = normalizeHomeTab(tab);
        if (normalizedTab === 'contacts') {
            return state.contactsLoading ? '正在同步同白名单通讯录' : '同白名单成员会显示在这里，点击可直接发起聊天';
        }
        if (normalizedTab === 'me') {
            return '这里保留头像设置、个人资料、设置三个入口';
        }
        if (normalizedTab === 'meetings') {
            return '';
        }
        return state.sessions.length ? '长按会话可置顶，点击右上角搜索联系人' : '点击右上角搜索联系人';
    }

    function getShellRenderState() {
        const activeSession = getActiveSession();
        const homeTab = normalizeHomeTab(state.homeTab);
        const showChat = !!activeSession && state.view === 'chat';
        const showCompose = state.view === 'compose';
        const showGroupInfo = state.view === 'group_info' && !!state.groupSettingsOpen;
        const showMemberAction = state.view === 'member_action' && !!state.memberActionOpen;
        const showGroupAdmins = state.view === 'group_admins' && !!state.groupAdminsOpen;
        const showProfileSubpage = isProfileSubpageView(state.view);
        const showGroupCreate = state.view === 'group_create';
        const showGroupTitleEdit = state.view === 'group_title_edit';
        const showMeetingPublish = state.view === 'meeting_publish' && !!state.meetingsPublishOpen;
        const showMeetingJoin = state.view === 'meeting_join' && !!state.meetingsJoinOpen;
        const showExternalPage = state.view === 'external_page' && !!state.externalPageOpen;
        const showContactSearch = state.view === 'contact_search';
        const showHomeTopActions = isHomeTopActionTab(homeTab) && !showContactSearch;
        state.homeTab = homeTab;
        return {
            allowed: !!state.allowed,
            open: !!state.open,
            showSessions: !showChat && !showCompose && !showGroupInfo && !showMemberAction && !showGroupAdmins && !showProfileSubpage && !showGroupCreate && !showGroupTitleEdit && !showMeetingPublish && !showMeetingJoin && !showExternalPage,
            showChat: !!showChat,
            showCompose: !!showCompose,
            showGroupInfo: !!showGroupInfo,
            showMemberAction: !!showMemberAction,
            showGroupAdmins: !!showGroupAdmins,
            showProfileSubpage: !!showProfileSubpage,
            showGroupCreate: !!showGroupCreate,
            showGroupTitleEdit: !!showGroupTitleEdit,
            showMeetingPublish: !!showMeetingPublish,
            showMeetingJoin: !!showMeetingJoin,
            showExternalPage: !!showExternalPage,
            showContactSearch: !!showContactSearch,
            hasUnread: hasUnreadSessions(),
            chatUnread: getUnreadSessionTotal(),
            homeTab: homeTab,
            homeTabTitle: getHomeTabTitle(homeTab),
            showSessionNewButton: false,
            showHomeTopActions: showHomeTopActions,
            showHomeAddMenu: showHomeTopActions && !showChat && !showCompose && !showGroupInfo && !showMemberAction && !showGroupAdmins && !showProfileSubpage && !showGroupCreate && !showGroupTitleEdit && !showMeetingPublish && !showMeetingJoin && !showExternalPage && !!state.homeAddMenuOpen,
            canAddFriend: !!state.canAddFriend,
            searchPillText: getHomeSearchPillText(homeTab),
            contactSearchKeyword: state.contactSearchKeyword,
            meetingsUnread: (function() {
                const m = getMeetingManageModule();
                if (!m) return 0;
                if (typeof m.getTabBadgeCount === 'function') return Number(m.getTabBadgeCount() || 0);
                if (typeof m.getTabUnreadCount === 'function') return Number(m.getTabUnreadCount() || 0);
                return typeof m.getUnreadCount === 'function' ? Number(m.getUnreadCount() || 0) : 0;
            })()
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
        return view === 'profile_avatar' || view === 'profile_detail' || view === 'profile_settings' || view === 'profile_blacklist';
    }

    function getProfileSubpageTitle(view) {
        if (view === 'profile_avatar') return '头像设置';
        if (view === 'profile_settings') return '设置';
        if (view === 'profile_blacklist') return '黑名单';
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
        state.profileSettingsError = '';
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
        const ensureModule = nextView === 'profile_blacklist' ? ensureOptionalLazyModule('social') : ensureOptionalLazyModule('profile');
        ensureModule.then(function(loadedModule) {
            if (nextView === 'profile_blacklist' && !loadedModule) {
                openDialog({
                    title: '提示',
                    message: '黑名单模块暂不可用，请刷新页面后重试',
                    confirmText: '知道了',
                    showCancel: false
                });
                return;
            }
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
            if (nextView === 'profile_blacklist') {
                state.blacklistError = '';
                const socialModule = getSocialModule();
                if (socialModule && typeof socialModule.loadBlacklist === 'function') {
                    socialModule.loadBlacklist();
                }
            }
            render();
        });
    }

    function ensureHomeTabData(tab) {
        const normalizedTab = normalizeHomeTab(tab);
        if (!state.allowed) return;
        if (normalizedTab === 'contacts') {
            if (!state.contactsLoading && !state.contactsLoaded) loadContacts();
            return;
        }
        if (normalizedTab === 'meetings') {
            const meetingModule = getMeetingManageModule();
            if (meetingModule && state.meetingsLoaded && typeof meetingModule.markTabSeen === 'function') {
                meetingModule.markTabSeen();
            }
            if (meetingModule && typeof meetingModule.loadMeetings === 'function' && !state.meetingsLoading) {
                meetingModule.loadMeetings();
            }
            return;
        }
        if (normalizedTab === 'me' && !state.profileLoading && !state.profileLoaded) {
            loadProfile();
        }
    }

    function switchHomeTab(tab) {
        state.homeTab = normalizeHomeTab(tab);
        state.contactSearchKeyword = '';
        closeHomeAddMenu({ silent: true });
        state.view = 'sessions';
        ensureHomeTabData(state.homeTab);
        render();
    }

    function getInitialOpenRequest() {
        try {
            const params = new URL(window.location.href).searchParams;
            if (params.get('ak_im_open') !== '1') return null;
            return {
                tab: normalizeHomeTab(params.get('ak_im_tab'))
            };
        } catch (e) {
            return null;
        }
    }

    function applyInitialOpenRequest() {
        const openRequest = initialOpenRequest;
        if (!openRequest || initialOpenRequestConsumed || !state.allowed) return false;
        initialOpenRequestConsumed = true;
        state.open = true;
        state.homeTab = openRequest.tab;
        state.view = 'sessions';
        closeHomeAddMenu({ silent: true });
        ensureHomeTabData(state.homeTab);
        clearInitialOpenRequestURL();
        render();
        return true;
    }

    function clearInitialOpenRequestURL() {
        try {
            const url = new URL(window.location.href);
            if (!url.searchParams.has('ak_im_open') && !url.searchParams.has('ak_im_tab')) return;
            url.searchParams.delete('ak_im_open');
            url.searchParams.delete('ak_im_tab');
            const nextURL = url.pathname + (url.search || '') + url.hash;
            window.history.replaceState(window.history.state, document.title, nextURL);
        } catch (e) {}
    }

    function renderHomeShell(shellState) {
        if (!root) return;
        const nextShellState = shellState || getShellRenderState();
        const formatTabBadgeCount = function(value) {
            const count = Math.max(0, Number(value || 0) || 0);
            if (!count) return '';
            return count > 999 ? '999+' : String(count);
        };
        if (sessionTopbarTitleEl) {
            sessionTopbarTitleEl.textContent = nextShellState.homeTabTitle;
        }
        if (sessionNewBtnEl) {
            sessionNewBtnEl.classList.toggle('is-hidden', !nextShellState.showSessionNewButton);
        }
        if (homeSearchTriggerBtnEl) {
            homeSearchTriggerBtnEl.classList.toggle('is-hidden', !nextShellState.showHomeTopActions);
        }
        if (homeAddTriggerBtnEl) {
            homeAddTriggerBtnEl.classList.toggle('is-hidden', !nextShellState.showHomeTopActions);
        }
        if (contactSearchBackBtnEl) {
            contactSearchBackBtnEl.classList.toggle('is-hidden', !nextShellState.showContactSearch);
        }
        if (sessionTopbarTitleEl) {
            sessionTopbarTitleEl.classList.toggle('is-hidden', !!nextShellState.showContactSearch);
        }
        if (contactSearchInputEl && contactSearchInputEl.value !== String(nextShellState.contactSearchKeyword || '')) {
            contactSearchInputEl.value = String(nextShellState.contactSearchKeyword || '');
        }
        if (contactSearchClearBtnEl) {
            contactSearchClearBtnEl.classList.toggle('is-hidden', !String(nextShellState.contactSearchKeyword || '').trim());
        }
        root.classList.toggle('ak-contact-search-open', !!nextShellState.showContactSearch);
        const searchPill = root.querySelector('.ak-im-search-pill');
        if (searchPill) {
            searchPill.textContent = nextShellState.searchPillText;
        }
        const addFriendButton = root.querySelector('[data-im-home-add-action="add_friend"]');
        if (addFriendButton) {
            addFriendButton.disabled = !nextShellState.canAddFriend;
            addFriendButton.setAttribute('aria-disabled', nextShellState.canAddFriend ? 'false' : 'true');
            if (nextShellState.canAddFriend) {
                addFriendButton.removeAttribute('title');
            } else {
                addFriendButton.setAttribute('title', '仅 M3 及以上玩家可添加好友');
            }
        }
        Array.prototype.forEach.call(root.querySelectorAll('[data-im-home-tab]'), function(button) {
            const tabName = button.getAttribute('data-im-home-tab');
            const badgeEl = button.querySelector('.ak-im-home-tab-badge');
            let badgeText = '';
            button.classList.toggle('is-active', tabName === nextShellState.homeTab);
            if (tabName === 'chats') badgeText = formatTabBadgeCount(nextShellState.chatUnread);
            else if (tabName === 'meetings') badgeText = formatTabBadgeCount(nextShellState.meetingsUnread);
            button.classList.toggle('has-unread', !!badgeText);
            if (badgeEl) badgeEl.textContent = badgeText;
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
        empty.textContent = state.sessions.length ? '会话模块暂不可用，请刷新页面后重试' : (state.allowed ? '暂无会话\n点击右上角搜索联系人开始聊天' : '当前账号未开通聊天');
        sessionList.appendChild(empty);
    }

    function getContactUsername(contact) {
        return String(contact && contact.username || '').trim().toLowerCase();
    }

    function getContactDisplayName(contact) {
        const username = getContactUsername(contact);
        return String(contact && contact.display_name || '').trim() || username || '联系人';
    }

    function buildContactItemInnerMarkup(contact) {
        const username = getContactUsername(contact);
        const displayName = getContactDisplayName(contact);
        const honorName = normalizeHonorName(contact && contact.honor_name);
        return buildAvatarBoxMarkup('ak-im-contact-avatar', contact && contact.avatar_url, displayName, displayName + '头像') +
            '<div class="ak-im-contact-body"><div class="ak-im-contact-name">' + buildDisplayNameWithHonorMarkup(displayName, honorName, '联系人') + '</div><div class="ak-im-contact-meta">@' + escapeHtml(username || 'unknown') + '</div></div>';
    }

    function matchContactSearch(contact, keyword) {
        const normalizedKeyword = String(keyword || '').trim().toLowerCase();
        if (!normalizedKeyword) return false;
        const username = getContactUsername(contact);
        const displayName = String(contact && contact.display_name || '').trim().toLowerCase();
        return displayName.indexOf(normalizedKeyword) >= 0 || username.indexOf(normalizedKeyword) >= 0;
    }

    function getContactSearchResults() {
        const keyword = String(state.contactSearchKeyword || '').trim().toLowerCase();
        if (!keyword) return [];
        return state.contacts.filter(function(contact) {
            return matchContactSearch(contact, keyword);
        });
    }

    function renderContactSearchView() {
	    const socialModule = getSocialModule();
	    if (socialModule && typeof socialModule.renderContactSearchView === 'function' && socialModule.renderContactSearchView()) {
	        return;
	    }
        if (!contactSearchPageEl) return;
	    if (state.contactSearchMode === 'friend_add') {
	        contactSearchPageEl.innerHTML = '<div class="ak-im-contact-search-empty">添加朋友模块暂不可用，请刷新页面后重试</div>';
	        return;
	    }
        if (!state.allowed) {
            contactSearchPageEl.innerHTML = '<div class="ak-im-contact-search-empty">当前账号未开通聊天</div>';
            return;
        }
        const keyword = String(state.contactSearchKeyword || '').trim();
        if (state.contactsLoading && !state.contactsLoaded) {
            contactSearchPageEl.innerHTML = '<div class="ak-im-contact-search-empty">正在同步联系人...</div>';
            return;
        }
        if (state.contactsError && !state.contacts.length) {
            contactSearchPageEl.innerHTML = '<div class="ak-im-contact-search-empty">' + escapeHtml(state.contactsError) + '</div>';
            return;
        }
        if (!keyword) {
            contactSearchPageEl.innerHTML = '<div class="ak-im-contact-search-empty">搜索联系人昵称或账号</div>';
            return;
        }
        const results = getContactSearchResults();
        if (!results.length) {
            contactSearchPageEl.innerHTML = '<div class="ak-im-contact-search-empty">未找到匹配联系人</div>';
            return;
        }
        contactSearchPageEl.innerHTML = '<div class="ak-im-contact-search-section"><div class="ak-im-contact-search-section-title">联系人</div><div class="ak-im-contact-search-section-list"></div></div>';
        const listEl = contactSearchPageEl.querySelector('.ak-im-contact-search-section-list');
        results.forEach(function(contact) {
            const username = getContactUsername(contact);
            if (!username) return;
            const node = document.createElement('button');
            node.type = 'button';
            node.className = 'ak-im-contact-item';
            node.innerHTML = buildContactItemInnerMarkup(contact);
            node.addEventListener('click', function() {
                closeContactSearch({ silent: true });
                openDirectConversation(username);
            });
            listEl.appendChild(node);
        });
    }

    function renderContactsView() {
	    const socialModule = getSocialModule();
	    if (socialModule && typeof socialModule.renderContactsView === 'function' && socialModule.renderContactsView()) {
	        return;
	    }
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
            const username = getContactUsername(contact);
            const node = document.createElement('button');
            node.type = 'button';
            node.className = 'ak-im-contact-item';
            node.innerHTML = buildContactItemInnerMarkup(contact);
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
        const honorName = normalizeHonorName(profile && profile.honor_name || state.honorName || '');
        const username = String(profile && profile.username || state.username || '').trim();
        const nickname = String(profile && profile.nickname || '').trim();
        const genderLabel = getProfileGenderLabel(profile && profile.gender);
        const favoriteCount = countProfileAvatarFavorites(state.profileAvatarHistory);
        const avatarHistorySummary = state.profileAvatarHistoryLoading ? '正在同步头像历史' : (state.profileAvatarHistoryLoaded ? (state.profileAvatarHistory.length ? (favoriteCount ? ('已收藏 ' + favoriteCount + ' 个头像，共保存 ' + state.profileAvatarHistory.length + ' 条记录') : ('最近保留 ' + state.profileAvatarHistory.length + ' 个历史头像')) : '切换头像后会在这里保留最近 10 个记录') : '可查看最近 10 个历史头像');
        profilePageEl.innerHTML = (state.profileError ? '<div class="ak-im-profile-error">' + escapeHtml(state.profileError) + '</div>' : '') +
            '<div class="ak-im-profile-card">' +
                '<div class="ak-im-profile-head">' +
                    buildAvatarBoxMarkup('ak-im-profile-avatar', profile && profile.avatar_url, displayName || username || '我', (displayName || username || '我') + '头像') +
                    '<div class="ak-im-profile-name">' + buildDisplayNameWithHonorMarkup(displayName || '我', honorName, '我') + '</div>' +
                    '<div class="ak-im-profile-username">@' + escapeHtml(username || 'unknown') + '</div>' +
                    '<div class="ak-im-profile-meta">' + escapeHtml((nickname ? ('昵称：' + nickname) : '可设置昵称') + ' · 性别：' + genderLabel) + '</div>' +
                '</div>' +
                '<div class="ak-im-profile-entry-list">' +
                '<button class="ak-im-profile-entry" type="button" data-im-profile-nav="profile_avatar">' +
                    '<div class="ak-im-profile-entry-main"><div class="ak-im-profile-entry-label">头像设置</div><div class="ak-im-profile-entry-meta">' + escapeHtml(avatarHistorySummary) + '</div></div>' +
                    '<div class="ak-im-profile-entry-arrow" aria-hidden="true">›</div>' +
                '</button>' +
                '<button class="ak-im-profile-entry" type="button" data-im-profile-nav="profile_detail">' +
                    '<div class="ak-im-profile-entry-main"><div class="ak-im-profile-entry-label">个人资料</div><div class="ak-im-profile-entry-meta">' + escapeHtml('昵称：' + (nickname || displayName || '未设置') + ' · 性别：' + genderLabel) + '</div></div>' +
                    '<div class="ak-im-profile-entry-arrow" aria-hidden="true">›</div>' +
                '</button>' +
                '<button class="ak-im-profile-entry" type="button" data-im-profile-nav="profile_settings">' +
                    '<div class="ak-im-profile-entry-main"><div class="ak-im-profile-entry-label">设置</div><div class="ak-im-profile-entry-meta">管理等级显示等个人设置</div></div>' +
                    '<div class="ak-im-profile-entry-arrow" aria-hidden="true">›</div>' +
                '</button>' +
	            '<button class="ak-im-profile-entry" type="button" data-im-profile-nav="profile_blacklist">' +
	                '<div class="ak-im-profile-entry-main"><div class="ak-im-profile-entry-label">黑名单</div><div class="ak-im-profile-entry-meta">管理已拉黑用户与禁止收发名单</div></div>' +
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
            const socialModule = getSocialModule();
            if (socialModule && state.view === 'profile_blacklist' && typeof socialModule.renderProfileSubpage === 'function') {
                if (profileSubpageTitleEl) profileSubpageTitleEl.textContent = '黑名单';
                if (socialModule.renderProfileSubpage()) {
	                return;
	            }
	        }
            if (state.view === 'profile_blacklist') {
                if (!profileSubpageBodyEl || !profileSubpageTitleEl) return;
                profileSubpageTitleEl.textContent = '黑名单';
                profileSubpageBodyEl.innerHTML = '<div class="ak-im-profile-panel"><div class="ak-im-empty">黑名单模块暂不可用，请刷新页面后重试</div></div>';
                return;
            }
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
            const activeSession = getActiveSession();
            const hasMessageManage = !!getMessageManageModule();
            const canSendBySession = !hasConversation || !activeSession || activeSession.can_send !== false;
            const restrictedHint = String(activeSession && activeSession.send_restriction_hint || '').trim();
            const isVoiceMode = normalizeComposerMode(state.composerMode) === 'voice';
            const voiceHoldState = String(state.voiceHoldState || '').trim().toLowerCase();
            const isVoiceRecording = voiceHoldState === 'recording';
            const isVoiceCancelReady = voiceHoldState === 'cancel_ready';
            const isVoiceSending = voiceHoldState === 'sending';
            const canSend = hasConversation && hasMessageManage && canSendBySession;
            const hasText = !!String(inputEl.value || '').trim();
            const canOpenEmoji = hasConversation && canSendBySession;
            const showVoiceMode = hasConversation && isVoiceMode;
            const canOpenPlus = hasConversation && !showVoiceMode && canSendBySession;
            const holdSupported = state.voiceHoldSupported !== false;
            const plusPanelVisible = !!state.plusPanelOpen && state.view === 'chat' && canOpenPlus;
            if (root) {
                root.classList.toggle('ak-im-composer-has-text', !showVoiceMode && canSend && hasText);
                root.classList.toggle('ak-im-composer-voice-mode', showVoiceMode);
                root.classList.toggle('ak-im-emoji-open', !!state.emojiPanelOpen && state.view === 'chat' && hasConversation);
                root.classList.toggle('ak-im-plus-open', plusPanelVisible);
                root.classList.toggle('ak-im-voice-hold-recording', showVoiceMode && isVoiceRecording);
                root.classList.toggle('ak-im-voice-hold-cancel-ready', showVoiceMode && isVoiceCancelReady);
                root.classList.toggle('ak-im-voice-hold-sending', showVoiceMode && isVoiceSending);
            }
            inputEl.disabled = !canSend || showVoiceMode;
            inputEl.placeholder = hasConversation ? (hasMessageManage ? (canSendBySession ? '输入消息' : (restrictedHint || '当前会话暂不可发送消息')) : '消息模块暂不可用') : '先选择一个会话';
            sendBtn.disabled = showVoiceMode || !canSend || !hasText;
            if (composerVoiceBtnEl) {
                composerVoiceBtnEl.disabled = !hasConversation || isVoiceSending;
                composerVoiceBtnEl.classList.toggle('is-active', showVoiceMode);
                composerVoiceBtnEl.setAttribute('aria-label', showVoiceMode ? '切换到键盘输入' : '切换到按住说话');
            }
            if (composerEmojiBtnEl) {
                composerEmojiBtnEl.disabled = !canOpenEmoji;
                composerEmojiBtnEl.classList.toggle('is-active', !!state.emojiPanelOpen && state.view === 'chat' && hasConversation);
                composerEmojiBtnEl.setAttribute('aria-label', state.emojiPanelOpen ? '切回键盘输入' : '打开表情面板');
            }
            if (composerPlusBtnEl) {
                composerPlusBtnEl.disabled = !canOpenPlus;
                composerPlusBtnEl.classList.toggle('is-active', plusPanelVisible);
                composerPlusBtnEl.setAttribute('aria-label', plusPanelVisible ? '收起更多功能' : '打开更多功能');
            }
            if (composerHoldBtnEl) {
                composerHoldBtnEl.disabled = !showVoiceMode || !hasMessageManage || !holdSupported || isVoiceSending;
                if (!holdSupported) composerHoldBtnEl.textContent = '当前浏览器不支持语音';
                else if (isVoiceSending) composerHoldBtnEl.textContent = '发送中...';
                else if (isVoiceCancelReady) composerHoldBtnEl.textContent = '松开 取消';
                else if (isVoiceRecording) composerHoldBtnEl.textContent = '松开 发送';
                else composerHoldBtnEl.textContent = '按住 说话';
            }
            if (statusLine) {
                let nextStatusText = '';
                if (!showVoiceMode && hasConversation && hasMessageManage && !canSendBySession) {
                    nextStatusText = restrictedHint || '当前会话暂不可发送消息';
                } else if (showVoiceMode) {
                    if (!holdSupported) nextStatusText = '当前浏览器暂不支持语音发送';
                    else if (isVoiceCancelReady) nextStatusText = '松开手指，取消发送';
                    else if (isVoiceRecording) nextStatusText = '松开发送，上滑取消';
                    else if (isVoiceSending) nextStatusText = '正在发送语音...';
                    else nextStatusText = String(state.voiceHoldStatusText || '').trim();
                }
                statusLine.textContent = nextStatusText;
            }
            if (composerMicBtnEl) composerMicBtnEl.disabled = true;
        }

    function render() {
        if (!root) return;
        const shellState = getShellRenderState();
        if (isFallbackShellActive()) {
            renderFallbackShell(shellState);
            return;
        }
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
            root.classList.toggle('ak-view-group-admins', !!shellState.showGroupAdmins);
            root.classList.toggle('ak-view-profile-subpage', !!shellState.showProfileSubpage);
            root.classList.toggle('ak-view-group-create', !!shellState.showGroupCreate);
            root.classList.toggle('ak-view-group-title-edit', !!shellState.showGroupTitleEdit);
            root.classList.toggle('ak-view-meeting-publish', !!shellState.showMeetingPublish);
            root.classList.toggle('ak-view-meeting-join', !!shellState.showMeetingJoin);
            root.classList.toggle('ak-view-external-page', !!shellState.showExternalPage);
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
        renderContactSearchView();
        renderProfileView();
        renderProfileSubpage();
        syncComposerState();
        syncInputHeight();
        renderEmojiPanel();
        renderPlusPanel();
        renderMessages();
        renderActionSheet();
        renderReadProgressPanel();
	    renderMemberPanel();
	    renderSettingsPanel();
	    renderMemberActionPage();
        renderGroupAdminsPage();
        renderGroupCreatePage();
        renderGroupTitleEditPage();
        renderExternalPage();
	    renderDialog();
        renderComposeView();
        if (state.open && state.view === 'compose') focusComposeInput();
	    if (state.open && shellState.showMemberAction) focusMemberActionSearch();
    }

    function renderExternalPage() {
        const externalPageModule = getExternalPageModule();
        if (externalPageModule && typeof externalPageModule.render === 'function') {
            externalPageModule.render();
            return;
        }
        if (externalPageBodyEl) externalPageBodyEl.innerHTML = '';
    }

    function renderGroupAdminsPage() {
        const groupAdminsModule = getGroupAdminsModule();
        if (groupAdminsModule && typeof groupAdminsModule.renderPage === 'function') {
            groupAdminsModule.renderPage();
            return;
        }
        if (!groupAdminsBodyEl) return;
        if (!state.groupAdminsOpen) {
            groupAdminsBodyEl.innerHTML = '';
            return;
        }
        if (state.groupAdminsLoading) {
            groupAdminsBodyEl.innerHTML = '<div class="ak-im-group-admins-empty">正在加载群管理员...</div>';
            return;
        }
        if (state.groupAdminsError) {
            groupAdminsBodyEl.innerHTML = '<div class="ak-im-group-admins-error">' + escapeHtml(state.groupAdminsError) + '</div>';
            return;
        }
        groupAdminsBodyEl.innerHTML = '<div class="ak-im-group-admins-empty">群管理员模块暂不可用，请刷新页面后重试</div>';
    }

    function renderGroupCreatePage() {
        const groupCreateModule = getGroupCreateModule();
        if (groupCreateModule && typeof groupCreateModule.renderPage === 'function') {
            groupCreateModule.renderPage();
            return;
        }
        if (!groupCreateBodyEl || !groupCreateTitleInputEl || !groupCreateSearchInputEl || !groupCreateSubmitBtnEl) return;
        groupCreateTitleInputEl.value = String(state.groupCreateTitle || '');
        groupCreateTitleInputEl.classList.toggle('is-error', !!state.groupCreateTitleError);
        if (groupCreateTitleTipEl) {
            groupCreateTitleTipEl.textContent = String(state.groupCreateTitleError || '');
            groupCreateTitleTipEl.classList.toggle('visible', !!state.groupCreateTitleError);
        }
        groupCreateSearchInputEl.value = String(state.groupCreateKeyword || '');
        if (state.view !== 'group_create') {
            groupCreateBodyEl.innerHTML = '';
            groupCreateTitleInputEl.classList.remove('is-error', 'is-alert');
            if (groupCreateTitleTipEl) {
                groupCreateTitleTipEl.textContent = '';
                groupCreateTitleTipEl.classList.remove('visible');
            }
            groupCreateSubmitBtnEl.disabled = true;
            groupCreateSubmitBtnEl.textContent = '创建';
            return;
        }
        groupCreateBodyEl.innerHTML = '<div class="ak-im-group-create-empty' + (state.groupCreateError ? ' is-error' : '') + '">' + escapeHtml(state.groupCreateError || '发起群聊模块暂不可用，请刷新页面后重试') + '</div>';
        groupCreateSubmitBtnEl.disabled = true;
        groupCreateSubmitBtnEl.textContent = '创建';
    }

    function renderGroupTitleEditPage() {
        const groupTitleModule = getGroupTitleModule();
        if (groupTitleModule && typeof groupTitleModule.renderPage === 'function') {
            groupTitleModule.renderPage();
            return;
        }
        if (!groupTitleEditBodyEl || !groupTitleEditInputEl || !groupTitleEditSubmitBtnEl) return;
        groupTitleEditInputEl.value = String(state.groupTitleEditValue || '');
        if (state.view !== 'group_title_edit') {
            groupTitleEditBodyEl.innerHTML = '';
            groupTitleEditSubmitBtnEl.disabled = true;
            groupTitleEditSubmitBtnEl.textContent = '保存';
            return;
        }
        groupTitleEditBodyEl.innerHTML = '<div class="ak-im-group-title-error">' + escapeHtml(state.groupTitleEditError || '群名编辑模块暂不可用，请刷新页面后重试') + '</div>';
        groupTitleEditSubmitBtnEl.disabled = true;
        groupTitleEditSubmitBtnEl.textContent = '保存';
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
            const groupAdminsModule = getGroupAdminsModule();
            if (canOpenGroupInfo && groupAdminsModule && typeof groupAdminsModule.bindGroupAvatarLongPress === 'function') {
                groupAdminsModule.bindGroupAvatarLongPress(chatTitleBtnEl, Number(activeSession && activeSession.conversation_id || 0));
            } else if (groupAdminsModule && typeof groupAdminsModule.unbindPress === 'function') {
                groupAdminsModule.unbindPress(chatTitleBtnEl);
            }
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
        const honorName = normalizeHonorName(item && item.honor_name || state.honorName || '');
        const canAddFriend = canUseAddFriendByHonorName(honorName) || !!(item && typeof item.can_add_friend !== 'undefined' ? item.can_add_friend : state.canAddFriend);
        return {
            username: username || String(state.username || '').trim().toLowerCase(),
            display_name: displayName || username || '我',
            honor_name: honorName,
            can_add_friend: canAddFriend,
            nickname: String(item && item.nickname || '').trim(),
            gender: normalizeProfileGender(item && item.gender),
            avatar_style: String(item && item.avatar_style || 'thumbs').trim() || 'thumbs',
            hide_honor: !!(item && item.hide_honor),
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
        state.honorName = normalizeHonorName(profile.honor_name);
        state.canAddFriend = !!profile.can_add_friend;
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
	            state.contactSections = Array.isArray(data && data.sections) ? data.sections : [];
            render();
            return state.contacts;
        }).catch(function(error) {
            state.contactsLoading = false;
            state.contactsLoaded = false;
            state.contactsError = error && error.message ? error.message : '读取通讯录失败';
            state.contacts = [];
	            state.contactSections = [];
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

    function saveProfileHonorVisibility(hideHonor) {
        if (!state.allowed || state.profileSettingsSaving) return Promise.resolve(null);
        const profile = state.profile || {};
        state.profileSettingsSaving = true;
        state.profileSettingsError = '';
        render();
        return request(`${HTTP_ROOT}/profile`, {
            method: 'POST',
            body: JSON.stringify({
                nickname: String(profile.nickname || '').trim(),
                gender: normalizeProfileGender(profile.gender),
                hide_honor: !!hideHonor
            })
        }).then(function(data) {
            state.profileLoaded = true;
            state.profileError = '';
            applyProfileItem(data && data.item ? data.item : null);
            state.profileSettingsSaving = false;
            state.profileSettingsError = '';
            render();
            return reloadProfileLinkedData().then(function() {
                render();
                return state.profile;
            });
        }).catch(function(error) {
            state.profileSettingsSaving = false;
            state.profileSettingsError = error && error.message ? error.message : '保存设置失败';
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
            state.profileError = error && error.message ? error.message : '随机生成头像失败';
            render();
            return null;
        });
    }

    function uploadProfileAvatar(file) {
        if (!state.allowed || state.profileAvatarUploading || !file || !file.size) return Promise.resolve(null);
        state.profileAvatarUploading = true;
        state.profileAvatarUploadProgress = 0;
        state.profileError = '';
        state.profileAvatarActionError = '';
        state.profileAvatarHistoryActionId = 0;
        state.profileAvatarHistoryActionType = '';
        render();
        return ensureLazyModule('image').then(function(imageModule) {
            const uploadConfigLoader = imageModule && typeof imageModule.loadUploadConfig === 'function'
                ? imageModule.loadUploadConfig(false)
                : Promise.resolve(null);
            return uploadConfigLoader.then(function(config) {
                const avatarConfig = Object.assign({}, config || {}, {
                    enabled: true,
                    compress_above_kb: 0,
                    max_long_edge_px: 512,
                    output_format: 'webp',
                    quality: 86,
                    target_size_kb: 256,
                    keep_png_with_alpha: false,
                    skip_animated_gif: true
                });
                if (!imageModule || typeof imageModule.maybeCompressImageFile !== 'function') {
                    return {
                        file: file,
                        fileName: String(file && file.name || '').trim() || ('avatar-' + Date.now() + '.jpg')
                    };
                }
                return imageModule.maybeCompressImageFile(file, avatarConfig, { forceOutputMimeType: 'image/webp' });
            });
        }).then(function(result) {
            const uploadFile = result && result.file ? result.file : file;
            const uploadFileName = String(result && result.fileName || uploadFile && uploadFile.name || '').trim() || ('avatar-' + Date.now() + '.webp');
            const formData = new FormData();
            formData.append('file', uploadFile, uploadFileName);
            return requestFormData(`${HTTP_ROOT}/profile/avatar/upload`, formData, {
                method: 'POST',
                onUploadProgress: function(progress) {
                    state.profileAvatarUploadProgress = Math.max(0, Math.min(100, Number(progress && progress.percent || 0) || 0));
                    render();
                }
            });
        }).then(function(data) {
            state.profileAvatarUploading = false;
            state.profileAvatarUploadProgress = 0;
            state.profileLoaded = true;
            state.profileError = '';
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
            state.profileAvatarUploading = false;
            state.profileAvatarUploadProgress = 0;
            state.profileAvatarActionError = error && error.message ? error.message : '上传头像失败';
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
            closeEmojiPicker({ silent: true });
            closePlusPanel({ silent: true });
            closeHomeAddMenu({ silent: true });
            state.composerMode = 'text';
            state.activeConversationId = conversationId;
            state.view = 'chat';
            state.activeMessages = [];
            state.activeMessagesLoading = true;
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

    function applyBootstrapUnavailable() {
        state.allowed = false;
        state.ready = true;
        state.honorName = '';
        state.canAddFriend = false;
        state.emojiPanelOpen = false;
        state.plusPanelOpen = false;
        state.homeAddMenuOpen = false;
        state.emojiPanelTab = 'standard';
        state.emojiAssets = [];
        state.emojiAssetsLoaded = false;
        state.emojiAssetsLoading = false;
        state.emojiAssetsError = '';
        window.AKIMEmojiAssets = [];
        window.AK_IM_EMOJI_ASSETS = [];
        state.contacts = [];
        state.contactsLoaded = false;
        state.contactsLoading = false;
        state.contactsError = '';
	        state.contactSections = [];
        state.contactSearchKeyword = '';
	        state.contactSearchMode = 'contacts';
	        state.friendSearchResults = [];
	        state.friendSearchLoading = false;
	        state.friendSearchError = '';
	        state.friendSearchActionUsername = '';
	        state.blacklistItems = [];
	        state.blacklistLoaded = false;
	        state.blacklistLoading = false;
	        state.blacklistError = '';
	        state.blacklistActionUsername = '';
	        state.actionSheetOpen = false;
	        state.actionSheetMessageId = 0;
	        state.actionSheetConversationId = 0;
	        state.actionSheetCanRecall = false;
	        state.actionSheetDraftText = '';
	        state.actionSheetContactUsername = '';
	        state.actionSheetMode = '';
	        state.actionSheetSessionPinned = false;
	        state.actionSheetSessionSystemPinned = false;
        state.profile = null;
        state.profileLoaded = false;
        state.profileLoading = false;
        state.profileError = '';
        state.profileRefreshing = false;
        state.profileAvatarUploading = false;
        state.profileAvatarUploadProgress = 0;
        state.profileSaving = false;
        state.profileSaveError = '';
        state.profileSettingsSaving = false;
        state.profileSettingsError = '';
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
        state.activeMessagesLoading = false;
        render();
        return null;
    }

    function loadBootstrap(retryCount) {
        const currentRetryCount = Number(retryCount || 0);
        return request(buildBootstrapUrl()).then(function(data) {
            const bootstrapEmojiAssets = Array.isArray(data && data.emoji_assets)
                ? data.emoji_assets
                : (Array.isArray(data && data.custom_emoji_assets) ? data.custom_emoji_assets : []);
            const hasBootstrapEmojiAssets = Array.isArray(data && data.emoji_assets) || Array.isArray(data && data.custom_emoji_assets);
            state.allowed = !!(data && data.allowed);
            state.ready = true;
            state.username = String((data && data.username) || '').trim().toLowerCase();
            state.displayName = String((data && data.display_name) || state.username || '').trim();
            state.honorName = normalizeHonorName(data && data.honor_name);
            state.canAddFriend = canUseAddFriendByHonorName(state.honorName) || !!(data && data.can_add_friend);
            state.emojiPanelOpen = false;
            state.plusPanelOpen = false;
            state.homeAddMenuOpen = false;
            state.emojiPanelTab = 'standard';
            state.emojiAssets = bootstrapEmojiAssets;
            state.emojiAssetsLoaded = hasBootstrapEmojiAssets;
            state.emojiAssetsLoading = false;
            state.emojiAssetsError = '';
            window.AKIMEmojiAssets = bootstrapEmojiAssets.slice();
            window.AK_IM_EMOJI_ASSETS = bootstrapEmojiAssets.slice();
            state.contacts = [];
            state.contactsLoaded = false;
            state.contactsLoading = false;
            state.contactsError = '';
	            state.contactSections = [];
            state.contactSearchKeyword = '';
	            state.contactSearchMode = 'contacts';
	            state.friendSearchResults = [];
	            state.friendSearchLoading = false;
	            state.friendSearchError = '';
	            state.friendSearchActionUsername = '';
	            state.blacklistItems = [];
	            state.blacklistLoaded = false;
	            state.blacklistLoading = false;
	            state.blacklistError = '';
	            state.blacklistActionUsername = '';
	            state.actionSheetOpen = false;
	            state.actionSheetMessageId = 0;
	            state.actionSheetConversationId = 0;
	            state.actionSheetCanRecall = false;
	            state.actionSheetDraftText = '';
	            state.actionSheetContactUsername = '';
	            state.actionSheetMode = '';
	            state.actionSheetSessionPinned = false;
	            state.actionSheetSessionSystemPinned = false;
            state.profileLoaded = false;
            state.profileLoading = false;
            state.profileError = '';
            state.profileRefreshing = false;
            state.profileAvatarUploading = false;
            state.profileAvatarUploadProgress = 0;
            state.profileSaving = false;
            state.profileSaveError = '';
            state.profileSettingsSaving = false;
            state.profileSettingsError = '';
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
                honor_name: state.honorName,
                can_add_friend: state.canAddFriend,
                hide_honor: !!(data && data.hide_honor),
                avatar_style: 'thumbs',
                avatar_url: data && data.avatar_url
            }) : null;
            syncProfileDraftFromProfile();
            if (!state.allowed) {
                state.sessions = [];
                state.activeConversationId = 0;
                state.activeMessages = [];
                state.activeMessagesLoading = false;
                render();
                return null;
            }
            ensureWebSocket();
            const imageModule = getImageModule();
            if (imageModule && typeof imageModule.loadUploadConfig === 'function') {
                imageModule.loadUploadConfig(false).catch(function() {
                    return null;
                });
            }
            return loadSessions().then(function() {
                if (!applyInitialOpenRequest()) {
                    ensureHomeTabData(state.homeTab);
                }
                return null;
            });
        }).catch(function() {
            const retryDelay = BOOTSTRAP_REQUEST_RETRY_DELAYS[currentRetryCount];
            if (getCanonicalUsername() && retryDelay) {
                return waitMs(retryDelay).then(function() {
                    return loadBootstrap(currentRetryCount + 1);
                });
            }
            return applyBootstrapUnavailable();
        });
    }

    function loadBootstrapWhenIdentityReady(attempt) {
        const currentAttempt = Number(attempt || 0);
        if (getCanonicalUsername()) {
            return loadBootstrap(0);
        }
        const retryDelay = BOOTSTRAP_IDENTITY_RETRY_DELAYS[currentAttempt];
        if (!retryDelay) {
            return applyBootstrapUnavailable();
        }
        return waitMs(retryDelay).then(function() {
            return loadBootstrapWhenIdentityReady(currentAttempt + 1);
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
            state.activeMessagesLoading = false;
            closeReadProgressPanel();
	        closeMemberPanel();
	        closeSettingsPanel({ silent: true });
            state.composerMode = 'text';
            state.voiceHoldState = 'idle';
            state.voiceHoldStatusText = '';
            if (state.view === 'chat') state.view = 'sessions';
        }
        render();
        return Promise.resolve(null);
    }

    function loadMessages(conversationId) {
        const targetConversationId = Number(conversationId || 0);
        if (!targetConversationId) {
            state.activeMessages = [];
            state.activeMessagesLoading = false;
            render();
            return Promise.resolve(null);
        }
        state.activeMessagesLoading = true;
        if (!state.activeMessages.length) {
            render();
        }
        return ensureChatFeatureModules().then(function() {
            const messageManageModule = getMessageManageModule();
            if (messageManageModule && typeof messageManageModule.loadMessages === 'function') {
                return messageManageModule.loadMessages(targetConversationId);
            }
            state.activeMessages = [];
            state.activeMessagesLoading = false;
            render();
            return null;
        });
    }

    function startDirectSession() {
        if (!state.allowed) return;
        closeEmojiPicker({ silent: true });
        closePlusPanel({ silent: true });
        closeHomeAddMenu({ silent: true });
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
        const content = inputEl ? String(inputEl.value || '').trim() : '';
        const groupAdminsModule = getGroupAdminsModule();
        if (content && groupAdminsModule && typeof groupAdminsModule.handleComposerCommand === 'function' && groupAdminsModule.handleComposerCommand(content)) {
            if (inputEl) inputEl.value = '';
            state.inputValue = '';
            syncInputHeight();
            syncComposerState();
            return Promise.resolve(null);
        }
        if (content === '开启全体禁言' || content === '关闭全体禁言') {
            return ensureOptionalLazyModule('groupAdmins').then(function(nextGroupAdminsModule) {
                if (nextGroupAdminsModule && typeof nextGroupAdminsModule.handleComposerCommand === 'function' && nextGroupAdminsModule.handleComposerCommand(content)) {
                    if (inputEl) inputEl.value = '';
                    state.inputValue = '';
                    syncInputHeight();
                    syncComposerState();
                    return null;
                }
                const messageManageModule = getMessageManageModule();
                if (messageManageModule && typeof messageManageModule.sendCurrentMessage === 'function') {
                    return messageManageModule.sendCurrentMessage();
                }
                if (Number(state.activeConversationId || 0) > 0) {
                    window.alert('消息模块暂不可用，请刷新页面后重试');
                }
                return null;
            });
        }
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
        bindComposerOutsideDismissEvents();
        render();
        loadBootstrapWhenIdentityReady(0);
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
