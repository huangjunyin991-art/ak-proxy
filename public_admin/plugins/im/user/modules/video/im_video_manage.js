(function(global) {
    'use strict';

    const VIDEO_MESSAGE_MAX_BYTES = 500 * 1024 * 1024;
    const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg)$/i;

    const videoManageModule = {
        ctx: null,
        playbackBound: false,
        videoViewerEl: null,
        videoViewerPlayer: null,
        videoViewerCloseBound: false,

        init(ctx) {
            this.ctx = ctx || null;
            this.ensureStyle();
            this.bindPlaybackState();
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

        formatFileSize(bytes) {
            if (this.ctx && typeof this.ctx.formatFileSize === 'function') {
                return this.ctx.formatFileSize(bytes);
            }
            const size = Math.max(0, Number(bytes || 0) || 0);
            if (!size) return '0 B';
            if (size < 1024) return size + ' B';
            if (size < 1024 * 1024) return (size / 1024).toFixed(size >= 10 * 1024 ? 0 : 1) + ' KB';
            if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(size >= 100 * 1024 * 1024 ? 0 : 1) + ' MB';
            return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
        },

        isVideoFile(file) {
            if (!file) return false;
            const mimeType = String(file.type || '').trim().toLowerCase();
            if (mimeType.indexOf('video/') === 0) return true;
            return VIDEO_EXT_RE.test(String(file.name || '').trim());
        },

        getUploadProgress() {
            return this.ctx && typeof this.ctx.getUploadProgress === 'function' ? this.ctx.getUploadProgress() : null;
        },

        createTempId() {
            const uploadProgress = this.getUploadProgress();
            if (uploadProgress && typeof uploadProgress.createTempId === 'function') {
                return uploadProgress.createTempId('video');
            }
            return 'video-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
        },

        buildVideoPayloadString(file, fileName) {
            return JSON.stringify({
                storage_name: '',
                video_url: '',
                poster_url: '',
                file_name: String(fileName || file && file.name || '视频').trim() || '视频',
                mime_type: String(file && file.type || 'video/mp4').trim() || 'video/mp4',
                file_size: Math.max(0, Number(file && file.size || 0) || 0)
            });
        },

        withInlineVideoAssetUrl(url) {
            const rawUrl = String(url || '').trim();
            if (!rawUrl || rawUrl.indexOf('/im/assets/file/') < 0) return rawUrl;
            try {
                const finalUrl = new URL(rawUrl, window.location.origin);
                const prefix = '/im/assets/file/';
                const prefixIndex = finalUrl.pathname.indexOf(prefix);
                if (prefixIndex >= 0) {
                    const storageName = finalUrl.pathname.slice(prefixIndex + prefix.length);
                    if (storageName) {
                        finalUrl.pathname = '/im/assets/file-video/' + storageName + '.video.mp4';
                    }
                }
                finalUrl.search = '';
                return finalUrl.toString();
            } catch (e) {
                const cleanUrl = rawUrl.split('?')[0];
                const prefix = '/im/assets/file/';
                const prefixIndex = cleanUrl.indexOf(prefix);
                if (prefixIndex < 0) return rawUrl;
                const storageName = cleanUrl.slice(prefixIndex + prefix.length);
                return storageName ? ('/im/assets/file-video/' + storageName + '.video.mp4') : rawUrl;
            }
        },

        withFileVideoPosterUrl(url) {
            const rawUrl = String(url || '').trim();
            if (!rawUrl || rawUrl.indexOf('/im/assets/file/') < 0) return '';
            try {
                const finalUrl = new URL(rawUrl, window.location.origin);
                const prefix = '/im/assets/file/';
                const prefixIndex = finalUrl.pathname.indexOf(prefix);
                if (prefixIndex < 0) return '';
                const storageName = finalUrl.pathname.slice(prefixIndex + prefix.length);
                if (!storageName) return '';
                finalUrl.pathname = '/im/assets/file-video-poster/' + storageName + '.video.poster.jpg';
                finalUrl.search = '';
                return finalUrl.toString();
            } catch (e) {
                const cleanUrl = rawUrl.split('?')[0];
                const prefix = '/im/assets/file/';
                const prefixIndex = cleanUrl.indexOf(prefix);
                if (prefixIndex < 0) return '';
                const storageName = cleanUrl.slice(prefixIndex + prefix.length);
                return storageName ? ('/im/assets/file-video-poster/' + storageName + '.video.poster.jpg') : '';
            }
        },

        createLocalVideoUrl(file) {
            try {
                return URL.createObjectURL(file);
            } catch (e) {
                return '';
            }
        },

        revokeLocalVideoUrl(url) {
            if (!url) return;
            try {
                URL.revokeObjectURL(url);
            } catch (e) {}
        },

        createTempMessage(file, tempId, localVideoUrl) {
            const state = this.getState();
            const fileName = String(file && file.name || '').trim() || ('video-' + Date.now());
            return {
                id: 0,
                conversation_id: Number(state && state.activeConversationId || 0),
                sender_username: String(state && state.username || '').trim().toLowerCase(),
                sender_display_name: String(state && (state.displayName || state.username) || '我').trim() || '我',
                sender_honor_name: String(state && state.honorName || '').trim(),
                sender_avatar_url: String(state && state.profile && state.profile.avatar_url || '').trim(),
                seq_no: 0,
                message_type: 'video',
                content: this.buildVideoPayloadString(file, fileName),
                content_preview: '[视频] ' + fileName,
                status: 'sending',
                sent_at: new Date().toISOString(),
                client_temp_id: tempId,
                __akTempId: tempId,
                __akLocalStatus: 'uploading',
                __akUploadProgress: 0,
                __akUploadError: '',
                __akLocalVideoUrl: String(localVideoUrl || '').trim()
            };
        },

        resolveVideoPayload(item) {
            const messageType = String(item && item.message_type || '').trim().toLowerCase();
            if (messageType !== 'video' && messageType !== 'file') return null;
            const rawContent = String(item && item.content || '').trim();
            if (!rawContent) return null;
            try {
                const parsed = JSON.parse(rawContent);
                const fileName = String(parsed && parsed.file_name || '视频').trim() || '视频';
                const fileUrl = String(parsed && parsed.file_url || '').trim();
                const videoUrl = String(parsed && (parsed.video_url || parsed.file_url) || '').trim();
                const rawMimeType = String(parsed && parsed.mime_type || '').trim();
                const mimeType = rawMimeType || (messageType === 'video' ? 'video/mp4' : '');
                const isFileVideo = messageType === 'file' && (mimeType.toLowerCase().indexOf('video/') === 0 || VIDEO_EXT_RE.test(fileName));
                if (messageType === 'file' && (!isFileVideo || parsed && parsed.expired === true || !fileUrl)) return null;
                return {
                    fileName: fileName,
                    videoUrl: String(item && item.__akLocalVideoUrl || '').trim() || (messageType === 'file' ? this.withInlineVideoAssetUrl(videoUrl) : videoUrl),
                    posterUrl: String(parsed && parsed.poster_url || '').trim() || (messageType === 'file' ? this.withFileVideoPosterUrl(videoUrl) : ''),
                    mimeType: mimeType,
                    fileSize: Math.max(0, Number(parsed && parsed.file_size || 0) || 0),
                    width: Math.max(0, Number(parsed && parsed.width || 0) || 0),
                    height: Math.max(0, Number(parsed && parsed.height || 0) || 0),
                    durationMs: Math.max(0, Number(parsed && parsed.duration_ms || 0) || 0)
                };
            } catch (e) {
                return null;
            }
        },

        buildOverlayMarkup(item) {
            const status = String(item && item.__akLocalStatus || '').trim().toLowerCase();
            if (status !== 'uploading' && status !== 'compressing' && status !== 'failed') return '';
            const progress = Math.max(0, Math.min(100, Math.round(Number(item && item.__akUploadProgress || 0) || 0)));
            const text = status === 'failed'
                ? (String(item && item.__akUploadError || '').trim() || '发送失败')
                : (status === 'compressing' ? '正在压缩 720p' : (progress > 0 ? ('上传中 ' + progress + '%') : '上传中'));
            const progressStyle = status === 'uploading' ? ' style="width:' + progress + '%"' : '';
            return '<span class="ak-im-video-progress-overlay' + (status === 'failed' ? ' is-failed' : '') + (status === 'uploading' ? ' is-uploading' : '') + '">' +
                (status === 'failed' ? '<span class="ak-im-video-progress-ring" aria-hidden="true"></span>' : '') +
                '<span class="ak-im-video-progress-text">' + this.escapeHtml(text) + '</span>' +
                (status === 'uploading' ? '<span class="ak-im-video-progress-bar" aria-hidden="true"><span class="ak-im-video-progress-bar-fill"' + progressStyle + '></span></span>' : '') +
            '</span>';
        },

        buildMessageBubbleMarkup(item) {
            const payload = this.resolveVideoPayload(item);
            if (!payload) return '';
            const overlayMarkup = this.buildOverlayMarkup(item);
            const isLocal = !!String(item && (item.__akTempId || item.client_temp_id) || '').trim() && Number(item && item.id || 0) <= 0;
            const safeName = this.escapeHtml(payload.fileName);
            const meta = this.formatFileSize(payload.fileSize) + (payload.width && payload.height ? (' · ' + payload.width + '×' + payload.height) : '');
            if (!payload.videoUrl) {
                return '<div class="ak-im-video-bubble ak-im-video-bubble-local" role="note" aria-label="视频发送中">' +
                    '<span class="ak-im-video-local-icon" aria-hidden="true">▶</span>' +
                    '<span class="ak-im-video-meta"><span class="ak-im-video-name">' + safeName + '</span><span class="ak-im-video-size">' + this.escapeHtml(meta) + '</span></span>' +
                    overlayMarkup +
                '</div>';
            }
            const safeUrl = this.escapeAttribute(payload.videoUrl);
            const safePoster = this.escapeAttribute(payload.posterUrl);
            const safeTitle = this.escapeAttribute(payload.fileName);
            const posterMarkup = safePoster
                ? '<img class="ak-im-video-poster" src="' + safePoster + '" alt="' + safeTitle + '" loading="lazy">'
                : '<span class="ak-im-video-poster-placeholder" aria-hidden="true">▶</span>';
            const ratioAttr = payload.width && payload.height ? ' style="aspect-ratio:' + Math.max(1, payload.width) + '/' + Math.max(1, payload.height) + '"' : '';
            return '<div class="ak-im-video-bubble' + (isLocal ? ' ak-im-video-bubble-sending' : '') + '">' +
                '<div class="ak-im-video-surface" role="button" tabindex="0" aria-label="播放视频" data-ak-im-video-url="' + safeUrl + '" data-ak-im-video-poster="' + safePoster + '" data-ak-im-video-title="' + safeTitle + '"' + ratioAttr + '>' +
                    posterMarkup +
                    '<button class="ak-im-video-play-badge" type="button" aria-label="播放视频">▶</button>' +
                    overlayMarkup +
                '</div>' +
            '</div>';
        },

        getMessageBubbleClassName(item) {
            return this.resolveVideoPayload(item) ? 'ak-im-bubble-video' : '';
        },

        logVideoDebug(message, details) {
            if (!window || !window.console || typeof window.console.info !== 'function') return;
            window.console.info('[AK IM Video] ' + message, details || {});
        },

        openVideoViewerFromSurface(surface) {
            if (!surface) return;
            const url = String(surface.getAttribute('data-ak-im-video-url') || '').trim();
            this.logVideoDebug('open request from surface', {
                hasSurface: !!surface,
                hasUrl: !!url,
                url: url,
                poster: String(surface.getAttribute('data-ak-im-video-poster') || '').trim(),
                title: String(surface.getAttribute('data-ak-im-video-title') || '').trim()
            });
            if (!url) return;
            this.openVideoViewer(url, String(surface.getAttribute('data-ak-im-video-poster') || '').trim(), String(surface.getAttribute('data-ak-im-video-title') || '').trim());
        },

        ensureVideoViewer() {
            if (this.videoViewerEl && this.videoViewerPlayer) return;
            const viewerEl = document.createElement('div');
            viewerEl.className = 'ak-im-video-viewer';
            viewerEl.innerHTML = '<div class="ak-im-video-viewer-stage" role="dialog" aria-modal="true" aria-label="视频播放器">' +
                '<button class="ak-im-video-viewer-close" type="button" aria-label="关闭视频">×</button>' +
                '<video class="ak-im-video-viewer-player" controls playsinline webkit-playsinline x5-playsinline preload="metadata"></video>' +
                '<span class="ak-im-video-viewer-loading" aria-hidden="true"></span>' +
                '<span class="ak-im-video-viewer-hint">点击视频开始播放</span>' +
                '<span class="ak-im-video-viewer-error">视频加载失败</span>' +
            '</div>';
            document.body.appendChild(viewerEl);
            this.videoViewerEl = viewerEl;
            this.videoViewerPlayer = viewerEl.querySelector('.ak-im-video-viewer-player');
            const self = this;
            const clearLoading = function() {
                self.logVideoDebug('viewer playable event', {
                    readyState: self.videoViewerPlayer && self.videoViewerPlayer.readyState,
                    networkState: self.videoViewerPlayer && self.videoViewerPlayer.networkState,
                    currentSrc: self.videoViewerPlayer && (self.videoViewerPlayer.currentSrc || self.videoViewerPlayer.src || '')
                });
                viewerEl.classList.remove('is-loading');
                viewerEl.classList.remove('is-error');
                viewerEl.classList.remove('needs-user-play');
            };
            this.videoViewerPlayer.addEventListener('loadstart', function() {
                self.logVideoDebug('viewer loadstart', {
                    readyState: self.videoViewerPlayer.readyState,
                    networkState: self.videoViewerPlayer.networkState,
                    currentSrc: self.videoViewerPlayer.currentSrc || self.videoViewerPlayer.src || ''
                });
                viewerEl.classList.add('is-loading');
                viewerEl.classList.remove('is-error');
                viewerEl.classList.remove('needs-user-play');
            });
            this.videoViewerPlayer.addEventListener('waiting', function() {
                self.logVideoDebug('viewer waiting', {
                    readyState: self.videoViewerPlayer.readyState,
                    networkState: self.videoViewerPlayer.networkState,
                    currentSrc: self.videoViewerPlayer.currentSrc || self.videoViewerPlayer.src || ''
                });
                viewerEl.classList.add('is-loading');
                viewerEl.classList.remove('is-error');
                viewerEl.classList.remove('needs-user-play');
            });
            this.videoViewerPlayer.addEventListener('playing', clearLoading);
            this.videoViewerPlayer.addEventListener('canplay', clearLoading);
            this.videoViewerPlayer.addEventListener('loadeddata', clearLoading);
            this.videoViewerPlayer.addEventListener('error', function() {
                self.logVideoDebug('viewer error event', {
                    code: self.videoViewerPlayer.error && self.videoViewerPlayer.error.code,
                    message: self.videoViewerPlayer.error && self.videoViewerPlayer.error.message,
                    readyState: self.videoViewerPlayer.readyState,
                    networkState: self.videoViewerPlayer.networkState,
                    currentSrc: self.videoViewerPlayer.currentSrc || self.videoViewerPlayer.src || ''
                });
                viewerEl.classList.remove('is-loading');
                viewerEl.classList.add('is-error');
            });
            this.videoViewerPlayer.addEventListener('click', function() {
                if (!self.videoViewerEl || !self.videoViewerEl.classList.contains('is-open') || !self.videoViewerPlayer || !self.videoViewerPlayer.paused) return;
                const playResult = self.videoViewerPlayer.play();
                if (playResult && typeof playResult.catch === 'function') {
                    playResult.catch(function() {});
                }
            });
            viewerEl.querySelector('.ak-im-video-viewer-close').addEventListener('click', function(event) {
                event.preventDefault();
                event.stopPropagation();
                self.closeVideoViewer();
            });
            viewerEl.addEventListener('click', function(event) {
                if (event.target === viewerEl) self.closeVideoViewer();
            });
            if (!this.videoViewerCloseBound) {
                this.videoViewerCloseBound = true;
                document.addEventListener('keydown', function(event) {
                    if (event && event.key === 'Escape') self.closeVideoViewer();
                });
            }
        },

        openVideoViewer(url, posterUrl, title) {
            this.ensureVideoViewer();
            const viewerEl = this.videoViewerEl;
            const player = this.videoViewerPlayer;
            if (!viewerEl || !player || !url) return;
            const self = this;
            const token = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
            player.dataset.akImVideoViewerToken = token;
            this.logVideoDebug('open viewer', {
                token: token,
                url: url,
                poster: posterUrl,
                title: title
            });
            viewerEl.classList.add('is-open');
            viewerEl.classList.add('is-loading');
            viewerEl.classList.remove('is-error');
            viewerEl.classList.remove('needs-user-play');
            if (title) {
                player.setAttribute('aria-label', title);
            } else {
                player.removeAttribute('aria-label');
            }
            if (posterUrl) {
                player.setAttribute('poster', posterUrl);
            } else {
                player.removeAttribute('poster');
            }
            try {
                player.pause();
            } catch (e) {}
            player.controls = true;
            player.autoplay = true;
            player.src = url;
            try {
                player.load();
            } catch (e) {}
            const playResult = player.play();
            if (playResult && typeof playResult.catch === 'function') {
                playResult.then(function() {
                    if (player.dataset.akImVideoViewerToken !== token) return;
                    viewerEl.classList.remove('needs-user-play');
                    self.logVideoDebug('viewer play resolved', {
                        token: token,
                        readyState: player.readyState,
                        networkState: player.networkState,
                        currentSrc: player.currentSrc || player.src || ''
                    });
                });
                playResult.catch(function(error) {
                    if (player.dataset.akImVideoViewerToken !== token) return;
                    self.logVideoDebug('viewer play rejected', {
                        token: token,
                        name: error && error.name,
                        message: error && error.message,
                        code: player.error && player.error.code,
                        readyState: player.readyState,
                        networkState: player.networkState,
                        currentSrc: player.currentSrc || player.src || ''
                    });
                    viewerEl.classList.remove('is-loading');
                    const errorName = String(error && error.name || '').trim();
                    if (errorName === 'NotAllowedError') {
                        viewerEl.classList.add('needs-user-play');
                        viewerEl.classList.remove('is-error');
                        return;
                    }
                    viewerEl.classList.remove('needs-user-play');
                    viewerEl.classList.add('is-error');
                });
            }
        },

        closeVideoViewer() {
            const viewerEl = this.videoViewerEl;
            const player = this.videoViewerPlayer;
            if (!viewerEl || !player) return;
            viewerEl.classList.remove('is-open');
            viewerEl.classList.remove('is-loading');
            viewerEl.classList.remove('is-error');
            viewerEl.classList.remove('needs-user-play');
            delete player.dataset.akImVideoViewerToken;
            try {
                player.pause();
            } catch (e) {}
            player.removeAttribute('src');
            player.removeAttribute('poster');
            try {
                player.load();
            } catch (e) {}
        },

        shouldAcceptSurfaceActivate(surfaceEl, debounceMs) {
            if (!surfaceEl) return false;
            const now = Date.now();
            const lastAt = Number(surfaceEl.dataset.akImVideoLastActivateAt || 0);
            if (now - lastAt < debounceMs) {
                this.logVideoDebug('surface activate blocked by debounce', {
                    elapsed: now - lastAt,
                    debounceMs: debounceMs,
                    url: String(surfaceEl.getAttribute('data-ak-im-video-url') || '').trim()
                });
                return false;
            }
            surfaceEl.dataset.akImVideoLastActivateAt = String(now);
            return true;
        },

        bindPlaybackState() {
            if (this.playbackBound) return;
            this.playbackBound = true;
            const self = this;
            const handleButtonActivate = function(event) {
                const button = event && event.target && event.target.closest ? event.target.closest('.ak-im-video-play-badge') : null;
                if (!button) return;
                const surface = button.closest ? button.closest('.ak-im-video-surface') : null;
                if (!surface) return;
                self.logVideoDebug('button activate', {
                    type: event && event.type,
                    url: String(surface.getAttribute('data-ak-im-video-url') || '').trim()
                });
                event.preventDefault();
                event.stopPropagation();
                if (!self.shouldAcceptSurfaceActivate(surface, 450)) return;
                self.openVideoViewerFromSurface(surface);
            };
            const handleSurfaceActivate = function(event) {
                if (event && event.target && event.target.closest && event.target.closest('.ak-im-video-play-badge')) return;
                const surface = event && event.target && event.target.closest ? event.target.closest('.ak-im-video-surface') : null;
                if (!surface) return;
                self.logVideoDebug('surface activate', {
                    type: event && event.type,
                    url: String(surface.getAttribute('data-ak-im-video-url') || '').trim()
                });
                event.preventDefault();
                event.stopPropagation();
                if (!self.shouldAcceptSurfaceActivate(surface, 450)) return;
                self.openVideoViewerFromSurface(surface);
            };
            const handleSurfaceKeyActivate = function(event) {
                if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;
                const surface = event.target && event.target.closest ? event.target.closest('.ak-im-video-surface') : null;
                if (!surface) return;
                self.logVideoDebug('surface key activate', {
                    key: event && event.key,
                    url: String(surface.getAttribute('data-ak-im-video-url') || '').trim()
                });
                event.preventDefault();
                event.stopPropagation();
                if (!self.shouldAcceptSurfaceActivate(surface, 450)) return;
                self.openVideoViewerFromSurface(surface);
            };
            if (window.PointerEvent) {
                document.addEventListener('pointerup', handleButtonActivate, true);
                document.addEventListener('pointerup', handleSurfaceActivate, true);
            } else {
                document.addEventListener('touchend', handleButtonActivate, true);
                document.addEventListener('touchend', handleSurfaceActivate, true);
            }
            document.addEventListener('click', handleButtonActivate, true);
            document.addEventListener('click', handleSurfaceActivate, true);
            document.addEventListener('keydown', handleSurfaceKeyActivate, true);
        },

        sendVideoFile(file) {
            const state = this.getState();
            if (!state || !state.allowed || !state.activeConversationId || !file || !this.ctx || typeof this.ctx.requestFormData !== 'function') {
                return Promise.resolve(null);
            }
            if (!this.isVideoFile(file)) return Promise.resolve(null);
            const fileSize = Math.max(0, Number(file && file.size || 0) || 0);
            if (!fileSize) {
                window.alert('视频不能为空');
                return Promise.resolve(null);
            }
            if (fileSize > VIDEO_MESSAGE_MAX_BYTES) {
                window.alert('视频不能超过 500MB');
                return Promise.resolve(null);
            }
            const targetConversationId = Number(state.activeConversationId || 0);
            const fileName = String(file && file.name || '').trim() || ('video-' + Date.now());
            const tempId = this.createTempId();
            const localVideoUrl = this.createLocalVideoUrl(file);
            const self = this;
            let hasLocalMessage = false;
            if (typeof this.ctx.insertLocalMessage === 'function') {
                hasLocalMessage = this.ctx.insertLocalMessage(this.createTempMessage(file, tempId, localVideoUrl));
            }
            const formData = new FormData();
            formData.append('conversation_id', String(targetConversationId));
            formData.append('client_temp_id', tempId);
            formData.append('file', file, fileName);
            return this.ctx.requestFormData(this.ctx.httpRoot + '/messages/video', formData, {
                method: 'POST',
                onUploadProgress: function(progress) {
                    if (hasLocalMessage && typeof self.ctx.updateLocalMessage === 'function') {
                        const percent = Math.max(0, Math.min(100, Number(progress && progress.percent || 0) || 0));
                        self.ctx.updateLocalMessage(tempId, {
                            __akLocalStatus: percent >= 100 ? 'compressing' : 'uploading',
                            __akUploadProgress: percent,
                            __akUploadError: ''
                        });
                    }
                }
            }).then(function(data) {
                const item = data && data.item ? data.item : null;
                if (hasLocalMessage && item && typeof self.ctx.replaceLocalMessage === 'function' && self.ctx.replaceLocalMessage(tempId, item)) {
                    self.revokeLocalVideoUrl(localVideoUrl);
                    return Promise.resolve(typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null).then(function() {
                        return item;
                    });
                }
                self.revokeLocalVideoUrl(localVideoUrl);
                return Promise.resolve(typeof self.ctx.applySentMessageItem === 'function' ? self.ctx.applySentMessageItem(item) : null).then(function() {
                    return item;
                });
            }).catch(function(error) {
                if (hasLocalMessage && typeof self.ctx.updateLocalMessage === 'function') {
                    self.ctx.updateLocalMessage(tempId, {
                        __akLocalStatus: 'failed',
                        __akUploadProgress: 0,
                        __akUploadError: error && error.message ? error.message : '视频发送失败'
                    });
                } else {
                    window.alert(error && error.message ? error.message : '视频发送失败');
                }
                return Promise.resolve(typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null).then(function() {
                    return null;
                });
            });
        },

        ensureStyle() {
            if (document.getElementById('ak-im-video-manage-style')) return;
            const style = document.createElement('style');
            style.id = 'ak-im-video-manage-style';
            style.textContent = [
                '#ak-im-root .ak-im-bubble-video{padding:0;overflow:hidden;background:transparent;color:#fff;box-shadow:none}',
                '#ak-im-root .ak-im-video-bubble{position:relative;width:min(276px,68vw);border-radius:10px;background:#020617;color:#fff;overflow:hidden;box-shadow:0 6px 18px rgba(15,23,42,.16)}',
                '#ak-im-root .ak-im-video-surface{position:relative;width:100%;aspect-ratio:9/16;background:linear-gradient(135deg,#111827,#020617);overflow:hidden;cursor:pointer}',
                '#ak-im-root .ak-im-video-surface:focus-visible{outline:2px solid rgba(255,255,255,.9);outline-offset:2px}',
                '#ak-im-root .ak-im-video-poster{display:block;width:100%;height:100%;object-fit:cover;background:#000}',
                '#ak-im-root .ak-im-video-poster-placeholder{display:flex;width:100%;height:100%;align-items:center;justify-content:center;background:linear-gradient(135deg,#111827,#020617);color:rgba(255,255,255,.62);font-size:42px;text-indent:6px}',
                '#ak-im-root .ak-im-video-play-badge{position:absolute;left:50%;top:50%;z-index:2;width:58px;height:58px;transform:translate(-50%,-50%);border-radius:999px;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42);border:2px solid rgba(255,255,255,.82);box-shadow:0 8px 24px rgba(0,0,0,.28);font-size:26px;line-height:1;text-indent:4px;color:#fff;cursor:pointer;appearance:none;-webkit-appearance:none;padding:0}',
                '#ak-im-root .ak-im-video-bubble-local{display:flex;align-items:center;gap:12px;min-height:88px;padding:14px;box-sizing:border-box;background:#0f172a}',
                '#ak-im-root .ak-im-video-local-icon{width:42px;height:42px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,.16);font-size:18px;flex:0 0 auto}',
                '#ak-im-root .ak-im-video-meta{display:flex;flex-direction:column;gap:4px;min-width:0}',
                '#ak-im-root .ak-im-video-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:700}',
                '#ak-im-root .ak-im-video-size{font-size:12px;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
                '#ak-im-root .ak-im-video-progress-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(2,6,23,.72);color:#fff;font-size:12px;font-weight:800;z-index:2}',
                '#ak-im-root .ak-im-video-progress-overlay.is-uploading{flex-direction:column;gap:10px}',
                '#ak-im-root .ak-im-video-progress-bar{width:118px;height:5px;border-radius:999px;background:rgba(255,255,255,.24);overflow:hidden}',
                '#ak-im-root .ak-im-video-progress-bar-fill{display:block;height:100%;border-radius:999px;background:#fff}',
                '#ak-im-root .ak-im-video-progress-overlay.is-failed{background:rgba(127,29,29,.86)}',
                '#ak-im-root .ak-im-video-progress-ring{width:26px;height:26px;border-radius:999px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;animation:ak-im-video-spin .8s linear infinite}',
                '#ak-im-root .ak-im-video-progress-overlay.is-failed .ak-im-video-progress-ring{animation:none;border-color:#fecaca;color:#fecaca}',
                '#ak-im-root .ak-im-video-progress-overlay.is-failed .ak-im-video-progress-ring:after{content:"!";display:flex;align-items:center;justify-content:center;height:100%;font-size:14px;font-weight:900}',
                '.ak-im-video-viewer{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(2,6,23,.92);padding:18px;box-sizing:border-box}',
                '.ak-im-video-viewer.is-open{display:flex}',
                '.ak-im-video-viewer-stage{position:relative;display:flex;align-items:center;justify-content:center;width:min(960px,100%);height:min(86vh,760px)}',
                '.ak-im-video-viewer-player{display:block;max-width:100%;max-height:100%;background:#000;border-radius:10px;box-shadow:0 20px 70px rgba(0,0,0,.45)}',
                '.ak-im-video-viewer-close{position:absolute;right:0;top:-46px;width:38px;height:38px;border:0;border-radius:999px;background:rgba(255,255,255,.16);color:#fff;font-size:28px;line-height:38px;cursor:pointer;appearance:none;-webkit-appearance:none;padding:0}',
                '.ak-im-video-viewer-loading{position:absolute;left:50%;top:50%;display:none;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:999px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;animation:ak-im-video-spin .8s linear infinite}',
                '.ak-im-video-viewer.is-loading .ak-im-video-viewer-loading{display:block}',
                '.ak-im-video-viewer-hint{position:absolute;left:50%;bottom:28px;display:none;transform:translateX(-50%);border-radius:999px;background:rgba(15,23,42,.72);color:#fff;font-size:13px;font-weight:800;padding:8px 12px}',
                '.ak-im-video-viewer.needs-user-play .ak-im-video-viewer-hint{display:block}',
                '.ak-im-video-viewer-error{position:absolute;left:50%;top:50%;display:none;transform:translate(-50%,-50%);border-radius:999px;background:rgba(127,29,29,.92);color:#fff;font-size:13px;font-weight:800;padding:10px 14px}',
                '.ak-im-video-viewer.is-error .ak-im-video-viewer-error{display:block}',
                '@media (pointer:coarse){#ak-im-root .ak-im-video-bubble{width:min(276px,72vw)}#ak-im-root .ak-im-video-surface{aspect-ratio:9/16;background:#000}#ak-im-root .ak-im-video-play-badge{display:flex}.ak-im-video-viewer{padding:0}.ak-im-video-viewer-stage{width:100%;height:100%}.ak-im-video-viewer-player{width:100%;max-height:100%;border-radius:0}.ak-im-video-viewer-close{right:12px;top:12px;z-index:2;background:rgba(15,23,42,.56)}}',
                '@keyframes ak-im-video-spin{to{transform:rotate(360deg)}}'
            ].join('');
            document.head.appendChild(style);
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.videoManage = videoManageModule;
})(window);
