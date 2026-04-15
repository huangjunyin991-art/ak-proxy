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
    const REMOTE_VOICE_CLIENT_URL = `${window.location.origin}/admin/api/remote-voice-client`;
    const WIDGET_ASSET_VERSION = String(window.__AK_WIDGET_ASSET_VERSION__ || '').trim();
    const ASSIST_ROUTE_PREFIX = '/admin/ak-web';
    const ASSIST_NATIVE_ROUTE_PREFIX = '/ak-web';
    function withWidgetAssetVersion(url) {
        try {
            const finalUrl = new URL(String(url || ''), window.location.origin);
            if (WIDGET_ASSET_VERSION) finalUrl.searchParams.set('v', WIDGET_ASSET_VERSION);
            return finalUrl.toString();
        } catch (e) {
            return String(url || '');
        }
    }
    const NOTIFICATION_WIDGET_URL = withWidgetAssetVersion(`${window.location.origin}/chat/notification-widget.js`);
    const IM_PLUGIN_ENTRY_URL = withWidgetAssetVersion(`${window.location.origin}/chat/plugins/im/user/im_entry.js`);
    const HEARTBEAT_INTERVAL = 5000; // 5秒心跳间隔
    
    // 状态
    let ws = null;
    let assistWs = null;
    let assistSessionId = '';
    let assistReconnectTimer = null;
    let assistHeartbeatTimer = null;
    let assistMutationObserver = null;
    let assistSnapshotTimer = null;
    let assistOverlaySnapshotTimer = null;
    let assistOverlaySnapshotToken = 0;
    let assistScrollTimer = null;
    let assistNodeSeq = 0;
    let assistNodeIdMap = new WeakMap();
    let assistNodeElementMap = new Map();
    let assistSuppressSnapshotUntil = 0;
    let assistCachedHeadRoute = '';
    let assistCachedHeadMarkup = '';
    let assistLastSnapshotPayload = null;
    let assistLastSnapshotSentAt = 0;
    let assistTraceSeq = 0;
    let assistLastSnapshotTriggerMeta = null;
    let assistLastScrollPayload = null;
    let assistScrollTarget = window;
    let assistLastElementScrollTarget = null;
    let assistLastElementScrollAt = 0;
    let assistLastScrollTargetRefreshAt = 0;
    let assistLastScrollCaptureDebugKey = '';
    let assistLastScrollCaptureDebugAt = 0;
    let assistRouteSettleTimer = null;
    let assistRouteFastSnapshotTimer = null;
    let assistRouteFastSnapshotRoute = '';
    let assistRouteFastScrollTimer = null;
    let assistRouteFastScrollRoute = '';
    let assistRouteFastScrollDispatched = false;
    let assistRouteSettleUntil = 0;
    let assistRouteSettleRoute = '';
    let assistRouteSettleNeedsFreshSnapshot = false;
    let isOpen = false;
    let hasNewMessage = false;
    let messageCount = 0;
    let username = 'visitor';
    let heartbeatTimer = null;
    let reconnectTimer = null;
    let presenceSuspended = false;
    let pendingAssistRequest = null;
    let pendingVoiceRequest = null;
    const CHAT_PAGE_CLIENT_ID_STORAGE_KEY = 'ak_chat_page_client_id';
    const ASSIST_SESSION_STORAGE_KEY = 'ak_chat_assist_session_id';
    let pageClientId = '';
    let remoteVoiceLibraryPromise = null;
    let remoteVoiceClient = null;
    let remoteVoiceSessionId = '';
    let remoteVoiceStatus = '';
    let remoteVoiceMutedSelf = false;
    let remoteVoiceMutedPeer = false;
    let remoteVoiceLocalLevel = 0;
    let remoteVoiceRemoteLevel = 0;
    let remoteVoiceConnectedRoles = [];

    function buildGuestUsername() {
        return 'guest_' + Math.random().toString(36).substr(2, 6);
    }

    function pickUsernameFromObject(source) {
        if (!source || typeof source !== 'object') return '';
        const fields = ['UserName', 'username', 'Account', 'account'];
        for (let i = 0; i < fields.length; i++) {
            const value = source[fields[i]];
            if (typeof value === 'string' && value.trim()) {
                return String(value).trim();
            }
        }
        return '';
    }

    function getStoredUserModelUsername() {
        const keys = ['AK_user_model'];
        try {
            if (window.APP && APP.CONFIG && APP.CONFIG.SYSTEM_KEYS && APP.CONFIG.SYSTEM_KEYS.USER_MODEL_KEY) {
                const storeKey = String(APP.CONFIG.SYSTEM_KEYS.USER_MODEL_KEY || '').trim();
                if (storeKey && keys.indexOf(storeKey) === -1) {
                    keys.unshift(storeKey);
                }
            }
        } catch (e) {}
        try {
            for (let i = 0; i < keys.length; i++) {
                const raw = localStorage.getItem(keys[i]);
                if (!raw) continue;
                const parsed = JSON.parse(raw);
                const resolved = pickUsernameFromObject(parsed);
                if (resolved) return resolved;
            }
        } catch (e) {}
        return '';
    }

    function getStoredCanonicalUsername() {
        const storageKeys = ['UserData', 'ak_login_result'];
        const stores = [localStorage, sessionStorage];
        try {
            for (let si = 0; si < stores.length; si++) {
                const store = stores[si];
                if (!store) continue;
                for (let i = 0; i < storageKeys.length; i++) {
                    const raw = store.getItem(storageKeys[i]);
                    if (!raw) continue;
                    const parsed = JSON.parse(raw);
                    const target = storageKeys[i] === 'ak_login_result'
                        ? (parsed && parsed.UserData && typeof parsed.UserData === 'object' ? parsed.UserData : null)
                        : parsed;
                    const resolved = pickUsernameFromObject(target);
                    if (resolved) return resolved;
                }
            }
        } catch (e) {}
        return '';
    }

    function schedulePresenceIdentityRefresh() {
        [1200, 4200].forEach(function(delay) {
            setTimeout(function() {
                if (!ws || ws.readyState !== WebSocket.OPEN) return;
                if (!isPresenceForeground() || presenceSuspended) return;
                const nextUsername = getUsername();
                if (!nextUsername || nextUsername === username) return;
                sendPresence('online');
            }, delay);
        });
    }

    function generatePageClientId() {
        return 'cp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }

    function getPageClientId() {
        if (pageClientId) return pageClientId;
        try {
            const stored = String(sessionStorage.getItem(CHAT_PAGE_CLIENT_ID_STORAGE_KEY) || '').trim();
            if (stored) {
                pageClientId = stored;
                return pageClientId;
            }
            pageClientId = generatePageClientId();
            sessionStorage.setItem(CHAT_PAGE_CLIENT_ID_STORAGE_KEY, pageClientId);
            return pageClientId;
        } catch (e) {
            pageClientId = pageClientId || generatePageClientId();
            return pageClientId;
        }
    }

    function getChatWsReadyStateLabel(targetWs) {
        if (!targetWs) return 'NULL';
        if (targetWs.readyState === WebSocket.CONNECTING) return 'CONNECTING';
        if (targetWs.readyState === WebSocket.OPEN) return 'OPEN';
        if (targetWs.readyState === WebSocket.CLOSING) return 'CLOSING';
        if (targetWs.readyState === WebSocket.CLOSED) return 'CLOSED';
        return String(targetWs.readyState);
    }

    function logChatWsDebug(eventName, extra) {
        return;
    }

    function reportAssistClientDebug(eventName, extra) {
        return;
    }

    function logAssistDebug(eventName, extra) {
        return;
    }

    function readPersistedAssistSessionId() {
        try {
            return String(sessionStorage.getItem(ASSIST_SESSION_STORAGE_KEY) || '').trim();
        } catch (e) {
            return '';
        }
    }

    function persistAssistSessionId(sessionId) {
        const nextSessionId = String(sessionId || '').trim();
        try {
            if (!nextSessionId) {
                sessionStorage.removeItem(ASSIST_SESSION_STORAGE_KEY);
                return '';
            }
            sessionStorage.setItem(ASSIST_SESSION_STORAGE_KEY, nextSessionId);
        } catch (e) {}
        return nextSessionId;
    }

    function restoreAssistSessionId() {
        if (assistSessionId) return String(assistSessionId || '').trim();
        const storedSessionId = readPersistedAssistSessionId();
        if (!storedSessionId) return '';
        assistSessionId = storedSessionId;
        return storedSessionId;
    }

    function getAssistPerfNow() {
        return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();
    }

    function buildAssistTraceMeta(type, route, reason) {
        assistTraceSeq += 1;
        const clientEmitTs = Date.now();
        return {
            trace_id: `rat_${clientEmitTs.toString(36)}_${assistTraceSeq.toString(36)}`,
            client_emit_ts: clientEmitTs,
            trace_type: String(type || ''),
            trace_reason: String(reason || ''),
            trace_route: String(route || '')
        };
    }

    function markAssistSnapshotTrigger(reason, extra) {
        assistLastSnapshotTriggerMeta = {
            reason: String(reason || ''),
            at: getAssistPerfNow(),
            extra: extra || {}
        };
    }

    function shouldLogAssistSnapshotBuild(reason, buildMs, triggerWaitMs) {
        const normalizedReason = String(reason || '');
        return buildMs >= ASSIST_SNAPSHOT_BUILD_LOG_THRESHOLD_MS
            || triggerWaitMs >= ASSIST_SNAPSHOT_TRIGGER_LOG_THRESHOLD_MS
            || normalizedReason === 'route_fast_frame'
            || normalizedReason === 'route_fast_scroll'
            || normalizedReason === 'route_settled'
            || normalizedReason === 'route_settled_request'
            || normalizedReason === 'click_interaction'
            || normalizedReason === 'snapshot_request'
            || normalizedReason === 'session_state';
    }
    
    // 从cookie获取值
    function getCookie(name) {
        let match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
        return match ? match[2] : null;
    }
    
    // 获取用户名
    function getUsername() {
        // 1. 优先从运行时用户模型读取规范用户名
        try {
            if (window.APP && APP.USER && APP.USER.MODEL) {
                let runtimeUser = pickUsernameFromObject(APP.USER.MODEL);
                if (runtimeUser) return runtimeUser;
            }
        } catch(e) {}
        try {
            let globalUser = pickUsernameFromObject(window.USER_MODEL);
            if (globalUser) return globalUser;
        } catch(e) {}

        // 2. 从固定用户模型存储读取规范用户名
        let storedUserModel = getStoredUserModelUsername();
        if (storedUserModel) return storedUserModel;

        // 3. 从登录返回落库的 UserData / ak_login_result 读取规范用户名
        let canonicalUser = getStoredCanonicalUsername();
        if (canonicalUser) return canonicalUser;

        // 4. 规范用户名缺失时再回退到cookie输入值
        let cookieUser = getCookie('ak_username');
        if (cookieUser) return String(cookieUser).trim();
        
        // 5. 从localStorage遍历找用户名
        try {
            for (let i = 0; i < localStorage.length; i++) {
                let value = localStorage.getItem(localStorage.key(i));
                try {
                    let data = JSON.parse(value);
                    let resolved = pickUsernameFromObject(data);
                    if (resolved) return resolved;
                } catch(e) {}
            }
        } catch(e) {}
        
        // 6. 从已保存的持久化登录凭据读取
        try {
            var saved = _akDecode();
            if (saved && saved.account) return String(saved.account).trim();
        } catch(e) {}
        
        // 获取不到就保持当前身份，避免每次生成新的访客名
        let currentUsername = String(username || '').trim();
        if (currentUsername) {
            if (currentUsername === 'visitor') return buildGuestUsername();
            return currentUsername;
        }
        return buildGuestUsername();
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

        #ak-assist-request-overlay {
            position: fixed;
            inset: 0;
            display: none;
            align-items: center;
            justify-content: center;
            background: rgba(2, 6, 23, 0.6);
            z-index: 2147483646;
            padding: 20px;
            box-sizing: border-box;
        }

        #ak-assist-request-overlay.visible {
            display: flex;
        }

        #ak-assist-request-modal {
            width: min(92vw, 360px);
            background: linear-gradient(180deg, #0f2c2f 0%, #0a1d20 100%);
            border: 1px solid rgba(0, 212, 180, 0.28);
            border-radius: 18px;
            box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
            color: #e6fff8;
            overflow: hidden;
        }

        #ak-assist-request-modal .assist-request-head {
            padding: 18px 18px 8px;
            font-size: 18px;
            font-weight: 700;
            text-align: center;
        }

        #ak-assist-request-modal .assist-request-body {
            padding: 0 18px 18px;
            font-size: 14px;
            line-height: 1.7;
            color: rgba(230, 255, 248, 0.86);
        }

        #ak-assist-request-modal .assist-request-actions {
            display: flex;
            gap: 12px;
            padding: 0 18px 18px;
        }

        #ak-assist-request-modal .assist-request-btn {
            flex: 1;
            height: 42px;
            border-radius: 999px;
            border: 1px solid rgba(0, 212, 180, 0.25);
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
        }

        #ak-assist-request-modal .assist-request-btn.confirm {
            background: linear-gradient(135deg, #00c9b7 0%, #7ed56f 100%);
            color: #072b2f;
        }

        #ak-assist-request-modal .assist-request-btn.cancel {
            background: rgba(148, 163, 184, 0.08);
            color: #d9f5ea;
        }

        #ak-remote-voice-bar {
            position: fixed;
            right: 20px;
            bottom: 394px;
            z-index: 2147483645;
            display: none;
            align-items: center;
            justify-content: center;
            width: 72px;
            height: 72px;
        }

        #ak-remote-voice-bar.visible {
            display: flex;
        }

        #ak-remote-voice-bar .voice-fab-pulse {
            display: none;
        }

        #ak-remote-voice-bar .voice-fab-btn {
            position: relative;
            z-index: 1;
            width: 56px;
            height: 56px;
            border-radius: 50%;
            border: 1px solid rgba(11, 48, 53, 0.9);
            background: linear-gradient(180deg, rgba(12, 39, 43, 0.98) 0%, rgba(7, 24, 28, 0.98) 100%);
            color: #f4fffc;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 0;
            font-weight: 700;
            cursor: pointer;
            box-shadow: 0 10px 18px rgba(0, 0, 0, 0.2);
            transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease, background 0.18s ease, color 0.18s ease;
        }

        #ak-remote-voice-bar .voice-fab-btn .voice-fab-icon-stack {
            position: relative;
            width: 26px;
            height: 26px;
            display: inline-block;
            flex: 0 0 26px;
            pointer-events: none;
        }

        #ak-remote-voice-bar .voice-fab-btn .voice-fab-icon {
            width: 26px;
            height: 26px;
            display: block;
            pointer-events: none;
        }

        #ak-remote-voice-bar .voice-fab-btn .voice-fab-icon-base {
            color: rgba(244, 255, 252, 0.34);
        }

        #ak-remote-voice-bar .voice-fab-btn .voice-fab-icon-fill-wrap {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: var(--voice-fill-percent, 24%);
            overflow: hidden;
            transition: height 0.12s ease;
            pointer-events: none;
        }

        #ak-remote-voice-bar .voice-fab-btn .voice-fab-icon-fill {
            position: absolute;
            left: 0;
            bottom: 0;
            color: var(--voice-fill-color, #7af3e3);
        }

        #ak-remote-voice-bar .voice-fab-btn .voice-fab-status-dot {
            position: absolute;
            right: 9px;
            bottom: 9px;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: rgba(0, 212, 180, 0.95);
            box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.2);
            pointer-events: none;
        }

        #ak-remote-voice-bar .voice-fab-btn .voice-fab-slash {
            position: absolute;
            width: 22px;
            height: 2.5px;
            border-radius: 999px;
            background: currentColor;
            transform: rotate(-42deg) scaleX(0);
            opacity: 0;
            transition: transform 0.18s ease, opacity 0.18s ease;
            pointer-events: none;
        }

        #ak-remote-voice-bar .voice-fab-btn[data-state="active"] {
            border-color: rgba(22, 92, 92, 0.92);
            background: linear-gradient(180deg, rgba(11, 41, 44, 0.98) 0%, rgba(8, 28, 31, 0.98) 100%);
            color: #6bf3de;
            --voice-fill-color: #26e7c9;
        }

        #ak-remote-voice-bar .voice-fab-btn[data-state="pending"] {
            border-color: rgba(11, 48, 53, 0.9);
            color: rgba(244, 255, 252, 0.94);
            --voice-fill-color: #7af3e3;
        }

        #ak-remote-voice-bar .voice-fab-btn[data-state="muted"] {
            color: #ffb1b1;
            border-color: rgba(88, 33, 39, 0.92);
            background: linear-gradient(180deg, rgba(43, 19, 24, 0.98) 0%, rgba(27, 12, 16, 0.98) 100%);
            --voice-fill-color: #ff7474;
        }

        #ak-remote-voice-bar .voice-fab-btn[data-state="muted"] .voice-fab-status-dot {
            background: rgba(255, 82, 82, 0.96);
        }

        #ak-remote-voice-bar .voice-fab-btn[data-state="pending"] .voice-fab-status-dot {
            background: rgba(0, 212, 180, 0.58);
        }

        #ak-remote-voice-bar .voice-fab-btn[data-state="muted"] .voice-fab-slash {
            transform: rotate(-42deg) scaleX(1);
            opacity: 1;
        }

        #ak-remote-voice-bar .voice-fab-btn:hover:not(:disabled) {
            transform: translateY(-1px);
            box-shadow: 0 12px 20px rgba(0, 0, 0, 0.22);
        }

        #ak-remote-voice-bar .voice-fab-btn:disabled {
            opacity: 0.45;
            cursor: not-allowed;
        }

        @media (max-width: 768px) {
            #ak-remote-voice-bar {
                right: 12px;
                bottom: 88px;
            }
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
        <div id="ak-assist-request-overlay">
            <div id="ak-assist-request-modal">
                <div class="assist-request-head" id="ak-assist-request-title">远程指导确认</div>
                <div class="assist-request-body" id="ak-assist-request-text">管理员即将对您进行远程指导，是否接受？</div>
                <div class="assist-request-actions">
                    <button type="button" class="assist-request-btn cancel" onclick="AKChat.rejectRequest()">取消</button>
                    <button type="button" class="assist-request-btn confirm" onclick="AKChat.acceptRequest()">确认</button>
                </div>
            </div>
        </div>
        <div id="ak-remote-voice-bar">
            <div class="voice-fab-pulse" id="ak-remote-voice-level"></div>
            <button type="button" class="voice-fab-btn" id="ak-remote-voice-mute-btn" onclick="AKChat.toggleVoiceMute()" aria-label="切换麦克风" title="切换本地麦克风">
                <span class="voice-fab-icon-stack" aria-hidden="true">
                    <svg class="voice-fab-icon voice-fab-icon-base" viewBox="0 0 24 24" focusable="false">
                        <path fill="currentColor" d="M12 15a3.75 3.75 0 0 0 3.75-3.75V7.25a3.75 3.75 0 0 0-7.5 0v4A3.75 3.75 0 0 0 12 15Zm6-3.75a.75.75 0 0 1 1.5 0A7.5 7.5 0 0 1 12.75 18.7V21a.75.75 0 0 1-1.5 0v-2.3A7.5 7.5 0 0 1 4.5 11.25a.75.75 0 0 1 1.5 0 6 6 0 0 0 12 0Z"/>
                    </svg>
                    <span class="voice-fab-icon-fill-wrap">
                        <svg class="voice-fab-icon voice-fab-icon-fill" viewBox="0 0 24 24" focusable="false">
                            <path fill="currentColor" d="M12 15a3.75 3.75 0 0 0 3.75-3.75V7.25a3.75 3.75 0 0 0-7.5 0v4A3.75 3.75 0 0 0 12 15Zm6-3.75a.75.75 0 0 1 1.5 0A7.5 7.5 0 0 1 12.75 18.7V21a.75.75 0 0 1-1.5 0v-2.3A7.5 7.5 0 0 1 4.5 11.25a.75.75 0 0 1 1.5 0 6 6 0 0 0 12 0Z"/>
                        </svg>
                    </span>
                </span>
                <span class="voice-fab-status-dot" aria-hidden="true"></span>
                <span class="voice-fab-slash" aria-hidden="true"></span>
            </button>
            <audio id="ak-remote-voice-audio" autoplay playsinline style="display:none;"></audio>
        </div>
    `;
    
    // 插入DOM
    const container = document.createElement('div');
    container.innerHTML = chatHTML;
    document.body.appendChild(container);
    
    const chatBox = document.getElementById('ak-admin-chat');
    const messagesDiv = document.getElementById('ak-chat-messages');
    const inputEl = document.getElementById('ak-chat-input');
    const assistRequestOverlay = document.getElementById('ak-assist-request-overlay');
    const assistRequestTitle = document.getElementById('ak-assist-request-title');
    const assistRequestText = document.getElementById('ak-assist-request-text');
    const remoteVoiceBar = document.getElementById('ak-remote-voice-bar');
    const remoteVoicePulse = document.getElementById('ak-remote-voice-level');
    const remoteVoiceMuteBtn = document.getElementById('ak-remote-voice-mute-btn');
    const remoteVoiceAudio = document.getElementById('ak-remote-voice-audio');
    
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

    function emitChatBridgeEvent(name, detail) {
        try {
            window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
        } catch(e) {}
    }

    function ensureNotificationWidget() {
        try {
            if (window.AKNotificationWidgetLoaded) return;
            if (document.querySelector('script[data-ak-notification-widget="1"]')) return;
            const script = document.createElement('script');
            script.src = NOTIFICATION_WIDGET_URL;
            script.async = true;
            script.dataset.akNotificationWidget = '1';
            document.head.appendChild(script);
        } catch(e) {}
    }

    function ensureIMPlugin() {
        try {
            if (window.AKIMClientLoaded) return;
            if (document.querySelector('script[data-ak-im-plugin-entry="1"]')) return;
            const script = document.createElement('script');
            script.src = IM_PLUGIN_ENTRY_URL;
            script.async = true;
            script.dataset.akImPluginEntry = '1';
            document.head.appendChild(script);
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

    function closeAssistRequestDialog(clearRequest) {
        if (clearRequest) pendingAssistRequest = null;
        if (assistRequestOverlay) assistRequestOverlay.classList.remove('visible');
        syncAssistOverlaySnapshot('assist_request_close', 80);
    }

    function openAssistRequestDialog(request) {
        pendingAssistRequest = request || null;
        pendingVoiceRequest = null;
        if (!assistRequestOverlay || !assistRequestText || !pendingAssistRequest) return;
        if (assistRequestTitle) assistRequestTitle.textContent = '远程指导确认';
        assistRequestText.textContent = '管理员即将对您进行远程指导，是否接受？';
        assistRequestOverlay.classList.add('visible');
        syncAssistOverlaySnapshot('assist_request_open', 80);
    }

    function closeVoiceRequestDialog(clearRequest) {
        if (clearRequest) pendingVoiceRequest = null;
        if (assistRequestOverlay) assistRequestOverlay.classList.remove('visible');
        syncAssistOverlaySnapshot('voice_request_close', 80);
    }

    function emitAssistOverlaySnapshotIfCurrent(token, reason, phase) {
        if (token !== assistOverlaySnapshotToken || !assistSessionId) return;
        markAssistSnapshotTrigger(reason || 'overlay_state_changed', {
            source: 'overlay_sync',
            phase: String(phase || '')
        });
        emitAssistSnapshot(reason || 'overlay_state_changed');
    }

    function syncAssistOverlaySnapshot(reason, delay = 80) {
        if (!assistSessionId) return;
        const snapshotReason = reason || 'overlay_state_changed';
        const nextDelay = Math.max(120, Number(delay || 0) + 80);
        assistOverlaySnapshotToken += 1;
        const token = assistOverlaySnapshotToken;
        clearAssistOverlaySnapshotTimer();
        clearAssistSnapshotTimer();
        try {
            const raf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
                ? window.requestAnimationFrame.bind(window)
                : function(callback) { return setTimeout(callback, 16); };
            raf(function() {
                raf(function() {
                    emitAssistOverlaySnapshotIfCurrent(token, snapshotReason, 'raf');
                    assistOverlaySnapshotTimer = setTimeout(function() {
                        assistOverlaySnapshotTimer = null;
                        emitAssistOverlaySnapshotIfCurrent(token, snapshotReason, 'followup');
                    }, nextDelay);
                });
            });
        } catch (e) {
            scheduleAssistSnapshot(nextDelay, snapshotReason);
        }
    }

    function emitRemoteVoiceEvent(eventType, payload) {
        try {
            window.dispatchEvent(new CustomEvent('ak-remote-voice', {
                detail: Object.assign({ event_type: eventType }, payload || {})
            }));
        } catch (e) {}
    }

    function isRemoteVoiceCountedStatus(status) {
        const current = String(status || '').trim().toLowerCase();
        return current === 'reserved' || current === 'ringing' || current === 'connecting' || current === 'active';
    }

    function setRemoteVoiceLevel(fillEl, value) {
        if (!fillEl) return;
        const num = Math.max(0, Math.min(1, Number(value || 0)));
        fillEl.style.transform = `scale(${(0.82 + (num * 0.56)).toFixed(3)})`;
        fillEl.style.opacity = `${(0.18 + (num * 0.5)).toFixed(3)}`;
        fillEl.style.background = num >= 0.62
            ? 'radial-gradient(circle, rgba(126, 213, 111, 0.42) 0%, rgba(0, 212, 180, 0.16) 55%, rgba(0, 212, 180, 0) 72%)'
            : (num >= 0.28
                ? 'radial-gradient(circle, rgba(0, 212, 255, 0.32) 0%, rgba(0, 212, 180, 0.14) 55%, rgba(0, 212, 180, 0) 72%)'
                : 'radial-gradient(circle, rgba(0, 212, 180, 0.24) 0%, rgba(0, 212, 180, 0.08) 55%, rgba(0, 212, 180, 0) 72%)');
    }

    function getRemoteVoiceStatusLabel() {
        const status = String(remoteVoiceStatus || '').trim().toLowerCase();
        if (status === 'active') return '实时语音通话中';
        if (status === 'connecting') return '实时语音连接中';
        if (status === 'ringing' || status === 'reserved') return '等待管理员接通';
        if (status === 'rejected') return '实时语音已拒绝';
        if (status === 'timeout') return '实时语音已超时';
        if (status === 'failed' || status === 'socket_closed') return '实时语音已断开';
        if (status === 'closed') return '实时语音已结束';
        return remoteVoiceSessionId ? '实时语音准备中' : '实时语音未连接';
    }

    function getRemoteVoiceSubLabel() {
        if (!remoteVoiceSessionId) return '等待管理员发起语音邀请';
        const bothConnected = remoteVoiceConnectedRoles.indexOf('admin') >= 0 && remoteVoiceConnectedRoles.indexOf('user') >= 0;
        if (String(remoteVoiceStatus || '').trim().toLowerCase() === 'active') {
            return `${remoteVoiceMutedSelf ? '您已静音' : '您的麦克风已开启'} · ${remoteVoiceMutedPeer ? '管理员已静音' : '管理员可听见'}`;
        }
        if (bothConnected) {
            return '双方已连入信令，正在建立音频通道';
        }
        return remoteVoiceConnectedRoles.indexOf('admin') >= 0 ? '管理员已就绪，正在等待音频建立' : '等待管理员进入语音';
    }

    function getRemoteVoiceFillPercent(level, state, muted) {
        const num = Math.max(0, Math.min(1, Number(level || 0)));
        if (muted) return 22;
        if (state === 'active') return Math.round(14 + (num * 72));
        if (state === 'connecting') return 28;
        return 20;
    }

    function renderRemoteVoiceBar() {
        const visible = !!remoteVoiceSessionId || isRemoteVoiceCountedStatus(remoteVoiceStatus);
        if (remoteVoiceBar) remoteVoiceBar.classList.toggle('visible', !!visible);
        const currentStatus = String(remoteVoiceStatus || '').trim().toLowerCase();
        const level = Math.max(remoteVoiceLocalLevel, remoteVoiceRemoteLevel);
        setRemoteVoiceLevel(remoteVoicePulse, level);
        const canControl = !!(remoteVoiceClient && remoteVoiceSessionId && isRemoteVoiceCountedStatus(remoteVoiceStatus));
        if (remoteVoiceMuteBtn) {
            remoteVoiceMuteBtn.disabled = !canControl;
            remoteVoiceMuteBtn.style.setProperty('--voice-fill-percent', `${getRemoteVoiceFillPercent(level, currentStatus, remoteVoiceMutedSelf)}%`);
            remoteVoiceMuteBtn.dataset.state = remoteVoiceMutedSelf
                ? 'muted'
                : (currentStatus === 'active' ? 'active' : 'pending');
            remoteVoiceMuteBtn.setAttribute('aria-label', remoteVoiceMutedSelf ? '恢复麦克风' : '切换麦克风');
            remoteVoiceMuteBtn.title = `${getRemoteVoiceStatusLabel()} · ${getRemoteVoiceSubLabel()}${canControl ? (remoteVoiceMutedSelf ? ' · 点击恢复麦克风' : ' · 点击静音麦克风') : ''}`;
        }
        if (remoteVoiceBar) {
            remoteVoiceBar.title = `${getRemoteVoiceStatusLabel()} · ${getRemoteVoiceSubLabel()}`;
        }
    }

    function hasForegroundProtectedRealtimeSession() {
        return !!(
            assistSessionId
            || (remoteVoiceSessionId && isRemoteVoiceCountedStatus(remoteVoiceStatus))
        );
    }

    function resetRemoteVoiceUiState(reason, clearSession = true) {
        remoteVoiceStatus = String(reason || '').trim() || (clearSession ? '' : remoteVoiceStatus);
        if (clearSession) remoteVoiceSessionId = '';
        remoteVoiceMutedSelf = false;
        remoteVoiceMutedPeer = false;
        remoteVoiceLocalLevel = 0;
        remoteVoiceRemoteLevel = 0;
        remoteVoiceConnectedRoles = [];
        renderRemoteVoiceBar();
    }

    function ensureRemoteVoiceLibrary() {
        if (window.AKRemoteVoiceClient) {
            return Promise.resolve(window.AKRemoteVoiceClient);
        }
        if (remoteVoiceLibraryPromise) return remoteVoiceLibraryPromise;
        remoteVoiceLibraryPromise = new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[data-ak-voice-client="1"]`);
            if (existing) {
                existing.addEventListener('load', () => resolve(window.AKRemoteVoiceClient));
                existing.addEventListener('error', () => reject(new Error('加载实时语音脚本失败')));
                return;
            }
            const script = document.createElement('script');
            script.src = REMOTE_VOICE_CLIENT_URL;
            script.async = true;
            script.dataset.akVoiceClient = '1';
            script.onload = () => resolve(window.AKRemoteVoiceClient);
            script.onerror = () => reject(new Error('加载实时语音脚本失败'));
            document.head.appendChild(script);
        }).catch(error => {
            remoteVoiceLibraryPromise = null;
            throw error;
        });
        return remoteVoiceLibraryPromise;
    }

    async function stopRemoteVoiceClient(notifyServer, reason, clearSession = true) {
        const client = remoteVoiceClient;
        remoteVoiceClient = null;
        try {
            if (client) {
                if (notifyServer && typeof client.hangup === 'function') {
                    await client.hangup(reason || 'manual_hangup');
                } else if (typeof client.stop === 'function') {
                    await client.stop(false, reason || 'closed');
                }
            }
        } catch (e) {
        }
        resetRemoteVoiceUiState(reason, clearSession);
    }

    async function startRemoteVoiceClient(bindPayload) {
        const payload = bindPayload || {};
        const nextSessionId = String(payload.voice_session_id || '').trim();
        if (!nextSessionId) return;
        if (remoteVoiceClient && remoteVoiceSessionId === nextSessionId && isRemoteVoiceCountedStatus(remoteVoiceStatus)) {
            renderRemoteVoiceBar();
            return;
        }
        await ensureRemoteVoiceLibrary();
        await stopRemoteVoiceClient(false, 'switch_session', true);
        remoteVoiceSessionId = nextSessionId;
        remoteVoiceStatus = String(payload.status || 'connecting');
        renderRemoteVoiceBar();
        const ClientCtor = window.AKRemoteVoiceClient;
        const client = new ClientCtor({
            voiceSessionId: nextSessionId,
            role: 'user',
            site: String(payload.site || 'ak_web').trim() || 'ak_web',
            remoteAudio: remoteVoiceAudio,
            onStateChange: function(state) {
                if (remoteVoiceClient !== client) return;
                remoteVoiceStatus = String(state && state.status || remoteVoiceStatus || '').trim() || remoteVoiceStatus;
                remoteVoiceMutedSelf = !!(state && state.mutedSelf);
                remoteVoiceMutedPeer = !!(state && state.mutedPeer);
                remoteVoiceLocalLevel = Number(state && state.localLevel || 0);
                remoteVoiceRemoteLevel = Number(state && state.remoteLevel || 0);
                remoteVoiceConnectedRoles = Array.isArray(state && state.connectedRoles) ? state.connectedRoles.slice() : [];
                if (!isRemoteVoiceCountedStatus(remoteVoiceStatus) && String(state && state.phase || '').trim() === 'closed') {
                    remoteVoiceClient = null;
                    resetRemoteVoiceUiState(remoteVoiceStatus, true);
                    emitRemoteVoiceEvent('state_closed', { voice_session_id: nextSessionId, status: remoteVoiceStatus });
                    return;
                }
                renderRemoteVoiceBar();
            },
            onError: function(error) {
                console.error('[AKChat] remote voice error:', error);
            }
        });
        remoteVoiceClient = client;
        try {
            await client.start();
            emitRemoteVoiceEvent('client_started', { voice_session_id: nextSessionId });
        } catch (error) {
            console.error('[AKChat] 启动实时语音失败:', error);
            await stopRemoteVoiceClient(true, 'media_error', true);
        }
    }

    async function toggleRemoteVoiceMute() {
        if (!remoteVoiceClient || !remoteVoiceSessionId) return false;
        try {
            await remoteVoiceClient.toggleMuted();
            return true;
        } catch (e) {
            return false;
        }
    }

    async function hangupRemoteVoice() {
        if (!remoteVoiceSessionId) return false;
        await stopRemoteVoiceClient(true, 'user_hangup', true);
        return true;
    }

    async function handleRemoteVoiceBind(payload) {
        closeVoiceRequestDialog(true);
        remoteVoiceSessionId = String(payload && payload.voice_session_id || '').trim();
        remoteVoiceStatus = String(payload && payload.status || 'connecting');
        renderRemoteVoiceBar();
        await startRemoteVoiceClient(payload || {});
    }

    async function handleRemoteVoiceUnbind(payload) {
        const nextSessionId = String(payload && payload.voice_session_id || '').trim();
        if (nextSessionId && remoteVoiceSessionId && nextSessionId !== remoteVoiceSessionId) return;
        closeVoiceRequestDialog(true);
        await stopRemoteVoiceClient(false, String(payload && payload.status || 'closed'), true);
    }

    window.addEventListener('ak-remote-voice', function(event) {
        const detail = event && event.detail ? event.detail : {};
        const eventType = String(detail.event_type || '').trim();
        if (eventType === 'bind') {
            handleRemoteVoiceBind(detail);
            return;
        }
        if (eventType === 'unbind') {
            handleRemoteVoiceUnbind(detail);
        }
    });

    function openVoiceRequestDialog(request) {
        pendingVoiceRequest = request || null;
        pendingAssistRequest = null;
        if (!assistRequestOverlay || !assistRequestText || !pendingVoiceRequest) return;
        if (assistRequestTitle) assistRequestTitle.textContent = '实时语音邀请';
        assistRequestText.textContent = '管理员邀请您开启一对一实时语音，是否接受？';
        assistRequestOverlay.classList.add('visible');
        syncAssistOverlaySnapshot('voice_request_open', 80);
        emitRemoteVoiceEvent('request', pendingVoiceRequest);
    }

    function sendAssistRequestResponse(accepted) {
        if (!pendingAssistRequest || !ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
            ws.send(JSON.stringify({
                type: 'remote_assist_request_response',
                session_id: pendingAssistRequest.session_id || '',
                accepted: !!accepted
            }));
            return true;
        } catch (e) {
            return false;
        }
    }

    function sendVoiceRequestResponse(accepted) {
        if (!pendingVoiceRequest || !ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
            ws.send(JSON.stringify({
                type: 'remote_voice_request_response',
                voice_session_id: pendingVoiceRequest.voice_session_id || '',
                accepted: !!accepted
            }));
            return true;
        } catch (e) {
            return false;
        }
    }

    function acceptAssistRequest() {
        if (!pendingAssistRequest) return;
        if (!sendAssistRequestResponse(true)) return;
        closeAssistRequestDialog(true);
    }

    function rejectAssistRequest() {
        if (!pendingAssistRequest) return;
        if (!sendAssistRequestResponse(false)) return;
        closeAssistRequestDialog(true);
    }

    function acceptVoiceRequest() {
        if (!pendingVoiceRequest) return;
        if (!sendVoiceRequestResponse(true)) return;
        closeVoiceRequestDialog(true);
    }

    function rejectVoiceRequest() {
        if (!pendingVoiceRequest) return;
        if (!sendVoiceRequestResponse(false)) return;
        closeVoiceRequestDialog(true);
    }

    function acceptRequest() {
        if (pendingVoiceRequest) {
            acceptVoiceRequest();
            return;
        }
        acceptAssistRequest();
    }

    function rejectRequest() {
        if (pendingVoiceRequest) {
            rejectVoiceRequest();
            return;
        }
        rejectAssistRequest();
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
                    userAgent: navigator.userAgent,
                    pageClientId: getPageClientId()
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
        if (raw === ASSIST_ROUTE_PREFIX || raw.indexOf(ASSIST_ROUTE_PREFIX + '/') === 0) return raw;
        if (raw === ASSIST_NATIVE_ROUTE_PREFIX || raw.indexOf(ASSIST_NATIVE_ROUTE_PREFIX + '/') === 0) {
            return ASSIST_ROUTE_PREFIX + raw.slice(ASSIST_NATIVE_ROUTE_PREFIX.length);
        }
        if (raw.indexOf('/pages/') === 0 || raw.indexOf('/content/') === 0 || raw.indexOf('/assets/') === 0) {
            return ASSIST_ROUTE_PREFIX + raw;
        }
        return raw;
    }

    function isAssistManagedRoute(route) {
        const normalized = String(route || normalizeAssistRoute() || '').trim();
        return normalized === ASSIST_ROUTE_PREFIX || normalized.indexOf(ASSIST_ROUTE_PREFIX + '/') === 0;
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
    const ASSIST_SCROLL_SETTLE_DELAY = 1500;
    const ASSIST_SCROLL_TARGET_PREFERRED_LIMIT = 28;
    const ASSIST_SCROLL_TARGET_MIN_OVERFLOW = 56;
    const ASSIST_SCROLL_TARGET_MIN_HEIGHT_RATIO = 0.22;
    const ASSIST_SCROLL_TARGET_MIN_WIDTH_RATIO = 0.35;
    const ASSIST_SCROLL_ELEMENT_STICKY_WINDOW_MS = 420;
    const ASSIST_SCROLL_TARGET_RESCAN_COOLDOWN_MS = 480;
    const ASSIST_SCROLL_VIEWPORT_SNAPSHOT_MIN_INTERVAL_MS = 900;

    const ASSIST_ROUTE_FIRST_SNAPSHOT_DELAY = 60;
    const ASSIST_ROUTE_FAST_SCROLL_DELAY = 120;
    const ASSIST_ROUTE_SETTLE_DELAY = 160;
    const ASSIST_ROUTE_SETTLE_WINDOW_MS = 1200;
    const ASSIST_SNAPSHOT_BUILD_LOG_THRESHOLD_MS = 120;
    const ASSIST_SNAPSHOT_TRIGGER_LOG_THRESHOLD_MS = 180;

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

    function clearAssistSnapshotTimer() {
        if (assistSnapshotTimer) {
            clearTimeout(assistSnapshotTimer);
            assistSnapshotTimer = null;
        }
    }

    function clearAssistOverlaySnapshotTimer() {
        if (assistOverlaySnapshotTimer) {
            clearTimeout(assistOverlaySnapshotTimer);
            assistOverlaySnapshotTimer = null;
        }
    }

    function clearAssistScrollTimer() {
        if (assistScrollTimer) {
            clearTimeout(assistScrollTimer);
            assistScrollTimer = null;
        }
    }

    function clearAssistRouteFastSnapshotTimer() {
        if (assistRouteFastSnapshotTimer) {
            clearTimeout(assistRouteFastSnapshotTimer);
            assistRouteFastSnapshotTimer = null;
        }
        assistRouteFastSnapshotRoute = '';
    }

    function clearAssistRouteFastScrollTimer() {
        if (assistRouteFastScrollTimer) {
            clearTimeout(assistRouteFastScrollTimer);
            assistRouteFastScrollTimer = null;
        }
    }

    function resetAssistRouteFastScrollState() {
        clearAssistRouteFastScrollTimer();
        assistRouteFastScrollRoute = '';
        assistRouteFastScrollDispatched = false;
    }

    function clearAssistRouteSettleState() {
        if (assistRouteSettleTimer) {
            clearTimeout(assistRouteSettleTimer);
            assistRouteSettleTimer = null;
        }
        clearAssistRouteFastSnapshotTimer();
        resetAssistRouteFastScrollState();
        assistRouteSettleUntil = 0;
        assistRouteSettleRoute = '';
        assistRouteSettleNeedsFreshSnapshot = false;
    }

    function isAssistRouteSettling(route) {
        const currentRoute = String(route || normalizeAssistRoute() || '').trim();
        return !!assistRouteSettleRoute
            && !!currentRoute
            && assistRouteSettleRoute === currentRoute
            && Date.now() < assistRouteSettleUntil;
    }

    function emitAssistRouteSettledSync(expectedRoute) {
        if (!assistSessionId) {
            clearAssistRouteSettleState();
            return;
        }
        const currentRoute = normalizeAssistRoute();
        if (expectedRoute && currentRoute !== expectedRoute) {
            logAssistDebug('route_settle_sync_skipped', {
                reason: 'route_changed_again',
                expectedRoute: String(expectedRoute || ''),
                currentRoute: String(currentRoute || '')
            });
            if (assistRouteSettleRoute === expectedRoute) {
                clearAssistRouteSettleState();
            }
            return;
        }
        refreshAssistScrollTarget('route_settled_sync', true);
        emitAssistScroll(true);
        const snapshotReason = assistRouteSettleNeedsFreshSnapshot ? 'route_settled_request' : 'route_settled';
        markAssistSnapshotTrigger(snapshotReason, {
            source: 'route_settled_sync',
            expected_route: String(expectedRoute || ''),
            needs_fresh_snapshot: !!assistRouteSettleNeedsFreshSnapshot
        });
        emitAssistSnapshot(snapshotReason);
        if (!assistRouteSettleRoute || assistRouteSettleRoute === expectedRoute) {
            clearAssistRouteSettleState();
        }
    }

    function emitAssistRouteFastSnapshot(expectedRoute) {
        if (!assistSessionId) return;
        const currentRoute = normalizeAssistRoute();
        if (expectedRoute && currentRoute !== expectedRoute) {
            return;
        }
        if (!isAssistRouteSettling(currentRoute)) {
            return;
        }
        markAssistSnapshotTrigger('route_fast_frame', {
            source: 'route_fast_frame',
            expected_route: String(expectedRoute || '')
        });
        emitAssistSnapshot('route_fast_frame');
    }

    function scheduleAssistRouteFastSnapshot(route, delay) {
        if (!assistSessionId) return;
        const expectedRoute = String(route || normalizeAssistRoute() || '').trim();
        if (!expectedRoute) return;
        clearAssistRouteFastSnapshotTimer();
        assistRouteFastSnapshotRoute = expectedRoute;
        const nextDelay = typeof delay === 'number' ? delay : ASSIST_ROUTE_FIRST_SNAPSHOT_DELAY;
        assistRouteFastSnapshotTimer = setTimeout(function() {
            assistRouteFastSnapshotTimer = null;
            if (assistRouteFastSnapshotRoute !== expectedRoute) return;
            assistRouteFastSnapshotRoute = '';
            emitAssistRouteFastSnapshot(expectedRoute);
        }, nextDelay);
    }

    function emitAssistRouteFastScrollSync(expectedRoute) {
        if (!assistSessionId) return;
        const currentRoute = normalizeAssistRoute();
        if (expectedRoute && currentRoute !== expectedRoute) {
            return;
        }
        if (!isAssistRouteSettling(currentRoute)) {
            return;
        }
        if (assistRouteFastScrollDispatched && assistRouteFastScrollRoute === currentRoute) {
            return;
        }
        assistRouteFastScrollDispatched = true;
        assistRouteFastScrollRoute = currentRoute;
        refreshAssistScrollTarget('route_fast_scroll_sync', false);
        emitAssistScroll(true);
        markAssistSnapshotTrigger('route_fast_scroll', {
            source: 'route_fast_scroll_sync',
            expected_route: String(expectedRoute || currentRoute || '')
        });
        emitAssistSnapshot('route_fast_scroll');
    }

    function scheduleAssistRouteFastScrollSync(route, delay) {
        if (!assistSessionId) return;
        const expectedRoute = String(route || normalizeAssistRoute() || '').trim();
        if (!expectedRoute) return;
        if (!isAssistRouteSettling(expectedRoute)) return;
        if (assistRouteFastScrollDispatched && assistRouteFastScrollRoute === expectedRoute) {
            return;
        }
        assistRouteFastScrollRoute = expectedRoute;
        clearAssistRouteFastScrollTimer();
        const nextDelay = typeof delay === 'number' ? delay : ASSIST_ROUTE_FAST_SCROLL_DELAY;
        assistRouteFastScrollTimer = setTimeout(function() {
            assistRouteFastScrollTimer = null;
            if (assistRouteFastScrollRoute !== expectedRoute || assistRouteFastScrollDispatched) {
                return;
            }
            emitAssistRouteFastScrollSync(expectedRoute);
        }, nextDelay);
    }

    function scheduleAssistRouteSettledSync(route, delay, needsFreshSnapshot) {
        if (!assistSessionId) return;
        const expectedRoute = String(route || normalizeAssistRoute() || '').trim();
        if (!expectedRoute) return;
        if (assistRouteSettleTimer) {
            clearTimeout(assistRouteSettleTimer);
            assistRouteSettleTimer = null;
        }
        const isSamePendingRoute = assistRouteSettleRoute === expectedRoute;
        assistRouteSettleRoute = expectedRoute;
        assistRouteSettleUntil = Date.now() + ASSIST_ROUTE_SETTLE_WINDOW_MS;
        assistRouteSettleNeedsFreshSnapshot = (isSamePendingRoute && assistRouteSettleNeedsFreshSnapshot) || !!needsFreshSnapshot;
        if (!isSamePendingRoute) {
            resetAssistRouteFastScrollState();
            assistRouteFastScrollRoute = expectedRoute;
        }
        const nextDelay = typeof delay === 'number' ? delay : ASSIST_ROUTE_SETTLE_DELAY;
        const firstFrameDelay = Math.max(40, Math.min(ASSIST_ROUTE_FIRST_SNAPSHOT_DELAY, Math.max(0, nextDelay - 80)));
        if (!isSamePendingRoute && nextDelay > firstFrameDelay) {
            scheduleAssistRouteFastSnapshot(expectedRoute, firstFrameDelay);
        }
        assistRouteSettleTimer = setTimeout(function() {
            assistRouteSettleTimer = null;
            emitAssistRouteSettledSync(expectedRoute);
        }, nextDelay);
    }

    function deferAssistSnapshotUntilRouteSettled(route, reason) {
        const expectedRoute = String(route || normalizeAssistRoute() || '').trim();
        if (!expectedRoute || !isAssistRouteSettling(expectedRoute)) {
            return false;
        }
        assistRouteSettleNeedsFreshSnapshot = true;
        if (!assistRouteSettleTimer) {
            scheduleAssistRouteSettledSync(expectedRoute, ASSIST_ROUTE_SETTLE_DELAY, true);
        }
        return true;
    }

    function stopAssistDomObserver() {
        if (assistMutationObserver) {
            try {
                assistMutationObserver.disconnect();
            } catch (e) {}
            assistMutationObserver = null;
        }
        clearAssistSnapshotTimer();
        clearAssistOverlaySnapshotTimer();
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

    function describeAssistTarget(target) {
        try {
            if (!target || target === window) {
                return {
                    kind: 'window',
                    scrollTop: Math.max(0, Math.round(window.scrollY || window.pageYOffset || 0)),
                    scrollLeft: Math.max(0, Math.round(window.scrollX || window.pageXOffset || 0)),
                    viewportHeight: Math.max(0, Math.round(window.innerHeight || 0)),
                    viewportWidth: Math.max(0, Math.round(window.innerWidth || 0)),
                    scrollHeight: Math.max(0, Math.round(getAssistDocumentScrollHeight()))
                };
            }
            if (target === document) {
                return { kind: 'document' };
            }
            if (!(target instanceof Element)) {
                return { kind: typeof target };
            }
            const tagName = String(target.tagName || 'div').toLowerCase();
            return {
                kind: 'element',
                tag: tagName,
                id: String(target.id || ''),
                className: String(target.className || '').trim().slice(0, 120),
                nodeId: ensureAssistNodeId(target),
                selector: buildAssistSelectorHint(target, tagName),
                scrollTop: Math.max(0, Math.round(target.scrollTop || 0)),
                scrollLeft: Math.max(0, Math.round(target.scrollLeft || 0)),
                clientHeight: Math.max(0, Math.round(target.clientHeight || 0)),
                clientWidth: Math.max(0, Math.round(target.clientWidth || 0)),
                scrollHeight: Math.max(0, Math.round(target.scrollHeight || 0)),
                scrollWidth: Math.max(0, Math.round(target.scrollWidth || 0))
            };
        } catch (e) {
            return { kind: 'error', message: String((e && e.message) || e || '') };
        }
    }

    function logAssistScrollCapture(source, target) {
        try {
            const targetMeta = describeAssistTarget(target);
            const debugKey = [
                String(source || ''),
                String(targetMeta && targetMeta.kind || ''),
                String(targetMeta && targetMeta.nodeId || ''),
                String(targetMeta && targetMeta.selector || ''),
                String(targetMeta && targetMeta.id || '')
            ].join('|');
            const now = Date.now();
            if (debugKey === assistLastScrollCaptureDebugKey && (now - assistLastScrollCaptureDebugAt) < 280) {
                return;
            }
            assistLastScrollCaptureDebugKey = debugKey;
            assistLastScrollCaptureDebugAt = now;
            logAssistDebug('scroll_capture', {
                source: String(source || ''),
                route: normalizeAssistRoute(),
                target: targetMeta
            });
        } catch (e) {}
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

    function isAssistWindowScrollFallbackTarget(element, computed, metrics) {
        try {
            if (!element || !(element instanceof Element) || !element.isConnected) return false;
            const windowTop = Math.max(0, Math.round(window.scrollY || window.pageYOffset || 0));
            if (windowTop < 8) return false;
            const scrollTop = Math.max(0, Math.round(metrics && metrics.scrollTop || element.scrollTop || 0));
            if (scrollTop >= 4) return false;
            const overflowValue = String((metrics && metrics.overflowValue) || (computed && (computed.overflowY || computed.overflow)) || '').toLowerCase();
            const touchScrollValue = String((metrics && metrics.touchScrollValue) || (computed && computed.webkitOverflowScrolling) || '').toLowerCase();
            const hasOverflowHint = overflowValue.indexOf('auto') !== -1 || overflowValue.indexOf('scroll') !== -1 || overflowValue.indexOf('overlay') !== -1;
            const hasTouchScrollHint = touchScrollValue.indexOf('touch') !== -1;
            if (hasOverflowHint || hasTouchScrollHint) return false;
            const viewportHeight = Math.max(0, Math.round(window.innerHeight || 0));
            const clientHeight = Math.max(0, Math.round(metrics && metrics.clientHeight || element.clientHeight || 0));
            const scrollHeight = Math.max(0, Math.round(metrics && metrics.scrollHeight || element.scrollHeight || 0));
            const rect = metrics && metrics.rect ? metrics.rect : (element.getBoundingClientRect ? element.getBoundingClientRect() : null);
            const sameAsViewport = Math.abs(clientHeight - viewportHeight) <= 24;
            const sameAsDocument = Math.abs(scrollHeight - Math.max(0, Math.round(getAssistDocumentScrollHeight()))) <= Math.max(48, Math.round(viewportHeight * 0.08));
            const nearViewportRoot = !!rect && Math.abs(Math.round(rect.top || 0)) <= 24 && Math.abs(Math.round(rect.left || 0)) <= 24;
            const looksLikeRoot = String(element.id || '').toLowerCase() === 'app'
                || element === (document.body && document.body.firstElementChild)
                || (element.parentElement === document.body && nearViewportRoot);
            return looksLikeRoot && sameAsViewport && sameAsDocument;
        } catch (e) {
            return false;
        }
    }

    function getAssistScrollTargetKeywordScore(element) {
        try {
            if (!element || !(element instanceof Element)) return 0;
            const keywords = String((element.id || '') + ' ' + (element.className || '') + ' ' + (element.tagName || '')).toLowerCase();
            let score = 0;
            if (keywords.indexOf('content') !== -1) score += 5;
            if (keywords.indexOf('list') !== -1) score += 5;
            if (keywords.indexOf('pull') !== -1 || keywords.indexOf('refresh') !== -1) score += 5;
            if (keywords.indexOf('tab') !== -1) score += 3;
            if (keywords.indexOf('page') !== -1) score += 3;
            if (keywords.indexOf('container') !== -1) score += 2;
            if (keywords.indexOf('wrap') !== -1 || keywords.indexOf('wrapper') !== -1) score += 2;
            if (keywords.indexOf('main') !== -1) score += 2;
            return score;
        } catch (e) {
            return 0;
        }
    }

    function evaluateAssistScrollableElement(element, viewportWidth, viewportHeight, relaxed) {
        try {
            if (!element || !(element instanceof Element)) return null;
            if (element === document.body || element === document.documentElement) return null;
            if (isAssistWidgetTarget(element)) return null;
            const computed = window.getComputedStyle(element);
            if (shouldSkipAssistElement(element, computed)) return null;
            const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
            if (!isAssistViewportRectVisible(rect, 36)) return null;
            const clientHeight = Math.max(0, Math.round(element.clientHeight || 0));
            const clientWidth = Math.max(0, Math.round(element.clientWidth || 0));
            const scrollHeight = Math.max(0, Math.round(element.scrollHeight || 0));
            const scrollTop = Math.max(0, Math.round(element.scrollTop || 0));
            const overflowValue = String(computed.overflowY || computed.overflow || '').toLowerCase();
            const touchScrollValue = String(computed.webkitOverflowScrolling || '').toLowerCase();
            const hasOverflowHint = overflowValue.indexOf('auto') !== -1 || overflowValue.indexOf('scroll') !== -1 || overflowValue.indexOf('overlay') !== -1;
            const hasTouchScrollHint = touchScrollValue.indexOf('touch') !== -1;
            if (isAssistWindowScrollFallbackTarget(element, computed, {
                rect,
                clientHeight,
                scrollHeight,
                scrollTop,
                overflowValue,
                touchScrollValue
            })) return null;
            const keywordScore = getAssistScrollTargetKeywordScore(element);
            const minHeightRatio = relaxed ? Math.max(0.16, ASSIST_SCROLL_TARGET_MIN_HEIGHT_RATIO - 0.06) : ASSIST_SCROLL_TARGET_MIN_HEIGHT_RATIO;
            const minWidthRatio = relaxed ? Math.max(0.28, ASSIST_SCROLL_TARGET_MIN_WIDTH_RATIO - 0.05) : ASSIST_SCROLL_TARGET_MIN_WIDTH_RATIO;
            const minHeight = Math.max(140, Math.round(viewportHeight * minHeightRatio));
            const minWidth = Math.max(140, Math.round(viewportWidth * minWidthRatio));
            const scrollDelta = Math.max(0, scrollHeight - clientHeight);
            const minOverflow = relaxed ? Math.max(32, ASSIST_SCROLL_TARGET_MIN_OVERFLOW - 24) : ASSIST_SCROLL_TARGET_MIN_OVERFLOW;
            if (clientHeight < minHeight || clientWidth < minWidth) return null;
            if (scrollDelta < minOverflow && scrollTop < 4) return null;
            if (!hasOverflowHint && !hasTouchScrollHint) {
                if (!relaxed && keywordScore < 3 && scrollTop < 8) return null;
                if (scrollDelta < Math.max(80, Math.round(viewportHeight * 0.12))) return null;
            }
            let score = clientHeight * clientWidth;
            score += scrollDelta * 24;
            score += keywordScore * 220000;
            if (scrollTop > 0) score += 1400000;
            if (hasOverflowHint) score += 420000;
            if (hasTouchScrollHint) score += 260000;
            if (rect && rect.top <= Math.round(viewportHeight * 0.18)) score += 80000;
            if (rect && rect.bottom >= Math.round(viewportHeight * 0.82)) score += 80000;
            return {
                element: element,
                score: score
            };
        } catch (e) {
            return null;
        }
    }

    function isAssistUsableScrollTarget(target) {
        try {
            if (!target || target === window || !(target instanceof Element) || !target.isConnected) return false;
            const viewportWidth = Math.max(1, Math.round(window.innerWidth || 0));
            const viewportHeight = Math.max(1, Math.round(window.innerHeight || 0));
            return !!evaluateAssistScrollableElement(target, viewportWidth, viewportHeight, true);
        } catch (e) {
            return false;
        }
    }

    function getRecentAssistElementScrollTarget() {
        try {
            if (!assistLastElementScrollTarget || !(assistLastElementScrollTarget instanceof Element) || !assistLastElementScrollTarget.isConnected) {
                return null;
            }
            if ((Date.now() - assistLastElementScrollAt) > ASSIST_SCROLL_ELEMENT_STICKY_WINDOW_MS) {
                return null;
            }
            return isAssistUsableScrollTarget(assistLastElementScrollTarget) ? assistLastElementScrollTarget : null;
        } catch (e) {
            return null;
        }
    }

    function collectAssistPreferredScrollCandidates(limit) {
        try {
            if (!document.body) return [];
            const selected = [];
            const preferredSelectors = [
                '#app-content',
                '#app',
                'van-pull-refresh',
                '.van-pull-refresh',
                '.van-list',
                '.van-tabs__content',
                '.van-tab__pane-wrapper',
                '.items-container',
                '.page-content',
                '.main-content',
                '[class*="pull-refresh"]',
                '[class*="pull_refresh"]'
            ];
            if (assistScrollTarget && assistScrollTarget !== window && assistScrollTarget instanceof Element) {
                pushAssistElementCandidate(selected, assistScrollTarget);
            }
            const viewportRoots = collectAssistViewportRoots(Math.max(8, Math.min(limit, 12)));
            viewportRoots.forEach(function(element) {
                pushAssistElementCandidate(selected, element);
            });
            for (let i = 0; i < preferredSelectors.length && selected.length < limit; i += 1) {
                const matches = document.querySelectorAll(preferredSelectors[i]);
                for (let j = 0; j < matches.length && selected.length < limit; j += 1) {
                    pushAssistElementCandidate(selected, matches[j]);
                }
            }
            Array.prototype.slice.call(document.body.children || []).forEach(function(element) {
                if (selected.length >= limit) return;
                pushAssistElementCandidate(selected, element);
            });
            return selected;
        } catch (e) {
            return [];
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
            const viewportWidth = Math.max(1, Math.round(window.innerWidth || 0));
            const viewportHeight = Math.max(1, Math.round(window.innerHeight || 0));
            let best = null;
            let bestScore = 0;
            function consider(element, relaxed) {
                const evaluation = evaluateAssistScrollableElement(element, viewportWidth, viewportHeight, relaxed);
                if (evaluation && evaluation.score > bestScore) {
                    best = evaluation.element;
                    bestScore = evaluation.score;
                }
            }
            const preferredCandidates = collectAssistPreferredScrollCandidates(ASSIST_SCROLL_TARGET_PREFERRED_LIMIT);
            preferredCandidates.forEach(function(element) {
                consider(element, false);
            });
            if (best) return best;
            const elements = document.body.querySelectorAll('*');
            for (let i = 0; i < elements.length; i += 1) {
                consider(elements[i], false);
            }
            if (best) return best;
            preferredCandidates.forEach(function(element) {
                consider(element, true);
            });
            return best;
        } catch (e) {
            return null;
        }
    }

    function getAssistActiveViewportTarget(options) {
        try {
            const forceRescan = !!(options && options.forceRescan);
            if (!forceRescan) {
                const recentTarget = getRecentAssistElementScrollTarget();
                if (recentTarget) {
                    assistScrollTarget = recentTarget;
                    return recentTarget;
                }
                if (isAssistUsableScrollTarget(assistScrollTarget)) {
                    return assistScrollTarget;
                }
            }
            return findAssistPrimaryScrollableElement() || window;
        } catch (e) {
            return window;
        }
    }

    function getAssistActiveViewportMetrics(options) {
        try {
            const target = getAssistActiveViewportTarget(options);
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

    function shouldDeferAssistScrollTargetRefresh(reason, forceRescan) {
        try {
            if (forceRescan) return false;
            if (String(reason || '').toLowerCase() !== 'build_scroll_payload') return false;
            if (assistScrollTarget && assistScrollTarget !== window) return false;
            return (Date.now() - assistLastScrollTargetRefreshAt) < ASSIST_SCROLL_TARGET_RESCAN_COOLDOWN_MS;
        } catch (e) {
            return false;
        }
    }

    function refreshAssistScrollTarget(reason, forceRescan) {
        try {
            if (shouldDeferAssistScrollTargetRefresh(reason, !!forceRescan)) {
                return assistScrollTarget || window;
            }
            const nextTarget = getAssistActiveViewportTarget({ forceRescan: !!forceRescan });
            rememberAssistScrollTarget(nextTarget);
            assistLastScrollTargetRefreshAt = Date.now();
            return nextTarget;
        } catch (e) {
            assistScrollTarget = window;
            logAssistDebug('scroll_target_resolved_error', {
                reason: String(reason || ''),
                forceRescan: !!forceRescan,
                message: String((e && e.message) || e || '')
            });
            return window;
        }
    }

    function isAssistViewportModeEligible() {
        try {
            if (!document.body) return false;
            const route = normalizeAssistRoute();
            if (!isAssistManagedRoute(route)) return false;
            const metrics = getAssistActiveViewportMetrics();
            return metrics.scrollHeight >= Math.round(Math.max(1, metrics.viewportHeight || 0) * ASSIST_VIEWPORT_SCROLL_HEIGHT_FACTOR);
        } catch (e) {
            return false;
        }
    }

    function shouldUseAssistViewportSnapshot(reason) {
        try {
            const normalizedReason = String(reason || '').toLowerCase();
            if (normalizedReason === 'scroll_viewport') {
                return !!assistLastSnapshotPayload
                    && !!assistLastSnapshotPayload.truncated
                    && (Date.now() - assistLastSnapshotSentAt) >= ASSIST_SCROLL_VIEWPORT_SNAPSHOT_MIN_INTERVAL_MS;
            }
            if (isAssistViewportModeEligible()) return true;
            if (!assistLastSnapshotPayload || !assistLastSnapshotPayload.truncated) return false;
            return normalizedReason !== 'snapshot_request';
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

    function applyAssistStickyViewportClonePosition(clone, element, computed) {
        try {
            if (!clone || !element || !(clone instanceof Element) || !(element instanceof Element)) return false;
            const position = String(computed && computed.position || '').toLowerCase();
            if (position !== 'sticky') return false;
            const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
            const viewportWidth = Math.max(1, Math.round(window.innerWidth || 0));
            const viewportHeight = Math.max(1, Math.round(window.innerHeight || 0));
            if (!rect || rect.width < 8 || rect.height < 8) return false;
            let left = Math.max(0, Math.round(rect.left || 0));
            let width = Math.max(1, Math.round(rect.width || 1));
            const top = Math.max(0, Math.round(rect.top || 0));
            const bottom = Math.max(0, Math.round(viewportHeight - (rect.bottom || 0)));
            const minHeight = Math.max(1, Math.round(rect.height || 1));
            const anchor = isAssistPinnedBottomCandidate(element, computed) ? 'bottom' : 'top';
            if (left <= 4 && Math.abs((rect.right || 0) - viewportWidth) <= 4) {
                left = 0;
                width = viewportWidth;
            }
            clone.setAttribute('style', (clone.getAttribute('style') || '') + ';position:fixed;left:' + left + 'px;' + (anchor === 'bottom' ? ('top:auto;right:auto;bottom:' + bottom + 'px;') : ('top:' + top + 'px;right:auto;bottom:auto;')) + 'width:' + width + 'px;min-height:' + minHeight + 'px;margin:0;transform:none;');
            return true;
        } catch (e) {
            return false;
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
            if (preservePosition) {
                const computed = window.getComputedStyle(element);
                applyAssistStickyViewportClonePosition(clone, element, computed);
            } else {
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
            if (container.getAttribute && container.getAttribute('data-ra-viewport-overlay') === '1') {
                clone.setAttribute('style', (clone.getAttribute('style') || '') + ';pointer-events:auto;');
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
        overlayStage.setAttribute('style', 'position:absolute;left:0;top:0;right:0;bottom:0;min-height:' + docHeight + 'px;z-index:2147483000;pointer-events:none;');
        return overlayStage;
    }

    function buildAssistWindowViewportBodyClone(stats) {
        try {
            if (!document.body) return null;
            const viewportRoots = collectAssistViewportRoots(ASSIST_VIEWPORT_ROOT_LIMIT);
            if (!viewportRoots.length) return null;
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

    function getAssistPinnedBottomCandidateMetrics(element) {
        try {
            const rect = element && element.getBoundingClientRect ? element.getBoundingClientRect() : null;
            const viewportWidth = Math.max(1, Math.round(window.innerWidth || 0));
            const viewportHeight = Math.max(1, Math.round(window.innerHeight || 0));
            const width = Math.max(0, Math.round(rect ? rect.width : 0));
            const height = Math.max(0, Math.round(rect ? rect.height : 0));
            const top = Math.max(0, Math.round(rect ? rect.top : 0));
            const bottom = Math.max(0, Math.round(rect ? rect.bottom : 0));
            return {
                width: width,
                height: height,
                top: top,
                bottomGap: Math.abs(viewportHeight - bottom),
                widthRatio: width / Math.max(1, viewportWidth),
                area: width * height,
                fullWidthPriority: width >= Math.round(viewportWidth * 0.72) ? 1 : 0
            };
        } catch (e) {
            return {
                width: 0,
                height: 0,
                top: Number.MAX_SAFE_INTEGER,
                bottomGap: Number.MAX_SAFE_INTEGER,
                widthRatio: 0,
                area: 0,
                fullWidthPriority: 0
            };
        }
    }

    function compareAssistPinnedBottomCandidateMetrics(left, right) {
        const leftFullWidth = Math.max(0, Number(left && left.fullWidthPriority) || 0);
        const rightFullWidth = Math.max(0, Number(right && right.fullWidthPriority) || 0);
        if (leftFullWidth !== rightFullWidth) return rightFullWidth - leftFullWidth;
        const leftWidthRatio = Math.max(0, Number(left && left.widthRatio) || 0);
        const rightWidthRatio = Math.max(0, Number(right && right.widthRatio) || 0);
        if (Math.abs(leftWidthRatio - rightWidthRatio) > 0.001) return rightWidthRatio - leftWidthRatio;
        const leftBottomGap = Math.max(0, Number(left && left.bottomGap) || 0);
        const rightBottomGap = Math.max(0, Number(right && right.bottomGap) || 0);
        if (leftBottomGap !== rightBottomGap) return leftBottomGap - rightBottomGap;
        const leftArea = Math.max(0, Number(left && left.area) || 0);
        const rightArea = Math.max(0, Number(right && right.area) || 0);
        if (leftArea !== rightArea) return rightArea - leftArea;
        const leftHeight = Math.max(0, Number(left && left.height) || 0);
        const rightHeight = Math.max(0, Number(right && right.height) || 0);
        if (leftHeight !== rightHeight) return rightHeight - leftHeight;
        const leftTop = Math.max(0, Number(left && left.top) || 0);
        const rightTop = Math.max(0, Number(right && right.top) || 0);
        return leftTop - rightTop;
    }

    function collectAssistPinnedBottomElements(limit) {
        try {
            if (!document.body) return [];
            const selected = [];
            const candidates = [];
            const elements = Array.prototype.slice.call(document.body.querySelectorAll('*'));
            for (let i = 0; i < elements.length; i += 1) {
                const element = elements[i];
                const computed = window.getComputedStyle(element);
                if (!isAssistPinnedBottomCandidate(element, computed)) continue;
                candidates.push({
                    element: element,
                    metrics: getAssistPinnedBottomCandidateMetrics(element)
                });
            }
            candidates.sort(function(left, right) {
                return compareAssistPinnedBottomCandidateMetrics(left.metrics, right.metrics);
            });
            candidates.forEach(function(candidate) {
                pushAssistElementCandidate(selected, candidate.element);
            });
            selected.sort(function(left, right) {
                return compareAssistPinnedBottomCandidateMetrics(
                    getAssistPinnedBottomCandidateMetrics(left),
                    getAssistPinnedBottomCandidateMetrics(right)
                );
            });
            if (selected.length > limit) selected.length = limit;
            return selected.sort(function(left, right) {
                return (left.getBoundingClientRect().top || 0) - (right.getBoundingClientRect().top || 0);
            });
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
                if (nodeId && usedNodeIds && usedNodeIds.has(nodeId)) {
                    return;
                }
                if (nodeId && container.querySelector(`[data-ra-node-id="${String(nodeId).replace(/"/g, '\\"')}"]`)) {
                    return;
                }
                const pinnedStats = { nodeCount: 0, truncated: false, maxNodeCount: ASSIST_PINNED_BOTTOM_NODE_BUDGET };
                const pinnedClone = buildAssistClone(element, pinnedStats);
                if (!pinnedClone) return;
                if (container.getAttribute && container.getAttribute('data-ra-viewport-overlay') === '1') {
                    pinnedClone.setAttribute('style', (pinnedClone.getAttribute('style') || '') + ';pointer-events:auto;');
                }
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

    function buildAssistSnapshotHtml(headMarkup, bodyAttrs, bodyClone) {
        const wrapper = document.createElement('div');
        wrapper.appendChild(bodyClone);
        return '<!doctype html><html><head>' + headMarkup + '<style>html,body{margin:0;padding:0;background:#f8fafc;color:#0f172a;font-family:Arial,Helvetica,sans-serif;}*{box-sizing:border-box;}[data-ra-node-id]{cursor:crosshair;}img{max-width:100%;}</style></head><body' + bodyAttrs + '>' + wrapper.innerHTML + '</body></html>';
    }

    function trimAssistViewportContentTail(bodyClone) {
        try {
            if (!bodyClone || !(bodyClone instanceof Element)) return false;
            const scrollStages = Array.prototype.slice.call(bodyClone.querySelectorAll('[data-ra-scroll-stage="1"]')).reverse();
            for (let i = 0; i < scrollStages.length; i += 1) {
                const stage = scrollStages[i];
                if (stage && stage.lastChild) {
                    stage.removeChild(stage.lastChild);
                    return true;
                }
            }
            const viewportStage = bodyClone.querySelector('[data-ra-viewport-stage="1"]');
            if (viewportStage && viewportStage.lastChild) {
                viewportStage.removeChild(viewportStage.lastChild);
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function fitAssistSnapshotHtmlWithinLimit(headMarkup, bodyAttrs, bodyClone, stats, useViewportMode, route) {
        let html = buildAssistSnapshotHtml(headMarkup, bodyAttrs, bodyClone);
        let trimmedNodes = 0;
        let slicedFallback = false;
        if (useViewportMode) {
            while (html.length > ASSIST_MAX_HTML_LENGTH && trimAssistViewportContentTail(bodyClone)) {
                trimmedNodes += 1;
                if (stats) stats.truncated = true;
                html = buildAssistSnapshotHtml(headMarkup, bodyAttrs, bodyClone);
            }
        }
        if (html.length > ASSIST_MAX_HTML_LENGTH) {
            html = html.slice(0, ASSIST_MAX_HTML_LENGTH);
            slicedFallback = true;
            if (stats) stats.truncated = true;
        }
        return html;
    }

    function buildAssistSnapshotPayload(reason) {
        try {
            const rawRoute = window.location.pathname + window.location.search + window.location.hash;
            const route = normalizeAssistRoute();
            if (!isAssistManagedRoute(route)) {
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
            const stats = { nodeCount: 0, truncated: false, maxNodeCount: useViewportMode ? ASSIST_VIEWPORT_NODE_LIMIT : ASSIST_MAX_NODE_COUNT };
            const viewportMetrics = useViewportMode ? getAssistActiveViewportMetrics() : null;
            const viewportTarget = useViewportMode && viewportMetrics ? viewportMetrics.target : assistScrollTarget;
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
            const html = fitAssistSnapshotHtmlWithinLimit(headMarkup, bodyAttrs, bodyClone, stats, useViewportMode, route);
            const scrollPayload = buildAssistScrollPayload(useViewportMode ? viewportTarget : assistScrollTarget);
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

    function sendAssistSnapshotPayload(payload, traceMeta = null) {
        if (!payload) return false;
        const nextPayload = traceMeta ? Object.assign({}, payload, traceMeta) : payload;
        const sent = sendAssistEvent('snapshot_replace', nextPayload);
        if (sent) {
            assistLastSnapshotPayload = nextPayload;
            assistLastSnapshotSentAt = Date.now();
        }
        return sent;
    }

    function rememberAssistScrollTarget(target) {
        try {
            const recentTarget = getRecentAssistElementScrollTarget();
            if (recentTarget && (!target || target === window || target === document || target === document.body || target === document.documentElement)) {
                assistScrollTarget = recentTarget;
                return;
            }
            if (!target || target === window || target === document || target === document.body || target === document.documentElement) {
                assistScrollTarget = window;
                return;
            }
            if (target instanceof Element) {
                assistScrollTarget = target;
                if (isAssistUsableScrollTarget(target)) {
                    assistLastElementScrollTarget = target;
                    assistLastElementScrollAt = Date.now();
                }
                return;
            }
            assistScrollTarget = window;
        } catch (e) {
            assistScrollTarget = window;
            logAssistDebug('scroll_target_remembered_error', {
                message: String((e && e.message) || e || ''),
                nextTarget: describeAssistTarget(assistScrollTarget)
            });
        }
    }

    function buildAssistScrollPayload(target) {
        const payload = {
            top: Math.max(0, Math.round(window.scrollY || window.pageYOffset || 0)),
            left: Math.max(0, Math.round(window.scrollX || window.pageXOffset || 0)),
            viewport_height: Math.max(0, Math.round(window.innerHeight || 0)),
            viewport_width: Math.max(0, Math.round(window.innerWidth || 0)),
            route: normalizeAssistRoute(),
            mode: 'window'
        };
        let activeTarget = target || getRecentAssistElementScrollTarget() || assistScrollTarget || window;
        try {
            const needsRefresh = !activeTarget
                || activeTarget === window
                || (activeTarget instanceof Element && !isAssistUsableScrollTarget(activeTarget));
            if (needsRefresh) {
                activeTarget = refreshAssistScrollTarget('build_scroll_payload', !target || activeTarget === window);
            }
        } catch (e) {
            activeTarget = window;
        }
        try {
            if (activeTarget && activeTarget !== window && activeTarget instanceof Element) {
                const computed = window.getComputedStyle(activeTarget);
                const targetMetrics = {
                    rect: activeTarget.getBoundingClientRect ? activeTarget.getBoundingClientRect() : null,
                    clientHeight: Math.max(0, Math.round(activeTarget.clientHeight || window.innerHeight || 0)),
                    scrollHeight: Math.max(0, Math.round(activeTarget.scrollHeight || activeTarget.clientHeight || 0)),
                    scrollTop: Math.max(0, Math.round(activeTarget.scrollTop || 0)),
                    overflowValue: String(computed.overflowY || computed.overflow || '').toLowerCase(),
                    touchScrollValue: String(computed.webkitOverflowScrolling || '').toLowerCase()
                };
                if (isAssistWindowScrollFallbackTarget(activeTarget, computed, targetMetrics)) {
                    logAssistDebug('scroll_target_forced_window', {
                        route: String(payload.route || ''),
                        window_top: Number(payload.top || 0),
                        target: describeAssistTarget(activeTarget)
                    });
                    activeTarget = window;
                }
            }
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
            && (assistLastScrollPayload.route || '') === (payload.route || '')
            && assistLastScrollPayload.mode === payload.mode
            && (assistLastScrollPayload.node_id || '') === (payload.node_id || '')
            && assistLastScrollPayload.top === payload.top
            && assistLastScrollPayload.left === payload.left) {
            return false;
        }
        const sent = sendAssistEvent('scroll_changed', payload);
        if (sent) {
            assistLastScrollPayload = payload;
            logAssistDebug('scroll_emit', {
                force: !!force,
                route: String(payload.route || ''),
                mode: String(payload.mode || ''),
                top: Number(payload.top || 0),
                left: Number(payload.left || 0),
                node_id: String(payload.node_id || ''),
                selector_hint: String(payload.selector_hint || ''),
                remembered_target: describeAssistTarget(assistScrollTarget)
            });
        } else {
            logAssistDebug('scroll_send_failed', {
                force: !!force,
                route: String(payload.route || ''),
                mode: payload.mode,
                top: payload.top,
                left: payload.left,
                nodeId: String(payload.node_id || ''),
                selector_hint: String(payload.selector_hint || ''),
                remembered_target: describeAssistTarget(assistScrollTarget)
            });
        }
        return sent;
    }

    function isAssistScrollSettling() {
        return !!assistScrollTimer;
    }

    function scheduleAssistScroll(delay) {
        if (!assistSessionId) return;
        clearAssistScrollTimer();
        const nextDelay = typeof delay === 'number' ? delay : ASSIST_SCROLL_SETTLE_DELAY;
        assistScrollTimer = setTimeout(function() {
            assistScrollTimer = null;
            const settledTarget = refreshAssistScrollTarget('scroll_settled_sync', false);
            emitAssistScroll(true);
            markAssistSnapshotTrigger('scroll_settled', {
                source: 'scroll_settled_sync',
                scheduled_delay_ms: nextDelay
            });
            emitAssistSnapshot('scroll_settled');
        }, nextDelay);
    }

    function emitAssistSnapshot(reason) {
        if (!assistSessionId) return false;
        const now = Date.now();
        const route = normalizeAssistRoute();
        const snapshotReason = String(reason || '');
        const snapshotTraceMeta = buildAssistTraceMeta('snapshot_replace', route, snapshotReason);
        const emitStartedAt = getAssistPerfNow();
        const triggerMeta = assistLastSnapshotTriggerMeta && assistLastSnapshotTriggerMeta.reason === snapshotReason
            ? assistLastSnapshotTriggerMeta
            : null;
        if (triggerMeta) {
            assistLastSnapshotTriggerMeta = null;
        }
        const triggerWaitMs = triggerMeta ? Math.max(0, Math.round(emitStartedAt - triggerMeta.at)) : 0;
        if (triggerWaitMs >= ASSIST_SNAPSHOT_TRIGGER_LOG_THRESHOLD_MS) {
            logAssistDebug('snapshot_trigger_timing', {
                reason: snapshotReason,
                triggerWaitMs,
                source: String(triggerMeta && triggerMeta.extra && triggerMeta.extra.source || ''),
                scheduledDelayMs: Number(triggerMeta && triggerMeta.extra && triggerMeta.extra.scheduled_delay_ms || 0),
                requestReason: String(triggerMeta && triggerMeta.extra && triggerMeta.extra.request_reason || '')
            });
        }
        if (snapshotReason === 'snapshot_request'
            && assistLastSnapshotPayload
            && assistLastSnapshotPayload.route === route
            && !isAssistRouteSettling(route)
            && (now - assistLastSnapshotSentAt) < 3000) {
            const sendStartedAt = getAssistPerfNow();
            const sent = sendAssistSnapshotPayload(assistLastSnapshotPayload, snapshotTraceMeta);
            const sendMs = Math.max(0, Math.round(getAssistPerfNow() - sendStartedAt));
            if (sent && shouldLogAssistSnapshotBuild(snapshotReason, 0, triggerWaitMs)) {
                logAssistDebug('snapshot_build_timing', {
                    traceId: snapshotTraceMeta.trace_id,
                    reason: snapshotReason,
                    mode: 'cached',
                    route: String(assistLastSnapshotPayload.route || route || ''),
                    htmlLength: String(assistLastSnapshotPayload.html || '').length,
                    truncated: !!assistLastSnapshotPayload.truncated,
                    nodeCount: Number(assistLastSnapshotPayload.node_count || 0),
                    buildMs: 0,
                    sendMs,
                    triggerWaitMs,
                    source: String(triggerMeta && triggerMeta.extra && triggerMeta.extra.source || ''),
                    scheduledDelayMs: Number(triggerMeta && triggerMeta.extra && triggerMeta.extra.scheduled_delay_ms || 0),
                    requestReason: String(triggerMeta && triggerMeta.extra && triggerMeta.extra.request_reason || '')
                });
            }
            if (!sent) {
                logAssistDebug('snapshot_send_failed_cached', {
                    traceId: snapshotTraceMeta.trace_id,
                    reason: snapshotReason,
                    route: String(assistLastSnapshotPayload.route || route || ''),
                    htmlLength: String(assistLastSnapshotPayload.html || '').length,
                    truncated: !!assistLastSnapshotPayload.truncated,
                    nodeCount: Number(assistLastSnapshotPayload.node_count || 0),
                    scrollMode: String(assistLastSnapshotPayload.scroll && assistLastSnapshotPayload.scroll.mode || 'window'),
                    scrollTop: Number(assistLastSnapshotPayload.scroll && assistLastSnapshotPayload.scroll.top || 0),
                    scrollLeft: Number(assistLastSnapshotPayload.scroll && assistLastSnapshotPayload.scroll.left || 0)
                });
            }
            return sent;
        }
        if ((snapshotReason === 'connect_open' || snapshotReason === 'session_state')
            && assistLastSnapshotPayload
            && assistLastSnapshotPayload.route === route
            && (now - assistLastSnapshotSentAt) < 1200) {
            return false;
        }
        const buildStartedAt = getAssistPerfNow();
        const payload = buildAssistSnapshotPayload(snapshotReason);
        const buildMs = Math.max(0, Math.round(getAssistPerfNow() - buildStartedAt));
        if (!payload) {
            if (shouldLogAssistSnapshotBuild(snapshotReason, buildMs, triggerWaitMs)) {
                logAssistDebug('snapshot_trigger_timing', {
                    reason: snapshotReason,
                    outcome: 'build_empty',
                    triggerWaitMs,
                    buildMs,
                    source: String(triggerMeta && triggerMeta.extra && triggerMeta.extra.source || ''),
                    scheduledDelayMs: Number(triggerMeta && triggerMeta.extra && triggerMeta.extra.scheduled_delay_ms || 0),
                    requestReason: String(triggerMeta && triggerMeta.extra && triggerMeta.extra.request_reason || '')
                });
            }
            logAssistDebug('snapshot_build_empty', {
                reason: snapshotReason,
                route: String(route || '')
            });
            return false;
        }
        if (assistLastSnapshotPayload
            && assistLastSnapshotPayload.route === payload.route
            && assistLastSnapshotPayload.html === payload.html
            && (now - assistLastSnapshotSentAt) < 5000
            && snapshotReason !== 'snapshot_request') {
            if (shouldLogAssistSnapshotBuild(snapshotReason, buildMs, triggerWaitMs)) {
                logAssistDebug('snapshot_trigger_timing', {
                    reason: snapshotReason,
                    outcome: 'skip_same_payload',
                    triggerWaitMs,
                    buildMs,
                    source: String(triggerMeta && triggerMeta.extra && triggerMeta.extra.source || ''),
                    scheduledDelayMs: Number(triggerMeta && triggerMeta.extra && triggerMeta.extra.scheduled_delay_ms || 0),
                    requestReason: String(triggerMeta && triggerMeta.extra && triggerMeta.extra.request_reason || '')
                });
            }
            return false;
        }
        const sendStartedAt = getAssistPerfNow();
        const sent = sendAssistSnapshotPayload(payload, snapshotTraceMeta);
        const sendMs = Math.max(0, Math.round(getAssistPerfNow() - sendStartedAt));
        if (sent && shouldLogAssistSnapshotBuild(snapshotReason, buildMs, triggerWaitMs)) {
            logAssistDebug('snapshot_build_timing', {
                traceId: snapshotTraceMeta.trace_id,
                reason: snapshotReason,
                mode: 'fresh',
                route: String(payload.route || ''),
                htmlLength: String(payload.html || '').length,
                truncated: !!payload.truncated,
                nodeCount: Number(payload.node_count || 0),
                buildMs,
                sendMs,
                triggerWaitMs,
                source: String(triggerMeta && triggerMeta.extra && triggerMeta.extra.source || ''),
                scheduledDelayMs: Number(triggerMeta && triggerMeta.extra && triggerMeta.extra.scheduled_delay_ms || 0),
                requestReason: String(triggerMeta && triggerMeta.extra && triggerMeta.extra.request_reason || '')
            });
        }
        if (!sent) {
            logAssistDebug('snapshot_send_failed', {
                traceId: snapshotTraceMeta.trace_id,
                reason: snapshotReason,
                route: String(payload.route || ''),
                htmlLength: String(payload.html || '').length,
                truncated: !!payload.truncated,
                nodeCount: Number(payload.node_count || 0),
                scrollMode: String(payload.scroll && payload.scroll.mode || 'window'),
                scrollTop: Number(payload.scroll && payload.scroll.top || 0),
                scrollLeft: Number(payload.scroll && payload.scroll.left || 0),
                scrollNodeId: String(payload.scroll && payload.scroll.node_id || '')
            });
        }
        return sent;
    }

    function scheduleAssistSnapshot(delay, reason) {
        if (!assistSessionId) return;
        clearAssistSnapshotTimer();
        const snapshotReason = reason || 'mutation';
        const nextDelay = typeof delay === 'number' ? delay : 500;
        markAssistSnapshotTrigger(snapshotReason, {
            source: 'schedule',
            scheduled_delay_ms: nextDelay
        });
        assistSnapshotTimer = setTimeout(function() {
            emitAssistSnapshot(snapshotReason);
        }, nextDelay);
    }

    function startAssistDomObserver() {
        stopAssistDomObserver();
        if (!assistSessionId || !document.body || typeof MutationObserver === 'undefined') return;
        assistMutationObserver = new MutationObserver(function(mutations) {
            if (!isAssistManagedRoute()) return;
            if (Date.now() < assistSuppressSnapshotUntil) return;
            const shouldRefresh = (mutations || []).some(function(mutation) {
                const target = mutation && mutation.target && mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target;
                return target && !(target.closest && target.closest('#ak-admin-chat'));
            });
            if (shouldRefresh) {
                if (isAssistScrollSettling()) return;
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
        if (!isAssistManagedRoute()) return;
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
        if (!isAssistManagedRoute(route)) return;
        const traceMeta = buildAssistTraceMeta('route_changed', route, 'route_changed');
        const payload = {
            route: route,
            title: document.title || '',
            replace: false,
            ...traceMeta
        };
        const sent = sendAssistEvent('route_changed', payload);
        if (sent) {
            logAssistDebug('route_emit_trace', {
                traceId: traceMeta.trace_id,
                route: String(payload.route || ''),
                title: String(payload.title || '')
            });
        }
        if (!sent) {
            logAssistDebug('route_send_failed', {
                traceId: traceMeta.trace_id,
                route: String(payload.route || ''),
                title: String(payload.title || '')
            });
        }
    }

    function scheduleAssistReconnect() {
        clearAssistReconnectTimer();
        if (!assistSessionId) return;
        logAssistDebug('assist_reconnect_scheduled', {
            delayMs: 1500
        });
        assistReconnectTimer = setTimeout(function() {
            connectAssist(assistSessionId);
        }, 1500);
    }

    function resumeAssistConnection(reason) {
        const activeSessionId = restoreAssistSessionId();
        if (!activeSessionId) return;
        if (assistWs && (assistWs.readyState === WebSocket.OPEN || assistWs.readyState === WebSocket.CONNECTING)) {
            logAssistDebug('assist_resume_skipped', {
                reason: String(reason || ''),
                assistReadyState: getChatWsReadyStateLabel(assistWs)
            });
            return;
        }
        logAssistDebug('assist_resume_attempt', {
            reason: String(reason || '')
        });
        connectAssist(activeSessionId);
    }

    function disconnectAssist(sessionId, silent, preserveSession) {
        if (sessionId && assistSessionId && String(sessionId) !== String(assistSessionId)) return;
        logAssistDebug('assist_disconnect', {
            requestedSessionId: String(sessionId || ''),
            silent: !!silent,
            preserveSession: !!preserveSession
        });
        clearAssistReconnectTimer();
        stopAssistHeartbeat();
        stopAssistDomObserver();
        clearAssistScrollTimer();
        clearAssistRouteSettleState();
        const releasedSessionId = String(assistSessionId || sessionId || '').trim();
        assistSessionId = '';
        if (preserveSession) {
            if (releasedSessionId) {
                persistAssistSessionId(releasedSessionId);
            }
        } else {
            persistAssistSessionId('');
        }
        assistScrollTarget = window;
        assistLastElementScrollTarget = null;
        assistLastElementScrollAt = 0;
        assistCachedHeadRoute = '';
        assistCachedHeadMarkup = '';
        assistLastSnapshotPayload = null;
        assistLastSnapshotSentAt = 0;
        assistLastScrollPayload = null;
        assistLastScrollTargetRefreshAt = 0;
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
            persistAssistSessionId(wantedSessionId);
            logAssistDebug('assist_connect_skipped', {
                wantedSessionId: wantedSessionId,
                assistReadyState: getChatWsReadyStateLabel(assistWs)
            });
            return;
        }
        if (assistSessionId && assistSessionId !== wantedSessionId) {
            disconnectAssist('', true);
        }
        clearAssistReconnectTimer();
        assistSessionId = wantedSessionId;
        persistAssistSessionId(wantedSessionId);
        logAssistDebug('assist_connect_start', {
            wantedSessionId: wantedSessionId
        });
        try {
            const currentAssistWs = new WebSocket(ASSIST_WS_URL + '?session_id=' + encodeURIComponent(wantedSessionId) + '&role=user&site=ak_web&readonly=0');
            assistWs = currentAssistWs;
            currentAssistWs.onopen = function() {
                if (assistWs !== currentAssistWs) return;
                logAssistDebug('assist_ws_open', {
                    wantedSessionId: wantedSessionId
                });
                startAssistHeartbeat();
                emitAssistRoute();
                startAssistDomObserver();
                scheduleAssistRouteSettledSync(normalizeAssistRoute(), ASSIST_ROUTE_SETTLE_DELAY, false);
            };
            currentAssistWs.onmessage = function(e) {
                if (assistWs !== currentAssistWs) return;
                try {
                    const data = JSON.parse(e.data || '{}');
                    if (data.type === 'click_highlight' && data.payload) {
                        applyAssistHighlight(data.payload);
                    } else if (data.type === 'snapshot_request') {
                        const snapshotRequestReason = String(data.payload && data.payload.reason || '');
                        if (deferAssistSnapshotUntilRouteSettled(normalizeAssistRoute(), snapshotRequestReason)) {
                            return;
                        }
                        markAssistSnapshotTrigger('snapshot_request', {
                            source: 'snapshot_request',
                            request_reason: snapshotRequestReason
                        });
                        emitAssistSnapshot('snapshot_request');
                    } else if (data.type === 'session_state') {
                        emitAssistRoute();
                        if (!data.payload || !data.payload.has_snapshot) {
                            if (deferAssistSnapshotUntilRouteSettled(normalizeAssistRoute(), 'session_state')) {
                                return;
                            }
                            markAssistSnapshotTrigger('session_state', {
                                source: 'session_state'
                            });
                            emitAssistSnapshot('session_state');
                        }
                    }
                } catch (err) {
                    console.error('[AKChatAssist] 消息处理错误:', err);
                }
            };
            currentAssistWs.onclose = function(event) {
                if (assistWs !== currentAssistWs) return;
                logAssistDebug('assist_ws_close', {
                    wantedSessionId: wantedSessionId,
                    code: Number((event && event.code) || 0),
                    reason: String((event && event.reason) || '')
                });
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
                logAssistDebug('assist_ws_error', {
                    wantedSessionId: wantedSessionId,
                    type: String((err && err.type) || '')
                });
                console.error('[AKChatAssist] WebSocket 错误:', err);
            };
        } catch (e) {
            logAssistDebug('assist_connect_exception', {
                wantedSessionId: wantedSessionId,
                message: String((e && e.message) || e || '')
            });
            scheduleAssistReconnect();
        }
    }

    function isPresenceForeground() {
        return !document.hidden;
    }

    function sendPresence(type) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            if (type === 'online') {
                username = getUsername();
            }
            ws.send(JSON.stringify({
                type: type,
                username: username,
                page: window.location.pathname + window.location.hash,
                userAgent: navigator.userAgent,
                pageClientId: getPageClientId()
            }));
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
            return;
        }
        reconnectTimer = setTimeout(function() {
            connect();
        }, 5000);
    }

    function suspendPresence(reason) {
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
        presenceSuspended = false;
        clearReconnectTimer();
        if (ws && ws.readyState === WebSocket.OPEN) {
            sendPresence('online');
            startHeartbeat();
            resumeAssistConnection(String(reason || 'resume_presence_ws_open'));
            return;
        }
        connect();
        resumeAssistConnection(String(reason || 'resume_presence_connect'));
    }
    
    // 连接WebSocket
    function connect() {
        // 获取用户名
        username = getUsername();
        clearReconnectTimer();
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
        
        try {
            ws = new WebSocket(WS_URL + '?username=' + encodeURIComponent(username));
            
            ws.onopen = function() {
                if (!isPresenceForeground() || presenceSuspended) {
                    presenceSuspended = true;
                    ws.close();
                    return;
                }
                sendPresence('online');
                startHeartbeat();
                schedulePresenceIdentityRefresh();
                emitChatBridgeEvent('ak-chat-ws-open', { username: username || '' });
                logAssistDebug('chat_ws_open_for_assist', {
                    username: String(username || '')
                });
                resumeAssistConnection('chat_ws_open');
            };
            
            ws.onmessage = function(e) {
                try {
                    const data = JSON.parse(e.data);
                    emitChatBridgeEvent('ak-chat-ws-message', data);
                    
                    if (data.type === 'admin_message') {
                        // 收到管理员消息 - 唯一可以弹出窗口的情况
                        addMessage(data.content, true, data.time);
                        showChat();
                        playNotificationSound();
                    } else if (data.type === 'remote_assist_request') {
                        logAssistDebug('assist_request_received', {
                            sessionId: String(data.session_id || '')
                        });
                        openAssistRequestDialog(data);
                    } else if (data.type === 'remote_assist_bind') {
                        logAssistDebug('assist_bind_received', {
                            sessionId: String(data.session_id || '')
                        });
                        closeAssistRequestDialog(true);
                        persistAssistSessionId(data.session_id || '');
                        connectAssist(data.session_id || '');
                    } else if (data.type === 'remote_assist_unbind') {
                        logAssistDebug('assist_unbind_received', {
                            sessionId: String(data.session_id || '')
                        });
                        if (!data.session_id || (pendingAssistRequest && String(pendingAssistRequest.session_id || '') === String(data.session_id || ''))) {
                            closeAssistRequestDialog(true);
                        }
                        disconnectAssist(data.session_id || '', true);
                    } else if (data.type === 'remote_voice_request') {
                        openVoiceRequestDialog(data);
                        playNotificationSound();
                    } else if (data.type === 'remote_voice_bind') {
                        closeVoiceRequestDialog(true);
                        emitRemoteVoiceEvent('bind', data);
                    } else if (data.type === 'remote_voice_unbind') {
                        if (!data.voice_session_id || (pendingVoiceRequest && String(pendingVoiceRequest.voice_session_id || '') === String(data.voice_session_id || ''))) {
                            closeVoiceRequestDialog(true);
                        }
                        emitRemoteVoiceEvent('unbind', data);
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
                closeAssistRequestDialog(true);
                closeVoiceRequestDialog(true);
                if (!hasForegroundProtectedRealtimeSession()) {
                    stopRemoteVoiceClient(false, 'chat_socket_closed', true);
                }
                stopHeartbeat();
                ws = null;
                emitChatBridgeEvent('ak-chat-ws-close', {
                    code: Number((event && event.code) || 0),
                    reason: String((event && event.reason) || '')
                });
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

    function sendWsPayload(payload) {
        if (!payload || typeof payload !== 'object') return false;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
            ws.send(JSON.stringify(payload));
            return true;
        } catch(e) {
            return false;
        }
    }
    
    // 暴露全局API
    window.AKChat = {
        show: showChat,
        close: closeChat,
        send: sendMessage,
        sendWsPayload: sendWsPayload,
        playNotificationSound: playNotificationSound,
        reconnect: reconnect,
        acceptRequest: acceptRequest,
        rejectRequest: rejectRequest,
        acceptAssistRequest: acceptAssistRequest,
        rejectAssistRequest: rejectAssistRequest,
        acceptVoiceRequest: acceptVoiceRequest,
        rejectVoiceRequest: rejectVoiceRequest,
        toggleVoiceMute: toggleRemoteVoiceMute
    };
    ensureNotificationWidget();
    ensureIMPlugin();
    emitChatBridgeEvent('ak-chat-ready', { api: window.AKChat });
    
    // 监听SPA路由变化（history.pushState / replaceState / 浏览器前进后退）
    function onUrlChange() {
        if (ws && ws.readyState === WebSocket.OPEN && !document.hidden) {
            sendPresence('online');
        }
        if (assistWs && assistWs.readyState === WebSocket.OPEN) {
            const nextRoute = normalizeAssistRoute();
            clearAssistSnapshotTimer();
            clearAssistScrollTimer();
            assistScrollTarget = window;
            assistLastScrollTargetRefreshAt = 0;
            emitAssistRoute();
            scheduleAssistRouteSettledSync(nextRoute, ASSIST_ROUTE_SETTLE_DELAY, false);
        }
    }
    (function() {
        var origPush = history.pushState.bind(history);
        var origReplace = history.replaceState.bind(history);
        history.pushState = function() { origPush.apply(history, arguments); onUrlChange(); };
        history.replaceState = function() { origReplace.apply(history, arguments); onUrlChange(); };
    })();
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);
    window.addEventListener('scroll', function() {
        if (!assistWs || assistWs.readyState !== WebSocket.OPEN || !assistSessionId) return;
        const route = normalizeAssistRoute();
        if (!isAssistManagedRoute(route)) return;
        logAssistScrollCapture('window', window);
        rememberAssistScrollTarget(window);
        scheduleAssistRouteFastScrollSync(route, ASSIST_ROUTE_FAST_SCROLL_DELAY);
        scheduleAssistScroll(ASSIST_SCROLL_SETTLE_DELAY);
    }, { passive: true });
    document.addEventListener('scroll', function(event) {
        if (!assistWs || assistWs.readyState !== WebSocket.OPEN || !assistSessionId) return;
        const route = normalizeAssistRoute();
        if (!isAssistManagedRoute(route)) return;
        const target = event && event.target;
        if (isAssistWidgetTarget(target)) return;
        logAssistScrollCapture('document', target);
        rememberAssistScrollTarget(target);
        scheduleAssistRouteFastScrollSync(route, ASSIST_ROUTE_FAST_SCROLL_DELAY);
        scheduleAssistScroll(ASSIST_SCROLL_SETTLE_DELAY);
    }, true);
    document.addEventListener('click', function(event) {
        if (!assistWs || assistWs.readyState !== WebSocket.OPEN || !assistSessionId) return;
        const target = event && event.target;
        if (isAssistWidgetTarget(target)) return;
        if (!isAssistManagedRoute()) return;
        sendAssistEvent('click_highlight', pickAssistMeta(target));
        if (!isAssistFormFieldTarget(target)) {
            scheduleAssistSnapshot(100, 'click_interaction');
        }
    }, true);
    document.addEventListener('input', handleAssistFormValueChange, true);
    document.addEventListener('change', handleAssistFormValueChange, true);

    document.addEventListener('visibilitychange', function() {
        logAssistDebug('page_visibility_change', {
            hidden: !!document.hidden
        });
        if (document.hidden) {
            if (hasForegroundProtectedRealtimeSession()) {
                logAssistDebug('page_visibility_hidden_keepalive', {
                    hasProtectedRealtimeSession: true
                });
                return;
            }
            suspendPresence('visibilitychange:hidden');
        } else {
            resumePresence('visibilitychange:visible');
        }
    });

    window.addEventListener('pagehide', function() {
        logAssistDebug('page_hide', {
            hasProtectedRealtimeSession: hasForegroundProtectedRealtimeSession()
        });
        if (hasForegroundProtectedRealtimeSession()) {
            return;
        }
        disconnectAssist('', true, true);
        stopRemoteVoiceClient(false, 'pagehide', true);
        suspendPresence('pagehide');
    });
    window.addEventListener('pageshow', function() {
        logAssistDebug('page_show', {
            isPresenceForeground: isPresenceForeground()
        });
        if (isPresenceForeground()) resumePresence('pageshow');
    });
    window.addEventListener('focus', function() {
        logAssistDebug('page_focus', {
            isPresenceForeground: isPresenceForeground()
        });
        if (isPresenceForeground()) resumePresence('focus');
    });
    window.addEventListener('beforeunload', function() {
        logAssistDebug('page_before_unload', {});
        disconnectAssist('', true, true);
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
