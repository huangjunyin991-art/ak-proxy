(function(global) {
    'use strict';

    const VIDEO_MESSAGE_MAX_BYTES = 500 * 1024 * 1024;
    const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg)$/i;

    const videoManageModule = {
        ctx: null,
        playbackBound: false,
        previewBound: false,

        init(ctx) {
            this.ctx = ctx || null;
            this.ensureStyle();
            this.bindPlaybackState();
            this.bindPreviewWarmup();
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
                finalUrl.searchParams.set('inline', '1');
                return finalUrl.toString();
            } catch (e) {
                return rawUrl + (rawUrl.indexOf('?') >= 0 ? '&' : '?') + 'inline=1';
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
                    posterUrl: String(parsed && parsed.poster_url || '').trim(),
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
            return '<span class="ak-im-video-progress-overlay' + (status === 'failed' ? ' is-failed' : '') + '">' +
                '<span class="ak-im-video-progress-ring" aria-hidden="true"></span>' +
                '<span class="ak-im-video-progress-text">' + this.escapeHtml(text) + '</span>' +
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
            const posterAttr = safePoster ? ' poster="' + safePoster + '"' : '';
            const previewAttr = safePoster ? '' : ' data-ak-im-video-preview-warmup="1"';
            const ratioAttr = payload.width && payload.height ? ' style="aspect-ratio:' + Math.max(1, payload.width) + '/' + Math.max(1, payload.height) + '"' : '';
            return '<div class="ak-im-video-bubble' + (isLocal ? ' ak-im-video-bubble-sending' : '') + '">' +
                '<div class="ak-im-video-surface"' + ratioAttr + '>' +
                '<video class="ak-im-video-player" controls playsinline webkit-playsinline preload="auto" src="' + safeUrl + '"' + posterAttr + previewAttr + '></video>' +
                    '<button class="ak-im-video-play-badge" type="button" aria-label="播放或暂停视频">▶</button>' +
                    overlayMarkup +
                '</div>' +
                '<div class="ak-im-video-footer"><span class="ak-im-video-info"><span class="ak-im-video-name">' + safeName + '</span><span class="ak-im-video-detail">' + this.escapeHtml(meta) + '</span></span><a class="ak-im-video-download" href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" download="' + this.escapeAttribute(payload.fileName) + '">下载</a></div>' +
            '</div>';
        },

        getMessageBubbleClassName(item) {
            return this.resolveVideoPayload(item) ? 'ak-im-bubble-video' : '';
        },

        bindPlaybackState() {
            if (this.playbackBound) return;
            this.playbackBound = true;
            const updateState = function(event) {
                const videoEl = event && event.target && event.target.closest ? event.target.closest('.ak-im-video-player') : null;
                if (!videoEl) return;
                const bubbleEl = videoEl.closest ? videoEl.closest('.ak-im-video-bubble') : null;
                if (!bubbleEl) return;
                if (event.type === 'play') {
                    bubbleEl.classList.add('is-playing');
                    return;
                }
                bubbleEl.classList.remove('is-playing');
            };
            document.addEventListener('play', updateState, true);
            document.addEventListener('pause', updateState, true);
            document.addEventListener('ended', updateState, true);
            document.addEventListener('click', function(event) {
                const button = event && event.target && event.target.closest ? event.target.closest('.ak-im-video-play-badge') : null;
                if (!button) return;
                const surface = button.closest ? button.closest('.ak-im-video-surface') : null;
                const videoEl = surface && surface.querySelector ? surface.querySelector('.ak-im-video-player') : null;
                if (!videoEl) return;
                event.preventDefault();
                event.stopPropagation();
                if (videoEl.paused || videoEl.ended) {
                    const playResult = videoEl.play();
                    if (playResult && typeof playResult.catch === 'function') playResult.catch(function() {});
                    return;
                }
                videoEl.pause();
            }, true);
        },

        warmupVideoPreview(videoEl) {
            if (!videoEl || videoEl.dataset.akImVideoPreviewReady) return;
            videoEl.dataset.akImVideoPreviewReady = '1';
            const seekPreviewFrame = function() {
                if (!videoEl || videoEl.dataset.akImVideoPreviewSeeked) return;
                if (!Number.isFinite(Number(videoEl.duration || 0)) || Number(videoEl.duration || 0) <= 0) return;
                videoEl.dataset.akImVideoPreviewSeeked = '1';
                try {
                    videoEl.currentTime = Math.min(0.12, Math.max(0.01, Number(videoEl.duration || 0) / 100));
                } catch (e) {}
            };
            videoEl.addEventListener('loadedmetadata', seekPreviewFrame, { once: true });
            videoEl.addEventListener('loadeddata', function() {
                const bubbleEl = videoEl.closest ? videoEl.closest('.ak-im-video-bubble') : null;
                if (bubbleEl) bubbleEl.classList.add('has-preview-frame');
            }, { once: true });
            try {
                videoEl.load();
            } catch (e) {}
            if (videoEl.readyState >= 1) seekPreviewFrame();
        },

        warmupVisibleVideoPreviews() {
            const root = document.getElementById('ak-im-root') || document;
            const self = this;
            Array.prototype.forEach.call(root.querySelectorAll('.ak-im-video-player[data-ak-im-video-preview-warmup="1"]'), function(videoEl) {
                self.warmupVideoPreview(videoEl);
            });
        },

        bindPreviewWarmup() {
            if (this.previewBound) return;
            this.previewBound = true;
            const self = this;
            const scheduleWarmup = function() {
                setTimeout(function() {
                    self.warmupVisibleVideoPreviews();
                }, 60);
                setTimeout(function() {
                    self.warmupVisibleVideoPreviews();
                }, 360);
            };
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', scheduleWarmup, { once: true });
            } else {
                scheduleWarmup();
            }
            const observer = new MutationObserver(scheduleWarmup);
            const observeRoot = document.getElementById('ak-im-root') || document.body || document.documentElement;
            if (observeRoot) observer.observe(observeRoot, { childList: true, subtree: true });
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
                '#ak-im-root .ak-im-video-surface{position:relative;width:100%;aspect-ratio:9/12;background:linear-gradient(135deg,#111827,#020617);overflow:hidden}',
                '#ak-im-root .ak-im-video-player{display:block;width:100%;height:100%;background:#000;object-fit:cover}',
                '#ak-im-root .ak-im-video-player::-webkit-media-controls-panel{background:linear-gradient(transparent,rgba(0,0,0,.55))}',
                '#ak-im-root .ak-im-video-play-badge{position:absolute;left:50%;top:50%;z-index:2;width:58px;height:58px;transform:translate(-50%,-50%);border-radius:999px;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42);border:2px solid rgba(255,255,255,.82);box-shadow:0 8px 24px rgba(0,0,0,.28);font-size:26px;line-height:1;text-indent:4px;color:#fff;cursor:pointer;appearance:none;-webkit-appearance:none;padding:0}',
                '#ak-im-root .ak-im-video-player:playing+.ak-im-video-play-badge{opacity:0}',
                '#ak-im-root .ak-im-video-bubble.is-playing .ak-im-video-play-badge{opacity:0}',
                '#ak-im-root .ak-im-video-footer{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:flex-end;justify-content:space-between;gap:10px;padding:34px 10px 9px;background:linear-gradient(transparent,rgba(0,0,0,.72));box-sizing:border-box;pointer-events:none}',
                '#ak-im-root .ak-im-video-info{min-width:0;display:flex;flex-direction:column;gap:2px}',
                '#ak-im-root .ak-im-video-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,.45)}',
                '#ak-im-root .ak-im-video-detail{font-size:11px;color:rgba(255,255,255,.78);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.45)}',
                '#ak-im-root .ak-im-video-download{color:#e0f2fe;text-decoration:none;font-size:12px;flex:0 0 auto;pointer-events:auto;text-shadow:0 1px 2px rgba(0,0,0,.45)}',
                '#ak-im-root .ak-im-video-bubble-local{display:flex;align-items:center;gap:12px;min-height:88px;padding:14px;box-sizing:border-box;background:#0f172a}',
                '#ak-im-root .ak-im-video-local-icon{width:42px;height:42px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,.16);font-size:18px;flex:0 0 auto}',
                '#ak-im-root .ak-im-video-meta{display:flex;flex-direction:column;gap:4px;min-width:0}',
                '#ak-im-root .ak-im-video-size{font-size:12px;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
                '#ak-im-root .ak-im-video-progress-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(2,6,23,.72);color:#fff;font-size:12px;font-weight:800;z-index:2}',
                '#ak-im-root .ak-im-video-progress-overlay.is-failed{background:rgba(127,29,29,.86)}',
                '#ak-im-root .ak-im-video-progress-ring{width:26px;height:26px;border-radius:999px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;animation:ak-im-video-spin .8s linear infinite}',
                '#ak-im-root .ak-im-video-progress-overlay.is-failed .ak-im-video-progress-ring{animation:none;border-color:#fecaca;color:#fecaca}',
                '#ak-im-root .ak-im-video-progress-overlay.is-failed .ak-im-video-progress-ring:after{content:"!";display:flex;align-items:center;justify-content:center;height:100%;font-size:14px;font-weight:900}',
                '@keyframes ak-im-video-spin{to{transform:rotate(360deg)}}'
            ].join('');
            document.head.appendChild(style);
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.videoManage = videoManageModule;
})(window);
