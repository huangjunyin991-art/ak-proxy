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
            resetSubscriptionGroupStatusSync(false);
        }

        function startSettingsPanelRefresh() {
            if (!shouldRunAdminPanelPoll('settings')) return;
            resetSubscriptionGroupStatusSync(true);
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
                proxy_cores: (metaData && metaData.proxy_cores) || (lbData && lbData.proxy_cores) || null,
                exits
            });
        }

        async function fetchLbStatusJson(url) {
            const response = await fetch(url);
            let data = null;
            try {
                data = await response.json();
            } catch (error) {
                throw new Error(`负载均衡状态响应无法解析 (HTTP ${response.status})`);
            }
            if (!response.ok || !data || data.error) {
                throw new Error((data && data.message) || (data && data.error) || `HTTP ${response.status}`);
            }
            return data;
        }

        function renderLbLoadError(error) {
            const message = String((error && error.message) || '负载均衡状态加载失败');
            setLbText('lbSummary', '状态加载失败');
            const exitContainer = document.getElementById('lbExitCards');
            if (exitContainer) {
                exitContainer.innerHTML = `
                    <div role="alert" style="grid-column:1/-1;padding:24px 18px;text-align:center;border:1px solid rgba(255,71,87,.32);border-radius:8px;background:rgba(255,71,87,.06);color:#ff8d98;">
                        <strong style="display:block;margin-bottom:6px;">负载均衡状态加载失败</strong>
                        <span style="font-size:12px;color:var(--text-secondary);">${escapeHtml(message)}</span>
                    </div>`;
            }
            const coreContainer = document.getElementById('lbCoreCards');
            if (coreContainer) {
                coreContainer.innerHTML = '<div class="lb-core-card"><div class="lb-core-head"><span class="lb-core-name">代理核心</span><span class="lb-core-state warn">状态获取失败</span></div></div>';
            }
        }

        async function loadLbStatus(options = {forceMeta: true}) {
            if (!shouldRunAdminPanelPoll('settings')) return;
            try {
                if (!lbLightApiAvailable) {
                    const data = await fetchLbStatusJson(`${API_BASE}/api/dispatcher/full`);
                    lbData = data;
                    renderLbStatus(data);
                    renderProxyCoreStatus(data);
                    syncSubscriptionGroupStatus(data);
                    return;
                }
                const forceMeta = options.forceMeta !== false || !lbMetaData;
                const metaPromise = forceMeta
                    ? fetchLbStatusJson(`${API_BASE}/api/dispatcher/meta${forceMeta ? '?force_refresh=true' : ''}`)
                    : Promise.resolve(lbMetaData);
                const lightPromise = fetchLbStatusJson(`${API_BASE}/api/dispatcher/light`);
                const [meta, light] = await Promise.all([metaPromise, lightPromise]);
                lbMetaData = meta || lbMetaData;
                const data = mergeLbStatusData(light, lbMetaData);
                lbData = data;
                renderLbStatus(data);
                renderProxyCoreStatus(data);
                syncSubscriptionGroupStatus(data);
            } catch (e) {
                try {
                    lbLightApiAvailable = false;
                    const data = await fetchLbStatusJson(`${API_BASE}/api/dispatcher/full`);
                    lbData = data;
                    renderLbStatus(data);
                    renderProxyCoreStatus(data);
                    syncSubscriptionGroupStatus(data);
                } catch (fallbackError) {
                    console.error('加载负载均衡状态失败', fallbackError);
                    renderLbLoadError(fallbackError);
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
                const light = await fetchLbStatusJson(`${API_BASE}/api/dispatcher/light`);
                const data = mergeLbStatusData(light, lbMetaData);
                lbData = data;
                renderLbStatus(data);
                syncSubscriptionGroupStatus(data);
            } catch (e) {
                loadLbStatus();
            }
        }

        function getProxyCoreInfo(data, coreType) {
            const cores = (data && data.proxy_cores) || {};
            const core = cores[coreType] || {};
            const exits = Array.isArray(data && data.exits) ? data.exits : [];
            const nodes = exits.filter(ex => ex && ex.core_type === coreType);
            const ports = nodes.map(ex => Number(ex.local_port || 0)).filter(Boolean).sort((a, b) => a - b);
            return { core, nodes, ports };
        }

        function formatCorePorts(ports) {
            if (!ports.length) return '-';
            if (ports.length === 1) return String(ports[0]);
            return `${ports[0]}-${ports[ports.length - 1]}`;
        }

        function getCoreState(core) {
            if (!core || Object.keys(core).length === 0) return { text: '未知', cls: 'warn' };
            if (core.downloading) return { text: '下载中', cls: 'warn' };
            if (!core.installed && !core.available) return { text: '未安装', cls: 'bad' };
            if (core.active || core.managed_active) return { text: '运行中', cls: 'ok' };
            if (core.download && core.download.state === 'failed') return { text: '下载失败', cls: 'bad' };
            return { text: '未运行', cls: 'warn' };
        }

        function getProxyCoreMessage(core, state, installed) {
            if (core.download && core.download.state === 'failed') {
                return `下载失败：${escapeHtml(core.download.error || '')}`;
            }
            if (!installed) return '缺失时会自动下载';
            if (state.cls === 'ok') {
                const mode = core.run_mode === 'systemd' ? 'systemd' : core.run_mode === 'managed' ? '托管进程' : '';
                return mode ? `核心已就绪 · ${mode}` : '核心已就绪';
            }
            if (core.last_log_tail && String(core.last_log_tail).includes('address already in use')) {
                return '未运行 · 端口被旧进程占用';
            }
            return '核心未运行';
        }

        function renderProxyCoreCard(data, coreType, title) {
            const info = getProxyCoreInfo(data, coreType);
            const core = info.core || {};
            const state = getCoreState(core);
            const pid = Number(core.pid || core.managed_pid || 0) || '-';
            const installed = !!(core.installed || core.available);
            const disabled = core.downloading ? 'disabled' : '';
            const actionText = core.downloading ? '准备中' : (installed ? '重启' : '下载并启动');
            const message = getProxyCoreMessage(core, state, installed);
            const portText = state.cls === 'ok' ? formatCorePorts(info.ports) : (info.nodes.length ? '待启动' : '-');
            return `
                <div class="lb-core-card">
                    <div class="lb-core-head">
                        <span class="lb-core-name">${escapeHtml(title)}</span>
                        <span class="lb-core-state ${state.cls}">${state.text}</span>
                    </div>
                    <div class="lb-core-metrics">
                        <div class="lb-core-metric"><span>PID</span><strong>${escapeHtml(pid)}</strong></div>
                        <div class="lb-core-metric"><span>节点数</span><strong>${info.nodes.length}</strong></div>
                        <div class="lb-core-metric"><span>端口</span><strong>${escapeHtml(portText)}</strong></div>
                    </div>
                    <div class="lb-core-foot">
                        <span>${message}</span>
                        <button class="lb-core-btn" onclick="lbRestartProxyCore(${jsArg(coreType)})" ${disabled}>${actionText}</button>
                    </div>
                </div>`;
        }

        function renderProxyCoreStatus(data) {
            const container = document.getElementById('lbCoreCards');
            if (!container) return;
            container.innerHTML =
                renderProxyCoreCard(data || {}, 'singbox', 'sing-box') +
                renderProxyCoreCard(data || {}, 'mihomo', 'mihomo');
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
            if (ex.latency_probing) return { text: '源站检测中...', color: '#00d4ff' };
            const latency = ex.latency_ms;
            if (latency === null || latency === undefined) {
                if (ex.latency_checked_at || ex.latency_probe_failures > 0) {
                    return { text: '源站不可达', color: '#ff4757' };
                }
                return { text: '未检测', color: 'var(--text-secondary)' };
            }
            if (latency < 100) return { text: `${latency}ms`, color: '#00ff88' };
            if (latency < 300) return { text: `${latency}ms`, color: '#00d4ff' };
            return { text: `${latency}ms`, color: '#ffa502' };
        }

        function getLbExitIndex(ex, fallbackIndex) {
            const index = Number(ex && ex.index);
            return Number.isFinite(index) ? index : fallbackIndex;
        }

        function formatLbDuration(seconds) {
            const total = Math.max(0, Math.round(Number(seconds || 0)));
            if (total >= 3600) {
                const hours = Math.floor(total / 3600);
                const minutes = Math.round((total % 3600) / 60);
                return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
            }
            if (total >= 60) return `${Math.round(total / 60)}分钟`;
            return `${total}秒`;
        }

        function getLbConnectFailureFreezeSchedule(policy) {
            const configured = policy && policy.connect_failure_freeze_schedule;
            const schedule = (Array.isArray(configured) ? configured : [])
                .map(value => Number(value))
                .filter(value => Number.isFinite(value) && value > 0)
                .map(value => Math.round(value));
            if (schedule.length) return schedule;
            const legacySeconds = Number(policy && policy.connect_failure_freeze_seconds);
            if (Number.isFinite(legacySeconds) && legacySeconds > 0) {
                return [Math.round(legacySeconds)];
            }
            return [10, 30, 60, 180, 300, 900, 3600];
        }

        function formatLbConnectFailureFreezeSchedule(policy) {
            return getLbConnectFailureFreezeSchedule(policy).map(formatLbDuration).join(' → ');
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

        function isLbExitDisplayAvailable(ex) {
            return Boolean(ex && ex.dispatch_ready) && !ex.frozen;
        }

        function sortLbExitsForDisplay(exits) {
            return exits.map((ex, originalIndex) => ({ex, originalIndex})).sort((a, b) => {
                const aDirect = a.ex && a.ex.type === 'direct';
                const bDirect = b.ex && b.ex.type === 'direct';
                if (aDirect !== bDirect) return aDirect ? -1 : 1;
                const aAvailable = isLbExitDisplayAvailable(a.ex);
                const bAvailable = isLbExitDisplayAvailable(b.ex);
                if (aAvailable !== bAvailable) return aAvailable ? -1 : 1;
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

        function setLbText(id, value) {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        }

        function normalizeLbNumber(value, fallback = 0) {
            const num = Number(value);
            return Number.isFinite(num) ? num : fallback;
        }

        function getLbAvailability(data) {
            const exits = Array.isArray(data.exits) ? data.exits : [];
            const total = normalizeLbNumber(data.total_exits, exits.length);
            let available = normalizeLbNumber(data.available_exits, NaN);
            if (!Number.isFinite(available)) {
                available = exits.filter(ex => ex && ex.healthy && !ex.frozen).length;
            }
            let disabled = normalizeLbNumber(data.disabled_exits, NaN);
            if (!Number.isFinite(disabled)) {
                disabled = Math.max(0, total - available);
            }
            let ratio = normalizeLbNumber(data.available_ratio, NaN);
            if (!Number.isFinite(ratio)) {
                ratio = total > 0 ? (available / total) * 100 : 0;
            }
            ratio = Math.max(0, Math.min(100, ratio));
            return { total, available, disabled, ratio };
        }

        function formatLbPercent(value) {
            const num = normalizeLbNumber(value, 0);
            return Number.isInteger(num) ? String(num) : num.toFixed(1).replace(/\.0$/, '');
        }

        function renderLbStatus(data) {
            if (!data || data.error) return;
            const policy = data.policy || {};
            const availability = getLbAvailability(data);
            const availableRatioText = `${formatLbPercent(availability.ratio)}%`;
            setLbText('lbTotalExits', availability.total);
            setLbText('lbHealthyExits', data.healthy_exits);
            setLbText('lbAvailableExits', availability.available);
            setLbText('lbDisabledExits', availability.disabled);
            setLbText('lbAvailableRatio', availableRatioText);
            setLbText('lbTotalActive', data.total_active);
            setLbText('lbLoginLimit', data.max_login_per_min);
            setLbText('lbLatencyStrategy', policy.latency_strategy_enabled === false ? '最少连接' : '公平负载');
            setLbText('lbPerSecondLimit', `${policy.per_exit_rate_per_second || 3} req/s/节点`);
            setLbText('lbProbeInterval', `${Math.round((policy.latency_probe_interval_seconds || 1800) / 60)} 分钟`);
            const connectFreezeEl = document.getElementById('lbConnectFailureFreeze');
            if (connectFreezeEl) connectFreezeEl.textContent = formatLbConnectFailureFreezeSchedule(policy);
            setLbText('lbSummary', `可用 ${availability.available}/${availability.total} (${availableRatioText}) | 禁用 ${availability.disabled} | ${data.total_active} 活跃连接`);

            const container = document.getElementById('lbExitCards');
            if (!data.exits || data.exits.length === 0) {
                container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:40px;">暂无出口配置</div>';
                return;
            }

            const displayExits = sortLbExitsForDisplay(data.exits);
            const cardItems = displayExits.map((ex, i) => {
                const isDirect = ex.type === 'direct';
                const exitIndex = getLbExitIndex(ex, i);
                const nodeAvailable = isLbExitDisplayAvailable(ex);
                const isIsolated = Boolean(ex.frozen);
                const healthText = isIsolated ? '隔离中' : (nodeAvailable ? '可用' : '不可用');
                const healthClass = isIsolated ? 'is-isolated' : (nodeAvailable ? 'is-available' : 'is-unavailable');
                const borderColor = isIsolated
                    ? 'rgba(255,165,2,0.42)'
                    : (nodeAvailable ? 'rgba(0,255,136,0.3)' : 'rgba(255,71,87,0.3)');

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
                    const frozenReason = ex.frozen_reason || '出口临时隔离';
                    warnHtml += `<div style="margin-top:6px;font-size:11px;color:#ffa502;">隔离中：${escapeHtml(frozenReason)} (${Math.round(ex.frozen_remaining)}s后恢复)</div>`;
                }
                if (ex.warn_403 > 0 || ex.warn_429 > 0) {
                    const parts = [];
                    if (ex.warn_403 > 0) parts.push(`<span style="color:#ff4757;">403×${ex.warn_403}</span>`);
                    if (ex.warn_429 > 0) parts.push(`<span style="color:#ffa502;">429×${ex.warn_429}</span>`);
                    warnHtml += `<div style="margin-top:6px;font-size:11px;">⚠️ ${parts.join(' ')}</div>`;
                }

                const serverLabel = isDirect ? '直连服务器' : `负载均衡服务器${exitIndex}`;
                const latencyMeta = formatLbLatency(ex);
                const latencyErr = ex.latency_probe_error ? ` | ${ex.latency_probe_error}` : '';
                const latencyTitle = ex.latency_checked_at ? `上次源站检测: ${ex.latency_checked_at}${latencyErr}` : '暂未检测业务源站';
                const exitNameArg = jsArg(ex.name || '');
                const groupHtml = ex.group_name ? `<div style="display:inline-block;margin-top:5px;padding:2px 6px;border-radius:999px;background:rgba(102,126,234,0.14);color:#8ea2ff;font-size:10px;">订阅组 · ${escapeHtml(ex.group_name)}</div>` : '';

                const cardHtml = `<div onclick="lbShowErrorLogs(${exitIndex}, ${exitNameArg})" title="点击查看节点日志" style="background:var(--bg-card);border-radius:10px;padding:14px;border:1px solid ${borderColor};position:relative;overflow:hidden;cursor:pointer;">
                    <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:start;margin-bottom:10px;">
                        <div style="min-width:0;">
                            <div style="font-size:15px;font-weight:bold;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${serverLabel}</div>
                            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(ex.name || '')}${ex.proxy ? ' | ' + escapeHtml(ex.proxy) : ''}</div>
                            ${groupHtml}
                        </div>
                        <div class="lb-node-head-controls">
                            <div class="lb-node-health ${healthClass}">
                                <span class="lb-node-health-dot"></span>
                                <span>${healthText}</span>
                            </div>
                            <div class="lb-node-toolbar">
                                <button class="lb-node-action logs" onclick="event.stopPropagation();lbShowErrorLogs(${exitIndex}, ${exitNameArg})" title="查看节点日志" aria-label="查看节点日志">
                                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><path d="M14 2v6h6"></path><path d="M16 13H8"></path><path d="M16 17H8"></path><path d="M10 9H8"></path></svg>
                                </button>
                                ${!isDirect ? `<button class="lb-node-action danger" onclick="event.stopPropagation();lbRemoveExit(${ex.index}, ${exitNameArg})" title="删除节点" aria-label="删除节点">
                                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>
                                </button>` : ''}
                            </div>
                        </div>
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:8px;">
                        <div style="background:rgba(102,126,234,0.1);border-radius:6px;padding:7px 5px;min-width:0;text-align:center;">
                            <div style="font-size:10px;color:var(--text-secondary);">并发</div>
                            <div style="font-size:15px;font-weight:bold;color:#667eea;">${ex.active}</div>
                        </div>
                        <div style="background:rgba(0,212,255,0.1);border-radius:6px;padding:7px 5px;min-width:0;text-align:center;">
                            <div style="font-size:10px;color:var(--text-secondary);">请求</div>
                            <div style="font-size:12px;font-weight:bold;color:var(--accent);">${ex.total_requests}</div>
                        </div>
                        <div style="background:rgba(0,212,255,0.08);border-radius:6px;padding:7px 5px;min-width:0;text-align:center;" title="${escapeHtml(latencyTitle)}">
                            <div style="font-size:10px;color:var(--text-secondary);">延迟</div>
                            <div style="font-size:12px;font-weight:bold;color:${latencyMeta.color};">${escapeHtml(latencyMeta.text)}</div>
                        </div>
                        <div style="background:rgba(255,165,0,0.08);border-radius:6px;padding:7px 5px;min-width:0;text-align:center;cursor:pointer;" onclick="event.stopPropagation();lbShowRateLimit(${exitIndex}, ${exitNameArg}, ${ex.rate_limit})" title="点击调整限速">
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
                showToast('正在检查源站连通性...', 'info');
                const res = await fetch(`${API_BASE}/api/dispatcher/detect_ips`, {method: 'POST'});
                const data = await res.json();
                if (data.success) {
                    showToast('源站连通性检查完成');
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
                showToast('正在检测业务源站...', 'info');
                const res = await fetch(`${API_BASE}/api/dispatcher/probe_latency`, {method: 'POST'});
                const data = await res.json();
                showToast(data.message || (data.success ? '源站检测完成' : '源站检测失败'), data.success ? 'success' : 'error');
                loadLbStatus();
            } catch (e) {
                showToast('源站检测请求失败: ' + e.message, 'error');
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
                            <div style="margin-top:5px;color:var(--text-secondary);font-size:11px;">直连受限时会自动通过现有可用节点隧道重试</div>
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
                    <div style="display:flex;gap:10px;padding:14px 22px 18px;border-top:1px solid var(--border);flex-shrink:0;align-items:center;flex-wrap:wrap;">
                        <span id="lbSubAddMsg" style="display:none;flex:0 0 100%;font-size:12px;color:var(--text-secondary);line-height:1.55;"></span>
                        <button onclick="closeLbSubModal()" class="btn" style="padding:10px 20px;background:var(--bg-secondary);color:var(--text-secondary);border-radius:8px;font-size:14px;">取消</button>
                        <button id="lbSubActionBtn" onclick="lbSubAction()" class="btn btn-primary" style="flex:1;min-width:0;padding:10px 12px;border-radius:8px;font-size:15px;font-weight:bold;white-space:nowrap;">🔍 解析订阅</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            window._lbSubStep = 'parse'; // 当前步骤
            window._lbSubParsedResult = null;
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
                window._lbSubParsedResult = null;
                resultEl.style.display = 'block';
                resultEl.innerHTML = '<div style="color:var(--accent);padding:10px;text-align:center;">⏳ 正在获取并解析订阅...</div>';
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
                    window._lbSubParsedResult = data;
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
            const routeHtml = data.fetch_route === 'node_tunnel'
                ? '<span style="display:inline-block;margin:0 0 7px;padding:3px 8px;border-radius:5px;background:rgba(0,201,183,.13);border:1px solid rgba(0,201,183,.28);color:var(--accent);font-size:11px;">已通过节点隧道获取</span>'
                : '';
            const regionHtml = Object.entries(data.regions || {}).map(([code, info]) =>
                `<span style="background:var(--bg-secondary);padding:2px 8px;border-radius:10px;font-size:11px;">${escapeHtml(info.label || code)} ×${Number(info.count || 0)}</span>`
            ).join(' ');

            const protocolLabels = {
                hysteria2: 'Hysteria2',
                hy2: 'Hysteria2',
                vless: 'VLESS',
                vmess: 'VMess',
                shadowsocks: 'Shadowsocks',
                ss: 'Shadowsocks',
                trojan: 'Trojan',
                tuic: 'TUIC',
                anytls: 'AnyTLS'
            };
            const protocolCounts = {};
            (data.nodes || []).forEach(node => {
                const rawType = String(node.type || 'unknown').toLowerCase();
                const label = protocolLabels[rawType] || rawType.toUpperCase();
                protocolCounts[label] = Number(protocolCounts[label] || 0) + 1;
            });
            const protocolHtml = Object.entries(protocolCounts).map(([label, count]) =>
                `<span style="padding:2px 7px;border-radius:5px;background:rgba(0,201,183,.1);color:var(--text-primary);font-size:11px;">${escapeHtml(label)} ${Number(count)}</span>`
            ).join('');

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
                    ${routeHtml}
                    <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:7px;font-size:13px;">
                        <span>节点 <strong style="color:var(--accent);">${Number((data.nodes || []).length)}</strong></span>
                        ${protocolHtml}
                    </div>
                    <div style="display:flex;gap:4px;flex-wrap:wrap;">${regionHtml}</div>
                </div>
                <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;">勾选要添加的节点（共 ${(data.nodes||[]).length} 个）：</div>
                <div style="max-height:220px;overflow-y:auto;margin-bottom:8px;border:1px solid var(--border);border-radius:6px;padding:4px 8px;">
                    ${nodesHtml}
                </div>
            `;
        }

        async function lbBatchAddFromSub() {
            const checks = document.querySelectorAll('.lb-sub-node:checked');
            if (checks.length === 0) { showToast('请至少选择一个节点', 'error'); return; }
            const msgEl = document.getElementById('lbSubAddMsg');
            const actionBtn = document.getElementById('lbSubActionBtn');
            msgEl.style.display = 'block';
            msgEl.textContent = '正在启动候选代理核心并切换节点...';
            actionBtn.disabled = true;
            actionBtn.textContent = '正在应用...';

            // 收集选中的节点索引
            const selected_node_indices = [];
            checks.forEach(chk => {
                selected_node_indices.push(parseInt(chk.dataset.index));
            });

            // 获取订阅源 (从弹窗的输入框)
            const url = document.getElementById('lbSubUrl')?.value?.trim() || '';
            const text = document.getElementById('lbSubText')?.value?.trim() || '';
            const group_name = document.getElementById('lbSubGroupName')?.value?.trim() || '';
            const parsed = window._lbSubParsedResult;
            const payload = { url, text, group_name, selected_node_indices };
            if (parsed && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
                payload.url = String(parsed.url || url || '');
                payload.parsed_nodes = parsed.nodes;
                payload.parsed_servers = parsed.servers || {};
                payload.parsed_format = String(parsed.format || 'direct');
            }

            try {
                const res = await fetch(`${API_BASE}/api/dispatcher/apply_sub`, {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (data.success) {
                    msgEl.innerHTML = `<span style="color:var(--accent-green);">${Number(data.applied_nodes_count ?? data.nodes_count ?? 0)} 个节点已生效</span>`;
                    showToast(`热重载成功: ${data.nodes_count}个出口已生效`);
                    closeLbSubModal();
                    await loadSubscriptionGroups();
                } else {
                    const attempted = Number(data.attempted_nodes_count || checks.length || 0);
                    const previousCount = Number(data.previous_nodes_count || 0);
                    const preserved = data.generation_preserved === true && previousCount > 0;
                    const title = preserved
                        ? `应用失败，原有 ${previousCount} 个节点保持运行`
                        : `应用失败，本次 ${attempted} 个节点未生效`;
                    msgEl.innerHTML = `<span style="color:#ffb84d;font-weight:700;">${escapeHtml(title)}</span>` +
                        `<span style="display:block;margin-top:3px;color:var(--text-secondary);overflow-wrap:anywhere;">${escapeHtml(data.message || '候选代理核心未能启动')}</span>`;
                    actionBtn.disabled = false;
                    actionBtn.textContent = '重新应用选中节点';
                    showToast(title, 'error');
                }
                loadLbStatus();
            } catch (e) {
                msgEl.innerHTML = `<span style="color:#ffb84d;font-weight:700;">请求状态未知，请刷新订阅组确认</span>` +
                    `<span style="display:block;margin-top:3px;color:var(--text-secondary);overflow-wrap:anywhere;">${escapeHtml(e.message || '')}</span>`;
                actionBtn.disabled = false;
                actionBtn.textContent = '重新应用选中节点';
                showToast('请求失败: ' + e.message, 'error');
            }
        }

        async function lbReloadSingbox() {
            return lbRestartProxyCore('all');
        }

        async function lbStartSingbox() {
            return lbRestartProxyCore('all');
        }

        async function lbRestartProxyCore(coreType) {
            const label = coreType === 'mihomo' ? 'mihomo' : coreType === 'singbox' ? 'sing-box' : '代理核心';
            try {
                showToast(`正在重启 ${label}...`, 'info');
                const res = await fetch(`${API_BASE}/api/dispatcher/proxy_core/restart`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({core_type: coreType || 'all'})
                });
                const data = await res.json();
                if (data.success) {
                    showToast(data.message || '重启完成', 'success');
                } else {
                    const result = data.result || {};
                    const detail = result.log_tail ? `\n\n最近日志：\n${result.log_tail}` : '';
                    showAlert((data.message || '重启失败') + detail, 'error');
                }
                await loadLbStatus();
            } catch (e) {
                showToast('重启失败: ' + e.message, 'error');
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
                        控制所有出口节点的每秒请求上限，并决定是否按实时负载公平分配请求。
                    </div>
                    <div style="display:flex;flex-direction:column;gap:10px;">
                        <label style="font-size:13px;color:var(--text-primary);">每节点请求上限 (req/s):</label>
                        <input id="lbPolicyRpsInput" type="number" min="1" max="20" step="1" value="${rate}"
                            style="background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-primary);font-size:14px;width:100%;">
                        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-primary);">
                            <input id="lbPolicyLatencyEnabled" type="checkbox" ${enabled ? 'checked' : ''} style="accent-color:var(--accent);">
                            启用公平负载调度
                        </label>
                        <div style="font-size:11px;color:var(--text-secondary);">
                            源站延迟仅在负载相同时参与排序。连接失败按 10、30、60、180、300、900、3600 秒逐级保护，任意一次成功后重置；系统至少保留 100 个已验证出口。节点会每 60 分钟自动检测业务源站。
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;margin-top:12px;">
                        <button onclick="document.getElementById('lbPolicyRpsInput').value=1" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(255,165,0,0.3);background:rgba(255,165,0,0.1);color:#ffa502;cursor:pointer;font-size:12px;">1/s</button>
                        <button onclick="document.getElementById('lbPolicyRpsInput').value=3" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(0,212,255,0.3);background:rgba(0,212,255,0.1);color:var(--accent);cursor:pointer;font-size:12px;">3/s</button>
                        <button onclick="document.getElementById('lbPolicyRpsInput').value=5" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(0,255,136,0.3);background:rgba(0,255,136,0.1);color:#00ff88;cursor:pointer;font-size:12px;">5/s</button>
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
        let subscriptionGroupsRefreshPromise = null;
        let subscriptionGroupsRefreshQueued = false;
        let subscriptionGroupsLoaded = false;
        let subscriptionGroupStatusSyncActive = false;
        let subscriptionGroupProbeSignature = null;

        function resetSubscriptionGroupStatusSync(active) {
            subscriptionGroupStatusSyncActive = Boolean(active);
            subscriptionGroupProbeSignature = null;
            subscriptionGroupsLoaded = false;
            if (!subscriptionGroupStatusSyncActive) {
                subscriptionGroupsRefreshQueued = false;
            }
        }

        function getSubscriptionExitProbeState(exitItem) {
            if (exitItem.dispatch_ready && !exitItem.frozen) return 'available';
            const failures = Number(exitItem.source_probe_failures || 0);
            if (exitItem.healthy !== false && (
                exitItem.source_probing ||
                (!exitItem.source_probe_checked_at && failures === 0)
            )) return 'pending';
            return 'unavailable';
        }

        function buildSubscriptionGroupProbeSignature(data) {
            const exits = Array.isArray(data && data.exits) ? data.exits : [];
            return exits
                .filter(exitItem => exitItem && exitItem.type !== 'direct')
                .map((exitItem, position) => {
                    const index = Number.isFinite(Number(exitItem.index)) ? Number(exitItem.index) : position;
                    const localPort = Number(exitItem.local_port || 0);
                    return `${index}:${localPort}:${getSubscriptionExitProbeState(exitItem)}`;
                })
                .sort()
                .join('|');
        }

        function syncSubscriptionGroupStatus(data) {
            if (!subscriptionGroupStatusSyncActive) return;
            const nextSignature = buildSubscriptionGroupProbeSignature(data);
            if (subscriptionGroupProbeSignature === null) {
                subscriptionGroupProbeSignature = nextSignature;
                if (subscriptionGroupsLoaded || subscriptionGroupsRefreshPromise) loadSubscriptionGroups();
                return;
            }
            if (nextSignature === subscriptionGroupProbeSignature) return;
            subscriptionGroupProbeSignature = nextSignature;
            if (subscriptionGroupsLoaded || subscriptionGroupsRefreshPromise) loadSubscriptionGroups();
        }

        function escapeSubGroupAttr(value) {
            return String(value ?? '').replace(/[&<>"']/g, ch => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            }[ch]));
        }

        function loadSubscriptionGroups() {
            subscriptionGroupsRefreshQueued = true;
            if (subscriptionGroupsRefreshPromise) return subscriptionGroupsRefreshPromise;

            subscriptionGroupsRefreshPromise = (async () => {
                try {
                    while (subscriptionGroupsRefreshQueued) {
                        subscriptionGroupsRefreshQueued = false;
                        try {
                            const res = await fetch(`${API_BASE}/admin/api/subscription_groups`, {
                                headers: getHeaders()
                            });
                            const data = await res.json();
                            if (data.success) {
                                subscriptionGroups = data.groups || [];
                                subscriptionGroupsLoaded = true;
                                renderSubscriptionGroups();
                            }
                        } catch (e) {
                            console.error('加载订阅组失败', e);
                        }
                    }
                } finally {
                    subscriptionGroupsRefreshPromise = null;
                }
            })();
            return subscriptionGroupsRefreshPromise;
        }

        function renderSubscriptionGroups() {
            const container = document.getElementById('subscriptionGroupsList');
            const countEl = document.getElementById('subGroupCount');
            if (!container) return;

            if (!subscriptionGroups || subscriptionGroups.length === 0) {
                container.innerHTML = '<div class="sub-groups-empty">暂无订阅组，请在设置页面导入订阅</div>';
                if (countEl) countEl.textContent = '0 个';
                return;
            }

            if (countEl) countEl.textContent = `${subscriptionGroups.length} 个`;

            const html = subscriptionGroups.map(group => {
                const isExpanded = expandedGroups.has(group.id);
                const importTime = group.import_time ? new Date(group.import_time).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                }) : '未知';
                const groupIdArg = jsArg(group.id || '');
                const groupNotesArg = jsArg(group.notes || '');
                const groupNameArg = jsArg(group.name || '');
                const sourceLabel = group.source_type === 'url' ? '订阅链接' : group.source_type === 'json' ? 'JSON' : '文本';
                const activeServers = Number(group.active_servers || 0);
                const totalServers = Number(group.total_servers || 0);
                const availableNodes = Number(group.available_nodes || 0);
                const availabilityTotal = Number(group.availability_total || 0);
                const pendingNodes = Number(group.pending_nodes || 0);
                const availabilityRatio = Number(group.availability_ratio || 0);
                const formattedAvailabilityRatio = availabilityRatio.toFixed(availabilityRatio % 1 === 0 ? 0 : 1);
                const availabilityClass = availabilityTotal === 0
                    ? 'muted'
                    : pendingNodes > 0
                        ? 'pending'
                        : availabilityRatio >= 80
                            ? 'good'
                            : availabilityRatio > 0
                                ? 'warn'
                                : 'bad';
                const availabilityText = availabilityTotal === 0
                    ? '暂无启用节点'
                    : pendingNodes === availabilityTotal
                        ? `检测中 0/${availabilityTotal}`
                        : pendingNodes > 0
                            ? `可用率 ${formattedAvailabilityRatio}% · ${availableNodes}/${availabilityTotal} · ${pendingNodes} 检测中`
                            : `可用率 ${formattedAvailabilityRatio}% · ${availableNodes}/${availabilityTotal}`;

                const notesHtml = group.notes ? `
                    <div class="sub-group-note">${escapeHtml(group.notes)}</div>
                ` : '';

                return `
                    <div class="sub-group-card">
                        <div class="sub-group-head${isExpanded ? ' is-expanded' : ''}"
                             role="button"
                             tabindex="0"
                             aria-expanded="${isExpanded ? 'true' : 'false'}"
                             aria-controls="subGroupServers_${escapeSubGroupAttr(group.id || '')}"
                             onclick="toggleSubscriptionGroup(${groupIdArg})"
                             onkeydown="handleSubscriptionGroupHeaderKeydown(event, ${groupIdArg})">
                            <div class="sub-group-main">
                                <span class="sub-group-caret" aria-hidden="true"></span>
                                <div class="sub-group-info">
                                    <div class="sub-group-title" title="${escapeSubGroupAttr(group.name || '')}">${escapeHtml(group.name || '')}</div>
                                    <div class="sub-group-meta">
                                        <span class="sub-group-pill">导入 ${escapeHtml(importTime)}</span>
                                        <span class="sub-group-pill good">启用 ${activeServers}/${totalServers}</span>
                                        <span class="sub-group-pill ${availabilityClass}">${escapeHtml(availabilityText)}</span>
                                        <span class="sub-group-pill">${escapeHtml(sourceLabel)}</span>
                                    </div>
                                    ${notesHtml}
                                </div>
                            </div>
                            <div class="sub-group-actions" onclick="event.stopPropagation()">
                                <button class="btn sub-group-btn" onclick="editSubscriptionGroupName(${groupIdArg}, ${groupNameArg})">重命名</button>
                                <button class="btn sub-group-btn neutral" onclick="editSubscriptionGroupNotes(${groupIdArg}, ${groupNotesArg})">备注</button>
                                <button class="btn sub-group-btn danger" onclick="deleteSubscriptionGroup(${groupIdArg})">删除</button>
                            </div>
                        </div>
                        <div id="subGroupServers_${escapeSubGroupAttr(group.id || '')}" class="sub-group-servers" style="display: ${isExpanded ? 'block' : 'none'};">
                            <div class="sub-groups-empty">服务器列表加载中...</div>
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

        function handleSubscriptionGroupHeaderKeydown(event, groupId) {
            if (!event || event.target !== event.currentTarget) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggleSubscriptionGroup(groupId);
        }

        async function loadGroupServers(groupId) {
            const container = document.getElementById(`subGroupServers_${groupId}`);
            if (!container) return;

            try {
                const res = await fetch(`${API_BASE}/admin/api/subscription_groups/${encodeURIComponent(groupId)}/nodes`, { headers: getHeaders() });
                const data = await res.json();
                if (!data.success) throw new Error(data.message || '节点状态获取失败');
                const stateOrder = { available: 0, pending: 1, unavailable: 2, unsupported: 3, disabled: 4 };
                const nodes = (data.nodes || [])
                    .filter(n => n && typeof n === 'object')
                    .sort((a, b) => {
                        const byState = (stateOrder[a.availability_state] ?? 9) - (stateOrder[b.availability_state] ?? 9);
                        if (byState !== 0) return byState;
                        return String(a.name || a.server || '').localeCompare(String(b.name || b.server || ''), 'zh-CN');
                    });

                if (nodes.length === 0) {
                    container.innerHTML = '<div class="sub-groups-empty">该组暂无服务器</div>';
                    return;
                }

                const stateLabels = {
                    available: '可用',
                    pending: '检测中',
                    unavailable: '不可用',
                    unsupported: '不支持',
                    disabled: '已禁用'
                };
                const serversHtml = nodes.map((node, idx) => {
                    const enabled = node.enabled !== false;
                    const state = stateLabels[node.availability_state] ? node.availability_state : 'pending';
                    const rowClass = `sub-group-server-row state-${state}${enabled ? '' : ' is-disabled'}`;
                    const stateText = stateLabels[state];
                    const groupIdArg = jsArg(groupId);
                    const identityArg = jsArg(node.node_identity || '');
                    const endpoint = node.port ? `${node.server || ''}:${node.port}` : (node.server || '');
                    const stateTitle = state === 'unsupported' && node.core_unsupported_reason
                        ? node.core_unsupported_reason
                        : stateText;

                    return `
                        <div class="${rowClass}">
                            <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleSubscriptionNode(${groupIdArg}, ${identityArg}, this.checked)" aria-label="${enabled ? '禁用' : '启用'}节点" style="cursor: pointer; accent-color: var(--accent-green);">
                            <div style="min-width:0;">
                                <div class="sub-group-server-name" title="${escapeSubGroupAttr(node.name || node.display_name || `服务器${idx + 1}`)}">${escapeHtml(node.name || node.display_name || `服务器${idx + 1}`)}</div>
                                <div class="sub-group-server-meta" title="${escapeSubGroupAttr(endpoint)}">
                                    ${escapeHtml((node.type || 'UNKNOWN').toUpperCase())} · ${escapeHtml(endpoint)}
                                </div>
                            </div>
                            <span class="sub-group-server-state" title="${escapeSubGroupAttr(stateTitle)}">${stateText}</span>
                        </div>
                    `;
                }).join('');

                const groupIdArg = jsArg(groupId);
                const actionsHtml = `
                    <div class="sub-group-server-tools">
                        <button class="btn sub-group-btn" onclick="toggleAllServers(${groupIdArg}, true)">全部启用</button>
                        <button class="btn sub-group-btn neutral" onclick="toggleAllServers(${groupIdArg}, false)">全部禁用</button>
                    </div>
                `;

                container.innerHTML = actionsHtml + serversHtml;
            } catch (e) {
                console.error('加载订阅组服务器失败', e);
                container.innerHTML = '<div class="sub-groups-empty" style="color: var(--accent-red);">加载失败</div>';
            }
        }

        async function toggleSubscriptionNode(groupId, nodeIdentity, enabled) {
            try {
                const res = await fetch(`${API_BASE}/admin/api/subscription_groups/${encodeURIComponent(groupId)}/toggle_node`, {
                    method: 'POST',
                    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ node_identity: nodeIdentity, enabled })
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

        async function editSubscriptionGroupName(groupId, currentName) {
            const group = subscriptionGroups.find(g => g.id === groupId);
            const groupName = currentName || (group ? group.name : groupId);

            showModal('重命名订阅组', `
                <div style="margin-bottom: 12px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text-primary); font-weight: 800;">当前名称</label>
                    <div style="margin-bottom: 12px; color: var(--text-secondary); font-size: 13px; word-break: break-word;">${escapeHtml(groupName || '')}</div>
                    <label style="display: block; margin-bottom: 6px; color: var(--text-secondary); font-size: 13px;">新名称</label>
                    <input type="text" id="editSubGroupNameInput" class="sub-group-input" value="${escapeSubGroupAttr(groupName || '')}" maxlength="80" placeholder="请输入订阅组名称">
                </div>
            `, async () => {
                const name = document.getElementById('editSubGroupNameInput').value.trim();
                if (!name) {
                    showToast('订阅组名称不能为空', 'error');
                    return;
                }
                try {
                    const res = await fetch(`${API_BASE}/admin/api/subscription_groups/${groupId}/name`, {
                        method: 'PATCH',
                        headers: { ...getHeaders(), 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name })
                    });
                    const data = await res.json();
                    if (data.success) {
                        showToast('订阅组名称已更新', 'success');
                        closeModal();
                        await loadSubscriptionGroups();
                        await loadLbStatus();
                    } else {
                        showToast(data.message || '更新失败', 'error');
                    }
                } catch (e) {
                    showToast('更新失败: ' + e.message, 'error');
                }
            }, '保存');
        }

        async function editSubscriptionGroupNotes(groupId, currentNotes) {
            const group = subscriptionGroups.find(g => g.id === groupId);
            const groupName = group ? group.name : groupId;

            showModal('编辑订阅组备注', `
                <div style="margin-bottom: 12px;">
                    <label style="display: block; margin-bottom: 8px; color: var(--text-primary); font-weight: 800;">订阅组：${escapeHtml(groupName)}</label>
                    <label style="display: block; margin-bottom: 6px; color: var(--text-secondary); font-size: 13px;">备注内容</label>
                    <textarea id="editNotesInput" class="sub-group-textarea" maxlength="500" placeholder="例如：套餐、到期时间、用途说明">${escapeHtml(currentNotes)}</textarea>
                    <div style="margin-top: 6px; font-size: 11px; color: var(--text-secondary);">用于记录订阅来源、到期时间或节点用途。</div>
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
                        closeModal();
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
            lbRestartProxyCore,
            lbShowLoginLimitModal,
            lbSetLoginLimit,
            lbShowPolicyModal,
            lbSetPolicy,
            lbShowRateLimit,
            lbSetRate,
            lbShowErrorLogs,
            loadSubscriptionGroups,
            toggleSubscriptionGroup,
            handleSubscriptionGroupHeaderKeydown,
            toggleSubscriptionNode,
            toggleAllServers,
            editSubscriptionGroupName,
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
            handleSubscriptionGroupHeaderKeydown,
            toggleSubscriptionNode,
            toggleAllServers,
            editSubscriptionGroupName,
            editSubscriptionGroupNotes,
            deleteSubscriptionGroup,
        };
})();
