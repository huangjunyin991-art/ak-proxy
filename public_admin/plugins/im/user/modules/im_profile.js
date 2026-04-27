(function(global) {
     'use strict';

     const profileModule = {
         ctx: null,

         init(ctx) {
             this.ctx = ctx || null;
         },
        
         splitProfileAvatarHistoryItems(items) {
             const groups = {
                 favorites: [],
                 history: []
             };
             (Array.isArray(items) ? items : []).forEach(function(item) {
                 if (!item) return;
                 if (item.is_favorite) groups.favorites.push(item);
                 else groups.history.push(item);
             });
             return groups;
         },

         isCurrentProfileAvatarHistoryItem(item) {
             const state = this.ctx.state;
             const currentAvatarUrl = this.ctx.getAvatarUrl(state.profile && state.profile.avatar_url);
             const historyAvatarUrl = this.ctx.getAvatarUrl(item && item.avatar_url);
             return !!currentAvatarUrl && !!historyAvatarUrl && currentAvatarUrl === historyAvatarUrl;
         },

         isProfileAvatarHistoryActionPending(actionType, historyId) {
             const state = this.ctx.state;
             return Number(state.profileAvatarHistoryActionId || 0) === Number(historyId || 0) && String(state.profileAvatarHistoryActionType || '') === String(actionType || '');
         },

         buildProfileAvatarHistoryCardMarkup(item, displayName, username) {
             const state = this.ctx.state;
             const historyId = Number(item && item.id || 0);
             const hasHistoryId = historyId > 0;
             const isBusy = !!state.profileAvatarHistoryActionType || !!state.profileRefreshing || !!state.profileAvatarUploading;
             const isCurrent = this.isCurrentProfileAvatarHistoryItem(item);
             const isFavorite = !!(item && item.is_favorite);
             const selecting = this.isProfileAvatarHistoryActionPending('select', historyId);
             const favoriting = this.isProfileAvatarHistoryActionPending('favorite', historyId);
             const removing = this.isProfileAvatarHistoryActionPending('remove', historyId);
             const historyTime = this.ctx.formatProfileHistoryTime(item && item.created_at) || '最近使用';
             const selectHint = !hasHistoryId ? '当前头像记录同步中' : (isCurrent ? '当前头像' : (selecting ? '正在切换...' : '点击设为当前头像'));
             const removeLabel = removing ? '…' : '-';
             return '<div class="ak-im-profile-history-item' + (isCurrent ? ' is-current' : '') + '">' +
                 (isCurrent ? '<div class="ak-im-profile-history-current">当前使用</div>' : '') +
                 '<button class="ak-im-profile-history-remove" type="button" data-im-profile-avatar-remove="' + historyId + '"' + (isBusy || !hasHistoryId ? ' disabled' : '') + '><span class="ak-im-profile-history-remove-mark">' + removeLabel + '</span></button>' +
                 '<button class="ak-im-profile-history-favorite' + (isFavorite ? ' is-active' : '') + '" type="button" data-im-profile-avatar-favorite="' + historyId + '" data-im-profile-avatar-next-favorite="' + (isFavorite ? '0' : '1') + '"' + (isBusy || !hasHistoryId ? ' disabled' : '') + '>' + (favoriting ? '…' : '★') + '</button>' +
                 '<button class="ak-im-profile-history-card" type="button" data-im-profile-avatar-select="' + historyId + '"' + (isBusy || isCurrent || !hasHistoryId ? ' disabled' : '') + '>' +
                     this.ctx.buildAvatarBoxMarkup('ak-im-profile-history-avatar', item && item.avatar_url, displayName || username || '我', '历史头像') +
                     '<div class="ak-im-profile-history-time">' + this.ctx.escapeHtml(historyTime) + '</div>' +
                     '<div class="ak-im-profile-history-hint">' + this.ctx.escapeHtml(selectHint) + '</div>' +
                 '</button>' +
             '</div>';
         },

         buildProfileAvatarHistorySectionMarkup(options) {
             const items = Array.isArray(options && options.items) ? options.items : [];
             const title = String(options && options.title || '').trim() || '头像';
             const subtitle = String(options && options.subtitle || '').trim();
             const countText = String(options && options.countText || '').trim();
             const emptyText = String(options && options.emptyText || '').trim() || '暂无头像';
             const displayName = String(options && options.displayName || '').trim();
             const username = String(options && options.username || '').trim();
             const self = this;
             return '<div class="ak-im-profile-history-section">' +
                 '<div class="ak-im-profile-history-section-head">' +
                     '<div class="ak-im-profile-entry-label">' + this.ctx.escapeHtml(title) + '</div>' +
                     (countText ? '<div class="ak-im-profile-history-section-count">' + this.ctx.escapeHtml(countText) + '</div>' : '') +
                 '</div>' +
                 (subtitle ? '<div class="ak-im-profile-subtitle">' + this.ctx.escapeHtml(subtitle) + '</div>' : '') +
                 (items.length ? '<div class="ak-im-profile-history-grid">' + items.map(function(item) {
                     return self.buildProfileAvatarHistoryCardMarkup(item, displayName, username);
                 }).join('') + '</div>' : '<div class="ak-im-profile-placeholder">' + this.ctx.escapeHtml(emptyText) + '</div>') +
             '</div>';
         },

         renderProfileSubpage() {
             if (!this.ctx || !this.ctx.state || !this.ctx.elements) return;
             const state = this.ctx.state;
             const profileSubpageBodyEl = this.ctx.elements.profileSubpageBodyEl;
             const profileSubpageTitleEl = this.ctx.elements.profileSubpageTitleEl;
             if (!profileSubpageBodyEl || !profileSubpageTitleEl) return;
             if (!this.ctx.isProfileSubpageView(state.view)) {
                 profileSubpageTitleEl.textContent = '个人资料';
                 profileSubpageBodyEl.innerHTML = '';
                 return;
             }
             profileSubpageTitleEl.textContent = this.ctx.getProfileSubpageTitle(state.view);
             if (!state.allowed) {
                 profileSubpageBodyEl.innerHTML = '<div class="ak-im-empty">当前账号未开通聊天</div>';
                 return;
             }
             const profile = state.profile || null;
             const displayName = String(profile && profile.display_name || state.displayName || state.username || '我').trim();
             const username = String(profile && profile.username || state.username || '').trim();
             const nickname = String(profile && profile.nickname || '').trim();
             const genderLabel = this.ctx.getProfileGenderLabel(profile && profile.gender);
             if (state.view === 'profile_avatar') {
                 this.renderProfileAvatarView(profileSubpageBodyEl, profile, displayName, username);
                 return;
             }
             if (state.view === 'profile_detail') {
                 this.renderProfileDetailView(profileSubpageBodyEl, displayName, username, nickname, genderLabel);
                 return;
             }
             this.renderProfileSettingsView(profileSubpageBodyEl, displayName, username, nickname, genderLabel, profile);
         },

         renderProfileAvatarView(container, profile, displayName, username) {
             const state = this.ctx.state;
             const historyGroups = this.splitProfileAvatarHistoryItems(state.profileAvatarHistory);
             const favoriteCount = this.ctx.countProfileAvatarFavorites(state.profileAvatarHistory);
             const avatarBusy = !!state.profileAvatarHistoryActionType || !!state.profileRefreshing || !!state.profileAvatarUploading;
             const uploadProgress = Math.max(0, Math.min(100, Number(state.profileAvatarUploadProgress || 0) || 0));
             const historyGuideText = favoriteCount >= 10 ? '已收藏满 10 个头像，继续随机生成或本地上传仍会进入历史，但需要删除部分收藏后才能继续收藏。' : '点击头像可立即切回；右上角删除，右下角收藏。';
             const historyMarkup = state.profileAvatarHistoryLoading ? '<div class="ak-im-profile-placeholder">正在读取头像历史...</div>' : (state.profileAvatarHistoryError ? '<div class="ak-im-profile-error">' + this.ctx.escapeHtml(state.profileAvatarHistoryError) + '</div>' : (
                 this.buildProfileAvatarHistorySectionMarkup({
                     title: '收藏头像',
                     subtitle: '收藏头像不会被自动替换，最多可保留 10 个。',
                     countText: favoriteCount + '/10',
                     items: historyGroups.favorites,
                     emptyText: '还没有收藏头像，点亮右下角星标后会固定保留在这里。',
                     displayName: displayName,
                     username: username
                 }) +
                 this.buildProfileAvatarHistorySectionMarkup({
                     title: '历史头像',
                     subtitle: '按时间倒序展示最近随机生成或本地上传过的头像。',
                     countText: historyGroups.history.length + ' 个',
                     items: historyGroups.history,
                     emptyText: '暂时还没有历史头像，随机生成或本地上传一次后会在这里保留最近 10 个记录。',
                     displayName: displayName,
                     username: username
                 })
             ));
             container.innerHTML = (state.profileError ? '<div class="ak-im-profile-error">' + this.ctx.escapeHtml(state.profileError) + '</div>' : '') +
                 (state.profileAvatarActionError ? '<div class="ak-im-profile-error">' + this.ctx.escapeHtml(state.profileAvatarActionError) + '</div>' : '') +
                 '<div class="ak-im-profile-panel">' +
                     '<div class="ak-im-profile-head">' +
                         this.ctx.buildAvatarBoxMarkup('ak-im-profile-avatar', profile && profile.avatar_url, displayName || username || '我', (displayName || username || '我') + '头像') +
                         '<div class="ak-im-profile-name">' + this.ctx.escapeHtml(displayName || '我') + '</div>' +
                         '<div class="ak-im-profile-username">@' + this.ctx.escapeHtml(username || 'unknown') + '</div>' +
                     '</div>' +
                     '<div class="ak-im-profile-subtitle">你可以随机生成新头像，也可以选择本地图片上传；上传图片会自动压缩并进入历史头像。</div>' +
                     '<button class="ak-im-profile-primary-btn" type="button" data-im-profile-action="refresh-avatar"' + (avatarBusy ? ' disabled' : '') + '>' + this.ctx.escapeHtml(state.profileRefreshing ? '正在随机生成...' : '随机生成') + '</button>' +
                     '<button class="ak-im-profile-primary-btn" type="button" data-im-profile-action="upload-avatar"' + (avatarBusy ? ' disabled' : '') + '>' + this.ctx.escapeHtml(state.profileAvatarUploading ? ('正在本地上传' + (uploadProgress ? ' ' + uploadProgress + '%' : '...')) : '本地上传') + '</button>' +
                     '<input style="display:none" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" data-im-profile-avatar-file />' +
                 '</div>' +
                 '<div class="ak-im-profile-panel">' +
                     '<div class="ak-im-profile-subtitle">' + this.ctx.escapeHtml(historyGuideText) + '</div>' +
                     historyMarkup +
                 '</div>';
             this.bindProfileAvatarEvents(container);
         },

         bindProfileAvatarEvents(container) {
             const self = this;
             const refreshBtn = container.querySelector('[data-im-profile-action="refresh-avatar"]');
             const uploadBtn = container.querySelector('[data-im-profile-action="upload-avatar"]');
             const uploadInput = container.querySelector('[data-im-profile-avatar-file]');
             if (refreshBtn) {
                 refreshBtn.addEventListener('click', function() {
                     self.ctx.refreshProfileAvatar();
                 });
             }
             if (uploadBtn && uploadInput) {
                 uploadBtn.addEventListener('click', function() {
                     uploadInput.click();
                 });
                 uploadInput.addEventListener('change', function() {
                     const files = uploadInput.files;
                     const file = files && files.length ? files[0] : null;
                     uploadInput.value = '';
                     if (file && typeof self.ctx.uploadProfileAvatar === 'function') {
                         self.ctx.uploadProfileAvatar(file);
                     }
                 });
             }
             Array.prototype.forEach.call(container.querySelectorAll('[data-im-profile-avatar-select]'), function(button) {
                 button.addEventListener('click', function(event) {
                     event.preventDefault();
                     event.stopPropagation();
                     self.ctx.selectProfileAvatar(Number(button.getAttribute('data-im-profile-avatar-select') || 0));
                 });
             });
             Array.prototype.forEach.call(container.querySelectorAll('[data-im-profile-avatar-favorite]'), function(button) {
                 button.addEventListener('click', function(event) {
                     event.preventDefault();
                     event.stopPropagation();
                     self.ctx.setProfileAvatarFavorite(Number(button.getAttribute('data-im-profile-avatar-favorite') || 0), button.getAttribute('data-im-profile-avatar-next-favorite') === '1');
                 });
             });
             Array.prototype.forEach.call(container.querySelectorAll('[data-im-profile-avatar-remove]'), function(button) {
                 button.addEventListener('click', function(event) {
                     event.preventDefault();
                     event.stopPropagation();
                     self.ctx.openProfileAvatarRemoveDialog(Number(button.getAttribute('data-im-profile-avatar-remove') || 0));
                 });
             });
         },

         renderProfileDetailView(container, displayName, username, nickname, genderLabel) {
             const state = this.ctx.state;
             const draftNickname = String(state.profileDraftNickname || '').trim();
             const draftGender = this.ctx.normalizeProfileGender(state.profileDraftGender);
             const draftGenderLabel = this.ctx.getProfileGenderLabel(draftGender);
             container.innerHTML = (state.profileSaveError ? '<div class="ak-im-profile-error">' + this.ctx.escapeHtml(state.profileSaveError) + '</div>' : '') +
                 '<div class="ak-im-profile-panel">' +
                     '<div class="ak-im-profile-form">' +
                         '<div class="ak-im-profile-form-group">' +
                             '<label class="ak-im-profile-form-label" for="ak-im-profile-nickname">昵称</label>' +
                             '<input class="ak-im-profile-form-input" id="ak-im-profile-nickname" data-im-profile-field="nickname" type="text" autocomplete="off" spellcheck="false" value="' + this.ctx.escapeHtml(state.profileDraftNickname) + '" placeholder="请输入昵称" />' +
                             '<div class="ak-im-profile-form-help">保存后会同步显示在会话标题、群成员、消息发送者和个人资料中。</div>' +
                         '</div>' +
                         '<div class="ak-im-profile-form-group">' +
                             '<label class="ak-im-profile-form-label" for="ak-im-profile-gender">性别</label>' +
                             '<select class="ak-im-profile-form-select" id="ak-im-profile-gender" data-im-profile-field="gender">' +
                                 '<option value="unknown"' + (draftGender === 'unknown' ? ' selected' : '') + '>未设置</option>' +
                                 '<option value="male"' + (draftGender === 'male' ? ' selected' : '') + '>男</option>' +
                                 '<option value="female"' + (draftGender === 'female' ? ' selected' : '') + '>女</option>' +
                             '</select>' +
                             '<div class="ak-im-profile-form-help" data-im-profile-preview>当前对外显示：' + this.ctx.escapeHtml((draftNickname || displayName || username || '我') + ' · ' + draftGenderLabel) + '</div>' +
                         '</div>' +
                         '<button class="ak-im-profile-primary-btn" type="button" data-im-profile-action="save-detail"' + (state.profileSaving ? ' disabled' : '') + '>' + this.ctx.escapeHtml(state.profileSaving ? '正在保存...' : '保存资料') + '</button>' +
                     '</div>' +
                 '</div>';
             this.bindProfileDetailEvents(container, displayName, username, nickname, genderLabel);
         },

         bindProfileDetailEvents(container, displayName, username) {
             const self = this;
             const state = this.ctx.state;
             const nicknameInput = container.querySelector('[data-im-profile-field="nickname"]');
             const genderSelect = container.querySelector('[data-im-profile-field="gender"]');
             const previewEl = container.querySelector('[data-im-profile-preview]');
             const saveBtn = container.querySelector('[data-im-profile-action="save-detail"]');
             const updateDraftPreview = function() {
                 if (!previewEl) return;
                 const previewName = String(state.profileDraftNickname || '').trim() || displayName || username || '我';
                 previewEl.textContent = '当前对外显示：' + previewName + ' · ' + self.ctx.getProfileGenderLabel(state.profileDraftGender);
             };
             if (nicknameInput) {
                 nicknameInput.addEventListener('input', function() {
                     state.profileDraftNickname = nicknameInput.value || '';
                     state.profileDraftDirty = true;
                     updateDraftPreview();
                 });
             }
             if (genderSelect) {
                 genderSelect.addEventListener('change', function() {
                     state.profileDraftGender = genderSelect.value || 'unknown';
                     state.profileDraftDirty = true;
                     updateDraftPreview();
                 });
             }
             if (saveBtn) {
                 saveBtn.addEventListener('click', function() {
                     self.ctx.saveProfileDetail();
                 });
             }
         },

         renderProfileSettingsView(container, displayName, username, nickname, genderLabel, profile) {
             container.innerHTML = '<div class="ak-im-profile-panel">' +
                 '<div class="ak-im-profile-head">' +
                     this.ctx.buildAvatarBoxMarkup('ak-im-profile-avatar', profile && profile.avatar_url, displayName || username || '我', (displayName || username || '我') + '头像') +
                     '<div class="ak-im-profile-name">' + this.ctx.escapeHtml(displayName || '我') + '</div>' +
                     '<div class="ak-im-profile-username">@' + this.ctx.escapeHtml(username || 'unknown') + '</div>' +
                 '</div>' +
                 '<div class="ak-im-profile-subtitle">这里是新的全屏设置页入口，后续与 IM 个人相关的设置项会继续放在这里。</div>' +
             '</div>' +
             '<div class="ak-im-profile-panel">' +
                 '<div class="ak-im-profile-entry-label">当前资料</div>' +
                 '<div class="ak-im-profile-subtitle">昵称：' + this.ctx.escapeHtml(nickname || displayName || '未设置') + '</div>' +
                 '<div class="ak-im-profile-subtitle">性别：' + this.ctx.escapeHtml(genderLabel) + '</div>' +
                 '<div class="ak-im-profile-subtitle">账号：@' + this.ctx.escapeHtml(username || 'unknown') + '</div>' +
             '</div>';
         }
     };

     global.AKIMUserModules = global.AKIMUserModules || {};
     global.AKIMUserModules.profile = profileModule;
 })(window);
