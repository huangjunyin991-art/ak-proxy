(function(global) {
    'use strict';

    const imageManageModule = {
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

        normalizeSource(value) {
            return String(value || '').trim().toLowerCase() === 'camera' ? 'camera' : 'album';
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
            return '<a class="ak-im-image-bubble-link" href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" aria-label="查看图片 ' + safeLabel + '">' +
                '<img class="ak-im-image-bubble-image" src="' + safeUrl + '" alt="' + safeLabel + '" loading="lazy">' +
            '</a>';
        },

        getMessageBubbleClassName(item) {
            return this.resolveImagePayload(item) ? 'ak-im-bubble-image' : '';
        },

        sendImageFile(file, meta) {
            const state = this.getState();
            if (!state || !state.allowed || !state.activeConversationId || !file || !file.size || !this.ctx || typeof this.ctx.requestFormData !== 'function') {
                return Promise.resolve(null);
            }
            const targetConversationId = Number(state.activeConversationId || 0);
            if (!targetConversationId) return Promise.resolve(null);
            const source = this.normalizeSource(meta && meta.source);
            const fileName = String(file && file.name || '').trim() || ('image-' + Date.now() + '.jpg');
            const formData = new FormData();
            formData.append('conversation_id', String(targetConversationId));
            formData.append('source', source);
            formData.append('file', file, fileName);
            const self = this;
            return this.ctx.requestFormData(this.ctx.httpRoot + '/messages/image', formData, {
                method: 'POST'
            }).then(function(data) {
                const item = data && data.item ? data.item : null;
                return Promise.resolve(typeof self.ctx.applySentMessageItem === 'function' ? self.ctx.applySentMessageItem(item) : null).then(function() {
                    return item;
                });
            }).catch(function(error) {
                window.alert(error && error.message ? error.message : '图片发送失败');
                return null;
            });
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.imageManage = imageManageModule;
})(window);
