(function(global) {
    'use strict';

    const STYLE_ID = 'ak-im-call-overlay-style';
    const PANEL_SELECTOR = '.ak-im-call-overlay';
    const SHELL_VERSION = '20260606-8';
    const PEER_DISCONNECT_GRACE_MS = 3500;
    const PEER_STATE_MUTE_MS = 1500;
    const REMOTE_EARPIECE_VOLUME = 0.1;
    const REMOTE_SPEAKER_VOLUME = 1;
    const CALL_MODES = {
        idle: 'idle',
        outgoing: 'outgoing',
        incoming: 'incoming',
        connecting: 'connecting',
        active: 'active',
        ended: 'ended',
        failed: 'failed'
    };
    const CALL_STATUS_TEXT = {
        idle: '',
        outgoing: '等待对方接听',
        incoming: '对方发来通话请求',
        connecting: '正在连接',
        active: '正在通话',
        ended: '通话已结束',
        failed: '通话失败'
    };
    const CALL_FAIL_REASON_TEXT = {
        busy: '对方或当前会话正在通话中',
        rejected: '对方已拒绝本次通话',
        timeout: '对方在 30 秒内未接听',
        media_denied: '无法使用麦克风，请检查浏览器权限',
        socket_error: '通话信令连接失败',
        socket_timeout: '通话请求未得到服务器确认',
        socket_unavailable: '通话服务暂不可用',
        unsupported: '当前浏览器不支持实时语音通话',
        call_not_found: '当前通话会话不存在或已失效',
        peer_not_found: '未找到可用的对端会话',
        invalid_target: '当前无法向该目标发起通话',
        forbidden: '当前账号无权执行该通话操作',
        peer_connection_failed: '语音连接已中断'
    };
    const LOCAL_TERMINATION_ECHO_TTL_MS = 5000;
    const PENDING_OUTGOING_CANCEL_TTL_MS = 15000;
    const CALL_HANGUP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="M5.15 14.55c4.18-2.94 9.52-2.94 13.7 0 .76.54.96 1.58.44 2.36l-1.05 1.58c-.43.65-1.26.9-1.98.6l-2.03-.86a1.55 1.55 0 0 1-.92-1.65l.14-.98a10.33 10.33 0 0 0-2.9 0l.14.98c.1.7-.27 1.37-.92 1.65l-2.03.86c-.72.3-1.55.05-1.98-.6L4.71 16.9c-.52-.78-.32-1.82.44-2.36Z"></path></svg>';
    const CALL_ICON_MARKUP = {
        close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',
        minimize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"></path></svg>',
        phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.8 4.8c2.5 0 4.5 2 4.5 4.5v1c0 .7.5 1.2 1.2 1.2h.8c1.1 0 2 .9 2 2v1.2c0 .9-.8 1.7-1.7 1.7h-1.7c-4.4 0-8-3.6-8-8V6.5c0-.9.8-1.7 1.7-1.7Z"></path><path d="M15.2 6.2a5.5 5.5 0 0 1 2.6 2.6"></path><path d="M14.7 3.8a8.9 8.9 0 0 1 5.5 5.5"></path></svg>',
        video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.8" y="6.9" width="11.8" height="10.2" rx="2.2"></rect><path d="m15.6 10 4.6-2.7v9.4L15.6 14Z"></path></svg>',
        incoming: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4v5.4h5.4"></path><path d="m21.4 4-6 6"></path><path d="M6.8 4.8c2.5 0 4.5 2 4.5 4.5v1c0 .7.5 1.2 1.2 1.2h.8c1.1 0 2 .9 2 2v1.2c0 .9-.8 1.7-1.7 1.7h-1.7c-4.4 0-8-3.6-8-8V6.5c0-.9.8-1.7 1.7-1.7Z"></path></svg>',
        waiting: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v6l4 2"></path></svg>',
        active: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.8 4.8c2.5 0 4.5 2 4.5 4.5v1c0 .7.5 1.2 1.2 1.2h.8c1.1 0 2 .9 2 2v1.2c0 .9-.8 1.7-1.7 1.7h-1.7c-4.4 0-8-3.6-8-8V6.5c0-.9.8-1.7 1.7-1.7Z"></path><path d="M10 12.2h4.5"></path><path d="M15.2 6.2a5.5 5.5 0 0 1 2.6 2.6"></path></svg>',
        success: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"></path></svg>',
        warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path></svg>',
        ended: CALL_HANGUP_ICON,
        accept: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.8 4.8c2.5 0 4.5 2 4.5 4.5v1c0 .7.5 1.2 1.2 1.2h.8c1.1 0 2 .9 2 2v1.2c0 .9-.8 1.7-1.7 1.7h-1.7c-4.4 0-8-3.6-8-8V6.5c0-.9.8-1.7 1.7-1.7Z"></path><path d="m10 12.2 1.6 1.6 3.2-3.2"></path></svg>',
        reject: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.8 4.8c2.5 0 4.5 2 4.5 4.5v1c0 .7.5 1.2 1.2 1.2h.8c1.1 0 2 .9 2 2v1.2c0 .9-.8 1.7-1.7 1.7h-1.7c-4.4 0-8-3.6-8-8V6.5c0-.9.8-1.7 1.7-1.7Z"></path><path d="m15.8 6.8 3.6 3.6"></path><path d="m19.4 6.8-3.6 3.6"></path></svg>',
        hangup: CALL_HANGUP_ICON,
        cancel: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.8 4.8c2.5 0 4.5 2 4.5 4.5v1c0 .7.5 1.2 1.2 1.2h.8c1.1 0 2 .9 2 2v1.2c0 .9-.8 1.7-1.7 1.7h-1.7c-4.4 0-8-3.6-8-8V6.5c0-.9.8-1.7 1.7-1.7Z"></path><path d="m15.8 6.8 3.6 3.6"></path><path d="m19.4 6.8-3.6 3.6"></path></svg>',
        mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Z"></path><path d="M19 10v2a7 7 0 1 1-14 0v-2"></path><path d="M12 19v3"></path></svg>',
        unmute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16"></path><path d="M9 9v3a3 3 0 0 0 5.12 2.12"></path><path d="M12 3a3 3 0 0 1 3 3v3"></path><path d="M19 10v2a7 7 0 0 1-11.06 5.8"></path><path d="M12 19v3"></path></svg>',
        speaker_on: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14h4l5 4V6L8 10H4Z"></path><path d="M17 9.5a4.5 4.5 0 0 1 0 5"></path><path d="M19.8 7a8.2 8.2 0 0 1 0 10"></path></svg>',
        speaker_off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14h4l5 4V6L8 10H4Z"></path><path d="m16.5 9.5 5 5"></path><path d="m21.5 9.5-5 5"></path></svg>',
        camera_on: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.7" y="6.9" width="11.6" height="10.2" rx="2.2"></rect><path d="m15.3 10 5-2.9v9.8l-5-2.9Z"></path></svg>',
        camera_off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16"></path><path d="M10.4 6.9h4.9V10"></path><path d="M15.3 14.1v.8c0 1.2-1 2.2-2.2 2.2H5.9c-1.2 0-2.2-1-2.2-2.2V9.1c0-1 .7-1.9 1.6-2.1"></path><path d="m17.2 9 3.1-1.9v9.8l-5-2.9"></path></svg>',
        camera_switch: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7.5 9.3 5.8h5.4L16 7.5"></path><rect x="4" y="7.5" width="16" height="11" rx="2.6"></rect><path d="M9 13.2a3.2 3.2 0 0 1 5.2-2.5"></path><path d="m14.1 8.9.2 2.6-2.6.2"></path><path d="M15 12.8a3.2 3.2 0 0 1-5.2 2.5"></path><path d="m9.9 17.1-.2-2.6 2.6-.2"></path></svg>',
        float_window: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="11.5" height="13" rx="2.2"></rect><rect x="12.8" y="10.8" width="7.2" height="8.2" rx="1.8"></rect></svg>'
    };
    const VIDEO_QUALITY_PROFILES = {
        hd: { width: 1280, height: 720, minWidth: 960, minHeight: 540, frameRate: 30, maxBitrate: 2800000, label: '高清' },
        sd: { width: 960, height: 540, minWidth: 640, minHeight: 360, frameRate: 24, maxBitrate: 1400000, label: '标清' },
        ld: { width: 640, height: 360, frameRate: 18, maxBitrate: 650000, label: '流畅' },
        vld: { width: 426, height: 240, frameRate: 12, maxBitrate: 260000, label: '省流' }
    };
    const VIDEO_PROFILE_ORDER = ['vld', 'ld', 'sd', 'hd'];

    function trim(value) {
        return String(value || '').trim();
    }

    function normalizeCallKind(value) {
        return trim(value).toLowerCase() === 'video' ? 'video' : 'audio';
    }

    function isVideoCallKind(value) {
        return normalizeCallKind(value) === 'video';
    }

    function getCallKindLabel(kind) {
        return isVideoCallKind(kind) ? '视频通话' : '语音通话';
    }

    function getCallRestoreLabel(kind) {
        return isVideoCallKind(kind) ? '返回视频通话' : '返回语音通话';
    }

    function getAvatarInitial(value) {
        const normalized = trim(value);
        return (normalized ? normalized.slice(0, 1) : 'C').toUpperCase();
    }

    function resolveAvatarUrlFromValue(value) {
        if (!value) return '';
        if (typeof value === 'string') return trim(value);
        if (typeof value !== 'object') return '';
        const directUrl = trim(
            value.peerAvatarUrl ||
            value.peer_avatar_url ||
            value.avatarUrl ||
            value.avatar_url ||
            value.senderAvatarUrl ||
            value.sender_avatar_url ||
            value.callerAvatarUrl ||
            value.caller_avatar_url ||
            value.url ||
            value.src
        );
        if (directUrl) return directUrl;
        return resolveAvatarUrlFromValue(value.peerAvatar || value.peer_avatar || value.avatar || value.senderAvatar || value.sender_avatar || value.callerAvatar || value.caller_avatar);
    }

    function getVideoProfileOrder(profile) {
        const normalized = trim(profile).toLowerCase();
        const index = VIDEO_PROFILE_ORDER.indexOf(normalized);
        return index >= 0 ? index : VIDEO_PROFILE_ORDER.indexOf('sd');
    }

    function getVideoProfileLabel(profile) {
        const normalized = trim(profile).toLowerCase();
        return VIDEO_QUALITY_PROFILES[normalized] ? VIDEO_QUALITY_PROFILES[normalized].label : '自适应';
    }

    function buildVideoQualityText(profile, health) {
        const qualityLabel = getVideoProfileLabel(profile);
        const normalizedHealth = trim(health).toLowerCase();
        if (normalizedHealth === 'weak') return '网络较弱 · 当前' + qualityLabel + '模式';
        if (normalizedHealth === 'normal') return '网络一般 · 当前' + qualityLabel + '模式';
        if (normalizedHealth === 'good') return '网络良好 · 当前' + qualityLabel + '模式';
        return qualityLabel ? '当前' + qualityLabel + '模式' : '';
    }

    function adaptCallViewModel(view, kind, mode, meta) {
        const nextView = Object.assign({}, view || {});
        const normalizedKind = normalizeCallKind(kind);
        const viewMeta = meta && typeof meta === 'object' ? meta : {};
        const connectionPhase = trim(viewMeta.connectionPhase).toLowerCase();
        if (mode === CALL_MODES.incoming) nextView.footer = '';
        if (normalizedKind !== 'video') return nextView;
        nextView.badge = trim(nextView.badge).replace(/语音通话/g, '视频通话').replace(/语音/g, '视频');
        nextView.subtitle = trim(nextView.subtitle).replace(/语音通话/g, '视频通话').replace(/语音连接/g, '视频连接').replace(/语音/g, '视频');
        nextView.headline = trim(nextView.headline).replace(/语音通话/g, '视频通话').replace(/语音通道/g, '视频通道').replace(/语音设备/g, '音视频设备').replace(/语音/g, '视频');
        nextView.detailTitle = trim(nextView.detailTitle).replace(/语音通话/g, '视频通话').replace(/语音连接/g, '视频连接').replace(/语音设备/g, '音视频设备').replace(/语音/g, '视频');
        nextView.detailBody = trim(nextView.detailBody)
            .replace(/语音通话/g, '视频通话')
            .replace(/语音连接/g, '视频连接')
            .replace(/语音设备/g, '音视频设备')
            .replace(/麦克风权限/g, '麦克风和摄像头权限')
            .replace(/麦克风/g, '麦克风和摄像头')
            .replace(/语音/g, '视频');
        nextView.footer = trim(nextView.footer).replace(/语音通话/g, '视频通话').replace(/语音/g, '视频');
        if (nextView.icon === 'phone' || nextView.icon === 'incoming' || nextView.icon === 'active') {
            nextView.icon = 'video';
        }
        if (mode === CALL_MODES.outgoing) {
            const displayName = trim(viewMeta.peerName) || '联系人';
            if (!viewMeta.localVideoReady) {
                nextView.detailTitle = '正在准备摄像头和麦克风';
                nextView.detailBody = '建立视频通话前，需要先完成本地音视频设备初始化。';
            } else {
                nextView.headline = '等待对方接受邀请';
                nextView.detailTitle = displayName;
                nextView.detailBody = '视频通话';
            }
        }
        if (mode === CALL_MODES.incoming) {
            nextView.badge = '收到视频来电';
            nextView.headline = '是否接听本次视频通话';
            nextView.detailTitle = '接听前会请求麦克风和摄像头权限';
            nextView.detailBody = '如果你现在不方便出镜，可以先拒绝，稍后再回拨。';
            nextView.footer = '';
            nextView.icon = 'video';
        }
        if (mode === CALL_MODES.connecting) {
            const displayName = trim(viewMeta.peerName) || '联系人';
            if (!viewMeta.localVideoReady && (connectionPhase === 'accepting' || connectionPhase === 'preparing_local')) {
                nextView.detailTitle = '正在准备摄像头和麦克风';
                nextView.detailBody = '浏览器需要先完成本地音视频设备初始化，之后才会继续交换连接信息。';
            } else if (viewMeta.localVideoReady) {
                nextView.headline = '正在建立视频连接';
                nextView.detailTitle = displayName;
                nextView.detailBody = '视频通话';
            }
            nextView.footer = '';
        }
        if (mode === CALL_MODES.active) {
            const remoteVideoReady = !!viewMeta.remoteVideoReady;
            nextView.badge = '视频通话中';
            nextView.subtitle = remoteVideoReady
                ? (trim(nextView.subtitle) || '画面已接通')
                : '语音已接通，正在等待对方画面';
            nextView.detailTitle = remoteVideoReady ? '当前视频与音频均已接通' : '当前语音已接通，正在等待对方画面';
            nextView.detailBody = remoteVideoReady
                ? '对方画面会直接显示在主视图，本地画面会保留在右上角小窗。'
                : '如果这里长时间没有出现对方画面，通常是对端摄像头权限、设备占用或网络质量导致的。';
            nextView.footer = '';
            nextView.icon = 'video';
        }
        if ((mode === CALL_MODES.failed || mode === CALL_MODES.ended) && nextView.icon === 'phone') {
            nextView.icon = 'video';
        }
        return nextView;
    }

    function normalizeReasonCode(value) {
        const normalized = trim(value).toLowerCase();
        if (!normalized) return '';
        if (normalized === 'busy') return 'busy';
        if (normalized === 'rejected') return 'rejected';
        if (normalized === 'timeout') return 'timeout';
        if (normalized === 'media_denied') return 'media_denied';
        if (normalized === 'socket_error') return 'socket_error';
        if (normalized === 'socket_timeout') return 'socket_timeout';
        if (normalized === 'socket_unavailable') return 'socket_unavailable';
        if (normalized === 'unsupported') return 'unsupported';
        if (normalized === 'call_not_found') return 'call_not_found';
        if (normalized === 'peer_not_found') return 'peer_not_found';
        if (normalized === 'invalid_target') return 'invalid_target';
        if (normalized === 'forbidden') return 'forbidden';
        if (normalized === 'peer_connection_failed') return 'peer_connection_failed';
        if (normalized === 'hangup') return 'hangup';
        if (normalized === 'cancel' || normalized === 'cancelled') return 'cancel';
        return normalized;
    }

    function getIconMarkup(name) {
        return CALL_ICON_MARKUP[String(name || '').trim()] || CALL_ICON_MARKUP.phone;
    }

    function buildActionMarkup(config) {
        const actionConfig = config && typeof config === 'object' ? config : {};
        const appearance = trim(actionConfig.appearance).toLowerCase() || 'tool';
        const label = trim(actionConfig.label);
        const iconName = trim(actionConfig.icon);
        if (appearance === 'pill') {
            return [
                iconName ? '<span class="ak-im-call-overlay-action-pill-icon" aria-hidden="true">' + getIconMarkup(iconName) + '</span>' : '',
                '<span class="ak-im-call-overlay-action-label">', label, '</span>'
            ].join('');
        }
        return [
            '<span class="ak-im-call-overlay-action-disc" aria-hidden="true">',
            getIconMarkup(iconName),
            '</span>',
            '<span class="ak-im-call-overlay-action-label">', label, '</span>'
        ].join('');
    }

    function buildHeaderStatusText(view) {
        const badge = trim(view && view.badge);
        const subtitle = trim(view && view.subtitle);
        if (badge && subtitle) return badge + ' · ' + subtitle;
        return badge || subtitle || '';
    }

    function padDurationUnit(value) {
        return String(Math.max(0, Number(value) || 0)).padStart(2, '0');
    }

    function formatCallDuration(totalSeconds) {
        const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const seconds = safeSeconds % 60;
        if (hours > 0) {
            return [hours, minutes, seconds].map(padDurationUnit).join(':');
        }
        return [minutes, seconds].map(padDurationUnit).join(':');
    }

    function buildOutgoingPhaseView(hasCallId) {
        if (!hasCallId) {
            return {
                badge: '正在发起',
                subtitle: '等待服务器确认本次通话',
                headline: '正在创建语音通话',
                detailTitle: '请求已经发出',
                detailBody: '如果这里长时间没有变化，通常表示服务端还没有确认通话会话。',
                footer: '你可以随时取消本次呼叫。',
                icon: 'waiting',
                pending: true
            };
        }
        return {
            badge: '等待接听',
            subtitle: '对方已经收到语音通话邀请',
            headline: '等待对方接听',
            detailTitle: '通话邀请已送达',
            detailBody: '当前会话已建立成功，正在等待对方决定是否接听。',
            footer: '30 秒内无人接听会自动结束。',
            icon: 'phone',
            pending: true
        };
    }

    function buildConnectingPhaseView(displayName, role, phase) {
        const normalizedRole = trim(role).toLowerCase();
        const normalizedPhase = trim(phase).toLowerCase();
        if (normalizedPhase === 'accepting') {
            return {
                badge: '正在连接',
                subtitle: '正在请求麦克风权限',
                headline: '正在准备接听 ' + displayName,
                detailTitle: '需要先启用你的麦克风',
                detailBody: '只有拿到浏览器麦克风权限后，才能继续建立语音通话。',
                footer: '如果权限被拦截，本次通话会直接失败。',
                icon: 'waiting',
                pending: true
            };
        }
        if (normalizedPhase === 'accepted') {
            return {
                badge: '正在连接',
                subtitle: normalizedRole === 'caller' ? '对方已接听，正在准备你的麦克风' : '双方已确认接听，正在进入连接阶段',
                headline: normalizedRole === 'caller' ? displayName + ' 已接听，正在接通' : '正在建立语音通道',
                detailTitle: '通话已进入接通前最后阶段',
                detailBody: normalizedRole === 'caller'
                    ? '下一步会启用你的麦克风，并开始交换语音连接信息。'
                    : '双方已经确认继续通话，马上开始建立音频通道。',
                footer: '如果这里停留过久，多半是浏览器权限或本地设备问题。',
                icon: 'waiting',
                pending: true
            };
        }
        if (normalizedPhase === 'preparing_local') {
            return {
                badge: '正在连接',
                subtitle: normalizedRole === 'caller' ? '正在启用你的麦克风' : '正在准备本地麦克风',
                headline: '正在准备语音设备',
                detailTitle: '浏览器正在初始化音频输入',
                detailBody: '麦克风准备完成后，会继续交换语音连接信息。',
                footer: '如浏览器弹出权限提示，请允许使用麦克风。',
                icon: 'waiting',
                pending: true
            };
        }
        if (normalizedPhase === 'negotiating') {
            return {
                badge: '正在连接',
                subtitle: '正在交换语音连接信息',
                headline: '正在建立语音通道',
                detailTitle: '本地与对方正在完成协商',
                detailBody: '通常几秒内就会接通；如果卡住，多半是网络或浏览器实时通信链路问题。',
                footer: '你可以随时取消本次通话。',
                icon: 'waiting',
                pending: true
            };
        }
        return {
            badge: '正在连接',
            subtitle: '双方已进入语音连接阶段',
            headline: '正在建立语音通道',
            detailTitle: '正在准备音频流',
            detailBody: '通常几秒内就会接通；如果卡住，多半是网络或麦克风权限问题。',
            footer: '你可以随时取消本次通话。',
            icon: 'waiting',
            pending: true
        };
    }

    function buildCallViewModel(mode, reason, hasCallId, peerName, muted, meta) {
        const displayName = trim(peerName) || '联系人';
        const normalizedReason = normalizeReasonCode(reason);
        const endReason = trim(meta && meta.endReason).toLowerCase();
        const actorRole = trim(meta && meta.actorRole).toLowerCase();
        const role = trim(meta && meta.role).toLowerCase();
        const wasEverConnected = !!(meta && meta.wasEverConnected);
        const connectionPhase = trim(meta && meta.connectionPhase).toLowerCase();
        const durationText = trim(meta && meta.durationText);
        if (mode === CALL_MODES.outgoing) {
            const outgoingView = buildOutgoingPhaseView(hasCallId);
            if (hasCallId) outgoingView.headline = '等待 ' + displayName + ' 接听';
            return outgoingView;
        }
        if (mode === CALL_MODES.incoming) {
            return {
                badge: '收到来电',
                subtitle: displayName + ' 正在呼叫你',
                headline: '是否接听本次语音通话',
                detailTitle: '接听前会请求麦克风权限',
                detailBody: '如果你现在不方便，可以直接拒绝这次来电。',
                footer: '右上角只保留最小化，真正的决定只用接听或拒绝。',
                icon: 'incoming',
                pending: true
            };
        }
        if (mode === CALL_MODES.connecting) {
            return buildConnectingPhaseView(displayName, role, connectionPhase);
        }
        if (mode === CALL_MODES.active) {
            return {
                badge: '语音通话中',
                subtitle: durationText ? '已通话 ' + durationText : '连接已经建立',
                headline: '正在和 ' + displayName + ' 通话',
                detailTitle: muted ? '你的麦克风已静音' : '你的麦克风正在工作',
                detailBody: muted ? '点击“取消静音”即可恢复说话。' : '当前语音连接已接通，双方现在可以正常说话。',
                footer: muted ? '当前你处于静音状态，对方暂时听不到你的声音。' : '你可以随时静音自己的麦克风，或直接结束通话。',
                icon: 'active',
                pending: false
            };
        }
        if (mode === CALL_MODES.ended) {
            if (endReason === 'cancel') {
                return {
                    badge: '通话已结束',
                    subtitle: actorRole && actorRole === role ? '你已取消本次呼叫' : '本次呼叫已取消',
                    headline: actorRole && actorRole === role ? '已取消呼叫' : '通话已结束',
                    detailTitle: '本次呼叫没有继续建立连接',
                    detailBody: actorRole && actorRole === role
                        ? '你已主动取消本次呼叫，如需继续沟通，可以重新发起语音通话。'
                        : '本次呼叫已被取消，如需继续沟通，可以重新发起语音通话。',
                    footer: '窗口将自动关闭。',
                    icon: 'ended',
                    pending: false
                };
            }
            if (endReason === 'hangup') {
                if (wasEverConnected && actorRole && actorRole === role) {
                    return {
                        badge: '通话已结束',
                        subtitle: '你已结束本次通话',
                        headline: '通话已结束',
                        detailTitle: durationText ? '本次通话时长 ' + durationText : '本次通话已结束',
                        detailBody: '如需继续沟通，可以重新发起语音通话。',
                        footer: '窗口将自动关闭。',
                        icon: 'ended',
                        pending: false
                    };
                }
                if (!wasEverConnected && actorRole === 'caller' && role === 'callee') {
                    return {
                        badge: '通话请求已取消',
                        subtitle: '对方取消了本次通话请求',
                        headline: displayName + ' 已取消通话',
                        detailTitle: '本次通话没有继续等待',
                        detailBody: '你无需再处理这次通话请求，窗口会自动关闭。',
                        footer: '窗口将自动关闭。',
                        icon: 'ended',
                        pending: false
                    };
                }
                if (!wasEverConnected && actorRole === 'callee' && role === 'caller') {
                    return {
                        badge: '通话请求已结束',
                        subtitle: displayName + ' 没有继续这次通话',
                        headline: displayName + ' 已结束通话请求',
                        detailTitle: '本次呼叫没有进入已接通状态',
                        detailBody: '这不是无人接听超时，而是对方在接通前主动结束了这次通话。',
                        footer: '窗口将自动关闭。',
                        icon: 'ended',
                        pending: false
                    };
                }
                return {
                    badge: '通话已结束',
                    subtitle: wasEverConnected ? '对方结束了本次通话' : '通话请求已经结束',
                    headline: wasEverConnected ? '对方已挂断' : '通话已结束',
                    detailTitle: wasEverConnected && durationText ? '本次通话时长 ' + durationText : (wasEverConnected ? '语音连接已经断开' : '本次呼叫没有继续保持'),
                    detailBody: wasEverConnected ? '如果还需要继续沟通，可以重新发起语音通话。' : '如需继续沟通，可以重新发起通话。',
                    footer: '窗口将自动关闭。',
                    icon: 'ended',
                    pending: false
                };
            }
            return {
                badge: '通话已结束',
                subtitle: '本次语音通话已经结束',
                headline: '通话已结束',
                detailTitle: durationText ? '本次通话时长 ' + durationText : '语音连接已关闭',
                detailBody: '如果还需要继续沟通，可以重新发起语音通话。',
                footer: '窗口将自动关闭。',
                icon: 'ended',
                pending: false
            };
        }
        if (mode === CALL_MODES.failed) {
            if (normalizedReason === 'peer_connection_failed' && durationText) {
                return {
                    badge: '连接中断',
                    subtitle: '语音连接在通话过程中断开',
                    headline: '本次通话中途断开',
                    detailTitle: '已通话 ' + durationText + ' 后连接中断',
                    detailBody: '这通常是网络波动或浏览器实时通信链路断开导致的。',
                    footer: '窗口将自动关闭。',
                    icon: 'warning',
                    pending: false
                };
            }
            if (normalizedReason === 'busy') {
                return {
                    badge: '对方忙线',
                    subtitle: '对方当前无法接听通话',
                    headline: '对方正在其他通话中',
                    detailTitle: '本次呼叫未建立',
                    detailBody: '服务端已明确返回忙线结果，不是网络波动造成的等待。',
                    footer: '窗口将自动关闭。',
                    icon: 'warning',
                    pending: false
                };
            }
            if (normalizedReason === 'rejected') {
                return {
                    badge: '对方已拒绝',
                    subtitle: '对方明确拒绝了本次语音通话',
                    headline: displayName + ' 已拒绝通话',
                    detailTitle: '这不是超时未接听',
                    detailBody: '对方主动点击了拒绝，本次呼叫不会继续等待到超时。',
                    footer: '窗口将自动关闭。',
                    icon: 'reject',
                    pending: false
                };
            }
            if (normalizedReason === 'timeout') {
                return {
                    badge: '对方未接听',
                    subtitle: '对方在 30 秒内没有接听',
                    headline: '本次通话无人接听',
                    detailTitle: '通话会话已自动结束',
                    detailBody: '服务端已经成功创建通话，只是对方一直没有接听。',
                    footer: '窗口将自动关闭。',
                    icon: 'warning',
                    pending: false
                };
            }
            if (normalizedReason === 'socket_timeout') {
                return {
                    badge: '服务器未确认',
                    subtitle: '通话请求没有得到服务端确认',
                    headline: '请求已发出，但会话未建立',
                    detailTitle: '问题出在服务端确认阶段',
                    detailBody: '当前没有拿到通话会话 ID，这不是对方未接听，而是服务端未及时确认。',
                    footer: '窗口将自动关闭。',
                    icon: 'warning',
                    pending: false
                };
            }
            const reasonText = CALL_FAIL_REASON_TEXT[normalizedReason] || CALL_STATUS_TEXT.failed;
            return {
                badge: '通话失败',
                subtitle: reasonText,
                headline: '本次语音通话未能建立',
                detailTitle: '失败原因',
                detailBody: reasonText,
                footer: '窗口将自动关闭。',
                icon: 'warning',
                pending: false
            };
        }
        return {
            badge: '语音通话',
            subtitle: '',
            headline: '等待通话连接',
            detailTitle: '',
            detailBody: '',
            footer: '',
            icon: 'phone',
            pending: false
        };
    }

    function buildCallActionLayout(mode, muted, speakerOn) {
        if (mode === CALL_MODES.incoming) {
            return {
                layout: 'double',
                reject: { visible: true, icon: '', label: '拒绝', variant: 'danger', prominence: 'secondary', slot: '1', appearance: 'pill' },
                accept: { visible: true, icon: '', label: '接听', variant: 'success', prominence: 'primary', slot: '2', appearance: 'pill' },
                mute: { visible: false },
                speaker: { visible: false },
                cameraSwitch: { visible: false },
                hangup: { visible: false }
            };
        }
        if (mode === CALL_MODES.active) {
            return {
                layout: 'active',
                reject: { visible: false },
                accept: { visible: false },
                mute: { visible: true, icon: muted ? 'unmute' : 'mute', label: muted ? '取消静音' : '静音', variant: muted ? 'primary' : 'neutral', prominence: 'secondary', slot: '1', appearance: 'tool', selected: muted },
                hangup: { visible: true, icon: 'hangup', label: '挂断', variant: 'danger', prominence: 'primary', slot: '2', appearance: 'tool' },
                speaker: { visible: true, icon: speakerOn ? 'speaker_on' : 'speaker_off', label: speakerOn ? '免提已开' : '免提', variant: speakerOn ? 'primary' : 'neutral', prominence: 'secondary', slot: '3', appearance: 'tool', selected: speakerOn },
                cameraSwitch: { visible: false }
            };
        }
        if (mode === CALL_MODES.outgoing || mode === CALL_MODES.connecting) {
            return {
                layout: 'single',
                reject: { visible: false },
                accept: { visible: false },
                mute: { visible: false },
                speaker: { visible: false },
                cameraSwitch: { visible: false },
                hangup: { visible: true, icon: 'cancel', label: '取消呼叫', variant: 'danger', prominence: 'primary', slot: '2', appearance: 'tool' }
            };
        }
        return {
            layout: 'hidden',
                reject: { visible: false },
                accept: { visible: false },
                mute: { visible: false },
                speaker: { visible: false },
                cameraSwitch: { visible: false },
                hangup: { visible: false }
        };
    }

    function buildVideoCallActionLayout(mode, muted, speakerOn, cameraEnabled, canSwitchCamera) {
        if (mode === CALL_MODES.incoming) {
            return buildCallActionLayout(mode, muted, speakerOn);
        }
        if (mode === CALL_MODES.active) {
            return {
                layout: 'video-grid',
                reject: { visible: false },
                accept: { visible: false },
                mute: { visible: true, icon: muted ? 'unmute' : 'mute', label: muted ? '取消静音' : '静音', variant: muted ? 'primary' : 'neutral', prominence: 'secondary', slot: '1', appearance: 'tool', selected: muted },
                hangup: { visible: true, icon: 'hangup', label: '挂断', variant: 'danger', prominence: 'primary', slot: '2', appearance: 'tool' },
                camera: { visible: true, icon: cameraEnabled ? 'camera_on' : 'camera_off', label: cameraEnabled ? '摄像头' : '摄像头已关', variant: cameraEnabled ? 'neutral' : 'primary', prominence: 'secondary', slot: '3', appearance: 'tool', selected: !cameraEnabled },
                speaker: { visible: true, icon: speakerOn ? 'speaker_on' : 'speaker_off', label: speakerOn ? '免提已开' : '免提', variant: speakerOn ? 'primary' : 'neutral', prominence: 'secondary', slot: '4', appearance: 'tool', selected: speakerOn },
                cameraSwitch: { visible: !!canSwitchCamera, icon: 'camera_switch', label: '翻转', variant: 'neutral', prominence: 'secondary', slot: '6', appearance: 'tool' }
            };
        }
        if (mode === CALL_MODES.outgoing || mode === CALL_MODES.connecting) {
            return {
                layout: 'video-grid',
                reject: { visible: false },
                accept: { visible: false },
                mute: { visible: true, icon: muted ? 'unmute' : 'mute', label: muted ? '取消静音' : '静音', variant: muted ? 'primary' : 'neutral', prominence: 'secondary', slot: '1', appearance: 'tool', selected: muted },
                hangup: { visible: true, icon: 'hangup', label: '挂断', variant: 'danger', prominence: 'primary', slot: '2', appearance: 'tool' },
                camera: { visible: true, icon: cameraEnabled ? 'camera_on' : 'camera_off', label: cameraEnabled ? '摄像头' : '摄像头已关', variant: cameraEnabled ? 'neutral' : 'primary', prominence: 'secondary', slot: '3', appearance: 'tool', selected: !cameraEnabled },
                speaker: { visible: true, icon: speakerOn ? 'speaker_on' : 'speaker_off', label: speakerOn ? '免提已开' : '免提', variant: speakerOn ? 'primary' : 'neutral', prominence: 'secondary', slot: '4', appearance: 'tool', selected: speakerOn },
                cameraSwitch: { visible: !!canSwitchCamera, icon: 'camera_switch', label: '翻转', variant: 'neutral', prominence: 'secondary', slot: '6', appearance: 'tool' }
            };
        }
        const layout = buildCallActionLayout(mode, muted, speakerOn);
        return layout;
    }

    function resolveCallAutoCloseMs(mode, reason, meta) {
        if (mode === CALL_MODES.failed) {
            const normalizedReason = normalizeReasonCode(reason);
            if (normalizedReason === 'rejected') return 1800;
            if (normalizedReason === 'busy') return 2200;
            if (normalizedReason === 'socket_timeout') return 2600;
            return 2400;
        }
        const endReason = normalizeReasonCode(meta && meta.endReason);
        const wasEverConnected = !!(meta && meta.wasEverConnected);
        const actorRole = trim(meta && meta.actorRole).toLowerCase();
        const role = trim(meta && meta.role).toLowerCase();
        if (endReason === 'hangup' && !wasEverConnected && actorRole === 'caller' && role === 'callee') return 1500;
        if (endReason === 'hangup' && !wasEverConnected && actorRole === 'callee' && role === 'caller') return 1600;
        if (wasEverConnected) return 1700;
        return 1400;
    }

    function ensureModuleRegistry() {
        global.AKIMUserModules = global.AKIMUserModules || {};
        return global.AKIMUserModules;
    }

    function createSharedSocketSignalingModule(sharedCtx) {
        return {
            options: {},
            outboundQueue: [],
            flushTimer: 0,

            init(options) {
                this.options = options || {};
                return this;
            },

            canSend() {
                return !!(sharedCtx && typeof sharedCtx.sendSocketEnvelope === 'function');
            },

            scheduleFlush() {
                if (this.flushTimer) return;
                const self = this;
                this.flushTimer = global.setInterval(function() {
                    if (sharedCtx && typeof sharedCtx.ensureSharedSocket === 'function') {
                        try { sharedCtx.ensureSharedSocket(); } catch (e) {}
                    }
                    self.flushQueue();
                    if (!self.outboundQueue.length && self.flushTimer) {
                        global.clearInterval(self.flushTimer);
                        self.flushTimer = 0;
                    }
                }, 800);
            },

            flushQueue() {
                if (!this.canSend() || !this.outboundQueue.length) return;
                const pending = this.outboundQueue.splice(0);
                for (let index = 0; index < pending.length; index += 1) {
                    const item = pending[index];
                    let sent = false;
                    try {
                        sent = !!sharedCtx.sendSocketEnvelope(item.type, item.payload);
                    } catch (e) {
                        sent = false;
                    }
                    if (!sent) {
                        this.outboundQueue = pending.slice(index).concat(this.outboundQueue);
                        break;
                    }
                }
            },

            send(type, payload) {
                const message = { type: String(type || ''), payload: payload || {} };
                if (!message.type) return;
                if (sharedCtx && typeof sharedCtx.ensureSharedSocket === 'function') {
                    try { sharedCtx.ensureSharedSocket(); } catch (e) {}
                }
                if (!this.canSend()) {
                    this.emitError('socket_unavailable', '通话服务暂不可用');
                    return;
                }
                let sent = false;
                try {
                    sent = !!sharedCtx.sendSocketEnvelope(message.type, message.payload);
                } catch (e) {
                    sent = false;
                }
                if (sent) {
                    this.flushQueue();
                    return;
                }
                this.outboundQueue.push(message);
                this.scheduleFlush();
            },

            emitError(reason, message) {
                if (this.options && typeof this.options.onError === 'function') {
                    this.options.onError(reason, message);
                }
            },

            destroy() {
                this.outboundQueue = [];
                if (this.flushTimer) {
                    global.clearInterval(this.flushTimer);
                    this.flushTimer = 0;
                }
            }
        };
    }

    function createBuiltInSignalingModule() {
        return {
            socket: null,
            socketReady: false,
            outboundQueue: [],
            options: {},

            init(options) {
                this.options = options || {};
                this.ensureSocket();
                return this;
            },

            getWsURL() {
                if (this.options && typeof this.options.getWsURL === 'function') {
                    return String(this.options.getWsURL() || '');
                }
                return '';
            },

            ensureSocket() {
                if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
                const wsURL = this.getWsURL();
                if (!wsURL) {
                    this.emitError('socket_unavailable', '通话服务地址不可用');
                    return;
                }
                try {
                    const socket = new WebSocket(wsURL);
                    this.socket = socket;
                    const self = this;
                    socket.addEventListener('open', function() {
                        self.socketReady = true;
                        self.flushQueue();
                    });
                    socket.addEventListener('message', function(event) {
                        self.handleMessage(event.data);
                    });
                    socket.addEventListener('close', function() {
                        self.socketReady = false;
                        if (self.socket === socket) self.socket = null;
                    });
                    socket.addEventListener('error', function() {
                        self.socketReady = false;
                        self.emitError('socket_error', '通话信令连接失败');
                    });
                } catch (error) {
                    this.socket = null;
                    this.socketReady = false;
                    this.emitError('socket_error', error && error.message ? error.message : '通话信令初始化失败');
                }
            },

            handleMessage(raw) {
                let data = null;
                try {
                    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
                } catch (e) {
                    return;
                }
                if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
                if (!data.type.startsWith('im.call.')) return;
                if (this.options && typeof this.options.onEvent === 'function') {
                    this.options.onEvent(data.type, data.payload && typeof data.payload === 'object' ? data.payload : {});
                }
            },

            send(type, payload) {
                const message = { type: String(type || ''), payload: payload || {} };
                if (!message.type) return;
                if (!this.socket || !this.socketReady || this.socket.readyState !== 1) {
                    this.outboundQueue.push(message);
                    this.ensureSocket();
                    return;
                }
                try {
                    this.socket.send(JSON.stringify(message));
                } catch (e) {
                    this.outboundQueue.push(message);
                    this.socketReady = false;
                    this.ensureSocket();
                }
            },

            flushQueue() {
                if (!this.socket || !this.socketReady || this.socket.readyState !== 1) return;
                while (this.outboundQueue.length > 0) {
                    const message = this.outboundQueue.shift();
                    try {
                        this.socket.send(JSON.stringify(message));
                    } catch (e) {
                        this.outboundQueue.unshift(message);
                        break;
                    }
                }
            },

            emitError(reason, message) {
                if (this.options && typeof this.options.onError === 'function') {
                    this.options.onError(reason, message);
                }
            },

            destroy() {
                this.outboundQueue = [];
                this.socketReady = false;
                if (this.socket) {
                    try { this.socket.close(); } catch (e) {}
                }
                this.socket = null;
            }
        };
    }

    function createBuiltInWebRTCModule() {
        return {
            pc: null,
            localStream: null,
            remoteStream: null,
            pendingCandidates: [],
            options: {},
            role: '',
            currentKind: 'audio',
            videoProfile: 'hd',
            facingMode: 'user',
            cameraEnabled: true,
            lastStatsSample: null,

            init(options) {
                this.options = options || {};
                return this;
            },

            isSupported() {
                return !!(global.navigator && global.navigator.mediaDevices && typeof global.navigator.mediaDevices.getUserMedia === 'function' && global.RTCPeerConnection);
            },

            getVideoProfileConfig(profile) {
                const normalized = trim(profile).toLowerCase();
                return VIDEO_QUALITY_PROFILES[normalized] || VIDEO_QUALITY_PROFILES.sd;
            },

            buildVideoConstraints(facingMode, options) {
                options = options || {};
                const profile = this.getVideoProfileConfig(this.videoProfile);
                const constraints = {
                    width: { ideal: profile.width },
                    height: { ideal: profile.height },
                    frameRate: { ideal: profile.frameRate, max: profile.frameRate },
                    facingMode: { ideal: trim(facingMode || this.facingMode || 'user') || 'user' },
                    resizeMode: 'crop-and-scale'
                };
                if (!options.relaxed && profile.minWidth && profile.minHeight) {
                    constraints.width.min = profile.minWidth;
                    constraints.height.min = profile.minHeight;
                }
                return constraints;
            },

            buildMediaConstraints(kind, options) {
                const normalizedKind = normalizeCallKind(kind || this.currentKind);
                const constraints = {
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    },
                    video: false
                };
                if (!isVideoCallKind(normalizedKind)) return constraints;
                constraints.video = this.buildVideoConstraints(this.facingMode, options);
                return constraints;
            },

            async startLocal(kind) {
                if (!this.isSupported()) throw new Error('当前浏览器不支持实时语音通话');
                this.currentKind = normalizeCallKind(kind || this.currentKind);
                if (this.localStream) return this.localStream;
                const constraints = this.buildMediaConstraints(this.currentKind);
                try {
                    this.localStream = await global.navigator.mediaDevices.getUserMedia(constraints);
            } catch (error) {
                if (!isVideoCallKind(this.currentKind)) throw error;
                this.localStream = await global.navigator.mediaDevices.getUserMedia(this.buildMediaConstraints(this.currentKind, { relaxed: true }));
            }
            if (isVideoCallKind(this.currentKind)) this.setCameraEnabled(this.cameraEnabled);
            this.emitLocalStream();
            return this.localStream;
        },

            async createPeer(role, kind) {
                this.role = String(role || '').toLowerCase();
                this.currentKind = normalizeCallKind(kind || this.currentKind);
                if (!this.localStream) await this.startLocal(kind);
                if (this.pc) return this.pc;
                const pc = new global.RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
                this.pc = pc;
                this.remoteStream = new global.MediaStream();
                const self = this;
                this.localStream.getTracks().forEach(function(track) {
                    pc.addTrack(track, self.localStream);
                });
                pc.addEventListener('icecandidate', function(event) {
                    if (!event.candidate) return;
                    self.emitSignal('ice', { candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate });
                });
                pc.addEventListener('track', function(event) {
                    event.streams.forEach(function(stream) {
                        stream.getTracks().forEach(function(track) {
                            self.remoteStream.addTrack(track);
                        });
                    });
                    self.emitRemoteStream();
                });
                pc.addEventListener('connectionstatechange', function() {
                    self.emitState(pc.connectionState || '');
                });
                return pc;
            },

            async createOffer(kind) {
                const pc = await this.createPeer('caller', kind);
                if (isVideoCallKind(kind || this.currentKind)) await this.applyVideoProfile(this.videoProfile);
                const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: isVideoCallKind(kind || this.currentKind) });
                await pc.setLocalDescription(offer);
                this.emitSignal('offer', { sdp: pc.localDescription });
            },

            async acceptOffer(sdp, kind) {
                const pc = await this.createPeer('callee', kind);
                if (isVideoCallKind(kind || this.currentKind)) await this.applyVideoProfile(this.videoProfile);
                await pc.setRemoteDescription(new global.RTCSessionDescription(sdp));
                await this.flushIceCandidates();
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                this.emitSignal('answer', { sdp: pc.localDescription });
            },

            async acceptAnswer(sdp) {
                if (!this.pc) return;
                await this.pc.setRemoteDescription(new global.RTCSessionDescription(sdp));
                await this.flushIceCandidates();
            },

            async addIceCandidate(candidate) {
                if (!this.pc || !candidate) return;
                if (!this.pc.remoteDescription) {
                    this.pendingCandidates.push(candidate);
                    return;
                }
                await this.pc.addIceCandidate(new global.RTCIceCandidate(candidate));
            },

            async flushIceCandidates() {
                if (!this.pc || !this.pc.remoteDescription) return;
                const items = this.pendingCandidates.splice(0);
                for (let index = 0; index < items.length; index += 1) {
                    await this.pc.addIceCandidate(new global.RTCIceCandidate(items[index]));
                }
            },

            setMuted(muted) {
                if (!this.localStream) return false;
                this.localStream.getAudioTracks().forEach(function(track) {
                    track.enabled = !muted;
                });
                return true;
            },

            setCameraEnabled(enabled) {
                this.cameraEnabled = enabled !== false;
                if (!this.localStream) return false;
                this.localStream.getVideoTracks().forEach(function(track) {
                    track.enabled = this.cameraEnabled;
                }, this);
                return true;
            },

            getFacingMode() {
                return this.facingMode;
            },

            getVideoSender() {
                if (!this.pc || typeof this.pc.getSenders !== 'function') return null;
                const senders = this.pc.getSenders();
                for (let index = 0; index < senders.length; index += 1) {
                    const sender = senders[index];
                    const track = sender && sender.track;
                    if (track && track.kind === 'video') return sender;
                }
                return null;
            },

            async switchCamera() {
                if (!this.isSupported() || !this.localStream || !isVideoCallKind(this.currentKind)) return false;
                const nextFacingMode = this.facingMode === 'user' ? 'environment' : 'user';
                const replacementStream = await global.navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: this.buildVideoConstraints(nextFacingMode)
                });
                const replacementTrack = replacementStream.getVideoTracks()[0] || null;
                if (!replacementTrack) {
                    replacementStream.getTracks().forEach(function(track) {
                        try { track.stop(); } catch (e) {}
                    });
                    return false;
                }
                replacementTrack.enabled = this.cameraEnabled !== false;
                const oldTrack = this.localStream.getVideoTracks()[0] || null;
                const sender = this.getVideoSender();
                if (sender && typeof sender.replaceTrack === 'function') {
                    try {
                        await sender.replaceTrack(replacementTrack);
                    } catch (error) {
                        try { replacementTrack.stop(); } catch (e) {}
                        throw error;
                    }
                }
                if (oldTrack) {
                    try { this.localStream.removeTrack(oldTrack); } catch (e) {}
                    try { oldTrack.stop(); } catch (e) {}
                }
                this.localStream.addTrack(replacementTrack);
                replacementStream.getAudioTracks().forEach(function(track) {
                    try { track.stop(); } catch (e) {}
                });
                const settings = typeof replacementTrack.getSettings === 'function' ? replacementTrack.getSettings() : {};
                this.facingMode = trim(settings && settings.facingMode) || nextFacingMode;
                this.emitLocalStream();
                return true;
            },

            async applyVideoProfile(profile) {
                const normalizedProfile = trim(profile).toLowerCase();
                const nextProfile = VIDEO_QUALITY_PROFILES[normalizedProfile] ? normalizedProfile : 'sd';
                this.videoProfile = nextProfile;
                if (!this.localStream || !isVideoCallKind(this.currentKind)) return false;
                const config = this.getVideoProfileConfig(nextProfile);
                const videoTrack = this.localStream.getVideoTracks()[0] || null;
                if (videoTrack && typeof videoTrack.applyConstraints === 'function') {
                    try {
                        await videoTrack.applyConstraints(this.buildVideoConstraints(this.facingMode));
                    } catch (e) {
                        try { await videoTrack.applyConstraints(this.buildVideoConstraints(this.facingMode, { relaxed: true })); } catch (ignored) {}
                    }
                }
                const sender = this.getVideoSender();
                if (sender && typeof sender.getParameters === 'function' && typeof sender.setParameters === 'function') {
                    try {
                        const parameters = sender.getParameters() || {};
                        parameters.encodings = parameters.encodings && parameters.encodings.length ? parameters.encodings : [{}];
                        parameters.encodings[0].maxBitrate = config.maxBitrate;
                        parameters.encodings[0].maxFramerate = config.frameRate;
                        await sender.setParameters(parameters);
                    } catch (e) {}
                }
                this.emitLocalStream();
                return true;
            },

            async readStatsSnapshot() {
                if (!this.pc || typeof this.pc.getStats !== 'function') return null;
                const report = await this.pc.getStats();
                const snapshot = {
                    availableOutgoingBitrate: 0,
                    outgoingBitrate: 0,
                    roundTripTime: 0,
                    packetsLost: 0,
                    jitter: 0,
                    framesPerSecond: 0,
                    qualityLimitationReason: '',
                    bytesSent: 0,
                    sampleTime: 0
                };
                report.forEach(function(stat) {
                    if (!stat || typeof stat !== 'object') return;
                    const statKind = trim(stat.kind || stat.mediaType);
                    if (stat.type === 'candidate-pair' && (stat.nominated || stat.selected)) {
                        if (Number(stat.availableOutgoingBitrate || 0) > 0) snapshot.availableOutgoingBitrate = Number(stat.availableOutgoingBitrate || 0);
                        if (Number(stat.currentRoundTripTime || 0) > 0) snapshot.roundTripTime = Number(stat.currentRoundTripTime || 0);
                    }
                    if (stat.type === 'outbound-rtp' && statKind === 'video') {
                        if (Number(stat.bytesSent || 0) > 0) snapshot.bytesSent += Number(stat.bytesSent || 0);
                        if (Number(stat.timestamp || 0) > 0) snapshot.sampleTime = Math.max(snapshot.sampleTime, Number(stat.timestamp || 0));
                        if (Number(stat.framesPerSecond || 0) > 0) snapshot.framesPerSecond = Number(stat.framesPerSecond || 0);
                        if (trim(stat.qualityLimitationReason)) snapshot.qualityLimitationReason = trim(stat.qualityLimitationReason);
                    }
                    if ((stat.type === 'remote-inbound-rtp' || stat.type === 'inbound-rtp') && statKind === 'video') {
                        if (Number(stat.packetsLost || 0) > 0) snapshot.packetsLost = Math.max(snapshot.packetsLost, Number(stat.packetsLost || 0));
                        if (Number(stat.jitter || 0) > 0) snapshot.jitter = Math.max(snapshot.jitter, Number(stat.jitter || 0));
                        if (!snapshot.roundTripTime && Number(stat.roundTripTime || 0) > 0) snapshot.roundTripTime = Number(stat.roundTripTime || 0);
                    }
                });
                const previous = this.lastStatsSample || null;
                if (previous && snapshot.bytesSent > 0 && snapshot.sampleTime > previous.sampleTime) {
                    const deltaBytes = snapshot.bytesSent - previous.bytesSent;
                    const deltaMs = snapshot.sampleTime - previous.sampleTime;
                    if (deltaBytes >= 0 && deltaMs > 0) {
                        snapshot.outgoingBitrate = Math.round((deltaBytes * 8 * 1000) / deltaMs);
                    }
                }
                if (snapshot.bytesSent > 0 && snapshot.sampleTime > 0) {
                    this.lastStatsSample = {
                        bytesSent: snapshot.bytesSent,
                        sampleTime: snapshot.sampleTime
                    };
                }
                return snapshot;
            },

            emitSignal(type, payload) {
                if (this.options && typeof this.options.onSignal === 'function') {
                    this.options.onSignal(type, payload || {});
                }
            },

            emitLocalStream() {
                if (this.options && typeof this.options.onLocalStream === 'function') {
                    this.options.onLocalStream(this.localStream);
                }
            },

            emitRemoteStream() {
                if (this.options && typeof this.options.onRemoteStream === 'function') {
                    this.options.onRemoteStream(this.remoteStream);
                }
            },

            emitState(state) {
                if (this.options && typeof this.options.onState === 'function') {
                    this.options.onState(state);
                }
            },

            close() {
                if (this.pc) {
                    try { this.pc.close(); } catch (e) {}
                }
                this.pc = null;
                if (this.localStream) {
                    this.localStream.getTracks().forEach(function(track) {
                        try { track.stop(); } catch (e) {}
                    });
                }
                this.localStream = null;
                this.remoteStream = null;
                this.pendingCandidates = [];
                this.role = '';
                this.currentKind = 'audio';
                this.videoProfile = 'hd';
                this.facingMode = 'user';
                this.cameraEnabled = true;
                this.lastStatsSample = null;
            }
        };
    }

    const callModule = {
        ctx: null,
        mode: CALL_MODES.idle,
        currentCallId: '',
        currentConversationId: 0,
        currentPeerName: '',
        currentPeerUsername: '',
        currentPeerAvatarUrl: '',
        currentKind: 'audio',
        role: '',
        muted: false,
        speakerEnabled: false,
        cameraEnabled: true,
        offerSent: false,
        timers: { autoEnd: 0, launch: 0, duration: 0, peerDisconnect: 0, videoQuality: 0 },
        refs: {},
        lastFailReason: '',
        lastEndReason: '',
        lastEndActor: '',
        lastEndActorRole: '',
        everConnectedAt: 0,
        activeStartedAt: 0,
        liveDurationText: '',
        lastDurationText: '',
        connectionPhase: '',
        localTermination: { action: '', role: '', callId: '', at: 0, wasEverConnected: false },
        flowVersion: 0,
        openedAt: 0,
        minimized: false,
        ignorePeerStateUntil: 0,
        terminalPresentation: 'panel',
        localVideoReady: false,
        remoteVideoReady: false,
        primaryVideoSource: 'remote',
        cameraSwitching: false,
        cameraFacingMode: 'user',
        qualityProfile: 'hd',
        qualityHealth: 'normal',
        qualityStatusText: '',
        qualityUpgradeStreak: 0,
        qualityDowngradeStreak: 0,
        qualityLastChangedAt: 0,
        bound: false,
        submodulePromise: null,
        signaling: null,
        webRTC: null,

        getShellMarkup() {
            return [
                '  <div class="ak-im-call-overlay-backdrop"></div>',
                '  <div class="ak-im-call-overlay-card" role="dialog" aria-modal="true" aria-label="通话面板">',
                '    <div class="ak-im-call-overlay-header">',
                '      <div class="ak-im-call-overlay-spacer" aria-hidden="true"></div>',
                '      <div class="ak-im-call-overlay-header-main">',
                '        <div class="ak-im-call-overlay-avatar" aria-hidden="true"></div>',
                '        <div class="ak-im-call-overlay-header-text">',
                '          <div class="ak-im-call-overlay-title">语音通话</div>',
                '          <div class="ak-im-call-overlay-subtitle"></div>',
                '        </div>',
                '      </div>',
                '      <button class="ak-im-call-overlay-minimize" type="button" aria-label="最小化"></button>',
                '    </div>',
                '    <div class="ak-im-call-overlay-stage">',
                '      <div class="ak-im-call-overlay-pulse"></div>',
                '      <div class="ak-im-call-overlay-placeholder">',
                '        <div class="ak-im-call-overlay-placeholder-icon" aria-hidden="true"></div>',
                '        <div class="ak-im-call-overlay-placeholder-text">等待通话连接</div>',
                '        <div class="ak-im-call-overlay-detail">',
                '          <div class="ak-im-call-overlay-detail-title"></div>',
                '          <div class="ak-im-call-overlay-detail-body"></div>',
                '        </div>',
                '        <div class="ak-im-call-overlay-inline-actions"></div>',
                '      </div>',
                '      <audio class="ak-im-call-overlay-audio" autoplay></audio>',
                '      <video class="ak-im-call-overlay-local" playsinline autoplay muted></video>',
                '      <video class="ak-im-call-overlay-remote" playsinline autoplay></video>',
                '    </div>',
                '    <div class="ak-im-call-overlay-state"></div>',
                '    <div class="ak-im-call-overlay-actions" data-layout="hidden">',
                '      <button class="ak-im-call-overlay-action ak-im-call-overlay-reject" type="button"></button>',
                '      <button class="ak-im-call-overlay-action ak-im-call-overlay-mute" type="button"></button>',
                '      <button class="ak-im-call-overlay-action ak-im-call-overlay-hangup" type="button"></button>',
                '      <button class="ak-im-call-overlay-action ak-im-call-overlay-camera" type="button"></button>',
                '      <button class="ak-im-call-overlay-action ak-im-call-overlay-speaker" type="button"></button>',
                '      <button class="ak-im-call-overlay-action ak-im-call-overlay-camera-switch" type="button"></button>',
                '      <button class="ak-im-call-overlay-action ak-im-call-overlay-accept" type="button"></button>',
                '    </div>',
                '  </div>',
                '  <button class="ak-im-call-overlay-restore" type="button" aria-label="恢复通话">',
                '    <video class="ak-im-call-overlay-restore-video" playsinline autoplay muted></video>',
                '    <span class="ak-im-call-overlay-restore-icon" aria-hidden="true"></span>',
                '    <span class="ak-im-call-overlay-restore-label">返回通话</span>',
                '  </button>'
            ].join('');
        },

        init(ctx) {
            this.ctx = ctx || {};
            this.ensureStyle();
            this.ensureShell();
            this.render();
            return this;
        },

        getApiBase() {
            if (this.ctx && typeof this.ctx.getApiBase === 'function') return trim(this.ctx.getApiBase());
            return '';
        },

        getAssetBase() {
            const apiBase = this.getApiBase();
            try {
                const url = new URL(apiBase || '/', global.location.origin);
                return url.origin;
            } catch (e) {
                return global.location.origin;
            }
        },

        getWsURL() {
            const apiBase = this.getApiBase();
            if (!apiBase) return '';
            try {
                const url = new URL(apiBase, global.location.origin);
                url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
                return url.origin.replace(/\/$/, '') + '/im/ws';
            } catch (e) {
                return global.location.origin.replace(/^http/, 'ws').replace(/\/$/, '') + '/im/ws';
            }
        },

        reportLaunchError(reason, detail) {
            if (!this.ctx || typeof this.ctx.reportLaunchError !== 'function') return;
            try { this.ctx.reportLaunchError(reason, detail || {}); } catch (e) {}
        },

        resolvePeerAvatarUrl(payload) {
            const directUrl = resolveAvatarUrlFromValue(payload);
            if (directUrl) return directUrl;
            if (this.ctx && typeof this.ctx.resolvePeerAvatarUrl === 'function') {
                try {
                    return trim(this.ctx.resolvePeerAvatarUrl(Object.assign({
                        conversationId: this.currentConversationId,
                        conversation_id: this.currentConversationId,
                        peerName: this.currentPeerName,
                        peerUsername: this.currentPeerUsername,
                        peer_name: this.currentPeerName,
                        peer_username: this.currentPeerUsername
                    }, payload || {})));
                } catch (e) {}
            }
            return '';
        },

        ensureBuiltInModules() {
            const modules = ensureModuleRegistry();
            if (!modules.callWebRTC
                || typeof modules.callWebRTC.applyVideoProfile !== 'function'
                || typeof modules.callWebRTC.readStatsSnapshot !== 'function'
                || typeof modules.callWebRTC.switchCamera !== 'function'
                || typeof modules.callWebRTC.setCameraEnabled !== 'function') {
                modules.callWebRTC = createBuiltInWebRTCModule();
            }
            return {
                signaling: this.ctx && typeof this.ctx.sendSocketEnvelope === 'function'
                    ? createSharedSocketSignalingModule(this.ctx)
                    : (modules.callSignaling || (modules.callSignaling = createBuiltInSignalingModule())),
                webRTC: modules.callWebRTC
            };
        },

        ensureSubmodules() {
            if (this.submodulePromise) return this.submodulePromise;
            const self = this;
            this.submodulePromise = Promise.resolve().then(function() {
                const modules = self.ensureBuiltInModules();
                self.signaling = modules.signaling;
                self.webRTC = modules.webRTC;
                self.initSignaling();
                self.initWebRTC();
                return { signaling: self.signaling, webRTC: self.webRTC };
            }).catch(function(error) {
                self.submodulePromise = null;
                throw error;
            });
            return this.submodulePromise;
        },

        initSignaling() {
            if (!this.signaling || typeof this.signaling.init !== 'function') return;
            const self = this;
            this.signaling.init({
                getWsURL: function() { return self.getWsURL(); },
                onEvent: function(type, payload) { self.handleSignalEvent(type, payload); },
                onError: function(reason, message) {
                    if (self.shouldIgnoreSignalingFailure(reason)) return;
                    self.fail(reason, message);
                }
            });
        },

        initWebRTC() {
            if (!this.webRTC || typeof this.webRTC.init !== 'function') return;
            const self = this;
            this.webRTC.init({
                onSignal: function(type, payload) { self.sendWebRTCSignal(type, payload); },
                onLocalStream: function(stream) { self.attachLocalStream(stream); },
                onRemoteStream: function(stream) { self.attachRemoteStream(stream); },
                onState: function(state) { self.handlePeerState(state); }
            });
        },

        getCallSessionModule() {
            if (!this.ctx || typeof this.ctx.getCallSessionModule !== 'function') return null;
            try {
                return this.ctx.getCallSessionModule() || null;
            } catch (e) {
                return null;
            }
        },

        getCallTimelineModule() {
            if (!this.ctx || typeof this.ctx.getCallTimelineModule !== 'function') return null;
            try {
                return this.ctx.getCallTimelineModule() || null;
            } catch (e) {
                return null;
            }
        },

        ensureCallSessionModule() {
            if (this.getCallSessionModule()) return Promise.resolve(this.getCallSessionModule());
            if (!this.ctx || typeof this.ctx.ensureCallSessionModule !== 'function') {
                return Promise.resolve(null);
            }
            const self = this;
            return Promise.resolve(this.ctx.ensureCallSessionModule()).then(function() {
                return self.getCallSessionModule();
            }).catch(function() {
                return self.getCallSessionModule();
            });
        },

        ensureCallTimelineModule() {
            if (this.getCallTimelineModule()) return Promise.resolve(this.getCallTimelineModule());
            if (!this.ctx || typeof this.ctx.ensureCallTimelineModule !== 'function') {
                return Promise.resolve(null);
            }
            const self = this;
            return Promise.resolve(this.ctx.ensureCallTimelineModule()).then(function() {
                return self.getCallTimelineModule();
            }).catch(function() {
                return self.getCallTimelineModule();
            });
        },

        ensureCallLifecycleModules() {
            const self = this;
            return Promise.all([
                this.ensureCallSessionModule(),
                this.ensureCallTimelineModule()
            ]).then(function() {
                return {
                    callSession: self.getCallSessionModule(),
                    callTimeline: self.getCallTimelineModule()
                };
            }).catch(function() {
                return {
                    callSession: self.getCallSessionModule(),
                    callTimeline: self.getCallTimelineModule()
                };
            });
        },

        parseDurationTextToSeconds(value) {
            const normalized = trim(value);
            if (!normalized) return 0;
            const units = normalized.split(':');
            if (units.length !== 2 && units.length !== 3) return 0;
            const numbers = units.map(function(item) {
                return Math.max(0, Number(item || 0) || 0);
            });
            if (numbers.length === 2) {
                return (numbers[0] * 60) + numbers[1];
            }
            return (numbers[0] * 3600) + (numbers[1] * 60) + numbers[2];
        },

        buildCallSessionSnapshot(extra) {
            const nextExtra = extra && typeof extra === 'object' ? extra : {};
            const now = Date.now();
            const durationText = trim(Object.prototype.hasOwnProperty.call(nextExtra, 'durationText')
                ? nextExtra.durationText
                : (this.activeStartedAt
                    ? formatCallDuration((now - this.activeStartedAt) / 1000)
                    : trim(this.liveDurationText || this.lastDurationText)));
            let durationSeconds = 0;
            if (Object.prototype.hasOwnProperty.call(nextExtra, 'durationSeconds')) {
                durationSeconds = Math.max(0, Math.floor(Number(nextExtra.durationSeconds || 0) || 0));
            } else if (this.activeStartedAt) {
                durationSeconds = Math.max(0, Math.floor((now - this.activeStartedAt) / 1000));
            } else {
                durationSeconds = this.parseDurationTextToSeconds(durationText);
            }
            const localTerminationSource = Object.prototype.hasOwnProperty.call(nextExtra, 'localTermination')
                ? nextExtra.localTermination
                : this.localTermination;
            const localTermination = {
                action: trim(localTerminationSource && localTerminationSource.action).toLowerCase(),
                role: trim(localTerminationSource && localTerminationSource.role).toLowerCase(),
                callId: trim(localTerminationSource && (localTerminationSource.callId || localTerminationSource.call_id)),
                at: Math.max(0, Number(localTerminationSource && localTerminationSource.at || 0) || 0),
                wasEverConnected: !!(localTerminationSource && localTerminationSource.wasEverConnected)
            };
            return {
                callId: trim(nextExtra.callId || nextExtra.call_id || this.currentCallId),
                conversationId: Math.max(0, Number(nextExtra.conversationId || nextExtra.conversation_id || this.currentConversationId || 0) || 0),
                peerName: trim(nextExtra.peerName || nextExtra.peer_name || this.currentPeerName),
                peerUsername: trim(nextExtra.peerUsername || nextExtra.peer_username || this.currentPeerUsername),
                kind: trim(nextExtra.kind || nextExtra.call_kind || this.currentKind || 'audio').toLowerCase() || 'audio',
                mode: trim(nextExtra.mode || this.mode || CALL_MODES.idle).toLowerCase(),
                role: trim(nextExtra.role || this.role).toLowerCase(),
                connectionPhase: trim(nextExtra.connectionPhase || nextExtra.connection_phase || this.connectionPhase).toLowerCase(),
                wasEverConnected: Object.prototype.hasOwnProperty.call(nextExtra, 'wasEverConnected')
                    ? !!nextExtra.wasEverConnected
                    : this.wasEverConnected(),
                connectedAt: Math.max(0, Number(nextExtra.connectedAt || nextExtra.connected_at || this.everConnectedAt || 0) || 0),
                activeAt: Math.max(0, Number(nextExtra.activeAt || nextExtra.active_at || this.activeStartedAt || 0) || 0),
                durationText: durationText,
                durationSeconds: durationSeconds,
                failReason: normalizeReasonCode(nextExtra.failReason || nextExtra.fail_reason || this.lastFailReason),
                endReason: normalizeReasonCode(nextExtra.endReason || nextExtra.end_reason || this.lastEndReason),
                endActor: trim(nextExtra.endActor || nextExtra.actor || this.lastEndActor),
                endActorRole: trim(nextExtra.endActorRole || nextExtra.actor_role || this.lastEndActorRole).toLowerCase(),
                localTermination: localTermination,
                openedAt: Math.max(0, Number(nextExtra.openedAt || nextExtra.opened_at || this.openedAt || 0) || 0),
                endedAt: Math.max(0, Number(nextExtra.endedAt || nextExtra.ended_at || 0) || 0)
            };
        },

        recordCallSession(eventName, extra) {
            const snapshot = this.buildCallSessionSnapshot(extra);
            const callSessionModule = this.getCallSessionModule();
            if (callSessionModule && typeof callSessionModule.record === 'function') {
                try {
                    return callSessionModule.record(eventName, snapshot) || snapshot;
                } catch (e) {}
            }
            const self = this;
            this.ensureCallSessionModule().then(function(moduleInstance) {
                if (!moduleInstance || typeof moduleInstance.record !== 'function') return;
                try { moduleInstance.record(eventName, snapshot); } catch (e) {}
            }).catch(function() {
                return self.getCallSessionModule();
            });
            return snapshot;
        },

        emitCallTimeline(trigger, extra) {
            const normalizedTrigger = trim(trigger).toLowerCase();
            if (!normalizedTrigger) return Promise.resolve(null);
            const snapshot = this.recordCallSession('terminal_' + normalizedTrigger, extra);
            const callTimelineModule = this.getCallTimelineModule();
            if (callTimelineModule && typeof callTimelineModule.handleTerminalSnapshot === 'function') {
                try {
                    return Promise.resolve(callTimelineModule.handleTerminalSnapshot(normalizedTrigger, snapshot)).catch(function() {
                        return null;
                    });
                } catch (e) {
                    return Promise.resolve(null);
                }
            }
            const self = this;
            return this.ensureCallTimelineModule().then(function(moduleInstance) {
                if (!moduleInstance || typeof moduleInstance.handleTerminalSnapshot !== 'function') return null;
                return Promise.resolve(moduleInstance.handleTerminalSnapshot(normalizedTrigger, snapshot)).catch(function() {
                    return null;
                });
            }).catch(function() {
                const fallbackModule = self.getCallTimelineModule();
                if (!fallbackModule || typeof fallbackModule.handleTerminalSnapshot !== 'function') return null;
                return Promise.resolve(fallbackModule.handleTerminalSnapshot(normalizedTrigger, snapshot)).catch(function() {
                    return null;
                });
            });
        },

        ensureStyle() {
            let styleEl = document.getElementById(STYLE_ID);
            if (styleEl && styleEl.getAttribute('data-style-version') === SHELL_VERSION) return;
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = STYLE_ID;
            }
            styleEl.setAttribute('data-style-version', SHELL_VERSION);
            styleEl.textContent = [
                '.ak-im-call-overlay{position:fixed;inset:0;z-index:2147483652;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(2,8,20,.78);backdrop-filter:blur(14px)}',
                '.ak-im-call-overlay[aria-hidden="false"]{display:flex}',
                '.ak-im-call-overlay-backdrop{position:absolute;inset:0}',
                '.ak-im-call-overlay-card{position:relative;z-index:1;width:min(calc(100vw - 32px),420px);min-height:520px;max-height:min(calc(100vh - 32px),720px);display:flex;flex-direction:column;overflow:hidden;border-radius:24px;background:linear-gradient(180deg,#07111d 0%,#0b1728 38%,#040812 100%);color:#f8fafc;box-shadow:0 34px 100px rgba(0,0,0,.48)}',
                '.ak-im-call-overlay-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 18px 14px;border-bottom:1px solid rgba(255,255,255,.06);background:linear-gradient(180deg,rgba(255,255,255,.06) 0%,rgba(255,255,255,.02) 100%)}',
                '.ak-im-call-overlay-header-main{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:12px}',
                '.ak-im-call-overlay-spacer{width:36px;height:36px;flex:0 0 36px}',
                '.ak-im-call-overlay-avatar{width:52px;height:52px;border-radius:999px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#14b8a6 0%,#38bdf8 100%);box-shadow:0 14px 32px rgba(15,118,110,.28);transition:transform .18s ease;color:#fff;font-size:20px;font-weight:700}',
                '.ak-im-call-overlay-header-text{min-width:0;text-align:center}',
                '.ak-im-call-overlay-title{font-size:19px;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '.ak-im-call-overlay-subtitle{margin-top:6px;font-size:12px;font-weight:600;line-height:1.4;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '.ak-im-call-overlay-minimize{width:36px;height:36px;border:none;border-radius:18px;background:rgba(255,255,255,.08);color:#e2e8f0;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto;transition:background .18s ease,color .18s ease}',
                '.ak-im-call-overlay-minimize:hover{background:rgba(255,255,255,.14);color:#fff}',
                '.ak-im-call-overlay-minimize svg,.ak-im-call-overlay-placeholder-icon svg,.ak-im-call-overlay-action-disc svg,.ak-im-call-overlay-restore-icon svg{width:24px;height:24px;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.9;fill:none}',
                '.ak-im-call-overlay-minimize svg{width:16px;height:16px}',
                '.ak-im-call-overlay-stage{position:relative;flex:1;display:flex;align-items:center;justify-content:center;padding:34px 26px 20px;background:radial-gradient(circle at top,rgba(14,165,233,.12) 0%,rgba(7,17,29,0) 42%),linear-gradient(180deg,#0b1323 0%,#07101c 100%);overflow:hidden}',
                '.ak-im-call-overlay-pulse{position:absolute;top:50%;left:50%;width:240px;height:240px;border-radius:50%;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(56,189,248,.18) 0%,rgba(56,189,248,0) 72%);opacity:0;pointer-events:none}',
                '.ak-im-call-overlay-placeholder{position:relative;z-index:1;width:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;text-align:center;color:#f8fafc}',
                '.ak-im-call-overlay-placeholder-icon{width:116px;height:116px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:#93c5fd;background:rgba(15,23,42,.58);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),0 18px 44px rgba(0,0,0,.32)}',
                '.ak-im-call-overlay-placeholder-text{font-size:24px;font-weight:700;line-height:1.3;max-width:300px}',
                '.ak-im-call-overlay-detail{width:min(100%,320px);padding:16px 18px;border-radius:18px;background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);display:flex;flex-direction:column;gap:8px;text-align:left}',
                '.ak-im-call-overlay-detail-title{font-size:13px;font-weight:600;color:#cbd5e1}',
                '.ak-im-call-overlay-detail-body{font-size:14px;line-height:1.6;color:rgba(248,250,252,.88)}',
                '.ak-im-call-overlay-inline-actions{display:none;position:relative;z-index:2;align-items:center;justify-content:center;gap:12px;width:min(100%,320px);pointer-events:auto}',
                '.ak-im-call-overlay-local,.ak-im-call-overlay-remote{display:none;position:absolute;background:#020617;object-fit:cover}',
                '.ak-im-call-overlay-remote{inset:0;width:100%;height:100%;z-index:0}',
                '.ak-im-call-overlay-local{top:18px;right:18px;width:112px;height:152px;border-radius:18px;z-index:2;box-shadow:0 18px 42px rgba(2,6,23,.44);border:1px solid rgba(255,255,255,.18)}',
                '.ak-im-call-overlay[data-kind="video"]{padding:0;background:#020617;backdrop-filter:none}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-backdrop{display:none}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-card{width:100vw;min-height:100dvh;max-height:100dvh;border-radius:0;background:#020617;box-shadow:none}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-header{position:absolute;top:0;left:0;right:0;z-index:4;padding:calc(16px + env(safe-area-inset-top,0px)) 18px 18px;border-bottom:none;background:linear-gradient(180deg,rgba(2,6,23,.72) 0%,rgba(2,6,23,.42) 48%,rgba(2,6,23,0) 100%)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-header-main{justify-content:flex-start}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-spacer,.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-avatar{display:none}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-header-text{text-align:left}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-title{font-size:18px}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-subtitle{margin-top:4px;font-size:11px;color:rgba(226,232,240,.86)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-minimize{order:-1;margin-left:0;margin-right:12px;width:48px;height:48px;border-radius:24px;background:rgba(15,23,42,.42);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-minimize svg{width:24px;height:24px}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-stage{padding:0;background:#020617}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-placeholder{position:absolute;inset:0;z-index:1;padding:calc(112px + env(safe-area-inset-top,0px)) 24px calc(168px + env(safe-area-inset-bottom,0px));justify-content:flex-end;background:linear-gradient(180deg,rgba(2,6,23,.12) 0%,rgba(2,6,23,.2) 34%,rgba(2,6,23,.72) 100%)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-placeholder-icon{width:88px;height:88px;background:rgba(15,23,42,.42);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),0 16px 36px rgba(0,0,0,.28)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-placeholder-text{max-width:360px;font-size:28px;text-shadow:0 8px 24px rgba(0,0,0,.32)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-detail{width:min(100%,360px);padding:18px 18px 16px;border-radius:20px;background:rgba(2,6,23,.38);backdrop-filter:blur(14px);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-inline-actions{width:min(100%,360px)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-local{top:calc(env(safe-area-inset-top,0px) + 88px);right:18px;width:118px;height:164px;border-radius:20px;z-index:3;background:#0f172a;transform:scaleX(-1);cursor:pointer}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-remote{cursor:pointer}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-state{position:absolute;left:0;right:0;bottom:calc(118px + env(safe-area-inset-bottom,0px));z-index:3;padding:0 20px;text-align:center;background:none;color:rgba(241,245,249,.86);text-shadow:0 2px 10px rgba(0,0,0,.28)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-header-main,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-header-main{display:none}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-minimize,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-minimize{margin-right:0}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"][data-video-surface="local"] .ak-im-call-overlay-local,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"][data-video-surface="local"] .ak-im-call-overlay-local{filter:blur(10px);transform:scale(1.05) scaleX(-1)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-placeholder,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-placeholder{justify-content:center;gap:12px;padding:calc(118px + env(safe-area-inset-top,0px)) 28px calc(210px + env(safe-area-inset-bottom,0px));background:linear-gradient(180deg,rgba(15,23,42,.08) 0%,rgba(15,23,42,.12) 42%,rgba(15,23,42,.58) 100%)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-placeholder-icon,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-placeholder-icon{order:1;width:112px;height:112px;border-radius:28px;background:rgba(255,255,255,.82);color:#0f172a;box-shadow:0 22px 60px rgba(2,6,23,.24);overflow:hidden}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-detail,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-detail{order:2;align-items:center;width:auto;min-width:0;padding:0;background:transparent;box-shadow:none;backdrop-filter:none;text-align:center}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-detail-title,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-detail-title{font-size:34px;font-weight:500;line-height:1.15;color:rgba(255,255,255,.9);text-shadow:0 8px 26px rgba(0,0,0,.24)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-detail-body,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-detail-body{margin-top:8px;display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:0 18px;border-radius:999px;background:rgba(35,35,35,.36);font-size:16px;line-height:1;color:rgba(255,255,255,.72)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-placeholder-text,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-placeholder-text{order:3;margin-top:min(23vh,220px);font-size:22px;font-weight:400;color:rgba(255,255,255,.72);text-shadow:0 8px 26px rgba(0,0,0,.24)}',
                '.ak-im-call-overlay-peer-initial{display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-size:42px;font-weight:700;color:#0f172a;background:linear-gradient(135deg,#f8fafc 0%,#cbd5e1 100%)}',
                '.ak-im-call-overlay[data-kind="video"][data-video-surface="local"] .ak-im-call-overlay-local{inset:0;width:100%;height:100%;border:0;border-radius:0;box-shadow:none;z-index:0;transform:scaleX(-1)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"][data-video-surface="local"] .ak-im-call-overlay-local,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"][data-video-surface="local"] .ak-im-call-overlay-local{filter:blur(10px);transform:scale(1.05) scaleX(-1)}',
                '.ak-im-call-overlay[data-kind="video"][data-video-surface="local"] .ak-im-call-overlay-remote{inset:auto;top:calc(env(safe-area-inset-top,0px) + 88px);right:18px;width:118px;height:164px;border-radius:20px;z-index:3;box-shadow:0 18px 42px rgba(2,6,23,.44);border:1px solid rgba(255,255,255,.18)}',
                '.ak-im-call-overlay[data-kind="video"][data-video-surface="local"] .ak-im-call-overlay-placeholder{background:linear-gradient(180deg,rgba(2,6,23,.12) 0%,rgba(2,6,23,.08) 36%,rgba(2,6,23,.74) 100%)}',
                '.ak-im-call-overlay[data-kind="video"][data-video-surface="local"]:not([data-mode="outgoing"]):not([data-mode="connecting"]) .ak-im-call-overlay-placeholder-icon,.ak-im-call-overlay[data-kind="video"][data-video-surface="local"]:not([data-mode="outgoing"]):not([data-mode="connecting"]) .ak-im-call-overlay-detail{display:none}',
                '.ak-im-call-overlay[data-kind="video"][data-video-surface="local"] .ak-im-call-overlay-placeholder-text{max-width:min(420px,calc(100vw - 48px));font-size:24px}',
                '.ak-im-call-overlay[data-kind="video"][data-video-surface="remote"] .ak-im-call-overlay-local{transform:scaleX(-1)}',
                '.ak-im-call-overlay[data-kind="video"][data-video-surface="remote"] .ak-im-call-overlay-placeholder{display:none!important}',
                '.ak-im-call-overlay-audio{display:none}',
                '.ak-im-call-overlay-state{padding:0 20px 14px;min-height:38px;font-size:12px;line-height:1.5;text-align:center;color:rgba(226,232,240,.84)}',
                '.ak-im-call-overlay-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:end;justify-items:center;gap:12px;padding:18px 22px calc(22px + env(safe-area-inset-bottom,0px));border-top:1px solid rgba(255,255,255,.06);background:rgba(2,9,18,.94)}',
                '.ak-im-call-overlay-actions[data-layout="hidden"]{display:none}',
                '.ak-im-call-overlay-actions[data-layout="single"]{grid-template-columns:minmax(0,1fr);align-items:start;justify-items:center;gap:0;padding-top:22px;padding-bottom:calc(24px + env(safe-area-inset-bottom,0px))}',
                '.ak-im-call-overlay-actions[data-layout="double"]{display:none}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions{position:absolute;left:0;right:0;bottom:0;z-index:4;border-top:none;background:linear-gradient(180deg,rgba(2,6,23,0) 0%,rgba(2,6,23,.86) 52%,rgba(2,6,23,.97) 100%);padding-top:34px}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="single"]{padding-top:42px}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-actions,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-actions{padding:36px 52px calc(92px + env(safe-area-inset-bottom,0px));background:linear-gradient(180deg,rgba(2,6,23,0) 0%,rgba(2,6,23,.28) 28%,rgba(2,6,23,.74) 100%)}',
                '.ak-im-call-overlay-action{all:unset;box-sizing:border-box;color:#e2e8f0;cursor:pointer;font:inherit;-webkit-appearance:none;appearance:none;-webkit-tap-highlight-color:transparent;pointer-events:auto}',
                '.ak-im-call-overlay-actions .ak-im-call-overlay-action[data-appearance="tool"]{width:100%;max-width:112px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:10px;padding:0;background:none;border:none;border-radius:0;box-shadow:none}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-action[data-appearance="mini"]{position:absolute;right:42px;bottom:calc(104px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;align-items:center;gap:6px;width:auto;max-width:none;color:#f8fafc}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-action[data-appearance="mini"] .ak-im-call-overlay-action-disc{width:48px;height:48px;background:rgba(15,23,42,.48);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1),0 14px 30px rgba(0,0,0,.2)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-action[data-appearance="mini"] .ak-im-call-overlay-action-label{display:none}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-action[data-appearance="tool"] .ak-im-call-overlay-action-disc,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-action[data-appearance="tool"] .ak-im-call-overlay-action-disc{width:86px;height:86px;background:rgba(255,255,255,.94);color:#020617;box-shadow:0 18px 45px rgba(2,6,23,.22)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-action[data-appearance="tool"][data-variant="danger"] .ak-im-call-overlay-action-disc,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-action[data-appearance="tool"][data-variant="danger"] .ak-im-call-overlay-action-disc{width:92px;height:92px;background:#ef4444;color:#fff;box-shadow:0 20px 52px rgba(239,68,68,.34)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-action[data-appearance="tool"] .ak-im-call-overlay-action-label,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-action[data-appearance="tool"] .ak-im-call-overlay-action-label{font-size:18px;font-weight:500;color:rgba(255,255,255,.86);text-shadow:0 6px 18px rgba(0,0,0,.28)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-action[data-appearance="mini"],.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-action[data-appearance="mini"]{right:72px;bottom:calc(26px + env(safe-area-inset-bottom,0px))}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-action[data-appearance="mini"] .ak-im-call-overlay-action-disc,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-action[data-appearance="mini"] .ak-im-call-overlay-action-disc{width:42px;height:42px;background:rgba(255,255,255,.16);color:#fff;box-shadow:none}',
                '.ak-im-call-overlay-action[data-slot="1"]{grid-column:1}',
                '.ak-im-call-overlay-action[data-slot="2"]{grid-column:2}',
                '.ak-im-call-overlay-action[data-slot="3"]{grid-column:3}',
                '.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-slot]{grid-column:1}',
                '.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-appearance="tool"]{width:auto;max-width:none;min-width:116px;min-height:118px;gap:12px;padding-top:2px;padding-bottom:2px}',
                '.ak-im-call-overlay-action:focus-visible{outline:2px solid rgba(148,163,184,.7);outline-offset:4px;border-radius:18px}',
                '.ak-im-call-overlay-action-disc{flex:0 0 auto;width:62px;height:62px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:rgba(148,163,184,.16);box-shadow:0 14px 30px rgba(0,0,0,.24);transition:transform .18s ease,background .18s ease,color .18s ease}',
                '.ak-im-call-overlay-action:hover .ak-im-call-overlay-action-disc{transform:translateY(-1px)}',
                '.ak-im-call-overlay-action-label{display:block;flex:0 0 auto;font-size:13px;font-weight:700;line-height:1.3;color:inherit;text-align:center}',
                '.ak-im-call-overlay-action-pill-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:16px;height:16px}',
                '.ak-im-call-overlay-action-pill-icon svg{width:16px;height:16px;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.9;fill:none}',
                '.ak-im-call-overlay-inline-actions .ak-im-call-overlay-action[data-appearance="pill"]{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:124px;height:52px;padding:0 18px;border:none;border-radius:999px;color:#f8fafc;cursor:pointer;box-shadow:0 18px 34px rgba(2,6,23,.26);pointer-events:auto;text-align:center}',
                '.ak-im-call-overlay-inline-actions .ak-im-call-overlay-action .ak-im-call-overlay-action-disc{display:none}',
                '.ak-im-call-overlay-inline-actions .ak-im-call-overlay-action .ak-im-call-overlay-action-label{font-size:15px;font-weight:700;line-height:1.2}',
                '.ak-im-call-overlay-inline-actions .ak-im-call-overlay-action:hover{transform:translateY(-1px)}',
                '.ak-im-call-overlay-inline-actions .ak-im-call-overlay-action:active{transform:translateY(0)}',
                '.ak-im-call-overlay-action[data-variant="danger"] .ak-im-call-overlay-action-disc{background:#ef4444;color:#fff}',
                '.ak-im-call-overlay-action[data-variant="success"] .ak-im-call-overlay-action-disc{background:#10b981;color:#fff}',
                '.ak-im-call-overlay-action[data-variant="primary"] .ak-im-call-overlay-action-disc{background:#2563eb;color:#fff}',
                '.ak-im-call-overlay-action[data-variant="neutral"] .ak-im-call-overlay-action-disc{background:rgba(148,163,184,.16);color:#e2e8f0}',
                '.ak-im-call-overlay-action[data-selected="1"] .ak-im-call-overlay-action-disc{transform:translateY(-1px)}',
                '.ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-disc{width:74px;height:74px;box-shadow:0 18px 34px rgba(239,68,68,.26)}',
                '.ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-label{font-size:14px}',
                '.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-disc{width:82px;height:82px;box-shadow:0 20px 38px rgba(239,68,68,.3)}',
                '.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-label{min-height:18px;margin-top:2px;font-size:15px;line-height:1.2;white-space:nowrap}',
                '.ak-im-call-overlay-inline-actions .ak-im-call-overlay-action[data-appearance="pill"][data-variant="danger"]{background:#ef4444;color:#fff}',
                '.ak-im-call-overlay-inline-actions .ak-im-call-overlay-action[data-appearance="pill"][data-variant="success"]{background:#10b981;color:#fff}',
                '.ak-im-call-overlay-inline-actions .ak-im-call-overlay-action[data-appearance="pill"][data-variant="primary"]{background:#2563eb;color:#fff}',
                '.ak-im-call-overlay-inline-actions .ak-im-call-overlay-action[data-appearance="pill"][data-prominence="primary"]{box-shadow:0 20px 40px rgba(37,99,235,.28)}',
                '.ak-im-call-overlay[data-mode="incoming"] .ak-im-call-overlay-placeholder-icon{color:#60a5fa;background:rgba(37,99,235,.12)}',
                '.ak-im-call-overlay[data-mode="outgoing"] .ak-im-call-overlay-placeholder-icon,.ak-im-call-overlay[data-mode="connecting"] .ak-im-call-overlay-placeholder-icon{color:#67e8f9;background:rgba(8,145,178,.14)}',
                '.ak-im-call-overlay[data-mode="active"] .ak-im-call-overlay-placeholder-icon{color:#34d399;background:rgba(16,185,129,.14)}',
                '.ak-im-call-overlay[data-mode="failed"] .ak-im-call-overlay-placeholder-icon{color:#fbbf24;background:rgba(245,158,11,.14)}',
                '.ak-im-call-overlay[data-mode="ended"] .ak-im-call-overlay-placeholder-icon{color:#cbd5e1;background:rgba(100,116,139,.18)}',
                '.ak-im-call-overlay-restore{display:none;position:fixed;top:calc(env(safe-area-inset-top,0px) + 16px);right:16px;max-width:min(calc(100vw - 32px),220px);min-height:48px;padding:8px 14px 8px 8px;border:none;border-radius:999px;background:rgba(7,17,29,.94);color:#f8fafc;box-shadow:0 18px 40px rgba(0,0,0,.34);align-items:center;gap:10px;cursor:pointer;pointer-events:auto}',
                '.ak-im-call-overlay-restore-icon{width:34px;height:34px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:rgba(56,189,248,.16);color:#93c5fd;flex:0 0 auto}',
                '.ak-im-call-overlay-restore-icon svg{width:18px;height:18px}',
                '.ak-im-call-overlay-restore-label{min-width:0;font-size:13px;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '.ak-im-call-overlay[data-minimized="1"]{background:transparent;backdrop-filter:none;align-items:flex-start;justify-content:flex-end;padding:0;pointer-events:none}',
                '.ak-im-call-overlay[data-minimized="1"] .ak-im-call-overlay-backdrop,.ak-im-call-overlay[data-minimized="1"] .ak-im-call-overlay-card{display:none}',
                '.ak-im-call-overlay[data-minimized="1"] .ak-im-call-overlay-restore{display:flex}',
                '.ak-im-call-overlay[data-terminal-presentation="toast"]{align-items:center;justify-content:center;padding:18px;background:rgba(2,8,20,.22);backdrop-filter:none}',
                '.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-backdrop{display:none}',
                '.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-card{width:min(calc(100vw - 36px),300px);min-height:0;max-height:none;border-radius:20px;background:rgba(15,23,42,.94);box-shadow:0 22px 70px rgba(2,6,23,.36)}',
                '.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-header,.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-actions,.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-state{display:none!important}',
                '.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-stage{min-height:0;padding:22px;background:transparent}',
                '.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-placeholder{position:relative;inset:auto;padding:0;gap:10px;justify-content:center;background:transparent}',
                '.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-placeholder-icon{width:44px;height:44px}',
                '.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-placeholder-icon svg{width:22px;height:22px}',
                '.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-placeholder-text{max-width:240px;font-size:16px;line-height:1.35}',
                '.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-detail,.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-pulse,.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-local,.ak-im-call-overlay[data-terminal-presentation="toast"] .ak-im-call-overlay-remote{display:none!important}',
                '@keyframes akImCallOverlayPulse{0%{transform:translate(-50%,-50%) scale(.82);opacity:.18}50%{transform:translate(-50%,-50%) scale(1.04);opacity:.5}100%{transform:translate(-50%,-50%) scale(1.18);opacity:0}}',
                '@keyframes akImCallOverlayIconFloat{0%{transform:translateY(0)}50%{transform:translateY(-3px)}100%{transform:translateY(0)}}',
                '@media (max-width:768px){.ak-im-call-overlay[data-kind="video"][data-video-surface="local"] .ak-im-call-overlay-remote{top:calc(env(safe-area-inset-top,0px) + 76px);right:14px;width:96px;height:132px;border-radius:16px}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-action[data-appearance="mini"]{right:28px;bottom:calc(96px + env(safe-area-inset-bottom,0px))}}',
                '@media (max-width:768px){.ak-im-call-overlay{padding:0}.ak-im-call-overlay-card{width:100vw;min-height:100dvh;max-height:100dvh;border-radius:0;box-shadow:none}.ak-im-call-overlay-header{padding-top:calc(18px + env(safe-area-inset-top,0px))}.ak-im-call-overlay-stage{padding:24px 18px 18px}.ak-im-call-overlay-actions{gap:10px;padding-left:16px;padding-right:16px}.ak-im-call-overlay-actions[data-layout="single"]{padding-top:24px;padding-bottom:calc(28px + env(safe-area-inset-bottom,0px))}.ak-im-call-overlay-title{font-size:17px}.ak-im-call-overlay-avatar{width:40px;height:40px;font-size:16px}.ak-im-call-overlay-placeholder{gap:16px}.ak-im-call-overlay-placeholder-icon{width:104px;height:104px}.ak-im-call-overlay-placeholder-text{font-size:21px}.ak-im-call-overlay-detail{width:100%}.ak-im-call-overlay-inline-actions{width:100%;gap:10px}.ak-im-call-overlay-inline-actions .ak-im-call-overlay-action[data-appearance="pill"]{min-width:0;flex:1;height:50px;padding:0 12px}.ak-im-call-overlay-actions .ak-im-call-overlay-action[data-appearance="tool"]{max-width:96px}.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-appearance="tool"]{min-width:108px;min-height:112px;max-width:none;gap:13px}.ak-im-call-overlay-action-disc{width:58px;height:58px}.ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-disc{width:70px;height:70px}.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-disc{width:78px;height:78px}.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-label{font-size:14px}.ak-im-call-overlay-restore{top:calc(env(safe-area-inset-top,0px) + 12px);right:12px}.ak-im-call-overlay-local{top:calc(env(safe-area-inset-top,0px) + 16px);right:16px;width:96px;height:132px;border-radius:16px}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-header{padding:calc(14px + env(safe-area-inset-top,0px)) 14px 16px}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-placeholder{padding:calc(104px + env(safe-area-inset-top,0px)) 18px calc(156px + env(safe-area-inset-bottom,0px))}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-placeholder-text{font-size:24px}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-local{top:calc(env(safe-area-inset-top,0px) + 76px);right:14px;width:96px;height:132px;border-radius:16px}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-state{bottom:calc(110px + env(safe-area-inset-bottom,0px));padding:0 16px}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions{padding-left:14px;padding-right:14px;padding-top:28px}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="single"]{padding-top:34px}}'
            ].join('');
            styleEl.textContent += [
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-header{min-height:92px;justify-content:center;pointer-events:none}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-header-main{position:absolute;top:calc(16px + env(safe-area-inset-top,0px));left:78px;right:78px;justify-content:center;pointer-events:none}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-header-text{text-align:center}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-title{font-size:20px}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-subtitle{font-size:12px}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-minimize{position:absolute;top:calc(16px + env(safe-area-inset-top,0px));left:18px;right:auto;order:0;margin:0;width:42px;height:42px;border-radius:21px;pointer-events:auto;background:rgba(15,23,42,.48);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1),0 12px 28px rgba(2,6,23,.24)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-minimize svg{width:20px;height:20px}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"]{left:50%;right:auto;width:min(360px,calc(100vw - 44px));grid-template-columns:repeat(3,72px);grid-template-rows:repeat(2,92px);align-items:start;justify-content:space-between;justify-items:center;gap:10px 0;bottom:clamp(18px,4dvh,46px);padding:26px 0 calc(26px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:linear-gradient(180deg,rgba(2,6,23,0) 0%,rgba(2,6,23,.62) 36%,rgba(2,6,23,.9) 100%)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-appearance="tool"]{width:72px;max-width:72px;gap:7px}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action-disc{width:56px;height:56px;background:rgba(15,23,42,.5);color:#f8fafc;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1),0 14px 28px rgba(2,6,23,.24)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-variant="danger"] .ak-im-call-overlay-action-disc{width:62px;height:62px;background:#ef4444;color:#fff;box-shadow:0 16px 34px rgba(239,68,68,.34)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action-disc svg{width:22px;height:22px}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-variant="danger"] .ak-im-call-overlay-action-disc svg{width:34px;height:34px}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-variant="primary"] .ak-im-call-overlay-action-disc,.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-selected="1"] .ak-im-call-overlay-action-disc{background:rgba(37,99,235,.92);color:#fff;box-shadow:0 16px 34px rgba(37,99,235,.3)}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action-label{font-size:12px;color:rgba(255,255,255,.92);text-shadow:0 6px 18px rgba(0,0,0,.35)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-actions[data-layout="video-grid"],.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-actions[data-layout="video-grid"]{bottom:clamp(20px,4.2dvh,48px);padding:26px 0 calc(26px + env(safe-area-inset-bottom,0px));background:linear-gradient(180deg,rgba(2,6,23,0) 0%,rgba(2,6,23,.42) 38%,rgba(2,6,23,.72) 100%)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-variant="neutral"] .ak-im-call-overlay-action-disc,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-variant="neutral"] .ak-im-call-overlay-action-disc{background:rgba(255,255,255,.94);color:#020617;box-shadow:0 18px 44px rgba(2,6,23,.2)}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-variant="neutral"] .ak-im-call-overlay-action-disc,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-variant="neutral"] .ak-im-call-overlay-action-disc{width:56px;height:56px}',
                '.ak-im-call-overlay[data-kind="video"][data-mode="outgoing"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-variant="danger"] .ak-im-call-overlay-action-disc,.ak-im-call-overlay[data-kind="video"][data-mode="connecting"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-variant="danger"] .ak-im-call-overlay-action-disc{width:62px;height:62px}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-slot="4"]{grid-column:1;grid-row:2}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-slot="6"]{grid-column:3;grid-row:2}',
                '.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-state{bottom:calc(238px + env(safe-area-inset-bottom,0px));font-size:13px}',
                '.ak-im-call-overlay-avatar-photo,.ak-im-call-overlay-peer-avatar{width:100%;height:100%;display:block;object-fit:cover;border-radius:inherit}',
                '.ak-im-call-overlay-restore-video{display:none;position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#020617}',
                '.ak-im-call-overlay-restore[data-kind="video"]{top:calc(env(safe-area-inset-top,0px) + 16px);left:16px;right:auto;max-width:none}',
                '.ak-im-call-overlay-restore[data-kind="video"][data-video-ready="1"]{width:116px;height:158px;min-height:0;padding:0;overflow:hidden;border-radius:18px;background:#020617;box-shadow:0 20px 46px rgba(2,6,23,.36);border:1px solid rgba(255,255,255,.14)}',
                '.ak-im-call-overlay-restore[data-kind="video"][data-video-ready="1"] .ak-im-call-overlay-restore-video{display:block}',
                '.ak-im-call-overlay-restore[data-kind="video"][data-video-ready="1"][data-video-source="local"] .ak-im-call-overlay-restore-video{transform:scaleX(-1)}',
                '.ak-im-call-overlay-restore[data-kind="video"][data-video-ready="1"] .ak-im-call-overlay-restore-icon{position:absolute;top:7px;left:7px;width:26px;height:26px;border-radius:13px;background:rgba(15,23,42,.56);color:#fff;z-index:1}',
                '.ak-im-call-overlay-restore[data-kind="video"][data-video-ready="1"] .ak-im-call-overlay-restore-icon svg{width:15px;height:15px}',
                '.ak-im-call-overlay-restore[data-kind="video"][data-video-ready="1"] .ak-im-call-overlay-restore-label{position:absolute;left:0;right:0;bottom:0;z-index:1;padding:22px 8px 8px;background:linear-gradient(180deg,rgba(2,6,23,0) 0%,rgba(2,6,23,.72) 100%);font-size:12px;text-align:center;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.45)}',
                '@media (max-width:768px){.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-header-main{left:66px;right:66px;top:calc(14px + env(safe-area-inset-top,0px))}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-minimize{top:calc(14px + env(safe-area-inset-top,0px));left:14px;width:40px;height:40px}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"]{width:min(330px,calc(100vw - 38px));grid-template-columns:repeat(3,68px);grid-template-rows:repeat(2,88px);bottom:clamp(16px,3.5dvh,36px);padding:22px 0 calc(22px + env(safe-area-inset-bottom,0px))}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-appearance="tool"]{width:68px;max-width:68px}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action-disc{width:54px;height:54px}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-actions[data-layout="video-grid"] .ak-im-call-overlay-action[data-variant="danger"] .ak-im-call-overlay-action-disc{width:60px;height:60px}.ak-im-call-overlay[data-kind="video"] .ak-im-call-overlay-state{bottom:calc(218px + env(safe-area-inset-bottom,0px))}.ak-im-call-overlay-restore[data-kind="video"]{top:calc(env(safe-area-inset-top,0px) + 12px);left:12px}.ak-im-call-overlay-restore[data-kind="video"][data-video-ready="1"]{width:102px;height:140px;border-radius:16px}}'
            ].join('');
            if (!styleEl.parentNode) {
                (document.head || document.documentElement).appendChild(styleEl);
            }
        },

        ensureShell() {
            const mountRoot = document.body || document.documentElement || null;
            if (!mountRoot) return null;
            let panel = document.querySelector(PANEL_SELECTOR);
            const needsUpgrade = !panel
                || panel.getAttribute('data-shell-version') !== SHELL_VERSION
                || !panel.querySelector('.ak-im-call-overlay-action')
                || !panel.querySelector('.ak-im-call-overlay-detail')
                || !panel.querySelector('.ak-im-call-overlay-inline-actions')
                || !panel.querySelector('.ak-im-call-overlay-speaker')
                || !panel.querySelector('.ak-im-call-overlay-camera')
                || !panel.querySelector('.ak-im-call-overlay-camera-switch')
                || !panel.querySelector('.ak-im-call-overlay-restore-video');
            if (!panel) {
                const wrapper = document.createElement('div');
                wrapper.innerHTML = '<div class="ak-im-call-overlay" aria-hidden="true">' + this.getShellMarkup() + '</div>';
                panel = wrapper.firstElementChild;
                mountRoot.appendChild(panel);
            } else if (needsUpgrade) {
                const hidden = panel.getAttribute('aria-hidden');
                const mode = panel.dataset.mode || '';
                const minimized = panel.dataset.minimized || '0';
                panel.innerHTML = this.getShellMarkup();
                if (hidden != null) panel.setAttribute('aria-hidden', hidden);
                if (mode) panel.dataset.mode = mode;
                panel.dataset.minimized = minimized;
                this.bound = false;
            }
            if (panel && panel.hasAttribute('data-ak-call-launch-fallback')) {
                panel.removeAttribute('data-ak-call-launch-fallback');
            }
            if (panel) panel.setAttribute('data-shell-version', SHELL_VERSION);
            this.refs.panel = panel;
            this.refs.title = panel.querySelector('.ak-im-call-overlay-title');
            this.refs.subtitle = panel.querySelector('.ak-im-call-overlay-subtitle');
            this.refs.state = panel.querySelector('.ak-im-call-overlay-state');
            this.refs.actions = panel.querySelector('.ak-im-call-overlay-actions');
            this.refs.accept = panel.querySelector('.ak-im-call-overlay-accept');
            this.refs.reject = panel.querySelector('.ak-im-call-overlay-reject');
            this.refs.hangup = panel.querySelector('.ak-im-call-overlay-hangup');
            this.refs.minimize = panel.querySelector('.ak-im-call-overlay-minimize');
            this.refs.restore = panel.querySelector('.ak-im-call-overlay-restore');
            this.refs.restoreVideo = panel.querySelector('.ak-im-call-overlay-restore-video');
            this.refs.restoreIcon = panel.querySelector('.ak-im-call-overlay-restore-icon');
            this.refs.restoreLabel = panel.querySelector('.ak-im-call-overlay-restore-label');
            this.refs.mute = panel.querySelector('.ak-im-call-overlay-mute');
            this.refs.speaker = panel.querySelector('.ak-im-call-overlay-speaker');
            this.refs.camera = panel.querySelector('.ak-im-call-overlay-camera');
            this.refs.cameraSwitch = panel.querySelector('.ak-im-call-overlay-camera-switch');
            this.refs.localAudio = panel.querySelector('.ak-im-call-overlay-audio');
            this.refs.localVideo = panel.querySelector('.ak-im-call-overlay-local');
            this.refs.remoteVideo = panel.querySelector('.ak-im-call-overlay-remote');
            this.refs.placeholder = panel.querySelector('.ak-im-call-overlay-placeholder');
            this.refs.placeholderText = panel.querySelector('.ak-im-call-overlay-placeholder-text');
            this.refs.pulse = panel.querySelector('.ak-im-call-overlay-pulse');
            this.refs.avatar = panel.querySelector('.ak-im-call-overlay-avatar');
            this.refs.placeholderIcon = panel.querySelector('.ak-im-call-overlay-placeholder-icon');
            this.refs.inlineActions = panel.querySelector('.ak-im-call-overlay-inline-actions');
            this.refs.detailTitle = panel.querySelector('.ak-im-call-overlay-detail-title');
            this.refs.detailBody = panel.querySelector('.ak-im-call-overlay-detail-body');
            if (this.refs.minimize) this.refs.minimize.innerHTML = getIconMarkup('minimize');
            if (this.refs.restoreIcon) this.refs.restoreIcon.innerHTML = getIconMarkup('phone');
            this.bindEvents();
            return panel;
        },

        bindEvents() {
            if (this.bound) return;
            this.bound = true;
            const self = this;
            const panel = this.refs.panel;
            if (!panel) return;
            const backdrop = panel.querySelector('.ak-im-call-overlay-backdrop');
            const stopClick = function(event) {
                if (!event) return;
                if (typeof event.stopPropagation === 'function') event.stopPropagation();
            };
            const bindAction = function(element, handler) {
                if (!element) return;
                element.addEventListener('click', function(event) {
                    stopClick(event);
                    handler();
                });
            };
            if (backdrop) backdrop.addEventListener('click', stopClick);
            if (panel) panel.addEventListener('click', stopClick);
            bindAction(this.refs.minimize, function() {
                self.minimize();
            });
            bindAction(this.refs.restore, function() {
                self.restore();
            });
            bindAction(this.refs.reject, function() {
                self.reject();
            });
            bindAction(this.refs.accept, function() {
                self.accept();
            });
            bindAction(this.refs.hangup, function() {
                self.hangup();
            });
            bindAction(this.refs.mute, function() {
                self.toggleMute();
            });
            bindAction(this.refs.speaker, function() {
                self.toggleSpeaker();
            });
            bindAction(this.refs.camera, function() {
                self.toggleCamera();
            });
            bindAction(this.refs.cameraSwitch, function() {
                self.switchCamera();
            });
            bindAction(this.refs.localVideo, function() {
                self.toggleVideoPrimary('local');
            });
            bindAction(this.refs.remoteVideo, function() {
                self.toggleVideoPrimary('remote');
            });
        },

        clearTimer(name) {
            if (!this.timers || !this.timers[name]) return;
            if (name === 'duration' || name === 'videoQuality') global.clearInterval(this.timers[name]);
            else global.clearTimeout(this.timers[name]);
            this.timers[name] = 0;
        },

        clearAllTimers() {
            this.clearTimer('autoEnd');
            this.clearTimer('launch');
            this.clearTimer('duration');
            this.clearTimer('peerDisconnect');
            this.clearTimer('videoQuality');
        },

        clearResultState() {
            this.lastFailReason = '';
            this.lastEndReason = '';
            this.lastEndActor = '';
            this.lastEndActorRole = '';
            this.lastDurationText = '';
            this.terminalPresentation = 'panel';
        },

        bumpFlowVersion() {
            this.flowVersion += 1;
            return this.flowVersion;
        },

        isFlowCurrent(version) {
            return Number(version) > 0 && this.flowVersion === Number(version);
        },

        mutePeerStateEvents(durationMs) {
            const waitMs = Math.max(0, Number(durationMs || 0) || 0);
            this.ignorePeerStateUntil = waitMs > 0 ? (Date.now() + waitMs) : 0;
            this.clearTimer('peerDisconnect');
        },

        resumePeerStateEvents() {
            this.ignorePeerStateUntil = 0;
        },

        shouldIgnorePeerState(state) {
            const normalizedState = trim(state).toLowerCase();
            if (!normalizedState || normalizedState === 'closed') return true;
            if (this.mode === CALL_MODES.idle || this.mode === CALL_MODES.ended || this.mode === CALL_MODES.failed) return true;
            return this.ignorePeerStateUntil > Date.now();
        },

        schedulePeerDisconnectFailure(state) {
            const normalizedState = trim(state).toLowerCase();
            if (!normalizedState || this.shouldIgnorePeerState(normalizedState)) return;
            if (this.timers.peerDisconnect) return;
            const flowVersion = this.flowVersion;
            const self = this;
            this.timers.peerDisconnect = global.setTimeout(function() {
                self.timers.peerDisconnect = 0;
                if (!self.isFlowCurrent(flowVersion)) return;
                if (self.shouldIgnorePeerState(normalizedState)) return;
                self.fail('peer_connection_failed', '', { connection_state: normalizedState });
            }, PEER_DISCONNECT_GRACE_MS);
        },

        clearVideoState() {
            this.localVideoReady = false;
            this.remoteVideoReady = false;
            this.primaryVideoSource = 'remote';
            this.cameraEnabled = true;
            this.cameraSwitching = false;
            this.cameraFacingMode = 'user';
            this.qualityProfile = 'hd';
            this.qualityHealth = 'normal';
            this.qualityStatusText = '';
            this.qualityUpgradeStreak = 0;
            this.qualityDowngradeStreak = 0;
            this.qualityLastChangedAt = 0;
        },

        isVideoCall() {
            return isVideoCallKind(this.currentKind);
        },

        updateVideoStatusText() {
            this.qualityStatusText = this.isVideoCall() ? buildVideoQualityText(this.qualityProfile, this.qualityHealth) : '';
            return this.qualityStatusText;
        },

        applyVideoProfileLocally(profile, health) {
            const normalizedProfile = VIDEO_QUALITY_PROFILES[trim(profile).toLowerCase()] ? trim(profile).toLowerCase() : 'sd';
            this.qualityProfile = normalizedProfile;
            if (trim(health)) this.qualityHealth = trim(health).toLowerCase();
            this.qualityLastChangedAt = Date.now();
            this.updateVideoStatusText();
            return normalizedProfile;
        },

        evaluateVideoQualitySnapshot(snapshot) {
            const nextSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
            const measuredBitrate = Number(nextSnapshot.outgoingBitrate || 0);
            const capacityBitrate = Number(nextSnapshot.availableOutgoingBitrate || 0);
            const bitrate = measuredBitrate > 0 ? measuredBitrate : capacityBitrate;
            const rtt = Number(nextSnapshot.roundTripTime || 0);
            const jitter = Number(nextSnapshot.jitter || 0);
            const packetsLost = Number(nextSnapshot.packetsLost || 0);
            const fps = Number(nextSnapshot.framesPerSecond || 0);
            const qualityLimited = trim(nextSnapshot.qualityLimitationReason).toLowerCase();
            const currentIndex = getVideoProfileOrder(this.qualityProfile);
            const currentProfile = VIDEO_QUALITY_PROFILES[this.qualityProfile] || VIDEO_QUALITY_PROFILES.hd;
            const hasUsableStats = bitrate > 0 || rtt > 0 || jitter > 0 || packetsLost > 0 || fps > 0 || !!qualityLimited;
            if (!hasUsableStats) {
                this.qualityDowngradeStreak = 0;
                this.qualityUpgradeStreak = 0;
                return {
                    health: 'normal',
                    profile: this.qualityProfile,
                    shouldChange: false
                };
            }
            let health = 'normal';
            if (bitrate > 0 && bitrate < Math.max(320000, Math.floor(currentProfile.maxBitrate * 0.5))) health = 'weak';
            else if (bitrate > 0 && bitrate >= Math.floor(currentProfile.maxBitrate * 0.82) && rtt > 0 && rtt < 0.22 && jitter < 0.045 && packetsLost <= 2 && (!fps || fps >= Math.max(16, currentProfile.frameRate - 6))) health = 'good';
            if (rtt > 0.48 || jitter > 0.1 || packetsLost >= 12 || (fps > 0 && fps < 11)) health = 'weak';
            else if (health === 'good' && (rtt > 0.24 || jitter > 0.055 || packetsLost >= 4 || (fps > 0 && fps < 17))) health = 'normal';
            if (qualityLimited === 'bandwidth' || qualityLimited === 'cpu') {
                health = health === 'weak' ? 'weak' : 'normal';
            }
            let targetIndex = currentIndex;
            if (health === 'weak') {
                this.qualityDowngradeStreak += 1;
                this.qualityUpgradeStreak = 0;
                if (this.qualityDowngradeStreak >= 2 && currentIndex > 0) targetIndex = currentIndex - 1;
            } else if (health === 'good') {
                this.qualityUpgradeStreak += 1;
                this.qualityDowngradeStreak = 0;
                const nextProfile = VIDEO_PROFILE_ORDER[currentIndex + 1];
                const nextProfileConfig = nextProfile ? VIDEO_QUALITY_PROFILES[nextProfile] : null;
                const canUpgrade = !!(nextProfileConfig && measuredBitrate > 0 && measuredBitrate >= Math.floor(nextProfileConfig.maxBitrate * 0.82));
                if (this.qualityUpgradeStreak >= 6 && currentIndex < (VIDEO_PROFILE_ORDER.length - 1) && canUpgrade) targetIndex = currentIndex + 1;
            } else {
                this.qualityDowngradeStreak = 0;
                this.qualityUpgradeStreak = 0;
            }
            return {
                health: health,
                profile: VIDEO_PROFILE_ORDER[targetIndex] || this.qualityProfile,
                shouldChange: targetIndex !== currentIndex
            };
        },

        startVideoQualityMonitor() {
            if (!this.isVideoCall() || !this.webRTC || typeof this.webRTC.readStatsSnapshot !== 'function') return;
            if (this.timers.videoQuality) return;
            const self = this;
            this.updateVideoStatusText();
            this.timers.videoQuality = global.setInterval(function() {
                if (!self.isVideoCall() || self.mode !== CALL_MODES.active || !self.webRTC || typeof self.webRTC.readStatsSnapshot !== 'function') {
                    self.clearTimer('videoQuality');
                    return;
                }
                Promise.resolve(self.webRTC.readStatsSnapshot()).then(function(snapshot) {
                    if (!snapshot) return;
                    const nextQuality = self.evaluateVideoQualitySnapshot(snapshot);
                    self.applyVideoProfileLocally(self.qualityProfile, nextQuality.health);
                    if (!nextQuality.shouldChange) {
                        self.render();
                        return;
                    }
                    const changedProfile = nextQuality.profile;
                    Promise.resolve(self.webRTC.applyVideoProfile(changedProfile)).catch(function() {
                        return false;
                    }).then(function() {
                        self.applyVideoProfileLocally(changedProfile, nextQuality.health);
                        self.render();
                    });
                }).catch(function() {
                    return null;
                });
            }, 2000);
        },

        clearLocalTermination() {
            this.localTermination = { action: '', role: '', callId: '', at: 0, wasEverConnected: false };
        },

        pruneLocalTermination() {
            const entry = this.localTermination || {};
            if (!entry.at) return;
            const ttl = entry.callId ? LOCAL_TERMINATION_ECHO_TTL_MS : PENDING_OUTGOING_CANCEL_TTL_MS;
            if ((Date.now() - entry.at) > ttl) this.clearLocalTermination();
        },

        rememberLocalTermination(action, payload) {
            payload = payload || {};
            this.localTermination = {
                action: trim(action).toLowerCase(),
                role: trim(this.role).toLowerCase(),
                callId: trim(payload.call_id || payload.callId || this.currentCallId),
                at: Date.now(),
                wasEverConnected: this.wasEverConnected()
            };
        },

        shouldAbortFreshOutgoingCall() {
            this.pruneLocalTermination();
            const entry = this.localTermination || {};
            return entry.action === 'cancel' && entry.role === 'caller' && !entry.callId && !!entry.at;
        },

        shouldIgnoreSignalingFailure() {
            this.pruneLocalTermination();
            const entry = this.localTermination || {};
            if (!entry.at) return false;
            return this.mode === CALL_MODES.ended && (
                entry.action === 'cancel' ||
                entry.action === 'hangup' ||
                entry.action === 'reject'
            );
        },

        shouldSuppressTerminationEcho(type, payload) {
            this.pruneLocalTermination();
            const entry = this.localTermination || {};
            if (!entry.at) return false;
            const eventCallId = trim(payload && (payload.call_id || payload.callId));
            if (entry.callId && eventCallId && entry.callId !== eventCallId) return false;
            const reason = normalizeReasonCode(payload && (payload.reason || payload.end_reason || payload.fail_reason));
            const actorRole = trim(payload && payload.actor_role).toLowerCase();
            if ((type === 'im.call.failed' || type === 'im.call.error') && entry.action === 'reject' && reason === 'rejected' && actorRole === entry.role) {
                return true;
            }
            if ((type === 'im.call.failed' || type === 'im.call.error') && entry.action === 'cancel' && entry.role === 'caller' && (
                reason === 'socket_timeout' ||
                reason === 'socket_error' ||
                reason === 'socket_unavailable' ||
                reason === 'call_not_found'
            )) {
                return true;
            }
            if (type === 'im.call.ended' && entry.action === 'cancel' && entry.role === 'caller' && reason === 'hangup') {
                return true;
            }
            if (type === 'im.call.ended' && entry.action === 'hangup' && reason === 'hangup' && (!actorRole || actorRole === entry.role)) {
                return true;
            }
            if (type === 'im.call.ended' && reason === 'hangup' && actorRole && actorRole === entry.role) {
                return true;
            }
            return false;
        },

        isRecentlyClosedCallPayload(payload) {
            this.pruneLocalTermination();
            const entry = this.localTermination || {};
            const eventCallId = trim(payload && (payload.call_id || payload.callId));
            return !!(entry.at && entry.callId && eventCallId && entry.callId === eventCallId);
        },

        isDifferentActiveCallPayload(payload) {
            const eventCallId = trim(payload && (payload.call_id || payload.callId));
            return !!(this.currentCallId && eventCallId && this.currentCallId !== eventCallId);
        },

        getViewerRole(payload) {
            return trim(payload && (payload.viewer_role || payload.role) || this.role).toLowerCase();
        },

        resolveSignalTerminalPresentation(type, reason, payload) {
            const normalizedType = trim(type).toLowerCase();
            const normalizedReason = normalizeReasonCode(reason);
            const viewerRole = this.getViewerRole(payload);
            const actorRole = trim(payload && payload.actor_role).toLowerCase();
            const wasConnected = this.wasEverConnected() || this.mode === CALL_MODES.active || !!(payload && (payload.connected_at || payload.accepted_at));
            if (normalizedReason === 'timeout' && viewerRole === 'callee') {
                return { action: 'silent' };
            }
            if ((normalizedReason === 'rejected' || normalizedReason === 'hangup') && actorRole && viewerRole && actorRole === viewerRole) {
                return { action: 'silent' };
            }
            if (normalizedReason === 'hangup' && actorRole && viewerRole && actorRole !== viewerRole) {
                if (!wasConnected && actorRole === 'caller' && viewerRole === 'callee') {
                    return { action: 'silent' };
                }
                return { action: 'show', presentation: wasConnected ? 'toast' : 'panel', autoCloseMs: wasConnected ? 1200 : 1600 };
            }
            if (normalizedType === 'im.call.failed' || normalizedType === 'im.call.error') {
                if (normalizedReason === 'timeout' && viewerRole === 'caller') {
                    return { action: 'show', presentation: 'panel', autoCloseMs: 1800 };
                }
                if (normalizedReason === 'rejected' && viewerRole === 'caller') {
                    return { action: 'show', presentation: 'panel', autoCloseMs: 1700 };
                }
            }
            return { action: 'show', presentation: 'panel' };
        },

        wasEverConnected() {
            return this.everConnectedAt > 0;
        },

        markConnected() {
            const wasConnected = this.everConnectedAt > 0;
            if (!this.everConnectedAt) this.everConnectedAt = Date.now();
            if (!wasConnected) {
                this.recordCallSession('mark_connected', {
                    connectedAt: this.everConnectedAt
                });
            }
        },

        setConnectionPhase(phase, options) {
            options = options || {};
            const normalizedPhase = trim(phase).toLowerCase();
            if (this.connectionPhase === normalizedPhase) return;
            this.connectionPhase = normalizedPhase;
            if (options.render !== false) this.render();
        },

        updateLiveDurationText() {
            if (!this.activeStartedAt) {
                this.liveDurationText = '';
                return '';
            }
            const nextText = formatCallDuration((Date.now() - this.activeStartedAt) / 1000);
            const changed = this.liveDurationText !== nextText;
            this.liveDurationText = nextText;
            if (changed && this.mode === CALL_MODES.active) this.render();
            return nextText;
        },

        startDurationTicker() {
            if (!this.activeStartedAt) this.activeStartedAt = Date.now();
            this.lastDurationText = '';
            this.updateLiveDurationText();
            if (this.timers.duration) return;
            const self = this;
            this.timers.duration = global.setInterval(function() {
                self.updateLiveDurationText();
            }, 1000);
        },

        stopDurationTicker(options) {
            options = options || {};
            this.clearTimer('duration');
            if (!options.preserveActiveStartedAt) this.activeStartedAt = 0;
            if (!options.preserveLiveDurationText) this.liveDurationText = '';
        },

        captureDurationSnapshot() {
            const snapshot = this.activeStartedAt
                ? formatCallDuration((Date.now() - this.activeStartedAt) / 1000)
                : trim(this.liveDurationText || this.lastDurationText);
            this.lastDurationText = snapshot || '';
            this.stopDurationTicker();
            return this.lastDurationText;
        },

        clearLiveSessionState() {
            this.stopDurationTicker();
            this.lastDurationText = '';
            this.setConnectionPhase('', { render: false });
        },

        markActive() {
            this.markConnected();
            this.setConnectionPhase('', { render: false });
            this.startDurationTicker();
            if (this.isVideoCall()) this.startVideoQualityMonitor();
            this.recordCallSession('mark_active', {
                mode: CALL_MODES.active,
                activeAt: this.activeStartedAt,
                durationText: trim(this.liveDurationText || this.lastDurationText)
            });
        },

        buildRenderMeta() {
            return {
                endReason: this.lastEndReason,
                actor: this.lastEndActor,
                actorRole: this.lastEndActorRole,
                role: this.role,
                kind: this.currentKind,
                wasEverConnected: this.wasEverConnected(),
                connectionPhase: this.connectionPhase,
                durationText: trim(this.liveDurationText || this.lastDurationText),
                localTermination: this.localTermination,
                peerName: this.currentPeerName,
                peerAvatarUrl: this.currentPeerAvatarUrl,
                localVideoReady: this.localVideoReady,
                remoteVideoReady: this.remoteVideoReady,
                primaryVideoSource: this.primaryVideoSource,
                cameraEnabled: this.cameraEnabled,
                cameraFacingMode: this.cameraFacingMode,
                qualityProfile: this.qualityProfile,
                qualityHealth: this.qualityHealth,
                qualityStatusText: this.qualityStatusText
            };
        },

        resolveVideoSurface() {
            if (!this.isVideoCall()) return 'none';
            if (this.remoteVideoReady && this.localVideoReady && this.primaryVideoSource === 'local') return 'local';
            if (this.remoteVideoReady) return 'remote';
            if (this.localVideoReady) return 'local';
            return 'empty';
        },

        canSwitchCamera() {
            return this.isVideoCall()
                && this.localVideoReady
                && !this.cameraSwitching
                && this.webRTC
                && typeof this.webRTC.switchCamera === 'function';
        },

        renderActionButton(ref, config) {
            if (!ref) return;
            const visible = !!(config && config.visible);
            ref.style.display = visible ? 'flex' : 'none';
            if (!visible) {
                ref.innerHTML = '';
                ref.removeAttribute('data-variant');
                ref.removeAttribute('data-prominence');
                ref.removeAttribute('data-slot');
                ref.removeAttribute('data-appearance');
                ref.removeAttribute('data-selected');
                ref.removeAttribute('aria-label');
                ref.removeAttribute('title');
                return;
            }
            ref.innerHTML = buildActionMarkup(config);
            ref.dataset.variant = config.variant || 'neutral';
            ref.dataset.prominence = config.prominence || 'secondary';
            ref.dataset.slot = config.slot || '';
            ref.dataset.appearance = config.appearance || 'tool';
            ref.dataset.selected = config.selected ? '1' : '0';
            ref.setAttribute('aria-label', config.label || '');
            ref.title = config.label || '';
        },

        renderAvatarTarget(element, avatarUrl, fallbackText, options) {
            if (!element) return;
            const renderOptions = options && typeof options === 'object' ? options : {};
            const initial = getAvatarInitial(fallbackText);
            const normalizedUrl = trim(avatarUrl);
            const imageClassName = renderOptions.imageClass || 'ak-im-call-overlay-peer-avatar';
            const existingImg = normalizedUrl ? element.querySelector('img') : null;
            if (existingImg && existingImg.getAttribute('src') === normalizedUrl && existingImg.className === imageClassName) {
                existingImg.alt = trim(renderOptions.altText) || '头像';
                element.dataset.hasAvatar = '1';
                return;
            }
            element.innerHTML = '';
            element.removeAttribute('data-has-avatar');
            if (normalizedUrl) {
                const img = document.createElement('img');
                img.className = imageClassName;
                img.alt = trim(renderOptions.altText) || '头像';
                img.src = normalizedUrl;
                img.loading = 'eager';
                img.decoding = 'async';
                img.referrerPolicy = 'no-referrer';
                img.onerror = function() {
                    if (img.parentNode !== element) return;
                    element.innerHTML = '';
                    element.removeAttribute('data-has-avatar');
                    if (renderOptions.initialClass) {
                        const fallbackNode = document.createElement('span');
                        fallbackNode.className = renderOptions.initialClass;
                        fallbackNode.textContent = initial;
                        element.appendChild(fallbackNode);
                    } else {
                        element.textContent = initial;
                    }
                };
                element.appendChild(img);
                element.dataset.hasAvatar = '1';
                return;
            }
            if (renderOptions.initialClass) {
                const initialNode = document.createElement('span');
                initialNode.className = renderOptions.initialClass;
                initialNode.textContent = initial;
                element.appendChild(initialNode);
                return;
            }
            element.textContent = initial;
        },

        sendHangupSignal(callId) {
            const normalizedCallId = trim(callId || this.currentCallId);
            if (!normalizedCallId || !this.signaling) return;
            this.signaling.send('im.call.hangup', { call_id: normalizedCallId });
        },

        presentLocalTermination(action, payload, options) {
            const normalizedAction = trim(action).toLowerCase();
            const nextPayload = Object.assign({}, payload || {});
            const actorRole = trim(options && options.actorRole || this.role).toLowerCase();
            const endReason = normalizedAction === 'cancel'
                ? 'cancel'
                : (normalizedAction === 'reject' ? 'rejected' : 'hangup');
            if (actorRole && !trim(nextPayload.actor_role)) nextPayload.actor_role = actorRole;
            if (!trim(nextPayload.reason)) nextPayload.reason = endReason;
            if (!trim(nextPayload.end_reason)) nextPayload.end_reason = endReason;
            this.end('ended', nextPayload, {
                endReason: endReason,
                actorRole: actorRole,
                preserveLocalTermination: true,
                presentation: 'panel',
                autoCloseMs: typeof options === 'object' && typeof options.autoCloseMs === 'number'
                    ? options.autoCloseMs
                    : (endReason === 'cancel' ? 1800 : 2000)
            });
        },

        canMinimize() {
            return this.mode === CALL_MODES.incoming
                || this.mode === CALL_MODES.outgoing
                || this.mode === CALL_MODES.connecting
                || this.mode === CALL_MODES.active;
        },

        minimize() {
            if (!this.canMinimize()) return;
            this.minimized = true;
            this.render();
        },

        restore() {
            if (this.mode === CALL_MODES.idle) return;
            this.minimized = false;
            this.render();
        },

        setState(mode, payload) {
            payload = payload || {};
            this.mode = mode || CALL_MODES.idle;
            const nextCallId = trim(payload.call_id || payload.callId);
            if (nextCallId) this.currentCallId = nextCallId;
            const nextConversationId = Number(payload.conversation_id || payload.conversationId || 0);
            if (nextConversationId > 0) this.currentConversationId = nextConversationId;
            const nextPeerName = trim(payload.peer_name || payload.peer_display_name || payload.peerName || payload.title);
            if (nextPeerName) this.currentPeerName = nextPeerName;
            const nextPeerUsername = trim(payload.peer_username || payload.peerUsername);
            if (nextPeerUsername) this.currentPeerUsername = nextPeerUsername;
            const nextPeerAvatarUrl = this.resolvePeerAvatarUrl(payload);
            if (nextPeerAvatarUrl) this.currentPeerAvatarUrl = nextPeerAvatarUrl;
            const nextKind = trim(payload.call_kind || payload.kind);
            if (nextKind) this.currentKind = normalizeCallKind(nextKind);
            const nextRole = trim(payload.viewer_role || payload.role);
            if (nextRole) this.role = nextRole.toLowerCase();
            const nextActor = trim(payload.actor);
            if (nextActor) this.lastEndActor = nextActor;
            const nextActorRole = trim(payload.actor_role);
            if (nextActorRole) this.lastEndActorRole = nextActorRole.toLowerCase();
            this.render();
        },

        render() {
            const refs = this.refs;
            if (!refs.panel) return;
            const visible = this.mode !== CALL_MODES.idle;
            const showMinimizedShell = visible && this.minimized;
            const isVideoCall = this.isVideoCall();
            const renderMeta = this.buildRenderMeta();
            const view = adaptCallViewModel(
                buildCallViewModel(this.mode, this.lastFailReason, !!this.currentCallId, this.currentPeerName, this.muted, renderMeta),
                this.currentKind,
                this.mode,
                renderMeta
            );
            const canSwitchCamera = this.canSwitchCamera();
            const actionLayout = isVideoCall
                ? buildVideoCallActionLayout(this.mode, this.muted, this.speakerEnabled, this.cameraEnabled, canSwitchCamera)
                : buildCallActionLayout(this.mode, this.muted, this.speakerEnabled);
            const headerStatus = buildHeaderStatusText(view);
            const stateText = this.cameraSwitching ? '正在翻转摄像头' : (trim(this.qualityStatusText) || trim(view.footer));
            const videoSurface = this.resolveVideoSurface();
            const isVideoWaitingIdentity = isVideoCall
                && (this.mode === CALL_MODES.outgoing || this.mode === CALL_MODES.connecting)
                && this.localVideoReady
                && !this.remoteVideoReady;
            refs.panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
            refs.panel.dataset.mode = this.mode;
            refs.panel.dataset.minimized = showMinimizedShell ? '1' : '0';
            refs.panel.dataset.kind = this.currentKind;
            refs.panel.dataset.localVideoReady = this.localVideoReady ? '1' : '0';
            refs.panel.dataset.remoteVideoReady = this.remoteVideoReady ? '1' : '0';
            refs.panel.dataset.videoSurface = videoSurface;
            refs.panel.dataset.cameraEnabled = this.cameraEnabled ? '1' : '0';
            refs.panel.dataset.cameraFacing = this.cameraFacingMode || 'user';
            refs.panel.dataset.terminalPresentation = this.terminalPresentation || 'panel';
            refs.title.textContent = this.currentPeerName || getCallKindLabel(this.currentKind);
            refs.subtitle.textContent = headerStatus;
            refs.subtitle.style.display = headerStatus ? 'block' : 'none';
            refs.state.textContent = stateText;
            refs.state.style.display = stateText ? 'block' : 'none';
            if (refs.minimize) {
                refs.minimize.style.display = visible && !this.minimized && this.canMinimize() ? 'flex' : 'none';
                refs.minimize.innerHTML = getIconMarkup(isVideoCall ? 'float_window' : 'minimize');
            }
            if (refs.restoreIcon) refs.restoreIcon.innerHTML = getIconMarkup(isVideoCall ? 'video' : 'phone');
            if (refs.restoreLabel) refs.restoreLabel.textContent = (this.currentPeerName || getCallRestoreLabel(this.currentKind)).trim() || getCallRestoreLabel(this.currentKind);
            if (refs.restore) {
                refs.restore.dataset.kind = this.currentKind;
                refs.restore.dataset.videoReady = (isVideoCall && (this.remoteVideoReady || this.localVideoReady)) ? '1' : '0';
                refs.restore.dataset.videoSource = this.remoteVideoReady ? 'remote' : (this.localVideoReady ? 'local' : 'none');
            }
            if (refs.restoreVideo) {
                const restoreStream = isVideoCall && refs.remoteVideo && refs.remoteVideo.srcObject
                    ? refs.remoteVideo.srcObject
                    : (isVideoCall && refs.localVideo ? refs.localVideo.srcObject : null);
                try {
                    if (refs.restoreVideo.srcObject !== restoreStream) refs.restoreVideo.srcObject = restoreStream || null;
                    refs.restoreVideo.muted = true;
                    refs.restoreVideo.playsInline = true;
                    refs.restoreVideo.style.display = showMinimizedShell && restoreStream ? 'block' : 'none';
                    if (showMinimizedShell && restoreStream) {
                        const restorePlayResult = refs.restoreVideo.play();
                        if (restorePlayResult && typeof restorePlayResult.catch === 'function') restorePlayResult.catch(function() {});
                    }
                } catch (e) {}
            }
            refs.placeholder.style.display = (isVideoCall && this.remoteVideoReady) ? 'none' : 'flex';
            if (refs.placeholderText) refs.placeholderText.textContent = view.headline || '';
            if (refs.detailTitle) refs.detailTitle.textContent = view.detailTitle || '';
            if (refs.detailBody) refs.detailBody.textContent = view.detailBody || '';
            if (refs.avatar) {
                refs.avatar.style.transform = view.pending ? 'scale(1.04)' : 'scale(1)';
                this.renderAvatarTarget(refs.avatar, this.currentPeerAvatarUrl, this.currentPeerName || this.currentPeerUsername || 'C', {
                    imageClass: 'ak-im-call-overlay-avatar-photo',
                    altText: (this.currentPeerName || '对方') + '头像'
                });
            }
            if (refs.placeholderIcon) {
                if (isVideoWaitingIdentity) {
                    this.renderAvatarTarget(refs.placeholderIcon, this.currentPeerAvatarUrl, this.currentPeerName || this.currentPeerUsername || 'V', {
                        imageClass: 'ak-im-call-overlay-peer-avatar',
                        initialClass: 'ak-im-call-overlay-peer-initial',
                        altText: (this.currentPeerName || '对方') + '头像'
                    });
                    refs.placeholderIcon.dataset.icon = 'avatar';
                    refs.placeholderIcon.dataset.identity = '1';
                } else {
                    refs.placeholderIcon.innerHTML = getIconMarkup(view.icon);
                    refs.placeholderIcon.dataset.icon = view.icon || 'phone';
                    refs.placeholderIcon.dataset.identity = '0';
                }
                refs.placeholderIcon.style.animation = view.pending ? 'akImCallOverlayIconFloat 2.2s ease-in-out infinite' : 'none';
            }
            if (refs.pulse) {
                refs.pulse.style.display = view.pending ? 'block' : 'none';
                refs.pulse.style.animation = view.pending ? 'akImCallOverlayPulse 1.8s ease-in-out infinite' : 'none';
            }
            if (refs.localVideo) refs.localVideo.style.display = isVideoCall && this.localVideoReady && !this.minimized ? 'block' : 'none';
            if (refs.remoteVideo) refs.remoteVideo.style.display = isVideoCall && this.remoteVideoReady && !this.minimized ? 'block' : 'none';
            if (refs.localAudio) refs.localAudio.style.display = isVideoCall ? 'none' : '';
            if (refs.actions) refs.actions.dataset.layout = actionLayout.layout || 'hidden';
            if (refs.inlineActions) refs.inlineActions.innerHTML = '';
            this.renderActionButton(refs.reject, actionLayout.reject);
            this.renderActionButton(refs.accept, actionLayout.accept);
            this.renderActionButton(refs.mute, actionLayout.mute);
            this.renderActionButton(refs.speaker, actionLayout.speaker);
            this.renderActionButton(refs.camera, actionLayout.camera);
            this.renderActionButton(refs.hangup, actionLayout.hangup);
            this.renderActionButton(refs.cameraSwitch, actionLayout.cameraSwitch);
            if (refs.inlineActions && actionLayout.layout === 'double') {
                refs.inlineActions.style.display = 'flex';
                if (refs.reject) refs.inlineActions.appendChild(refs.reject);
                if (refs.accept) refs.inlineActions.appendChild(refs.accept);
                if (refs.actions) refs.actions.style.display = 'none';
            } else {
                if (refs.inlineActions) refs.inlineActions.style.display = 'none';
                if (refs.actions) {
                    if (refs.reject && refs.reject.parentNode !== refs.actions) refs.actions.appendChild(refs.reject);
                    if (refs.mute && refs.mute.parentNode !== refs.actions) refs.actions.appendChild(refs.mute);
                    if (refs.hangup && refs.hangup.parentNode !== refs.actions) refs.actions.appendChild(refs.hangup);
                    if (refs.camera && refs.camera.parentNode !== refs.actions) refs.actions.appendChild(refs.camera);
                    if (refs.speaker && refs.speaker.parentNode !== refs.actions) refs.actions.appendChild(refs.speaker);
                    if (refs.cameraSwitch && refs.cameraSwitch.parentNode !== refs.actions) refs.actions.appendChild(refs.cameraSwitch);
                    if (refs.accept && refs.accept.parentNode !== refs.actions) refs.actions.appendChild(refs.accept);
                    refs.actions.style.display = '';
                }
            }
        },

        openOutgoing(payload) {
            payload = payload || {};
            const flowVersion = this.bumpFlowVersion();
            this.ensureStyle();
            this.ensureShell();
            this.clearAllTimers();
            this.resumePeerStateEvents();
            this.cleanupMedia();
            this.clearLocalTermination();
            this.clearResultState();
            this.clearLiveSessionState();
            this.minimized = false;
            this.role = 'caller';
            this.muted = false;
            this.speakerEnabled = false;
            this.offerSent = false;
            this.everConnectedAt = 0;
            this.terminalPresentation = 'panel';
            this.openedAt = Date.now();
            this.currentCallId = '';
            this.currentConversationId = 0;
            this.currentPeerName = '';
            this.currentPeerUsername = '';
            this.currentPeerAvatarUrl = '';
            this.currentKind = normalizeCallKind(payload.kind || payload.call_kind || this.currentKind || 'audio');
            this.clearVideoState();
            this.setConnectionPhase('launching', { render: false });
            this.setState(CALL_MODES.outgoing, payload);
            this.ensureCallLifecycleModules();
            this.recordCallSession('open_outgoing', {
                openedAt: this.openedAt,
                mode: CALL_MODES.outgoing
            });
            const self = this;
            this.ensureSubmodules().then(function() {
                if (!self.isFlowCurrent(flowVersion) || self.mode !== CALL_MODES.outgoing) return;
                if (!self.isVideoCall()) return null;
                self.setConnectionPhase('preparing_local');
                return self.webRTC.startLocal(self.currentKind).then(function() {
                    if (!self.isFlowCurrent(flowVersion) || self.mode !== CALL_MODES.outgoing) return null;
                    self.setConnectionPhase('launching');
                    return null;
                });
            }).then(function() {
                if (!self.isFlowCurrent(flowVersion) || self.mode !== CALL_MODES.outgoing) return;
                self.signaling.send('im.call.start', {
                    conversation_id: Number(payload.conversationId || payload.conversation_id || 0),
                    callee_username: trim(payload.peerUsername || payload.peer_username),
                    call_kind: self.currentKind,
                    ws_id: trim(payload.wsId),
                    page_id: trim(payload.pageId)
                });
                self.timers.launch = global.setTimeout(function() {
                    if (self.mode === CALL_MODES.outgoing && !self.currentCallId) {
                        self.fail('socket_timeout');
                    }
                }, 10000);
            }).catch(function(error) {
                self.fail(self.isVideoCall() ? 'media_denied' : 'unsupported', error && error.message ? error.message : '通话模块不可用');
            });
        },

        openIncoming(payload) {
            payload = payload || {};
            const flowVersion = this.bumpFlowVersion();
            this.ensureStyle();
            this.ensureShell();
            this.clearAllTimers();
            this.resumePeerStateEvents();
            this.cleanupMedia();
            this.clearLocalTermination();
            this.clearResultState();
            this.clearLiveSessionState();
            this.minimized = false;
            this.role = 'callee';
            this.muted = false;
            this.offerSent = false;
            this.everConnectedAt = 0;
            this.terminalPresentation = 'panel';
            this.openedAt = Date.now();
            this.currentCallId = '';
            this.currentConversationId = 0;
            this.currentPeerName = '';
            this.currentPeerUsername = '';
            this.currentPeerAvatarUrl = '';
            this.currentKind = normalizeCallKind(payload.call_kind || payload.kind || this.currentKind || 'audio');
            this.clearVideoState();
            this.setState(CALL_MODES.incoming, payload);
            this.ensureCallLifecycleModules();
            this.recordCallSession('open_incoming', {
                openedAt: this.openedAt,
                mode: CALL_MODES.incoming
            });
            const self = this;
            this.ensureSubmodules().then(function() {
                if (!self.isFlowCurrent(flowVersion) || self.mode !== CALL_MODES.incoming) return;
            }).catch(function(error) {
                self.fail('socket_unavailable', error && error.message ? error.message : '通话模块不可用');
            });
        },

        async accept() {
            await this.ensureSubmodules().catch(function() {
                return null;
            });
            if (!this.currentCallId || !this.signaling) return;
            const flowVersion = this.flowVersion;
            this.clearTimer('autoEnd');
            this.clearResultState();
            this.setConnectionPhase('accepting', { render: false });
            this.setState(CALL_MODES.connecting, {});
            this.recordCallSession('accept_requested', {
                mode: CALL_MODES.connecting,
                connectionPhase: 'accepting'
            });
            try {
                if (!this.webRTC || !this.webRTC.isSupported()) throw new Error('unsupported');
                await this.webRTC.startLocal(this.currentKind);
                if (!this.isFlowCurrent(flowVersion) || this.mode !== CALL_MODES.connecting || !this.currentCallId) return;
                this.setConnectionPhase('accepted');
                this.recordCallSession('accept_ready', {
                    mode: CALL_MODES.connecting,
                    connectionPhase: 'accepted'
                });
                this.signaling.send('im.call.accept', {
                    call_id: this.currentCallId,
                    ws_id: trim(this.ctx && this.ctx.state && this.ctx.state.wsId),
                    page_id: trim(this.ctx && this.ctx.state && this.ctx.state.pageId)
                });
            } catch (error) {
                this.fail(error && error.message === 'unsupported' ? 'unsupported' : 'media_denied', error && error.message ? error.message : '');
            }
        },

        reject() {
            const self = this;
            if (this.mode !== CALL_MODES.incoming) {
                this.close();
                return;
            }
            this.rememberLocalTermination('reject');
            this.emitCallTimeline('local_reject', {
                mode: CALL_MODES.ended,
                endReason: 'rejected',
                localTermination: this.localTermination
            });
            const sendReject = function() {
                if (!self.currentCallId || !self.signaling) return;
                try {
                    self.signaling.send('im.call.reject', { call_id: self.currentCallId });
                } catch (e) {}
            };
            if (this.signaling) {
                sendReject();
            } else {
                this.ensureSubmodules().then(sendReject).catch(function() {});
            }
            this.reset({ preserveLocalTermination: true });
        },

        hangup() {
            const hasEstablishedCall = this.activeStartedAt > 0 || this.mode === CALL_MODES.active;
            const action = hasEstablishedCall ? 'hangup' : 'cancel';
            this.rememberLocalTermination(action);
            this.presentLocalTermination(action, {
                call_id: this.currentCallId,
                conversation_id: this.currentConversationId
            }, {
                actorRole: this.role,
                autoCloseMs: hasEstablishedCall ? 2200 : 1800
            });
            this.emitCallTimeline(action === 'hangup' ? 'local_hangup' : 'local_cancel', {
                mode: CALL_MODES.ended,
                endReason: action === 'cancel' ? 'cancel' : 'hangup',
                localTermination: this.localTermination
            });
            if (this.currentCallId && this.signaling) {
                try {
                    this.signaling.send('im.call.hangup', { call_id: this.currentCallId });
                } catch (e) {}
            }
        },

        close() {
            if (this.mode === CALL_MODES.incoming) {
                this.reject();
                return;
            }
            if (this.mode === CALL_MODES.active || this.mode === CALL_MODES.outgoing || this.mode === CALL_MODES.connecting) {
                this.hangup();
                return;
            }
            this.reset();
        },

        reset(options) {
            options = options || {};
            this.bumpFlowVersion();
            this.clearAllTimers();
            this.mutePeerStateEvents(PEER_STATE_MUTE_MS);
            this.cleanupMedia();
            this.mode = CALL_MODES.idle;
            this.minimized = false;
            this.currentCallId = '';
            this.currentConversationId = 0;
            this.currentPeerName = '';
            this.currentPeerUsername = '';
            this.currentPeerAvatarUrl = '';
            this.currentKind = 'audio';
            this.role = '';
            this.muted = false;
            this.speakerEnabled = false;
            this.offerSent = false;
            this.everConnectedAt = 0;
            this.terminalPresentation = 'panel';
            if (!options.preserveLocalTermination) this.openedAt = 0;
            this.clearResultState();
            this.clearLiveSessionState();
            this.clearVideoState();
            if (!options.preserveLocalTermination) this.clearLocalTermination();
            this.render();
        },

        end(reason, payload, options) {
            payload = payload || {};
            options = options || {};
            this.captureDurationSnapshot();
            this.clearAllTimers();
            this.mutePeerStateEvents(PEER_STATE_MUTE_MS);
            this.cleanupMedia();
            this.minimized = false;
            this.terminalPresentation = trim(options.presentation).toLowerCase() === 'toast' ? 'toast' : 'panel';
            const nextMode = reason === 'failed' ? CALL_MODES.failed : CALL_MODES.ended;
            if (nextMode === CALL_MODES.failed) {
                this.lastFailReason = normalizeReasonCode(options.reason || payload.reason || payload.fail_reason || this.lastFailReason || 'socket_error');
            } else {
                this.lastEndReason = normalizeReasonCode(options.endReason || payload.end_reason || payload.reason || this.lastEndReason || 'hangup');
                this.lastEndActor = trim(options.actor || payload.actor || this.lastEndActor);
                this.lastEndActorRole = trim(options.actorRole || payload.actor_role || this.lastEndActorRole).toLowerCase();
            }
            this.setState(nextMode, payload);
            this.recordCallSession(nextMode === CALL_MODES.failed ? 'end_failed' : 'end_ended', {
                mode: nextMode,
                failReason: this.lastFailReason,
                endReason: this.lastEndReason,
                endActor: this.lastEndActor,
                endActorRole: this.lastEndActorRole,
                endedAt: Date.now()
            });
            if (options.instantClose) {
                this.reset({ preserveLocalTermination: !!options.preserveLocalTermination });
                return;
            }
            const self = this;
            const autoCloseMs = typeof options.autoCloseMs === 'number'
                ? options.autoCloseMs
                : resolveCallAutoCloseMs(nextMode, nextMode === CALL_MODES.failed ? this.lastFailReason : this.lastEndReason, this.buildRenderMeta());
            if (autoCloseMs > 0) {
                this.timers.autoEnd = global.setTimeout(function() {
                    self.reset({ preserveLocalTermination: !!options.preserveLocalTermination });
                }, autoCloseMs);
            }
        },

        fail(reason, message, payload, options) {
            payload = Object.assign({}, payload || {});
            const normalizedReason = normalizeReasonCode(reason || payload.reason || 'socket_error');
            this.lastFailReason = normalizedReason;
            payload.reason = normalizedReason;
            if (trim(message)) payload.message = trim(message);
            const nextOptions = options && typeof options === 'object' ? options : {};
            this.end('failed', payload, Object.assign({}, nextOptions, { reason: normalizedReason }));
            this.emitCallTimeline('failed', {
                mode: CALL_MODES.failed,
                failReason: normalizedReason,
                endedAt: Date.now()
            });
        },

        async startCallerPeer() {
            if (!this.webRTC || this.role !== 'caller') return;
            if (this.offerSent) return;
            const flowVersion = this.flowVersion;
            this.offerSent = true;
            try {
                this.setConnectionPhase('preparing_local', { render: false });
                this.setState(CALL_MODES.connecting, {});
                this.recordCallSession('caller_preparing_local', {
                    mode: CALL_MODES.connecting,
                    connectionPhase: 'preparing_local'
                });
                await this.webRTC.startLocal(this.currentKind);
                if (!this.isFlowCurrent(flowVersion) || this.mode === CALL_MODES.idle || !this.currentCallId) {
                    this.offerSent = false;
                    return;
                }
                this.setConnectionPhase('negotiating');
                this.recordCallSession('caller_negotiating', {
                    mode: CALL_MODES.connecting,
                    connectionPhase: 'negotiating'
                });
                await this.webRTC.createOffer(this.currentKind);
            } catch (error) {
                this.offerSent = false;
                this.fail('media_denied', error && error.message ? error.message : '');
            }
        },

        async handleSignalEvent(type, payload) {
            payload = payload || {};
            this.pruneLocalTermination();
            if (type === 'im.call.ended' || type === 'im.call.failed' || type === 'im.call.error') {
                this.clearTimer('peerDisconnect');
            }
            if (type !== 'im.call.started' && this.mode === CALL_MODES.idle && this.isRecentlyClosedCallPayload(payload)) return;
            if (type !== 'im.call.ringing' && this.isDifferentActiveCallPayload(payload)) return;
            if (type === 'im.call.started') {
                this.clearTimer('launch');
                this.role = 'caller';
                if (this.shouldAbortFreshOutgoingCall()) {
                    this.rememberLocalTermination('cancel', payload);
                    this.presentLocalTermination('cancel', payload, {
                        actorRole: 'caller',
                        autoCloseMs: 1800
                    });
                    this.sendHangupSignal(payload.call_id);
                    return;
                }
                this.setState(CALL_MODES.outgoing, payload);
                this.recordCallSession('signal_started', {
                    mode: CALL_MODES.outgoing
                });
                return;
            }
            if (type === 'im.call.ringing') {
                if (this.currentCallId && trim(payload.call_id) && this.currentCallId !== trim(payload.call_id)) return;
                this.openIncoming(payload);
                return;
            }
            if (type === 'im.call.accepted' || type === 'im.call.connected') {
                this.markConnected();
                this.setConnectionPhase(this.role === 'caller' ? 'accepted' : 'negotiating', { render: false });
                this.setState(CALL_MODES.connecting, payload);
                this.recordCallSession(type === 'im.call.accepted' ? 'signal_accepted' : 'signal_connected', {
                    mode: CALL_MODES.connecting,
                    connectionPhase: this.role === 'caller' ? 'accepted' : 'negotiating'
                });
                if (this.role === 'caller') await this.startCallerPeer();
                return;
            }
            if (type === 'im.call.offer') {
                if (!this.webRTC || !payload.sdp) return;
                this.markConnected();
                this.setConnectionPhase('negotiating', { render: false });
                this.setState(CALL_MODES.connecting, payload);
                this.recordCallSession('signal_offer', {
                    mode: CALL_MODES.connecting,
                    connectionPhase: 'negotiating'
                });
                try {
                    await this.webRTC.acceptOffer(payload.sdp, this.currentKind || payload.call_kind || payload.kind || 'audio');
                } catch (error) {
                    this.fail('media_denied', error && error.message ? error.message : '', payload);
                }
                return;
            }
            if (type === 'im.call.answer') {
                if (this.webRTC && payload.sdp) {
                    await this.webRTC.acceptAnswer(payload.sdp);
                    this.markActive();
                    this.setState(CALL_MODES.active, payload);
                    this.recordCallSession('signal_answer', {
                        mode: CALL_MODES.active
                    });
                }
                return;
            }
            if (type === 'im.call.ice') {
                if (this.webRTC && payload.candidate) await this.webRTC.addIceCandidate(payload.candidate);
                return;
            }
            if (type === 'im.call.updated') {
                this.setState(this.mode, payload);
                this.recordCallSession('signal_updated', {
                    mode: this.mode
                });
                return;
            }
            if (type === 'im.call.failed' || type === 'im.call.error') {
                if (this.shouldSuppressTerminationEcho(type, payload)) return;
                const failReason = normalizeReasonCode(payload.reason) || (trim(payload.message) === 'busy' ? 'busy' : 'socket_error');
                const terminal = this.resolveSignalTerminalPresentation(type, failReason, payload);
                if (terminal.action === 'silent') {
                    this.reset({ preserveLocalTermination: true });
                    return;
                }
                this.fail(failReason, trim(payload.message), payload, {
                    presentation: terminal.presentation,
                    autoCloseMs: terminal.autoCloseMs
                });
                return;
            }
            if (type === 'im.call.ended') {
                if (this.shouldSuppressTerminationEcho(type, payload)) return;
                const endReason = normalizeReasonCode(payload.reason || payload.end_reason || 'hangup');
                const terminal = this.resolveSignalTerminalPresentation(type, endReason, payload);
                if (terminal.action === 'silent') {
                    this.reset({ preserveLocalTermination: true });
                    return;
                }
                this.end('ended', Object.assign({}, payload, { reason: endReason, end_reason: endReason }), {
                    endReason: endReason,
                    presentation: terminal.presentation,
                    autoCloseMs: terminal.autoCloseMs
                });
            }
        },

        handleSocketPayload(data) {
            if (!data || typeof data !== 'object' || typeof data.type !== 'string') return false;
            if (!data.type.startsWith('im.call.')) return false;
            this.ensureStyle();
            this.ensureShell();
            Promise.resolve(this.handleSignalEvent(data.type, data.payload && typeof data.payload === 'object' ? data.payload : {})).catch(function() {});
            return true;
        },

        sendWebRTCSignal(type, payload) {
            if (!this.signaling || !this.currentCallId) return;
            const eventType = type === 'ice' ? 'im.call.ice' : (type === 'answer' ? 'im.call.answer' : 'im.call.offer');
            this.signaling.send(eventType, Object.assign({
                call_id: this.currentCallId,
                conversation_id: this.currentConversationId,
                call_kind: this.currentKind
            }, payload || {}));
        },

        attachLocalStream(stream) {
            const audio = this.refs.localAudio;
            const localVideo = this.refs.localVideo;
            if (!stream) return;
            if (this.webRTC && typeof this.webRTC.getFacingMode === 'function') {
                this.cameraFacingMode = this.webRTC.getFacingMode() || this.cameraFacingMode || 'user';
            }
            try {
                if (audio) {
                    audio.srcObject = stream;
                    audio.muted = true;
                }
            } catch (e) {}
            try {
                if (localVideo) {
                    localVideo.srcObject = stream;
                    localVideo.muted = true;
                    localVideo.playsInline = true;
                    localVideo.autoplay = true;
                    const localVideoPlayResult = localVideo.play();
                    if (localVideoPlayResult && typeof localVideoPlayResult.catch === 'function') localVideoPlayResult.catch(function() {});
                }
            } catch (e) {}
            if (this.webRTC && typeof this.webRTC.setMuted === 'function') {
                try { this.webRTC.setMuted(this.muted); } catch (e) {}
            }
            if (this.webRTC && typeof this.webRTC.setCameraEnabled === 'function') {
                try { this.webRTC.setCameraEnabled(this.cameraEnabled); } catch (e) {}
            }
            this.localVideoReady = !!(isVideoCallKind(this.currentKind) && stream.getVideoTracks && stream.getVideoTracks().length);
            this.render();
        },

        attachRemoteStream(stream) {
            const audio = this.refs.localAudio;
            const remoteVideo = this.refs.remoteVideo;
            const isVideo = this.isVideoCall();
            if (!stream) return;
            try {
                if (audio) {
                    if (isVideo) {
                        audio.muted = true;
                        audio.srcObject = null;
                    } else {
                        audio.srcObject = stream;
                        audio.muted = false;
                        audio.volume = this.getRemotePlaybackVolume();
                        const playResult = audio.play();
                        if (playResult && typeof playResult.catch === 'function') playResult.catch(function() {});
                    }
                }
            } catch (e) {}
            try {
                if (remoteVideo && isVideo) {
                    remoteVideo.srcObject = stream;
                    remoteVideo.muted = false;
                    remoteVideo.playsInline = true;
                    remoteVideo.volume = this.getRemotePlaybackVolume();
                    const videoPlayResult = remoteVideo.play();
                    if (videoPlayResult && typeof videoPlayResult.catch === 'function') videoPlayResult.catch(function() {});
                }
            } catch (e) {}
            this.remoteVideoReady = !!(isVideoCallKind(this.currentKind) && stream.getVideoTracks && stream.getVideoTracks().length);
            this.markActive();
            this.setState(CALL_MODES.active, {});
            if (this.remoteVideoReady) this.startVideoQualityMonitor();
        },

        getRemotePlaybackVolume() {
            return this.speakerEnabled ? REMOTE_SPEAKER_VOLUME : REMOTE_EARPIECE_VOLUME;
        },

        applyRemotePlaybackVolume() {
            const volume = this.getRemotePlaybackVolume();
            if (this.refs.localAudio) {
                try { this.refs.localAudio.volume = volume; } catch (e) {}
            }
            if (this.refs.remoteVideo) {
                try { this.refs.remoteVideo.volume = volume; } catch (e) {}
            }
            return volume;
        },

        handlePeerState(state) {
            const normalizedState = trim(state).toLowerCase();
            if (this.shouldIgnorePeerState(normalizedState)) return;
            if (normalizedState === 'connected') {
                this.clearTimer('peerDisconnect');
                this.markActive();
                this.setState(CALL_MODES.active, {});
                return;
            }
            if (normalizedState === 'failed' || normalizedState === 'disconnected') {
                this.schedulePeerDisconnectFailure(normalizedState);
            }
        },

        toggleMute() {
            this.muted = !this.muted;
            if (this.webRTC && typeof this.webRTC.setMuted === 'function') this.webRTC.setMuted(this.muted);
            if (this.signaling && this.currentCallId) this.signaling.send('im.call.mute', { call_id: this.currentCallId, muted: this.muted });
            this.render();
        },

        toggleSpeaker() {
            this.speakerEnabled = !this.speakerEnabled;
            this.applyRemotePlaybackVolume();
            this.render();
        },

        toggleCamera() {
            if (!this.isVideoCall()) return;
            this.cameraEnabled = !this.cameraEnabled;
            if (this.webRTC && typeof this.webRTC.setCameraEnabled === 'function') {
                try { this.webRTC.setCameraEnabled(this.cameraEnabled); } catch (e) {}
            }
            this.render();
        },

        toggleVideoPrimary(source) {
            if (!this.isVideoCall() || !this.localVideoReady || !this.remoteVideoReady) return;
            const currentSurface = this.resolveVideoSurface();
            const normalizedSource = trim(source).toLowerCase();
            if (normalizedSource === 'local' && currentSurface === 'remote') this.primaryVideoSource = 'local';
            else if (normalizedSource === 'remote' && currentSurface === 'local') this.primaryVideoSource = 'remote';
            else return;
            this.render();
        },

        switchCamera() {
            if (!this.canSwitchCamera()) return;
            const self = this;
            this.cameraSwitching = true;
            this.render();
            Promise.resolve(this.webRTC.switchCamera()).then(function(switched) {
                if (self.webRTC && typeof self.webRTC.getFacingMode === 'function') {
                    self.cameraFacingMode = self.webRTC.getFacingMode() || self.cameraFacingMode || 'user';
                }
                if (!switched) {
                    self.qualityStatusText = '当前设备不支持摄像头翻转';
                }
            }).catch(function() {
                self.qualityStatusText = '摄像头翻转失败';
            }).then(function() {
                self.cameraSwitching = false;
                self.render();
            });
        },

        cleanupMedia() {
            if (this.webRTC && typeof this.webRTC.close === 'function') this.webRTC.close();
            if (this.refs.localAudio) {
                try { this.refs.localAudio.srcObject = null; } catch (e) {}
            }
            if (this.refs.localVideo) {
                try { this.refs.localVideo.srcObject = null; } catch (e) {}
            }
            if (this.refs.remoteVideo) {
                try { this.refs.remoteVideo.srcObject = null; } catch (e) {}
            }
            if (this.refs.restoreVideo) {
                try { this.refs.restoreVideo.srcObject = null; } catch (e) {}
            }
            this.localVideoReady = false;
            this.remoteVideoReady = false;
        },

        destroy() {
            this.bumpFlowVersion();
            this.clearAllTimers();
            this.mutePeerStateEvents(PEER_STATE_MUTE_MS);
            this.cleanupMedia();
            this.clearLiveSessionState();
            this.clearLocalTermination();
            this.openedAt = 0;
            if (this.signaling && typeof this.signaling.destroy === 'function') this.signaling.destroy();
            this.signaling = null;
            this.webRTC = null;
            this.submodulePromise = null;
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.callManage = callModule;
})(window);
