(function(global) {
    'use strict';

    const MAX_HISTORY_SIZE = 24;

    function trim(value) {
        return String(value || '').trim();
    }

    function toNumber(value) {
        const nextValue = Number(value || 0);
        return Number.isFinite(nextValue) ? nextValue : 0;
    }

    function cloneLocalTermination(source) {
        const nextSource = source && typeof source === 'object' ? source : {};
        return {
            action: trim(nextSource.action).toLowerCase(),
            role: trim(nextSource.role).toLowerCase(),
            callId: trim(nextSource.callId || nextSource.call_id),
            at: toNumber(nextSource.at),
            wasEverConnected: !!nextSource.wasEverConnected
        };
    }

    function createEmptyState() {
        return {
            callId: '',
            conversationId: 0,
            peerName: '',
            peerUsername: '',
            kind: 'audio',
            mode: 'idle',
            role: '',
            connectionPhase: '',
            wasEverConnected: false,
            connectedAt: 0,
            activeAt: 0,
            durationText: '',
            durationSeconds: 0,
            failReason: '',
            endReason: '',
            endActor: '',
            endActorRole: '',
            localTermination: cloneLocalTermination(null),
            openedAt: 0,
            endedAt: 0,
            updatedAt: 0,
            lastEvent: '',
            history: []
        };
    }

    function cloneState(state) {
        const nextState = state && typeof state === 'object' ? state : createEmptyState();
        return Object.assign(createEmptyState(), nextState, {
            localTermination: cloneLocalTermination(nextState.localTermination),
            history: Array.isArray(nextState.history) ? nextState.history.slice() : []
        });
    }

    const callSessionModule = {
        ctx: null,
        state: createEmptyState(),

        init(ctx) {
            this.ctx = ctx || null;
            if (!this.state || typeof this.state !== 'object') {
                this.state = createEmptyState();
            }
            return this;
        },

        now() {
            if (this.ctx && typeof this.ctx.getNow === 'function') {
                try {
                    return toNumber(this.ctx.getNow());
                } catch (e) {}
            }
            return Date.now();
        },

        normalizeSnapshot(snapshot) {
            const nextSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
            const normalized = {};
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'callId') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'call_id')) {
                normalized.callId = trim(nextSnapshot.callId || nextSnapshot.call_id);
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'conversationId') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'conversation_id')) {
                normalized.conversationId = Math.max(0, toNumber(nextSnapshot.conversationId || nextSnapshot.conversation_id));
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'peerName') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'peer_name')) {
                normalized.peerName = trim(nextSnapshot.peerName || nextSnapshot.peer_name);
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'peerUsername') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'peer_username')) {
                normalized.peerUsername = trim(nextSnapshot.peerUsername || nextSnapshot.peer_username);
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'kind') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'call_kind')) {
                normalized.kind = trim(nextSnapshot.kind || nextSnapshot.call_kind || 'audio').toLowerCase() || 'audio';
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'mode')) {
                normalized.mode = trim(nextSnapshot.mode).toLowerCase();
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'role')) {
                normalized.role = trim(nextSnapshot.role).toLowerCase();
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'connectionPhase') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'connection_phase')) {
                normalized.connectionPhase = trim(nextSnapshot.connectionPhase || nextSnapshot.connection_phase).toLowerCase();
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'wasEverConnected')) {
                normalized.wasEverConnected = !!nextSnapshot.wasEverConnected;
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'connectedAt') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'connected_at')) {
                normalized.connectedAt = Math.max(0, toNumber(nextSnapshot.connectedAt || nextSnapshot.connected_at));
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'activeAt') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'active_at')) {
                normalized.activeAt = Math.max(0, toNumber(nextSnapshot.activeAt || nextSnapshot.active_at));
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'durationText') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'duration_text')) {
                normalized.durationText = trim(nextSnapshot.durationText || nextSnapshot.duration_text);
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'durationSeconds') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'duration_seconds')) {
                normalized.durationSeconds = Math.max(0, Math.floor(toNumber(nextSnapshot.durationSeconds || nextSnapshot.duration_seconds)));
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'failReason') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'fail_reason')) {
                normalized.failReason = trim(nextSnapshot.failReason || nextSnapshot.fail_reason).toLowerCase();
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'endReason') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'end_reason')) {
                normalized.endReason = trim(nextSnapshot.endReason || nextSnapshot.end_reason).toLowerCase();
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'endActor') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'actor')) {
                normalized.endActor = trim(nextSnapshot.endActor || nextSnapshot.actor);
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'endActorRole') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'actor_role')) {
                normalized.endActorRole = trim(nextSnapshot.endActorRole || nextSnapshot.actor_role).toLowerCase();
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'localTermination') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'local_termination')) {
                normalized.localTermination = cloneLocalTermination(nextSnapshot.localTermination || nextSnapshot.local_termination);
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'openedAt') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'opened_at')) {
                normalized.openedAt = Math.max(0, toNumber(nextSnapshot.openedAt || nextSnapshot.opened_at));
            }
            if (Object.prototype.hasOwnProperty.call(nextSnapshot, 'endedAt') || Object.prototype.hasOwnProperty.call(nextSnapshot, 'ended_at')) {
                normalized.endedAt = Math.max(0, toNumber(nextSnapshot.endedAt || nextSnapshot.ended_at));
            }
            return normalized;
        },

        record(eventName, snapshot) {
            const normalizedEventName = trim(eventName).toLowerCase();
            if (!normalizedEventName) return this.snapshot();
            const currentState = cloneState(this.state);
            const normalizedSnapshot = this.normalizeSnapshot(snapshot);
            const now = this.now();
            const nextState = Object.assign(createEmptyState(), currentState, normalizedSnapshot);
            nextState.localTermination = Object.prototype.hasOwnProperty.call(normalizedSnapshot, 'localTermination')
                ? cloneLocalTermination(normalizedSnapshot.localTermination)
                : cloneLocalTermination(currentState.localTermination);
            nextState.lastEvent = normalizedEventName;
            nextState.updatedAt = now;
            if (!nextState.openedAt) nextState.openedAt = now;
            if (nextState.wasEverConnected && !nextState.connectedAt) nextState.connectedAt = now;
            if (nextState.mode === 'active' && !nextState.activeAt) nextState.activeAt = nextState.connectedAt || now;
            if ((nextState.mode === 'ended' || nextState.mode === 'failed') && !nextState.endedAt) nextState.endedAt = now;
            const nextHistory = Array.isArray(currentState.history) ? currentState.history.slice() : [];
            nextHistory.push({
                event: normalizedEventName,
                at: now,
                mode: nextState.mode,
                reason: nextState.failReason || nextState.endReason || ''
            });
            if (nextHistory.length > MAX_HISTORY_SIZE) {
                nextHistory.splice(0, nextHistory.length - MAX_HISTORY_SIZE);
            }
            nextState.history = nextHistory;
            this.state = nextState;
            return this.snapshot();
        },

        snapshot() {
            return cloneState(this.state);
        },

        destroy() {
            this.ctx = null;
            this.state = createEmptyState();
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.callSession = callSessionModule;
})(window);
