(function(global) {
    'use strict';

    const DEFAULT_IMAGE_ATTRS = {
        loading: 'lazy',
        decoding: 'async',
        fetchpriority: 'low'
    };

    const resourceTransportModule = {
        ctx: null,
        seenPreloadUrls: {},

        init(ctx) {
            this.ctx = ctx || null;
            this.seenPreloadUrls = this.seenPreloadUrls || {};
        },

        escapeAttribute(value) {
            if (this.ctx && typeof this.ctx.escapeHtml === 'function') {
                return this.ctx.escapeHtml(value).replace(/`/g, '&#96;');
            }
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/`/g, '&#96;');
        },

        normalizeUrl(url) {
            return String(url || '').trim();
        },

        resolveAvatarUrl(url) {
            return this.normalizeUrl(url);
        },

        resolveImageDisplayUrl(payload) {
            if (!payload || typeof payload !== 'object') return '';
            const previewStatus = String(payload.previewStatus || payload.preview_status || '').trim().toLowerCase();
            const previewUrl = this.normalizeUrl(payload.previewUrl || payload.preview_url);
            const displayUrl = this.normalizeUrl(payload.displayUrl || payload.display_url);
            const fileUrl = this.normalizeUrl(payload.fileUrl || payload.file_url);
            if (previewStatus === 'ready' && previewUrl) return previewUrl;
            return displayUrl || previewUrl || fileUrl;
        },

        buildImageAttributes(kind, options) {
            const source = options && typeof options === 'object' ? options : {};
            const attrs = Object.assign({}, DEFAULT_IMAGE_ATTRS);
            const normalizedKind = String(kind || '').trim().toLowerCase();
            if (normalizedKind === 'avatar') {
                attrs.referrerpolicy = source.referrerpolicy || 'no-referrer';
            }
            if (source.loading) attrs.loading = source.loading;
            if (source.decoding) attrs.decoding = source.decoding;
            if (source.fetchpriority) attrs.fetchpriority = source.fetchpriority;
            if (source.referrerpolicy) attrs.referrerpolicy = source.referrerpolicy;
            return Object.keys(attrs).map(function(key) {
                return key + '="' + resourceTransportModule.escapeAttribute(attrs[key]) + '"';
            }).join(' ');
        },

        buildImageMarkup(options) {
            const source = options && typeof options === 'object' ? options : {};
            const src = this.normalizeUrl(source.src);
            if (!src) return '';
            const className = String(source.className || '').trim();
            const alt = String(source.alt || '').trim();
            const kind = String(source.kind || '').trim();
            const attrs = this.buildImageAttributes(kind, source.attrs || {});
            return '<img' +
                (className ? ' class="' + this.escapeAttribute(className) + '"' : '') +
                ' src="' + this.escapeAttribute(src) + '"' +
                ' alt="' + this.escapeAttribute(alt) + '"' +
                (attrs ? ' ' + attrs : '') +
                '>';
        },

        preload(url, options) {
            const normalizedUrl = this.normalizeUrl(url);
            if (!normalizedUrl || this.seenPreloadUrls[normalizedUrl]) return false;
            this.seenPreloadUrls[normalizedUrl] = true;
            const link = document.createElement('link');
            link.rel = 'preload';
            link.as = 'image';
            link.href = normalizedUrl;
            if (options && options.fetchpriority) link.fetchPriority = String(options.fetchpriority);
            (document.head || document.documentElement).appendChild(link);
            return true;
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.resourceTransport = resourceTransportModule;
})(window);
