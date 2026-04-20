(function(global) {
    'use strict';

    const plusEntryManageModule = {
        ctx: null,
        cameraInputEl: null,
        albumInputEl: null,
        fileInputEl: null,

        init(ctx) {
            this.ctx = ctx || null;
            this.ensureInputs();
        },

        ensureInputs() {
            this.cameraInputEl = this.ensureInput('camera');
            this.albumInputEl = this.ensureInput('album');
            this.fileInputEl = this.ensureInput('file');
        },

        ensureInput(kind) {
            const selector = 'input[data-ak-im-plus-input="' + kind + '"]';
            let inputEl = document.querySelector(selector);
            if (!inputEl) {
                inputEl = document.createElement('input');
                inputEl.type = 'file';
                inputEl.style.display = 'none';
                inputEl.tabIndex = -1;
                inputEl.dataset.akImPlusInput = kind;
                if (kind === 'camera') {
                    inputEl.accept = 'image/*';
                    inputEl.setAttribute('capture', 'environment');
                } else if (kind === 'album') {
                    inputEl.accept = 'image/*';
                }
                (document.body || document.documentElement).appendChild(inputEl);
            }
            if (!inputEl.dataset.akImPlusBound) {
                const self = this;
                inputEl.addEventListener('change', function(event) {
                    if (kind === 'camera' || kind === 'album') {
                        self.handleImageInputChange(kind, event);
                        return;
                    }
                    self.handleFileInputChange(event);
                });
                inputEl.dataset.akImPlusBound = '1';
            }
            return inputEl;
        },

        pickFirstFile(event) {
            const inputEl = event && event.target ? event.target : null;
            const files = inputEl && inputEl.files ? inputEl.files : null;
            const file = files && files.length ? files[0] : null;
            if (inputEl) {
                try {
                    inputEl.value = '';
                } catch (e) {}
            }
            return file || null;
        },

        openInput(inputEl) {
            if (!inputEl) return;
            try {
                inputEl.value = '';
            } catch (e) {}
            try {
                inputEl.click();
            } catch (e) {}
        },

        handleImageInputChange(source, event) {
            const file = this.pickFirstFile(event);
            if (!file) return;
            if (!this.ctx || typeof this.ctx.sendImageFile !== 'function') {
                window.alert('图片发送模块暂不可用');
                return;
            }
            Promise.resolve(this.ctx.sendImageFile(file, { source: source })).catch(function(error) {
                window.alert(error && error.message ? error.message : '图片发送失败');
            });
        },

        handleFileInputChange(event) {
            const file = this.pickFirstFile(event);
            if (!file) return;
            if (!this.ctx || typeof this.ctx.sendAttachmentFile !== 'function') {
                window.alert('文件发送模块暂不可用');
                return;
            }
            Promise.resolve(this.ctx.sendAttachmentFile(file)).catch(function(error) {
                window.alert(error && error.message ? error.message : '文件发送失败');
            });
        },

        handleAction(action) {
            const actionKey = String(action || '').trim().toLowerCase();
            if (actionKey === 'camera') {
                this.openInput(this.cameraInputEl);
                return;
            }
            if (actionKey === 'album') {
                this.openInput(this.albumInputEl);
                return;
            }
            if (actionKey === 'file') {
                this.openInput(this.fileInputEl);
                return;
            }
            window.alert('位置功能暂未开放');
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.plusEntryManage = plusEntryManageModule;
})(window);
