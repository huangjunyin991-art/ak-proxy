(function(global) {
    'use strict';

    const IMAGE_UPLOAD_CONFIG_CACHE_MS = 60 * 1000;
    const DEFAULT_UPLOAD_CONFIG = {
        enabled: true,
        compress_above_kb: 512,
        max_long_edge_px: 1920,
        output_format: 'jpeg',
        quality: 82,
        target_size_kb: 1024,
        keep_png_with_alpha: true,
        skip_animated_gif: true
    };

    const imageManageModule = {
        ctx: null,

        init(ctx) {
            this.ctx = ctx || null;
            this.uploadConfig = Object.assign({}, DEFAULT_UPLOAD_CONFIG);
            this.uploadConfigLoadedAt = 0;
            this.uploadConfigPromise = null;
            this.previewUrlMap = {};
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
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

        escapeAttribute(value) {
            return this.escapeHtml(value).replace(/`/g, '&#96;');
        },

        normalizeSource(value) {
            return String(value || '').trim().toLowerCase() === 'camera' ? 'camera' : 'album';
        },

        getHeicModule() {
            return this.ctx && this.ctx.heicManage ? this.ctx.heicManage : null;
        },

        normalizeUploadConfig(data) {
            const source = data && typeof data === 'object' ? data : {};
            const outputFormat = String(source.output_format || DEFAULT_UPLOAD_CONFIG.output_format).trim().toLowerCase();
            const rawCompressAboveKB = source.compress_above_kb == null ? DEFAULT_UPLOAD_CONFIG.compress_above_kb : Number(source.compress_above_kb);
            const rawMaxLongEdgePx = source.max_long_edge_px == null ? DEFAULT_UPLOAD_CONFIG.max_long_edge_px : Number(source.max_long_edge_px);
            const rawQuality = source.quality == null ? DEFAULT_UPLOAD_CONFIG.quality : Number(source.quality);
            const rawTargetSizeKB = source.target_size_kb == null ? DEFAULT_UPLOAD_CONFIG.target_size_kb : Number(source.target_size_kb);
            return {
                enabled: source.enabled !== false,
                compress_above_kb: Math.max(0, isNaN(rawCompressAboveKB) ? DEFAULT_UPLOAD_CONFIG.compress_above_kb : Math.round(rawCompressAboveKB)),
                max_long_edge_px: Math.max(320, isNaN(rawMaxLongEdgePx) ? DEFAULT_UPLOAD_CONFIG.max_long_edge_px : Math.round(rawMaxLongEdgePx)),
                output_format: outputFormat === 'keep' || outputFormat === 'webp' ? outputFormat : 'jpeg',
                quality: Math.min(95, Math.max(40, isNaN(rawQuality) ? DEFAULT_UPLOAD_CONFIG.quality : Math.round(rawQuality))),
                target_size_kb: Math.max(64, isNaN(rawTargetSizeKB) ? DEFAULT_UPLOAD_CONFIG.target_size_kb : Math.round(rawTargetSizeKB)),
                keep_png_with_alpha: source.keep_png_with_alpha !== false,
                skip_animated_gif: source.skip_animated_gif !== false
            };
        },

        loadUploadConfig(forceRefresh) {
            const self = this;
            const now = Date.now();
            if (!forceRefresh && this.uploadConfigLoadedAt && (now - this.uploadConfigLoadedAt) < IMAGE_UPLOAD_CONFIG_CACHE_MS) {
                return Promise.resolve(this.uploadConfig);
            }
            if (this.uploadConfigPromise) return this.uploadConfigPromise;
            if (!this.ctx || typeof this.ctx.request !== 'function' || !this.ctx.httpRoot) {
                this.uploadConfig = this.normalizeUploadConfig(this.uploadConfig);
                return Promise.resolve(this.uploadConfig);
            }
            this.uploadConfigPromise = this.ctx.request(this.ctx.httpRoot + '/image_upload/config').then(function(data) {
                self.uploadConfig = self.normalizeUploadConfig(data);
                self.uploadConfigLoadedAt = Date.now();
                return self.uploadConfig;
            }).catch(function() {
                self.uploadConfig = self.normalizeUploadConfig(self.uploadConfig);
                if (!self.uploadConfigLoadedAt) self.uploadConfigLoadedAt = Date.now();
                return self.uploadConfig;
            }).then(function(config) {
                self.uploadConfigPromise = null;
                return config;
            }, function(error) {
                self.uploadConfigPromise = null;
                throw error;
            });
            return this.uploadConfigPromise;
        },

        buildImagePayloadObject(fileUrl, fileName, mimeType, fileSize, source) {
            return {
                file_url: String(fileUrl || '').trim(),
                file_name: String(fileName || '').trim() || '图片',
                mime_type: String(mimeType || '').trim(),
                file_size: Math.max(0, Number(fileSize || 0) || 0),
                source: this.normalizeSource(source)
            };
        },

        buildImagePayloadString(fileUrl, fileName, mimeType, fileSize, source) {
            return JSON.stringify(this.buildImagePayloadObject(fileUrl, fileName, mimeType, fileSize, source));
        },

        getLocalMessageStatus(item) {
            return String(item && item.__akLocalStatus || '').trim().toLowerCase();
        },

        buildLocalOverlayMarkup(item) {
            const localStatus = this.getLocalMessageStatus(item);
            if (!localStatus) return '';
            let statusText = '';
            let progressText = '';
            if (localStatus === 'preparing') {
                statusText = '图片处理中';
            } else if (localStatus === 'uploading') {
                statusText = '正在上传';
                const progress = Math.max(0, Math.min(100, Number(item && item.__akUploadProgress || 0) || 0));
                progressText = progress > 0 ? (progress + '%') : '';
            } else if (localStatus === 'failed') {
                statusText = String(item && item.__akUploadError || '').trim() || '发送失败';
                progressText = '失败';
            }
            if (!statusText && !progressText) return '';
            return '<span class="ak-im-image-bubble-overlay' + (localStatus === 'failed' ? ' is-failed' : '') + '">' +
                '<span class="ak-im-image-bubble-status">' + this.escapeHtml(statusText) + '</span>' +
                '<span class="ak-im-image-bubble-progress">' + this.escapeHtml(progressText) + '</span>' +
            '</span>';
        },

        resolveImagePayload(item) {
            if (String(item && item.message_type || '').trim().toLowerCase() !== 'image') return null;
            const rawContent = String(item && item.content || '').trim();
            if (!rawContent) return null;
            try {
                const parsed = JSON.parse(rawContent);
                const fileUrl = String(parsed && parsed.file_url || '').trim();
                if (!fileUrl) return null;
                const fileName = String(parsed && parsed.file_name || '图片').trim() || '图片';
                const mimeType = String(parsed && parsed.mime_type || '').trim();
                const fileSize = Math.max(0, Number(parsed && parsed.file_size || 0) || 0);
                return {
                    fileUrl: fileUrl,
                    fileName: fileName,
                    mimeType: mimeType,
                    fileSize: fileSize,
                    source: this.normalizeSource(parsed && parsed.source)
                };
            } catch (e) {
                return null;
            }
        },

        buildMessageBubbleMarkup(item) {
            const payload = this.resolveImagePayload(item);
            if (!payload) return '';
            const label = payload.fileName || '图片';
            const safeUrl = this.escapeAttribute(payload.fileUrl);
            const safeLabel = this.escapeAttribute(label);
            const overlayMarkup = this.buildLocalOverlayMarkup(item);
            return '<a class="ak-im-image-bubble-link" href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" aria-label="查看图片 ' + safeLabel + '">' +
                '<span class="ak-im-image-bubble-surface">' +
                    '<img class="ak-im-image-bubble-image" src="' + safeUrl + '" alt="' + safeLabel + '" loading="lazy">' +
                    overlayMarkup +
                '</span>' +
            '</a>';
        },

        getMessageBubbleClassName(item) {
            return this.resolveImagePayload(item) ? 'ak-im-bubble-image' : '';
        },

        createTempId() {
            return 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
        },

        buildPlaceholderPreviewUrl(fileName, mimeType) {
            const normalizedFileName = String(fileName || '').trim() || '图片';
            const normalizedMimeType = this.normalizeMimeType(mimeType);
            const badgeText = normalizedMimeType === 'image/heic' || normalizedMimeType === 'image/heif' ? 'HEIC' : '图片';
            const displayName = normalizedFileName.length > 18 ? (normalizedFileName.slice(0, 15) + '...') : normalizedFileName;
            const markup = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">' +
                '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1f2937"/><stop offset="100%" stop-color="#0f172a"/></linearGradient></defs>' +
                '<rect width="1080" height="1080" rx="96" fill="url(#bg)"/>' +
                '<rect x="96" y="120" width="220" height="84" rx="42" fill="#38bdf8" fill-opacity="0.18" stroke="#38bdf8" stroke-opacity="0.45"/>' +
                '<text x="206" y="174" text-anchor="middle" font-size="42" font-family="Arial, sans-serif" fill="#e0f2fe">' + this.escapeHtml(badgeText) + '</text>' +
                '<text x="540" y="500" text-anchor="middle" font-size="146" font-family="Arial, sans-serif" fill="#f8fafc">🖼</text>' +
                '<text x="540" y="640" text-anchor="middle" font-size="52" font-family="Arial, sans-serif" fill="#e2e8f0">图片处理中</text>' +
                '<text x="540" y="726" text-anchor="middle" font-size="34" font-family="Arial, sans-serif" fill="#94a3b8">' + this.escapeHtml(displayName) + '</text>' +
            '</svg>';
            return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(markup);
        },

        storePreviewUrl(tempId, previewUrl) {
            const key = String(tempId || '').trim();
            if (!key) return;
            const previousUrl = this.previewUrlMap[key];
            if (previousUrl && previousUrl !== previewUrl) {
                try {
                    URL.revokeObjectURL(previousUrl);
                } catch (e) {}
            }
            if (previewUrl) this.previewUrlMap[key] = previewUrl;
            else delete this.previewUrlMap[key];
        },

        releasePreviewUrl(tempId) {
            const key = String(tempId || '').trim();
            if (!key || !this.previewUrlMap[key]) return;
            const previewUrl = this.previewUrlMap[key];
            delete this.previewUrlMap[key];
            setTimeout(function() {
                try {
                    URL.revokeObjectURL(previewUrl);
                } catch (e) {}
            }, 1200);
        },

        createTempMessage(file, previewUrl, source, tempId) {
            const state = this.getState();
            return {
                id: 0,
                conversation_id: Number(state && state.activeConversationId || 0),
                sender_username: String(state && state.username || '').trim().toLowerCase(),
                sender_display_name: String(state && (state.displayName || state.username) || '我').trim() || '我',
                sender_avatar_url: String(state && state.profile && state.profile.avatar_url || '').trim(),
                seq_no: 0,
                message_type: 'image',
                content: this.buildImagePayloadString(previewUrl, file && file.name, file && file.type, file && file.size, source),
                content_preview: '[图片]',
                status: 'sending',
                sent_at: new Date().toISOString(),
                client_temp_id: tempId,
                __akTempId: tempId,
                __akLocalStatus: 'preparing',
                __akUploadProgress: 0,
                __akUploadError: ''
            };
        },

        normalizeMimeType(value) {
            return String(value || '').trim().toLowerCase();
        },

        getFileExtension(value) {
            const normalizedValue = String(value || '').trim();
            const matched = normalizedValue.match(/\.[^.]+$/);
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

        prepareUploadSourceFile(file, config) {
            if (!this.isHeicLikeFile(file)) {
                return Promise.resolve({
                    file: file,
                    previewFile: file,
                    forceOutputMimeType: ''
                });
            }
            const heicModule = this.getHeicModule();
            if (!heicModule || typeof heicModule.prepareImageFile !== 'function') {
                return Promise.reject(new Error('当前环境暂不支持 HEIC 图片发送'));
            }
            return heicModule.prepareImageFile(file, {
                targetMimeType: 'image/webp',
                quality: Math.max(0.4, Math.min(0.95, (Number(config && config.quality || 82) || 82) / 100))
            }).then(function(result) {
                const nextFile = result && result.file ? result.file : file;
                return {
                    file: nextFile,
                    previewFile: nextFile,
                    forceOutputMimeType: 'image/webp'
                };
            });
        },

        getFileExtensionByMimeType(mimeType) {
            const normalizedMimeType = this.normalizeMimeType(mimeType);
            if (normalizedMimeType === 'image/jpeg') return 'jpg';
            if (normalizedMimeType === 'image/png') return 'png';
            if (normalizedMimeType === 'image/webp') return 'webp';
            if (normalizedMimeType === 'image/gif') return 'gif';
            return 'jpg';
        },

        buildUploadFileName(fileName, mimeType) {
            const rawName = String(fileName || '').trim();
            const baseName = rawName ? rawName.replace(/\.[^.]+$/, '') : ('image-' + Date.now());
            return (baseName || ('image-' + Date.now())) + '.' + this.getFileExtensionByMimeType(mimeType);
        },

        createImageBitmapSource(file) {
            const objectUrl = URL.createObjectURL(file);
            return new Promise(function(resolve, reject) {
                const image = new Image();
                image.onload = function() {
                    resolve({
                        image: image,
                        width: Math.max(1, Number(image.naturalWidth || image.width || 0) || 1),
                        height: Math.max(1, Number(image.naturalHeight || image.height || 0) || 1),
                        release: function() {
                            try {
                                URL.revokeObjectURL(objectUrl);
                            } catch (e) {}
                        }
                    });
                };
                image.onerror = function() {
                    try {
                        URL.revokeObjectURL(objectUrl);
                    } catch (e) {}
                    reject(new Error('图片解析失败'));
                };
                image.src = objectUrl;
            });
        },

        calcScaledSize(width, height, maxLongEdgePx) {
            const sourceWidth = Math.max(1, Number(width || 0) || 1);
            const sourceHeight = Math.max(1, Number(height || 0) || 1);
            const longEdge = Math.max(sourceWidth, sourceHeight);
            if (!maxLongEdgePx || longEdge <= maxLongEdgePx) {
                return { width: sourceWidth, height: sourceHeight, scaled: false };
            }
            const scale = maxLongEdgePx / longEdge;
            return {
                width: Math.max(1, Math.round(sourceWidth * scale)),
                height: Math.max(1, Math.round(sourceHeight * scale)),
                scaled: true
            };
        },

        createCanvas(width, height) {
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Number(width || 0) || 1);
            canvas.height = Math.max(1, Number(height || 0) || 1);
            return canvas;
        },

        sampleCanvasHasAlpha(canvas) {
            if (!canvas || !canvas.width || !canvas.height) return false;
            let sampleCanvas = canvas;
            if (Math.max(canvas.width, canvas.height) > 128) {
                const sampleSize = this.calcScaledSize(canvas.width, canvas.height, 128);
                sampleCanvas = this.createCanvas(sampleSize.width, sampleSize.height);
                const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
                if (!sampleContext) return false;
                sampleContext.drawImage(canvas, 0, 0, sampleCanvas.width, sampleCanvas.height);
            }
            const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
            if (!sampleContext) return false;
            const imageData = sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
            for (let index = 3; index < imageData.data.length; index += 4) {
                if (imageData.data[index] < 255) return true;
            }
            return false;
        },

        supportsCanvasMimeType(mimeType) {
            if (mimeType !== 'image/webp') return true;
            try {
                const canvas = this.createCanvas(1, 1);
                return canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
            } catch (e) {
                return false;
            }
        },

        canvasToBlob(canvas, mimeType, quality) {
            return new Promise(function(resolve, reject) {
                try {
                    canvas.toBlob(function(blob) {
                        if (!blob) {
                            reject(new Error('图片编码失败'));
                            return;
                        }
                        resolve(blob);
                    }, mimeType, quality);
                } catch (error) {
                    reject(error);
                }
            });
        },

        buildQualityCandidates(quality) {
            const normalizedQuality = Math.max(0.4, Math.min(0.95, Number(quality || 0.82) || 0.82));
            const candidates = [normalizedQuality, normalizedQuality - 0.08, normalizedQuality - 0.14, normalizedQuality - 0.2, normalizedQuality - 0.28, 0.4];
            const unique = [];
            candidates.forEach(function(value) {
                const roundedValue = Math.max(0.4, Math.min(0.95, Math.round(value * 100) / 100));
                if (unique.indexOf(roundedValue) < 0) unique.push(roundedValue);
            });
            return unique;
        },

        resolveTargetMimeType(file, config, hasAlpha, options) {
            const originalMimeType = this.normalizeMimeType(file && file.type);
            const forcedMimeType = this.normalizeMimeType(options && options.forceOutputMimeType);
            if (forcedMimeType === 'image/png') return 'image/png';
            if (forcedMimeType === 'image/webp' && this.supportsCanvasMimeType('image/webp')) return 'image/webp';
            if (forcedMimeType === 'image/jpeg') return 'image/jpeg';
            if (originalMimeType === 'image/png' && hasAlpha && config.keep_png_with_alpha) return 'image/png';
            if (config.output_format === 'keep') {
                if (originalMimeType === 'image/jpeg' || originalMimeType === 'image/png') return originalMimeType;
                if (originalMimeType === 'image/webp' && this.supportsCanvasMimeType('image/webp')) return 'image/webp';
                if (originalMimeType === 'image/gif') return 'image/gif';
                return 'image/jpeg';
            }
            if (config.output_format === 'webp' && this.supportsCanvasMimeType('image/webp')) return 'image/webp';
            return 'image/jpeg';
        },

        encodeCanvas(canvas, targetMimeType, config) {
            const targetBytes = Math.max(64 * 1024, Number(config && config.target_size_kb || 0) * 1024 || 0);
            if (targetMimeType === 'image/png') {
                return this.canvasToBlob(canvas, targetMimeType).then(function(blob) {
                    return { blob: blob, quality: 1 };
                });
            }
            const self = this;
            const candidates = this.buildQualityCandidates((Number(config && config.quality || 82) || 82) / 100);
            let bestBlob = null;
            let bestQuality = candidates[0];
            return candidates.reduce(function(sequence, quality) {
                return sequence.then(function(found) {
                    if (found) return true;
                    return self.canvasToBlob(canvas, targetMimeType, quality).then(function(blob) {
                        if (!bestBlob || blob.size < bestBlob.size) {
                            bestBlob = blob;
                            bestQuality = quality;
                        }
                        return blob.size <= targetBytes;
                    });
                });
            }, Promise.resolve(false)).then(function() {
                if (!bestBlob) throw new Error('图片编码失败');
                return { blob: bestBlob, quality: bestQuality };
            });
        },

        isAnimatedGif(file) {
            const normalizedMimeType = this.normalizeMimeType(file && file.type);
            if (normalizedMimeType !== 'image/gif' || !file || typeof file.arrayBuffer !== 'function') return Promise.resolve(false);
            return file.arrayBuffer().then(function(buffer) {
                const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
                if (bytes.length < 16) return false;
                let imageDescriptorCount = 0;
                for (let index = 0; index < bytes.length; index += 1) {
                    if (bytes[index] === 0x2c) {
                        imageDescriptorCount += 1;
                        if (imageDescriptorCount > 1) return true;
                    }
                }
                return false;
            }).catch(function() {
                return false;
            });
        },

        maybeCompressImageFile(file, config, options) {
            const normalizedConfig = this.normalizeUploadConfig(config || this.uploadConfig);
            const thresholdBytes = Math.max(0, Number(normalizedConfig.compress_above_kb || 0) || 0) * 1024;
            const originalMimeType = this.normalizeMimeType(file && file.type);
            const shouldCompress = !!normalizedConfig.enabled && file && file.size > 0 && file.size >= thresholdBytes;
            if (!file || !file.size || !shouldCompress) {
                return Promise.resolve({
                    file: file,
                    changed: false,
                    fileName: String(file && file.name || '').trim() || ('image-' + Date.now() + '.jpg')
                });
            }
            const self = this;
            return Promise.resolve().then(function() {
                if (originalMimeType === 'image/gif' && normalizedConfig.skip_animated_gif) {
                    return self.isAnimatedGif(file).then(function(animated) {
                        return animated ? { skip: true } : null;
                    });
                }
                return null;
            }).then(function(skipResult) {
                if (skipResult && skipResult.skip) {
                    return {
                        file: file,
                        changed: false,
                        fileName: String(file && file.name || '').trim() || ('image-' + Date.now() + '.gif')
                    };
                }
                return self.createImageBitmapSource(file).then(function(sourceImage) {
                    const scaledSize = self.calcScaledSize(sourceImage.width, sourceImage.height, normalizedConfig.max_long_edge_px);
                    const canvas = self.createCanvas(scaledSize.width, scaledSize.height);
                    const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
                    if (!context) {
                        sourceImage.release();
                        throw new Error('图片绘制失败');
                    }
                    context.drawImage(sourceImage.image, 0, 0, canvas.width, canvas.height);
                    sourceImage.release();
                    const hasAlpha = originalMimeType === 'image/png' && normalizedConfig.keep_png_with_alpha ? self.sampleCanvasHasAlpha(canvas) : false;
                    const targetMimeType = self.resolveTargetMimeType(file, normalizedConfig, hasAlpha, options);
                    if (targetMimeType === 'image/gif') {
                        return {
                            file: file,
                            changed: false,
                            fileName: String(file && file.name || '').trim() || ('image-' + Date.now() + '.gif')
                        };
                    }
                    return self.encodeCanvas(canvas, targetMimeType, normalizedConfig).then(function(encoded) {
                        const nextFileName = self.buildUploadFileName(file && file.name, targetMimeType);
                        if (!encoded || !encoded.blob) {
                            return { file: file, changed: false, fileName: nextFileName };
                        }
                        if (!scaledSize.scaled && targetMimeType === originalMimeType && encoded.blob.size >= file.size) {
                            return { file: file, changed: false, fileName: String(file && file.name || '').trim() || nextFileName };
                        }
                        const nextFile = new File([encoded.blob], nextFileName, {
                            type: targetMimeType,
                            lastModified: Date.now()
                        });
                        return {
                            file: nextFile,
                            changed: nextFile.size !== file.size || nextFile.type !== file.type || nextFile.name !== file.name,
                            fileName: nextFileName
                        };
                    });
                });
            });
        },

        sendImageFile(file, meta) {
            const state = this.getState();
            if (!state || !state.allowed || !state.activeConversationId || !file || !file.size || !this.ctx || typeof this.ctx.requestFormData !== 'function') {
                return Promise.resolve(null);
            }
            const targetConversationId = Number(state.activeConversationId || 0);
            if (!targetConversationId) return Promise.resolve(null);
            const source = this.normalizeSource(meta && meta.source);
            const self = this;
            const tempId = this.createTempId();
            const initialPreviewUrl = this.isHeicLikeFile(file)
                ? this.buildPlaceholderPreviewUrl(file && file.name, file && file.type)
                : URL.createObjectURL(file);
            this.storePreviewUrl(tempId, initialPreviewUrl);
            if (typeof this.ctx.insertLocalMessage === 'function') {
                this.ctx.insertLocalMessage(this.createTempMessage(file, initialPreviewUrl, source, tempId));
            }
            return this.loadUploadConfig(false).then(function(config) {
                return self.prepareUploadSourceFile(file, config).then(function(prepared) {
                    const sourceFile = prepared && prepared.file ? prepared.file : file;
                    const previewFile = prepared && prepared.previewFile ? prepared.previewFile : sourceFile;
                    const forceOutputMimeType = String(prepared && prepared.forceOutputMimeType || '').trim();
                    const previewUrl = previewFile === file ? initialPreviewUrl : URL.createObjectURL(previewFile);
                    self.storePreviewUrl(tempId, previewUrl);
                    if (typeof self.ctx.updateLocalMessage === 'function') {
                        self.ctx.updateLocalMessage(tempId, {
                            content: self.buildImagePayloadString(previewUrl, previewFile && previewFile.name, previewFile && previewFile.type, previewFile && previewFile.size, source),
                            __akLocalStatus: 'preparing',
                            __akUploadProgress: 0,
                            __akUploadError: ''
                        });
                    }
                    return self.maybeCompressImageFile(sourceFile, config, { forceOutputMimeType: forceOutputMimeType }).then(function(result) {
                    const uploadFile = result && result.file ? result.file : sourceFile;
                    const uploadFileName = String(result && result.fileName || uploadFile && uploadFile.name || '').trim() || ('image-' + Date.now() + '.jpg');
                    if (typeof self.ctx.updateLocalMessage === 'function') {
                        self.ctx.updateLocalMessage(tempId, {
                            content: self.buildImagePayloadString(previewUrl, uploadFileName, uploadFile && uploadFile.type, uploadFile && uploadFile.size, source),
                            __akLocalStatus: 'uploading',
                            __akUploadProgress: 0,
                            __akUploadError: ''
                        });
                    }
                    const formData = new FormData();
                    formData.append('conversation_id', String(targetConversationId));
                    formData.append('source', source);
                    formData.append('client_temp_id', tempId);
                    formData.append('file', uploadFile, uploadFileName);
                    return self.ctx.requestFormData(self.ctx.httpRoot + '/messages/image', formData, {
                        method: 'POST',
                        onUploadProgress: function(progress) {
                            if (typeof self.ctx.updateLocalMessage === 'function') {
                                self.ctx.updateLocalMessage(tempId, {
                                    __akLocalStatus: 'uploading',
                                    __akUploadProgress: Math.max(0, Math.min(100, Number(progress && progress.percent || 0) || 0))
                                });
                            }
                        }
                    }).then(function(data) {
                        const item = data && data.item ? data.item : null;
                        if (item && typeof self.ctx.replaceLocalMessage === 'function' && self.ctx.replaceLocalMessage(tempId, item)) {
                            self.releasePreviewUrl(tempId);
                            return Promise.resolve(typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null).then(function() {
                                return item;
                            });
                        }
                        self.releasePreviewUrl(tempId);
                        return Promise.resolve(typeof self.ctx.applySentMessageItem === 'function' ? self.ctx.applySentMessageItem(item) : null).then(function() {
                            return item;
                        });
                    });
                });
                });
            }).catch(function(error) {
                if (typeof self.ctx.updateLocalMessage === 'function') {
                    self.ctx.updateLocalMessage(tempId, {
                        __akLocalStatus: 'failed',
                        __akUploadProgress: 0,
                        __akUploadError: error && error.message ? error.message : '图片发送失败'
                    });
                }
                window.alert(error && error.message ? error.message : '图片发送失败');
                return null;
            });
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.imageManage = imageManageModule;
})(window);
