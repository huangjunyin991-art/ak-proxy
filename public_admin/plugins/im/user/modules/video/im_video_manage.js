(function(global) {
    'use strict';

    const VIDEO_MESSAGE_MAX_BYTES = 500 * 1024 * 1024;
    const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg)$/i;

    const videoManageModule = {
        ctx: null,

        init(ctx) {
            this.ctx = ctx || null;
            this.ensureStyle();
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

        createTempMessage(file, tempId) {
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
                __akUploadError: ''
            };
        },

        resolveVideoPayload(item) {
            if (String(item && item.message_type || '').trim().toLowerCase() !== 'video') return null;
            const rawContent = String(item && item.content || '').trim();
            if (!rawContent) return null;
            try {
                const parsed = JSON.parse(rawContent);
                const fileName = String(parsed && parsed.file_name || '视频').trim() || '视频';
                return {
                    fileName: fileName,
                    videoUrl: String(parsed && (parsed.video_url || parsed.file_url) || '').trim(),
                    posterUrl: String(parsed && parsed.poster_url || '').trim(),
                    mimeType: String(parsed && parsed.mime_type || 'video/mp4').trim() || 'video/mp4',
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
            if (isLocal || !payload.videoUrl) {
                return '<div class="ak-im-video-bubble ak-im-video-bubble-local" role="note" aria-label="视频发送中">' +
                    '<span class="ak-im-video-local-icon" aria-hidden="true">▶</span>' +
                    '<span class="ak-im-video-meta"><span class="ak-im-video-name">' + safeName + '</span><span class="ak-im-video-size">' + this.escapeHtml(meta) + '</span></span>' +
                    overlayMarkup +
                '</div>';
            }
            const safeUrl = this.escapeAttribute(payload.videoUrl);
            const safePoster = this.escapeAttribute(payload.posterUrl);
            const posterAttr = safePoster ? ' poster="' + safePoster + '"' : '';
            return '<div class="ak-im-video-bubble">' +
                '<video class="ak-im-video-player" controls playsinline preload="metadata" src="' + safeUrl + '"' + posterAttr + '></video>' +
                '<div class="ak-im-video-footer"><span class="ak-im-video-name">' + safeName + '</span><a class="ak-im-video-download" href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" download="' + this.escapeAttribute(payload.fileName) + '">下载</a></div>' +
            '</div>';
        },

        getMessageBubbleClassName(item) {
            return this.resolveVideoPayload(item) ? 'ak-im-bubble-video' : '';
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
            const self = this;
            let hasLocalMessage = false;
            if (typeof this.ctx.insertLocalMessage === 'function') {
                hasLocalMessage = this.ctx.insertLocalMessage(this.createTempMessage(file, tempId));
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
                    return Promise.resolve(typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null).then(function() {
                        return item;
                    });
                }
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
                '#ak-im-root .ak-im-bubble-video{padding:0;overflow:hidden;background:#000;color:#fff}',
                '#ak-im-root .ak-im-video-bubble{position:relative;width:min(280px,66vw);background:#020617;color:#fff;overflow:hidden}',
                '#ak-im-root .ak-im-video-player{display:block;width:100%;max-height:360px;background:#000;object-fit:contain}',
                '#ak-im-root .ak-im-video-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;background:rgba(15,23,42,.92);box-sizing:border-box}',
                '#ak-im-root .ak-im-video-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:700}',
                '#ak-im-root .ak-im-video-download{color:#bfdbfe;text-decoration:none;font-size:12px;flex:0 0 auto}',
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
