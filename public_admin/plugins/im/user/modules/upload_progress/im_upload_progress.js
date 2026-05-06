(function(global) {
    'use strict';

    const uploadProgressModule = {
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

        createTempId(prefix) {
            return String(prefix || 'upload') + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
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

        buildFilePayloadString(file, fileName) {
            return JSON.stringify({
                file_url: '',
                file_name: String(fileName || file && file.name || '文件').trim() || '文件',
                mime_type: String(file && file.type || '').trim(),
                file_size: Math.max(0, Number(file && file.size || 0) || 0),
                expires_at: ''
            });
        },

        createFileTempMessage(file, tempId) {
            const state = this.getState();
            const fileName = String(file && file.name || '').trim() || ('attachment-' + Date.now());
            return {
                id: 0,
                conversation_id: Number(state && state.activeConversationId || 0),
                sender_username: String(state && state.username || '').trim().toLowerCase(),
                sender_display_name: String(state && (state.displayName || state.username) || '我').trim() || '我',
                sender_honor_name: String(state && state.honorName || '').trim(),
                sender_avatar_kind: String(state && state.profile && state.profile.avatar_kind || '').trim(),
                sender_avatar_style: String(state && state.profile && state.profile.avatar_style || '').trim(),
                sender_avatar_seed: String(state && state.profile && state.profile.avatar_seed || '').trim(),
                sender_avatar_url: String(state && state.profile && state.profile.avatar_url || '').trim(),
                seq_no: 0,
                message_type: 'file',
                content: this.buildFilePayloadString(file, fileName),
                content_preview: '[文件] ' + fileName,
                status: 'sending',
                sent_at: this.ctx.createLocalSentAt(),
                client_temp_id: tempId,
                __akTempId: tempId,
                __akLocalStatus: 'uploading',
                __akUploadProgress: 0,
                __akUploadError: ''
            };
        },

        normalizeProgress(value) {
            return Math.max(0, Math.min(100, Math.round(Number(value || 0) || 0)));
        },

        getLocalStatus(item) {
            return String(item && item.__akLocalStatus || '').trim().toLowerCase();
        },

        buildProgressRingMarkup(item) {
            const status = this.getLocalStatus(item);
            if (status !== 'uploading' && status !== 'failed') return '';
            const progress = status === 'failed' ? 100 : this.normalizeProgress(item && item.__akUploadProgress);
            const radius = 15;
            const circumference = 94.248;
            const dashOffset = (circumference * (1 - (progress / 100))).toFixed(3);
            const label = status === 'failed' ? '!' : (progress > 0 ? String(progress) : '');
            const ariaLabel = status === 'failed' ? '文件发送失败' : ('文件上传中 ' + progress + '%');
            return '<span class="ak-im-upload-progress-ring' + (status === 'failed' ? ' is-failed' : '') + '" role="img" aria-label="' + this.escapeHtml(ariaLabel) + '">' +
                '<svg viewBox="0 0 40 40" aria-hidden="true">' +
                    '<circle class="ak-im-upload-progress-track" cx="20" cy="20" r="' + radius + '"></circle>' +
                    '<circle class="ak-im-upload-progress-value" cx="20" cy="20" r="' + radius + '" style="stroke-dasharray:' + circumference + ';stroke-dashoffset:' + dashOffset + '"></circle>' +
                '</svg>' +
                '<span class="ak-im-upload-progress-label">' + this.escapeHtml(label) + '</span>' +
            '</span>';
        },

        buildFileOverlayMarkup(item) {
            const status = this.getLocalStatus(item);
            if (status !== 'uploading' && status !== 'failed') return '';
            const progress = this.normalizeProgress(item && item.__akUploadProgress);
            const statusText = status === 'failed'
                ? (String(item && item.__akUploadError || '').trim() || '发送失败')
                : (progress > 0 ? ('上传中 ' + progress + '%') : '上传中');
            return '<span class="ak-im-file-upload-progress-overlay' + (status === 'failed' ? ' is-failed' : '') + '">' +
                this.buildProgressRingMarkup(item) +
                '<span class="ak-im-file-upload-progress-text">' + this.escapeHtml(statusText) + '</span>' +
            '</span>';
        },

        ensureStyle() {
            if (document.getElementById('ak-im-upload-progress-style')) return;
            const style = document.createElement('style');
            style.id = 'ak-im-upload-progress-style';
            style.textContent = '#ak-im-root .ak-im-file-bubble-link,#ak-im-root .ak-im-file-bubble-expired,#ak-im-root .ak-im-file-bubble-local{position:relative}#ak-im-root .ak-im-file-bubble-local{display:flex;align-items:center;gap:12px;min-width:min(220px,60vw);padding:12px 14px;box-sizing:border-box;color:inherit;text-decoration:none}#ak-im-root .ak-im-file-upload-progress-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(255,255,255,.72);backdrop-filter:blur(2px);color:#0f172a;font-size:12px;font-weight:700;line-height:1.2;z-index:2}#ak-im-root .ak-im-message-row.ak-self .ak-im-file-upload-progress-overlay{background:rgba(220,252,231,.76)}#ak-im-root .ak-im-file-upload-progress-overlay.is-failed{background:rgba(254,226,226,.86);color:#991b1b}#ak-im-root .ak-im-upload-progress-ring{position:relative;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}#ak-im-root .ak-im-upload-progress-ring svg{width:36px;height:36px;transform:rotate(-90deg)}#ak-im-root .ak-im-upload-progress-track{fill:none;stroke:rgba(15,23,42,.16);stroke-width:4}#ak-im-root .ak-im-upload-progress-value{fill:none;stroke:#22c55e;stroke-width:4;stroke-linecap:round;transition:stroke-dashoffset .18s ease}#ak-im-root .ak-im-upload-progress-ring.is-failed .ak-im-upload-progress-value{stroke:#ef4444}#ak-im-root .ak-im-upload-progress-label{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:currentColor}#ak-im-root .ak-im-file-upload-progress-text{max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
            document.head.appendChild(style);
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.uploadProgress = uploadProgressModule;
})(window);
