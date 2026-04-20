(function(global) {
    'use strict';

    const HEIC2ANY_LOCAL_URL = '/chat/plugins/im/user/vendor/heic2any.min.js';

    const heicManageModule = {
        ctx: null,
        libraryPromise: null,

        init(ctx) {
            this.ctx = ctx || null;
        },

        normalizeMimeType(value) {
            return String(value || '').trim().toLowerCase();
        },

        normalizeQuality(value) {
            return Math.max(0.4, Math.min(0.95, Number(value || 0.86) || 0.86));
        },

        getFileExtension(fileName) {
            const normalizedName = String(fileName || '').trim();
            const matched = normalizedName.match(/\.[^.]+$/);
            return matched ? matched[0].toLowerCase() : '';
        },

        isHeicLikeMimeType(value) {
            const normalizedMimeType = this.normalizeMimeType(value);
            return normalizedMimeType === 'image/heic' || normalizedMimeType === 'image/heif';
        },

        isHeicLikeFile(file) {
            if (!file || typeof file !== 'object') return false;
            if (this.isHeicLikeMimeType(file.type)) return true;
            const ext = this.getFileExtension(file.name);
            return ext === '.heic' || ext === '.heif';
        },

        getOutputExtension(mimeType) {
            const normalizedMimeType = this.normalizeMimeType(mimeType);
            if (normalizedMimeType === 'image/jpeg') return 'jpg';
            if (normalizedMimeType === 'image/png') return 'png';
            return 'webp';
        },

        buildOutputFileName(fileName, mimeType) {
            const normalizedName = String(fileName || '').trim();
            const baseName = normalizedName ? normalizedName.replace(/\.[^.]+$/, '') : ('image-' + Date.now());
            return (baseName || ('image-' + Date.now())) + '.' + this.getOutputExtension(mimeType);
        },

        buildPreparedFile(file, blob, mimeType) {
            const normalizedMimeType = this.normalizeMimeType(mimeType) || this.normalizeMimeType(blob && blob.type) || 'image/webp';
            const nextFileName = this.buildOutputFileName(file && file.name, normalizedMimeType);
            return {
                file: new File([blob], nextFileName, {
                    type: normalizedMimeType,
                    lastModified: Date.now()
                }),
                targetMimeType: normalizedMimeType,
                changed: true
            };
        },

        resolveConverter() {
            if (typeof global.heic2any === 'function') return global.heic2any;
            if (global.heic2any && typeof global.heic2any.default === 'function') return global.heic2any.default;
            return null;
        },

        buildLibraryUrl() {
            const assetVersion = String(global.__AK_WIDGET_ASSET_VERSION__ || '').trim();
            try {
                const finalUrl = new URL(HEIC2ANY_LOCAL_URL, global.location && global.location.origin ? global.location.origin : undefined);
                if (assetVersion) finalUrl.searchParams.set('v', assetVersion);
                return finalUrl.toString();
            } catch (e) {
                if (!assetVersion) return HEIC2ANY_LOCAL_URL;
                return HEIC2ANY_LOCAL_URL + '?v=' + encodeURIComponent(assetVersion);
            }
        },

        ensureConverter() {
            const resolvedConverter = this.resolveConverter();
            if (resolvedConverter) return Promise.resolve(resolvedConverter);
            if (this.libraryPromise) return this.libraryPromise;
            const self = this;
            this.libraryPromise = new Promise(function(resolve, reject) {
                const selector = 'script[data-ak-im-heic-lib="1"]';
                let script = document.querySelector(selector);
                const finalize = function() {
                    const converter = self.resolveConverter();
                    if (!converter) {
                        reject(new Error('HEIC 转码库加载失败'));
                        return;
                    }
                    resolve(converter);
                };
                if (script) {
                    if (script.dataset.akImHeicLibReady === '1') {
                        finalize();
                        return;
                    }
                    script.addEventListener('load', finalize, { once: true });
                    script.addEventListener('error', function() {
                        reject(new Error('HEIC 转码库加载失败'));
                    }, { once: true });
                    return;
                }
                script = document.createElement('script');
                script.src = self.buildLibraryUrl();
                script.async = true;
                script.dataset.akImHeicLib = '1';
                script.onload = function() {
                    script.dataset.akImHeicLibReady = '1';
                    finalize();
                };
                script.onerror = function() {
                    reject(new Error('HEIC 转码库加载失败'));
                };
                (document.head || document.documentElement || document.body).appendChild(script);
            }).then(function(converter) {
                self.libraryPromise = Promise.resolve(converter);
                return converter;
            }, function(error) {
                self.libraryPromise = null;
                throw error;
            });
            return this.libraryPromise;
        },

        convertWithLibrary(file, options) {
            const self = this;
            const targetMimeType = this.normalizeMimeType(options && options.targetMimeType) === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
            const quality = this.normalizeQuality(options && options.quality);
            return this.ensureConverter().then(function(converter) {
                return Promise.resolve(converter({
                    blob: file,
                    toType: targetMimeType,
                    quality: quality
                })).then(function(result) {
                    const blob = Array.isArray(result) ? result[0] : result;
                    if (!(blob instanceof Blob)) throw new Error('HEIC 图片转换失败');
                    return self.buildPreparedFile(file, blob, blob.type || targetMimeType);
                });
            });
        },

        prepareImageFile(file, options) {
            if (!this.isHeicLikeFile(file)) {
                return Promise.resolve({
                    file: file,
                    targetMimeType: this.normalizeMimeType(file && file.type),
                    changed: false
                });
            }
            const self = this;
            const normalizedOptions = {
                targetMimeType: this.normalizeMimeType(options && options.targetMimeType) === 'image/jpeg' ? 'image/jpeg' : 'image/webp',
                quality: this.normalizeQuality(options && options.quality)
            };
            return this.convertWithLibrary(file, normalizedOptions).then(function(result) {
                return {
                    file: result && result.file ? result.file : file,
                    targetMimeType: result && result.targetMimeType ? result.targetMimeType : normalizedOptions.targetMimeType,
                    changed: !!(result && result.changed)
                };
            }).catch(function() {
                throw new Error('当前浏览器暂不支持 HEIC 图片发送');
            });
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.heicManage = heicManageModule;
})(window);
