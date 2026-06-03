(function(global) {
    'use strict';

    const STYLE_ID = 'ak-im-call-overlay-style';
    const PANEL_SELECTOR = '.ak-im-call-overlay';
    const CALL_MODES = {
        idle: 'idle',
        outgoing: 'outgoing',
        incoming: 'incoming',
        active: 'active',
        ended: 'ended',
        failed: 'failed'
    };

    const CALL_STATUS_TEXT = {
        idle: '',
        outgoing: '等待对方接听',
        incoming: '对方发来通话请求',
        active: '正在通话',
        ended: '通话已结束',
        failed: '通话失败'
    };

    const CALL_FAIL_REASON_TEXT = {
        socket_timeout: '通话请求未得到服务器响应',
        socket_unavailable: '通话服务暂不可用'
    };

    const callModule = {
        ctx: null,
        mode: CALL_MODES.idle,
        currentCallId: '',
        currentConversationId: 0,
        currentPeerName: '',
        currentKind: 'audio',
        socket: null,
        socketReady: false,
        socketToken: '',
        mediaStream: null,
        outboundQueue: [],
        timers: { autoEnd: 0 },
        refs: {},
        lastFailReason: '',
        bound: false,

        init(ctx) {
            this.ctx = ctx || {};
            this.ensureStyle();
            this.ensureShell();
            this.ensureSocket();
            this.render();
        },

        getMountRoot() {
            return document.body || document.documentElement || null;
        },

        getApiBase() {
            if (this.ctx && typeof this.ctx.getApiBase === 'function') return String(this.ctx.getApiBase() || '');
            return '';
        },

        getWsBase() {
            const apiBase = this.getApiBase();
            if (!apiBase) return '';
            try {
                const url = new URL(apiBase, window.location.origin);
                url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
                return url.origin;
            } catch (e) {
                return window.location.origin.replace(/^http/, 'ws');
            }
        },

        ensureStyle() {
            if (document.getElementById(STYLE_ID)) return;
            const styleEl = document.createElement('style');
            styleEl.id = STYLE_ID;
            styleEl.textContent = [
                '.ak-im-call-overlay{position:fixed;inset:0;z-index:2147483646;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(7,10,20,.72);backdrop-filter:blur(12px)}',
                '.ak-im-call-overlay[aria-hidden="false"]{display:flex}',
                '.ak-im-call-overlay-backdrop{position:absolute;inset:0}',
                '.ak-im-call-overlay-card{position:relative;z-index:1;width:min(calc(100vw - 32px),420px);min-height:560px;max-height:min(calc(100vh - 32px),760px);display:flex;flex-direction:column;overflow:hidden;border-radius:28px;background:linear-gradient(180deg,#0b1220 0%,#111827 42%,#020617 100%);color:#fff;box-shadow:0 32px 90px rgba(0,0,0,.42)}',
                '.ak-im-call-overlay-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 16px 10px;background:rgba(255,255,255,.03)}',
                '.ak-im-call-overlay-header-main{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:12px}',
                '.ak-im-call-overlay-spacer{width:36px;height:36px;flex:0 0 36px}',
                '.ak-im-call-overlay-avatar{width:52px;height:52px;border-radius:999px;flex:0 0 auto;background:linear-gradient(135deg,#34d399 0%,#10b981 100%);box-shadow:0 12px 28px rgba(16,185,129,.28);transition:transform .18s ease}',
                '.ak-im-call-overlay-header-text{min-width:0;text-align:center}',
                '.ak-im-call-overlay-title{font-size:18px;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '.ak-im-call-overlay-subtitle{margin-top:6px;font-size:13px;line-height:1.4;color:rgba(255,255,255,.72);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '.ak-im-call-overlay-close{width:36px;height:36px;border:none;border-radius:18px;background:rgba(255,255,255,.12);color:#fff;font-size:24px;line-height:36px;cursor:pointer;flex:0 0 auto}',
                '.ak-im-call-overlay-stage{position:relative;flex:1;display:flex;align-items:center;justify-content:center;padding:18px 18px 12px;background:radial-gradient(circle at top,#1e293b 0%,#0f172a 52%,#020617 100%);overflow:hidden}',
                '.ak-im-call-overlay-pulse{position:absolute;top:50%;left:50%;width:220px;height:220px;border-radius:50%;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(56,189,248,.18) 0%,rgba(56,189,248,0) 70%);opacity:0;pointer-events:none}',
                '.ak-im-call-overlay-placeholder{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;color:rgba(255,255,255,.82)}',
                '.ak-im-call-overlay-placeholder-icon{width:92px;height:92px;border-radius:46px;display:flex;align-items:center;justify-content:center;font-size:38px;background:rgba(255,255,255,.09);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}',
                '.ak-im-call-overlay-placeholder-text{font-size:15px;letter-spacing:.02em}',
                '.ak-im-call-overlay-remote{position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:cover;background:#020617}',
                '.ak-im-call-overlay-local{position:absolute;right:18px;bottom:18px;width:120px;height:160px;display:block;object-fit:cover;border-radius:16px;border:1px solid rgba(255,255,255,.22);box-shadow:0 12px 30px rgba(0,0,0,.35);background:#0b1220}',
                '.ak-im-call-overlay-audio{display:none}',
                '.ak-im-call-overlay-state{padding:10px 18px 0;min-height:26px;font-size:15px;font-weight:500;text-align:center;color:#e2e8f0}',
                '.ak-im-call-overlay-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;padding:18px 18px calc(20px + env(safe-area-inset-bottom, 0px));background:rgba(2,6,23,.94)}',
                '.ak-im-call-overlay-actions button{min-width:92px;height:44px;padding:0 18px;border:none;border-radius:22px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.22)}',
                '.ak-im-call-overlay-reject{background:#ef4444;color:#fff}',
                '.ak-im-call-overlay-accept{background:#22c55e;color:#fff}',
                '.ak-im-call-overlay-hangup{background:#f97316;color:#fff}',
                '.ak-im-call-overlay-mute,.ak-im-call-overlay-camera{background:rgba(255,255,255,.1);color:#fff}',
                '@keyframes akImCallOverlayPulse{0%{transform:translate(-50%,-50%) scale(.82);opacity:.2}50%{transform:translate(-50%,-50%) scale(1.05);opacity:.55}100%{transform:translate(-50%,-50%) scale(1.18);opacity:0}}',
                '@media (max-width:768px){.ak-im-call-overlay{padding:0}.ak-im-call-overlay-card{width:100vw;min-height:100vh;max-height:100vh;border-radius:0;box-shadow:none}.ak-im-call-overlay-stage{padding:14px 14px 10px}.ak-im-call-overlay-local{width:92px;height:122px;right:12px;bottom:12px}.ak-im-call-overlay-actions{gap:10px;padding-left:12px;padding-right:12px}.ak-im-call-overlay-actions button{min-width:84px}.ak-im-call-overlay-title{font-size:17px}.ak-im-call-overlay-avatar{width:40px;height:40px}.ak-im-call-overlay-placeholder-icon{width:84px;height:84px;font-size:34px}}'
            ].join('');
            (document.head || document.documentElement).appendChild(styleEl);
        },

        ensureShell() {
            const mountRoot = this.getMountRoot();
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
                    '      <video class="ak-im-call-overlay-remote" playsinline autoplay></video>',
                    '      <video class="ak-im-call-overlay-local" playsinline autoplay muted></video>',
                    '      <audio class="ak-im-call-overlay-audio" autoplay></audio>',
                    '    </div>',
                    '    <div class="ak-im-call-overlay-state"></div>',
                    '    <div class="ak-im-call-overlay-actions">',
                    '      <button class="ak-im-call-overlay-reject" type="button">拒绝</button>',
                    '      <button class="ak-im-call-overlay-accept" type="button">接听</button>',
                    '      <button class="ak-im-call-overlay-mute" type="button">静音</button>',
                    '      <button class="ak-im-call-overlay-camera" type="button">摄像头</button>',
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
            this.refs.camera = panel.querySelector('.ak-im-call-overlay-camera');
            this.refs.localVideo = panel.querySelector('.ak-im-call-overlay-local');
            this.refs.remoteVideo = panel.querySelector('.ak-im-call-overlay-remote');
            this.refs.localAudio = panel.querySelector('.ak-im-call-overlay-audio');
            this.refs.placeholder = panel.querySelector('.ak-im-call-overlay-placeholder');
            this.refs.pulse = panel.querySelector('.ak-im-call-overlay-pulse');
            this.refs.avatar = panel.querySelector('.ak-im-call-overlay-avatar');
            this.refs.placeholderIcon = panel.querySelector('.ak-im-call-overlay-placeholder-icon');
            this.bindEvents();
            try {
                global.__AKIM_DIAG__ = global.__AKIM_DIAG__ || {};
                global.__AKIM_DIAG__.call_ui_version = 'body-overlay-v1';
            } catch (e) {}
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
            this.refs.camera.addEventListener('click', function() { self.toggleCamera(); });
        },

        ensureSocket() {
            if (this.socket || this.socketReady) return;
            const wsBase = this.getWsBase();
            if (!wsBase) return;
            try {
                const socket = new WebSocket(wsBase.replace(/\/$/, '') + '/im/ws');
                this.socket = socket;
                const self = this;
                socket.addEventListener('open', function() {
                    self.socketReady = true;
                    self.flushQueue();
                });
                socket.addEventListener('message', function(event) {
                    self.handleSocketMessage(event.data);
                });
                socket.addEventListener('close', function() {
                    self.socketReady = false;
                    self.socket = null;
                });
                socket.addEventListener('error', function() {
                    self.socketReady = false;
                });
            } catch (e) {
                this.socket = null;
                this.socketReady = false;
            }
        },

        flushQueue() {
            if (!this.socketReady || !this.socket || this.socket.readyState !== 1) return;
            while (this.outboundQueue.length > 0) {
                const payload = this.outboundQueue.shift();
                try {
                    this.socket.send(JSON.stringify(payload));
                } catch (e) {
                    break;
                }
            }
        },

        send(type, payload) {
            const message = { type: type, payload: payload || {} };
            if (!this.socket || !this.socketReady || this.socket.readyState !== 1) {
                this.outboundQueue.push(message);
                this.ensureSocket();
                return;
            }
            try {
                this.socket.send(JSON.stringify(message));
            } catch (e) {
                this.outboundQueue.push(message);
            }
        },

        handleSocketMessage(raw) {
            let data = null;
            try {
                data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            } catch (e) {
                return;
            }
            if (!data || typeof data !== 'object') return;
            if (typeof data.type !== 'string') return;
            if (!data.type.startsWith('im.call.')) return;
            const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
            switch (data.type) {
                case 'im.call.started':
                    this.openActive(payload, 'outgoing');
                    break;
                case 'im.call.ringing':
                    this.openIncoming(payload);
                    break;
                case 'im.call.accepted':
                case 'im.call.connected':
                    this.openActive(payload, 'active');
                    break;
                case 'im.call.ended':
                    this.end('ended', payload);
                    break;
                case 'im.call.failed':
                case 'im.call.error':
                    this.end('failed', payload);
                    break;
                default:
                    break;
            }
        },

        setState(mode, payload) {
            payload = payload || {};
            this.mode = mode || CALL_MODES.idle;
            this.currentCallId = String(payload.call_id || payload.callId || this.currentCallId || '');
            this.currentConversationId = Number(payload.conversation_id || payload.conversationId || this.currentConversationId || 0);
            this.currentPeerName = String(payload.peer_name || payload.peerName || payload.title || this.currentPeerName || '联系人');
            this.currentKind = String(payload.call_kind || payload.kind || this.currentKind || 'audio');
            this.lastFailReason = String(payload.reason || payload.fail_reason || '').trim();
            this.ensureStyle();
            this.ensureShell();
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
            const isPending = this.mode === CALL_MODES.outgoing || this.mode === CALL_MODES.incoming;
            refs.panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
            refs.panel.dataset.mode = this.mode;
            if (refs.title) refs.title.textContent = this.currentPeerName || '通话';
            if (refs.subtitle) refs.subtitle.textContent = statusText;
            if (refs.state) refs.state.textContent = statusText;
            if (refs.accept) refs.accept.style.display = isIncoming ? 'inline-flex' : 'none';
            if (refs.reject) refs.reject.style.display = isIncoming ? 'inline-flex' : 'none';
            if (refs.hangup) refs.hangup.style.display = this.mode === CALL_MODES.active || this.mode === CALL_MODES.outgoing ? 'inline-flex' : 'none';
            if (refs.mute) refs.mute.style.display = isActive ? 'inline-flex' : 'none';
            if (refs.camera) refs.camera.style.display = isActive ? 'inline-flex' : 'none';
            if (refs.remoteVideo) refs.remoteVideo.style.display = isActive ? 'block' : 'none';
            if (refs.localVideo) refs.localVideo.style.display = isActive ? 'block' : 'none';
            if (refs.placeholder) refs.placeholder.style.display = isActive ? 'none' : 'flex';
            if (refs.pulse) {
                refs.pulse.style.animation = isPending ? 'akImCallOverlayPulse 1.8s ease-in-out infinite' : 'none';
                refs.pulse.style.display = isPending ? 'block' : 'none';
            }
            if (refs.avatar) refs.avatar.style.transform = isPending ? 'scale(1.06)' : 'scale(1)';
            if (refs.placeholderIcon) refs.placeholderIcon.style.animation = isPending ? 'akImCallOverlayPulse 1.8s ease-in-out infinite' : 'none';
        },

        openOutgoing(payload) {
            payload = payload || {};
            this.setState(CALL_MODES.outgoing, payload);
            this.ensureSocket();
            clearTimeout(this.timers.autoEnd);
            const self = this;
            this.timers.autoEnd = window.setTimeout(function() {
                if (self.mode === CALL_MODES.outgoing && !self.currentCallId) {
                    self.end('failed', {
                        call_id: '',
                        conversation_id: self.currentConversationId,
                        peer_name: self.currentPeerName,
                        call_kind: self.currentKind,
                        reason: 'socket_timeout'
                    });
                }
            }, 8000);
            this.send('im.call.start', {
                conversation_id: Number(payload.conversationId || payload.conversation_id || 0),
                callee_username: String(payload.peerUsername || payload.peer_username || ''),
                call_kind: String(payload.kind || 'audio'),
                ws_id: String(payload.wsId || ''),
                page_id: String(payload.pageId || ''),
                peer_name: String(payload.title || payload.peerName || '联系人')
            });
        },

        openIncoming(payload) {
            payload = payload || {};
            this.setState(CALL_MODES.incoming, payload);
        },

        openActive(payload, fallbackMode) {
            payload = payload || {};
            this.setState(fallbackMode || CALL_MODES.active, payload);
        },

        accept() {
            if (!this.currentCallId) return;
            this.send('im.call.accept', { call_id: this.currentCallId });
            this.setState(CALL_MODES.active, {
                call_id: this.currentCallId,
                conversation_id: this.currentConversationId,
                peer_name: this.currentPeerName,
                call_kind: this.currentKind
            });
        },

        reject() {
            if (this.currentCallId) this.send('im.call.reject', { call_id: this.currentCallId });
            this.end('ended', {});
        },

        hangup() {
            if (this.currentCallId) this.send('im.call.hangup', { call_id: this.currentCallId });
            this.end('ended', {});
        },

        close() {
            clearTimeout(this.timers.autoEnd);
            this.mode = CALL_MODES.idle;
            this.currentCallId = '';
            this.lastFailReason = '';
            this.render();
        },

        end(reason, payload) {
            payload = payload || {};
            const nextMode = reason === 'failed' ? CALL_MODES.failed : CALL_MODES.ended;
            this.setState(nextMode, {
                call_id: this.currentCallId,
                conversation_id: this.currentConversationId,
                peer_name: this.currentPeerName,
                call_kind: this.currentKind,
                ...payload
            });
            clearTimeout(this.timers.autoEnd);
            const self = this;
            this.timers.autoEnd = window.setTimeout(function() {
                self.mode = CALL_MODES.idle;
                self.currentCallId = '';
                self.lastFailReason = '';
                self.render();
            }, nextMode === CALL_MODES.failed ? 1800 : 1200);
        },

        toggleMute() {
            if (!this.currentCallId) return;
            this.send('im.call.mute', { call_id: this.currentCallId, muted: true });
        },

        toggleCamera() {
            if (!this.currentCallId) return;
            this.send('im.call.camera', { call_id: this.currentCallId });
        },

        destroy() {
            clearTimeout(this.timers.autoEnd);
            if (this.socket) {
                try { this.socket.close(); } catch (e) {}
            }
            this.socket = null;
            this.socketReady = false;
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.callManage = callModule;
})(window);
