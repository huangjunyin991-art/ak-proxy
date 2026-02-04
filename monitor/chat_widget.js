/**
 * AK 系统管理员传讯组件
 * - 只有管理员发消息时才显示
 * - 用户关闭后需等管理员再发消息才能再次打开
 * - 青色风格匹配网站主题
 */

(function() {
    'use strict';
    
    // 配置
    const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_URL = `${WS_PROTOCOL}//${window.location.host}/chat/ws`;
    
    // 状态
    let ws = null;
    let isOpen = false;
    let hasNewMessage = false;
    let username = localStorage.getItem('AK_USER') ? JSON.parse(localStorage.getItem('AK_USER')).UserName : 'guest_' + Math.random().toString(36).substr(2, 6);
    let messageCount = 0;
    
    // 创建样式
    const style = document.createElement('style');
    style.textContent = `
        /* 聊天窗口 - 默认隐藏 */
        #ak-admin-chat {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 340px;
            max-height: 450px;
            background: linear-gradient(135deg, #0d1b2a 0%, #1b263b 100%);
            border-radius: 16px;
            box-shadow: 0 10px 40px rgba(0, 212, 255, 0.2);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            z-index: 99998;
            display: none;
            flex-direction: column;
            border: 1px solid rgba(0, 212, 255, 0.3);
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
        
        /* 头部 */
        #ak-admin-chat .chat-header {
            background: linear-gradient(135deg, #00d4ff 0%, #00a8cc 100%);
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
            background: #0d1b2a;
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
            background: linear-gradient(135deg, #00d4ff 0%, #00a8cc 100%);
            color: #0d1b2a;
            border-bottom-left-radius: 4px;
        }
        
        #ak-admin-chat .user .chat-bubble {
            background: #1b263b;
            color: #e0e0e0;
            border: 1px solid rgba(0, 212, 255, 0.2);
            border-bottom-right-radius: 4px;
        }
        
        #ak-admin-chat .chat-time {
            font-size: 11px;
            color: #5a7a9a;
            margin-top: 4px;
        }
        
        #ak-admin-chat .chat-label {
            font-size: 11px;
            color: #00d4ff;
            margin-bottom: 4px;
        }
        
        /* 输入区域 */
        #ak-admin-chat .chat-input-area {
            padding: 12px;
            background: #1b263b;
            border-top: 1px solid rgba(0, 212, 255, 0.1);
            display: flex;
            gap: 10px;
        }
        
        #ak-admin-chat .chat-input {
            flex: 1;
            padding: 10px 14px;
            border: 1px solid rgba(0, 212, 255, 0.3);
            border-radius: 20px;
            background: #0d1b2a;
            color: #e0e0e0;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
        }
        
        #ak-admin-chat .chat-input:focus {
            border-color: #00d4ff;
        }
        
        #ak-admin-chat .chat-input::placeholder {
            color: #5a7a9a;
        }
        
        #ak-admin-chat .chat-send {
            width: 40px;
            height: 40px;
            border: none;
            border-radius: 50%;
            background: linear-gradient(135deg, #00d4ff 0%, #00a8cc 100%);
            color: #0d1b2a;
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
    
    // 连接WebSocket
    function connect() {
        try {
            ws = new WebSocket(WS_URL + '?username=' + encodeURIComponent(username));
            
            ws.onopen = function() {
                console.log('[AKChat] Connected');
                // 发送上线消息注册用户
                ws.send(JSON.stringify({
                    type: 'online',
                    username: username,
                    page: window.location.pathname,
                    userAgent: navigator.userAgent
                }));
                // 定时发送心跳
                setInterval(function() {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'heartbeat' }));
                    }
                }, 30000);
            };
            
            ws.onmessage = function(e) {
                try {
                    const data = JSON.parse(e.data);
                    
                    if (data.type === 'admin_message') {
                        // 收到管理员消息 - 显示窗口
                        addMessage(data.content, true, data.time);
                        showChat();
                        playNotificationSound();
                    } else if (data.type === 'history') {
                        // 加载历史消息
                        if (data.messages && data.messages.length > 0) {
                            data.messages.forEach(function(msg) {
                                addMessage(msg.content, msg.is_admin, msg.time);
                            });
                            // 如果有历史消息，显示窗口
                            showChat();
                        }
                    }
                } catch(err) {}
            };
            
            ws.onclose = function() {
                console.log('[AKChat] Disconnected, reconnecting...');
                setTimeout(connect, 5000);
            };
            
            ws.onerror = function() {
                ws.close();
            };
        } catch(e) {
            setTimeout(connect, 5000);
        }
    }
    
    // 显示聊天窗口
    function showChat() {
        chatBox.classList.add('visible');
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
        if (!content || !ws || ws.readyState !== WebSocket.OPEN) return;
        
        ws.send(JSON.stringify({
            type: 'user_message',
            content: content
        }));
        
        addMessage(content, false);
        inputEl.value = '';
    }
    
    // 暴露全局API
    window.AKChat = {
        show: showChat,
        close: closeChat,
        send: sendMessage
    };
    
    // 页面加载完成后连接
    if (document.readyState === 'complete') {
        connect();
    } else {
        window.addEventListener('load', connect);
    }
    
})();
