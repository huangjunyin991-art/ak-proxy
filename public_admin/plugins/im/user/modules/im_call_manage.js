(function(global) {
    'use strict';

    const STYLE_ID = 'ak-im-call-overlay-style';
    const PANEL_SELECTOR = '.ak-im-call-overlay';
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
    const CALL_HANGUP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(90 12 12)"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.11 4.18 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.62a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.46-1.18a2 2 0 0 1 2.11-.45c.84.29 1.72.5 2.62.62A2 2 0 0 1 22 16.92Z"></path></g></svg>';
    const CALL_ICON_MARKUP = {
        close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',
        minimize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"></path></svg>',
        phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.11 4.18 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.62a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.46-1.18a2 2 0 0 1 2.11-.45c.84.29 1.72.5 2.62.62A2 2 0 0 1 22 16.92Z"></path></svg>',
        incoming: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 2v6h6"></path><path d="m22 2-7 7"></path><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.11 4.18 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.62a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.46-1.18a2 2 0 0 1 2.11-.45c.84.29 1.72.5 2.62.62A2 2 0 0 1 22 16.92Z"></path></svg>',
        waiting: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v6l4 2"></path></svg>',
        active: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.11 4.18 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.62a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.46-1.18a2 2 0 0 1 2.11-.45c.84.29 1.72.5 2.62.62A2 2 0 0 1 22 16.92Z"></path><path d="M9 12h6"></path></svg>',
        success: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"></path></svg>',
        warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path></svg>',
        ended: CALL_HANGUP_ICON,
        accept: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.11 4.18 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.62a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.46-1.18a2 2 0 0 1 2.11-.45c.84.29 1.72.5 2.62.62A2 2 0 0 1 22 16.92Z"></path><path d="m9 12 2 2 4-4"></path></svg>',
        reject: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.7 15.4a17 17 0 0 1 16.6 0"></path><path d="m6.15 14.65-2.15 3.75"></path><path d="m17.85 14.65 2.15 3.75"></path><path d="m9 9 6 6"></path><path d="m15 9-6 6"></path></svg>',
        hangup: CALL_HANGUP_ICON,
        cancel: CALL_HANGUP_ICON,
        mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Z"></path><path d="M19 10v2a7 7 0 1 1-14 0v-2"></path><path d="M12 19v3"></path></svg>',
        unmute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16"></path><path d="M9 9v3a3 3 0 0 0 5.12 2.12"></path><path d="M12 3a3 3 0 0 1 3 3v3"></path><path d="M19 10v2a7 7 0 0 1-11.06 5.8"></path><path d="M12 19v3"></path></svg>'
    };
    function trim(value) {
        return String(value || '').trim();
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

    function buildActionMarkup(iconName, label) {
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
                footer: '关闭窗口也会按“拒绝”处理。',
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

    function buildCallActionLayout(mode, muted) {
        if (mode === CALL_MODES.incoming) {
            return {
                layout: 'incoming',
                reject: { visible: true, icon: 'reject', label: '拒绝', variant: 'danger', prominence: 'secondary', slot: '1' },
                accept: { visible: true, icon: 'accept', label: '接听', variant: 'success', prominence: 'secondary', slot: '3' },
                mute: { visible: false },
                hangup: { visible: false }
            };
        }
        if (mode === CALL_MODES.active) {
            return {
                layout: 'active',
                reject: { visible: false },
                accept: { visible: false },
                mute: { visible: true, icon: muted ? 'unmute' : 'mute', label: muted ? '取消静音' : '静音', variant: 'neutral', prominence: 'secondary', slot: '1' },
                hangup: { visible: true, icon: 'hangup', label: '结束通话', variant: 'danger', prominence: 'primary', slot: '2' }
            };
        }
        if (mode === CALL_MODES.outgoing || mode === CALL_MODES.connecting) {
            return {
                layout: 'single',
                reject: { visible: false },
                accept: { visible: false },
                mute: { visible: false },
                hangup: { visible: true, icon: 'cancel', label: '取消呼叫', variant: 'danger', prominence: 'primary', slot: '2' }
            };
        }
        return {
            layout: 'hidden',
            reject: { visible: false },
            accept: { visible: false },
            mute: { visible: false },
            hangup: { visible: false }
        };
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

            init(options) {
                this.options = options || {};
                return this;
            },

            isSupported() {
                return !!(global.navigator && global.navigator.mediaDevices && typeof global.navigator.mediaDevices.getUserMedia === 'function' && global.RTCPeerConnection);
            },

            async startLocal(kind) {
                if (!this.isSupported()) throw new Error('当前浏览器不支持实时语音通话');
                if (this.localStream) return this.localStream;
                const constraints = {
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    },
                    video: String(kind || 'audio').toLowerCase() === 'video'
                };
                this.localStream = await global.navigator.mediaDevices.getUserMedia(constraints);
                this.emitLocalStream();
                return this.localStream;
            },

            async createPeer(role, kind) {
                this.role = String(role || '').toLowerCase();
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
                const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: String(kind || 'audio').toLowerCase() === 'video' });
                await pc.setLocalDescription(offer);
                this.emitSignal('offer', { sdp: pc.localDescription });
            },

            async acceptOffer(sdp, kind) {
                const pc = await this.createPeer('callee', kind);
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
        currentKind: 'audio',
        role: '',
        muted: false,
        offerSent: false,
        timers: { autoEnd: 0, launch: 0, duration: 0 },
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
                '      <button class="ak-im-call-overlay-action ak-im-call-overlay-accept" type="button"></button>',
                '    </div>',
                '  </div>',
                '  <button class="ak-im-call-overlay-restore" type="button" aria-label="恢复通话">',
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

        ensureBuiltInModules() {
            const modules = ensureModuleRegistry();
            if (!modules.callWebRTC) modules.callWebRTC = createBuiltInWebRTCModule();
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
            if (document.getElementById(STYLE_ID)) return;
            const styleEl = document.createElement('style');
            styleEl.id = STYLE_ID;
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
                '.ak-im-call-overlay-local,.ak-im-call-overlay-remote{display:none}',
                '.ak-im-call-overlay-audio{display:none}',
                '.ak-im-call-overlay-state{padding:0 20px 14px;min-height:38px;font-size:12px;line-height:1.5;text-align:center;color:rgba(226,232,240,.84)}',
                '.ak-im-call-overlay-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:end;justify-items:center;gap:12px;padding:18px 22px calc(22px + env(safe-area-inset-bottom,0px));border-top:1px solid rgba(255,255,255,.06);background:rgba(2,9,18,.94)}',
                '.ak-im-call-overlay-actions[data-layout="hidden"]{min-height:0}',
                '.ak-im-call-overlay-actions[data-layout="single"]{grid-template-columns:minmax(0,1fr);align-items:start;justify-items:center;gap:0;padding-top:22px;padding-bottom:calc(24px + env(safe-area-inset-bottom,0px))}',
                '.ak-im-call-overlay-action{all:unset;box-sizing:border-box;width:100%;max-width:112px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:10px;padding:0;background:none !important;border:none !important;border-radius:0 !important;box-shadow:none !important;color:#e2e8f0;cursor:pointer;font:inherit;-webkit-appearance:none;appearance:none;-webkit-tap-highlight-color:transparent}',
                '.ak-im-call-overlay-action[data-slot="1"]{grid-column:1}',
                '.ak-im-call-overlay-action[data-slot="2"]{grid-column:2}',
                '.ak-im-call-overlay-action[data-slot="3"]{grid-column:3}',
                '.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-slot]{grid-column:1}',
                '.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action{width:auto;max-width:none;min-width:116px;min-height:118px;gap:12px;padding-top:2px;padding-bottom:2px}',
                '.ak-im-call-overlay-action:focus-visible{outline:2px solid rgba(148,163,184,.7);outline-offset:4px;border-radius:18px}',
                '.ak-im-call-overlay-action-disc{flex:0 0 auto;width:62px;height:62px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:rgba(148,163,184,.16);box-shadow:0 14px 30px rgba(0,0,0,.24);transition:transform .18s ease,background .18s ease,color .18s ease}',
                '.ak-im-call-overlay-action:hover .ak-im-call-overlay-action-disc{transform:translateY(-1px)}',
                '.ak-im-call-overlay-action-label{display:block;flex:0 0 auto;font-size:13px;font-weight:700;line-height:1.3;color:inherit;text-align:center}',
                '.ak-im-call-overlay-action[data-variant="danger"] .ak-im-call-overlay-action-disc{background:#ef4444;color:#fff}',
                '.ak-im-call-overlay-action[data-variant="success"] .ak-im-call-overlay-action-disc{background:#10b981;color:#fff}',
                '.ak-im-call-overlay-action[data-variant="neutral"] .ak-im-call-overlay-action-disc{background:rgba(148,163,184,.16);color:#e2e8f0}',
                '.ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-disc{width:74px;height:74px;box-shadow:0 18px 34px rgba(239,68,68,.26)}',
                '.ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-label{font-size:14px}',
                '.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-disc{width:82px;height:82px;box-shadow:0 20px 38px rgba(239,68,68,.3)}',
                '.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-label{min-height:18px;margin-top:2px;font-size:15px;line-height:1.2;white-space:nowrap}',
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
                '@keyframes akImCallOverlayPulse{0%{transform:translate(-50%,-50%) scale(.82);opacity:.18}50%{transform:translate(-50%,-50%) scale(1.04);opacity:.5}100%{transform:translate(-50%,-50%) scale(1.18);opacity:0}}',
                '@keyframes akImCallOverlayIconFloat{0%{transform:translateY(0)}50%{transform:translateY(-3px)}100%{transform:translateY(0)}}',
                '@media (max-width:768px){.ak-im-call-overlay{padding:0}.ak-im-call-overlay-card{width:100vw;min-height:100vh;max-height:100vh;border-radius:0;box-shadow:none}.ak-im-call-overlay-stage{padding:28px 18px 18px}.ak-im-call-overlay-actions{gap:10px;padding-left:16px;padding-right:16px}.ak-im-call-overlay-actions[data-layout="single"]{padding-top:24px;padding-bottom:calc(28px + env(safe-area-inset-bottom,0px))}.ak-im-call-overlay-title{font-size:17px}.ak-im-call-overlay-avatar{width:40px;height:40px;font-size:16px}.ak-im-call-overlay-placeholder-icon{width:104px;height:104px}.ak-im-call-overlay-placeholder-text{font-size:21px}.ak-im-call-overlay-detail{width:100%}.ak-im-call-overlay-action{max-width:96px}.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action{min-width:108px;min-height:112px;max-width:none;gap:13px}.ak-im-call-overlay-action-disc{width:58px;height:58px}.ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-disc{width:70px;height:70px}.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-disc{width:78px;height:78px}.ak-im-call-overlay-actions[data-layout="single"] .ak-im-call-overlay-action[data-prominence="primary"] .ak-im-call-overlay-action-label{font-size:14px}.ak-im-call-overlay-restore{top:calc(env(safe-area-inset-top,0px) + 12px);right:12px}}'
            ].join('');
            (document.head || document.documentElement).appendChild(styleEl);
        },

        ensureShell() {
            const mountRoot = document.body || document.documentElement || null;
            if (!mountRoot) return null;
            let panel = document.querySelector(PANEL_SELECTOR);
            const needsUpgrade = !panel || !panel.querySelector('.ak-im-call-overlay-action') || !panel.querySelector('.ak-im-call-overlay-detail');
            if (!panel) {
                const wrapper = document.createElement('div');
                wrapper.innerHTML = '<div class="ak-im-call-overlay" aria-hidden="true">' + this.getShellMarkup() + '</div>';
                panel = wrapper.firstElementChild;
                mountRoot.appendChild(panel);
            } else if (needsUpgrade) {
                const hidden = panel.getAttribute('aria-hidden');
                const mode = panel.dataset.mode || '';
                panel.innerHTML = this.getShellMarkup();
                if (hidden != null) panel.setAttribute('aria-hidden', hidden);
                if (mode) panel.dataset.mode = mode;
                this.bound = false;
            }
            if (panel && panel.hasAttribute('data-ak-call-launch-fallback')) {
                panel.removeAttribute('data-ak-call-launch-fallback');
            }
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
            this.refs.restoreIcon = panel.querySelector('.ak-im-call-overlay-restore-icon');
            this.refs.restoreLabel = panel.querySelector('.ak-im-call-overlay-restore-label');
            this.refs.mute = panel.querySelector('.ak-im-call-overlay-mute');
            this.refs.localAudio = panel.querySelector('.ak-im-call-overlay-audio');
            this.refs.placeholder = panel.querySelector('.ak-im-call-overlay-placeholder');
            this.refs.placeholderText = panel.querySelector('.ak-im-call-overlay-placeholder-text');
            this.refs.pulse = panel.querySelector('.ak-im-call-overlay-pulse');
            this.refs.avatar = panel.querySelector('.ak-im-call-overlay-avatar');
            this.refs.placeholderIcon = panel.querySelector('.ak-im-call-overlay-placeholder-icon');
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
        },

        clearTimer(name) {
            if (!this.timers || !this.timers[name]) return;
            if (name === 'duration') global.clearInterval(this.timers[name]);
            else global.clearTimeout(this.timers[name]);
            this.timers[name] = 0;
        },

        clearAllTimers() {
            this.clearTimer('autoEnd');
            this.clearTimer('launch');
            this.clearTimer('duration');
        },

        clearResultState() {
            this.lastFailReason = '';
            this.lastEndReason = '';
            this.lastEndActor = '';
            this.lastEndActorRole = '';
            this.lastDurationText = '';
        },

        bumpFlowVersion() {
            this.flowVersion += 1;
            return this.flowVersion;
        },

        isFlowCurrent(version) {
            return Number(version) > 0 && this.flowVersion === Number(version);
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
                wasEverConnected: this.wasEverConnected(),
                connectionPhase: this.connectionPhase,
                durationText: trim(this.liveDurationText || this.lastDurationText),
                localTermination: this.localTermination
            };
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
                ref.removeAttribute('aria-label');
                ref.removeAttribute('title');
                return;
            }
            ref.innerHTML = buildActionMarkup(config.icon, config.label);
            ref.dataset.variant = config.variant || 'neutral';
            ref.dataset.prominence = config.prominence || 'secondary';
            ref.dataset.slot = config.slot || '';
            ref.setAttribute('aria-label', config.label || '');
            ref.title = config.label || '';
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
            const nextKind = trim(payload.call_kind || payload.kind);
            if (nextKind) this.currentKind = nextKind;
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
            const view = buildCallViewModel(this.mode, this.lastFailReason, !!this.currentCallId, this.currentPeerName, this.muted, this.buildRenderMeta());
            const actionLayout = buildCallActionLayout(this.mode, this.muted);
            const headerStatus = buildHeaderStatusText(view);
            refs.panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
            refs.panel.dataset.mode = this.mode;
            refs.panel.dataset.minimized = showMinimizedShell ? '1' : '0';
            refs.title.textContent = this.currentPeerName || '语音通话';
            refs.subtitle.textContent = headerStatus;
            refs.subtitle.style.display = headerStatus ? 'block' : 'none';
            refs.state.textContent = view.footer || '';
            refs.state.style.display = view.footer ? 'block' : 'none';
            if (refs.minimize) refs.minimize.style.display = visible && !this.minimized && this.canMinimize() ? 'flex' : 'none';
            if (refs.restoreLabel) refs.restoreLabel.textContent = (this.currentPeerName || '返回通话').trim() || '返回通话';
            refs.placeholder.style.display = 'flex';
            if (refs.placeholderText) refs.placeholderText.textContent = view.headline || '';
            if (refs.detailTitle) refs.detailTitle.textContent = view.detailTitle || '';
            if (refs.detailBody) refs.detailBody.textContent = view.detailBody || '';
            if (refs.avatar) {
                refs.avatar.style.transform = view.pending ? 'scale(1.04)' : 'scale(1)';
                refs.avatar.textContent = (this.currentPeerName || '联').trim().slice(0, 1).toUpperCase();
            }
            if (refs.placeholderIcon) {
                refs.placeholderIcon.innerHTML = getIconMarkup(view.icon);
                refs.placeholderIcon.dataset.icon = view.icon || 'phone';
                refs.placeholderIcon.style.animation = view.pending ? 'akImCallOverlayIconFloat 2.2s ease-in-out infinite' : 'none';
            }
            if (refs.pulse) {
                refs.pulse.style.display = view.pending ? 'block' : 'none';
                refs.pulse.style.animation = view.pending ? 'akImCallOverlayPulse 1.8s ease-in-out infinite' : 'none';
            }
            if (refs.actions) refs.actions.dataset.layout = actionLayout.layout || 'hidden';
            this.renderActionButton(refs.reject, actionLayout.reject);
            this.renderActionButton(refs.accept, actionLayout.accept);
            this.renderActionButton(refs.mute, actionLayout.mute);
            this.renderActionButton(refs.hangup, actionLayout.hangup);
        },

        openOutgoing(payload) {
            payload = payload || {};
            const flowVersion = this.bumpFlowVersion();
            this.ensureStyle();
            this.ensureShell();
            this.clearAllTimers();
            this.cleanupMedia();
            this.clearLocalTermination();
            this.clearResultState();
            this.clearLiveSessionState();
            this.minimized = false;
            this.role = 'caller';
            this.muted = false;
            this.offerSent = false;
            this.everConnectedAt = 0;
            this.openedAt = Date.now();
            this.currentCallId = '';
            this.currentConversationId = 0;
            this.currentPeerName = '';
            this.currentPeerUsername = '';
            this.currentKind = trim(payload.kind || payload.call_kind || this.currentKind || 'audio') || 'audio';
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
                self.fail('unsupported', error && error.message ? error.message : '通话模块不可用');
            });
        },

        openIncoming(payload) {
            payload = payload || {};
            this.bumpFlowVersion();
            this.ensureStyle();
            this.ensureShell();
            this.clearAllTimers();
            this.cleanupMedia();
            this.clearLocalTermination();
            this.clearResultState();
            this.clearLiveSessionState();
            this.minimized = false;
            this.role = 'callee';
            this.muted = false;
            this.offerSent = false;
            this.everConnectedAt = 0;
            this.openedAt = Date.now();
            this.currentCallId = '';
            this.currentConversationId = 0;
            this.currentPeerName = '';
            this.currentPeerUsername = '';
            this.currentKind = trim(payload.call_kind || payload.kind || this.currentKind || 'audio') || 'audio';
            this.setState(CALL_MODES.incoming, payload);
            this.ensureCallLifecycleModules();
            this.recordCallSession('open_incoming', {
                openedAt: this.openedAt,
                mode: CALL_MODES.incoming
            });
        },

        async accept() {
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
                await this.webRTC.startLocal('audio');
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
            if (this.currentCallId && this.signaling) {
                try {
                    this.signaling.send('im.call.reject', { call_id: this.currentCallId });
                } catch (e) {}
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
            this.cleanupMedia();
            this.mode = CALL_MODES.idle;
            this.minimized = false;
            this.currentCallId = '';
            this.currentConversationId = 0;
            this.currentPeerName = '';
            this.currentPeerUsername = '';
            this.currentKind = 'audio';
            this.role = '';
            this.muted = false;
            this.offerSent = false;
            this.everConnectedAt = 0;
            if (!options.preserveLocalTermination) this.openedAt = 0;
            this.clearResultState();
            this.clearLiveSessionState();
            if (!options.preserveLocalTermination) this.clearLocalTermination();
            this.render();
        },

        end(reason, payload, options) {
            payload = payload || {};
            options = options || {};
            this.captureDurationSnapshot();
            this.clearAllTimers();
            this.cleanupMedia();
            this.minimized = false;
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

        fail(reason, message, payload) {
            payload = Object.assign({}, payload || {});
            const normalizedReason = normalizeReasonCode(reason || payload.reason || 'socket_error');
            this.lastFailReason = normalizedReason;
            payload.reason = normalizedReason;
            if (trim(message)) payload.message = trim(message);
            this.end('failed', payload, { reason: normalizedReason });
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
                await this.webRTC.startLocal('audio');
                if (!this.isFlowCurrent(flowVersion) || this.mode === CALL_MODES.idle || !this.currentCallId) {
                    this.offerSent = false;
                    return;
                }
                this.setConnectionPhase('negotiating');
                this.recordCallSession('caller_negotiating', {
                    mode: CALL_MODES.connecting,
                    connectionPhase: 'negotiating'
                });
                await this.webRTC.createOffer('audio');
            } catch (error) {
                this.offerSent = false;
                this.fail('media_denied', error && error.message ? error.message : '');
            }
        },

        async handleSignalEvent(type, payload) {
            payload = payload || {};
            this.pruneLocalTermination();
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
                    await this.webRTC.acceptOffer(payload.sdp, 'audio');
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
                this.fail(normalizeReasonCode(payload.reason) || (trim(payload.message) === 'busy' ? 'busy' : 'socket_error'), trim(payload.message), payload);
                return;
            }
            if (type === 'im.call.ended') {
                if (this.shouldSuppressTerminationEcho(type, payload)) return;
                const endReason = normalizeReasonCode(payload.reason || payload.end_reason || 'hangup');
                this.end('ended', Object.assign({}, payload, { reason: endReason, end_reason: endReason }), { endReason: endReason });
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
                conversation_id: this.currentConversationId
            }, payload || {}));
        },

        attachLocalStream(stream) {
            const audio = this.refs.localAudio;
            if (!audio || !stream) return;
            try {
                audio.srcObject = stream;
                audio.muted = true;
            } catch (e) {}
        },

        attachRemoteStream(stream) {
            const audio = this.refs.localAudio;
            if (!audio || !stream) return;
            try {
                audio.srcObject = stream;
                audio.muted = false;
                const playResult = audio.play();
                if (playResult && typeof playResult.catch === 'function') playResult.catch(function() {});
            } catch (e) {}
            this.markActive();
            this.setState(CALL_MODES.active, {});
        },

        handlePeerState(state) {
            const normalizedState = trim(state).toLowerCase();
            if (normalizedState === 'connected') {
                this.markActive();
                this.setState(CALL_MODES.active, {});
            }
            if (normalizedState === 'failed' || normalizedState === 'disconnected') {
                this.fail('peer_connection_failed');
            }
        },

        toggleMute() {
            this.muted = !this.muted;
            if (this.webRTC && typeof this.webRTC.setMuted === 'function') this.webRTC.setMuted(this.muted);
            if (this.signaling && this.currentCallId) this.signaling.send('im.call.mute', { call_id: this.currentCallId, muted: this.muted });
            this.render();
        },

        cleanupMedia() {
            if (this.webRTC && typeof this.webRTC.close === 'function') this.webRTC.close();
            if (this.refs.localAudio) {
                try { this.refs.localAudio.srcObject = null; } catch (e) {}
            }
        },

        destroy() {
            this.bumpFlowVersion();
            this.clearAllTimers();
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
