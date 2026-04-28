(function(global) {
    'use strict';

    const socialModule = {
        ctx: null,
        friendSearchTimer: 0,
        friendSearchToken: 0,

        init(ctx) {
            this.ctx = ctx || null;
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getElements() {
            return this.ctx && this.ctx.elements ? this.ctx.elements : {};
        },

        renderEmpty(container, text, className) {
            if (!container) return;
            container.innerHTML = '<div class="' + (className || 'ak-im-empty') + '">' + (this.ctx && typeof this.ctx.escapeHtml === 'function' ? this.ctx.escapeHtml(text || '') : String(text || '')) + '</div>';
        },

        buildActionButton(label, className, disabled) {
            return '<button class="ak-im-social-action' + (className ? (' ' + className) : '') + '" type="button"' + (disabled ? ' disabled' : '') + '>' + (this.ctx && typeof this.ctx.escapeHtml === 'function' ? this.ctx.escapeHtml(label) : String(label || '')) + '</button>';
        },

        bindLongPressAction(node, onClick, onPress) {
            if (!node || typeof onPress !== 'function') return;
            let pressTimer = 0;
            let didOpenActionSheet = false;
            const startPress = function() {
                if (pressTimer) clearTimeout(pressTimer);
                pressTimer = setTimeout(function() {
                    pressTimer = 0;
                    didOpenActionSheet = true;
                    onPress();
                }, 420);
            };
            const cancelPress = function() {
                if (!pressTimer) return;
                clearTimeout(pressTimer);
                pressTimer = 0;
            };
            if (typeof onClick === 'function') {
                node.addEventListener('click', function() {
                    if (didOpenActionSheet) {
                        didOpenActionSheet = false;
                        return;
                    }
                    onClick();
                });
            }
            node.addEventListener('pointerdown', startPress);
            node.addEventListener('pointerup', cancelPress);
            node.addEventListener('pointercancel', cancelPress);
            node.addEventListener('pointerleave', cancelPress);
            node.addEventListener('contextmenu', function(event) {
                event.preventDefault();
                cancelPress();
                didOpenActionSheet = true;
                onPress();
            });
        },

        renderContactsView() {
            const state = this.getState();
            const elements = this.getElements();
            const contactsListEl = elements.contactsListEl;
            if (!contactsListEl || !state) return false;
            contactsListEl.innerHTML = '';
            if (!state.allowed) {
                this.renderEmpty(contactsListEl, '当前账号未开通聊天');
                return true;
            }
            if (state.contactsLoading) {
                this.renderEmpty(contactsListEl, '正在加载通讯录...');
                return true;
            }
            if (state.contactsError) {
                this.renderEmpty(contactsListEl, state.contactsError);
                return true;
            }
            const sections = Array.isArray(state.contactSections) && state.contactSections.length
                ? state.contactSections
                : (Array.isArray(state.contacts) && state.contacts.length ? [{ key: 'all', title: '通讯录', items: state.contacts }] : []);
            if (!sections.length) {
                this.renderEmpty(contactsListEl, '当前暂无联系人');
                return true;
            }
            const self = this;
            sections.forEach(function(section) {
                const sectionNode = document.createElement('div');
                sectionNode.className = 'ak-im-contact-list-section';
                sectionNode.innerHTML = '<div class="ak-im-contact-list-section-title">' + self.ctx.escapeHtml(section && section.title || '通讯录') + '</div><div class="ak-im-social-list"></div>';
                const listEl = sectionNode.querySelector('.ak-im-social-list');
                (Array.isArray(section && section.items) ? section.items : []).forEach(function(contact) {
                    const username = self.ctx.getContactUsername(contact);
                    if (!username) return;
                    const node = document.createElement('button');
                    node.type = 'button';
                    node.className = 'ak-im-contact-item';
                    node.innerHTML = self.ctx.buildContactItemInnerMarkup(contact);
                    self.bindLongPressAction(node, function() {
                        if (typeof self.ctx.closeActionSheet === 'function') self.ctx.closeActionSheet();
                        self.ctx.openDirectConversation(username);
                    }, function() {
                        if (typeof self.ctx.openContactActionSheet === 'function') self.ctx.openContactActionSheet(contact, 'contact_blacklist_add');
                    });
                    listEl.appendChild(node);
                });
                contactsListEl.appendChild(sectionNode);
            });
            return true;
        },

        handleFriendSearchInputChange(value) {
            const state = this.getState();
            if (!state) return;
            const keyword = String(value || '').trim();
            const keywordLength = Array.from(keyword).length;
            if (this.friendSearchTimer) {
                clearTimeout(this.friendSearchTimer);
                this.friendSearchTimer = 0;
            }
            if (!keyword) {
                state.friendSearchLoading = false;
                state.friendSearchError = '';
                state.friendSearchResults = [];
                if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
                return;
            }
            if (keywordLength < 4) {
                state.friendSearchLoading = false;
                state.friendSearchError = '';
                state.friendSearchResults = [];
                if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
                return;
            }
            state.friendSearchLoading = true;
            state.friendSearchError = '';
            if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
            const self = this;
            const token = ++this.friendSearchToken;
            this.friendSearchTimer = setTimeout(function() {
                self.ctx.request(self.ctx.httpRoot + '/social/search?keyword=' + encodeURIComponent(keyword)).then(function(data) {
                    if (token !== self.friendSearchToken) return null;
                    state.friendSearchLoading = false;
                    state.friendSearchError = '';
                    state.friendSearchResults = Array.isArray(data && data.items) ? data.items : [];
                    if (typeof self.ctx.render === 'function') self.ctx.render();
                    return state.friendSearchResults;
                }).catch(function(error) {
                    if (token !== self.friendSearchToken) return null;
                    state.friendSearchLoading = false;
                    state.friendSearchResults = [];
                    state.friendSearchError = error && error.message ? error.message : '搜索用户失败';
                    if (typeof self.ctx.render === 'function') self.ctx.render();
                    return null;
                });
            }, 220);
        },

        addContact(username) {
            const state = this.getState();
            const normalizedUsername = String(username || '').trim().toLowerCase();
            if (!state || !normalizedUsername || state.friendSearchActionUsername) return Promise.resolve(null);
            const self = this;
            state.friendSearchActionUsername = normalizedUsername;
            if (typeof this.ctx.render === 'function') this.ctx.render();
            return this.ctx.request(this.ctx.httpRoot + '/social/contacts/add', {
                method: 'POST',
                body: JSON.stringify({ username: normalizedUsername })
            }).then(function() {
                state.friendSearchResults = (Array.isArray(state.friendSearchResults) ? state.friendSearchResults : []).filter(function(item) {
                    return self.ctx.getContactUsername(item) !== normalizedUsername;
                });
                return Promise.all([
                    typeof self.ctx.loadContacts === 'function' ? self.ctx.loadContacts() : null,
                    typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null
                ]);
            }).catch(function(error) {
                state.friendSearchError = error && error.message ? error.message : '添加好友失败';
                return null;
            }).then(function(result) {
                state.friendSearchActionUsername = '';
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return result;
            }, function(error) {
                state.friendSearchActionUsername = '';
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return Promise.reject(error);
            });
        },

        renderSearchResultRow(container, item) {
            const state = this.getState();
            const self = this;
            const username = this.ctx.getContactUsername(item);
            if (!container || !username) return;
            const node = document.createElement('div');
            const isContact = !!(item && item.is_contact);
            const friendActionLoading = String(state && state.friendSearchActionUsername || '') === username;
            node.className = 'ak-im-social-row';
            node.innerHTML = '<div class="ak-im-social-row-main">' + this.ctx.buildContactItemInnerMarkup(item) + '</div><div class="ak-im-social-actions">' +
                (isContact
                    ? this.buildActionButton('发消息', 'is-ghost', false)
                    : this.buildActionButton(friendActionLoading ? '添加中...' : '添加', '', friendActionLoading)) +
                '</div>';
            const mainEl = node.querySelector('.ak-im-social-row-main');
            if (mainEl && isContact) {
                mainEl.addEventListener('click', function() {
                    if (typeof self.ctx.closeContactSearch === 'function') self.ctx.closeContactSearch({ silent: true });
                    self.ctx.openDirectConversation(username);
                });
            }
            const buttons = node.querySelectorAll('.ak-im-social-action');
            if (buttons[0]) {
                buttons[0].addEventListener('click', function() {
                    if (isContact) {
                        if (typeof self.ctx.closeContactSearch === 'function') self.ctx.closeContactSearch({ silent: true });
                        self.ctx.openDirectConversation(username);
                        return;
                    }
                    self.addContact(username);
                });
            }
            container.appendChild(node);
        },

        renderContactSearchView() {
            const state = this.getState();
            const elements = this.getElements();
            const container = elements.contactSearchPageEl;
            if (!container || !state || state.contactSearchMode !== 'friend_add') return false;
            if (!state.allowed) {
                this.renderEmpty(container, '当前账号未开通聊天', 'ak-im-contact-search-empty');
                return true;
            }
            const keyword = String(state.contactSearchKeyword || '').trim();
            if (!keyword) {
                this.renderEmpty(container, '搜索账号或姓名，添加到通讯录', 'ak-im-contact-search-empty');
                return true;
            }
            if (Array.from(keyword).length < 4) {
                container.innerHTML = '';
                return true;
            }
            if (state.friendSearchLoading) {
                this.renderEmpty(container, '正在搜索用户...', 'ak-im-contact-search-empty');
                return true;
            }
            if (state.friendSearchError && !(Array.isArray(state.friendSearchResults) && state.friendSearchResults.length)) {
                this.renderEmpty(container, state.friendSearchError, 'ak-im-contact-search-empty');
                return true;
            }
            const results = Array.isArray(state.friendSearchResults) ? state.friendSearchResults : [];
            if (!results.length) {
                this.renderEmpty(container, '未找到可添加的用户', 'ak-im-contact-search-empty');
                return true;
            }
            container.innerHTML = '<div class="ak-im-contact-search-section"><div class="ak-im-contact-search-section-title">搜索结果</div><div class="ak-im-social-list"></div></div>';
            const listEl = container.querySelector('.ak-im-social-list');
            const self = this;
            results.forEach(function(item) {
                self.renderSearchResultRow(listEl, item);
            });
            return true;
        },

        loadBlacklist(force) {
            const state = this.getState();
            if (!state || !state.allowed) return Promise.resolve([]);
            if (!force && state.blacklistLoaded && !state.blacklistLoading) {
                return Promise.resolve(state.blacklistItems);
            }
            if (state.blacklistLoading) {
                return Promise.resolve(state.blacklistItems);
            }
            const self = this;
            state.blacklistLoading = true;
            state.blacklistError = '';
            if (typeof this.ctx.render === 'function') this.ctx.render();
            return this.ctx.request(this.ctx.httpRoot + '/social/blacklist').then(function(data) {
                state.blacklistLoading = false;
                state.blacklistLoaded = true;
                state.blacklistError = '';
                state.blacklistItems = Array.isArray(data && data.items) ? data.items : [];
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return state.blacklistItems;
            }).catch(function(error) {
                state.blacklistLoading = false;
                state.blacklistLoaded = false;
                state.blacklistItems = [];
                state.blacklistError = error && error.message ? error.message : '读取黑名单失败';
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return [];
            });
        },

        addToBlacklist(username) {
            const state = this.getState();
            const normalizedUsername = String(username || '').trim().toLowerCase();
            if (!state || !normalizedUsername || state.blacklistActionUsername) return Promise.resolve(null);
            const self = this;
            state.blacklistActionUsername = normalizedUsername;
            if (typeof this.ctx.render === 'function') this.ctx.render();
            return this.ctx.request(this.ctx.httpRoot + '/social/blacklist/add', {
                method: 'POST',
                body: JSON.stringify({ username: normalizedUsername })
            }).then(function() {
                return Promise.all([
                    self.loadBlacklist(true),
                    typeof self.ctx.loadContacts === 'function' ? self.ctx.loadContacts() : null,
                    typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null
                ]);
            }).catch(function(error) {
                state.blacklistError = error && error.message ? error.message : '加入黑名单失败';
                return null;
            }).then(function(result) {
                state.blacklistActionUsername = '';
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return result;
            }, function(error) {
                state.blacklistActionUsername = '';
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return Promise.reject(error);
            });
        },

        removeFromBlacklist(username) {
            const state = this.getState();
            const normalizedUsername = String(username || '').trim().toLowerCase();
            if (!state || !normalizedUsername || state.blacklistActionUsername) return Promise.resolve(null);
            const self = this;
            state.blacklistActionUsername = normalizedUsername;
            if (typeof this.ctx.render === 'function') this.ctx.render();
            return this.ctx.request(this.ctx.httpRoot + '/social/blacklist/remove', {
                method: 'POST',
                body: JSON.stringify({ username: normalizedUsername })
            }).then(function() {
                return Promise.all([
                    self.loadBlacklist(true),
                    typeof self.ctx.loadContacts === 'function' ? self.ctx.loadContacts() : null,
                    typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null
                ]);
            }).catch(function(error) {
                state.blacklistError = error && error.message ? error.message : '移出黑名单失败';
                return null;
            }).then(function(result) {
                state.blacklistActionUsername = '';
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return result;
            }, function(error) {
                state.blacklistActionUsername = '';
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return Promise.reject(error);
            });
        },

        renderProfileSubpage() {
            const state = this.getState();
            const elements = this.getElements();
            const container = elements.profileSubpageBodyEl;
            if (!container || !state || state.view !== 'profile_blacklist') return false;
            if (!state.blacklistLoaded && !state.blacklistLoading) {
                this.loadBlacklist();
            }
            container.innerHTML = '<div class="ak-im-social-panel">' +
                '<div class="ak-im-social-panel-title">黑名单</div>' +
                '<div class="ak-im-social-panel-subtitle">被拉黑用户会从通讯录中隐藏，且双方不能继续互发消息。长按联系人可移出黑名单。</div>' +
                '<div class="ak-im-social-current-list"></div>' +
            '</div>';
            const currentListEl = container.querySelector('.ak-im-social-current-list');
            const self = this;
            if (state.blacklistLoading) {
                this.renderEmpty(currentListEl, '正在加载黑名单...', 'ak-im-social-empty');
            } else if (state.blacklistError && !(Array.isArray(state.blacklistItems) && state.blacklistItems.length)) {
                this.renderEmpty(currentListEl, state.blacklistError, 'ak-im-social-empty');
            } else if (!(Array.isArray(state.blacklistItems) && state.blacklistItems.length)) {
                this.renderEmpty(currentListEl, '当前黑名单为空', 'ak-im-social-empty');
            } else {
                currentListEl.innerHTML = '<div class="ak-im-social-list"></div>';
                const listEl = currentListEl.querySelector('.ak-im-social-list');
                (Array.isArray(state.blacklistItems) ? state.blacklistItems : []).forEach(function(item) {
                    const username = self.ctx.getContactUsername(item);
                    if (!username) return;
                    const row = document.createElement('button');
                    row.type = 'button';
                    row.className = 'ak-im-contact-item';
                    row.innerHTML = self.ctx.buildContactItemInnerMarkup(item);
                    self.bindLongPressAction(row, null, function() {
                        if (typeof self.ctx.openContactActionSheet === 'function') self.ctx.openContactActionSheet(item, 'contact_blacklist_remove');
                    });
                    listEl.appendChild(row);
                });
            }
            return true;
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.social = socialModule;
})(window);
