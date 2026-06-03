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
    const SUBMODULES = [
        {
            key: 'callSignaling',
            datasetKey: 'akImUserPluginCallSignaling',
            src: '/chat/plugins/im/user/modules/call/im_call_signaling.js'
        },
        {
            key: 'callWebRTC',
            datasetKey: 'akImUserPluginCallWebRTC',
            src: '/chat/plugins/im/user/modules/call/im_call_webrtc.js'
        }
    ];

    function trim(value) {
        return String(value || '').trim();
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
            this.ensureSubmodules();
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

        loadScriptOnce(config) {
            const modules = global.AKIMUserModules || {};
            if (modules[config.key]) return Promise.resolve(modules[config.key]);
            const selector = 'script[data-' + config.datasetKey.replace(/[A-Z]/g, function(ch) {
                return '-' + ch.toLowerCase();
            }) + '="1"]';
            const existingScript = document.querySelector(selector);
            if (existingScript) {
                return new Promise(function(resolve, reject) {
                    existingScript.addEventListener('load', function() {
                        const loaded = (global.AKIMUserModules || {})[config.key];
                        loaded ? resolve(loaded) : reject(new Error('通话子模块加载失败'));
                    }, { once: true });
                    existingScript.addEventListener('error', function() {
                        reject(new Error('通话子模块加载失败'));
                    }, { once: true });
                });
            }
            const url = new URL(config.src, this.getAssetBase());
            const script = document.createElement('script');
            script.src = url.toString();
            script.async = true;
            script.dataset[config.datasetKey] = '1';
            return new Promise(function(resolve, reject) {
                script.onload = function() {
                    const loaded = (global.AKIMUserModules || {})[config.key];
                    loaded ? resolve(loaded) : reject(new Error('通话子模块加载失败'));
                };
                script.onerror = function() {
                    reject(new Error('通话子模块加载失败'));
                };
                (document.head || document.documentElement || document.body).appendChild(script);
            });
        },

        ensureSubmodules() {
            if (this.submodulePromise) return this.submodulePromise;
            const self = this;
            this.submodulePromise = Promise.all(SUBMODULES.map(function(config) {
                return self.loadScriptOnce(config);
            })).then(function(items) {
                self.signaling = items[0];
                self.webRTC = items[1];
                self.initSignaling();
                self.initWebRTC();
                return { signaling: self.signaling, webRTC: self.webRTC };
            }).catch(function(error) {
                self.submodulePromise = null;
                self.fail('unsupported', error && error.message ? error.message : '通话模块不可用');
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
                self.fail('unsupported', error && error.message ? error.message : '');
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
            if (message) this.reportLaunchError(message, { reason: reason || '' });
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
