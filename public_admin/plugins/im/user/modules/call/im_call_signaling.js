(function(global) {
    'use strict';

    const signalingModule = {
        socket: null,
        socketReady: false,
        socketConnecting: false,
        socketToken: 0,
        outboundQueue: [],
        options: {},

        init(options) {
            this.options = options || {};
            this.ensureSocket();
            return this;
        },

        getWsURL() {
            if (this.options && typeof this.options.getWsURL === 'function') {
                const value = this.options.getWsURL();
                if (value && typeof value.then === 'function') {
                    return value.then(function(url) { return String(url || ''); });
                }
                return String(value || '');
            }
            return '';
        },

        ensureSocket() {
            if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
            if (this.socketConnecting) return;
            let wsURL = '';
            const token = Number(this.socketToken || 0) + 1;
            this.socketToken = token;
            try {
                wsURL = this.getWsURL();
            } catch (error) {
                this.emitError('socket_error', error && error.message ? error.message : '通话信令初始化失败');
                return;
            }
            const self = this;
            if (wsURL && typeof wsURL.then === 'function') {
                this.socketConnecting = true;
                wsURL.then(function(resolvedURL) {
                    if (Number(self.socketToken || 0) !== token) return;
                    self.socketConnecting = false;
                    self.openSocket(resolvedURL, token);
                }).catch(function(error) {
                    if (Number(self.socketToken || 0) !== token) return;
                    self.socketConnecting = false;
                    self.socketReady = false;
                    self.emitError('socket_error', error && error.message ? error.message : '通话信令初始化失败');
                });
                return;
            }
            this.openSocket(wsURL, token);
        },

        openSocket(wsURL, token) {
            if (Number(this.socketToken || 0) !== Number(token || 0)) return;
            wsURL = String(wsURL || '');
            if (!wsURL) {
                this.emitError('socket_unavailable', '通话服务地址不可用');
                return;
            }
            try {
                const socket = new WebSocket(wsURL);
                this.socket = socket;
                const self = this;
                socket.addEventListener('open', function() {
                    if (self.socket !== socket || Number(self.socketToken || 0) !== Number(token || 0)) return;
                    self.socketReady = true;
                    self.flushQueue();
                });
                socket.addEventListener('message', function(event) {
                    if (self.socket !== socket || Number(self.socketToken || 0) !== Number(token || 0)) return;
                    self.handleMessage(event.data);
                });
                socket.addEventListener('close', function() {
                    if (Number(self.socketToken || 0) !== Number(token || 0)) return;
                    self.socketReady = false;
                    if (self.socket === socket) self.socket = null;
                });
                socket.addEventListener('error', function() {
                    if (self.socket !== socket || Number(self.socketToken || 0) !== Number(token || 0)) return;
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
            this.socketConnecting = false;
            this.socketToken += 1;
            if (this.socket) {
                try { this.socket.close(); } catch (e) {}
            }
            this.socket = null;
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.callSignaling = signalingModule;
})(window);
