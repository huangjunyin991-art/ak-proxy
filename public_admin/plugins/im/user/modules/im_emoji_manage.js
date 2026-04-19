(function(global) {
    'use strict';

    const STANDARD_SECTIONS = [
        {
            key: 'smile',
            title: '笑脸',
            items: ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '😴', '🥳', '🥲', '🤔', '😭', '😡']
        },
        {
            key: 'gesture',
            title: '手势',
            items: ['👍', '👎', '👌', '🙏', '👏', '💪', '🙌', '🤝', '✌️', '🫶', '👀', '🔥', '💯', '❤️']
        },
        {
            key: 'daily',
            title: '日常',
            items: ['🎉', '🎁', '🌹', '☕', '🍉', '🍻', '🎈', '🎵', '⭐', '⚡', '🌞', '🌙', '🐶', '🐱']
        }
    ];

    const emojiManageModule = {
        ctx: null,
        emojiAssetsRequest: null,

        init(ctx) {
            this.ctx = ctx || null;
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getElements() {
            return this.ctx && this.ctx.elements ? this.ctx.elements : {};
        },

        escapeHtml(value) {
            if (this.ctx && typeof this.ctx.escapeHtml === 'function') {
                return this.ctx.escapeHtml(value);
            }
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },

        escapeAttribute(value) {
            return this.escapeHtml(value).replace(/`/g, '&#96;');
        },

        normalizeTab(tab) {
            return String(tab || '').trim().toLowerCase() === 'custom' ? 'custom' : 'standard';
        },

        isPanelAvailable() {
            const state = this.getState();
            return !!(state && state.allowed && state.open && state.view === 'chat' && Number(state.activeConversationId || 0) > 0);
        },

        focusInput() {
            const elements = this.getElements();
            const inputEl = elements.inputEl;
            if (!inputEl) return;
            try {
                inputEl.focus();
            } catch (e) {}
        },

        syncComposer() {
            if (this.ctx && typeof this.ctx.syncInputHeight === 'function') this.ctx.syncInputHeight();
            if (this.ctx && typeof this.ctx.syncComposerState === 'function') this.ctx.syncComposerState();
        },

        syncGlobalEmojiAssets(items) {
            const nextItems = Array.isArray(items) ? items.slice() : [];
            global.AKIMEmojiAssets = nextItems;
            global.AK_IM_EMOJI_ASSETS = nextItems;
        },

        getEmojiAssetsEndpoint() {
            const httpRoot = this.ctx && this.ctx.httpRoot ? String(this.ctx.httpRoot).trim() : '';
            return httpRoot ? (httpRoot + '/emoji_assets') : '';
        },

        requestEmojiAssets(force) {
            const state = this.getState();
            const endpoint = this.getEmojiAssetsEndpoint();
            if (!state || !this.ctx || typeof this.ctx.request !== 'function' || !endpoint) {
                return Promise.resolve([]);
            }
            if (this.emojiAssetsRequest) return this.emojiAssetsRequest;
            const self = this;
            state.emojiAssetsLoading = true;
            if (force) state.emojiAssetsError = '';
            this.emojiAssetsRequest = this.ctx.request(endpoint).then(function(data) {
                const nextItems = Array.isArray(data && (data.items || data.emoji_assets || data.custom_emoji_assets))
                    ? (data.items || data.emoji_assets || data.custom_emoji_assets)
                    : [];
                state.emojiAssets = nextItems;
                state.emojiAssetsLoaded = true;
                state.emojiAssetsError = '';
                self.syncGlobalEmojiAssets(nextItems);
                return nextItems;
            }).catch(function(err) {
                state.emojiAssetsLoaded = false;
                state.emojiAssetsError = err && err.message ? err.message : '加载自定义表情失败';
                return [];
            }).finally(function() {
                state.emojiAssetsLoading = false;
                self.emojiAssetsRequest = null;
                if (self.ctx && typeof self.ctx.render === 'function') self.ctx.render();
            });
            return this.emojiAssetsRequest;
        },

        ensureCustomAssetsLoaded(force) {
            const state = this.getState();
            if (!state) return Promise.resolve([]);
            if (state.emojiAssetsLoading && this.emojiAssetsRequest) return this.emojiAssetsRequest;
            if (state.emojiAssetsLoaded) {
                return Promise.resolve(Array.isArray(state.emojiAssets) ? state.emojiAssets : []);
            }
            if (Array.isArray(state.emojiAssets) && state.emojiAssets.length) {
                state.emojiAssetsLoaded = true;
                this.syncGlobalEmojiAssets(state.emojiAssets);
                return Promise.resolve(state.emojiAssets);
            }
            if (state.emojiAssetsError && !force) {
                return Promise.resolve([]);
            }
            return this.requestEmojiAssets(force);
        },

        getStandardSections() {
            return STANDARD_SECTIONS;
        },

        getRawEmojiAssets() {
            const state = this.getState();
            if (state && state.emojiAssetsLoaded) {
                return Array.isArray(state.emojiAssets) ? state.emojiAssets : [];
            }
            if (state && Array.isArray(state.emojiAssets) && state.emojiAssets.length) {
                return state.emojiAssets;
            }
            if (Array.isArray(global.AKIMEmojiAssets) && global.AKIMEmojiAssets.length) {
                return global.AKIMEmojiAssets;
            }
            if (Array.isArray(global.AK_IM_EMOJI_ASSETS) && global.AK_IM_EMOJI_ASSETS.length) {
                return global.AK_IM_EMOJI_ASSETS;
            }
            return [];
        },

        normalizeEmojiAsset(item, index) {
            const assetId = Number(item && (item.id || item.asset_id || item.emoji_asset_id) || 0) || (index + 1);
            const title = String(item && (item.title || item.name || item.emoji_name || item.code || item.emoji_code) || '').trim();
            const code = String(item && (item.code || item.emoji_code || item.short_code || title) || '').trim();
            const imageUrl = String(item && (item.webp_url || item.image_url || item.asset_url || item.preview_url || item.url) || '').trim();
            return {
                id: assetId,
                title: title || code || ('表情 ' + assetId),
                code: code || title || ('表情' + assetId),
                imageUrl: imageUrl
            };
        },

        getEmojiAssets() {
            return this.getRawEmojiAssets().map(this.normalizeEmojiAsset).filter(function(item) {
                return Number(item && item.id || 0) > 0;
            });
        },

        findEmojiAssetById(assetId) {
            const targetId = Number(assetId || 0);
            if (!targetId) return null;
            const assets = this.getEmojiAssets();
            for (let i = 0; i < assets.length; i++) {
                if (Number(assets[i].id || 0) === targetId) return assets[i];
            }
            return null;
        },

        parseEmojiPayload(rawContent) {
            const text = String(rawContent || '').trim();
            if (!text || text.charAt(0) !== '{') return null;
            try {
                const parsed = JSON.parse(text);
                return parsed && typeof parsed === 'object' ? parsed : null;
            } catch (e) {
                return null;
            }
        },

        resolveEmojiMessage(item) {
            if (String(item && item.message_type || '').trim().toLowerCase() !== 'emoji_custom') return null;
            const parsedPayload = this.parseEmojiPayload(item && item.content);
            const assetId = Number(
                (parsedPayload && (parsedPayload.emoji_asset_id || parsedPayload.asset_id || parsedPayload.id)) ||
                (item && (item.emoji_asset_id || item.asset_id)) ||
                0
            );
            const asset = this.findEmojiAssetById(assetId);
            if (!asset && assetId > 0) {
                const state = this.getState();
                if (state && !state.emojiAssetsLoaded && !state.emojiAssetsLoading) {
                    this.ensureCustomAssetsLoaded();
                }
            }
            const label = String(
                (parsedPayload && (parsedPayload.emoji_code || parsedPayload.code || parsedPayload.title || parsedPayload.name || parsedPayload.text)) ||
                (item && (item.emoji_code || item.emoji_name || item.content_preview)) ||
                (asset && (asset.code || asset.title)) ||
                '自定义表情'
            ).trim() || '自定义表情';
            const imageUrl = String(
                (parsedPayload && (parsedPayload.webp_url || parsedPayload.image_url || parsedPayload.asset_url || parsedPayload.preview_url || parsedPayload.url)) ||
                (item && (item.emoji_url || item.emoji_image_url || item.asset_url || item.image_url || item.webp_url)) ||
                (asset && asset.imageUrl) ||
                ''
            ).trim();
            return {
                assetId: assetId,
                label: label,
                imageUrl: imageUrl
            };
        },

        getMessageBubbleClassName(item) {
            return this.resolveEmojiMessage(item) ? 'ak-im-bubble-emoji' : '';
        },

        buildMessageBubbleMarkup(item) {
            const emojiMessage = this.resolveEmojiMessage(item);
            if (!emojiMessage) {
                return this.escapeHtml(item && (item.content || item.content_preview || '') || '');
            }
            if (emojiMessage.imageUrl) {
                return '<img class="ak-im-emoji-bubble-image" src="' + this.escapeAttribute(emojiMessage.imageUrl) + '" alt="' + this.escapeAttribute(emojiMessage.label) + '">';
            }
            return '<span class="ak-im-emoji-bubble-fallback">' + this.escapeHtml(emojiMessage.label) + '</span>';
        },

        insertStandardEmoji(emojiText) {
            const state = this.getState();
            const elements = this.getElements();
            const inputEl = elements.inputEl;
            const nextText = String(emojiText || '');
            if (!state || !inputEl || !nextText) return;
            const value = String(inputEl.value || '');
            const start = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : value.length;
            const end = typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : value.length;
            const merged = value.slice(0, start) + nextText + value.slice(end);
            inputEl.value = merged;
            state.inputValue = merged;
            this.syncComposer();
            this.focusInput();
            try {
                const caret = start + nextText.length;
                inputEl.setSelectionRange(caret, caret);
            } catch (e) {}
        },

        sendCustomEmoji(asset) {
            if (!asset || !asset.id || !this.ctx || typeof this.ctx.sendCustomEmoji !== 'function') {
                return Promise.resolve(null);
            }
            return this.ctx.sendCustomEmoji(asset.id, asset.code || asset.title || '');
        },

        togglePicker() {
            const state = this.getState();
            if (!state || !this.isPanelAvailable()) return;
            state.emojiPanelOpen = !state.emojiPanelOpen;
            if (state.emojiPanelOpen && this.normalizeTab(state.emojiPanelTab) === 'custom') {
                this.ensureCustomAssetsLoaded(true);
            }
            if (!state.emojiPanelOpen) this.focusInput();
            if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
        },

        closePicker(options) {
            const state = this.getState();
            if (!state || !state.emojiPanelOpen) return;
            state.emojiPanelOpen = false;
            if (!options || !options.silent) {
                if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
            }
        },

        switchTab(tab) {
            const state = this.getState();
            if (!state) return;
            state.emojiPanelTab = this.normalizeTab(tab);
            if (state.emojiPanelTab === 'custom') {
                this.ensureCustomAssetsLoaded(true);
            }
            if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
        },

        getTabIconMarkup(tabKey) {
            if (tabKey === 'custom') {
                return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.25l-.32-.29C6.03 14.82 2.25 11.39 2.25 7.5 2.25 4.47 4.72 2 7.75 2c1.67 0 3.27.78 4.25 2.02A5.74 5.74 0 0 1 16.25 2C19.28 2 21.75 4.47 21.75 7.5c0 3.89-3.78 7.32-9.43 12.46l-.32.29Z"></path></svg>';
            }
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M9 10h.01"></path><path d="M15 10h.01"></path><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8"></path></svg>';
        },

        renderTabs(container, activeTab) {
            if (!container) return;
            const self = this;
            container.innerHTML = '';
            [
                { key: 'standard', label: '标准表情' },
                { key: 'custom', label: '自定义表情' }
            ].forEach(function(tab) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'ak-im-emoji-sheet-tab' + (tab.key === activeTab ? ' is-active' : '');
                button.setAttribute('aria-label', tab.label);
                button.setAttribute('title', tab.label);
                button.innerHTML = self.getTabIconMarkup(tab.key);
                button.addEventListener('click', function() {
                    self.switchTab(tab.key);
                });
                container.appendChild(button);
            });
        },

        renderStandardPanel(container) {
            if (!container) return;
            const self = this;
            container.innerHTML = '';
            this.getStandardSections().forEach(function(section) {
                const sectionEl = document.createElement('section');
                sectionEl.className = 'ak-im-emoji-section';
                const titleEl = document.createElement('h4');
                titleEl.className = 'ak-im-emoji-section-title';
                titleEl.textContent = section.title;
                const gridEl = document.createElement('div');
                gridEl.className = 'ak-im-emoji-grid';
                section.items.forEach(function(emojiText) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'ak-im-emoji-item';
                    button.setAttribute('aria-label', emojiText);
                    button.textContent = emojiText;
                    button.addEventListener('click', function() {
                        self.insertStandardEmoji(emojiText);
                    });
                    gridEl.appendChild(button);
                });
                sectionEl.appendChild(titleEl);
                sectionEl.appendChild(gridEl);
                container.appendChild(sectionEl);
            });
        },

        renderCustomPanel(container) {
            if (!container) return;
            const self = this;
            const state = this.getState();
            const assets = this.getEmojiAssets();
            container.innerHTML = '';
            if (state && state.emojiAssetsLoading) {
                container.innerHTML = '<div class="ak-im-emoji-loading">正在加载自定义表情…</div>';
                return;
            }
            if (state && state.emojiAssetsError) {
                container.innerHTML = '<div class="ak-im-emoji-error">' + this.escapeHtml(state.emojiAssetsError) + '</div>';
                return;
            }
            if (!assets.length) {
                container.innerHTML = '<div class="ak-im-emoji-empty">暂未配置自定义表情</div>';
                return;
            }
            const sectionEl = document.createElement('section');
            sectionEl.className = 'ak-im-emoji-section';
            const titleEl = document.createElement('h4');
            titleEl.className = 'ak-im-emoji-section-title';
            titleEl.textContent = '自定义表情';
            const gridEl = document.createElement('div');
            gridEl.className = 'ak-im-sticker-grid';
            assets.forEach(function(asset) {
                const labelText = asset.title || asset.code || '自定义表情';
                const button = document.createElement('button');
                const preview = document.createElement('div');
                const labelEl = document.createElement('span');
                button.type = 'button';
                button.className = 'ak-im-sticker-item';
                button.setAttribute('aria-label', labelText);
                button.setAttribute('title', labelText);
                preview.className = 'ak-im-sticker-preview';
                if (asset.imageUrl) {
                    const image = document.createElement('img');
                    image.className = 'ak-im-sticker-img';
                    image.src = asset.imageUrl;
                    image.alt = labelText;
                    preview.appendChild(image);
                } else {
                    const fallback = document.createElement('span');
                    fallback.className = 'ak-im-sticker-fallback';
                    fallback.textContent = asset.code || asset.title || '表情';
                    preview.appendChild(fallback);
                }
                labelEl.className = 'ak-im-sticker-label';
                labelEl.textContent = labelText;
                button.appendChild(preview);
                button.appendChild(labelEl);
                button.addEventListener('click', function() {
                    self.sendCustomEmoji(asset);
                });
                gridEl.appendChild(button);
            });
            sectionEl.appendChild(titleEl);
            sectionEl.appendChild(gridEl);
            container.appendChild(sectionEl);
        },

        renderEmojiPanel() {
            const state = this.getState();
            const elements = this.getElements();
            const emojiSheetEl = elements.emojiSheetEl;
            const emojiSheetTabsEl = elements.emojiSheetTabsEl;
            const emojiSheetBodyEl = elements.emojiSheetBodyEl;
            if (!emojiSheetEl || !emojiSheetTabsEl || !emojiSheetBodyEl) return;
            const panelAvailable = this.isPanelAvailable();
            const shouldOpen = !!(state && state.emojiPanelOpen && panelAvailable);
            if (!shouldOpen) {
                emojiSheetEl.classList.remove('is-open');
                emojiSheetEl.setAttribute('aria-hidden', 'true');
                emojiSheetEl.setAttribute('inert', '');
                emojiSheetTabsEl.innerHTML = '';
                emojiSheetBodyEl.innerHTML = '';
                return;
            }
            const activeTab = this.normalizeTab(state && state.emojiPanelTab);
            emojiSheetEl.classList.add('is-open');
            emojiSheetEl.setAttribute('aria-hidden', 'false');
            emojiSheetEl.removeAttribute('inert');
            this.renderTabs(emojiSheetTabsEl, activeTab);
            if (activeTab === 'custom') {
                if (!state.emojiAssetsLoading && !state.emojiAssetsLoaded && !state.emojiAssetsError) {
                    this.ensureCustomAssetsLoaded(false);
                }
                this.renderCustomPanel(emojiSheetBodyEl);
                return;
            }
            this.renderStandardPanel(emojiSheetBodyEl);
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.emojiManage = emojiManageModule;
})(window);
