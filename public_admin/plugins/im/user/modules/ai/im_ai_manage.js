(function(global) {
    'use strict';

    const BOT_USERNAME = 'ak_ai_assistant';
    const STYLE_ID = 'ak-im-ai-manage-style';
    const MAX_TASK_POLL_MS = 130000;

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
                '#ak-im-root .ak-im-ai-redeem-mask{position:absolute;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(15,23,42,.28);backdrop-filter:blur(4px);box-sizing:border-box}',
                '#ak-im-root .ak-im-ai-redeem-card{width:min(360px,100%);border:1px solid rgba(15,23,42,.10);border-radius:14px;background:#fff;box-shadow:0 18px 48px rgba(15,23,42,.22);padding:16px;box-sizing:border-box}',
                '#ak-im-root .ak-im-ai-redeem-title{font-size:16px;font-weight:800;color:#111827;margin-bottom:6px}',
                '#ak-im-root .ak-im-ai-redeem-sub{font-size:12px;line-height:1.6;color:#64748b;margin-bottom:12px}',
                '#ak-im-root .ak-im-ai-redeem-input{width:100%;height:40px;border:1px solid #d8dee9;border-radius:10px;background:#f8fafc;color:#111827;padding:0 11px;outline:none;font-size:14px;box-sizing:border-box}',
                '#ak-im-root .ak-im-ai-redeem-input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}',
                '#ak-im-root .ak-im-ai-redeem-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:14px}',
                '#ak-im-root .ak-im-ai-redeem-btn{height:36px;border:0;border-radius:10px;padding:0 13px;background:#eef2f7;color:#334155;font-weight:800;cursor:pointer}',
                '#ak-im-root .ak-im-ai-redeem-btn.primary{background:#2563eb;color:#fff}',
                '#ak-im-root .ak-im-ai-redeem-btn:disabled{opacity:.55;cursor:not-allowed}'
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
            if (status === 'queued') {
                const position = Number(task && task.queue_position || 0);
                return position > 0 ? ('AI 请求较多，排队中 · 前方 ' + position + ' 个') : 'AI 请求较多，已为你排队';
            }
            if (status === 'running') return 'AI 正在思考...';
            if (status === 'succeeded') return 'AI 已回复';
            if (status === 'failed') return String(task && task.message || '').trim() || 'AI 生成失败，本次未消耗额度';
            if (status === 'rejected') return String(task && task.message || '').trim() || 'AI 暂不可用，本次未消耗额度';
            return String(task && task.message || '').trim() || 'AI 正在处理...';
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
            } else if (!(options && options.skipPoll)) {
                this.scheduleTaskPoll(task.task_id, this.resolveTaskPollDelay(state.aiAssistant.activeTask));
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
                this.setActiveTask(task, { skipPoll: true });
                if (!this.isTerminalTaskStatus(task.status)) {
                    this.scheduleTaskPoll(task.task_id, this.resolveTaskPollDelay(task));
                }
                return task;
            }).catch(() => {
                this.scheduleTaskPoll(normalizedTaskId, 2200);
                return null;
            });
        },

        handleMessageCreated(item, meta) {
            const state = this.ctx && this.ctx.state;
            if (!state || !item || typeof item !== 'object') return;
            const task = item.ai_task || (meta && meta.response && meta.response.ai_task) || null;
            if (task && task.task_id && Number(item.conversation_id || 0) === Number(state.activeConversationId || 0)) {
                this.setActiveTask(task);
                return;
            }
            const activeTask = state.aiAssistant && state.aiAssistant.activeTask ? state.aiAssistant.activeTask : null;
            if (activeTask && String(item.sender_username || '').trim().toLowerCase() === BOT_USERNAME && Number(item.conversation_id || 0) === Number(activeTask.conversation_id || 0)) {
                this.setActiveTask(Object.assign({}, activeTask, { status: 'succeeded', message: 'AI 已回复' }), { skipPoll: true });
            }
        },

        getRootElement() {
            return this.ctx && this.ctx.elements && this.ctx.elements.root ? this.ctx.elements.root : document.getElementById('ak-im-root');
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
                (activeTask ? '<span class="ak-im-ai-status-task">' + this.escapeHtml(String(activeTask.status || '').trim() || 'processing') + '</span>' : '') +
                (!activeTask && quotaText ? '<span class="ak-im-ai-status-quota">' + this.escapeHtml(quotaText) + '</span>' : '') +
                '<button type="button" class="ak-im-ai-status-action" data-ak-ai-redeem="1">兑换</button>' +
                '<button type="button" class="ak-im-ai-status-action" data-ak-ai-refresh="1">刷新</button>' +
                '</span>';
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
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.aiManage = aiManageModule;
})(window);
