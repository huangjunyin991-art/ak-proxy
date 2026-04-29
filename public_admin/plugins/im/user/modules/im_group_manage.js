(function(global) {
    'use strict';

    const groupManageModule = {
        ctx: null,

        init(ctx) {
            this.ctx = ctx || null;
        },

        normalizePromptUsernames(raw) {
            const unique = [];
            const seen = {};
            String(raw || '').split(/[\s,，;；、\n\r\t]+/).forEach(function(item) {
                const value = String(item || '').trim().toLowerCase();
                if (!value || seen[value]) return;
                seen[value] = true;
                unique.push(value);
            });
            return unique;
        },

        getGroupMemberRoleLabel(role) {
            const key = String(role || '').trim().toLowerCase();
            if (key === 'owner') return '群主';
            if (key === 'admin') return '管理员';
            return '';
        },

        getMemberDisplayName(member, fallbackText) {
            const displayName = String(member && (member.display_name || member.displayName) || '').trim();
            const username = String(member && member.username || '').trim();
            return displayName || username || String(fallbackText || '成员');
        },

        getMemberHonorName(member) {
            return String(member && (member.honor_name || member.honorName) || '').trim();
        },

        buildMemberDisplayMarkup(member, fallbackText) {
            const displayName = this.getMemberDisplayName(member, fallbackText);
            const honorName = this.getMemberHonorName(member);
            if (this.ctx && typeof this.ctx.buildDisplayNameWithHonorMarkup === 'function') {
                return this.ctx.buildDisplayNameWithHonorMarkup(displayName, honorName, fallbackText || '成员');
            }
            const escapeHtml = this.ctx && typeof this.ctx.escapeHtml === 'function' ? this.ctx.escapeHtml : function(text) {
                return String(text || '');
            };
            return escapeHtml(displayName);
        },

        buildMemberActionCandidateNameMarkup(candidate) {
            return this.buildMemberDisplayMarkup(candidate, '成员');
        },

        formatMemberActionCandidateLabel(candidate) {
            const displayName = this.getMemberDisplayName(candidate, '成员');
            const username = String(candidate && candidate.username || '').trim();
            const honorName = this.getMemberHonorName(candidate);
            if (this.ctx && typeof this.ctx.formatUserDisplayText === 'function') {
                return this.ctx.formatUserDisplayText(displayName, username, honorName, '成员');
            }
            if (displayName && username && displayName.toLowerCase() !== username.toLowerCase()) {
                return honorName ? (displayName + ' [' + honorName + '] @' + username) : (displayName + ' @' + username);
            }
            return honorName ? ((displayName || username || '成员') + ' [' + honorName + ']') : (displayName || username || '成员');
        },

        formatMemberActionCandidateSummary(candidates) {
            const self = this;
            const names = (Array.isArray(candidates) ? candidates : []).map(function(candidate) {
                return self.formatMemberActionCandidateLabel(candidate);
            }).filter(Boolean);
            if (!names.length) return '暂无成员';
            if (names.length <= 3) return names.join('、');
            return names.slice(0, 3).join('、') + ' 等 ' + names.length + ' 人';
        },

        getMemberActionConfig(mode) {
            const httpRoot = this.ctx && this.ctx.httpRoot ? this.ctx.httpRoot : '';
            const self = this;
            if (mode === 'remove') {
                return {
                    title: '移除成员',
                    selectedTitle: '已选择移除成员',
                    listTitle: '全部成员',
                    emptyText: '当前没有可移除的成员',
                    submitText: '确认移除',
                    submittingText: '正在移除...',
                    confirmTitle: '确认移除成员？',
                    confirmText: '移除',
                    errorMessage: '移除成员失败',
                    buildRequestBody: function(conversationId, usernames) {
                        return { conversation_id: conversationId, usernames: usernames };
                    },
                    requestUrl: httpRoot + '/sessions/members/remove',
                    buildConfirmMessage: function(candidates) {
                        return '移除后，这些成员将退出当前群聊。\n\n已选择：' + self.formatMemberActionCandidateSummary(candidates);
                    }
                };
            }
            if (mode === 'clear_member_history') {
                return {
                    title: '清空指定成员聊天记录',
                    selectedTitle: '已选择清空聊天记录成员',
                    listTitle: '全部成员',
                    emptyText: '当前没有可清空聊天记录的成员',
                    submitText: '确认清空',
                    submittingText: '正在清空...',
                    confirmTitle: '确认清空指定成员聊天记录？',
                    confirmText: '清空',
                    errorMessage: '清空指定成员聊天记录失败',
                    buildRequestBody: function(conversationId, usernames) {
                        return { conversation_id: conversationId, usernames: usernames };
                    },
                    requestUrl: httpRoot + '/sessions/history/clear-member',
                    buildConfirmMessage: function(candidates) {
                        return '将删除所选成员在本群发送过的全部消息。\n\n已选择：' + self.formatMemberActionCandidateSummary(candidates);
                    }
                };
            }
            return null;
        },

        buildMemberActionCandidates(detail, mode) {
            if (!this.ctx || typeof this.ctx.sortGroupMembersForDisplay !== 'function') return [];
            const self = this;
            const members = this.ctx.sortGroupMembersForDisplay(Array.isArray(detail && detail.members) ? detail.members : []);
            const authorSet = {};
            (Array.isArray(detail && detail.message_authors) ? detail.message_authors : []).forEach(function(item) {
                const username = String(item && item.username || '').trim().toLowerCase();
                if (username) authorSet[username] = true;
            });
            return members.map(function(member) {
                const username = String(member && member.username || '').trim().toLowerCase();
                const displayName = self.getMemberDisplayName(member, '成员');
                const role = String(member && member.role || '').trim().toLowerCase();
                let disabledReason = '';
                if (!username) {
                    disabledReason = '账号无效';
                } else if (mode === 'remove') {
                    if (role === 'owner') disabledReason = '群主不可移除';
                    else if (role === 'admin') disabledReason = '管理员不可移除';
                } else if (mode === 'clear_member_history' && !authorSet[username]) {
                    disabledReason = '无聊天记录';
                }
                return {
                    username: username,
                    displayName: displayName,
                    honorName: self.getMemberHonorName(member),
                    avatarUrl: typeof self.ctx.getAvatarUrl === 'function' ? self.ctx.getAvatarUrl(member && member.avatar_url) : String(member && member.avatar_url || ''),
                    role: role,
                    roleLabel: self.getGroupMemberRoleLabel(role),
                    disabledReason: disabledReason,
                    selectable: !disabledReason,
                    searchText: (displayName + '\n' + username + '\n' + self.getMemberHonorName(member)).toLowerCase()
                };
            });
        },

        getActiveMemberActionDetail() {
            const state = this.ctx && this.ctx.state;
            const conversationId = Number(state && state.memberActionConversationId || 0);
            if (!conversationId) return null;
            if (Number(state.groupSettingsConversationId || 0) !== conversationId) return null;
            return state.groupSettingsData;
        },

        getMemberActionCandidates() {
            const detail = this.getActiveMemberActionDetail();
            if (!detail) return [];
            return this.buildMemberActionCandidates(detail, this.ctx && this.ctx.state ? this.ctx.state.memberActionMode : '');
        },

        syncMemberActionSelection(candidates) {
            const state = this.ctx && this.ctx.state;
            if (!state) return [];
            const allowedMap = {};
            (Array.isArray(candidates) ? candidates : []).forEach(function(candidate) {
                if (candidate && candidate.selectable && candidate.username) allowedMap[candidate.username] = true;
            });
            const currentSelected = Array.isArray(state.memberActionSelectedUsernames) ? state.memberActionSelectedUsernames : [];
            const nextSelected = currentSelected.filter(function(username) {
                return !!allowedMap[username];
            });
            if (nextSelected.length !== currentSelected.length) {
                state.memberActionSelectedUsernames = nextSelected;
            }
            return nextSelected;
        },

        filterMemberActionCandidates(candidates, keyword) {
            const normalizedKeyword = String(keyword || '').trim().toLowerCase();
            if (!normalizedKeyword) return Array.isArray(candidates) ? candidates : [];
            return (Array.isArray(candidates) ? candidates : []).filter(function(candidate) {
                return String(candidate && candidate.searchText || '').indexOf(normalizedKeyword) >= 0;
            });
        },

        showSettingsErrorDialog(message) {
            if (this.ctx && typeof this.ctx.openDialog === 'function') {
                this.ctx.openDialog({
                    title: '操作失败',
                    message: message,
                    confirmText: '我知道了',
                    showCancel: false,
                    danger: false
                });
                return;
            }
            window.alert(String(message || '操作失败'));
        },

        executeSettingsDialogRequest(requestPromiseFactory, onSuccess, fallbackMessage, onError) {
            if (!this.ctx || !this.ctx.state) return Promise.resolve(null);
            const self = this;
            const state = this.ctx.state;
            state.dialogSubmitting = true;
            if (typeof this.ctx.renderDialog === 'function') this.ctx.renderDialog();
            return Promise.resolve().then(requestPromiseFactory).then(function() {
                return typeof onSuccess === 'function' ? onSuccess() : null;
            }).then(function(result) {
                if (typeof self.ctx.closeDialog === 'function') self.ctx.closeDialog({ silent: true, force: true });
                if (typeof self.ctx.render === 'function') self.ctx.render();
                return result;
            }).catch(function(error) {
                const message = error && error.message ? error.message : fallbackMessage;
                if (typeof self.ctx.closeDialog === 'function') self.ctx.closeDialog({ silent: true, force: true });
                if (typeof onError === 'function' && onError(message) === true) {
                    if (typeof self.ctx.render === 'function') self.ctx.render();
                    return null;
                }
                self.showSettingsErrorDialog(message);
                return null;
            });
        },

        submitMemberActionPage() {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const config = this.getMemberActionConfig(state.memberActionMode);
            const conversationId = Number(state.memberActionConversationId || 0);
            if (!config || !conversationId) return;
            const candidates = this.getMemberActionCandidates();
            const selectedUsernames = this.syncMemberActionSelection(candidates);
            const candidateMap = {};
            candidates.forEach(function(candidate) {
                if (candidate && candidate.username) candidateMap[candidate.username] = candidate;
            });
            const selectedCandidates = selectedUsernames.map(function(username) {
                return candidateMap[username] || null;
            }).filter(Boolean);
            if (!selectedCandidates.length) {
                state.memberActionError = '请至少选择一名成员';
                if (typeof this.ctx.renderMemberActionPage === 'function') this.ctx.renderMemberActionPage();
                return;
            }
            state.memberActionError = '';
            if (typeof this.ctx.openDialog !== 'function') return;
            this.ctx.openDialog({
                title: config.confirmTitle,
                message: config.buildConfirmMessage(selectedCandidates),
                confirmText: config.confirmText,
                cancelText: '取消',
                danger: true,
                action: 'member_action_submit',
                payload: {
                    mode: state.memberActionMode,
                    conversationId: conversationId,
                    usernames: selectedCandidates.map(function(candidate) {
                        return candidate.username;
                    })
                }
            });
        },

        executeMemberActionRequest(payload) {
            if (!this.ctx || !this.ctx.state || typeof this.ctx.request !== 'function') return;
            const self = this;
            const state = this.ctx.state;
            const mode = String(payload && payload.mode || '');
            const conversationId = Number(payload && payload.conversationId || 0);
            const config = this.getMemberActionConfig(mode);
            const usernames = Array.isArray(payload && payload.usernames) ? payload.usernames : [];
            if (!config || !conversationId || !usernames.length) {
                if (typeof this.ctx.closeDialog === 'function') this.ctx.closeDialog({ force: true });
                return;
            }
            state.memberActionSubmitting = true;
            if (typeof this.ctx.renderMemberActionPage === 'function') this.ctx.renderMemberActionPage();
            this.executeSettingsDialogRequest(function() {
                return self.ctx.request(config.requestUrl, {
                    method: 'POST',
                    body: JSON.stringify(config.buildRequestBody(conversationId, usernames))
                });
            }, function() {
                return self.refreshAfterSettingsAction(conversationId).then(function() {
                    if (typeof self.ctx.closeMemberActionPage === 'function') {
                        self.ctx.closeMemberActionPage({ silent: true, fallbackView: 'group_info' });
                    }
                });
            }, config.errorMessage, function(message) {
                state.memberActionSubmitting = false;
                state.memberActionError = message;
                if (typeof self.ctx.renderMemberActionPage === 'function') self.ctx.renderMemberActionPage();
                return true;
            });
        },

        executeClearHistoryRequest(conversationId) {
            if (!this.ctx || typeof this.ctx.request !== 'function') return;
            const self = this;
            this.executeSettingsDialogRequest(function() {
                return self.ctx.request(self.ctx.httpRoot + '/sessions/history/clear', {
                    method: 'POST',
                    body: JSON.stringify({ conversation_id: conversationId })
                });
            }, function() {
                return self.refreshAfterSettingsAction(conversationId);
            }, '清空全群聊天记录失败');
        },

        executeHideGroupRequest(conversationId) {
            if (!this.ctx || typeof this.ctx.request !== 'function') return;
            const self = this;
            this.executeSettingsDialogRequest(function() {
                return self.ctx.request(self.ctx.httpRoot + '/sessions/hide', {
                    method: 'POST',
                    body: JSON.stringify({ conversation_id: conversationId })
                });
            }, function() {
                if (typeof self.ctx.closeSettingsPanel === 'function') self.ctx.closeSettingsPanel();
                if (typeof self.ctx.loadSessions === 'function') return self.ctx.loadSessions();
                return null;
            }, '隐藏本群失败');
        },

        handleDialogAction(action, payload) {
            if (action === 'member_action_submit') {
                this.executeMemberActionRequest(payload || null);
                return true;
            }
            if (action === 'clear_history') {
                this.executeClearHistoryRequest(Number(payload && payload.conversationId || 0));
                return true;
            }
            if (action === 'hide_group') {
                this.executeHideGroupRequest(Number(payload && payload.conversationId || 0));
                return true;
            }
            return false;
        },

        formatGroupInfoMemberText(member, fallbackText) {
            const displayName = this.getMemberDisplayName(member, fallbackText);
            const username = String(member && member.username || '').trim();
            const honorName = this.getMemberHonorName(member);
            if (this.ctx && typeof this.ctx.formatUserDisplayText === 'function') {
                return this.ctx.formatUserDisplayText(displayName, username, honorName, fallbackText || '暂无');
            }
            if (displayName && username && displayName !== username) return honorName ? (displayName + ' [' + honorName + '] @' + username) : (displayName + ' @' + username);
            return honorName ? ((displayName || username || String(fallbackText || '暂无')) + ' [' + honorName + ']') : (displayName || username || String(fallbackText || '暂无'));
        },

        formatGroupInfoMemberMarkup(member, fallbackText) {
            const displayName = this.getMemberDisplayName(member, fallbackText);
            const username = String(member && member.username || '').trim();
            const escapeHtml = this.ctx && typeof this.ctx.escapeHtml === 'function' ? this.ctx.escapeHtml : function(text) {
                return String(text || '');
            };
            const nameMarkup = this.buildMemberDisplayMarkup(member, fallbackText || '暂无');
            if (displayName && username && displayName !== username) {
                return '<span class="ak-im-group-info-member-inline">' + nameMarkup + '<span class="ak-im-group-info-member-username">@' + escapeHtml(username) + '</span></span>';
            }
            return nameMarkup;
        },

        formatGroupInfoCollectionText(members, emptyText) {
            const self = this;
            const names = (Array.isArray(members) ? members : []).map(function(member) {
                return self.formatGroupInfoMemberText(member, '');
            }).filter(Boolean);
            if (!names.length) return String(emptyText || '暂无');
            if (names.length <= 3) return names.join('、');
            return names.slice(0, 3).join('、') + ' 等 ' + names.length + ' 人';
        },

        formatGroupInfoCollectionMarkup(members, emptyText) {
            const self = this;
            const escapeHtml = this.ctx && typeof this.ctx.escapeHtml === 'function' ? this.ctx.escapeHtml : function(text) {
                return String(text || '');
            };
            const items = (Array.isArray(members) ? members : []).map(function(member) {
                return self.formatGroupInfoMemberMarkup(member, '');
            }).filter(Boolean);
            if (!items.length) return escapeHtml(String(emptyText || '暂无'));
            if (items.length <= 3) return items.join('<span class="ak-im-inline-sep">、</span>');
            return items.slice(0, 3).join('<span class="ak-im-inline-sep">、</span>') + '<span class="ak-im-group-info-collection-more"> 等 ' + escapeHtml(String(items.length)) + ' 人</span>';
        },

        buildGroupInfoCell(label, value, action, extraClass, allowValueMarkup) {
            const escapeHtml = this.ctx && typeof this.ctx.escapeHtml === 'function' ? this.ctx.escapeHtml : function(text) {
                return String(text || '');
            };
            const className = 'ak-im-group-info-cell' + (action ? ' is-action' : '') + (extraClass ? ' ' + extraClass : '');
            const tagName = action ? 'button' : 'div';
            return '<' + tagName + ' class="' + className + '"' + (action ? ' type="button" data-im-settings-action="' + action + '"' : '') + '>' +
                '<div class="ak-im-group-info-cell-main"><div class="ak-im-group-info-cell-label">' + escapeHtml(label) + '</div>' +
                (value ? '<div class="ak-im-group-info-cell-value">' + (allowValueMarkup ? value : escapeHtml(value)) + '</div>' : '') +
                '</div>' + (action ? '<div class="ak-im-group-info-cell-arrow">›</div>' : '') + '</' + tagName + '>';
        },

        loadGroupSettings(conversationId) {
            if (!this.ctx || !this.ctx.state || typeof this.ctx.request !== 'function') return Promise.resolve(null);
            const self = this;
            const state = this.ctx.state;
            const targetConversationId = Number(conversationId || 0);
            if (!targetConversationId) return Promise.resolve(null);
            state.groupSettingsLoading = true;
            state.groupSettingsError = '';
            state.groupSettingsConversationId = targetConversationId;
            if (typeof this.ctx.renderSettingsPanel === 'function') this.ctx.renderSettingsPanel();
            return this.ctx.request(this.ctx.httpRoot + '/sessions/group_profile?conversation_id=' + encodeURIComponent(targetConversationId)).then(function(data) {
                if (Number(state.groupSettingsConversationId || 0) !== targetConversationId) return null;
                state.groupSettingsLoading = false;
                state.groupSettingsData = data && data.item ? data.item : null;
                if (typeof self.ctx.renderSettingsPanel === 'function') self.ctx.renderSettingsPanel();
                return state.groupSettingsData;
            }).catch(function(error) {
                if (Number(state.groupSettingsConversationId || 0) !== targetConversationId) return null;
                state.groupSettingsLoading = false;
                state.groupSettingsError = error && error.message ? error.message : '读取群信息失败';
                if (typeof self.ctx.renderSettingsPanel === 'function') self.ctx.renderSettingsPanel();
                return null;
            });
        },

        refreshAfterSettingsAction(conversationId) {
            if (!this.ctx) return Promise.resolve(null);
            const self = this;
            return Promise.resolve(typeof this.ctx.loadSessions === 'function' ? this.ctx.loadSessions() : null).then(function() {
                if (Number(self.ctx.state && self.ctx.state.activeConversationId || 0) === Number(conversationId || 0) && typeof self.ctx.loadMessages === 'function') {
                    return self.ctx.loadMessages(conversationId);
                }
                return null;
            }).then(function() {
                const state = self.ctx && self.ctx.state;
                if (state && state.groupSettingsOpen && Number(state.groupSettingsConversationId || 0) === Number(conversationId || 0)) {
                    return self.loadGroupSettings(conversationId);
                }
                return null;
            });
        },

        handleSettingsAction(action) {
            if (!this.ctx || !this.ctx.state || typeof this.ctx.request !== 'function') return;
            const self = this;
            const state = this.ctx.state;
            const conversationId = Number(state.groupSettingsConversationId || 0);
            const detail = state.groupSettingsData;
            if (!conversationId || !detail || !detail.can_manage) return;
            if (action === 'edit_title') {
                if (typeof this.ctx.openGroupTitleEditPage === 'function') this.ctx.openGroupTitleEditPage();
                return;
            }
            if (action === 'add') {
                const raw = window.prompt('输入要添加的账号，多个账号可用空格、逗号或换行分隔', '');
                const usernames = this.normalizePromptUsernames(raw);
                if (!usernames.length) return;
                this.ctx.request(this.ctx.httpRoot + '/sessions/members/add', {
                    method: 'POST',
                    body: JSON.stringify({ conversation_id: conversationId, usernames: usernames })
                }).then(function() {
                    return self.refreshAfterSettingsAction(conversationId);
                }).catch(function(error) {
                    window.alert(error && error.message ? error.message : '添加成员失败');
                });
                return;
            }
            if (action === 'remove') {
                if (typeof this.ctx.openMemberActionPage === 'function') this.ctx.openMemberActionPage('remove');
                return;
            }
            if (action === 'clear_member_history') {
                if (typeof this.ctx.openMemberActionPage === 'function') this.ctx.openMemberActionPage('clear_member_history');
                return;
            }
            if (action === 'clear_history') {
                if (typeof this.ctx.openDialog === 'function') {
                    this.ctx.openDialog({
                        title: '清空全群聊天记录？',
                        message: '清空后，本群现有聊天记录会立即对所有成员生效。',
                        confirmText: '清空',
                        cancelText: '取消',
                        danger: true,
                        action: 'clear_history',
                        payload: { conversationId: conversationId }
                    });
                }
                return;
            }
            if (action === 'hide_group' && typeof this.ctx.openDialog === 'function') {
                this.ctx.openDialog({
                    title: '隐藏本群？',
                    message: '隐藏后，本群会对所有成员生效。',
                    confirmText: '隐藏',
                    cancelText: '取消',
                    danger: true,
                    action: 'hide_group',
                    payload: { conversationId: conversationId }
                });
            }
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.groupManage = groupManageModule;
})(window);
