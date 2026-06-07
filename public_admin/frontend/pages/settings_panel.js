(function() {
    'use strict';

    if (window.AKAdminSettingsPanelLoaded && window.AKAdminSettingsPanel) return;
    window.AKAdminSettingsPanelLoaded = true;

    // Settings panel module. Loaded only when the settings panel is opened.

        // ===== 代理池管理 =====
        const SETTINGS_POLL_OWNER = 'panel:settings';
        let ppRefreshTimer = null;
        let ppRefreshEnabled = false;
        let ppCurrentView = 'slots';
        let ppCachedNodes = [];
        let settingsPollingRegistered = false;

        function setupSettingsPollingRegistry() {
            const registry = window.AKPollingRegistry;
            if (!registry || settingsPollingRegistered) return registry || null;
            settingsPollingRegistered = true;
            registry.register({
                id: 'settings.proxy-pool-status',
                owner: SETTINGS_POLL_OWNER,
                intervalMs: 5000,
                jitterMs: 700,
                immediate: false,
                dedupeKey: 'GET:/admin/api/proxy_pool/status',
                runWhen: function() {
                    return ppRefreshEnabled && shouldRunAdminPanelPoll('settings');
                },
                task: loadProxyPoolStatus
            });
            registry.register({
                id: 'settings.load-balancer-light',
                owner: SETTINGS_POLL_OWNER,
                intervalMs: 8000,
                jitterMs: 900,
                immediate: false,
                dedupeKey: 'GET:/api/dispatcher/light',
                runWhen: function() {
                    return lbRefreshEnabled && shouldRunAdminPanelPoll('settings') && isSuperAdmin();
                },
                task: refreshLbLightStatus
            });
            registry.register({
                id: 'settings.remote-voice-usage',
                owner: SETTINGS_POLL_OWNER,
                intervalMs: 8000,
                jitterMs: 900,
                immediate: false,
                dedupeKey: 'GET:/admin/api/remote_voice/usage',
                runWhen: function() {
                    return remoteVoiceRefreshEnabled && shouldRunAdminPanelPoll('settings') && isSuperAdmin();
                },
                task: loadRemoteVoicePanel
            });
            return registry;
        }

        function startSettingsPollingOwner() {
            const registry = setupSettingsPollingRegistry();
            if (registry) registry.startOwner(SETTINGS_POLL_OWNER);
            return !!registry;
        }

        function stopSettingsPollingOwner() {
            if (window.AKPollingRegistry) window.AKPollingRegistry.stopOwner(SETTINGS_POLL_OWNER);
        }

        async function loadProxyPoolStatus() {
            if (!shouldRunAdminPanelPoll('settings')) return;
            try {
                const res = await fetch(`${API_BASE}/admin/api/proxy_pool/status`, {
                    headers: { 'Authorization': `Bearer ${sessionStorage.getItem('admin_token')}` }
                });
                const data = await res.json();
                if (data.available === false) {
                    document.getElementById('proxyPoolStatus').textContent = '模块未加载';
                    document.getElementById('proxyPoolStatus').style.background = 'rgba(255,165,2,0.2)';
                    document.getElementById('proxyPoolStatus').style.color = 'var(--accent-yellow)';
                    document.getElementById('ppRunningInfo').style.display = 'none';
                    return;
                }
                const pool = data.pool;

                // 更新当前路由
                const routeEl = document.getElementById('ppLastRoute');
                const lastRoute = data.last_route || '';
                if (lastRoute) {
                    const isProxy = lastRoute.includes('代理');
                    routeEl.textContent = `当前: ${lastRoute}`;
                    routeEl.style.background = isProxy ? 'rgba(0,200,255,0.15)' : 'rgba(0,255,136,0.15)';
                    routeEl.style.color = isProxy ? '#00c8ff' : 'var(--accent-green)';
                } else {
                    routeEl.textContent = '';
                }

                if (pool && pool.running) {
                    document.getElementById('proxyPoolStatus').textContent = `运行中 (${pool.alive_slots}/${pool.total_slots})`;
                    document.getElementById('proxyPoolStatus').style.background = 'rgba(0,255,136,0.2)';
                    document.getElementById('proxyPoolStatus').style.color = 'var(--accent-green)';
                    document.getElementById('ppRunningInfo').style.display = 'block';

                    document.getElementById('ppTotalReq').textContent = pool.total_requests;
                    document.getElementById('ppTotalSuccess').textContent = pool.total_success;
                    document.getElementById('ppTotalFail').textContent = pool.total_fail;
                    document.getElementById('ppSuccessRate').textContent = pool.success_rate;
                    document.getElementById('ppRateLimitCur').textContent = pool.current_rate_limit;
                    document.getElementById('ppTotalNodes').textContent = pool.total_nodes;

                    // 节点分级统计
                    const tiers = pool.node_tiers || {};
                    document.getElementById('ppTierT1').textContent = tiers.good || 0;
                    document.getElementById('ppTierT2').textContent = tiers.ok || 0;
                    document.getElementById('ppTierT3').textContent = tiers.bad || 0;
                    document.getElementById('ppReadyPool').textContent = tiers.ready_pool || 0;
                    document.getElementById('ppTierInfo').style.display = 'flex';

                    // 直连状态
                    const direct = data.direct || {};
                    const ppDirectEl = document.getElementById('ppDirectInfo');
                    if (direct.prefer_direct) {
                        ppDirectEl.style.display = 'block';
                        const reqMin = direct.direct_req_1min || 0;
                        const rateLim = direct.direct_rate_limit || 4;
                        const rateInfo = `(${reqMin}/${rateLim}/min)`;
                        if (direct.is_cooling) {
                            ppDirectEl.innerHTML = `<span style="color:var(--accent-yellow);">🟡 直连冷却中 (${Math.round(direct.cooldown_remaining)}s)，走代理 ${rateInfo}</span>`;
                        } else if (reqMin >= rateLim) {
                            ppDirectEl.innerHTML = `<span style="color:var(--accent-yellow);">🟡 直连限速中，走代理 ${rateInfo}</span>`;
                        } else {
                            ppDirectEl.innerHTML = `<span style="color:var(--accent-green);">🟢 优先直连中 ${rateInfo}</span>`;
                        }
                    } else {
                        ppDirectEl.style.display = 'none';
                    }

                    renderPPSlots(pool.slots || []);
                    ppCachedNodes = pool.nodes || [];
                    if (ppCurrentView === 'nodes') renderPPNodes(ppCachedNodes);
                    startProxyPoolRefresh();
                } else {
                    ppRefreshEnabled = false;
                    document.getElementById('proxyPoolStatus').textContent = '已加载·未启用';
                    document.getElementById('proxyPoolStatus').style.background = 'rgba(255,71,87,0.2)';
                    document.getElementById('proxyPoolStatus').style.color = 'var(--accent-red)';
                    document.getElementById('ppRunningInfo').style.display = 'none';
                    if (ppRefreshTimer) { clearInterval(ppRefreshTimer); ppRefreshTimer = null; }
                }
            } catch (e) {
                console.error('加载代理池状态失败:', e);
            }
        }

        function startProxyPoolRefresh() {
            if (!shouldRunAdminPanelPoll('settings')) return;
            ppRefreshEnabled = true;
            if (startSettingsPollingOwner()) return;
            if (ppRefreshTimer) return;
            ppRefreshTimer = setInterval(() => {
                if (shouldRunAdminPanelPoll('settings')) loadProxyPoolStatus();
            }, 5000);
        }

        function stopProxyPoolRefresh() {
            ppRefreshEnabled = false;
            if (ppRefreshTimer) {
                clearInterval(ppRefreshTimer);
                ppRefreshTimer = null;
            }
        }

        function stopSettingsPanelRefresh() {
            stopSettingsPollingOwner();
            stopSubAdminStatusRefresh();
            stopLbRefresh();
            stopRemoteVoiceRefresh();
            stopProxyPoolRefresh();
        }

        function startSettingsPanelRefresh() {
            if (!shouldRunAdminPanelPoll('settings')) return;
            startSettingsPollingOwner();
            loadSubAdminStatus({ refreshSettingModules: false });
            startSubAdminStatusRefresh();
            if (!isSuperAdmin()) return;
            loadLbStatus();
            startLbRefresh();
            loadRemoteVoicePanel();
            startRemoteVoiceRefresh();
            loadSubscriptionGroups();
        }

        function renderPPSlots(slots) {
            const container = document.getElementById('ppSlotList');
            if (!slots.length) { container.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">无槽位</span>'; return; }
            container.innerHTML = slots.map(s => {
                const statusColor = s.alive ? (s.status === 'blocked' ? 'var(--accent-yellow)' : 'var(--accent-green)') : 'var(--accent-red)';
                const statusText = s.alive ? (s.status === 'blocked' ? '冷却中' : '在线') : '离线';
                const statusDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};margin-right:6px;"></span>`;
                const tierColor = s.node_tier === 'T1' ? 'var(--accent-green)' : s.node_tier === 'T3' ? 'var(--accent-red)' : 'var(--accent-yellow)';
                const tierBadge = `<span style="color:${tierColor};font-size:10px;font-weight:bold;padding:1px 4px;border:1px solid ${tierColor};border-radius:3px;margin-left:4px;">${escapeHtml(s.node_tier || '?')}</span>`;
                const cooldownInfo = s.cooldown_left > 0 ? `<span style="color:var(--accent-yellow);margin-left:8px;">⏳ ${s.cooldown_left}s</span>` : '';
                const errorInfo = s.last_error ? `<div style="color:var(--accent-red);font-size:11px;margin-top:3px;opacity:0.8;">最近错误: ${escapeHtml(s.last_error)}</div>` : '';
                const blockedInfo = s.blocked_count > 0 ? `<span style="color:var(--accent-yellow);">🚫${s.blocked_count}</span>` : '';
                const failStreak = s.consecutive_fails > 0 ? `<span style="color:var(--accent-red);">连败${s.consecutive_fails}</span>` : '';
                return `<div style="padding:8px 12px;background:var(--bg-primary);border-radius:6px;border:1px solid var(--border);margin-bottom:4px;font-size:12px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">
                        <span>${statusDot}<strong>Slot ${escapeHtml(s.slot_id || '')}</strong> <span style="color:${statusColor};font-size:11px;">[${statusText}]</span>${tierBadge} → ${escapeHtml(s.node || '-')} <span style="color:var(--text-secondary);font-size:11px;">:${escapeHtml(s.port || '')}</span>${cooldownInfo}</span>
                        <span style="color:var(--text-secondary);">${s.requests_1min}/min | ${s.success}✓ ${s.fail}✗ | ${s.success_rate} ${blockedInfo} ${failStreak}</span>
                    </div>
                    ${errorInfo}
                </div>`;
            }).join('');
        }

        function switchPPView(view) {
            ppCurrentView = view;
            const slotsBtn = document.getElementById('ppViewSlots');
            const nodesBtn = document.getElementById('ppViewNodes');
            const slotList = document.getElementById('ppSlotList');
            const nodeList = document.getElementById('ppNodeList');
            if (view === 'slots') {
                slotsBtn.style.background = 'rgba(0,200,255,0.2)';
                slotsBtn.style.borderColor = '#00c8ff';
                slotsBtn.style.color = '#00c8ff';
                nodesBtn.style.background = 'transparent';
                nodesBtn.style.borderColor = 'var(--border)';
                nodesBtn.style.color = 'var(--text-secondary)';
                slotList.style.display = '';
                nodeList.style.display = 'none';
            } else {
                nodesBtn.style.background = 'rgba(0,200,255,0.2)';
                nodesBtn.style.borderColor = '#00c8ff';
                nodesBtn.style.color = '#00c8ff';
                slotsBtn.style.background = 'transparent';
                slotsBtn.style.borderColor = 'var(--border)';
                slotsBtn.style.color = 'var(--text-secondary)';
                slotList.style.display = 'none';
                nodeList.style.display = '';
                renderPPNodes(ppCachedNodes);
            }
        }

        function renderPPNodes(nodes) {
            const container = document.getElementById('ppNodeList');
            if (!nodes.length) { container.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">无节点数据</span>'; return; }
            container.innerHTML = nodes.map((n, i) => {
                const tierColor = n.tier === 'T1' ? 'var(--accent-green)' : n.tier === 'T3' ? 'var(--accent-red)' : 'var(--accent-yellow)';
                const tierBadge = `<span style="color:${tierColor};font-size:10px;font-weight:bold;padding:1px 4px;border:1px solid ${tierColor};border-radius:3px;">${escapeHtml(n.tier || '')}</span>`;
                const inUseBadge = n.in_use ? '<span style="color:#00c8ff;font-size:10px;padding:1px 4px;border:1px solid #00c8ff;border-radius:3px;margin-left:4px;">使用中</span>' : '';
                const verifiedIcon = n.verified ? '✅' : (n.fail_count > 0 ? '❌' : '⏳');
                const latencyText = n.latency > 0 ? `<span style="color:${n.latency < 500 ? 'var(--accent-green)' : n.latency < 1500 ? 'var(--accent-yellow)' : 'var(--accent-red)'};">${Math.round(n.latency)}ms</span>` : '<span style="color:var(--text-secondary);">-</span>';
                const failInfo = n.fail_count > 0 ? `<span style="color:var(--accent-red);margin-left:6px;">失败${n.fail_count}次</span>` : '';
                const bgColor = n.in_use ? 'rgba(0,200,255,0.05)' : 'var(--bg-primary)';
                const borderColor = n.in_use ? 'rgba(0,200,255,0.3)' : 'var(--border)';
                return `<div style="padding:6px 12px;background:${bgColor};border-radius:6px;border:1px solid ${borderColor};margin-bottom:3px;font-size:12px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">
                        <span>${verifiedIcon} ${tierBadge}${inUseBadge} <strong style="margin-left:4px;">${escapeHtml(n.name || '')}</strong> <span style="color:var(--text-secondary);font-size:11px;">${escapeHtml(n.type || '')} | ${escapeHtml(n.host || '')}:${Number(n.port || 0)}</span></span>
                        <span style="color:var(--text-secondary);">延迟: ${latencyText}${failInfo}</span>
                    </div>
                </div>`;
            }).join('');
        }


        // ===== 负载均衡管理 =====
        let lbRefreshTimer = null;
        let lbData = null;
        let lbMetaData = null;
        let lbLightApiAvailable = true;
        let remoteVoiceRefreshTimer = null;
        let lbRefreshEnabled = false;
        let remoteVoiceRefreshEnabled = false;

        function mergeLbStatusData(lightData, metaData) {
            const previousExits = {};
            ((lbData && Array.isArray(lbData.exits)) ? lbData.exits : []).forEach(ex => {
                previousExits[Number(ex.index || 0)] = ex;
            });
            const nodeMeta = {};
            ((metaData && Array.isArray(metaData.node_meta)) ? metaData.node_meta : []).forEach(item => {
                nodeMeta[Number(item.index || 0)] = item;
            });
            const exits = ((lightData && Array.isArray(lightData.exits)) ? lightData.exits : []).map(ex => {
                const index = Number(ex.index || 0);
                return Object.assign({}, previousExits[index] || {}, ex, nodeMeta[index] || {});
            });
            return Object.assign({}, metaData || {}, lightData || {}, {
                singbox: (metaData && metaData.singbox) || (lbData && lbData.singbox) || null,
                exits
            });
        }

        async function loadLbStatus(options = {forceMeta: true}) {
            if (!shouldRunAdminPanelPoll('settings')) return;
            try {
                if (!lbLightApiAvailable) {
                    const res = await fetch(`${API_BASE}/api/dispatcher/full`);
                    const data = await res.json();
                    lbData = data;
                    renderLbStatus(data);
                    renderSingboxStatus(data.singbox);
                    return;
                }
                const forceMeta = options.forceMeta !== false || !lbMetaData;
                const metaPromise = forceMeta
                    ? fetch(`${API_BASE}/api/dispatcher/meta${forceMeta ? '?force_refresh=true' : ''}`).then(res => res.json())
                    : Promise.resolve(lbMetaData);
                const lightPromise = fetch(`${API_BASE}/api/dispatcher/light`).then(res => res.json());
                const [meta, light] = await Promise.all([metaPromise, lightPromise]);
                lbMetaData = meta || lbMetaData;
                const data = mergeLbStatusData(light, lbMetaData);
                lbData = data;
                renderLbStatus(data);
                renderSingboxStatus(data.singbox);
            } catch (e) {
                try {
                    lbLightApiAvailable = false;
                    const res = await fetch(`${API_BASE}/api/dispatcher/full`);
                    const data = await res.json();
                    lbData = data;
                    renderLbStatus(data);
                    renderSingboxStatus(data.singbox);
                } catch (fallbackError) {
                    console.error('加载负载均衡状态失败', fallbackError);
                }
            }
        }

        async function refreshLbLightStatus() {
            if (!shouldRunAdminPanelPoll('settings')) return;
            if (!lbLightApiAvailable) {
                loadLbStatus();
                return;
            }
            try {
                const res = await fetch(`${API_BASE}/api/dispatcher/light`);
                const light = await res.json();
                const data = mergeLbStatusData(light, lbMetaData);
                lbData = data;
                renderLbStatus(data);
            } catch (e) {
                loadLbStatus();
            }
        }

        function renderSingboxStatus(sb) {
            const stateEl = document.getElementById('lbSbState');
            const nodesEl = document.getElementById('lbSbNodes');
            const configEl = document.getElementById('lbSbConfig');
            if (!sb) return;
            if (sb.active) {
                stateEl.innerHTML = `<span style="color:#00ff88;">● 运行中</span> <span style="color:var(--text-secondary);">(PID: ${sb.pid})</span> <button onclick="lbReloadSingbox()" style="margin-left:8px;background:rgba(102,126,234,0.2);color:#667eea;border:1px solid rgba(102,126,234,0.3);border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;font-weight:bold;">重启</button>`;
            } else if (sb.installed) {
                stateEl.innerHTML = `<span style="color:#ff4757;">● 已停止</span> <button onclick="lbStartSingbox()" style="margin-left:8px;background:#00ff88;color:#000;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;font-weight:bold;">启动</button>`;
            } else {
                stateEl.innerHTML = `<span style="color:#ffa502;">● 未安装</span>`;
            }
            nodesEl.textContent = sb.nodes_count ? `节点: ${sb.nodes_count}` : '';
            configEl.textContent = sb.config_exists ? sb.config_path : '配置文件不存在';
        }

        function startLbRefresh() {
            if (!shouldRunAdminPanelPoll('settings')) return;
            lbRefreshEnabled = true;
            if (startSettingsPollingOwner()) return;
            if (lbRefreshTimer) return;
            lbRefreshTimer = setInterval(() => {
                if (shouldRunAdminPanelPoll('settings')) refreshLbLightStatus();
            }, 8000);
        }

        function stopLbRefresh() {
            lbRefreshEnabled = false;
            if (lbRefreshTimer) { clearInterval(lbRefreshTimer); lbRefreshTimer = null; }
        }

        function startRemoteVoiceRefresh() {
            if (!shouldRunAdminPanelPoll('settings')) return;
            remoteVoiceRefreshEnabled = true;
            if (startSettingsPollingOwner()) return;
            if (remoteVoiceRefreshTimer) return;
            remoteVoiceRefreshTimer = setInterval(() => {
                if (shouldRunAdminPanelPoll('settings')) loadRemoteVoicePanel();
            }, 8000);
        }

        function stopRemoteVoiceRefresh() {
            remoteVoiceRefreshEnabled = false;
            if (remoteVoiceRefreshTimer) {
                clearInterval(remoteVoiceRefreshTimer);
                remoteVoiceRefreshTimer = null;
            }
        }

        function formatRemoteVoiceTime(value) {
            if (!value) return '-';
            try {
                return new Date(Number(value) * 1000).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
            } catch (e) {
                return '-';
            }
        }

        function formatRemoteVoiceDuration(totalSeconds) {
            const seconds = Math.max(0, parseInt(totalSeconds || 0, 10) || 0);
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            if (hours > 0) return `${hours}小时${String(minutes).padStart(2, '0')}分${String(secs).padStart(2, '0')}秒`;
            if (minutes > 0) return `${minutes}分${String(secs).padStart(2, '0')}秒`;
            return `${secs}秒`;
        }

        function getRemoteVoiceStatusMeta(status) {
            const current = String(status || '').trim().toLowerCase();
            const mapping = {
                reserved: {label: '已预留', color: '#a78bfa', phase: '等待分配'},
                ringing: {label: '振铃中', color: '#00d4ff', phase: '等待用户接听'},
                connecting: {label: '连接中', color: '#ffa502', phase: '正在建立语音链路'},
                active: {label: '通话中', color: '#00ff88', phase: '语音已建立'},
                rejected: {label: '已拒绝', color: '#ff6b81', phase: '用户拒绝'},
                timeout: {label: '超时', color: '#ff4757', phase: '等待超时'},
                closed: {label: '已关闭', color: '#94a3b8', phase: '管理员或系统关闭'},
                failed: {label: '失败', color: '#ff4757', phase: '链路异常结束'}
            };
            return mapping[current] || {label: current || '-', color: '#94a3b8', phase: '-'};
        }

        function renderRemoteVoicePanel(data) {
            if (!data) return;
            document.getElementById('rvMaxSessions').textContent = data.max_active_sessions ?? '-';
            document.getElementById('rvCurrentSessions').textContent = data.current_sessions ?? 0;
            document.getElementById('rvActiveSessions').textContent = data.active_sessions ?? 0;
            document.getElementById('rvAvailableSlots').textContent = data.available_slots ?? 0;
            document.getElementById('rvSummary').textContent = `${data.current_sessions || 0}/${data.max_active_sessions || 0} 路 | 振铃 ${data.ringing_sessions || 0} | 通话 ${data.active_sessions || 0}`;
            const updatedMeta = [];
            if (data.updated_by) updatedMeta.push(`更新人: ${data.updated_by}`);
            if (data.updated_at) updatedMeta.push(`更新时间: ${formatRemoteVoiceTime(data.updated_at)}`);
            document.getElementById('rvUpdatedMeta').textContent = updatedMeta.join(' · ');

            const body = document.getElementById('rvSessionTableBody');
            const sessions = Array.isArray(data.sessions) ? data.sessions : [];
            if (!sessions.length) {
                body.innerHTML = '<tr><td colspan="7" style="padding: 18px 12px; text-align: center; color: var(--text-secondary);">当前没有占用名额的实时语音会话</td></tr>';
                return;
            }
            body.innerHTML = sessions.map(item => {
                const meta = getRemoteVoiceStatusMeta(item.status);
                const heartbeatAge = item.last_heartbeat_age_seconds;
                const heartbeatText = heartbeatAge === null || heartbeatAge === undefined ? '-' : `${heartbeatAge} 秒前`;
                return `
                    <tr>
                        <td style="padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text-primary);">${escapeHtml(item.admin_name || '-')}</td>
                        <td style="padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text-primary);">${escapeHtml(item.user_name || '-')}</td>
                        <td style="padding: 10px 12px; border-bottom: 1px solid var(--border);"><span style="display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:999px; background:${meta.color}22; color:${meta.color}; font-size:12px; font-weight:bold;">${escapeHtml(meta.label)}</span></td>
                        <td style="padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text-secondary);">${escapeHtml(formatRemoteVoiceTime(item.started_at))}</td>
                        <td style="padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text-primary);">${escapeHtml(formatRemoteVoiceDuration(item.duration_seconds))}</td>
                        <td style="padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text-secondary);">${escapeHtml(meta.phase)}</td>
                        <td style="padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text-secondary);">${escapeHtml(heartbeatText)}</td>
                    </tr>
                `;
            }).join('');
        }

        async function loadRemoteVoicePanel() {
            if (!shouldRunAdminPanelPoll('settings')) return;
            if (!isSuperAdmin()) return;
            try {
                const res = await fetch(`${API_BASE}/admin/api/remote_voice/usage`, { headers: getHeaders() });
                const data = await res.json();
                if (!res.ok || data.success === false) {
                    throw new Error(data.message || '加载实时语音数据失败');
                }
                renderRemoteVoicePanel(data);
            } catch (e) {
                document.getElementById('rvSummary').textContent = '加载失败';
                document.getElementById('rvSessionTableBody').innerHTML = `<tr><td colspan="7" style="padding: 18px 12px; text-align: center; color: var(--accent-red);">${escapeHtml(e.message || '加载实时语音数据失败')}</td></tr>`;
            }
        }

        function showRemoteVoiceLimitModal() {
            const current = document.getElementById('rvMaxSessions').textContent || '10';
            const content = `
                <div style="margin-bottom:12px;">
                    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">
                        控制当前系统允许同时占用名额的实时语音会话数量，超限时管理员发起会收到稍后重试提示。
                    </div>
                    <div style="display:flex;flex-direction:column;gap:8px;">
                        <label style="font-size:13px;color:var(--text-primary);">实时语音并发上限:</label>
                        <input id="remoteVoiceLimitInput" type="number" min="1" step="1" value="${current}"
                            style="background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-primary);font-size:14px;width:100%;">
                    </div>
                    <div style="display:flex;gap:8px;margin-top:12px;">
                        <button onclick="setRemoteVoiceLimit(5)" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(255,165,0,0.3);background:rgba(255,165,0,0.1);color:#ffa502;cursor:pointer;font-size:12px;">5路</button>
                        <button onclick="setRemoteVoiceLimit(10)" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(0,212,255,0.3);background:rgba(0,212,255,0.1);color:var(--accent);cursor:pointer;font-size:12px;">10路</button>
                        <button onclick="setRemoteVoiceLimit(20)" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(0,255,136,0.3);background:rgba(0,255,136,0.1);color:#00ff88;cursor:pointer;font-size:12px;">20路</button>
                        <button onclick="setRemoteVoiceLimit(30)" style="flex:1;padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:12px;">30路</button>
                    </div>
                </div>
            `;
            showModal('🎙️ 调整实时语音并发上限', content, async () => {
                const val = parseInt(document.getElementById('remoteVoiceLimitInput')?.value || '10', 10);
                await setRemoteVoiceLimit(val);
            }, '应用');
        }

        async function setRemoteVoiceLimit(value) {
            try {
                const res = await fetch(`${API_BASE}/admin/api/remote_voice/config`, {
                    method: 'POST',
                    headers: Object.assign({ 'Content-Type': 'application/json' }, getHeaders()),
                    body: JSON.stringify({ max_active_sessions: value })
                });
                const data = await res.json();
                showToast(data.message || (data.success ? '设置成功' : '设置失败'), res.ok ? 'success' : 'error');
                if (!res.ok || data.success === false) return;
                closeModal();
                renderRemoteVoicePanel(data);
            } catch (e) {
                showToast('设置失败: ' + e.message, 'error');
            }
        }

        function formatLbLatency(ex) {
            if (ex.latency_probing) return { text: '测速中...', color: '#00d4ff' };
            const latency = ex.latency_ms;
            if (latency === null || latency === undefined) {
                if (ex.latency_checked_at || ex.latency_probe_failures > 0) {
                    return { text: '测速失败', color: '#ff4757' };
                }
                return { text: '未测速', color: 'var(--text-secondary)' };
            }
            if (latency < 100) return { text: `${latency}ms`, color: '#00ff88' };
            if (latency < 300) return { text: `${latency}ms`, color: '#00d4ff' };
            return { text: `${latency}ms`, color: '#ffa502' };
        }

        function formatLbExitIp(ex, healthColor) {
            if (ex.exit_ip) {
                return { text: ex.exit_ip, color: healthColor, title: ex.exit_ip, badge: '' };
            }
            if (ex.ip_detecting) {
                return {
                    text: '检测中...',
                    color: '#00d4ff',
                    title: '出口IP检测中',
                    badge: `<span style="display:inline-flex;align-items:center;margin-left:6px;padding:1px 6px;border-radius:999px;font-size:10px;color:#001018;background:rgba(0,212,255,0.85);font-weight:bold;">检测中</span>`
                };
            }
            if (ex.ip_detect_checked_at || ex.ip_detect_failures > 0) {
                const err = ex.ip_detect_last_error ? ` | ${ex.ip_detect_last_error}` : '';
                return {
                    text: '检测失败',
                    color: '#ff4757',
                    title: `上次检测: ${ex.ip_detect_checked_at || '-'}${err}`,
                    badge: `<span style="display:inline-flex;align-items:center;margin-left:6px;padding:1px 6px;border-radius:999px;font-size:10px;color:#fff;background:rgba(255,71,87,0.85);font-weight:bold;">失败${ex.ip_detect_failures ? '×' + ex.ip_detect_failures : ''}</span>`
                };
            }
            return { text: '未检测', color: 'var(--text-secondary)', title: '暂未开始出口IP检测', badge: '' };
        }

        function getLbExitIndex(ex, fallbackIndex) {
            const index = Number(ex && ex.index);
            return Number.isFinite(index) ? index : fallbackIndex;
        }

        function getLbExitLatencyNumber(ex) {
            const value = ex && ex.latency_ms;
            if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
            if (typeof value === 'string' && value.trim() !== '') {
                const latency = Number(value);
                return Number.isFinite(latency) && latency >= 0 ? latency : null;
            }
            return null;
        }

        function getLbExitLatencySortMeta(ex) {
            if (ex && (ex.latency_probe_failures > 0 || ex.latency_probe_error)) {
                return {rank: 2, latency: Number.POSITIVE_INFINITY};
            }
            const latency = getLbExitLatencyNumber(ex);
            if (latency !== null) return {rank: 0, latency};
            if (ex && ex.latency_probing) return {rank: 1, latency: Number.POSITIVE_INFINITY};
            if (ex && ex.latency_checked_at) {
                return {rank: 2, latency: Number.POSITIVE_INFINITY};
            }
            return {rank: 1, latency: Number.POSITIVE_INFINITY};
        }

        function isLbExitTemporarilyDisabled(ex) {
            return !!(ex && (ex.frozen || ex.temporarily_disabled || ex.disabled || ex.enabled === false || ex.healthy === false));
        }

        function sortLbExitsForDisplay(exits) {
            return exits.map((ex, originalIndex) => ({ex, originalIndex})).sort((a, b) => {
                const aDirect = a.ex && a.ex.type === 'direct';
                const bDirect = b.ex && b.ex.type === 'direct';
                if (aDirect !== bDirect) return aDirect ? -1 : 1;
                const aDisabled = isLbExitTemporarilyDisabled(a.ex);
                const bDisabled = isLbExitTemporarilyDisabled(b.ex);
                if (aDisabled !== bDisabled) return aDisabled ? 1 : -1;
                const aLatency = getLbExitLatencySortMeta(a.ex);
                const bLatency = getLbExitLatencySortMeta(b.ex);
                if (aLatency.rank !== bLatency.rank) return aLatency.rank - bLatency.rank;
                const latencyDelta = aLatency.latency - bLatency.latency;
                if (Number.isFinite(latencyDelta) && latencyDelta !== 0) return latencyDelta;
                return a.originalIndex - b.originalIndex;
            }).map(item => item.ex);
        }

        function getLbExitRenderKey(ex, fallbackIndex) {
            const exitIndex = getLbExitIndex(ex, fallbackIndex);
            return [exitIndex, ex && ex.type || '', ex && ex.name || '', ex && ex.proxy || ''].join('|');
        }

        function getLbRenderHash(value) {
            const text = String(value || '');
            let hash = 0;
            for (let i = 0; i < text.length; i++) {
                hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
            }
            return String(hash);
        }

        function createLbExitCardItem(key, html) {
            const hash = getLbRenderHash(html);
            return {
                key,
                hash,
                html: `<div data-lb-exit-key="${escapeHtml(key)}" data-lb-render-hash="${hash}"${html.slice(4)}`
            };
        }

        function renderLbExitCards(container, cardItems) {
            const currentCards = Array.from(container.children).filter(node => node.dataset && node.dataset.lbExitKey);
            const sameOrder = currentCards.length === cardItems.length && cardItems.every((item, index) => currentCards[index].dataset.lbExitKey === item.key);
            if (!sameOrder) {
                container.innerHTML = cardItems.map(item => item.html).join('');
                return;
            }
            cardItems.forEach((item, index) => {
                const node = currentCards[index];
                if (node.dataset.lbRenderHash !== item.hash) {
                    node.outerHTML = item.html;
                }
            });
        }

        function renderLbStatus(data) {
            if (!data || data.error) return;
            const policy = data.policy || {};
            document.getElementById('lbTotalExits').textContent = data.total_exits;
            document.getElementById('lbHealthyExits').textContent = data.healthy_exits;
            document.getElementById('lbTotalActive').textContent = data.total_active;
            document.getElementById('lbLoginLimit').textContent = data.max_login_per_min;
            document.getElementById('lbLatencyStrategy').textContent = policy.latency_strategy_enabled === false ? '最少连接' : '延迟优先';
            document.getElementById('lbPerSecondLimit').textContent = `${policy.per_exit_rate_per_second || 3} req/s/节点`;
            document.getElementById('lbProbeInterval').textContent = `${Math.round((policy.latency_probe_interval_seconds || 1800) / 60)} 分钟`;
            document.getElementById('lbSummary').textContent =
                `${data.healthy_exits}/${data.total_exits} 健康 | ${data.total_active} 活跃连接`;

            const container = document.getElementById('lbExitCards');
            if (!data.exits || data.exits.length === 0) {
                container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:40px;">暂无出口配置</div>';
                return;
            }

            const displayExits = sortLbExitsForDisplay(data.exits);
            const cardItems = displayExits.map((ex, i) => {
                const isDirect = ex.type === 'direct';
                const exitIndex = getLbExitIndex(ex, i);
                const healthColor = ex.healthy ? '#00ff88' : '#ff4757';
                const healthText = ex.healthy ? '在线' : '离线';
                const healthBg = ex.healthy ? 'rgba(0,255,136,0.1)' : 'rgba(255,71,87,0.1)';
                const borderColor = ex.healthy ? 'rgba(0,255,136,0.3)' : 'rgba(255,71,87,0.3)';

                // 登录冷却进度条
                const cd = ex.login_cooldown || {};
                const cdUsed = cd.used || 0;
                const cdMax = cd.max || 10;
                const cdPct = Math.min(100, (cdUsed / cdMax) * 100);
                const cdColor = cdPct >= 100 ? '#ff4757' : cdPct >= 75 ? '#ffa502' : '#00ff88';
                const cdRemaining = cd.remaining || 0;
                const cdText = cdPct >= 100
                    ? `已满 (${cd.next_available_in}s后开始释放)`
                    : cdUsed > 0
                        ? `${cdUsed}/${cdMax} (${cdRemaining}个可用)`
                        : `${cdUsed}/${cdMax}`;

                // 冻结+告警标记
                let warnHtml = '';
                if (ex.frozen) {
                    const frozenReason = ex.frozen_reason || '出口临时禁用';
                    warnHtml += `<div style="margin-top:6px;font-size:11px;color:#ff4757;">🧊 禁用中：${escapeHtml(frozenReason)} (${Math.round(ex.frozen_remaining)}s后恢复)</div>`;
                }
                if (ex.warn_403 > 0 || ex.warn_429 > 0) {
                    const parts = [];
                    if (ex.warn_403 > 0) parts.push(`<span style="color:#ff4757;">403×${ex.warn_403}</span>`);
                    if (ex.warn_429 > 0) parts.push(`<span style="color:#ffa502;">429×${ex.warn_429}</span>`);
                    warnHtml += `<div style="margin-top:6px;font-size:11px;">⚠️ ${parts.join(' ')}</div>`;
                }

                const serverLabel = isDirect ? '直连服务器' : `负载均衡服务器${exitIndex}`;
                const exitIpMeta = formatLbExitIp(ex, healthColor);
                const latencyMeta = formatLbLatency(ex);
                const latencyErr = ex.latency_probe_error ? ` | ${ex.latency_probe_error}` : '';
                const latencyTitle = ex.latency_checked_at ? `上次测速: ${ex.latency_checked_at}${latencyErr}` : '暂未开始延迟测速';
                const exitNameArg = jsArg(ex.name || '');
                const groupHtml = ex.group_name ? `<div style="display:inline-block;margin-top:5px;padding:2px 6px;border-radius:999px;background:rgba(102,126,234,0.14);color:#8ea2ff;font-size:10px;">📦 ${escapeHtml(ex.group_name)}</div>` : '';

                const cardHtml = `<div onclick="lbShowErrorLogs(${exitIndex}, ${exitNameArg})" style="background:var(--bg-card);border-radius:10px;padding:14px;border:1px solid ${borderColor};position:relative;overflow:hidden;cursor:pointer;">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                        <div>
                            <div style="font-size:15px;font-weight:bold;color:var(--text-primary);">${serverLabel}</div>
                            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(ex.name || '')}${ex.proxy ? ' | ' + escapeHtml(ex.proxy) : ''}</div>
                            ${groupHtml}
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${healthColor};"></span>
                            <span style="font-size:12px;color:${healthColor};font-weight:bold;">${healthText}</span>
                            <button onclick="event.stopPropagation();lbShowErrorLogs(${exitIndex}, ${exitNameArg})" style="margin-left:4px;background:rgba(255,71,87,0.12);border:1px solid rgba(255,71,87,0.35);border-radius:4px;color:#ff4757;cursor:pointer;font-size:11px;padding:2px 6px;">403详情</button>
                            ${!isDirect ? `<button onclick="event.stopPropagation();lbRemoveExit(${ex.index}, ${exitNameArg})" style="margin-left:4px;background:none;border:1px solid rgba(255,71,87,0.3);border-radius:4px;color:#ff4757;cursor:pointer;font-size:11px;padding:2px 6px;">删除</button>` : ''}
                        </div>
                    </div>
                    <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:nowrap;">
                        <div style="background:${healthBg};border-radius:6px;padding:6px 8px;flex:3;min-width:0;overflow:hidden;">
                            <div style="font-size:10px;color:var(--text-secondary);display:flex;align-items:center;">出口IP${exitIpMeta.badge}</div>
                            <div style="font-size:12px;font-weight:bold;color:${exitIpMeta.color};font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(exitIpMeta.title)}">${escapeHtml(exitIpMeta.text)}</div>
                        </div>
                        <div style="background:rgba(102,126,234,0.1);border-radius:6px;padding:6px 8px;flex:1;min-width:0;text-align:center;">
                            <div style="font-size:10px;color:var(--text-secondary);">并发</div>
                            <div style="font-size:15px;font-weight:bold;color:#667eea;">${ex.active}</div>
                        </div>
                        <div style="background:rgba(0,212,255,0.1);border-radius:6px;padding:6px 8px;flex:1;min-width:0;text-align:center;">
                            <div style="font-size:10px;color:var(--text-secondary);">请求</div>
                            <div style="font-size:12px;font-weight:bold;color:var(--accent);">${ex.total_requests}</div>
                        </div>
                        <div style="background:rgba(0,212,255,0.08);border-radius:6px;padding:6px 8px;flex:1;min-width:0;text-align:center;" title="${escapeHtml(latencyTitle)}">
                            <div style="font-size:10px;color:var(--text-secondary);">延迟</div>
                            <div style="font-size:12px;font-weight:bold;color:${latencyMeta.color};">${escapeHtml(latencyMeta.text)}</div>
                        </div>
                        <div style="background:rgba(255,165,0,0.08);border-radius:6px;padding:6px 8px;flex:1.2;min-width:0;text-align:center;cursor:pointer;" onclick="event.stopPropagation();lbShowRateLimit(${exitIndex}, ${exitNameArg}, ${ex.rate_limit})" title="点击调整限速">
                            <div style="font-size:10px;color:var(--text-secondary);">速率${ex.rate_limit > 0 ? ' ⚡' : ''}</div>
                            <div style="font-size:12px;font-weight:bold;color:${ex.rate_limit > 0 && ex.rpm >= ex.rate_limit * 0.8 ? '#ffa502' : 'var(--accent)'};">${ex.rpm}<span style="font-size:9px;color:var(--text-secondary);">/${ex.rate_limit || '∞'}</span></div>
                        </div>
                    </div>
                    <!-- 登录冷却进度 -->
                    <div style="margin-top:4px;">
                        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
                            <span style="color:var(--text-secondary);">登录冷却 (1分钟窗口)</span>
                            <span style="color:${cdColor};font-weight:bold;">${cdText}</span>
                        </div>
                        <div style="background:var(--bg-primary);border-radius:3px;height:6px;overflow:hidden;">
                            <div style="height:100%;background:${cdColor};width:${cdPct}%;transition:width 0.5s;border-radius:3px;"></div>
                        </div>
                    </div>
                    ${warnHtml}
                </div>`;
                return createLbExitCardItem(getLbExitRenderKey(ex, i), cardHtml);
            });
            renderLbExitCards(container, cardItems);
        }

        async function lbDetectIPs() {
            try {
                showToast('正在检测出口IP...', 'info');
                const res = await fetch(`${API_BASE}/api/dispatcher/detect_ips`, {method: 'POST'});
                const data = await res.json();
                if (data.success) {
                    showToast('IP检测完成');
                    loadLbStatus();
                } else {
                    showToast(data.message || '检测失败', 'error');
                }
            } catch (e) {
                showToast('检测请求失败: ' + e.message, 'error');
            }
        }

        async function lbProbeLatency() {
            try {
                showToast('正在测试节点延迟...', 'info');
                const res = await fetch(`${API_BASE}/api/dispatcher/probe_latency`, {method: 'POST'});
                const data = await res.json();
                showToast(data.message || (data.success ? '测速完成' : '测速失败'), data.success ? 'success' : 'error');
                loadLbStatus();
            } catch (e) {
                showToast('测速请求失败: ' + e.message, 'error');
            }
        }

        async function lbRemoveExit(index, name) {
            if (!confirm(`确定删除出口 [${name}] (#${index})？`)) return;
            try {
                const res = await fetch(`${API_BASE}/api/dispatcher/remove`, {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({index})
                });
                const data = await res.json();
                if (data.success) { showToast(data.message); loadLbStatus(); }
                else { showToast(data.message || '删除失败', 'error'); }
            } catch (e) { showToast('请求失败: ' + e.message, 'error'); }
        }

        function showLbAddModal() {
            const content = `
                <div style="margin-bottom:12px;">
                    <label style="display:block;margin-bottom:4px;color:var(--text-secondary);font-size:13px;">出口名称</label>
                    <input type="text" id="lbAddName" placeholder="如: 负载均衡欧洲服务器1" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);">
                </div>
                <div style="margin-bottom:12px;">
                    <label style="display:block;margin-bottom:4px;color:var(--text-secondary);font-size:13px;">SOCKS5端口 (本地sing-box)</label>
                    <input type="number" id="lbAddPort" placeholder="如: 10001" min="1024" max="65535" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);">
                </div>
            `;
            showModal('➕ 添加SOCKS5出口', content, async () => {
                const name = document.getElementById('lbAddName').value.trim();
                const port = parseInt(document.getElementById('lbAddPort').value);
                if (!name || !port) { showToast('请填写名称和端口', 'error'); return; }
                try {
                    const res = await fetch(`${API_BASE}/api/dispatcher/add`, {
                        method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({name, port})
                    });
                    const data = await res.json();
                    if (data.success) { closeModal(); showToast(data.message); loadLbStatus(); }
                    else { showToast(data.message || '添加失败', 'error'); }
                } catch (e) { showToast('请求失败: ' + e.message, 'error'); }
            }, '确认添加');
        }

        function showLbSubModal() {
            // 自建大弹窗，两步交互: 解析 → 应用
            const old = document.getElementById('lbSubModal');
            if (old) old.remove();

            const modal = document.createElement('div');
            modal.id = 'lbSubModal';
            modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:10000;';
            modal.innerHTML = `
                <div style="background:var(--bg-card);border-radius:12px;max-width:680px;width:95%;max-height:85vh;border:1px solid var(--border);display:flex;flex-direction:column;">
                    <h3 style="padding:18px 22px 14px;margin:0;color:var(--accent);border-bottom:1px solid var(--border);flex-shrink:0;">📡 导入VPN订阅</h3>
                    <div style="padding:14px 22px;overflow-y:auto;flex:1;" id="lbSubBody">
                        <div style="margin-bottom:10px;">
                            <label style="display:block;margin-bottom:4px;color:var(--text-secondary);font-size:13px;">订阅链接 (自动获取并解析)</label>
                            <input type="text" id="lbSubUrl" placeholder="https://example.com/sub?token=xxx" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);">
                        </div>
                        <div style="margin-bottom:10px;">
                            <label style="display:block;margin-bottom:4px;color:var(--text-secondary);font-size:13px;">订阅组名称</label>
                            <input type="text" id="lbSubGroupName" placeholder="如: 机场A / 下载专用 / 日本节点组" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);">
                        </div>
                        <div style="text-align:center;color:var(--text-secondary);font-size:12px;margin:6px 0;">—— 或 ——</div>
                        <div style="margin-bottom:10px;">
                            <label style="display:block;margin-bottom:4px;color:var(--text-secondary);font-size:13px;">订阅内容 (粘贴Clash YAML / Base64 / SS链接 / JSON节点)</label>
                            <textarea id="lbSubText" rows="4" placeholder="粘贴订阅内容..." style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:monospace;font-size:12px;resize:vertical;"></textarea>
                        </div>
                        <div id="lbSubResult" style="display:none;"></div>
                    </div>
                    <div style="display:flex;gap:10px;padding:14px 22px 18px;border-top:1px solid var(--border);flex-shrink:0;align-items:center;">
                        <button onclick="closeLbSubModal()" class="btn" style="padding:10px 20px;background:var(--bg-secondary);color:var(--text-secondary);border-radius:8px;font-size:14px;">取消</button>
                        <button id="lbSubActionBtn" onclick="lbSubAction()" class="btn btn-primary" style="flex:1;padding:10px 0;border-radius:8px;font-size:15px;font-weight:bold;">🔍 解析订阅</button>
                        <span id="lbSubAddMsg" style="font-size:12px;color:var(--text-secondary);"></span>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            window._lbSubStep = 'parse'; // 当前步骤
        }

        function closeLbSubModal() {
            const m = document.getElementById('lbSubModal');
            if (m) m.remove();
        }

        async function lbSubAction() {
            if (window._lbSubStep === 'parse') {
                // 第一步: 解析
                const url = document.getElementById('lbSubUrl').value.trim();
                const text = document.getElementById('lbSubText').value.trim();
                if (!url && !text) { showToast('请输入订阅链接或内容', 'error'); return; }
                const resultEl = document.getElementById('lbSubResult');
                const btn = document.getElementById('lbSubActionBtn');
                resultEl.style.display = 'block';
                resultEl.innerHTML = '<div style="color:var(--accent);padding:10px;text-align:center;">⏳ 正在解析订阅...</div>';
                btn.disabled = true;
                btn.textContent = '解析中...';
                try {
                    const res = await fetch(`${API_BASE}/api/dispatcher/parse_sub`, {
                        method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({url, text})
                    });
                    const data = await res.json();
                    if (data.error) {
                        resultEl.innerHTML = `<div style="color:#ff4757;padding:10px;">❌ ${escapeHtml(data.error)}</div>`;
                        btn.disabled = false;
                        btn.textContent = '🔍 重新解析';
                        return;
                    }
                    renderSubResult(data, resultEl);
                    // 切换到第二步
                    window._lbSubStep = 'apply';
                    btn.disabled = false;
                    btn.textContent = '🚀 一键应用选中节点';
                    btn.style.background = 'linear-gradient(135deg, #00c9b7, #7ed56f)';
                } catch (e) {
                    resultEl.innerHTML = `<div style="color:#ff4757;padding:10px;">请求失败: ${escapeHtml(e.message)}</div>`;
                    btn.disabled = false;
                    btn.textContent = '🔍 重新解析';
                }
            } else {
                // 第二步: 应用
                await lbBatchAddFromSub();
            }
        }

        function renderSubResult(data, el) {
            const regionHtml = Object.entries(data.regions || {}).map(([code, info]) =>
                `<span style="background:var(--bg-secondary);padding:2px 8px;border-radius:10px;font-size:11px;">${escapeHtml(info.label || code)} ×${Number(info.count || 0)}</span>`
            ).join(' ');

            const nodesHtml = (data.nodes || []).map((node, ni) => {
                const label = node.name || `${node.region_label || ''}节点${ni+1}`;
                return `<label style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px;cursor:pointer;">
                    <input type="checkbox" class="lb-sub-node" data-index="${ni}" data-server="${escapeHtml(node.server || '')}" data-port="${Number(node.port || 0)}" data-name="${escapeHtml(label)}" checked style="accent-color:var(--accent);">
                    <span style="flex:1;">
                        <strong style="font-size:11px;">${escapeHtml(label)}</strong>
                        <span style="color:var(--text-secondary);margin-left:6px;font-size:11px;">${escapeHtml((node.type||'').toUpperCase())} | ${escapeHtml(node.server || '')}:${Number(node.port || 0)}</span>
                    </span>
                </label>`;
            }).join('');

            el.innerHTML = `
                <div style="background:var(--bg-secondary);border-radius:8px;padding:10px;margin-bottom:8px;">
                    <div style="font-size:13px;margin-bottom:6px;">✅ 格式: <strong style="color:var(--accent);">${escapeHtml(data.format || '-')}</strong> |
                        节点: <strong>${Number(data.total_nodes || 0)}</strong> |
                        唯一服务器: <strong style="color:var(--accent-green);">${Number(data.unique_servers || 0)}</strong></div>
                    <div style="display:flex;gap:4px;flex-wrap:wrap;">${regionHtml}</div>
                </div>
                <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;">勾选要添加的节点（共 ${(data.nodes||[]).length} 个）：</div>
                <div style="max-height:220px;overflow-y:auto;margin-bottom:8px;border:1px solid var(--border);border-radius:6px;padding:4px 8px;">
                    ${nodesHtml}
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <label style="font-size:12px;color:var(--text-secondary);">起始端口:</label>
                    <input type="number" id="lbSubBasePort" value="10001" min="1024" max="65000" style="width:80px;padding:4px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px;">
                    <span style="font-size:11px;color:var(--text-secondary);">点击下方按钮一键应用</span>
                </div>
            `;
        }

        async function lbBatchAddFromSub() {
            const checks = document.querySelectorAll('.lb-sub-node:checked');
            if (checks.length === 0) { showToast('请至少选择一个节点', 'error'); return; }
            const basePort = parseInt(document.getElementById('lbSubBasePort').value) || 10001;
            const msgEl = document.getElementById('lbSubAddMsg');
            msgEl.textContent = '正在应用: 生成配置 → 重载sing-box → 注册出口...';

            // 收集选中的节点索引
            const selected_node_indices = [];
            checks.forEach(chk => {
                selected_node_indices.push(parseInt(chk.dataset.index));
            });

            // 获取订阅源 (从弹窗的输入框)
            const url = document.getElementById('lbSubUrl')?.value?.trim() || '';
            const text = document.getElementById('lbSubText')?.value?.trim() || '';
            const group_name = document.getElementById('lbSubGroupName')?.value?.trim() || '';

            try {
                const res = await fetch(`${API_BASE}/api/dispatcher/apply_sub`, {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ url, text, group_name, selected_node_indices, base_port: basePort })
                });
                const data = await res.json();
                if (data.success) {
                    const sbIcon = data.singbox_reload ? '✅' : '⚠️';
                    msgEl.innerHTML = `${sbIcon} 完成! ${Number(data.nodes_count || 0)}个节点已应用, sing-box: ${escapeHtml(data.message || '')}`;
                    showToast(`热重载成功: ${data.nodes_count}个出口已生效`);
                    closeLbSubModal();
                    await loadSubscriptionGroups();
                } else {
                    msgEl.innerHTML = `<span style="color:#ffa502;">⚠️ ${escapeHtml(data.message || '')}</span><br>节点已注册到dispatcher(${Number(data.nodes_count || 0)}个), sing-box需手动重载`;
                    showToast(data.message || '部分失败', 'error');
                }
                loadLbStatus();
            } catch (e) {
                msgEl.textContent = `请求失败: ${e.message}`;
                showToast('请求失败: ' + e.message, 'error');
            }
        }

        async function lbReloadSingbox() {
            try {
                showToast('正在热重载 sing-box...', 'info');
                const res = await fetch(`${API_BASE}/api/dispatcher/reload_singbox`, {method: 'POST'});
                const data = await res.json();
                showToast(data.message, data.success ? 'success' : 'error');
                loadLbStatus();
            } catch (e) {
                showToast('热重载失败: ' + e.message, 'error');
            }
        }

        async function lbStartSingbox() {
            try {
                showToast('正在启动 sing-box...', 'info');
                const res = await fetch(`${API_BASE}/api/dispatcher/start_singbox`, {method: 'POST'});
                const data = await res.json();
                showToast(data.message, data.success ? 'success' : 'error');
                loadLbStatus();
            } catch (e) {
                showToast('启动失败: ' + e.message, 'error');
            }
        }

        function lbShowLoginLimitModal() {
            const current = document.getElementById('lbLoginLimit').textContent || '10';
            const content = `
                <div style="margin-bottom:12px;">
                    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">
                        每个出口每分钟最多允许的登录次数，超出后自动轮换到其他出口。
                    </div>
                    <div style="display:flex;flex-direction:column;gap:8px;">
                        <label style="font-size:13px;color:var(--text-primary);">登录限额 (次/分钟/出口):</label>
                        <input id="loginLimitInput" type="number" min="1" step="1" value="${current}"
                            style="background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-primary);font-size:14px;width:100%;">
                    </div>
                    <div style="display:flex;gap:8px;margin-top:12px;">
                        <button onclick="lbSetLoginLimit(5)" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(255,165,0,0.3);background:rgba(255,165,0,0.1);color:#ffa502;cursor:pointer;font-size:12px;">5/min</button>
                        <button onclick="lbSetLoginLimit(8)" style="flex:1;padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:12px;">8/min</button>
                        <button onclick="lbSetLoginLimit(10)" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(0,212,255,0.3);background:rgba(0,212,255,0.1);color:var(--accent);cursor:pointer;font-size:12px;">10/min</button>
                        <button onclick="lbSetLoginLimit(15)" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(0,255,136,0.3);background:rgba(0,255,136,0.1);color:#00ff88;cursor:pointer;font-size:12px;">15/min</button>
                    </div>
                </div>
            `;
            showModal('✏️ 调整登录限额', content, async () => {
                const val = parseInt(document.getElementById('loginLimitInput')?.value || '10');
                await lbSetLoginLimit(val);
            }, '应用');
        }

        async function lbSetLoginLimit(value) {
            try {
                const res = await fetch(`${API_BASE}/api/dispatcher/max_login`, {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ value })
                });
                const data = await res.json();
                showToast(data.message, data.success ? 'success' : 'error');
                closeModal();
                loadLbStatus();
            } catch (e) {
                showToast('设置失败: ' + e.message, 'error');
            }
        }

        function lbShowPolicyModal() {
            const policy = (lbData && lbData.policy) || {};
            const rate = policy.per_exit_rate_per_second || 3;
            const enabled = policy.latency_strategy_enabled !== false;
            const content = `
                <div style="margin-bottom:12px;">
                    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">
                        控制所有出口节点的每秒请求上限，并决定是否优先使用低延迟节点。
                    </div>
                    <div style="display:flex;flex-direction:column;gap:10px;">
                        <label style="font-size:13px;color:var(--text-primary);">每节点请求上限 (req/s):</label>
                        <input id="lbPolicyRpsInput" type="number" min="1" max="20" step="1" value="${rate}"
                            style="background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-primary);font-size:14px;width:100%;">
                        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-primary);">
                            <input id="lbPolicyLatencyEnabled" type="checkbox" ${enabled ? 'checked' : ''} style="accent-color:var(--accent);">
                            启用延迟优先调度
                        </label>
                        <div style="font-size:11px;color:var(--text-secondary);">
                            默认 3 req/s/节点；节点会每 30 分钟自动测速一次，也可以点击“测速”立即触发。
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;margin-top:12px;">
                        <button onclick="lbSetPolicy(1,true)" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(255,165,0,0.3);background:rgba(255,165,0,0.1);color:#ffa502;cursor:pointer;font-size:12px;">1/s</button>
                        <button onclick="lbSetPolicy(3,true)" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(0,212,255,0.3);background:rgba(0,212,255,0.1);color:var(--accent);cursor:pointer;font-size:12px;">3/s</button>
                        <button onclick="lbSetPolicy(5,true)" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(0,255,136,0.3);background:rgba(0,255,136,0.1);color:#00ff88;cursor:pointer;font-size:12px;">5/s</button>
                    </div>
                </div>
            `;
            showModal('⚙️ 负载均衡策略', content, async () => {
                const val = parseInt(document.getElementById('lbPolicyRpsInput')?.value || '3', 10);
                const latencyEnabled = !!document.getElementById('lbPolicyLatencyEnabled')?.checked;
                await lbSetPolicy(val, latencyEnabled);
            }, '应用策略');
        }

        async function lbSetPolicy(perExitRatePerSecond, latencyStrategyEnabled) {
            try {
                const res = await fetch(`${API_BASE}/api/dispatcher/policy`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        per_exit_rate_per_second: perExitRatePerSecond,
                        latency_strategy_enabled: latencyStrategyEnabled
                    })
                });
                const data = await res.json();
                showToast(data.message, data.success ? 'success' : 'error');
                closeModal();
                loadLbStatus();
            } catch (e) {
                showToast('设置失败: ' + e.message, 'error');
            }
        }

        function lbShowRateLimit(index, name, currentLimit) {
            const content = `
                <div style="margin-bottom:12px;">
                    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">出口 #${Number(index || 0)} | ${escapeHtml(name || '')}</div>
                    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">
                        当前限速: <b style="color:var(--accent);">${escapeHtml(currentLimit || '不限速')}</b> ${currentLimit ? 'req/min' : ''}
                    </div>
                    <div style="display:flex;flex-direction:column;gap:8px;">
                        <label style="font-size:13px;color:var(--text-primary);">设置速率上限 (req/min):</label>
                        <input id="rateLimitInput" type="number" min="0" step="5" value="${Number(currentLimit || 0)}" placeholder="0 = 不限速"
                            style="background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-primary);font-size:14px;width:100%;">
                        <div style="font-size:11px;color:var(--text-secondary);">
                            💡 设为 0 表示不限速 | 收到403会自动降速10%<br>
                            建议值: 30~100/min (视上游承受能力)
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;margin-top:12px;">
                        <button onclick="lbSetRate(${Number(index || 0)},0)" style="flex:1;padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:12px;">🔓 取消限速</button>
                        <button onclick="lbSetRate(${Number(index || 0)},30)" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(255,165,0,0.3);background:rgba(255,165,0,0.1);color:#ffa502;cursor:pointer;font-size:12px;">🐢 30/min</button>
                        <button onclick="lbSetRate(${Number(index || 0)},60)" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(0,212,255,0.3);background:rgba(0,212,255,0.1);color:var(--accent);cursor:pointer;font-size:12px;">⚡ 60/min</button>
                    </div>
                </div>
            `;
            showModal(`⚡ 速率控制 - ${name}`, content, async () => {
                const val = parseInt(document.getElementById('rateLimitInput')?.value || '0');
                await lbSetRate(index, val);
            }, '应用设置');
        }

        async function lbSetRate(index, limit) {
            try {
                const res = await fetch(`${API_BASE}/api/dispatcher/rate_limit`, {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ index, limit })
                });
                const data = await res.json();
                showToast(data.message, data.success ? 'success' : 'error');
                closeModal();
                loadLbStatus();
            } catch (e) {
                showToast('设置失败: ' + e.message, 'error');
            }
        }

        async function lbShowErrorLogs(index, name) {
            try {
                const [logsRes, eventsRes] = await Promise.all([
                    fetch(`${API_BASE}/api/dispatcher/logs/${index}`),
                    fetch(`${API_BASE}/api/dispatcher/runtime_events?exit_name=${encodeURIComponent(name)}&status_code=403&limit=200`)
                ]);
                const logsData = await logsRes.json();
                const eventsData = await eventsRes.json();
                const logs = logsData.logs || [];
                const events = eventsData.events || [];

                const logsHtml = logs.length === 0
                    ? '<div style="color:var(--text-secondary);text-align:center;padding:20px;">暂无连接错误</div>'
                    : logs.map(l => `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;font-family:monospace;">
                            <span style="color:var(--text-secondary);white-space:nowrap;">${escapeHtml(l.time || '')}</span>
                            <span style="color:#ff4757;word-break:break-all;">${escapeHtml(l.msg || '')}</span>
                        </div>`).reverse().join('');

                const eventsHtml = events.length === 0
                    ? '<div style="color:var(--text-secondary);text-align:center;padding:20px;">本次启动后暂无上游K937 403明细</div>'
                    : events.map(e => {
                        return `<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;font-family:monospace;">
                            <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;">
                                <span style="color:var(--text-secondary);white-space:nowrap;">${escapeHtml(e.ts || '')}</span>
                                <span style="color:#ff4757;font-weight:bold;white-space:nowrap;">403</span>
                                <span style="color:var(--accent);white-space:nowrap;" title="API">${escapeHtml(e.api_path || '-')}</span>
                            </div>
                            <div style="display:grid;grid-template-columns:72px 1fr;gap:3px 8px;color:var(--text-secondary);">
                                <span>账号</span><span style="color:var(--text-primary);word-break:break-all;">${escapeHtml(e.account || '-')}</span>
                                <span>客户端IP</span><span style="color:var(--text-primary);word-break:break-all;">${escapeHtml(e.client_ip || '-')}</span>
                                <span>出口IP</span><span style="color:var(--text-primary);word-break:break-all;">${escapeHtml(e.exit_ip || '-')}</span>
                                <span>原因</span><span style="color:#ffa502;word-break:break-all;">${escapeHtml(e.reason || '上游K937返回403')}</span>
                            </div>
                        </div>`;
                    }).join('');

                const content = `
                    <div style="display:flex;gap:8px;margin-bottom:10px;">
                        <button onclick="this.parentNode.querySelectorAll('button').forEach(b=>b.style.background='var(--bg-secondary)');this.style.background='rgba(0,212,255,0.15)';document.getElementById('lbLogTab1').style.display='block';document.getElementById('lbLogTab2').style.display='none';"
                            style="flex:1;padding:6px;border-radius:6px;border:1px solid var(--border);background:rgba(0,212,255,0.15);color:var(--accent);cursor:pointer;font-size:12px;">
                            🔌 连接错误 (${logs.length})
                        </button>
                        <button onclick="this.parentNode.querySelectorAll('button').forEach(b=>b.style.background='var(--bg-secondary)');this.style.background='rgba(255,71,87,0.15)';document.getElementById('lbLogTab1').style.display='none';document.getElementById('lbLogTab2').style.display='block';"
                            style="flex:1;padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:#ff4757;cursor:pointer;font-size:12px;">
                            ⚠️ 上游K937 403 (${events.length})
                        </button>
                    </div>
                    <div id="lbLogTab1" style="max-height:320px;overflow-y:auto;">${logsHtml}</div>
                    <div id="lbLogTab2" style="max-height:320px;overflow-y:auto;display:none;">${eventsHtml}</div>
                `;
                showModal(`📋 日志 - ${name || ''}`, content, () => closeModal(), '关闭');
            } catch (e) {
                showToast('获取日志失败: ' + e.message, 'error');
            }
        }

        // 初始化应用（登录成功后调用）

        // ===== 订阅组管理 =====
        let subscriptionGroups = [];
        let expandedGroups = new Set();

        async function loadSubscriptionGroups() {
            try {
                const res = await fetch(`${API_BASE}/admin/api/subscription_groups`, {
                    headers: getHeaders()
                });
                const data = await res.json();
                if (data.success) {
                    subscriptionGroups = data.groups || [];
                    renderSubscriptionGroups();
                }
            } catch (e) {
                console.error('加载订阅组失败', e);
            }
        }

        function renderSubscriptionGroups() {
            const container = document.getElementById('subscriptionGroupsList');
            const countEl = document.getElementById('subGroupCount');
            if (!container) return;

            if (!subscriptionGroups || subscriptionGroups.length === 0) {
                container.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 30px; font-size: 12px;">暂无订阅组，请在设置页面导入订阅</div>';
                if (countEl) countEl.textContent = '0 个';
                return;
            }

            if (countEl) countEl.textContent = `${subscriptionGroups.length} 个`;

            const html = subscriptionGroups.map(group => {
                const isExpanded = expandedGroups.has(group.id);
                const icon = isExpanded ? '🔽' : '▶';
                const importTime = group.import_time ? new Date(group.import_time).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                }) : '未知';
                const groupIdArg = jsArg(group.id || '');
                const groupNotesArg = jsArg(group.notes || '');

                const notesHtml = group.notes ? `
                    <div style="margin-top: 4px; padding: 3px 8px; background: rgba(102,126,234,0.1); border-radius: 4px; font-size: 11px; color: var(--accent);">
                        📝 ${escapeHtml(group.notes)}
                    </div>
                ` : '';

                return `
                    <div style="background: var(--bg-primary); border-radius: 8px; border: 1px solid var(--border); overflow: hidden;">
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; cursor: pointer;" onclick="toggleSubscriptionGroup(${groupIdArg})">
                            <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                                <span style="font-size: 14px;">${icon}</span>
                                <div style="flex: 1;">
                                    <div style="font-size: 13px; font-weight: bold; color: var(--text-primary);">${escapeHtml(group.name || '')}</div>
                                    <div style="font-size: 11px; color: var(--text-secondary);">
                                        ${escapeHtml(importTime)} | 服务器启用 ${Number(group.active_servers || 0)}/${Number(group.total_servers || 0)}
                                        ${group.source_type === 'url' ? ' | 🔗订阅链接' : group.source_type === 'json' ? ' | 📋JSON' : ' | 📝文本'}
                                    </div>
                                    ${notesHtml}
                                </div>
                            </div>
                            <div style="display: flex; gap: 6px;" onclick="event.stopPropagation()">
                                <button class="btn" onclick="editSubscriptionGroupNotes(${groupIdArg}, ${groupNotesArg})"
                                        style="padding: 4px 8px; font-size: 11px; background: rgba(102,126,234,0.1); color: var(--accent); border: 1px solid rgba(102,126,234,0.3);">
                                    📝 备注
                                </button>
                                <button class="btn" onclick="deleteSubscriptionGroup(${groupIdArg})"
                                        style="padding: 4px 8px; font-size: 11px; background: rgba(255,71,87,0.1); color: var(--accent-red); border: 1px solid rgba(255,71,87,0.3);">
                                    🗑️ 删除
                                </button>
                            </div>
                        </div>
                        <div id="subGroupServers_${escapeHtml(group.id || '')}" style="display: ${isExpanded ? 'block' : 'none'}; padding: 0 12px 12px; border-top: 1px solid var(--border);">
                            <div style="color: var(--text-secondary); font-size: 11px; padding: 8px 0;">服务器列表加载中...</div>
                        </div>
                    </div>
                `;
            }).join('');

            container.innerHTML = html;

            expandedGroups.forEach(groupId => {
                loadGroupServers(groupId);
            });
        }

        function toggleSubscriptionGroup(groupId) {
            if (expandedGroups.has(groupId)) {
                expandedGroups.delete(groupId);
            } else {
                expandedGroups.add(groupId);
                loadGroupServers(groupId);
            }
            renderSubscriptionGroups();
        }

        async function loadGroupServers(groupId) {
            const container = document.getElementById(`subGroupServers_${groupId}`);
            if (!container) return;

            try {
                const res = await fetch(`${API_BASE}/admin/api/nodes`, { headers: getHeaders() });
                const data = await res.json();
                const nodes = (data.nodes || []).filter(n => n && typeof n === 'object' && n.group_id === groupId);

                if (nodes.length === 0) {
                    container.innerHTML = '<div style="padding: 8px; color: var(--text-secondary); font-size: 11px;">该组暂无服务器</div>';
                    return;
                }

                const uniqueServers = new Map();
                nodes.forEach(node => {
                    const s = node.server;
                    if (!uniqueServers.has(s)) {
                        uniqueServers.set(s, { representative: node, allNodes: [node] });
                    } else {
                        uniqueServers.get(s).allNodes.push(node);
                    }
                });

                const serversHtml = Array.from(uniqueServers.entries()).map(([server, { representative, allNodes }], idx) => {
                    const enabled = allNodes.every(n => n.enabled !== false);
                    const node = representative;
                    const textColor = enabled ? 'var(--text-primary)' : '#6b7280';
                    const bgColor = enabled ? 'var(--bg-secondary)' : 'rgba(107,114,128,0.1)';
                    const opacity = enabled ? '1' : '0.6';
                    const disabledTag = enabled ? '' : '<span style="color: #6b7280; font-size: 10px; margin-left: 6px;">❌已禁用</span>';
                    const nodeCountTag = allNodes.length > 1 ? `<span style="color: #9ca3af; font-size: 10px; margin-left: 4px;">(同服务器${allNodes.length}条节点)</span>` : '';
                    const groupIdArg = jsArg(groupId);
                    const serverArg = jsArg(server);

                    return `
                        <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: ${bgColor}; border-radius: 6px; margin-top: 6px; opacity: ${opacity};">
                            <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleServerByIP(${groupIdArg}, ${serverArg}, this.checked)" style="cursor: pointer; accent-color: var(--accent-green);">
                            <div style="flex: 1; font-size: 12px; color: ${textColor};">
                                <strong>${escapeHtml(node.name || node.display_name || `服务器${idx + 1}`)}</strong>
                                ${nodeCountTag}${disabledTag}
                                <span style="color: #6b7280; margin-left: 6px;">${escapeHtml((node.type || 'UNKNOWN').toUpperCase())} | ${escapeHtml(node.server || '')}</span>
                            </div>
                        </div>
                    `;
                }).join('');

                const groupIdArg = jsArg(groupId);
                const actionsHtml = `
                    <div style="display: flex; gap: 6px; padding: 8px 0; font-size: 11px;">
                        <button class="btn" onclick="toggleAllServers(${groupIdArg}, true)" style="padding: 4px 10px; background: rgba(76,175,80,0.1); color: var(--accent-green);">全选</button>
                        <button class="btn" onclick="toggleAllServers(${groupIdArg}, false)" style="padding: 4px 10px; background: var(--bg-secondary); color: var(--text-secondary);">全不选</button>
                    </div>
                `;

                container.innerHTML = actionsHtml + serversHtml;
            } catch (e) {
                console.error('加载订阅组服务器失败', e);
                container.innerHTML = '<div style="padding: 8px; color: var(--accent-red); font-size: 11px;">加载失败</div>';
            }
        }

        async function toggleServerByIP(groupId, server, enabled) {
            try {
                const res = await fetch(`${API_BASE}/admin/api/subscription_groups/${groupId}/toggle_by_ip`, {
                    method: 'POST',
                    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ server, enabled })
                });
                const data = await res.json();
                if (data.success) {
                    showToast(data.message, 'success');
                    await loadSubscriptionGroups();
                } else {
                    showToast(data.message || '操作失败', 'error');
                }
            } catch (e) {
                showToast('操作失败: ' + e.message, 'error');
            }
        }

        async function toggleAllServers(groupId, enabled) {
            try {
                const res = await fetch(`${API_BASE}/admin/api/subscription_groups/${groupId}/toggle_all`, {
                    method: 'POST',
                    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                const data = await res.json();
                if (data.success) {
                    showToast(data.message, 'success');
                    await loadSubscriptionGroups();
                } else {
                    showToast(data.message || '操作失败', 'error');
                }
            } catch (e) {
                showToast('操作失败: ' + e.message, 'error');
            }
        }

        async function editSubscriptionGroupNotes(groupId, currentNotes) {
            const group = subscriptionGroups.find(g => g.id === groupId);
            const groupName = group ? group.name : groupId;

            showModal('编辑订阅组备注', `
                <div style="margin-bottom: 12px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text-primary); font-weight: bold;">订阅组：${escapeHtml(groupName)}</label>
                    <label style="display: block; margin-bottom: 4px; color: var(--text-secondary); font-size: 13px;">备注内容</label>
                    <input type="text" id="editNotesInput" value="${escapeHtml(currentNotes)}"
                           placeholder="如：XX机场-月付套餐 | 2026-04-12到期"
                           style="width: 100%; padding: 8px 12px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 6px; color: var(--text-primary); font-size: 14px; box-sizing: border-box;">
                    <div style="margin-top: 6px; font-size: 11px; color: var(--text-secondary);">💡 方便记录订阅来源、到期时间等信息</div>
                </div>
            `, async () => {
                const notes = document.getElementById('editNotesInput').value.trim();
                try {
                    const res = await fetch(`${API_BASE}/admin/api/subscription_groups/${groupId}/notes`, {
                        method: 'PATCH',
                        headers: { ...getHeaders(), 'Content-Type': 'application/json' },
                        body: JSON.stringify({ notes })
                    });
                    const data = await res.json();
                    if (data.success) {
                        showToast('备注已更新', 'success');
                        await loadSubscriptionGroups();
                    } else {
                        showToast(data.message || '更新失败', 'error');
                    }
                } catch (e) {
                    showToast('更新失败: ' + e.message, 'error');
                }
            }, '保存');
        }

        async function deleteSubscriptionGroup(groupId) {
            const group = subscriptionGroups.find(g => g.id === groupId);
            const groupName = group ? group.name : groupId;

            if (!await showConfirm('确认删除', `确定要删除订阅组"${groupName}"吗？\n\n该组的所有服务器将被移除。`)) return;

            try {
                const res = await fetch(`${API_BASE}/admin/api/subscription_groups/${groupId}`, {
                    method: 'DELETE',
                    headers: getHeaders()
                });
                const data = await res.json();
                if (data.success) {
                    showToast(data.message, 'success');
                    expandedGroups.delete(groupId);
                    await loadSubscriptionGroups();
                    await loadLbStatus();
                } else {
                    showToast(data.message || '删除失败', 'error');
                }
            } catch (e) {
                showToast('删除失败: ' + e.message, 'error');
            }
        }

        Object.assign(window, {
            startSettingsPanelRefresh,
            stopSettingsPanelRefresh,
            loadProxyPoolStatus,
            startProxyPoolRefresh,
            stopProxyPoolRefresh,
            switchPPView,
            loadLbStatus,
            startLbRefresh,
            stopLbRefresh,
            refreshLbLightStatus,
            loadRemoteVoicePanel,
            startRemoteVoiceRefresh,
            stopRemoteVoiceRefresh,
            showRemoteVoiceLimitModal,
            setRemoteVoiceLimit,
            lbDetectIPs,
            lbProbeLatency,
            lbRemoveExit,
            showLbAddModal,
            showLbSubModal,
            closeLbSubModal,
            lbSubAction,
            lbBatchAddFromSub,
            lbReloadSingbox,
            lbStartSingbox,
            lbShowLoginLimitModal,
            lbSetLoginLimit,
            lbShowPolicyModal,
            lbSetPolicy,
            lbShowRateLimit,
            lbSetRate,
            lbShowErrorLogs,
            loadSubscriptionGroups,
            toggleSubscriptionGroup,
            toggleServerByIP,
            toggleAllServers,
            editSubscriptionGroupNotes,
            deleteSubscriptionGroup,
        });

        window.AKAdminSettingsPanel = {
            start: startSettingsPanelRefresh,
            stop: stopSettingsPanelRefresh,
            loadProxyPoolStatus,
            startProxyPoolRefresh,
            stopProxyPoolRefresh,
            switchPPView,
            loadLbStatus,
            startLbRefresh,
            stopLbRefresh,
            refreshLbLightStatus,
            loadRemoteVoicePanel,
            startRemoteVoiceRefresh,
            stopRemoteVoiceRefresh,
            showRemoteVoiceLimitModal,
            setRemoteVoiceLimit,
            lbDetectIPs,
            lbProbeLatency,
            lbRemoveExit,
            showLbAddModal,
            showLbSubModal,
            closeLbSubModal,
            lbSubAction,
            lbBatchAddFromSub,
            lbReloadSingbox,
            lbStartSingbox,
            lbShowLoginLimitModal,
            lbSetLoginLimit,
            lbShowPolicyModal,
            lbSetPolicy,
            lbShowRateLimit,
            lbSetRate,
            lbShowErrorLogs,
            loadSubscriptionGroups,
            toggleSubscriptionGroup,
            toggleServerByIP,
            toggleAllServers,
            editSubscriptionGroupNotes,
            deleteSubscriptionGroup,
        };
})();
