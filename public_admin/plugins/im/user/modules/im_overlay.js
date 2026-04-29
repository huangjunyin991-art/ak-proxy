(function(global) {
    'use strict';

    const overlayModule = {
        ctx: null,
        eventsBound: false,

        init(ctx) {
            this.ctx = ctx || null;
            this.eventsBound = false;
        },

        getElements() {
            return this.ctx && this.ctx.elements ? this.ctx.elements : {};
        },

        getProgressPercent(summary) {
            const percent = Number(summary && summary.progress_percent || 0) || 0;
            return Math.max(0, Math.min(100, Math.round(percent)));
        },

        renderOverlays() {
            this.renderActionSheet();
            this.renderReadProgressPanel();
            this.renderSettingsPanel();
            this.renderMemberActionPage();
            this.renderDialog();
        },

        renderActionSheet() {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const elements = this.getElements();
            const actionSheetEl = elements.actionSheetEl;
            const actionSheetRecallBtn = elements.actionSheetRecallBtn;
            const actionSheetCancelBtn = elements.actionSheetCancelBtn;
            if (!actionSheetEl || !actionSheetRecallBtn || !actionSheetCancelBtn) return;
            Array.prototype.forEach.call(actionSheetEl.querySelectorAll('[data-im-dynamic-action]'), function(button) {
                if (button && button.parentNode) button.parentNode.removeChild(button);
            });
            const customActions = Array.isArray(state.actionSheetCustomActions) ? state.actionSheetCustomActions : [];
            if ((state.actionSheetMode === 'group_member' || state.actionSheetMode === 'group_mute_duration') && customActions.length) {
                const firstAction = customActions[0] || {};
                actionSheetRecallBtn.classList.toggle('danger', !!firstAction.danger);
                actionSheetRecallBtn.textContent = String(firstAction.label || '操作');
                actionSheetRecallBtn.disabled = !!firstAction.disabled;
                actionSheetCancelBtn.textContent = '取消';
                const panel = actionSheetCancelBtn.parentNode;
                const self = this;
                customActions.slice(1).forEach(function(action) {
                    const button = document.createElement('button');
                    button.className = 'ak-im-action-btn' + (action && action.danger ? ' danger' : '');
                    button.type = 'button';
                    button.textContent = String(action && action.label || '操作');
                    button.disabled = !!(action && action.disabled);
                    button.setAttribute('data-im-dynamic-action', String(action && action.key || ''));
                    button.addEventListener('click', function() {
                        if (typeof self.ctx.onActionSheetCustom === 'function') self.ctx.onActionSheetCustom(button.getAttribute('data-im-dynamic-action'));
                    });
                    panel.insertBefore(button, actionSheetCancelBtn);
                });
            } else if (state.actionSheetMode === 'group_menu') {
                actionSheetRecallBtn.classList.remove('danger');
                actionSheetRecallBtn.textContent = '群成员';
                actionSheetRecallBtn.disabled = !state.actionSheetConversationId;
                actionSheetCancelBtn.textContent = '群设置';
            } else if (state.actionSheetMode === 'session') {
                actionSheetRecallBtn.classList.remove('danger');
                if (state.actionSheetSessionSystemPinned) {
                    actionSheetRecallBtn.textContent = '系统置顶';
                    actionSheetRecallBtn.disabled = true;
                } else {
                    actionSheetRecallBtn.textContent = state.actionSheetSessionPinned ? '取消置顶' : '置顶聊天';
                    actionSheetRecallBtn.disabled = !state.actionSheetConversationId;
                }
                actionSheetCancelBtn.textContent = '取消';
            } else if (state.actionSheetMode === 'contact_blacklist_add') {
                actionSheetRecallBtn.classList.add('danger');
                actionSheetRecallBtn.textContent = '加入黑名单';
                actionSheetRecallBtn.disabled = !String(state.actionSheetContactUsername || '').trim();
                actionSheetCancelBtn.textContent = '取消';
            } else if (state.actionSheetMode === 'contact_blacklist_remove') {
                actionSheetRecallBtn.classList.add('danger');
                actionSheetRecallBtn.textContent = '移出黑名单';
                actionSheetRecallBtn.disabled = !String(state.actionSheetContactUsername || '').trim();
                actionSheetCancelBtn.textContent = '取消';
            } else {
                actionSheetRecallBtn.classList.add('danger');
                actionSheetRecallBtn.textContent = '撤回';
                actionSheetRecallBtn.disabled = !state.actionSheetCanRecall;
                actionSheetCancelBtn.textContent = '取消';
            }
            const isOpen = !!state.actionSheetOpen;
            actionSheetEl.classList.toggle('visible', isOpen);
            if (!isOpen) {
                const activeElement = document.activeElement;
                if (activeElement && actionSheetEl.contains(activeElement) && typeof activeElement.blur === 'function') {
                    activeElement.blur();
                }
                actionSheetEl.setAttribute('inert', '');
                actionSheetEl.setAttribute('aria-hidden', 'true');
                return;
            }
            actionSheetEl.removeAttribute('inert');
            actionSheetEl.setAttribute('aria-hidden', 'false');
        },

        openActionSheet(messageItem) {
            if (!this.ctx || !this.ctx.state) return;
            const elements = this.getElements();
            if (!elements.actionSheetEl) return;
            const state = this.ctx.state;
            state.actionSheetMode = 'message';
            state.actionSheetOpen = true;
            state.actionSheetMessageId = Number(messageItem && messageItem.id || 0);
            state.actionSheetConversationId = Number(messageItem && messageItem.conversation_id || state.activeConversationId || 0);
            state.actionSheetCanRecall = this.ctx.canRecallMessage(messageItem);
            state.actionSheetDraftText = String(messageItem && (messageItem.content || messageItem.content_preview || '') || '');
            state.actionSheetSessionPinned = false;
            state.actionSheetSessionSystemPinned = false;
            state.actionSheetContactUsername = '';
            this.renderActionSheet();
        },

        openSessionActionSheet(sessionItem) {
            if (!this.ctx || !this.ctx.state) return;
            const elements = this.getElements();
            if (!elements.actionSheetEl || !sessionItem) return;
            const state = this.ctx.state;
            const sessionManage = this.ctx.sessionManage;
            state.actionSheetMode = 'session';
            state.actionSheetOpen = true;
            state.actionSheetMessageId = 0;
            state.actionSheetConversationId = Number(sessionItem.conversation_id || 0);
            state.actionSheetCanRecall = false;
            state.actionSheetDraftText = '';
            state.actionSheetSessionPinned = !!(sessionManage && typeof sessionManage.isSessionPinned === 'function' ? sessionManage.isSessionPinned(sessionItem) : false);
            state.actionSheetSessionSystemPinned = !!(sessionManage && typeof sessionManage.isSessionSystemPinned === 'function' ? sessionManage.isSessionSystemPinned(sessionItem) : false);
            state.actionSheetContactUsername = '';
            this.renderActionSheet();
        },

        openContactActionSheet(contactItem, mode) {
            if (!this.ctx || !this.ctx.state) return;
            const elements = this.getElements();
            if (!elements.actionSheetEl) return;
            const state = this.ctx.state;
            const username = this.ctx.getContactUsername(contactItem);
            if (!username) return;
            state.actionSheetMode = mode === 'contact_blacklist_remove' ? 'contact_blacklist_remove' : 'contact_blacklist_add';
            state.actionSheetOpen = true;
            state.actionSheetMessageId = 0;
            state.actionSheetConversationId = 0;
            state.actionSheetCanRecall = false;
            state.actionSheetDraftText = '';
            state.actionSheetSessionPinned = false;
            state.actionSheetSessionSystemPinned = false;
            state.actionSheetContactUsername = username;
            this.renderActionSheet();
        },

        closeActionSheet() {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            state.actionSheetOpen = false;
            state.actionSheetMessageId = 0;
            state.actionSheetConversationId = 0;
            state.actionSheetCanRecall = false;
            state.actionSheetDraftText = '';
            state.actionSheetMode = '';
            state.actionSheetCustomActions = [];
            state.actionSheetSessionPinned = false;
            state.actionSheetSessionSystemPinned = false;
            state.actionSheetContactUsername = '';
            this.renderActionSheet();
        },

        formatReadProgressMember(member) {
            const displayName = String(member && member.display_name || '').trim();
            const username = String(member && member.username || '').trim();
            const honorName = String(member && member.honor_name || '').trim();
            const nameMarkup = this.ctx && typeof this.ctx.buildDisplayNameWithHonorMarkup === 'function'
                ? this.ctx.buildDisplayNameWithHonorMarkup(displayName || username || '未知成员', honorName, '未知成员')
                : this.ctx.escapeHtml(displayName || username || '未知成员');
            if (displayName && username && displayName !== username) {
                return '<span class="ak-im-progress-member-name">' + nameMarkup + '</span><span class="ak-im-progress-member-username">@' + this.ctx.escapeHtml(username) + '</span>';
            }
            return '<span class="ak-im-progress-member-name">' + nameMarkup + '</span>';
        },

        renderReadProgressPanel() {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const elements = this.getElements();
            const progressPanelEl = elements.progressPanelEl;
            const progressPanelBodyEl = elements.progressPanelBodyEl;
            if (!progressPanelEl || !progressPanelBodyEl) return;
            const isOpen = !!state.readProgressOpen;
            progressPanelEl.classList.toggle('visible', isOpen);
            if (!isOpen) {
                const activeElement = document.activeElement;
                if (activeElement && progressPanelEl.contains(activeElement) && typeof activeElement.blur === 'function') {
                    activeElement.blur();
                }
                progressPanelEl.setAttribute('inert', '');
                progressPanelEl.setAttribute('aria-hidden', 'true');
                progressPanelBodyEl.innerHTML = '';
                return;
            }
            progressPanelEl.removeAttribute('inert');
            progressPanelEl.setAttribute('aria-hidden', 'false');
            if (state.readProgressLoading) {
                progressPanelBodyEl.innerHTML = '<div class="ak-im-progress-loading">正在加载消息读进度...</div>';
                return;
            }
            if (state.readProgressError) {
                progressPanelBodyEl.innerHTML = '<div class="ak-im-progress-error">' + this.ctx.escapeHtml(state.readProgressError) + '</div>';
                return;
            }
            const detail = state.readProgressData;
            const summary = detail && detail.read_progress && typeof detail.read_progress === 'object' ? detail.read_progress : null;
            if (!detail || !summary) {
                progressPanelBodyEl.innerHTML = '<div class="ak-im-progress-empty">暂无可用的读进度数据</div>';
                return;
            }
            const unreadMembers = Array.isArray(detail.unread_members) ? detail.unread_members : [];
            const unreadList = unreadMembers.length ? unreadMembers.map(this.formatReadProgressMember.bind(this)).map(function(markup) {
                return '<div class="ak-im-progress-member"><div>' + markup + '</div></div>';
            }).join('') : '<div class="ak-im-progress-empty">全部成员已读</div>';
            progressPanelBodyEl.innerHTML = '<div class="ak-im-progress-summary">' +
                '<div class="ak-im-progress-stat"><div class="ak-im-progress-stat-value">' + this.ctx.escapeHtml(String(this.getProgressPercent(summary))) + '%</div><div class="ak-im-progress-stat-label">已读进度</div></div>' +
                '<div class="ak-im-progress-stat"><div class="ak-im-progress-stat-value">' + this.ctx.escapeHtml(String(Number(summary.read_count || 0))) + '</div><div class="ak-im-progress-stat-label">已读人数</div></div>' +
                '<div class="ak-im-progress-stat"><div class="ak-im-progress-stat-value">' + this.ctx.escapeHtml(String(Number(summary.unread_count || 0))) + '</div><div class="ak-im-progress-stat-label">未读人数</div></div>' +
            '</div>' +
            '<div class="ak-im-progress-list"><h4 class="ak-im-progress-list-title">未读成员（共 ' + this.ctx.escapeHtml(String(Number(summary.unread_count || 0))) + ' 人）</h4>' + unreadList + '</div>';
        },

        openReadProgressPanel(messageItem) {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const messageId = Number(messageItem && messageItem.id || 0);
            if (!messageId) return;
            if (typeof this.ctx.closeMemberPanel === 'function') this.ctx.closeMemberPanel();
            if (typeof this.ctx.closeSettingsPanel === 'function') this.ctx.closeSettingsPanel({ silent: true });
            state.readProgressOpen = true;
            state.readProgressLoading = true;
            state.readProgressError = '';
            state.readProgressMessageId = messageId;
            state.readProgressData = null;
            this.renderReadProgressPanel();
            this.ctx.request(this.ctx.httpRoot + '/messages/read_progress?message_id=' + encodeURIComponent(messageId)).then(function(data) {
                if (Number(state.readProgressMessageId || 0) !== messageId) return;
                state.readProgressLoading = false;
                state.readProgressData = data && data.item ? data.item : null;
                overlayModule.renderReadProgressPanel();
            }).catch(function(error) {
                if (Number(state.readProgressMessageId || 0) !== messageId) return;
                state.readProgressLoading = false;
                state.readProgressError = error && error.message ? error.message : '读取消息读进度失败';
                overlayModule.renderReadProgressPanel();
            });
        },

        closeReadProgressPanel() {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            state.readProgressOpen = false;
            state.readProgressLoading = false;
            state.readProgressError = '';
            state.readProgressMessageId = 0;
            state.readProgressData = null;
            this.renderReadProgressPanel();
        },

        openDialog(options) {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            state.dialogOpen = true;
            state.dialogTitle = String(options && options.title || '提示');
            state.dialogMessage = String(options && options.message || '');
            state.dialogConfirmText = String(options && options.confirmText || '确定');
            state.dialogCancelText = String(options && options.cancelText || '取消');
            state.dialogDanger = !!(options && options.danger);
            state.dialogShowCancel = options && Object.prototype.hasOwnProperty.call(options, 'showCancel') ? !!options.showCancel : true;
            state.dialogAction = String(options && options.action || '');
            state.dialogSubmitting = false;
            state.dialogPayload = options && options.payload ? options.payload : null;
            this.renderDialog();
        },

        closeDialog(options) {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const silent = !!(options && options.silent);
            const force = !!(options && options.force);
            if (state.dialogSubmitting && !force) return;
            state.dialogOpen = false;
            state.dialogTitle = '';
            state.dialogMessage = '';
            state.dialogConfirmText = '';
            state.dialogCancelText = '';
            state.dialogDanger = false;
            state.dialogShowCancel = true;
            state.dialogAction = '';
            state.dialogSubmitting = false;
            state.dialogPayload = null;
            if (!silent) this.renderDialog();
        },

        renderDialog() {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const elements = this.getElements();
            const dialogEl = elements.dialogEl;
            const dialogTitleEl = elements.dialogTitleEl;
            const dialogMessageEl = elements.dialogMessageEl;
            const dialogCancelBtnEl = elements.dialogCancelBtnEl;
            const dialogConfirmBtnEl = elements.dialogConfirmBtnEl;
            if (!dialogEl || !dialogTitleEl || !dialogMessageEl || !dialogCancelBtnEl || !dialogConfirmBtnEl) return;
            const isOpen = !!state.dialogOpen;
            const actionWrap = dialogEl.querySelector('.ak-im-dialog-actions');
            dialogEl.classList.toggle('visible', isOpen);
            if (!isOpen) {
                const activeElement = document.activeElement;
                if (activeElement && dialogEl.contains(activeElement) && typeof activeElement.blur === 'function') activeElement.blur();
                dialogEl.setAttribute('inert', '');
                dialogEl.setAttribute('aria-hidden', 'true');
                if (actionWrap) actionWrap.classList.remove('is-single');
                return;
            }
            dialogEl.removeAttribute('inert');
            dialogEl.setAttribute('aria-hidden', 'false');
            if (actionWrap) actionWrap.classList.toggle('is-single', !state.dialogShowCancel);
            dialogTitleEl.textContent = state.dialogTitle || '提示';
            dialogMessageEl.textContent = state.dialogMessage || '';
            dialogCancelBtnEl.textContent = state.dialogCancelText || '取消';
            dialogCancelBtnEl.style.display = state.dialogShowCancel ? '' : 'none';
            dialogCancelBtnEl.disabled = !!state.dialogSubmitting;
            dialogConfirmBtnEl.textContent = state.dialogConfirmText || '确定';
            dialogConfirmBtnEl.disabled = !!state.dialogSubmitting;
            dialogConfirmBtnEl.classList.toggle('is-danger', !!state.dialogDanger);
        },

        renderSettingsPanel() {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const elements = this.getElements();
            const settingsPanelBodyEl = elements.settingsPanelBodyEl;
            const groupInfoTitleEl = elements.groupInfoTitleEl;
            if (!elements.settingsPanelEl || !settingsPanelBodyEl) return;
            const escapeHtml = this.ctx.escapeHtml;
            const groupManage = this.ctx.groupManage;
            if (groupInfoTitleEl) groupInfoTitleEl.textContent = '聊天信息';
            if (!state.groupSettingsOpen) {
                settingsPanelBodyEl.innerHTML = '';
                return;
            }
            if (state.groupSettingsLoading) {
                settingsPanelBodyEl.innerHTML = '<div class="ak-im-group-info-loading">正在加载群信息...</div>';
                return;
            }
            if (state.groupSettingsError) {
                settingsPanelBodyEl.innerHTML = '<div class="ak-im-group-info-error">' + escapeHtml(state.groupSettingsError) + '</div>';
                return;
            }
            const detail = state.groupSettingsData;
            if (!groupManage || typeof groupManage.formatGroupInfoMemberText !== 'function' || typeof groupManage.formatGroupInfoCollectionText !== 'function' || typeof groupManage.buildGroupInfoCell !== 'function') {
                settingsPanelBodyEl.innerHTML = '<div class="ak-im-group-info-empty">群设置模块暂不可用，请刷新后重试</div>';
                return;
            }
            if (!detail) {
                settingsPanelBodyEl.innerHTML = '<div class="ak-im-group-info-empty">暂无可用的群信息</div>';
                return;
            }
            const rawMembers = Array.isArray(detail.members) ? detail.members : [];
            const members = this.ctx.sortGroupMembersForDisplay(rawMembers);
            const admins = Array.isArray(detail.admins) ? detail.admins : [];
            const authors = Array.isArray(detail.message_authors) ? detail.message_authors : [];
            const canManage = !!detail.can_manage;
            const memberCount = Math.max(0, Number(detail.member_count || members.length || 0) || 0);
            const showAddMemberTile = canManage && memberCount <= 15;
            const addMemberMarkup = showAddMemberTile ? '<button class="ak-im-member-item is-add" type="button" data-im-settings-action="add"><div class="ak-im-member-honor"></div><div class="ak-im-member-avatar">+</div><div class="ak-im-member-body"><div class="ak-im-member-name">添加</div></div></button>' : '';
            const previewLimit = showAddMemberTile ? 19 : 20;
            const membersExpanded = !!state.groupSettingsMembersExpanded;
            const visibleMembers = membersExpanded ? members : members.slice(0, previewLimit);
            const showMoreMembers = members.length > previewLimit;
            const memberGridMarkup = (visibleMembers.length || addMemberMarkup) ? '<div class="ak-im-member-list">' + visibleMembers.map(this.ctx.formatSessionMember).join('') + addMemberMarkup + '</div>' : '<div class="ak-im-group-info-empty">当前群里还没有成员</div>';
            const ownerText = groupManage.formatGroupInfoMemberText(detail.owner || { username: detail.owner_username }, '暂无群主');
            const adminsText = groupManage.formatGroupInfoCollectionText(admins, '暂无群管理员');
            const authorsText = groupManage.formatGroupInfoCollectionText(authors, '暂无可清空聊天记录成员');
            const ownerMarkup = typeof groupManage.formatGroupInfoMemberMarkup === 'function'
                ? groupManage.formatGroupInfoMemberMarkup(detail.owner || { username: detail.owner_username }, '暂无群主')
                : escapeHtml(ownerText);
            const adminsMarkup = typeof groupManage.formatGroupInfoCollectionMarkup === 'function'
                ? groupManage.formatGroupInfoCollectionMarkup(admins, '暂无群管理员')
                : escapeHtml(adminsText);
            const authorsMarkup = typeof groupManage.formatGroupInfoCollectionMarkup === 'function'
                ? groupManage.formatGroupInfoCollectionMarkup(authors, '暂无可清空聊天记录成员')
                : escapeHtml(authorsText);
            const statusText = detail.hidden_for_all ? '已对全员隐藏' : '正常显示';
            const allMuteText = detail.all_muted ? '已开启' : '未开启';
            const adminsAction = detail.can_manage_admins ? 'admins' : 'admins_view';
            const allMuteAction = detail.can_toggle_all_mute ? 'all_mute' : '';
            if (groupInfoTitleEl) groupInfoTitleEl.textContent = '聊天信息(' + memberCount + ')';
            const heroTitle = String(detail.conversation_title || '群聊');
            const heroMosaicSource = members.length ? members : (detail.owner ? [detail.owner] : []);
            const heroMarkup = '<div class="ak-im-group-info-hero">' +
                '<div class="ak-im-group-info-hero-avatar">' + this.ctx.buildGroupAvatarMosaicMarkup(heroMosaicSource, heroTitle) + '</div>' +
                '<div class="ak-im-group-info-hero-title">' + escapeHtml(heroTitle) + '</div>' +
                '<div class="ak-im-group-info-hero-subtitle">群聊 · ' + memberCount + ' 人</div>' +
            '</div>';
            settingsPanelBodyEl.innerHTML = heroMarkup + '<div class="ak-im-group-info-members">' + memberGridMarkup + (showMoreMembers ? '<button class="ak-im-group-info-more" type="button" data-im-settings-action="toggle_members">' + escapeHtml(membersExpanded ? '收起群成员' : '更多群成员') + '<span aria-hidden="true">⌄</span></button>' : '') + '</div>' +
                '<div class="ak-im-group-info-section">' +
                    groupManage.buildGroupInfoCell('群聊名称', String(detail.conversation_title || '群聊'), canManage ? 'edit_title' : '') +
                    groupManage.buildGroupInfoCell('群主', ownerMarkup, '', '', true) +
                    groupManage.buildGroupInfoCell('群管理员', adminsMarkup, adminsAction, '', true) +
                    groupManage.buildGroupInfoCell('全体禁言', allMuteText, allMuteAction) +
                    groupManage.buildGroupInfoCell('可清空聊天记录成员', authorsMarkup, '', '', true) +
                    groupManage.buildGroupInfoCell('群状态', statusText) +
                '</div>' +
                (canManage ? '<div class="ak-im-group-info-section">' +
                    groupManage.buildGroupInfoCell('添加成员', '', 'add') +
                    groupManage.buildGroupInfoCell('移除成员', '', 'remove') +
                    groupManage.buildGroupInfoCell('清空指定成员聊天记录', '', 'clear_member_history') +
                    groupManage.buildGroupInfoCell('清空全群聊天记录', '', 'clear_history', 'is-danger') +
                    groupManage.buildGroupInfoCell('隐藏本群', '', 'hide_group', 'is-danger') +
                '</div>' : '');
            const self = this;
            Array.prototype.forEach.call(settingsPanelBodyEl.querySelectorAll('[data-im-settings-action]'), function(button) {
                button.addEventListener('click', function() {
                    const action = button.getAttribute('data-im-settings-action');
                    if (action === 'toggle_members') {
                        state.groupSettingsMembersExpanded = !state.groupSettingsMembersExpanded;
                        self.renderSettingsPanel();
                        return;
                    }
                    if (typeof groupManage.handleSettingsAction === 'function') groupManage.handleSettingsAction(action);
                });
            });
            if (typeof groupManage.bindSettingsMemberInteractions === 'function') {
                groupManage.bindSettingsMemberInteractions(settingsPanelBodyEl);
            }
        },

        openSettingsPanel(sessionItem) {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const sessionManage = this.ctx.sessionManage;
            const activeSession = sessionItem || (sessionManage && typeof sessionManage.getActiveSession === 'function' ? sessionManage.getActiveSession() : (typeof this.ctx.getActiveSession === 'function' ? this.ctx.getActiveSession() : null));
            const groupManage = this.ctx.groupManage;
            const conversationId = Number(sessionItem && sessionItem.conversation_id || state.activeConversationId || 0);
            const isGroupSession = sessionManage && typeof sessionManage.isGroupSession === 'function' ? sessionManage.isGroupSession(activeSession) : !!(this.ctx.isGroupSession && this.ctx.isGroupSession(activeSession));
            if (!conversationId || !isGroupSession) return;
            if (typeof this.ctx.closeActionSheet === 'function') this.ctx.closeActionSheet();
            if (typeof this.ctx.closeReadProgressPanel === 'function') this.ctx.closeReadProgressPanel();
            if (typeof this.ctx.closeMemberPanel === 'function') this.ctx.closeMemberPanel();
            this.closeDialog({ silent: true, force: true });
            this.closeMemberActionPage({ silent: true, fallbackView: 'group_info' });
            state.groupSettingsOpen = true;
            state.groupSettingsLoading = !!(groupManage && typeof groupManage.loadGroupSettings === 'function');
            state.groupSettingsError = '';
            state.groupSettingsMembersExpanded = false;
            state.groupSettingsData = null;
            state.open = true;
            state.view = 'group_info';
            if (typeof this.ctx.render === 'function') this.ctx.render();
            if (groupManage && typeof groupManage.loadGroupSettings === 'function') groupManage.loadGroupSettings(conversationId);
        },

        closeSettingsPanel(options) {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const silent = !!(options && options.silent);
            this.closeDialog({ silent: true, force: true });
            this.closeMemberActionPage({ silent: true, fallbackView: state.activeConversationId ? 'chat' : 'sessions' });
            state.groupSettingsOpen = false;
            state.groupSettingsLoading = false;
            state.groupSettingsError = '';
            state.groupSettingsConversationId = 0;
            state.groupSettingsData = null;
            state.groupSettingsMembersExpanded = false;
            if (state.view === 'group_info' || state.view === 'group_title_edit') state.view = state.activeConversationId ? 'chat' : 'sessions';
            if (!silent && typeof this.ctx.render === 'function') this.ctx.render();
        },

        focusMemberActionSearch() {
            if (!this.ctx || !this.ctx.state) return;
            const elements = this.getElements();
            const memberActionSearchEl = elements.memberActionSearchEl;
            const state = this.ctx.state;
            if (!memberActionSearchEl) return;
            setTimeout(function() {
                if (!memberActionSearchEl || !state.memberActionOpen || state.view !== 'member_action') return;
                memberActionSearchEl.focus();
                try {
                    const length = memberActionSearchEl.value.length;
                    memberActionSearchEl.setSelectionRange(length, length);
                } catch (e) {}
            }, 0);
        },

        openMemberActionPage(mode) {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const groupManage = this.ctx.groupManage;
            const config = groupManage && typeof groupManage.getMemberActionConfig === 'function' ? groupManage.getMemberActionConfig(mode) : null;
            const conversationId = Number(state.groupSettingsConversationId || 0);
            if (!config || !conversationId || !state.groupSettingsData) return;
            state.memberActionOpen = true;
            state.memberActionMode = mode;
            state.memberActionConversationId = conversationId;
            state.memberActionKeyword = '';
            state.memberActionSelectedUsernames = [];
            state.memberActionSubmitting = false;
            state.memberActionError = '';
            this.closeDialog({ silent: true, force: true });
            state.view = 'member_action';
            if (typeof this.ctx.render === 'function') this.ctx.render();
        },

        closeMemberActionPage(options) {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const silent = !!(options && options.silent);
            const fallbackView = options && options.fallbackView ? options.fallbackView : (state.groupSettingsOpen ? 'group_info' : (state.activeConversationId ? 'chat' : 'sessions'));
            state.memberActionOpen = false;
            state.memberActionMode = '';
            state.memberActionConversationId = 0;
            state.memberActionKeyword = '';
            state.memberActionSelectedUsernames = [];
            state.memberActionSubmitting = false;
            state.memberActionError = '';
            if (state.view === 'member_action') state.view = fallbackView;
            if (!silent && typeof this.ctx.render === 'function') this.ctx.render();
        },

        toggleMemberActionSelection(username) {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const normalized = String(username || '').trim().toLowerCase();
            if (!normalized || state.memberActionSubmitting) return;
            const selected = Array.isArray(state.memberActionSelectedUsernames) ? state.memberActionSelectedUsernames.slice() : [];
            const index = selected.indexOf(normalized);
            if (index >= 0) selected.splice(index, 1);
            else selected.push(normalized);
            state.memberActionSelectedUsernames = selected;
            if (state.memberActionError) state.memberActionError = '';
            this.renderMemberActionPage();
        },

        renderMemberActionPage() {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const elements = this.getElements();
            const memberActionBodyEl = elements.memberActionBodyEl;
            const memberActionSearchEl = elements.memberActionSearchEl;
            const memberActionTitleEl = elements.memberActionTitleEl;
            const memberActionSubmitBtnEl = elements.memberActionSubmitBtnEl;
            if (!memberActionBodyEl || !memberActionSearchEl || !memberActionTitleEl || !memberActionSubmitBtnEl) return;
            const groupManage = this.ctx.groupManage;
            const config = groupManage && typeof groupManage.getMemberActionConfig === 'function' ? groupManage.getMemberActionConfig(state.memberActionMode) : null;
            memberActionTitleEl.textContent = config ? config.title : '选择成员';
            memberActionSearchEl.value = String(state.memberActionKeyword || '');
            memberActionSearchEl.disabled = !state.memberActionOpen || !!state.memberActionSubmitting;
            if (!state.memberActionOpen) {
                memberActionBodyEl.innerHTML = '';
                memberActionSubmitBtnEl.disabled = true;
                memberActionSubmitBtnEl.textContent = '确认';
                return;
            }
            if (!groupManage || !config || typeof groupManage.getMemberActionCandidates !== 'function' || typeof groupManage.syncMemberActionSelection !== 'function' || typeof groupManage.filterMemberActionCandidates !== 'function' || typeof groupManage.formatMemberActionCandidateLabel !== 'function') {
                memberActionBodyEl.innerHTML = '<div class="ak-im-member-action-empty">成员操作模块暂不可用，请刷新后重试</div>';
                memberActionSubmitBtnEl.disabled = true;
                memberActionSubmitBtnEl.textContent = '确认';
                return;
            }
            const candidates = groupManage.getMemberActionCandidates();
            const selectedUsernames = groupManage.syncMemberActionSelection(candidates);
            const candidateMap = {};
            candidates.forEach(function(candidate) {
                if (candidate && candidate.username) candidateMap[candidate.username] = candidate;
            });
            const selectedCandidates = selectedUsernames.map(function(username) {
                return candidateMap[username] || null;
            }).filter(Boolean);
            const filteredCandidates = groupManage.filterMemberActionCandidates(candidates, state.memberActionKeyword);
            const escapeHtml = this.ctx.escapeHtml;
            const selectedMarkup = selectedCandidates.length ? '<div class="ak-im-member-action-chip-list">' + selectedCandidates.map(function(candidate) {
                const chipLabelMarkup = typeof groupManage.buildMemberActionCandidateNameMarkup === 'function'
                    ? groupManage.buildMemberActionCandidateNameMarkup(candidate)
                    : escapeHtml(groupManage.formatMemberActionCandidateLabel(candidate));
                return '<button class="ak-im-member-action-chip" type="button" data-im-member-chip="' + escapeHtml(candidate.username) + '"><span class="ak-im-member-action-chip-label">' + chipLabelMarkup + '</span><span class="ak-im-member-action-chip-remove" aria-hidden="true">×</span></button>';
            }).join('') + '</div>' : '<div class="ak-im-member-action-selected-empty">暂未选择成员</div>';
            const listMarkup = filteredCandidates.length ? '<div class="ak-im-member-action-list">' + filteredCandidates.map(function(candidate) {
                const isSelected = selectedUsernames.indexOf(candidate.username) >= 0;
                const reasonClass = candidate.disabledReason === '无聊天记录' ? ' is-muted' : '';
                const candidateNameMarkup = typeof groupManage.buildMemberActionCandidateNameMarkup === 'function'
                    ? groupManage.buildMemberActionCandidateNameMarkup(candidate)
                    : escapeHtml(candidate.displayName || candidate.username || '未知成员');
                return '<button class="ak-im-member-action-row' + (candidate.selectable ? '' : ' is-disabled') + '" type="button" data-im-member-option="' + escapeHtml(candidate.username) + '"' + (candidate.selectable ? '' : ' disabled') + '>' +
                    overlayModule.ctx.buildAvatarBoxMarkup('ak-im-member-action-avatar', candidate.avatarUrl, candidate.displayName || candidate.username || '成员', (candidate.displayName || candidate.username || '成员') + '头像') +
                    '<div class="ak-im-member-action-main"><div class="ak-im-member-action-name">' + candidateNameMarkup + '</div>' +
                    '<div class="ak-im-member-action-meta"><span>@' + escapeHtml(candidate.username || 'unknown') + '</span>' +
                    (candidate.roleLabel ? '<span class="ak-im-member-action-role">' + escapeHtml(candidate.roleLabel) + '</span>' : '') +
                    (candidate.disabledReason ? '<span class="ak-im-member-action-reason' + reasonClass + '">' + escapeHtml(candidate.disabledReason) + '</span>' : '') +
                    '</div></div>' +
                    '<span class="ak-im-member-action-check' + (candidate.selectable ? (isSelected ? ' is-selected' : '') : ' is-disabled') + '">' + (isSelected ? '✓' : '') + '</span>' +
                '</button>';
            }).join('') + '</div>' : '<div class="ak-im-member-action-empty">' + escapeHtml(state.memberActionKeyword ? '没有匹配的成员' : config.emptyText) + '</div>';
            memberActionBodyEl.innerHTML = (state.memberActionError ? '<div class="ak-im-member-action-error">' + escapeHtml(state.memberActionError) + '</div>' : '') +
                '<div class="ak-im-member-action-section"><div class="ak-im-member-action-section-title">' + escapeHtml(config.selectedTitle + '（' + selectedCandidates.length + '）') + '</div>' + selectedMarkup + '</div>' +
                '<div class="ak-im-member-action-section"><div class="ak-im-member-action-section-title">' + escapeHtml(config.listTitle) + '</div>' + listMarkup + '</div>';
            const self = this;
            Array.prototype.forEach.call(memberActionBodyEl.querySelectorAll('[data-im-member-option]'), function(button) {
                button.addEventListener('click', function() {
                    self.toggleMemberActionSelection(button.getAttribute('data-im-member-option'));
                });
            });
            Array.prototype.forEach.call(memberActionBodyEl.querySelectorAll('[data-im-member-chip]'), function(button) {
                button.addEventListener('click', function() {
                    self.toggleMemberActionSelection(button.getAttribute('data-im-member-chip'));
                });
            });
            memberActionSubmitBtnEl.disabled = !selectedCandidates.length || !!state.memberActionSubmitting;
            memberActionSubmitBtnEl.textContent = state.memberActionSubmitting ? config.submittingText : (config.submitText + (selectedCandidates.length ? '（' + selectedCandidates.length + '）' : ''));
        },

        bindEvents() {
            if (this.eventsBound) return;
            const elements = this.getElements();
            if (!elements.actionSheetEl || !elements.actionSheetRecallBtn || !elements.actionSheetCancelBtn || !elements.progressPanelEl || !elements.dialogEl || !elements.dialogCancelBtnEl || !elements.dialogConfirmBtnEl) return;
            const self = this;
            const actionMask = elements.actionSheetEl.querySelector('.ak-im-action-mask');
            const progressMask = elements.progressPanelEl.querySelector('.ak-im-progress-mask');
            const progressClose = elements.progressPanelEl.querySelector('.ak-im-progress-close');
            const dialogMask = elements.dialogEl.querySelector('.ak-im-dialog-mask');
            const settingsBack = elements.settingsPanelEl ? elements.settingsPanelEl.querySelector('.ak-im-group-info-back') : null;
            const memberActionBack = elements.memberActionPageEl ? elements.memberActionPageEl.querySelector('.ak-im-member-action-back') : null;
            if (!actionMask || !progressMask || !progressClose || !dialogMask) return;
            actionMask.addEventListener('click', function() {
                self.closeActionSheet();
            });
            elements.actionSheetCancelBtn.addEventListener('click', function() {
                if (typeof self.ctx.onActionSheetSecondary === 'function') self.ctx.onActionSheetSecondary();
            });
            elements.actionSheetRecallBtn.addEventListener('click', function() {
                if (typeof self.ctx.onActionSheetPrimary === 'function') self.ctx.onActionSheetPrimary();
            });
            progressMask.addEventListener('click', function() {
                self.closeReadProgressPanel();
            });
            progressClose.addEventListener('click', function() {
                self.closeReadProgressPanel();
            });
            dialogMask.addEventListener('click', function() {
                self.closeDialog();
            });
            elements.dialogCancelBtnEl.addEventListener('click', function() {
                self.closeDialog();
            });
            elements.dialogConfirmBtnEl.addEventListener('click', function() {
                if (typeof self.ctx.onDialogConfirm === 'function') self.ctx.onDialogConfirm();
            });
            if (settingsBack) {
                settingsBack.addEventListener('click', function() {
                    self.closeSettingsPanel();
                });
            }
            if (memberActionBack) {
                memberActionBack.addEventListener('click', function() {
                    self.closeDialog({ silent: true, force: true });
                    self.closeMemberActionPage();
                });
            }
            if (elements.memberActionSearchEl) {
                elements.memberActionSearchEl.addEventListener('input', function() {
                    self.ctx.state.memberActionKeyword = elements.memberActionSearchEl.value || '';
                    self.renderMemberActionPage();
                });
            }
            if (elements.memberActionSubmitBtnEl) {
                elements.memberActionSubmitBtnEl.addEventListener('click', function() {
                    const groupManage = self.ctx && self.ctx.groupManage;
                    if (groupManage && typeof groupManage.submitMemberActionPage === 'function') groupManage.submitMemberActionPage();
                });
            }
            this.eventsBound = true;
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.overlay = overlayModule;
})(window);
