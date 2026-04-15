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
                #ak-im-root{display:none;position:fixed;right:18px;bottom:88px;z-index:2147483641;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
                #ak-im-root .ak-im-launcher{width:52px;height:52px;border:none;border-radius:50%;background:#2563eb;color:#fff;box-shadow:0 8px 26px rgba(37,99,235,.28);cursor:pointer;font-size:14px;font-weight:700}
                #ak-im-root .ak-im-panel{display:none;width:min(360px,calc(100vw - 20px));height:min(520px,calc(100vh - 120px));background:#fff;border-radius:16px;box-shadow:0 14px 48px rgba(15,23,42,.22);overflow:hidden;border:1px solid rgba(15,23,42,.08)}
                #ak-im-root.ak-im-open .ak-im-panel{display:grid;grid-template-columns:132px 1fr}
                #ak-im-root.ak-im-open .ak-im-launcher{display:none}
                #ak-im-root .ak-im-sidebar{background:#f8fafc;border-right:1px solid rgba(15,23,42,.08);display:flex;flex-direction:column;min-height:0}
                #ak-im-root .ak-im-header{padding:12px 12px 8px;font-size:13px;font-weight:700;color:#0f172a;display:flex;align-items:center;justify-content:space-between;gap:8px}
                #ak-im-root .ak-im-header button{border:none;background:#e2e8f0;color:#0f172a;border-radius:8px;padding:6px 8px;cursor:pointer;font-size:12px}
                #ak-im-root .ak-im-session-list{flex:1;overflow:auto;padding:0 8px 8px}
                #ak-im-root .ak-im-session-item{padding:10px 8px;border-radius:10px;cursor:pointer;margin-top:4px;background:transparent}
                #ak-im-root .ak-im-session-item.ak-active{background:#dbeafe}
                #ak-im-root .ak-im-session-title{font-size:12px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-session-preview{font-size:11px;color:#64748b;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-main{display:flex;flex-direction:column;min-width:0;min-height:0}
                #ak-im-root .ak-im-main-header{padding:12px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:8px}
                #ak-im-root .ak-im-main-title{font-size:14px;font-weight:700;color:#0f172a}
                #ak-im-root .ak-im-main-subtitle{font-size:12px;color:#64748b;margin-top:2px}
                #ak-im-root .ak-im-close{border:none;background:#e2e8f0;color:#0f172a;border-radius:8px;padding:6px 10px;cursor:pointer}
                #ak-im-root .ak-im-message-list{flex:1;overflow:auto;padding:12px;background:#f8fafc;display:flex;flex-direction:column;gap:8px}
                #ak-im-root .ak-im-empty{margin:auto;color:#94a3b8;font-size:13px;text-align:center;padding:20px}
                #ak-im-root .ak-im-row{display:flex;flex-direction:column;max-width:82%}
                #ak-im-root .ak-im-row.ak-self{align-self:flex-end;align-items:flex-end}
                #ak-im-root .ak-im-row.ak-peer{align-self:flex-start;align-items:flex-start}
                #ak-im-root .ak-im-bubble{padding:10px 12px;border-radius:12px;background:#fff;color:#0f172a;box-shadow:0 1px 2px rgba(15,23,42,.06);word-break:break-word;white-space:pre-wrap}
                #ak-im-root .ak-im-row.ak-self .ak-im-bubble{background:#2563eb;color:#fff}
                #ak-im-root .ak-im-meta{font-size:11px;color:#94a3b8;margin-top:4px}
                #ak-im-root .ak-im-composer{padding:10px;border-top:1px solid rgba(15,23,42,.08);display:flex;gap:8px;background:#fff}
                #ak-im-root .ak-im-composer textarea{flex:1;resize:none;border:1px solid rgba(15,23,42,.12);border-radius:10px;padding:10px;min-height:44px;max-height:120px;outline:none}
                #ak-im-root .ak-im-composer button{border:none;background:#2563eb;color:#fff;border-radius:10px;padding:0 14px;cursor:pointer;font-weight:700}
                #ak-im-root .ak-im-status{padding:0 12px 10px;font-size:11px;color:#64748b;background:#fff}
                @media (max-width: 640px){#ak-im-root{right:10px;bottom:82px}#ak-im-root.ak-im-open .ak-im-panel{width:calc(100vw - 20px);height:min(72vh,560px);grid-template-columns:118px 1fr}}
            </style>
            <button class="ak-im-launcher" type="button">IM</button>
            <div class="ak-im-panel">
                <div class="ak-im-sidebar">
                    <div class="ak-im-header"><span>聊天</span><button type="button" data-im-action="new">发起</button></div>
                    <div class="ak-im-session-list"></div>
                </div>
                <div class="ak-im-main">
                    <div class="ak-im-main-header">
                        <div><div class="ak-im-main-title">内部聊天</div><div class="ak-im-main-subtitle">仅白名单账号可用</div></div>
                        <button class="ak-im-close" type="button">关闭</button>
                    </div>
                    <div class="ak-im-message-list"></div>
                    <div class="ak-im-composer"><textarea placeholder="输入消息"></textarea><button type="button">发送</button></div>
                    <div class="ak-im-status"></div>
                </div>
            </div>
        `;
        document.body.appendChild(root);
        panel = root.querySelector('.ak-im-panel');
        sessionList = root.querySelector('.ak-im-session-list');
        messageList = root.querySelector('.ak-im-message-list');
        statusLine = root.querySelector('.ak-im-status');
        inputEl = root.querySelector('textarea');
        sendBtn = root.querySelector('.ak-im-composer button');
        root.querySelector('.ak-im-launcher').addEventListener('click', function() {
            state.open = true;
            render();
        });
        root.querySelector('.ak-im-close').addEventListener('click', function() {
            state.open = false;
            render();
        });
        root.querySelector('[data-im-action="new"]').addEventListener('click', startDirectSession);
        sendBtn.addEventListener('click', sendCurrentMessage);
        inputEl.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendCurrentMessage();
            }
        });
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

    function render() {
        if (!root) return;
        root.style.display = state.allowed ? '' : 'none';
        root.classList.toggle('ak-im-open', !!state.open);
        statusLine.textContent = state.allowed ? ('当前账号：' + state.username) : '聊天功能未开放';
        sessionList.innerHTML = '';
        if (!state.sessions.length) {
            const empty = document.createElement('div');
            empty.className = 'ak-im-empty';
            empty.textContent = state.allowed ? '暂无会话，点击“发起”开始单聊' : '当前账号未开通聊天';
            sessionList.appendChild(empty);
        } else {
            state.sessions.forEach(function(item) {
                const node = document.createElement('div');
                node.className = 'ak-im-session-item' + (item.conversation_id === state.activeConversationId ? ' ak-active' : '');
                node.innerHTML = '<div class="ak-im-session-title">' + escapeHtml(item.peer_display_name || item.peer_username || '会话') + '</div>' +
                    '<div class="ak-im-session-preview">' + escapeHtml(item.last_message_preview || '暂无消息') + '</div>';
                node.addEventListener('click', function() {
                    state.activeConversationId = item.conversation_id;
                    loadMessages(item.conversation_id);
                    render();
                });
                sessionList.appendChild(node);
            });
        }
        renderMessages();
    }

    function renderMessages() {
        const headerTitle = root.querySelector('.ak-im-main-title');
        const headerSubtitle = root.querySelector('.ak-im-main-subtitle');
        const activeSession = state.sessions.find(function(item) { return item.conversation_id === state.activeConversationId; }) || null;
        headerTitle.textContent = activeSession ? (activeSession.peer_display_name || activeSession.peer_username || '会话') : '内部聊天';
        headerSubtitle.textContent = activeSession ? '白名单账号单聊' : '仅白名单账号可用';
        messageList.innerHTML = '';
        if (!state.activeConversationId) {
            const empty = document.createElement('div');
            empty.className = 'ak-im-empty';
            empty.textContent = state.allowed ? '选择左侧会话或点击“发起”' : '当前账号未开通聊天';
            messageList.appendChild(empty);
            return;
        }
        if (!state.activeMessages.length) {
            const empty = document.createElement('div');
            empty.className = 'ak-im-empty';
            empty.textContent = '还没有消息';
            messageList.appendChild(empty);
            return;
        }
        state.activeMessages.forEach(function(item) {
            const row = document.createElement('div');
            const isSelf = item.sender_username === state.username;
            row.className = 'ak-im-row ' + (isSelf ? 'ak-self' : 'ak-peer');
            row.innerHTML = '<div class="ak-im-bubble">' + escapeHtml(item.content || item.content_preview || '') + '</div>' +
                '<div class="ak-im-meta">' + escapeHtml(formatTime(item.sent_at)) + (isSelf ? (item.read ? ' · 已读' : ' · 未读') : '') + '</div>';
            messageList.appendChild(row);
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
            return loadSessions();
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
        open: function() { state.open = true; render(); },
        close: function() { state.open = false; render(); },
        reloadSessions: loadSessions
    };
})();
