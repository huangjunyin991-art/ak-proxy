(function(global) {
    'use strict';

    const DEFAULT_STYLE = 'thumbs';
    const DEFAULT_SIZE = 128;
    const DEFAULT_KIND = 'generated';
    const EXTERNAL_DICEBEAR_BASE = 'https://api.dicebear.com/9.x/thumbs/svg';

    const avatarRuntimeModule = {
        ctx: null,
        dataUriCache: {},
        cacheKeys: [],
        cacheLimit: 500,

        init(ctx) {
            this.ctx = ctx || null;
            this.dataUriCache = this.dataUriCache || {};
            this.cacheKeys = this.cacheKeys || [];
        },

        normalizeText(value) {
            return String(value == null ? '' : value).trim();
        },

        normalizeStyle(value) {
            const style = this.normalizeText(value).toLowerCase();
            return style || DEFAULT_STYLE;
        },

        normalizeKind(value) {
            const kind = this.normalizeText(value).toLowerCase();
            return kind || DEFAULT_KIND;
        },

        normalizeSeed(value) {
            return this.normalizeText(value) || 'user';
        },

        getDicebearThumbsModule() {
            const modules = global.AKIMUserModules;
            if (!modules || typeof modules !== 'object') return null;
            const dicebearThumbs = modules.dicebearThumbs;
            if (!dicebearThumbs || typeof dicebearThumbs.createThumbsDataUri !== 'function') return null;
            return dicebearThumbs;
        },

        isGeneratedThumbsDescriptor(descriptor) {
            if (!descriptor || typeof descriptor !== 'object') return false;
            const style = this.normalizeStyle(descriptor.avatar_style || descriptor.avatarStyle || descriptor.style);
            const kind = this.normalizeKind(descriptor.avatar_kind || descriptor.avatarKind || descriptor.kind);
            const seed = this.normalizeText(descriptor.avatar_seed || descriptor.avatarSeed || descriptor.seed);
            return !!seed && style === DEFAULT_STYLE && (kind === DEFAULT_KIND || kind === 'default' || kind === 'dicebear');
        },

        normalizeDescriptor(source) {
            if (!source || typeof source !== 'object') {
                const url = this.normalizeText(source);
                return url ? { avatar_url: url } : null;
            }
            const descriptor = Object.assign({}, source);
            const rawKind = this.normalizeText(descriptor.avatar_kind || descriptor.avatarKind || descriptor.sender_avatar_kind || descriptor.senderAvatarKind || descriptor.kind);
            const rawSeed = this.normalizeText(descriptor.avatar_seed || descriptor.avatarSeed || descriptor.sender_avatar_seed || descriptor.senderAvatarSeed || descriptor.seed);
            descriptor.avatar_url = this.normalizeText(descriptor.avatar_url || descriptor.avatarUrl || descriptor.sender_avatar_url || descriptor.senderAvatarUrl || descriptor.url);
            descriptor.avatar_style = this.normalizeStyle(descriptor.avatar_style || descriptor.avatarStyle || descriptor.sender_avatar_style || descriptor.senderAvatarStyle || descriptor.style);
            descriptor.avatar_kind = rawKind ? this.normalizeKind(rawKind) : (rawSeed ? DEFAULT_KIND : 'custom');
            descriptor.avatar_seed = rawSeed ? this.normalizeSeed(rawSeed) : '';
            return descriptor;
        },

        buildExternalThumbsUrl(seed, options) {
            const size = Number(options && options.size || DEFAULT_SIZE) || DEFAULT_SIZE;
            return EXTERNAL_DICEBEAR_BASE + '?seed=' + encodeURIComponent(this.normalizeSeed(seed)) + '&size=' + encodeURIComponent(String(size));
        },

        getCachedDataUri(cacheKey) {
            return Object.prototype.hasOwnProperty.call(this.dataUriCache, cacheKey) ? this.dataUriCache[cacheKey] : '';
        },

        rememberDataUri(cacheKey, dataUri) {
            if (!cacheKey || !dataUri) return dataUri;
            if (!Object.prototype.hasOwnProperty.call(this.dataUriCache, cacheKey)) {
                this.cacheKeys.push(cacheKey);
            }
            this.dataUriCache[cacheKey] = dataUri;
            while (this.cacheKeys.length > this.cacheLimit) {
                const oldestKey = this.cacheKeys.shift();
                if (oldestKey) delete this.dataUriCache[oldestKey];
            }
            return dataUri;
        },

        buildLocalThumbsDataUri(seed, options) {
            const normalizedSeed = this.normalizeSeed(seed);
            const size = Number(options && options.size || DEFAULT_SIZE) || DEFAULT_SIZE;
            const cacheKey = DEFAULT_STYLE + ':' + normalizedSeed + ':' + size;
            const cached = this.getCachedDataUri(cacheKey);
            if (cached) return cached;
            const dicebearThumbs = this.getDicebearThumbsModule();
            if (!dicebearThumbs) return '';
            const dataUri = dicebearThumbs.createThumbsDataUri(normalizedSeed, { size: size });
            return this.rememberDataUri(cacheKey, dataUri);
        },

        resolveAvatarUrl(source, options) {
            const descriptor = this.normalizeDescriptor(source);
            if (!descriptor) return '';
            if (this.isGeneratedThumbsDescriptor(descriptor)) {
                return this.buildLocalThumbsDataUri(descriptor.avatar_seed, options || {});
            }
            return descriptor.avatar_url || '';
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.avatarRuntime = avatarRuntimeModule;
})(window);
