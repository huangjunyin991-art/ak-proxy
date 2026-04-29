(function(global) {
    'use strict';

    const groupCreateModule = {
        ctx: null,

        init(ctx) {
            this.ctx = ctx || null;
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getElements() {
            return this.ctx && this.ctx.elements ? this.ctx.elements : {};
        },

        openPage() {
            const state = this.getState();
            if (!state || !state.allowed) return;
            if (typeof this.ctx.closeActionSheet === 'function') this.ctx.closeActionSheet();
            if (typeof this.ctx.closeReadProgressPanel === 'function') this.ctx.closeReadProgressPanel();
            if (typeof this.ctx.closeMemberPanel === 'function') this.ctx.closeMemberPanel();
            if (typeof this.ctx.closeSettingsPanel === 'function') this.ctx.closeSettingsPanel({ silent: true });
            if (typeof this.ctx.closeEmojiPicker === 'function') this.ctx.closeEmojiPicker({ silent: true });
            if (typeof this.ctx.closePlusPanel === 'function') this.ctx.closePlusPanel({ silent: true });
            if (typeof this.ctx.closeHomeAddMenu === 'function') this.ctx.closeHomeAddMenu({ silent: true });
            state.groupCreateTitle = '';
            state.groupCreateTitleError = '';
            state.groupCreateKeyword = '';
            state.groupCreateSelectedUsernames = [];
            state.groupCreateSubmitting = false;
            state.groupCreateError = '';
            state.open = true;
            state.view = 'group_create';
            if (!state.contactsLoaded && !state.contactsLoading && typeof this.ctx.loadContacts === 'function') {
                this.ctx.loadContacts();
            }
            if (typeof this.ctx.render === 'function') this.ctx.render();
            this.focusTitleInput();
        },

        closePage(options) {
            const state = this.getState();
            if (!state || state.groupCreateSubmitting) return;
            const silent = !!(options && options.silent);
            state.groupCreateTitle = '';
            state.groupCreateTitleError = '';
            state.groupCreateKeyword = '';
            state.groupCreateSelectedUsernames = [];
            state.groupCreateError = '';
            if (state.view === 'group_create') state.view = 'sessions';
            if (!silent && typeof this.ctx.render === 'function') this.ctx.render();
        },

        setTitle(value) {
            const state = this.getState();
            if (!state) return;
            state.groupCreateTitle = String(value || '');
            if (String(state.groupCreateTitle || '').trim()) state.groupCreateTitleError = '';
            if (state.groupCreateError) state.groupCreateError = '';
            this.renderPage();
        },

        setKeyword(value) {
            const state = this.getState();
            if (!state) return;
            state.groupCreateKeyword = String(value || '');
            this.renderPage();
        },

        normalizeContact(contact) {
            const getContactUsername = this.ctx && typeof this.ctx.getContactUsername === 'function' ? this.ctx.getContactUsername : function(item) {
                return String(item && item.username || '').trim().toLowerCase();
            };
            const username = getContactUsername(contact);
            const displayName = String(contact && contact.display_name || '').trim() || username || '联系人';
            const honorName = String(contact && contact.honor_name || '').trim();
            return {
                raw: contact,
                username: username,
                displayName: displayName,
                honorName: honorName,
                searchText: (displayName + '\n' + username + '\n' + honorName).toLowerCase()
            };
        },

        getCandidates() {
            const state = this.getState();
            const contacts = Array.isArray(state && state.contacts) ? state.contacts : [];
            const items = [];
            const seen = {};
            for (let index = 0; index < contacts.length; index += 1) {
                const item = this.normalizeContact(contacts[index]);
                if (!item.username || seen[item.username]) continue;
                seen[item.username] = true;
                items.push(item);
            }
            return items;
        },

        getFilteredCandidates(candidates) {
            const state = this.getState();
            const keyword = String(state && state.groupCreateKeyword || '').trim().toLowerCase();
            if (!keyword) return candidates;
            return candidates.filter(function(candidate) {
                return String(candidate && candidate.searchText || '').indexOf(keyword) >= 0;
            });
        },

        syncSelection(candidates) {
            const state = this.getState();
            if (!state) return [];
            const allowed = {};
            candidates.forEach(function(candidate) {
                if (candidate && candidate.username) allowed[candidate.username] = true;
            });
            const current = Array.isArray(state.groupCreateSelectedUsernames) ? state.groupCreateSelectedUsernames : [];
            const next = current.filter(function(username) {
                return !!allowed[username];
            });
            if (next.length !== current.length) state.groupCreateSelectedUsernames = next;
            return next;
        },

        toggleSelection(username) {
            const state = this.getState();
            if (!state || state.groupCreateSubmitting) return;
            const normalized = String(username || '').trim().toLowerCase();
            if (!normalized) return;
            const selected = Array.isArray(state.groupCreateSelectedUsernames) ? state.groupCreateSelectedUsernames.slice() : [];
            const index = selected.indexOf(normalized);
            if (index >= 0) selected.splice(index, 1);
            else selected.push(normalized);
            state.groupCreateSelectedUsernames = selected;
            state.groupCreateError = '';
            this.renderPage();
        },

        alertTitleInput(message) {
            const state = this.getState();
            const elements = this.getElements();
            const titleInputEl = elements.groupCreateTitleInputEl;
            if (!state) return;
            state.groupCreateTitleError = String(message || '请输入群名');
            this.renderPage();
            if (titleInputEl) {
                titleInputEl.classList.remove('is-alert');
                void titleInputEl.offsetWidth;
                titleInputEl.classList.add('is-alert');
                setTimeout(function() {
                    titleInputEl.classList.remove('is-alert');
                }, 360);
            }
            this.focusTitleInput();
        },

        buildContactMarkup(candidate) {
            if (this.ctx && typeof this.ctx.buildContactItemInnerMarkup === 'function') {
                return this.ctx.buildContactItemInnerMarkup(candidate.raw || candidate);
            }
            const escapeHtml = this.ctx && typeof this.ctx.escapeHtml === 'function' ? this.ctx.escapeHtml : function(text) { return String(text || ''); };
            return '<div class="ak-im-contact-body"><div class="ak-im-contact-name">' + escapeHtml(candidate.displayName || candidate.username || '联系人') + '</div><div class="ak-im-contact-meta">@' + escapeHtml(candidate.username || '') + '</div></div>';
        },

        renderPage() {
            const state = this.getState();
            const elements = this.getElements();
            const bodyEl = elements.groupCreateBodyEl;
            const titleInputEl = elements.groupCreateTitleInputEl;
            const titleTipEl = elements.groupCreateTitleTipEl;
            const searchInputEl = elements.groupCreateSearchInputEl;
            const submitBtnEl = elements.groupCreateSubmitBtnEl;
            if (!state || !bodyEl || !titleInputEl || !searchInputEl || !submitBtnEl) return;
            titleInputEl.value = String(state.groupCreateTitle || '');
            titleInputEl.disabled = state.view !== 'group_create' || !!state.groupCreateSubmitting;
            titleInputEl.classList.toggle('is-error', !!state.groupCreateTitleError);
            if (titleTipEl) {
                titleTipEl.textContent = String(state.groupCreateTitleError || '');
                titleTipEl.classList.toggle('visible', !!state.groupCreateTitleError);
            }
            searchInputEl.value = String(state.groupCreateKeyword || '');
            searchInputEl.disabled = state.view !== 'group_create' || !!state.groupCreateSubmitting;
            if (state.view !== 'group_create') {
                bodyEl.innerHTML = '';
                if (titleTipEl) {
                    titleTipEl.textContent = '';
                    titleTipEl.classList.remove('visible');
                }
                titleInputEl.classList.remove('is-error', 'is-alert');
                submitBtnEl.disabled = true;
                submitBtnEl.textContent = '创建';
                return;
            }
            const escapeHtml = this.ctx && typeof this.ctx.escapeHtml === 'function' ? this.ctx.escapeHtml : function(text) { return String(text || ''); };
            const candidates = this.getCandidates();
            const selectedUsernames = this.syncSelection(candidates);
            const candidateMap = {};
            candidates.forEach(function(candidate) {
                candidateMap[candidate.username] = candidate;
            });
            const selectedCandidates = selectedUsernames.map(function(username) {
                return candidateMap[username] || null;
            }).filter(Boolean);
            const filteredCandidates = this.getFilteredCandidates(candidates);
            const selectedMarkup = selectedCandidates.length ? '<div class="ak-im-group-create-chip-list">' + selectedCandidates.map(function(candidate) {
                return '<button class="ak-im-group-create-chip" type="button" data-im-group-create-chip="' + escapeHtml(candidate.username) + '"><span>' + escapeHtml(candidate.displayName || candidate.username) + '</span><i aria-hidden="true">×</i></button>';
            }).join('') + '</div>' : '<div class="ak-im-group-create-selected-empty">请选择至少 2 个联系人</div>';
            let listMarkup = '';
            if (state.contactsLoading && !state.contactsLoaded) {
                listMarkup = '<div class="ak-im-group-create-empty">正在同步联系人...</div>';
            } else if (state.contactsError && !candidates.length) {
                listMarkup = '<div class="ak-im-group-create-empty is-error">' + escapeHtml(state.contactsError) + '</div>';
            } else if (!filteredCandidates.length) {
                listMarkup = '<div class="ak-im-group-create-empty">' + escapeHtml(state.groupCreateKeyword ? '没有匹配的联系人' : '当前暂无可选择联系人') + '</div>';
            } else {
                const self = this;
                listMarkup = '<div class="ak-im-group-create-list">' + filteredCandidates.map(function(candidate) {
                    const selected = selectedUsernames.indexOf(candidate.username) >= 0;
                    return '<button class="ak-im-group-create-row" type="button" data-im-group-create-option="' + escapeHtml(candidate.username) + '">' + self.buildContactMarkup(candidate) + '<span class="ak-im-group-create-check' + (selected ? ' is-selected' : '') + '">' + (selected ? '✓' : '') + '</span></button>';
                }).join('') + '</div>';
            }
            bodyEl.innerHTML = (state.groupCreateError ? '<div class="ak-im-group-create-error">' + escapeHtml(state.groupCreateError) + '</div>' : '') +
                '<div class="ak-im-group-create-section"><div class="ak-im-group-create-section-title">已选联系人（' + selectedCandidates.length + '）</div>' + selectedMarkup + '</div>' +
                '<div class="ak-im-group-create-section"><div class="ak-im-group-create-section-title">联系人</div>' + listMarkup + '</div>';
            const self = this;
            Array.prototype.forEach.call(bodyEl.querySelectorAll('[data-im-group-create-option]'), function(button) {
                button.addEventListener('click', function() {
                    self.toggleSelection(button.getAttribute('data-im-group-create-option'));
                });
            });
            Array.prototype.forEach.call(bodyEl.querySelectorAll('[data-im-group-create-chip]'), function(button) {
                button.addEventListener('click', function() {
                    self.toggleSelection(button.getAttribute('data-im-group-create-chip'));
                });
            });
            submitBtnEl.disabled = !!state.groupCreateSubmitting || selectedCandidates.length < 2;
            submitBtnEl.textContent = state.groupCreateSubmitting ? '创建中...' : ('创建（' + selectedCandidates.length + '）');
        },

        submitPage() {
            const state = this.getState();
            if (!state || state.groupCreateSubmitting) return Promise.resolve(null);
            const title = String(state.groupCreateTitle || '').trim();
            const usernames = Array.isArray(state.groupCreateSelectedUsernames) ? state.groupCreateSelectedUsernames.slice() : [];
            if (!title) {
                state.groupCreateError = '';
                this.alertTitleInput('请输入群名');
                return Promise.resolve(null);
            }
            state.groupCreateTitleError = '';
            if (usernames.length < 2) {
                state.groupCreateError = '请选择至少 2 个联系人';
                this.renderPage();
                return Promise.resolve(null);
            }
            if (!this.ctx || typeof this.ctx.request !== 'function') return Promise.resolve(null);
            const self = this;
            state.groupCreateSubmitting = true;
            state.groupCreateError = '';
            this.renderPage();
            return this.ctx.request(this.ctx.httpRoot + '/sessions/group/create', {
                method: 'POST',
                body: JSON.stringify({ title: title, usernames: usernames })
            }).then(function(data) {
                const conversationId = Number(data && data.conversation_id || 0);
                state.groupCreateSubmitting = false;
                state.groupCreateTitle = '';
                state.groupCreateTitleError = '';
                state.groupCreateKeyword = '';
                state.groupCreateSelectedUsernames = [];
                if (conversationId) {
                    state.activeConversationId = conversationId;
                    state.activeMessages = [];
                    state.activeMessagesLoading = true;
                    state.view = 'chat';
                    if (typeof self.ctx.render === 'function') self.ctx.render();
                    return Promise.resolve(typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null).then(function() {
                        return typeof self.ctx.loadMessages === 'function' ? self.ctx.loadMessages(conversationId) : null;
                    });
                }
                state.view = 'sessions';
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return data;
            }).catch(function(error) {
                state.groupCreateSubmitting = false;
                state.groupCreateError = error && error.message ? error.message : '创建群聊失败';
                self.renderPage();
                return null;
            });
        },

        focusTitleInput() {
            const state = this.getState();
            const elements = this.getElements();
            const titleInputEl = elements.groupCreateTitleInputEl;
            if (!titleInputEl) return;
            setTimeout(function() {
                if (!state || state.view !== 'group_create' || titleInputEl.disabled) return;
                try {
                    titleInputEl.focus();
                } catch (e) {}
            }, 0);
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.groupCreate = groupCreateModule;
})(window);
