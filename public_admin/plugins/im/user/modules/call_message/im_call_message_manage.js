(function(global) {
    'use strict';

    const STYLE_ID = 'ak-im-call-event-message-style';

    const ICONS = {
        cancelled: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.7 15.4a17 17 0 0 1 16.6 0"></path><path d="m6.15 14.65-2.15 3.75"></path><path d="m17.85 14.65 2.15 3.75"></path><path d="M4 4 20 20"></path></svg>',
        rejected: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.7 15.4a17 17 0 0 1 16.6 0"></path><path d="m6.15 14.65-2.15 3.75"></path><path d="m17.85 14.65 2.15 3.75"></path><path d="m9 9 6 6"></path><path d="m15 9-6 6"></path></svg>',
        completed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v2.6a2 2 0 0 1-2.2 2 19.7 19.7 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.7 19.7 0 0 1 2 4.2 2 2 0 0 1 4.1 2h2.6"></path><circle cx="18" cy="6" r="4"></circle><path d="M18 4.4v1.9l1.2.9"></path></svg>',
        default: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v2.6a2 2 0 0 1-2.2 2 19.7 19.7 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.7 19.7 0 0 1 2 4.2 2 2 0 0 1 4.1 2h2.6"></path></svg>'
    };

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

    function buildMainText(eventName, durationText, fallbackText) {
        const normalizedFallbackText = trim(fallbackText);
        if (normalizedFallbackText) return normalizedFallbackText;
        if (eventName === 'completed') return '通话时长 ' + normalizeDurationText(durationText || '00:00');
        if (eventName === 'rejected') return '已拒接';
        return '已取消';
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
            if (trim(item && item.message_type).toLowerCase() !== 'call_event') return null;
            const payload = safeParseJson(item && item.content) || {};
            const eventName = normalizeEvent(payload.event);
            const durationText = normalizeDurationText(payload.duration_text || payload.durationText || '');
            const previewText = trim(item && item.content_preview || payload.preview_text || payload.previewText);
            return {
                event: eventName || (previewText.indexOf('通话时长') === 0 ? 'completed' : (previewText === '已拒接' ? 'rejected' : 'cancelled')),
                title: buildMainText(eventName, durationText, previewText),
                subtitle: buildSubtitle(payload.call_kind || payload.kind),
                icon: resolveIcon(eventName),
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
