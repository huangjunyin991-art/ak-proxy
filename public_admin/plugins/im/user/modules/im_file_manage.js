(function(global) {
    'use strict';

    const FILE_MESSAGE_MAX_BYTES = 200 * 1024 * 1024;

    const fileManageModule = {
        ctx: null,

        init(ctx) {
            this.ctx = ctx || null;
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
            const size = Math.max(0, Number(bytes || 0) || 0);
            if (!size) return '0 B';
            if (size < 1024) return size + ' B';
            if (size < 1024 * 1024) return (size / 1024).toFixed(size >= 10 * 1024 ? 0 : 1) + ' KB';
            if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(size >= 100 * 1024 * 1024 ? 0 : 1) + ' MB';
            return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
        },

        resolveFilePayload(item) {
            if (String(item && item.message_type || '').trim().toLowerCase() !== 'file') return null;
            const rawContent = String(item && item.content || '').trim();
            if (!rawContent) return null;
            try {
                const parsed = JSON.parse(rawContent);
                const fileName = String(parsed && parsed.file_name || '文件').trim() || '文件';
                return {
                    fileName: fileName,
                    fileUrl: String(parsed && parsed.file_url || '').trim(),
                    mimeType: String(parsed && parsed.mime_type || '').trim(),
                    fileSize: Math.max(0, Number(parsed && parsed.file_size || 0) || 0),
                    expiresAt: String(parsed && parsed.expires_at || '').trim(),
                    expired: parsed ? parsed.expired === true : false
                };
            } catch (e) {
                return null;
            }
        },

        buildFileBubbleInnerMarkup(payload, expired) {
            const iconMarkup = '<span class="ak-im-file-bubble-icon" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" fill="none"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M14 2v5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>' +
            '</span>';
            const metaText = expired ? '文件已失效' : this.formatFileSize(payload.fileSize);
            return iconMarkup + '<span class="ak-im-file-bubble-body">' +
                '<span class="ak-im-file-bubble-name">' + this.escapeHtml(payload.fileName) + '</span>' +
                '<span class="ak-im-file-bubble-meta">' + this.escapeHtml(metaText) + '</span>' +
            '</span>';
        },

        buildMessageBubbleMarkup(item) {
            const payload = this.resolveFilePayload(item);
            if (!payload) return '';
            if (payload.expired || !payload.fileUrl) {
                return '<div class="ak-im-file-bubble-expired" role="note" aria-label="文件已失效">' + this.buildFileBubbleInnerMarkup(payload, true) + '</div>';
            }
            const safeUrl = this.escapeAttribute(payload.fileUrl);
            const safeFileName = this.escapeAttribute(payload.fileName);
            return '<a class="ak-im-file-bubble-link" href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" download="' + safeFileName + '">' + this.buildFileBubbleInnerMarkup(payload, false) + '</a>';
        },

        getMessageBubbleClassName(item) {
            return this.resolveFilePayload(item) ? 'ak-im-bubble-file' : '';
        },

        sendAttachmentFile(file) {
            const state = this.getState();
            if (!state || !state.allowed || !state.activeConversationId || !file || !this.ctx || typeof this.ctx.requestFormData !== 'function') {
                return Promise.resolve(null);
            }
            const targetConversationId = Number(state.activeConversationId || 0);
            if (!targetConversationId) return Promise.resolve(null);
            const fileSize = Math.max(0, Number(file && file.size || 0) || 0);
            if (!fileSize) {
                window.alert('文件不能为空');
                return Promise.resolve(null);
            }
            if (fileSize > FILE_MESSAGE_MAX_BYTES) {
                window.alert('文件不能超过 200MB');
                return Promise.resolve(null);
            }
            const fileName = String(file && file.name || '').trim() || ('attachment-' + Date.now());
            const formData = new FormData();
            formData.append('conversation_id', String(targetConversationId));
            formData.append('file', file, fileName);
            const self = this;
            return this.ctx.requestFormData(this.ctx.httpRoot + '/messages/file', formData, {
                method: 'POST'
            }).then(function(data) {
                const item = data && data.item ? data.item : null;
                return Promise.resolve(typeof self.ctx.applySentMessageItem === 'function' ? self.ctx.applySentMessageItem(item) : null).then(function() {
                    return item;
                });
            }).catch(function(error) {
                window.alert(error && error.message ? error.message : '文件发送失败');
                return null;
            });
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.fileManage = fileManageModule;
})(window);
