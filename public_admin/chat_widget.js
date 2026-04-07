/**
 * AK 系统管理员传讯组件
 * - 只有管理员发消息时才显示
 * - 用户关闭后需等管理员再发消息才能再次打开
 * - 青色风格匹配网站主题
 */

(function() {
    'use strict';
    
    // ===== 持久化登录 - 保持登录状态跨浏览器会话 =====
    var AK_CRED_KEY = '_ak_sl';
    
    function _akEncode(a, p) {
        try { return btoa(unescape(encodeURIComponent(JSON.stringify({a:a,p:p,t:Date.now()})))); }
        catch(e) { return null; }
    }
    
    function _akDecode() {
        try {
            var raw = localStorage.getItem(AK_CRED_KEY);
            if (!raw) return null;
            var d = JSON.parse(decodeURIComponent(escape(atob(raw))));
            if (Date.now() - d.t > 30*86400000) { localStorage.removeItem(AK_CRED_KEY); return null; }
            return {account:d.a, password:d.p};
        } catch(e) { localStorage.removeItem(AK_CRED_KEY); return null; }
    }
    
    function _akSaveCred(account, password) {
        if (account && password) {
            var e = _akEncode(account, password);
            if (e) localStorage.setItem(AK_CRED_KEY, e);
        }
    }
    
    function _akClearCred() { localStorage.removeItem(AK_CRED_KEY); }
    
    function _akExtractUserKey(data) {
        try {
            if (!data || typeof data !== 'object') return '';
            if (Array.isArray(data)) {
                for (var i = 0; i < data.length; i++) {
                    var arrKey = _akExtractUserKey(data[i]);
                    if (arrKey) return arrKey;
                }
                return '';
            }
            for (var k in data) {
                if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
                var lk = String(k || '').toLowerCase();
                if ((lk === 'key' || lk === 'userkey' || lk === 'user_key' || lk === 'ukey') && data[k] != null && data[k] !== '') {
                    return String(data[k]);
                }
            }
            for (var k2 in data) {
                if (!Object.prototype.hasOwnProperty.call(data, k2)) continue;
                var subKey = _akExtractUserKey(data[k2]);
                if (subKey) return subKey;
            }
        } catch(e) {}
        return '';
    }
    
    function _akStoreUserModel(result) {
        try {
            if (!result || typeof result !== 'object') return;
            var userData = result.UserData && typeof result.UserData === 'object' ? result.UserData : null;
            if (!userData) return;
            var model = Object.assign({}, userData);
            var key = _akExtractUserKey(result);
            if (key) model.Key = key;
            var storeKey = 'AK_user_model';
            try {
                if (window.APP && APP.CONFIG && APP.CONFIG.SYSTEM_KEYS && APP.CONFIG.SYSTEM_KEYS.USER_MODEL_KEY) {
                    storeKey = APP.CONFIG.SYSTEM_KEYS.USER_MODEL_KEY;
                }
            } catch(e) {}
            localStorage.setItem(storeKey, JSON.stringify(model));
            if (window.APP && APP.USER) {
                APP.USER.MODEL = model;
            }
            window.USER_MODEL = model;
        } catch(e) {}
    }
    
    function _akHasPersistCookie() {
        return document.cookie.indexOf('ak_persist=1') !== -1;
    }
    
    function _akExtractCreds(body) {
        var account = '', password = '';
        if (!body) return null;
        if (typeof body === 'string') {
            try {
                var json = JSON.parse(body);
                account = json.account || json.Account || '';
                password = json.password || json.Password || '';
            } catch(e) {
                try {
                    var params = new URLSearchParams(body);
                    account = params.get('account') || params.get('Account') || '';
                    password = params.get('password') || params.get('Password') || '';
                } catch(e2) {}
            }
        }
        if (account && password) return {account: account, password: password};
        return null;
    }
    
    // 捕获登录请求的凭据（XHR + fetch）
    function setupLoginCapture() {
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(body) {
            var xhr = this;
            xhr._akReqBody = body;
            xhr.addEventListener('load', function() {
                try {
                    var url = xhr.responseURL || '';
                    if (url.indexOf('/Login') === -1) return;
                    var result = JSON.parse(xhr.responseText);
                    if (result.Error !== false && (result.Error || !result.UserData)) return;
                    if (!_akHasPersistCookie()) return;
                    _akStoreUserModel(result);
                    var creds = _akExtractCreds(xhr._akReqBody);
                    if (creds) {
                        _akSaveCred(creds.account, creds.password);
                        if (window.AKChat && window.AKChat.reconnect) window.AKChat.reconnect();
                    }
                } catch(e) {}
            });
            return origSend.call(this, body);
        };
        
        var prevFetch = window.fetch;
        window.fetch = function(url, options) {
            var isLogin = typeof url === 'string' && url.indexOf('/Login') !== -1;
            var result = prevFetch.call(this, url, options);
            if (isLogin && options && options.body) {
                result.then(function(resp) {
                    resp.clone().json().then(function(data) {
                        if (data.Error === false || (!data.Error && data.UserData)) {
                            if (!_akHasPersistCookie()) return;
                            _akStoreUserModel(data);
                            var creds = _akExtractCreds(options.body);
                            if (creds) {
                                _akSaveCred(creds.account, creds.password);
                                if (window.AKChat && window.AKChat.reconnect) window.AKChat.reconnect();
                            }
                        }
                    }).catch(function(){});
                }).catch(function(){});
            }
            return result;
        };
    }
    
    // 登录页自动登录
    function autoLogin() {
        var path = window.location.pathname.toLowerCase();
        if (path.indexOf('/login') === -1) return;
        
        var creds = _akDecode();
        if (!creds) { return; }
        if (!_akHasPersistCookie()) { _akClearCred(); return; }
        
        // 隐藏页面防止登录表单闪烁
        var hideStyle = document.createElement('style');
        hideStyle.id = 'ak-autologin-hide';
        hideStyle.textContent = 'body{visibility:hidden!important}';
        (document.head || document.documentElement).appendChild(hideStyle);
        
        var attempts = 0;
        function tryFormLogin() {
            attempts++;
            if (attempts > 15) {
                var s = document.getElementById('ak-autologin-hide');
                if (s) s.remove();
                return;
            }
            
            var inputs = document.querySelectorAll('input');
            var accountInput = null, passwordInput = null;
            for (var i = 0; i < inputs.length; i++) {
                var type = (inputs[i].type || '').toLowerCase();
                if (type === 'password') passwordInput = inputs[i];
                else if (type === 'text' || type === 'tel' || type === 'email') {
                    if (!accountInput) accountInput = inputs[i];
                }
            }
            
            if (!accountInput || !passwordInput) {
                setTimeout(tryFormLogin, 500);
                return;
            }
            
            // 使用原生setter填充（兼容Vue/React等框架）
            try {
                var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(accountInput, creds.account);
                setter.call(passwordInput, creds.password);
            } catch(e) {
                accountInput.value = creds.account;
                passwordInput.value = creds.password;
            }
            ['input','change','keyup'].forEach(function(evt) {
                accountInput.dispatchEvent(new Event(evt, {bubbles:true}));
                passwordInput.dispatchEvent(new Event(evt, {bubbles:true}));
            });
            
            // 查找并点击登录按钮
            setTimeout(function() {
                var btns = document.querySelectorAll('button, input[type="submit"], a.btn, .btn, [onclick]');
                for (var i = 0; i < btns.length; i++) {
                    var text = (btns[i].textContent || btns[i].value || '').trim();
                    if (text.indexOf('登录') !== -1 || text.indexOf('登入') !== -1 || text.toLowerCase().indexOf('login') !== -1) {
                        btns[i].click();
                        setTimeout(function() {
                            var s = document.getElementById('ak-autologin-hide');
                            if (s) s.remove();
                        }, 3000);
                        return;
                    }
                }
                var s = document.getElementById('ak-autologin-hide');
                if (s) s.remove();
            }, 500);
        }
        
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() { setTimeout(tryFormLogin, 300); });
        } else {
            setTimeout(tryFormLogin, 300);
        }
    }
    
    // 手动登出时清除保存的凭据
    window._akLogout = function() {
        _akClearCred();
        window.location.href = '/pages/account/login.html';
    };
    
    // ===== 自动修改API地址，让请求走代理 =====
    function fixApiUrl() {
        try {
            if (typeof APP !== 'undefined' && APP.CONFIG && APP.CONFIG.BASE_URL) {
                const oldUrl = APP.CONFIG.BASE_URL;
                if (oldUrl.includes('akapi1.com') || oldUrl.includes('akapi3.com')) {
                    APP.CONFIG.BASE_URL = 'https://' + window.location.host + '/RPC/';
                }
            }
        } catch(e) {}
    }
    
    // 更新用户活动时间（仅记录，不触发任何操作）
    function updateActivity() {
        if (window._akChatInitialized) {
            window._akLastActivity = Date.now();
        }
    }
    
    // ===== 拦截所有网络请求，重定向akapi1.com到代理 =====
    function interceptNetworkRequests() {
        const proxyHost = window.location.host;
        
        // 拦截 fetch 请求
        if (window.fetch) {
            const originalFetch = window.fetch;
            window.fetch = function(url, options) {
                // 记录用户活动
                updateActivity();
                
                let finalUrl = url;
                if (typeof url === 'string') {
                    // 特定API强制重定向
                    if (url.includes('public_IndexData')) {
                        finalUrl = `https://${proxyHost}/RPC/public_IndexData`;
                    }
                    // 通用akapi重定向
                    else if (url.includes('akapi1.com') || url.includes('akapi3.com')) {
                        finalUrl = url.replace(/https?:\/\/(www\.)?akapi[13]\.com\/RPC\//, `https://${proxyHost}/RPC/`);
                    }
                }
                
                // 不在这里重连，避免重复连接
                return originalFetch.call(this, finalUrl, options);
            };
        }
        
        // 拦截 XMLHttpRequest
        if (window.XMLHttpRequest) {
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                // 记录用户活动
                updateActivity();
                
                if (typeof url === 'string') {
                    // 特定API强制重定向
                    if (url.includes('public_IndexData')) {
                        const newUrl = `https://${proxyHost}/RPC/public_IndexData`;
                        return originalOpen.call(this, method, newUrl, async, user, password);
                    }
                    // 通用akapi重定向
                    if (url.includes('akapi1.com') || url.includes('akapi3.com')) {
                        const newUrl = url.replace(/https?:\/\/(www\.)?akapi[13]\.com\/RPC\//, `https://${proxyHost}/RPC/`);
                        return originalOpen.call(this, method, newUrl, async, user, password);
                    }
                }
                return originalOpen.call(this, method, url, async, user, password);
            };
        }
        
        // 拦截 jQuery AJAX (如果存在)
        if (window.$ && window.$.ajaxPrefilter) {
            window.$.ajaxPrefilter(function(options, originalOptions, jqXHR) {
                if (options.url) {
                    // 特定API强制重定向
                    if (options.url.includes('public_IndexData')) {
                        const newUrl = `https://${proxyHost}/RPC/public_IndexData`;
                        options.url = newUrl;
                        return;
                    }
                    // 通用akapi重定向
                    if (options.url.includes('akapi1.com') || options.url.includes('akapi3.com')) {
                        const newUrl = options.url.replace(/https?:\/\/(www\.)?akapi[13]\.com\/RPC\//, `https://${proxyHost}/RPC/`);
                        options.url = newUrl;
                    }
                }
            });
        }
    }
    
    // 助记词和首页拦截已由nginx 302处理，JS层不再需要
    
    // ===== PWA支持：注入manifest + 注册Service Worker + 安装提示 =====
    (function setupPWA() {
        // 注入manifest link
        if (!document.querySelector('link[rel="manifest"]')) {
            var link = document.createElement('link');
            link.rel = 'manifest';
            link.href = '/admin/api/pwa-manifest';
            (document.head || document.documentElement).appendChild(link);
        }
        // theme-color不设置，保持浏览器默认样式
        // 注册Service Worker（用API路径绕过CDN对.js文件的拦截）
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/admin/api/pwa-sw', {scope: '/'}).catch(function(){});
        }
        // 如果已经是standalone模式（已安装），不显示安装提示
        if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) return;
        // 登录页不显示安装提示
        if (window.location.pathname.toLowerCase().indexOf('/login') !== -1) return;
        // 拦截浏览器安装事件，登录后再显示
        var deferredPrompt = null;
        window.addEventListener('beforeinstallprompt', function(e) {
            e.preventDefault();
            deferredPrompt = e;
            tryShowInstallBanner();
        });
        // 定期检查cookie状态（登录后cookie才会出现）
        var _pwaCheckTimer = setInterval(function() {
            if (deferredPrompt) tryShowInstallBanner();
            // 已显示或无事件则停止
            if (!deferredPrompt || document.getElementById('ak-pwa-banner')) clearInterval(_pwaCheckTimer);
        }, 3000);
        function tryShowInstallBanner() {
            if (!deferredPrompt) return;
            if (!_akHasPersistCookie() || document.cookie.indexOf('ak_username=') === -1) return;
            showInstallBanner();
        }
        function showInstallBanner() {
            if (document.getElementById('ak-pwa-banner')) return;
            // 如果用户之前关闭了提示，24小时内不再显示
            try {
                var dismissed = localStorage.getItem('ak_pwa_dismiss');
                if (dismissed && (Date.now() - parseInt(dismissed)) < 86400000) return;
            } catch(e) {}
            var banner = document.createElement('div');
            banner.id = 'ak-pwa-banner';
            banner.innerHTML = '<div style="display:flex;align-items:center;gap:12px;"><img src="/admin/api/pwa-icon/192" width="40" height="40" style="border-radius:8px;"><div><b style="font-size:14px;">安装 AK</b><br><span style="font-size:12px;opacity:0.8;">添加到桌面，获得APP体验</span></div></div><div style="display:flex;gap:8px;"><button id="ak-pwa-install" style="background:#00e5ff;color:#000;border:none;padding:8px 16px;border-radius:20px;font-weight:bold;cursor:pointer;">安装</button><button id="ak-pwa-close" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.3);padding:8px 12px;border-radius:20px;cursor:pointer;">取消</button></div>';
            banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:linear-gradient(135deg,#0a0e1a,#1a1e3a);color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;z-index:999999;box-shadow:0 -4px 20px rgba(0,0,0,0.5);font-family:sans-serif;';
            document.body.appendChild(banner);
            document.getElementById('ak-pwa-install').onclick = function() {
                if (deferredPrompt) {
                    deferredPrompt.prompt();
                    deferredPrompt.userChoice.then(function() { deferredPrompt = null; });
                }
                banner.remove();
            };
            document.getElementById('ak-pwa-close').onclick = function() {
                banner.remove();
                try { localStorage.setItem('ak_pwa_dismiss', Date.now()); } catch(e) {}
            };
        }
    })();
    
    // 持久化登录：尽早隐藏登录页并自动登录
    autoLogin();
    // 立即执行一次
    fixApiUrl();
    // 立即拦截网络请求
    interceptNetworkRequests();
    // 设置登录凭据捕获（必须在interceptNetworkRequests之后）
    setupLoginCapture();
    // 延迟再执行（确保APP对象已加载）
    setTimeout(fixApiUrl, 500);
    setTimeout(fixApiUrl, 1500);
    setTimeout(fixApiUrl, 3000);
    
    // ===== 以下是聊天组件代码，需要等待 DOM 准备好 =====
    function initChatWidget() {
        // 在 iframe 里不初始化（避免子框架发送错误的page覆盖父页面）
        if (window.self !== window.top) return;
        // 防止重复初始化
        if (window._akChatInitialized) return;
        window._akChatInitialized = true;
        
    // 配置
    const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_URL = `${WS_PROTOCOL}//${window.location.host}/chat/ws`;
    const ASSIST_WS_URL = `${WS_PROTOCOL}//${window.location.host}/admin/assist/ws`;
    const HEARTBEAT_INTERVAL = 5000; // 5秒心跳间隔
    
    // 状态
    let ws = null;
    let assistWs = null;
    let assistSessionId = '';
    let assistReconnectTimer = null;
    let assistHeartbeatTimer = null;
    let assistMutationObserver = null;
    let assistSnapshotTimer = null;
    let assistScrollTimer = null;
    let assistNodeSeq = 0;
    let assistNodeIdMap = new WeakMap();
    let assistNodeElementMap = new Map();
    let assistSuppressSnapshotUntil = 0;
    let assistCachedHeadRoute = '';
    let assistCachedHeadMarkup = '';
    let assistLastSnapshotPayload = null;
    let assistLastSnapshotSentAt = 0;
    let assistLastScrollPayload = null;
    let assistScrollTarget = window;
    let assistDebugSignatures = Object.create(null);
    let isOpen = false;
    let hasNewMessage = false;
    let messageCount = 0;
    let username = 'visitor';
    let heartbeatTimer = null;
    let reconnectTimer = null;
    let presenceSuspended = false;

    function getChatWsReadyStateLabel(targetWs) {
        if (!targetWs) return 'NULL';
        if (targetWs.readyState === WebSocket.CONNECTING) return 'CONNECTING';
        if (targetWs.readyState === WebSocket.OPEN) return 'OPEN';
        if (targetWs.readyState === WebSocket.CLOSING) return 'CLOSING';
        if (targetWs.readyState === WebSocket.CLOSED) return 'CLOSED';
        return String(targetWs.readyState);
    }

    function logChatWsDebug(eventName, extra) {
        try {
            console.warn('[AKChatDebug]', JSON.stringify(Object.assign({
                event: String(eventName || ''),
                username: String(username || ''),
                route: window.location.pathname + window.location.hash,
                hidden: !!document.hidden,
                presenceSuspended: !!presenceSuspended,
                readyState: getChatWsReadyStateLabel(ws),
                ts: new Date().toISOString()
            }, extra || {})));
        } catch (e) {
            try {
                console.warn('[AKChatDebug]', eventName, extra || {});
            } catch (_) {}
        }
    }
    
    // 从cookie获取值
    function getCookie(name) {
        let match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
        return match ? match[2] : null;
    }
    
    // 获取用户名
    function getUsername() {
        // 1. 优先从cookie读取
        let cookieUser = getCookie('ak_username');
        if (cookieUser) return String(cookieUser).trim();
        
        // 2. 从localStorage遍历找用户名
        try {
            for (let i = 0; i < localStorage.length; i++) {
                let value = localStorage.getItem(localStorage.key(i));
                try {
                    let data = JSON.parse(value);
                    if (data && typeof data === 'object') {
                        if (data.UserName && typeof data.UserName === 'string') return String(data.UserName).trim();
                        if (data.Account && typeof data.Account === 'string') return String(data.Account).trim();
                    }
                } catch(e) {}
            }
        } catch(e) {}
        
        // 3. 从已保存的持久化登录凭据读取
        try {
            var saved = _akDecode();
            if (saved && saved.account) return String(saved.account).trim();
        } catch(e) {}
        
        // 获取不到就用访客名
        return 'guest_' + Math.random().toString(36).substr(2, 6);
    }
    
    // 创建样式 - 青绿渐变风格
    const style = document.createElement('style');
    style.textContent = `
        /* 聊天窗口 - 默认隐藏 */
        #ak-admin-chat {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 340px;
            max-height: 450px;
            background: linear-gradient(135deg, #0a3d3d 0%, #1a4a3a 100%);
            border-radius: 16px;
            box-shadow: 0 10px 40px rgba(0, 212, 180, 0.25);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            z-index: 99998;
            display: none;
            flex-direction: column;
            border: 1px solid rgba(0, 212, 180, 0.4);
            overflow: hidden;
        }
        
        #ak-admin-chat.visible {
            display: flex;
            animation: ak-slide-in 0.3s ease;
        }
        
        @keyframes ak-slide-in {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        /* 头部 - 青绿渐变 */
        #ak-admin-chat .chat-header {
            background: linear-gradient(135deg, #00c9b7 0%, #7ed56f 100%);
            padding: 14px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        #ak-admin-chat .chat-header-title {
            display: flex;
            align-items: center;
            gap: 10px;
            color: #0d1b2a;
            font-weight: 600;
            font-size: 15px;
        }
        
        #ak-admin-chat .chat-header-title::before {
            content: '📢';
            font-size: 18px;
        }
        
        #ak-admin-chat .chat-close {
            background: rgba(0,0,0,0.2);
            border: none;
            color: #0d1b2a;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        }
        
        #ak-admin-chat .chat-close:hover {
            background: rgba(0,0,0,0.3);
        }
        
        /* 消息区域 */
        #ak-admin-chat .chat-messages {
            flex: 1;
            padding: 16px;
            overflow-y: auto;
            min-height: 200px;
            max-height: 300px;
            background: #0a3d3d;
        }
        
        #ak-admin-chat .chat-message {
            margin-bottom: 12px;
            animation: ak-msg-in 0.2s ease;
        }
        
        @keyframes ak-msg-in {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        #ak-admin-chat .chat-message.admin {
            text-align: left;
        }
        
        #ak-admin-chat .chat-message.user {
            text-align: right;
        }
        
        #ak-admin-chat .chat-bubble {
            display: inline-block;
            padding: 10px 14px;
            border-radius: 12px;
            max-width: 85%;
            word-break: break-word;
            font-size: 14px;
            line-height: 1.5;
        }
        
        #ak-admin-chat .admin .chat-bubble {
            background: linear-gradient(135deg, #00c9b7 0%, #7ed56f 100%);
            color: #0a3d3d;
            border-bottom-left-radius: 4px;
        }
        
        #ak-admin-chat .user .chat-bubble {
            background: #1a4a3a;
            color: #e0f0e8;
            border: 1px solid rgba(0, 212, 180, 0.3);
            border-bottom-right-radius: 4px;
        }
        
        #ak-admin-chat .chat-time {
            font-size: 11px;
            color: #6aa88a;
            margin-top: 4px;
        }
        
        #ak-admin-chat .chat-label {
            font-size: 11px;
            color: #7ed56f;
            margin-bottom: 4px;
        }
        
        /* 输入区域 */
        #ak-admin-chat .chat-input-area {
            padding: 12px;
            background: #1a4a3a;
            border-top: 1px solid rgba(0, 212, 180, 0.2);
            display: flex;
            gap: 10px;
        }
        
        #ak-admin-chat .chat-input {
            flex: 1;
            padding: 10px 14px;
            border: 1px solid rgba(0, 212, 180, 0.4);
            border-radius: 20px;
            background: #0a3d3d;
            color: #e0f0e8;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
        }
        
        #ak-admin-chat .chat-input:focus {
            border-color: #00d4ff;
        }
        
        #ak-admin-chat .chat-input::placeholder {
            color: #6aa88a;
        }
        
        #ak-admin-chat .chat-send {
            width: 40px;
            height: 40px;
            border: none;
            border-radius: 50%;
            background: linear-gradient(135deg, #00c9b7 0%, #7ed56f 100%);
            color: #0a3d3d;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.2s;
        }
        
        #ak-admin-chat .chat-send:hover {
            transform: scale(1.05);
        }
        
        #ak-admin-chat .chat-send svg {
            width: 18px;
            height: 18px;
        }
        
        /* 新消息提示音效 */
        @keyframes ak-notify {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.1); }
        }
    `;
    document.head.appendChild(style);
    
    // 创建聊天窗口HTML
    const chatHTML = `
        <div id="ak-admin-chat">
            <div class="chat-header">
                <div class="chat-header-title">系统管理员传讯</div>
                <button class="chat-close" onclick="AKChat.close()">×</button>
            </div>
            <div class="chat-messages" id="ak-chat-messages"></div>
            <div class="chat-input-area">
                <input type="text" class="chat-input" id="ak-chat-input" placeholder="输入回复..." onkeypress="if(event.keyCode===13)AKChat.send()">
                <button class="chat-send" onclick="AKChat.send()">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>
            </div>
        </div>
    `;
    
    // 插入DOM
    const container = document.createElement('div');
    container.innerHTML = chatHTML;
    document.body.appendChild(container);
    
    // 获取元素
    const chatBox = document.getElementById('ak-admin-chat');
    const messagesDiv = document.getElementById('ak-chat-messages');
    const inputEl = document.getElementById('ak-chat-input');
    
    
    if (!chatBox) {
        console.error('[AKChat] 聊天窗口元素未找到！');
        return;
    }
    
    // 播放提示音
    function playNotificationSound() {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            oscillator.frequency.value = 800;
            oscillator.type = 'sine';
            gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
            oscillator.start(audioCtx.currentTime);
            oscillator.stop(audioCtx.currentTime + 0.3);
        } catch(e) {}
    }
    
    // 添加消息
    function addMessage(content, isAdmin, time) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-message ' + (isAdmin ? 'admin' : 'user');
        
        const timeStr = time || new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
        
        msgDiv.innerHTML = `
            ${isAdmin ? '<div class="chat-label">管理员</div>' : ''}
            <div class="chat-bubble">${escapeHtml(content)}</div>
            <div class="chat-time">${timeStr}</div>
        `;
        
        messagesDiv.appendChild(msgDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
    
    // HTML转义
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // 启动心跳（发online消息，前台每5秒自动保持主连接）
    function startHeartbeat() {
        // 清除旧的心跳
        stopHeartbeat();
        
        // 游客用户不启动持续心跳，只靠首次online上报，60秒后自动从列表消失
        if (username && username.indexOf('guest_') === 0) return;
        
        heartbeatTimer = setInterval(function() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'online',
                    username: username,
                    page: window.location.pathname + window.location.hash,
                    userAgent: navigator.userAgent
                }));
            }
        }, HEARTBEAT_INTERVAL);
    }
    
    // 停止心跳
    function stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    function clearReconnectTimer() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }

    function clearAssistReconnectTimer() {
        if (assistReconnectTimer) {
            clearTimeout(assistReconnectTimer);
            assistReconnectTimer = null;
        }
    }

    function stopAssistHeartbeat() {
        if (assistHeartbeatTimer) {
            clearInterval(assistHeartbeatTimer);
            assistHeartbeatTimer = null;
        }
    }

    function startAssistHeartbeat() {
        stopAssistHeartbeat();
        if (!assistSessionId) return;
        assistHeartbeatTimer = setInterval(function() {
            if (assistWs && assistWs.readyState === WebSocket.OPEN) {
                assistWs.send(JSON.stringify({ type: 'heartbeat', payload: { username: username } }));
            }
        }, 8000);
    }

    function normalizeAssistRoute() {
        const raw = window.location.pathname + window.location.search + window.location.hash;
        if (raw.indexOf('/admin/ak-web/') === 0) return raw;
        if (raw.indexOf('/pages/') === 0 || raw.indexOf('/content/') === 0 || raw.indexOf('/assets/') === 0) {
            return '/admin/ak-web' + raw;
        }
        return raw;
    }

    function resolveAssistTarget(meta) {
        try {
            if (meta && meta.node_id) {
                const byNodeId = assistNodeElementMap.get(String(meta.node_id));
                if (byNodeId && byNodeId.isConnected) return byNodeId;
            }
        } catch (e) {}
        try {
            if (meta && meta.selector_hint) {
                const byId = document.querySelector(meta.selector_hint);
                if (byId) return byId;
            }
        } catch (e) {}
        try {
            if (meta && meta.rect) {
                return document.elementFromPoint(Number(meta.rect.x) || 0, Number(meta.rect.y) || 0);
            }
        } catch (e) {}
        return null;
    }

    function flashAssistTarget(target) {
        try {
            if (!target) return;
            assistSuppressSnapshotUntil = Date.now() + 1500;
            const prevOutline = target.style.outline;
            const prevOffset = target.style.outlineOffset;
            target.style.outline = '2px solid rgba(255,82,82,0.95)';
            target.style.outlineOffset = '2px';
            setTimeout(function() {
                target.style.outline = prevOutline || '';
                target.style.outlineOffset = prevOffset || '';
            }, 1200);
        } catch (e) {}
    }

    function applyAssistHighlight(meta) {
        const target = resolveAssistTarget(meta || {});
        if (target) flashAssistTarget(target);
    }

    const ASSIST_STYLE_PROPS = [
        'display', 'position', 'z-index', 'top', 'right', 'bottom', 'left',
        'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
        'margin', 'padding', 'box-sizing', 'overflow', 'overflow-x', 'overflow-y',
        'font', 'font-size', 'font-weight', 'font-family', 'line-height', 'letter-spacing',
        'color', 'text-align', 'white-space', 'word-break', 'text-decoration',
        'background', 'background-color', 'background-size', 'background-position', 'background-repeat', 'border', 'border-radius', 'box-shadow',
        'flex', 'flex-direction', 'justify-content', 'align-items', 'gap',
        'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
        'opacity', 'transform', 'object-fit', 'object-position'
    ];
    const ASSIST_SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'LINK', 'META', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO']);
    const ASSIST_PLACEHOLDER_TAGS = new Set(['CANVAS']);
    const ASSIST_MAX_NODE_COUNT = 1600;
    const ASSIST_MAX_HTML_LENGTH = 320000;
    const ASSIST_PINNED_BOTTOM_LIMIT = 2;
    const ASSIST_PINNED_BOTTOM_NODE_BUDGET = 180;
    const ASSIST_VIEWPORT_SAMPLE_ROWS = 7;
    const ASSIST_VIEWPORT_SAMPLE_COLS = 3;
    const ASSIST_VIEWPORT_ROOT_LIMIT = 18;
    const ASSIST_VIEWPORT_OUTER_ROOT_LIMIT = 8;
    const ASSIST_ELEMENT_VIEWPORT_ROOT_LIMIT = 20;
    const ASSIST_ELEMENT_VIEWPORT_SCAN_LIMIT = 220;
    const ASSIST_VIEWPORT_NODE_LIMIT = 1200;
    const ASSIST_VIEWPORT_SCROLL_HEIGHT_FACTOR = 2.4;
    const ASSIST_VIEWPORT_SCROLL_SNAPSHOT_DELAY = 220;

    function nextAssistNodeId() {
        assistNodeSeq += 1;
        return 'ra_' + assistNodeSeq;
    }

    function ensureAssistNodeId(element) {
        try {
            if (!element) return '';
            let nodeId = assistNodeIdMap.get(element);
            if (!nodeId) {
                nodeId = nextAssistNodeId();
                assistNodeIdMap.set(element, nodeId);
            }
            assistNodeElementMap.set(nodeId, element);
            return nodeId;
        } catch (e) {
            return '';
        }
    }

    function getAssistDebugTargetMode(target) {
        try {
            if (!target || target === window || target === document || target === document.body || target === document.documentElement) {
                return 'window';
            }
            return target instanceof Element ? 'element' : 'unknown';
        } catch (e) {
            return 'unknown';
        }
    }

    function logAssistDebug(stage, payload, signature) {
        try {
            if (signature) {
                if (assistDebugSignatures[stage] === signature) return;
                assistDebugSignatures[stage] = signature;
            }
            console.log('[AKChatAssistDebug]', stage, payload || {});
        } catch (e) {}
    }

    function clearAssistSnapshotTimer() {
        if (assistSnapshotTimer) {
            clearTimeout(assistSnapshotTimer);
            assistSnapshotTimer = null;
        }
    }

    function clearAssistScrollTimer() {
        if (assistScrollTimer) {
            clearTimeout(assistScrollTimer);
            assistScrollTimer = null;
        }
    }

    function stopAssistDomObserver() {
        if (assistMutationObserver) {
            try {
                assistMutationObserver.disconnect();
            } catch (e) {}
            assistMutationObserver = null;
        }
        clearAssistSnapshotTimer();
    }

    function buildAssistStyleText(computed) {
        try {
            return ASSIST_STYLE_PROPS.map(function(prop) {
                let value = computed.getPropertyValue(prop);
                value = sanitizeAssistCssText(value);
                return value ? (prop + ':' + value) : '';
            }).filter(Boolean).join(';');
        } catch (e) {
            return '';
        }
    }

    function escapeAssistHtml(text) {
        return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function sanitizeAssistHtmlAttr(text) {
        return escapeAssistHtml(String(text || '')).replace(/`/g, '&#96;');
    }

    function sanitizeAssistUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return '';
        if (/^#/i.test(raw)) return raw;
        if (/^(?:https?:|blob:|\/|\.{1,2}\/|\?)/i.test(raw)) return raw;
        if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|avif)(?:;|,)/i.test(raw)) return raw;
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return '';
        return raw;
    }

    function sanitizeAssistCssText(cssText) {
        return String(cssText || '')
            .replace(/@import\s+(?:url\()?\s*(['"]?)\s*javascript:[^;]+;?/ig, '')
            .replace(/@import\s+(?:url\()?\s*(['"]?)\s*(?:vbscript:|data:text\/html|data:text\/javascript)[^;]+;?/ig, '')
            .replace(/url\(\s*(['"]?)\s*(?:javascript:|vbscript:|data:text\/html|data:text\/javascript)[^)]*\1\s*\)/ig, 'none')
            .replace(/url\(\s*(['"]?)\s*data:image\/svg\+xml[^)]*\1\s*\)/ig, 'none')
            .replace(/expression\s*\([^)]*\)/ig, '')
            .replace(/behavior\s*:[^;]+;?/ig, '')
            .replace(/-moz-binding\s*:[^;]+;?/ig, '');
    }

    function buildAssistSelectorHint(node, tagName) {
        const className = String(node.getAttribute('class') || '').trim();
        return node.id
            ? ('#' + node.id)
            : (className ? (tagName + '.' + className.split(/\s+/).slice(0, 2).join('.')) : tagName);
    }

    function decorateAssistClone(node, clone, tagName, computed) {
        const nodeId = ensureAssistNodeId(node);
        if (nodeId) clone.setAttribute('data-ra-node-id', nodeId);
        clone.setAttribute('data-ra-tag', tagName);
        clone.setAttribute('style', buildAssistStyleText(computed));
        if (tagName !== 'body') {
            try {
                const originalId = String(node.getAttribute('id') || '').trim();
                if (originalId && originalId !== 'ak-admin-chat') clone.setAttribute('id', originalId);
            } catch (e) {}
            try {
                const className = String(node.getAttribute('class') || '').trim();
                if (className) clone.setAttribute('class', className);
            } catch (e) {}
        }
        const ariaLabel = node.getAttribute('aria-label') || node.getAttribute('title') || '';
        const selectorHint = buildAssistSelectorHint(node, tagName);
        const textHint = String(node.innerText || node.textContent || '').trim().slice(0, 40);
        if (ariaLabel) clone.setAttribute('data-ra-label', ariaLabel);
        if (selectorHint) clone.setAttribute('data-ra-selector-hint', selectorHint);
        if (textHint) clone.setAttribute('data-ra-text-hint', textHint);
    }

    function buildAssistHeadMarkup() {
        const routeKey = normalizeAssistRoute();
        if (assistCachedHeadMarkup && assistCachedHeadRoute === routeKey) {
            return assistCachedHeadMarkup;
        }
        const parts = ['<meta charset="utf-8">'];
        try {
            const baseHref = sanitizeAssistUrl(window.location.href || '');
            if (baseHref) parts.push('<base href="' + sanitizeAssistHtmlAttr(baseHref) + '">');
        } catch (e) {}
        try {
            const head = document.head;
            if (!head) return parts.join('');
            const links = head.querySelectorAll('link[rel]');
            for (let i = 0; i < links.length; i += 1) {
                const link = links[i];
                const rel = String(link.getAttribute('rel') || '').trim().toLowerCase();
                if (rel.indexOf('stylesheet') === -1) continue;
                const href = sanitizeAssistUrl(link.href || link.getAttribute('href') || '');
                if (!href) continue;
                const media = String(link.getAttribute('media') || '').trim();
                parts.push('<link rel="stylesheet" href="' + sanitizeAssistHtmlAttr(href) + '"' + (media ? ' media="' + sanitizeAssistHtmlAttr(media) + '"' : '') + '>');
            }
            const styles = head.querySelectorAll('style');
            for (let i = 0; i < styles.length; i += 1) {
                const cssText = sanitizeAssistCssText(styles[i].textContent || '');
                if (cssText) parts.push('<style>' + cssText.replace(/<\/style/ig, '<\\/style') + '</style>');
            }
        } catch (e) {}
        const markup = parts.join('');
        assistCachedHeadRoute = routeKey;
        assistCachedHeadMarkup = markup;
        return markup;
    }

    function buildAssistBodyAttrs() {
        const attrs = [];
        try {
            const bodyId = String((document.body && document.body.getAttribute('id')) || '').trim();
            if (bodyId) attrs.push(' id="' + sanitizeAssistHtmlAttr(bodyId) + '"');
        } catch (e) {}
        try {
            const bodyClass = String((document.body && document.body.getAttribute('class')) || '').trim();
            if (bodyClass) attrs.push(' class="' + sanitizeAssistHtmlAttr(bodyClass) + '"');
        } catch (e) {}
        return attrs.join('');
    }

    function buildAssistSvgClone(node, stats, computed) {
        try {
            const clone = node.cloneNode(true);
            if (!(clone instanceof Element)) return buildAssistPlaceholder(node, stats, 'svg');
            Array.prototype.slice.call(clone.querySelectorAll('script,foreignObject')).forEach(function(dangerNode) {
                dangerNode.remove();
            });
            Array.prototype.slice.call(clone.querySelectorAll('style')).forEach(function(styleNode) {
                const cssText = sanitizeAssistCssText(styleNode.textContent || '');
                if (cssText) {
                    styleNode.textContent = cssText;
                } else {
                    styleNode.remove();
                }
            });
            const svgNodes = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
            svgNodes.forEach(function(element) {
                Array.prototype.slice.call(element.attributes || []).forEach(function(attr) {
                    const name = String(attr.name || '');
                    const lowered = name.toLowerCase();
                    const value = String(attr.value || '');
                    if (lowered.indexOf('on') === 0) {
                        element.removeAttribute(name);
                        return;
                    }
                    if (lowered === 'style') {
                        const cssText = sanitizeAssistCssText(value);
                        if (cssText) {
                            element.setAttribute(name, cssText);
                        } else {
                            element.removeAttribute(name);
                        }
                        return;
                    }
                    if ((lowered === 'href' || lowered === 'xlink:href' || lowered === 'src') && !sanitizeAssistUrl(value)) {
                        element.removeAttribute(name);
                    }
                });
            });
            decorateAssistClone(node, clone, 'svg', computed);
            stats.nodeCount += 1;
            return clone;
        } catch (e) {
            return buildAssistPlaceholder(node, stats, 'svg');
        }
    }

    function buildAssistPlaceholder(original, stats, label) {
        const placeholder = document.createElement('div');
        const computed = window.getComputedStyle(original);
        const nodeId = ensureAssistNodeId(original);
        if (nodeId) placeholder.setAttribute('data-ra-node-id', nodeId);
        placeholder.setAttribute('data-ra-placeholder', String(label || '占位'));
        placeholder.setAttribute('style', buildAssistStyleText(computed) + ';display:flex;align-items:center;justify-content:center;background:rgba(148,163,184,0.12);border:1px dashed rgba(148,163,184,0.55);color:#64748b;font-size:12px;min-height:24px;');
        placeholder.textContent = '[' + (label || original.tagName.toLowerCase()) + ']';
        stats.nodeCount += 1;
        return placeholder;
    }

    function shouldSkipAssistElement(element, computed) {
        if (!element || !(element instanceof Element)) return true;
        if (ASSIST_SKIP_TAGS.has(element.tagName)) return true;
        if (element.id === 'ak-admin-chat') return true;
        if (element.closest && element.closest('#ak-admin-chat')) return true;
        if (!computed) return true;
        if (computed.display === 'none' || computed.visibility === 'hidden' || Number(computed.opacity || 1) === 0) return true;
        return false;
    }

    function getAssistDocumentScrollHeight() {
        try {
            return Math.max(
                Number((document.documentElement && document.documentElement.scrollHeight) || 0),
                Number((document.body && document.body.scrollHeight) || 0),
                Number(window.innerHeight || 0)
            );
        } catch (e) {
            return Math.max(0, Math.round(window.innerHeight || 0));
        }
    }

    function pushAssistElementCandidate(list, element) {
        try {
            if (!element || !(element instanceof Element)) return;
            for (let i = 0; i < list.length; i += 1) {
                const existing = list[i];
                if (existing === element || (existing.contains && existing.contains(element))) return;
                if (element.contains && element.contains(existing)) {
                    list.splice(i, 1);
                    i -= 1;
                }
            }
            list.push(element);
        } catch (e) {}
    }

    function findAssistPrimaryScrollableElement() {
        try {
            if (!document.body) return null;
            const elements = document.body.querySelectorAll('*');
            const viewportWidth = Math.max(1, Math.round(window.innerWidth || 0));
            const viewportHeight = Math.max(1, Math.round(window.innerHeight || 0));
            let best = null;
            let bestScore = 0;
            for (let i = 0; i < elements.length; i += 1) {
                const element = elements[i];
                if (!element || isAssistWidgetTarget(element)) continue;
                const computed = window.getComputedStyle(element);
                if (shouldSkipAssistElement(element, computed)) continue;
                const overflowValue = String(computed.overflowY || computed.overflow || '').toLowerCase();
                if (overflowValue.indexOf('auto') === -1 && overflowValue.indexOf('scroll') === -1 && overflowValue.indexOf('overlay') === -1) continue;
                const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
                if (!isAssistViewportRectVisible(rect, 24)) continue;
                const clientHeight = Math.max(0, Math.round(element.clientHeight || 0));
                const clientWidth = Math.max(0, Math.round(element.clientWidth || 0));
                const scrollHeight = Math.max(0, Math.round(element.scrollHeight || 0));
                if (clientHeight < Math.round(viewportHeight * 0.35) || clientWidth < Math.round(viewportWidth * 0.45)) continue;
                if (scrollHeight < Math.round(Math.max(1, clientHeight) * ASSIST_VIEWPORT_SCROLL_HEIGHT_FACTOR)) continue;
                const score = clientHeight * clientWidth;
                if (score > bestScore) {
                    best = element;
                    bestScore = score;
                }
            }
            return best;
        } catch (e) {
            return null;
        }
    }

    function getAssistActiveViewportTarget() {
        try {
            if (assistScrollTarget && assistScrollTarget !== window && assistScrollTarget instanceof Element) {
                return assistScrollTarget;
            }
            return findAssistPrimaryScrollableElement() || window;
        } catch (e) {
            return window;
        }
    }

    function getAssistActiveViewportMetrics() {
        try {
            const target = getAssistActiveViewportTarget();
            if (target && target !== window && target instanceof Element) {
                return {
                    mode: 'element',
                    target: target,
                    viewportHeight: Math.max(1, Math.round(target.clientHeight || window.innerHeight || 0)),
                    viewportWidth: Math.max(1, Math.round(target.clientWidth || window.innerWidth || 0)),
                    scrollHeight: Math.max(1, Math.round(target.scrollHeight || target.clientHeight || 0))
                };
            }
            return {
                mode: 'window',
                target: window,
                viewportHeight: Math.max(1, Math.round(window.innerHeight || 0)),
                viewportWidth: Math.max(1, Math.round(window.innerWidth || 0)),
                scrollHeight: Math.max(1, Math.round(getAssistDocumentScrollHeight()))
            };
        } catch (e) {
            return {
                mode: 'window',
                target: window,
                viewportHeight: Math.max(1, Math.round(window.innerHeight || 0)),
                viewportWidth: Math.max(1, Math.round(window.innerWidth || 0)),
                scrollHeight: Math.max(1, Math.round(getAssistDocumentScrollHeight()))
            };
        }
    }

    function isAssistViewportModeEligible() {
        try {
            if (!document.body) return false;
            const route = normalizeAssistRoute();
            if (route.indexOf('/admin/ak-web/') !== 0) return false;
            const metrics = getAssistActiveViewportMetrics();
            return metrics.scrollHeight >= Math.round(Math.max(1, metrics.viewportHeight || 0) * ASSIST_VIEWPORT_SCROLL_HEIGHT_FACTOR);
        } catch (e) {
            return false;
        }
    }

    function shouldUseAssistViewportSnapshot(reason) {
        try {
            if (isAssistViewportModeEligible()) return true;
            if (!assistLastSnapshotPayload || !assistLastSnapshotPayload.truncated) return false;
            return String(reason || '').toLowerCase() !== 'snapshot_request';
        } catch (e) {
            return false;
        }
    }

    function isAssistViewportRectVisible(rect, padding) {
        const extra = typeof padding === 'number' ? padding : 0;
        const viewportWidth = Math.max(1, Math.round(window.innerWidth || 0));
        const viewportHeight = Math.max(1, Math.round(window.innerHeight || 0));
        if (!rect || rect.width < 8 || rect.height < 8) return false;
        if (rect.bottom < -extra || rect.top > viewportHeight + extra) return false;
        if (rect.right < -extra || rect.left > viewportWidth + extra) return false;
        return true;
    }

    function isAssistContainerRectVisible(rect, containerRect, padding) {
        const extra = typeof padding === 'number' ? padding : 0;
        if (!rect || !containerRect || rect.width < 8 || rect.height < 8) return false;
        if (rect.bottom < containerRect.top - extra || rect.top > containerRect.bottom + extra) return false;
        if (rect.right < containerRect.left - extra || rect.left > containerRect.right + extra) return false;
        return true;
    }

    function pickAssistViewportRoot(target, boundaryElement, viewportWidth, viewportHeight) {
        try {
            let candidate = target instanceof Element ? target : null;
            let current = candidate;
            const maxWidth = Math.max(1, Math.round(viewportWidth || window.innerWidth || 0));
            const maxHeight = Math.max(1, Math.round(viewportHeight || window.innerHeight || 0));
            let depth = 0;
            while (current && current.parentElement && current.parentElement !== document.body && depth < 6) {
                const parent = current.parentElement;
                if (boundaryElement && parent === boundaryElement) break;
                const computed = window.getComputedStyle(parent);
                if (shouldSkipAssistElement(parent, computed)) break;
                const rect = parent.getBoundingClientRect ? parent.getBoundingClientRect() : null;
                if (!rect || rect.width <= 0 || rect.height <= 0) break;
                const position = String(computed.position || '').toLowerCase();
                if (position === 'fixed') {
                    candidate = parent;
                    break;
                }
                if (rect.width > maxWidth * 1.08) break;
                if (rect.height > maxHeight * 0.92) break;
                candidate = parent;
                current = parent;
                depth += 1;
            }
            return candidate;
        } catch (e) {
            return target instanceof Element ? target : null;
        }
    }

    function isAssistPinnedViewportCandidate(element, computed) {
        try {
            if (!element || !(element instanceof Element)) return false;
            if (element === document.body || element === document.documentElement) return false;
            if (shouldSkipAssistElement(element, computed)) return false;
            const position = String(computed && computed.position || '').toLowerCase();
            if (position !== 'fixed' && position !== 'sticky') return false;
            const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
            const viewportWidth = Math.max(1, Math.round(window.innerWidth || 0));
            if (!isAssistViewportRectVisible(rect, 12)) return false;
            if (!rect || rect.height < 20 || rect.width < Math.max(80, Math.round(viewportWidth * 0.28))) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    function collectAssistPinnedViewportElements(limit) {
        try {
            if (!document.body) return [];
            const selected = [];
            const elements = Array.prototype.slice.call(document.body.querySelectorAll('*')).reverse();
            for (let i = 0; i < elements.length; i += 1) {
                const element = elements[i];
                const computed = window.getComputedStyle(element);
                if (!isAssistPinnedViewportCandidate(element, computed)) continue;
                pushAssistElementCandidate(selected, element);
            }
            selected.sort(function(a, b) {
                return (a.getBoundingClientRect().top || 0) - (b.getBoundingClientRect().top || 0);
            });
            if (selected.length <= limit) return selected;
            const prioritized = [];
            let start = 0;
            let end = selected.length - 1;
            while (start <= end && prioritized.length < limit) {
                pushAssistElementCandidate(prioritized, selected[end]);
                end -= 1;
                if (prioritized.length >= limit || start > end) break;
                pushAssistElementCandidate(prioritized, selected[start]);
                start += 1;
            }
            return prioritized.sort(function(a, b) {
                return (a.getBoundingClientRect().top || 0) - (b.getBoundingClientRect().top || 0);
            });
        } catch (e) {
            return [];
        }
    }

    function collectAssistViewportRoots(limit) {
        try {
            const selected = [];
            const viewportWidth = Math.max(1, Math.round(window.innerWidth || 0));
            const viewportHeight = Math.max(1, Math.round(window.innerHeight || 0));
            for (let row = 1; row <= ASSIST_VIEWPORT_SAMPLE_ROWS; row += 1) {
                const y = Math.max(1, Math.min(viewportHeight - 2, Math.round((viewportHeight * row) / (ASSIST_VIEWPORT_SAMPLE_ROWS + 1))));
                for (let col = 1; col <= ASSIST_VIEWPORT_SAMPLE_COLS; col += 1) {
                    const x = Math.max(1, Math.min(viewportWidth - 2, Math.round((viewportWidth * col) / (ASSIST_VIEWPORT_SAMPLE_COLS + 1))));
                    const target = document.elementFromPoint(x, y);
                    if (!target || isAssistWidgetTarget(target)) continue;
                    const root = pickAssistViewportRoot(target, null, viewportWidth, viewportHeight);
                    const rect = root && root.getBoundingClientRect ? root.getBoundingClientRect() : null;
                    if (!root || !isAssistViewportRectVisible(rect, 18)) continue;
                    pushAssistElementCandidate(selected, root);
                    if (selected.length >= limit) {
                        return selected.sort(function(a, b) {
                            const aRect = a.getBoundingClientRect();
                            const bRect = b.getBoundingClientRect();
                            return (aRect.top || 0) - (bRect.top || 0) || (aRect.left || 0) - (bRect.left || 0);
                        });
                    }
                }
            }
            return selected.sort(function(a, b) {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return (aRect.top || 0) - (bRect.top || 0) || (aRect.left || 0) - (bRect.left || 0);
            });
        } catch (e) {
            return [];
        }
    }

    function collectAssistContextViewportRootsForElement(container, limit) {
        try {
            if (!container || !(container instanceof Element)) return [];
            const selected = [];
            const viewportWidth = Math.max(1, Math.round(window.innerWidth || 0));
            const viewportHeight = Math.max(1, Math.round(window.innerHeight || 0));
            let branch = container;
            let parent = container.parentElement;
            let depth = 0;
            while (parent && parent !== document.body && selected.length < limit && depth < 6) {
                const siblings = Array.prototype.slice.call(parent.children || []);
                for (let i = 0; i < siblings.length; i += 1) {
                    if (selected.length >= limit) break;
                    const sibling = siblings[i];
                    if (!sibling || sibling === branch || isAssistWidgetTarget(sibling)) continue;
                    const computed = window.getComputedStyle(sibling);
                    if (shouldSkipAssistElement(sibling, computed)) continue;
                    const rect = sibling.getBoundingClientRect ? sibling.getBoundingClientRect() : null;
                    if (!isAssistViewportRectVisible(rect, 32)) continue;
                    const root = pickAssistViewportRoot(sibling, parent, viewportWidth, viewportHeight) || sibling;
                    const rootRect = root && root.getBoundingClientRect ? root.getBoundingClientRect() : null;
                    if (!root || !isAssistViewportRectVisible(rootRect, 32)) continue;
                    pushAssistElementCandidate(selected, root);
                }
                branch = parent;
                parent = parent.parentElement;
                depth += 1;
            }
            return selected.sort(function(a, b) {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return (aRect.top || 0) - (bRect.top || 0) || (aRect.left || 0) - (bRect.left || 0);
            });
        } catch (e) {
            return [];
        }
    }

    function collectAssistOuterViewportRootsForElement(container, limit) {
        try {
            if (!container || !(container instanceof Element)) return [];
            const selected = [];
            const contextRoots = collectAssistContextViewportRootsForElement(container, Math.max(limit, 2));
            contextRoots.forEach(function(element) {
                if (selected.length >= limit) return;
                if (!element || element === container) return;
                if (container.contains(element) || element.contains(container)) return;
                pushAssistElementCandidate(selected, element);
            });
            if (selected.length < limit) {
                const roots = collectAssistViewportRoots(Math.max(limit * 3, limit));
                roots.forEach(function(element) {
                    if (selected.length >= limit) return;
                    if (!element || element === container) return;
                    if (container.contains(element) || element.contains(container)) return;
                    pushAssistElementCandidate(selected, element);
                });
            }
            return selected.sort(function(a, b) {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return (aRect.top || 0) - (bRect.top || 0) || (aRect.left || 0) - (bRect.left || 0);
            });
        } catch (e) {
            return [];
        }
    }

    function collectAssistElementViewportRoots(container, limit) {
        try {
            if (!container || !(container instanceof Element)) return [];
            const selected = [];
            const containerRect = container.getBoundingClientRect ? container.getBoundingClientRect() : null;
            const viewportWidth = Math.max(1, Math.round(container.clientWidth || window.innerWidth || 0));
            const viewportHeight = Math.max(1, Math.round(container.clientHeight || window.innerHeight || 0));
            const buffer = Math.max(120, Math.round(viewportHeight * 0.6));
            const queue = Array.prototype.slice.call(container.children || []);
            let scanned = 0;
            while (queue.length && selected.length < limit && scanned < ASSIST_ELEMENT_VIEWPORT_SCAN_LIMIT) {
                const element = queue.shift();
                scanned += 1;
                if (!element || isAssistWidgetTarget(element)) continue;
                const computed = window.getComputedStyle(element);
                if (shouldSkipAssistElement(element, computed)) continue;
                const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
                if (!isAssistContainerRectVisible(rect, containerRect, buffer)) continue;
                const isHugeWrapper = rect && rect.height > Math.max(120, Math.round(viewportHeight * 0.92)) && element.children && element.children.length;
                if (isHugeWrapper) {
                    const childElements = Array.prototype.slice.call(element.children || []);
                    childElements.forEach(function(child) {
                        queue.push(child);
                    });
                    continue;
                }
                const root = pickAssistViewportRoot(element, container, viewportWidth, viewportHeight);
                const rootRect = root && root.getBoundingClientRect ? root.getBoundingClientRect() : null;
                if (!root || !isAssistContainerRectVisible(rootRect, containerRect, buffer)) continue;
                pushAssistElementCandidate(selected, root);
            }
            if (!selected.length && containerRect) {
                const visibleLeft = Math.max(1, Math.round(containerRect.left));
                const visibleRight = Math.max(visibleLeft + 1, Math.min(Math.round(window.innerWidth || 0) - 2, Math.round(containerRect.right)));
                const visibleTop = Math.max(1, Math.round(containerRect.top));
                const visibleBottom = Math.max(visibleTop + 1, Math.min(Math.round(window.innerHeight || 0) - 2, Math.round(containerRect.bottom)));
                for (let row = 1; row <= ASSIST_VIEWPORT_SAMPLE_ROWS; row += 1) {
                    const y = Math.max(1, Math.min(visibleBottom, Math.round(visibleTop + ((visibleBottom - visibleTop) * row) / (ASSIST_VIEWPORT_SAMPLE_ROWS + 1))));
                    for (let col = 1; col <= ASSIST_VIEWPORT_SAMPLE_COLS; col += 1) {
                        const x = Math.max(1, Math.min(visibleRight, Math.round(visibleLeft + ((visibleRight - visibleLeft) * col) / (ASSIST_VIEWPORT_SAMPLE_COLS + 1))));
                        const target = document.elementFromPoint(x, y);
                        if (!target || !container.contains(target) || isAssistWidgetTarget(target)) continue;
                        const root = pickAssistViewportRoot(target, container, viewportWidth, viewportHeight);
                        const rootRect = root && root.getBoundingClientRect ? root.getBoundingClientRect() : null;
                        if (!root || !isAssistContainerRectVisible(rootRect, containerRect, buffer)) continue;
                        pushAssistElementCandidate(selected, root);
                        if (selected.length >= limit) break;
                    }
                    if (selected.length >= limit) break;
                }
            }
            return selected.sort(function(a, b) {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return (aRect.top || 0) - (bRect.top || 0) || (aRect.left || 0) - (bRect.left || 0);
            });
        } catch (e) {
            return [];
        }
    }

    function appendAssistViewportClone(container, element, stats, usedNodeIds, preservePosition, layout) {
        try {
            if (!container || !element || !(container instanceof Element)) return;
            const nodeId = ensureAssistNodeId(element);
            if (nodeId && usedNodeIds && usedNodeIds.has(nodeId)) return;
            const remaining = Math.max(0, ASSIST_VIEWPORT_NODE_LIMIT - Math.max(0, Number(stats && stats.nodeCount) || 0));
            if (!remaining) {
                if (stats) stats.truncated = true;
                return;
            }
            const cloneStats = { nodeCount: 0, truncated: false, maxNodeCount: remaining };
            const clone = buildAssistClone(element, cloneStats);
            if (!clone) {
                if (stats && cloneStats.truncated) stats.truncated = true;
                return;
            }
            if (!preservePosition) {
                const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
                let top = Math.max(0, Math.round((window.scrollY || window.pageYOffset || 0) + (rect ? rect.top : 0)));
                let left = Math.max(0, Math.round((window.scrollX || window.pageXOffset || 0) + (rect ? rect.left : 0)));
                if (layout && layout.mode === 'element' && layout.containerRect && layout.scrollTarget) {
                    top = Math.max(0, Math.round((layout.scrollTarget.scrollTop || 0) + ((rect ? rect.top : 0) - layout.containerRect.top)));
                    left = Math.max(0, Math.round((layout.scrollTarget.scrollLeft || 0) + ((rect ? rect.left : 0) - layout.containerRect.left)));
                }
                const width = Math.max(1, Math.round(rect ? rect.width : element.clientWidth || 1));
                const minHeight = Math.max(1, Math.round(rect ? rect.height : element.clientHeight || 1));
                clone.setAttribute('style', (clone.getAttribute('style') || '') + ';position:absolute;left:' + left + 'px;top:' + top + 'px;right:auto;bottom:auto;width:' + width + 'px;min-height:' + minHeight + 'px;margin:0;transform:none;');
            }
            container.appendChild(clone);
            if (nodeId && usedNodeIds) usedNodeIds.add(nodeId);
            if (stats) {
                stats.nodeCount += cloneStats.nodeCount;
                if (cloneStats.truncated) stats.truncated = true;
            }
        } catch (e) {}
    }

    function createAssistViewportOverlayStage(docHeight) {
        const overlayStage = document.createElement('div');
        overlayStage.setAttribute('data-ra-viewport-overlay', '1');
        overlayStage.setAttribute('style', 'position:absolute;left:0;top:0;right:0;bottom:0;min-height:' + docHeight + 'px;z-index:2147483000;');
        return overlayStage;
    }

    function buildAssistWindowViewportBodyClone(stats) {
        try {
            if (!document.body) return null;
            const viewportRoots = collectAssistViewportRoots(ASSIST_VIEWPORT_ROOT_LIMIT);
            if (!viewportRoots.length) {
                logAssistDebug('viewport_body_clone_empty', {
                    scroll_target: getAssistDebugTargetMode(assistScrollTarget),
                    doc_height: Math.round(getAssistDocumentScrollHeight()),
                    route: normalizeAssistRoute()
                }, [getAssistDebugTargetMode(assistScrollTarget), Math.round(getAssistDocumentScrollHeight()), normalizeAssistRoute()].join('|'));
                return null;
            }
            const bodyComputed = window.getComputedStyle(document.body);
            const bodyClone = document.createElement('div');
            const docHeight = Math.max(Math.round(getAssistDocumentScrollHeight()), Math.round(window.innerHeight || 0));
            decorateAssistClone(document.body, bodyClone, 'body', bodyComputed);
            bodyClone.setAttribute('style', (bodyClone.getAttribute('style') || '') + ';position:relative;min-height:' + docHeight + 'px;');
            const stage = document.createElement('div');
            stage.setAttribute('data-ra-viewport-stage', '1');
            stage.setAttribute('style', 'position:relative;min-height:' + docHeight + 'px;');
            bodyClone.appendChild(stage);
            const overlayStage = createAssistViewportOverlayStage(docHeight);
            bodyClone.appendChild(overlayStage);
            const usedNodeIds = new Set();
            const pinnedElements = collectAssistPinnedViewportElements(ASSIST_PINNED_BOTTOM_LIMIT + 2);
            pinnedElements.forEach(function(element) {
                appendAssistViewportClone(overlayStage, element, stats, usedNodeIds, true);
            });
            prependAssistPinnedBottomClones(overlayStage, stats, usedNodeIds);
            viewportRoots.forEach(function(element) {
                appendAssistViewportClone(stage, element, stats, usedNodeIds, false);
            });
            if (!stage.childNodes.length) return null;
            logAssistDebug('viewport_body_clone', {
                scroll_target: getAssistDebugTargetMode(assistScrollTarget),
                route: normalizeAssistRoute(),
                doc_height: docHeight,
                viewport_root_count: viewportRoots.length,
                pinned_count: pinnedElements.length,
                node_count: Math.max(0, Number(stats && stats.nodeCount) || 0),
                truncated: !!(stats && stats.truncated)
            }, [getAssistDebugTargetMode(assistScrollTarget), normalizeAssistRoute(), docHeight, viewportRoots.length, pinnedElements.length, Math.max(0, Number(stats && stats.nodeCount) || 0), !!(stats && stats.truncated)].join('|'));
            return bodyClone;
        } catch (e) {
            return null;
        }
    }

    function buildAssistElementViewportBodyClone(target, stats) {
        try {
            if (!document.body || !target || !(target instanceof Element)) return null;
            const targetRect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
            if (!isAssistViewportRectVisible(targetRect, 24)) return null;
            const innerRoots = collectAssistElementViewportRoots(target, ASSIST_ELEMENT_VIEWPORT_ROOT_LIMIT);
            if (!innerRoots.length) return null;
            const bodyComputed = window.getComputedStyle(document.body);
            const bodyClone = document.createElement('div');
            const docHeight = Math.max(Math.round(getAssistDocumentScrollHeight()), Math.round(window.innerHeight || 0));
            decorateAssistClone(document.body, bodyClone, 'body', bodyComputed);
            bodyClone.setAttribute('style', (bodyClone.getAttribute('style') || '') + ';position:relative;min-height:' + docHeight + 'px;');
            const stage = document.createElement('div');
            stage.setAttribute('data-ra-viewport-stage', '1');
            stage.setAttribute('style', 'position:relative;min-height:' + docHeight + 'px;');
            bodyClone.appendChild(stage);
            const overlayStage = createAssistViewportOverlayStage(docHeight);
            bodyClone.appendChild(overlayStage);
            const usedNodeIds = new Set();
            const pinnedElements = collectAssistPinnedViewportElements(ASSIST_PINNED_BOTTOM_LIMIT + 2);
            pinnedElements.forEach(function(element) {
                appendAssistViewportClone(overlayStage, element, stats, usedNodeIds, true);
            });
            prependAssistPinnedBottomClones(overlayStage, stats, usedNodeIds);
            const outerRoots = collectAssistOuterViewportRootsForElement(target, ASSIST_VIEWPORT_OUTER_ROOT_LIMIT);
            const targetComputed = window.getComputedStyle(target);
            const targetTag = String(target.tagName || 'div').toLowerCase();
            const targetClone = document.createElement(targetTag);
            decorateAssistClone(target, targetClone, targetTag, targetComputed);
            const targetNodeId = ensureAssistNodeId(target);
            if (targetNodeId) usedNodeIds.add(targetNodeId);
            const shellTop = Math.max(0, Math.round((window.scrollY || window.pageYOffset || 0) + (targetRect ? targetRect.top : 0)));
            const shellLeft = Math.max(0, Math.round((window.scrollX || window.pageXOffset || 0) + (targetRect ? targetRect.left : 0)));
            const shellWidth = Math.max(1, Math.round(targetRect ? targetRect.width : target.clientWidth || 1));
            const shellHeight = Math.max(1, Math.round(targetRect ? targetRect.height : target.clientHeight || 1));
            targetClone.setAttribute('style', (targetClone.getAttribute('style') || '') + ';position:absolute;left:' + shellLeft + 'px;top:' + shellTop + 'px;right:auto;bottom:auto;width:' + shellWidth + 'px;height:' + shellHeight + 'px;min-height:' + shellHeight + 'px;max-height:none;overflow:auto;margin:0;transform:none;');
            const contentStage = document.createElement('div');
            contentStage.setAttribute('data-ra-scroll-stage', '1');
            contentStage.setAttribute('style', 'position:relative;min-height:' + Math.max(Math.round(target.scrollHeight || 0), shellHeight) + 'px;width:100%;');
            targetClone.appendChild(contentStage);
            const layout = { mode: 'element', containerRect: targetRect, scrollTarget: target };
            innerRoots.forEach(function(element) {
                appendAssistViewportClone(contentStage, element, stats, usedNodeIds, false, layout);
            });
            if (!contentStage.childNodes.length) return null;
            stage.appendChild(targetClone);
            outerRoots.forEach(function(element) {
                appendAssistViewportClone(stage, element, stats, usedNodeIds, false);
            });
            logAssistDebug('viewport_element_body_clone', {
                scroll_target: getAssistDebugTargetMode(assistScrollTarget),
                snapshot_target: getAssistDebugTargetMode(target),
                route: normalizeAssistRoute(),
                doc_height: docHeight,
                outer_root_count: outerRoots.length,
                inner_root_count: innerRoots.length,
                pinned_count: pinnedElements.length,
                node_count: Math.max(0, Number(stats && stats.nodeCount) || 0),
                truncated: !!(stats && stats.truncated),
                scroll_height: Math.max(0, Math.round(target.scrollHeight || 0))
            }, [getAssistDebugTargetMode(assistScrollTarget), getAssistDebugTargetMode(target), normalizeAssistRoute(), docHeight, outerRoots.length, innerRoots.length, pinnedElements.length, Math.max(0, Number(stats && stats.nodeCount) || 0), !!(stats && stats.truncated), Math.max(0, Math.round(target.scrollHeight || 0))].join('|'));
            return bodyClone;
        } catch (e) {
            return null;
        }
    }

    function buildAssistViewportBodyClone(stats, target) {
        try {
            const viewportTarget = target || getAssistActiveViewportTarget();
            if (viewportTarget && viewportTarget !== window && viewportTarget instanceof Element) {
                const elementClone = buildAssistElementViewportBodyClone(viewportTarget, stats);
                if (elementClone) return elementClone;
            }
            return buildAssistWindowViewportBodyClone(stats);
        } catch (e) {
            return null;
        }
    }

    function isAssistPinnedBottomCandidate(element, computed) {
        try {
            if (!element || !(element instanceof Element)) return false;
            if (element === document.body || element === document.documentElement) return false;
            if (shouldSkipAssistElement(element, computed)) return false;
            const position = String(computed && computed.position || '').toLowerCase();
            if (position !== 'fixed' && position !== 'sticky') return false;
            const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
            const viewportHeight = Math.max(0, Math.round(window.innerHeight || 0));
            const viewportWidth = Math.max(0, Math.round(window.innerWidth || 0));
            if (!rect || rect.height < 24 || rect.width < Math.max(120, Math.round(viewportWidth * 0.35))) return false;
            if (rect.bottom < Math.round(viewportHeight * 0.82) || rect.top > viewportHeight) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    function collectAssistPinnedBottomElements(limit) {
        try {
            if (!document.body) return [];
            const selected = [];
            const elements = Array.prototype.slice.call(document.body.querySelectorAll('*')).reverse();
            for (let i = 0; i < elements.length; i += 1) {
                if (selected.length >= limit) break;
                const element = elements[i];
                const computed = window.getComputedStyle(element);
                if (!isAssistPinnedBottomCandidate(element, computed)) continue;
                if (selected.some(function(existing) { return existing === element || existing.contains(element) || element.contains(existing); })) continue;
                selected.push(element);
            }
            return selected.reverse();
        } catch (e) {
            return [];
        }
    }

    function prependAssistPinnedBottomClones(container, stats, usedNodeIds) {
        try {
            if (!container || !(container instanceof Element)) return;
            const pinnedElements = collectAssistPinnedBottomElements(ASSIST_PINNED_BOTTOM_LIMIT);
            pinnedElements.forEach(function(element) {
                const nodeId = ensureAssistNodeId(element);
                if (nodeId && usedNodeIds && usedNodeIds.has(nodeId)) return;
                if (nodeId && container.querySelector(`[data-ra-node-id="${String(nodeId).replace(/"/g, '\\"')}"]`)) return;
                const pinnedStats = { nodeCount: 0, truncated: false, maxNodeCount: ASSIST_PINNED_BOTTOM_NODE_BUDGET };
                const pinnedClone = buildAssistClone(element, pinnedStats);
                if (!pinnedClone) return;
                container.appendChild(pinnedClone);
                if (nodeId && usedNodeIds) usedNodeIds.add(nodeId);
                if (stats) {
                    stats.nodeCount += pinnedStats.nodeCount;
                    if (pinnedStats.truncated) stats.truncated = true;
                }
            });
        } catch (e) {}
    }

    function buildAssistMaskedValue(element) {
        try {
            if (!element) return '';
            const tag = element.tagName;
            const type = String(element.getAttribute('type') || '').toLowerCase();
            if (tag === 'TEXTAREA') return String(element.value || '');
            if (tag === 'INPUT') {
                if (type === 'password') return element.value ? '••••' : '';
                if (type === 'checkbox' || type === 'radio') return element.checked ? '已选中' : '未选中';
                return String(element.value || '');
            }
            if (tag === 'SELECT') {
                const option = element.options && element.selectedIndex >= 0 ? element.options[element.selectedIndex] : null;
                return option ? String(option.textContent || '').trim() : '';
            }
        } catch (e) {}
        return '';
    }

    function buildAssistFieldDisplayState(element) {
        const text = buildAssistMaskedValue(element);
        if (text) {
            return { text: text, placeholder: false };
        }
        try {
            if (!element) return { text: '', placeholder: false };
            const tag = element.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') {
                const placeholder = String(element.getAttribute('placeholder') || '').trim();
                if (placeholder) {
                    return { text: placeholder, placeholder: true };
                }
            }
        } catch (e) {}
        return { text: '', placeholder: false };
    }

    function buildAssistClone(node, stats) {
        const maxNodeCount = Math.max(1, Number(stats && stats.maxNodeCount) || ASSIST_MAX_NODE_COUNT);
        if (!node || stats.nodeCount >= maxNodeCount) {
            stats.truncated = true;
            return null;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            const text = String(node.textContent || '');
            if (!text.trim()) return document.createTextNode(text);
            return document.createTextNode(text);
        }
        if (!(node instanceof Element)) return null;
        const computed = window.getComputedStyle(node);
        if (shouldSkipAssistElement(node, computed)) return null;
        if (ASSIST_PLACEHOLDER_TAGS.has(node.tagName)) {
            return buildAssistPlaceholder(node, stats, node.tagName.toLowerCase());
        }
        const tagName = node.tagName.toLowerCase();
        if (tagName === 'svg') {
            return buildAssistSvgClone(node, stats, computed);
        }
        if (tagName === 'img') {
            const src = sanitizeAssistUrl(node.currentSrc || node.src || node.getAttribute('src') || '');
            if (!src) return buildAssistPlaceholder(node, stats, 'img');
            const clone = document.createElement('img');
            decorateAssistClone(node, clone, tagName, computed);
            clone.setAttribute('src', src);
            clone.setAttribute('loading', 'lazy');
            clone.setAttribute('decoding', 'async');
            const alt = String(node.getAttribute('alt') || '').trim();
            if (alt) clone.setAttribute('alt', alt);
            stats.nodeCount += 1;
            return clone;
        }
        const cloneTag = ['html', 'body', 'input', 'textarea', 'select'].includes(tagName) ? 'div' : tagName;
        const clone = document.createElement(cloneTag);
        decorateAssistClone(node, clone, tagName, computed);
        if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
            const displayState = buildAssistFieldDisplayState(node);
            clone.textContent = displayState.text;
            if (displayState.placeholder) {
                clone.setAttribute('data-ra-input-placeholder', '1');
                clone.setAttribute('style', (clone.getAttribute('style') || '') + ';color:#94a3b8;');
            }
        } else if (node.tagName === 'SELECT') {
            clone.textContent = buildAssistMaskedValue(node);
        } else {
            for (let i = 0; i < node.childNodes.length; i += 1) {
                const child = buildAssistClone(node.childNodes[i], stats);
                if (child) clone.appendChild(child);
                if (stats.nodeCount >= maxNodeCount) break;
            }
        }
        stats.nodeCount += 1;
        return clone;
    }

    function buildAssistSnapshotPayload(reason) {
        try {
            const rawRoute = window.location.pathname + window.location.search + window.location.hash;
            const route = normalizeAssistRoute();
            if (route.indexOf('/admin/ak-web/') !== 0) {
                return {
                    route: route,
                    title: document.title || '',
                    html: '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#f8fafc;color:#334155;font-family:Arial,Helvetica,sans-serif;}body{padding:20px;} .ra-empty{border:1px dashed rgba(148,163,184,0.6);border-radius:12px;padding:16px;background:#ffffff;} .ra-route{margin-top:10px;color:#64748b;font-size:12px;word-break:break-all;}</style></head><body><div class="ra-empty"><div>当前用户页面暂不在可协助的 AK 页面内</div><div class="ra-route">' + escapeAssistHtml(rawRoute || '/') + '</div></div></body></html>',
                    viewport: {
                        width: window.innerWidth || 0,
                        height: window.innerHeight || 0,
                        devicePixelRatio: window.devicePixelRatio || 1
                    },
                    scroll: {
                        top: window.scrollY || 0,
                        left: window.scrollX || 0
                    },
                    node_count: 0,
                    truncated: false
                };
            }
            if (!document.body) return null;
            assistNodeElementMap = new Map();
            const useViewportMode = shouldUseAssistViewportSnapshot(reason);
            logAssistDebug('snapshot_mode', {
                reason: reason || '',
                route: route,
                use_viewport_mode: useViewportMode,
                scroll_target: getAssistDebugTargetMode(assistScrollTarget),
                doc_height: Math.round(getAssistDocumentScrollHeight()),
                last_truncated: !!(assistLastSnapshotPayload && assistLastSnapshotPayload.truncated)
            }, [reason || '', route, useViewportMode ? 'viewport' : 'full', getAssistDebugTargetMode(assistScrollTarget), Math.round(getAssistDocumentScrollHeight()), !!(assistLastSnapshotPayload && assistLastSnapshotPayload.truncated)].join('|'));
            const stats = { nodeCount: 0, truncated: false, maxNodeCount: useViewportMode ? ASSIST_VIEWPORT_NODE_LIMIT : ASSIST_MAX_NODE_COUNT };
            const viewportTarget = useViewportMode ? getAssistActiveViewportTarget() : assistScrollTarget;
            let bodyClone = useViewportMode ? buildAssistViewportBodyClone(stats, viewportTarget) : buildAssistClone(document.body, stats);
            if (!bodyClone && useViewportMode) {
                stats.nodeCount = 0;
                stats.truncated = false;
                stats.maxNodeCount = ASSIST_MAX_NODE_COUNT;
                bodyClone = buildAssistClone(document.body, stats);
            }
            if (!bodyClone) return null;
            if (!useViewportMode) {
                prependAssistPinnedBottomClones(bodyClone, stats);
            }
            const headMarkup = buildAssistHeadMarkup();
            const bodyAttrs = buildAssistBodyAttrs();
            const wrapper = document.createElement('div');
            wrapper.appendChild(bodyClone);
            let html = '<!doctype html><html><head>' + headMarkup + '<style>html,body{margin:0;padding:0;background:#f8fafc;color:#0f172a;font-family:Arial,Helvetica,sans-serif;}*{box-sizing:border-box;}[data-ra-node-id]{cursor:crosshair;}img{max-width:100%;}</style></head><body' + bodyAttrs + '>' + wrapper.innerHTML + '</body></html>';
            if (html.length > ASSIST_MAX_HTML_LENGTH) {
                html = html.slice(0, ASSIST_MAX_HTML_LENGTH);
                stats.truncated = true;
            }
            const scrollPayload = buildAssistScrollPayload(useViewportMode ? viewportTarget : assistScrollTarget);
            logAssistDebug('snapshot_payload_ready', {
                reason: reason || '',
                route: route,
                use_viewport_mode: useViewportMode,
                node_count: stats.nodeCount,
                truncated: !!stats.truncated,
                html_length: html.length,
                scroll_mode: String(scrollPayload && scrollPayload.mode || ''),
                scroll_top: Math.max(0, Math.round(scrollPayload && scrollPayload.top || 0))
            });
            return {
                route: route,
                title: document.title || '',
                html: html,
                viewport: {
                    width: window.innerWidth || 0,
                    height: window.innerHeight || 0,
                    devicePixelRatio: window.devicePixelRatio || 1
                },
                scroll: scrollPayload,
                node_count: stats.nodeCount,
                truncated: !!stats.truncated
            };
        } catch (e) {
            console.error('[AKChatAssist] 构建快照失败:', e);
            return null;
        }
    }

    function sendAssistSnapshotPayload(payload) {
        if (!payload) return false;
        const sent = sendAssistEvent('snapshot_replace', payload);
        if (sent) {
            assistLastSnapshotPayload = payload;
            assistLastSnapshotSentAt = Date.now();
        }
        return sent;
    }

    function rememberAssistScrollTarget(target) {
        try {
            if (!target || target === window || target === document || target === document.body || target === document.documentElement) {
                assistScrollTarget = window;
                return;
            }
            assistScrollTarget = target instanceof Element ? target : window;
        } catch (e) {
            assistScrollTarget = window;
        }
    }

    function buildAssistScrollPayload(target) {
        const payload = {
            top: Math.max(0, Math.round(window.scrollY || window.pageYOffset || 0)),
            left: Math.max(0, Math.round(window.scrollX || window.pageXOffset || 0)),
            viewport_height: Math.max(0, Math.round(window.innerHeight || 0)),
            viewport_width: Math.max(0, Math.round(window.innerWidth || 0)),
            mode: 'window'
        };
        try {
            const activeTarget = target || assistScrollTarget || window;
            if (activeTarget && activeTarget !== window && activeTarget instanceof Element) {
                const tagName = String(activeTarget.tagName || 'div').toLowerCase();
                payload.top = Math.max(0, Math.round(activeTarget.scrollTop || 0));
                payload.left = Math.max(0, Math.round(activeTarget.scrollLeft || 0));
                payload.viewport_height = Math.max(0, Math.round(activeTarget.clientHeight || window.innerHeight || 0));
                payload.viewport_width = Math.max(0, Math.round(activeTarget.clientWidth || window.innerWidth || 0));
                payload.mode = 'element';
                payload.node_id = ensureAssistNodeId(activeTarget);
                payload.selector_hint = buildAssistSelectorHint(activeTarget, tagName);
            }
        } catch (e) {}
        return payload;
    }

    function emitAssistScroll(force) {
        if (!assistSessionId) return false;
        const payload = buildAssistScrollPayload();
        if (!force
            && assistLastScrollPayload
            && assistLastScrollPayload.mode === payload.mode
            && (assistLastScrollPayload.node_id || '') === (payload.node_id || '')
            && assistLastScrollPayload.top === payload.top
            && assistLastScrollPayload.left === payload.left) {
            return false;
        }
        const sent = sendAssistEvent('scroll_changed', payload);
        if (sent) {
            assistLastScrollPayload = payload;
        }
        return sent;
    }

    function scheduleAssistScroll(delay) {
        if (!assistSessionId) return;
        clearAssistScrollTimer();
        assistScrollTimer = setTimeout(function() {
            emitAssistScroll(false);
        }, typeof delay === 'number' ? delay : 120);
    }

    function emitAssistSnapshot(reason) {
        if (!assistSessionId) return false;
        const now = Date.now();
        const route = normalizeAssistRoute();
        if (reason === 'snapshot_request'
            && assistLastSnapshotPayload
            && assistLastSnapshotPayload.route === route
            && (now - assistLastSnapshotSentAt) < 3000) {
            return sendAssistSnapshotPayload(assistLastSnapshotPayload);
        }
        if ((reason === 'connect_open' || reason === 'session_state')
            && assistLastSnapshotPayload
            && assistLastSnapshotPayload.route === route
            && (now - assistLastSnapshotSentAt) < 1200) {
            return false;
        }
        const payload = buildAssistSnapshotPayload(reason);
        if (!payload) return false;
        if (assistLastSnapshotPayload
            && assistLastSnapshotPayload.route === payload.route
            && assistLastSnapshotPayload.html === payload.html
            && (now - assistLastSnapshotSentAt) < 5000
            && reason !== 'snapshot_request') {
            return false;
        }
        return sendAssistSnapshotPayload(payload);
    }

    function scheduleAssistSnapshot(delay, reason) {
        if (!assistSessionId) return;
        clearAssistSnapshotTimer();
        assistSnapshotTimer = setTimeout(function() {
            emitAssistSnapshot(reason || 'mutation');
        }, typeof delay === 'number' ? delay : 500);
    }

    function startAssistDomObserver() {
        stopAssistDomObserver();
        if (!assistSessionId || !document.body || typeof MutationObserver === 'undefined') return;
        assistMutationObserver = new MutationObserver(function(mutations) {
            if (normalizeAssistRoute().indexOf('/admin/ak-web/') !== 0) return;
            if (Date.now() < assistSuppressSnapshotUntil) return;
            const shouldRefresh = (mutations || []).some(function(mutation) {
                const target = mutation && mutation.target && mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target;
                return target && !(target.closest && target.closest('#ak-admin-chat'));
            });
            if (shouldRefresh) {
                scheduleAssistSnapshot(600, 'mutation');
            }
        });
        assistMutationObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
        });
    }

    function isAssistWidgetTarget(target) {
        try {
            return !!(target && target.closest && target.closest('#ak-admin-chat'));
        } catch (e) {
            return false;
        }
    }

    function isAssistFormFieldTarget(target) {
        try {
            const tagName = String(target && target.tagName || '').toUpperCase();
            return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
        } catch (e) {
            return false;
        }
    }

    function handleAssistFormValueChange(event) {
        const target = event && event.target;
        if (!assistWs || assistWs.readyState !== WebSocket.OPEN || !assistSessionId) return;
        if (!isAssistFormFieldTarget(target) || isAssistWidgetTarget(target)) return;
        if (normalizeAssistRoute().indexOf('/admin/ak-web/') !== 0) return;
        scheduleAssistSnapshot(120, 'form_input');
    }

    function pickAssistMeta(target) {
        try {
            if (!target) return {};
            const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
            const selector = target.id
                ? ('#' + target.id)
                : (((target.className && typeof target.className === 'string' && target.className.trim())
                    ? ((target.tagName || 'div').toLowerCase() + '.' + target.className.trim().split(/\s+/).slice(0, 2).join('.'))
                    : (target.tagName || 'div').toLowerCase()));
            return {
                node_id: ensureAssistNodeId(target),
                selector_hint: selector,
                text_hint: String(target.innerText || target.textContent || '').trim().slice(0, 40),
                rect: rect ? {
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                    w: Math.round(rect.width),
                    h: Math.round(rect.height)
                } : null
            };
        } catch (e) {
            return {};
        }
    }

    function sendAssistEvent(type, payload) {
        try {
            if (!assistWs || assistWs.readyState !== WebSocket.OPEN || !assistSessionId) return false;
            assistWs.send(JSON.stringify({
                type: type,
                payload: payload || {}
            }));
            return true;
        } catch (e) {
            return false;
        }
    }

    function emitAssistRoute() {
        if (!assistSessionId) return;
        const route = normalizeAssistRoute();
        if (route.indexOf('/admin/ak-web/') !== 0) return;
        sendAssistEvent('route_changed', {
            route: route,
            title: document.title || '',
            replace: false
        });
    }

    function scheduleAssistReconnect() {
        clearAssistReconnectTimer();
        if (!assistSessionId) return;
        assistReconnectTimer = setTimeout(function() {
            connectAssist(assistSessionId);
        }, 1500);
    }

    function disconnectAssist(sessionId, silent) {
        if (sessionId && assistSessionId && String(sessionId) !== String(assistSessionId)) return;
        clearAssistReconnectTimer();
        stopAssistHeartbeat();
        stopAssistDomObserver();
        clearAssistScrollTimer();
        assistSessionId = '';
        assistScrollTarget = window;
        assistDebugSignatures = Object.create(null);
        assistCachedHeadRoute = '';
        assistCachedHeadMarkup = '';
        assistLastSnapshotPayload = null;
        assistLastSnapshotSentAt = 0;
        assistLastScrollPayload = null;
        if (!assistWs) return;
        const current = assistWs;
        assistWs = null;
        try {
            if (!silent && current.readyState === WebSocket.OPEN) {
                current.close();
                return;
            }
            if (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING) {
                current.close();
            }
        } catch (e) {}
    }

    function connectAssist(sessionId) {
        const wantedSessionId = String(sessionId || '').trim();
        if (!wantedSessionId) return;
        if (assistWs && (assistWs.readyState === WebSocket.OPEN || assistWs.readyState === WebSocket.CONNECTING) && assistSessionId === wantedSessionId) {
            return;
        }
        if (assistSessionId && assistSessionId !== wantedSessionId) {
            disconnectAssist('', true);
        }
        clearAssistReconnectTimer();
        assistSessionId = wantedSessionId;
        try {
            const currentAssistWs = new WebSocket(ASSIST_WS_URL + '?session_id=' + encodeURIComponent(wantedSessionId) + '&role=user&site=ak_web&readonly=0');
            assistWs = currentAssistWs;
            currentAssistWs.onopen = function() {
                if (assistWs !== currentAssistWs) return;
                startAssistHeartbeat();
                emitAssistRoute();
                emitAssistSnapshot('connect_open');
                emitAssistScroll(true);
                startAssistDomObserver();
            };
            currentAssistWs.onmessage = function(e) {
                if (assistWs !== currentAssistWs) return;
                try {
                    const data = JSON.parse(e.data || '{}');
                    if (data.type === 'click_highlight' && data.payload) {
                        applyAssistHighlight(data.payload);
                    } else if (data.type === 'snapshot_request') {
                        emitAssistSnapshot('snapshot_request');
                    } else if (data.type === 'session_state') {
                        emitAssistRoute();
                        if (!data.payload || !data.payload.has_snapshot) {
                            emitAssistSnapshot('session_state');
                        }
                    }
                } catch (err) {
                    console.error('[AKChatAssist] 消息处理错误:', err);
                }
            };
            currentAssistWs.onclose = function(event) {
                if (assistWs !== currentAssistWs) return;
                if (Number((event && event.code) || 0) === 1008) {
                    disconnectAssist(wantedSessionId, true);
                    return;
                }
                stopAssistHeartbeat();
                stopAssistDomObserver();
                assistWs = null;
                scheduleAssistReconnect();
            };
            currentAssistWs.onerror = function(err) {
                if (assistWs !== currentAssistWs) return;
                console.error('[AKChatAssist] WebSocket 错误:', err);
            };
        } catch (e) {
            scheduleAssistReconnect();
        }
    }

    function isPresenceForeground() {
        return !document.hidden;
    }

    function sendPresence(type) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            logChatWsDebug('send_presence_skipped', { type: type });
            return false;
        }
        try {
            ws.send(JSON.stringify({
                type: type,
                username: username,
                page: window.location.pathname + window.location.hash,
                userAgent: navigator.userAgent
            }));
            logChatWsDebug('send_presence', { type: type });
            return true;
        } catch(e) {
            logChatWsDebug('send_presence_error', {
                type: type,
                message: String((e && e.message) || e || '')
            });
            return false;
        }
    }

    function scheduleReconnect(reason) {
        clearReconnectTimer();
        if (presenceSuspended) {
            logChatWsDebug('schedule_reconnect_skipped', {
                reason: String(reason || ''),
                cause: 'presence_suspended'
            });
            return;
        }
        logChatWsDebug('schedule_reconnect', {
            reason: String(reason || ''),
            delay_ms: 5000
        });
        reconnectTimer = setTimeout(function() {
            connect();
        }, 5000);
    }

    function suspendPresence(reason) {
        logChatWsDebug('suspend_presence', {
            reason: String(reason || ''),
            wsStateBeforeClose: getChatWsReadyStateLabel(ws)
        });
        presenceSuspended = true;
        stopHeartbeat();
        clearReconnectTimer();
        if (!ws) return;
        const currentWs = ws;
        sendPresence('offline');
        setTimeout(function() {
            if (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING) {
                currentWs.close();
            }
        }, 80);
    }

    function resumePresence(reason) {
        logChatWsDebug('resume_presence', {
            reason: String(reason || ''),
            wsStateBeforeResume: getChatWsReadyStateLabel(ws)
        });
        presenceSuspended = false;
        clearReconnectTimer();
        if (ws && ws.readyState === WebSocket.OPEN) {
            sendPresence('online');
            startHeartbeat();
            return;
        }
        connect();
    }
    
    // 连接WebSocket
    function connect() {
        // 获取用户名
        username = getUsername();
        clearReconnectTimer();
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            logChatWsDebug('connect_skipped_existing', {
                wsState: getChatWsReadyStateLabel(ws)
            });
            return;
        }
        
        try {
            logChatWsDebug('connect_start', {
                username: String(username || ''),
                wsUrl: WS_URL
            });
            ws = new WebSocket(WS_URL + '?username=' + encodeURIComponent(username));
            
            ws.onopen = function() {
                logChatWsDebug('ws_open', {
                    username: String(username || '')
                });
                if (!isPresenceForeground() || presenceSuspended) {
                    presenceSuspended = true;
                    ws.close();
                    return;
                }
                sendPresence('online');
                startHeartbeat();
            };
            
            ws.onmessage = function(e) {
                try {
                    const data = JSON.parse(e.data);
                    
                    if (data.type === 'admin_message') {
                        // 收到管理员消息 - 唯一可以弹出窗口的情况
                        addMessage(data.content, true, data.time);
                        showChat();
                        playNotificationSound();
                    } else if (data.type === 'remote_assist_bind') {
                        connectAssist(data.session_id || '');
                    } else if (data.type === 'remote_assist_unbind') {
                        disconnectAssist(data.session_id || '', true);
                    } else if (data.type === 'history') {
                        // 加载历史消息 - 静默加载，不弹出窗口
                        if (data.messages && data.messages.length > 0) {
                            data.messages.forEach(function(msg) {
                                addMessage(msg.content, msg.is_admin, msg.time);
                            });
                        }
                    }
                } catch(err) {
                    console.error('[AKChat] 消息处理错误:', err);
                }
            };
            
            ws.onclose = function(event) {
                logChatWsDebug('ws_close', {
                    code: Number((event && event.code) || 0),
                    reason: String((event && event.reason) || ''),
                    wasClean: !!(event && event.wasClean)
                });
                stopHeartbeat();
                ws = null;
                scheduleReconnect('ws_onclose');
            };
            
            ws.onerror = function(err) {
                logChatWsDebug('ws_error', {
                    type: String((err && err.type) || ''),
                    wsState: getChatWsReadyStateLabel(ws)
                });
                console.error('[AKChat] WebSocket 错误:', err);
            };
        } catch(e) {
            logChatWsDebug('connect_exception', {
                message: String((e && e.message) || e || '')
            });
            scheduleReconnect('connect_exception');
        }
    }
    
    // 显示聊天窗口
    function showChat() {
        if (chatBox) {
            chatBox.classList.add('visible');
        }
        isOpen = true;
    }
    
    // 关闭聊天窗口
    function closeChat() {
        chatBox.classList.remove('visible');
        isOpen = false;
    }
    
    // 发送消息
    function sendMessage() {
        const content = inputEl.value.trim();
        if (!content) return;
        
        // 检查WebSocket连接状态
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.error('[AKChat] WebSocket未连接，无法发送消息');
            alert('连接已断开，消息发送失败');
            return;
        }
        
        try {
            ws.send(JSON.stringify({
                type: 'user_message',
                content: content
            }));
            addMessage(content, false);
            inputEl.value = '';
        } catch(e) {
            console.error('[AKChat] 发送消息失败:', e);
            alert('发送失败，请重试');
        }
    }
    
    // 重连WebSocket（登录后调用）
    function reconnect() {
        suspendPresence('manual_reconnect');
        // 重新获取用户名并连接
        username = getUsername();
        if (isPresenceForeground()) {
            resumePresence('manual_reconnect');
        }
    }
    
    // 暴露全局API
    window.AKChat = {
        show: showChat,
        close: closeChat,
        send: sendMessage,
        reconnect: reconnect
    };
    
    // 监听SPA路由变化（history.pushState / replaceState / 浏览器前进后退）
    function onUrlChange() {
        if (ws && ws.readyState === WebSocket.OPEN && !document.hidden) {
            sendPresence('online');
        }
        if (assistWs && assistWs.readyState === WebSocket.OPEN) {
            assistScrollTarget = window;
            emitAssistRoute();
            scheduleAssistSnapshot(80, 'route_change');
            scheduleAssistScroll(40);
        }
    }
    (function() {
        var origPush = history.pushState.bind(history);
        var origReplace = history.replaceState.bind(history);
        history.pushState = function() { origPush.apply(history, arguments); onUrlChange(); };
        history.replaceState = function() { origReplace.apply(history, arguments); onUrlChange(); };
    })();
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('scroll', function() {
        if (!assistWs || assistWs.readyState !== WebSocket.OPEN || !assistSessionId) return;
        if (normalizeAssistRoute().indexOf('/admin/ak-web/') !== 0) return;
        rememberAssistScrollTarget(window);
        scheduleAssistScroll(120);
        if (shouldUseAssistViewportSnapshot('scroll_viewport')) {
            scheduleAssistSnapshot(ASSIST_VIEWPORT_SCROLL_SNAPSHOT_DELAY, 'scroll_viewport');
        }
    }, { passive: true });
    document.addEventListener('scroll', function(event) {
        if (!assistWs || assistWs.readyState !== WebSocket.OPEN || !assistSessionId) return;
        if (normalizeAssistRoute().indexOf('/admin/ak-web/') !== 0) return;
        const target = event && event.target;
        if (isAssistWidgetTarget(target)) return;
        rememberAssistScrollTarget(target);
        scheduleAssistScroll(120);
        if (shouldUseAssistViewportSnapshot('scroll_viewport')) {
            scheduleAssistSnapshot(ASSIST_VIEWPORT_SCROLL_SNAPSHOT_DELAY, 'scroll_viewport');
        }
    }, true);
    document.addEventListener('click', function(event) {
        if (!assistWs || assistWs.readyState !== WebSocket.OPEN || !assistSessionId) return;
        if (isAssistWidgetTarget(event.target)) return;
        if (normalizeAssistRoute().indexOf('/admin/ak-web/') !== 0) return;
        sendAssistEvent('click_highlight', pickAssistMeta(event.target));
    }, true);
    document.addEventListener('input', handleAssistFormValueChange, true);
    document.addEventListener('change', handleAssistFormValueChange, true);

    document.addEventListener('visibilitychange', function() {
        logChatWsDebug('dom_visibilitychange', {
            hidden: !!document.hidden
        });
        if (document.hidden) {
            suspendPresence('visibilitychange:hidden');
        } else {
            resumePresence('visibilitychange:visible');
        }
    });

    window.addEventListener('pagehide', function() {
        logChatWsDebug('window_pagehide');
        disconnectAssist('', true);
        suspendPresence('pagehide');
    });
    window.addEventListener('pageshow', function() {
        logChatWsDebug('window_pageshow');
        if (isPresenceForeground()) resumePresence('pageshow');
    });
    window.addEventListener('blur', function() {
        logChatWsDebug('window_blur', {
            hidden: !!document.hidden
        });
    });
    window.addEventListener('focus', function() {
        logChatWsDebug('window_focus', {
            hidden: !!document.hidden
        });
        if (isPresenceForeground()) resumePresence('focus');
    });
    window.addEventListener('beforeunload', function() {
        logChatWsDebug('window_beforeunload');
        disconnectAssist('', true);
        suspendPresence('beforeunload');
    });
    
    // DOM加载完成后立即连接（不等待所有资源加载）
    setTimeout(function() {
        if (isPresenceForeground()) {
            resumePresence('initial_boot');
        }
    }, 100);
    
    } // 结束 initChatWidget 函数
    
    // 等待 body 加载完成后初始化聊天组件
    function tryInit() {
        if (document.body) {
            initChatWidget();
        } else {
            setTimeout(tryInit, 100);
        }
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryInit);
    } else {
        tryInit();
    }
    
})();
