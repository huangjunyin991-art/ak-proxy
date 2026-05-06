(function(global) {
    'use strict';

    const DEFAULT_INCREMENT_LIMIT = 200;
    const PREFETCH_SESSION_LIMIT = 12;
    const PREFETCH_BATCH_SIZE = 4;

    const messageSyncModule = {
        ctx: null,
        prefetchingByConversationId: {},

        init(ctx) {
            this.ctx = ctx || null;
            this.prefetchingByConversationId = {};
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getStore() {
            return this.ctx && typeof this.ctx.getMessageStore === 'function' ? this.ctx.getMessageStore() : null;
        },

        getStoreMessages(conversationId) {
            const store = this.getStore();
            if (!store || typeof store.load !== 'function') return [];
            return store.load(conversationId);
        },

        getLastSeqNo(messages) {
            let lastSeqNo = 0;
            (Array.isArray(messages) ? messages : []).forEach(function(item) {
                lastSeqNo = Math.max(lastSeqNo, Number(item && item.seq_no || 0) || 0);
            });
            return lastSeqNo;
        },

        mergeMessages(leftMessages, rightMessages) {
            const byKey = {};
            (Array.isArray(leftMessages) ? leftMessages : []).concat(Array.isArray(rightMessages) ? rightMessages : []).forEach(function(item) {
                if (!item || typeof item !== 'object') return;
                const messageId = Number(item.id || 0);
                const seqNo = Number(item.seq_no || 0);
                if (messageId <= 0 && seqNo <= 0) return;
                const key = messageId > 0 ? ('id:' + messageId) : ('seq:' + seqNo);
                byKey[key] = Object.assign({}, item);
            });
            return Object.keys(byKey).map(function(key) {
                return byKey[key];
            }).sort(function(left, right) {
                const leftSeq = Number(left && left.seq_no || 0);
                const rightSeq = Number(right && right.seq_no || 0);
                if (leftSeq !== rightSeq) return leftSeq - rightSeq;
                return Number(left && left.id || 0) - Number(right && right.id || 0);
            });
        },

        buildMessagesUrl(conversationId, afterSeqNo) {
            const httpRoot = String(this.ctx && this.ctx.httpRoot || '').trim();
            const params = ['conversation_id=' + encodeURIComponent(Number(conversationId || 0))];
            const nextAfterSeqNo = Number(afterSeqNo || 0);
            if (nextAfterSeqNo > 0) {
                params.push('after_seq_no=' + encodeURIComponent(nextAfterSeqNo));
                params.push('limit=' + encodeURIComponent(DEFAULT_INCREMENT_LIMIT));
            }
            return httpRoot + '/messages?' + params.join('&');
        },

        renderActive(conversationId, messages, loading) {
            const state = this.getState();
            const targetConversationId = Number(conversationId || 0);
            if (!state || !targetConversationId || Number(state.activeConversationId || 0) !== targetConversationId) return;
            state.activeMessages = Array.isArray(messages) ? messages.slice() : [];
            state.activeMessagesLoading = !!loading;
            if (this.ctx && typeof this.ctx.setCachedMessages === 'function') {
                this.ctx.setCachedMessages(targetConversationId, state.activeMessages);
            }
            if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
        },

        saveConversation(conversationId, messages) {
            const sourceMessages = Array.isArray(messages) ? messages.slice() : [];
            const store = this.getStore();
            if (!store || typeof store.save !== 'function') return sourceMessages;
            const savedMessages = store.save(conversationId, sourceMessages);
            if (Array.isArray(savedMessages) && (savedMessages.length > 0 || sourceMessages.length === 0)) return savedMessages;
            return sourceMessages;
        },

        hydrateConversation(conversationId) {
            const state = this.getState();
            const targetConversationId = Number(conversationId || 0);
            if (!state || !targetConversationId || !this.ctx || typeof this.ctx.request !== 'function') {
                return Promise.resolve({ handled: false, messages: [] });
            }
            const cachedMessages = this.getStoreMessages(targetConversationId);
            const hasCachedMessages = cachedMessages.length > 0;
            if (hasCachedMessages) {
                this.renderActive(targetConversationId, cachedMessages, true);
            }
            const afterSeqNo = this.getLastSeqNo(cachedMessages);
            return this.ctx.request(this.buildMessagesUrl(targetConversationId, afterSeqNo)).then(function(data) {
                const incomingItems = Array.isArray(data && data.items) ? data.items : [];
                const mergedMessages = afterSeqNo > 0 ? this.mergeMessages(cachedMessages, incomingItems) : incomingItems;
                const savedMessages = this.saveConversation(targetConversationId, mergedMessages);
                this.renderActive(targetConversationId, savedMessages, false);
                return {
                    handled: true,
                    used_cache: hasCachedMessages,
                    messages: savedMessages,
                    incoming_count: incomingItems.length
                };
            }.bind(this)).catch(function(error) {
                if (hasCachedMessages) {
                    this.renderActive(targetConversationId, cachedMessages, false);
                    return {
                        handled: true,
                        used_cache: true,
                        messages: cachedMessages,
                        error: error
                    };
                }
                throw error;
            }.bind(this));
        },

        prefetchConversation(conversationId) {
            const targetConversationId = Number(conversationId || 0);
            if (!targetConversationId || !this.ctx || typeof this.ctx.request !== 'function') return Promise.resolve(null);
            const key = String(targetConversationId);
            if (this.prefetchingByConversationId[key]) return this.prefetchingByConversationId[key];
            const cachedMessages = this.getStoreMessages(targetConversationId);
            const afterSeqNo = this.getLastSeqNo(cachedMessages);
            this.prefetchingByConversationId[key] = this.ctx.request(this.buildMessagesUrl(targetConversationId, afterSeqNo)).then(function(data) {
                const incomingItems = Array.isArray(data && data.items) ? data.items : [];
                const mergedMessages = afterSeqNo > 0 ? this.mergeMessages(cachedMessages, incomingItems) : incomingItems;
                const savedMessages = this.saveConversation(targetConversationId, mergedMessages);
                if (this.ctx && typeof this.ctx.setCachedMessages === 'function') {
                    this.ctx.setCachedMessages(targetConversationId, savedMessages);
                }
                this.renderActive(targetConversationId, savedMessages, false);
                delete this.prefetchingByConversationId[key];
                return savedMessages;
            }.bind(this)).catch(function() {
                delete this.prefetchingByConversationId[key];
                return null;
            }.bind(this));
            return this.prefetchingByConversationId[key];
        },

        prefetchRecentSessions(sessions) {
            if (!Array.isArray(sessions) || !sessions.length) return Promise.resolve(null);
            const self = this;
            const conversationIds = [];
            sessions.forEach(function(item) {
                const conversationId = Number(item && item.conversation_id || 0);
                if (!conversationId || conversationIds.indexOf(conversationId) >= 0) return;
                conversationIds.push(conversationId);
            });
            const batches = [];
            const targets = conversationIds.slice(0, PREFETCH_SESSION_LIMIT);
            for (let index = 0; index < targets.length; index += PREFETCH_BATCH_SIZE) {
                batches.push(targets.slice(index, index + PREFETCH_BATCH_SIZE));
            }
            return batches.reduce(function(chain, batch) {
                return chain.then(function() {
                    return Promise.all(batch.map(function(conversationId) {
                        return self.prefetchConversation(conversationId);
                    }));
                });
            }, Promise.resolve(null));
        },

        mergeIncomingMessage(item) {
            if (!item || !item.conversation_id) return [];
            const store = this.getStore();
            if (!store || typeof store.replaceMessage !== 'function') return [];
            return store.replaceMessage(item);
        },

        replaceMessage(item) {
            return this.mergeIncomingMessage(item);
        },

        removeMessage(item) {
            const store = this.getStore();
            if (!store || typeof store.removeMessage !== 'function') return [];
            return store.removeMessage(item);
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.messageSync = messageSyncModule;
})(window);
