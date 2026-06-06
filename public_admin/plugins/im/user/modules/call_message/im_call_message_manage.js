(function(global) {
    'use strict';

    const STYLE_ID = 'ak-im-call-event-message-style';

    const ICONS = {
        cancelled: '<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(90 12 12)"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.11 4.18 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.62a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.46-1.18a2 2 0 0 1 2.11-.45c.84.29 1.72.5 2.62.62A2 2 0 0 1 22 16.92Z"></path></g></svg>',
        rejected: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.7 15.4a17 17 0 0 1 16.6 0"></path><path d="m6.15 14.65-2.15 3.75"></path><path d="m17.85 14.65 2.15 3.75"></path><path d="m9 9 6 6"></path><path d="m15 9-6 6"></path></svg>',
        completed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v2.6a2 2 0 0 1-2.2 2 19.7 19.7 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.7 19.7 0 0 1 2 4.2 2 2 0 0 1 4.1 2h2.6"></path><circle cx="18" cy="6" r="4"></circle><path d="M18 4.4v1.9l1.2.9"></path></svg>',
        default: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v2.6a2 2 0 0 1-2.2 2 19.7 19.7 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.7 19.7 0 0 1 2 4.2 2 2 0 0 1 4.1 2h2.6"></path></svg>'
    };
    const CALL_TEXT_PREFIX = '📞';

    function trim(value) {
        return String(value || '').trim();
    }

    function safeParseJson(text) {
        const rawText = trim(text);
        if (!rawText) return null;
        try {
            const parsed = JSON.parse(rawText);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    function normalizeEvent(value) {
        const normalized = trim(value).toLowerCase();
        if (normalized === 'completed') return 'completed';
        if (normalized === 'rejected') return 'rejected';
        if (normalized === 'cancelled') return 'cancelled';
        return '';
    }

    function normalizeKind(value) {
        return trim(value).toLowerCase() === 'video' ? 'video' : 'audio';
    }

    function normalizeDurationText(value) {
        const normalized = trim(value);
        if (!normalized) return '';
        const units = normalized.split(':');
        if (units.length !== 2 && units.length !== 3) return normalized;
        return units.map(function(item) {
            return String(Math.max(0, Number(item || 0) || 0)).padStart(2, '0');
        }).join(':');
    }

    function isPhoneText(value) {
        return trim(value).indexOf(CALL_TEXT_PREFIX) === 0;
    }

    function normalizeTextEvent(text) {
        const normalized = trim(text);
        if (!normalized) return '';
        if (normalized.indexOf('通话时长') >= 0) return 'completed';
        if (normalized.indexOf('拒接') >= 0) return 'rejected';
        if (normalized.indexOf('未接听') >= 0 || normalized.indexOf('取消') >= 0) return 'cancelled';
        return '';
    }

    function buildMainText(eventName, durationText, fallbackText, options) {
        options = options || {};
        const normalizedFallbackText = trim(fallbackText);
        if (eventName === 'completed') return '通话时长 ' + normalizeDurationText(durationText || '00:00');
        if (eventName === 'rejected') return options.remote ? '本次呼叫未接通 · 对方已拒接' : '本次呼叫未接通 · 已拒接';
        if (normalizedFallbackText.indexOf('未接听') >= 0) return '本次呼叫未接通 · 对方未接听';
        if (eventName === 'cancelled') return options.remote ? '本次呼叫未接通 · 对方已取消' : '本次呼叫未接通 · 已取消';
        return normalizedFallbackText || '本次呼叫未接通';
    }

    function buildSubtitle(kind) {
        return normalizeKind(kind) === 'video' ? '视频通话' : '语音通话';
    }

    function resolveIcon(eventName) {
        return ICONS[eventName] || ICONS.default;
    }

    const callMessageManageModule = {
        ctx: null,

        init(ctx) {
            this.ctx = ctx || null;
            return this;
        },

        getViewerUsername() {
            if (this.ctx && typeof this.ctx.getViewerUsername === 'function') {
                return trim(this.ctx.getViewerUsername()).toLowerCase();
            }
            return '';
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

        ensureStyle() {
            if (!global.document || global.document.getElementById(STYLE_ID)) return;
            const styleEl = global.document.createElement('style');
            styleEl.id = STYLE_ID;
            styleEl.textContent = [
                '.ak-im-bubble.ak-im-bubble-call-event{padding:10px 12px;min-width:0}',
                '.ak-im-call-event-bubble{display:flex;align-items:center;gap:10px;min-width:0}',
                '.ak-im-call-event-icon{width:28px;height:28px;border-radius:14px;display:flex;align-items:center;justify-content:center;flex:0 0 auto}',
                '.ak-im-call-event-icon svg{width:18px;height:18px;stroke:currentColor;stroke-width:1.85;stroke-linecap:round;stroke-linejoin:round;fill:none}',
                '.ak-im-call-event-bubble[data-event="cancelled"] .ak-im-call-event-icon{background:rgba(148,163,184,.16);color:#cbd5e1}',
                '.ak-im-call-event-bubble[data-event="rejected"] .ak-im-call-event-icon{background:rgba(239,68,68,.14);color:#f87171}',
                '.ak-im-call-event-bubble[data-event="completed"] .ak-im-call-event-icon{background:rgba(16,185,129,.14);color:#34d399}',
                '.ak-im-call-event-text{min-width:0;display:flex;flex-direction:column;gap:2px}',
                '.ak-im-call-event-title{font-size:14px;font-weight:700;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '.ak-im-call-event-subtitle{font-size:11px;line-height:1.4;color:rgba(100,116,139,.92)}'
            ].join('');
            (global.document.head || global.document.documentElement).appendChild(styleEl);
        },

        resolveCallEvent(item) {
            const messageType = trim(item && item.message_type).toLowerCase();
            const rawContent = trim(item && item.content);
            const rawPreview = trim(item && item.content_preview);
            const senderUsername = trim(item && item.sender_username).toLowerCase();
            const viewerUsername = this.getViewerUsername();
            const isRemote = !!(senderUsername && viewerUsername && senderUsername !== viewerUsername);
            let payload = {};
            let eventName = '';
            let durationText = '';
            let previewText = rawPreview || rawContent;
            if (messageType === 'call_event') {
                payload = safeParseJson(item && item.content) || {};
                eventName = normalizeEvent(payload.event);
                durationText = normalizeDurationText(payload.duration_text || payload.durationText || '');
                previewText = trim(rawPreview || payload.preview_text || payload.previewText);
            } else if (messageType === 'text' && (isPhoneText(rawContent) || isPhoneText(rawPreview))) {
                eventName = normalizeTextEvent(rawPreview || rawContent);
                const durationMatch = String(rawPreview || rawContent).match(/通话时长\s*([0-9:]+)/);
                durationText = normalizeDurationText(durationMatch && durationMatch[1] || '');
            } else {
                return null;
            }
            return {
                event: eventName || normalizeTextEvent(previewText) || (previewText.indexOf('通话时长') >= 0 ? 'completed' : (previewText.indexOf('拒接') >= 0 ? 'rejected' : 'cancelled')),
                title: buildMainText(eventName || normalizeTextEvent(previewText), durationText, previewText, { remote: isRemote }),
                subtitle: buildSubtitle(payload.call_kind || payload.kind || 'audio'),
                icon: resolveIcon(eventName || normalizeTextEvent(previewText)),
                durationText: durationText
            };
        },

        getMessageBubbleClassName(item) {
            return this.resolveCallEvent(item) ? 'ak-im-bubble-call-event' : '';
        },

        buildMessageBubbleMarkup(item) {
            const callEvent = this.resolveCallEvent(item);
            if (!callEvent) return '';
            this.ensureStyle();
            return '<div class="ak-im-call-event-bubble" data-event="' + this.escapeHtml(callEvent.event) + '">' +
                '<span class="ak-im-call-event-icon" aria-hidden="true">' + callEvent.icon + '</span>' +
                '<span class="ak-im-call-event-text">' +
                    '<span class="ak-im-call-event-title">' + this.escapeHtml(callEvent.title) + '</span>' +
                    '<span class="ak-im-call-event-subtitle">' + this.escapeHtml(callEvent.subtitle) + '</span>' +
                '</span>' +
            '</div>';
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.callMessageManage = callMessageManageModule;
})(window);
