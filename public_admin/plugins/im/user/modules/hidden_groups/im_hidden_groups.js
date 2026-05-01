(function(global) {
    'use strict';

    const hiddenGroupsModule = {
        ctx: null,

        init(ctx) {
            this.ctx = ctx || null;
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getContainer() {
            const elements = this.ctx && this.ctx.elements ? this.ctx.elements : null;
            return elements && elements.profileSubpageBodyEl ? elements.profileSubpageBodyEl : null;
        },

        renderEmpty(container, text) {
            if (!container) return;
            container.innerHTML = '<div class="ak-im-social-empty">' + this.ctx.escapeHtml(text || '') + '</div>';
        },

        loadHiddenGroups(force) {
            const state = this.getState();
            if (!state || !state.allowed) return Promise.resolve([]);
            if (!force && state.hiddenGroupsLoaded && !state.hiddenGroupsLoading) {
                return Promise.resolve(state.hiddenGroupsItems);
            }
            if (state.hiddenGroupsLoading) {
                return Promise.resolve(state.hiddenGroupsItems);
            }
            const self = this;
            state.hiddenGroupsLoading = true;
            state.hiddenGroupsError = '';
            if (typeof this.ctx.render === 'function') this.ctx.render();
            return this.ctx.request(this.ctx.httpRoot + '/sessions/hidden-groups').then(function(data) {
                state.hiddenGroupsLoading = false;
                state.hiddenGroupsLoaded = true;
                state.hiddenGroupsError = '';
                state.hiddenGroupsItems = Array.isArray(data && data.items) ? data.items : [];
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return state.hiddenGroupsItems;
            }).catch(function(error) {
                state.hiddenGroupsLoading = false;
                state.hiddenGroupsLoaded = false;
                state.hiddenGroupsItems = [];
                state.hiddenGroupsError = error && error.message ? error.message : '读取已隐藏群聊失败';
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return [];
            });
        },

        restoreHiddenGroup(conversationID) {
            const state = this.getState();
            const normalizedID = Number(conversationID || 0);
            if (!state || !normalizedID || state.hiddenGroupsActionId) return Promise.resolve(null);
            const self = this;
            state.hiddenGroupsActionId = normalizedID;
            state.hiddenGroupsError = '';
            if (typeof this.ctx.render === 'function') this.ctx.render();
            return this.ctx.request(this.ctx.httpRoot + '/sessions/hidden-groups/restore', {
                method: 'POST',
                body: JSON.stringify({ conversation_id: normalizedID })
            }).then(function() {
                return Promise.all([
                    self.loadHiddenGroups(true),
                    typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null
                ]);
            }).catch(function(error) {
                state.hiddenGroupsError = error && error.message ? error.message : '恢复群聊失败';
                return null;
            }).then(function(result) {
                state.hiddenGroupsActionId = 0;
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return result;
            }, function(error) {
                state.hiddenGroupsActionId = 0;
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return Promise.reject(error);
            });
        },

        formatUpdatedAt(value) {
            const text = String(value || '').trim();
            if (!text) return '';
            const date = new Date(text);
            if (Number.isNaN(date.getTime())) return text;
            try {
                return date.toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } catch (e) {
                return text;
            }
        },

        openHiddenGroup(conversationID) {
            const normalizedID = Number(conversationID || 0);
            if (!normalizedID || !this.ctx || typeof this.ctx.openConversationById !== 'function') return Promise.resolve(null);
            const state = this.getState();
            const item = (Array.isArray(state && state.hiddenGroupsItems) ? state.hiddenGroupsItems : []).find(function(groupItem) {
                return Number(groupItem && groupItem.conversation_id || 0) === normalizedID;
            }) || null;
            const sessionItem = item ? {
                conversation_id: normalizedID,
                conversation_type: 'group',
                conversation_title: String(item.conversation_title || '').trim() || '未命名群聊',
                avatar_url: String(item.avatar_url || '').trim(),
                member_count: Number(item.member_count || 0) || 0,
                updated_at: item.updated_at || '',
                hidden_for_all: true,
                can_send: true
            } : null;
            return this.ctx.openConversationById(normalizedID, sessionItem);
        },

        buildGroupRow(item) {
            const conversationID = Number(item && item.conversation_id || 0);
            const title = String(item && item.conversation_title || '').trim() || '未命名群聊';
            const memberCount = Math.max(0, Number(item && item.member_count || 0) || 0);
            const updatedAtText = this.formatUpdatedAt(item && item.updated_at);
            const state = this.getState();
            const restoring = Number(state && state.hiddenGroupsActionId || 0) === conversationID;
            return '<div class="ak-im-hidden-group-row" data-im-hidden-group-id="' + conversationID + '">' +
                '<button class="ak-im-hidden-group-open" type="button" data-im-hidden-group-open="' + conversationID + '">' +
                    (typeof this.ctx.buildAvatarBoxMarkup === 'function' ? this.ctx.buildAvatarBoxMarkup('ak-im-contact-avatar', item && item.avatar_url, title, title + '头像') : '<div class="ak-im-contact-avatar">群</div>') +
                    '<span class="ak-im-hidden-group-main">' +
                        '<span class="ak-im-hidden-group-title">' + this.ctx.escapeHtml(title) + '</span>' +
                        '<span class="ak-im-hidden-group-meta">' + this.ctx.escapeHtml(memberCount + ' 名成员' + (updatedAtText ? ' · 更新于 ' + updatedAtText : '')) + '</span>' +
                    '</span>' +
                '</button>' +
                '<button class="ak-im-social-action" type="button" data-im-hidden-group-restore="' + conversationID + '"' + (restoring ? ' disabled' : '') + '>' + this.ctx.escapeHtml(restoring ? '恢复中...' : '恢复显示') + '</button>' +
            '</div>';
        },

        renderProfileSubpage() {
            const state = this.getState();
            const container = this.getContainer();
            if (!container || !state || state.view !== 'profile_hidden_groups') return false;
            if (!state.hiddenGroupsLoaded && !state.hiddenGroupsLoading) {
                this.loadHiddenGroups();
            }
            container.innerHTML = '<div class="ak-im-social-panel">' +
                '<div class="ak-im-social-current-list"></div>' +
            '</div>';
            const listEl = container.querySelector('.ak-im-social-current-list');
            const items = Array.isArray(state.hiddenGroupsItems) ? state.hiddenGroupsItems : [];
            if (state.hiddenGroupsLoading) {
                this.renderEmpty(listEl, '正在加载已隐藏群聊...');
            } else if (state.hiddenGroupsError && !items.length) {
                this.renderEmpty(listEl, state.hiddenGroupsError);
            } else if (!items.length) {
                this.renderEmpty(listEl, '当前没有已隐藏的群聊');
            } else {
                listEl.innerHTML = '<div class="ak-im-hidden-group-list">' + items.map(this.buildGroupRow.bind(this)).join('') + '</div>';
                this.bindRestoreEvents(listEl);
            }
            return true;
        },

        bindRestoreEvents(container) {
            const self = this;
            Array.prototype.forEach.call(container.querySelectorAll('[data-im-hidden-group-open]'), function(button) {
                button.addEventListener('click', function() {
                    self.openHiddenGroup(Number(button.getAttribute('data-im-hidden-group-open') || 0));
                });
            });
            Array.prototype.forEach.call(container.querySelectorAll('[data-im-hidden-group-restore]'), function(button) {
                button.addEventListener('click', function() {
                    self.restoreHiddenGroup(Number(button.getAttribute('data-im-hidden-group-restore') || 0));
                });
            });
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.hiddenGroups = hiddenGroupsModule;
})(window);
