(function(global) {
    'use strict';

    const STORE_PREFIX = 'ak.im.messages.v1';
    const MAX_MESSAGES_PER_CONVERSATION = 200;

    const messageStoreModule = {
        ctx: null,
        available: null,

        init(ctx) {
            this.ctx = ctx || null;
            this.available = null;
        },

        isAvailable() {
            if (this.available !== null) return this.available;
            try {
                const storage = global.localStorage;
                if (!storage) {
                    this.available = false;
                    return false;
                }
                const key = STORE_PREFIX + '.probe';
                storage.setItem(key, '1');
                storage.removeItem(key);
                this.available = true;
                return true;
            } catch (e) {
                this.available = false;
                return false;
            }
        },

        getUsername() {
            const state = this.ctx && this.ctx.state ? this.ctx.state : null;
            return String(state && state.username || '').trim().toLowerCase();
        },

        getStorageKey(conversationId) {
            const username = this.getUsername();
            const targetConversationId = Number(conversationId || 0);
            if (!username || !targetConversationId) return '';
            return [STORE_PREFIX, username, String(targetConversationId)].join(':');
        },

        normalizeMessages(messages) {
            const byKey = {};
            (Array.isArray(messages) ? messages : []).forEach(function(item) {
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
            }).slice(-MAX_MESSAGES_PER_CONVERSATION);
        },

        load(conversationId) {
            if (!this.isAvailable()) return [];
            const key = this.getStorageKey(conversationId);
            if (!key) return [];
            try {
                const raw = global.localStorage.getItem(key);
                if (!raw) return [];
                const parsed = JSON.parse(raw);
                return this.normalizeMessages(parsed && parsed.messages);
            } catch (e) {
                return [];
            }
        },

        save(conversationId, messages) {
            if (!this.isAvailable()) return [];
            const key = this.getStorageKey(conversationId);
            if (!key) return [];
            const normalized = this.normalizeMessages(messages);
            try {
                global.localStorage.setItem(key, JSON.stringify({
                    conversation_id: Number(conversationId || 0),
                    username: this.getUsername(),
                    updated_at: Date.now(),
                    messages: normalized
                }));
            } catch (e) {}
            return normalized;
        },

        merge(conversationId, incomingMessages) {
            const current = this.load(conversationId);
            return this.save(conversationId, current.concat(Array.isArray(incomingMessages) ? incomingMessages : []));
        },

        getLastSeqNo(conversationId) {
            let lastSeqNo = 0;
            this.load(conversationId).forEach(function(item) {
                lastSeqNo = Math.max(lastSeqNo, Number(item && item.seq_no || 0) || 0);
            });
            return lastSeqNo;
        },

        replaceMessage(item) {
            if (!item || !item.conversation_id) return [];
            const conversationId = Number(item.conversation_id || 0);
            const messageId = Number(item.id || 0);
            const seqNo = Number(item.seq_no || 0);
            if (!conversationId || (!messageId && !seqNo)) return [];
            const current = this.load(conversationId).map(function(currentItem) {
                if (!currentItem) return currentItem;
                if (messageId > 0 && Number(currentItem.id || 0) === messageId) return item;
                if (seqNo > 0 && Number(currentItem.seq_no || 0) === seqNo) return item;
                return currentItem;
            });
            const exists = current.some(function(currentItem) {
                if (!currentItem) return false;
                if (messageId > 0 && Number(currentItem.id || 0) === messageId) return true;
                return seqNo > 0 && Number(currentItem.seq_no || 0) === seqNo;
            });
            return this.save(conversationId, exists ? current : current.concat([item]));
        },

        removeMessage(item) {
            if (!item || !item.conversation_id) return [];
            const conversationId = Number(item.conversation_id || 0);
            const messageId = Number(item.id || 0);
            if (!conversationId || !messageId) return [];
            return this.save(conversationId, this.load(conversationId).filter(function(currentItem) {
                return !currentItem || Number(currentItem.id || 0) !== messageId;
            }));
        },

        clearConversation(conversationId) {
            if (!this.isAvailable()) return;
            const key = this.getStorageKey(conversationId);
            if (!key) return;
            try {
                global.localStorage.removeItem(key);
            } catch (e) {}
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.messageStore = messageStoreModule;
})(window);
