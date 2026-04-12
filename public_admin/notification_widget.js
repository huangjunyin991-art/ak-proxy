(function() {
    'use strict';

    if (window.AKNotificationWidgetLoaded) return;
    window.AKNotificationWidgetLoaded = true;

    const state = {
        items: [],
        unreadCount: 0,
        open: false,
        mounted: false,
        lastMarkedReadAt: 0,
        requestedSnapshot: false
    };

    let rootEl = null;
    let badgeEl = null;
    let listEl = null;
    let emptyEl = null;
    let countEl = null;
    let panelEl = null;
    let bellBtnEl = null;
    let mountedApi = null;

    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    function isMobilePlatform() {
        const ua = String((navigator && navigator.userAgent) || '').toLowerCase();
        return /iphone|ipad|ipod|android|mobile|harmonyos/.test(ua);
    }

    function normalizeItems(items) {
        if (!Array.isArray(items)) return [];
        const next = [];
        const seen = new Set();
        items.forEach(function(item) {
            if (!item || typeof item !== 'object') return;
            const id = Number(item.id || 0);
            if (!id || seen.has(id)) return;
            seen.add(id);
            next.push(item);
        });
        next.sort(function(a, b) {
            return Number(b.id || 0) - Number(a.id || 0);
        });
        return next;
    }

    function upsertNotification(item) {
        if (!item || typeof item !== 'object') return;
        const id = Number(item.id || 0);
        if (!id) return;
        const next = [];
        let inserted = false;
        normalizeItems(state.items).forEach(function(current) {
            if (Number(current.id || 0) === id) {
                if (!inserted) {
                    next.push(item);
                    inserted = true;
                }
            } else {
                next.push(current);
            }
        });
        if (!inserted) next.unshift(item);
        state.items = normalizeItems(next);
    }

    function formatTime(value) {
        if (!value) return '';
        try {
            const date = value instanceof Date ? value : new Date(value);
            if (isNaN(date.getTime())) return String(value || '');
            return date.toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            return String(value || '');
        }
    }

    function isHttpUrl(url) {
        return /^https?:/i.test(String(url || '').trim());
    }

    function isMeetingNotification(item) {
        const payload = item && item.payload && typeof item.payload === 'object' ? item.payload : {};
        return String(item && item.notification_type || '').trim().toLowerCase() === 'meeting'
            || String(payload.kind || '').trim().toLowerCase() === 'meeting';
    }

    function getActionLabel(item) {
        if (isMeetingNotification(item)) return '进入会议';
        const payload = item && item.payload && typeof item.payload === 'object' ? item.payload : {};
        if (payload.url) return '立即查看';
        return '';
    }

    function getPanelTitle() {
        const unread = Number(state.unreadCount || 0);
        return unread > 0 ? `通知中心 · ${unread} 条未读` : '通知中心';
    }

    function ensureStyle() {
        if (document.getElementById('ak-notification-widget-style')) return;
        const style = document.createElement('style');
        style.id = 'ak-notification-widget-style';
        style.textContent = `
#ak-notification-widget-root {
    display: none;
    position: fixed;
    left: 50%;
    top: calc(env(safe-area-inset-top, 0px) + 12px);
    transform: translateX(-50%);
    z-index: 2147483642;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
#ak-notification-widget-root.visible {
    display: block;
}
#ak-notification-widget-root * {
    box-sizing: border-box;
}
#ak-notification-widget-root .ak-notification-bell {
    width: 56px;
    height: 56px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: rgba(233, 244, 255, 0.84);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow: none;
    cursor: pointer;
    position: relative;
    transition: color 0.18s ease, transform 0.18s ease, filter 0.18s ease;
}
#ak-notification-widget-root .ak-notification-bell::before {
    content: '';
    position: absolute;
    inset: 3px;
    border-radius: 999px;
    background: radial-gradient(circle at 50% 40%, rgba(255, 230, 164, 0) 0%, rgba(255, 198, 86, 0) 58%, rgba(255, 174, 46, 0) 100%);
    opacity: 0;
    transition: opacity 0.18s ease, background 0.18s ease;
    pointer-events: none;
}
#ak-notification-widget-root .ak-notification-bell svg {
    position: relative;
    z-index: 1;
    width: 28px;
    height: 28px;
}
#ak-notification-widget-root .ak-notification-bell:hover {
    transform: translateY(-1px);
}
#ak-notification-widget-root .ak-notification-bell:hover::before,
#ak-notification-widget-root .ak-notification-bell.is-open::before {
    opacity: 1;
    background: radial-gradient(circle at 50% 40%, rgba(255, 230, 164, 0.14) 0%, rgba(255, 199, 87, 0.08) 58%, rgba(255, 174, 46, 0.02) 100%);
}
#ak-notification-widget-root .ak-notification-bell:hover,
#ak-notification-widget-root .ak-notification-bell.is-open {
    color: #fff0c0;
    filter: drop-shadow(0 0 12px rgba(255, 213, 100, 0.22));
}
@keyframes ak-notification-bell-gold-flash {
    0%,
    100% {
        filter: drop-shadow(0 0 12px rgba(255, 210, 88, 0.22));
    }
    50% {
        filter: drop-shadow(0 0 22px rgba(255, 229, 124, 0.48));
    }
}
@keyframes ak-notification-bell-aura {
    0%,
    100% {
        opacity: 0.72;
    }
    50% {
        opacity: 1;
    }
}
#ak-notification-widget-root .ak-notification-bell {
}
#ak-notification-widget-root .ak-notification-bell.has-unread {
    color: #f1cf63;
    animation: ak-notification-bell-gold-flash 1.8s ease-in-out infinite;
}
#ak-notification-widget-root .ak-notification-bell.has-unread::before {
    opacity: 1;
    background: radial-gradient(circle at 50% 40%, rgba(255, 232, 158, 0.22) 0%, rgba(255, 202, 89, 0.14) 56%, rgba(255, 156, 42, 0.04) 100%);
    animation: ak-notification-bell-aura 1.8s ease-in-out infinite;
}
#ak-notification-widget-root .ak-notification-dot {
    position: absolute;
    top: 8px;
    right: 8px;
    min-width: 14px;
    width: 14px;
    height: 14px;
    padding: 0;
    border-radius: 999px;
    background: radial-gradient(circle at 32% 30%, rgba(255, 255, 255, 0.95) 0%, rgba(255, 183, 188, 0.96) 18%, #ff555f 36%, #ef1f36 58%, #bf0b1f 76%, #7a000f 100%);
    color: transparent;
    font-size: 0;
    line-height: 0;
    display: none;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(92, 8, 20, 0.92);
    box-shadow: 0 0 0 2px rgba(15, 16, 26, 0.88), 0 0 14px rgba(255, 42, 76, 0.34), inset 0 1px 1px rgba(255, 255, 255, 0.45), inset 0 -2px 3px rgba(87, 0, 16, 0.35);
    z-index: 2;
}
#ak-notification-widget-root .ak-notification-dot::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 6px;
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.72);
    filter: blur(0.3px);
}
#ak-notification-widget-root .ak-notification-dot.visible {
    display: inline-flex;
}
#ak-notification-widget-root .ak-notification-panel {
    position: absolute;
    left: 50%;
    top: 68px;
    right: auto;
    bottom: auto;
    transform: translateX(-50%);
    width: min(420px, calc(100vw - 24px));
    max-height: min(72vh, 680px);
    display: none;
    flex-direction: column;
    border: 1px solid rgba(255, 218, 124, 0.14);
    border-radius: 20px;
    background: linear-gradient(180deg, rgba(8, 18, 31, 0.98) 0%, rgba(5, 11, 22, 0.98) 100%);
    box-shadow: 0 22px 48px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 213, 102, 0.04);
    overflow: hidden;
    backdrop-filter: blur(12px);
}
#ak-notification-widget-root .ak-notification-panel.visible {
    display: flex;
}
#ak-notification-widget-root .ak-notification-panel-head {
    padding: 16px 18px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    color: #f2feff;
    font-size: 15px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}
#ak-notification-widget-root .ak-notification-panel-count {
    color: rgba(179, 233, 241, 0.88);
    font-size: 12px;
    font-weight: 500;
}
#ak-notification-widget-root .ak-notification-list {
    overflow: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
#ak-notification-widget-root .ak-notification-empty {
    display: none;
    padding: 34px 18px 40px;
    text-align: center;
    color: rgba(182, 212, 220, 0.86);
    font-size: 13px;
}
#ak-notification-widget-root .ak-notification-empty.visible {
    display: block;
}
#ak-notification-widget-root .ak-notification-item {
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 16px;
    padding: 14px 14px 12px;
    background: rgba(255, 255, 255, 0.028);
    color: #effdff;
    position: relative;
}
#ak-notification-widget-root .ak-notification-item.ak-unread {
    border-color: rgba(0, 214, 255, 0.18);
    background: linear-gradient(180deg, rgba(12, 35, 55, 0.42) 0%, rgba(255, 255, 255, 0.028) 100%);
}
#ak-notification-widget-root .ak-notification-item-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}
#ak-notification-widget-root .ak-notification-type {
    font-size: 11px;
    line-height: 18px;
    padding: 0 8px;
    border-radius: 999px;
    color: #b4fdff;
    background: rgba(0, 214, 255, 0.12);
    border: 1px solid rgba(0, 214, 255, 0.18);
}
#ak-notification-widget-root .ak-notification-type.meeting {
    color: #ffe3b0;
    background: rgba(255, 168, 51, 0.12);
    border-color: rgba(255, 168, 51, 0.18);
}
#ak-notification-widget-root .ak-notification-time {
    margin-left: auto;
    font-size: 11px;
    color: rgba(173, 208, 216, 0.72);
}
#ak-notification-widget-root .ak-notification-title {
    font-size: 14px;
    font-weight: 600;
    color: #f7ffff;
    line-height: 1.45;
}
#ak-notification-widget-root .ak-notification-content {
    margin-top: 6px;
    font-size: 13px;
    line-height: 1.6;
    color: rgba(221, 243, 248, 0.92);
    white-space: pre-wrap;
    word-break: break-word;
}
#ak-notification-widget-root .ak-notification-meta {
    margin-top: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}
#ak-notification-widget-root .ak-notification-chip {
    font-size: 11px;
    line-height: 18px;
    padding: 0 8px;
    border-radius: 999px;
    color: rgba(183, 223, 230, 0.92);
    background: rgba(255, 255, 255, 0.06);
}
#ak-notification-widget-root .ak-notification-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
}
#ak-notification-widget-root .ak-notification-action-btn {
    border: 1px solid rgba(0, 214, 255, 0.18);
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(13, 78, 96, 0.92) 0%, rgba(8, 47, 59, 0.92) 100%);
    color: #effdff;
    font-size: 12px;
    font-weight: 600;
    line-height: 34px;
    padding: 0 14px;
    cursor: pointer;
}
#ak-notification-widget-root .ak-notification-action-btn.secondary {
    border-color: rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04);
    color: rgba(224, 245, 249, 0.9);
}
#ak-notification-widget-root .ak-notification-unread-mark {
    position: absolute;
    top: 14px;
    right: 14px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ff5968;
    box-shadow: 0 0 0 3px rgba(17, 27, 42, 0.9);
}
@media (max-width: 768px) {
    #ak-notification-widget-root {
        top: calc(env(safe-area-inset-top, 0px) + 10px);
    }
    #ak-notification-widget-root .ak-notification-bell {
        width: 52px;
        height: 52px;
    }
    #ak-notification-widget-root .ak-notification-panel {
        top: 62px;
        width: min(420px, calc(100vw - 16px));
        max-height: min(70vh, 620px);
    }
}
        `;
        document.head.appendChild(style);
    }

    function ensureMounted() {
        if (state.mounted) return;
        if (!document.body) return;
        ensureStyle();
        rootEl = document.createElement('div');
        rootEl.id = 'ak-notification-widget-root';
        rootEl.innerHTML = `
            <div class="ak-notification-panel" id="ak-notification-panel">
                <div class="ak-notification-panel-head">
                    <span id="ak-notification-panel-title">通知中心</span>
                    <span class="ak-notification-panel-count" id="ak-notification-panel-count">0 条通知</span>
                </div>
                <div class="ak-notification-empty" id="ak-notification-empty">暂无通知</div>
                <div class="ak-notification-list" id="ak-notification-list"></div>
            </div>
            <button type="button" class="ak-notification-bell" id="ak-notification-bell" aria-label="通知中心" title="通知中心">
                <span class="ak-notification-dot" id="ak-notification-dot"></span>
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
                    <path d="M12 3.75a4.25 4.25 0 0 0-4.25 4.25v1.41c0 .84-.24 1.66-.69 2.37l-1.26 1.98A1.75 1.75 0 0 0 7.28 16.5h9.44a1.75 1.75 0 0 0 1.48-2.74l-1.26-1.98a4.42 4.42 0 0 1-.69-2.37V8A4.25 4.25 0 0 0 12 3.75Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
                    <path d="M9.75 18a2.25 2.25 0 0 0 4.5 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                </svg>
            </button>
        `;
        document.body.appendChild(rootEl);
        badgeEl = document.getElementById('ak-notification-dot');
        listEl = document.getElementById('ak-notification-list');
        emptyEl = document.getElementById('ak-notification-empty');
        countEl = document.getElementById('ak-notification-panel-count');
        panelEl = document.getElementById('ak-notification-panel');
        bellBtnEl = document.getElementById('ak-notification-bell');
        bellBtnEl.addEventListener('click', function() {
            state.open = !state.open;
            if (state.open && Number(state.unreadCount || 0) > 0) {
                state.lastMarkedReadAt = Date.now();
                optimisticMarkAllRead();
                sendPayload({ type: 'notification_read_all' });
            }
            render();
        });
        document.addEventListener('click', function(event) {
            if (!state.open || !rootEl) return;
            const target = event && event.target;
            if (target && rootEl.contains(target)) return;
            state.open = false;
            render();
        }, true);
        state.mounted = true;
        render();
    }

    function getChatApi() {
        return window.AKChat && typeof window.AKChat === 'object' ? window.AKChat : null;
    }

    function sendPayload(payload) {
        const api = getChatApi();
        if (!api || typeof api.sendWsPayload !== 'function') return false;
        return !!api.sendWsPayload(payload);
    }

    function requestSnapshot(force) {
        const api = getChatApi();
        if (!api || typeof api.sendWsPayload !== 'function') return false;
        if (state.requestedSnapshot && !force) return true;
        state.requestedSnapshot = !!api.sendWsPayload({ type: 'notification_request_snapshot' });
        return state.requestedSnapshot;
    }

    function optimisticMarkAllRead() {
        state.unreadCount = 0;
        state.items = normalizeItems(state.items).map(function(item) {
            return Object.assign({}, item, {
                read: true,
                read_at: item.read_at || new Date().toISOString()
            });
        });
    }

    function cancelFallback(timer, handlers) {
        if (timer) clearTimeout(timer);
        if (!handlers) return;
        if (handlers.blur) window.removeEventListener('blur', handlers.blur, true);
        if (handlers.pagehide) window.removeEventListener('pagehide', handlers.pagehide, true);
        if (handlers.visibilitychange) document.removeEventListener('visibilitychange', handlers.visibilitychange, true);
    }

    function openUrl(url, mode) {
        const finalUrl = String(url || '').trim();
        if (!finalUrl) return false;
        const finalMode = String(mode || 'location').trim().toLowerCase();
        if (finalMode === 'new_window') {
            const popup = window.open(finalUrl, '_blank', 'noopener,noreferrer');
            if (popup) return true;
        }
        if (finalMode === 'iframe') {
            const iframe = document.createElement('iframe');
            iframe.style.position = 'absolute';
            iframe.style.width = '1px';
            iframe.style.height = '1px';
            iframe.style.opacity = '0';
            iframe.style.pointerEvents = 'none';
            iframe.style.border = '0';
            iframe.src = finalUrl;
            document.body.appendChild(iframe);
            setTimeout(function() {
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            }, 1600);
            return true;
        }
        if (isHttpUrl(finalUrl)) {
            const popup = window.open(finalUrl, '_blank', 'noopener,noreferrer');
            if (popup) return true;
        }
        try {
            window.location.href = finalUrl;
            return true;
        } catch (e) {
            return false;
        }
    }

    function launchMeeting(item) {
        const payload = item && item.payload && typeof item.payload === 'object' ? item.payload : {};
        const targets = Array.isArray(payload.launch_targets) ? payload.launch_targets : [];
        const platform = isMobilePlatform() ? 'mobile' : 'desktop';
        const primary = [];
        const fallbackTargets = [];
        targets.forEach(function(target) {
            if (!target || typeof target !== 'object') return;
            if (String(target.platform || '').trim().toLowerCase() === platform) {
                primary.push(target);
            } else {
                fallbackTargets.push(target);
            }
        });
        const orderedTargets = primary.concat(fallbackTargets);
        const fallbackUrl = String(payload.web_fallback_url || '').trim();
        const launched = orderedTargets.some(function(target) {
            return openUrl(target.url, target.method);
        });
        if (!launched && fallbackUrl) {
            openUrl(fallbackUrl, 'new_window');
            return;
        }
        if (!fallbackUrl) return;
        const handlers = {};
        const timer = setTimeout(function() {
            cancelFallback(null, handlers);
            if (document.visibilityState === 'visible') {
                openUrl(fallbackUrl, 'new_window');
            }
        }, isMobilePlatform() ? 1500 : 1200);
        handlers.blur = function() { cancelFallback(timer, handlers); };
        handlers.pagehide = function() { cancelFallback(timer, handlers); };
        handlers.visibilitychange = function() {
            if (document.visibilityState === 'hidden') {
                cancelFallback(timer, handlers);
            }
        };
        window.addEventListener('blur', handlers.blur, true);
        window.addEventListener('pagehide', handlers.pagehide, true);
        document.addEventListener('visibilitychange', handlers.visibilitychange, true);
    }

    function handleAction(itemId) {
        const item = normalizeItems(state.items).find(function(current) {
            return Number(current.id || 0) === Number(itemId || 0);
        });
        if (!item) return;
        if (isMeetingNotification(item)) {
            launchMeeting(item);
            return;
        }
        const payload = item && item.payload && typeof item.payload === 'object' ? item.payload : {};
        if (payload.url) {
            openUrl(payload.url, 'new_window');
        }
    }

    function renderItems() {
        if (!listEl || !emptyEl || !countEl || !panelEl || !badgeEl || !bellBtnEl) return;
        const items = normalizeItems(state.items);
        listEl.innerHTML = '';
        if (!items.length) {
            emptyEl.classList.add('visible');
        } else {
            emptyEl.classList.remove('visible');
            items.forEach(function(item) {
                const payload = item && item.payload && typeof item.payload === 'object' ? item.payload : {};
                const actionLabel = getActionLabel(item);
                const row = document.createElement('div');
                row.className = `ak-notification-item ${item.read ? '' : 'ak-unread'}`;
                const typeLabel = isMeetingNotification(item) ? '会议通知' : '一般通知';
                const metaChips = [];
                if (payload.meeting_code) metaChips.push(`<span class="ak-notification-chip">会议号 ${escapeHtml(payload.meeting_code)}</span>`);
                if (payload.meeting_password) metaChips.push(`<span class="ak-notification-chip">密码 ${escapeHtml(payload.meeting_password)}</span>`);
                if (payload.start_time) metaChips.push(`<span class="ak-notification-chip">开始时间 ${escapeHtml(payload.start_time)}</span>`);
                row.innerHTML = `
                    ${item.read ? '' : '<span class="ak-notification-unread-mark"></span>'}
                    <div class="ak-notification-item-head">
                        <span class="ak-notification-type ${isMeetingNotification(item) ? 'meeting' : ''}">${typeLabel}</span>
                        <span class="ak-notification-time">${escapeHtml(formatTime(item.published_at || item.created_at || item.delivered_at))}</span>
                    </div>
                    <div class="ak-notification-title">${escapeHtml(item.title || (isMeetingNotification(item) ? '会议通知' : '系统通知'))}</div>
                    <div class="ak-notification-content">${escapeHtml(item.content || '')}</div>
                    ${metaChips.length ? `<div class="ak-notification-meta">${metaChips.join('')}</div>` : ''}
                    ${actionLabel ? `<div class="ak-notification-actions"><button type="button" class="ak-notification-action-btn" data-action-id="${Number(item.id || 0)}">${actionLabel}</button></div>` : ''}
                `;
                const actionBtn = row.querySelector('[data-action-id]');
                if (actionBtn) {
                    actionBtn.addEventListener('click', function(event) {
                        event.preventDefault();
                        event.stopPropagation();
                        handleAction(item.id);
                    });
                }
                listEl.appendChild(row);
            });
        }
        const unread = Math.max(0, Number(state.unreadCount || 0));
        const shouldShowWidget = items.length > 0 || unread > 0;
        if (!shouldShowWidget) {
            state.open = false;
        }
        rootEl.classList.toggle('visible', shouldShowWidget);
        badgeEl.classList.toggle('visible', unread > 0);
        badgeEl.textContent = '';
        panelEl.classList.toggle('visible', shouldShowWidget && !!state.open);
        bellBtnEl.classList.toggle('has-unread', unread > 0);
        bellBtnEl.classList.toggle('is-open', shouldShowWidget && !!state.open);
        countEl.textContent = `${items.length} 条通知`;
        const panelTitle = document.getElementById('ak-notification-panel-title');
        if (panelTitle) panelTitle.textContent = getPanelTitle();
        bellBtnEl.title = getPanelTitle();
        bellBtnEl.setAttribute('aria-label', getPanelTitle());
    }

    function render() {
        ensureMounted();
        renderItems();
    }

    function applySnapshot(items, unreadCount) {
        state.items = normalizeItems(items);
        state.unreadCount = Math.max(0, Number(unreadCount || 0));
        render();
    }

    function handleBridgeMessage(data) {
        if (!data || typeof data !== 'object') return;
        if (data.type === 'notification_snapshot') {
            state.requestedSnapshot = true;
            applySnapshot(data.items, data.unread_count);
            return;
        }
        if (data.type === 'notification_new') {
            upsertNotification(data.notification);
            state.unreadCount = Math.max(0, Number(state.unreadCount || 0) + 1);
            if (!state.open) {
                const api = getChatApi();
                if (api && typeof api.playNotificationSound === 'function') {
                    api.playNotificationSound();
                }
            }
            render();
            return;
        }
        if (data.type === 'notification_read_sync') {
            const readIds = new Set(Array.isArray(data.campaign_ids) ? data.campaign_ids.map(function(item) { return Number(item || 0); }) : []);
            state.items = normalizeItems(state.items).map(function(item) {
                if (!readIds.has(Number(item.id || 0))) return item;
                return Object.assign({}, item, {
                    read: true,
                    read_at: item.read_at || new Date().toISOString()
                });
            });
            state.unreadCount = Math.max(0, Number(data.unread_count || 0));
            render();
        }
    }

    function mount(api) {
        mountedApi = api || getChatApi();
        render();
        requestSnapshot(true);
    }

    window.addEventListener('ak-chat-ready', function(event) {
        const detail = event && event.detail && typeof event.detail === 'object' ? event.detail : {};
        mount(detail.api || getChatApi());
    });

    window.addEventListener('ak-chat-ws-open', function() {
        requestSnapshot(true);
    });

    window.addEventListener('ak-chat-ws-message', function(event) {
        handleBridgeMessage(event && event.detail);
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            mount(getChatApi());
        });
    } else {
        mount(getChatApi());
    }

    window.AKNotificationWidget = {
        requestSnapshot: function() { return requestSnapshot(true); },
        open: function() { state.open = true; render(); },
        close: function() { state.open = false; render(); },
        getState: function() {
            return {
                items: normalizeItems(state.items),
                unreadCount: Math.max(0, Number(state.unreadCount || 0)),
                open: !!state.open,
                mounted: !!state.mounted,
                ready: !!mountedApi
            };
        }
    };
})();
