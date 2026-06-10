(function(global) {
    'use strict';

    const BOT_USERNAME = 'ak_ai_assistant';
    const STYLE_ID = 'ak-im-ai-markdown-render-style';
    const MAX_MARKDOWN_LENGTH = 80000;
    const VENDOR_SCRIPTS = [
        {
            globalName: 'marked',
            fileName: 'vendors/marked-18.0.5.umd.js',
            selector: 'script[data-ak-im-user-plugin-ai-markdown-marked="1"]',
            datasetKey: 'akImUserPluginAiMarkdownMarked'
        },
        {
            globalName: 'DOMPurify',
            fileName: 'vendors/dompurify-3.4.9.min.js',
            selector: 'script[data-ak-im-user-plugin-ai-markdown-purify="1"]',
            datasetKey: 'akImUserPluginAiMarkdownPurify'
        }
    ];
    const TEXT_LIKE_TYPES = {
        text: true,
        markdown: true,
        ai_text: true,
        ai_response: true,
        assistant_text: true
    };
    const ALLOWED_TAGS = [
        'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4',
        'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th',
        'thead', 'tr', 'ul'
    ];
    const ALLOWED_ATTR = ['colspan', 'href', 'rel', 'rowspan', 'target', 'title'];
    const FORBID_TAGS = [
        'audio', 'button', 'canvas', 'embed', 'form', 'iframe', 'img', 'input',
        'math', 'object', 'picture', 'script', 'select', 'source', 'style',
        'svg', 'textarea', 'video'
    ];
    const FORBID_ATTR = [
        'action', 'background', 'formaction', 'onabort', 'onblur', 'onchange',
        'onclick', 'onerror', 'onfocus', 'onload', 'onmouseover', 'onpointerdown',
        'onpointerup', 'onsubmit', 'poster', 'src', 'srcset', 'style', 'xlink:href'
    ];

    const aiMarkdownModule = {
        ctx: null,
        markedConfigured: false,
        vendorPromise: null,
        rerenderPending: false,

        init(ctx) {
            this.ctx = ctx || this.ctx || null;
            this.configureMarked();
            this.ensureStyle();
            return this;
        },

        ensureStyle() {
            if (document.getElementById(STYLE_ID)) return;
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = [
                '#ak-im-root .ak-im-bubble.ak-im-bubble-ai{white-space:normal;max-width:min(82vw,520px)}',
                '#ak-im-root .ak-im-ai-markdown{display:block;font-size:15px;line-height:1.62;color:inherit;word-break:break-word;overflow-wrap:anywhere}',
                '#ak-im-root .ak-im-ai-markdown>*:first-child{margin-top:0}',
                '#ak-im-root .ak-im-ai-markdown>*:last-child{margin-bottom:0}',
                '#ak-im-root .ak-im-ai-markdown p{margin:0 0 8px}',
                '#ak-im-root .ak-im-ai-markdown h1,#ak-im-root .ak-im-ai-markdown h2,#ak-im-root .ak-im-ai-markdown h3{margin:2px 0 8px;font-weight:800;line-height:1.35}',
                '#ak-im-root .ak-im-ai-markdown h1{font-size:17px}',
                '#ak-im-root .ak-im-ai-markdown h2{font-size:16px}',
                '#ak-im-root .ak-im-ai-markdown h3{font-size:15px}',
                '#ak-im-root .ak-im-ai-markdown ul,#ak-im-root .ak-im-ai-markdown ol{margin:0 0 8px 18px;padding:0}',
                '#ak-im-root .ak-im-ai-markdown li{margin:3px 0;padding-left:2px}',
                '#ak-im-root .ak-im-ai-markdown blockquote{margin:0 0 8px;padding:2px 0 2px 10px;border-left:3px solid rgba(37,99,235,.32);color:#475569}',
                '#ak-im-root .ak-im-ai-markdown code{font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;font-size:.92em;background:rgba(15,23,42,.08);border-radius:5px;padding:1px 4px}',
                '#ak-im-root .ak-im-ai-markdown pre{margin:0 0 9px;max-width:100%;overflow:auto;border-radius:8px;background:#0f172a;color:#e5e7eb;padding:10px 11px;white-space:pre}',
                '#ak-im-root .ak-im-ai-markdown pre code{display:block;background:transparent;color:inherit;padding:0;border-radius:0;font-size:12px;line-height:1.55}',
                '#ak-im-root .ak-im-ai-markdown a{color:#2563eb;text-decoration:none;border-bottom:1px solid rgba(37,99,235,.28)}',
                '#ak-im-root .ak-im-ai-markdown a:hover{border-bottom-color:rgba(37,99,235,.72)}',
                '#ak-im-root .ak-im-ai-markdown hr{border:0;border-top:1px solid rgba(15,23,42,.12);margin:10px 0}',
                '#ak-im-root .ak-im-ai-table-scroll{max-width:100%;overflow:auto;margin:0 0 9px;border:1px solid rgba(15,23,42,.10);border-radius:8px}',
                '#ak-im-root .ak-im-ai-table-scroll table{min-width:100%;border-collapse:collapse;font-size:13px;white-space:normal}',
                '#ak-im-root .ak-im-ai-table-scroll th,#ak-im-root .ak-im-ai-table-scroll td{padding:6px 8px;border-bottom:1px solid rgba(15,23,42,.08);text-align:left;vertical-align:top}',
                '#ak-im-root .ak-im-ai-table-scroll tr:last-child td{border-bottom:0}',
                '#ak-im-root .ak-im-ai-thinking{display:inline-flex;align-items:center;gap:7px;color:#475569}',
                '#ak-im-root .ak-im-ai-thinking:before{content:"";width:6px;height:6px;border-radius:999px;background:#2563eb;box-shadow:10px 0 0 rgba(37,99,235,.45),20px 0 0 rgba(37,99,235,.22);animation:ak-im-ai-thinking 1.05s infinite ease-in-out}',
                '@keyframes ak-im-ai-thinking{0%,100%{opacity:.45;transform:translateY(0)}50%{opacity:1;transform:translateY(-1px)}}'
            ].join('\n');
            (document.head || document.documentElement).appendChild(style);
        },

        configureMarked() {
            if (this.markedConfigured) return;
            const api = this.getMarkedApi();
            if (api && typeof api.setOptions === 'function') {
                api.setOptions({
                    breaks: true,
                    gfm: true,
                    silent: true
                });
            }
            this.markedConfigured = !!api;
        },

        getMarkedApi() {
            const markedGlobal = global.marked;
            if (!markedGlobal) return null;
            if (typeof markedGlobal.parse === 'function') return markedGlobal;
            if (markedGlobal.marked && typeof markedGlobal.marked.parse === 'function') return markedGlobal.marked;
            if (typeof markedGlobal.marked === 'function') return {
                parse: markedGlobal.marked,
                setOptions: markedGlobal.setOptions || markedGlobal.marked.setOptions
            };
            if (typeof markedGlobal === 'function') return {
                parse: markedGlobal,
                setOptions: markedGlobal.setOptions
            };
            return null;
        },

        getPurify() {
            const purify = global.DOMPurify;
            return purify && typeof purify.sanitize === 'function' ? purify : null;
        },

        getPluginRoot() {
            const configuredRoot = String(this.ctx && this.ctx.pluginRoot || '').trim();
            if (configuredRoot) return configuredRoot.replace(/\/+$/, '');
            const origin = global.location && global.location.origin ? global.location.origin : '';
            return origin + '/chat/plugins/im/user/modules/ai';
        },

        withAssetVersion(url) {
            if (this.ctx && typeof this.ctx.withAssetVersion === 'function') {
                return this.ctx.withAssetVersion(url);
            }
            return String(url || '');
        },

        getVendorScriptUrl(config) {
            return this.withAssetVersion(this.getPluginRoot() + '/' + config.fileName);
        },

        hasVendorGlobal(config) {
            if (!config || !config.globalName) return false;
            const value = global[config.globalName];
            return !!value;
        },

        loadVendorScript(config) {
            if (this.hasVendorGlobal(config)) return Promise.resolve(true);
            return new Promise((resolve, reject) => {
                const existing = document.querySelector(config.selector);
                if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
                const script = document.createElement('script');
                script.async = true;
                script.src = this.getVendorScriptUrl(config);
                script.dataset[config.datasetKey] = '1';
                script.onload = () => resolve(true);
                script.onerror = () => {
                    script.dataset.akAiMarkdownLoadFailed = '1';
                    reject(new Error('AI markdown vendor load failed'));
                };
                (document.head || document.documentElement || document.body).appendChild(script);
            }).then(() => this.hasVendorGlobal(config));
        },

        ensureVendors() {
            if (this.getMarkedApi() && this.getPurify()) return Promise.resolve(true);
            if (this.vendorPromise) return this.vendorPromise;
            this.vendorPromise = Promise.all(VENDOR_SCRIPTS.map((config) => this.loadVendorScript(config))).then(() => {
                this.markedConfigured = false;
                this.configureMarked();
                this.vendorPromise = null;
                return !!(this.getMarkedApi() && this.getPurify());
            }).catch(() => {
                this.vendorPromise = null;
                return false;
            });
            return this.vendorPromise;
        },

        scheduleRerenderWhenReady() {
            if (this.rerenderPending) return;
            this.rerenderPending = true;
            this.ensureVendors().then((ready) => {
                this.rerenderPending = false;
                if (!ready || !this.ctx || typeof this.ctx.renderMessages !== 'function') return;
                this.ctx.renderMessages();
            });
        },

        escapeHtml(value) {
            if (this.ctx && typeof this.ctx.escapeHtml === 'function') return this.ctx.escapeHtml(value);
            return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
                return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] || ch;
            });
        },

        normalizeText(value) {
            return String(value == null ? '' : value).trim().toLowerCase();
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getViewerUsername() {
            const state = this.getState();
            return this.normalizeText(state && state.username);
        },

        getSenderUsername(item) {
            const fields = [
                'sender_username',
                'sender',
                'username',
                'from_username',
                'from',
                'account',
                'author_username'
            ];
            for (let i = 0; i < fields.length; i += 1) {
                const value = this.normalizeText(item && item[fields[i]]);
                if (value) return value;
            }
            return '';
        },

        isTextLikeMessage(item) {
            const type = this.normalizeText(item && (item.message_type || item.messageType || item.type));
            if (!type) return true;
            return !!TEXT_LIKE_TYPES[type];
        },

        isAIAssistantSession(session) {
            if (!session || typeof session !== 'object') return false;
            const peerUsername = this.normalizeText(session.peer_username);
            if (peerUsername === BOT_USERNAME) return true;
            if (session.is_ai_assistant || session.ai_assistant) return true;
            const avatarSeed = this.normalizeText(session.avatar_seed || session.avatarSeed || session.sender_avatar_seed || session.senderAvatarSeed);
            return avatarSeed === 'ak-ai-assistant';
        },

        getMessageSession(item) {
            if (this.ctx && typeof this.ctx.getActiveSession === 'function') {
                const activeSession = this.ctx.getActiveSession();
                if (activeSession && Number(activeSession.conversation_id || 0) === Number(item && item.conversation_id || 0)) {
                    return activeSession;
                }
            }
            const state = this.getState();
            const sessions = Array.isArray(state && state.sessions) ? state.sessions : [];
            const conversationId = Number(item && item.conversation_id || 0);
            for (let i = 0; i < sessions.length; i += 1) {
                if (Number(sessions[i] && sessions[i].conversation_id || 0) === conversationId) return sessions[i];
            }
            return null;
        },

        isFromViewer(item) {
            if (item && item.is_self === true) return true;
            const viewerUsername = this.getViewerUsername();
            const senderUsername = this.getSenderUsername(item);
            return !!(viewerUsername && senderUsername && viewerUsername === senderUsername);
        },

        isFromAIAssistant(item) {
            const senderUsername = this.getSenderUsername(item);
            if (senderUsername === BOT_USERNAME) return true;
            if (item && (item.is_ai_assistant || item.ai_assistant)) return true;
            const avatarSeed = this.normalizeText(item && (item.avatar_seed || item.avatarSeed || item.sender_avatar_seed || item.senderAvatarSeed));
            return avatarSeed === 'ak-ai-assistant';
        },

        isAITextMessage(item) {
            if (!item || typeof item !== 'object') return false;
            const fromAssistant = this.isFromAIAssistant(item);
            const sessionIsAssistant = this.isAIAssistantSession(this.getMessageSession(item));
            if (!fromAssistant && !sessionIsAssistant) return false;
            if (this.isFromViewer(item)) return false;
            return this.isTextLikeMessage(item);
        },

        isThinkingPlaceholder(item) {
            return !!(item && (item.__akAIPlaceholder || String(item.__akLocalStatus || '').trim() === 'ai-thinking'));
        },

        canRender(item) {
            return this.isAITextMessage(item);
        },

        getMessageText(item) {
            return String(item && (item.content || item.content_preview || '') || '');
        },

        buildMessageBubbleMarkup(item) {
            if (!this.isAITextMessage(item)) return '';
            this.configureMarked();
            this.ensureStyle();
            const text = this.getMessageText(item);
            if (this.isThinkingPlaceholder(item)) {
                return '<span class="ak-im-ai-thinking">' + this.escapeHtml(text) + '</span>';
            }
            return '<div class="ak-im-ai-markdown" data-ak-ai-markdown="1">' + this.renderMarkdown(text) + '</div>';
        },

        getMessageBubbleClassName(item) {
            return this.isAITextMessage(item) ? 'ak-im-bubble-ai' : '';
        },

        renderMarkdown(text) {
            const source = String(text || '').slice(0, MAX_MARKDOWN_LENGTH);
            const api = this.getMarkedApi();
            const purify = this.getPurify();
            if (!api || !purify) {
                this.scheduleRerenderWhenReady();
                return this.renderPlainText(source);
            }
            let rawHtml = '';
            try {
                rawHtml = api.parse(source, {
                    breaks: true,
                    gfm: true,
                    silent: true
                });
            } catch (error) {
                return this.renderPlainText(source);
            }
            let cleanHtml = '';
            try {
                cleanHtml = purify.sanitize(String(rawHtml || ''), {
                    ALLOW_ARIA_ATTR: false,
                    ALLOW_DATA_ATTR: false,
                    ALLOWED_ATTR: ALLOWED_ATTR,
                    ALLOWED_TAGS: ALLOWED_TAGS,
                    FORBID_ATTR: FORBID_ATTR,
                    FORBID_TAGS: FORBID_TAGS,
                    KEEP_CONTENT: true,
                    RETURN_TRUSTED_TYPE: false
                });
            } catch (error) {
                return this.renderPlainText(source);
            }
            return this.postProcessHtml(cleanHtml);
        },

        renderPlainText(text) {
            return this.escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
        },

        postProcessHtml(html) {
            const template = document.createElement('template');
            template.innerHTML = String(html || '');
            Array.prototype.slice.call(template.content.querySelectorAll('a')).forEach((anchor) => {
                const href = String(anchor.getAttribute('href') || '').trim();
                if (!this.isSafeLink(href)) {
                    anchor.removeAttribute('href');
                    anchor.removeAttribute('target');
                    anchor.removeAttribute('rel');
                    return;
                }
                anchor.setAttribute('target', '_blank');
                anchor.setAttribute('rel', 'noopener noreferrer');
            });
            Array.prototype.slice.call(template.content.querySelectorAll('table')).forEach((table) => {
                if (table.parentNode && table.parentNode.classList && table.parentNode.classList.contains('ak-im-ai-table-scroll')) return;
                const wrap = document.createElement('div');
                wrap.className = 'ak-im-ai-table-scroll';
                table.parentNode.insertBefore(wrap, table);
                wrap.appendChild(table);
            });
            return template.innerHTML || '';
        },

        isSafeLink(href) {
            if (!href) return false;
            try {
                const base = global.location && global.location.href ? global.location.href : 'https://invalid.local/';
                const url = new URL(href, base);
                return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
            } catch (error) {
                return false;
            }
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.aiMarkdown = aiMarkdownModule;
})(window);
