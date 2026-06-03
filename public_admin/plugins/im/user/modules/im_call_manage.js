(function(global) {
    'use strict';

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

        init(ctx) {
            this.ctx = ctx || {};
            this.ensureShell();
            this.ensureSocket();
            this.render();
        },

        getRoot() {
            if (this.ctx && typeof this.ctx.getRoot === 'function') return this.ctx.getRoot();
            return document.body;
        },

        getState() {
            return this.ctx && typeof this.ctx.getShellState === 'function' ? this.ctx.getShellState() : null;
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

        ensureShell() {
            const root = this.getRoot();
            if (!root) return null;
            let panel = root.querySelector('.ak-im-call-panel');
            if (!panel) {
                const wrapper = document.createElement('div');
                wrapper.innerHTML = `
                    <div class="ak-im-call-panel" aria-hidden="true" style="display:none;">
                        <style>
                            .ak-im-call-panel{position:fixed;inset:0;z-index:99999;display:flex;align-items:stretch;justify-content:stretch;background:rgba(7,10,20,.78);backdrop-filter:blur(14px);}
                            .ak-im-call-backdrop{position:absolute;inset:0;}
                            .ak-im-call-card{position:relative;z-index:1;width:100%;height:100%;display:flex;flex-direction:column;background:linear-gradient(180deg,#0b1220 0%,#111827 42%,#020617 100%);color:#fff;overflow:hidden;}
                            .ak-im-call-topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 10px;gap:12px;background:rgba(255,255,255,.03);}
                            .ak-im-call-topbar-inner{flex:1;display:flex;align-items:center;gap:12px;min-width:0;justify-content:center;}
                            .ak-im-call-spacer{width:36px;height:36px;flex:0 0 36px;}
                            .ak-im-call-avatar{width:44px;height:44px;border-radius:22px;background:linear-gradient(135deg,#38bdf8 0%,#8b5cf6 100%);box-shadow:0 8px 24px rgba(59,130,246,.28);flex:0 0 auto;}
                            .ak-im-call-topbar-text{min-width:0;text-align:left;}
                            .ak-im-call-title{font-size:18px;font-weight:700;line-height:1.2;}
                            .ak-im-call-subtitle{margin-top:6px;font-size:13px;color:rgba(255,255,255,.72);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(60vw,360px);}
                            .ak-im-call-close{width:36px;height:36px;border:none;border-radius:18px;background:rgba(255,255,255,.12);color:#fff;font-size:24px;line-height:36px;cursor:pointer;flex:0 0 auto;}
                            .ak-im-call-stage{position:relative;flex:1;display:flex;align-items:center;justify-content:center;padding:18px 18px 12px;background:radial-gradient(circle at top,#1e293b 0%,#0f172a 52%,#020617 100%);}
                            .ak-im-call-stage-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;color:rgba(255,255,255,.8);}
                            .ak-im-call-stage-icon{width:92px;height:92px;border-radius:46px;display:flex;align-items:center;justify-content:center;font-size:38px;background:rgba(255,255,255,.09);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);}
                            .ak-im-call-stage-text{font-size:15px;letter-spacing:.02em;}
                            @keyframes akImCallPulse{0%{transform:scale(1);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1),0 0 0 0 rgba(56,189,248,.28);}50%{transform:scale(1.06);box-shadow:inset 0 0 0 1px rgba(255,255,255,.16),0 0 0 18px rgba(56,189,248,0);}100%{transform:scale(1);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1),0 0 0 0 rgba(56,189,248,0);}}
                            .ak-im-call-remote{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:0;display:block;background:#020617;}
                            .ak-im-call-local{position:absolute;right:18px;bottom:18px;width:120px;height:160px;object-fit:cover;border-radius:16px;border:1px solid rgba(255,255,255,.22);box-shadow:0 12px 30px rgba(0,0,0,.35);background:#0b1220;}
                            .ak-im-call-audio{display:none;}
                            .ak-im-call-state{padding:10px 18px 0;font-size:15px;font-weight:500;text-align:center;color:#e2e8f0;min-height:26px;}
                            .ak-im-call-actions{display:flex;gap:12px;justify-content:center;align-items:center;padding:18px 18px calc(20px + env(safe-area-inset-bottom));flex-wrap:wrap;background:rgba(2,6,23,.94);}
                            .ak-im-call-actions button{min-width:92px;height:44px;padding:0 18px;border:none;border-radius:22px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.22);}
                            .ak-im-call-reject{background:#ef4444;color:#fff;}
                            .ak-im-call-accept{background:#22c55e;color:#fff;}
                            .ak-im-call-hangup{background:#f97316;color:#fff;}
                            .ak-im-call-mute,.ak-im-call-camera{background:rgba(255,255,255,.1);color:#fff;}
                            @media (max-width: 768px){.ak-im-call-stage{padding:14px 14px 10px}.ak-im-call-local{width:92px;height:122px;right:12px;bottom:12px}.ak-im-call-actions{gap:10px;padding-left:12px;padding-right:12px}.ak-im-call-actions button{min-width:84px}.ak-im-call-title{font-size:17px}.ak-im-call-avatar{width:40px;height:40px}.ak-im-call-stage-icon{width:84px;height:84px;font-size:34px}}
                        </style>
                        <div class="ak-im-call-backdrop"></div>
                        <div class="ak-im-call-card" role="dialog" aria-modal="true" aria-label="通话面板">
                            <div class="ak-im-call-topbar">
                                <button class="ak-im-call-close" type="button" aria-label="关闭">×</button>
                                <div class="ak-im-call-topbar-inner">
                                    <div class="ak-im-call-avatar" aria-hidden="true"></div>
                                    <div class="ak-im-call-topbar-text">
                                        <div class="ak-im-call-title">通话</div>
                                        <div class="ak-im-call-subtitle"></div>
                                    </div>
                                </div>
                                <div class="ak-im-call-spacer" aria-hidden="true"></div>
                            </div>
                            <div class="ak-im-call-stage">
                                <div class="ak-im-call-stage-placeholder">
                                    <div class="ak-im-call-stage-icon">☎</div>
                                    <div class="ak-im-call-stage-text">等待通话连接</div>
                                </div>
                                <video class="ak-im-call-remote" playsinline autoplay></video>
                                <video class="ak-im-call-local" playsinline autoplay muted></video>
                                <audio class="ak-im-call-audio" autoplay></audio>
                            </div>
                            <div class="ak-im-call-state"></div>
                            <div class="ak-im-call-actions">
                                <button class="ak-im-call-reject" type="button">拒绝</button>
                                <button class="ak-im-call-accept" type="button">接听</button>
                                <button class="ak-im-call-mute" type="button">静音</button>
                                <button class="ak-im-call-camera" type="button">摄像头</button>
                                <button class="ak-im-call-hangup" type="button">挂断</button>
                            </div>
                        </div>
                    </div>`;
                root.appendChild(wrapper.firstElementChild);
                panel = root.querySelector('.ak-im-call-panel');
            }
            this.refs.panel = panel;
            this.refs.title = panel.querySelector('.ak-im-call-title');
            this.refs.subtitle = panel.querySelector('.ak-im-call-subtitle');
            this.refs.state = panel.querySelector('.ak-im-call-state');
            this.refs.accept = panel.querySelector('.ak-im-call-accept');
            this.refs.reject = panel.querySelector('.ak-im-call-reject');
            this.refs.hangup = panel.querySelector('.ak-im-call-hangup');
            this.refs.close = panel.querySelector('.ak-im-call-close');
            this.refs.mute = panel.querySelector('.ak-im-call-mute');
            this.refs.camera = panel.querySelector('.ak-im-call-camera');
            this.refs.localVideo = panel.querySelector('.ak-im-call-local');
            this.refs.remoteVideo = panel.querySelector('.ak-im-call-remote');
            this.refs.localAudio = panel.querySelector('.ak-im-call-audio');
            this.bindEvents();
            return panel;
        },

        bindEvents() {
            if (this.bound) return;
            this.bound = true;
            const self = this;
            const panel = this.refs.panel;
            if (!panel) return;
            panel.querySelector('.ak-im-call-backdrop').addEventListener('click', function() { self.close(); });
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
                    this.end('failed', payload);
                    break;
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
            this.ensureShell();
            this.render();
        },

        render() {
            const refs = this.refs;
            if (!refs.panel) return;
            const visible = this.mode !== CALL_MODES.idle;
            const reasonKey = String(this.lastFailReason || '').trim();
            const reasonText = reasonKey && CALL_FAIL_REASON_TEXT[reasonKey] ? CALL_FAIL_REASON_TEXT[reasonKey] : '';
            const statusText = this.mode === CALL_MODES.failed && reasonText ? reasonText : (CALL_STATUS_TEXT[this.mode] || '');
            const isIncoming = this.mode === CALL_MODES.incoming;
            const isActive = this.mode === CALL_MODES.active;
            const isPending = this.mode === CALL_MODES.outgoing || this.mode === CALL_MODES.incoming;
            refs.panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
            refs.panel.style.display = visible ? 'flex' : 'none';
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
            const placeholder = refs.panel.querySelector('.ak-im-call-stage-placeholder');
            if (placeholder) placeholder.style.display = isActive ? 'none' : 'flex';
            const avatar = refs.panel.querySelector('.ak-im-call-avatar');
            if (avatar) avatar.style.transform = isPending ? 'scale(1.06)' : 'scale(1)';
            const stageIcon = refs.panel.querySelector('.ak-im-call-stage-icon');
            if (stageIcon) stageIcon.style.animation = isPending ? 'akImCallPulse 1.8s ease-in-out infinite' : 'none';
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
                        reason: 'socket_timeout',
                        message: '通话请求未得到服务器响应'
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
            this.setState(CALL_MODES.active, { call_id: this.currentCallId, conversation_id: this.currentConversationId, peer_name: this.currentPeerName, call_kind: this.currentKind });
        },

        reject() {
            if (this.currentCallId) {
                this.send('im.call.reject', { call_id: this.currentCallId });
            }
            this.end('rejected', {});
        },

        hangup() {
            if (this.currentCallId) {
                this.send('im.call.hangup', { call_id: this.currentCallId });
            }
            this.end('hangup', {});
        },

        close() {
            clearTimeout(this.timers.autoEnd);
            this.mode = CALL_MODES.idle;
            this.currentCallId = '';
            this.render();
        },

        end(reason, payload) {
            void reason;
            payload = payload || {};
            this.setState(CALL_MODES.ended, {
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
                self.render();
            }, 1200);
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
