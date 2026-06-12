(function(global) {
    'use strict';

    const BOTTOM_THRESHOLD_PX = 72;
    const HIGHLIGHT_DURATION_MS = 1200;

    const messageNavigationModule = {
        ctx: null,
        scrollBoundEl: null,
        highlightTimer: null,
        bottomStabilizeTimers: [],

        init(ctx) {
            this.ctx = ctx || null;
            this.ensureNavigationState();
            this.bindScrollEvents();
            this.renderControls();
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getElements() {
            return this.ctx && this.ctx.elements ? this.ctx.elements : {};
        },

        ensureNavigationState() {
            const state = this.getState();
            if (!state) return null;
            if (!state.messageNavigation || typeof state.messageNavigation !== 'object') {
                state.messageNavigation = {
                    conversationId: 0,
                    entryUnreadCount: 0,
                    firstUnreadSeqNo: 0,
                    unreadAnchorPartial: false,
                    unreadAnchorConsumed: false,
                    newMessageCount: 0,
                    mentionSeqNo: 0,
                    mentionLabel: '',
                    atBottom: true,
                    forceBottomUntil: 0
                };
            }
            return state.messageNavigation;
        },

        getActiveConversationId() {
            const state = this.getState();
            return Number(state && state.activeConversationId || 0);
        },

        getUnreadCount(session) {
            return Math.max(0, Number(session && (session.unread_count || session.unread || 0) || 0) || 0);
        },

        isAtBottom() {
            const messageList = this.getElements().messageList;
            if (!messageList) return true;
            const distance = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight;
            return distance <= BOTTOM_THRESHOLD_PX;
        },

        shouldMarkReadNow() {
            return this.isAtBottom() || this.areEntryUnreadMessagesFullyVisible();
        },

        shouldSuppressControls() {
            const state = this.getState();
            return !state || state.view !== 'chat' || !state.activeConversationId || !!state.emojiPanelOpen || !!state.plusPanelOpen;
        },

        bindScrollEvents() {
            const messageList = this.getElements().messageList;
            if (!messageList || this.scrollBoundEl === messageList) return;
            if (this.scrollBoundEl) this.scrollBoundEl.removeEventListener('scroll', this.handleScroll);
            this.handleScroll = this.handleScroll || this.onScroll.bind(this);
            this.scrollBoundEl = messageList;
            messageList.addEventListener('scroll', this.handleScroll, { passive: true });
        },

        onScroll() {
            const navState = this.ensureNavigationState();
            if (!navState) return;
            if (this.shouldSuppressControls()) {
                this.clearControls();
                return;
            }
            const atBottom = this.isAtBottom();
            navState.atBottom = atBottom;
            if (!atBottom && Number(navState.forceBottomUntil || 0) > Date.now()) {
                navState.forceBottomUntil = 0;
            }
            if (atBottom && navState.newMessageCount > 0) {
                navState.newMessageCount = 0;
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
                this.markReadActiveConversation();
            }
            this.consumeVisibleEntryUnread();
            this.renderControls();
        },

        markReadActiveConversation() {
            if (this.ctx && typeof this.ctx.markReadActiveConversation === 'function') {
                this.ctx.markReadActiveConversation(this.getActiveConversationId());
            }
        },

        clearControls() {
            const navEl = this.getElements().navigationEl;
            if (!navEl) return;
            navEl.innerHTML = '';
            navEl.classList.remove('is-visible');
        },

        beginConversationLoad(conversationId, session) {
            const navState = this.ensureNavigationState();
            const targetConversationId = Number(conversationId || 0);
            if (!navState || !targetConversationId) return;
            const unreadCount = this.getUnreadCount(session);
            const forceBottomUntil = unreadCount <= 0 ? Date.now() + 1800 : 0;
            if (Number(navState.conversationId || 0) !== targetConversationId) {
                navState.conversationId = targetConversationId;
                navState.entryUnreadCount = unreadCount;
                navState.firstUnreadSeqNo = 0;
                navState.unreadAnchorPartial = false;
                navState.unreadAnchorConsumed = unreadCount <= 0;
                navState.newMessageCount = 0;
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
                navState.atBottom = true;
                navState.forceBottomUntil = forceBottomUntil;
                this.renderControls();
                return;
            }
            if (forceBottomUntil) {
                navState.forceBottomUntil = forceBottomUntil;
                navState.entryUnreadCount = 0;
                navState.firstUnreadSeqNo = 0;
                navState.unreadAnchorConsumed = true;
                navState.newMessageCount = 0;
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
            }
            if (!navState.unreadAnchorConsumed && navState.entryUnreadCount <= 0 && unreadCount > 0) {
                navState.entryUnreadCount = unreadCount;
            }
        },

        beforeRenderMessages() {
            this.bindScrollEvents();
            const messageList = this.getElements().messageList;
            if (!messageList) return { shouldScrollBottom: true, distanceFromBottom: 0 };
            const navState = this.ensureNavigationState();
            const forceBottom = !!(navState && Number(navState.forceBottomUntil || 0) > Date.now());
            const distanceFromBottom = Math.max(0, messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight);
            return {
                shouldScrollBottom: forceBottom || distanceFromBottom <= BOTTOM_THRESHOLD_PX,
                distanceFromBottom: distanceFromBottom,
                scrollTop: messageList.scrollTop,
                forceBottom: forceBottom
            };
        },

        shouldAutoFollowBottom() {
            const navState = this.ensureNavigationState();
            return this.isAtBottom() || !!(navState && Number(navState.forceBottomUntil || 0) > Date.now());
        },

        afterRenderMessages(snapshot) {
            this.bindScrollEvents();
            const messageList = this.getElements().messageList;
            const navState = this.ensureNavigationState();
            if (!messageList || !navState) return false;
            this.refreshUnreadAnchor();
            if (snapshot && snapshot.shouldScrollBottom) {
                this.scrollToBottom({ silent: true });
            } else if (snapshot) {
                messageList.scrollTop = Math.max(0, Number(snapshot.scrollTop || 0) || 0);
            }
            this.bindMediaBottomStabilizers(messageList);
            if (snapshot && snapshot.forceBottom) this.scheduleBottomStabilize();
            navState.atBottom = this.isAtBottom();
            if (navState.atBottom) {
                navState.newMessageCount = 0;
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
            }
            this.consumeVisibleEntryUnread();
            this.renderControls();
            return true;
        },

        scheduleBottomStabilize() {
            const navState = this.ensureNavigationState();
            if (!navState || Number(navState.forceBottomUntil || 0) <= Date.now()) return;
            const self = this;
            this.bottomStabilizeTimers.forEach(function(timerId) {
                clearTimeout(timerId);
            });
            this.bottomStabilizeTimers = [40, 160, 420, 900, 1500].map(function(delay) {
                return setTimeout(function() {
                    const currentState = self.ensureNavigationState();
                    if (!currentState || Number(currentState.forceBottomUntil || 0) <= Date.now()) return;
                    self.scrollToBottom({ silent: true });
                    self.renderControls();
                }, delay);
            });
        },

        forceScrollToBottom(durationMs) {
            const navState = this.ensureNavigationState();
            if (navState) {
                navState.forceBottomUntil = Date.now() + Math.max(600, Number(durationMs || 0) || 1800);
                navState.entryUnreadCount = 0;
                navState.firstUnreadSeqNo = 0;
                navState.unreadAnchorConsumed = true;
                navState.newMessageCount = 0;
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
            }
            this.scrollToBottom({ silent: true });
            this.scheduleBottomStabilize();
            this.renderControls();
        },

        bindMediaBottomStabilizers(messageList) {
            const navState = this.ensureNavigationState();
            if (!messageList || !navState || Number(navState.forceBottomUntil || 0) <= Date.now()) return;
            const self = this;
            Array.prototype.forEach.call(messageList.querySelectorAll('img, video'), function(mediaEl) {
                if (!mediaEl || mediaEl.dataset.akImBottomStabilized) return;
                mediaEl.dataset.akImBottomStabilized = '1';
                const handler = function() {
                    const currentState = self.ensureNavigationState();
                    if (!currentState || Number(currentState.forceBottomUntil || 0) <= Date.now()) return;
                    self.scrollToBottom({ silent: true });
                    self.renderControls();
                };
                mediaEl.addEventListener('load', handler, { once: true });
                mediaEl.addEventListener('loadedmetadata', handler, { once: true });
                mediaEl.addEventListener('loadeddata', handler, { once: true });
            });
        },

        isMentionedInMessage(item) {
            const state = this.getState();
            if (!state || !item) return '';
            if (String(item.sender_username || '') === String(state.username || '')) return '';
            if (item.mention_all) return '@全体';
            const currentUsername = String(state.username || '').trim().toLowerCase();
            const mentionUsernames = Array.isArray(item.mention_usernames) ? item.mention_usernames : [];
            const matched = mentionUsernames.some(function(username) {
                return String(username || '').trim().toLowerCase() === currentUsername;
            });
            return matched ? '@我' : '';
        },

        refreshUnreadAnchor() {
            const state = this.getState();
            const navState = this.ensureNavigationState();
            if (!state || !navState || navState.unreadAnchorConsumed) return;
            const entryUnreadCount = Math.max(0, Number(navState.entryUnreadCount || 0) || 0);
            if (entryUnreadCount <= 0) return;
            const peerMessages = (Array.isArray(state.activeMessages) ? state.activeMessages : []).filter(function(item) {
                return item && Number(item.seq_no || 0) > 0 && String(item.sender_username || '') !== String(state.username || '');
            });
            if (!peerMessages.length) return;
            const anchorIndex = Math.max(0, peerMessages.length - entryUnreadCount);
            const anchorMessage = peerMessages[anchorIndex] || peerMessages[0];
            navState.firstUnreadSeqNo = Number(anchorMessage && anchorMessage.seq_no || 0) || 0;
            navState.unreadAnchorPartial = entryUnreadCount > peerMessages.length;
        },

        getEntryUnreadMessages() {
            const state = this.getState();
            const navState = this.ensureNavigationState();
            if (!state || !navState || navState.unreadAnchorConsumed || navState.unreadAnchorPartial) return [];
            const entryUnreadCount = Math.max(0, Number(navState.entryUnreadCount || 0) || 0);
            if (entryUnreadCount <= 0) return [];
            const peerMessages = (Array.isArray(state.activeMessages) ? state.activeMessages : []).filter(function(item) {
                return item && Number(item.seq_no || 0) > 0 && String(item.sender_username || '') !== String(state.username || '');
            });
            if (peerMessages.length < entryUnreadCount) return [];
            return peerMessages.slice(peerMessages.length - entryUnreadCount);
        },

        areEntryUnreadMessagesFullyVisible() {
            const messageList = this.getElements().messageList;
            const unreadMessages = this.getEntryUnreadMessages();
            if (!messageList || !unreadMessages.length) return false;
            const listRect = messageList.getBoundingClientRect();
            return unreadMessages.every((item) => {
                const node = this.findMessageNodeBySeqNo(item.seq_no);
                if (!node) return false;
                const rect = node.getBoundingClientRect();
                return rect.top >= listRect.top && rect.bottom <= listRect.bottom;
            });
        },

        consumeVisibleEntryUnread() {
            const navState = this.ensureNavigationState();
            if (!navState || navState.unreadAnchorConsumed || !this.areEntryUnreadMessagesFullyVisible()) return false;
            this.markReadActiveConversation();
            navState.unreadAnchorConsumed = true;
            navState.entryUnreadCount = 0;
            navState.firstUnreadSeqNo = 0;
            return true;
        },

        handleIncomingMessage(item) {
            const state = this.getState();
            const navState = this.ensureNavigationState();
            if (!navState || !item) return;
            if (Number(item.conversation_id || 0) !== this.getActiveConversationId()) return;
            if (state && String(item.sender_username || '') === String(state.username || '')) return;
            const mentionLabel = this.isMentionedInMessage(item);
            if (this.isAtBottom()) {
                navState.newMessageCount = 0;
                navState.atBottom = true;
                return;
            }
            if (mentionLabel) {
                navState.mentionSeqNo = Number(item.seq_no || 0) || 0;
                navState.mentionLabel = mentionLabel;
            }
            navState.newMessageCount = Math.max(0, Number(navState.newMessageCount || 0) || 0) + 1;
            navState.atBottom = false;
            this.renderControls();
        },

        findMessageNodeBySeqNo(seqNo) {
            const messageList = this.getElements().messageList;
            const targetSeqNo = Number(seqNo || 0);
            if (!messageList || !targetSeqNo) return null;
            return messageList.querySelector('[data-im-message-seq-no="' + String(targetSeqNo) + '"]');
        },

        highlightMessage(node) {
            if (!node) return;
            if (this.highlightTimer) clearTimeout(this.highlightTimer);
            node.classList.add('is-navigation-highlight');
            this.highlightTimer = setTimeout(function() {
                node.classList.remove('is-navigation-highlight');
            }, HIGHLIGHT_DURATION_MS);
        },

        scrollToNode(node) {
            const messageList = this.getElements().messageList;
            if (!messageList || !node) return false;
            const listRect = messageList.getBoundingClientRect();
            const nodeRect = node.getBoundingClientRect();
            const top = Math.max(0, messageList.scrollTop + nodeRect.top - listRect.top - 16);
            messageList.scrollTop = top;
            this.highlightMessage(node);
            return true;
        },

        scrollToFirstUnread() {
            const navState = this.ensureNavigationState();
            if (!navState) return;
            this.refreshUnreadAnchor();
            const node = this.findMessageNodeBySeqNo(navState.firstUnreadSeqNo);
            if (node && this.scrollToNode(node)) {
                navState.unreadAnchorConsumed = true;
                this.renderControls();
                return;
            }
            const messageList = this.getElements().messageList;
            if (messageList) messageList.scrollTop = 0;
        },

        scrollToMention() {
            const navState = this.ensureNavigationState();
            if (!navState) return;
            const node = this.findMessageNodeBySeqNo(navState.mentionSeqNo);
            if (node && this.scrollToNode(node)) {
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
                this.renderControls();
            }
        },

        scrollToBottom(options) {
            const messageList = this.getElements().messageList;
            const navState = this.ensureNavigationState();
            if (!messageList) return;
            messageList.scrollTop = messageList.scrollHeight;
            if (navState) {
                navState.newMessageCount = 0;
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
                navState.atBottom = true;
            }
            if (!options || !options.silent) this.markReadActiveConversation();
            if (!options || !options.silent) this.renderControls();
        },

        buildButton(action, text) {
            return '<button class="ak-im-message-nav-btn" type="button" data-im-message-nav-action="' + action + '">' + this.ctx.escapeHtml(text) + '</button>';
        },

        renderControls() {
            const elements = this.getElements();
            const navEl = elements.navigationEl;
            const navState = this.ensureNavigationState();
            if (!navEl || !navState || !this.ctx || typeof this.ctx.escapeHtml !== 'function') return;
            if (this.shouldSuppressControls()) {
                this.clearControls();
                return;
            }
            const parts = [];
            const entryUnreadCount = Math.max(0, Number(navState.entryUnreadCount || 0) || 0);
            if (entryUnreadCount > 0 && !navState.unreadAnchorConsumed) {
                parts.push(this.buildButton('unread', entryUnreadCount + '条未读消息'));
            }
            if (Number(navState.mentionSeqNo || 0) > 0 && String(navState.mentionLabel || '').trim()) {
                parts.push(this.buildButton('mention', '有人' + String(navState.mentionLabel || '').trim()));
            }
            const newMessageCount = Math.max(0, Number(navState.newMessageCount || 0) || 0);
            if (newMessageCount > 0 && !this.isAtBottom()) {
                parts.push(this.buildButton('new', newMessageCount + '条新消息'));
            }
            if (!this.isAtBottom()) {
                parts.push(this.buildButton('bottom', '回到底部'));
            }
            navEl.innerHTML = parts.join('');
            navEl.classList.toggle('is-visible', parts.length > 0);
            this.bindControlEvents(navEl);
        },

        bindControlEvents(navEl) {
            const self = this;
            Array.prototype.forEach.call(navEl.querySelectorAll('[data-im-message-nav-action]'), function(button) {
                button.addEventListener('click', function() {
                    const action = String(button.getAttribute('data-im-message-nav-action') || '').trim();
                    if (action === 'unread') {
                        self.scrollToFirstUnread();
                        return;
                    }
                    if (action === 'mention') {
                        self.scrollToMention();
                        return;
                    }
                    self.scrollToBottom();
                });
            });
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.messageNavigation = messageNavigationModule;
})(window);
