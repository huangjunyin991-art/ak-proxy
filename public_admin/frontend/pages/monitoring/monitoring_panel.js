(function() {
    if (window.AKMonitoringPanelLoaded) return;
    window.AKMonitoringPanelLoaded = true;

    var state = {
        initialized: false,
        active: false,
        range: '7d',
        staticCacheEntryFilter: 'all',
        lightTimer: null,
        heavyTimer: null,
        startupHeavyTimer: null,
        indexPlanTimer: null,
        loadingHeavy: false,
        loadingLight: false,
        data: {
            system: null,
            health: null,
            database: null,
            chat: null,
            groups: null,
            fileAssets: null,
            wsTickets: null,
            staticCache: null,
            staticCacheEntries: null,
            staticCachePrewarm: null,
            runtimeHygiene: null,
            runtimePerformance: null,
            indexPlan: null
        },
        loadingWsTickets: false,
        loadingStaticCache: false,
        loadingStaticCacheEntries: false,
        loadingStaticCachePrewarm: false,
        loadingRuntimeHygiene: false,
        loadingRuntimePerformance: false,
        loadingIndexPlan: false,
        loadingCollapsible: {}
    };
    var MONITORING_POLL_OWNER = 'panel:monitoring';
    var monitoringPollingRegistered = false;

    function shouldRunMonitoringPoll() {
        if (!state.active) return false;
        if (typeof window.shouldRunAdminPanelPoll === 'function') {
            return window.shouldRunAdminPanelPoll('monitoring');
        }
        return document.visibilityState === 'visible';
    }

    function setupMonitoringPollingRegistry() {
        var registry = window.AKPollingRegistry;
        if (!registry || monitoringPollingRegistered) return registry || null;
        monitoringPollingRegistered = true;
        registry.register({
            id: 'monitoring.light',
            owner: MONITORING_POLL_OWNER,
            intervalMs: 5000,
            jitterMs: 700,
            immediate: false,
            dedupeKey: 'monitoring.light',
            runWhen: shouldRunMonitoringPoll,
            task: function() {
                return Promise.all([
                    loadLight(false),
                    loadWsTickets(false),
                    loadRuntimeHygiene(false),
                    loadRuntimePerformance(false)
                ]);
            }
        });
        registry.register({
            id: 'monitoring.heavy',
            owner: MONITORING_POLL_OWNER,
            intervalMs: 3600000,
            jitterMs: 10000,
            immediate: false,
            dedupeKey: 'monitoring.heavy',
            runWhen: shouldRunMonitoringPoll,
            task: function() {
                return loadHeavy(false);
            }
        });
        return registry;
    }

    function collapsibleSection(key) {
        if (!key || !document.querySelector) return null;
        return document.querySelector('[data-monitoring-section="' + key + '"]');
    }

    function isCollapsibleSectionOpen(key) {
        var section = collapsibleSection(key);
        return !!(section && section.open === true);
    }

    function isAnyCollapsibleSectionOpen(keys) {
        for (var i = 0; i < keys.length; i++) {
            if (isCollapsibleSectionOpen(keys[i])) return true;
        }
        return false;
    }

    function shouldLoadCollapsibleSection(key) {
        return state.active && isCollapsibleSectionOpen(key);
    }

    function shouldLoadRuntimeHygiene() {
        return state.active && isAnyCollapsibleSectionOpen(['runtimeHygiene', 'staticCache']);
    }

    function loadCollapsibleSection(key, force) {
        if (key === 'chat') return loadChatSummary(force);
        if (key === 'database') return loadDatabaseStats(force);
        if (key === 'groups') return loadGroupStorage(force);
        if (key === 'fileAssets') return loadFileAssets(force);
        if (key === 'indexPlan') return loadIndexPlan(force);
        if (key === 'runtimeHygiene') return loadRuntimeHygiene(force);
        if (key === 'staticCache') {
            return Promise.allSettled([loadStaticCachePolicy(force), loadRuntimeHygiene(force)]);
        }
        return Promise.resolve();
    }

    function token() {
        return sessionStorage.getItem('admin_token') || '';
    }

    function mount() {
        return document.getElementById('monitoringPanelMount');
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>'"]/g, function(ch) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[ch] || ch;
        });
    }

    function formatBytes(value) {
        var n = Number(value || 0);
        if (!isFinite(n) || n <= 0) return '0 B';
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var index = 0;
        while (n >= 1024 && index < units.length - 1) {
            n = n / 1024;
            index += 1;
        }
        return (index === 0 ? String(Math.round(n)) : n.toFixed(n >= 10 ? 1 : 2)) + ' ' + units[index];
    }

    function formatNumber(value) {
        var n = Number(value || 0);
        if (!isFinite(n)) return '0';
        return Math.round(n).toLocaleString('zh-CN');
    }

    function formatPercent(value) {
        var n = Number(value);
        if (!isFinite(n)) return '-';
        return n.toFixed(1) + '%';
    }

    function formatTime(value) {
        if (!value) return '-';
        var date = new Date(value);
        if (isNaN(date.getTime())) return '-';
        return date.toLocaleString('zh-CN', { hour12: false });
    }

    function formatDuration(seconds) {
        var total = Math.max(0, Math.floor(Number(seconds || 0)));
        var days = Math.floor(total / 86400);
        var hours = Math.floor((total % 86400) / 3600);
        var minutes = Math.floor((total % 3600) / 60);
        if (days > 0) return days + '天 ' + hours + '小时';
        if (hours > 0) return hours + '小时 ' + minutes + '分钟';
        return minutes + '分钟';
    }

    function formatSeconds(value) {
        var total = Math.max(0, Math.round(Number(value || 0)));
        if (total >= 86400) return Math.round(total / 86400 * 10) / 10 + '天';
        if (total >= 3600) return Math.round(total / 3600 * 10) / 10 + '小时';
        if (total >= 60) return Math.round(total / 60 * 10) / 10 + '分钟';
        return total + '秒';
    }

    function formatMs(value) {
        var n = Number(value || 0);
        if (!isFinite(n) || n < 0) return '-';
        if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 1 : 2) + ' s';
        return n.toFixed(n >= 10 ? 1 : 2) + ' ms';
    }

    function formatSampleTime(value) {
        var n = Number(value || 0);
        if (!isFinite(n) || n <= 0) return '-';
        return formatTime(n < 1000000000000 ? n * 1000 : n);
    }

    function secondsToDays(value) {
        var seconds = Number(value || 0);
        return Math.max(0, Math.round(seconds / 86400 * 100) / 100);
    }

    function secondsToHours(value) {
        var seconds = Number(value || 0);
        return Math.max(0, Math.round(seconds / 3600 * 100) / 100);
    }

    function daysToSeconds(value) {
        return Math.max(60, Math.round(Number(value || 0) * 86400));
    }

    function daysToSecondsAllowZero(value) {
        return Math.max(0, Math.round(Number(value || 0) * 86400));
    }

    function hoursToSeconds(value) {
        return Math.max(60, Math.round(Number(value || 0) * 3600));
    }

    function bytesToMb(value) {
        return Math.max(1, Math.round(Number(value || 0) / 1024 / 1024 * 100) / 100);
    }

    function bytesToKb(value) {
        return Math.max(16, Math.round(Number(value || 0) / 1024));
    }

    function mbToBytes(value) {
        return Math.max(1024 * 1024, Math.round(Number(value || 0) * 1024 * 1024));
    }

    function kbToBytes(value) {
        return Math.max(16 * 1024, Math.round(Number(value || 0) * 1024));
    }

    function api(path, params) {
        var query = new URLSearchParams(params || {});
        var url = '/admin/api/monitoring' + path + (query.toString() ? '?' + query.toString() : '');
        return fetch(url, {
            headers: { 'Authorization': 'Bearer ' + token() },
            credentials: 'same-origin'
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error) throw new Error(body.message || body.detail || '监控接口请求失败');
                return body;
            });
        });
    }

    function apiPost(path, payload) {
        return fetch('/admin/api/monitoring' + path, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token(),
                'Content-Type': 'application/json'
            },
            credentials: 'same-origin',
            body: JSON.stringify(payload || {})
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error) throw new Error(body.message || body.detail || '监控接口请求失败');
                return body;
            });
        });
    }

    function performanceApi(path, params) {
        var query = new URLSearchParams(params || {});
        var url = '/admin/api/performance' + path + (query.toString() ? '?' + query.toString() : '');
        return fetch(url, {
            headers: { 'Authorization': 'Bearer ' + token() },
            credentials: 'same-origin'
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error) throw new Error(body.message || body.detail || '运行时性能接口请求失败');
                return body;
            });
        });
    }

    function performancePost(path, payload) {
        return fetch('/admin/api/performance' + path, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token(),
                'Content-Type': 'application/json'
            },
            credentials: 'same-origin',
            body: JSON.stringify(payload || {})
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error) throw new Error(body.message || body.detail || '运行时性能接口请求失败');
                return body;
            });
        });
    }

    function ensureCss() {
        if (document.querySelector('link[data-monitoring-panel-css="1"]')) return;
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/admin/api/monitoring-panel.css?v=20260608-05';
        link.setAttribute('data-monitoring-panel-css', '1');
        document.head.appendChild(link);
    }

    function notify(message, type) {
        try {
            if (typeof showToast === 'function') {
                showToast(message, type || 'info');
                return;
            }
        } catch (e) {}
        if (type === 'error') console.error('[MonitoringPanel]', message);
    }

    function setHtmlIfChanged(el, html) {
        var next = String(html == null ? '' : html);
        if (!el || el._monitoringRenderHtml === next) return;
        el.innerHTML = next;
        el._monitoringRenderHtml = next;
    }

    function setTextIfChanged(el, text) {
        var next = String(text == null ? '' : text);
        if (!el || el.textContent === next) return;
        el.textContent = next;
    }

    function buildShell() {
        var el = mount();
        if (!el) return;
        el.innerHTML = '<div class="monitoring-root">' +
            '<div class="monitoring-header">' +
            '<div class="monitoring-title"><h3>性能监控</h3><p>低成本健康状态 5 秒刷新，高成本统计 1 小时刷新；高负载时优先保护正常业务。</p></div>' +
            '<div class="monitoring-actions">' +
            '<select class="monitoring-select" id="monitoringRange"><option value="24h">24小时</option><option value="7d" selected>7天</option><option value="30d">30天</option></select>' +
            '<button class="monitoring-btn" id="monitoringRefreshLight">刷新状态</button>' +
            '<button class="monitoring-btn primary" id="monitoringRefreshHeavy">刷新统计</button>' +
            '</div>' +
            '</div>' +
            '<div class="monitoring-alert" id="monitoringAlert"></div>' +
            '<div class="monitoring-section"><div class="monitoring-section-header"><h4>服务器负载</h4><span class="monitoring-meta" id="monitoringSystemMeta">-</span></div><div class="monitoring-donuts" id="monitoringSystemDonuts"></div><div class="monitoring-bars" id="monitoringSystemBars"></div></div>' +
            '<div class="monitoring-grid" id="monitoringCards"></div>' +
            '<div class="monitoring-section monitoring-ws-ticket-section">' +
            '<div class="monitoring-section-header"><h4>WebSocket 短票握手</h4><span class="monitoring-meta" id="monitoringWsTicketMeta">读取中...</span></div>' +
            '<div class="monitoring-cache-grid monitoring-ws-ticket-policy-grid">' +
            '<label class="monitoring-switch-card"><input id="wsTicketDiagnosticsEnabled" type="checkbox"><span class="monitoring-switch-control"></span><span class="monitoring-switch-copy"><strong>启用诊断写入</strong><small>关闭后短票安全仍生效，但不写入事件表</small></span></label>' +
            '<label><span>自动关闭（分钟）</span><input class="monitoring-input" id="wsTicketDiagnosticsMinutes" type="number" min="5" max="1440" step="5"></label>' +
            '<label><span>事件保留（天）</span><input class="monitoring-input" id="wsTicketDiagnosticsRetentionDays" type="number" min="1" max="30" step="1"></label>' +
            '</div>' +
            '<div class="monitoring-cache-actions monitoring-ws-ticket-actions"><button class="monitoring-btn primary" data-monitoring-action="save-ws-ticket-policy">保存诊断策略</button><span class="monitoring-meta" id="monitoringWsTicketPolicyMeta">默认关闭，仅调试时开启</span></div>' +
            '<div class="monitoring-grid" id="monitoringWsTicketCards"></div>' +
            '<div class="monitoring-bars" id="monitoringWsTicketBars"></div>' +
            '<div class="monitoring-table-wrap monitoring-ws-ticket-table-wrap"><table class="monitoring-table monitoring-ws-ticket-table"><thead><tr><th>Audience</th><th>签发</th><th>消费</th><th>拒绝</th><th>待消费</th><th>过期未用</th><th>最近事件</th></tr></thead><tbody id="monitoringWsTicketAudienceRows"></tbody></table></div>' +
            '<div class="monitoring-table-wrap monitoring-ws-ticket-failure-wrap"><table class="monitoring-table monitoring-ws-ticket-failure-table"><thead><tr><th>时间</th><th>Audience</th><th>原因</th><th>角色</th><th>资源</th><th>账号</th><th>IP</th></tr></thead><tbody id="monitoringWsTicketFailureRows"></tbody></table></div>' +
            '</div>' +
            '<div class="monitoring-section monitoring-runtime-performance-section">' +
            '<div class="monitoring-section-header"><h4>运行时性能</h4><span class="monitoring-meta" id="monitoringRuntimePerformanceMeta">读取中...</span></div>' +
            '<div class="monitoring-grid" id="monitoringRuntimePerformanceCards"></div>' +
            '<div class="monitoring-bars" id="monitoringRuntimePerformanceBars"></div>' +
            '<div class="monitoring-table-wrap monitoring-runtime-performance-table-wrap"><table class="monitoring-table monitoring-runtime-performance-table"><thead><tr><th>类型</th><th>指标</th><th>函数/调用点</th><th>排队/等待</th><th>运行/滞后</th><th>时间</th></tr></thead><tbody id="monitoringRuntimePerformanceRows"></tbody></table></div>' +
            '</div>' +
            '<details class="monitoring-section monitoring-chat-section monitoring-collapsible-section" data-monitoring-section="chat">' +
            '<summary class="monitoring-section-header monitoring-collapsible-summary"><h4>聊天统计</h4><span class="monitoring-meta" id="monitoringChatMeta">-</span></summary>' +
            '<div class="monitoring-grid" id="monitoringChatCards"></div><div class="monitoring-bars" id="monitoringTypeBars" style="margin-top:14px;"></div>' +
            '</details>' +
            '<details class="monitoring-section monitoring-db-section monitoring-collapsible-section" data-monitoring-section="database"><summary class="monitoring-section-header monitoring-collapsible-summary"><h4>数据库表占用</h4><span class="monitoring-meta" id="monitoringDbMeta">-</span></summary><div class="monitoring-bars" id="monitoringDbBars"></div></details>' +
            '<details class="monitoring-section monitoring-index-panel monitoring-collapsible-section" data-monitoring-section="indexPlan"><summary class="monitoring-section-header monitoring-collapsible-summary"><h4>索引优化计划</h4><span class="monitoring-meta" id="monitoringIndexPlanMeta">读取中...</span></summary>' +
            '<div class="monitoring-grid monitoring-index-cards" id="monitoringIndexPlanCards"></div>' +
            '<div class="monitoring-cache-actions"><button class="monitoring-btn" data-monitoring-action="refresh-index-plan">刷新索引状态</button><button class="monitoring-btn primary" data-monitoring-action="run-index-plan">执行 1 个缺失索引</button><span class="monitoring-meta">使用 CONCURRENTLY 小批量执行，避免长时间锁表；大表仍建议低峰操作。</span></div>' +
            '<div class="monitoring-table-wrap monitoring-index-table-wrap"><table class="monitoring-table monitoring-index-table"><thead><tr><th>索引</th><th>状态</th><th>表</th><th>用途</th><th>风险</th><th>说明</th></tr></thead><tbody id="monitoringIndexPlanRows"></tbody></table></div>' +
            '<div class="monitoring-table-wrap monitoring-index-result-wrap"><table class="monitoring-table monitoring-index-result-table"><thead><tr><th>最近执行</th><th>结果</th><th>耗时</th><th>时间</th><th>信息</th></tr></thead><tbody id="monitoringIndexRunRows"></tbody></table></div></details>' +
            '<details class="monitoring-section monitoring-file-assets-section monitoring-collapsible-section" data-monitoring-section="fileAssets"><summary class="monitoring-section-header monitoring-collapsible-summary"><h4>文件资源 Top</h4><span class="monitoring-meta" id="monitoringFileAssetMeta">按 active 文件大小倒序；删除后聊天消息保留，附件显示失效</span></summary><div class="monitoring-table-wrap"><table class="monitoring-table"><thead><tr><th>文件名</th><th>类型</th><th>大小</th><th>状态</th><th>引用消息</th><th>过期时间</th><th>创建时间</th><th>storage_name</th><th>操作</th></tr></thead><tbody id="monitoringFileAssetRows"></tbody></table></div></details>' +
            '<details class="monitoring-section monitoring-group-storage-section monitoring-collapsible-section" data-monitoring-section="groups"><summary class="monitoring-section-header monitoring-collapsible-summary"><h4>群组存储与活跃排行</h4><span class="monitoring-meta" id="monitoringGroupMeta">文件占用为消息载荷估算口径</span></summary><div class="monitoring-table-wrap"><table class="monitoring-table"><thead><tr><th>群组</th><th>群主</th><th>成员</th><th>管理员</th><th>总消息</th><th>今日</th><th>范围内</th><th>纯文本</th><th>消息载荷</th><th>文件估算</th><th>总占用</th><th>最近活跃</th></tr></thead><tbody id="monitoringGroupRows"></tbody></table></div></details>' +
            '<details class="monitoring-section monitoring-runtime-section monitoring-collapsible-section" data-monitoring-section="runtimeHygiene">' +
            '<summary class="monitoring-section-header monitoring-collapsible-summary"><h4>运行时维护</h4><span class="monitoring-meta" id="monitoringRuntimeMeta">读取中...</span></summary>' +
            '<div class="monitoring-grid" id="monitoringRuntimeCards"></div>' +
            '<div class="monitoring-cache-grid monitoring-runtime-policy-grid">' +
            '<label class="monitoring-switch-card"><input id="runtimeHygieneEnabled" type="checkbox"><span class="monitoring-switch-control"></span><span class="monitoring-switch-copy"><strong>启用自动维护</strong><small>周期清理过期缓存和空闲连接</small></span></label>' +
            '<label class="monitoring-switch-card"><input id="runtimeCleanupBrowseSessions" type="checkbox"><span class="monitoring-switch-control"></span><span class="monitoring-switch-copy"><strong>清理浏览会话</strong><small>移除过期 AK 页面会话</small></span></label>' +
            '<label class="monitoring-switch-card"><input id="runtimeCleanupAkAuthCache" type="checkbox"><span class="monitoring-switch-control"></span><span class="monitoring-switch-copy"><strong>清理 AK 登录缓存</strong><small>移除过期登录态缓存</small></span></label>' +
            '<label class="monitoring-switch-card"><input id="runtimeCleanupStaticLocks" type="checkbox"><span class="monitoring-switch-control"></span><span class="monitoring-switch-copy"><strong>清理静态资源锁</strong><small>释放无请求占用的缓存锁</small></span></label>' +
            '<label><span>维护周期（秒）</span><input class="monitoring-input" id="runtimeCleanupInterval" type="number" min="5" step="5"></label>' +
            '<label><span>AK 代理连接最大寿命（秒）</span><input class="monitoring-input" id="runtimeAkClientMaxAge" type="number" min="60" step="30"></label>' +
            '<label><span>AK 代理连接最大请求数</span><input class="monitoring-input" id="runtimeAkClientMaxRequests" type="number" min="10" step="10"></label>' +
            '<label><span>AK 代理连接空闲释放（秒）</span><input class="monitoring-input" id="runtimeAkClientIdle" type="number" min="30" step="30"></label>' +
            '<label><span>出口连接最大寿命（秒）</span><input class="monitoring-input" id="runtimeOutboundClientMaxAge" type="number" min="60" step="30"></label>' +
            '<label><span>出口连接最大请求数</span><input class="monitoring-input" id="runtimeOutboundClientMaxRequests" type="number" min="10" step="10"></label>' +
            '<label><span>出口连接空闲释放（秒）</span><input class="monitoring-input" id="runtimeOutboundClientIdle" type="number" min="30" step="30"></label>' +
            '</div>' +
            '<div class="monitoring-cache-actions monitoring-runtime-actions">' +
            '<button class="monitoring-btn primary" data-monitoring-action="save-runtime-hygiene">保存运行时配置</button>' +
            '<button class="monitoring-btn" data-monitoring-action="run-runtime-hygiene-once">立即清理一次</button>' +
            '<button class="monitoring-btn" data-monitoring-action="refresh-runtime-hygiene">刷新运行态</button>' +
            '<span class="monitoring-meta">连接池状态属于性能监控，保存后立即应用到当前进程。</span>' +
            '</div>' +
            '<div class="monitoring-table-wrap monitoring-runtime-table-wrap"><table class="monitoring-table"><thead><tr><th>连接池</th><th>节点</th><th>状态</th><th>年龄</th><th>空闲</th><th>请求</th><th>换新次数</th><th>最近原因</th></tr></thead><tbody id="monitoringRuntimeClientRows"></tbody></table></div>' +
            '</details>' +
            '<details class="monitoring-section monitoring-cache-section monitoring-collapsible-section" data-monitoring-section="staticCache">' +
            '<summary class="monitoring-section-header monitoring-collapsible-summary"><h4>K937 静态资源缓存策略</h4><span class="monitoring-meta" id="monitoringStaticCacheMeta">读取中...</span></summary>' +
            '<div class="monitoring-grid" id="monitoringStaticCacheRuntimeCards"></div>' +
            '<div class="monitoring-cache-grid">' +
            '<label class="monitoring-switch-card"><input id="staticCacheMemoryEnabled" type="checkbox"><span class="monitoring-switch-control"></span><span class="monitoring-switch-copy"><strong>启用 L1 内存缓存</strong><small>关闭后回退到磁盘静态缓存</small></span></label>' +
            '<label class="monitoring-switch-card"><input id="staticCacheMemoryStatsEnabled" type="checkbox"><span class="monitoring-switch-control"></span><span class="monitoring-switch-copy"><strong>启用实时统计</strong><small>只影响 hit/miss 等计数</small></span></label>' +
            '<label><span>L1 最大条目</span><input class="monitoring-input" id="staticCacheMemoryMaxEntries" type="number" min="1" step="16"></label>' +
            '<label><span>L1 总内存（MB）</span><input class="monitoring-input" id="staticCacheMemoryMaxMb" type="number" min="1" step="1"></label>' +
            '<label><span>L1 单资源上限（KB）</span><input class="monitoring-input" id="staticCacheMemoryMaxBodyKb" type="number" min="16" step="16"></label>' +
            '<label><span>JS 浏览器缓存（小时）</span><input class="monitoring-input" id="staticCacheJsBrowserHours" type="number" min="1" step="1"></label>' +
            '<label><span>CSS 浏览器缓存（天）</span><input class="monitoring-input" id="staticCacheCssBrowserDays" type="number" min="1" step="1"></label>' +
            '<label><span>图片/字体浏览器缓存（天）</span><input class="monitoring-input" id="staticCacheMediaBrowserDays" type="number" min="1" step="1"></label>' +
            '<label><span>JS 服务端缓存（天）</span><input class="monitoring-input" id="staticCacheJsDiskDays" type="number" min="1" step="1"></label>' +
            '<label><span>CSS 服务端缓存（天）</span><input class="monitoring-input" id="staticCacheCssDiskDays" type="number" min="1" step="1"></label>' +
            '<label><span>图片/字体服务端缓存（天）</span><input class="monitoring-input" id="staticCacheMediaDiskDays" type="number" min="1" step="1"></label>' +
            '<label><span>stale-while-revalidate（天）</span><input class="monitoring-input" id="staticCacheStaleDays" type="number" min="0" step="1"></label>' +
            '</div>' +
            '<div class="monitoring-cache-actions">' +
            '<button class="monitoring-btn primary" data-monitoring-action="save-static-cache-policy">保存缓存时间</button>' +
            '<button class="monitoring-btn danger" data-monitoring-action="refresh-static-cache-upstream">立即启用上游新资源</button>' +
            '<button class="monitoring-btn primary" data-monitoring-action="prewarm-static-cache">预热常用页面资源</button>' +
            '<button class="monitoring-btn" data-monitoring-action="refresh-static-cache-entries">刷新缓存条目</button>' +
            '<span class="monitoring-meta">HTML 继续 no-store；点击启用新资源会清空服务端静态缓存并切换全局资源版本。</span>' +
            '</div>' +
            '<div class="monitoring-grid" id="monitoringStaticCachePrewarmCards"></div>' +
            '<div class="monitoring-table-wrap monitoring-static-cache-prewarm-table-wrap"><table class="monitoring-table monitoring-static-cache-prewarm-table"><thead><tr><th>页面</th><th>状态</th><th>发现资源</th><th>耗时</th><th>错误</th></tr></thead><tbody id="monitoringStaticCachePrewarmRows"></tbody></table></div>' +
            '<div class="monitoring-static-cache-entry-toolbar"><label><span>文件类型</span><select class="monitoring-select monitoring-static-cache-type-select" id="monitoringStaticCacheEntryTypeFilter"><option value="all">全部</option></select></label><span class="monitoring-meta" id="monitoringStaticCacheEntryMeta">-</span></div>' +
            '<div class="monitoring-table-wrap monitoring-static-cache-entry-table-wrap"><table class="monitoring-table monitoring-static-cache-entry-table"><thead><tr><th>资源</th><th>L1</th><th>磁盘</th><th>大小</th><th>类型</th><th>过期</th><th>写入时间</th></tr></thead><tbody id="monitoringStaticCacheEntryRows"></tbody></table></div>' +
            '</details>' +
            '</div>';
        el.addEventListener('click', function(event) {
            var target = event.target;
            var actionNode = target && target.closest ? target.closest('[data-monitoring-action]') : null;
            if (!actionNode) return;
            var action = actionNode.getAttribute('data-monitoring-action');
            if (action === 'expire-file-asset') {
                var storageName = actionNode.getAttribute('data-storage-name') || '';
                var originalName = actionNode.getAttribute('data-original-name') || storageName;
                var referencedMessages = Number(actionNode.getAttribute('data-referenced-messages') || 0);
                expireFileAsset(storageName, originalName, referencedMessages);
            } else if (action === 'save-static-cache-policy') {
                saveStaticCachePolicy();
            } else if (action === 'refresh-static-cache-upstream') {
                refreshStaticCacheUpstream();
            } else if (action === 'prewarm-static-cache') {
                prewarmStaticCache();
            } else if (action === 'refresh-static-cache-entries') {
                loadStaticCacheEntries(true);
            } else if (action === 'save-runtime-hygiene') {
                saveRuntimeHygienePolicy();
            } else if (action === 'run-runtime-hygiene-once') {
                runRuntimeHygieneOnce();
            } else if (action === 'refresh-runtime-hygiene') {
                loadRuntimeHygiene(true);
            } else if (action === 'save-ws-ticket-policy') {
                saveWsTicketPolicy();
            } else if (action === 'refresh-index-plan') {
                loadIndexPlan(true);
            } else if (action === 'run-index-plan') {
                runIndexPlan();
            }
        });
        document.getElementById('monitoringRange').addEventListener('change', function() {
            state.range = this.value || '7d';
            loadHeavy(false);
        });
        document.getElementById('monitoringRefreshLight').addEventListener('click', function() {
            loadLight(true);
            loadWsTickets(true);
            loadStaticCachePolicy();
            loadRuntimeHygiene(true);
            loadRuntimePerformance(true);
            loadIndexPlan(true);
        });
        document.getElementById('monitoringRefreshHeavy').addEventListener('click', function() { loadHeavy(true); });
        var staticCacheEntryFilter = document.getElementById('monitoringStaticCacheEntryTypeFilter');
        if (staticCacheEntryFilter) {
            staticCacheEntryFilter.addEventListener('change', function() {
                state.staticCacheEntryFilter = this.value || 'all';
                renderStaticCacheEntries();
            });
        }
        Array.prototype.forEach.call(el.querySelectorAll('details[data-monitoring-section]'), function(section) {
            section.addEventListener('toggle', function() {
                var key = section.getAttribute('data-monitoring-section') || '';
                if (!section.open) {
                    if (key === 'indexPlan') clearIndexPlanTimer();
                    return;
                }
                loadCollapsibleSection(key, false);
            });
        });
    }

    function renderCardSub(sub) {
        return String(sub || '').split('；').map(function(part) {
            return part.trim();
        }).filter(Boolean).map(function(part) {
            return '<span>' + escapeHtml(part) + '</span>';
        }).join('');
    }

    function renderCard(label, value, sub) {
        return '<div class="monitoring-card"><div class="monitoring-card-label">' + escapeHtml(label) + '</div><div class="monitoring-card-value">' + escapeHtml(value) + '</div><div class="monitoring-card-sub">' + renderCardSub(sub) + '</div></div>';
    }

    function renderProgress(label, percent, valueText) {
        var p = Math.max(0, Math.min(100, Number(percent || 0)));
        return '<div class="monitoring-bar-row"><div>' + escapeHtml(label) + '</div><div class="monitoring-bar-track"><div class="monitoring-bar-fill" style="width:' + p.toFixed(1) + '%"></div></div><div>' + escapeHtml(valueText || formatPercent(p)) + '</div></div>';
    }

    function renderDonut(label, percent, subText, color) {
        var value = Number(percent);
        var available = isFinite(value);
        var p = available ? Math.max(0, Math.min(100, value)) : 0;
        var display = available ? p.toFixed(1) + '%' : '-';
        return '<div class="monitoring-donut-card">' +
            '<div class="monitoring-donut" style="--donut-percent:' + p.toFixed(1) + '%;--donut-color:' + escapeHtml(color || '#00d4ff') + '"><span class="monitoring-donut-value">' + escapeHtml(display) + '</span></div>' +
            '<div class="monitoring-donut-info"><div class="monitoring-donut-title">' + escapeHtml(label) + '</div><div class="monitoring-donut-sub">' + escapeHtml(subText || '') + '</div></div>' +
            '</div>';
    }

    function renderRankBars(items, labelKey, valueKey, formatter, limit, itemTextBuilder) {
        var maxItems = Number(limit) > 0 ? Number(limit) : 10;
        var list = Array.isArray(items) ? items.slice(0, maxItems) : [];
        if (!list.length) return '<div class="monitoring-empty">暂无数据</div>';
        var max = list.reduce(function(acc, item) { return Math.max(acc, Number(item[valueKey] || 0)); }, 0) || 1;
        return list.map(function(item) {
            var value = Number(item[valueKey] || 0);
            var label = item[labelKey] || item.table_name || item.message_type || '-';
            var valueText = typeof itemTextBuilder === 'function'
                ? itemTextBuilder(item, value)
                : (formatter ? formatter(value) : formatNumber(value));
            return renderProgress(label, value / max * 100, valueText);
        }).join('');
    }

    function renderMessageTypeStorageBars(items) {
        var list = Array.isArray(items) ? items.slice(0, 10) : [];
        if (!list.length) return '<div class="monitoring-empty">暂无数据</div>';
        var max = list.reduce(function(acc, item) { return Math.max(acc, Number(item.estimated_storage_bytes || 0)); }, 0) || 1;
        return list.map(function(item) {
            var value = Number(item.estimated_storage_bytes || 0);
            var label = item.message_type || '-';
            var valueText = formatBytes(value) + ' / ' + formatNumber(item.count) + '条';
            return renderProgress(label, value / max * 100, valueText);
        }).join('');
    }

    function renderAlert() {
        var alert = document.getElementById('monitoringAlert');
        if (!alert) return;
        var messages = [];
        ['database', 'chat', 'groups'].forEach(function(key) {
            var item = state.data[key];
            if (item && item.delayed) messages.push(item.delay_reason || '监控统计已延迟执行');
        });
        var system = state.data.system;
        if (system && system.high_load) messages.push('当前系统负载较高：' + (system.high_load_reasons || []).join('、'));
        runtimePerformanceWarnings(state.data.runtimePerformance).forEach(function(message) {
            messages.push(message);
        });
        if (!messages.length) {
            alert.classList.remove('show');
            alert.textContent = '';
            return;
        }
        alert.classList.add('show');
        alert.textContent = Array.from(new Set(messages)).join('；');
        if (!alert.dataset.notified) {
            alert.dataset.notified = '1';
            notify(alert.textContent, 'warning');
        }
    }

    function runtimePerformanceWarnings(item) {
        var warnings = [];
        if (!item || item.error) return warnings;
        var eventLoop = item.event_loop || {};
        var blocking = item.blocking_io || {};
        var dbPool = item.db_pool || {};
        var bulkWriter = item.bulk_writer || {};
        var auditQueue = item.login_audit_queue || {};
        var acquire = dbPool.acquire_metrics || {};
        var policy = dbPool.policy || {};
        if (Number(eventLoop.p99_lag_ms || 0) >= 250) warnings.push('事件循环 p99 lag 已超过 250ms');
        if (Number(blocking.max_concurrency || 0) > 0 && Number(blocking.in_flight || 0) >= Number(blocking.max_concurrency || 0)) warnings.push('阻塞 I/O runner 已打满');
        if (Number(dbPool.usage_pct || 0) >= 90) warnings.push('DB 连接池使用率接近上限');
        if (Number(acquire.timeouts || 0) > 0) warnings.push('DB acquire 出现超时');
        if (Number(bulkWriter.failed || 0) > 0) warnings.push('批量写入出现失败');
        if (Number(auditQueue.failed || 0) > 0) warnings.push('登录审计异步写入出现失败');
        if (Number(auditQueue.max_pending || 0) > 0 && Number(auditQueue.pending || 0) / Number(auditQueue.max_pending || 1) >= 0.8) warnings.push('登录审计队列接近满载');
        if (policy.fixed_budget !== true) warnings.push('DB 连接池当前不是固定预算模式');
        return warnings;
    }

    function runtimeProgressPercent(value, threshold) {
        var n = Number(value || 0);
        var t = Number(threshold || 1);
        if (!isFinite(n) || !isFinite(t) || t <= 0) return 0;
        return Math.max(0, Math.min(100, n / t * 100));
    }

    function renderRuntimePerformanceRows(item) {
        if (!item || item.error) return '<tr><td colspan="6"><div class="monitoring-empty">运行时性能数据暂不可用</div></td></tr>';
        var eventLoop = item.event_loop || {};
        var blocking = item.blocking_io || {};
        var dbPool = item.db_pool || {};
        var bulkWriter = item.bulk_writer || {};
        var acquire = dbPool.acquire_metrics || {};
        var rows = [];
        (eventLoop.recent_slow || []).forEach(function(sample) {
            rows.push({
                kind: '事件循环',
                metric: 'lag',
                target: '-',
                wait: '-',
                run: formatMs(sample.lag_ms),
                ts: sample.ts
            });
        });
        (blocking.recent_slow || []).forEach(function(sample) {
            rows.push({
                kind: '阻塞 I/O',
                metric: 'slow',
                target: sample.func || '-',
                wait: formatMs(sample.queue_ms),
                run: formatMs(sample.run_ms),
                ts: sample.ts
            });
        });
        (acquire.recent_slow || []).forEach(function(sample) {
            rows.push({
                kind: 'DB acquire',
                metric: 'slow',
                target: sample.callsite || '-',
                wait: formatMs(sample.wait_ms),
                run: '-',
                ts: sample.ts
            });
        });
        (acquire.recent_errors || []).forEach(function(sample) {
            rows.push({
                kind: 'DB acquire',
                metric: sample.error || 'error',
                target: sample.callsite || '-',
                wait: formatMs(sample.wait_ms),
                run: sample.error || '-',
                ts: sample.ts
            });
        });
        (bulkWriter.recent || []).forEach(function(sample) {
            rows.push({
                kind: '批量写入',
                metric: sample.failed ? (sample.error || 'error') : 'slow',
                target: sample.operation || '-',
                wait: '-',
                run: formatMs(sample.elapsed_ms),
                ts: sample.ts
            });
        });
        rows.sort(function(a, b) { return Number(b.ts || 0) - Number(a.ts || 0); });
        if (!rows.length) return '<tr><td colspan="6"><div class="monitoring-empty">暂无慢样本或错误</div></td></tr>';
        return rows.slice(0, 24).map(function(row) {
            return '<tr>' +
                '<td>' + escapeHtml(row.kind) + '</td>' +
                '<td>' + escapeHtml(row.metric) + '</td>' +
                '<td>' + escapeHtml(row.target) + '</td>' +
                '<td>' + escapeHtml(row.wait) + '</td>' +
                '<td>' + escapeHtml(row.run) + '</td>' +
                '<td>' + escapeHtml(formatSampleTime(row.ts)) + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderRuntimePerformance() {
        var item = state.data.runtimePerformance || {};
        var cards = document.getElementById('monitoringRuntimePerformanceCards');
        var bars = document.getElementById('monitoringRuntimePerformanceBars');
        var rows = document.getElementById('monitoringRuntimePerformanceRows');
        var meta = document.getElementById('monitoringRuntimePerformanceMeta');
        if (!item.error && !item.event_loop && !item.blocking_io && !item.db_pool && !item.bulk_writer) {
            if (cards) setHtmlIfChanged(cards, renderCard('运行时性能', '读取中', '等待首次轻量刷新'));
            if (bars) setHtmlIfChanged(bars, '');
            if (rows) setHtmlIfChanged(rows, '<tr><td colspan="6"><div class="monitoring-empty">等待首次采样</div></td></tr>');
            if (meta) setTextIfChanged(meta, '读取中...');
            return;
        }
        if (item.error) {
            if (cards) setHtmlIfChanged(cards, renderCard('运行时性能', '不可用', item.error));
            if (bars) setHtmlIfChanged(bars, '');
            if (rows) setHtmlIfChanged(rows, renderRuntimePerformanceRows(item));
            if (meta) setTextIfChanged(meta, '运行时性能数据暂不可用');
            return;
        }
        var eventLoop = item.event_loop || {};
        var blocking = item.blocking_io || {};
        var dbPool = item.db_pool || {};
        var bulkWriter = item.bulk_writer || {};
        var auditQueue = item.login_audit_queue || {};
        var acquire = dbPool.acquire_metrics || {};
        var policy = dbPool.policy || {};
        var dbPolicyText = policy.fixed_budget ? '固定预算' : (policy.auto_expand_enabled ? '自动扩容' : '未知');
        var auditQueueEnabled = auditQueue.enabled !== false;
        var auditQueueText = auditQueueEnabled ? (auditQueue.started ? '运行中' : '未启动') : '已关闭';
        var bulkOperations = bulkWriter.operations || {};
        var topBulkOperation = Object.keys(bulkOperations).map(function(name) {
            var op = bulkOperations[name] || {};
            return {
                name: name,
                rows: Number(op.rows || 0),
                avgRows: Number(op.avg_rows || 0),
                maxMs: Number(op.max_ms || 0),
                failed: Number(op.failed || 0)
            };
        }).sort(function(a, b) {
            return b.rows - a.rows;
        })[0] || { name: '-', rows: 0, avgRows: 0, maxMs: 0, failed: 0 };
        if (cards) {
            setHtmlIfChanged(cards,
                renderCard('事件循环 p99', formatMs(eventLoop.p99_lag_ms), 'max ' + formatMs(eventLoop.max_lag_ms) + '；慢样本 ' + formatNumber(eventLoop.slow_count)) +
                renderCard('事件循环状态', eventLoop.running ? '运行中' : '未运行', '采样 ' + formatNumber(eventLoop.sample_count) + '；间隔 ' + formatSeconds(eventLoop.interval_seconds)) +
                renderCard('阻塞 I/O 并发', formatNumber(blocking.in_flight) + ' / ' + formatNumber(blocking.max_concurrency), '完成 ' + formatNumber(blocking.completed) + '；慢调用 ' + formatNumber(blocking.slow_count)) +
                renderCard('阻塞 I/O 耗时', formatMs(blocking.avg_run_ms), 'max ' + formatMs(blocking.max_run_ms) + '；排队 max ' + formatMs(blocking.max_queue_ms)) +
                renderCard('DB 连接池', formatPercent(dbPool.usage_pct), 'active ' + formatNumber(dbPool.active) + ' / max ' + formatNumber(dbPool.max_size) + '；' + dbPolicyText) +
                renderCard('DB acquire', formatMs(acquire.avg_wait_ms), 'max ' + formatMs(acquire.max_wait_ms) + '；timeout ' + formatNumber(acquire.timeouts)) +
                renderCard('批量写入', formatNumber(bulkWriter.rows), 'calls ' + formatNumber(bulkWriter.calls) + '；failed ' + formatNumber(bulkWriter.failed)) +
                renderCard('批量写热点', topBulkOperation.name, 'avg ' + formatNumber(topBulkOperation.avgRows) + ' 行；max ' + formatMs(topBulkOperation.maxMs)) +
                renderCard('登录审计队列', auditQueueText, 'pending ' + formatNumber(auditQueue.pending) + ' / ' + formatNumber(auditQueue.max_pending) + '；fallback ' + formatNumber(auditQueue.sync_fallback)) +
                renderCard('登录审计写入', formatNumber(auditQueue.written), 'accepted ' + formatNumber(auditQueue.accepted) + '；failed ' + formatNumber(auditQueue.failed))
            );
        }
        if (bars) {
            setHtmlIfChanged(bars,
                renderProgress('事件循环 p99', runtimeProgressPercent(eventLoop.p99_lag_ms, 250), formatMs(eventLoop.p99_lag_ms) + ' / 250 ms') +
                renderProgress('阻塞 I/O 饱和度', Number(blocking.max_concurrency || 0) > 0 ? Number(blocking.in_flight || 0) / Number(blocking.max_concurrency || 1) * 100 : 0, formatNumber(blocking.in_flight) + ' / ' + formatNumber(blocking.max_concurrency)) +
                renderProgress('DB 连接使用率', dbPool.usage_pct, formatPercent(dbPool.usage_pct)) +
                renderProgress('DB acquire max', runtimeProgressPercent(acquire.max_wait_ms, 500), formatMs(acquire.max_wait_ms) + ' / 500 ms') +
                renderProgress('批量写 max', runtimeProgressPercent(topBulkOperation.maxMs, 500), formatMs(topBulkOperation.maxMs) + ' / 500 ms') +
                renderProgress('批量写失败', Number(bulkWriter.calls || 0) > 0 ? Number(bulkWriter.failed || 0) / Number(bulkWriter.calls || 1) * 100 : 0, formatNumber(bulkWriter.failed) + ' / ' + formatNumber(bulkWriter.calls)) +
                renderProgress('登录审计队列', Number(auditQueue.max_pending || 0) > 0 ? Number(auditQueue.pending || 0) / Number(auditQueue.max_pending || 1) * 100 : 0, formatNumber(auditQueue.pending) + ' / ' + formatNumber(auditQueue.max_pending))
            );
        }
        if (rows) setHtmlIfChanged(rows, renderRuntimePerformanceRows(item));
        if (meta) {
            setTextIfChanged(meta, '轻量指标 5 秒刷新 · DB ' + dbPolicyText + ' · 批量写 ' + formatNumber(bulkWriter.calls) + ' 次 · 登录审计 ' + auditQueueText + ' · 阻塞 I/O 并发上限 ' + formatNumber(blocking.max_concurrency));
        }
    }

    function wsTicketWindow(item, key) {
        var windows = item && item.windows || {};
        return windows[key] || {};
    }

    function renderWsTicketAudienceRows(item) {
        if (!item || item.error || item.available === false) return '<tr><td colspan="7"><div class="monitoring-empty">短票诊断暂不可用</div></td></tr>';
        var ticketState = item.ticket_state || {};
        var stateByAudience = {};
        (ticketState.by_audience || []).forEach(function(row) {
            stateByAudience[String(row.audience || '-')] = row;
        });
        var rows = Array.isArray(item.audiences) ? item.audiences.slice() : [];
        Object.keys(stateByAudience).forEach(function(audience) {
            if (!rows.some(function(row) { return String(row.audience || '-') === audience; })) {
                rows.push({ audience: audience, issued: 0, consumed: 0, rejected: 0, last_event_at: '' });
            }
        });
        if (!rows.length) return '<tr><td colspan="7"><div class="monitoring-empty">暂无短票事件</div></td></tr>';
        return rows.map(function(row) {
            var audience = String(row.audience || '-');
            var stateRow = stateByAudience[audience] || {};
            return '<tr>' +
                '<td><code>' + escapeHtml(audience) + '</code></td>' +
                '<td>' + formatNumber(row.issued) + '</td>' +
                '<td>' + formatNumber(row.consumed) + '</td>' +
                '<td>' + formatNumber(row.rejected) + '</td>' +
                '<td>' + formatNumber(stateRow.pending) + '</td>' +
                '<td>' + formatNumber(stateRow.expired_unconsumed) + '</td>' +
                '<td>' + escapeHtml(formatTime(row.last_event_at)) + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderWsTicketFailureRows(item) {
        if (!item || item.error || item.available === false) return '<tr><td colspan="7"><div class="monitoring-empty">短票失败样本暂不可用</div></td></tr>';
        var rows = Array.isArray(item.recent_failures) ? item.recent_failures : [];
        if (!rows.length) return '<tr><td colspan="7"><div class="monitoring-empty">最近没有短票拒绝事件</div></td></tr>';
        return rows.map(function(row) {
            var resource = [row.resource_type || '', row.resource_id || ''].filter(Boolean).join(':') || '-';
            return '<tr>' +
                '<td>' + escapeHtml(formatTime(row.created_at)) + '</td>' +
                '<td><code>' + escapeHtml(row.audience || '-') + '</code></td>' +
                '<td>' + escapeHtml(row.code || '-') + '</td>' +
                '<td>' + escapeHtml(row.role || '-') + '</td>' +
                '<td>' + escapeHtml(resource) + '</td>' +
                '<td>' + escapeHtml(row.subject || '-') + '</td>' +
                '<td>' + escapeHtml(row.client_ip || '-') + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderWsTickets() {
        var item = state.data.wsTickets || {};
        var cards = document.getElementById('monitoringWsTicketCards');
        var bars = document.getElementById('monitoringWsTicketBars');
        var audienceRows = document.getElementById('monitoringWsTicketAudienceRows');
        var failureRows = document.getElementById('monitoringWsTicketFailureRows');
        var meta = document.getElementById('monitoringWsTicketMeta');
        var policyMeta = document.getElementById('monitoringWsTicketPolicyMeta');
        var policy = item.policy || {};
        if (!wsTicketPolicyEditing()) {
            setChecked('wsTicketDiagnosticsEnabled', !!policy.enabled && policy.expired !== true);
            setInputValue('wsTicketDiagnosticsMinutes', policy.effective_enabled && policy.remaining_seconds ? Math.max(1, Math.ceil(Number(policy.remaining_seconds || 0) / 60)) : (policy.default_auto_close_minutes || 30));
            setInputValue('wsTicketDiagnosticsRetentionDays', policy.retention_days || 3);
        }
        if (policyMeta) {
            var policyText = policy.effective_enabled
                ? ('已开启，' + (policy.remaining_seconds ? Math.ceil(Number(policy.remaining_seconds || 0) / 60) + ' 分钟后自动关闭' : '未设置自动关闭'))
                : (policy.expired ? '已到期：诊断写入已自动停止' : '已关闭：不写入诊断事件');
            setTextIfChanged(policyMeta, policyText);
        }
        if (!item || (!item.windows && item.available !== false && !item.error)) {
            if (cards) setHtmlIfChanged(cards, renderCard('短票握手', '读取中', '等待首次轻量刷新'));
            if (bars) setHtmlIfChanged(bars, '');
            if (audienceRows) setHtmlIfChanged(audienceRows, '<tr><td colspan="7"><div class="monitoring-empty">等待首次采样</div></td></tr>');
            if (failureRows) setHtmlIfChanged(failureRows, '<tr><td colspan="7"><div class="monitoring-empty">等待首次采样</div></td></tr>');
            if (meta) setTextIfChanged(meta, '读取中...');
            return;
        }
        if (item.error || item.available === false) {
            var message = item.error || item.message || '短票诊断不可用';
            if (cards) setHtmlIfChanged(cards, renderCard('短票握手', '不可用', message));
            if (bars) setHtmlIfChanged(bars, '');
            if (audienceRows) setHtmlIfChanged(audienceRows, renderWsTicketAudienceRows(item));
            if (failureRows) setHtmlIfChanged(failureRows, renderWsTicketFailureRows(item));
            if (meta) setTextIfChanged(meta, message);
            return;
        }
        var w15 = wsTicketWindow(item, '15m');
        var w1h = wsTicketWindow(item, '1h');
        var w24 = wsTicketWindow(item, '24h');
        var ticketState = item.ticket_state || {};
        var topReject = (w1h.reject_codes || [])[0] || {};
        var eventTableText = item.event_table_available === false ? '事件表未初始化' : '事件表正常';
        var recordingText = item.recording_enabled ? '已开启' : '已关闭';
        var recordingSub = item.recording_enabled ? '正在记录签发/消费/拒绝摘要' : '短票安全生效，诊断写入停止';
        if (cards) {
            setHtmlIfChanged(cards,
                renderCard('诊断写入', recordingText, recordingSub) +
                renderCard('15分钟签发', formatNumber(w15.issued), item.recording_enabled ? ('消费 ' + formatNumber(w15.consumed) + '；拒绝 ' + formatNumber(w15.rejected)) : '关闭期间不新增事件') +
                renderCard('1小时消费率', formatPercent(w1h.consume_rate_pct), '签发 ' + formatNumber(w1h.issued) + '；消费 ' + formatNumber(w1h.consumed)) +
                renderCard('1小时拒绝率', formatPercent(w1h.reject_rate_pct), topReject.code ? ('主要原因 ' + topReject.code + ' × ' + formatNumber(topReject.count)) : '无拒绝事件') +
                renderCard('待消费短票', formatNumber(ticketState.pending), '过期未用 ' + formatNumber(ticketState.expired_unconsumed) + '；库存 ' + formatNumber(ticketState.stored_total)) +
                renderCard('24小时签发', formatNumber(w24.issued), '消费 ' + formatNumber(w24.consumed) + '；拒绝 ' + formatNumber(w24.rejected)) +
                renderCard('诊断状态', eventTableText, '只记录事件摘要，不记录明文 ticket')
            );
        }
        if (bars) {
            setHtmlIfChanged(bars,
                renderProgress('15分钟消费率', w15.consume_rate_pct, formatPercent(w15.consume_rate_pct)) +
                renderProgress('1小时消费率', w1h.consume_rate_pct, formatPercent(w1h.consume_rate_pct)) +
                renderProgress('1小时拒绝率', w1h.reject_rate_pct, formatPercent(w1h.reject_rate_pct)) +
                renderProgress('待消费占库存', Number(ticketState.stored_total || 0) > 0 ? Number(ticketState.pending || 0) / Number(ticketState.stored_total || 1) * 100 : 0, formatNumber(ticketState.pending) + ' / ' + formatNumber(ticketState.stored_total))
            );
        }
        if (audienceRows) setHtmlIfChanged(audienceRows, renderWsTicketAudienceRows(item));
        if (failureRows) setHtmlIfChanged(failureRows, renderWsTicketFailureRows(item));
        if (meta) setTextIfChanged(meta, '轻量指标 5 秒刷新 · 更新于 ' + formatTime(item.generated_at));
    }

    function indexStatusLabel(status) {
        var value = String(status || '').toLowerCase();
        if (value === 'exists') return '已存在';
        if (value === 'installed') return '已安装';
        if (value === 'missing') return '缺失';
        if (value === 'missing_table') return '缺少表';
        if (value === 'blocked_extension') return '等待扩展';
        if (value === 'invalid') return '无效';
        return value || '-';
    }

    function indexStatusClass(status) {
        var value = String(status || '').toLowerCase();
        if (value === 'exists' || value === 'installed') return 'ok';
        if (value === 'missing') return 'warn';
        if (value === 'blocked_extension' || value === 'missing_table') return 'blocked';
        if (value === 'invalid') return 'bad';
        return 'neutral';
    }

    function renderIndexStatus(status) {
        var cls = indexStatusClass(status);
        return '<span class="monitoring-index-status ' + escapeHtml(cls) + '">' + escapeHtml(indexStatusLabel(status)) + '</span>';
    }

    function renderIndexPlanRows(item) {
        if (!item || item.error) return '<tr><td colspan="6"><div class="monitoring-empty">索引计划暂不可用</div></td></tr>';
        var list = Array.isArray(item.items) ? item.items : [];
        if (!list.length) return '<tr><td colspan="6"><div class="monitoring-empty">暂无索引计划</div></td></tr>';
        list = list.slice().sort(function(a, b) {
            var score = { missing: 0, blocked_extension: 1, invalid: 2, missing_table: 3, exists: 4, installed: 4 };
            return (score[a.status] == null ? 9 : score[a.status]) - (score[b.status] == null ? 9 : score[b.status]);
        });
        return list.map(function(row) {
            return '<tr>' +
                '<td><code>' + escapeHtml(row.name || '-') + '</code></td>' +
                '<td>' + renderIndexStatus(row.status) + '</td>' +
                '<td>' + escapeHtml(row.table || '-') + '</td>' +
                '<td>' + escapeHtml(row.purpose || '-') + '</td>' +
                '<td>' + escapeHtml(row.risk || '-') + '</td>' +
                '<td>' + escapeHtml(row.message || (row.runnable ? '可执行' : '-')) + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderIndexRunRows(runner) {
        var results = runner && Array.isArray(runner.recent_results) ? runner.recent_results.slice().reverse() : [];
        if (!results.length) return '<tr><td colspan="5"><div class="monitoring-empty">暂无执行记录</div></td></tr>';
        return results.slice(0, 8).map(function(row) {
            return '<tr>' +
                '<td><code>' + escapeHtml(row.name || '-') + '</code></td>' +
                '<td>' + escapeHtml(row.status || '-') + '</td>' +
                '<td>' + escapeHtml(formatMs(row.elapsed_ms)) + '</td>' +
                '<td>' + escapeHtml(formatSampleTime(row.finished_at)) + '</td>' +
                '<td>' + escapeHtml(row.message || '-') + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderIndexPlan() {
        var item = state.data.indexPlan || {};
        var summary = item.summary || {};
        var runner = item.runner || {};
        var cards = document.getElementById('monitoringIndexPlanCards');
        var meta = document.getElementById('monitoringIndexPlanMeta');
        var rows = document.getElementById('monitoringIndexPlanRows');
        var runRows = document.getElementById('monitoringIndexRunRows');
        if (!item.error && !item.summary && !item.items) {
            if (cards) setHtmlIfChanged(cards, renderCard('索引计划', '读取中', '等待首次对账'));
            if (rows) setHtmlIfChanged(rows, '<tr><td colspan="6"><div class="monitoring-empty">等待首次对账</div></td></tr>');
            if (runRows) setHtmlIfChanged(runRows, '<tr><td colspan="5"><div class="monitoring-empty">暂无执行记录</div></td></tr>');
            if (meta) setTextIfChanged(meta, '读取中...');
            return;
        }
        if (item.error) {
            if (cards) setHtmlIfChanged(cards, renderCard('索引计划', '不可用', item.error));
            if (rows) setHtmlIfChanged(rows, renderIndexPlanRows(item));
            if (runRows) setHtmlIfChanged(runRows, renderIndexRunRows(runner));
            if (meta) setTextIfChanged(meta, '索引计划读取失败');
            return;
        }
        var runningText = runner.running ? ('运行中：' + (runner.current_name || '准备中')) : '空闲';
        if (cards) {
            setHtmlIfChanged(cards,
                renderCard('索引就绪', formatNumber(summary.ready) + ' / ' + formatNumber(summary.total), '缺失 ' + formatNumber(summary.missing) + '；可执行 ' + formatNumber(summary.runnable)) +
                renderCard('阻塞项', formatNumber(summary.blocked), '缺表或扩展未就绪') +
                renderCard('无效索引', formatNumber(summary.invalid), '需要人工清理后重建') +
                renderCard('执行器', runningText, '完成 ' + formatNumber(runner.completed) + '；失败 ' + formatNumber(runner.failed))
            );
        }
        if (rows) setHtmlIfChanged(rows, renderIndexPlanRows(item));
        if (runRows) setHtmlIfChanged(runRows, renderIndexRunRows(runner));
        if (meta) {
            var planned = runner.running && runner.planned_names ? '；计划 ' + runner.planned_names.join(', ') : '';
            var last = runner.finished_at ? '；上次结束 ' + formatSampleTime(runner.finished_at) : '';
            setTextIfChanged(meta, runningText + planned + last);
        }
    }

    function render() {
        var system = state.data.system || {};
        var health = state.data.health || {};
        var database = state.data.database || {};
        var chat = state.data.chat || {};
        var groups = state.data.groups || {};
        var fileAssets = state.data.fileAssets || {};
        var memory = system.memory || {};
        var disk = system.disk || {};
        var process = system.process || {};
        var imProcess = system.im_process || {};
        var memorySub = memory.available ? formatBytes(memory.used_bytes) + ' / ' + formatBytes(memory.total_bytes) : '不可用';
        var memoryDetail = memory.available ? '可用 ' + formatBytes(memory.available_bytes) + ' / 缓存 ' + formatBytes(memory.cached_bytes) : '不可用';
        var dbOk = health.database && health.database.ok;
        var imOk = health.im_server && health.im_server.ok;
        var cards = document.getElementById('monitoringCards');
        if (cards) {
            setHtmlIfChanged(cards, renderCard('数据库', dbOk ? '正常' : '异常', health.database && health.database.message || '-') +
                renderCard('IM 服务', imOk ? '正常' : '异常', health.im_server && health.im_server.message || '-') +
                renderCard('CPU', formatPercent(system.cpu_percent), (system.cpu_count || '-') + ' 核') +
                renderCard('内存', memory.available ? formatPercent(memory.percent) : '-', memorySub + '；' + memoryDetail) +
                renderCard('磁盘', disk.available ? formatPercent(disk.percent) : '-', disk.available ? formatBytes(disk.used_bytes) + ' / ' + formatBytes(disk.total_bytes) : '不可用') +
                renderCard('管理后台内存', process.available ? formatBytes(process.rss_bytes) : '-', process.available ? '线程 ' + formatNumber(process.threads) + ' / PID ' + formatNumber(process.pid) : '不可用') +
                renderCard('IM进程内存', imProcess.available ? formatBytes(imProcess.rss_bytes) : '-', imProcess.available ? 'CPU ' + formatPercent(imProcess.cpu_percent) + ' / 线程 ' + formatNumber(imProcess.threads) + ' / PID ' + formatNumber(imProcess.pid) : '未找到 im-server') +
                renderCard('后台运行时长', formatDuration(system.process_uptime_seconds), system.platform || '-') +
                renderCard('数据库大小', formatBytes(database.database_size_bytes), '连接数 ' + formatNumber(database.active_connections)));
        }
        var systemDonuts = document.getElementById('monitoringSystemDonuts');
        if (systemDonuts) {
            setHtmlIfChanged(systemDonuts, renderDonut('CPU 使用率', system.cpu_percent, (system.cpu_count || '-') + ' 核', '#00d4ff') +
                renderDonut('内存使用率', memory.available ? memory.percent : NaN, memory.available ? memorySub : '不可用', '#00ff88') +
                renderDonut('磁盘使用率', disk.available ? disk.percent : NaN, disk.available ? formatBytes(disk.used_bytes) + ' / ' + formatBytes(disk.total_bytes) : '不可用', '#f5cd60'));
        }
        var systemBars = document.getElementById('monitoringSystemBars');
        if (systemBars) {
            var load = system.load_average || {};
            var loadPercent = load.available && system.cpu_count ? Math.min(100, Number(load.load1 || 0) / Number(system.cpu_count || 1) * 100) : 0;
            setHtmlIfChanged(systemBars, renderProgress('1分钟负载', loadPercent, load.available ? String(Number(load.load1 || 0).toFixed(2)) : '-') +
                renderProgress('5分钟负载', load.available && system.cpu_count ? Math.min(100, Number(load.load5 || 0) / Number(system.cpu_count || 1) * 100) : 0, load.available ? String(Number(load.load5 || 0).toFixed(2)) : '-') +
                renderProgress('15分钟负载', load.available && system.cpu_count ? Math.min(100, Number(load.load15 || 0) / Number(system.cpu_count || 1) * 100) : 0, load.available ? String(Number(load.load15 || 0).toFixed(2)) : '-') +
                renderProgress('可用内存', memory.available && memory.total_bytes ? Number(memory.available_bytes || 0) / Number(memory.total_bytes || 1) * 100 : 0, memory.available ? formatBytes(memory.available_bytes) : '-') +
                renderProgress('文件缓存', memory.available && memory.total_bytes ? Number(memory.cached_bytes || 0) / Number(memory.total_bytes || 1) * 100 : 0, memory.available ? formatBytes(memory.cached_bytes) : '-'));
        }
        var systemMeta = document.getElementById('monitoringSystemMeta');
        if (systemMeta) setTextIfChanged(systemMeta, '更新于 ' + formatTime(system.generated_at));
        var chatCards = document.getElementById('monitoringChatCards');
        if (chatCards) {
            setHtmlIfChanged(chatCards, renderCard('会话总数', formatNumber(chat.conversation_total), '群聊 ' + formatNumber(chat.group_total) + ' / 私聊 ' + formatNumber(chat.direct_total)) +
                renderCard('消息总数', formatNumber(chat.message_total), '今日 ' + formatNumber(chat.message_today)) +
                renderCard('范围内消息', formatNumber(chat.message_in_range), chat.range || state.range) +
                renderCard('文件资源', formatBytes(chat.file_storage_bytes), '活跃 ' + formatNumber(chat.file_asset_active) + ' / 历史声明 ' + formatBytes(chat.declared_attachment_bytes)) +
                renderCard('纯文本内容', formatBytes(chat.text_storage_bytes), '仅 text 消息正文') +
                renderCard('消息载荷', formatBytes(chat.stored_payload_bytes), '文本与 JSON 元数据') +
                renderCard('估算总占用', formatBytes(chat.estimated_storage_bytes), '消息载荷 + 文件资源'));
        }
        var typeBars = document.getElementById('monitoringTypeBars');
        if (typeBars) setHtmlIfChanged(typeBars, renderMessageTypeStorageBars(chat.message_type_distribution));
        var chatMeta = document.getElementById('monitoringChatMeta');
        if (chatMeta) setTextIfChanged(chatMeta, '高成本统计每小时自动刷新，更新于 ' + formatTime(chat.generated_at));
        var dbBars = document.getElementById('monitoringDbBars');
        if (dbBars) {
            setHtmlIfChanged(dbBars, renderRankBars(database.table_sizes, 'table_name', 'total_bytes', formatBytes, 100, function(item, value) {
                var rowCount = Number(item.row_count || 0);
                return formatBytes(value) + ' · ' + formatNumber(rowCount) + ' 行';
            }));
        }
        var dbMeta = document.getElementById('monitoringDbMeta');
        if (dbMeta) {
            var tableCount = Array.isArray(database.table_sizes) ? database.table_sizes.length : 0;
            var countText = tableCount > 0 ? '共 ' + tableCount + ' 张表 · ' : '';
            var timeText = database.cache && database.cache.hit ? '缓存 ' + database.cache.age_seconds + ' 秒' : '更新于 ' + formatTime(database.generated_at);
            setTextIfChanged(dbMeta, countText + timeText);
        }
        renderIndexPlan();
        var fileAssetRows = document.getElementById('monitoringFileAssetRows');
        if (fileAssetRows) {
            var assets = Array.isArray(fileAssets.items) ? fileAssets.items : [];
            setHtmlIfChanged(fileAssetRows, assets.length ? assets.map(function(item) {
                var storageName = String(item.storage_name || '');
                var originalName = String(item.original_name || storageName || '-');
                var status = String(item.status || '-');
                var disabled = status.toLowerCase() !== 'active';
                var button = disabled ? '<span class="monitoring-meta">已失效</span>' : '<button class="monitoring-btn danger" data-monitoring-action="expire-file-asset" data-storage-name="' + escapeHtml(storageName) + '" data-original-name="' + escapeHtml(originalName) + '" data-referenced-messages="' + Number(item.referenced_messages || 0) + '">删除文件</button>';
                return '<tr><td>' + escapeHtml(originalName) + '</td><td>' + escapeHtml(item.mime_type || '-') + '</td><td>' + formatBytes(item.file_size) + '</td><td>' + escapeHtml(status) + '</td><td>' + formatNumber(item.referenced_messages) + '</td><td>' + escapeHtml(formatTime(item.expires_at)) + '</td><td>' + escapeHtml(formatTime(item.created_at)) + '</td><td>' + escapeHtml(storageName) + '</td><td>' + button + '</td></tr>';
            }).join('') : '<tr><td colspan="9"><div class="monitoring-empty">暂无 active 文件资源</div></td></tr>');
        }
        var fileAssetMeta = document.getElementById('monitoringFileAssetMeta');
        if (fileAssetMeta) setTextIfChanged(fileAssetMeta, (fileAssets.cache && fileAssets.cache.hit ? '缓存 ' + fileAssets.cache.age_seconds + ' 秒；' : '') + '删除后聊天消息保留，附件显示失效');
        var groupRows = document.getElementById('monitoringGroupRows');
        if (groupRows) {
            var items = Array.isArray(groups.items) ? groups.items : [];
            setHtmlIfChanged(groupRows, items.length ? items.map(function(item) {
                return '<tr><td>' + escapeHtml(item.title || ('群组 ' + item.conversation_id)) + '</td><td>' + escapeHtml(item.owner_username || '-') + '</td><td>' + formatNumber(item.member_count) + '</td><td>' + formatNumber(item.admin_count) + '</td><td>' + formatNumber(item.message_total) + '</td><td>' + formatNumber(item.message_today) + '</td><td>' + formatNumber(item.message_in_range) + '</td><td>' + formatBytes(item.text_storage_bytes) + '</td><td>' + formatBytes(item.payload_storage_bytes) + '</td><td>' + formatBytes(item.file_storage_bytes) + '</td><td>' + formatBytes(item.estimated_storage_bytes) + '</td><td>' + escapeHtml(formatTime(item.last_message_at)) + '</td></tr>';
            }).join('') : '<tr><td colspan="12"><div class="monitoring-empty">暂无群组统计数据</div></td></tr>');
        }
        var groupMeta = document.getElementById('monitoringGroupMeta');
        if (groupMeta) setTextIfChanged(groupMeta, (groups.cache && groups.cache.hit ? '缓存 ' + groups.cache.age_seconds + ' 秒；' : '') + '文件占用为消息载荷估算口径');
        renderWsTickets();
        renderRuntimePerformance();
        renderRuntimeHygiene();
        renderStaticCachePolicy();
        renderAlert();
    }

    function setInputValue(id, value) {
        var el = document.getElementById(id);
        if (el && document.activeElement !== el) el.value = value == null ? '' : String(value);
    }

    function inputNumber(id) {
        var el = document.getElementById(id);
        return Number(el && el.value || 0);
    }

    function inputChecked(id) {
        var el = document.getElementById(id);
        return !!(el && el.checked);
    }

    function setChecked(id, value) {
        var el = document.getElementById(id);
        if (el && document.activeElement !== el) el.checked = !!value;
    }

    function runtimePolicyEditing() {
        var grid = document.querySelector('.monitoring-runtime-policy-grid');
        return !!(grid && document.activeElement && grid.contains(document.activeElement));
    }

    function wsTicketPolicyEditing() {
        var grid = document.querySelector('.monitoring-ws-ticket-policy-grid');
        return !!(grid && document.activeElement && grid.contains(document.activeElement));
    }

    function renderRuntimeClientRows(item) {
        var rows = [];
        var akPool = item.ak_web_client_pool || {};
        (akPool.clients || []).forEach(function(client) {
            rows.push({
                pool: 'AK 网页代理',
                name: client.key || '-',
                client: client
            });
        });
        var dispatcher = item.dispatcher || {};
        (dispatcher.exits || []).forEach(function(exit) {
            rows.push({
                pool: '出口调度',
                name: (exit.type === 'direct' ? '直连' : exit.name || '-') + (exit.proxy ? ' · ' + exit.proxy : ''),
                client: exit.client || {}
            });
        });
        if (!rows.length) return '<tr><td colspan="8"><div class="monitoring-empty">暂无连接池条目</div></td></tr>';
        return rows.map(function(row) {
            var c = row.client || {};
            var open = !!c.open;
            return '<tr>' +
                '<td>' + escapeHtml(row.pool) + '</td>' +
                '<td>' + escapeHtml(row.name) + '</td>' +
                '<td><span style="color:' + (open ? '#00ff88' : 'var(--text-secondary)') + '">' + (open ? '打开' : '关闭') + '</span></td>' +
                '<td>' + escapeHtml(formatSeconds(c.age_seconds)) + '</td>' +
                '<td>' + escapeHtml(formatSeconds(c.idle_seconds)) + '</td>' +
                '<td>' + formatNumber(c.request_count) + '</td>' +
                '<td>' + formatNumber(c.retire_count) + '</td>' +
                '<td>' + escapeHtml(c.last_retire_reason || '-') + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderRuntimeHygiene() {
        var item = state.data.runtimeHygiene || {};
        var policy = item.policy || {};
        if (!runtimePolicyEditing()) {
            setChecked('runtimeHygieneEnabled', policy.enabled !== false);
            setChecked('runtimeCleanupBrowseSessions', policy.cleanup_browse_sessions_enabled !== false);
            setChecked('runtimeCleanupAkAuthCache', policy.cleanup_ak_auth_cache_enabled !== false);
            setChecked('runtimeCleanupStaticLocks', policy.cleanup_static_cache_locks_enabled !== false);
            setInputValue('runtimeCleanupInterval', policy.cleanup_interval_seconds || 300);
            setInputValue('runtimeAkClientMaxAge', policy.ak_web_client_max_age_seconds || 900);
            setInputValue('runtimeAkClientMaxRequests', policy.ak_web_client_max_requests || 800);
            setInputValue('runtimeAkClientIdle', policy.ak_web_client_idle_seconds || 300);
            setInputValue('runtimeOutboundClientMaxAge', policy.outbound_client_max_age_seconds || 900);
            setInputValue('runtimeOutboundClientMaxRequests', policy.outbound_client_max_requests || 800);
            setInputValue('runtimeOutboundClientIdle', policy.outbound_client_idle_seconds || 300);
        }

        var service = item.service || {};
        var akPool = item.ak_web_client_pool || {};
        var dispatcher = item.dispatcher || {};
        var exits = dispatcher.exits || [];
        var dispatcherOpen = exits.reduce(function(total, ex) {
            return total + ((ex.client && ex.client.open) ? 1 : 0);
        }, 0);
        var browse = item.browse_sessions || {};
        var auth = item.ak_auth_cache || {};
        var staticCache = item.static_resource_cache || {};
        var cards = document.getElementById('monitoringRuntimeCards');
        if (cards) {
            setHtmlIfChanged(cards,
                renderCard('维护任务', service.running ? '运行中' : (policy.enabled === false ? '已关闭' : '未运行'), '周期 ' + formatSeconds(policy.cleanup_interval_seconds || 0) + '；执行 ' + formatNumber(service.run_count) + ' 次') +
                renderCard('AK 代理连接池', formatNumber(akPool.open_clients) + ' 打开', '跟踪 ' + formatNumber(akPool.tracked_clients) + '；换新 ' + formatNumber(akPool.retire_count)) +
                renderCard('出口连接池', formatNumber(dispatcherOpen) + ' 打开', '出口 ' + formatNumber(exits.length) + '；活跃 ' + formatNumber(dispatcher.total_active)) +
                renderCard('浏览会话缓存', formatNumber(browse.count), '过期待清理 ' + formatNumber(browse.expired_count) + '；已验证 ' + formatNumber(browse.validated_count)) +
                renderCard('AK 登录缓存', formatNumber(auth.count), '过期待清理 ' + formatNumber(auth.expired_count)) +
                renderCard('静态资源锁', formatNumber(staticCache.lock_count), '上次清理剩余 ' + formatNumber((staticCache.last_lock_cleanup || {}).remaining))
            );
        }
        var meta = document.getElementById('monitoringRuntimeMeta');
        if (meta) {
            var lastText = service.last_finished_at ? '上次清理 ' + formatTime(service.last_finished_at * 1000) : '尚未执行清理';
            var errText = service.last_error ? ' · 最近错误: ' + service.last_error : '';
            setTextIfChanged(meta, lastText + errText);
        }
        var rows = document.getElementById('monitoringRuntimeClientRows');
        if (rows) setHtmlIfChanged(rows, renderRuntimeClientRows(item));
    }

    function staticCacheRuntimeSnapshot() {
        var runtimeCache = (state.data.runtimeHygiene && state.data.runtimeHygiene.static_resource_cache) || {};
        var policyCache = state.data.staticCache || {};
        return {
            policy: policyCache.memory_policy || runtimeCache.memory_policy || {},
            cache: runtimeCache.memory_cache || policyCache.memory_cache || {}
        };
    }

    function renderStaticCacheRuntimeCards() {
        var target = document.getElementById('monitoringStaticCacheRuntimeCards');
        if (!target) return;
        var snapshot = staticCacheRuntimeSnapshot();
        var policy = snapshot.policy || {};
        var cache = snapshot.cache || {};
        if (!policy.max_entries && !cache.max_entries) {
            setHtmlIfChanged(target, renderCard('L1 内存缓存', '读取中', '等待运行态刷新'));
            return;
        }
        var enabled = policy.enabled !== false && cache.enabled !== false;
        var statsEnabled = policy.stats_enabled !== false && cache.stats_enabled !== false;
        var maxBytes = Number(policy.max_bytes || cache.max_bytes || 0);
        var usedBytes = Number(cache.bytes || 0);
        var usageText = maxBytes > 0 ? formatBytes(usedBytes) + ' / ' + formatBytes(maxBytes) : formatBytes(usedBytes);
        var hitText = statsEnabled ? formatPercent(cache.hit_ratio_pct) : '已关闭';
        var hitSub = statsEnabled
            ? 'hit ' + formatNumber(cache.hits) + '；miss ' + formatNumber(cache.misses)
            : '缓存继续工作，不再累计 hit/miss';
        setHtmlIfChanged(target,
            renderCard('L1 内存缓存', enabled ? '已启用' : '已关闭', enabled ? '条目 ' + formatNumber(cache.entries) + ' / ' + formatNumber(policy.max_entries || cache.max_entries) + '；' + usageText : '请求会回退到磁盘缓存') +
            renderCard('实时统计', statsEnabled ? '已启用' : '已关闭', hitSub) +
            renderCard('L1 命中率', hitText, '写入 ' + (statsEnabled ? formatNumber(cache.writes) : '-') + '；单资源上限 ' + formatBytes(policy.max_body_bytes || cache.max_body_bytes)) +
            renderCard('L1 淘汰', statsEnabled ? formatNumber(cache.evictions) : '-', '过期 ' + (statsEnabled ? formatNumber(cache.expired) : '-') + '；拒绝 ' + (statsEnabled ? formatNumber(cache.rejected) : '-'))
        );
    }

    function staticCacheEntryExtension(path) {
        var clean = String(path || '').split('?', 1)[0].toLowerCase();
        var slash = clean.lastIndexOf('/');
        var dot = clean.lastIndexOf('.');
        if (dot <= slash) return '';
        return clean.slice(dot);
    }

    function staticCacheEntryContentType(item) {
        return String((item && item.content_type) || '').split(';', 1)[0].trim().toLowerCase();
    }

    function staticCacheEntryTypeInfo(item) {
        var contentType = staticCacheEntryContentType(item);
        var ext = staticCacheEntryExtension(item && item.path);
        var key = (contentType || '-') + '|' + (ext || '-');
        var label = '';
        if (contentType && ext) {
            label = contentType + ' · ' + ext;
        } else if (contentType) {
            label = contentType;
        } else if (ext) {
            label = ext;
        } else {
            label = '未识别类型';
        }
        return { key: key, label: label };
    }

    function buildStaticCacheEntryTypeGroups(items) {
        var groups = {};
        (items || []).forEach(function(item) {
            var info = staticCacheEntryTypeInfo(item);
            if (!groups[info.key]) groups[info.key] = { key: info.key, label: info.label, count: 0 };
            groups[info.key].count += 1;
        });
        return Object.keys(groups).map(function(key) { return groups[key]; }).sort(function(a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return a.label.localeCompare(b.label, 'zh-CN');
        });
    }

    function renderStaticCacheEntryTypeFilter(items) {
        var select = document.getElementById('monitoringStaticCacheEntryTypeFilter');
        var meta = document.getElementById('monitoringStaticCacheEntryMeta');
        var groups = buildStaticCacheEntryTypeGroups(items);
        var selected = state.staticCacheEntryFilter || 'all';
        var valid = selected === 'all' || groups.some(function(group) { return group.key === selected; });
        if (!valid) {
            selected = 'all';
            state.staticCacheEntryFilter = 'all';
        }
        if (select) {
            var options = '<option value="all">全部（' + formatNumber((items || []).length) + '）</option>' +
                groups.map(function(group) {
                    return '<option value="' + escapeHtml(group.key) + '">' + escapeHtml(group.label + '（' + formatNumber(group.count) + '）') + '</option>';
                }).join('');
            setHtmlIfChanged(select, options);
            if (select.value !== selected) select.value = selected;
        }
        if (meta) {
            var selectedGroup = null;
            for (var i = 0; i < groups.length; i++) {
                if (groups[i].key === selected) {
                    selectedGroup = groups[i];
                    break;
                }
            }
            var label = selectedGroup ? selectedGroup.label : '全部';
            setTextIfChanged(meta, '当前显示 ' + label + ' · 类型 ' + formatNumber(groups.length));
        }
        return selected;
    }

    function renderStaticCacheEntries() {
        var rows = document.getElementById('monitoringStaticCacheEntryRows');
        if (!rows) return;
        var payload = state.data.staticCacheEntries || {};
        var items = payload.items || [];
        var selected = renderStaticCacheEntryTypeFilter(items);
        if (!items.length) {
            setHtmlIfChanged(rows, '<tr><td colspan="7"><div class="monitoring-empty">暂无缓存条目，点击预热或访问 K937 页面后会出现</div></td></tr>');
            return;
        }
        var visibleItems = selected === 'all' ? items : items.filter(function(item) {
            return staticCacheEntryTypeInfo(item).key === selected;
        });
        if (!visibleItems.length) {
            setHtmlIfChanged(rows, '<tr><td colspan="7"><div class="monitoring-empty">当前类型暂无缓存条目</div></td></tr>');
            return;
        }
        setHtmlIfChanged(rows, visibleItems.map(function(item) {
            var path = item.path || '-';
            var fresh = item.fresh !== false;
            return '<tr>' +
                '<td><code>' + escapeHtml(path) + '</code></td>' +
                '<td>' + escapeHtml(item.memory ? '命中' : '-') + '</td>' +
                '<td>' + escapeHtml(fresh ? '有效' : '过期') + '</td>' +
                '<td>' + escapeHtml(formatBytes(item.body_size)) + '</td>' +
                '<td>' + escapeHtml(item.content_type || '-') + '</td>' +
                '<td>' + escapeHtml(formatSeconds(item.ttl_seconds || 0)) + '</td>' +
                '<td>' + escapeHtml(formatTime(item.created_at ? item.created_at * 1000 : '')) + '</td>' +
                '</tr>';
        }).join(''));
    }

    function renderStaticCachePrewarm() {
        var cards = document.getElementById('monitoringStaticCachePrewarmCards');
        var rows = document.getElementById('monitoringStaticCachePrewarmRows');
        var item = state.data.staticCachePrewarm || {};
        var summary = item.summary || {};
        var pages = item.pages || [];
        if (cards) {
            if (!item.summary) {
                setHtmlIfChanged(cards, renderCard('资源预热', '未执行', '覆盖首页、中心页、EP/ACE、安全设置和财务管理'));
            } else {
                setHtmlIfChanged(cards,
                    renderCard('预热页面', formatNumber(summary.pages), '发现 ' + formatNumber(summary.discovered) + ' 个资源') +
                    renderCard('预热请求', formatNumber(summary.attempted), '耗时 ' + formatMs(summary.elapsed_ms)) +
                    renderCard('命中/新写入', formatNumber(summary.hit || 0) + ' / ' + formatNumber(summary.miss || 0), '绕过 ' + formatNumber(summary.bypass || 0) + '；失败 ' + formatNumber(summary.error || 0))
                );
            }
        }
        if (rows) {
            if (!pages.length) {
                setHtmlIfChanged(rows, '<tr><td colspan="5"><div class="monitoring-empty">尚未执行预热</div></td></tr>');
            } else {
                setHtmlIfChanged(rows, pages.map(function(page) {
                    return '<tr>' +
                        '<td><code>' + escapeHtml(page.path || '-') + '</code></td>' +
                        '<td>' + escapeHtml(page.status_code || '-') + '</td>' +
                        '<td>' + escapeHtml(formatNumber(page.asset_count || 0)) + '</td>' +
                        '<td>' + escapeHtml(formatMs(page.elapsed_ms || 0)) + '</td>' +
                        '<td>' + escapeHtml(page.error || '-') + '</td>' +
                        '</tr>';
                }).join(''));
            }
        }
    }

    function renderStaticCachePolicy() {
        var item = state.data.staticCache || {};
        var runtime = staticCacheRuntimeSnapshot();
        var memoryPolicy = runtime.policy || {};
        setChecked('staticCacheMemoryEnabled', memoryPolicy.enabled !== false);
        setChecked('staticCacheMemoryStatsEnabled', memoryPolicy.stats_enabled !== false);
        setInputValue('staticCacheMemoryMaxEntries', memoryPolicy.max_entries || 512);
        setInputValue('staticCacheMemoryMaxMb', bytesToMb(memoryPolicy.max_bytes || 64 * 1024 * 1024));
        setInputValue('staticCacheMemoryMaxBodyKb', bytesToKb(memoryPolicy.max_body_bytes || 2 * 1024 * 1024));
        setInputValue('staticCacheJsBrowserHours', secondsToHours(item.js_browser_max_age_seconds));
        setInputValue('staticCacheCssBrowserDays', secondsToDays(item.css_browser_max_age_seconds));
        setInputValue('staticCacheMediaBrowserDays', secondsToDays(item.media_browser_max_age_seconds));
        setInputValue('staticCacheJsDiskDays', secondsToDays(item.js_disk_ttl_seconds));
        setInputValue('staticCacheCssDiskDays', secondsToDays(item.css_disk_ttl_seconds));
        setInputValue('staticCacheMediaDiskDays', secondsToDays(item.media_disk_ttl_seconds));
        setInputValue('staticCacheStaleDays', secondsToDays(item.stale_while_revalidate_seconds));
        var meta = document.getElementById('monitoringStaticCacheMeta');
        if (meta) {
            var version = item.version ? '版本 ' + item.version : '版本 -';
            setTextIfChanged(meta, version + ' · 更新于 ' + formatTime(item.updated_at ? item.updated_at * 1000 : ''));
        }
        renderStaticCacheRuntimeCards();
        renderStaticCacheEntries();
        renderStaticCachePrewarm();
    }

    function loadCollapsibleRequest(key, force, requestFactory, applyResult, renderAfter, errorMessage) {
        if (!shouldLoadCollapsibleSection(key) || state.loadingCollapsible[key]) return Promise.resolve();
        state.loadingCollapsible[key] = true;
        return requestFactory().then(function(body) {
            applyResult(body || {});
            if (typeof renderAfter === 'function') renderAfter();
        }).catch(function(err) {
            if (force) notify(err && err.message || errorMessage || '监控数据刷新失败', 'error');
        }).finally(function() {
            state.loadingCollapsible[key] = false;
        });
    }

    function loadDatabaseStats(force) {
        return loadCollapsibleRequest('database', force, function() {
            return api('/database', force ? { force: '1' } : {});
        }, function(body) {
            state.data.database = body.item;
        }, render, '数据库表占用刷新失败');
    }

    function loadChatSummary(force) {
        var params = { range: state.range };
        var forceParams = { range: state.range, force: force ? '1' : '' };
        return loadCollapsibleRequest('chat', force, function() {
            return api('/chat/summary', force ? forceParams : params);
        }, function(body) {
            state.data.chat = body.item;
        }, render, '聊天统计刷新失败');
    }

    function loadGroupStorage(force) {
        var params = { range: state.range, limit: '100' };
        var forceParams = { range: state.range, limit: '100', force: '1' };
        return loadCollapsibleRequest('groups', force, function() {
            return api('/chat/groups', force ? forceParams : params);
        }, function(body) {
            state.data.groups = body.item;
        }, render, '群组存储排行刷新失败');
    }

    function loadFileAssets(force) {
        var params = { status: 'active', limit: '50' };
        var forceParams = { status: 'active', limit: '50', force: '1' };
        return loadCollapsibleRequest('fileAssets', force, function() {
            return api('/chat/file-assets', force ? forceParams : params);
        }, function(body) {
            state.data.fileAssets = body.item;
        }, render, '文件资源 Top 刷新失败');
    }

    function loadStaticCachePolicy() {
        if (!shouldLoadCollapsibleSection('staticCache') || state.loadingStaticCache) return Promise.resolve();
        state.loadingStaticCache = true;
        return api('/static-cache/policy', {}).then(function(body) {
            state.data.staticCache = body.item || {};
            renderStaticCachePolicy();
            return loadStaticCacheEntries(false);
        }).catch(function(err) {
            notify(err && err.message || '静态资源缓存策略读取失败', 'error');
        }).finally(function() {
            state.loadingStaticCache = false;
        });
    }

    function loadStaticCacheEntries(force) {
        if (!shouldLoadCollapsibleSection('staticCache') || state.loadingStaticCacheEntries) return Promise.resolve();
        state.loadingStaticCacheEntries = true;
        return api('/static-cache/entries', { limit: 80 }).then(function(body) {
            state.data.staticCacheEntries = body.item || {};
            renderStaticCacheEntries();
            if (force) notify('缓存条目已刷新', 'success');
        }).catch(function(err) {
            if (force) notify(err && err.message || '缓存条目读取失败', 'error');
        }).finally(function() {
            state.loadingStaticCacheEntries = false;
        });
    }

    function loadRuntimeHygiene(force) {
        if (!shouldLoadRuntimeHygiene() || state.loadingRuntimeHygiene) return Promise.resolve();
        state.loadingRuntimeHygiene = true;
        return api('/runtime-hygiene', force ? { force: '1' } : {}).then(function(body) {
            state.data.runtimeHygiene = body.item || {};
            renderRuntimeHygiene();
            renderStaticCachePolicy();
        }).catch(function(err) {
            notify(err && err.message || '运行时维护状态读取失败', 'error');
        }).finally(function() {
            state.loadingRuntimeHygiene = false;
        });
    }

    function loadRuntimePerformance(force) {
        if (!state.active || state.loadingRuntimePerformance) return Promise.resolve();
        state.loadingRuntimePerformance = true;
        return performanceApi('/runtime', force ? { force: '1' } : {}).then(function(body) {
            state.data.runtimePerformance = body || {};
            renderRuntimePerformance();
            renderAlert();
        }).catch(function(err) {
            state.data.runtimePerformance = { error: err && err.message || '运行时性能数据读取失败' };
            renderRuntimePerformance();
            renderAlert();
            if (force) notify(state.data.runtimePerformance.error, 'error');
        }).finally(function() {
            state.loadingRuntimePerformance = false;
        });
    }

    function loadWsTickets(force) {
        if (!state.active || state.loadingWsTickets) return Promise.resolve();
        state.loadingWsTickets = true;
        return api('/ws-tickets', force ? { force: '1' } : {}).then(function(body) {
            state.data.wsTickets = body.item || {};
            renderWsTickets();
            renderAlert();
        }).catch(function(err) {
            state.data.wsTickets = { error: err && err.message || '短票诊断数据读取失败' };
            renderWsTickets();
            renderAlert();
            if (force) notify(state.data.wsTickets.error, 'error');
        }).finally(function() {
            state.loadingWsTickets = false;
        });
    }

    function clearIndexPlanTimer() {
        if (state.indexPlanTimer) clearTimeout(state.indexPlanTimer);
        state.indexPlanTimer = null;
    }

    function scheduleIndexPlanFollowup() {
        clearIndexPlanTimer();
        var runner = state.data.indexPlan && state.data.indexPlan.runner || {};
        if (!shouldLoadCollapsibleSection('indexPlan') || !runner.running) return;
        state.indexPlanTimer = setTimeout(function() {
            loadIndexPlan(false);
        }, 5000);
    }

    function loadIndexPlan(force) {
        if (!shouldLoadCollapsibleSection('indexPlan') || state.loadingIndexPlan) return Promise.resolve();
        state.loadingIndexPlan = true;
        return performanceApi('/index-plan', force ? { force: '1' } : {}).then(function(body) {
            state.data.indexPlan = body || {};
            renderIndexPlan();
            scheduleIndexPlanFollowup();
        }).catch(function(err) {
            state.data.indexPlan = { error: err && err.message || '索引计划读取失败' };
            renderIndexPlan();
            if (force) notify(state.data.indexPlan.error, 'error');
        }).finally(function() {
            state.loadingIndexPlan = false;
        });
    }

    function runIndexPlan() {
        var current = state.data.indexPlan || {};
        var runner = current.runner || {};
        var summary = current.summary || {};
        if (runner.running) {
            notify('索引执行器正在运行，请等待当前批次结束', 'warning');
            return;
        }
        if (!Number(summary.runnable || 0)) {
            notify('当前没有可执行的缺失索引', 'info');
            return;
        }
        if (!window.confirm('确认执行 1 个缺失索引？\n系统会使用 CREATE INDEX CONCURRENTLY，并限制小批量执行；大表仍建议低峰操作。')) return;
        performancePost('/index-plan/run', { limit: 1 }).then(function(body) {
            state.data.indexPlan = body || {};
            renderIndexPlan();
            scheduleIndexPlanFollowup();
            notify(body.accepted ? '索引执行已启动' : (body.message || '没有可执行索引'), body.accepted ? 'success' : 'info');
        }).catch(function(err) {
            notify(err && err.message || '索引执行启动失败', 'error');
        });
    }

    function collectRuntimeHygienePolicy() {
        return {
            enabled: inputChecked('runtimeHygieneEnabled'),
            cleanup_browse_sessions_enabled: inputChecked('runtimeCleanupBrowseSessions'),
            cleanup_ak_auth_cache_enabled: inputChecked('runtimeCleanupAkAuthCache'),
            cleanup_static_cache_locks_enabled: inputChecked('runtimeCleanupStaticLocks'),
            cleanup_interval_seconds: inputNumber('runtimeCleanupInterval'),
            ak_web_client_max_age_seconds: inputNumber('runtimeAkClientMaxAge'),
            ak_web_client_max_requests: inputNumber('runtimeAkClientMaxRequests'),
            ak_web_client_idle_seconds: inputNumber('runtimeAkClientIdle'),
            outbound_client_max_age_seconds: inputNumber('runtimeOutboundClientMaxAge'),
            outbound_client_max_requests: inputNumber('runtimeOutboundClientMaxRequests'),
            outbound_client_idle_seconds: inputNumber('runtimeOutboundClientIdle')
        };
    }

    function collectWsTicketPolicy() {
        return {
            enabled: inputChecked('wsTicketDiagnosticsEnabled'),
            auto_close_minutes: inputNumber('wsTicketDiagnosticsMinutes'),
            retention_days: inputNumber('wsTicketDiagnosticsRetentionDays')
        };
    }

    function saveWsTicketPolicy() {
        apiPost('/ws-tickets/policy', collectWsTicketPolicy()).then(function(body) {
            state.data.wsTickets = body.item || {};
            renderWsTickets();
            notify('WebSocket 短票诊断策略已保存', 'success');
        }).catch(function(err) {
            notify(err && err.message || 'WebSocket 短票诊断策略保存失败', 'error');
        });
    }

    function saveRuntimeHygienePolicy() {
        apiPost('/runtime-hygiene/config', collectRuntimeHygienePolicy()).then(function(body) {
            state.data.runtimeHygiene = body.item || {};
            renderRuntimeHygiene();
            notify('运行时维护配置已保存并应用', 'success');
        }).catch(function(err) {
            notify(err && err.message || '运行时维护配置保存失败', 'error');
        });
    }

    function runRuntimeHygieneOnce() {
        apiPost('/runtime-hygiene/run-once', {}).then(function(body) {
            state.data.runtimeHygiene = body.item || {};
            renderRuntimeHygiene();
            notify('运行时维护已执行一次', 'success');
        }).catch(function(err) {
            notify(err && err.message || '运行时维护执行失败', 'error');
        });
    }

    function saveStaticCachePolicy() {
        var payload = {
            js_browser_max_age_seconds: hoursToSeconds(inputNumber('staticCacheJsBrowserHours')),
            css_browser_max_age_seconds: daysToSeconds(inputNumber('staticCacheCssBrowserDays')),
            media_browser_max_age_seconds: daysToSeconds(inputNumber('staticCacheMediaBrowserDays')),
            js_disk_ttl_seconds: daysToSeconds(inputNumber('staticCacheJsDiskDays')),
            css_disk_ttl_seconds: daysToSeconds(inputNumber('staticCacheCssDiskDays')),
            media_disk_ttl_seconds: daysToSeconds(inputNumber('staticCacheMediaDiskDays')),
            stale_while_revalidate_seconds: daysToSecondsAllowZero(inputNumber('staticCacheStaleDays')),
            memory_enabled: inputChecked('staticCacheMemoryEnabled'),
            memory_stats_enabled: inputChecked('staticCacheMemoryStatsEnabled'),
            memory_max_entries: inputNumber('staticCacheMemoryMaxEntries'),
            memory_max_bytes: mbToBytes(inputNumber('staticCacheMemoryMaxMb')),
            memory_max_body_bytes: kbToBytes(inputNumber('staticCacheMemoryMaxBodyKb'))
        };
        apiPost('/static-cache/policy', payload).then(function(body) {
            state.data.staticCache = body.item || {};
            renderStaticCachePolicy();
            notify('K937 静态资源缓存配置已保存', 'success');
            return loadRuntimeHygiene(true);
        }).catch(function(err) {
            notify(err && err.message || '缓存配置保存失败', 'error');
        });
    }

    function refreshStaticCacheUpstream() {
        if (!window.confirm('确认立刻启用 K937 上游新资源？\n该操作会清空服务端静态资源缓存，并切换全局资源版本，使用户下次打开页面时请求新静态资源。')) return;
        apiPost('/static-cache/refresh-upstream', {}).then(function(body) {
            state.data.staticCache = body.item || {};
            renderStaticCachePolicy();
            notify('已切换上游资源版本，清理缓存分片 ' + formatNumber((body.item && body.item.removed_entries) || 0) + ' 个', 'success');
            return Promise.allSettled([loadStaticCacheEntries(false), loadRuntimeHygiene(true)]);
        }).catch(function(err) {
            notify(err && err.message || '启用上游新资源失败', 'error');
        });
    }

    function prewarmStaticCache() {
        if (state.loadingStaticCachePrewarm) {
            notify('静态资源预热正在执行，请稍候', 'warning');
            return;
        }
        if (!window.confirm('确认预热 K937 常用页面资源？\n将覆盖首页、中心页、EP/ACE 列表、安全设置和财务管理页面。')) return;
        state.loadingStaticCachePrewarm = true;
        apiPost('/static-cache/prewarm', { max_assets: 180 }).then(function(body) {
            state.data.staticCachePrewarm = body.item || {};
            renderStaticCachePrewarm();
            var summary = (body.item && body.item.summary) || {};
            notify('预热完成：新写入 ' + formatNumber(summary.miss || 0) + '，命中 ' + formatNumber(summary.hit || 0) + '，失败 ' + formatNumber(summary.error || 0), summary.error ? 'warning' : 'success');
            return Promise.allSettled([loadStaticCacheEntries(false), loadRuntimeHygiene(true)]);
        }).catch(function(err) {
            notify(err && err.message || '静态资源预热失败', 'error');
        }).finally(function() {
            state.loadingStaticCachePrewarm = false;
        });
    }

    function loadLight(force) {
        if (!state.active || state.loadingLight) return Promise.resolve();
        state.loadingLight = true;
        return Promise.allSettled([
            api('/system', force ? { force: '1' } : {}).then(function(body) { state.data.system = body.item; }),
            api('/health', force ? { force: '1' } : {}).then(function(body) { state.data.health = body.item; })
        ]).then(function(results) {
            results.forEach(function(result) {
                if (result.status === 'rejected') notify(result.reason && result.reason.message || '监控状态刷新失败', 'error');
            });
            render();
        }).finally(function() {
            state.loadingLight = false;
        });
    }

    function loadHeavy(force) {
        if (!state.active || state.loadingHeavy) return Promise.resolve();
        state.loadingHeavy = true;
        return Promise.allSettled([
            loadDatabaseStats(force),
            loadChatSummary(force),
            loadGroupStorage(force),
            loadFileAssets(force)
        ]).then(function(results) {
            results.forEach(function(result) {
                if (result.status === 'rejected') notify(result.reason && result.reason.message || '监控统计刷新失败', 'error');
            });
            render();
        }).finally(function() {
            state.loadingHeavy = false;
        });
    }

    function loadOverview(force) {
        return Promise.allSettled([
            loadLight(force),
            loadHeavy(force)
        ]).then(function() {
            render();
        });
    }

    function clearStartupHeavyTimer() {
        if (state.startupHeavyTimer) {
            clearTimeout(state.startupHeavyTimer);
            state.startupHeavyTimer = null;
        }
    }

    function scheduleStartupHeavyLoad() {
        clearStartupHeavyTimer();
        state.startupHeavyTimer = setTimeout(function() {
            state.startupHeavyTimer = null;
            if (state.active) loadHeavy(false);
        }, 800);
    }

    function loadInitialMonitoringData() {
        return Promise.all([loadLight(false), loadWsTickets(false)]).finally(function() {
            if (state.active) scheduleStartupHeavyLoad();
        });
    }

    function expireFileAsset(storageName, originalName, referencedMessages) {
        if (!storageName) return;
        var message = '确认删除文件“' + originalName + '”并释放存储空间？';
        if (referencedMessages > 0) {
            message += '\n该文件仍被 ' + referencedMessages + ' 条聊天消息引用，删除后这些附件会显示为已失效。';
        }
        if (!window.confirm(message)) return;
        apiPost('/chat/file-assets/' + encodeURIComponent(storageName) + '/expire', {}).then(function(body) {
            notify(body.message || '文件已删除并标记失效', 'success');
            return loadHeavy(true);
        }).catch(function(err) {
            notify(err && err.message || '文件删除失败', 'error');
        });
    }

    function start() {
        state.active = true;
        if (!state.initialized) init();
        stopTimers();
        loadInitialMonitoringData();
        loadStaticCachePolicy();
        loadRuntimeHygiene(false);
        loadRuntimePerformance(false);
        loadIndexPlan(false);
        var registry = setupMonitoringPollingRegistry();
        if (registry) {
            registry.startOwner(MONITORING_POLL_OWNER);
            return;
        }
        state.lightTimer = setInterval(function() {
            loadLight(false);
            loadWsTickets(false);
            loadRuntimeHygiene(false);
            loadRuntimePerformance(false);
        }, 5000);
        state.heavyTimer = setInterval(function() { loadHeavy(false); }, 3600000);
    }

    function stopTimers() {
        if (window.AKPollingRegistry) window.AKPollingRegistry.stopOwner(MONITORING_POLL_OWNER);
        if (state.lightTimer) clearInterval(state.lightTimer);
        if (state.heavyTimer) clearInterval(state.heavyTimer);
        clearStartupHeavyTimer();
        clearIndexPlanTimer();
        state.lightTimer = null;
        state.heavyTimer = null;
    }

    function stop() {
        state.active = false;
        stopTimers();
    }

    function init() {
        ensureCss();
        buildShell();
        state.initialized = true;
        render();
    }

    window.AKMonitoringPanel = {
        init: init,
        start: start,
        stop: stop,
        refreshLight: function() { return Promise.all([loadLight(true), loadWsTickets(true), loadStaticCachePolicy(), loadRuntimeHygiene(true), loadRuntimePerformance(true), loadIndexPlan(true)]); },
        refreshHeavy: function() { return loadHeavy(true); }
    };

    window.addEventListener('ak-admin-panel-changed', function(event) {
        var panel = event && event.detail && event.detail.panel;
        if (panel === 'monitoring') {
            start();
        } else {
            stop();
        }
    });

    if (document.querySelector('.tab.active[data-panel="monitoring"]')) {
        start();
    } else {
        init();
    }
})();
