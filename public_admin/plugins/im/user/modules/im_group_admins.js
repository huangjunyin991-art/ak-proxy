(function(global) {
    'use strict';

    const MUTE_DURATIONS = [
        { key: 'mute_3600', label: '禁言 1 小时', seconds: 3600 },
        { key: 'mute_7200', label: '禁言 2 小时', seconds: 7200 },
        { key: 'mute_10800', label: '禁言 3 小时', seconds: 10800 },
        { key: 'mute_86400', label: '禁言 1 天', seconds: 86400 },
        { key: 'mute_259200', label: '禁言 3 天', seconds: 259200 }
    ];

    const groupAdminsModule = {
        ctx: null,
        actionContext: null,

        init(ctx) {
            this.ctx = ctx || null;
            this.actionContext = null;
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getElements() {
            return this.ctx && this.ctx.elements ? this.ctx.elements : {};
        },

        isDebugEnabled() {
            try {
                const search = new URLSearchParams(global.location && global.location.search || '');
                return search.get('ak_im_debug') === '1' || global.localStorage && global.localStorage.getItem('ak_im_debug') === '1';
            } catch (e) {
                return false;
            }
        },

        debugLog(label, payload) {
            if (!this.isDebugEnabled() || !global.console || typeof global.console.log !== 'function') return;
            global.console.log('[AKIM:group-admins]', label, payload || {});
        },

        escapeHtml(value) {
            return this.ctx && typeof this.ctx.escapeHtml === 'function' ? this.ctx.escapeHtml(value) : String(value || '');
        },

        normalizeUsername(value) {
            return String(value || '').trim().toLowerCase();
        },

        getMemberDisplayName(member, fallbackText) {
            const displayName = String(member && (member.display_name || member.displayName) || '').trim();
            const username = String(member && member.username || '').trim();
            return displayName || username || String(fallbackText || '成员');
        },

        getMemberHonorName(member) {
            return String(member && (member.honor_name || member.honorName) || '').trim();
        },

        getMemberRole(member) {
            return String(member && member.role || '').trim().toLowerCase() || 'member';
        },

        getRoleLabel(role) {
            const key = String(role || '').trim().toLowerCase();
            if (key === 'owner') return '群主';
            if (key === 'admin') return '管理员';
            return '成员';
        },

        getRoleRank(role) {
            const key = String(role || '').trim().toLowerCase();
            if (key === 'owner') return 3;
            if (key === 'admin') return 2;
            return 1;
        },

        buildMemberNameMarkup(member, fallbackText) {
            const displayName = this.getMemberDisplayName(member, fallbackText || '成员');
            const honorName = this.getMemberHonorName(member);
            if (this.ctx && typeof this.ctx.buildDisplayNameWithHonorMarkup === 'function') {
                return this.ctx.buildDisplayNameWithHonorMarkup(displayName, honorName, fallbackText || '成员');
            }
            return this.escapeHtml(displayName);
        },

        buildMemberRow(member, action) {
            const escapeHtml = this.escapeHtml.bind(this);
            const username = this.normalizeUsername(member && member.username);
            const displayName = this.getMemberDisplayName(member, '成员');
            const role = this.getMemberRole(member);
            const roleLabel = this.getRoleLabel(role);
            const avatarUrl = this.ctx && typeof this.ctx.getAvatarUrl === 'function' ? this.ctx.getAvatarUrl(member && member.avatar_url) : String(member && member.avatar_url || '');
            const avatarMarkup = this.ctx && typeof this.ctx.buildAvatarBoxMarkup === 'function'
                ? this.ctx.buildAvatarBoxMarkup('ak-im-group-admins-avatar', avatarUrl, displayName, displayName + '头像')
                : '<div class="ak-im-group-admins-avatar">' + escapeHtml(displayName.slice(0, 1) || '成') + '</div>';
            const actionMarkup = action ? '<button class="ak-im-group-admins-action' + (action.primary ? ' is-primary' : '') + (action.danger ? ' is-danger' : '') + '" type="button" data-im-admin-action="' + escapeHtml(action.key) + '" data-im-admin-username="' + escapeHtml(username) + '"' + (action.disabled ? ' disabled' : '') + '>' + escapeHtml(action.label) + '</button>' : '';
            const muteMarkup = this.memberMuteActive(member) ? '<span>已禁言</span>' : '';
            return '<div class="ak-im-group-admins-row" data-im-member-username="' + escapeHtml(username) + '">' +
                avatarMarkup +
                '<div class="ak-im-group-admins-main"><div class="ak-im-group-admins-name">' + this.buildMemberNameMarkup(member, '成员') + '</div>' +
                '<div class="ak-im-group-admins-meta"><span>@' + escapeHtml(username || 'unknown') + '</span><span class="ak-im-group-admins-role">' + escapeHtml(roleLabel) + '</span>' + muteMarkup + '</div></div>' +
                actionMarkup +
            '</div>';
        },

        findMember(username) {
            const state = this.getState();
            const target = this.normalizeUsername(username);
            const members = Array.isArray(state && state.groupSettingsData && state.groupSettingsData.members) ? state.groupSettingsData.members : [];
            return members.find(function(member) {
                return String(member && member.username || '').trim().toLowerCase() === target;
            }) || null;
        },

        canManageMemberTarget(detail, member) {
            const state = this.getState();
            const actorUsername = this.normalizeUsername(state && state.username);
            const targetUsername = this.normalizeUsername(member && member.username);
            if (!detail || !member || !targetUsername || actorUsername === targetUsername) return false;
            const actorRole = String(detail.my_role || '').trim().toLowerCase();
            const targetRole = this.getMemberRole(member);
            if (this.getRoleRank(actorRole) < 2) return false;
            if (targetRole === 'owner') return false;
            if (actorRole === 'admin' && targetRole === 'admin') return false;
            return true;
        },

        memberMuteActive(member) {
            const value = String(member && member.muted_until || '').trim();
            if (!value) return false;
            const time = new Date(value).getTime();
            return !isNaN(time) && time > Date.now();
        },

        openPage(conversationId) {
            const state = this.getState();
            const targetConversationId = Number(conversationId || 0);
            if (!state || !targetConversationId) return;
            state.groupAdminsOpen = true;
            state.groupAdminsLoading = true;
            state.groupAdminsError = '';
            state.groupAdminsConversationId = targetConversationId;
            state.groupAdminsKeyword = '';
            state.groupAdminsActionUsername = '';
            state.open = true;
            state.view = 'group_admins';
            if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
            this.loadPage(targetConversationId);
        },

        closePage(options) {
            const state = this.getState();
            if (!state) return;
            const silent = !!(options && options.silent);
            state.groupAdminsOpen = false;
            state.groupAdminsLoading = false;
            state.groupAdminsError = '';
            state.groupAdminsConversationId = 0;
            state.groupAdminsKeyword = '';
            state.groupAdminsActionUsername = '';
            if (state.view === 'group_admins') state.view = state.groupSettingsOpen ? 'group_info' : (state.activeConversationId ? 'chat' : 'sessions');
            if (!silent && this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
        },

        loadPage(conversationId) {
            if (!this.ctx || typeof this.ctx.request !== 'function') return Promise.resolve(null);
            const self = this;
            const state = this.getState();
            const targetConversationId = Number(conversationId || 0);
            return this.ctx.request(this.ctx.httpRoot + '/sessions/group_admins?conversation_id=' + encodeURIComponent(targetConversationId)).then(function(data) {
                if (!state || Number(state.groupAdminsConversationId || 0) !== targetConversationId) return null;
                state.groupAdminsLoading = false;
                state.groupAdminsError = '';
                state.groupSettingsConversationId = targetConversationId;
                state.groupSettingsData = data && data.item ? data.item : null;
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return state.groupSettingsData;
            }).catch(function(error) {
                if (!state || Number(state.groupAdminsConversationId || 0) !== targetConversationId) return null;
                state.groupAdminsLoading = false;
                state.groupAdminsError = error && error.message ? error.message : '读取群管理员失败';
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return null;
            });
        },

        renderPage() {
            const state = this.getState();
            const elements = this.getElements();
            const bodyEl = elements.groupAdminsBodyEl;
            if (!state || !bodyEl) return;
            if (!state.groupAdminsOpen) {
                bodyEl.innerHTML = '';
                return;
            }
            if (state.groupAdminsLoading) {
                bodyEl.innerHTML = '<div class="ak-im-group-admins-empty">正在加载群管理员...</div>';
                return;
            }
            if (state.groupAdminsError) {
                bodyEl.innerHTML = '<div class="ak-im-group-admins-error">' + this.escapeHtml(state.groupAdminsError) + '</div>';
                return;
            }
            const detail = state.groupSettingsData || null;
            if (!detail) {
                bodyEl.innerHTML = '<div class="ak-im-group-admins-empty">暂无可用的管理员数据</div>';
                return;
            }
            const members = this.ctx && typeof this.ctx.sortGroupMembersForDisplay === 'function'
                ? this.ctx.sortGroupMembersForDisplay(Array.isArray(detail.members) ? detail.members : [])
                : (Array.isArray(detail.members) ? detail.members : []);
            const admins = Array.isArray(detail.admins) ? detail.admins : [];
            const adminMap = {};
            admins.forEach(function(member) {
                const username = String(member && member.username || '').trim().toLowerCase();
                if (username) adminMap[username] = true;
            });
            const canManageAdmins = !!detail.can_manage_admins;
            const keyword = String(state.groupAdminsKeyword || '').trim().toLowerCase();
            const assignCandidates = members.filter(function(member) {
                const username = String(member && member.username || '').trim().toLowerCase();
                const role = String(member && member.role || '').trim().toLowerCase();
                if (!username || role === 'owner' || adminMap[username]) return false;
                if (!keyword) return true;
                return (String(member && member.display_name || '') + '\n' + username + '\n' + String(member && member.honor_name || '')).toLowerCase().indexOf(keyword) >= 0;
            });
            const adminListMarkup = admins.length ? admins.map(function(member) {
                const action = canManageAdmins && groupAdminsModule.getMemberRole(member) !== 'owner'
                    ? { key: 'revoke', label: '降级', danger: true }
                    : null;
                return groupAdminsModule.buildMemberRow(member, action);
            }).join('') : '<div class="ak-im-group-admins-empty">暂无群管理员</div>';
            const assignMarkup = canManageAdmins ? '<div class="ak-im-group-admins-panel"><div class="ak-im-group-admins-title">任命管理员</div><div class="ak-im-group-admins-desc">选择普通成员任命为群管理员。</div><input class="ak-im-group-admins-search" type="search" placeholder="搜索成员" value="' + this.escapeHtml(state.groupAdminsKeyword || '') + '"><div class="ak-im-group-admins-list">' + (assignCandidates.length ? assignCandidates.map(function(member) {
                return groupAdminsModule.buildMemberRow(member, { key: 'assign', label: '任命', primary: true });
            }).join('') : '<div class="ak-im-group-admins-empty">没有可任命的成员</div>') + '</div></div>' : '';
            bodyEl.innerHTML = '<div class="ak-im-group-admins-panel"><div class="ak-im-group-admins-title">当前管理员</div><div class="ak-im-group-admins-desc">群主拥有最高管理权限，管理员可协助管理成员和禁言。</div><div class="ak-im-group-admins-list">' + adminListMarkup + '</div></div>' + assignMarkup;
            this.bindPageEvents(bodyEl);
        },

        bindPageEvents(bodyEl) {
            const self = this;
            const state = this.getState();
            const input = bodyEl.querySelector('.ak-im-group-admins-search');
            if (input) {
                input.addEventListener('input', function() {
                    state.groupAdminsKeyword = input.value || '';
                    self.renderPage();
                });
            }
            Array.prototype.forEach.call(bodyEl.querySelectorAll('[data-im-admin-action]'), function(button) {
                button.addEventListener('click', function(event) {
                    event.preventDefault();
                    event.stopPropagation();
                    const action = button.getAttribute('data-im-admin-action');
                    const username = button.getAttribute('data-im-admin-username');
                    if (action === 'assign') self.assignAdmin(username);
                    if (action === 'revoke') self.revokeAdmin(username);
                });
            });
            Array.prototype.forEach.call(bodyEl.querySelectorAll('[data-im-member-username]'), function(node) {
                self.bindMemberLongPress(node, Number(state.groupAdminsConversationId || 0), node.getAttribute('data-im-member-username'));
            });
        },

        refreshAfterAction(conversationId) {
            const state = this.getState();
            const tasks = [];
            if (this.ctx && typeof this.ctx.loadSessions === 'function') tasks.push(this.ctx.loadSessions());
            if (this.ctx && typeof this.ctx.loadGroupSettings === 'function') tasks.push(this.ctx.loadGroupSettings(conversationId));
            if (this.ctx && typeof this.ctx.loadMessages === 'function' && Number(state && state.activeConversationId || 0) === Number(conversationId || 0)) tasks.push(this.ctx.loadMessages(conversationId));
            if (state && state.groupAdminsOpen && Number(state.groupAdminsConversationId || 0) === Number(conversationId || 0)) {
                return Promise.all(tasks).then(() => this.loadPage(conversationId));
            }
            return Promise.all(tasks);
        },

        assignAdmin(username) {
            this.executeAdminRequest('/sessions/group_admins/assign', username, '任命管理员失败');
        },

        revokeAdmin(username) {
            this.executeAdminRequest('/sessions/group_admins/revoke', username, '降级管理员失败');
        },

        executeAdminRequest(path, username, fallbackMessage) {
            const state = this.getState();
            const conversationId = Number(state && (state.groupAdminsConversationId || state.groupSettingsConversationId) || 0);
            const target = this.normalizeUsername(username);
            if (!this.ctx || typeof this.ctx.request !== 'function' || !conversationId || !target) return;
            const self = this;
            state.groupAdminsActionUsername = target;
            this.ctx.request(this.ctx.httpRoot + path, {
                method: 'POST',
                body: JSON.stringify({ conversation_id: conversationId, username: target })
            }).then(function() {
                state.groupAdminsActionUsername = '';
                return self.refreshAfterAction(conversationId);
            }).catch(function(error) {
                state.groupAdminsActionUsername = '';
                state.groupAdminsError = error && error.message ? error.message : fallbackMessage;
                if (self.ctx && typeof self.ctx.render === 'function') self.ctx.render();
            });
        },

        toggleAllMute(conversationId, enabled) {
            if (!this.ctx || typeof this.ctx.request !== 'function') return Promise.resolve(null);
            const targetConversationId = Number(conversationId || 0);
            if (!targetConversationId) return Promise.resolve(null);
            const self = this;
            return this.ctx.request(this.ctx.httpRoot + '/sessions/all_mute/update', {
                method: 'POST',
                body: JSON.stringify({ conversation_id: targetConversationId, enabled: !!enabled })
            }).then(function() {
                return self.refreshAfterAction(targetConversationId);
            }).catch(function(error) {
                if (self.ctx && typeof self.ctx.openDialog === 'function') {
                    self.ctx.openDialog({ title: '操作失败', message: error && error.message ? error.message : '更新全体禁言失败', confirmText: '知道了', showCancel: false });
                }
                return null;
            });
        },

        bindGroupAvatarLongPress(node, conversationId) {
            if (!node) return;
            this.bindPress(node, function() {
                const state = groupAdminsModule.getState();
                const targetConversationId = Number(conversationId || state && state.groupSettingsConversationId || state && state.activeConversationId || 0);
                const currentDetailConversationId = Number(state && state.groupSettingsData && state.groupSettingsData.conversation_id || state && state.groupSettingsConversationId || 0);
                if (state && targetConversationId && (!state.groupSettingsData || currentDetailConversationId !== targetConversationId) && groupAdminsModule.ctx && typeof groupAdminsModule.ctx.loadGroupSettings === 'function') {
                    groupAdminsModule.ctx.loadGroupSettings(targetConversationId).then(function() {
                        groupAdminsModule.openAllMuteActionSheet(targetConversationId);
                    });
                    return;
                }
                groupAdminsModule.openAllMuteActionSheet(targetConversationId);
            });
        },

        bindMemberLongPress(node, conversationId, username) {
            if (!node) return;
            this.bindPress(node, function() {
                groupAdminsModule.openMemberActionSheet(Number(conversationId || 0), username);
            });
        },

        bindMemberLongPressDelegate(rootEl, conversationId) {
            if (!rootEl) return;
            if (rootEl.__akImGroupAdminsDelegateListeners) {
                this.unbindMemberLongPressDelegate(rootEl);
            }
            this.debugLog('bind-member-delegate', {
                conversationId: Number(conversationId || 0),
                memberNodeCount: rootEl.querySelectorAll ? rootEl.querySelectorAll('[data-im-member-username]').length : 0
            });
            let timer = null;
            let handled = false;
            let targetUsername = '';
            let touchActive = false;
            const findMemberNode = function(target) {
                let node = target;
                while (node && node !== rootEl) {
                    if (node.getAttribute && node.getAttribute('data-im-member-username')) return node;
                    node = node.parentNode;
                }
                return null;
            };
            const start = function(event) {
                if (event && event.type === 'pointerdown' && touchActive) return;
                if (event && event.type === 'pointerdown' && event.pointerType === 'mouse' && event.button !== 0) return;
                const memberNode = findMemberNode(event && event.target);
                if (!memberNode) {
                    groupAdminsModule.debugLog('press-start-no-member', {
                        type: event && event.type,
                        targetTag: event && event.target && event.target.tagName,
                        targetClass: event && event.target && event.target.className
                    });
                    return;
                }
                if (event && event.type === 'touchstart') touchActive = true;
                targetUsername = memberNode.getAttribute('data-im-member-username') || '';
                groupAdminsModule.debugLog('press-start-member', {
                    type: event && event.type,
                    pointerType: event && event.pointerType,
                    conversationId: Number(conversationId || 0),
                    username: targetUsername,
                    targetTag: event && event.target && event.target.tagName,
                    targetClass: event && event.target && event.target.className
                });
                if (timer) clearTimeout(timer);
                timer = setTimeout(function() {
                    timer = null;
                    handled = true;
                    groupAdminsModule.debugLog('press-timer-fired', {
                        conversationId: Number(conversationId || 0),
                        username: targetUsername
                    });
                    groupAdminsModule.openMemberActionSheet(Number(conversationId || 0), targetUsername);
                }, 420);
            };
            const cancel = function() {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
            };
            const endTouch = function() {
                cancel();
                touchActive = false;
            };
            const contextmenu = function(event) {
                const memberNode = findMemberNode(event && event.target);
                if (!memberNode) return;
                event.preventDefault();
                cancel();
                if (handled) return;
                handled = true;
                groupAdminsModule.debugLog('contextmenu-member', {
                    conversationId: Number(conversationId || 0),
                    username: memberNode.getAttribute('data-im-member-username') || ''
                });
                groupAdminsModule.openMemberActionSheet(Number(conversationId || 0), memberNode.getAttribute('data-im-member-username') || '');
            };
            const click = function(event) {
                if (!handled) return;
                event.preventDefault();
                event.stopPropagation();
                handled = false;
            };
            rootEl.__akImGroupAdminsDelegateListeners = {
                start: start,
                cancel: cancel,
                endTouch: endTouch,
                contextmenu: contextmenu,
                click: click
            };
            rootEl.addEventListener('pointerdown', start, true);
            rootEl.addEventListener('pointerup', cancel, true);
            rootEl.addEventListener('pointercancel', cancel, true);
            rootEl.addEventListener('pointerleave', cancel, true);
            rootEl.addEventListener('touchstart', start, true);
            rootEl.addEventListener('touchend', endTouch, true);
            rootEl.addEventListener('touchcancel', endTouch, true);
            rootEl.addEventListener('contextmenu', contextmenu, true);
            rootEl.addEventListener('click', click, true);
        },

        unbindMemberLongPressDelegate(rootEl) {
            if (!rootEl || !rootEl.__akImGroupAdminsDelegateListeners) return;
            const previous = rootEl.__akImGroupAdminsDelegateListeners;
            if (previous.start) {
                rootEl.removeEventListener('pointerdown', previous.start, true);
                rootEl.removeEventListener('touchstart', previous.start, true);
            }
            if (previous.cancel) {
                rootEl.removeEventListener('pointerup', previous.cancel, true);
                rootEl.removeEventListener('pointercancel', previous.cancel, true);
                rootEl.removeEventListener('pointerleave', previous.cancel, true);
            }
            if (previous.endTouch) {
                rootEl.removeEventListener('touchend', previous.endTouch, true);
                rootEl.removeEventListener('touchcancel', previous.endTouch, true);
            }
            if (previous.contextmenu) rootEl.removeEventListener('contextmenu', previous.contextmenu, true);
            if (previous.click) rootEl.removeEventListener('click', previous.click, true);
            delete rootEl.__akImGroupAdminsDelegateListeners;
        },

        bindPress(node, callback) {
            if (node.__akImGroupAdminsPressListeners) {
                this.unbindPress(node);
            }
            let timer = null;
            let handled = false;
            const start = function(event) {
                if (event && event.pointerType === 'mouse' && event.button !== 0) return;
                if (timer) clearTimeout(timer);
                timer = setTimeout(function() {
                    timer = null;
                    handled = true;
                    callback();
                }, 420);
            };
            const cancel = function() {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
            };
            const contextmenu = function(event) {
                event.preventDefault();
                cancel();
                if (handled) return;
                handled = true;
                callback();
            };
            const click = function(event) {
                if (!handled) return;
                event.preventDefault();
                event.stopPropagation();
                handled = false;
            };
            node.__akImGroupAdminsPressListeners = {
                start: start,
                cancel: cancel,
                contextmenu: contextmenu,
                click: click
            };
            node.addEventListener('pointerdown', start);
            node.addEventListener('pointerup', cancel);
            node.addEventListener('pointercancel', cancel);
            node.addEventListener('pointerleave', cancel);
            node.addEventListener('touchstart', start);
            node.addEventListener('touchend', cancel);
            node.addEventListener('touchcancel', cancel);
            node.addEventListener('contextmenu', contextmenu);
            node.addEventListener('click', click, true);
        },

        unbindPress(node) {
            if (!node || !node.__akImGroupAdminsPressListeners) return;
            const previous = node.__akImGroupAdminsPressListeners;
            if (previous.start) node.removeEventListener('pointerdown', previous.start);
            if (previous.cancel) {
                node.removeEventListener('pointerup', previous.cancel);
                node.removeEventListener('pointercancel', previous.cancel);
                node.removeEventListener('pointerleave', previous.cancel);
                node.removeEventListener('touchend', previous.cancel);
                node.removeEventListener('touchcancel', previous.cancel);
            }
            if (previous.start) node.removeEventListener('touchstart', previous.start);
            if (previous.contextmenu) node.removeEventListener('contextmenu', previous.contextmenu);
            if (previous.click) node.removeEventListener('click', previous.click, true);
            delete node.__akImGroupAdminsPressListeners;
        },

        openAllMuteActionSheet(conversationId) {
            const state = this.getState();
            const detail = state && state.groupSettingsData ? state.groupSettingsData : null;
            if (!state || !detail || !detail.can_toggle_all_mute) return;
            const enabled = !detail.all_muted;
            this.actionContext = { type: 'all_mute', conversationId: Number(conversationId || detail.conversation_id || state.groupSettingsConversationId || 0), enabled: enabled };
            state.actionSheetMode = 'group_member';
            state.actionSheetOpen = true;
            state.actionSheetConversationId = this.actionContext.conversationId;
            state.actionSheetCustomActions = [{ key: 'all_mute_toggle', label: enabled ? '开启全体禁言' : '关闭全体禁言', danger: enabled }];
            if (this.ctx && typeof this.ctx.renderActionSheet === 'function') {
                this.ctx.renderActionSheet();
                return;
            }
            if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
        },

        openUnavailableMemberActionSheet(conversationId, label) {
            const state = this.getState();
            if (!state) return;
            this.debugLog('open-unavailable-sheet', {
                conversationId: Number(conversationId || state.groupSettingsConversationId || state.activeConversationId || 0),
                label: String(label || '暂无可用操作')
            });
            this.actionContext = null;
            state.actionSheetMode = 'group_member';
            state.actionSheetOpen = true;
            state.actionSheetConversationId = Number(conversationId || state.groupSettingsConversationId || state.activeConversationId || 0);
            state.actionSheetCustomActions = [{ key: 'member_unavailable', label: String(label || '暂无可用操作'), disabled: true }];
            if (this.ctx && typeof this.ctx.renderActionSheet === 'function') {
                this.ctx.renderActionSheet();
                return;
            }
            if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
        },

        openMemberActionSheet(conversationId, username) {
            const state = this.getState();
            const targetConversationId = Number(conversationId || state && state.groupSettingsConversationId || state && state.activeConversationId || 0);
            const currentDetailConversationId = Number(state && state.groupSettingsData && state.groupSettingsData.conversation_id || state && state.groupSettingsConversationId || 0);
            this.debugLog('open-member-sheet-start', {
                inputConversationId: Number(conversationId || 0),
                targetConversationId: targetConversationId,
                currentDetailConversationId: currentDetailConversationId,
                username: this.normalizeUsername(username),
                hasState: !!state,
                hasDetail: !!(state && state.groupSettingsData)
            });
            if (state && targetConversationId && (!state.groupSettingsData || currentDetailConversationId !== targetConversationId) && this.ctx && typeof this.ctx.loadGroupSettings === 'function') {
                const self = this;
                this.ctx.loadGroupSettings(targetConversationId).then(function() {
                    self.openMemberActionSheet(targetConversationId, username);
                });
                return;
            }
            const detail = state && state.groupSettingsData ? state.groupSettingsData : null;
            const member = this.findMember(username);
            if (!state || !detail) return;
            if (!member) {
                this.debugLog('open-member-sheet-missing-member', {
                    username: this.normalizeUsername(username),
                    memberCount: Array.isArray(detail.members) ? detail.members.length : 0,
                    sampleUsernames: Array.isArray(detail.members) ? detail.members.slice(0, 8).map(function(item) { return item && item.username; }) : []
                });
                this.openUnavailableMemberActionSheet(targetConversationId, '未找到成员信息');
                return;
            }
            const actions = [];
            const targetUsername = this.normalizeUsername(member.username);
            if (detail.can_manage_admins && this.getMemberRole(member) !== 'owner') {
                if (this.getMemberRole(member) === 'admin') actions.push({ key: 'admin_revoke', label: '降级', danger: true });
                else actions.push({ key: 'admin_assign', label: '任命管理员', primary: true });
            }
            if (this.canManageMemberTarget(detail, member)) {
                actions.push({ key: 'member_remove', label: '移除成员', danger: true });
                actions.push({ key: 'member_mute', label: '禁言' });
                if (this.memberMuteActive(member)) actions.push({ key: 'member_unmute', label: '解除禁言' });
            }
            this.debugLog('open-member-sheet-actions', {
                username: targetUsername,
                role: this.getMemberRole(member),
                myRole: String(detail.my_role || ''),
                canManageAdmins: !!detail.can_manage_admins,
                canManageMembers: !!detail.can_manage_members,
                actionKeys: actions.map(function(action) { return action.key; })
            });
            if (!actions.length) {
                this.openUnavailableMemberActionSheet(targetConversationId || Number(detail.conversation_id || state.groupSettingsConversationId || 0), '暂无可用操作');
                return;
            }
            this.actionContext = { type: 'member', conversationId: targetConversationId || Number(detail.conversation_id || state.groupSettingsConversationId || 0), username: targetUsername };
            state.actionSheetMode = 'group_member';
            state.actionSheetOpen = true;
            state.actionSheetConversationId = this.actionContext.conversationId;
            state.actionSheetCustomActions = actions;
            if (this.ctx && typeof this.ctx.renderActionSheet === 'function') {
                this.ctx.renderActionSheet();
                return;
            }
            if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
        },

        openMuteDurationSheet() {
            const state = this.getState();
            if (!state || !this.actionContext) return;
            state.actionSheetMode = 'group_mute_duration';
            state.actionSheetOpen = true;
            state.actionSheetCustomActions = MUTE_DURATIONS.map(function(item) {
                return { key: item.key, label: item.label };
            });
            if (this.ctx && typeof this.ctx.renderActionSheet === 'function') {
                this.ctx.renderActionSheet();
                return;
            }
            if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
        },

        handleActionSheetAction(actionKey) {
            const action = String(actionKey || '').trim();
            if (action === 'member_unavailable') return;
            if (!this.actionContext) return;
            if (action === 'all_mute_toggle') {
                const context = this.actionContext;
                if (this.ctx && typeof this.ctx.closeActionSheet === 'function') this.ctx.closeActionSheet();
                this.toggleAllMute(context.conversationId, context.enabled);
                return;
            }
            if (action === 'admin_assign') {
                const context = this.actionContext;
                if (this.ctx && typeof this.ctx.closeActionSheet === 'function') this.ctx.closeActionSheet();
                this.assignAdmin(context.username);
                return;
            }
            if (action === 'admin_revoke') {
                const context = this.actionContext;
                if (this.ctx && typeof this.ctx.closeActionSheet === 'function') this.ctx.closeActionSheet();
                this.revokeAdmin(context.username);
                return;
            }
            if (action === 'member_remove') {
                const context = this.actionContext;
                if (this.ctx && typeof this.ctx.closeActionSheet === 'function') this.ctx.closeActionSheet();
                this.removeMember(context.conversationId, context.username);
                return;
            }
            if (action === 'member_unmute') {
                const context = this.actionContext;
                if (this.ctx && typeof this.ctx.closeActionSheet === 'function') this.ctx.closeActionSheet();
                this.unmuteMember(context.conversationId, context.username);
                return;
            }
            if (action === 'member_mute') {
                this.openMuteDurationSheet();
                return;
            }
            const muteOption = MUTE_DURATIONS.find(function(item) { return item.key === action; });
            if (muteOption) {
                const context = this.actionContext;
                if (this.ctx && typeof this.ctx.closeActionSheet === 'function') this.ctx.closeActionSheet();
                this.muteMember(context.conversationId, context.username, muteOption.seconds);
            }
        },

        removeMember(conversationId, username) {
            this.executeMemberRequest('/sessions/members/remove', conversationId, { usernames: [username] }, '移除成员失败');
        },

        muteMember(conversationId, username, durationSeconds) {
            this.executeMemberRequest('/sessions/members/mute', conversationId, { username: username, duration_seconds: durationSeconds }, '禁言成员失败');
        },

        unmuteMember(conversationId, username) {
            this.executeMemberRequest('/sessions/members/unmute', conversationId, { username: username }, '解除禁言失败');
        },

        executeMemberRequest(path, conversationId, payload, fallbackMessage) {
            if (!this.ctx || typeof this.ctx.request !== 'function') return;
            const targetConversationId = Number(conversationId || 0);
            if (!targetConversationId) return;
            const self = this;
            this.ctx.request(this.ctx.httpRoot + path, {
                method: 'POST',
                body: JSON.stringify(Object.assign({ conversation_id: targetConversationId }, payload || {}))
            }).then(function() {
                return self.refreshAfterAction(targetConversationId);
            }).catch(function(error) {
                if (self.ctx && typeof self.ctx.openDialog === 'function') {
                    self.ctx.openDialog({ title: '操作失败', message: error && error.message ? error.message : fallbackMessage, confirmText: '知道了', showCancel: false });
                }
            });
        },

        handleComposerCommand(content) {
            const state = this.getState();
            const activeSession = this.ctx && typeof this.ctx.getActiveSession === 'function' ? this.ctx.getActiveSession() : null;
            const text = String(content || '').trim();
            if (!state || !activeSession || !this.ctx || typeof this.ctx.isGroupSession !== 'function' || !this.ctx.isGroupSession(activeSession)) return false;
            const conversationId = Number(activeSession.conversation_id || state.activeConversationId || 0);
            const myRole = String(activeSession.my_role || '').trim().toLowerCase();
            const canToggle = !!activeSession.can_toggle_all_mute || myRole === 'owner' || myRole === 'admin';
            if (!conversationId || !canToggle) return false;
            if (text === '开启全体禁言') {
                this.toggleAllMute(conversationId, true);
                return true;
            }
            if (text === '关闭全体禁言') {
                this.toggleAllMute(conversationId, false);
                return true;
            }
            return false;
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.groupAdmins = groupAdminsModule;
})(window);
