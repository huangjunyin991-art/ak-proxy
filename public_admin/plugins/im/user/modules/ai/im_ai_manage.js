(function(global) {
    'use strict';

    const BOT_USERNAME = 'ak_ai_assistant';
    const STYLE_ID = 'ak-im-ai-manage-style';
    const MAX_TASK_POLL_MS = 130000;
    const MAX_TASK_POLL_ERRORS = 6;
    const SESSION_LIST_STALE_MS = 20000;
    const THINKING_TEXT = '\u8bf7\u7a0d\u7b49\uff0c\u8ba9\u6211\u60f3\u60f3...';

    const aiManageModule = {
        ctx: null,
        bootstrapPromise: null,
        sessionPromise: null,
        taskPollTimer: null,

        init(ctx) {
            this.ctx = ctx || null;
            this.ensureState();
            this.ensureStyle();
            this.ensurePlusEntryButton();
            this.loadBootstrap(false);
        },

        ensureState() {
            const state = this.ctx && this.ctx.state;
            if (!state) return;
            if (!state.aiAssistant || typeof state.aiAssistant !== 'object') {
                state.aiAssistant = {
                    bootstrap: null,
                    bootstrapLoadedAt: 0,
                    bootstrapLoading: false,
                    bootstrapError: '',
                    opening: false,
                    redeeming: false,
                    activeTask: null,
                    activeTaskClearingAt: 0,
                    message: ''
                };
            }
            const defaults = {
                sessions: [],
                sessionsLoadedAt: 0,
                sessionsLoading: false,
                sessionsError: '',
                sessionDrawerOpen: false,
                activeSessionId: 0,
                sessionMutating: false,
                treeHydrateRequestedAt: 0,
                pinBottomUntil: 0,
                editingMessageId: 0,
                editingOriginalContent: ''
            };
            Object.keys(defaults).forEach(function(key) {
                if (typeof state.aiAssistant[key] === 'undefined') state.aiAssistant[key] = defaults[key];
            });
        },

        ensureStyle() {
            if (document.getElementById(STYLE_ID)) return;
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = [
                '#ak-im-root .ak-im-ai-status{display:flex!important;align-items:center;justify-content:space-between;gap:8px;min-height:26px;padding:4px 10px;margin:0;color:#3b4758;font-size:12px;line-height:1.3;background:linear-gradient(90deg,rgba(70,130,255,.10),rgba(39,196,134,.10));border-top:1px solid rgba(15,23,42,.06);box-sizing:border-box}',
                '#ak-im-root .ak-im-ai-status-main{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
                '#ak-im-root .ak-im-ai-status-pill{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:18px;padding:0 7px;border-radius:999px;background:rgba(36,97,235,.13);color:#1f4ed8;font-size:11px;font-weight:700;white-space:nowrap}',
                '#ak-im-root .ak-im-ai-status-side{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
                '#ak-im-root .ak-im-ai-status-quota{color:#5b6472;font-variant-numeric:tabular-nums}',
                '#ak-im-root .ak-im-ai-status-task{color:#2563eb;font-weight:700}',
                '#ak-im-root .ak-im-ai-status-action{border:0;background:transparent;color:#2563eb;font-size:12px;font-weight:700;padding:0 2px;cursor:pointer;white-space:nowrap}',
                '#ak-im-root .ak-im-ai-status.is-error{background:rgba(255,71,87,.08);color:#b91c1c}',
                '#ak-im-root .ak-im-ai-status.is-error .ak-im-ai-status-pill{background:rgba(255,71,87,.12);color:#b91c1c}',
                '#ak-im-root .ak-im-topbar.ak-im-ai-topbar-enabled{grid-template-columns:52px minmax(0,1fr) 78px;column-gap:4px}',
                '#ak-im-root .ak-im-ai-topbar-actions{grid-column:3;grid-row:1;justify-self:end;display:flex;align-items:center;justify-content:flex-end;gap:5px;z-index:2}',
                '#ak-im-root .ak-im-ai-topbar-btn{width:34px;height:34px;border:0;border-radius:999px;background:rgba(15,23,42,.06);color:#1f2937;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s ease,color .15s ease,transform .12s ease,opacity .12s ease}',
                '#ak-im-root .ak-im-ai-topbar-btn svg{width:18px;height:18px;display:block;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
                '#ak-im-root .ak-im-ai-topbar-btn:hover{background:rgba(37,99,235,.12);color:#1d4ed8}',
                '#ak-im-root .ak-im-ai-topbar-btn:active{transform:translateY(1px)}',
                '#ak-im-root .ak-im-ai-topbar-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}',
                '#ak-im-root .ak-im-ai-session-mask{position:absolute;inset:0;z-index:78;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.22);backdrop-filter:blur(3px);box-sizing:border-box}',
                '#ak-im-root .ak-im-ai-session-panel{width:100%;max-height:min(70vh,520px);border-radius:18px 18px 0 0;background:#f8fafc;box-shadow:0 -18px 46px rgba(15,23,42,.18);overflow:hidden;display:flex;flex-direction:column}',
                '#ak-im-root .ak-im-ai-session-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px 10px;background:#fff;border-bottom:1px solid rgba(15,23,42,.07)}',
                '#ak-im-root .ak-im-ai-session-title{min-width:0;font-size:16px;font-weight:900;color:#101827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '#ak-im-root .ak-im-ai-session-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
                '#ak-im-root .ak-im-ai-session-btn{height:32px;border:1px solid rgba(37,99,235,.16);border-radius:999px;background:#eef4ff;color:#1d4ed8;padding:0 12px;font-size:12px;font-weight:900;cursor:pointer}',
                '#ak-im-root .ak-im-ai-session-btn.secondary{background:#f1f5f9;color:#334155;border-color:rgba(15,23,42,.08)}',
                '#ak-im-root .ak-im-ai-session-btn:disabled{opacity:.5;cursor:not-allowed}',
                '#ak-im-root .ak-im-ai-session-list{padding:8px 10px 14px;overflow:auto;box-sizing:border-box}',
                '#ak-im-root .ak-im-ai-session-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;min-height:52px;border:1px solid transparent;border-radius:12px;background:transparent;padding:8px 9px;margin:3px 0;box-sizing:border-box;text-align:left;cursor:pointer}',
                '#ak-im-root .ak-im-ai-session-row.is-active{background:#fff;border-color:rgba(37,99,235,.20);box-shadow:0 6px 18px rgba(15,23,42,.07)}',
                '#ak-im-root .ak-im-ai-session-main{min-width:0}',
                '#ak-im-root .ak-im-ai-session-name{font-size:14px;font-weight:900;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '#ak-im-root .ak-im-ai-session-meta{margin-top:4px;color:#64748b;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '#ak-im-root .ak-im-ai-session-row-actions{display:flex;align-items:center;gap:6px}',
                '#ak-im-root .ak-im-ai-session-icon-btn{width:30px;height:30px;border:0;border-radius:999px;background:rgba(15,23,42,.06);color:#334155;font-size:12px;font-weight:900;cursor:pointer}',
                '#ak-im-root .ak-im-ai-session-icon-btn.danger{color:#b91c1c;background:rgba(239,68,68,.10)}',
                '#ak-im-root .ak-im-ai-session-empty{padding:26px 12px;color:#64748b;font-size:13px;text-align:center;line-height:1.6}',
                '#ak-im-root .ak-im-ai-tree-actions{display:flex;align-items:center;gap:6px;margin-top:5px;min-height:28px;flex-wrap:wrap}',
                '#ak-im-root .ak-im-message-row.ak-self .ak-im-ai-tree-actions{justify-content:flex-end}',
                '#ak-im-root .ak-im-ai-tree-btn{width:28px;height:28px;border:0;border-radius:999px;background:rgba(15,23,42,.07);color:#475569;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s ease,color .15s ease,transform .12s ease,opacity .12s ease}',
                '#ak-im-root .ak-im-ai-tree-btn svg{width:15px;height:15px;display:block;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
                '#ak-im-root .ak-im-ai-tree-btn:hover{background:rgba(37,99,235,.12);color:#1d4ed8}',
                '#ak-im-root .ak-im-ai-tree-btn:active{transform:translateY(1px)}',
                '#ak-im-root .ak-im-ai-tree-btn:disabled{opacity:.38;cursor:not-allowed;transform:none;background:rgba(15,23,42,.05);color:#94a3b8}',
                '#ak-im-root .ak-im-ai-tree-btn.primary{background:rgba(37,99,235,.10);color:#1d4ed8}',
                '#ak-im-root .ak-im-ai-tree-btn.is-copied{background:rgba(34,197,94,.14);color:#15803d}',
                '#ak-im-root .ak-im-message-row.ak-self .ak-im-ai-tree-btn{background:rgba(20,83,45,.10);color:#166534}',
                '#ak-im-root .ak-im-message-row.ak-self .ak-im-ai-tree-btn:hover{background:rgba(20,83,45,.16);color:#14532d}',
                '#ak-im-root .ak-im-message-row.ak-self .ak-im-ai-tree-btn:disabled{background:rgba(20,83,45,.06);color:rgba(20,83,45,.42)}',
                '#ak-im-root .ak-im-ai-tree-version{display:inline-flex;align-items:center;gap:4px;height:28px;border-radius:999px;background:rgba(15,23,42,.06);padding:0 4px;color:#475569;font-size:11px;font-weight:800}',
                '#ak-im-root .ak-im-ai-tree-version button{width:22px;height:22px;border:0;border-radius:999px;background:#fff;color:#334155;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 1px 2px rgba(15,23,42,.08)}',
                '#ak-im-root .ak-im-ai-tree-version button svg{width:13px;height:13px;display:block;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}',
                '#ak-im-root .ak-im-ai-tree-version button:disabled{opacity:.42;cursor:not-allowed}',
                '#ak-im-root .ak-im-ai-suggestions{display:flex;align-items:center;gap:7px;padding:7px 10px 0;background:#f7f7f7;border-top:1px solid rgba(15,23,42,.06);box-sizing:border-box;overflow-x:auto;scrollbar-width:none}',
                '#ak-im-root .ak-im-ai-suggestions::-webkit-scrollbar{display:none}',
                '#ak-im-root .ak-im-ai-suggestion-label{flex:0 0 auto;color:#7b8494;font-size:12px;white-space:nowrap}',
                '#ak-im-root .ak-im-ai-suggestion-chip{flex:0 0 auto;max-width:52vw;height:30px;border:1px solid rgba(37,99,235,.18);border-radius:999px;background:#fff;color:#1f2937;padding:0 11px;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(15,23,42,.05);cursor:pointer}',
                '#ak-im-root .ak-im-ai-suggestion-chip:active{transform:translateY(1px);background:#eef4ff}',
                '#ak-im-root .ak-im-ai-redeem-mask{position:absolute;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(15,23,42,.28);backdrop-filter:blur(4px);box-sizing:border-box}',
                '#ak-im-root .ak-im-ai-redeem-card{width:min(360px,100%);border:1px solid rgba(15,23,42,.10);border-radius:14px;background:#fff;box-shadow:0 18px 48px rgba(15,23,42,.22);padding:16px;box-sizing:border-box}',
                '#ak-im-root .ak-im-ai-redeem-title{font-size:16px;font-weight:800;color:#111827;margin-bottom:6px}',
                '#ak-im-root .ak-im-ai-redeem-sub{font-size:12px;line-height:1.6;color:#64748b;margin-bottom:12px}',
                '#ak-im-root .ak-im-ai-redeem-input{width:100%;height:40px;border:1px solid #d8dee9;border-radius:10px;background:#f8fafc;color:#111827;padding:0 11px;outline:none;font-size:14px;box-sizing:border-box}',
                '#ak-im-root .ak-im-ai-redeem-input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}',
                '#ak-im-root .ak-im-ai-redeem-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:14px}',
                '#ak-im-root .ak-im-ai-redeem-btn{height:36px;border:0;border-radius:10px;padding:0 13px;background:#eef2f7;color:#334155;font-weight:800;cursor:pointer}',
                '#ak-im-root .ak-im-ai-redeem-btn.primary{background:#2563eb;color:#fff}',
                '#ak-im-root .ak-im-ai-redeem-btn:disabled{opacity:.55;cursor:not-allowed}',
                '#ak-im-root .ak-im-bubble.ak-im-bubble-ai-thinking{min-width:min(188px,64vw);max-width:min(260px,74vw);padding:9px 12px;white-space:normal;overflow:visible}',
                '#ak-im-root .ak-im-ai-thinking{display:flex;align-items:center;gap:10px;min-width:0;color:#475569}',
                '#ak-im-root .ak-im-ai-thinking-dots{display:inline-flex;align-items:center;gap:4px;width:26px;min-width:26px;height:16px;flex:0 0 26px}',
                '#ak-im-root .ak-im-ai-thinking-dots i{display:block;width:5px;height:5px;border-radius:999px;background:#2563eb;animation:ak-im-ai-thinking 1.05s infinite ease-in-out}',
                '#ak-im-root .ak-im-ai-thinking-dots i:nth-child(2){animation-delay:.14s;opacity:.56}',
                '#ak-im-root .ak-im-ai-thinking-dots i:nth-child(3){animation-delay:.28s;opacity:.34}',
                '#ak-im-root .ak-im-ai-thinking-text{display:block;min-width:0;white-space:normal;overflow:visible;text-overflow:clip;line-height:1.45}',
                '@keyframes ak-im-ai-thinking{0%,100%{opacity:.36;transform:translateY(0)}50%{opacity:1;transform:translateY(-1px)}}'
            ].join('\n');
            (document.head || document.documentElement).appendChild(style);
        },

        ensurePlusEntryButton() {
            const root = this.ctx && this.ctx.elements && this.ctx.elements.root ? this.ctx.elements.root : document.getElementById('ak-im-root');
            const grid = root ? root.querySelector('.ak-im-plus-grid') : null;
            if (!grid || grid.querySelector('[data-im-plus-action="ai-assistant"]')) return;
            const button = document.createElement('button');
            button.className = 'ak-im-plus-item';
            button.type = 'button';
            button.setAttribute('data-im-plus-action', 'ai-assistant');
            button.innerHTML = [
                '<span class="ak-im-plus-item-icon">',
                '<svg viewBox="0 0 24 24" aria-hidden="true">',
                '<path d="M5.1 6.7c0-1.2 1-2.2 2.2-2.2h8.4c1.2 0 2.2 1 2.2 2.2v5.8c0 1.2-1 2.2-2.2 2.2h-4.1l-3.5 3v-3h-.8c-1.2 0-2.2-1-2.2-2.2V6.7Z"></path>',
                '<path d="M10.3 9.3h3.4"></path>',
                '<path d="M12 7.6v3.4"></path>',
                '<path d="M16.3 3.7l.5-1 .5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5Z"></path>',
                '</svg>',
                '</span>',
                '<span class="ak-im-plus-item-label">AI助手</span>'
            ].join('');
            const videoButton = grid.querySelector('[data-im-plus-action="call-video"]');
            if (videoButton && videoButton.nextSibling) {
                grid.insertBefore(button, videoButton.nextSibling);
            } else {
                grid.insertBefore(button, grid.firstChild);
            }
            button.addEventListener('click', () => {
                if (this.ctx && typeof this.ctx.closePlusPanel === 'function') this.ctx.closePlusPanel({ silent: true });
                this.openAssistant();
            });
        },

        escapeHtml(value) {
            if (this.ctx && typeof this.ctx.escapeHtml === 'function') return this.ctx.escapeHtml(value);
            return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
                return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] || ch;
            });
        },

        aiTreeIcon(name) {
            switch (String(name || '').trim()) {
            case 'copy':
                return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"></path></svg>';
            case 'edit':
                return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"></path></svg>';
            case 'regenerate':
                return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.3 6.4"></path><path d="M3 12a9 9 0 0 1 15.3-6.4"></path><path d="M18 2v4h-4"></path><path d="M6 22v-4h4"></path></svg>';
            case 'check':
                return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';
            case 'sessions':
                return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14"></path><path d="M5 12h14"></path><path d="M5 17h9"></path><path d="M3.5 7h.01"></path><path d="M3.5 12h.01"></path><path d="M3.5 17h.01"></path></svg>';
            case 'new-session':
                return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>';
            case 'prev':
                return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>';
            case 'next':
                return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>';
            default:
                return '';
            }
        },

        aiTreeIconButton(action, messageId, label, iconName, options) {
            const opts = options && typeof options === 'object' ? options : {};
            const disabled = opts.disabled ? ' disabled aria-disabled="true"' : '';
            const extraClass = opts.primary ? ' primary' : '';
            return '<button type="button" class="ak-im-ai-tree-btn' + extraClass + '" data-ak-ai-tree-' + this.escapeHtml(action) + '="' + Number(messageId || 0) + '" title="' + this.escapeHtml(label) + '" aria-label="' + this.escapeHtml(label) + '"' + disabled + '>' + this.aiTreeIcon(iconName) + '</button>';
        },

        isAIActionBusy(conversationId) {
            const state = this.ctx && this.ctx.state;
            const aiState = state && state.aiAssistant ? state.aiAssistant : null;
            const activeTask = aiState && aiState.activeTask ? aiState.activeTask : null;
            if (!activeTask || this.isTerminalTaskStatus(activeTask.status)) return false;
            const activeConversationId = Number(conversationId || state && state.activeConversationId || 0);
            return !activeConversationId || Number(activeTask.conversation_id || 0) === activeConversationId;
        },

        getTreeMessageText(item) {
            return String(item && (item.content || item.content_preview || '') || '').trim();
        },

        isAssistantMessage(item) {
            return String(item && item.sender_username || '').trim().toLowerCase() === BOT_USERNAME
                || String(item && item.__akAIRole || '').trim().toLowerCase() === 'assistant';
        },

        keepConversationPinnedToBottom(durationMs) {
            const state = this.ctx && this.ctx.state;
            if (!state || !state.aiAssistant) return;
            const duration = Math.max(1200, Number(durationMs || 0) || 3000);
            state.aiAssistant.pinBottomUntil = Math.max(Number(state.aiAssistant.pinBottomUntil || 0), Date.now() + duration);
            if (typeof this.ctx.forceScrollToBottom === 'function') this.ctx.forceScrollToBottom(duration);
        },

        shouldPinConversationToBottom(conversationId) {
            const state = this.ctx && this.ctx.state;
            if (!state || !this.isAIConversation()) return false;
            const targetConversationId = Number(conversationId || state.activeConversationId || 0);
            if (!targetConversationId || targetConversationId !== Number(state.activeConversationId || 0)) return false;
            const aiState = state.aiAssistant || {};
            if (Number(aiState.pinBottomUntil || 0) > Date.now()) return true;
            const activeTask = aiState.activeTask && Number(aiState.activeTask.conversation_id || 0) === targetConversationId ? aiState.activeTask : null;
            if (activeTask && !this.isTerminalTaskStatus(activeTask.status)) return true;
            return (Array.isArray(state.activeMessages) ? state.activeMessages : []).some(function(item) {
                return !!(item && item.__akAIPlaceholder);
            });
        },

        maybeHydrateTreeMessages() {
            const state = this.ctx && this.ctx.state;
            if (!state || !state.aiAssistant || !this.isAIConversation() || !Array.isArray(state.activeMessages) || !state.activeMessages.length) return;
            const hasTreeMessage = state.activeMessages.some(function(item) {
                return !!(item && item.__akAITreeMessage);
            });
            if (hasTreeMessage) return;
            const hasPlaceholder = state.activeMessages.some(function(item) {
                return !!(item && item.__akAIPlaceholder);
            });
            if (hasPlaceholder) return;
            const now = Date.now();
            if (now - Number(state.aiAssistant.treeHydrateRequestedAt || 0) < 3500) return;
            state.aiAssistant.treeHydrateRequestedAt = now;
            this.loadSessionMessages(state.activeConversationId, { forceRefresh: true });
        },

        copyText(text) {
            const content = String(text == null ? '' : text);
            if (!content) return Promise.resolve(false);
            try {
                if (global.navigator && global.navigator.clipboard && typeof global.navigator.clipboard.writeText === 'function') {
                    return global.navigator.clipboard.writeText(content).then(function() { return true; }).catch(function() { return false; });
                }
            } catch (error) {}
            return new Promise(function(resolve) {
                try {
                    const ta = document.createElement('textarea');
                    ta.value = content;
                    ta.setAttribute('readonly', 'readonly');
                    ta.style.position = 'fixed';
                    ta.style.left = '-9999px';
                    ta.style.top = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    const ok = document.execCommand && document.execCommand('copy');
                    if (ta.parentNode) ta.parentNode.removeChild(ta);
                    resolve(!!ok);
                } catch (error) {
                    resolve(false);
                }
            });
        },

        setCopyButtonFeedback(button, ok) {
            if (!button) return;
            const originalHtml = button.innerHTML;
            const originalTitle = button.getAttribute('title') || '复制内容';
            button.classList.toggle('is-copied', !!ok);
            button.innerHTML = ok ? this.aiTreeIcon('check') : this.aiTreeIcon('copy');
            button.setAttribute('title', ok ? '已复制' : '复制失败');
            button.setAttribute('aria-label', ok ? '已复制' : '复制失败');
            setTimeout(() => {
                if (!button || !button.isConnected) return;
                button.classList.remove('is-copied');
                button.innerHTML = originalHtml || this.aiTreeIcon('copy');
                button.setAttribute('title', originalTitle);
                button.setAttribute('aria-label', originalTitle);
            }, ok ? 1200 : 1600);
        },

        loadBootstrap(force) {
            const state = this.ctx && this.ctx.state;
            if (!this.ctx || typeof this.ctx.request !== 'function' || !this.ctx.httpRoot) return Promise.resolve(null);
            this.ensureState();
            if (!force && state && state.aiAssistant && state.aiAssistant.bootstrap) {
                return Promise.resolve(state.aiAssistant.bootstrap);
            }
            if (!force && this.bootstrapPromise) return this.bootstrapPromise;
            if (state && state.aiAssistant) {
                state.aiAssistant.bootstrapLoading = true;
                state.aiAssistant.bootstrapError = '';
            }
            this.bootstrapPromise = this.ctx.request(this.ctx.httpRoot + '/ai/bootstrap').then((data) => {
                if (state && state.aiAssistant) {
                    state.aiAssistant.bootstrap = data || null;
                    state.aiAssistant.bootstrapLoadedAt = Date.now();
                    state.aiAssistant.bootstrapLoading = false;
                    state.aiAssistant.bootstrapError = '';
                }
                return data || null;
            }).catch((error) => {
                if (state && state.aiAssistant) {
                    state.aiAssistant.bootstrapLoading = false;
                    state.aiAssistant.bootstrapError = error && error.message ? error.message : 'AI 助手状态加载失败';
                }
                return null;
            }).finally(() => {
                this.bootstrapPromise = null;
                if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
            });
            return this.bootstrapPromise;
        },

        normalizeSessionPayload(data) {
            const payload = data && data.item && Array.isArray(data.item.items) ? data.item : data;
            const items = Array.isArray(payload && payload.items) ? payload.items : [];
            const activeSession = payload && payload.active_session ? payload.active_session : null;
            const activeSessionId = Number(payload && payload.active_session_id || activeSession && activeSession.id || 0);
            return {
                items: items,
                activeSessionId: activeSessionId,
                activeSession: activeSession
            };
        },

        applySessionPayload(data) {
            const state = this.ctx && this.ctx.state;
            if (!state || !state.aiAssistant) return this.normalizeSessionPayload(data);
            const payload = this.normalizeSessionPayload(data);
            state.aiAssistant.sessions = payload.items;
            state.aiAssistant.activeSessionId = payload.activeSessionId;
            state.aiAssistant.sessionsLoadedAt = Date.now();
            state.aiAssistant.sessionsError = '';
            return payload;
        },

        shouldUseSessionMessages(conversationId) {
            const state = this.ctx && this.ctx.state;
            const activeConversationId = Number(conversationId || state && state.activeConversationId || 0);
            if (!activeConversationId) return false;
            const activeSession = this.ctx && typeof this.ctx.getActiveSession === 'function' ? this.ctx.getActiveSession() : null;
            if (activeSession && Number(activeSession.conversation_id || 0) === activeConversationId) {
                return this.isAIConversation(activeSession);
            }
            return this.isAIConversation();
        },

        getActiveAISessionId() {
            const state = this.ctx && this.ctx.state;
            const aiState = state && state.aiAssistant ? state.aiAssistant : null;
            const activeId = Number(aiState && aiState.activeSessionId || 0);
            if (activeId > 0) return activeId;
            const items = Array.isArray(aiState && aiState.sessions) ? aiState.sessions : [];
            for (let index = 0; index < items.length; index += 1) {
                const id = Number(items[index] && items[index].id || 0);
                if (id > 0) return id;
            }
            return 0;
        },

        normalizeSessionMessagesPayload(data) {
            const payload = data && data.messages && Array.isArray(data.messages.items) ? data.messages : data;
            return {
                session: payload && payload.session ? payload.session : null,
                activeMessageId: Number(payload && payload.active_message_id || 0),
                items: Array.isArray(payload && payload.items) ? payload.items : []
            };
        },

        treeMessageToChatItem(item, conversationId, index) {
            const message = item && item.Message ? item.Message : item;
            const role = String(message && message.role || '').trim().toLowerCase();
            const isAssistant = role === 'assistant';
            const isUser = role === 'user';
            const senderUsername = isAssistant ? BOT_USERNAME : String(this.ctx && this.ctx.state && this.ctx.state.username || '');
            const displayName = isAssistant ? '\u5c0f\u0041' : String(this.ctx && this.ctx.state && (this.ctx.state.displayName || this.ctx.state.username) || '');
            const content = String(message && message.content || '');
            const versions = Array.isArray(item && item.versions) ? item.versions : [];
            const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
            const suggestions = Array.isArray(metadata.suggestions) ? metadata.suggestions : [];
            return {
                id: Number(message && message.id || 0),
                conversation_id: Number(conversationId || 0),
                sender_username: senderUsername,
                sender_display_name: displayName,
                seq_no: Number(index || 0) + 1,
                message_type: 'text',
                content: content,
                content_preview: content,
                status: 'sent',
                sent_at: message && message.created_at ? message.created_at : new Date().toISOString(),
                avatar_kind: isAssistant ? 'generated' : undefined,
                avatar_style: isAssistant ? 'thumbs' : undefined,
                avatar_seed: isAssistant ? 'ak-ai-assistant' : undefined,
                ai_suggestions: suggestions,
                __akAITreeMessage: true,
                __akAIMessageId: Number(message && message.id || 0),
                __akAISessionId: Number(message && message.session_id || 0),
                __akAIRole: role,
                __akAICanEdit: isUser,
                __akAICanRegenerate: isAssistant || isUser,
                __akAIVersionNo: Number(message && message.version_no || 1),
                __akAIVersionCount: Math.max(1, Number(item && item.version_count || versions.length || 1) || 1),
                __akAIVersions: versions
            };
        },

        applySessionMessagesPayload(data, conversationId) {
            const state = this.ctx && this.ctx.state;
            if (!state || !state.aiAssistant) return this.normalizeSessionMessagesPayload(data);
            const payload = this.normalizeSessionMessagesPayload(data);
            if (payload.session && payload.session.id) {
                state.aiAssistant.activeSessionId = Number(payload.session.id || 0);
            }
            state.aiAssistant.activeMessageId = payload.activeMessageId;
            state.aiAssistant.sessionMessagesLoadedAt = Date.now();
            const messages = payload.items.map((item, index) => this.treeMessageToChatItem(item, conversationId || state.activeConversationId, index));
            state.activeMessages = messages;
            state.activeMessagesLoading = false;
            return payload;
        },

        loadSessionMessages(conversationId, options) {
            const state = this.ctx && this.ctx.state;
            if (!this.ctx || typeof this.ctx.request !== 'function' || !state || !state.aiAssistant) return Promise.resolve(null);
            const targetConversationId = Number(conversationId || state.activeConversationId || 0);
            if (!targetConversationId) return Promise.resolve(null);
            const ensureSession = () => {
                const activeId = this.getActiveAISessionId();
                if (activeId > 0) return Promise.resolve(activeId);
                return this.loadAISessions(true).then(() => this.getActiveAISessionId());
            };
            state.activeMessagesLoading = true;
            const hasCurrentMessages = Array.isArray(state.activeMessages) && state.activeMessages.length > 0;
            if (!hasCurrentMessages && typeof this.ctx.renderMessages === 'function') this.ctx.renderMessages();
            return ensureSession().then((sessionId) => {
                if (!sessionId) {
                    state.activeMessages = [];
                    state.activeMessagesLoading = false;
                    if (typeof this.ctx.renderMessages === 'function') this.ctx.renderMessages();
                    return null;
                }
                return this.ctx.request(this.ctx.httpRoot + '/ai/sessions/' + encodeURIComponent(sessionId) + '/messages').then((data) => {
                    this.applySessionMessagesPayload(data, targetConversationId);
                    if (typeof this.ctx.renderMessages === 'function') this.ctx.renderMessages();
                    if (this.shouldPinConversationToBottom(targetConversationId)) this.keepConversationPinnedToBottom(2400);
                    this.renderAIMessageControls();
                    const activeTask = state.aiAssistant && state.aiAssistant.activeTask && Number(state.aiAssistant.activeTask.conversation_id || 0) === targetConversationId
                        ? state.aiAssistant.activeTask
                        : null;
                    if (activeTask && !this.isTerminalTaskStatus(activeTask.status)) {
                        this.showThinkingPlaceholder(activeTask);
                    } else {
                        this.renderSuggestions();
                    }
                    return data;
                });
            }).catch((error) => {
                state.activeMessagesLoading = false;
                state.aiAssistant.sessionsError = error && error.message ? error.message : 'AI 会话消息加载失败';
                if (typeof this.ctx.renderMessages === 'function') this.ctx.renderMessages();
                return null;
            });
        },

        findTreeMessage(messageId) {
            const state = this.ctx && this.ctx.state;
            const targetId = Number(messageId || 0);
            if (!state || !targetId || !Array.isArray(state.activeMessages)) return null;
            for (let index = 0; index < state.activeMessages.length; index += 1) {
                const item = state.activeMessages[index];
                if (item && Number(item.__akAIMessageId || item.id || 0) === targetId) return item;
            }
            return null;
        },

        runTreeMessageAction(messageId, action, body) {
            const state = this.ctx && this.ctx.state;
            const sessionId = Number(state && state.aiAssistant && state.aiAssistant.activeSessionId || 0);
            const targetId = Number(messageId || 0);
            if (!this.ctx || typeof this.ctx.request !== 'function' || !sessionId || !targetId) return Promise.resolve(null);
            return this.ctx.request(this.ctx.httpRoot + '/ai/sessions/' + encodeURIComponent(sessionId) + '/messages/' + encodeURIComponent(targetId) + '/' + encodeURIComponent(action), {
                method: 'POST',
                body: body ? JSON.stringify(body) : '{}'
            }).then((data) => {
                const payload = data && data.messages ? data.messages : data;
                this.applySessionMessagesPayload(payload, state.activeConversationId);
                if (data && data.ai_task && data.ai_task.task_id) {
                    this.setActiveTask(data.ai_task);
                } else if (typeof this.ctx.renderMessages === 'function') {
                    this.ctx.renderMessages();
                }
                this.renderAIMessageControls();
                return data;
            }).catch((error) => {
                if (typeof global.alert === 'function') global.alert(error && error.message ? error.message : 'AI 消息操作失败');
                return null;
            });
        },

        clearEditingState() {
            const state = this.ctx && this.ctx.state;
            if (!state || !state.aiAssistant) return;
            state.aiAssistant.editingMessageId = 0;
            state.aiAssistant.editingOriginalContent = '';
        },

        editTreeMessage(messageId) {
            const item = this.findTreeMessage(messageId);
            if (!item) return Promise.resolve(null);
            const current = this.getTreeMessageText(item);
            if (!current) return Promise.resolve(null);
            this.removeSuggestionBar();
            const state = this.ctx && this.ctx.state;
            if (state && state.aiAssistant) {
                state.aiAssistant.editingMessageId = Number(messageId || 0);
                state.aiAssistant.editingOriginalContent = current;
            }
            if (this.ctx && typeof this.ctx.setComposerText === 'function') this.ctx.setComposerText(current);
            return Promise.resolve(null);
        },

        handleComposerSubmit(content) {
            const state = this.ctx && this.ctx.state;
            const aiState = state && state.aiAssistant ? state.aiAssistant : null;
            const messageId = Number(aiState && aiState.editingMessageId || 0);
            if (!messageId || !this.isAIConversation()) return Promise.resolve(false);
            const nextContent = String(content || '').trim();
            const originalContent = String(aiState.editingOriginalContent || '').trim();
            if (!nextContent) return Promise.resolve(true);
            if (nextContent === originalContent) {
                this.clearEditingState();
                if (this.ctx && typeof this.ctx.clearComposerText === 'function') this.ctx.clearComposerText();
                return this.regenerateTreeMessage(messageId).then(function() { return true; });
            }
            this.removeSuggestionBar();
            this.clearEditingState();
            if (this.ctx && typeof this.ctx.clearComposerText === 'function') this.ctx.clearComposerText();
            return this.runTreeMessageAction(messageId, 'edit', { content: nextContent }).then(function() {
                return true;
            });
        },

        regenerateTreeMessage(messageId) {
            const state = this.ctx && this.ctx.state;
            const wasEditing = Number(state && state.aiAssistant && state.aiAssistant.editingMessageId || 0) > 0;
            this.clearEditingState();
            if (wasEditing && this.ctx && typeof this.ctx.clearComposerText === 'function') this.ctx.clearComposerText();
            this.removeSuggestionBar();
            return this.runTreeMessageAction(messageId, 'regenerate', null);
        },

        copyTreeMessage(messageId, button) {
            const item = this.findTreeMessage(messageId);
            const content = this.getTreeMessageText(item);
            if (!item || !content) {
                this.setCopyButtonFeedback(button, false);
                return Promise.resolve(false);
            }
            return this.copyText(content).then((ok) => {
                this.setCopyButtonFeedback(button, ok);
                return ok;
            });
        },

        activateTreeMessage(messageId) {
            return this.runTreeMessageAction(messageId, 'activate', null).then((data) => {
                if (!data && this.ctx && typeof this.ctx.renderMessages === 'function') this.ctx.renderMessages();
                return data;
            });
        },

        activateAdjacentVersion(messageId, direction) {
            const item = this.findTreeMessage(messageId);
            const versions = Array.isArray(item && item.__akAIVersions) ? item.__akAIVersions : [];
            if (!item || versions.length <= 1) return Promise.resolve(null);
            const currentId = Number(item.__akAIMessageId || item.id || 0);
            let currentIndex = -1;
            versions.forEach(function(version, index) {
                if (Number(version && version.id || 0) === currentId) currentIndex = index;
            });
            if (currentIndex < 0) currentIndex = 0;
            const step = String(direction || '') === 'prev' ? -1 : 1;
            const nextIndex = (currentIndex + step + versions.length) % versions.length;
            const nextId = Number(versions[nextIndex] && versions[nextIndex].id || 0);
            if (!nextId || nextId === currentId) return Promise.resolve(null);
            return this.activateTreeMessage(nextId);
        },

        getLatestUserActionMessageId() {
            const state = this.ctx && this.ctx.state;
            const items = state && Array.isArray(state.activeMessages) ? state.activeMessages : [];
            for (let index = items.length - 1; index >= 0; index -= 1) {
                const item = items[index];
                if (!item || item.__akAIPlaceholder || !item.__akAITreeMessage) continue;
                const role = String(item.__akAIRole || '').trim().toLowerCase();
                if (role !== 'user') continue;
                const messageId = Number(item.__akAIMessageId || item.id || 0);
                if (messageId > 0) return messageId;
            }
            return 0;
        },

        renderAIMessageControls() {
            const root = this.getRootElement();
            const state = this.ctx && this.ctx.state;
            this.renderTopbarActions();
            if (!root || !state || !this.isAIConversation() || !Array.isArray(state.activeMessages)) return;
            root.querySelectorAll('.ak-im-ai-tree-actions').forEach(function(node) {
                if (node && node.parentNode) node.parentNode.removeChild(node);
            });
            const labels = {
                copy: '\u590d\u5236\u5185\u5bb9',
                edit: '\u4fee\u6539\u540e\u91cd\u65b0\u751f\u6210',
                regenerate: '\u91cd\u65b0\u751f\u6210',
                prev: '\u4e0a\u4e00\u4e2a\u7248\u672c',
                next: '\u4e0b\u4e00\u4e2a\u7248\u672c'
            };
            let hasTreeMessage = false;
            const latestUserActionMessageId = this.getLatestUserActionMessageId();
            state.activeMessages.forEach((item) => {
                if (!item || item.__akAIPlaceholder) return;
                const isTreeMessage = !!item.__akAITreeMessage;
                if (isTreeMessage) hasTreeMessage = true;
                const messageId = Number((isTreeMessage ? item.__akAIMessageId : item.id) || item.id || 0);
                if (!messageId) return;
                const wrapper = root.querySelector('[data-im-message-id="' + String(messageId) + '"]');
                const main = wrapper ? wrapper.querySelector('.ak-im-message-main') : null;
                if (!main) return;
                const role = String(item.__akAIRole || '').trim().toLowerCase() || (this.isAssistantMessage(item) ? 'assistant' : 'user');
                const versionCount = Number(item.__akAIVersionCount || 1);
                const versionNo = Number(item.__akAIVersionNo || 1);
                const busy = this.isAIActionBusy(item.conversation_id || state.activeConversationId);
                const actions = document.createElement('div');
                actions.className = 'ak-im-ai-tree-actions';
                const parts = [];
                if (role === 'assistant' && this.getTreeMessageText(item)) {
                    parts.push(this.aiTreeIconButton('copy', messageId, labels.copy, 'copy'));
                }
                const canMutateLatest = isTreeMessage && role === 'user' && messageId === latestUserActionMessageId;
                if (canMutateLatest && role === 'user') {
                    parts.push(this.aiTreeIconButton('edit', messageId, labels.edit, 'edit', { disabled: busy }));
                }
                if (canMutateLatest) {
                    parts.push(this.aiTreeIconButton('regenerate', messageId, labels.regenerate, 'regenerate', { primary: true, disabled: busy }));
                }
                if (isTreeMessage && versionCount > 1) {
                    const disabled = busy ? ' disabled aria-disabled="true"' : '';
                    parts.push('<span class="ak-im-ai-tree-version"><button type="button" data-ak-ai-tree-version-prev="' + messageId + '" title="' + this.escapeHtml(labels.prev) + '" aria-label="' + this.escapeHtml(labels.prev) + '"' + disabled + '>' + this.aiTreeIcon('prev') + '</button><span>' + versionNo + '/' + versionCount + '</span><button type="button" data-ak-ai-tree-version-next="' + messageId + '" title="' + this.escapeHtml(labels.next) + '" aria-label="' + this.escapeHtml(labels.next) + '"' + disabled + '>' + this.aiTreeIcon('next') + '</button></span>');
                }
                if (!parts.length) return;
                actions.innerHTML = parts.join('');
                main.appendChild(actions);
                actions.querySelectorAll('[data-ak-ai-tree-copy]').forEach((button) => {
                    button.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        this.copyTreeMessage(button.getAttribute('data-ak-ai-tree-copy'), button);
                    });
                });
                actions.querySelectorAll('[data-ak-ai-tree-edit]').forEach((button) => {
                    button.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (button.disabled) return;
                        this.editTreeMessage(button.getAttribute('data-ak-ai-tree-edit'));
                    });
                });
                actions.querySelectorAll('[data-ak-ai-tree-regenerate]').forEach((button) => {
                    button.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (button.disabled) return;
                        this.regenerateTreeMessage(button.getAttribute('data-ak-ai-tree-regenerate'));
                    });
                });
                actions.querySelectorAll('[data-ak-ai-tree-version-prev]').forEach((button) => {
                    button.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (button.disabled) return;
                        this.activateAdjacentVersion(button.getAttribute('data-ak-ai-tree-version-prev'), 'prev');
                    });
                });
                actions.querySelectorAll('[data-ak-ai-tree-version-next]').forEach((button) => {
                    button.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (button.disabled) return;
                        this.activateAdjacentVersion(button.getAttribute('data-ak-ai-tree-version-next'), 'next');
                    });
                });
            });
            if (!hasTreeMessage) this.maybeHydrateTreeMessages();
        },

        loadAISessions(force) {
            const state = this.ctx && this.ctx.state;
            if (!this.ctx || typeof this.ctx.request !== 'function' || !this.ctx.httpRoot) return Promise.resolve(null);
            this.ensureState();
            const aiState = state && state.aiAssistant;
            if (!force && aiState && Array.isArray(aiState.sessions) && aiState.sessions.length && Date.now() - Number(aiState.sessionsLoadedAt || 0) < SESSION_LIST_STALE_MS) {
                return Promise.resolve({
                    items: aiState.sessions,
                    activeSessionId: Number(aiState.activeSessionId || 0)
                });
            }
            if (aiState) {
                aiState.sessionsLoading = true;
                aiState.sessionsError = '';
            }
            return this.ctx.request(this.ctx.httpRoot + '/ai/sessions').then((data) => {
                return this.applySessionPayload(data);
            }).catch((error) => {
                if (aiState) aiState.sessionsError = error && error.message ? error.message : 'AI 会话加载失败';
                return null;
            }).finally(() => {
                if (aiState) aiState.sessionsLoading = false;
                this.renderSessionDrawer();
                if (typeof this.ctx.render === 'function') this.ctx.render();
            });
        },

        openSessionDrawer() {
            const state = this.ctx && this.ctx.state;
            if (!state || !this.isAIConversation()) return;
            this.ensureState();
            state.aiAssistant.sessionDrawerOpen = true;
            this.renderSessionDrawer();
            this.loadAISessions(true);
        },

        closeSessionDrawer() {
            const state = this.ctx && this.ctx.state;
            if (state && state.aiAssistant) state.aiAssistant.sessionDrawerOpen = false;
            this.removeSessionDrawer();
        },

        removeSessionDrawer() {
            const root = this.getRootElement();
            const mask = root ? root.querySelector('.ak-im-ai-session-mask') : null;
            if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
        },

        sessionTitle(item) {
            const title = String(item && item.title || '').trim();
            return title || '新对话';
        },

        sessionMeta(item) {
            const updatedAt = item && item.updated_at ? Date.parse(item.updated_at) : 0;
            if (!updatedAt) return '上下文';
            const diff = Math.max(0, Date.now() - updatedAt);
            if (diff < 60000) return '刚刚更新';
            if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
            if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
            return Math.floor(diff / 86400000) + ' 天前';
        },

        createAISession() {
            const state = this.ctx && this.ctx.state;
            if (!this.ctx || typeof this.ctx.request !== 'function' || !state || !state.aiAssistant || state.aiAssistant.sessionMutating) return Promise.resolve(null);
            state.aiAssistant.sessionMutating = true;
            this.renderSessionDrawer();
            return this.ctx.request(this.ctx.httpRoot + '/ai/sessions', {
                method: 'POST',
                body: JSON.stringify({ title: '新对话' })
            }).then((data) => {
                this.applySessionPayload(data);
                if (Number(state.activeConversationId || 0) > 0 && this.isAIConversation()) {
                    this.loadSessionMessages(state.activeConversationId, { forceRefresh: true });
                }
                return data;
            }).catch((error) => {
                if (typeof global.alert === 'function') global.alert(error && error.message ? error.message : '新建 AI 会话失败');
                return null;
            }).finally(() => {
                state.aiAssistant.sessionMutating = false;
                this.renderSessionDrawer();
                if (typeof this.ctx.render === 'function') this.ctx.render();
            });
        },

        activateAISession(id) {
            const sessionId = Number(id || 0);
            const state = this.ctx && this.ctx.state;
            if (!sessionId || !this.ctx || typeof this.ctx.request !== 'function' || !state || !state.aiAssistant) return Promise.resolve(null);
            if (Number(state.aiAssistant.activeSessionId || 0) === sessionId) {
                this.closeSessionDrawer();
                return Promise.resolve(null);
            }
            state.aiAssistant.sessionMutating = true;
            this.renderSessionDrawer();
            return this.ctx.request(this.ctx.httpRoot + '/ai/sessions/' + encodeURIComponent(sessionId) + '/activate', {
                method: 'POST',
                body: '{}'
            }).then((data) => {
                this.applySessionPayload(data);
                this.closeSessionDrawer();
                if (Number(state.activeConversationId || 0) > 0) {
                    this.loadSessionMessages(state.activeConversationId, { forceRefresh: true });
                }
                return data;
            }).catch((error) => {
                if (typeof global.alert === 'function') global.alert(error && error.message ? error.message : '切换 AI 会话失败');
                return null;
            }).finally(() => {
                state.aiAssistant.sessionMutating = false;
                this.renderSessionDrawer();
                if (typeof this.ctx.render === 'function') this.ctx.render();
            });
        },

        renameAISession(id, currentTitle) {
            const sessionId = Number(id || 0);
            if (!sessionId || !this.ctx || typeof this.ctx.request !== 'function') return Promise.resolve(null);
            const nextTitle = typeof global.prompt === 'function' ? global.prompt('输入会话名称', this.sessionTitle({ title: currentTitle })) : '';
            const title = String(nextTitle || '').trim();
            if (!title) return Promise.resolve(null);
            return this.ctx.request(this.ctx.httpRoot + '/ai/sessions/' + encodeURIComponent(sessionId), {
                method: 'PATCH',
                body: JSON.stringify({ title: title })
            }).then((data) => {
                this.applySessionPayload(data);
                this.renderSessionDrawer();
                return data;
            }).catch((error) => {
                if (typeof global.alert === 'function') global.alert(error && error.message ? error.message : '重命名 AI 会话失败');
                return null;
            });
        },

        archiveAISession(id) {
            const sessionId = Number(id || 0);
            if (!sessionId || !this.ctx || typeof this.ctx.request !== 'function') return Promise.resolve(null);
            const ok = typeof global.confirm === 'function' ? global.confirm('归档这个 AI 会话？') : true;
            if (!ok) return Promise.resolve(null);
            return this.ctx.request(this.ctx.httpRoot + '/ai/sessions/' + encodeURIComponent(sessionId), {
                method: 'PATCH',
                body: JSON.stringify({ status: 'archived' })
            }).then((data) => {
                this.applySessionPayload(data);
                this.renderSessionDrawer();
                return data;
            }).catch((error) => {
                if (typeof global.alert === 'function') global.alert(error && error.message ? error.message : '归档 AI 会话失败');
                return null;
            });
        },

        renderSessionDrawer() {
            const state = this.ctx && this.ctx.state;
            const root = this.getRootElement();
            if (!root || !state || !state.aiAssistant || !state.aiAssistant.sessionDrawerOpen || !this.isAIConversation()) {
                this.removeSessionDrawer();
                return;
            }
            this.ensureStyle();
            let mask = root.querySelector('.ak-im-ai-session-mask');
            if (!mask) {
                mask = document.createElement('div');
                mask.className = 'ak-im-ai-session-mask';
                root.appendChild(mask);
            }
            const aiState = state.aiAssistant;
            const activeId = Number(aiState.activeSessionId || 0);
            const items = Array.isArray(aiState.sessions) ? aiState.sessions : [];
            const listHtml = items.length ? items.map((item) => {
                const id = Number(item && item.id || 0);
                const active = id && id === activeId;
                return [
                    '<div class="ak-im-ai-session-row' + (active ? ' is-active' : '') + '" data-ak-ai-session-id="' + id + '">',
                    '<div class="ak-im-ai-session-main">',
                    '<div class="ak-im-ai-session-name">' + this.escapeHtml(this.sessionTitle(item)) + '</div>',
                    '<div class="ak-im-ai-session-meta">' + this.escapeHtml(active ? '当前上下文' : this.sessionMeta(item)) + '</div>',
                    '</div>',
                    '<div class="ak-im-ai-session-row-actions">',
                    '<button type="button" class="ak-im-ai-session-icon-btn" data-ak-ai-session-rename="' + id + '" title="重命名">改</button>',
                    '<button type="button" class="ak-im-ai-session-icon-btn danger" data-ak-ai-session-archive="' + id + '" title="归档">归</button>',
                    '</div>',
                    '</div>'
                ].join('');
            }).join('') : '<div class="ak-im-ai-session-empty">' + (aiState.sessionsLoading ? '正在加载 AI 会话...' : '暂无 AI 会话') + '</div>';
            mask.innerHTML = [
                '<div class="ak-im-ai-session-panel" role="dialog" aria-modal="true" aria-label="AI 会话管理">',
                '<div class="ak-im-ai-session-head">',
                '<div class="ak-im-ai-session-title">AI 会话</div>',
                '<div class="ak-im-ai-session-actions">',
                '<button type="button" class="ak-im-ai-session-btn" data-ak-ai-session-new="1"' + (aiState.sessionMutating ? ' disabled' : '') + '>新建</button>',
                '<button type="button" class="ak-im-ai-session-btn secondary" data-ak-ai-session-close="1">关闭</button>',
                '</div>',
                '</div>',
                '<div class="ak-im-ai-session-list">',
                aiState.sessionsError ? '<div class="ak-im-ai-session-empty">' + this.escapeHtml(aiState.sessionsError) + '</div>' : listHtml,
                '</div>',
                '</div>'
            ].join('');
            mask.onclick = (event) => {
                if (event.target === mask) this.closeSessionDrawer();
            };
            const closeBtn = mask.querySelector('[data-ak-ai-session-close]');
            if (closeBtn) closeBtn.addEventListener('click', () => this.closeSessionDrawer());
            const newBtn = mask.querySelector('[data-ak-ai-session-new]');
            if (newBtn) newBtn.addEventListener('click', () => this.createAISession());
            mask.querySelectorAll('[data-ak-ai-session-id]').forEach((row) => {
                row.addEventListener('click', (event) => {
                    if (event.target && event.target.closest && event.target.closest('[data-ak-ai-session-rename],[data-ak-ai-session-archive]')) return;
                    this.activateAISession(row.getAttribute('data-ak-ai-session-id'));
                });
            });
            mask.querySelectorAll('[data-ak-ai-session-rename]').forEach((button) => {
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    const id = button.getAttribute('data-ak-ai-session-rename');
                    const item = items.find(function(entry) { return Number(entry && entry.id || 0) === Number(id || 0); });
                    this.renameAISession(id, item && item.title);
                });
            });
            mask.querySelectorAll('[data-ak-ai-session-archive]').forEach((button) => {
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.archiveAISession(button.getAttribute('data-ak-ai-session-archive'));
                });
            });
        },

        openAssistant() {
            const state = this.ctx && this.ctx.state;
            if (!this.ctx || !state || typeof this.ctx.request !== 'function') return Promise.resolve(null);
            this.ensureState();
            if (this.sessionPromise) return this.sessionPromise;
            state.aiAssistant.opening = true;
            state.aiAssistant.message = '正在打开 AI 助手...';
            if (typeof this.ctx.render === 'function') this.ctx.render();
            this.sessionPromise = this.ctx.request(this.ctx.httpRoot + '/ai/session', {
                method: 'POST',
                body: '{}'
            }).then((data) => {
                const conversationId = Number(data && data.conversation_id || 0);
                if (!conversationId) throw new Error('AI 助手会话创建失败');
                const bootstrap = data && data.bootstrap ? data.bootstrap : null;
                if (bootstrap) {
                    state.aiAssistant.bootstrap = bootstrap;
                    state.aiAssistant.bootstrapLoadedAt = Date.now();
                }
                if (data && data.sessions) {
                    this.applySessionPayload(data.sessions);
                } else {
                    this.loadAISessions(true);
                }
                state.aiAssistant.message = '';
                const sessionItem = {
                    conversation_id: conversationId,
                    conversation_type: 'direct',
                    peer_username: String(data && data.bot_username || BOT_USERNAME),
                    peer_display_name: String(data && data.bot_display_name || 'AK AI Assistant'),
                    avatar_kind: 'generated',
                    avatar_style: 'thumbs',
                    avatar_seed: 'ak-ai-assistant',
                    can_send: true
                };
                if (typeof this.ctx.openConversationById === 'function') {
                    return Promise.resolve(this.ctx.openConversationById(conversationId, sessionItem)).then(() => {
                        if (typeof this.ctx.loadSessions === 'function') return this.ctx.loadSessions();
                        return null;
                    });
                }
                return null;
            }).catch((error) => {
                state.aiAssistant.message = error && error.message ? error.message : 'AI 助手暂不可用';
                if (typeof global.alert === 'function') global.alert(state.aiAssistant.message);
                return null;
            }).finally(() => {
                state.aiAssistant.opening = false;
                this.sessionPromise = null;
                if (typeof this.ctx.render === 'function') this.ctx.render();
            });
            return this.sessionPromise;
        },

        isAIConversation(session) {
            const item = session || (this.ctx && typeof this.ctx.getActiveSession === 'function' ? this.ctx.getActiveSession() : null);
            const peerUsername = String(item && item.peer_username || '').trim().toLowerCase();
            return peerUsername === BOT_USERNAME;
        },

        getThinkingTempId(taskId) {
            const normalizedTaskId = String(taskId || '').trim();
            return normalizedTaskId ? ('ak-ai-thinking-' + normalizedTaskId) : '';
        },

        hasThinkingPlaceholder(tempId) {
            const state = this.ctx && this.ctx.state;
            const normalizedTempId = String(tempId || '').trim();
            if (!state || !normalizedTempId || !Array.isArray(state.activeMessages)) return false;
            return state.activeMessages.some(function(item) {
                return item && String(item.__akTempId || item.client_temp_id || '').trim() === normalizedTempId;
            });
        },

        getTaskStageText(task) {
            return String(task && (task.stage_text || task.message) || '').trim() || THINKING_TEXT;
        },

        updateThinkingPlaceholder(task) {
            const state = this.ctx && this.ctx.state;
            const taskId = String(task && task.task_id || '').trim();
            const tempId = this.getThinkingTempId(taskId);
            const text = this.getTaskStageText(task);
            if (!state || !tempId || !this.hasThinkingPlaceholder(tempId)) return false;
            const patch = {
                content: text,
                content_preview: text,
                __akAIStage: String(task && task.stage || '').trim()
            };
            if (this.ctx && typeof this.ctx.updateLocalMessage === 'function' && this.ctx.updateLocalMessage(tempId, patch)) {
                return true;
            }
            let changed = false;
            state.activeMessages = (Array.isArray(state.activeMessages) ? state.activeMessages : []).map(function(item) {
                if (!item || String(item.__akTempId || item.client_temp_id || '').trim() !== tempId) return item;
                changed = true;
                return Object.assign({}, item, patch);
            });
            if (changed && typeof this.ctx.renderMessages === 'function') this.ctx.renderMessages();
            return changed;
        },

        showThinkingPlaceholder(task) {
            const state = this.ctx && this.ctx.state;
            const conversationId = Number(task && task.conversation_id || state && state.activeConversationId || 0);
            const taskId = String(task && task.task_id || '').trim();
            const tempId = this.getThinkingTempId(taskId);
            if (!this.ctx || !state || !conversationId || !tempId || typeof this.ctx.insertLocalMessage !== 'function') return;
            this.keepConversationPinnedToBottom(6000);
            if (this.hasThinkingPlaceholder(tempId)) {
                this.updateThinkingPlaceholder(task);
                this.keepConversationPinnedToBottom(6000);
                return;
            }
            const thinkingText = this.getTaskStageText(task);
            const sentAt = typeof this.ctx.createLocalSentAt === 'function' ? this.ctx.createLocalSentAt() : new Date().toISOString();
            this.ctx.insertLocalMessage({
                id: 0,
                conversation_id: conversationId,
                sender_username: BOT_USERNAME,
                sender_display_name: '\u5c0f\u0041',
                seq_no: 0,
                message_type: 'text',
                content: thinkingText,
                content_preview: thinkingText,
                status: 'sent',
                sent_at: sentAt,
                client_temp_id: tempId,
                avatar_kind: 'generated',
                avatar_style: 'thumbs',
                avatar_seed: 'ak-ai-assistant',
                __akTempId: tempId,
                __akLocalStatus: 'ai-thinking',
                __akAIPlaceholder: true,
                __akAITaskId: taskId
            });
            if (typeof this.ctx.renderMessages === 'function') this.ctx.renderMessages();
            this.keepConversationPinnedToBottom(6000);
        },

        clearThinkingPlaceholder(taskId) {
            const tempId = this.getThinkingTempId(taskId);
            if (!tempId || !this.ctx || typeof this.ctx.removeLocalMessage !== 'function') return false;
            const removed = !!this.ctx.removeLocalMessage(tempId);
            if (removed && typeof this.ctx.renderMessages === 'function') this.ctx.renderMessages();
            return removed;
        },

        clearTaskPoll() {
            if (!this.taskPollTimer) return;
            clearTimeout(this.taskPollTimer);
            this.taskPollTimer = null;
        },

        isTerminalTaskStatus(status) {
            const normalized = String(status || '').trim().toLowerCase();
            return normalized === 'succeeded' || normalized === 'failed' || normalized === 'rejected';
        },

        taskStatusText(task) {
            const status = String(task && task.status || '').trim().toLowerCase();
            if (status === 'queued' || status === 'running') return this.getTaskStageText(task);
            if (status === 'succeeded') return '\u0041\u0049 \u5df2\u56de\u590d';
            if (status === 'failed') return String(task && task.message || '').trim() || '\u0041\u0049 \u751f\u6210\u5931\u8d25\uff0c\u672c\u6b21\u672a\u6d88\u8017\u989d\u5ea6';
            if (status === 'rejected') return String(task && task.message || '').trim() || '\u0041\u0049 \u6682\u4e0d\u53ef\u7528\uff0c\u672c\u6b21\u672a\u6d88\u8017\u989d\u5ea6';
            return String(task && task.message || '').trim() || THINKING_TEXT;
        },

        resolveTaskPollDelay(task) {
            const status = String(task && task.status || '').trim().toLowerCase();
            if (status === 'queued') return 1800;
            const startedAt = Date.parse(task && (task.started_at || task.created_at) || '');
            const elapsedMs = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
            if (elapsedMs > 60000) return 5000;
            if (elapsedMs > 30000) return 3500;
            if (elapsedMs > 12000) return 2400;
            return 1400;
        },

        setActiveTask(task, options) {
            const state = this.ctx && this.ctx.state;
            if (!state || !task || !task.task_id) return;
            this.ensureState();
            state.aiAssistant.activeTask = Object.assign({}, state.aiAssistant.activeTask || {}, task, {
                conversation_id: Number(task.conversation_id || state.activeConversationId || 0)
            });
            state.aiAssistant.activeTaskClearingAt = 0;
            const status = String(state.aiAssistant.activeTask.status || '').trim().toLowerCase();
            if (this.isTerminalTaskStatus(status)) {
                this.clearTaskPoll();
                this.clearThinkingPlaceholder(state.aiAssistant.activeTask.task_id);
                this.keepConversationPinnedToBottom(status === 'succeeded' ? 6000 : 2400);
                const clearDelay = status === 'succeeded' ? 2200 : 4800;
                state.aiAssistant.activeTaskClearingAt = Date.now() + clearDelay;
                setTimeout(() => {
                    const latestState = this.ctx && this.ctx.state;
                    const latestTask = latestState && latestState.aiAssistant && latestState.aiAssistant.activeTask;
                    if (!latestTask || latestTask.task_id !== task.task_id) return;
                    latestState.aiAssistant.activeTask = null;
                    latestState.aiAssistant.activeTaskClearingAt = 0;
                    if (typeof this.ctx.render === 'function') this.ctx.render();
                }, clearDelay);
                this.loadBootstrap(true);
                if (status === 'succeeded' && this.ctx && typeof this.ctx.loadMessages === 'function' && Number(state.activeConversationId || 0) === Number(state.aiAssistant.activeTask.conversation_id || 0)) {
                    setTimeout(() => this.ctx.loadMessages(state.activeConversationId), 350);
                }
            } else {
                this.removeSuggestionBar();
                this.keepConversationPinnedToBottom(8000);
                this.showThinkingPlaceholder(state.aiAssistant.activeTask);
                if (!(options && options.skipPoll)) this.scheduleTaskPoll(task.task_id, this.resolveTaskPollDelay(state.aiAssistant.activeTask));
            }
            if (typeof this.ctx.render === 'function') this.ctx.render();
        },

        scheduleTaskPoll(taskId, delayMs) {
            const normalizedTaskId = String(taskId || '').trim();
            if (!normalizedTaskId || !this.ctx || typeof this.ctx.request !== 'function') return;
            this.clearTaskPoll();
            this.taskPollTimer = setTimeout(() => {
                this.taskPollTimer = null;
                this.pollTask(normalizedTaskId);
            }, Math.max(500, Number(delayMs || 1200) || 1200));
        },

        pollTask(taskId) {
            const normalizedTaskId = String(taskId || '').trim();
            const state = this.ctx && this.ctx.state;
            if (!normalizedTaskId || !state || !state.aiAssistant || !state.aiAssistant.activeTask || state.aiAssistant.activeTask.task_id !== normalizedTaskId) {
                return Promise.resolve(null);
            }
            const activeTask = state.aiAssistant.activeTask;
            const startedAt = Date.parse(activeTask.started_at || activeTask.created_at || '');
            if (startedAt && Date.now() - startedAt > MAX_TASK_POLL_MS) {
                this.setActiveTask(Object.assign({}, activeTask, {
                    status: 'failed',
                    message: '\u0041\u0049 \u54cd\u5e94\u8d85\u65f6\uff0c\u672c\u6b21\u672a\u6d88\u8017\u989d\u5ea6\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5'
                }), { skipPoll: true });
                return Promise.resolve(null);
            }
            return this.ctx.request(this.ctx.httpRoot + '/ai/tasks/' + encodeURIComponent(normalizedTaskId)).then((task) => {
                if (!task || !task.task_id) return null;
                this.setActiveTask(Object.assign({}, task, { poll_error_count: 0 }), { skipPoll: true });
                if (!this.isTerminalTaskStatus(task.status)) {
                    this.scheduleTaskPoll(task.task_id, this.resolveTaskPollDelay(task));
                }
                return task;
            }).catch((error) => {
                const latestTask = state.aiAssistant && state.aiAssistant.activeTask;
                if (!latestTask || latestTask.task_id !== normalizedTaskId) return null;
                const errorCount = Number(latestTask.poll_error_count || 0) + 1;
                if (errorCount >= MAX_TASK_POLL_ERRORS) {
                    this.setActiveTask(Object.assign({}, latestTask, {
                        status: 'failed',
                        poll_error_count: errorCount,
                        message: '\u0041\u0049 \u8fde\u63a5\u5f02\u5e38\uff0c\u672c\u6b21\u672a\u6d88\u8017\u989d\u5ea6\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5'
                    }), { skipPoll: true });
                    return null;
                }
                this.setActiveTask(Object.assign({}, latestTask, {
                    poll_error_count: errorCount,
                    message: error && error.message ? error.message : latestTask.message
                }), { skipPoll: true });
                this.scheduleTaskPoll(normalizedTaskId, Math.min(15000, 2500 + errorCount * 1800));
                return null;
            });
        },

        handleMessageCreated(item, meta) {
            const state = this.ctx && this.ctx.state;
            if (!state || !item || typeof item !== 'object') return;
            const task = item.ai_task || (meta && meta.response && meta.response.ai_task) || null;
            if (task && task.task_id && Number(item.conversation_id || 0) === Number(state.activeConversationId || 0)) {
                this.setActiveTask(task);
                if (this.isAIConversation()) {
                    setTimeout(() => this.loadSessionMessages(item.conversation_id, { forceRefresh: true }), 120);
                }
                return;
            }
            const activeTask = state.aiAssistant && state.aiAssistant.activeTask ? state.aiAssistant.activeTask : null;
            if (activeTask && String(item.sender_username || '').trim().toLowerCase() === BOT_USERNAME && Number(item.conversation_id || 0) === Number(activeTask.conversation_id || 0)) {
                this.clearThinkingPlaceholder(activeTask.task_id);
                this.setActiveTask(Object.assign({}, activeTask, { status: 'succeeded', message: 'AI 已回复' }), { skipPoll: true });
                if (this.isAIConversation()) {
                    setTimeout(() => this.loadSessionMessages(item.conversation_id, { forceRefresh: true }), 160);
                }
                setTimeout(() => this.renderSuggestions(), 0);
            }
        },

        getRootElement() {
            return this.ctx && this.ctx.elements && this.ctx.elements.root ? this.ctx.elements.root : document.getElementById('ak-im-root');
        },

        removeTopbarActions() {
            const root = this.getRootElement();
            const actions = root ? root.querySelector('.ak-im-ai-topbar-actions') : null;
            if (actions && actions.parentNode) actions.parentNode.removeChild(actions);
            const topbar = root ? root.querySelector('.ak-im-chat-screen .ak-im-topbar') : null;
            if (topbar) topbar.classList.remove('ak-im-ai-topbar-enabled');
        },

        renderTopbarActions() {
            const root = this.getRootElement();
            const state = this.ctx && this.ctx.state;
            const topbar = root ? root.querySelector('.ak-im-chat-screen .ak-im-topbar') : null;
            if (!root || !topbar || !state || !this.isAIConversation()) {
                this.removeTopbarActions();
                return;
            }
            this.ensureState();
            this.ensureStyle();
            topbar.classList.add('ak-im-ai-topbar-enabled');
            let actions = topbar.querySelector('.ak-im-ai-topbar-actions');
            if (!actions) {
                actions = document.createElement('div');
                actions.className = 'ak-im-ai-topbar-actions';
                topbar.appendChild(actions);
            }
            const aiState = state.aiAssistant || {};
            const busy = !!aiState.sessionMutating;
            const contextLabel = '\u5207\u6362\u4e0a\u4e0b\u6587';
            const newLabel = '\u65b0\u5efa\u4e0a\u4e0b\u6587';
            actions.innerHTML = [
                '<button type="button" class="ak-im-ai-topbar-btn" data-ak-ai-topbar-sessions="1" title="' + contextLabel + '" aria-label="' + contextLabel + '"' + (busy ? ' disabled' : '') + '>' + this.aiTreeIcon('sessions') + '</button>',
                '<button type="button" class="ak-im-ai-topbar-btn" data-ak-ai-topbar-new="1" title="' + newLabel + '" aria-label="' + newLabel + '"' + (busy ? ' disabled' : '') + '>' + this.aiTreeIcon('new-session') + '</button>'
            ].join('');
            const sessionsBtn = actions.querySelector('[data-ak-ai-topbar-sessions]');
            if (sessionsBtn) {
                sessionsBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (sessionsBtn.disabled) return;
                    this.openSessionDrawer();
                });
            }
            const newBtn = actions.querySelector('[data-ak-ai-topbar-new]');
            if (newBtn) {
                newBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (newBtn.disabled) return;
                    this.createAISession();
                });
            }
        },

        removeSuggestionBar() {
            const root = this.getRootElement();
            const bar = root ? root.querySelector('.ak-im-ai-suggestions') : null;
            if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
        },

        normalizeSuggestions(items) {
            const result = [];
            const seen = {};
            (Array.isArray(items) ? items : []).forEach(function(item) {
                const text = String(item || '').trim();
                const key = text.toLowerCase();
                if (!text || seen[key]) return;
                seen[key] = true;
                result.push(text.length > 28 ? text.slice(0, 28) : text);
            });
            return result.slice(0, 3);
        },

        getLatestReplySuggestions() {
            const state = this.ctx && this.ctx.state;
            if (!state || !this.isAIConversation() || !Array.isArray(state.activeMessages)) return [];
            const activeTask = state.aiAssistant && state.aiAssistant.activeTask && Number(state.aiAssistant.activeTask.conversation_id || 0) === Number(state.activeConversationId || 0)
                ? state.aiAssistant.activeTask
                : null;
            if (activeTask && !this.isTerminalTaskStatus(activeTask.status)) return [];
            for (let index = state.activeMessages.length - 1; index >= 0; index -= 1) {
                const item = state.activeMessages[index];
                if (!item || item.__akAIPlaceholder) continue;
                const sender = String(item.sender_username || '').trim().toLowerCase();
                if (sender === BOT_USERNAME) return this.normalizeSuggestions(item.ai_suggestions);
                if (sender) return [];
            }
            return [];
        },

        applySuggestion(text) {
            const value = String(text || '').trim();
            if (!value) return;
            if (this.ctx && typeof this.ctx.setComposerText === 'function') {
                this.ctx.setComposerText(value);
            }
        },

        renderSuggestions() {
            const root = this.getRootElement();
            if (!root) return;
            const suggestions = this.getLatestReplySuggestions();
            const composer = root.querySelector('.ak-im-composer');
            if (!composer || !suggestions.length) {
                this.removeSuggestionBar();
                return;
            }
            let bar = root.querySelector('.ak-im-ai-suggestions');
            if (!bar) {
                bar = document.createElement('div');
                bar.className = 'ak-im-ai-suggestions';
            }
            const nextKey = suggestions.join('\n');
            if (bar.dataset.suggestionsKey !== nextKey) {
                bar.dataset.suggestionsKey = nextKey;
                bar.innerHTML = '<span class="ak-im-ai-suggestion-label">可以继续问</span>' + suggestions.map((item) => {
                    return '<button type="button" class="ak-im-ai-suggestion-chip" data-ak-ai-suggestion="' + this.escapeHtml(item) + '">' + this.escapeHtml(item) + '</button>';
                }).join('');
            }
            if (bar.parentNode !== composer.parentNode || bar.nextSibling !== composer) {
                composer.parentNode.insertBefore(bar, composer);
            }
            bar.querySelectorAll('[data-ak-ai-suggestion]').forEach((button) => {
                if (button.dataset.bound === '1') return;
                button.dataset.bound = '1';
                button.addEventListener('click', () => this.applySuggestion(button.getAttribute('data-ak-ai-suggestion') || button.textContent || ''));
            });
        },

        closeRedeemDialog() {
            const root = this.getRootElement();
            const mask = root ? root.querySelector('.ak-im-ai-redeem-mask') : null;
            if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
        },

        showRedeemDialog() {
            const root = this.getRootElement();
            if (!root) return;
            this.ensureStyle();
            this.closeRedeemDialog();
            const mask = document.createElement('div');
            mask.className = 'ak-im-ai-redeem-mask';
            mask.innerHTML = [
                '<div class="ak-im-ai-redeem-card" role="dialog" aria-modal="true" aria-label="兑换 AI 权益">',
                '<div class="ak-im-ai-redeem-title">兑换 AI 权益</div>',
                '<div class="ak-im-ai-redeem-sub">输入管理员发放的兑换码，成功后会立即刷新你的权益和今日额度。</div>',
                '<input class="ak-im-ai-redeem-input" data-ak-ai-redeem-input="1" autocomplete="one-time-code" placeholder="请输入兑换码">',
                '<div class="ak-im-ai-redeem-actions">',
                '<button type="button" class="ak-im-ai-redeem-btn" data-ak-ai-redeem-cancel="1">取消</button>',
                '<button type="button" class="ak-im-ai-redeem-btn primary" data-ak-ai-redeem-submit="1">兑换</button>',
                '</div>',
                '</div>'
            ].join('');
            mask.addEventListener('click', (event) => {
                if (event.target === mask) this.closeRedeemDialog();
            });
            const input = mask.querySelector('[data-ak-ai-redeem-input]');
            const submit = mask.querySelector('[data-ak-ai-redeem-submit]');
            const cancel = mask.querySelector('[data-ak-ai-redeem-cancel]');
            const submitCode = () => this.redeemCode(input ? input.value : '', submit);
            if (cancel) cancel.addEventListener('click', () => this.closeRedeemDialog());
            if (submit) submit.addEventListener('click', submitCode);
            if (input) {
                input.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') submitCode();
                    if (event.key === 'Escape') this.closeRedeemDialog();
                });
            }
            root.appendChild(mask);
            if (input) setTimeout(() => input.focus(), 30);
        },

        redeemCode(code, submitButton) {
            const state = this.ctx && this.ctx.state;
            const normalizedCode = String(code || '').trim();
            if (!normalizedCode) {
                if (typeof global.alert === 'function') global.alert('请输入兑换码');
                return Promise.resolve(null);
            }
            if (!this.ctx || typeof this.ctx.request !== 'function') return Promise.resolve(null);
            this.ensureState();
            if (state && state.aiAssistant && state.aiAssistant.redeeming) return Promise.resolve(null);
            if (state && state.aiAssistant) state.aiAssistant.redeeming = true;
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.textContent = '兑换中...';
            }
            return this.ctx.request(this.ctx.httpRoot + '/ai/redeem', {
                method: 'POST',
                body: JSON.stringify({ code: normalizedCode })
            }).then((data) => {
                if (state && state.aiAssistant && data && data.snapshot) {
                    state.aiAssistant.bootstrap = Object.assign({}, state.aiAssistant.bootstrap || {}, {
                        enabled: true,
                        available: true,
                        entitlement: data.snapshot
                    });
                    state.aiAssistant.bootstrapLoadedAt = Date.now();
                }
                this.closeRedeemDialog();
                if (typeof global.alert === 'function') global.alert('兑换成功，权益已更新');
                return this.loadBootstrap(true);
            }).catch((error) => {
                if (typeof global.alert === 'function') global.alert(error && error.message ? error.message : '兑换失败，请检查兑换码');
                return null;
            }).finally(() => {
                if (state && state.aiAssistant) state.aiAssistant.redeeming = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = '兑换';
                }
                if (typeof this.ctx.render === 'function') this.ctx.render();
            });
        },

        renderStatus() {
            this.ensurePlusEntryButton();
            const state = this.ctx && this.ctx.state;
            const elements = this.ctx && this.ctx.elements ? this.ctx.elements : {};
            const statusLine = elements && elements.statusLine;
            if (!statusLine || !state || !this.isAIConversation()) {
                this.removeSuggestionBar();
                this.removeSessionDrawer();
                this.removeTopbarActions();
                if (statusLine) {
                    statusLine.classList.remove('ak-im-ai-status', 'is-error');
                    if (statusLine.dataset.akAiStatus === '1') {
                        statusLine.dataset.akAiStatus = '';
                        statusLine.innerHTML = '';
                    }
                }
                return;
            }
            this.ensureState();
            this.renderTopbarActions();
            const aiState = state.aiAssistant || {};
            if (!aiState.bootstrapLoading && (!aiState.bootstrap || Date.now() - Number(aiState.bootstrapLoadedAt || 0) > 15000)) {
                this.loadBootstrap(true);
            }
            const activeTask = aiState.activeTask && Number(aiState.activeTask.conversation_id || 0) === Number(state.activeConversationId || 0)
                ? aiState.activeTask
                : null;
            const bootstrap = aiState.bootstrap;
            const entitlement = bootstrap && bootstrap.entitlement ? bootstrap.entitlement : null;
            const billing = bootstrap && bootstrap.billing ? bootstrap.billing : null;
            const quota = entitlement && entitlement.quota ? entitlement.quota : null;
            const tierName = entitlement && entitlement.tier_name ? entitlement.tier_name : (entitlement && entitlement.is_trial ? '试用' : 'AI');
            const dailyRemaining = quota ? Number(quota.daily_remaining || 0) : 0;
            const dailyLimit = quota ? Number(quota.daily_limit || 0) : 0;
            const billingRemaining = billing ? Number(billing.monthly_remaining_units || 0) : 0;
            const billingLimit = billing ? Number(billing.monthly_limit_units || 0) : 0;
            const billingUnit = billing && billing.unit_label ? String(billing.unit_label) : 'AI额度';
            let mainText = 'AI 助手';
            let quotaText = '';
            let isError = false;
            if (aiState.opening) {
                mainText = '正在打开 AI 助手...';
            } else if (activeTask) {
                mainText = this.taskStatusText(activeTask);
                quotaText = '';
            } else if (aiState.bootstrapError) {
                mainText = aiState.bootstrapError;
                isError = true;
            } else if (bootstrap && !bootstrap.enabled) {
                mainText = 'AI 助手暂未开启';
                isError = true;
            } else if (bootstrap && !bootstrap.provider_ready) {
                mainText = bootstrap.provider_message || 'AI 中转站暂未配置';
                isError = true;
            } else if (quota) {
                mainText = '当前权益：' + tierName;
                quotaText = billing
                    ? (billingUnit + ' ' + billingRemaining + '/' + billingLimit + ' · 今日 ' + dailyRemaining + '/' + dailyLimit)
                    : ('今日剩余 ' + dailyRemaining + '/' + dailyLimit);
            } else {
                mainText = '当前权益：' + tierName;
                if (billing) quotaText = billingUnit + ' ' + billingRemaining + '/' + billingLimit;
            }
            statusLine.classList.add('ak-im-ai-status');
            statusLine.classList.toggle('is-error', isError);
            statusLine.dataset.akAiStatus = '1';
            statusLine.innerHTML =
                '<span class="ak-im-ai-status-main"><span class="ak-im-ai-status-pill">AI</span><span>' + this.escapeHtml(mainText) + '</span></span>' +
                '<span class="ak-im-ai-status-side">' +
                (!activeTask && quotaText ? '<span class="ak-im-ai-status-quota">' + this.escapeHtml(quotaText) + '</span>' : '') +
                '<button type="button" class="ak-im-ai-status-action" data-ak-ai-sessions="1">会话</button>' +
                '<button type="button" class="ak-im-ai-status-action" data-ak-ai-redeem="1">兑换</button>' +
                '<button type="button" class="ak-im-ai-status-action" data-ak-ai-refresh="1">刷新</button>' +
                '</span>';
            const sessionsBtn = statusLine.querySelector('[data-ak-ai-sessions]');
            if (sessionsBtn && !sessionsBtn.dataset.bound) {
                sessionsBtn.dataset.bound = '1';
                sessionsBtn.addEventListener('click', () => this.openSessionDrawer());
            }
            const refreshBtn = statusLine.querySelector('[data-ak-ai-refresh]');
            if (refreshBtn && !refreshBtn.dataset.bound) {
                refreshBtn.dataset.bound = '1';
                refreshBtn.addEventListener('click', () => this.loadBootstrap(true));
            }
            const redeemBtn = statusLine.querySelector('[data-ak-ai-redeem]');
            if (redeemBtn && !redeemBtn.dataset.bound) {
                redeemBtn.dataset.bound = '1';
                redeemBtn.addEventListener('click', () => this.showRedeemDialog());
            }
            this.renderSuggestions();
            this.renderSessionDrawer();
            this.renderAIMessageControls();
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.aiManage = aiManageModule;
})(window);
