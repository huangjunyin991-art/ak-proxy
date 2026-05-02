(function() {
    if (window.AKMonitoringPanelLoaded) return;
    window.AKMonitoringPanelLoaded = true;

    var state = {
        initialized: false,
        active: false,
        range: '7d',
        lightTimer: null,
        heavyTimer: null,
        loadingHeavy: false,
        loadingLight: false,
        data: {
            system: null,
            health: null,
            database: null,
            chat: null,
            groups: null,
            fileAssets: null
        }
    };

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

    function ensureCss() {
        if (document.querySelector('link[data-monitoring-panel-css="1"]')) return;
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/admin/api/monitoring-panel.css?v=20260502-05';
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

    function buildShell() {
        var el = mount();
        if (!el) return;
        el.innerHTML = '<div class="monitoring-root">' +
            '<div class="monitoring-header">' +
            '<div class="monitoring-title"><h3>监控中心</h3><p>低成本健康状态 5 秒刷新，高成本统计 1 小时刷新；高负载时优先保护正常业务。</p></div>' +
            '<div class="monitoring-actions">' +
            '<select class="monitoring-select" id="monitoringRange"><option value="24h">24小时</option><option value="7d" selected>7天</option><option value="30d">30天</option></select>' +
            '<button class="monitoring-btn" id="monitoringRefreshLight">刷新状态</button>' +
            '<button class="monitoring-btn primary" id="monitoringRefreshHeavy">刷新统计</button>' +
            '</div>' +
            '</div>' +
            '<div class="monitoring-alert" id="monitoringAlert"></div>' +
            '<div class="monitoring-grid" id="monitoringCards"></div>' +
            '<div class="monitoring-section"><div class="monitoring-section-header"><h4>服务器负载</h4><span class="monitoring-meta" id="monitoringSystemMeta">-</span></div><div class="monitoring-donuts" id="monitoringSystemDonuts"></div><div class="monitoring-bars" id="monitoringSystemBars"></div></div>' +
            '<div class="monitoring-section"><div class="monitoring-section-header"><h4>聊天统计</h4><span class="monitoring-meta" id="monitoringChatMeta">-</span></div><div class="monitoring-grid" id="monitoringChatCards"></div><div class="monitoring-bars" id="monitoringTypeBars" style="margin-top:14px;"></div></div>' +
            '<div class="monitoring-section"><div class="monitoring-section-header"><h4>数据库表占用</h4><span class="monitoring-meta" id="monitoringDbMeta">-</span></div><div class="monitoring-bars" id="monitoringDbBars"></div></div>' +
            '<div class="monitoring-section"><div class="monitoring-section-header"><h4>文件资源 Top</h4><span class="monitoring-meta" id="monitoringFileAssetMeta">按 active 文件大小倒序；删除后聊天消息保留，附件显示失效</span></div><div class="monitoring-table-wrap"><table class="monitoring-table"><thead><tr><th>文件名</th><th>类型</th><th>大小</th><th>状态</th><th>引用消息</th><th>过期时间</th><th>创建时间</th><th>storage_name</th><th>操作</th></tr></thead><tbody id="monitoringFileAssetRows"></tbody></table></div></div>' +
            '<div class="monitoring-section"><div class="monitoring-section-header"><h4>群组存储与活跃排行</h4><span class="monitoring-meta" id="monitoringGroupMeta">文件占用为消息载荷估算口径</span></div><div class="monitoring-table-wrap"><table class="monitoring-table"><thead><tr><th>群组</th><th>群主</th><th>成员</th><th>管理员</th><th>总消息</th><th>今日</th><th>范围内</th><th>纯文本</th><th>消息载荷</th><th>文件估算</th><th>总占用</th><th>最近活跃</th></tr></thead><tbody id="monitoringGroupRows"></tbody></table></div></div>' +
            '</div>';
        el.addEventListener('click', function(event) {
            var target = event.target;
            if (!target || !target.getAttribute || target.getAttribute('data-monitoring-action') !== 'expire-file-asset') return;
            var storageName = target.getAttribute('data-storage-name') || '';
            var originalName = target.getAttribute('data-original-name') || storageName;
            var referencedMessages = Number(target.getAttribute('data-referenced-messages') || 0);
            expireFileAsset(storageName, originalName, referencedMessages);
        });
        document.getElementById('monitoringRange').addEventListener('change', function() {
            state.range = this.value || '7d';
            loadHeavy(false);
        });
        document.getElementById('monitoringRefreshLight').addEventListener('click', function() { loadLight(true); });
        document.getElementById('monitoringRefreshHeavy').addEventListener('click', function() { loadHeavy(true); });
    }

    function renderCard(label, value, sub) {
        return '<div class="monitoring-card"><div class="monitoring-card-label">' + escapeHtml(label) + '</div><div class="monitoring-card-value">' + escapeHtml(value) + '</div><div class="monitoring-card-sub">' + escapeHtml(sub || '') + '</div></div>';
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

    function renderRankBars(items, labelKey, valueKey, formatter) {
        var list = Array.isArray(items) ? items.slice(0, 10) : [];
        if (!list.length) return '<div class="monitoring-empty">暂无数据</div>';
        var max = list.reduce(function(acc, item) { return Math.max(acc, Number(item[valueKey] || 0)); }, 0) || 1;
        return list.map(function(item) {
            var value = Number(item[valueKey] || 0);
            var label = item[labelKey] || item.table_name || item.message_type || '-';
            return renderProgress(label, value / max * 100, formatter ? formatter(value) : formatNumber(value));
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
        var dbOk = health.database && health.database.ok;
        var imOk = health.im_server && health.im_server.ok;
        var cards = document.getElementById('monitoringCards');
        if (cards) {
            cards.innerHTML = renderCard('数据库', dbOk ? '正常' : '异常', health.database && health.database.message || '-') +
                renderCard('IM 服务', imOk ? '正常' : '异常', health.im_server && health.im_server.message || '-') +
                renderCard('CPU', formatPercent(system.cpu_percent), (system.cpu_count || '-') + ' 核') +
                renderCard('内存', memory.available ? formatPercent(memory.percent) : '-', memory.available ? formatBytes(memory.used_bytes) + ' / ' + formatBytes(memory.total_bytes) : '不可用') +
                renderCard('磁盘', disk.available ? formatPercent(disk.percent) : '-', disk.available ? formatBytes(disk.used_bytes) + ' / ' + formatBytes(disk.total_bytes) : '不可用') +
                renderCard('后台进程内存', process.available ? formatBytes(process.rss_bytes) : '-', process.available ? '线程 ' + formatNumber(process.threads) + ' / PID ' + formatNumber(process.pid) : '不可用') +
                renderCard('后台运行时长', formatDuration(system.process_uptime_seconds), system.platform || '-') +
                renderCard('数据库大小', formatBytes(database.database_size_bytes), '连接数 ' + formatNumber(database.active_connections));
        }
        var systemDonuts = document.getElementById('monitoringSystemDonuts');
        if (systemDonuts) {
            systemDonuts.innerHTML = renderDonut('CPU 使用率', system.cpu_percent, (system.cpu_count || '-') + ' 核', '#00d4ff') +
                renderDonut('内存使用率', memory.available ? memory.percent : NaN, memory.available ? formatBytes(memory.used_bytes) + ' / ' + formatBytes(memory.total_bytes) : '不可用', '#00ff88') +
                renderDonut('磁盘使用率', disk.available ? disk.percent : NaN, disk.available ? formatBytes(disk.used_bytes) + ' / ' + formatBytes(disk.total_bytes) : '不可用', '#f5cd60');
        }
        var systemBars = document.getElementById('monitoringSystemBars');
        if (systemBars) {
            var load = system.load_average || {};
            var loadPercent = load.available && system.cpu_count ? Math.min(100, Number(load.load1 || 0) / Number(system.cpu_count || 1) * 100) : 0;
            systemBars.innerHTML = renderProgress('1分钟负载', loadPercent, load.available ? String(Number(load.load1 || 0).toFixed(2)) : '-') +
                renderProgress('5分钟负载', load.available && system.cpu_count ? Math.min(100, Number(load.load5 || 0) / Number(system.cpu_count || 1) * 100) : 0, load.available ? String(Number(load.load5 || 0).toFixed(2)) : '-') +
                renderProgress('15分钟负载', load.available && system.cpu_count ? Math.min(100, Number(load.load15 || 0) / Number(system.cpu_count || 1) * 100) : 0, load.available ? String(Number(load.load15 || 0).toFixed(2)) : '-');
        }
        var systemMeta = document.getElementById('monitoringSystemMeta');
        if (systemMeta) systemMeta.textContent = '更新于 ' + formatTime(system.generated_at);
        var chatCards = document.getElementById('monitoringChatCards');
        if (chatCards) {
            chatCards.innerHTML = renderCard('会话总数', formatNumber(chat.conversation_total), '群聊 ' + formatNumber(chat.group_total) + ' / 私聊 ' + formatNumber(chat.direct_total)) +
                renderCard('消息总数', formatNumber(chat.message_total), '今日 ' + formatNumber(chat.message_today)) +
                renderCard('范围内消息', formatNumber(chat.message_in_range), chat.range || state.range) +
                renderCard('文件资源', formatBytes(chat.file_storage_bytes), '活跃 ' + formatNumber(chat.file_asset_active) + ' / 声明附件 ' + formatBytes(chat.declared_attachment_bytes)) +
                renderCard('纯文本内容', formatBytes(chat.text_storage_bytes), '仅 text 消息正文') +
                renderCard('消息载荷', formatBytes(chat.stored_payload_bytes), '文本与 JSON 元数据') +
                renderCard('估算总占用', formatBytes(chat.estimated_storage_bytes), '消息载荷 + 文件资源');
        }
        var typeBars = document.getElementById('monitoringTypeBars');
        if (typeBars) typeBars.innerHTML = renderMessageTypeStorageBars(chat.message_type_distribution);
        var chatMeta = document.getElementById('monitoringChatMeta');
        if (chatMeta) chatMeta.textContent = '高成本统计每小时自动刷新，更新于 ' + formatTime(chat.generated_at);
        var dbBars = document.getElementById('monitoringDbBars');
        if (dbBars) dbBars.innerHTML = renderRankBars(database.table_sizes, 'table_name', 'total_bytes', formatBytes);
        var dbMeta = document.getElementById('monitoringDbMeta');
        if (dbMeta) dbMeta.textContent = database.cache && database.cache.hit ? '缓存 ' + database.cache.age_seconds + ' 秒' : '更新于 ' + formatTime(database.generated_at);
        var fileAssetRows = document.getElementById('monitoringFileAssetRows');
        if (fileAssetRows) {
            var assets = Array.isArray(fileAssets.items) ? fileAssets.items : [];
            fileAssetRows.innerHTML = assets.length ? assets.map(function(item) {
                var storageName = String(item.storage_name || '');
                var originalName = String(item.original_name || storageName || '-');
                var status = String(item.status || '-');
                var disabled = status.toLowerCase() !== 'active';
                var button = disabled ? '<span class="monitoring-meta">已失效</span>' : '<button class="monitoring-btn danger" data-monitoring-action="expire-file-asset" data-storage-name="' + escapeHtml(storageName) + '" data-original-name="' + escapeHtml(originalName) + '" data-referenced-messages="' + Number(item.referenced_messages || 0) + '">删除文件</button>';
                return '<tr><td>' + escapeHtml(originalName) + '</td><td>' + escapeHtml(item.mime_type || '-') + '</td><td>' + formatBytes(item.file_size) + '</td><td>' + escapeHtml(status) + '</td><td>' + formatNumber(item.referenced_messages) + '</td><td>' + escapeHtml(formatTime(item.expires_at)) + '</td><td>' + escapeHtml(formatTime(item.created_at)) + '</td><td>' + escapeHtml(storageName) + '</td><td>' + button + '</td></tr>';
            }).join('') : '<tr><td colspan="9"><div class="monitoring-empty">暂无 active 文件资源</div></td></tr>';
        }
        var fileAssetMeta = document.getElementById('monitoringFileAssetMeta');
        if (fileAssetMeta) fileAssetMeta.textContent = (fileAssets.cache && fileAssets.cache.hit ? '缓存 ' + fileAssets.cache.age_seconds + ' 秒；' : '') + '删除后聊天消息保留，附件显示失效';
        var groupRows = document.getElementById('monitoringGroupRows');
        if (groupRows) {
            var items = Array.isArray(groups.items) ? groups.items : [];
            groupRows.innerHTML = items.length ? items.map(function(item) {
                return '<tr><td>' + escapeHtml(item.title || ('群组 ' + item.conversation_id)) + '</td><td>' + escapeHtml(item.owner_username || '-') + '</td><td>' + formatNumber(item.member_count) + '</td><td>' + formatNumber(item.admin_count) + '</td><td>' + formatNumber(item.message_total) + '</td><td>' + formatNumber(item.message_today) + '</td><td>' + formatNumber(item.message_in_range) + '</td><td>' + formatBytes(item.text_storage_bytes) + '</td><td>' + formatBytes(item.payload_storage_bytes) + '</td><td>' + formatBytes(item.file_storage_bytes) + '</td><td>' + formatBytes(item.estimated_storage_bytes) + '</td><td>' + escapeHtml(formatTime(item.last_message_at)) + '</td></tr>';
            }).join('') : '<tr><td colspan="12"><div class="monitoring-empty">暂无群组统计数据</div></td></tr>';
        }
        var groupMeta = document.getElementById('monitoringGroupMeta');
        if (groupMeta) groupMeta.textContent = (groups.cache && groups.cache.hit ? '缓存 ' + groups.cache.age_seconds + ' 秒；' : '') + '文件占用为消息载荷估算口径';
        renderAlert();
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
        var params = { range: state.range };
        var forceParams = { range: state.range, force: force ? '1' : '' };
        return Promise.allSettled([
            api('/database', force ? { force: '1' } : {}).then(function(body) { state.data.database = body.item; }),
            api('/chat/summary', force ? forceParams : params).then(function(body) { state.data.chat = body.item; }),
            api('/chat/groups', force ? { range: state.range, limit: '100', force: '1' } : { range: state.range, limit: '100' }).then(function(body) { state.data.groups = body.item; }),
            api('/chat/file-assets', force ? { status: 'active', limit: '50', force: '1' } : { status: 'active', limit: '50' }).then(function(body) { state.data.fileAssets = body.item; })
        ]).then(function(results) {
            results.forEach(function(result) {
                if (result.status === 'rejected') notify(result.reason && result.reason.message || '监控统计刷新失败', 'error');
            });
            render();
        }).finally(function() {
            state.loadingHeavy = false;
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
        loadLight(false);
        loadHeavy(false);
        stopTimers();
        state.lightTimer = setInterval(function() { loadLight(false); }, 5000);
        state.heavyTimer = setInterval(function() { loadHeavy(false); }, 3600000);
    }

    function stopTimers() {
        if (state.lightTimer) clearInterval(state.lightTimer);
        if (state.heavyTimer) clearInterval(state.heavyTimer);
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
        refreshLight: function() { return loadLight(true); },
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
