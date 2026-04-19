(function(global) {
    'use strict';

    const VOICE_CANCEL_THRESHOLD_PX = 56;
    const VOICE_MIN_DURATION_MS = 300;
    const VOICE_STATUS_CLEAR_DELAY_MS = 1600;
    const PREFERRED_VOICE_MIME_TYPES = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg'
    ];

    const voiceHoldModule = {
        ctx: null,
        boundHoldBtnEl: null,
        boundListeners: null,
        globalEventsBound: false,
        activePointerId: null,
        pressStartY: 0,
        pressStartedAt: 0,
        pendingStart: false,
        pendingCanceled: false,
        mediaStream: null,
        mediaRecorder: null,
        mediaChunks: [],
        activeMimeType: '',
        statusTimer: 0,

        init(ctx) {
            this.ctx = ctx || null;
            this.bindGlobalEvents();
            this.refreshSupportState(false);
            this.bindHoldButton();
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getElements() {
            return this.ctx && this.ctx.elements ? this.ctx.elements : {};
        },

        escapeHtml(value) {
            if (this.ctx && typeof this.ctx.escapeHtml === 'function') return this.ctx.escapeHtml(value);
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

        normalizeVoiceState(value) {
            const normalized = String(value || '').trim().toLowerCase();
            if (normalized === 'recording' || normalized === 'cancel_ready' || normalized === 'sending') {
                return normalized;
            }
            return 'idle';
        },

        isSupported() {
            return !!(
                global.navigator &&
                global.navigator.mediaDevices &&
                typeof global.navigator.mediaDevices.getUserMedia === 'function' &&
                typeof global.MediaRecorder === 'function'
            );
        },

        pickSupportedMimeType() {
            if (!global.MediaRecorder || typeof global.MediaRecorder.isTypeSupported !== 'function') return '';
            for (let index = 0; index < PREFERRED_VOICE_MIME_TYPES.length; index += 1) {
                if (global.MediaRecorder.isTypeSupported(PREFERRED_VOICE_MIME_TYPES[index])) {
                    return PREFERRED_VOICE_MIME_TYPES[index];
                }
            }
            return '';
        },

        refreshSupportState(shouldSync) {
            const state = this.getState();
            const supported = this.isSupported();
            if (state) state.voiceHoldSupported = supported;
            if (shouldSync !== false) this.syncComposer();
            return supported;
        },

        syncComposer() {
            if (this.ctx && typeof this.ctx.syncComposerState === 'function') {
                this.ctx.syncComposerState();
            }
        },

        clearStatusTimer() {
            if (this.statusTimer) {
                clearTimeout(this.statusTimer);
                this.statusTimer = 0;
            }
        },

        setVoiceUIState(nextState, nextStatusText, options) {
            const state = this.getState();
            if (!state) return;
            state.voiceHoldState = this.normalizeVoiceState(nextState);
            state.voiceHoldStatusText = String(nextStatusText || '').trim();
            if (!(options && options.keepTimer)) this.clearStatusTimer();
            this.syncComposer();
        },

        setTransientStatus(message) {
            const state = this.getState();
            if (!state) return;
            this.clearStatusTimer();
            state.voiceHoldState = 'idle';
            state.voiceHoldStatusText = String(message || '').trim();
            this.syncComposer();
            if (!state.voiceHoldStatusText) return;
            const expectedText = state.voiceHoldStatusText;
            const self = this;
            this.statusTimer = setTimeout(function() {
                const currentState = self.getState();
                if (!currentState) return;
                if (self.normalizeVoiceState(currentState.voiceHoldState) !== 'idle') return;
                if (String(currentState.voiceHoldStatusText || '').trim() !== expectedText) return;
                currentState.voiceHoldStatusText = '';
                self.statusTimer = 0;
                self.syncComposer();
            }, VOICE_STATUS_CLEAR_DELAY_MS);
        },

        canStartRecording() {
            const state = this.getState();
            return !!(
                state &&
                state.allowed &&
                state.open &&
                state.view === 'chat' &&
                Number(state.activeConversationId || 0) > 0 &&
                String(state.composerMode || '').trim().toLowerCase() === 'voice' &&
                this.normalizeVoiceState(state.voiceHoldState) === 'idle' &&
                state.voiceHoldSupported !== false &&
                this.ctx &&
                typeof this.ctx.sendVoiceMessage === 'function'
            );
        },

        bindGlobalEvents() {
            if (this.globalEventsBound) return;
            const self = this;
            global.addEventListener('blur', function() {
                self.cancelActiveRecording('已取消语音发送');
            });
            if (global.document && typeof global.document.addEventListener === 'function') {
                global.document.addEventListener('visibilitychange', function() {
                    if (global.document.visibilityState === 'hidden') {
                        self.cancelActiveRecording('已取消语音发送');
                    }
                });
            }
            this.globalEventsBound = true;
        },

        bindHoldButton() {
            const elements = this.getElements();
            const holdBtn = elements.composerHoldBtnEl || null;
            if (this.boundHoldBtnEl === holdBtn) return;
            if (this.boundHoldBtnEl && this.boundListeners) {
                this.boundHoldBtnEl.removeEventListener('pointerdown', this.boundListeners.pointerdown);
                this.boundHoldBtnEl.removeEventListener('pointermove', this.boundListeners.pointermove);
                this.boundHoldBtnEl.removeEventListener('pointerup', this.boundListeners.pointerup);
                this.boundHoldBtnEl.removeEventListener('pointercancel', this.boundListeners.pointercancel);
            }
            this.boundHoldBtnEl = holdBtn;
            this.boundListeners = null;
            if (!holdBtn) return;
            const self = this;
            this.boundListeners = {
                pointerdown: function(event) {
                    self.handlePointerDown(event);
                },
                pointermove: function(event) {
                    self.handlePointerMove(event);
                },
                pointerup: function(event) {
                    self.handlePointerUp(event);
                },
                pointercancel: function(event) {
                    self.handlePointerCancel(event);
                }
            };
            holdBtn.addEventListener('pointerdown', this.boundListeners.pointerdown);
            holdBtn.addEventListener('pointermove', this.boundListeners.pointermove);
            holdBtn.addEventListener('pointerup', this.boundListeners.pointerup);
            holdBtn.addEventListener('pointercancel', this.boundListeners.pointercancel);
        },

        isActivePointer(event) {
            if (this.activePointerId == null) return true;
            return !!event && Number(event.pointerId) === Number(this.activePointerId);
        },

        releasePointerCapture() {
            const holdBtn = this.boundHoldBtnEl;
            if (!holdBtn || this.activePointerId == null || typeof holdBtn.releasePointerCapture !== 'function') return;
            try {
                if (typeof holdBtn.hasPointerCapture !== 'function' || holdBtn.hasPointerCapture(this.activePointerId)) {
                    holdBtn.releasePointerCapture(this.activePointerId);
                }
            } catch (e) {}
        },

        stopStreamTracks() {
            if (!this.mediaStream || !this.mediaStream.getTracks) {
                this.mediaStream = null;
                return;
            }
            this.mediaStream.getTracks().forEach(function(track) {
                try {
                    track.stop();
                } catch (e) {}
            });
            this.mediaStream = null;
        },

        resetActiveSession() {
            this.releasePointerCapture();
            this.stopStreamTracks();
            this.mediaRecorder = null;
            this.mediaChunks = [];
            this.activePointerId = null;
            this.pressStartY = 0;
            this.pressStartedAt = 0;
            this.pendingStart = false;
            this.pendingCanceled = false;
            this.activeMimeType = '';
        },

        stopRecorderAndCollectBlob() {
            const recorder = this.mediaRecorder;
            const mimeType = String((recorder && recorder.mimeType) || this.activeMimeType || '').trim() || 'audio/webm';
            const self = this;
            if (!recorder) return Promise.resolve(null);
            return new Promise(function(resolve) {
                let settled = false;
                const finalize = function(blob) {
                    if (settled) return;
                    settled = true;
                    resolve(blob);
                };
                const handleStop = function() {
                    const blob = self.mediaChunks.length ? new Blob(self.mediaChunks, { type: mimeType }) : null;
                    finalize(blob);
                };
                recorder.addEventListener('stop', handleStop, { once: true });
                recorder.addEventListener('error', function() {
                    finalize(null);
                }, { once: true });
                try {
                    if (recorder.state === 'inactive') {
                        handleStop();
                        return;
                    }
                    recorder.stop();
                } catch (e) {
                    finalize(null);
                }
            });
        },

        resolveRecorderStartError(error) {
            const name = String(error && error.name || '').trim();
            if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝';
            if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '未检测到可用麦克风';
            return '语音录制不可用';
        },

        buildVoiceFileName(mimeType) {
            const normalizedMimeType = String(mimeType || '').toLowerCase();
            if (normalizedMimeType.indexOf('ogg') >= 0) return 'voice-message.ogg';
            return 'voice-message.webm';
        },

        beginRecording(event) {
            const self = this;
            this.pendingStart = true;
            this.pendingCanceled = false;
            this.activePointerId = event && typeof event.pointerId === 'number' ? event.pointerId : null;
            this.pressStartY = Number(event && event.clientY || 0);
            if (this.boundHoldBtnEl && this.activePointerId != null && typeof this.boundHoldBtnEl.setPointerCapture === 'function') {
                try {
                    this.boundHoldBtnEl.setPointerCapture(this.activePointerId);
                } catch (e) {}
            }
            const constraints = {
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            };
            return global.navigator.mediaDevices.getUserMedia(constraints).then(function(stream) {
                if (self.pendingCanceled) {
                    if (stream && stream.getTracks) {
                        stream.getTracks().forEach(function(track) {
                            try {
                                track.stop();
                            } catch (e) {}
                        });
                    }
                    self.resetActiveSession();
                    self.syncComposer();
                    return null;
                }
                const preferredMimeType = self.pickSupportedMimeType();
                const recorderOptions = preferredMimeType ? {
                    mimeType: preferredMimeType,
                    audioBitsPerSecond: 12000
                } : {
                    audioBitsPerSecond: 12000
                };
                const recorder = new global.MediaRecorder(stream, recorderOptions);
                self.mediaStream = stream;
                self.mediaRecorder = recorder;
                self.mediaChunks = [];
                self.activeMimeType = String(preferredMimeType || recorder.mimeType || '').trim();
                self.pressStartedAt = Date.now();
                recorder.addEventListener('dataavailable', function(dataEvent) {
                    if (dataEvent && dataEvent.data && dataEvent.data.size > 0) {
                        self.mediaChunks.push(dataEvent.data);
                    }
                });
                recorder.addEventListener('error', function() {
                    self.cancelActiveRecording('语音录制失败');
                });
                recorder.start();
                self.pendingStart = false;
                self.setVoiceUIState('recording', '松开发送，上滑取消');
                return null;
            }).catch(function(error) {
                self.resetActiveSession();
                self.setTransientStatus(self.resolveRecorderStartError(error));
                return null;
            });
        },

        handlePointerDown(event) {
            this.bindHoldButton();
            if (!event || (event.pointerType === 'mouse' && event.button !== 0)) return;
            this.refreshSupportState(false);
            if (!this.canStartRecording()) return;
            if (this.pendingStart || this.mediaRecorder) return;
            event.preventDefault();
            this.clearStatusTimer();
            this.beginRecording(event);
        },

        handlePointerMove(event) {
            const state = this.getState();
            if (!state || !event || !this.isActivePointer(event)) return;
            if (this.pendingStart || !this.mediaRecorder) return;
            const distanceY = this.pressStartY - Number(event.clientY || 0);
            const nextState = distanceY >= VOICE_CANCEL_THRESHOLD_PX ? 'cancel_ready' : 'recording';
            const currentState = this.normalizeVoiceState(state.voiceHoldState);
            if (currentState === nextState) return;
            if (nextState === 'cancel_ready') {
                this.setVoiceUIState('cancel_ready', '松开手指，取消发送');
                return;
            }
            this.setVoiceUIState('recording', '松开发送，上滑取消');
        },

        finishRecording(shouldCancel) {
            const self = this;
            const startedAt = this.pressStartedAt;
            this.pendingStart = false;
            this.pendingCanceled = false;
            return this.stopRecorderAndCollectBlob().then(function(blob) {
                const durationMs = Math.max(0, Date.now() - startedAt);
                self.resetActiveSession();
                if (shouldCancel) {
                    self.setTransientStatus('已取消语音发送');
                    return null;
                }
                if (!blob || !blob.size) {
                    self.setTransientStatus('语音录制失败');
                    return null;
                }
                if (durationMs < VOICE_MIN_DURATION_MS) {
                    self.setTransientStatus('说话时间太短');
                    return null;
                }
                self.setVoiceUIState('sending', '正在发送语音...');
                if (!self.ctx || typeof self.ctx.sendVoiceMessage !== 'function') {
                    self.setTransientStatus('语音发送模块暂不可用');
                    return null;
                }
                return self.ctx.sendVoiceMessage(blob, {
                    durationMs: durationMs,
                    mimeType: blob.type || self.activeMimeType || '',
                    fileName: self.buildVoiceFileName(blob.type || self.activeMimeType || '')
                }).then(function() {
                    self.setTransientStatus('语音已发送');
                    return null;
                }).catch(function(error) {
                    self.setTransientStatus(error && error.message ? error.message : '语音发送失败');
                    return null;
                });
            });
        },

        handlePointerUp(event) {
            if (!event || !this.isActivePointer(event)) return;
            event.preventDefault();
            if (this.pendingStart && !this.mediaRecorder) {
                this.pendingCanceled = true;
                this.releasePointerCapture();
                return;
            }
            if (!this.mediaRecorder) return;
            const shouldCancel = this.normalizeVoiceState(this.getState() && this.getState().voiceHoldState) === 'cancel_ready';
            this.finishRecording(shouldCancel);
        },

        handlePointerCancel(event) {
            if (event && !this.isActivePointer(event)) return;
            if (this.pendingStart && !this.mediaRecorder) {
                this.pendingCanceled = true;
                this.resetActiveSession();
                this.setTransientStatus('已取消语音发送');
                return;
            }
            if (!this.mediaRecorder) return;
            this.finishRecording(true);
        },

        cancelActiveRecording(message) {
            if (this.pendingStart && !this.mediaRecorder) {
                this.pendingCanceled = true;
                this.resetActiveSession();
                if (message) this.setTransientStatus(message);
                return;
            }
            if (!this.mediaRecorder) return;
            this.finishRecording(true).then(function() {
                return null;
            });
        },

        parseVoicePayload(rawContent) {
            const text = String(rawContent || '').trim();
            if (!text || text.charAt(0) !== '{') return null;
            try {
                const parsed = JSON.parse(text);
                return parsed && typeof parsed === 'object' ? parsed : null;
            } catch (e) {
                return null;
            }
        },

        resolveVoiceMessage(item) {
            if (String(item && item.message_type || '').trim().toLowerCase() !== 'voice') return null;
            const payload = this.parseVoicePayload(item && item.content);
            if (!payload) return null;
            const fileUrl = String(payload.file_url || payload.url || '').trim();
            const durationMs = Math.max(0, Number(payload.duration_ms || 0) || 0);
            const fileSize = Math.max(0, Number(payload.file_size || 0) || 0);
            if (!fileUrl || !durationMs) return null;
            return {
                fileUrl: fileUrl,
                durationMs: durationMs,
                fileSize: fileSize,
                mimeType: String(payload.mime_type || '').trim()
            };
        },

        formatDurationLabel(durationMs) {
            const seconds = Math.max(1, Math.round(Number(durationMs || 0) / 1000));
            return seconds + '″';
        },

        getMessageBubbleClassName(item) {
            return this.resolveVoiceMessage(item) ? 'ak-im-bubble-voice' : '';
        },

        buildMessageBubbleMarkup(item) {
            const voiceMessage = this.resolveVoiceMessage(item);
            if (!voiceMessage) return '';
            const durationLabel = this.formatDurationLabel(voiceMessage.durationMs);
            return '<div class="ak-im-voice-bubble-head">' +
                '<div class="ak-im-voice-bubble-indicator">' +
                    '<svg class="ak-im-voice-bubble-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.2c.62.5.93 1.1.93 1.8s-.31 1.3-.93 1.8"></path><path d="M9.7 8.3c1.04.82 1.56 1.98 1.56 3.7s-.52 2.88-1.56 3.7"></path><path d="M13 6.7c1.5 1.2 2.25 2.97 2.25 5.3s-.75 4.1-2.25 5.3"></path></svg>' +
                    '<span class="ak-im-voice-duration">' + this.escapeHtml(durationLabel) + '</span>' +
                '</div>' +
            '</div>' +
            '<audio class="ak-im-voice-audio" controls preload="none" src="' + this.escapeAttribute(voiceMessage.fileUrl) + '"></audio>';
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.voiceHoldManage = voiceHoldModule;
})(window);
