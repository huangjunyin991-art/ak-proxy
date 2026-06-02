(function(global) {
    const DEFAULT_SITE = 'ak_web';
    const DEFAULT_HEARTBEAT_INTERVAL = 10000;
    const DEFAULT_LEVEL_INTERVAL = 120;
    const QUALITY_SAMPLE_INTERVAL = 2500;
    const QUALITY_CONNECTIVITY_POLL_INTERVAL = 4000;

    function buildDefaultWsUrl(voiceSessionId, role, site) {
        const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        return `${protocol}${window.location.host}/voice/ws?voice_session_id=${encodeURIComponent(String(voiceSessionId || ''))}&role=${encodeURIComponent(String(role || 'user'))}&site=${encodeURIComponent(String(site || DEFAULT_SITE))}`;
    }

    function clampLevel(value) {
        const num = Number(value || 0);
        if (!Number.isFinite(num)) return 0;
        if (num <= 0) return 0;
        if (num >= 1) return 1;
        return num;
    }

    function stopTrack(track) {
        if (!track || typeof track.stop !== 'function') return;
        try { track.stop(); } catch (e) {}
    }

    function getGlobalQualityModule() {
        if (typeof globalThis !== 'undefined' && globalThis.AKRemoteVoiceQualityModule) {
            return globalThis.AKRemoteVoiceQualityModule;
        }
        if (typeof module !== 'undefined' && module.exports) {
            try {
                return require('./quality_controller');
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    const qualityModule = getGlobalQualityModule();
    const VideoQualityController = qualityModule && qualityModule.VideoQualityController ? qualityModule.VideoQualityController : null;
    const computeQualityScore = qualityModule && qualityModule.computeQualityScore ? qualityModule.computeQualityScore : function() { return 0.75; };
    const getInitialQualityLevel = qualityModule && qualityModule.getInitialQualityLevel ? qualityModule.getInitialQualityLevel : function() {
        return { id: 'high', label: '高清', width: 960, height: 540, maxBitrate: 1400000, maxFramerate: 24 };
    };

    class AKRemoteVoiceClient {
        constructor(options) {
            const config = options || {};
            this.voiceSessionId = String(config.voiceSessionId || '').trim();
            this.role = String(config.role || 'user').trim().toLowerCase() === 'admin' ? 'admin' : 'user';
            this.site = String(config.site || DEFAULT_SITE).trim() || DEFAULT_SITE;
            this.wsUrlBuilder = typeof config.wsUrlBuilder === 'function' ? config.wsUrlBuilder : buildDefaultWsUrl;
            this.onStateChange = typeof config.onStateChange === 'function' ? config.onStateChange : function() {};
            this.onError = typeof config.onError === 'function' ? config.onError : function() {};
            this.remoteAudio = config.remoteAudio || null;
            this.remoteVideo = config.remoteVideo || null;
            this.localStream = config.localStream || null;
            this.lazyMedia = !!config.lazyMedia;
            this.enableVideo = !!config.enableVideo;
            this.preferCamera = config.preferCamera !== false;
            this.localAudioTrack = null;
            this.localVideoTrack = null;
            this.remoteStream = null;
            this.ws = null;
            this.peer = null;
            this.audioContext = null;
            this.localAnalyser = null;
            this.remoteAnalyser = null;
            this.localLevelBuffer = null;
            this.remoteLevelBuffer = null;
            this.levelTimer = null;
            this.heartbeatTimer = null;
            this.connectedRoles = [];
            this.status = 'idle';
            this.phase = 'idle';
            this.mutedSelf = false;
            this.mutedPeer = false;
            this.localLevel = 0;
            this.remoteLevel = 0;
            this.started = false;
            this.destroyed = false;
            this.sentOffer = false;
            this.settingRemoteAnswer = false;
            this.pendingCandidates = [];
            this.localTracksAttached = false;
            this.startPromise = null;
            this.stopPromise = null;
            this.videoEnabled = !!config.enableVideo;
            this.qualityPollTimer = null;
            this.qualityController = null;
            this.qualityState = {
                level: getInitialQualityLevel(),
                score: 0.75,
                degraded: false,
                recovering: false,
                lastStatsAt: 0,
                lastReason: ''
            };
            this.videoSender = null;
            this.lastStatsSample = null;
            this._statsFailureCount = 0;
        }

        getState() {
            return {
                voiceSessionId: this.voiceSessionId,
                role: this.role,
                site: this.site,
                status: this.status,
                phase: this.phase,
                mutedSelf: !!this.mutedSelf,
                mutedPeer: !!this.mutedPeer,
                localLevel: clampLevel(this.localLevel),
                remoteLevel: clampLevel(this.remoteLevel),
                connectedRoles: Array.isArray(this.connectedRoles) ? this.connectedRoles.slice() : [],
                connected: !!(this.peer && this.peer.connectionState === 'connected'),
                videoEnabled: !!this.videoEnabled,
                cameraEnabled: !!(this.localVideoTrack && this.localVideoTrack.enabled),
                qualityLevel: this.qualityState && this.qualityState.level ? this.qualityState.level : getInitialQualityLevel(),
                qualityScore: Number(this.qualityState && this.qualityState.score || 0),
                qualityDegraded: !!(this.qualityState && this.qualityState.degraded),
                qualityRecovering: !!(this.qualityState && this.qualityState.recovering)
            };
        }

        emitState(patch) {
            if (patch && typeof patch === 'object') {
                if (Object.prototype.hasOwnProperty.call(patch, 'status')) this.status = String(patch.status || this.status || '').trim() || this.status;
                if (Object.prototype.hasOwnProperty.call(patch, 'phase')) this.phase = String(patch.phase || this.phase || '').trim() || this.phase;
                if (Object.prototype.hasOwnProperty.call(patch, 'mutedSelf')) this.mutedSelf = !!patch.mutedSelf;
                if (Object.prototype.hasOwnProperty.call(patch, 'mutedPeer')) this.mutedPeer = !!patch.mutedPeer;
                if (Object.prototype.hasOwnProperty.call(patch, 'localLevel')) this.localLevel = clampLevel(patch.localLevel);
                if (Object.prototype.hasOwnProperty.call(patch, 'remoteLevel')) this.remoteLevel = clampLevel(patch.remoteLevel);
                if (Object.prototype.hasOwnProperty.call(patch, 'connectedRoles')) this.connectedRoles = Array.isArray(patch.connectedRoles) ? patch.connectedRoles.slice() : [];
                if (Object.prototype.hasOwnProperty.call(patch, 'videoEnabled')) this.videoEnabled = !!patch.videoEnabled;
                if (Object.prototype.hasOwnProperty.call(patch, 'qualityLevel') && patch.qualityLevel) this.qualityState.level = patch.qualityLevel;
                if (Object.prototype.hasOwnProperty.call(patch, 'qualityScore')) this.qualityState.score = clampLevel(patch.qualityScore);
                if (Object.prototype.hasOwnProperty.call(patch, 'qualityDegraded')) this.qualityState.degraded = !!patch.qualityDegraded;
                if (Object.prototype.hasOwnProperty.call(patch, 'qualityRecovering')) this.qualityState.recovering = !!patch.qualityRecovering;
            }
            try {
                this.onStateChange(this.getState());
            } catch (e) {}
        }

        fail(error) {
            try {
                this.onError(error);
            } catch (e) {}
        }

        async start() {
            if (this.startPromise) return this.startPromise;
            this.startPromise = this._start().finally(() => {
                this.startPromise = null;
            });
            return this.startPromise;
        }

        async _start() {
            if (!this.voiceSessionId) {
                throw new Error('缺少语音会话ID');
            }
            if (!this.remoteAudio) {
                this.remoteAudio = document.createElement('audio');
                this.remoteAudio.autoplay = true;
                this.remoteAudio.playsInline = true;
                this.remoteAudio.style.display = 'none';
                document.body.appendChild(this.remoteAudio);
            }
            if (!this.remoteVideo) {
                this.remoteVideo = document.createElement('video');
                this.remoteVideo.autoplay = true;
                this.remoteVideo.playsInline = true;
                this.remoteVideo.muted = true;
                this.remoteVideo.style.display = 'none';
                document.body.appendChild(this.remoteVideo);
            }
            this.destroyed = false;
            await this.ensureAudioContext();
            await this.connectSocket();
            if (!this.lazyMedia) {
                await this.ensureLocalStream();
            }
            this.started = true;
            this.startHeartbeat();
            this.startLevelMonitor();
            this.startQualityMonitoring();
            this.emitState({ status: this.status === 'idle' ? 'connecting' : this.status, phase: this.phase === 'idle' ? 'waiting_peer' : this.phase });
            return this;
        }

        ensureQualityController() {
            if (this.qualityController) return this.qualityController;
            if (!VideoQualityController) return null;
            this.qualityController = new VideoQualityController({
                initialLevel: this.qualityState && this.qualityState.level ? this.qualityState.level.id : 'high',
                onChange: (qualityState, reason) => {
                    this.qualityState = {
                        level: qualityState.level,
                        score: qualityState.score || 0,
                        degraded: qualityState.level && qualityState.level.id !== 'ultra',
                        recovering: reason && reason.action === 'upgrade',
                        lastStatsAt: Date.now(),
                        lastReason: reason && reason.action ? reason.action : 'hold'
                    };
                    this.emitState({
                        qualityLevel: qualityState.level,
                        qualityScore: qualityState.score || 0,
                        qualityDegraded: !!(qualityState.level && qualityState.level.id !== 'ultra'),
                        qualityRecovering: !!(reason && reason.action === 'upgrade')
                    });
                },
                onDebug: () => {}
            });
            return this.qualityController;
        }

        startQualityMonitoring() {
            this.stopQualityMonitoring();
            if (!this.enableVideo) return;
            this.qualityPollTimer = setInterval(() => {
                this.sampleNetworkQuality().catch(() => {});
            }, QUALITY_SAMPLE_INTERVAL);
        }

        stopQualityMonitoring() {
            if (this.qualityPollTimer) {
                clearInterval(this.qualityPollTimer);
                this.qualityPollTimer = null;
            }
        }

        async sampleNetworkQuality() {
            if (!this.peer || typeof this.peer.getStats !== 'function' || !this.videoEnabled) return null;
            const stats = await this.peer.getStats();
            const metrics = this.extractQualityMetrics(stats);
            const score = computeQualityScore(metrics);
            const controller = this.ensureQualityController();
            this.lastStatsSample = metrics;
            this._statsFailureCount = 0;
            this.qualityState.lastStatsAt = Date.now();
            if (controller) {
                controller.pushSample({
                    score,
                    rtt: metrics.rtt,
                    jitter: metrics.jitter,
                    packetLoss: metrics.packetLoss,
                    bitrateRatio: metrics.bitrateRatio,
                    fpsRatio: metrics.fpsRatio,
                    availableRatio: metrics.availableRatio,
                    localConnected: metrics.localConnected,
                    remoteConnected: metrics.remoteConnected,
                    videoActive: this.videoEnabled
                });
            } else {
                this.qualityState = {
                    level: this.qualityState.level || getInitialQualityLevel(),
                    score,
                    degraded: score < 0.65,
                    recovering: score >= 0.8 && this.qualityState.degraded,
                    lastStatsAt: Date.now(),
                    lastReason: 'fallback'
                };
                this.emitState({
                    qualityScore: score,
                    qualityLevel: this.qualityState.level,
                    qualityDegraded: this.qualityState.degraded,
                    qualityRecovering: this.qualityState.recovering
                });
            }
            await this.applyQualityLevel(controller ? controller.getState().level : this.qualityState.level, metrics).catch(() => {});
            return metrics;
        }

        extractQualityMetrics(statsReport) {
            const values = Array.isArray(statsReport && statsReport.values) ? statsReport.values : [];
            let rtt = 0;
            let jitter = 0;
            let packetLoss = 0;
            let localFramesPerSecond = 0;
            let remoteFramesPerSecond = 0;
            let bitrate = 0;
            let availableBitrate = 0;
            let localConnected = false;
            let remoteConnected = false;
            let videoActive = !!this.videoEnabled;

            values.forEach(report => {
                if (!report) return;
                const type = String(report.type || '').toLowerCase();
                if (type === 'candidate-pair' && (report.state === 'succeeded' || report.nominated)) {
                    rtt = normalizeStat(report.currentRoundTripTime, report.totalRoundTripTime, rtt);
                    availableBitrate = Math.max(availableBitrate, Math.max(0, Number(report.availableOutgoingBitrate || 0)));
                    localConnected = true;
                }
                if (type === 'remote-inbound-rtp' && String(report.kind || '').toLowerCase() === 'video') {
                    packetLoss = Math.max(packetLoss, ratioFromCounts(report.packetsLost, report.packetsReceived));
                    jitter = Math.max(jitter, millisecondsFromSeconds(report.jitter));
                    remoteFramesPerSecond = Math.max(remoteFramesPerSecond, Number(report.framesPerSecond || 0));
                    remoteConnected = true;
                }
                if (type === 'outbound-rtp' && String(report.kind || '').toLowerCase() === 'video') {
                    localFramesPerSecond = Math.max(localFramesPerSecond, Number(report.framesPerSecond || 0));
                    bitrate = Math.max(bitrate, bitrateFromBytes(report.bytesSent, report.timestamp, this.lastStatsSample));
                    videoActive = videoActive || !!report.active;
                    localConnected = true;
                }
                if (type === 'inbound-rtp' && String(report.kind || '').toLowerCase() === 'video') {
                    packetLoss = Math.max(packetLoss, ratioFromCounts(report.packetsLost, report.packetsReceived));
                    jitter = Math.max(jitter, millisecondsFromSeconds(report.jitter));
                    remoteFramesPerSecond = Math.max(remoteFramesPerSecond, Number(report.framesPerSecond || 0));
                    remoteConnected = true;
                }
                if (type === 'track' && String(report.kind || '').toLowerCase() === 'video') {
                    remoteFramesPerSecond = Math.max(remoteFramesPerSecond, Number(report.framesPerSecond || 0));
                }
            });

            const currentLevel = this.qualityState && this.qualityState.level ? this.qualityState.level : getInitialQualityLevel();
            const bitrateRatio = currentLevel.maxBitrate ? Math.min(1, bitrate / currentLevel.maxBitrate) : 1;
            const fpsRatio = currentLevel.maxFramerate ? Math.min(1, Math.max(localFramesPerSecond, remoteFramesPerSecond) / currentLevel.maxFramerate) : 1;
            const availableRatio = currentLevel.maxBitrate && availableBitrate ? Math.min(1, availableBitrate / currentLevel.maxBitrate) : 1;

            return {
                rtt,
                jitter,
                packetLoss,
                bitrateRatio,
                fpsRatio,
                availableRatio,
                bitrate,
                availableBitrate,
                localFramesPerSecond,
                remoteFramesPerSecond,
                localConnected,
                remoteConnected,
                videoActive
            };
        }

        async applyQualityLevel(level, metrics) {
            if (!level || !this.enableVideo) return null;
            const currentLevel = this.qualityState && this.qualityState.level ? this.qualityState.level : getInitialQualityLevel();
            const nextLevel = level && level.id ? level : currentLevel;
            if (!nextLevel || nextLevel.id === currentLevel.id) {
                this.emitState({
                    qualityLevel: currentLevel,
                    qualityScore: this.qualityState && this.qualityState.score || 0,
                    qualityDegraded: !!(this.qualityState && this.qualityState.degraded),
                    qualityRecovering: !!(this.qualityState && this.qualityState.recovering)
                });
                return currentLevel;
            }
            const sender = await this.getVideoSender();
            if (!sender) {
                this.qualityState.level = nextLevel;
                this.emitState({ qualityLevel: nextLevel });
                return nextLevel;
            }
            const params = sender.getParameters ? sender.getParameters() : null;
            if (!params) {
                this.qualityState.level = nextLevel;
                this.emitState({ qualityLevel: nextLevel });
                return nextLevel;
            }
            const encodings = Array.isArray(params.encodings) && params.encodings.length ? params.encodings : [{}];
            encodings[0].maxBitrate = nextLevel.maxBitrate;
            encodings[0].maxFramerate = nextLevel.maxFramerate;
            encodings[0].scaleResolutionDownBy = nextLevel.width >= 1280 ? 1 : nextLevel.width >= 960 ? 1.33 : nextLevel.width >= 640 ? 2 : 4;
            params.encodings = encodings;
            params.degradationPreference = 'balanced';
            if (typeof sender.setParameters === 'function') {
                try {
                    await sender.setParameters(params);
                } catch (error) {
                    this.fail(error);
                }
            }
            this.qualityState.level = nextLevel;
            this.emitState({
                qualityLevel: nextLevel,
                qualityScore: this.qualityState && this.qualityState.score || 0,
                qualityDegraded: !!(metrics && metrics.packetLoss > 0.08),
                qualityRecovering: !!(metrics && metrics.packetLoss < 0.03 && metrics.rtt < 150)
            });
            return nextLevel;
        }

        async getVideoSender() {
            if (!this.peer || typeof this.peer.getSenders !== 'function') return null;
            if (this.videoSender && this.peer.getSenders().includes(this.videoSender)) {
                return this.videoSender;
            }
            this.videoSender = (this.peer.getSenders() || []).find(sender => sender && sender.track && sender.track.kind === 'video') || null;
            return this.videoSender;
        }

        async ensureAudioContext() {
            if (this.audioContext) {
                try {
                    if (this.audioContext.state === 'suspended') {
                        await this.audioContext.resume();
                    }
                } catch (e) {}
                return this.audioContext;
            }
            const AudioCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtor) return null;
            this.audioContext = new AudioCtor();
            try {
                if (this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }
            } catch (e) {}
            return this.audioContext;
        }

        async ensureLocalStream() {
            if (!this.localStream) {
                if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
                    throw new Error('当前浏览器不支持麦克风采集');
                }
                this.emitState({ status: 'connecting', phase: 'request_media' });
                const constraints = {
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    },
                    video: this.videoEnabled ? {
                        facingMode: this.preferCamera ? 'user' : 'environment'
                    } : false
                };
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            }
            this.bindLocalTracks(this.localStream);
            const connection = this.ensurePeer();
            this.attachLocalTracks(connection);
            await this.applyInitialVideoQuality();
            return this.localStream;
        }

        bindLocalTracks(stream) {
            if (!stream) return;
            this.localAudioTrack = (stream.getAudioTracks() || [])[0] || null;
            this.localVideoTrack = (stream.getVideoTracks() || [])[0] || null;
            this.mutedSelf = this.localAudioTrack ? !this.localAudioTrack.enabled : false;
            this.videoEnabled = !!this.localVideoTrack;
            this.attachLocalAnalyser();
        }

        attachLocalTracks(connection) {
            const targetPeer = connection || this.peer;
            if (!targetPeer || !this.localStream) return;
            const senderTrackIds = new Set((targetPeer.getSenders() || []).map(sender => sender && sender.track && sender.track.id).filter(Boolean));
            this.localStream.getTracks().forEach(track => {
                if (!track || senderTrackIds.has(track.id)) return;
                targetPeer.addTrack(track, this.localStream);
            });
            this.localTracksAttached = true;
        }

        ensurePeer() {
            if (this.peer) return this.peer;
            const connection = new RTCPeerConnection({
                iceServers: [
                    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
                ]
            });
            this.peer = connection;
            if (this.localStream) {
                this.attachLocalTracks(connection);
            }
            connection.onicecandidate = event => {
                if (!event || !event.candidate) return;
                this.send('ice_candidate', { candidate: event.candidate });
            };
            connection.ontrack = event => {
                const stream = (event.streams && event.streams[0]) || null;
                if (!stream) return;
                this.remoteStream = stream;
                if (this.remoteAudio) {
                    this.remoteAudio.srcObject = stream;
                    const playPromise = this.remoteAudio.play();
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch(() => {});
                    }
                }
                if (this.remoteVideo) {
                    this.remoteVideo.srcObject = stream;
                    const playPromise = this.remoteVideo.play();
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch(() => {});
                    }
                }
                this.attachRemoteAnalyser();
                this.emitState({ phase: 'receiving_media' });
            };
            connection.onconnectionstatechange = () => {
                const state = String(connection.connectionState || '').trim();
                if (state === 'connected') {
                    this.emitState({ status: 'active', phase: 'active' });
                    this.send('media_connected', {});
                    return;
                }
                if (state === 'connecting') {
                    this.emitState({ status: 'connecting', phase: 'connecting_media' });
                    return;
                }
                if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                    this.stop(false, state);
                }
            };
            return connection;
        }
            this.status = 'idle';
            this.phase = 'idle';
            this.mutedSelf = false;
            this.mutedPeer = false;
            this.localLevel = 0;
            this.remoteLevel = 0;
            this.started = false;
            this.destroyed = false;
            this.sentOffer = false;
            this.settingRemoteAnswer = false;
            this.pendingCandidates = [];
            this.localTracksAttached = false;
            this.startPromise = null;
            this.stopPromise = null;
            this.videoEnabled = !!config.enableVideo;
        }

        getState() {
            return {
                voiceSessionId: this.voiceSessionId,
                role: this.role,
                site: this.site,
                status: this.status,
                phase: this.phase,
                mutedSelf: !!this.mutedSelf,
                mutedPeer: !!this.mutedPeer,
                localLevel: clampLevel(this.localLevel),
                remoteLevel: clampLevel(this.remoteLevel),
                connectedRoles: Array.isArray(this.connectedRoles) ? this.connectedRoles.slice() : [],
                connected: !!(this.peer && this.peer.connectionState === 'connected'),
                videoEnabled: !!this.videoEnabled,
                cameraEnabled: !!(this.localVideoTrack && this.localVideoTrack.enabled)
            };
        }

        emitState(patch) {
            if (patch && typeof patch === 'object') {
                if (Object.prototype.hasOwnProperty.call(patch, 'status')) this.status = String(patch.status || this.status || '').trim() || this.status;
                if (Object.prototype.hasOwnProperty.call(patch, 'phase')) this.phase = String(patch.phase || this.phase || '').trim() || this.phase;
                if (Object.prototype.hasOwnProperty.call(patch, 'mutedSelf')) this.mutedSelf = !!patch.mutedSelf;
                if (Object.prototype.hasOwnProperty.call(patch, 'mutedPeer')) this.mutedPeer = !!patch.mutedPeer;
                if (Object.prototype.hasOwnProperty.call(patch, 'localLevel')) this.localLevel = clampLevel(patch.localLevel);
                if (Object.prototype.hasOwnProperty.call(patch, 'remoteLevel')) this.remoteLevel = clampLevel(patch.remoteLevel);
                if (Object.prototype.hasOwnProperty.call(patch, 'connectedRoles')) this.connectedRoles = Array.isArray(patch.connectedRoles) ? patch.connectedRoles.slice() : [];
                if (Object.prototype.hasOwnProperty.call(patch, 'videoEnabled')) this.videoEnabled = !!patch.videoEnabled;
            }
            try {
                this.onStateChange(this.getState());
            } catch (e) {}
        }

        fail(error) {
            try {
                this.onError(error);
            } catch (e) {}
        }

        async start() {
            if (this.startPromise) return this.startPromise;
            this.startPromise = this._start().finally(() => {
                this.startPromise = null;
            });
            return this.startPromise;
        }

        async _start() {
            if (!this.voiceSessionId) {
                throw new Error('缺少语音会话ID');
            }
            if (!this.remoteAudio) {
                this.remoteAudio = document.createElement('audio');
                this.remoteAudio.autoplay = true;
                this.remoteAudio.playsInline = true;
                this.remoteAudio.style.display = 'none';
                document.body.appendChild(this.remoteAudio);
            }
            if (!this.remoteVideo) {
                this.remoteVideo = document.createElement('video');
                this.remoteVideo.autoplay = true;
                this.remoteVideo.playsInline = true;
                this.remoteVideo.muted = true;
                this.remoteVideo.style.display = 'none';
                document.body.appendChild(this.remoteVideo);
            }
            this.destroyed = false;
            await this.ensureAudioContext();
            await this.connectSocket();
            if (!this.lazyMedia) {
                await this.ensureLocalStream();
            }
            this.started = true;
            this.startHeartbeat();
            this.startLevelMonitor();
            this.emitState({ status: this.status === 'idle' ? 'connecting' : this.status, phase: this.phase === 'idle' ? 'waiting_peer' : this.phase });
            return this;
        }

        async ensureAudioContext() {
            if (this.audioContext) {
                try {
                    if (this.audioContext.state === 'suspended') {
                        await this.audioContext.resume();
                    }
                } catch (e) {}
                return this.audioContext;
            }
            const AudioCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtor) return null;
            this.audioContext = new AudioCtor();
            try {
                if (this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }
            } catch (e) {}
            return this.audioContext;
        }

        async ensureLocalStream() {
            if (!this.localStream) {
                if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
                    throw new Error('当前浏览器不支持麦克风采集');
                }
                this.emitState({ status: 'connecting', phase: 'request_media' });
                const constraints = {
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    },
                    video: this.videoEnabled ? {
                        facingMode: this.preferCamera ? 'user' : 'environment'
                    } : false
                };
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            }
            this.bindLocalTracks(this.localStream);
            const connection = this.ensurePeer();
            this.attachLocalTracks(connection);
            return this.localStream;
        }

        bindLocalTracks(stream) {
            if (!stream) return;
            this.localAudioTrack = (stream.getAudioTracks() || [])[0] || null;
            this.localVideoTrack = (stream.getVideoTracks() || [])[0] || null;
            this.mutedSelf = this.localAudioTrack ? !this.localAudioTrack.enabled : false;
            this.videoEnabled = !!this.localVideoTrack;
            this.attachLocalAnalyser();
        }

        attachLocalTracks(connection) {
            const targetPeer = connection || this.peer;
            if (!targetPeer || !this.localStream) return;
            const senderTrackIds = new Set((targetPeer.getSenders() || []).map(sender => sender && sender.track && sender.track.id).filter(Boolean));
            this.localStream.getTracks().forEach(track => {
                if (!track || senderTrackIds.has(track.id)) return;
                targetPeer.addTrack(track, this.localStream);
            });
            this.localTracksAttached = true;
        }

        ensurePeer() {
            if (this.peer) return this.peer;
            const connection = new RTCPeerConnection({
                iceServers: [
                    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
                ]
            });
            this.peer = connection;
            if (this.localStream) {
                this.attachLocalTracks(connection);
            }
            connection.onicecandidate = event => {
                if (!event || !event.candidate) return;
                this.send('ice_candidate', { candidate: event.candidate });
            };
            connection.ontrack = event => {
                const stream = (event.streams && event.streams[0]) || null;
                if (!stream) return;
                this.remoteStream = stream;
                if (this.remoteAudio) {
                    this.remoteAudio.srcObject = stream;
                    const playPromise = this.remoteAudio.play();
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch(() => {});
                    }
                }
                if (this.remoteVideo) {
                    this.remoteVideo.srcObject = stream;
                    const playPromise = this.remoteVideo.play();
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch(() => {});
                    }
                }
                this.attachRemoteAnalyser();
                this.emitState({ phase: 'receiving_media' });
            };
            connection.onconnectionstatechange = () => {
                const state = String(connection.connectionState || '').trim();
                if (state === 'connected') {
                    this.emitState({ status: 'active', phase: 'active' });
                    this.send('media_connected', {});
                    return;
                }
                if (state === 'connecting') {
                    this.emitState({ status: 'connecting', phase: 'connecting_media' });
                    return;
                }
                if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                    this.stop(false, state);
                }
            };
            return connection;
        }

        async connectSocket() {
            if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
                return this.ws;
            }
            return await new Promise((resolve, reject) => {
                try {
                    const currentWs = new WebSocket(this.wsUrlBuilder(this.voiceSessionId, this.role, this.site));
                    this.ws = currentWs;
                    currentWs.onopen = () => {
                        this.emitState({ status: 'connecting', phase: 'signal_ready' });
                        resolve(currentWs);
                    };
                    currentWs.onmessage = async event => {
                        try {
                            const data = JSON.parse(String((event && event.data) || '{}'));
                            await this.handleMessage(data);
                        } catch (e) {
                            this.fail(e);
                        }
                    };
                    currentWs.onerror = err => {
                        this.fail(err);
                    };
                    currentWs.onclose = () => {
                        if (!this.destroyed) {
                            this.stop(false, 'socket_closed');
                        }
                    };
                } catch (e) {
                    reject(e);
                }
            });
        }

        startHeartbeat() {
            this.stopHeartbeat();
            this.heartbeatTimer = setInterval(() => {
                this.send('heartbeat', {});
            }, DEFAULT_HEARTBEAT_INTERVAL);
        }

        stopHeartbeat() {
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }
        }

        startLevelMonitor() {
            this.stopLevelMonitor();
            this.levelTimer = setInterval(() => {
                this.emitState({
                    localLevel: this.readAnalyserLevel(this.localAnalyser, this.localLevelBuffer),
                    remoteLevel: this.readAnalyserLevel(this.remoteAnalyser, this.remoteLevelBuffer)
                });
            }, DEFAULT_LEVEL_INTERVAL);
        }

        stopLevelMonitor() {
            if (this.levelTimer) {
                clearInterval(this.levelTimer);
                this.levelTimer = null;
            }
        }

        attachLocalAnalyser() {
            if (!this.audioContext || !this.localStream) return;
            try {
                const analyser = this.audioContext.createAnalyser();
                analyser.fftSize = 1024;
                const source = this.audioContext.createMediaStreamSource(this.localStream);
                source.connect(analyser);
                this.localAnalyser = analyser;
                this.localLevelBuffer = new Uint8Array(analyser.fftSize);
            } catch (e) {}
        }

        attachRemoteAnalyser() {
            if (!this.audioContext || !this.remoteStream) return;
            try {
                const analyser = this.audioContext.createAnalyser();
                analyser.fftSize = 1024;
                const source = this.audioContext.createMediaStreamSource(this.remoteStream);
                source.connect(analyser);
                this.remoteAnalyser = analyser;
                this.remoteLevelBuffer = new Uint8Array(analyser.fftSize);
            } catch (e) {}
        }

        readAnalyserLevel(analyser, buffer) {
            if (!analyser || !buffer) return 0;
            try {
                analyser.getByteTimeDomainData(buffer);
                let total = 0;
                for (let i = 0; i < buffer.length; i += 1) {
                    total += Math.abs(buffer[i] - 128);
                }
                return clampLevel((total / buffer.length) / 24);
            } catch (e) {
                return 0;
            }
        }

        async handleMessage(data) {
            if (!data || !data.type) return;
            const type = String(data.type || '').trim();
            const payload = data.payload || {};
            if (type === 'session_state') {
                await this.applySessionState(payload);
                return;
            }
            if (type === 'offer') {
                await this.handleOffer(payload);
                return;
            }
            if (type === 'answer') {
                await this.handleAnswer(payload);
                return;
            }
            if (type === 'ice_candidate') {
                await this.handleIceCandidate(payload);
                return;
            }
            if (type === 'hangup') {
                await this.stop(false, String(payload.reason || payload.status || 'closed'));
                return;
            }
        }

        async applySessionState(payload) {
            const current = payload || {};
            const nextStatus = String(current.status || this.status || '').trim() || this.status;
            const connectedRoles = Array.isArray(current.connected_roles) ? current.connected_roles.slice() : [];
            const adminMuted = !!current.admin_muted;
            const userMuted = !!current.user_muted;
            const mutedSelf = this.role === 'admin' ? adminMuted : userMuted;
            const mutedPeer = this.role === 'admin' ? userMuted : adminMuted;
            if (this.localAudioTrack) {
                this.localAudioTrack.enabled = !mutedSelf;
            }
            if (this.localVideoTrack) {
                this.localVideoTrack.enabled = !!this.videoEnabled;
            }
            this.emitState({
                status: nextStatus || this.status,
                phase: nextStatus === 'active' ? 'active' : (connectedRoles.includes('admin') && connectedRoles.includes('user') ? 'ready' : 'waiting_peer'),
                mutedSelf,
                mutedPeer,
                connectedRoles
            });
            if (nextStatus === 'closed' || nextStatus === 'failed' || nextStatus === 'rejected' || nextStatus === 'timeout') {
                await this.stop(false, nextStatus);
                return;
            }
            if (this.role === 'admin' && connectedRoles.includes('admin') && connectedRoles.includes('user')) {
                await this.maybeCreateOffer();
            }
        }

        async maybeCreateOffer() {
            if (this.role !== 'admin' || this.sentOffer || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return;
            }
            try {
                await this.ensureLocalStream();
                const connection = this.ensurePeer();
                if (!connection || connection.signalingState !== 'stable') {
                    return;
                }
                this.sentOffer = true;
                const offer = await connection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: !!this.videoEnabled });
                await connection.setLocalDescription(offer);
                this.send('offer', { sdp: offer.sdp, type: offer.type });
                this.emitState({ status: 'connecting', phase: 'offer_sent' });
            } catch (e) {
                this.sentOffer = false;
                this.fail(e);
                throw e;
            }
        }

        async handleOffer(payload) {
            await this.ensureLocalStream();
            this.ensurePeer();
            const description = new RTCSessionDescription({
                type: String(payload.type || 'offer'),
                sdp: String(payload.sdp || '')
            });
            await this.peer.setRemoteDescription(description);
            const answer = await this.peer.createAnswer();
            await this.peer.setLocalDescription(answer);
            this.send('answer', { sdp: answer.sdp, type: answer.type });
            this.emitState({ status: 'connecting', phase: 'answer_sent' });
        }

        async handleAnswer(payload) {
            if (!this.peer || this.settingRemoteAnswer) return;
            this.settingRemoteAnswer = true;
            try {
                const description = new RTCSessionDescription({
                    type: String(payload.type || 'answer'),
                    sdp: String(payload.sdp || '')
                });
                await this.peer.setRemoteDescription(description);
                while (this.pendingCandidates.length) {
                    const candidate = this.pendingCandidates.shift();
                    if (candidate) {
                        await this.peer.addIceCandidate(candidate);
                    }
                }
                this.emitState({ status: 'connecting', phase: 'answer_applied' });
            } finally {
                this.settingRemoteAnswer = false;
            }
        }

        async handleIceCandidate(payload) {
            if (!payload || !payload.candidate) return;
            const candidate = new RTCIceCandidate(payload.candidate);
            if (!this.peer || !this.peer.remoteDescription) {
                this.pendingCandidates.push(candidate);
                return;
            }
            await this.peer.addIceCandidate(candidate);
        }

        send(type, payload) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
            try {
                this.ws.send(JSON.stringify({ type: String(type || '').trim(), payload: payload || {} }));
                return true;
            } catch (e) {
                return false;
            }
        }

        async setMuted(muted) {
            const nextMuted = !!muted;
            this.mutedSelf = nextMuted;
            if (this.localAudioTrack) {
                this.localAudioTrack.enabled = !nextMuted;
            }
            this.emitState({ mutedSelf: nextMuted });
            this.send('mute_state', { muted: nextMuted });
            return nextMuted;
        }

        async toggleMuted() {
            return await this.setMuted(!this.mutedSelf);
        }

        async setCameraEnabled(enabled) {
            const nextEnabled = !!enabled;
            this.videoEnabled = nextEnabled;
            if (this.localVideoTrack) {
                this.localVideoTrack.enabled = nextEnabled;
            } else if (nextEnabled && this.localStream && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
                const extraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: this.preferCamera ? 'user' : 'environment' } });
                const nextTrack = (extraStream.getVideoTracks() || [])[0] || null;
                if (nextTrack) {
                    this.localVideoTrack = nextTrack;
                    this.localStream.addTrack(nextTrack);
                    this.attachLocalTracks(this.peer);
                    if (this.peer) {
                        this.sentOffer = false;
                        await this.maybeCreateOffer();
                    }
                }
                (extraStream.getTracks() || []).forEach(stopTrack);
            }
            this.emitState({ videoEnabled: nextEnabled });
            return nextEnabled;
        }

        async toggleCamera() {
            return await this.setCameraEnabled(!this.videoEnabled);
        }

        async hangup(reason) {
            this.send('hangup', { reason: String(reason || 'manual_hangup') });
            await this.stop(false, String(reason || 'manual_hangup'));
        }

        async stop(_notifyServer, reason) {
            if (this.stopPromise) return this.stopPromise;
            this.stopPromise = this._stop(reason).finally(() => {
                this.stopPromise = null;
            });
            return this.stopPromise;
        }

        async _stop(reason) {
            if (this.destroyed) return;
            this.destroyed = true;
            this.started = false;
            this.stopHeartbeat();
            this.stopLevelMonitor();
            const currentWs = this.ws;
            this.ws = null;
            if (currentWs) {
                try {
                    currentWs.close();
                } catch (e) {}
            }
            const currentPeer = this.peer;
            this.peer = null;
            if (currentPeer) {
                try {
                    currentPeer.close();
                } catch (e) {}
            }
            if (this.remoteAudio) {
                try {
                    this.remoteAudio.pause();
                    this.remoteAudio.srcObject = null;
                } catch (e) {}
            }
            if (this.remoteVideo) {
                try {
                    this.remoteVideo.pause();
                    this.remoteVideo.srcObject = null;
                } catch (e) {}
            }
            if (this.localStream) {
                try {
                    this.localStream.getTracks().forEach(track => track.stop());
                } catch (e) {}
            }
            this.localStream = null;
            this.localAudioTrack = null;
            this.localVideoTrack = null;
            this.remoteStream = null;
            this.localTracksAttached = false;
            this.emitState({ status: String(reason || 'closed'), phase: 'closed' });
        }
    }

    global.AKRemoteVoiceClient = AKRemoteVoiceClient;
})(window);
            this.localTracksAttached = false;
            this.startPromise = null;
            this.stopPromise = null;
        }

        getState() {
            return {
                voiceSessionId: this.voiceSessionId,
                role: this.role,
                site: this.site,
                status: this.status,
                phase: this.phase,
                mutedSelf: !!this.mutedSelf,
                mutedPeer: !!this.mutedPeer,
                localLevel: clampLevel(this.localLevel),
                remoteLevel: clampLevel(this.remoteLevel),
                connectedRoles: Array.isArray(this.connectedRoles) ? this.connectedRoles.slice() : [],
                connected: !!(this.peer && this.peer.connectionState === 'connected')
            };
        }

        emitState(patch) {
            if (patch && typeof patch === 'object') {
                if (Object.prototype.hasOwnProperty.call(patch, 'status')) this.status = String(patch.status || this.status || '').trim() || this.status;
                if (Object.prototype.hasOwnProperty.call(patch, 'phase')) this.phase = String(patch.phase || this.phase || '').trim() || this.phase;
                if (Object.prototype.hasOwnProperty.call(patch, 'mutedSelf')) this.mutedSelf = !!patch.mutedSelf;
                if (Object.prototype.hasOwnProperty.call(patch, 'mutedPeer')) this.mutedPeer = !!patch.mutedPeer;
                if (Object.prototype.hasOwnProperty.call(patch, 'localLevel')) this.localLevel = clampLevel(patch.localLevel);
                if (Object.prototype.hasOwnProperty.call(patch, 'remoteLevel')) this.remoteLevel = clampLevel(patch.remoteLevel);
                if (Object.prototype.hasOwnProperty.call(patch, 'connectedRoles')) this.connectedRoles = Array.isArray(patch.connectedRoles) ? patch.connectedRoles.slice() : [];
            }
            try {
                this.onStateChange(this.getState());
            } catch (e) {}
        }

        fail(error) {
            try {
                this.onError(error);
            } catch (e) {}
        }

        async start() {
            if (this.startPromise) return this.startPromise;
            this.startPromise = this._start().finally(() => {
                this.startPromise = null;
            });
            return this.startPromise;
        }

        async _start() {
            if (!this.voiceSessionId) {
                throw new Error('缺少语音会话ID');
            }
            if (!this.remoteAudio) {
                this.remoteAudio = document.createElement('audio');
                this.remoteAudio.autoplay = true;
                this.remoteAudio.playsInline = true;
                this.remoteAudio.style.display = 'none';
                document.body.appendChild(this.remoteAudio);
            }
            this.destroyed = false;
            await this.ensureAudioContext();
            await this.connectSocket();
            if (!this.lazyMedia) {
                await this.ensureLocalStream();
            }
            this.started = true;
            this.startHeartbeat();
            this.startLevelMonitor();
            this.emitState({ status: this.status === 'idle' ? 'connecting' : this.status, phase: this.phase === 'idle' ? 'waiting_peer' : this.phase });
            return this;
        }

        async ensureAudioContext() {
            if (this.audioContext) {
                try {
                    if (this.audioContext.state === 'suspended') {
                        await this.audioContext.resume();
                    }
                } catch (e) {}
                return this.audioContext;
            }
            const AudioCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtor) return null;
            this.audioContext = new AudioCtor();
            try {
                if (this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }
            } catch (e) {}
            return this.audioContext;
        }

        async ensureLocalStream() {
            if (!this.localStream) {
                if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
                    throw new Error('当前浏览器不支持麦克风采集');
                }
                this.emitState({ status: 'connecting', phase: 'request_media' });
                this.localStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });
            }
            this.localTrack = (this.localStream.getAudioTracks() || [])[0] || null;
            this.mutedSelf = this.localTrack ? !this.localTrack.enabled : false;
            this.attachLocalAnalyser();
            const connection = this.ensurePeer();
            this.attachLocalTracks(connection);
            return this.localStream;
        }

        attachLocalTracks(connection) {
            const targetPeer = connection || this.peer;
            if (!targetPeer || !this.localStream) return;
            const senderTrackIds = new Set((targetPeer.getSenders() || []).map(sender => sender && sender.track && sender.track.id).filter(Boolean));
            this.localStream.getTracks().forEach(track => {
                if (!track || senderTrackIds.has(track.id)) return;
                targetPeer.addTrack(track, this.localStream);
            });
            this.localTracksAttached = true;
        }

        ensurePeer() {
            if (this.peer) return this.peer;
            const connection = new RTCPeerConnection({
                iceServers: [
                    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
                ]
            });
            this.peer = connection;
            if (this.localStream) {
                this.attachLocalTracks(connection);
            }
            connection.onicecandidate = event => {
                if (!event || !event.candidate) return;
                this.send('ice_candidate', { candidate: event.candidate });
            };
            connection.ontrack = event => {
                const stream = (event.streams && event.streams[0]) || null;
                if (!stream) return;
                this.remoteStream = stream;
                if (this.remoteAudio) {
                    this.remoteAudio.srcObject = stream;
                    const playPromise = this.remoteAudio.play();
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch(() => {});
                    }
                }
                this.attachRemoteAnalyser();
                this.emitState({ phase: 'receiving_audio' });
            };
            connection.onconnectionstatechange = () => {
                const state = String(connection.connectionState || '').trim();
                if (state === 'connected') {
                    this.emitState({ status: 'active', phase: 'active' });
                    this.send('media_connected', {});
                    return;
                }
                if (state === 'connecting') {
                    this.emitState({ status: 'connecting', phase: 'connecting_media' });
                    return;
                }
                if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                    this.stop(false, state);
                }
            };
            return connection;
        }

        async connectSocket() {
            if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
                return this.ws;
            }
            return await new Promise((resolve, reject) => {
                try {
                    const currentWs = new WebSocket(this.wsUrlBuilder(this.voiceSessionId, this.role, this.site));
                    this.ws = currentWs;
                    currentWs.onopen = () => {
                        this.emitState({ status: 'connecting', phase: 'signal_ready' });
                        resolve(currentWs);
                    };
                    currentWs.onmessage = async event => {
                        try {
                            const data = JSON.parse(String((event && event.data) || '{}'));
                            await this.handleMessage(data);
                        } catch (e) {
                            this.fail(e);
                        }
                    };
                    currentWs.onerror = err => {
                        this.fail(err);
                    };
                    currentWs.onclose = () => {
                        if (!this.destroyed) {
                            this.stop(false, 'socket_closed');
                        }
                    };
                } catch (e) {
                    reject(e);
                }
            });
        }

        startHeartbeat() {
            this.stopHeartbeat();
            this.heartbeatTimer = setInterval(() => {
                this.send('heartbeat', {});
            }, DEFAULT_HEARTBEAT_INTERVAL);
        }

        stopHeartbeat() {
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }
        }

        startLevelMonitor() {
            this.stopLevelMonitor();
            this.levelTimer = setInterval(() => {
                this.emitState({
                    localLevel: this.readAnalyserLevel(this.localAnalyser, this.localLevelBuffer),
                    remoteLevel: this.readAnalyserLevel(this.remoteAnalyser, this.remoteLevelBuffer)
                });
            }, DEFAULT_LEVEL_INTERVAL);
        }

        stopLevelMonitor() {
            if (this.levelTimer) {
                clearInterval(this.levelTimer);
                this.levelTimer = null;
            }
        }

        attachLocalAnalyser() {
            if (!this.audioContext || !this.localStream) return;
            try {
                const analyser = this.audioContext.createAnalyser();
                analyser.fftSize = 1024;
                const source = this.audioContext.createMediaStreamSource(this.localStream);
                source.connect(analyser);
                this.localAnalyser = analyser;
                this.localLevelBuffer = new Uint8Array(analyser.fftSize);
            } catch (e) {}
        }

        attachRemoteAnalyser() {
            if (!this.audioContext || !this.remoteStream) return;
            try {
                const analyser = this.audioContext.createAnalyser();
                analyser.fftSize = 1024;
                const source = this.audioContext.createMediaStreamSource(this.remoteStream);
                source.connect(analyser);
                this.remoteAnalyser = analyser;
                this.remoteLevelBuffer = new Uint8Array(analyser.fftSize);
            } catch (e) {}
        }

        readAnalyserLevel(analyser, buffer) {
            if (!analyser || !buffer) return 0;
            try {
                analyser.getByteTimeDomainData(buffer);
                let total = 0;
                for (let i = 0; i < buffer.length; i += 1) {
                    total += Math.abs(buffer[i] - 128);
                }
                return clampLevel((total / buffer.length) / 24);
            } catch (e) {
                return 0;
            }
        }

        async handleMessage(data) {
            if (!data || !data.type) return;
            const type = String(data.type || '').trim();
            const payload = data.payload || {};
            if (type === 'session_state') {
                await this.applySessionState(payload);
                return;
            }
            if (type === 'offer') {
                await this.handleOffer(payload);
                return;
            }
            if (type === 'answer') {
                await this.handleAnswer(payload);
                return;
            }
            if (type === 'ice_candidate') {
                await this.handleIceCandidate(payload);
                return;
            }
            if (type === 'hangup') {
                await this.stop(false, String(payload.reason || payload.status || 'closed'));
                return;
            }
        }

        async applySessionState(payload) {
            const current = payload || {};
            const nextStatus = String(current.status || this.status || '').trim() || this.status;
            const connectedRoles = Array.isArray(current.connected_roles) ? current.connected_roles.slice() : [];
            const adminMuted = !!current.admin_muted;
            const userMuted = !!current.user_muted;
            const mutedSelf = this.role === 'admin' ? adminMuted : userMuted;
            const mutedPeer = this.role === 'admin' ? userMuted : adminMuted;
            if (this.localTrack) {
                this.localTrack.enabled = !mutedSelf;
            }
            this.emitState({
                status: nextStatus || this.status,
                phase: nextStatus === 'active' ? 'active' : (connectedRoles.includes('admin') && connectedRoles.includes('user') ? 'ready' : 'waiting_peer'),
                mutedSelf,
                mutedPeer,
                connectedRoles
            });
            if (nextStatus === 'closed' || nextStatus === 'failed' || nextStatus === 'rejected' || nextStatus === 'timeout') {
                await this.stop(false, nextStatus);
                return;
            }
            if (this.role === 'admin' && connectedRoles.includes('admin') && connectedRoles.includes('user')) {
                await this.maybeCreateOffer();
            }
        }

        async maybeCreateOffer() {
            if (this.role !== 'admin' || this.sentOffer || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return;
            }
            try {
                await this.ensureLocalStream();
                const connection = this.ensurePeer();
                if (!connection || connection.signalingState !== 'stable') {
                    return;
                }
                this.sentOffer = true;
                const offer = await connection.createOffer({ offerToReceiveAudio: true });
                await connection.setLocalDescription(offer);
                this.send('offer', { sdp: offer.sdp, type: offer.type });
                this.emitState({ status: 'connecting', phase: 'offer_sent' });
            } catch (e) {
                this.sentOffer = false;
                this.fail(e);
                throw e;
            }
        }

        async handleOffer(payload) {
            await this.ensureLocalStream();
            this.ensurePeer();
            const description = new RTCSessionDescription({
                type: String(payload.type || 'offer'),
                sdp: String(payload.sdp || '')
            });
            await this.peer.setRemoteDescription(description);
            const answer = await this.peer.createAnswer();
            await this.peer.setLocalDescription(answer);
            this.send('answer', { sdp: answer.sdp, type: answer.type });
            this.emitState({ status: 'connecting', phase: 'answer_sent' });
        }

        async handleAnswer(payload) {
            if (!this.peer || this.settingRemoteAnswer) return;
            this.settingRemoteAnswer = true;
            try {
                const description = new RTCSessionDescription({
                    type: String(payload.type || 'answer'),
                    sdp: String(payload.sdp || '')
                });
                await this.peer.setRemoteDescription(description);
                while (this.pendingCandidates.length) {
                    const candidate = this.pendingCandidates.shift();
                    if (candidate) {
                        await this.peer.addIceCandidate(candidate);
                    }
                }
                this.emitState({ status: 'connecting', phase: 'answer_applied' });
            } finally {
                this.settingRemoteAnswer = false;
            }
        }

        async handleIceCandidate(payload) {
            if (!payload || !payload.candidate) return;
            const candidate = new RTCIceCandidate(payload.candidate);
            if (!this.peer || !this.peer.remoteDescription) {
                this.pendingCandidates.push(candidate);
                return;
            }
            await this.peer.addIceCandidate(candidate);
        }

        send(type, payload) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
            try {
                this.ws.send(JSON.stringify({ type: String(type || '').trim(), payload: payload || {} }));
                return true;
            } catch (e) {
                return false;
            }
        }

        async setMuted(muted) {
            const nextMuted = !!muted;
            this.mutedSelf = nextMuted;
            if (this.localTrack) {
                this.localTrack.enabled = !nextMuted;
            }
            this.emitState({ mutedSelf: nextMuted });
            this.send('mute_state', { muted: nextMuted });
            return nextMuted;
        }

        async toggleMuted() {
            return await this.setMuted(!this.mutedSelf);
        }

        async hangup(reason) {
            this.send('hangup', { reason: String(reason || 'manual_hangup') });
            await this.stop(false, String(reason || 'manual_hangup'));
        }

        async stop(_notifyServer, reason) {
            if (this.stopPromise) return this.stopPromise;
            this.stopPromise = this._stop(reason).finally(() => {
                this.stopPromise = null;
            });
            return this.stopPromise;
        }

        async _stop(reason) {
            if (this.destroyed) return;
            this.destroyed = true;
            this.started = false;
            this.stopHeartbeat();
            this.stopLevelMonitor();
            const currentWs = this.ws;
            this.ws = null;
            if (currentWs) {
                try {
                    currentWs.close();
                } catch (e) {}
            }
            const currentPeer = this.peer;
            this.peer = null;
            if (currentPeer) {
                try {
                    currentPeer.close();
                } catch (e) {}
            }
            if (this.remoteAudio) {
                try {
                    this.remoteAudio.pause();
                    this.remoteAudio.srcObject = null;
                } catch (e) {}
            }
            if (this.localStream) {
                try {
                    this.localStream.getTracks().forEach(track => track.stop());
                } catch (e) {}
            }
            this.localStream = null;
            this.localTrack = null;
            this.remoteStream = null;
            this.localAnalyser = null;
            this.remoteAnalyser = null;
            this.localLevelBuffer = null;
            this.remoteLevelBuffer = null;
            this.connectedRoles = [];
            this.sentOffer = false;
            this.localTracksAttached = false;
            this.pendingCandidates = [];
            this.emitState({
                status: String(reason || 'closed'),
                phase: 'closed',
                localLevel: 0,
                remoteLevel: 0,
                connectedRoles: []
            });
        }
    }

    global.AKRemoteVoiceClient = AKRemoteVoiceClient;
})(window);
