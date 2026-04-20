(function(global) {
    'use strict';

    const VOICE_CANCEL_THRESHOLD_PX = 56;
    const VOICE_MIN_DURATION_MS = 300;
    const VOICE_STATUS_CLEAR_DELAY_MS = 1600;
    const VOICE_TIMER_INTERVAL_MS = 200;
    const VOICE_IDLE_METER_HEIGHTS = [10, 12, 14, 16, 18, 20, 22, 24, 24, 22, 20, 18, 16, 14, 12, 10];
    const VOICE_BUBBLE_WIDTH_MIN_PX = 116;
    const VOICE_BUBBLE_WIDTH_MAX_PX = 228;
    const VOICE_BUBBLE_SEEK_MOVE_THRESHOLD_PX = 8;
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
        boundMessageListEl: null,
        boundMessageListListeners: null,
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
        recordTimerId: 0,
        meterFrameId: 0,
        audioContext: null,
        analyserNode: null,
        analyserSource: null,
        analyserData: null,
        playbackAudioEl: null,
        playbackFrameId: 0,
        playbackMessageId: 0,
        playbackSrc: '',
        playbackDurationMs: 0,
        playbackProgress: 0,
        playbackConversationId: 0,
        playbackPendingSeekRatio: null,
        playbackPendingAutoPlay: false,
        playbackClickBlockUntil: 0,
        voiceSeekSession: null,

        init(ctx) {
            this.ctx = ctx || null;
            this.bindGlobalEvents();
            this.refreshSupportState(false);
            this.bindHoldButton();
            this.bindMessageListInteractions();
            this.syncRecordingOverlay();
            this.syncMessageBubblePlaybackState();
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
            this.bindHoldButton();
            this.bindMessageListInteractions();
            this.syncRecordingOverlay();
            this.syncMessageBubblePlaybackState();
        },

        clearStatusTimer() {
            if (this.statusTimer) {
                clearTimeout(this.statusTimer);
                this.statusTimer = 0;
            }
        },

        clearRecordTimer() {
            if (this.recordTimerId) {
                clearInterval(this.recordTimerId);
                this.recordTimerId = 0;
            }
        },

        cancelMeterFrame() {
            if (!this.meterFrameId) return;
            if (typeof global.cancelAnimationFrame === 'function') {
                global.cancelAnimationFrame(this.meterFrameId);
            } else {
                clearTimeout(this.meterFrameId);
            }
            this.meterFrameId = 0;
        },

        teardownAudioAnalyser() {
            this.cancelMeterFrame();
            if (this.analyserSource && typeof this.analyserSource.disconnect === 'function') {
                try {
                    this.analyserSource.disconnect();
                } catch (e) {}
            }
            if (this.analyserNode && typeof this.analyserNode.disconnect === 'function') {
                try {
                    this.analyserNode.disconnect();
                } catch (e) {}
            }
            const audioContext = this.audioContext;
            this.audioContext = null;
            this.analyserNode = null;
            this.analyserSource = null;
            this.analyserData = null;
            if (audioContext && typeof audioContext.close === 'function') {
                try {
                    const closeResult = audioContext.close();
                    if (closeResult && typeof closeResult.catch === 'function') {
                        closeResult.catch(function() {});
                    }
                } catch (e) {}
            }
        },

        resetMeterBars() {
            const barElements = Array.prototype.slice.call((this.getElements().voiceHoldMeterBarEls || []));
            if (!barElements.length) return;
            barElements.forEach(function(barEl, index) {
                const height = VOICE_IDLE_METER_HEIGHTS[index % VOICE_IDLE_METER_HEIGHTS.length];
                barEl.style.height = height + 'px';
                barEl.classList.remove('is-active');
            });
        },

        formatRecordDuration(durationMs) {
            const totalSeconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
        },

        renderRecordDuration(durationMs) {
            const timerEl = this.getElements().voiceHoldTimerEl || null;
            if (!timerEl) return;
            timerEl.textContent = this.formatRecordDuration(durationMs);
        },

        tickRecordDuration() {
            if (!this.pressStartedAt) {
                this.renderRecordDuration(0);
                return;
            }
            this.renderRecordDuration(Date.now() - this.pressStartedAt);
        },

        startRecordDurationTicker() {
            const self = this;
            this.clearRecordTimer();
            this.tickRecordDuration();
            this.recordTimerId = setInterval(function() {
                self.tickRecordDuration();
            }, VOICE_TIMER_INTERVAL_MS);
        },

        setCancelZoneActive(isActive) {
            const elements = this.getElements();
            const cancelZoneEl = elements.voiceHoldCancelZoneEl || null;
            const cancelLabelEl = elements.voiceHoldCancelLabelEl || null;
            const active = !!isActive;
            if (cancelZoneEl) cancelZoneEl.classList.toggle('is-active', active);
            if (cancelLabelEl) cancelLabelEl.textContent = active ? '松开手指，取消发送' : '上滑到此，取消发送';
        },

        syncRecordingOverlay() {
            const elements = this.getElements();
            const overlayEl = elements.voiceHoldOverlayEl || null;
            const state = this.getState();
            const voiceState = this.normalizeVoiceState(state && state.voiceHoldState);
            const overlayVisible = voiceState === 'recording' || voiceState === 'cancel_ready';
            if (overlayEl) overlayEl.setAttribute('aria-hidden', overlayVisible ? 'false' : 'true');
            this.setCancelZoneActive(voiceState === 'cancel_ready');
            if (!overlayVisible) {
                this.renderRecordDuration(0);
                this.resetMeterBars();
            }
        },

        setupAudioAnalyser(stream) {
            const AudioContextConstructor = global.AudioContext || global.webkitAudioContext;
            this.teardownAudioAnalyser();
            this.resetMeterBars();
            if (!AudioContextConstructor || !stream) return;
            try {
                const audioContext = new AudioContextConstructor();
                const analyserNode = audioContext.createAnalyser();
                const analyserSource = audioContext.createMediaStreamSource(stream);
                analyserNode.fftSize = 64;
                analyserNode.smoothingTimeConstant = 0.76;
                analyserNode.minDecibels = -90;
                analyserNode.maxDecibels = -12;
                analyserSource.connect(analyserNode);
                this.audioContext = audioContext;
                this.analyserNode = analyserNode;
                this.analyserSource = analyserSource;
                this.analyserData = new Uint8Array(analyserNode.frequencyBinCount);
                if (audioContext.state === 'suspended' && typeof audioContext.resume === 'function') {
                    const resumeResult = audioContext.resume();
                    if (resumeResult && typeof resumeResult.catch === 'function') {
                        resumeResult.catch(function() {});
                    }
                }
                this.drawMeterFrame();
            } catch (e) {
                this.teardownAudioAnalyser();
                this.resetMeterBars();
            }
        },

        drawMeterFrame() {
            const analyserNode = this.analyserNode;
            const analyserData = this.analyserData;
            const barElements = Array.prototype.slice.call((this.getElements().voiceHoldMeterBarEls || []));
            if (!analyserNode || !analyserData || !barElements.length) {
                if (barElements.length) this.resetMeterBars();
                return;
            }
            analyserNode.getByteFrequencyData(analyserData);
            const bucketSize = Math.max(1, Math.floor(analyserData.length / barElements.length));
            barElements.forEach(function(barEl, index) {
                const start = index * bucketSize;
                const end = index === barElements.length - 1 ? analyserData.length : Math.min(analyserData.length, start + bucketSize);
                let total = 0;
                let count = 0;
                for (let cursor = start; cursor < end; cursor += 1) {
                    total += analyserData[cursor];
                    count += 1;
                }
                const normalized = count ? total / count / 255 : 0;
                const height = 10 + Math.round(Math.pow(normalized, 0.84) * 24);
                barEl.style.height = height + 'px';
                barEl.classList.toggle('is-active', height >= 19);
            });
            const self = this;
            if (typeof global.requestAnimationFrame === 'function') {
                this.meterFrameId = global.requestAnimationFrame(function() {
                    self.drawMeterFrame();
                });
            } else {
                this.meterFrameId = setTimeout(function() {
                    self.drawMeterFrame();
                }, 80);
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
                self.cancelVoiceSeek();
                self.cancelActiveRecording('已取消语音发送');
            });
            if (global.document && typeof global.document.addEventListener === 'function') {
                global.document.addEventListener('pointermove', function(event) {
                    self.handleVoiceSeekPointerMove(event);
                });
                global.document.addEventListener('pointerup', function(event) {
                    self.handleVoiceSeekPointerUp(event);
                });
                global.document.addEventListener('pointercancel', function(event) {
                    self.handleVoiceSeekPointerCancel(event);
                });
                global.document.addEventListener('visibilitychange', function() {
                    if (global.document.visibilityState === 'hidden') {
                        self.cancelVoiceSeek();
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

        bindMessageListInteractions() {
            const messageListEl = this.getElements().messageList || null;
            if (this.boundMessageListEl === messageListEl) return;
            if (this.boundMessageListEl && this.boundMessageListListeners) {
                this.boundMessageListEl.removeEventListener('pointerdown', this.boundMessageListListeners.pointerdown);
                this.boundMessageListEl.removeEventListener('click', this.boundMessageListListeners.click);
            }
            this.boundMessageListEl = messageListEl;
            this.boundMessageListListeners = null;
            if (!messageListEl) return;
            const self = this;
            this.boundMessageListListeners = {
                pointerdown: function(event) {
                    self.handleMessageListPointerDown(event);
                },
                click: function(event) {
                    self.handleMessageListClick(event);
                }
            };
            messageListEl.addEventListener('pointerdown', this.boundMessageListListeners.pointerdown);
            messageListEl.addEventListener('click', this.boundMessageListListeners.click);
        },

        findVoiceBubbleSurface(target) {
            if (!target || typeof target.closest !== 'function') return null;
            const surfaceEl = target.closest('.ak-im-voice-bubble-surface');
            const messageListEl = this.getElements().messageList || null;
            if (!surfaceEl || !messageListEl || !messageListEl.contains(surfaceEl)) return null;
            return surfaceEl;
        },

        readVoiceBubbleData(surfaceEl) {
            if (!surfaceEl) return null;
            const messageId = Math.max(0, Number(surfaceEl.getAttribute('data-im-voice-message-id') || 0) || 0);
            const fileUrl = String(surfaceEl.getAttribute('data-im-voice-src') || '').trim();
            const durationMs = Math.max(0, Number(surfaceEl.getAttribute('data-im-voice-duration-ms') || 0) || 0);
            const conversationId = Math.max(0, Number(surfaceEl.getAttribute('data-im-voice-conversation-id') || 0) || 0);
            if (!messageId || !fileUrl) return null;
            return {
                messageId: messageId,
                fileUrl: fileUrl,
                durationMs: durationMs,
                conversationId: conversationId
            };
        },

        normalizeProgressRatio(value) {
            const numeric = Number(value);
            if (!isFinite(numeric)) return 0;
            if (numeric <= 0) return 0;
            if (numeric >= 1) return 1;
            return numeric;
        },

        resolveVoiceTrackRatio(surfaceEl, clientX) {
            if (!surfaceEl) return 0;
            const trackEl = surfaceEl.querySelector('.ak-im-voice-track') || surfaceEl;
            const rect = trackEl.getBoundingClientRect();
            if (!rect || !(rect.width > 0)) return 0;
            return this.normalizeProgressRatio((Number(clientX || 0) - rect.left) / rect.width);
        },

        isPlaybackActive() {
            return !!(this.playbackAudioEl && !this.playbackAudioEl.paused && !this.playbackAudioEl.ended && this.playbackMessageId);
        },

        isMessagePlaying(messageId) {
            return !!messageId && Number(this.playbackMessageId || 0) === Number(messageId) && this.isPlaybackActive();
        },

        ensurePlaybackAudio() {
            if (this.playbackAudioEl) return this.playbackAudioEl;
            const audio = new Audio();
            audio.preload = 'metadata';
            const self = this;
            audio.addEventListener('loadedmetadata', function() {
                if (self.playbackPendingSeekRatio != null && Number(audio.duration || 0) > 0) {
                    try {
                        audio.currentTime = audio.duration * self.playbackPendingSeekRatio;
                    } catch (e) {}
                    self.playbackProgress = self.playbackPendingSeekRatio;
                    self.playbackPendingSeekRatio = null;
                } else {
                    self.syncPlaybackProgressFromAudio();
                }
                self.syncMessageBubblePlaybackState();
            });
            audio.addEventListener('timeupdate', function() {
                self.syncPlaybackProgressFromAudio();
            });
            audio.addEventListener('play', function() {
                self.startPlaybackFrameLoop();
                self.syncMessageBubblePlaybackState();
            });
            audio.addEventListener('pause', function() {
                self.stopPlaybackFrameLoop();
                self.syncPlaybackProgressFromAudio();
                self.syncMessageBubblePlaybackState();
            });
            audio.addEventListener('ended', function() {
                self.stopPlaybackFrameLoop();
                self.playbackPendingSeekRatio = null;
                self.playbackProgress = 1;
                self.syncMessageBubblePlaybackState();
            });
            audio.addEventListener('error', function() {
                self.stopPlaybackFrameLoop();
                self.playbackPendingSeekRatio = null;
                self.syncMessageBubblePlaybackState();
            });
            this.playbackAudioEl = audio;
            return audio;
        },

        startPlaybackFrameLoop() {
            const self = this;
            this.stopPlaybackFrameLoop();
            const tick = function() {
                self.playbackFrameId = 0;
                self.syncPlaybackProgressFromAudio();
                if (!self.isPlaybackActive()) return;
                if (typeof global.requestAnimationFrame === 'function') {
                    self.playbackFrameId = global.requestAnimationFrame(tick);
                    return;
                }
                self.playbackFrameId = setTimeout(tick, 80);
            };
            if (!this.isPlaybackActive()) return;
            if (typeof global.requestAnimationFrame === 'function') {
                this.playbackFrameId = global.requestAnimationFrame(tick);
                return;
            }
            this.playbackFrameId = setTimeout(tick, 80);
        },

        stopPlaybackFrameLoop() {
            if (!this.playbackFrameId) return;
            if (typeof global.cancelAnimationFrame === 'function') {
                global.cancelAnimationFrame(this.playbackFrameId);
            } else {
                clearTimeout(this.playbackFrameId);
            }
            this.playbackFrameId = 0;
        },

        syncPlaybackProgressFromAudio() {
            const audio = this.playbackAudioEl;
            if (!audio || !this.playbackMessageId) return;
            const durationSeconds = Number(audio.duration || 0);
            if (durationSeconds > 0) {
                this.playbackDurationMs = Math.max(this.playbackDurationMs, Math.round(durationSeconds * 1000));
                this.playbackProgress = this.normalizeProgressRatio(Number(audio.currentTime || 0) / durationSeconds);
            } else if (this.playbackPendingSeekRatio != null) {
                this.playbackProgress = this.playbackPendingSeekRatio;
            }
            this.syncMessageBubblePlaybackState({ activeOnly: true });
        },

        pausePlayback() {
            const audio = this.playbackAudioEl;
            if (!audio) return;
            try {
                audio.pause();
            } catch (e) {
                this.stopPlaybackFrameLoop();
            }
            this.syncMessageBubblePlaybackState();
        },

        resetPlaybackState(shouldKeepProgress) {
            const audio = this.playbackAudioEl;
            this.stopPlaybackFrameLoop();
            this.playbackPendingSeekRatio = null;
            this.playbackClickBlockUntil = 0;
            this.playbackMessageId = 0;
            this.playbackSrc = '';
            this.playbackDurationMs = 0;
            this.playbackConversationId = 0;
            if (!shouldKeepProgress) this.playbackProgress = 0;
            if (audio) {
                try {
                    audio.pause();
                } catch (e) {}
                try {
                    audio.removeAttribute('data-ak-im-voice-src');
                    audio.src = '';
                } catch (e) {}
            }
            this.syncMessageBubblePlaybackState();
        },

        resumePlayback() {
            const audio = this.ensurePlaybackAudio();
            if (!this.playbackSrc) return;
            if (!audio.src || this.playbackSrc !== String(audio.getAttribute('data-ak-im-voice-src') || '').trim()) {
                audio.src = this.playbackSrc;
                audio.setAttribute('data-ak-im-voice-src', this.playbackSrc);
                audio.load();
            }
            if (this.playbackPendingSeekRatio != null && Number(audio.duration || 0) > 0) {
                try {
                    audio.currentTime = audio.duration * this.playbackPendingSeekRatio;
                } catch (e) {}
                this.playbackPendingSeekRatio = null;
            }
            if (this.playbackProgress >= 0.999) {
                try {
                    audio.currentTime = 0;
                } catch (e) {}
                this.playbackProgress = 0;
            }
            const playResult = audio.play();
            if (playResult && typeof playResult.catch === 'function') {
                playResult.catch(function() {});
            }
        },

        playVoiceBubble(voiceData, options) {
            const normalizedData = voiceData || null;
            const messageId = Math.max(0, Number(normalizedData && normalizedData.messageId || 0) || 0);
            const fileUrl = String(normalizedData && normalizedData.fileUrl || '').trim();
            if (!messageId || !fileUrl) return;
            const audio = this.ensurePlaybackAudio();
            const sameMessage = Number(this.playbackMessageId || 0) === messageId && this.playbackSrc === fileUrl;
            if (!sameMessage) {
                try {
                    audio.pause();
                } catch (e) {}
            }
            this.playbackMessageId = messageId;
            this.playbackSrc = fileUrl;
            this.playbackDurationMs = Math.max(0, Number(normalizedData.durationMs || 0) || 0);
            this.playbackConversationId = Math.max(0, Number(normalizedData.conversationId || 0) || 0);
            if (!sameMessage) {
                this.playbackProgress = 0;
                this.playbackPendingSeekRatio = null;
                audio.src = fileUrl;
                audio.setAttribute('data-ak-im-voice-src', fileUrl);
                audio.load();
            }
            if (options && typeof options.seekRatio === 'number') {
                this.playbackPendingSeekRatio = this.normalizeProgressRatio(options.seekRatio);
                this.playbackProgress = this.playbackPendingSeekRatio;
                if (Number(audio.duration || 0) > 0) {
                    try {
                        audio.currentTime = audio.duration * this.playbackPendingSeekRatio;
                    } catch (e) {}
                    this.playbackPendingSeekRatio = null;
                }
            } else if (!sameMessage) {
                this.playbackProgress = 0;
            }
            this.syncMessageBubblePlaybackState();
            if (options && options.autoPlay === false) return;
            this.resumePlayback();
        },

        handleMessageListPointerDown(event) {
            if (!event || (event.pointerType === 'mouse' && event.button !== 0)) return;
            const surfaceEl = this.findVoiceBubbleSurface(event.target);
            if (!surfaceEl) return;
            const voiceData = this.readVoiceBubbleData(surfaceEl);
            if (!voiceData) return;
            this.voiceSeekSession = {
                pointerId: typeof event.pointerId === 'number' ? event.pointerId : null,
                startX: Number(event.clientX || 0),
                startY: Number(event.clientY || 0),
                moved: false,
                surfaceEl: surfaceEl,
                voiceData: voiceData,
                wasPlaying: this.isMessagePlaying(voiceData.messageId),
                hadAnyPlayback: this.isPlaybackActive()
            };
        },

        handleMessageListClick(event) {
            const surfaceEl = this.findVoiceBubbleSurface(event && event.target);
            if (!surfaceEl) return;
            if (Date.now() < Number(this.playbackClickBlockUntil || 0)) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            const voiceData = this.readVoiceBubbleData(surfaceEl);
            if (!voiceData) return;
            event.preventDefault();
            event.stopPropagation();
            if (Number(this.playbackMessageId || 0) === Number(voiceData.messageId) && this.playbackSrc === voiceData.fileUrl) {
                if (this.isPlaybackActive()) {
                    this.pausePlayback();
                    return;
                }
                this.resumePlayback();
                return;
            }
            this.playVoiceBubble(voiceData);
        },

        handleVoiceSeekPointerMove(event) {
            const session = this.voiceSeekSession;
            if (!session) return;
            if (session.pointerId != null && Number(event && event.pointerId) !== Number(session.pointerId)) return;
            const deltaX = Number(event && event.clientX || 0) - session.startX;
            const deltaY = Number(event && event.clientY || 0) - session.startY;
            if (!session.moved) {
                if (Math.abs(deltaX) < VOICE_BUBBLE_SEEK_MOVE_THRESHOLD_PX && Math.abs(deltaY) < VOICE_BUBBLE_SEEK_MOVE_THRESHOLD_PX) return;
                if (Math.abs(deltaY) > Math.abs(deltaX)) {
                    if (Math.abs(deltaY) >= VOICE_BUBBLE_SEEK_MOVE_THRESHOLD_PX) this.voiceSeekSession = null;
                    return;
                }
                session.moved = true;
                if (session.hadAnyPlayback) this.pausePlayback();
            }
            event.preventDefault();
            this.playbackPendingSeekRatio = this.resolveVoiceTrackRatio(session.surfaceEl, Number(event.clientX || 0));
            this.playbackClickBlockUntil = Date.now() + 260;
            this.syncMessageBubblePlaybackState({
                messageId: session.voiceData.messageId,
                progressRatio: this.playbackPendingSeekRatio,
                dragging: true
            });
        },

        handleVoiceSeekPointerUp(event) {
            const session = this.voiceSeekSession;
            if (!session) return;
            if (session.pointerId != null && Number(event && event.pointerId) !== Number(session.pointerId)) return;
            this.voiceSeekSession = null;
            if (!session.moved) return;
            event.preventDefault();
            const ratio = this.playbackPendingSeekRatio != null ? this.playbackPendingSeekRatio : this.resolveVoiceTrackRatio(session.surfaceEl, Number(event.clientX || 0));
            this.playbackPendingSeekRatio = null;
            this.playbackClickBlockUntil = Date.now() + 320;
            this.playVoiceBubble(session.voiceData, {
                autoPlay: session.wasPlaying || session.hadAnyPlayback || Number(this.playbackMessageId || 0) !== Number(session.voiceData.messageId),
                seekRatio: ratio
            });
        },

        handleVoiceSeekPointerCancel(event) {
            const session = this.voiceSeekSession;
            if (!session) return;
            if (session.pointerId != null && Number(event && event.pointerId) !== Number(session.pointerId)) return;
            this.cancelVoiceSeek();
        },

        cancelVoiceSeek() {
            if (!this.voiceSeekSession) return;
            this.voiceSeekSession = null;
            this.playbackPendingSeekRatio = null;
            this.playbackClickBlockUntil = Date.now() + 220;
            this.syncMessageBubblePlaybackState();
        },

        syncMessageBubblePlaybackState(options) {
            const messageListEl = this.getElements().messageList || null;
            if (!messageListEl) return;
            const state = this.getState();
            if (this.playbackConversationId && Number(state && state.activeConversationId || 0) !== Number(this.playbackConversationId || 0)) {
                this.resetPlaybackState(false);
                return;
            }
            const onlyActive = !!(options && options.activeOnly && this.playbackMessageId);
            const selector = onlyActive ? '.ak-im-voice-bubble-surface[data-im-voice-message-id="' + String(this.playbackMessageId) + '"]' : '.ak-im-voice-bubble-surface';
            const surfaceEls = Array.prototype.slice.call(messageListEl.querySelectorAll(selector));
            const activeMessageId = Math.max(0, Number(options && options.messageId || this.playbackMessageId || 0) || 0);
            const activeProgress = this.normalizeProgressRatio(options && typeof options.progressRatio === 'number' ? options.progressRatio : this.playbackProgress);
            const dragging = !!(options && options.dragging);
            const playing = this.isPlaybackActive();
            if (!onlyActive && activeMessageId && !messageListEl.querySelector('.ak-im-voice-bubble-surface[data-im-voice-message-id="' + String(activeMessageId) + '"]')) {
                this.resetPlaybackState(false);
                return;
            }
            surfaceEls.forEach(function(surfaceEl) {
                const messageId = Math.max(0, Number(surfaceEl.getAttribute('data-im-voice-message-id') || 0) || 0);
                const isActive = !!activeMessageId && messageId === activeMessageId;
                const progress = isActive ? activeProgress : 0;
                surfaceEl.classList.toggle('is-active', isActive && progress > 0);
                surfaceEl.classList.toggle('is-playing', isActive && playing && !dragging);
                surfaceEl.classList.toggle('is-dragging', isActive && dragging);
                surfaceEl.classList.toggle('is-complete', isActive && progress >= 0.999);
                surfaceEl.style.setProperty('--ak-im-voice-progress', String(progress));
            });
            if (onlyActive) return;
            const staleSurfaceEls = Array.prototype.slice.call(messageListEl.querySelectorAll('.ak-im-voice-bubble-surface'));
            staleSurfaceEls.forEach(function(surfaceEl) {
                const messageId = Math.max(0, Number(surfaceEl.getAttribute('data-im-voice-message-id') || 0) || 0);
                if (messageId === activeMessageId) return;
                surfaceEl.classList.remove('is-active', 'is-playing', 'is-dragging', 'is-complete');
                surfaceEl.style.setProperty('--ak-im-voice-progress', '0');
            });
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

        isPointerInsideCancelZone(event) {
            const cancelZoneEl = this.getElements().voiceHoldCancelZoneEl || null;
            if (!cancelZoneEl || !event) return false;
            const rect = cancelZoneEl.getBoundingClientRect();
            if (!rect || !(rect.width > 0) || !(rect.height > 0)) return false;
            const clientX = Number(event.clientX || 0);
            const clientY = Number(event.clientY || 0);
            if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;
            const localX = clientX - rect.left;
            const localY = clientY - rect.top;
            const radiusX = rect.width / 2;
            const radiusY = rect.height;
            const centerX = rect.width / 2;
            const centerY = rect.height;
            if (!(radiusX > 0) || !(radiusY > 0)) return false;
            const normalizedX = (localX - centerX) / radiusX;
            const normalizedY = (localY - centerY) / radiusY;
            return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
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
            this.clearRecordTimer();
            this.teardownAudioAnalyser();
            this.renderRecordDuration(0);
            this.resetMeterBars();
            this.setCancelZoneActive(false);
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
                self.startRecordDurationTicker();
                self.setupAudioAnalyser(stream);
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
            const nextState = this.isPointerInsideCancelZone(event) || distanceY >= VOICE_CANCEL_THRESHOLD_PX ? 'cancel_ready' : 'recording';
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
            const activeMimeType = this.activeMimeType;
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
                    mimeType: blob.type || activeMimeType || '',
                    fileName: self.buildVoiceFileName(blob.type || activeMimeType || '')
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

        getVoiceBubbleWidth(durationMs) {
            const seconds = Math.max(1, Math.round(Number(durationMs || 0) / 1000));
            const ratio = Math.min(60, seconds) / 60;
            return Math.round(VOICE_BUBBLE_WIDTH_MIN_PX + (VOICE_BUBBLE_WIDTH_MAX_PX - VOICE_BUBBLE_WIDTH_MIN_PX) * Math.pow(ratio, 0.82));
        },

        getMessageBubbleClassName(item) {
            return this.resolveVoiceMessage(item) ? 'ak-im-bubble-voice' : '';
        },

        buildMessageBubbleMarkup(item) {
            const voiceMessage = this.resolveVoiceMessage(item);
            if (!voiceMessage) return '';
            const durationLabel = this.formatDurationLabel(voiceMessage.durationMs);
            const bubbleWidth = this.getVoiceBubbleWidth(voiceMessage.durationMs);
            const messageId = Math.max(0, Number(item && item.id || 0) || 0);
            const conversationId = Math.max(0, Number(item && item.conversation_id || 0) || 0);
            return '<div class="ak-im-voice-bubble-surface" style="--ak-im-voice-bubble-width:' + String(bubbleWidth) + 'px;--ak-im-voice-progress:0" data-im-voice-message-id="' + String(messageId) + '" data-im-voice-conversation-id="' + String(conversationId) + '" data-im-voice-duration-ms="' + String(voiceMessage.durationMs) + '" data-im-voice-src="' + this.escapeAttribute(voiceMessage.fileUrl) + '">' +
                '<div class="ak-im-voice-track">' +
                    '<div class="ak-im-voice-track-progress"></div>' +
                    '<div class="ak-im-voice-track-scan"></div>' +
                '</div>' +
                '<div class="ak-im-voice-bubble-indicator">' +
                    '<svg class="ak-im-voice-bubble-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.2c.62.5.93 1.1.93 1.8s-.31 1.3-.93 1.8"></path><path d="M9.7 8.3c1.04.82 1.56 1.98 1.56 3.7s-.52 2.88-1.56 3.7"></path><path d="M13 6.7c1.5 1.2 2.25 2.97 2.25 5.3s-.75 4.1-2.25 5.3"></path></svg>' +
                    '<span class="ak-im-voice-duration">' + this.escapeHtml(durationLabel) + '</span>' +
                '</div>' +
            '</div>';
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.voiceHoldManage = voiceHoldModule;
})(window);
