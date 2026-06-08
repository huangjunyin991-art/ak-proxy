(function() {
    'use strict';

    if (window.AKRemoteAssistPanelLoaded && window.AKRemoteAssistPanel) return;
    window.AKRemoteAssistPanelLoaded = true;

    // Remote assist / AK browser panel module. Loaded only when one of its actions is used.

        // ===== AK 网页浏览面板 =====
        let akBrowserLoadSeq = 0;
        let akBrowserRetryTimer = null;
        let akBrowserMode = 'browser';
        let akAssistSessionId = '';

        function getAkBrowserMode() {
            return akBrowserMode === 'assist' ? 'assist' : 'browser';
        }

        function setAkBrowserMode(mode = 'browser', assistSessionId = '') {
            akBrowserMode = mode === 'assist' ? 'assist' : 'browser';
            akAssistSessionId = akBrowserMode === 'assist' ? String(assistSessionId || '').trim() : '';
            const badge = document.getElementById('akAssistModeBadge');
            if (badge) {
                badge.style.display = akBrowserMode === 'assist' ? 'inline-flex' : 'none';
            }
        }

        async function fetchWsTicket(audience, payload) {
            const response = await fetch(`${API_BASE}/admin/api/ws-ticket`, {
                method: 'POST',
                headers: {
                    ...getHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(Object.assign({}, payload || {}, {
                    audience: String(audience || '').trim().toLowerCase()
                }))
            });
            let data = null;
            try { data = await response.json(); } catch (e) {}
            if (!response.ok || !data || !data.ticket) {
                throw new Error(data && data.message ? data.message : `WebSocket ticket failed: ${response.status}`);
            }
            return data;
        }

        function buildTicketedWsUrl(path, ticket) {
            const url = new URL(path, window.location.origin);
            url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            url.search = '';
            url.searchParams.set('ticket', String(ticket || ''));
            return url.toString();
        }

        function formatAkBrowserTitle(username, mode = getAkBrowserMode()) {
            const name = String(username || '').trim();
            if (mode === 'assist') {
                return name ? `${name} 的远程指导` : '远程指导';
            }
            return name ? `${name} 的后台` : 'AK 后台';
        }

        function formatAkBrowserLoadingText(username, mode = getAkBrowserMode()) {
            const name = String(username || '').trim();
            if (mode === 'assist') {
                return name ? `正在进入 ${name} 的远程指导` : '正在进入远程指导';
            }
            return name ? `正在进入 ${name} 的后台` : '正在进入后台';
        }

        function setAkBrowserTitle(username, mode = getAkBrowserMode()) {
            const title = document.getElementById('akBrowserTitle');
            if (!title) return;
            const name = String(username || '').trim();
            title.dataset.username = name;
            title.dataset.mode = mode;
            title.textContent = formatAkBrowserTitle(name, mode);
        }

        function getAkBrowserCurrentUsername() {
            const title = document.getElementById('akBrowserTitle');
            return title ? (title.dataset.username || '') : '';
        }

        function setAkBrowserLoading(visible, username = '', mode = getAkBrowserMode()) {
            const loading = document.getElementById('akBrowserLoading');
            const loadingText = document.getElementById('akBrowserLoadingText');
            const frame = document.getElementById('akBrowserFrame');
            loading.style.display = visible ? 'flex' : 'none';
            loadingText.textContent = formatAkBrowserLoadingText(username || getAkBrowserCurrentUsername(), mode);
            frame.style.visibility = visible ? 'hidden' : 'visible';
        }

        let akBrowserSwipeCleanup = null;

        function clearAkBrowserSwipeBinding() {
            if (typeof akBrowserSwipeCleanup === 'function') {
                akBrowserSwipeCleanup();
            }
            akBrowserSwipeCleanup = null;
        }

        function bindAkBrowserSwipeClose(seq) {
            const frame = document.getElementById('akBrowserFrame');
            if (!frame || !frame.contentWindow) return;
            clearAkBrowserSwipeBinding();
            let startX = 0;
            let startY = 0;
            let tracking = false;
            const onTouchStart = (event) => {
                const touch = event.touches && event.touches[0];
                if (!touch) return;
                startX = touch.clientX;
                startY = touch.clientY;
                tracking = true;
            };
            const onTouchEnd = (event) => {
                if (!tracking || seq !== akBrowserLoadSeq) return;
                const touch = event.changedTouches && event.changedTouches[0];
                tracking = false;
                if (!touch) return;
                const deltaX = touch.clientX - startX;
                const deltaY = touch.clientY - startY;
                if (deltaX <= -72 && Math.abs(deltaX) >= Math.abs(deltaY) * 1.35) {
                    closeAkBrowser();
                }
            };
            const onTouchCancel = () => {
                tracking = false;
            };
            frame.contentWindow.addEventListener('touchstart', onTouchStart, { passive: true });
            frame.contentWindow.addEventListener('touchend', onTouchEnd, { passive: true });
            frame.contentWindow.addEventListener('touchcancel', onTouchCancel, { passive: true });
            akBrowserSwipeCleanup = () => {
                try {
                    frame.contentWindow.removeEventListener('touchstart', onTouchStart, { passive: true });
                    frame.contentWindow.removeEventListener('touchend', onTouchEnd, { passive: true });
                    frame.contentWindow.removeEventListener('touchcancel', onTouchCancel, { passive: true });
                } catch (e) {
                }
            };
        }

        function bindAkBrowserFrame(username, seq) {
            const frame = document.getElementById('akBrowserFrame');
            frame.onload = () => {
                if (seq !== akBrowserLoadSeq) return;
                if (akBrowserRetryTimer) {
                    clearTimeout(akBrowserRetryTimer);
                    akBrowserRetryTimer = null;
                }
                try {
                    bindAkBrowserSwipeClose(seq);
                    const href = frame.contentWindow.location.href || '';
                    const path = new URL(href, window.location.origin).pathname;
                    if (path.includes('/pages/account/login.html')) {
                        setAkBrowserTitle(username);
                        setAkBrowserLoading(true, username);
                        return;
                    }
                } catch (e) {
                }
                setAkBrowserTitle(username, getAkBrowserMode());
                setAkBrowserLoading(false, username, getAkBrowserMode());
            };
        }

        async function releaseAkAssistSession(sessionId = akAssistSessionId) {
            const activeSessionId = String(sessionId || '').trim();
            if (!activeSessionId) return;
            try {
                await fetch(`${API_BASE}/admin/api/remote_assist/close`, {
                    method: 'POST',
                    headers: {
                        ...getHeaders(),
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ session_id: activeSessionId })
                });
            } catch (e) {
            }
            if (activeSessionId === akAssistSessionId) {
                setAkBrowserMode('browser');
            }
        }

        async function openAkBrowser(username) {
            await closeRemoteAssistPanel();
            await releaseAkAssistSession();
            // 先发 browse_login 触发全局 fetch 拦截器的 TOTP 验证（如有需要），
            // 验证通过且 success=true 才真正打开面板，避免出现空白等待页。
            let data;
            try {
                const res = await fetch(`${API_BASE}/admin/api/browse_login`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({username})
                });
                data = await res.json();
            } catch (e) {
                if (typeof showToast === 'function') {
                    showToast(`打开后台失败: ${e.message}`, 'error');
                }
                return;
            }
            if (!data || !data.success) {
                const msg = (data && (data.message || data.detail)) || '该操作需要 Google 验证码授权';
                if (typeof showToast === 'function') {
                    showToast(`打开后台失败: ${msg}`, 'error');
                }
                return;
            }
            // 验证通过 → 真正打开 AK 浏览器面板
            setAkBrowserMode('browser');
            const panel = document.getElementById('akBrowserPanel');
            const overlay = document.getElementById('akBrowserOverlay');
            const frame = document.getElementById('akBrowserFrame');
            const seq = ++akBrowserLoadSeq;
            if (akBrowserRetryTimer) {
                clearTimeout(akBrowserRetryTimer);
                akBrowserRetryTimer = null;
            }
            clearAkBrowserSwipeBinding();
            setAkBrowserTitle(username, 'browser');
            setAkBrowserLoading(true, username, 'browser');
            frame.onload = null;
            frame.src = 'about:blank';
            panel.classList.add('open');
            overlay.style.display = getMobileLayoutMedia().matches ? 'none' : 'block';
            syncAkBrowserViewport();
            try {
                if ('serviceWorker' in navigator) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map(r => r.unregister()));
                }
                bindAkBrowserFrame(username, seq);
                const entryUrl = `${API_BASE}/admin/ak-web/pages/account/login.html`;
                frame.src = entryUrl;
            } catch (e) {
                setAkBrowserLoading(false);
                document.getElementById('akBrowserTitle').textContent = `登录失败: ${e.message}`;
            }
        }

        let remoteAssistPanelSessionId = '';
        let remoteAssistPanelUsername = '';
        let remoteAssistPanelWs = null;
        let remoteAssistPanelReconnectTimer = null;
        let remoteAssistPanelHeartbeatTimer = null;
        let remoteAssistVoiceSessionId = '';
        let remoteAssistVoiceStatus = '';
        let remoteAssistVoiceStatePollTimer = null;
        let remoteAssistVoiceLibraryPromise = null;
        let remoteAssistVoiceClient = null;
        let remoteAssistVoiceMutedSelf = false;
        let remoteAssistVoiceMutedPeer = false;
        let remoteAssistVoiceLocalLevel = 0;
        let remoteAssistVoiceRemoteLevel = 0;
        let remoteAssistVoiceConnectedRoles = [];
        let remoteAssistPanelLastSnapshot = null;
        let remoteAssistPanelLastHtml = '';
        let remoteAssistPanelLastScroll = null;
        let remoteAssistPanelApplyingScrollDepth = 0;
        let remoteAssistPanelRestoreScrollTimer = null;
        let remoteAssistPanelRouteSnapshotTimer = null;
        let remoteAssistPanelConsentStatus = 'waiting';
        let remoteAssistVoiceSnapshotRequestAt = 0;
        let remoteAssistVoiceSnapshotRequestKey = '';
        let remoteAssistPanelPendingRoute = '';
        let remoteAssistPanelPendingRouteRequestAt = 0;
        let remoteAssistPanelPendingRouteRequestKey = '';
        let remoteAssistPanelWaitingForRouteSnapshot = false;
        let remoteAssistPanelRenderSeq = 0;
        let remoteAssistPanelLoadedRenderSeq = 0;
        let remoteAssistPanelReadyRenderSeq = 0;
        let remoteAssistPanelRenderingSnapshot = false;
        let remoteAssistPanelQueuedSnapshot = null;
        let remoteAssistPanelSnapshotDrainTimer = null;
        let remoteAssistPanelFrameBindingCleanup = null;
        let remoteAssistPanelRenderReadyTimer = null;
        let remoteAssistPanelLastViewportSyncDebugKey = '';
        let remoteAssistPanelProxySnapshotRequestAt = 0;
        let remoteAssistPanelProxySnapshotRequestKey = '';
        let remoteAssistPanelProxySnapshotTimer = null;
        let remoteAssistPanelSnapshotRequestSeq = 0;
        let remoteAssistOpenSeq = 0;
        let remoteAssistOpenPromise = null;
        let remoteAssistOpeningUsername = '';
        const REMOTE_ASSIST_PREPARE_LOG_THRESHOLD_MS = 80;
        const REMOTE_ASSIST_RENDER_LOG_THRESHOLD_MS = 200;
        const REMOTE_ASSIST_PENDING_ROUTE_REQUEST_RETRY_MS = 1000;
        const REMOTE_ASSIST_PROXY_EVENT_SNAPSHOT_MIN_INTERVAL_MS = 600;
        const REMOTE_ASSIST_PROXY_EVENT_SNAPSHOT_DELAY_MS = 120;

        function isRemoteAssistSocketReady() {
            return !!(remoteAssistPanelWs
                && (remoteAssistPanelWs.readyState === WebSocket.OPEN || remoteAssistPanelWs.readyState === WebSocket.CONNECTING));
        }

        function showRemoteAssistPanelShell() {
            const panel = document.getElementById('remoteAssistPanel');
            const overlay = document.getElementById('remoteAssistOverlay');
            if (panel) panel.classList.add('open');
            if (overlay) overlay.style.display = getMobileLayoutMedia().matches ? 'none' : 'block';
        }

        function focusExistingRemoteAssist(targetUsername) {
            if (!remoteAssistPanelSessionId) return false;
            if (String(remoteAssistPanelUsername || '').trim() !== String(targetUsername || '').trim()) return false;
            showRemoteAssistPanelShell();
            updateRemoteAssistVoiceButton();
            if (!isRemoteAssistSocketReady()) {
                reconnectRemoteAssistPanel();
            }
            return true;
        }

        function clearRemoteAssistReconnectTimer() {
            if (remoteAssistPanelReconnectTimer) {
                clearTimeout(remoteAssistPanelReconnectTimer);
                remoteAssistPanelReconnectTimer = null;
            }
        }

        function stopRemoteAssistHeartbeat() {
            if (remoteAssistPanelHeartbeatTimer) {
                clearInterval(remoteAssistPanelHeartbeatTimer);
                remoteAssistPanelHeartbeatTimer = null;
            }
        }

        function startRemoteAssistHeartbeat() {
            stopRemoteAssistHeartbeat();
            if (!remoteAssistPanelSessionId) return;
            remoteAssistPanelHeartbeatTimer = setInterval(() => {
                sendRemoteAssistMessage('heartbeat', { session_id: remoteAssistPanelSessionId });
            }, 8000);
        }

        function setRemoteAssistLoading(visible, text = '') {
            const loading = document.getElementById('remoteAssistLoading');
            const loadingText = document.getElementById('remoteAssistLoadingText');
            const frame = document.getElementById('remoteAssistFrame');
            if (!loading || !loadingText || !frame) return;
            const keepCurrentFrame = !!visible && !!remoteAssistPanelLastSnapshot && !!remoteAssistPanelLastHtml;
            loading.style.display = visible && !keepCurrentFrame ? 'flex' : 'none';
            if (text) loadingText.textContent = text;
            frame.style.visibility = visible && !keepCurrentFrame ? 'hidden' : 'visible';
            if (keepCurrentFrame && text) {
                setRemoteAssistMeta(text);
            }
        }

        function setRemoteAssistMeta(text) {
            const meta = document.getElementById('remoteAssistMeta');
            if (!meta) return;
            const content = String(text || '').trim();
            meta.textContent = content;
            meta.style.display = content ? 'block' : 'none';
        }

        function isRemoteAssistVoiceCountedStatus(status) {
            const current = String(status || '').trim().toLowerCase();
            return current === 'reserved' || current === 'ringing' || current === 'connecting' || current === 'active';
        }

        function isRemoteAssistVoiceSocketStatus(status) {
            const current = String(status || '').trim().toLowerCase();
            return current === 'connecting' || current === 'active';
        }

        function isRemoteAssistVoiceSignalStatus(status) {
            return isRemoteAssistVoiceCountedStatus(status);
        }

        function isRemoteAssistVoiceTerminalStatus(status) {
            const current = String(status || '').trim().toLowerCase();
            return current === 'rejected' || current === 'timeout' || current === 'closed' || current === 'failed' || current === 'socket_closed';
        }

        function clearRemoteAssistVoiceStatePollTimer() {
            if (remoteAssistVoiceStatePollTimer) {
                clearTimeout(remoteAssistVoiceStatePollTimer);
                remoteAssistVoiceStatePollTimer = null;
            }
        }

        function shouldRefreshRemoteAssistVoicePendingState(status = remoteAssistVoiceStatus) {
            const current = String(status || '').trim().toLowerCase();
            return current === 'reserved' || current === 'ringing' || current === 'connecting';
        }

        function scheduleRemoteAssistVoiceStateRefresh(delay = 900) {
            clearRemoteAssistVoiceStatePollTimer();
            if (!remoteAssistPanelSessionId || !remoteAssistVoiceSessionId) return;
            if (!shouldRefreshRemoteAssistVoicePendingState(remoteAssistVoiceStatus)) return;
            remoteAssistVoiceStatePollTimer = setTimeout(async () => {
                remoteAssistVoiceStatePollTimer = null;
                await loadRemoteAssistVoiceState();
            }, Math.max(200, Number(delay || 0)));
        }

        function maybeRequestRemoteAssistSnapshotForVoiceStatus(previousStatus, nextStatus) {
            const prev = String(previousStatus || '').trim().toLowerCase();
            const next = String(nextStatus || '').trim().toLowerCase();
            if (!remoteAssistPanelSessionId || remoteAssistPanelConsentStatus !== 'accepted') return;
            if (next !== 'connecting' && next !== 'active') return;
            if (prev === next && (next === 'connecting' || next === 'active')) return;
            const now = Date.now();
            const requestKey = `${String(remoteAssistPanelSessionId || '').trim()}|${next}`;
            if (remoteAssistVoiceSnapshotRequestKey === requestKey && (now - remoteAssistVoiceSnapshotRequestAt) < 1500) return;
            remoteAssistVoiceSnapshotRequestKey = requestKey;
            remoteAssistVoiceSnapshotRequestAt = now;
            requestRemoteAssistSnapshot('voice_state_change');
        }

        function getRemoteAssistVoiceIconHtml(size = 16) {
            return `<span style="display:inline-flex; align-items:center; justify-content:center; width:${size}px; height:${size}px; flex:0 0 ${size}px;" aria-hidden="true"><svg viewBox="0 0 24 24" style="width:${size}px; height:${size}px; display:block;" focusable="false"><path fill="currentColor" d="M12 15a3.75 3.75 0 0 0 3.75-3.75V7.25a3.75 3.75 0 0 0-7.5 0v4A3.75 3.75 0 0 0 12 15Zm6-3.75a.75.75 0 0 1 1.5 0A7.5 7.5 0 0 1 12.75 18.7V21a.75.75 0 0 1-1.5 0v-2.3A7.5 7.5 0 0 1 4.5 11.25a.75.75 0 0 1 1.5 0 6 6 0 0 0 12 0Z"></path></svg></span>`;
        }

        function buildRemoteAssistVoiceToggleHtml(label) {
            const textHtml = `<span style="white-space:nowrap;">${label}</span>`;
            const normalizedLabel = String(label || '').trim();
            if (normalizedLabel === '关闭语音' || normalizedLabel === '取消语音') {
                return textHtml;
            }
            return `${getRemoteAssistVoiceIconHtml(16)}${textHtml}`;
        }

        function getRemoteAssistVoiceFillPercent(level, status, muted) {
            const num = Math.max(0, Math.min(1, Number(level || 0)));
            if (muted) return 22;
            if (String(status || '').trim().toLowerCase() === 'active') return Math.round(14 + (num * 72));
            if (String(status || '').trim().toLowerCase() === 'connecting') return 28;
            return 20;
        }

        function buildRemoteAssistVoiceMuteHtml(muted, pending) {
            const dotColor = muted ? 'rgba(255, 82, 82, 0.96)' : (pending ? 'rgba(0, 212, 180, 0.58)' : 'rgba(0, 212, 180, 0.96)');
            const fillColor = muted ? '#ff7474' : (pending ? '#7af3e3' : '#26e7c9');
            return `<span style="position:relative; display:inline-block; width:18px; height:18px; flex:0 0 18px;" aria-hidden="true"><svg viewBox="0 0 24 24" style="width:18px; height:18px; display:block; color:rgba(244, 255, 252, 0.34);" focusable="false"><path fill="currentColor" d="M12 15a3.75 3.75 0 0 0 3.75-3.75V7.25a3.75 3.75 0 0 0-7.5 0v4A3.75 3.75 0 0 0 12 15Zm6-3.75a.75.75 0 0 1 1.5 0A7.5 7.5 0 0 1 12.75 18.7V21a.75.75 0 0 1-1.5 0v-2.3A7.5 7.5 0 0 1 4.5 11.25a.75.75 0 0 1 1.5 0 6 6 0 0 0 12 0Z"></path></svg><span style="position:absolute; left:0; right:0; bottom:0; height:var(--remote-assist-voice-fill-percent, 24%); overflow:hidden; transition:height 0.12s ease;"><svg viewBox="0 0 24 24" style="width:18px; height:18px; display:block; position:absolute; left:0; bottom:0; color:${fillColor};" focusable="false"><path fill="currentColor" d="M12 15a3.75 3.75 0 0 0 3.75-3.75V7.25a3.75 3.75 0 0 0-7.5 0v4A3.75 3.75 0 0 0 12 15Zm6-3.75a.75.75 0 0 1 1.5 0A7.5 7.5 0 0 1 12.75 18.7V21a.75.75 0 0 1-1.5 0v-2.3A7.5 7.5 0 0 1 4.5 11.25a.75.75 0 0 1 1.5 0 6 6 0 0 0 12 0Z"></path></svg></span></span><span aria-hidden="true" style="position:absolute; right:10px; bottom:8px; width:7px; height:7px; border-radius:50%; background:${dotColor}; box-shadow:0 0 0 3px rgba(0, 0, 0, 0.16);"></span>`;
        }

        function updateRemoteAssistVoiceButton() {
            const button = document.getElementById('remoteAssistVoiceBtn');
            if (!button) return;
            let label = '发起语音';
            let disabled = !remoteAssistPanelSessionId;
            let title = '向用户发起实时语音';
            if (!remoteAssistPanelSessionId) {
                title = '远程指导会话未建立';
            } else if (remoteAssistPanelConsentStatus !== 'accepted') {
                label = '等待确认';
                disabled = true;
                title = '用户接受远程指导后才能发起实时语音';
            } else if (isRemoteAssistVoiceSocketStatus(remoteAssistVoiceStatus)) {
                label = '关闭语音';
                disabled = false;
                title = `当前语音状态：${remoteAssistVoiceStatus}`;
            } else if (isRemoteAssistVoiceCountedStatus(remoteAssistVoiceStatus)) {
                label = '取消语音';
                disabled = false;
                title = `当前语音状态：${remoteAssistVoiceStatus}`;
            } else if (remoteAssistVoiceStatus) {
                title = `当前语音状态：${remoteAssistVoiceStatus}`;
            }
            const showIcon = label !== '关闭语音' && label !== '取消语音';
            button.innerHTML = buildRemoteAssistVoiceToggleHtml(label);
            button.disabled = !!disabled;
            button.setAttribute('aria-label', label);
            button.style.display = 'inline-flex';
            button.style.alignItems = 'center';
            button.style.justifyContent = 'center';
            button.style.gap = showIcon ? '6px' : '0';
            button.style.opacity = disabled ? '0.6' : '1';
            button.style.cursor = disabled ? 'not-allowed' : 'pointer';
            button.title = title;
            renderRemoteAssistVoiceStrip();
        }

        function buildRemoteAssistVoiceGlow(level, muted) {
            const num = Math.max(0, Math.min(1, Number(level || 0)));
            if (muted) {
                return `0 0 0 ${Math.round(5 + (num * 6))}px rgba(255, 82, 82, ${(0.06 + (num * 0.1)).toFixed(3)}), 0 10px 24px rgba(0, 0, 0, 0.22)`;
            }
            return `0 0 0 ${Math.round(5 + (num * 8))}px rgba(0, 212, 180, ${(0.05 + (num * 0.14)).toFixed(3)}), 0 10px 24px rgba(0, 0, 0, 0.22)`;
        }

        function getRemoteAssistVoiceStripStateText() {
            const status = String(remoteAssistVoiceStatus || '').trim().toLowerCase();
            if (status === 'active') return '实时语音通话中';
            if (status === 'connecting') return '实时语音连接中';
            if (status === 'ringing' || status === 'reserved') return '等待用户接听实时语音';
            if (status === 'rejected') return '用户已拒绝实时语音';
            if (status === 'timeout') return '实时语音已超时';
            if (status === 'failed' || status === 'socket_closed') return '实时语音已断开';
            if (status === 'closed') return '实时语音已结束';
            return remoteAssistVoiceSessionId ? '实时语音准备中' : '实时语音未连接';
        }

        function getRemoteAssistVoiceStripSubText() {
            if (!remoteAssistVoiceSessionId) return '等待管理员发起语音邀请';
            const bothConnected = remoteAssistVoiceConnectedRoles.includes('admin') && remoteAssistVoiceConnectedRoles.includes('user');
            if (String(remoteAssistVoiceStatus || '').trim().toLowerCase() === 'active') {
                return `${remoteAssistVoiceMutedSelf ? '您的麦克风已静音' : '您的麦克风已开启'} · ${remoteAssistVoiceMutedPeer ? '用户已静音' : '用户可正常说话'}`;
            }
            if (bothConnected) {
                return '双方已连入信令，正在建立音频通道';
            }
            return remoteAssistVoiceConnectedRoles.includes('user') ? '用户已就绪，正在建立音频通道' : '等待用户进入语音';
        }

        function renderRemoteAssistVoiceStrip() {
            const muteBtn = document.getElementById('remoteAssistVoiceMuteBtn');
            if (!muteBtn) return;
            const visible = !!(remoteAssistVoiceSessionId && isRemoteAssistVoiceSocketStatus(remoteAssistVoiceStatus));
            const currentStatus = String(remoteAssistVoiceStatus || '').trim().toLowerCase();
            const level = Math.max(0, Math.min(1, Math.max(Number(remoteAssistVoiceLocalLevel || 0), Number(remoteAssistVoiceRemoteLevel || 0))));
            if (muteBtn) {
                const canControl = !!(remoteAssistVoiceClient && remoteAssistVoiceSessionId && isRemoteAssistVoiceCountedStatus(remoteAssistVoiceStatus));
                muteBtn.style.display = visible ? 'inline-flex' : 'none';
                muteBtn.disabled = !canControl;
                muteBtn.style.setProperty('--remote-assist-voice-fill-percent', `${getRemoteAssistVoiceFillPercent(level, currentStatus, remoteAssistVoiceMutedSelf)}%`);
                muteBtn.innerHTML = buildRemoteAssistVoiceMuteHtml(remoteAssistVoiceMutedSelf, currentStatus !== 'active');
                muteBtn.setAttribute('aria-label', remoteAssistVoiceMutedSelf ? '恢复麦克风' : '切换麦克风');
                muteBtn.style.width = '56px';
                muteBtn.style.height = '36px';
                muteBtn.style.padding = '0';
                muteBtn.style.position = 'relative';
                muteBtn.style.justifyContent = 'center';
                muteBtn.title = `${getRemoteAssistVoiceStripStateText()} · ${getRemoteAssistVoiceStripSubText()}${canControl ? (remoteAssistVoiceMutedSelf ? ' · 点击恢复麦克风' : ' · 点击静音麦克风') : ''}`;
                muteBtn.style.background = remoteAssistVoiceMutedSelf
                    ? 'linear-gradient(180deg, rgba(43, 19, 24, 0.98) 0%, rgba(27, 12, 16, 0.98) 100%)'
                    : 'linear-gradient(180deg, rgba(12, 39, 43, 0.98) 0%, rgba(7, 24, 28, 0.98) 100%)';
                muteBtn.style.color = remoteAssistVoiceMutedSelf ? '#ffb1b1' : (currentStatus === 'active' ? '#6bf3de' : '#f4fffc');
                muteBtn.style.border = remoteAssistVoiceMutedSelf
                    ? '1px solid rgba(88, 33, 39, 0.92)'
                    : (currentStatus === 'active' ? '1px solid rgba(22, 92, 92, 0.92)' : '1px solid rgba(11, 48, 53, 0.9)');
                muteBtn.style.boxShadow = '0 10px 18px rgba(0, 0, 0, 0.2)';
                muteBtn.style.opacity = canControl ? '1' : '0.45';
            }
        }

        function resetRemoteAssistVoiceUi(reason = '', clearSession = true) {
            remoteAssistVoiceStatus = String(reason || '').trim() || (clearSession ? '' : remoteAssistVoiceStatus);
            if (clearSession) remoteAssistVoiceSessionId = '';
            remoteAssistVoiceMutedSelf = false;
            remoteAssistVoiceMutedPeer = false;
            remoteAssistVoiceLocalLevel = 0;
            remoteAssistVoiceRemoteLevel = 0;
            remoteAssistVoiceConnectedRoles = [];
            renderRemoteAssistVoiceStrip();
        }

        async function buildRemoteVoiceWsUrl(voiceSessionId, role, site) {
            const ticket = await fetchWsTicket('voice', {
                voice_session_id: String(voiceSessionId || ''),
                role: String(role || 'admin'),
                site: String(site || 'ak_web')
            });
            return buildTicketedWsUrl('/voice/ws', ticket.ticket);
        }

        function ensureRemoteAssistVoiceLibrary() {
            if (window.AKRemoteVoiceClient) {
                return Promise.resolve(window.AKRemoteVoiceClient);
            }
            if (remoteAssistVoiceLibraryPromise) return remoteAssistVoiceLibraryPromise;
            remoteAssistVoiceLibraryPromise = new Promise((resolve, reject) => {
                const existing = document.querySelector('script[data-ak-voice-client="1"]');
                if (existing) {
                    existing.addEventListener('load', () => resolve(window.AKRemoteVoiceClient));
                    existing.addEventListener('error', () => reject(new Error('加载实时语音脚本失败')));
                    return;
                }
                const script = document.createElement('script');
                script.src = `${window.location.origin}/admin/api/remote-voice-client`;
                script.async = true;
                script.dataset.akVoiceClient = '1';
                script.onload = () => resolve(window.AKRemoteVoiceClient);
                script.onerror = () => reject(new Error('加载实时语音脚本失败'));
                document.head.appendChild(script);
            }).catch(error => {
                remoteAssistVoiceLibraryPromise = null;
                throw error;
            });
            return remoteAssistVoiceLibraryPromise;
        }

        async function disconnectRemoteAssistVoiceClient(notifyServer = false, reason = 'closed', clearSession = false, options = {}) {
            const client = remoteAssistVoiceClient;
            remoteAssistVoiceClient = null;
            if (!(options && options.preservePoll)) {
                clearRemoteAssistVoiceStatePollTimer();
            }
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
            resetRemoteAssistVoiceUi(reason, clearSession);
            updateRemoteAssistVoiceButton();
        }

        async function ensureRemoteAssistVoiceClient() {
            if (!remoteAssistPanelSessionId || !remoteAssistVoiceSessionId) {
                await disconnectRemoteAssistVoiceClient(false, remoteAssistVoiceStatus || 'closed', true);
                return;
            }
            if (!isRemoteAssistVoiceSignalStatus(remoteAssistVoiceStatus)) {
                if (remoteAssistVoiceClient) {
                    await disconnectRemoteAssistVoiceClient(false, remoteAssistVoiceStatus || 'closed', false, { preservePoll: true });
                }
                renderRemoteAssistVoiceStrip();
                updateRemoteAssistVoiceButton();
                return;
            }
            if (remoteAssistVoiceClient && remoteAssistVoiceClient.voiceSessionId === remoteAssistVoiceSessionId) {
                renderRemoteAssistVoiceStrip();
                return;
            }
            await ensureRemoteAssistVoiceLibrary();
            await disconnectRemoteAssistVoiceClient(false, '', false);
            const ClientCtor = window.AKRemoteVoiceClient;
            const voiceAudioEl = document.getElementById('remoteAssistVoiceAudio');
            const currentVoiceSessionId = remoteAssistVoiceSessionId;
            const client = new ClientCtor({
                voiceSessionId: currentVoiceSessionId,
                role: 'admin',
                site: 'ak_web',
                initialStatus: remoteAssistVoiceStatus,
                preserveSessionStatusOnSignalOpen: true,
                lazyMedia: true,
                remoteAudio: voiceAudioEl,
                wsUrlBuilder: buildRemoteVoiceWsUrl,
                onStateChange: function(state) {
                    if (remoteAssistVoiceClient !== client) return;
                    const previousVoiceStatus = String(remoteAssistVoiceStatus || '').trim();
                    remoteAssistVoiceStatus = String(state && state.status || remoteAssistVoiceStatus || '').trim() || remoteAssistVoiceStatus;
                    remoteAssistVoiceMutedSelf = !!(state && state.mutedSelf);
                    remoteAssistVoiceMutedPeer = !!(state && state.mutedPeer);
                    remoteAssistVoiceLocalLevel = Number(state && state.localLevel || 0);
                    remoteAssistVoiceRemoteLevel = Number(state && state.remoteLevel || 0);
                    remoteAssistVoiceConnectedRoles = Array.isArray(state && state.connectedRoles) ? state.connectedRoles.slice() : [];
                    if (!isRemoteAssistVoiceCountedStatus(remoteAssistVoiceStatus) && String(state && state.phase || '').trim() === 'closed') {
                        clearRemoteAssistVoiceStatePollTimer();
                        remoteAssistVoiceClient = null;
                        resetRemoteAssistVoiceUi(remoteAssistVoiceStatus, true);
                        updateRemoteAssistVoiceButton();
                        return;
                    }
                    if (shouldRefreshRemoteAssistVoicePendingState(remoteAssistVoiceStatus)) {
                        scheduleRemoteAssistVoiceStateRefresh(900);
                    } else {
                        clearRemoteAssistVoiceStatePollTimer();
                    }
                    maybeRequestRemoteAssistSnapshotForVoiceStatus(previousVoiceStatus, remoteAssistVoiceStatus);
                    renderRemoteAssistVoiceStrip();
                    updateRemoteAssistVoiceButton();
                },
                onError: function(error) {
                    if (remoteAssistVoiceClient !== client) return;
                    handleRemoteAssistVoiceClientError(error, client, currentVoiceSessionId);
                }
            });
            remoteAssistVoiceClient = client;
            renderRemoteAssistVoiceStrip();
            try {
                await client.start();
            } catch (e) {
                await loadRemoteAssistVoiceState({ syncClient: false });
                if (
                    remoteAssistVoiceClient !== client
                    || remoteAssistVoiceSessionId !== currentVoiceSessionId
                    || !isRemoteAssistVoiceSignalStatus(remoteAssistVoiceStatus)
                    || isRemoteAssistVoiceTerminalStatus(remoteAssistVoiceStatus)
                ) {
                    updateRemoteAssistVoiceButton();
                    return;
                }
                if (remoteAssistVoiceClient === client) {
                    remoteAssistVoiceClient = null;
                    resetRemoteAssistVoiceUi('failed', true);
                }
                updateRemoteAssistVoiceButton();
                showToast(`启动实时语音失败: ${(e && e.message) || '信令连接失败'}`, 'error');
            }
        }

        async function handleRemoteAssistVoiceClientError(error, client, voiceSessionId) {
            if (remoteAssistVoiceClient !== client) return;
            if (isRemoteAssistVoiceTerminalStatus(remoteAssistVoiceStatus) || !isRemoteAssistVoiceSocketStatus(remoteAssistVoiceStatus)) return;
            await loadRemoteAssistVoiceState({ syncClient: false });
            if (
                remoteAssistVoiceClient !== client
                || remoteAssistVoiceSessionId !== voiceSessionId
                || isRemoteAssistVoiceTerminalStatus(remoteAssistVoiceStatus)
                || !isRemoteAssistVoiceSocketStatus(remoteAssistVoiceStatus)
            ) {
                return;
            }
            const message = String((error && error.message) || '').trim() || '信令连接失败';
            showToast(`实时语音异常：${message}`, 'error');
        }

        async function toggleRemoteAssistVoiceMute() {
            if (!remoteAssistVoiceClient) return;
            try {
                await remoteAssistVoiceClient.toggleMuted();
            } catch (e) {
                showToast(`切换麦克风失败: ${e.message}`, 'error');
            }
        }

        async function loadRemoteAssistVoiceState(options = {}) {
            const shouldSyncClient = !(options && options.syncClient === false);
            if (!remoteAssistPanelSessionId) {
                clearRemoteAssistVoiceStatePollTimer();
                await disconnectRemoteAssistVoiceClient(false, 'closed', true);
                updateRemoteAssistVoiceButton();
                return;
            }
            try {
                const previousVoiceStatus = String(remoteAssistVoiceStatus || '').trim();
                const res = await fetch(`${API_BASE}/admin/api/remote_voice/status?assist_session_id=${encodeURIComponent(remoteAssistPanelSessionId)}`, {
                    headers: getHeaders()
                });
                const data = await res.json();
                if (!res.ok || data.success === false) {
                    throw new Error(data.message || '加载实时语音状态失败');
                }
                remoteAssistVoiceSessionId = data.active ? String(data.voice_session_id || '') : '';
                remoteAssistVoiceStatus = String(data.status || '');
                remoteAssistVoiceMutedSelf = !!data.admin_muted;
                remoteAssistVoiceMutedPeer = !!data.user_muted;
                remoteAssistVoiceConnectedRoles = Array.isArray(data.connected_roles) ? data.connected_roles.slice() : [];
                updateRemoteAssistVoiceButton();
                if (shouldRefreshRemoteAssistVoicePendingState(remoteAssistVoiceStatus)) {
                    scheduleRemoteAssistVoiceStateRefresh(900);
                } else {
                    clearRemoteAssistVoiceStatePollTimer();
                }
                maybeRequestRemoteAssistSnapshotForVoiceStatus(previousVoiceStatus, remoteAssistVoiceStatus);
                if (remoteAssistVoiceSessionId && isRemoteAssistVoiceSignalStatus(remoteAssistVoiceStatus)) {
                    if (!shouldSyncClient) {
                        renderRemoteAssistVoiceStrip();
                        updateRemoteAssistVoiceButton();
                        return;
                    }
                    await ensureRemoteAssistVoiceClient();
                } else if (remoteAssistVoiceSessionId && isRemoteAssistVoiceCountedStatus(remoteAssistVoiceStatus)) {
                    if (remoteAssistVoiceClient) {
                        await disconnectRemoteAssistVoiceClient(false, remoteAssistVoiceStatus || 'ringing', false, { preservePoll: true });
                    } else {
                        renderRemoteAssistVoiceStrip();
                        updateRemoteAssistVoiceButton();
                    }
                } else {
                    await disconnectRemoteAssistVoiceClient(false, remoteAssistVoiceStatus || 'closed', true);
                }
            } catch (e) {
                if (shouldRefreshRemoteAssistVoicePendingState(remoteAssistVoiceStatus)) {
                    scheduleRemoteAssistVoiceStateRefresh(1200);
                } else {
                    clearRemoteAssistVoiceStatePollTimer();
                }
                if (!remoteAssistVoiceClient) {
                    resetRemoteAssistVoiceUi('', true);
                }
                updateRemoteAssistVoiceButton();
            }
        }

        async function toggleRemoteAssistVoice() {
            if (!remoteAssistPanelSessionId) return;
            if (remoteAssistPanelConsentStatus !== 'accepted') {
                showToast('用户尚未接受远程指导，暂无法发起实时语音', 'error');
                return;
            }
            const shouldClose = isRemoteAssistVoiceCountedStatus(remoteAssistVoiceStatus);
            try {
                const res = await fetch(`${API_BASE}/admin/api/remote_voice/${shouldClose ? 'close' : 'start'}`, {
                    method: 'POST',
                    headers: {
                        ...getHeaders(),
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(shouldClose ? {
                        assist_session_id: remoteAssistPanelSessionId,
                        voice_session_id: remoteAssistVoiceSessionId
                    } : {
                        assist_session_id: remoteAssistPanelSessionId
                    })
                });
                const data = await res.json();
                if (!res.ok || data.success === false) {
                    showToast(data.message || (shouldClose ? '关闭实时语音失败' : '发起实时语音失败'), 'error');
                    await loadRemoteAssistVoiceState();
                    return;
                }
                remoteAssistVoiceSessionId = shouldClose ? '' : String(data.voice_session_id || '');
                remoteAssistVoiceStatus = String(data.status || (shouldClose ? '' : 'ringing'));
                if (shouldClose) {
                    clearRemoteAssistVoiceStatePollTimer();
                    await disconnectRemoteAssistVoiceClient(false, 'closed', true);
                } else {
                    remoteAssistVoiceMutedSelf = false;
                    remoteAssistVoiceMutedPeer = false;
                    remoteAssistVoiceLocalLevel = 0;
                    remoteAssistVoiceRemoteLevel = 0;
                    remoteAssistVoiceConnectedRoles = [];
                    scheduleRemoteAssistVoiceStateRefresh(700);
                    if (isRemoteAssistVoiceSignalStatus(remoteAssistVoiceStatus)) {
                        await ensureRemoteAssistVoiceClient();
                    }
                }
                updateRemoteAssistVoiceButton();
                showToast(data.message || (shouldClose ? '已关闭实时语音' : '已发起实时语音邀请'));
                await loadRemoteAssistVoiceState();
            } catch (e) {
                showToast((shouldClose ? '关闭实时语音失败: ' : '发起实时语音失败: ') + e.message, 'error');
                await loadRemoteAssistVoiceState();
            }
        }

        function setRemoteAssistTitle(username) {
            remoteAssistPanelUsername = String(username || '').trim();
            const title = document.getElementById('remoteAssistTitle');
            if (!title) return;
            title.textContent = remoteAssistPanelUsername ? `${remoteAssistPanelUsername} 的远程指导` : '远程指导';
        }

        function buildRemoteAssistPlaceholderHtml(text) {
            const safeText = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            return `<!doctype html><html><body style="font-family:Arial;padding:16px;color:#64748b;">${safeText}</body></html>`;
        }

        async function buildRemoteAssistWsUrl(sessionId) {
            const ticket = await fetchWsTicket('assist', {
                session_id: String(sessionId || ''),
                site: 'ak_web',
                readonly: true
            });
            return buildTicketedWsUrl('/admin/assist/ws', ticket.ticket);
        }

        function getRemoteAssistSnapshotViewport(snapshot = remoteAssistPanelLastSnapshot) {
            try {
                const viewport = snapshot && snapshot.viewport ? snapshot.viewport : null;
                const width = Math.max(0, Math.round(viewport && viewport.width || 0));
                const height = Math.max(0, Math.round(viewport && viewport.height || 0));
                if (!width || !height) return null;
                return {
                    width,
                    height,
                    devicePixelRatio: Math.max(0, Number(viewport && viewport.devicePixelRatio || 0))
                };
            } catch (e) {
                return null;
            }
        }

        function syncRemoteAssistViewport(snapshot = remoteAssistPanelLastSnapshot) {
            try {
                const stage = document.getElementById('remoteAssistStage');
                const stageFrame = document.getElementById('remoteAssistStageFrame');
                const frame = document.getElementById('remoteAssistFrame');
                if (!stage || !stageFrame || !frame) return;
                const viewport = getRemoteAssistSnapshotViewport(snapshot);
                if (!viewport) {
                    remoteAssistPanelLastViewportSyncDebugKey = '';
                    stageFrame.style.position = 'relative';
                    stageFrame.style.left = '';
                    stageFrame.style.top = '';
                    stageFrame.style.width = '100%';
                    stageFrame.style.height = '100%';
                    stageFrame.style.transform = 'none';
                    stageFrame.style.transformOrigin = '';
                    frame.style.width = '100%';
                    frame.style.height = '100%';
                    return;
                }
                const stageWidth = Math.max(1, Math.round(stage.clientWidth || 0));
                const stageHeight = Math.max(1, Math.round(stage.clientHeight || 0));
                const viewportWidth = Math.max(1, Math.round(viewport.width || stageWidth));
                const viewportHeight = Math.max(1, Math.round(viewport.height || stageHeight));
                const scale = Math.max(0.1, Math.min(stageWidth / viewportWidth, stageHeight / viewportHeight));
                stageFrame.style.position = 'absolute';
                stageFrame.style.left = '50%';
                stageFrame.style.top = '0';
                stageFrame.style.width = viewportWidth + 'px';
                stageFrame.style.height = viewportHeight + 'px';
                stageFrame.style.transform = 'translateX(-50%) scale(' + scale + ')';
                stageFrame.style.transformOrigin = 'top center';
                frame.style.width = '100%';
                frame.style.height = '100%';
                const route = getRemoteAssistSnapshotRoute(snapshot);
                const debugKey = [
                    route,
                    viewportWidth,
                    viewportHeight,
                    stageWidth,
                    stageHeight,
                    scale.toFixed(4),
                    stageFrame.style.width,
                    stageFrame.style.height,
                    stageFrame.style.transform
                ].join('|');
                if (remoteAssistPanelLastViewportSyncDebugKey !== debugKey) {
                    remoteAssistPanelLastViewportSyncDebugKey = debugKey;
                    logRemoteAssistDebug('viewport_sync_applied', {
                        route,
                        viewport_width: viewportWidth,
                        viewport_height: viewportHeight,
                        stage_width: stageWidth,
                        stage_height: stageHeight,
                        scale: Number(scale.toFixed(4)),
                        frame_width: String(stageFrame.style.width || ''),
                        frame_height: String(stageFrame.style.height || ''),
                        frame_transform: String(stageFrame.style.transform || '')
                    });
                }
            } catch (e) {
            }
        }
        window.syncRemoteAssistViewport = syncRemoteAssistViewport;

        function flashRemoteAssistSnapshotNode(meta) {
            try {
                const target = findRemoteAssistSnapshotNode(meta);
                if (!target) return;
                const prevOutline = target.style.outline;
                const prevOffset = target.style.outlineOffset;
                target.style.outline = '2px solid rgba(255,82,82,0.95)';
                target.style.outlineOffset = '2px';
                setTimeout(() => {
                    target.style.outline = prevOutline || '';
                    target.style.outlineOffset = prevOffset || '';
                }, 1200);
            } catch (e) {
            }
        }

        function findRemoteAssistSnapshotNode(meta) {
            try {
                const frame = document.getElementById('remoteAssistFrame');
                const doc = frame && frame.contentDocument;
                if (!doc) return null;
                let target = null;
                if (meta && meta.node_id) {
                    target = doc.querySelector(`[data-ra-node-id="${String(meta.node_id).replace(/"/g, '\\"')}"]`);
                }
                if (!target && meta && meta.selector_hint) {
                    target = doc.querySelector(meta.selector_hint);
                }
                if (!target && meta && meta.rect) {
                    target = doc.elementFromPoint(Number(meta.rect.x) || 0, Number(meta.rect.y) || 0);
                }
                return target || null;
            } catch (e) {
                return null;
            }
        }

        function clearRemoteAssistScrollRestoreTimer() {
            if (remoteAssistPanelRestoreScrollTimer) {
                clearTimeout(remoteAssistPanelRestoreScrollTimer);
                remoteAssistPanelRestoreScrollTimer = null;
            }
        }

        function clearRemoteAssistRouteSnapshotTimer() {
            if (remoteAssistPanelRouteSnapshotTimer) {
                clearTimeout(remoteAssistPanelRouteSnapshotTimer);
                remoteAssistPanelRouteSnapshotTimer = null;
            }
        }

        function clearRemoteAssistRenderReadyTimer() {
            if (remoteAssistPanelRenderReadyTimer) {
                clearTimeout(remoteAssistPanelRenderReadyTimer);
                remoteAssistPanelRenderReadyTimer = null;
            }
        }

        function clearRemoteAssistSnapshotDrainTimer() {
            if (remoteAssistPanelSnapshotDrainTimer) {
                clearTimeout(remoteAssistPanelSnapshotDrainTimer);
                remoteAssistPanelSnapshotDrainTimer = null;
            }
        }

        function clearRemoteAssistProxySnapshotTimer() {
            if (remoteAssistPanelProxySnapshotTimer) {
                clearTimeout(remoteAssistPanelProxySnapshotTimer);
                remoteAssistPanelProxySnapshotTimer = null;
            }
        }

        function clearRemoteAssistFrameBinding() {
            if (typeof remoteAssistPanelFrameBindingCleanup === 'function') {
                try {
                    remoteAssistPanelFrameBindingCleanup();
                } catch (e) {
                }
            }
            remoteAssistPanelFrameBindingCleanup = null;
        }

        function resetRemoteAssistFrameDocument(html = '<!doctype html><html><body></body></html>') {
            const frame = document.getElementById('remoteAssistFrame');
            remoteAssistPanelRenderSeq += 1;
            remoteAssistPanelLoadedRenderSeq = 0;
            remoteAssistPanelReadyRenderSeq = 0;
            remoteAssistPanelRenderingSnapshot = false;
            remoteAssistPanelQueuedSnapshot = null;
            remoteAssistPanelProxySnapshotRequestAt = 0;
            remoteAssistPanelProxySnapshotRequestKey = '';
            clearRemoteAssistRenderReadyTimer();
            clearRemoteAssistSnapshotDrainTimer();
            clearRemoteAssistProxySnapshotTimer();
            clearRemoteAssistFrameBinding();
            syncRemoteAssistViewport(null);
            if (!frame) return;
            frame.onload = null;
            frame.srcdoc = html;
        }

        function scheduleRemoteAssistSnapshotDrain() {
            clearRemoteAssistSnapshotDrainTimer();
            if (!remoteAssistPanelQueuedSnapshot || remoteAssistPanelRenderingSnapshot) return;
            remoteAssistPanelSnapshotDrainTimer = setTimeout(function() {
                remoteAssistPanelSnapshotDrainTimer = null;
                drainRemoteAssistSnapshotQueue();
            }, 0);
        }

        function completeRemoteAssistSnapshotRender(renderSeq) {
            if (typeof renderSeq === 'number' && renderSeq !== remoteAssistPanelRenderSeq) return;
            remoteAssistPanelRenderingSnapshot = false;
            scheduleRemoteAssistSnapshotDrain();
        }

        function drainRemoteAssistSnapshotQueue() {
            if (remoteAssistPanelRenderingSnapshot) return;
            const snapshot = remoteAssistPanelQueuedSnapshot;
            remoteAssistPanelQueuedSnapshot = null;
            if (!snapshot) return;
            remoteAssistPanelRenderingSnapshot = true;
            try {
                renderRemoteAssistSnapshotNow(snapshot);
            } catch (e) {
                remoteAssistPanelRenderingSnapshot = false;
                throw e;
            }
        }

        function renderRemoteAssistSnapshot(snapshot) {
            remoteAssistPanelQueuedSnapshot = snapshot || null;
            drainRemoteAssistSnapshotQueue();
        }

        function getRemoteAssistSnapshotRoute(snapshot) {
            return String(snapshot && snapshot.route || '').trim();
        }

        function getRemoteAssistScrollRoute(scroll) {
            return String(scroll && scroll.route || '').trim();
        }

        function resetRemoteAssistPendingSnapshotRequest() {
            remoteAssistPanelPendingRouteRequestKey = '';
            remoteAssistPanelPendingRouteRequestAt = 0;
        }

        function hasRecentRemoteAssistPendingSnapshotRequest(route = '') {
            const normalizedRoute = String(route || '').trim();
            return !!normalizedRoute
                && remoteAssistPanelPendingRouteRequestKey === normalizedRoute
                && (Date.now() - remoteAssistPanelPendingRouteRequestAt) < REMOTE_ASSIST_PENDING_ROUTE_REQUEST_RETRY_MS;
        }

        function setRemoteAssistPendingRoute(route, traceMeta = null) {
            const normalizedRoute = String(route || '').trim();
            const shouldLogWaitStart = !remoteAssistPanelWaitingForRouteSnapshot || remoteAssistPanelPendingRoute !== normalizedRoute;
            remoteAssistPanelPendingRoute = normalizedRoute;
            remoteAssistPanelWaitingForRouteSnapshot = true;
            resetRemoteAssistPendingSnapshotRequest();
            if (shouldLogWaitStart) {
                logRemoteAssistDebug('route_wait_started', {
                    route: normalizedRoute,
                    current_route: getRemoteAssistSnapshotRoute(remoteAssistPanelLastSnapshot),
                    trace_id: String(traceMeta && traceMeta.trace_id || ''),
                    client_emit_ts: Number(traceMeta && traceMeta.client_emit_ts || 0),
                    admin_wait_started_ts: Date.now()
                });
            }
        }

        function clearRemoteAssistPendingRoute(route = '') {
            const normalizedRoute = String(route || '').trim();
            if (!remoteAssistPanelWaitingForRouteSnapshot) return;
            if (!remoteAssistPanelPendingRoute || !normalizedRoute || remoteAssistPanelPendingRoute === normalizedRoute) {
                clearRemoteAssistRouteSnapshotTimer();
                remoteAssistPanelPendingRoute = '';
                remoteAssistPanelWaitingForRouteSnapshot = false;
                resetRemoteAssistPendingSnapshotRequest();
            }
        }

        function scheduleRemoteAssistRouteSnapshotRequest(route = '') {
            const wantedRoute = String(route || '').trim();
            clearRemoteAssistRouteSnapshotTimer();
            if (!remoteAssistPanelSessionId) return;
            remoteAssistPanelRouteSnapshotTimer = setTimeout(function() {
                remoteAssistPanelRouteSnapshotTimer = null;
                if (!remoteAssistPanelWaitingForRouteSnapshot) {
                    return;
                }
                if (wantedRoute && remoteAssistPanelPendingRoute && wantedRoute !== remoteAssistPanelPendingRoute) {
                    return;
                }
                const requestRoute = wantedRoute || remoteAssistPanelPendingRoute;
                if (hasRecentRemoteAssistPendingSnapshotRequest(requestRoute)) {
                    return;
                }
                const sent = sendRemoteAssistMessage('snapshot_request', { reason: 'route_changed' });
                if (sent) {
                    remoteAssistPanelPendingRouteRequestKey = requestRoute;
                    remoteAssistPanelPendingRouteRequestAt = Date.now();
                }
                if (!sent) {
                    logRemoteAssistDebug('route_snapshot_request_failed', {
                        route: wantedRoute,
                        pending_route: remoteAssistPanelPendingRoute,
                        waiting: !!remoteAssistPanelWaitingForRouteSnapshot
                    });
                }
                if (!sent) {
                    setRemoteAssistMeta('指导连接未就绪，正在等待重连');
                }
            }, 80);
        }

        function nudgeRemoteAssistPendingSnapshot(route = '', source = '') {
            const normalizedRoute = String(route || '').trim();
            if (!remoteAssistPanelWaitingForRouteSnapshot || !remoteAssistPanelSessionId) return;
            if (normalizedRoute && remoteAssistPanelPendingRoute && normalizedRoute !== remoteAssistPanelPendingRoute) return;
            if (remoteAssistPanelRouteSnapshotTimer) return;
            const requestRoute = normalizedRoute || remoteAssistPanelPendingRoute;
            if (hasRecentRemoteAssistPendingSnapshotRequest(requestRoute)) return;
            logRemoteAssistDebug('pending_snapshot_nudge', {
                route: requestRoute,
                pending_route: remoteAssistPanelPendingRoute,
                source: String(source || ''),
                waiting: !!remoteAssistPanelWaitingForRouteSnapshot
            });
            scheduleRemoteAssistRouteSnapshotRequest(requestRoute);
        }

        function resolveRemoteAssistSnapshotScroll(snapshot) {
            const snapshotRoute = getRemoteAssistSnapshotRoute(snapshot);
            const snapshotScroll = snapshot && snapshot.scroll ? { ...snapshot.scroll } : null;
            const liveScroll = remoteAssistPanelLastScroll ? { ...remoteAssistPanelLastScroll } : null;
            const liveRoute = getRemoteAssistScrollRoute(liveScroll);
            if (snapshotScroll && !getRemoteAssistScrollRoute(snapshotScroll) && snapshotRoute) {
                snapshotScroll.route = snapshotRoute;
            }
            if (liveScroll && snapshotRoute && liveRoute === snapshotRoute) {
                return liveScroll;
            }
            if (snapshotScroll) {
                return snapshotScroll;
            }
            return liveScroll;
        }

        function withRemoteAssistProgrammaticScroll(task) {
            remoteAssistPanelApplyingScrollDepth += 1;
            try {
                return typeof task === 'function' ? task() : undefined;
            } finally {
                const release = function() {
                    remoteAssistPanelApplyingScrollDepth = Math.max(0, remoteAssistPanelApplyingScrollDepth - 1);
                };
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(release);
                } else {
                    setTimeout(release, 16);
                }
            }
        }

        function isRemoteAssistScrollKey(event) {
            const key = String(event && event.key || '');
            return key === 'ArrowUp'
                || key === 'ArrowDown'
                || key === 'PageUp'
                || key === 'PageDown'
                || key === 'Home'
                || key === 'End'
                || key === ' '
                || key === 'Spacebar';
        }

        function scheduleRemoteAssistScrollRestore() {
            if (remoteAssistPanelApplyingScrollDepth > 0 || !remoteAssistPanelLastScroll || remoteAssistPanelWaitingForRouteSnapshot) return;
            if (remoteAssistPanelRestoreScrollTimer) return;
            remoteAssistPanelRestoreScrollTimer = setTimeout(function() {
                remoteAssistPanelRestoreScrollTimer = null;
                if (remoteAssistPanelApplyingScrollDepth > 0 || !remoteAssistPanelLastScroll || remoteAssistPanelWaitingForRouteSnapshot) return;
                applyRemoteAssistScroll(remoteAssistPanelLastScroll);
            }, 0);
        }

        function blockRemoteAssistManualScroll(event) {
            if (remoteAssistPanelApplyingScrollDepth > 0) return;
            if (event && event.cancelable) {
                event.preventDefault();
            }
            if (event && event.stopPropagation) {
                event.stopPropagation();
            }
            scheduleRemoteAssistScrollRestore();
        }

        function bindRemoteAssistSnapshotFrame(renderSeq) {
            if (typeof renderSeq === 'number' && (renderSeq !== remoteAssistPanelRenderSeq || (remoteAssistPanelLoadedRenderSeq !== renderSeq && remoteAssistPanelReadyRenderSeq !== renderSeq))) {
                return;
            }
            const frame = document.getElementById('remoteAssistFrame');
            const doc = frame && frame.contentDocument;
            const win = frame && frame.contentWindow;
            if (!frame || !doc || !win) return;
            clearRemoteAssistFrameBinding();
            try {
                const styleHost = doc.head || doc.body || doc.documentElement;
                const scrollRoot = doc.scrollingElement || doc.documentElement || doc.body;
                if (doc.documentElement) {
                    doc.documentElement.style.overscrollBehavior = 'none';
                    doc.documentElement.style.scrollbarWidth = 'none';
                }
                if (doc.body) {
                    doc.body.style.overscrollBehavior = 'none';
                    doc.body.style.scrollbarWidth = 'none';
                }
                if (scrollRoot && scrollRoot.style) {
                    scrollRoot.style.overscrollBehavior = 'none';
                    scrollRoot.style.scrollbarWidth = 'none';
                    if (scrollRoot !== doc.documentElement && scrollRoot !== doc.body && scrollRoot.setAttribute) {
                        scrollRoot.setAttribute('data-ra-admin-scroll-root', '1');
                    }
                }
                let scrollLockStyle = doc.getElementById('ra-admin-scroll-lock');
                if (!scrollLockStyle && styleHost) {
                    scrollLockStyle = doc.createElement('style');
                    scrollLockStyle.id = 'ra-admin-scroll-lock';
                    styleHost.appendChild(scrollLockStyle);
                }
                if (scrollLockStyle) {
                    scrollLockStyle.textContent = 'html,body,*{touch-action:none!important;}html::-webkit-scrollbar,body::-webkit-scrollbar,[data-ra-admin-scroll-root="1"]::-webkit-scrollbar{display:none !important;width:0 !important;height:0 !important;}';
                }
            } catch (e) {
            }
            const handleClick = function(event) {
                event.preventDefault();
                event.stopPropagation();
                const target = event.target && event.target.closest ? event.target.closest('[data-ra-node-id]') || event.target : event.target;
                if (!target) return;
                const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
                const payload = {
                    node_id: target.getAttribute && target.getAttribute('data-ra-node-id') ? target.getAttribute('data-ra-node-id') : '',
                    selector_hint: target.getAttribute && target.getAttribute('data-ra-selector-hint') ? target.getAttribute('data-ra-selector-hint') : (target.id ? `#${target.id}` : String((target.tagName || 'div')).toLowerCase()),
                    text_hint: target.getAttribute && target.getAttribute('data-ra-text-hint') ? target.getAttribute('data-ra-text-hint') : String(target.innerText || target.textContent || '').trim().slice(0, 40),
                    rect: rect ? {
                        x: Math.round(rect.left + rect.width / 2),
                        y: Math.round(rect.top + rect.height / 2),
                        w: Math.round(rect.width),
                        h: Math.round(rect.height)
                    } : null
                };
                flashRemoteAssistSnapshotNode(payload);
                sendRemoteAssistMessage('click_highlight', payload);
            };
            doc.addEventListener('wheel', blockRemoteAssistManualScroll, { capture: true, passive: false });
            doc.addEventListener('touchmove', blockRemoteAssistManualScroll, { capture: true, passive: false });
            doc.addEventListener('pointermove', blockRemoteAssistManualScroll, { capture: true, passive: false });
            doc.addEventListener('dragstart', blockRemoteAssistManualScroll, { capture: true, passive: false });
            const handleKeyDown = function(event) {
                if (!isRemoteAssistScrollKey(event)) return;
                blockRemoteAssistManualScroll(event);
            };
            const handleManualScrollDrift = function() {
                if (remoteAssistPanelApplyingScrollDepth > 0) return;
                scheduleRemoteAssistScrollRestore();
            };
            doc.addEventListener('click', handleClick, true);
            doc.addEventListener('keydown', handleKeyDown, true);
            doc.addEventListener('scroll', handleManualScrollDrift, true);
            win.addEventListener('scroll', handleManualScrollDrift, true);
            remoteAssistPanelFrameBindingCleanup = function() {
                try {
                    doc.removeEventListener('click', handleClick, true);
                } catch (e) {
                }
                try {
                    doc.removeEventListener('wheel', blockRemoteAssistManualScroll, true);
                } catch (e) {
                }
                try {
                    doc.removeEventListener('touchmove', blockRemoteAssistManualScroll, true);
                } catch (e) {
                }
                try {
                    doc.removeEventListener('pointermove', blockRemoteAssistManualScroll, true);
                } catch (e) {
                }
                try {
                    doc.removeEventListener('dragstart', blockRemoteAssistManualScroll, true);
                } catch (e) {
                }
                try {
                    doc.removeEventListener('keydown', handleKeyDown, true);
                } catch (e) {
                }
                try {
                    doc.removeEventListener('scroll', handleManualScrollDrift, true);
                } catch (e) {
                }
                try {
                    win.removeEventListener('scroll', handleManualScrollDrift, true);
                } catch (e) {
                }
                try {
                    const markedScrollRoot = doc.querySelector('[data-ra-admin-scroll-root="1"]');
                    if (markedScrollRoot) {
                        markedScrollRoot.removeAttribute('data-ra-admin-scroll-root');
                    }
                } catch (e) {
                }
            };
        }

        function sanitizeRemoteAssistCssText(cssText) {
            return String(cssText || '')
                .replace(/@import\s+(?:url\()?\s*(['"]?)\s*javascript:[^;]+;?/ig, '')
                .replace(/@import\s+(?:url\()?\s*(['"]?)\s*(?:vbscript:|data:text\/html|data:text\/javascript)[^;]+;?/ig, '')
                .replace(/url\(\s*(['"]?)\s*(?:javascript:|vbscript:|data:text\/html|data:text\/javascript)[^)]*\1\s*\)/ig, 'none')
                .replace(/url\(\s*(['"]?)\s*data:image\/svg\+xml[^)]*\1\s*\)/ig, 'none')
                .replace(/expression\s*\([^)]*\)/ig, '')
                .replace(/behavior\s*:[^;]+;?/ig, '')
                .replace(/-moz-binding\s*:[^;]+;?/ig, '');
        }

        function stripRemoteAssistUnsafeHtml(rawHtml) {
            return String(rawHtml || '')
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
                .replace(/<(object|embed|foreignObject)\b[^>]*>/gi, '')
                .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, '')
                .replace(/\s(?:href|src|xlink:href|formaction)\s*=\s*(["'])\s*(?:javascript:|vbscript:|data:text\/html|data:text\/javascript|data:image\/svg\+xml)[^"']*\1/gi, '')
                .replace(/\ssrcset\s*=\s*(["'])[^"']*(?:javascript:|vbscript:|data:text\/html|data:text\/javascript|data:image\/svg\+xml)[^"']*\1/gi, '');
        }

        function sanitizeRemoteAssistSrcdocHtml(html) {
            const rawHtml = String(html || '<!doctype html><html><body style="font-family:Arial;padding:16px;color:#64748b;">暂无可渲染快照</body></html>');
            try {
                const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
                const root = doc.documentElement || doc.body;
                if (!root) return rawHtml;
                doc.querySelectorAll('script,iframe,object,embed,foreignObject').forEach(node => node.remove());
                doc.querySelectorAll('style').forEach(node => {
                    const cssText = sanitizeRemoteAssistCssText(node.textContent || '');
                    if (cssText) {
                        node.textContent = cssText;
                    } else {
                        node.remove();
                    }
                });
                root.querySelectorAll('*').forEach(node => {
                    Array.from(node.attributes || []).forEach(attr => {
                        const name = String(attr.name || '').toLowerCase();
                        const value = String(attr.value || '');
                        if (!name) return;
                        if (name.indexOf('on') === 0) {
                            node.removeAttribute(attr.name);
                            return;
                        }
                        if (name === 'style') {
                            const cssText = sanitizeRemoteAssistCssText(value);
                            if (cssText) {
                                node.setAttribute(attr.name, cssText);
                            } else {
                                node.removeAttribute(attr.name);
                            }
                            return;
                        }
                        if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'formaction') && /^\s*(?:javascript:|vbscript:|data:text\/html|data:text\/javascript|data:image\/svg\+xml)/i.test(value)) {
                            node.removeAttribute(attr.name);
                            return;
                        }
                        if (name === 'srcset' && /(?:javascript:|vbscript:|data:text\/html|data:text\/javascript|data:image\/svg\+xml)/i.test(value)) {
                            node.removeAttribute(attr.name);
                        }
                    });
                });
                return '<!doctype html>' + root.outerHTML;
            } catch (e) {
                return stripRemoteAssistUnsafeHtml(rawHtml);
            }
        }

        function isRemoteAssistSerializedSnapshotHtml(rawHtml) {
            const normalizedHtml = String(rawHtml || '');
            return normalizedHtml.indexOf('<!doctype html>') === 0
                && normalizedHtml.indexOf('<meta charset="utf-8">') !== -1
                && normalizedHtml.indexOf('data-ra-tag=') !== -1
                && normalizedHtml.indexOf('data-ra-node-id=') !== -1;
        }

        function prepareRemoteAssistSrcdocHtml(html) {
            const rawHtml = String(html || '<!doctype html><html><body style="font-family:Arial;padding:16px;color:#64748b;">暂无可渲染快照</body></html>');
            if (isRemoteAssistSerializedSnapshotHtml(rawHtml)) {
                return stripRemoteAssistUnsafeHtml(rawHtml);
            }
            return sanitizeRemoteAssistSrcdocHtml(rawHtml);
        }

        function applyRemoteAssistScroll(scroll) {
            remoteAssistPanelLastScroll = scroll || null;
            clearRemoteAssistScrollRestoreTimer();
            const currentRoute = getRemoteAssistSnapshotRoute(remoteAssistPanelLastSnapshot);
            const scrollRoute = getRemoteAssistScrollRoute(scroll);
            if (remoteAssistPanelWaitingForRouteSnapshot) {
                logRemoteAssistDebug('scroll_apply_skipped', {
                    reason: 'waiting_for_route_snapshot',
                    current_route: currentRoute,
                    scroll_route: scrollRoute,
                    mode: String(scroll && scroll.mode || 'window')
                });
                return;
            }
            if (scrollRoute && currentRoute && scrollRoute !== currentRoute) {
                logRemoteAssistDebug('scroll_apply_skipped', {
                    reason: 'route_mismatch',
                    current_route: currentRoute,
                    scroll_route: scrollRoute,
                    mode: String(scroll && scroll.mode || 'window')
                });
                return;
            }
            const isRenderReady = remoteAssistPanelLoadedRenderSeq === remoteAssistPanelRenderSeq
                || remoteAssistPanelReadyRenderSeq === remoteAssistPanelRenderSeq;
            if (!isRenderReady) {
                logRemoteAssistDebug('scroll_apply_skipped', {
                    reason: 'render_not_ready',
                    current_route: currentRoute,
                    scroll_route: scrollRoute,
                    loaded_render_seq: remoteAssistPanelLoadedRenderSeq,
                    ready_render_seq: remoteAssistPanelReadyRenderSeq,
                    render_seq: remoteAssistPanelRenderSeq,
                    mode: String(scroll && scroll.mode || 'window')
                });
                return;
            }
            try {
                const frame = document.getElementById('remoteAssistFrame');
                const win = frame && frame.contentWindow;
                if (!frame || !win) {
                    logRemoteAssistDebug('scroll_apply_skipped', {
                        reason: 'frame_missing',
                        current_route: currentRoute,
                        scroll_route: scrollRoute,
                        mode: String(scroll && scroll.mode || 'window')
                    });
                    return;
                }
                const top = Math.max(0, Math.round(scroll && scroll.top || 0));
                const left = Math.max(0, Math.round(scroll && scroll.left || 0));
                const mode = String(scroll && scroll.mode || 'window').toLowerCase();
                withRemoteAssistProgrammaticScroll(function() {
                    if (mode === 'element') {
                        const target = findRemoteAssistSnapshotNode(scroll);
                        if (target) {
                            target.scrollTop = top;
                            target.scrollLeft = left;
                            logRemoteAssistDebug('scroll_apply_element_success', {
                                current_route: currentRoute,
                                scroll_route: scrollRoute,
                                top,
                                left,
                                node_id: String(scroll && scroll.node_id || ''),
                                selector_hint: String(scroll && scroll.selector_hint || '')
                            });
                        } else {
                            logRemoteAssistDebug('scroll_apply_element_missing_target', {
                                current_route: currentRoute,
                                scroll_route: scrollRoute,
                                top,
                                left,
                                node_id: String(scroll && scroll.node_id || ''),
                                selector_hint: String(scroll && scroll.selector_hint || '')
                            });
                        }
                        return;
                    }
                    win.scrollTo(left, top);
                    const doc = win.document;
                    const docEl = doc && doc.documentElement;
                    const body = doc && doc.body;
                    const actualTop = Math.max(0, Math.round(win.scrollY || win.pageYOffset || (docEl && docEl.scrollTop) || (body && body.scrollTop) || 0));
                    const actualLeft = Math.max(0, Math.round(win.scrollX || win.pageXOffset || (docEl && docEl.scrollLeft) || (body && body.scrollLeft) || 0));
                    logRemoteAssistDebug('scroll_apply_window_success', {
                        current_route: currentRoute,
                        scroll_route: scrollRoute,
                        top,
                        left,
                        actual_top: actualTop,
                        actual_left: actualLeft,
                        doc_scroll_top: Math.max(0, Math.round(docEl && docEl.scrollTop || 0)),
                        body_scroll_top: Math.max(0, Math.round(body && body.scrollTop || 0)),
                        scroll_height: Math.max(0, Math.round(docEl && docEl.scrollHeight || body && body.scrollHeight || 0)),
                        client_height: Math.max(0, Math.round(docEl && docEl.clientHeight || body && body.clientHeight || 0))
                    });
                });
            } catch (e) {
                logRemoteAssistDebug('scroll_apply_error', {
                    current_route: currentRoute,
                    scroll_route: scrollRoute,
                    message: String((e && e.message) || e || '')
                });
            }
        }

        function logRemoteAssistDebug(stage, payload) {
            return;
        }

        function getRemoteAssistPerfNow() {
            return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
                ? performance.now()
                : Date.now();
        }

        function getRemoteAssistTraceMeta(payload) {
            const clientEmitTs = Number(payload && payload.client_emit_ts || 0);
            const normalizedClientEmitTs = Number.isFinite(clientEmitTs) && clientEmitTs > 0 ? clientEmitTs : 0;
            const adminRequestTs = Number(payload && payload.admin_request_ts || 0);
            const userRequestReceivedTs = Number(payload && payload.user_request_received_ts || 0);
            const userBuildStartTs = Number(payload && payload.user_snapshot_build_start_ts || 0);
            const userBuildDoneTs = Number(payload && payload.user_snapshot_build_done_ts || 0);
            const userSentTs = Number(payload && payload.user_snapshot_sent_ts || 0);
            return {
                trace_id: String(payload && payload.trace_id || ''),
                client_emit_ts: normalizedClientEmitTs,
                trace_type: String(payload && payload.trace_type || ''),
                trace_reason: String(payload && payload.trace_reason || ''),
                admin_request_ts: Number.isFinite(adminRequestTs) && adminRequestTs > 0 ? adminRequestTs : 0,
                user_request_received_ts: Number.isFinite(userRequestReceivedTs) && userRequestReceivedTs > 0 ? userRequestReceivedTs : 0,
                user_snapshot_build_start_ts: Number.isFinite(userBuildStartTs) && userBuildStartTs > 0 ? userBuildStartTs : 0,
                user_snapshot_build_done_ts: Number.isFinite(userBuildDoneTs) && userBuildDoneTs > 0 ? userBuildDoneTs : 0,
                user_snapshot_sent_ts: Number.isFinite(userSentTs) && userSentTs > 0 ? userSentTs : 0,
                html_bytes: Number(payload && payload.html_bytes || 0)
            };
        }

        function buildRemoteAssistSnapshotTraceTiming(traceMeta, adminTs = Date.now()) {
            const adminRequestTs = Number(traceMeta && traceMeta.admin_request_ts || 0);
            const userRequestReceivedTs = Number(traceMeta && traceMeta.user_request_received_ts || 0);
            const userBuildStartTs = Number(traceMeta && traceMeta.user_snapshot_build_start_ts || 0);
            const userBuildDoneTs = Number(traceMeta && traceMeta.user_snapshot_build_done_ts || 0);
            const userSentTs = Number(traceMeta && traceMeta.user_snapshot_sent_ts || 0);
            return {
                admin_request_ts: adminRequestTs,
                user_request_received_ts: userRequestReceivedTs,
                user_snapshot_build_start_ts: userBuildStartTs,
                user_snapshot_build_done_ts: userBuildDoneTs,
                user_snapshot_sent_ts: userSentTs,
                admin_received_ts: adminTs,
                admin_request_to_received_ms: adminRequestTs > 0 ? Math.max(0, adminTs - adminRequestTs) : 0,
                user_request_to_build_start_ms: userRequestReceivedTs > 0 && userBuildStartTs > 0 ? Math.max(0, userBuildStartTs - userRequestReceivedTs) : 0,
                user_snapshot_build_ms: userBuildStartTs > 0 && userBuildDoneTs > 0 ? Math.max(0, userBuildDoneTs - userBuildStartTs) : 0,
                user_snapshot_send_wait_ms: userBuildDoneTs > 0 && userSentTs > 0 ? Math.max(0, userSentTs - userBuildDoneTs) : 0,
                html_bytes: Number(traceMeta && traceMeta.html_bytes || 0)
            };
        }

        function getRemoteAssistVisibleSignal(doc) {
            const body = doc && doc.body;
            const root = doc && doc.documentElement;
            const scrollHeight = Math.max(
                Number(root && root.scrollHeight || 0),
                Number(body && body.scrollHeight || 0)
            );
            const childCount = Number(body && body.childElementCount || 0);
            const textLength = String(body && (body.innerText || body.textContent) || '').trim().length;
            return {
                scroll_height: scrollHeight,
                child_count: childCount,
                text_length: textLength,
                is_visible: scrollHeight > 0 && (childCount > 0 || textLength > 0)
            };
        }

        function markRemoteAssistRenderReady(renderSeq, scrollPayload, route, prepareMs, isFastPath, renderStartedAt, traceMeta = null, stage = 'load', visibleSignal = null) {
            if (renderSeq !== remoteAssistPanelRenderSeq) return false;
            const frame = document.getElementById('remoteAssistFrame');
            const doc = frame && frame.contentDocument;
            const body = doc && doc.body;
            if (!frame || !doc || !body) return false;
            const nextVisibleSignal = visibleSignal || getRemoteAssistVisibleSignal(doc);
            if (stage !== 'load' && !nextVisibleSignal.is_visible) return false;
            if (remoteAssistPanelReadyRenderSeq === renderSeq) return true;
            remoteAssistPanelReadyRenderSeq = renderSeq;
            clearRemoteAssistRenderReadyTimer();
            const adminReadyTs = Date.now();
            const traceTiming = buildRemoteAssistSnapshotTraceTiming(traceMeta, adminReadyTs);
            if (stage !== 'load') {
                logRemoteAssistDebug('snapshot_render_ready', {
                    route,
                    trace_id: String(traceMeta && traceMeta.trace_id || ''),
                    client_emit_ts: Number(traceMeta && traceMeta.client_emit_ts || 0),
                    admin_ready_ts: adminReadyTs,
                    admin_request_ts: traceTiming.admin_request_ts,
                    user_request_received_ts: traceTiming.user_request_received_ts,
                    user_snapshot_build_start_ts: traceTiming.user_snapshot_build_start_ts,
                    user_snapshot_build_done_ts: traceTiming.user_snapshot_build_done_ts,
                    user_snapshot_sent_ts: traceTiming.user_snapshot_sent_ts,
                    admin_request_to_ready_ms: traceTiming.admin_request_ts > 0 ? Math.max(0, adminReadyTs - traceTiming.admin_request_ts) : 0,
                    user_request_to_build_start_ms: traceTiming.user_request_to_build_start_ms,
                    user_snapshot_build_ms: traceTiming.user_snapshot_build_ms,
                    user_snapshot_send_wait_ms: traceTiming.user_snapshot_send_wait_ms,
                    render_seq: renderSeq,
                    ready_ms: Math.max(0, Math.round(getRemoteAssistPerfNow() - renderStartedAt)),
                    prepare_ms: prepareMs,
                    is_fast_path: !!isFastPath,
                    stage: String(stage || 'early_ready'),
                    scroll_height: Number(nextVisibleSignal.scroll_height || 0),
                    child_count: Number(nextVisibleSignal.child_count || 0),
                    text_length: Number(nextVisibleSignal.text_length || 0)
                });
            }
            setRemoteAssistLoading(false);
            bindRemoteAssistSnapshotFrame(renderSeq);
            applyRemoteAssistScroll(resolveRemoteAssistSnapshotScroll(remoteAssistPanelLastSnapshot) || scrollPayload);
            return true;
        }

        function scheduleRemoteAssistRenderReady(renderSeq, scrollPayload, route, prepareMs, isFastPath, renderStartedAt, traceMeta = null) {
            clearRemoteAssistRenderReadyTimer();
            let attempt = 0;
            let visibleStableFrames = 0;
            const tryMarkReady = function() {
                if (renderSeq !== remoteAssistPanelRenderSeq) {
                    remoteAssistPanelRenderReadyTimer = null;
                    return;
                }
                attempt += 1;
                const frame = document.getElementById('remoteAssistFrame');
                const visibleSignal = getRemoteAssistVisibleSignal(frame && frame.contentDocument);
                visibleStableFrames = visibleSignal.is_visible ? (visibleStableFrames + 1) : 0;
                if (visibleStableFrames >= 2 && markRemoteAssistRenderReady(renderSeq, scrollPayload, route, prepareMs, isFastPath, renderStartedAt, traceMeta, 'early_ready', visibleSignal)) {
                    remoteAssistPanelRenderReadyTimer = null;
                    setTimeout(function() {
                        completeRemoteAssistSnapshotRender(renderSeq);
                    }, 300);
                    return;
                }
                if (attempt >= 60) {
                    remoteAssistPanelRenderReadyTimer = null;
                    completeRemoteAssistSnapshotRender(renderSeq);
                    return;
                }
                remoteAssistPanelRenderReadyTimer = setTimeout(tryMarkReady, 16);
            };
            tryMarkReady();
        }

        function getRemoteAssistWsReadyStateLabel(targetWs) {
            if (!targetWs) return 'NULL';
            if (targetWs.readyState === WebSocket.CONNECTING) return 'CONNECTING';
            if (targetWs.readyState === WebSocket.OPEN) return 'OPEN';
            if (targetWs.readyState === WebSocket.CLOSING) return 'CLOSING';
            if (targetWs.readyState === WebSocket.CLOSED) return 'CLOSED';
            return String(targetWs.readyState);
        }

        function renderRemoteAssistSnapshotNow(snapshot) {
            const frame = document.getElementById('remoteAssistFrame');
            if (!frame) {
                completeRemoteAssistSnapshotRender();
                return;
            }
            const route = getRemoteAssistSnapshotRoute(snapshot);
            const traceMeta = getRemoteAssistTraceMeta(snapshot);
            const adminReceivedTs = Date.now();
            const traceTiming = buildRemoteAssistSnapshotTraceTiming(traceMeta, adminReceivedTs);
            const previousRenderedRoute = getRemoteAssistSnapshotRoute(remoteAssistPanelLastSnapshot);
            if (remoteAssistPanelWaitingForRouteSnapshot && remoteAssistPanelPendingRoute && route && route !== remoteAssistPanelPendingRoute) {
                logRemoteAssistDebug('snapshot_render_dropped_pending_route', {
                    route,
                    trace_id: String(traceMeta.trace_id || ''),
                    admin_request_ts: traceTiming.admin_request_ts,
                    admin_received_ts: adminReceivedTs,
                    pending_route: remoteAssistPanelPendingRoute,
                    waiting: !!remoteAssistPanelWaitingForRouteSnapshot,
                    html_length: String(snapshot && snapshot.html || '').length,
                    html_bytes: traceTiming.html_bytes,
                    truncated: !!(snapshot && snapshot.truncated),
                    node_count: Number(snapshot && snapshot.node_count || 0)
                });
                completeRemoteAssistSnapshotRender();
                return;
            }
            if (remoteAssistPanelWaitingForRouteSnapshot || previousRenderedRoute !== route) {
                logRemoteAssistDebug('snapshot_render_received', {
                    route,
                    trace_id: String(traceMeta.trace_id || ''),
                    client_emit_ts: Number(traceMeta.client_emit_ts || 0),
                    admin_received_ts: adminReceivedTs,
                    admin_request_ts: traceTiming.admin_request_ts,
                    user_request_received_ts: traceTiming.user_request_received_ts,
                    user_snapshot_build_start_ts: traceTiming.user_snapshot_build_start_ts,
                    user_snapshot_build_done_ts: traceTiming.user_snapshot_build_done_ts,
                    user_snapshot_sent_ts: traceTiming.user_snapshot_sent_ts,
                    admin_request_to_received_ms: traceTiming.admin_request_to_received_ms,
                    user_request_to_build_start_ms: traceTiming.user_request_to_build_start_ms,
                    user_snapshot_build_ms: traceTiming.user_snapshot_build_ms,
                    user_snapshot_send_wait_ms: traceTiming.user_snapshot_send_wait_ms,
                    previous_route: previousRenderedRoute,
                    pending_route: remoteAssistPanelPendingRoute,
                    waiting: !!remoteAssistPanelWaitingForRouteSnapshot,
                    html_length: String(snapshot && snapshot.html || '').length,
                    html_bytes: traceTiming.html_bytes,
                    truncated: !!(snapshot && snapshot.truncated),
                    node_count: Number(snapshot && snapshot.node_count || 0)
                });
            }
            clearRemoteAssistPendingRoute(route);
            const scrollPayload = resolveRemoteAssistSnapshotScroll(snapshot);
            const metaText = snapshot && snapshot.truncated
                ? '当前画面已截断，请以当前可见区域为准'
                : '';
            setRemoteAssistMeta(metaText);
            const rawHtml = String(snapshot && snapshot.html || '<!doctype html><html><body style="font-family:Arial;padding:16px;color:#64748b;">暂无可渲染快照</body></html>');
            const prepareStartedAt = getRemoteAssistPerfNow();
            const isFastPath = isRemoteAssistSerializedSnapshotHtml(rawHtml);
            const sanitizedHtml = prepareRemoteAssistSrcdocHtml(rawHtml);
            const prepareMs = Math.max(0, Math.round(getRemoteAssistPerfNow() - prepareStartedAt));
            if (prepareMs >= REMOTE_ASSIST_PREPARE_LOG_THRESHOLD_MS) {
                logRemoteAssistDebug('snapshot_prepare_timing', {
                    route,
                    trace_id: String(traceMeta.trace_id || ''),
                    html_length: rawHtml.length,
                    html_bytes: traceTiming.html_bytes,
                    sanitized_html_length: sanitizedHtml.length,
                    prepare_ms: prepareMs,
                    is_fast_path: !!isFastPath,
                    truncated: !!(snapshot && snapshot.truncated),
                    node_count: Number(snapshot && snapshot.node_count || 0)
                });
            }
            const isSameInFlightFrame = remoteAssistPanelLastHtml === sanitizedHtml
                && previousRenderedRoute === route
                && remoteAssistPanelRenderSeq > 0
                && remoteAssistPanelLoadedRenderSeq !== remoteAssistPanelRenderSeq;
            const canReuseRenderedFrame = remoteAssistPanelLastHtml === sanitizedHtml
                && previousRenderedRoute === route
                && remoteAssistPanelLoadedRenderSeq === remoteAssistPanelRenderSeq;
            remoteAssistPanelLastSnapshot = snapshot || null;
            if (isSameInFlightFrame) {
                logRemoteAssistDebug('inflight_dedupe_hit', {
                    route,
                    trace_id: String(traceMeta.trace_id || ''),
                    html_length: sanitizedHtml.length,
                    html_bytes: traceTiming.html_bytes,
                    prepare_ms: prepareMs,
                    render_seq: remoteAssistPanelRenderSeq
                });
                completeRemoteAssistSnapshotRender();
                return;
            }
            if (canReuseRenderedFrame) {
                setRemoteAssistLoading(false);
                syncRemoteAssistViewport(snapshot);
                applyRemoteAssistScroll(scrollPayload);
                completeRemoteAssistSnapshotRender();
                return;
            }
            remoteAssistPanelLastHtml = sanitizedHtml;
            syncRemoteAssistViewport(snapshot);
            const renderSeq = remoteAssistPanelRenderSeq + 1;
            const renderStartedAt = getRemoteAssistPerfNow();
            remoteAssistPanelRenderSeq = renderSeq;
            remoteAssistPanelLoadedRenderSeq = 0;
            remoteAssistPanelReadyRenderSeq = 0;
            clearRemoteAssistRenderReadyTimer();
            clearRemoteAssistFrameBinding();
            frame.onload = null;
            frame.onload = function() {
                if (renderSeq !== remoteAssistPanelRenderSeq) return;
                remoteAssistPanelLoadedRenderSeq = renderSeq;
                const renderMs = Math.max(0, Math.round(getRemoteAssistPerfNow() - renderStartedAt));
                const adminLoadTs = Date.now();
                if (renderMs >= REMOTE_ASSIST_RENDER_LOG_THRESHOLD_MS) {
                    logRemoteAssistDebug('snapshot_render_timing', {
                        route,
                        trace_id: String(traceMeta.trace_id || ''),
                        client_emit_ts: Number(traceMeta.client_emit_ts || 0),
                        admin_load_ts: adminLoadTs,
                        admin_request_ts: traceTiming.admin_request_ts,
                        admin_request_to_load_ms: traceTiming.admin_request_ts > 0 ? Math.max(0, adminLoadTs - traceTiming.admin_request_ts) : 0,
                        user_request_to_build_start_ms: traceTiming.user_request_to_build_start_ms,
                        user_snapshot_build_ms: traceTiming.user_snapshot_build_ms,
                        user_snapshot_send_wait_ms: traceTiming.user_snapshot_send_wait_ms,
                        render_seq: renderSeq,
                        html_length: sanitizedHtml.length,
                        html_bytes: traceTiming.html_bytes,
                        prepare_ms: prepareMs,
                        render_ms: renderMs,
                        is_fast_path: !!isFastPath
                    });
                }
                const readyBeforeLoad = remoteAssistPanelReadyRenderSeq === renderSeq;
                markRemoteAssistRenderReady(renderSeq, scrollPayload, route, prepareMs, isFastPath, renderStartedAt, traceMeta, 'load', getRemoteAssistVisibleSignal(frame && frame.contentDocument));
                if (readyBeforeLoad) {
                    applyRemoteAssistScroll(resolveRemoteAssistSnapshotScroll(remoteAssistPanelLastSnapshot) || scrollPayload);
                }
                completeRemoteAssistSnapshotRender(renderSeq);
            };
            frame.srcdoc = sanitizedHtml;
            scheduleRemoteAssistRenderReady(renderSeq, scrollPayload, route, prepareMs, isFastPath, renderStartedAt, traceMeta);
        }

        function sendRemoteAssistMessage(type, payload = {}) {
            try {
                if (!remoteAssistPanelWs || remoteAssistPanelWs.readyState !== WebSocket.OPEN) return false;
                remoteAssistPanelWs.send(JSON.stringify({ type, payload }));
                return true;
            } catch (e) {
                return false;
            }
        }

        function requestRemoteAssistSnapshot(reason = 'admin_refresh') {
            if (!remoteAssistPanelSessionId) return;
            if (remoteAssistPanelConsentStatus !== 'accepted') {
                setRemoteAssistMeta('等待用户确认远程指导');
                setRemoteAssistLoading(true, '正在等待用户确认远程指导');
                return;
            }
            setRemoteAssistLoading(true, '正在请求用户页面快照');
            const requestReason = String(reason || 'admin_refresh');
            const adminRequestTs = Date.now();
            remoteAssistPanelSnapshotRequestSeq += 1;
            const traceId = `ras_${adminRequestTs.toString(36)}_${remoteAssistPanelSnapshotRequestSeq.toString(36)}`;
            const payload = {
                reason: requestReason,
                trace_id: traceId,
                trace_type: 'snapshot_request',
                trace_reason: requestReason,
                admin_request_ts: adminRequestTs
            };
            const sent = sendRemoteAssistMessage('snapshot_request', payload);
            if (sent) {
                logRemoteAssistDebug('snapshot_request_sent', {
                    session_id: remoteAssistPanelSessionId,
                    reason: requestReason,
                    trace_id: traceId,
                    admin_request_ts: adminRequestTs,
                    pending_route: remoteAssistPanelPendingRoute,
                    waiting: !!remoteAssistPanelWaitingForRouteSnapshot
                });
            }
            if (!sent) {
                logRemoteAssistDebug('snapshot_request_failed', {
                    session_id: remoteAssistPanelSessionId,
                    reason: requestReason,
                    trace_id: traceId,
                    admin_request_ts: adminRequestTs,
                    pending_route: remoteAssistPanelPendingRoute,
                    waiting: !!remoteAssistPanelWaitingForRouteSnapshot
                });
            }
            if (!sent) {
                setRemoteAssistLoading(false);
                setRemoteAssistMeta('指导连接未就绪，正在等待重连');
            }
        }

        function shouldRequestSnapshotForRemoteAssistProxyEvent(payload) {
            const contentType = String(payload && payload.content_type || '').toLowerCase();
            const normalizedPath = String(payload && payload.normalized_path || '').toLowerCase();
            const fetchDest = String(payload && payload.fetch_dest || '').toLowerCase();
            return remoteAssistPanelWaitingForRouteSnapshot
                || contentType.indexOf('text/html') >= 0
                || contentType.indexOf('application/json') >= 0
                || normalizedPath.indexOf('api/') === 0
                || normalizedPath.indexOf('/api/') >= 0
                || normalizedPath.indexOf('rpc/') === 0
                || normalizedPath.indexOf('/rpc/') >= 0
                || (fetchDest === 'document' && contentType.indexOf('text/') >= 0);
        }

        function handleRemoteAssistProxyEvent(payload) {
            const now = Date.now();
            const proxyTs = Number(payload && payload.proxy_ts || 0);
            const normalizedPath = String(payload && payload.normalized_path || payload && payload.path || '').trim();
            const method = String(payload && payload.method || '').toUpperCase();
            const requestKey = [method, normalizedPath].join(':');
            logRemoteAssistDebug('proxy_event_received', {
                kind: String(payload && payload.kind || ''),
                method,
                path: String(payload && payload.path || ''),
                normalized_path: normalizedPath,
                content_type: String(payload && payload.content_type || ''),
                fetch_dest: String(payload && payload.fetch_dest || ''),
                status: Number(payload && payload.status || 0),
                bytes: Number(payload && payload.bytes || 0),
                upstream_ms: Number(payload && payload.upstream_ms || 0),
                rewrite_ms: Number(payload && payload.rewrite_ms || 0),
                inject_ms: Number(payload && payload.inject_ms || 0),
                total_ms: Number(payload && payload.total_ms || 0),
                proxy_to_admin_ms: proxyTs > 0 ? Math.max(0, now - proxyTs) : 0,
                waiting: !!remoteAssistPanelWaitingForRouteSnapshot,
                pending_route: remoteAssistPanelPendingRoute,
                current_route: getRemoteAssistSnapshotRoute(remoteAssistPanelLastSnapshot)
            });
            if (!remoteAssistPanelSessionId || remoteAssistPanelConsentStatus !== 'accepted') return;
            if (!shouldRequestSnapshotForRemoteAssistProxyEvent(payload)) return;
            if (remoteAssistPanelProxySnapshotRequestKey === requestKey
                && (now - remoteAssistPanelProxySnapshotRequestAt) < REMOTE_ASSIST_PROXY_EVENT_SNAPSHOT_MIN_INTERVAL_MS) {
                return;
            }
            if ((now - remoteAssistPanelProxySnapshotRequestAt) < REMOTE_ASSIST_PROXY_EVENT_SNAPSHOT_MIN_INTERVAL_MS) {
                if (!remoteAssistPanelProxySnapshotTimer) {
                    remoteAssistPanelProxySnapshotTimer = setTimeout(function() {
                        remoteAssistPanelProxySnapshotTimer = null;
                        requestRemoteAssistSnapshot('proxy_event');
                    }, REMOTE_ASSIST_PROXY_EVENT_SNAPSHOT_MIN_INTERVAL_MS - (now - remoteAssistPanelProxySnapshotRequestAt));
                }
                return;
            }
            remoteAssistPanelProxySnapshotRequestKey = requestKey;
            remoteAssistPanelProxySnapshotRequestAt = now;
            clearRemoteAssistProxySnapshotTimer();
            remoteAssistPanelProxySnapshotTimer = setTimeout(function() {
                remoteAssistPanelProxySnapshotTimer = null;
                requestRemoteAssistSnapshot('proxy_event');
            }, REMOTE_ASSIST_PROXY_EVENT_SNAPSHOT_DELAY_MS);
        }

        function reconnectRemoteAssistPanel() {
            const sessionId = String(remoteAssistPanelSessionId || '').trim();
            if (!sessionId) return;
            clearRemoteAssistReconnectTimer();
            clearRemoteAssistRouteSnapshotTimer();
            clearRemoteAssistProxySnapshotTimer();
            stopRemoteAssistHeartbeat();
            remoteAssistPanelPendingRoute = '';
            remoteAssistPanelWaitingForRouteSnapshot = false;
            resetRemoteAssistPendingSnapshotRequest();
            const currentWs = remoteAssistPanelWs;
            remoteAssistPanelWs = null;
            if (currentWs) {
                try {
                    currentWs.close();
                } catch (e) {
                }
            }
            setRemoteAssistLoading(true, '正在重连远程指导');
            setRemoteAssistMeta('指导连接断开，正在重连');
            connectRemoteAssistPanelSocket(sessionId);
        }

        function scheduleRemoteAssistReconnect() {
            clearRemoteAssistReconnectTimer();
            if (!remoteAssistPanelSessionId) return;
            remoteAssistPanelReconnectTimer = setTimeout(() => {
                connectRemoteAssistPanelSocket(remoteAssistPanelSessionId);
            }, 1500);
        }

        async function connectRemoteAssistPanelSocket(sessionId) {
            const wantedSessionId = String(sessionId || '').trim();
            if (!wantedSessionId) return;
            if (remoteAssistPanelWs && (remoteAssistPanelWs.readyState === WebSocket.OPEN || remoteAssistPanelWs.readyState === WebSocket.CONNECTING) && remoteAssistPanelSessionId === wantedSessionId) return;
            clearRemoteAssistReconnectTimer();
            let currentWs = null;
            try {
                currentWs = new WebSocket(await buildRemoteAssistWsUrl(wantedSessionId));
            } catch (error) {
                setRemoteAssistMeta('远程指导连接失败，正在重试');
                logRemoteAssistDebug('ws_ticket_failed', {
                    session_id: wantedSessionId,
                    message: String((error && error.message) || error || '')
                });
                scheduleRemoteAssistReconnect();
                return;
            }
            remoteAssistPanelWs = currentWs;
            currentWs.onopen = function() {
                if (remoteAssistPanelWs !== currentWs) return;
                startRemoteAssistHeartbeat();
            };
            currentWs.onmessage = function(event) {
                if (remoteAssistPanelWs !== currentWs) return;
                try {
                    const data = JSON.parse(event.data || '{}');
                    logRemoteAssistDebug('ws_message_received', {
                        type: String(data && data.type || ''),
                        source: String(data && data.source || ''),
                        session_id: String(data && data.session_id || ''),
                        site: String(data && data.site || ''),
                        has_payload: !!(data && data.payload),
                        current_route: getRemoteAssistSnapshotRoute(remoteAssistPanelLastSnapshot)
                    });
                    if (!data || !data.type) return;
                    if (data.type === 'session_state') {
                        const payload = data.payload || {};
                        const consentStatus = String(payload.consent_status || remoteAssistPanelConsentStatus || 'waiting');
                        remoteAssistPanelConsentStatus = consentStatus;
                        if (consentStatus !== 'accepted') {
                            disconnectRemoteAssistVoiceClient(false, 'closed', true);
                        }
                        updateRemoteAssistVoiceButton();
                        if (consentStatus === 'rejected') {
                            clearRemoteAssistRouteSnapshotTimer();
                            remoteAssistPanelPendingRoute = '';
                            remoteAssistPanelWaitingForRouteSnapshot = false;
                            resetRemoteAssistPendingSnapshotRequest();
                            setRemoteAssistLoading(false);
                            setRemoteAssistMeta('用户已拒绝远程指导');
                            remoteAssistPanelLastSnapshot = null;
                            remoteAssistPanelLastHtml = '';
                            remoteAssistPanelLastScroll = null;
                            resetRemoteAssistFrameDocument(buildRemoteAssistPlaceholderHtml('用户已拒绝远程指导'));
                            return;
                        }
                        if (consentStatus !== 'accepted') {
                            clearRemoteAssistRouteSnapshotTimer();
                            remoteAssistPanelPendingRoute = '';
                            remoteAssistPanelWaitingForRouteSnapshot = false;
                            resetRemoteAssistPendingSnapshotRequest();
                            setRemoteAssistMeta('等待用户确认远程指导');
                            setRemoteAssistLoading(true, '正在等待用户确认远程指导');
                            remoteAssistPanelLastSnapshot = null;
                            remoteAssistPanelLastHtml = '';
                            remoteAssistPanelLastScroll = null;
                            resetRemoteAssistFrameDocument(buildRemoteAssistPlaceholderHtml('正在等待用户确认远程指导'));
                            return;
                        }
                        loadRemoteAssistVoiceState();
                        if (!payload.has_snapshot) {
                            const route = String(payload.last_route || '').trim();
                            setRemoteAssistPendingRoute(route);
                            setRemoteAssistMeta('用户已确认，等待页面快照');
                            setRemoteAssistLoading(true, '用户已确认，正在等待页面快照');
                            requestRemoteAssistSnapshot();
                        }
                        return;
                    }
                    if (data.type === 'snapshot_replace' && data.payload) {
                        renderRemoteAssistSnapshot(data.payload);
                        return;
                    }
                    if (data.type === 'proxy_event' && data.payload) {
                        handleRemoteAssistProxyEvent(data.payload);
                        return;
                    }
                    if (data.type === 'route_changed' && data.payload) {
                        const route = String(data.payload.route || '').trim();
                        const traceMeta = getRemoteAssistTraceMeta(data.payload);
                        logRemoteAssistDebug('route_changed_received', {
                            route,
                            trace_id: String(traceMeta.trace_id || ''),
                            client_emit_ts: Number(traceMeta.client_emit_ts || 0),
                            admin_received_ts: Date.now(),
                            current_route: getRemoteAssistSnapshotRoute(remoteAssistPanelLastSnapshot)
                        });
                        const currentRoute = getRemoteAssistSnapshotRoute(remoteAssistPanelLastSnapshot);
                        if (route && currentRoute && route === currentRoute) {
                            clearRemoteAssistPendingRoute(route);
                            setRemoteAssistLoading(false);
                            return;
                        }
                        setRemoteAssistPendingRoute(route, traceMeta);
                        setRemoteAssistLoading(true, '用户页面切换中，正在等待新页面快照');
                        setRemoteAssistMeta('用户页面切换中，等待新画面');
                        scheduleRemoteAssistRouteSnapshotRequest(route);
                        return;
                    }
                    if (data.type === 'scroll_changed' && data.payload) {
                        logRemoteAssistDebug('scroll_changed_received', {
                            current_route: getRemoteAssistSnapshotRoute(remoteAssistPanelLastSnapshot),
                            scroll_route: getRemoteAssistScrollRoute(data.payload),
                            mode: String(data.payload.mode || 'window'),
                            top: Number(data.payload.top || 0),
                            left: Number(data.payload.left || 0),
                            node_id: String(data.payload.node_id || ''),
                            selector_hint: String(data.payload.selector_hint || '')
                        });
                        nudgeRemoteAssistPendingSnapshot(getRemoteAssistScrollRoute(data.payload), 'scroll_changed');
                        applyRemoteAssistScroll(data.payload);
                        return;
                    }
                    if (data.type === 'click_highlight' && data.payload) {
                        nudgeRemoteAssistPendingSnapshot('', 'click_highlight');
                        flashRemoteAssistSnapshotNode(data.payload);
                    }
                } catch (e) {
                }
            };
            currentWs.onclose = function() {
                if (remoteAssistPanelWs !== currentWs) return;
                stopRemoteAssistHeartbeat();
                clearRemoteAssistRouteSnapshotTimer();
                clearRemoteAssistProxySnapshotTimer();
                remoteAssistPanelWs = null;
                setRemoteAssistLoading(true, '指导连接断开，正在重连');
                setRemoteAssistMeta('指导连接断开，正在重连');
                scheduleRemoteAssistReconnect();
            };
            currentWs.onerror = function(err) {
                logRemoteAssistDebug('admin_socket_error', {
                    session_id: wantedSessionId,
                    type: String((err && err.type) || ''),
                    ready_state: getRemoteAssistWsReadyStateLabel(currentWs)
                });
            };
        }

        async function releaseRemoteAssistPanelSession(sessionId = remoteAssistPanelSessionId) {
            const activeSessionId = String(sessionId || '').trim();
            if (!activeSessionId) return;
            try {
                await fetch(`${API_BASE}/admin/api/remote_assist/close`, {
                    method: 'POST',
                    headers: {
                        ...getHeaders(),
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ session_id: activeSessionId })
                });
            } catch (e) {
                logRemoteAssistDebug('release_remote_assist_session_error', {
                    session_id: activeSessionId,
                    message: String((e && e.message) || e || '')
                });
            }
        }

        async function openRemoteAssist(username) {
            const targetUsername = String(username || '').trim();
            if (!targetUsername) {
                if (typeof showToast === 'function') showToast('远程指导失败: 缺少用户名', 'error');
                return;
            }
            if (focusExistingRemoteAssist(targetUsername)) return;
            if (remoteAssistOpenPromise && remoteAssistOpeningUsername === targetUsername) {
                return remoteAssistOpenPromise;
            }
            const openSeq = ++remoteAssistOpenSeq;
            remoteAssistOpeningUsername = targetUsername;
            remoteAssistOpenPromise = (async () => {
                await closeAkBrowser();
                if (openSeq !== remoteAssistOpenSeq) return;
                await closeRemoteAssistPanel(true, { cancelOpen: false });
                if (openSeq !== remoteAssistOpenSeq) return;
                // 先发 remote_assist/start 触发全局 fetch 拦截器的 TOTP 验证（如有需要），
                // 验证通过且 success=true 才真正打开远程指导面板，避免出现空白等待页。
                let data;
                try {
                    const res = await fetch(`${API_BASE}/admin/api/remote_assist/start`, {
                        method: 'POST',
                        headers: {
                            ...getHeaders(),
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ username: targetUsername })
                    });
                    data = await res.json();
                } catch (e) {
                    if (openSeq === remoteAssistOpenSeq) {
                        logRemoteAssistDebug('open_remote_assist_error', {
                            username: targetUsername,
                            message: String((e && e.message) || e || '')
                        });
                        if (typeof showToast === 'function') {
                            showToast(`远程指导失败: ${e.message}`, 'error');
                        }
                    }
                    return;
                }
                if (openSeq !== remoteAssistOpenSeq) {
                    if (data && data.success && data.session_id) {
                        await releaseRemoteAssistPanelSession(data.session_id);
                    }
                    return;
                }
                if (!data || !data.success) {
                    const msg = (data && (data.message || data.detail)) || '该操作需要 Google 验证码授权';
                    if (typeof showToast === 'function') {
                        showToast(`远程指导失败: ${msg}`, 'error');
                    }
                    return;
                }
                // 验证通过 → 真正打开远程指导面板
                remoteAssistPanelUsername = targetUsername;
                const panel = document.getElementById('remoteAssistPanel');
                const overlay = document.getElementById('remoteAssistOverlay');
                setRemoteAssistTitle(remoteAssistPanelUsername);
                setRemoteAssistMeta('正在发起远程指导请求');
                setRemoteAssistLoading(true, '正在等待用户确认远程指导');
                remoteAssistPanelLastHtml = '';
                remoteAssistPanelLastScroll = null;
                remoteAssistPanelApplyingScrollDepth = 0;
                remoteAssistPanelConsentStatus = 'waiting';
                resetRemoteAssistVoiceUi('', true);
                remoteAssistPanelPendingRoute = '';
                remoteAssistPanelWaitingForRouteSnapshot = false;
                resetRemoteAssistPendingSnapshotRequest();
                clearRemoteAssistScrollRestoreTimer();
                clearRemoteAssistRouteSnapshotTimer();
                clearRemoteAssistProxySnapshotTimer();
                updateRemoteAssistVoiceButton();
                panel.classList.add('open');
                overlay.style.display = getMobileLayoutMedia().matches ? 'none' : 'block';
                resetRemoteAssistFrameDocument(buildRemoteAssistPlaceholderHtml('正在等待用户确认远程指导'));
                remoteAssistPanelSessionId = String(data.session_id || '').trim();
                remoteAssistPanelConsentStatus = String(data.consent_status || 'waiting');
                updateRemoteAssistVoiceButton();
                loadRemoteAssistVoiceState();
                connectRemoteAssistPanelSocket(remoteAssistPanelSessionId);
            })();
            try {
                return await remoteAssistOpenPromise;
            } finally {
                if (openSeq === remoteAssistOpenSeq) {
                    remoteAssistOpenPromise = null;
                    remoteAssistOpeningUsername = '';
                }
            }
        }

        async function closeRemoteAssistPanel(releaseSession = true, options = {}) {
            if (!options || options.cancelOpen !== false) {
                remoteAssistOpenSeq++;
                remoteAssistOpenPromise = null;
                remoteAssistOpeningUsername = '';
            }
            const panel = document.getElementById('remoteAssistPanel');
            const overlay = document.getElementById('remoteAssistOverlay');
            const closingSessionId = remoteAssistPanelSessionId;
            remoteAssistPanelSessionId = '';
            remoteAssistPanelLastSnapshot = null;
            remoteAssistPanelLastHtml = '';
            remoteAssistPanelLastScroll = null;
            remoteAssistPanelApplyingScrollDepth = 0;
            remoteAssistPanelConsentStatus = 'waiting';
            remoteAssistPanelPendingRoute = '';
            remoteAssistPanelWaitingForRouteSnapshot = false;
            resetRemoteAssistPendingSnapshotRequest();
            clearRemoteAssistScrollRestoreTimer();
            clearRemoteAssistRouteSnapshotTimer();
            clearRemoteAssistProxySnapshotTimer();
            clearRemoteAssistReconnectTimer();
            stopRemoteAssistHeartbeat();
            if (remoteAssistPanelWs) {
                try {
                    remoteAssistPanelWs.close();
                } catch (e) {
                }
                remoteAssistPanelWs = null;
            }
            panel.classList.remove('open');
            overlay.style.display = 'none';
            updateRemoteAssistVoiceButton();
            setRemoteAssistLoading(false, '正在等待用户确认远程指导');
            setRemoteAssistMeta('等待用户确认远程指导');
            resetRemoteAssistFrameDocument('<!doctype html><html><body></body></html>');
            if (releaseSession && closingSessionId) {
                await releaseRemoteAssistPanelSession(closingSessionId);
            }
            await disconnectRemoteAssistVoiceClient(false, 'closed', true);
        }

        function refreshAkBrowser() {
            const frame = document.getElementById('akBrowserFrame');
            if (!frame || frame.src === 'about:blank') return;
            setAkBrowserLoading(true, getAkBrowserCurrentUsername());
            frame.src = `${API_BASE}/admin/ak-web/pages/account/login.html`;
        }

        async function closeAkBrowser() {
            const panel = document.getElementById('akBrowserPanel');
            const overlay = document.getElementById('akBrowserOverlay');
            const frame = document.getElementById('akBrowserFrame');
            const stageFrame = document.getElementById('akBrowserStageFrame');
            const closingAssistSessionId = akAssistSessionId;
            akBrowserLoadSeq++;
            clearAkBrowserSwipeBinding();
            if (akBrowserRetryTimer) {
                clearTimeout(akBrowserRetryTimer);
                akBrowserRetryTimer = null;
            }
            panel.classList.remove('open');
            overlay.style.display = 'none';
            if (stageFrame) {
                stageFrame.style.width = '100%';
                stageFrame.style.height = '100%';
            }
            setAkBrowserLoading(false);
            frame.onload = null;
            frame.src = 'about:blank';
            setAkBrowserMode('browser');
            await releaseAkAssistSession(closingAssistSessionId);
        }

        Object.assign(window, {
            openAkBrowser,
            closeAkBrowser,
            refreshAkBrowser,
            openRemoteAssist,
            closeRemoteAssistPanel,
            reconnectRemoteAssistPanel,
            toggleRemoteAssistVoice,
            toggleRemoteAssistVoiceMute,
            syncRemoteAssistViewport,
        });

        window.AKRemoteAssistPanel = {
            openAkBrowser,
            closeAkBrowser,
            refreshAkBrowser,
            openRemoteAssist,
            closeRemoteAssistPanel,
            reconnectRemoteAssistPanel,
            toggleRemoteAssistVoice,
            toggleRemoteAssistVoiceMute,
            syncRemoteAssistViewport,
        };
})();
