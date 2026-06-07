(function () {
    'use strict';

    function formatNumber(value) {
        const num = Number(value || 0);
        if (window.formatNumber) return window.formatNumber(num);
        return num.toLocaleString('zh-CN');
    }

    function escapeHtml(value) {
        if (window.escapeHtml) return window.escapeHtml(value);
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch]));
    }

    function fmtTime(value) {
        if (window.fmtTime) return window.fmtTime(value);
        if (!value) return '-';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN');
    }

    function canPollDashboard() {
        return !window.shouldRunAdminPanelPoll || window.shouldRunAdminPanelPoll('dashboard');
    }

    function renderHourlyChart(data) {
        const container = document.getElementById('hourlyChart');
        const labelsContainer = document.getElementById('chartLabels');
        if (!container || !labelsContainer) return;
        const hourlyData = new Array(24).fill(0);
        (Array.isArray(data) ? data : []).forEach(item => {
            const hour = Number(item && item.hour);
            if (hour >= 0 && hour < 24) hourlyData[hour] = Number(item.count || 0);
        });
        const maxValue = Math.max(...hourlyData, 1);
        const currentHour = new Date().getHours();
        container.innerHTML = hourlyData.map((value, hour) => {
            const height = (value / maxValue) * 100;
            const activeStyle = hour === currentHour ? 'background: linear-gradient(to top, #00ff88, #00d4ff);' : '';
            const label = `${hour}:00 - ${formatNumber(value)} 次`;
            return `<div class="chart-bar" style="height:${Math.max(height, 3)}%;${activeStyle}" data-value="${escapeHtml(formatNumber(value) + ' 次')}" title="${escapeHtml(label)}"></div>`;
        }).join('');
        labelsContainer.innerHTML = hourlyData.map((_, hour) => (
            `<div class="chart-label">${hour % 3 === 0 ? hour + ':00' : ''}</div>`
        )).join('');
    }

    function renderTopUsers(users) {
        const container = document.getElementById('topUsersList');
        if (!container) return;
        const rows = Array.isArray(users) ? users : [];
        if (!rows.length) {
            container.innerHTML = '<div class="ranking-empty">暂无数据</div>';
            return;
        }
        container.innerHTML = rows.slice(0, 10).map((user, index) => `
            <div class="ranking-item">
                <div class="ranking-rank">${index + 1}</div>
                <div class="ranking-user">
                    <div class="ranking-user-name">${escapeHtml(user.username || '')}</div>
                    <div class="ranking-user-meta">最近登录：${escapeHtml(fmtTime(user.last_login))}</div>
                </div>
                <div class="ranking-value">${formatNumber(user.count)} 次</div>
            </div>
        `).join('');
    }

    function renderTopIps(ips) {
        const container = document.getElementById('topIpsList');
        if (!container) return;
        const rows = Array.isArray(ips) ? ips : [];
        if (!rows.length) {
            container.innerHTML = '<div class="ranking-empty">暂无数据</div>';
            return;
        }
        container.innerHTML = rows.slice(0, 10).map((ip, index) => `
            <div class="ranking-item">
                <div class="ranking-rank">${index + 1}</div>
                <div class="ranking-name">${escapeHtml(ip.ip || '')}</div>
                <div class="ranking-value">${formatNumber(ip.count)} 次</div>
            </div>
        `).join('');
    }

    function renderMetrics(data) {
        const today = document.getElementById('dashTodayRequests');
        const rate = document.getElementById('dashSuccessRate');
        const active = document.getElementById('dashActiveUsers');
        const peak = document.getElementById('dashPeakRPM');
        if (today) today.textContent = formatNumber(data.today_requests || 0);
        if (rate) rate.textContent = `${Number(data.success_rate || 0).toFixed(1)}%`;
        if (active) active.textContent = formatNumber(data.active_users || 0);
        if (peak) peak.textContent = formatNumber(data.peak_rpm || 0);
    }

    function renderDashboard(data) {
        data = data || {};
        renderMetrics(data);
        renderHourlyChart(data.hourly_data || []);
        renderTopUsers(data.top_users || []);
        renderTopIps(data.top_ips || []);
        const time = document.getElementById('chartUpdateTime');
        if (time) {
            time.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
            });
        }
    }

    async function loadDashboard() {
        if (!canPollDashboard()) return;
        try {
            const base = window.API_BASE || window.location.origin;
            const res = await fetch(`${base}/admin/api/dashboard?force_refresh=1`);
            const data = await res.json();
            renderDashboard(data || {});
        } catch (error) {
            console.error('加载仪表盘失败', error);
        }
    }

    window.AdminTrafficDashboard = {
        loadDashboard,
        renderHourlyChart,
        renderTopUsers,
        renderTopIps,
        renderDashboard,
    };
})();
