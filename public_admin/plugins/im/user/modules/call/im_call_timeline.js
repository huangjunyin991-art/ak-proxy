(function(global) {
    'use strict';

    const SENT_KEY_TTL_MS = 5 * 60 * 1000;

    function trim(value) {
        return String(value || '').trim();
    }

    function toNumber(value) {
        const nextValue = Number(value || 0);
        return Number.isFinite(nextValue) ? nextValue : 0;
    }

    function normalizeKind(value) {
        return trim(value).toLowerCase() === 'video' ? 'video' : 'audio';
    }

    function normalizeRole(value) {
        const normalized = trim(value).toLowerCase();
        if (normalized === 'callee') return 'callee';
        return normalized === 'caller' ? 'caller' : '';
    }

    function normalizeDurationText(value) {
        const normalized = trim(value);
        if (!normalized) return '';
        const segments = normalized.split(':').map(function(item) {
            return String(Math.max(0, Number(item || 0) || 0)).padStart(2, '0');
        });
        if (segments.length === 2) return segments.join(':');
        if (segments.length === 3) return segments.join(':');
        return normalized;
    }

    function formatDuration(totalSeconds) {
        const safeSeconds = Math.max(0, Math.floor(toNumber(totalSeconds)));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const seconds = safeSeconds % 60;
        const pad = function(value) {
            return String(Math.max(0, value || 0)).padStart(2, '0');
        };
        if (hours > 0) return [hours, minutes, seconds].map(pad).join(':');
        return [minutes, seconds].map(pad).join(':');
    }

    function buildCallLabel(kind) {
        return normalizeKind(kind) === 'video' ? '视频通话' : '语音通话';
    }

    function buildPreviewText(eventName, durationText) {
        if (eventName === 'completed') return '通话时长 ' + normalizeDurationText(durationText || '00:00');
        if (eventName === 'rejected') return '已拒接';
        return '已取消';
    }

    const callTimelineModule = {
        ctx: null,
        sentKeys: {},

        init(ctx) {
            this.ctx = ctx || null;
            if (!this.sentKeys || typeof this.sentKeys !== 'object') {
                this.sentKeys = {};
            }
            return this;
        },

        now() {
            if (this.ctx && typeof this.ctx.getNow === 'function') {
                try {
                    return Math.max(0, toNumber(this.ctx.getNow()));
                } catch (e) {}
            }
            return Date.now();
        },

        pruneSentKeys() {
            const now = this.now();
            const sentKeys = this.sentKeys && typeof this.sentKeys === 'object' ? this.sentKeys : {};
            Object.keys(sentKeys).forEach(function(key) {
                if ((now - toNumber(sentKeys[key])) > SENT_KEY_TTL_MS) {
                    delete sentKeys[key];
                }
            });
            this.sentKeys = sentKeys;
        },

        hasSentKey(key) {
            const normalizedKey = trim(key);
            if (!normalizedKey) return false;
            this.pruneSentKeys();
            return Object.prototype.hasOwnProperty.call(this.sentKeys, normalizedKey);
        },

        markSentKey(key) {
            const normalizedKey = trim(key);
            if (!normalizedKey) return;
            this.pruneSentKeys();
            this.sentKeys[normalizedKey] = this.now();
        },

        clearSentKey(key) {
            const normalizedKey = trim(key);
            if (!normalizedKey || !this.sentKeys || typeof this.sentKeys !== 'object') return;
            delete this.sentKeys[normalizedKey];
        },

        resolveOutcome(trigger, snapshot) {
            const normalizedTrigger = trim(trigger).toLowerCase();
            const nextSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
            const role = normalizeRole(nextSnapshot.role);
            const failReason = trim(nextSnapshot.failReason || nextSnapshot.fail_reason).toLowerCase();
            const wasEverConnected = !!nextSnapshot.wasEverConnected;
            const activeAt = Math.max(0, toNumber(nextSnapshot.activeAt || nextSnapshot.active_at));
            const durationSeconds = Math.max(0, Math.floor(toNumber(nextSnapshot.durationSeconds || nextSnapshot.duration_seconds)));
            const durationText = normalizeDurationText(nextSnapshot.durationText || nextSnapshot.duration_text || formatDuration(durationSeconds));
            const hasEstablishedCall = activeAt > 0 || durationSeconds > 0 || trim(nextSnapshot.mode).toLowerCase() === 'active';
            if (normalizedTrigger === 'local_reject' && role === 'callee') {
                return {
                    event: 'rejected',
                    by: 'callee',
                    connected: false,
                    durationSeconds: 0,
                    durationText: ''
                };
            }
            if (normalizedTrigger === 'local_cancel' && role === 'caller' && !hasEstablishedCall) {
                return {
                    event: 'cancelled',
                    by: 'caller',
                    connected: false,
                    durationSeconds: 0,
                    durationText: ''
                };
            }
            if (normalizedTrigger === 'local_hangup' && (hasEstablishedCall || wasEverConnected)) {
                return {
                    event: 'completed',
                    by: role || 'caller',
                    connected: !!hasEstablishedCall,
                    durationSeconds: durationSeconds,
                    durationText: durationText || '00:00'
                };
            }
            if (normalizedTrigger === 'failed' && role === 'caller' && (failReason === 'timeout' || failReason === 'socket_timeout')) {
                return {
                    event: 'cancelled',
                    by: 'caller',
                    connected: false,
                    durationSeconds: 0,
                    durationText: ''
                };
            }
            return null;
        },

        buildDedupKey(outcome, snapshot) {
            const nextOutcome = outcome && typeof outcome === 'object' ? outcome : {};
            const nextSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
            const callId = trim(nextSnapshot.callId || nextSnapshot.call_id);
            const conversationId = Math.max(0, toNumber(nextSnapshot.conversationId || nextSnapshot.conversation_id));
            const peerIdentity = trim(nextSnapshot.peerUsername || nextSnapshot.peer_username || nextSnapshot.peerName || nextSnapshot.peer_name);
            const openedAt = Math.max(0, toNumber(nextSnapshot.openedAt || nextSnapshot.opened_at || nextSnapshot.updatedAt || nextSnapshot.updated_at));
            const durationKey = nextOutcome.event === 'completed'
                ? normalizeDurationText(nextOutcome.durationText || '')
                : nextOutcome.event;
            if (callId) return ['call', callId, nextOutcome.event, durationKey].join(':');
            return [
                'conversation',
                String(conversationId || 0),
                peerIdentity || 'peer',
                nextOutcome.event,
                nextOutcome.by || '',
                String(openedAt || 0)
            ].join(':');
        },

        buildMessagePayload(outcome, snapshot) {
            const nextOutcome = outcome && typeof outcome === 'object' ? outcome : {};
            const nextSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
            const conversationId = Math.max(0, toNumber(nextSnapshot.conversationId || nextSnapshot.conversation_id));
            const previewText = buildPreviewText(nextOutcome.event, nextOutcome.durationText);
            const contentPayload = {
                event: nextOutcome.event,
                call_kind: normalizeKind(nextSnapshot.kind || nextSnapshot.call_kind),
                by: nextOutcome.by || normalizeRole(nextSnapshot.role),
                connected: !!nextOutcome.connected,
                call_id: trim(nextSnapshot.callId || nextSnapshot.call_id),
                conversation_id: conversationId,
                peer_username: trim(nextSnapshot.peerUsername || nextSnapshot.peer_username),
                peer_name: trim(nextSnapshot.peerName || nextSnapshot.peer_name),
                duration_seconds: Math.max(0, Math.floor(toNumber(nextOutcome.durationSeconds || nextSnapshot.durationSeconds || nextSnapshot.duration_seconds))),
                duration_text: nextOutcome.durationText || normalizeDurationText(nextSnapshot.durationText || nextSnapshot.duration_text || ''),
                preview_text: previewText,
                label: buildCallLabel(nextSnapshot.kind || nextSnapshot.call_kind)
            };
            return {
                conversation_id: conversationId,
                message_type: 'call_event',
                content: JSON.stringify(contentPayload),
                content_preview: previewText
            };
        },

        emitOutcome(outcome, snapshot) {
            const sendCallResultPayload = this.ctx && typeof this.ctx.sendCallResultPayload === 'function'
                ? this.ctx.sendCallResultPayload
                : null;
            const sendMessagePayload = this.ctx && typeof this.ctx.sendMessagePayload === 'function'
                ? this.ctx.sendMessagePayload
                : null;
            const payload = this.buildMessagePayload(outcome, snapshot);
            if (Math.max(0, toNumber(payload.conversation_id)) <= 0) return Promise.resolve(null);
            if (sendCallResultPayload) return Promise.resolve(sendCallResultPayload(payload));
            if (!sendMessagePayload) return Promise.resolve(null);
            return Promise.resolve(sendMessagePayload(payload, {
                resetComposer: false,
                failSilently: true
            }));
        },

        handleTerminalSnapshot(trigger, snapshot) {
            const outcome = this.resolveOutcome(trigger, snapshot);
            if (!outcome) return Promise.resolve(null);
            const dedupKey = this.buildDedupKey(outcome, snapshot);
            if (dedupKey && this.hasSentKey(dedupKey)) return Promise.resolve(null);
            if (dedupKey) this.markSentKey(dedupKey);
            const self = this;
            return this.emitOutcome(outcome, snapshot).catch(function(error) {
                if (dedupKey) self.clearSentKey(dedupKey);
                return null;
            });
        },

        destroy() {
            this.ctx = null;
            this.sentKeys = {};
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.callTimeline = callTimelineModule;
})(window);
