(function(global) {
    'use strict';

    const externalPageModule = {
        ctx: null,
        providers: {},

        init(ctx) {
            this.ctx = ctx || null;
            this.initState();
            this.registerDefaultProviders();
            this.bindActions();
        },

        initState() {
            const state = this.getState();
            if (!state) return;
            if (typeof state.externalPageOpen !== 'boolean') state.externalPageOpen = false;
            if (typeof state.externalPageProvider !== 'string') state.externalPageProvider = '';
            if (typeof state.externalPageTitle !== 'string') state.externalPageTitle = '';
            if (typeof state.externalPageReturnView !== 'string') state.externalPageReturnView = 'sessions';
            if (typeof state.externalPageReturnHomeTab !== 'string') state.externalPageReturnHomeTab = 'chats';
            if (!state.externalPagePayload) state.externalPagePayload = null;
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getBody() {
            const elements = this.ctx && this.ctx.elements ? this.ctx.elements : null;
            return elements && elements.externalPageBodyEl ? elements.externalPageBodyEl : null;
        },

        getTitleEl() {
            const elements = this.ctx && this.ctx.elements ? this.ctx.elements : null;
            return elements && elements.externalPageTitleEl ? elements.externalPageTitleEl : null;
        },

        escapeHtml(raw) {
            if (this.ctx && typeof this.ctx.escapeHtml === 'function') return this.ctx.escapeHtml(raw);
            return String(raw == null ? '' : raw).replace(/[&<>"']/g, function(ch) {
                return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
            });
        },

        triggerRender() {
            if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
        },

        registerProvider(name, provider) {
            const key = String(name || '').trim();
            if (!key || !provider) return;
            this.providers[key] = provider;
        },

        registerDefaultProviders() {
            if (this._defaultProvidersRegistered) return;
            this._defaultProvidersRegistered = true;
            const self = this;
            this.registerProvider('tencent_meeting_download', {
                getTitle() {
                    return '安装腾讯会议';
                },
                getViewModel() {
                    const device = self.detectDevice();
                    const actions = [];
                    if (device === 'ios') {
                        actions.push({ key: 'app_store', label: '前往 App Store 安装', style: 'primary', url: 'itms-apps://apps.apple.com/cn/app/id1484048379', fallbackURL: 'https://apps.apple.com/cn/app/id1484048379' });
                        actions.push({ key: 'official', label: '打开腾讯会议下载页', style: 'secondary', url: 'https://meeting.tencent.com/download/' });
                    } else if (device === 'android') {
                        const fallbackURL = 'https://ulink.meeting.tencent.com/download/';
                        actions.push({ key: 'android_store', label: '应用商店安装', style: 'primary', url: 'intent://details?id=com.tencent.wemeet.app#Intent;scheme=market;S.browser_fallback_url=' + encodeURIComponent(fallbackURL) + ';end', fallbackURL: fallbackURL, fallbackDelay: 3200 });
                        actions.push({ key: 'android_web', label: '直接网页下载', style: 'secondary', url: fallbackURL });
                    } else if (device === 'windows') {
                        actions.push({ key: 'windows_download', label: '下载 Windows 客户端', style: 'primary', url: 'https://meeting.tencent.com/download-win.html', fallbackURL: 'https://meeting.tencent.com/download/' });
                        actions.push({ key: 'official', label: '打开腾讯会议下载页', style: 'secondary', url: 'https://meeting.tencent.com/download/' });
                    } else {
                        actions.push({ key: 'official', label: '打开腾讯会议下载页', style: 'primary', url: 'https://meeting.tencent.com/download/' });
                    }
                    return {
                        title: '安装腾讯会议',
                        eyebrow: 'Tencent Meeting',
                        heading: '当前设备未检测到腾讯会议客户端',
                        description: '请先安装腾讯会议，安装完成后返回此页点击“重新打开腾讯会议”。',
                        tips: [
                            '若 Edge 弹出确认框，可点击“打开外部应用”进入腾讯会议。',
                            '可勾选“记住我的选择”以避免后续重复确认。',
                            device === 'android' ? '安卓设备会优先拉起应用商店；如果无法打开应用商店，可直接网页下载。' : ''
                        ].filter(Boolean),
                        actions: actions
                    };
                }
            });
            this.registerProvider('generic_link', {
                getTitle(payload) {
                    return String(payload && payload.title || '外部链接');
                },
                getViewModel(payload) {
                    const url = String(payload && payload.url || '').trim();
                    return {
                        title: String(payload && payload.title || '外部链接'),
                        eyebrow: 'External Link',
                        heading: String(payload && payload.heading || '即将打开外部页面'),
                        description: String(payload && payload.description || '该页面由外部服务提供，将通过浏览器或系统应用打开。'),
                        tips: ['你可以随时返回 IM 内部页面。'],
                        actions: url ? [{ key: 'open', label: '打开外部页面', style: 'primary', url: url }] : []
                    };
                }
            });
        },

        detectDevice() {
            const ua = String(navigator.userAgent || '').toLowerCase();
            const platform = String(navigator.platform || '').toLowerCase();
            const maxTouchPoints = Number(navigator.maxTouchPoints || 0);
            if (/iphone|ipad|ipod/.test(ua) || (platform === 'macintel' && maxTouchPoints > 1)) return 'ios';
            if (/android/.test(ua)) return 'android';
            if (/win/.test(platform)) return 'windows';
            return 'desktop';
        },

        open(options) {
            const state = this.getState();
            if (!state) return false;
            const opts = options || {};
            const providerName = String(opts.provider || 'generic_link').trim();
            const provider = this.providers[providerName];
            if (!provider) return false;
            const previousView = String(opts.returnView || state.view || 'sessions');
            const previousHomeTab = String(opts.returnHomeTab || state.homeTab || 'chats');
            const title = typeof provider.getTitle === 'function' ? provider.getTitle(opts.payload || null) : '外部页面';
            state.externalPageOpen = true;
            state.externalPageProvider = providerName;
            state.externalPageTitle = String(opts.title || title || '外部页面');
            state.externalPageReturnView = previousView;
            state.externalPageReturnHomeTab = previousHomeTab;
            state.externalPagePayload = opts.payload || null;
            state.open = true;
            state.view = 'external_page';
            this.triggerRender();
            return true;
        },

        close() {
            const state = this.getState();
            if (!state) return;
            const returnView = String(state.externalPageReturnView || 'sessions');
            const returnHomeTab = String(state.externalPageReturnHomeTab || 'chats');
            state.externalPageOpen = false;
            state.externalPageProvider = '';
            state.externalPageTitle = '';
            state.externalPageReturnView = 'sessions';
            state.externalPageReturnHomeTab = 'chats';
            state.externalPagePayload = null;
            state.homeTab = returnHomeTab;
            state.view = returnView;
            this.triggerRender();
        },

        getActiveViewModel() {
            const state = this.getState();
            if (!state || !state.externalPageOpen) return null;
            const provider = this.providers[state.externalPageProvider];
            if (!provider || typeof provider.getViewModel !== 'function') return null;
            return provider.getViewModel(state.externalPagePayload || null) || null;
        },

        render() {
            const body = this.getBody();
            const titleEl = this.getTitleEl();
            const state = this.getState();
            if (!body || !state || !state.externalPageOpen) {
                if (body) body.innerHTML = '';
                return;
            }
            const model = this.getActiveViewModel();
            const esc = this.escapeHtml.bind(this);
            const title = String(state.externalPageTitle || model && model.title || '外部页面');
            if (titleEl) titleEl.textContent = title;
            if (!model) {
                body.innerHTML = '<div class="ak-im-external-card"><div class="ak-im-external-heading">外部页模块暂不可用</div><div class="ak-im-external-desc">请返回上一页后重试。</div></div>';
                return;
            }
            const actions = Array.isArray(model.actions) ? model.actions : [];
            const tips = Array.isArray(model.tips) ? model.tips : [];
            body.innerHTML = `
                <section class="ak-im-external-card">
                    ${model.eyebrow ? `<div class="ak-im-external-eyebrow">${esc(model.eyebrow)}</div>` : ''}
                    <div class="ak-im-external-heading">${esc(model.heading || title)}</div>
                    ${model.description ? `<div class="ak-im-external-desc">${esc(model.description)}</div>` : ''}
                    <div class="ak-im-external-actions">
                        ${actions.map(function(action) {
                            const style = action && action.style === 'secondary' ? 'secondary' : 'primary';
                            return `<button type="button" class="ak-im-external-action ${style}" data-im-external-action="${esc(action.key || '')}">${esc(action.label || '打开')}</button>`;
                        }).join('')}
                    </div>
                    ${tips.length ? `<div class="ak-im-external-tips">${tips.map(function(tip) { return `<div>${esc(tip)}</div>`; }).join('')}</div>` : ''}
                </section>`;
        },

        findAction(actionKey) {
            const key = String(actionKey || '').trim();
            const model = this.getActiveViewModel();
            const actions = model && Array.isArray(model.actions) ? model.actions : [];
            for (let i = 0; i < actions.length; i += 1) {
                if (String(actions[i] && actions[i].key || '') === key) return actions[i];
            }
            return null;
        },

        runAction(actionKey) {
            const action = this.findAction(actionKey);
            if (!action || !action.url) return;
            this.openURL(action);
        },

        openURL(action) {
            const startedAt = Date.now();
            try {
                window.location.href = action.url;
            } catch (e) {}
            if (action.fallbackURL && action.fallbackURL !== action.url) {
                setTimeout(function() {
                    if (document.hidden || Date.now() - startedAt < 1200) return;
                    try {
                        window.location.href = action.fallbackURL;
                    } catch (e) {}
                }, Number(action.fallbackDelay || 1500));
            }
        },

        bindActions() {
            const body = this.getBody();
            if (!body || body.__akExternalPageEventsBound) return;
            body.__akExternalPageEventsBound = true;
            const self = this;
            body.addEventListener('click', function(event) {
                const target = event.target.closest('[data-im-external-action]');
                if (!target || target.disabled) return;
                self.runAction(target.getAttribute('data-im-external-action'));
            });
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.externalPage = externalPageModule;
})(window);
