(function() {
    'use strict';

    const CHAT_SHELL_STYLE_ID = 'ak-client-runtime-chat-shell-style';
    const CHAT_SHELL_STYLE_TEXT = `
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
            overflow-wrap: anywhere;
            white-space: pre-wrap;
            white-space: break-spaces;
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
            line-height: 1.45;
            min-height: 40px;
            max-height: 120px;
            resize: none;
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
        }`;
    const CHAT_SHELL_HTML = `
        <div id="ak-admin-chat">
            <div class="chat-header">
                <div class="chat-header-title">系统管理员传讯</div>
                <button class="chat-close" onclick="AKChat.close()">×</button>
            </div>
            <div class="chat-messages" id="ak-chat-messages"></div>
            <div class="chat-input-area">
                <textarea class="chat-input" id="ak-chat-input" rows="1" placeholder="输入回复..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();AKChat.send()}"></textarea>
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
        </div>`;

    function ensureShellStyle() {
        if (document.getElementById(CHAT_SHELL_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = CHAT_SHELL_STYLE_ID;
        style.textContent = CHAT_SHELL_STYLE_TEXT;
        document.head.appendChild(style);
    }

    function collectRefs() {
        return {
            chatBox: document.getElementById('ak-admin-chat'),
            messagesDiv: document.getElementById('ak-chat-messages'),
            inputEl: document.getElementById('ak-chat-input'),
            assistRequestOverlay: document.getElementById('ak-assist-request-overlay'),
            assistRequestTitle: document.getElementById('ak-assist-request-title'),
            assistRequestText: document.getElementById('ak-assist-request-text'),
            remoteVoiceBar: document.getElementById('ak-remote-voice-bar'),
            remoteVoicePulse: document.getElementById('ak-remote-voice-level'),
            remoteVoiceMuteBtn: document.getElementById('ak-remote-voice-mute-btn'),
            remoteVoiceAudio: document.getElementById('ak-remote-voice-audio')
        };
    }

    function mountShell() {
        ensureShellStyle();
        if (!document.getElementById('ak-admin-chat')) {
            const container = document.createElement('div');
            container.innerHTML = CHAT_SHELL_HTML;
            document.body.appendChild(container);
        }
        return collectRefs();
    }

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

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function normalizeChatTextContent(content) {
        return String(content == null ? '' : content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    function addMessage(messagesDiv, content, isAdmin, time) {
        if (!messagesDiv) return;
        const messageContent = normalizeChatTextContent(content);
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-message ' + (isAdmin ? 'admin' : 'user');
        const timeStr = time || new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
        msgDiv.innerHTML = `
            ${isAdmin ? '<div class="chat-label">管理员</div>' : ''}
            <div class="chat-bubble">${escapeHtml(messageContent)}</div>
            <div class="chat-time">${timeStr}</div>
        `;
        messagesDiv.appendChild(msgDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    window.AKClientRuntimeChatShell = window.AKClientRuntimeChatShell || {};
    window.AKClientRuntimeChatShell.mountShell = mountShell;
    window.AKClientRuntimeChatUI = window.AKClientRuntimeChatUI || {};
    window.AKClientRuntimeChatUI.playNotificationSound = playNotificationSound;
    window.AKClientRuntimeChatUI.escapeHtml = escapeHtml;
    window.AKClientRuntimeChatUI.addMessage = addMessage;
})();
