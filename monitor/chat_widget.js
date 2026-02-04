/**
 * AK代理 - 客服聊天组件
 * 注入到用户页面，实现实时通讯
 */
(function() {
    // 配置
    const WS_URL = 'wss://' + window.location.host + '/chat/ws';
    const HEARTBEAT_INTERVAL = 30000; // 30秒心跳
    
    // 状态
    let ws = null;
    let username = null;
    let isMinimized = true;
    let unreadCount = 0;
    let heartbeatTimer = null;
    
    // 尝试获取用户名
    function getUsername() {
        try {
            // 从localStorage获取用户信息
            const userModel = localStorage.getItem('AK_USER_MODEL') || localStorage.getItem('user_model');
            if (userModel) {
                const user = JSON.parse(userModel);
                return user.Account || user.account || user.Username || user.username;
            }
            // 从APP.GLOBAL获取
            if (window.APP && APP.GLOBAL && APP.GLOBAL.getUserModel) {
                const user = APP.GLOBAL.getUserModel();
                if (user) return user.Account || user.account;
            }
        } catch (e) {}
        return 'visitor_' + Math.random().toString(36).substr(2, 8);
    }
    
    // 创建聊天界面
    function createChatUI() {
        const style = document.createElement('style');
        style.textContent = `
            #ak-chat-widget {
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 999999;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            #ak-chat-btn {
                width: 60px;
                height: 60px;
                border-radius: 50%;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border: none;
                cursor: pointer;
                box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
                display: flex;
                align-items: center;
                justify-content: center;
                transition: transform 0.2s, box-shadow 0.2s;
            }
            #ak-chat-btn:hover {
                transform: scale(1.1);
                box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
            }
            #ak-chat-btn svg {
                width: 28px;
                height: 28px;
                fill: white;
            }
            #ak-chat-badge {
                position: absolute;
                top: -5px;
                right: -5px;
                background: #ff4757;
                color: white;
                border-radius: 10px;
                padding: 2px 6px;
                font-size: 12px;
                font-weight: bold;
                display: none;
            }
            #ak-chat-box {
                position: absolute;
                bottom: 70px;
                right: 0;
                width: 320px;
                height: 420px;
                background: #1a1a2e;
                border-radius: 16px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.3);
                display: none;
                flex-direction: column;
                overflow: hidden;
                border: 1px solid #2d2d44;
            }
            #ak-chat-box.active {
                display: flex;
            }
            #ak-chat-header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                padding: 15px;
                color: white;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            #ak-chat-header h4 {
                margin: 0;
                font-size: 16px;
            }
            #ak-chat-close {
                background: none;
                border: none;
                color: white;
                font-size: 20px;
                cursor: pointer;
                opacity: 0.8;
            }
            #ak-chat-close:hover {
                opacity: 1;
            }
            #ak-chat-messages {
                flex: 1;
                padding: 15px;
                overflow-y: auto;
                background: #0f0f23;
            }
            .ak-msg {
                margin-bottom: 12px;
                max-width: 85%;
                animation: ak-fadeIn 0.3s ease;
            }
            @keyframes ak-fadeIn {
                from { opacity: 0; transform: translateY(10px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .ak-msg.admin {
                margin-right: auto;
            }
            .ak-msg.user {
                margin-left: auto;
            }
            .ak-msg-content {
                padding: 10px 14px;
                border-radius: 12px;
                font-size: 14px;
                line-height: 1.4;
                word-wrap: break-word;
            }
            .ak-msg.admin .ak-msg-content {
                background: #2d2d44;
                color: #e4e4e4;
                border-bottom-left-radius: 4px;
            }
            .ak-msg.user .ak-msg-content {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border-bottom-right-radius: 4px;
            }
            .ak-msg-time {
                font-size: 11px;
                color: #666;
                margin-top: 4px;
            }
            .ak-msg.user .ak-msg-time {
                text-align: right;
            }
            #ak-chat-input-area {
                padding: 12px;
                background: #1a1a2e;
                border-top: 1px solid #2d2d44;
                display: flex;
                gap: 8px;
            }
            #ak-chat-input {
                flex: 1;
                padding: 10px 14px;
                border: 1px solid #2d2d44;
                border-radius: 20px;
                background: #0f0f23;
                color: #e4e4e4;
                font-size: 14px;
                outline: none;
            }
            #ak-chat-input:focus {
                border-color: #667eea;
            }
            #ak-chat-send {
                width: 40px;
                height: 40px;
                border-radius: 50%;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            #ak-chat-send svg {
                width: 18px;
                height: 18px;
                fill: white;
            }
            #ak-chat-status {
                padding: 4px 8px;
                font-size: 11px;
                background: rgba(0,0,0,0.2);
                border-radius: 10px;
            }
            #ak-chat-status.online {
                color: #00ff88;
            }
            #ak-chat-status.offline {
                color: #ff4757;
            }
        `;
        document.head.appendChild(style);
        
        const widget = document.createElement('div');
        widget.id = 'ak-chat-widget';
        widget.innerHTML = `
            <div id="ak-chat-box">
                <div id="ak-chat-header">
                    <h4>💬 在线客服</h4>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span id="ak-chat-status" class="offline">离线</span>
                        <button id="ak-chat-close">×</button>
                    </div>
                </div>
                <div id="ak-chat-messages">
                    <div class="ak-msg admin">
                        <div class="ak-msg-content">您好！有什么可以帮助您的吗？</div>
                        <div class="ak-msg-time">系统消息</div>
                    </div>
                </div>
                <div id="ak-chat-input-area">
                    <input type="text" id="ak-chat-input" placeholder="输入消息...">
                    <button id="ak-chat-send">
                        <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    </button>
                </div>
            </div>
            <button id="ak-chat-btn">
                <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
                <span id="ak-chat-badge">0</span>
            </button>
        `;
        document.body.appendChild(widget);
        
        // 绑定事件
        document.getElementById('ak-chat-btn').onclick = toggleChat;
        document.getElementById('ak-chat-close').onclick = toggleChat;
        document.getElementById('ak-chat-send').onclick = sendMessage;
        document.getElementById('ak-chat-input').onkeypress = (e) => {
            if (e.key === 'Enter') sendMessage();
        };
    }
    
    // 切换聊天框
    function toggleChat() {
        const box = document.getElementById('ak-chat-box');
        isMinimized = !isMinimized;
        box.classList.toggle('active', !isMinimized);
        if (!isMinimized) {
            unreadCount = 0;
            updateBadge();
            document.getElementById('ak-chat-input').focus();
        }
    }
    
    // 更新未读徽章
    function updateBadge() {
        const badge = document.getElementById('ak-chat-badge');
        badge.textContent = unreadCount;
        badge.style.display = unreadCount > 0 ? 'block' : 'none';
    }
    
    // 添加消息
    function addMessage(content, isAdmin, time) {
        const container = document.getElementById('ak-chat-messages');
        const msg = document.createElement('div');
        msg.className = `ak-msg ${isAdmin ? 'admin' : 'user'}`;
        msg.innerHTML = `
            <div class="ak-msg-content">${escapeHtml(content)}</div>
            <div class="ak-msg-time">${time || new Date().toLocaleTimeString()}</div>
        `;
        container.appendChild(msg);
        container.scrollTop = container.scrollHeight;
        
        if (isAdmin && isMinimized) {
            unreadCount++;
            updateBadge();
        }
    }
    
    // HTML转义
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // 发送消息
    function sendMessage() {
        const input = document.getElementById('ak-chat-input');
        const content = input.value.trim();
        if (!content || !ws || ws.readyState !== WebSocket.OPEN) return;
        
        ws.send(JSON.stringify({
            type: 'user_message',
            content: content
        }));
        
        addMessage(content, false);
        input.value = '';
    }
    
    // 连接WebSocket
    function connectWS() {
        username = getUsername();
        
        try {
            ws = new WebSocket(WS_URL + '?username=' + encodeURIComponent(username));
            
            ws.onopen = () => {
                console.log('[AK Chat] Connected');
                document.getElementById('ak-chat-status').textContent = '在线';
                document.getElementById('ak-chat-status').className = 'online';
                
                // 发送上线通知
                ws.send(JSON.stringify({
                    type: 'online',
                    username: username,
                    page: window.location.pathname,
                    userAgent: navigator.userAgent
                }));
                
                // 开始心跳
                heartbeatTimer = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'heartbeat' }));
                    }
                }, HEARTBEAT_INTERVAL);
            };
            
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'admin_message') {
                        addMessage(data.content, true, data.time);
                        // 如果聊天框是关闭的，显示通知
                        if (isMinimized) {
                            showNotification(data.content);
                        }
                    } else if (data.type === 'history') {
                        // 加载历史消息
                        data.messages.forEach(msg => {
                            addMessage(msg.content, msg.is_admin, msg.time);
                        });
                    }
                } catch (e) {}
            };
            
            ws.onclose = () => {
                console.log('[AK Chat] Disconnected');
                document.getElementById('ak-chat-status').textContent = '离线';
                document.getElementById('ak-chat-status').className = 'offline';
                clearInterval(heartbeatTimer);
                // 重连
                setTimeout(connectWS, 5000);
            };
            
            ws.onerror = (e) => {
                console.log('[AK Chat] Error', e);
            };
        } catch (e) {
            console.log('[AK Chat] Failed to connect', e);
            setTimeout(connectWS, 5000);
        }
    }
    
    // 显示桌面通知
    function showNotification(content) {
        if (Notification.permission === 'granted') {
            new Notification('新消息', { body: content, icon: '/favicon.ico' });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission();
        }
    }
    
    // 页面关闭时发送离线通知
    window.addEventListener('beforeunload', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'offline' }));
        }
    });
    
    // 初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            createChatUI();
            connectWS();
        });
    } else {
        createChatUI();
        connectWS();
    }
})();
