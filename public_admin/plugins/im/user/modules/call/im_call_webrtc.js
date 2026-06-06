(function(global) {
    'use strict';

    const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
    const VIDEO_QUALITY_PROFILES = {
        hd: { width: 1280, height: 720, minWidth: 960, minHeight: 540, frameRate: 30, maxBitrate: 2800000 },
        sd: { width: 960, height: 540, minWidth: 640, minHeight: 360, frameRate: 24, maxBitrate: 1400000 },
        ld: { width: 640, height: 360, frameRate: 18, maxBitrate: 650000 },
        vld: { width: 426, height: 240, frameRate: 12, maxBitrate: 260000 }
    };

    function hasMediaSupport() {
        return !!(global.navigator && global.navigator.mediaDevices && typeof global.navigator.mediaDevices.getUserMedia === 'function' && global.RTCPeerConnection);
    }

    function trim(value) {
        return String(value || '').trim();
    }

    function normalizeCallKind(value) {
        return trim(value).toLowerCase() === 'video' ? 'video' : 'audio';
    }

    function isVideoCallKind(value) {
        return normalizeCallKind(value) === 'video';
    }

    const webRTCModule = {
        pc: null,
        localStream: null,
        remoteStream: null,
        pendingCandidates: [],
        options: {},
        role: '',
        currentKind: 'audio',
        videoProfile: 'hd',
        facingMode: 'user',
        lastStatsSample: null,

        init(options) {
            this.options = options || {};
            return this;
        },

        isSupported() {
            return hasMediaSupport();
        },

        getVideoProfileConfig(profile) {
            const normalized = trim(profile).toLowerCase();
            return VIDEO_QUALITY_PROFILES[normalized] || VIDEO_QUALITY_PROFILES.sd;
        },

        buildVideoConstraints(facingMode, options) {
            options = options || {};
            const profile = this.getVideoProfileConfig(this.videoProfile);
            const constraints = {
                width: { ideal: profile.width },
                height: { ideal: profile.height },
                frameRate: { ideal: profile.frameRate, max: profile.frameRate },
                facingMode: { ideal: trim(facingMode || this.facingMode || 'user') || 'user' },
                resizeMode: 'crop-and-scale'
            };
            if (!options.relaxed && profile.minWidth && profile.minHeight) {
                constraints.width.min = profile.minWidth;
                constraints.height.min = profile.minHeight;
            }
            return constraints;
        },

        buildMediaConstraints(kind, options) {
            const normalizedKind = normalizeCallKind(kind || this.currentKind);
            const constraints = {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            };
            if (!isVideoCallKind(normalizedKind)) return constraints;
            constraints.video = this.buildVideoConstraints(this.facingMode, options);
            return constraints;
        },

        async startLocal(kind) {
            if (!this.isSupported()) throw new Error('当前浏览器不支持实时语音通话');
            this.currentKind = normalizeCallKind(kind || this.currentKind);
            if (this.localStream) return this.localStream;
            const constraints = this.buildMediaConstraints(this.currentKind);
            try {
                this.localStream = await global.navigator.mediaDevices.getUserMedia(constraints);
            } catch (error) {
                if (!isVideoCallKind(this.currentKind)) throw error;
                this.localStream = await global.navigator.mediaDevices.getUserMedia(this.buildMediaConstraints(this.currentKind, { relaxed: true }));
            }
            this.emitLocalStream();
            return this.localStream;
        },

        async createPeer(role, kind) {
            this.role = String(role || '').toLowerCase();
            this.currentKind = normalizeCallKind(kind || this.currentKind);
            if (!this.localStream) await this.startLocal(kind);
            if (this.pc) return this.pc;
            const pc = new global.RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
            this.pc = pc;
            this.remoteStream = new global.MediaStream();
            const self = this;
            this.localStream.getTracks().forEach(function(track) {
                pc.addTrack(track, self.localStream);
            });
            pc.addEventListener('icecandidate', function(event) {
                if (!event.candidate) return;
                self.emitSignal('ice', { candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate });
            });
            pc.addEventListener('track', function(event) {
                event.streams.forEach(function(stream) {
                    stream.getTracks().forEach(function(track) {
                        self.remoteStream.addTrack(track);
                    });
                });
                self.emitRemoteStream();
            });
            pc.addEventListener('connectionstatechange', function() {
                self.emitState(pc.connectionState || '');
            });
            return pc;
        },

        async createOffer(kind) {
            const pc = await this.createPeer('caller', kind);
            if (isVideoCallKind(kind || this.currentKind)) await this.applyVideoProfile(this.videoProfile);
            const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: isVideoCallKind(kind || this.currentKind) });
            await pc.setLocalDescription(offer);
            this.emitSignal('offer', { sdp: pc.localDescription });
        },

        async acceptOffer(sdp, kind) {
            const pc = await this.createPeer('callee', kind);
            if (isVideoCallKind(kind || this.currentKind)) await this.applyVideoProfile(this.videoProfile);
            await pc.setRemoteDescription(new global.RTCSessionDescription(sdp));
            await this.flushIceCandidates();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.emitSignal('answer', { sdp: pc.localDescription });
        },

        async acceptAnswer(sdp) {
            if (!this.pc) return;
            await this.pc.setRemoteDescription(new global.RTCSessionDescription(sdp));
            await this.flushIceCandidates();
        },

        async addIceCandidate(candidate) {
            if (!this.pc || !candidate) return;
            if (!this.pc.remoteDescription) {
                this.pendingCandidates.push(candidate);
                return;
            }
            await this.pc.addIceCandidate(new global.RTCIceCandidate(candidate));
        },

        async flushIceCandidates() {
            if (!this.pc || !this.pc.remoteDescription) return;
            const items = this.pendingCandidates.splice(0);
            for (let index = 0; index < items.length; index += 1) {
                await this.pc.addIceCandidate(new global.RTCIceCandidate(items[index]));
            }
        },

        setMuted(muted) {
            if (!this.localStream) return false;
            this.localStream.getAudioTracks().forEach(function(track) {
                track.enabled = !muted;
            });
            return true;
        },

        getFacingMode() {
            return this.facingMode;
        },

        getVideoSender() {
            if (!this.pc || typeof this.pc.getSenders !== 'function') return null;
            const senders = this.pc.getSenders();
            for (let index = 0; index < senders.length; index += 1) {
                const sender = senders[index];
                const track = sender && sender.track;
                if (track && track.kind === 'video') return sender;
            }
            return null;
        },

        async switchCamera() {
            if (!this.isSupported() || !this.localStream || !isVideoCallKind(this.currentKind)) return false;
            const nextFacingMode = this.facingMode === 'user' ? 'environment' : 'user';
            const replacementStream = await global.navigator.mediaDevices.getUserMedia({
                audio: false,
                video: this.buildVideoConstraints(nextFacingMode)
            });
            const replacementTrack = replacementStream.getVideoTracks()[0] || null;
            if (!replacementTrack) {
                replacementStream.getTracks().forEach(function(track) {
                    try { track.stop(); } catch (e) {}
                });
                return false;
            }
            const oldTrack = this.localStream.getVideoTracks()[0] || null;
            const sender = this.getVideoSender();
            if (sender && typeof sender.replaceTrack === 'function') {
                try {
                    await sender.replaceTrack(replacementTrack);
                } catch (error) {
                    try { replacementTrack.stop(); } catch (e) {}
                    throw error;
                }
            }
            if (oldTrack) {
                try { this.localStream.removeTrack(oldTrack); } catch (e) {}
                try { oldTrack.stop(); } catch (e) {}
            }
            this.localStream.addTrack(replacementTrack);
            replacementStream.getAudioTracks().forEach(function(track) {
                try { track.stop(); } catch (e) {}
            });
            const settings = typeof replacementTrack.getSettings === 'function' ? replacementTrack.getSettings() : {};
            this.facingMode = trim(settings && settings.facingMode) || nextFacingMode;
            this.emitLocalStream();
            return true;
        },

        async applyVideoProfile(profile) {
            const normalizedProfile = trim(profile).toLowerCase();
            const nextProfile = VIDEO_QUALITY_PROFILES[normalizedProfile] ? normalizedProfile : 'sd';
            this.videoProfile = nextProfile;
            if (!this.localStream || !isVideoCallKind(this.currentKind)) return false;
            const config = this.getVideoProfileConfig(nextProfile);
            const videoTrack = this.localStream.getVideoTracks()[0] || null;
            if (videoTrack && typeof videoTrack.applyConstraints === 'function') {
                try {
                    await videoTrack.applyConstraints(this.buildVideoConstraints(this.facingMode));
                } catch (e) {
                    try { await videoTrack.applyConstraints(this.buildVideoConstraints(this.facingMode, { relaxed: true })); } catch (ignored) {}
                }
            }
            const sender = this.getVideoSender();
            if (sender && typeof sender.getParameters === 'function' && typeof sender.setParameters === 'function') {
                try {
                    const parameters = sender.getParameters() || {};
                    parameters.encodings = parameters.encodings && parameters.encodings.length ? parameters.encodings : [{}];
                    parameters.encodings[0].maxBitrate = config.maxBitrate;
                    parameters.encodings[0].maxFramerate = config.frameRate;
                    await sender.setParameters(parameters);
                } catch (e) {}
            }
            this.emitLocalStream();
            return true;
        },

        async readStatsSnapshot() {
            if (!this.pc || typeof this.pc.getStats !== 'function') return null;
            const report = await this.pc.getStats();
            const snapshot = {
                availableOutgoingBitrate: 0,
                outgoingBitrate: 0,
                roundTripTime: 0,
                packetsLost: 0,
                jitter: 0,
                framesPerSecond: 0,
                qualityLimitationReason: '',
                bytesSent: 0,
                sampleTime: 0
            };
            report.forEach(function(stat) {
                if (!stat || typeof stat !== 'object') return;
                const statKind = trim(stat.kind || stat.mediaType);
                if (stat.type === 'candidate-pair' && (stat.nominated || stat.selected)) {
                    if (Number(stat.availableOutgoingBitrate || 0) > 0) snapshot.availableOutgoingBitrate = Number(stat.availableOutgoingBitrate || 0);
                    if (Number(stat.currentRoundTripTime || 0) > 0) snapshot.roundTripTime = Number(stat.currentRoundTripTime || 0);
                }
                if (stat.type === 'outbound-rtp' && statKind === 'video') {
                    if (Number(stat.bytesSent || 0) > 0) snapshot.bytesSent += Number(stat.bytesSent || 0);
                    if (Number(stat.timestamp || 0) > 0) snapshot.sampleTime = Math.max(snapshot.sampleTime, Number(stat.timestamp || 0));
                    if (Number(stat.framesPerSecond || 0) > 0) snapshot.framesPerSecond = Number(stat.framesPerSecond || 0);
                    if (trim(stat.qualityLimitationReason)) snapshot.qualityLimitationReason = trim(stat.qualityLimitationReason);
                }
                if ((stat.type === 'remote-inbound-rtp' || stat.type === 'inbound-rtp') && statKind === 'video') {
                    if (Number(stat.packetsLost || 0) > 0) snapshot.packetsLost = Math.max(snapshot.packetsLost, Number(stat.packetsLost || 0));
                    if (Number(stat.jitter || 0) > 0) snapshot.jitter = Math.max(snapshot.jitter, Number(stat.jitter || 0));
                    if (!snapshot.roundTripTime && Number(stat.roundTripTime || 0) > 0) snapshot.roundTripTime = Number(stat.roundTripTime || 0);
                }
            });
            const previous = this.lastStatsSample || null;
            if (previous && snapshot.bytesSent > 0 && snapshot.sampleTime > previous.sampleTime) {
                const deltaBytes = snapshot.bytesSent - previous.bytesSent;
                const deltaMs = snapshot.sampleTime - previous.sampleTime;
                if (deltaBytes >= 0 && deltaMs > 0) {
                    snapshot.outgoingBitrate = Math.round((deltaBytes * 8 * 1000) / deltaMs);
                }
            }
            if (snapshot.bytesSent > 0 && snapshot.sampleTime > 0) {
                this.lastStatsSample = {
                    bytesSent: snapshot.bytesSent,
                    sampleTime: snapshot.sampleTime
                };
            }
            return snapshot;
        },

        emitSignal(type, payload) {
            if (this.options && typeof this.options.onSignal === 'function') {
                this.options.onSignal(type, payload || {});
            }
        },

        emitLocalStream() {
            if (this.options && typeof this.options.onLocalStream === 'function') {
                this.options.onLocalStream(this.localStream);
            }
        },

        emitRemoteStream() {
            if (this.options && typeof this.options.onRemoteStream === 'function') {
                this.options.onRemoteStream(this.remoteStream);
            }
        },

        emitState(state) {
            if (this.options && typeof this.options.onState === 'function') {
                this.options.onState(state);
            }
        },

        close() {
            if (this.pc) {
                try { this.pc.close(); } catch (e) {}
            }
            this.pc = null;
            if (this.localStream) {
                this.localStream.getTracks().forEach(function(track) {
                    try { track.stop(); } catch (e) {}
                });
            }
            this.localStream = null;
            this.remoteStream = null;
            this.pendingCandidates = [];
            this.role = '';
            this.currentKind = 'audio';
            this.videoProfile = 'hd';
            this.facingMode = 'user';
            this.lastStatsSample = null;
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.callWebRTC = webRTCModule;
})(window);
