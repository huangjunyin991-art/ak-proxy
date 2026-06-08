(function(global) {
    'use strict';

    const CHECK_COOLDOWN_MS = 2500;
    const RECENT_TERMINAL_SKIP_MS = 10000;
    const RECOVERABLE_STATUSES = {
        dialing: true,
        ringing: true
    };

    function trim(value) {
        return String(value || '').trim();
    }

    function toNumber(value) {
        const nextValue = Number(value || 0);
        return Number.isFinite(nextValue) ? nextValue : 0;
    }

    function normalizeStatus(value) {
        return trim(value).toLowerCase();
    }

    function normalizeRole(value) {
        const normalized = trim(value).toLowerCase();
        if (normalized === 'caller' || normalized === 'callee') return normalized;
        return '';
    }

    const callRecoveryModule = {
        ctx: null,
        inFlightByConversation: {},
        lastCheckByConversation: {},

        init(ctx) {
            this.ctx = ctx || null;
            if (!this.inFlightByConversation || typeof this.inFlightByConversation !== 'object') {
                this.inFlightByConversation = {};
            }
            if (!this.lastCheckByConversation || typeof this.lastCheckByConversation !== 'object') {
                this.lastCheckByConversation = {};
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

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getActiveSession(conversationId) {
            if (this.ctx && typeof this.ctx.getActiveSession === 'function') {
                try {
                    const activeSession = this.ctx.getActiveSession();
                    if (activeSession && Number(activeSession.conversation_id || 0) === Number(conversationId || 0)) {
                        return activeSession;
                    }
                } catch (e) {}
            }
            return null;
        },

        isDirectConversation(conversationId) {
            const session = this.getActiveSession(conversationId);
            if (!session) return false;
            if (this.ctx && typeof this.ctx.isGroupSession === 'function') {
                try {
                    return !this.ctx.isGroupSession(session);
                } catch (e) {}
            }
            return trim(session.conversation_type).toLowerCase() !== 'group';
        },

        shouldCheck(conversationId, options) {
            const state = this.getState();
            if (!state || !state.allowed || state.view !== 'chat') return false;
            const targetConversationId = Math.max(0, toNumber(conversationId || state.activeConversationId));
            if (!targetConversationId) return false;
            if (Number(state.activeConversationId || 0) !== targetConversationId) return false;
            if (!this.isDirectConversation(targetConversationId)) return false;
            if (this.inFlightByConversation[String(targetConversationId)]) return false;
            const force = !!(options && options.force);
            if (!force) {
                const checkedAt = Math.max(0, toNumber(this.lastCheckByConversation[String(targetConversationId)]));
                if (checkedAt && (this.now() - checkedAt) < CHECK_COOLDOWN_MS) return false;
            }
            return true;
        },

        requestCallState(conversationId) {
            if (!this.ctx || typeof this.ctx.request !== 'function' || !this.ctx.httpRoot) {
                return Promise.resolve(null);
            }
            const url = this.ctx.httpRoot + '/call/state?conversation_id=' + encodeURIComponent(String(conversationId));
            return this.ctx.request(url).catch(function() {
                return null;
            });
        },

        getCallManageModule() {
            if (this.ctx && typeof this.ctx.getCallManage === 'function') {
                try {
                    return this.ctx.getCallManage() || null;
                } catch (e) {}
            }
            return null;
        },

        ensureCallManageModule() {
            const existing = this.getCallManageModule();
            if (existing) return Promise.resolve(existing);
            if (!this.ctx || typeof this.ctx.ensureCallManageModule !== 'function') {
                return Promise.resolve(null);
            }
            const self = this;
            return Promise.resolve(this.ctx.ensureCallManageModule()).then(function() {
                return self.getCallManageModule();
            }).catch(function() {
                return self.getCallManageModule();
            });
        },

        callManageHasActiveCall(callManage, payload) {
            if (!callManage || typeof callManage !== 'object') return false;
            const mode = trim(callManage.mode).toLowerCase();
            if (!mode || mode === 'idle') return false;
            const payloadCallId = trim(payload && (payload.call_id || payload.callId));
            const currentCallId = trim(callManage.currentCallId);
            if (payloadCallId && currentCallId && payloadCallId === currentCallId) return true;
            if ((mode === 'ended' || mode === 'failed') && currentCallId && payloadCallId && currentCallId === payloadCallId) return true;
            const localTermination = callManage.localTermination && typeof callManage.localTermination === 'object'
                ? callManage.localTermination
                : null;
            const localTerminationAt = Math.max(0, toNumber(localTermination && localTermination.at));
            const localTerminationCallId = trim(localTermination && (localTermination.callId || localTermination.call_id));
            if ((mode === 'ended' || mode === 'failed') && localTerminationAt && (this.now() - localTerminationAt) < RECENT_TERMINAL_SKIP_MS) {
                if (!payloadCallId || !localTerminationCallId || payloadCallId === localTerminationCallId) return true;
            }
            return mode === 'incoming' || mode === 'outgoing' || mode === 'connecting' || mode === 'active';
        },

        shouldRecoverPayload(payload, conversationId) {
            const nextPayload = payload && typeof payload === 'object' ? payload : {};
            const payloadConversationId = Math.max(0, toNumber(nextPayload.conversation_id || nextPayload.conversationId));
            if (!payloadConversationId || payloadConversationId !== Number(conversationId || 0)) return false;
            const status = normalizeStatus(nextPayload.status);
            const role = normalizeRole(nextPayload.viewer_role || nextPayload.viewerRole || nextPayload.role);
            if (!RECOVERABLE_STATUSES[status] || !role) return false;
            return true;
        },

        recoverPayload(payload, source) {
            const nextPayload = Object.assign({}, payload || {}, {
                restore_source: trim(source) || 'call_recovery',
                reason: trim(payload && payload.reason) || 'state_recovery'
            });
            const role = normalizeRole(nextPayload.viewer_role || nextPayload.viewerRole || nextPayload.role);
            const self = this;
            return this.ensureCallManageModule().then(function(callManage) {
                if (!callManage) return null;
                if (self.callManageHasActiveCall(callManage, nextPayload)) return true;
                if (role === 'callee' && typeof callManage.openIncoming === 'function') {
                    callManage.openIncoming(nextPayload);
                    return true;
                }
                if (role === 'caller' && typeof callManage.restoreOutgoing === 'function') {
                    callManage.restoreOutgoing(nextPayload);
                    return true;
                }
                return null;
            });
        },

        checkActiveConversation(options) {
            const state = this.getState();
            const conversationId = Math.max(0, toNumber(options && options.conversationId || state && state.activeConversationId));
            if (!this.shouldCheck(conversationId, options)) return Promise.resolve(null);
            const key = String(conversationId);
            this.lastCheckByConversation[key] = this.now();
            this.inFlightByConversation[key] = true;
            const self = this;
            return this.requestCallState(conversationId).then(function(data) {
                const payload = data && (data.session || data.payload);
                if (!data || !data.found || !self.shouldRecoverPayload(payload, conversationId)) return null;
                return self.recoverPayload(payload, options && options.source);
            }).catch(function() {
                return null;
            }).then(function(result) {
                delete self.inFlightByConversation[key];
                return result || null;
            }, function(error) {
                delete self.inFlightByConversation[key];
                throw error;
            });
        },

        destroy() {
            this.ctx = null;
            this.inFlightByConversation = {};
            this.lastCheckByConversation = {};
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.callRecovery = callRecoveryModule;
})(window);
