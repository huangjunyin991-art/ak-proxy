(function(global) {
    'use strict';

    const STYLE_ID = 'ak-im-call-overlay-style';
    const PANEL_SELECTOR = '.ak-im-call-overlay';
    const CALL_MODES = {
        idle: 'idle',
        outgoing: 'outgoing',
        incoming: 'incoming',
        connecting: 'connecting',
        active: 'active',
        ended: 'ended',
        failed: 'failed'
    };
    const CALL_STATUS_TEXT = {
        idle: '',
        outgoing: '等待对方接听',
        incoming: '对方发来通话请求',
        connecting: '正在连接',
        active: '正在通话',
        ended: '通话已结束',
        failed: '通话失败'
    };
    const CALL_FAIL_REASON_TEXT = {
        busy: '对方或当前会话正在通话中',
        media_denied: '无法使用麦克风',
        socket_error: '通话信令连接失败',
        socket_timeout: '通话请求未得到服务器响应',
        socket_unavailable: '通话服务暂不可用',
        unsupported: '当前浏览器不支持实时语音通话'
    };
    function trim(value) {
        return String(value || '').trim();
    }

    function ensureModuleRegistry() {
        global.AKIMUserModules = global.AKIMUserModules || {};
        return global.AKIMUserModules;
    }

    function createBuiltInSignalingModule() {
        return {
            socket: null,
            socketReady: false,
            outboundQueue: [],
            options: {},

            init(options) {
                this.options = options || {};
                this.ensureSocket();
                return this;
            },

            getWsURL() {
                if (this.options && typeof this.options.getWsURL === 'function') {
                    return String(this.options.getWsURL() || '');
                }
                return '';
            },

            ensureSocket() {
                if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
                const wsURL = this.getWsURL();
                if (!wsURL) {
                    this.emitError('socket_unavailable', '通话服务地址不可用');
                    return;
                }
                try {
                    const socket = new WebSocket(wsURL);
                    this.socket = socket;
                    const self = this;
                    socket.addEventListener('open', function() {
                        self.socketReady = true;
                        self.flushQueue();
                    });
                    socket.addEventListener('message', function(event) {
                        self.handleMessage(event.data);
                    });
                    socket.addEventListener('close', function() {
                        self.socketReady = false;
                        if (self.socket === socket) self.socket = null;
                    });
                    socket.addEventListener('error', function() {
                        self.socketReady = false;
                        self.emitError('socket_error', '通话信令连接失败');
                    });
                } catch (error) {
                    this.socket = null;
                    this.socketReady = false;
                    this.emitError('socket_error', error && error.message ? error.message : '通话信令初始化失败');
                }
            },

            handleMessage(raw) {
                let data = null;
                try {
                    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
                } catch (e) {
                    return;
                }
                if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
                if (!data.type.startsWith('im.call.')) return;
                if (this.options && typeof this.options.onEvent === 'function') {
                    this.options.onEvent(data.type, data.payload && typeof data.payload === 'object' ? data.payload : {});
                }
            },

            send(type, payload) {
                const message = { type: String(type || ''), payload: payload || {} };
                if (!message.type) return;
                if (!this.socket || !this.socketReady || this.socket.readyState !== 1) {
                    this.outboundQueue.push(message);
                    this.ensureSocket();
                    return;
                }
                try {
                    this.socket.send(JSON.stringify(message));
                } catch (e) {
                    this.outboundQueue.push(message);
                    this.socketReady = false;
                    this.ensureSocket();
                }
            },

            flushQueue() {
                if (!this.socket || !this.socketReady || this.socket.readyState !== 1) return;
                while (this.outboundQueue.length > 0) {
                    const message = this.outboundQueue.shift();
                    try {
                        this.socket.send(JSON.stringify(message));
                    } catch (e) {
                        this.outboundQueue.unshift(message);
                        break;
                    }
                }
            },

            emitError(reason, message) {
                if (this.options && typeof this.options.onError === 'function') {
                    this.options.onError(reason, message);
                }
            },

            destroy() {
                this.outboundQueue = [];
                this.socketReady = false;
                if (this.socket) {
                    try { this.socket.close(); } catch (e) {}
                }
                this.socket = null;
            }
        };
    }

    function createBuiltInWebRTCModule() {
        return {
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
                return !!(global.navigator && global.navigator.mediaDevices && typeof global.navigator.mediaDevices.getUserMedia === 'function' && global.RTCPeerConnection);
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
                const pc = new global.RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
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
    }

    const callModule = {
        ctx: null,
        mode: CALL_MODES.idle,
        currentCallId: '',
        currentConversationId: 0,
        currentPeerName: '',
        currentPeerUsername: '',
        currentKind: 'audio',
        role: '',
        muted: false,
        offerSent: false,
        timers: { autoEnd: 0, launch: 0 },
        refs: {},
        lastFailReason: '',
        bound: false,
        submodulePromise: null,
        signaling: null,
        webRTC: null,

        init(ctx) {
            this.ctx = ctx || {};
            this.ensureStyle();
            this.ensureShell();
            this.render();
            return this;
        },

        getApiBase() {
            if (this.ctx && typeof this.ctx.getApiBase === 'function') return trim(this.ctx.getApiBase());
            return '';
        },

        getAssetBase() {
            const apiBase = this.getApiBase();
            try {
                const url = new URL(apiBase || '/', global.location.origin);
                return url.origin;
            } catch (e) {
                return global.location.origin;
            }
        },

        getWsURL() {
            const apiBase = this.getApiBase();
            if (!apiBase) return '';
            try {
                const url = new URL(apiBase, global.location.origin);
                url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
                return url.origin.replace(/\/$/, '') + '/im/ws';
            } catch (e) {
                return global.location.origin.replace(/^http/, 'ws').replace(/\/$/, '') + '/im/ws';
            }
        },

        reportLaunchError(reason, detail) {
            if (!this.ctx || typeof this.ctx.reportLaunchError !== 'function') return;
            try { this.ctx.reportLaunchError(reason, detail || {}); } catch (e) {}
        },

        ensureBuiltInModules() {
            const modules = ensureModuleRegistry();
            if (!modules.callSignaling) modules.callSignaling = createBuiltInSignalingModule();
            if (!modules.callWebRTC) modules.callWebRTC = createBuiltInWebRTCModule();
            return {
                signaling: modules.callSignaling,
                webRTC: modules.callWebRTC
            };
        },

        ensureSubmodules() {
            if (this.submodulePromise) return this.submodulePromise;
            const self = this;
            this.submodulePromise = Promise.resolve().then(function() {
                const modules = self.ensureBuiltInModules();
                self.signaling = modules.signaling;
                self.webRTC = modules.webRTC;
                self.initSignaling();
                self.initWebRTC();
                return { signaling: self.signaling, webRTC: self.webRTC };
            }).catch(function(error) {
                self.submodulePromise = null;
                throw error;
            });
            return this.submodulePromise;
        },

        initSignaling() {
            if (!this.signaling || typeof this.signaling.init !== 'function') return;
            const self = this;
            this.signaling.init({
                getWsURL: function() { return self.getWsURL(); },
                onEvent: function(type, payload) { self.handleSignalEvent(type, payload); },
                onError: function(reason, message) { self.fail(reason, message); }
            });
        },

        initWebRTC() {
            if (!this.webRTC || typeof this.webRTC.init !== 'function') return;
            const self = this;
            this.webRTC.init({
                onSignal: function(type, payload) { self.sendWebRTCSignal(type, payload); },
                onLocalStream: function(stream) { self.attachLocalStream(stream); },
                onRemoteStream: function(stream) { self.attachRemoteStream(stream); },
                onState: function(state) { self.handlePeerState(state); }
            });
        },

        ensureStyle() {
            if (document.getElementById(STYLE_ID)) return;
            const styleEl = document.createElement('style');
            styleEl.id = STYLE_ID;
            styleEl.textContent = [
                '.ak-im-call-overlay{position:fixed;inset:0;z-index:2147483646;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(4,10,18,.72);backdrop-filter:blur(12px)}',
                '.ak-im-call-overlay[aria-hidden="false"]{display:flex}',
                '.ak-im-call-overlay-backdrop{position:absolute;inset:0}',
                '.ak-im-call-overlay-card{position:relative;z-index:1;width:min(calc(100vw - 32px),420px);min-height:520px;max-height:min(calc(100vh - 32px),720px);display:flex;flex-direction:column;overflow:hidden;border-radius:24px;background:linear-gradient(180deg,#07111c 0%,#10251f 48%,#040b12 100%);color:#fff;box-shadow:0 32px 90px rgba(0,0,0,.42)}',
                '.ak-im-call-overlay-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 16px 10px;background:rgba(255,255,255,.04)}',
                '.ak-im-call-overlay-header-main{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:12px}',
                '.ak-im-call-overlay-spacer{width:36px;height:36px;flex:0 0 36px}',
                '.ak-im-call-overlay-avatar{width:52px;height:52px;border-radius:999px;flex:0 0 auto;background:linear-gradient(135deg,#16a34a 0%,#0891b2 100%);box-shadow:0 12px 28px rgba(8,145,178,.28);transition:transform .18s ease}',
                '.ak-im-call-overlay-header-text{min-width:0;text-align:center}',
                '.ak-im-call-overlay-title{font-size:18px;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '.ak-im-call-overlay-subtitle{margin-top:6px;font-size:13px;line-height:1.4;color:rgba(255,255,255,.72);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '.ak-im-call-overlay-close{width:36px;height:36px;border:none;border-radius:18px;background:rgba(255,255,255,.12);color:#fff;font-size:24px;line-height:36px;cursor:pointer;flex:0 0 auto}',
                '.ak-im-call-overlay-stage{position:relative;flex:1;display:flex;align-items:center;justify-content:center;padding:18px 18px 12px;background:radial-gradient(circle at top,#164e63 0%,#0f271f 52%,#031018 100%);overflow:hidden}',
                '.ak-im-call-overlay-pulse{position:absolute;top:50%;left:50%;width:220px;height:220px;border-radius:50%;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(45,212,191,.2) 0%,rgba(45,212,191,0) 70%);opacity:0;pointer-events:none}',
                '.ak-im-call-overlay-placeholder{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;color:rgba(255,255,255,.84)}',
                '.ak-im-call-overlay-placeholder-icon{width:92px;height:92px;border-radius:46px;display:flex;align-items:center;justify-content:center;font-size:38px;background:rgba(255,255,255,.09);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}',
                '.ak-im-call-overlay-placeholder-text{font-size:15px}',
                '.ak-im-call-overlay-local,.ak-im-call-overlay-remote{display:none}',
                '.ak-im-call-overlay-audio{display:none}',
                '.ak-im-call-overlay-state{padding:10px 18px 0;min-height:26px;font-size:15px;font-weight:500;text-align:center;color:#e2e8f0}',
                '.ak-im-call-overlay-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;padding:18px 18px calc(20px + env(safe-area-inset-bottom,0px));background:rgba(2,10,15,.94)}',
                '.ak-im-call-overlay-actions button{min-width:92px;height:44px;padding:0 18px;border:none;border-radius:22px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.22)}',
                '.ak-im-call-overlay-reject{background:#ef4444;color:#fff}',
                '.ak-im-call-overlay-accept{background:#22c55e;color:#fff}',
                '.ak-im-call-overlay-hangup{background:#f97316;color:#fff}',
                '.ak-im-call-overlay-mute{background:rgba(255,255,255,.12);color:#fff}',
                '@keyframes akImCallOverlayPulse{0%{transform:translate(-50%,-50%) scale(.82);opacity:.2}50%{transform:translate(-50%,-50%) scale(1.05);opacity:.55}100%{transform:translate(-50%,-50%) scale(1.18);opacity:0}}',
                '@media (max-width:768px){.ak-im-call-overlay{padding:0}.ak-im-call-overlay-card{width:100vw;min-height:100vh;max-height:100vh;border-radius:0;box-shadow:none}.ak-im-call-overlay-stage{padding:14px 14px 10px}.ak-im-call-overlay-actions{gap:10px;padding-left:12px;padding-right:12px}.ak-im-call-overlay-actions button{min-width:84px}.ak-im-call-overlay-title{font-size:17px}.ak-im-call-overlay-avatar{width:40px;height:40px}.ak-im-call-overlay-placeholder-icon{width:84px;height:84px;font-size:34px}}'
            ].join('');
            (document.head || document.documentElement).appendChild(styleEl);
        },

        ensureShell() {
            const mountRoot = document.body || document.documentElement || null;
            if (!mountRoot) return null;
            let panel = document.querySelector(PANEL_SELECTOR);
            if (!panel) {
                const wrapper = document.createElement('div');
                wrapper.innerHTML = [
                    '<div class="ak-im-call-overlay" aria-hidden="true">',
                    '  <div class="ak-im-call-overlay-backdrop"></div>',
                    '  <div class="ak-im-call-overlay-card" role="dialog" aria-modal="true" aria-label="通话面板">',
                    '    <div class="ak-im-call-overlay-header">',
                    '      <button class="ak-im-call-overlay-close" type="button" aria-label="关闭">×</button>',
                    '      <div class="ak-im-call-overlay-header-main">',
                    '        <div class="ak-im-call-overlay-avatar" aria-hidden="true"></div>',
                    '        <div class="ak-im-call-overlay-header-text">',
                    '          <div class="ak-im-call-overlay-title">通话</div>',
                    '          <div class="ak-im-call-overlay-subtitle"></div>',
                    '        </div>',
                    '      </div>',
                    '      <div class="ak-im-call-overlay-spacer" aria-hidden="true"></div>',
                    '    </div>',
                    '    <div class="ak-im-call-overlay-stage">',
                    '      <div class="ak-im-call-overlay-pulse"></div>',
                    '      <div class="ak-im-call-overlay-placeholder">',
                    '        <div class="ak-im-call-overlay-placeholder-icon">☎</div>',
                    '        <div class="ak-im-call-overlay-placeholder-text">等待通话连接</div>',
                    '      </div>',
                    '      <audio class="ak-im-call-overlay-audio" autoplay></audio>',
                    '      <video class="ak-im-call-overlay-local" playsinline autoplay muted></video>',
                    '      <video class="ak-im-call-overlay-remote" playsinline autoplay></video>',
                    '    </div>',
                    '    <div class="ak-im-call-overlay-state"></div>',
                    '    <div class="ak-im-call-overlay-actions">',
                    '      <button class="ak-im-call-overlay-reject" type="button">拒绝</button>',
                    '      <button class="ak-im-call-overlay-accept" type="button">接听</button>',
                    '      <button class="ak-im-call-overlay-mute" type="button">静音</button>',
                    '      <button class="ak-im-call-overlay-hangup" type="button">挂断</button>',
                    '    </div>',
                    '  </div>',
                    '</div>'
                ].join('');
                panel = wrapper.firstElementChild;
                mountRoot.appendChild(panel);
            }
            this.refs.panel = panel;
            this.refs.title = panel.querySelector('.ak-im-call-overlay-title');
            this.refs.subtitle = panel.querySelector('.ak-im-call-overlay-subtitle');
            this.refs.state = panel.querySelector('.ak-im-call-overlay-state');
            this.refs.accept = panel.querySelector('.ak-im-call-overlay-accept');
            this.refs.reject = panel.querySelector('.ak-im-call-overlay-reject');
            this.refs.hangup = panel.querySelector('.ak-im-call-overlay-hangup');
            this.refs.close = panel.querySelector('.ak-im-call-overlay-close');
            this.refs.mute = panel.querySelector('.ak-im-call-overlay-mute');
            this.refs.localAudio = panel.querySelector('.ak-im-call-overlay-audio');
            this.refs.placeholder = panel.querySelector('.ak-im-call-overlay-placeholder');
            this.refs.pulse = panel.querySelector('.ak-im-call-overlay-pulse');
            this.refs.avatar = panel.querySelector('.ak-im-call-overlay-avatar');
            this.refs.placeholderIcon = panel.querySelector('.ak-im-call-overlay-placeholder-icon');
            this.bindEvents();
            return panel;
        },

        bindEvents() {
            if (this.bound) return;
            this.bound = true;
            const self = this;
            const panel = this.refs.panel;
            if (!panel) return;
            panel.querySelector('.ak-im-call-overlay-backdrop').addEventListener('click', function() { self.close(); });
            this.refs.close.addEventListener('click', function() { self.close(); });
            this.refs.reject.addEventListener('click', function() { self.reject(); });
            this.refs.accept.addEventListener('click', function() { self.accept(); });
            this.refs.hangup.addEventListener('click', function() { self.hangup(); });
            this.refs.mute.addEventListener('click', function() { self.toggleMute(); });
        },

        setState(mode, payload) {
            payload = payload || {};
            this.mode = mode || CALL_MODES.idle;
            this.currentCallId = trim(payload.call_id || payload.callId || this.currentCallId);
            this.currentConversationId = Number(payload.conversation_id || payload.conversationId || this.currentConversationId || 0);
            this.currentPeerName = trim(payload.peer_name || payload.peerName || payload.title || this.currentPeerName || '联系人');
            this.currentPeerUsername = trim(payload.peer_username || payload.peerUsername || this.currentPeerUsername);
            this.currentKind = trim(payload.call_kind || payload.kind || this.currentKind || 'audio') || 'audio';
            this.lastFailReason = trim(payload.reason || payload.fail_reason || this.lastFailReason);
            this.render();
        },

        render() {
            const refs = this.refs;
            if (!refs.panel) return;
            const visible = this.mode !== CALL_MODES.idle;
            const reasonText = this.lastFailReason && CALL_FAIL_REASON_TEXT[this.lastFailReason] ? CALL_FAIL_REASON_TEXT[this.lastFailReason] : '';
            const statusText = this.mode === CALL_MODES.failed && reasonText ? reasonText : (CALL_STATUS_TEXT[this.mode] || '');
            const isIncoming = this.mode === CALL_MODES.incoming;
            const isActive = this.mode === CALL_MODES.active;
            const isPending = this.mode === CALL_MODES.outgoing || this.mode === CALL_MODES.incoming || this.mode === CALL_MODES.connecting;
            refs.panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
            refs.panel.dataset.mode = this.mode;
            refs.title.textContent = this.currentPeerName || '通话';
            refs.subtitle.textContent = statusText;
            refs.state.textContent = statusText;
            refs.accept.style.display = isIncoming ? 'inline-flex' : 'none';
            refs.reject.style.display = isIncoming ? 'inline-flex' : 'none';
            refs.hangup.style.display = isActive || this.mode === CALL_MODES.outgoing || this.mode === CALL_MODES.connecting ? 'inline-flex' : 'none';
            refs.mute.style.display = isActive ? 'inline-flex' : 'none';
            refs.mute.textContent = this.muted ? '取消静音' : '静音';
            refs.placeholder.style.display = 'flex';
            refs.pulse.style.animation = isPending ? 'akImCallOverlayPulse 1.8s ease-in-out infinite' : 'none';
            refs.pulse.style.display = isPending ? 'block' : 'none';
            refs.avatar.style.transform = isPending ? 'scale(1.06)' : 'scale(1)';
            refs.placeholderIcon.style.animation = isPending ? 'akImCallOverlayPulse 1.8s ease-in-out infinite' : 'none';
        },

        openOutgoing(payload) {
            payload = payload || {};
            this.ensureStyle();
            this.ensureShell();
            this.cleanupMedia();
            this.role = 'caller';
            this.muted = false;
            this.offerSent = false;
            this.setState(CALL_MODES.outgoing, payload);
            clearTimeout(this.timers.launch);
            const self = this;
            this.ensureSubmodules().then(function() {
                self.signaling.send('im.call.start', {
                    conversation_id: Number(payload.conversationId || payload.conversation_id || 0),
                    callee_username: trim(payload.peerUsername || payload.peer_username),
                    call_kind: 'audio',
                    ws_id: trim(payload.wsId),
                    page_id: trim(payload.pageId)
                });
                self.timers.launch = global.setTimeout(function() {
                    if (self.mode === CALL_MODES.outgoing && !self.currentCallId) {
                        self.fail('socket_timeout');
                    }
                }, 10000);
            }).catch(function(error) {
                self.fail('unsupported', error && error.message ? error.message : '通话模块不可用');
            });
        },

        openIncoming(payload) {
            this.cleanupMedia();
            this.role = 'callee';
            this.muted = false;
            this.offerSent = false;
            this.setState(CALL_MODES.incoming, payload);
        },

        async accept() {
            if (!this.currentCallId || !this.signaling) return;
            this.setState(CALL_MODES.connecting, {});
            try {
                if (!this.webRTC || !this.webRTC.isSupported()) throw new Error('unsupported');
                await this.webRTC.startLocal('audio');
                this.signaling.send('im.call.accept', {
                    call_id: this.currentCallId,
                    ws_id: trim(this.ctx && this.ctx.state && this.ctx.state.wsId),
                    page_id: trim(this.ctx && this.ctx.state && this.ctx.state.pageId)
                });
            } catch (error) {
                this.fail(error && error.message === 'unsupported' ? 'unsupported' : 'media_denied', error && error.message ? error.message : '');
            }
        },

        reject() {
            if (this.currentCallId && this.signaling) this.signaling.send('im.call.reject', { call_id: this.currentCallId });
            this.end('ended', {});
        },

        hangup() {
            if (this.currentCallId && this.signaling) this.signaling.send('im.call.hangup', { call_id: this.currentCallId });
            this.end('ended', {});
        },

        close() {
            if (this.mode === CALL_MODES.active || this.mode === CALL_MODES.outgoing || this.mode === CALL_MODES.connecting || this.mode === CALL_MODES.incoming) {
                this.hangup();
                return;
            }
            this.reset();
        },

        reset() {
            clearTimeout(this.timers.autoEnd);
            clearTimeout(this.timers.launch);
            this.cleanupMedia();
            this.mode = CALL_MODES.idle;
            this.currentCallId = '';
            this.currentConversationId = 0;
            this.currentPeerUsername = '';
            this.role = '';
            this.muted = false;
            this.offerSent = false;
            this.lastFailReason = '';
            this.render();
        },

        end(reason, payload) {
            payload = payload || {};
            const nextMode = reason === 'failed' ? CALL_MODES.failed : CALL_MODES.ended;
            this.setState(nextMode, payload);
            clearTimeout(this.timers.autoEnd);
            clearTimeout(this.timers.launch);
            this.cleanupMedia();
            const self = this;
            this.timers.autoEnd = global.setTimeout(function() { self.reset(); }, nextMode === CALL_MODES.failed ? 2000 : 1200);
        },

        fail(reason, message) {
            this.lastFailReason = trim(reason || 'socket_error');
            this.end('failed', { reason: this.lastFailReason });
        },

        async startCallerPeer() {
            if (!this.webRTC || this.role !== 'caller') return;
            if (this.offerSent) return;
            this.offerSent = true;
            try {
                this.setState(CALL_MODES.connecting, {});
                await this.webRTC.startLocal('audio');
                await this.webRTC.createOffer('audio');
            } catch (error) {
                this.offerSent = false;
                this.fail('media_denied', error && error.message ? error.message : '');
            }
        },

        async handleSignalEvent(type, payload) {
            payload = payload || {};
            if (type === 'im.call.started') {
                clearTimeout(this.timers.launch);
                this.role = 'caller';
                this.setState(CALL_MODES.outgoing, payload);
                return;
            }
            if (type === 'im.call.ringing') {
                if (this.currentCallId && this.currentCallId !== trim(payload.call_id)) return;
                this.role = 'callee';
                this.openIncoming(payload);
                return;
            }
            if (type === 'im.call.accepted' || type === 'im.call.connected') {
                this.setState(CALL_MODES.connecting, payload);
                if (this.role === 'caller') await this.startCallerPeer();
                return;
            }
            if (type === 'im.call.offer') {
                if (!this.webRTC || !payload.sdp) return;
                this.setState(CALL_MODES.connecting, payload);
                try {
                    await this.webRTC.acceptOffer(payload.sdp, 'audio');
                } catch (error) {
                    this.fail('media_denied', error && error.message ? error.message : '');
                }
                return;
            }
            if (type === 'im.call.answer') {
                if (this.webRTC && payload.sdp) {
                    await this.webRTC.acceptAnswer(payload.sdp);
                    this.setState(CALL_MODES.active, payload);
                }
                return;
            }
            if (type === 'im.call.ice') {
                if (this.webRTC && payload.candidate) await this.webRTC.addIceCandidate(payload.candidate);
                return;
            }
            if (type === 'im.call.updated') {
                this.setState(this.mode, payload);
                return;
            }
            if (type === 'im.call.failed' || type === 'im.call.error') {
                this.fail(trim(payload.reason) || (trim(payload.message) === 'busy' ? 'busy' : 'socket_error'), trim(payload.message));
                return;
            }
            if (type === 'im.call.ended') {
                this.end('ended', payload);
            }
        },

        sendWebRTCSignal(type, payload) {
            if (!this.signaling || !this.currentCallId) return;
            const eventType = type === 'ice' ? 'im.call.ice' : (type === 'answer' ? 'im.call.answer' : 'im.call.offer');
            this.signaling.send(eventType, Object.assign({
                call_id: this.currentCallId,
                conversation_id: this.currentConversationId
            }, payload || {}));
        },

        attachLocalStream(stream) {
            const audio = this.refs.localAudio;
            if (!audio || !stream) return;
            try {
                audio.srcObject = stream;
                audio.muted = true;
            } catch (e) {}
        },

        attachRemoteStream(stream) {
            const audio = this.refs.localAudio;
            if (!audio || !stream) return;
            try {
                audio.srcObject = stream;
                audio.muted = false;
                const playResult = audio.play();
                if (playResult && typeof playResult.catch === 'function') playResult.catch(function() {});
            } catch (e) {}
            this.setState(CALL_MODES.active, {});
        },

        handlePeerState(state) {
            const normalizedState = trim(state).toLowerCase();
            if (normalizedState === 'connected') {
                this.setState(CALL_MODES.active, {});
            }
            if (normalizedState === 'failed' || normalizedState === 'disconnected') {
                this.fail('socket_error');
            }
        },

        toggleMute() {
            this.muted = !this.muted;
            if (this.webRTC && typeof this.webRTC.setMuted === 'function') this.webRTC.setMuted(this.muted);
            if (this.signaling && this.currentCallId) this.signaling.send('im.call.mute', { call_id: this.currentCallId, muted: this.muted });
            this.render();
        },

        cleanupMedia() {
            if (this.webRTC && typeof this.webRTC.close === 'function') this.webRTC.close();
            if (this.refs.localAudio) {
                try { this.refs.localAudio.srcObject = null; } catch (e) {}
            }
        },

        destroy() {
            clearTimeout(this.timers.autoEnd);
            clearTimeout(this.timers.launch);
            this.cleanupMedia();
            if (this.signaling && typeof this.signaling.destroy === 'function') this.signaling.destroy();
            this.signaling = null;
            this.webRTC = null;
            this.submodulePromise = null;
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.callManage = callModule;
})(window);
