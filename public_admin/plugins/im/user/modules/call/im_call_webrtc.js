(function(global) {
    'use strict';

    const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

    function hasMediaSupport() {
        return !!(global.navigator && global.navigator.mediaDevices && typeof global.navigator.mediaDevices.getUserMedia === 'function' && global.RTCPeerConnection);
    }

    const webRTCModule = {
        pc: null,
        localStream: null,
        remoteStream: null,
        pendingCandidates: [],
        options: {},
        role: '',

        init(options) {
            this.options = options || {};
            return this;
        },

        isSupported() {
            return hasMediaSupport();
        },

        async startLocal(kind) {
            if (!this.isSupported()) throw new Error('当前浏览器不支持实时语音通话');
            if (this.localStream) return this.localStream;
            const constraints = {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: String(kind || 'audio').toLowerCase() === 'video'
            };
            this.localStream = await global.navigator.mediaDevices.getUserMedia(constraints);
            this.emitLocalStream();
            return this.localStream;
        },

        async createPeer(role, kind) {
            this.role = String(role || '').toLowerCase();
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
            const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: String(kind || 'audio').toLowerCase() === 'video' });
            await pc.setLocalDescription(offer);
            this.emitSignal('offer', { sdp: pc.localDescription });
        },

        async acceptOffer(sdp, kind) {
            const pc = await this.createPeer('callee', kind);
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
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.callWebRTC = webRTCModule;
})(window);
