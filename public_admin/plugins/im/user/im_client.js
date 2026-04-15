(function() {
    'use strict';

    if (window.self !== window.top) return;
    if (window.AKIMClientLoaded) return;
    window.AKIMClientLoaded = true;

    const API_ROOT = window.location.origin;
    const HTTP_ROOT = `${API_ROOT}/im/api`;

    const state = {
        allowed: false,
        loading: false,
        ready: false,
        username: '',
        displayName: '',
        sessions: [],
        activeConversationId: 0,
        activeMessages: [],
        ws: null,
        open: false,
        view: 'sessions',
        inputValue: ''
    };

    let root = null;
    let panel = null;
    let sessionList = null;
    let messageList = null;
    let statusLine = null;
    let inputEl = null;
    let sendBtn = null;

    function getCookie(name) {
        try {
            const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
            return match ? decodeURIComponent(match[1]) : '';
        } catch (e) {
            return '';
        }
    }

    function pickUsernameFromObject(target) {
        if (!target || typeof target !== 'object') return '';
        const candidates = [
            target.UserName,
            target.username,
            target.Account,
            target.account,
            target.Name,
            target.name
        ];
        for (let i = 0; i < candidates.length; i++) {
            const value = String(candidates[i] || '').trim();
            if (value) return value.toLowerCase();
        }
        return '';
    }

    function getCanonicalUsername() {
        try {
            if (window.APP && APP.USER && APP.USER.MODEL) {
                const value = pickUsernameFromObject(APP.USER.MODEL);
                if (value) return value;
            }
        } catch (e) {}
        try {
            if (window.USER_MODEL) {
                const value = pickUsernameFromObject(window.USER_MODEL);
                if (value) return value;
            }
        } catch (e) {}
        try {
            const raw = localStorage.getItem('AK_user_model') || sessionStorage.getItem('AK_user_model');
            if (raw) {
                const value = pickUsernameFromObject(JSON.parse(raw));
                if (value) return value;
            }
        } catch (e) {}
        try {
            const userDataRaw = localStorage.getItem('UserData') || sessionStorage.getItem('UserData');
            if (userDataRaw) {
                const value = pickUsernameFromObject(JSON.parse(userDataRaw));
                if (value) return value;
            }
        } catch (e) {}
        try {
            const loginResultRaw = localStorage.getItem('ak_login_result') || sessionStorage.getItem('ak_login_result');
            if (loginResultRaw) {
                const parsed = JSON.parse(loginResultRaw);
                const value = pickUsernameFromObject(parsed && parsed.UserData && typeof parsed.UserData === 'object' ? parsed.UserData : null);
                if (value) return value;
            }
        } catch (e) {}
        return String(getCookie('ak_username') || '').trim().toLowerCase();
    }

    function buildRequestHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        const username = getCanonicalUsername();
        if (username) headers['X-AK-Username'] = username;
        return headers;
    }

    function buildWsUrl() {
        const baseUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/im/ws`;
        try {
            const finalUrl = new URL(baseUrl);
            const username = getCanonicalUsername();
            if (username) finalUrl.searchParams.set('username', username);
            return finalUrl.toString();
        } catch (e) {
            return baseUrl;
        }
    }

    function request(url, options) {
        return fetch(url, Object.assign({
            credentials: 'same-origin',
            headers: buildRequestHeaders()
        }, options || {})).then(function(resp) {
            return resp.json().then(function(data) {
                if (!resp.ok) {
                    throw new Error((data && data.message) || 'request_failed');
                }
                return data;
            });
        });
    }

    function ensureRoot() {
        if (root) return;
        root = document.createElement('div');
        root.id = 'ak-im-root';
        root.innerHTML = `
            <style>
                #ak-im-root{display:none;position:fixed;left:calc(50% + 46px);top:calc(env(safe-area-inset-top, 0px) - 10px);z-index:2147483642;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
                #ak-im-root.ak-visible{display:block}
                #ak-im-root .ak-im-launcher{width:56px;height:56px;border:none;border-radius:999px;background:transparent;color:rgba(52,63,84,.92);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;position:relative;transition:color .18s ease,transform .18s ease,filter .18s ease,opacity .18s ease}
                #ak-im-root .ak-im-launcher::before{content:'';position:absolute;inset:3px;border-radius:999px;background:radial-gradient(circle at 50% 40%,rgba(86,197,123,.18) 0%,rgba(86,197,123,.08) 56%,rgba(86,197,123,0) 100%);opacity:0;transition:opacity .18s ease,background .18s ease;pointer-events:none}
                #ak-im-root .ak-im-launcher svg{position:relative;z-index:1;width:30px;height:30px}
                #ak-im-root .ak-im-launcher:hover,#ak-im-root .ak-im-launcher.is-open{transform:translateY(-1px);color:#1f2937;filter:drop-shadow(0 0 10px rgba(86,197,123,.18))}
                #ak-im-root .ak-im-launcher:hover::before,#ak-im-root .ak-im-launcher.is-open::before{opacity:1}
                #ak-im-root .ak-im-launcher-badge{position:absolute;top:8px;right:8px;min-width:9px;width:9px;height:9px;border-radius:999px;background:linear-gradient(180deg,#ff4d5e 0%,#ef233c 100%);box-shadow:0 0 8px rgba(255,77,94,.28);display:none}
                #ak-im-root .ak-im-launcher.has-unread .ak-im-launcher-badge{display:block}
                #ak-im-root .ak-im-shell{display:none;position:fixed;inset:0;background:#ededed;overflow:hidden}
                #ak-im-root.ak-im-open .ak-im-shell{display:block}
                #ak-im-root.ak-im-open .ak-im-launcher{opacity:0;pointer-events:none;transform:scale(.96)}
                #ak-im-root .ak-im-screen{display:none;position:absolute;inset:0;flex-direction:column;min-height:0}
                #ak-im-root.ak-view-sessions .ak-im-session-screen{display:flex}
                #ak-im-root.ak-view-chat .ak-im-chat-screen{display:flex}
                #ak-im-root .ak-im-topbar{height:calc(56px + env(safe-area-inset-top, 0px));padding:calc(env(safe-area-inset-top, 0px) + 8px) 12px 8px;display:grid;grid-template-columns:52px 1fr 52px;align-items:center;background:#ededed;border-bottom:1px solid rgba(15,23,42,.06);box-sizing:border-box}
                #ak-im-root .ak-im-topbar-title,#ak-im-root .ak-im-topbar-title-wrap{text-align:center;min-width:0}
                #ak-im-root .ak-im-topbar-title{font-size:17px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-chat-title{font-size:17px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-chat-subtitle{margin-top:2px;font-size:11px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-nav-btn{height:34px;border:none;background:transparent;color:#111827;padding:0 8px;font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:10px}
                #ak-im-root .ak-im-nav-btn svg{width:20px;height:20px;stroke:currentColor}
                #ak-im-root .ak-im-nav-btn.ak-im-new{justify-self:end;font-size:15px;color:#1f2937}
                #ak-im-root .ak-im-session-page{flex:1;display:flex;flex-direction:column;min-height:0;background:#f7f7f7}
                #ak-im-root .ak-im-search-bar{padding:8px 12px;background:#ededed;border-bottom:1px solid rgba(15,23,42,.04)}
                #ak-im-root .ak-im-search-pill{height:36px;border-radius:12px;background:#ffffff;color:#6b7280;display:flex;align-items:center;justify-content:center;font-size:12px}
                #ak-im-root .ak-im-session-list{flex:1;overflow:auto;background:#ffffff}
                #ak-im-root .ak-im-session-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border:none;border-bottom:1px solid rgba(15,23,42,.05);background:#fff;cursor:pointer;position:relative}
                #ak-im-root .ak-im-session-item.ak-active{background:#f0fdf4}
                #ak-im-root .ak-im-session-avatar{width:48px;height:48px;border-radius:14px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-session-body{min-width:0;flex:1;display:grid;grid-template-columns:1fr auto;grid-template-areas:'name time' 'preview unread';align-items:center;column-gap:10px;row-gap:4px}
                #ak-im-root .ak-im-session-title{grid-area:name;font-size:16px;font-weight:500;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-session-time{grid-area:time;font-size:11px;color:#9ca3af;white-space:nowrap}
                #ak-im-root .ak-im-session-preview{grid-area:preview;font-size:13px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-session-unread{grid-area:unread;justify-self:end;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#ef4444;color:#fff;font-size:11px;display:none;align-items:center;justify-content:center}
                #ak-im-root .ak-im-session-unread.visible{display:inline-flex}
                #ak-im-root .ak-im-message-list{flex:1;overflow:auto;padding:14px 12px 10px;background:#ebebeb;display:flex;flex-direction:column;gap:14px}
                #ak-im-root .ak-im-empty{margin:auto;color:#94a3b8;font-size:13px;text-align:center;padding:28px 24px;line-height:1.6;white-space:pre-line}
                #ak-im-root .ak-im-time-divider{text-align:center;font-size:11px;color:#9ca3af;line-height:1.4}
                #ak-im-root .ak-im-message-row{display:flex;align-items:flex-start;gap:8px;max-width:100%}
                #ak-im-root .ak-im-message-row.ak-self{flex-direction:row-reverse}
                #ak-im-root .ak-im-avatar{width:34px;height:34px;border-radius:10px;background:#d1d5db;color:#374151;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-avatar{background:#7fd88a;color:#ffffff}
                #ak-im-root .ak-im-message-main{display:flex;flex-direction:column;max-width:min(78%, 420px)}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-message-main{align-items:flex-end}
                #ak-im-root .ak-im-bubble{padding:10px 12px;border-radius:8px;background:#ffffff;color:#111827;word-break:break-word;white-space:pre-wrap;box-shadow:0 1px 1px rgba(15,23,42,.04);font-size:15px;line-height:1.45}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-bubble{background:#95ec69}
                #ak-im-root .ak-im-meta{margin-top:4px;font-size:11px;color:#9ca3af;line-height:1.4}
                #ak-im-root .ak-im-composer{padding:8px 10px calc(8px + env(safe-area-inset-bottom, 0px));border-top:1px solid rgba(15,23,42,.06);display:flex;align-items:flex-end;gap:8px;background:#f7f7f7}
                #ak-im-root .ak-im-input-wrap{flex:1;min-height:36px;display:flex;align-items:flex-end;background:#ffffff;border-radius:8px;border:1px solid rgba(15,23,42,.08);padding:7px 10px}
                #ak-im-root .ak-im-input{width:100%;resize:none;border:none;outline:none;background:transparent;min-height:22px;max-height:120px;font-size:15px;line-height:1.45;color:#111827}
                #ak-im-root .ak-im-send{height:36px;border:none;border-radius:8px;padding:0 16px;background:#07c160;color:#ffffff;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .18s ease,transform .18s ease}
                #ak-im-root .ak-im-send:disabled{opacity:.42;cursor:not-allowed}
                #ak-im-root .ak-im-status{padding:0 12px calc(8px + env(safe-area-inset-bottom, 0px));background:#f7f7f7;font-size:11px;color:#9ca3af}
                @media (max-width: 640px){#ak-im-root{left:calc(50% + 42px);top:calc(env(safe-area-inset-top, 0px) - 10px)}#ak-im-root .ak-im-topbar{grid-template-columns:48px 1fr 56px}#ak-im-root .ak-im-session-avatar{width:44px;height:44px;border-radius:12px}#ak-im-root .ak-im-message-main{max-width:78%}}
            </style>
            <button class="ak-im-launcher" type="button" aria-label="内部聊天">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M5.4 6.3C5.4 4.92 6.52 3.8 7.9 3.8H13.25C14.63 3.8 15.75 4.92 15.75 6.3V10.95C15.75 12.33 14.63 13.45 13.25 13.45H9.85L6.95 15.72C6.66 15.95 6.23 15.74 6.23 15.37V13.45H5.4V6.3Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="9.35" cy="8.55" r="0.85" fill="currentColor"/>
                    <circle cx="12.05" cy="8.55" r="0.85" fill="currentColor"/>
                    <path d="M13.9 8.2H16.65C17.92 8.2 18.95 9.23 18.95 10.5V13.55C18.95 14.82 17.92 15.85 16.65 15.85H15.45V17.32C15.45 17.68 15.03 17.89 14.73 17.67L12.6 16.12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.72"/>
                </svg>
                <span class="ak-im-launcher-badge" aria-hidden="true"></span>
            </button>
            <div class="ak-im-shell">
                <div class="ak-im-screen ak-im-session-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-close" type="button" aria-label="关闭内部聊天">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title">内部聊天</div>
                        <button class="ak-im-nav-btn ak-im-new" type="button" data-im-action="new">发起</button>
                    </div>
                    <div class="ak-im-session-page">
                        <div class="ak-im-search-bar"><div class="ak-im-search-pill">仅白名单账号可用</div></div>
                        <div class="ak-im-session-list"></div>
                    </div>
                </div>
                <div class="ak-im-screen ak-im-chat-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-back" type="button" aria-label="返回会话列表">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title-wrap"><div class="ak-im-chat-title">内部聊天</div><div class="ak-im-chat-subtitle">白名单账号单聊</div></div>
                        <button class="ak-im-nav-btn ak-im-chat-close" type="button" aria-label="关闭内部聊天">关闭</button>
                    </div>
                    <div class="ak-im-message-list"></div>
                    <div class="ak-im-composer"><div class="ak-im-input-wrap"><textarea class="ak-im-input" placeholder="输入消息"></textarea></div><button class="ak-im-send" type="button">发送</button></div>
                    <div class="ak-im-status"></div>
                </div>
            </div>
        `;
        document.body.appendChild(root);
        panel = root.querySelector('.ak-im-shell');
        sessionList = root.querySelector('.ak-im-session-list');
        messageList = root.querySelector('.ak-im-message-list');
        statusLine = root.querySelector('.ak-im-status');
        inputEl = root.querySelector('.ak-im-input');
        sendBtn = root.querySelector('.ak-im-send');
        root.querySelector('.ak-im-launcher').addEventListener('click', function() {
            state.open = true;
            if (!state.activeConversationId) state.view = 'sessions';
            render();
        });
        root.querySelector('.ak-im-close').addEventListener('click', function() {
            state.open = false;
            state.view = 'sessions';
            render();
        });
        root.querySelector('.ak-im-back').addEventListener('click', function() {
            state.view = 'sessions';
            render();
        });
        root.querySelector('.ak-im-chat-close').addEventListener('click', function() {
            state.open = false;
            state.view = 'sessions';
            render();
        });
        root.querySelector('[data-im-action="new"]').addEventListener('click', startDirectSession);
        sendBtn.addEventListener('click', sendCurrentMessage);
        inputEl.addEventListener('input', function() {
            state.inputValue = inputEl.value || '';
            syncInputHeight();
            syncComposerState();
        });
        inputEl.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendCurrentMessage();
            }
        });
        syncInputHeight();
        syncComposerState();
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, function(char) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char;
        });
    }

    function formatTime(value) {
        if (!value) return '';
        try {
            return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            return '';
        }
    }

    function formatSessionTime(value) {
        if (!value) return '';
        try {
            const date = new Date(value);
            if (isNaN(date.getTime())) return '';
            const now = new Date();
            if (date.toDateString() === now.toDateString()) {
                return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            }
            return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
        } catch (e) {
            return '';
        }
    }

    function getActiveSession() {
        return state.sessions.find(function(item) {
            return Number(item && item.conversation_id || 0) === Number(state.activeConversationId || 0);
        }) || null;
    }

    function getSessionDisplayName(item) {
        return String(item && (item.peer_display_name || item.peer_username || '内部聊天') || '内部聊天').trim();
    }

    function getSessionPreview(item) {
        return String(item && item.last_message_preview || '').trim() || '暂无消息';
    }

    function getAvatarText(value) {
        const raw = String(value || '').replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, '').trim();
        if (!raw) return '聊';
        return raw.slice(0, 2).toUpperCase();
    }

    function getUnreadCount(item) {
        return Number(item && (item.unread_count || item.unread || 0) || 0);
    }

    function syncInputHeight() {
        if (!inputEl) return;
        inputEl.style.height = '22px';
        const nextHeight = Math.min(Math.max(inputEl.scrollHeight, 22), 120);
        inputEl.style.height = `${nextHeight}px`;
    }

    function syncComposerState() {
        if (!inputEl || !sendBtn) return;
        const canSend = !!state.activeConversationId;
        inputEl.disabled = !canSend;
        inputEl.placeholder = canSend ? '输入消息' : '先选择一个会话';
        sendBtn.disabled = !canSend || !String(inputEl.value || '').trim();
    }

    function render() {
        if (!root) return;
        const activeSession = getActiveSession();
        const showChat = !!activeSession && state.view === 'chat';
        root.classList.toggle('ak-visible', !!state.allowed);
        root.classList.toggle('ak-im-open', !!state.open);
        root.classList.toggle('ak-view-sessions', !showChat);
        root.classList.toggle('ak-view-chat', !!showChat);
        root.querySelector('.ak-im-launcher').classList.toggle('is-open', !!state.open);
        root.querySelector('.ak-im-launcher').classList.toggle('has-unread', state.sessions.some(function(item) {
            return getUnreadCount(item) > 0;
        }));
        statusLine.textContent = state.allowed ? ('当前账号：' + state.username) : '聊天功能未开放';
        sessionList.innerHTML = '';
        if (!state.sessions.length) {
            const empty = document.createElement('div');
            empty.className = 'ak-im-empty';
            empty.textContent = state.allowed ? '暂无会话\n点击右上角“发起”开始单聊' : '当前账号未开通聊天';
            sessionList.appendChild(empty);
        } else {
            state.sessions.forEach(function(item) {
                const node = document.createElement('div');
                node.className = 'ak-im-session-item' + (item.conversation_id === state.activeConversationId ? ' ak-active' : '');
                const unreadCount = getUnreadCount(item);
                node.innerHTML = '<div class="ak-im-session-avatar">' + escapeHtml(getAvatarText(getSessionDisplayName(item))) + '</div>' +
                    '<div class="ak-im-session-body">' +
                        '<div class="ak-im-session-title">' + escapeHtml(getSessionDisplayName(item)) + '</div>' +
                        '<div class="ak-im-session-time">' + escapeHtml(formatSessionTime(item.last_message_at || item.updated_at || item.created_at)) + '</div>' +
                        '<div class="ak-im-session-preview">' + escapeHtml(getSessionPreview(item)) + '</div>' +
                        '<div class="ak-im-session-unread' + (unreadCount > 0 ? ' visible' : '') + '">' + escapeHtml(unreadCount > 99 ? '99+' : String(unreadCount || '')) + '</div>' +
                    '</div>';
                node.addEventListener('click', function() {
                    state.activeConversationId = item.conversation_id;
                    state.view = 'chat';
                    state.activeMessages = [];
                    loadMessages(item.conversation_id);
                    render();
                });
                sessionList.appendChild(node);
            });
        }
        syncComposerState();
        syncInputHeight();
        renderMessages();
    }

    function renderMessages() {
        const headerTitle = root.querySelector('.ak-im-chat-title');
        const headerSubtitle = root.querySelector('.ak-im-chat-subtitle');
        const activeSession = getActiveSession();
        headerTitle.textContent = activeSession ? getSessionDisplayName(activeSession) : '内部聊天';
        headerSubtitle.textContent = activeSession ? ('账号：' + (activeSession.peer_username || getSessionDisplayName(activeSession))) : '选择一个会话开始单聊';
        messageList.innerHTML = '';
        if (!state.activeConversationId) {
            const empty = document.createElement('div');
            empty.className = 'ak-im-empty';
            empty.textContent = state.allowed ? '选择一个会话\n开始内部单聊' : '当前账号未开通聊天';
            messageList.appendChild(empty);
            return;
        }
        if (!state.activeMessages.length) {
            const empty = document.createElement('div');
            empty.className = 'ak-im-empty';
            empty.textContent = '还没有消息\n发一条试试';
            messageList.appendChild(empty);
            return;
        }
        state.activeMessages.forEach(function(item) {
            const isSelf = item.sender_username === state.username;
            const wrapper = document.createElement('div');
            const displayName = isSelf ? (state.displayName || state.username || '我') : (activeSession ? getSessionDisplayName(activeSession) : (item.sender_username || '对方'));
            wrapper.innerHTML = '<div class="ak-im-time-divider">' + escapeHtml(formatTime(item.sent_at)) + '</div>' +
                '<div class="ak-im-message-row ' + (isSelf ? 'ak-self' : 'ak-peer') + '">' +
                    '<div class="ak-im-avatar">' + escapeHtml(getAvatarText(displayName)) + '</div>' +
                    '<div class="ak-im-message-main">' +
                        '<div class="ak-im-bubble">' + escapeHtml(item.content || item.content_preview || '') + '</div>' +
                        '<div class="ak-im-meta">' + escapeHtml(isSelf ? (item.read ? '已读' : '未读') : displayName) + '</div>' +
                    '</div>' +
                '</div>';
            messageList.appendChild(wrapper);
        });
        messageList.scrollTop = messageList.scrollHeight;
    }

    function loadBootstrap() {
        return request(`${HTTP_ROOT}/bootstrap`).then(function(data) {
            state.allowed = !!(data && data.allowed);
            state.ready = true;
            state.username = String((data && data.username) || '').trim();
            state.displayName = String((data && data.display_name) || state.username || '').trim();
            if (!state.allowed) {
                render();
                return null;
            }
            ensureWebSocket();
            return loadSessions();
        }).catch(function() {
            state.allowed = false;
            state.ready = true;
            render();
            return null;
        });
    }

    function loadSessions() {
        return request(`${HTTP_ROOT}/sessions`).then(function(data) {
            state.sessions = Array.isArray(data && data.items) ? data.items : [];
            if (!state.activeConversationId && state.sessions.length) {
                state.activeConversationId = state.sessions[0].conversation_id;
                return loadMessages(state.activeConversationId);
            }
            render();
            return null;
        }).catch(function() {
            render();
            return null;
        });
    }

    function loadMessages(conversationId) {
        return request(`${HTTP_ROOT}/messages?conversation_id=${encodeURIComponent(conversationId)}`).then(function(data) {
            state.activeMessages = Array.isArray(data && data.items) ? data.items : [];
            render();
            markRead();
            return null;
        }).catch(function() {
            render();
            return null;
        });
    }

    function startDirectSession() {
        if (!state.allowed) return;
        const target = window.prompt('请输入要发起聊天的白名单账号 username');
        if (!target) return;
        request(`${HTTP_ROOT}/sessions/direct`, {
            method: 'POST',
            body: JSON.stringify({ target_username: String(target || '').trim() })
        }).then(function(data) {
            state.activeConversationId = Number((data && data.conversation_id) || 0);
            state.view = 'chat';
            state.activeMessages = [];
            return loadSessions().then(function() {
                return loadMessages(state.activeConversationId);
            });
        }).catch(function(error) {
            window.alert(error && error.message ? error.message : '发起会话失败');
        });
    }

    function sendCurrentMessage() {
        if (!state.allowed || !state.activeConversationId) return;
        const content = String((inputEl && inputEl.value) || '').trim();
        if (!content) return;
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'im.message.send',
                payload: {
                    conversation_id: state.activeConversationId,
                    content: content
                }
            }));
            inputEl.value = '';
            state.inputValue = '';
            syncInputHeight();
            syncComposerState();
            return;
        }
        request(`${HTTP_ROOT}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                conversation_id: state.activeConversationId,
                content: content
            })
        }).then(function() {
            inputEl.value = '';
            state.inputValue = '';
            syncInputHeight();
            syncComposerState();
            return loadMessages(state.activeConversationId).then(loadSessions);
        }).catch(function(error) {
            window.alert(error && error.message ? error.message : '发送失败');
        });
    }

    function markRead() {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        if (!state.activeConversationId || !state.activeMessages.length) return;
        const last = state.activeMessages[state.activeMessages.length - 1];
        if (!last || !last.seq_no) return;
        state.ws.send(JSON.stringify({
            type: 'im.message.read',
            payload: {
                conversation_id: state.activeConversationId,
                seq_no: last.seq_no
            }
        }));
    }

    function ensureWebSocket() {
        if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
        try {
            state.ws = new WebSocket(buildWsUrl());
            state.ws.addEventListener('message', function(event) {
                try {
                    const data = JSON.parse(event.data || '{}');
                    if (data.type === 'im.message.created') {
                        const item = data.payload || null;
                        if (!item || !item.conversation_id) return;
                        if (Number(item.conversation_id) === Number(state.activeConversationId)) {
                            state.activeMessages.push(item);
                            renderMessages();
                            if (item.sender_username !== state.username) markRead();
                        }
                        loadSessions();
                        return;
                    }
                    if (data.type === 'im.message.read') {
                        loadMessages(state.activeConversationId);
                    }
                } catch (e) {}
            });
            state.ws.addEventListener('close', function() {
                state.ws = null;
                setTimeout(function() {
                    if (state.allowed) ensureWebSocket();
                }, 1500);
            });
        } catch (e) {}
    }

    function init() {
        ensureRoot();
        render();
        loadBootstrap();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.AKIMClient = {
        open: function() { state.open = true; if (!state.activeConversationId) state.view = 'sessions'; render(); },
        close: function() { state.open = false; state.view = 'sessions'; render(); },
        reloadSessions: loadSessions
    };
})();
