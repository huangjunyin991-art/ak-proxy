(function () {
    'use strict';

    const state = {
        stats: null,
        bound: false,
        chart: null,
        chartLoading: false,
    };

    function formatNumber(value) {
        const num = Number(value || 0);
        if (window.formatNumber) return window.formatNumber(num);
        return num.toLocaleString('zh-CN');
    }

    function normalizeRows(rows) {
        return Array.isArray(rows) ? rows.map(item => ({
            date: String(item.date || ''),
            increase: Number(item.increase || 0),
            total: Number(item.total || 0),
        })).filter(item => item.date) : [];
    }

    function ensureModal() {
        let modal = document.getElementById('userGrowthModal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'userGrowthModal';
        modal.innerHTML = `
            <div class="modal-content user-growth-modal-content">
                <h3 class="ug-modal-title">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                    用户数量增长趋势
                </h3>
                <div id="userGrowthContent"></div>
                <div class="modal-buttons" style="display:flex;justify-content:center;margin-top:18px;">
                    <button class="btn" id="userGrowthCloseBtn" style="min-width:140px;background:var(--accent);color:white;">关闭</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', event => {
            if (event.target === modal) close();
        });
        const closeBtn = modal.querySelector('#userGrowthCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', close);
        return modal;
    }

    function destroyChart() {
        if (state.chart) {
            state.chart.destroy();
            state.chart = null;
        }
    }

    function showChartOverlay(type, message) {
        const shell = document.querySelector('.ug-chart-shell');
        if (!shell) return;
        removeChartOverlay();
        const overlay = document.createElement('div');
        overlay.className = 'ug-chart-overlay ug-chart-overlay--' + type;
        overlay.innerHTML = '<span>' + message + '</span>';
        shell.style.position = 'relative';
        shell.appendChild(overlay);
    }

    function showChartLoading() {
        state.chartLoading = true;
        showChartOverlay('loading', '正在加载图表...');
    }

    function showChartError(msg) {
        state.chartLoading = false;
        showChartOverlay('error', msg || '图表加载失败');
    }

    function removeChartOverlay() {
        state.chartLoading = false;
        const overlay = document.querySelector('.ug-chart-overlay');
        if (overlay) overlay.remove();
    }

    function drawChart(labels, increases, maxIncrease) {
        const canvas = document.getElementById('userGrowthChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const shellH = (canvas.parentElement && canvas.parentElement.offsetHeight) || 280;
        const gradient = ctx.createLinearGradient(0, 0, 0, shellH);
        gradient.addColorStop(0, 'rgba(0, 212, 255, 0.25)');
        gradient.addColorStop(1, 'rgba(0, 212, 255, 0.02)');

        state.chart = new window.Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        type: 'bar',
                        label: '新增',
                        data: increases,
                        backgroundColor: 'rgba(0, 212, 255, 0.7)',
                        borderColor: 'rgba(0, 212, 255, 1)',
                        borderWidth: 1,
                        borderRadius: 4,
                        borderSkipped: false,
                        yAxisID: 'y',
                    },
                    {
                        type: 'line',
                        label: '趋势',
                        data: increases,
                        borderColor: '#00d4ff',
                        backgroundColor: gradient,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 3,
                        pointBackgroundColor: '#00d4ff',
                        pointBorderColor: '#0a1a2f',
                        pointBorderWidth: 1.5,
                        pointHoverRadius: 5,
                        borderWidth: 2,
                        yAxisID: 'y',
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 800,
                    easing: 'easeOutQuart',
                },
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(10, 20, 40, 0.95)',
                        borderColor: 'rgba(0, 212, 255, 0.4)',
                        borderWidth: 1,
                        titleColor: '#00d4ff',
                        bodyColor: '#e0e8f0',
                        titleFont: { size: 12, weight: 'bold' },
                        bodyFont: { size: 12 },
                        padding: 10,
                        filter: function (item) {
                            // 只显示 bar（新增）dataset 的 tooltip，隐藏 line（趋势）dataset
                            return item.dataset.type === 'bar';
                        },
                        callbacks: {
                            title: function (items) {
                                const idx = items[0].dataIndex;
                                const rows = normalizeRows(state.stats && state.stats.user_growth || []);
                                return rows[idx] ? rows[idx].date : items[0].label;
                            },
                            label: function (ctx) {
                                const idx = ctx.dataIndex;
                                const rows = normalizeRows(state.stats && state.stats.user_growth || []);
                                if (rows[idx]) {
                                    return [
                                        '新增: +' + formatNumber(rows[idx].increase),
                                        '总数: ' + formatNumber(rows[idx].total),
                                    ];
                                }
                                return ctx.dataset.label + ': ' + formatNumber(ctx.raw);
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255,255,255,0.05)', drawTicks: false },
                        ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 10 }, maxRotation: 0 },
                        border: { display: false },
                    },
                    y: {
                        beginAtZero: true,
                        max: Math.ceil(maxIncrease * 1.15) || 10,
                        grid: { color: 'rgba(255,255,255,0.05)', drawTicks: false },
                        ticks: {
                            color: 'rgba(255,255,255,0.5)',
                            font: { size: 10 },
                            callback: function (value) { return formatNumber(value); },
                        },
                        border: { display: false },
                    },
                },
            },
        });
    }

    function initChart(labels, increases, maxIncrease) {
        if (typeof window.Chart !== 'function') {
            if (initChart._pollCount < 30) {
                initChart._pollCount = (initChart._pollCount || 0) + 1;
                setTimeout(function () { initChart(labels, increases, maxIncrease); }, 100);
            } else {
                showChartError('图表库加载超时，请强制刷新页面后重试');
            }
            return;
        }
        initChart._pollCount = 0;
        destroyChart();
        drawChart(labels, increases, maxIncrease);
        removeChartOverlay();
    }

    function open() {
        var modal = ensureModal();
        var rows = state.stats && state.stats.user_growth;
        var data = normalizeRows(rows);
        var content = document.getElementById('userGrowthContent');

        if (!data.length) {
            if (content) content.innerHTML = '<div class="ug-empty">暂无增长数据</div>';
            modal.classList.add('active');
            modal.style.display = 'flex';
            return;
        }

        var last = data[data.length - 1];
        var periodIncrease = data.reduce(function (s, i) { return s + i.increase; }, 0);
        var trendDelta = data.length > 1 ? last.total - data[0].total : 0;
        var trendUp = trendDelta >= 0;
        var trendPercent = data.length > 1 && data[0].total > 0
            ? ((trendDelta / data[0].total) * 100).toFixed(1)
            : '0';

        var lbls = data.map(function (item, i) { return (i % 2 === 0 || i === data.length - 1) ? item.date.slice(5) : ''; });
        var vals = data.map(function (item) { return item.increase; });
        var maxVal = Math.max.apply(null, vals.concat([1]));

        content.innerHTML = [
            '<div class="ug-summary">',
            '<div class="ug-stat-card">',
            '<div class="ug-stat-icon" style="background:linear-gradient(135deg,#00d4ff22,#00d4ff44);">',
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00d4ff" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
            '</div><div class="ug-stat-body"><div class="ug-stat-label">当前总用户数</div>',
            '<div class="ug-stat-value accent">' + formatNumber(last.total) + '</div></div></div>',
            '<div class="ug-stat-card">',
            '<div class="ug-stat-icon" style="background:linear-gradient(135deg,#ffd70022,#ffd70044);">',
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffd700" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
            '</div><div class="ug-stat-body"><div class="ug-stat-label">当天新增</div>',
            '<div class="ug-stat-value" style="color:#ffd700">+' + formatNumber(last.increase) + '</div></div></div>',
            '<div class="ug-stat-card">',
            '<div class="ug-stat-icon" style="background:linear-gradient(135deg,#00ff8822,#00ff8844);">',
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00ff88" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 5 5 12"/></svg>',
            '</div><div class="ug-stat-body"><div class="ug-stat-label">近' + data.length + '天新增</div>',
            '<div class="ug-stat-value green">+' + formatNumber(periodIncrease) + '</div></div></div>',
            '<div class="ug-stat-card">',
            '<div class="ug-stat-icon" style="background:linear-gradient(135deg,' + (trendUp ? '#00ff8822,#00ff8844' : '#ff475722,#ff475744') + ');">',
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="' + (trendUp ? '#00ff88' : '#ff4757') + '" stroke-width="2">' + (trendUp ? '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>' : '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>') + '</svg>',
            '</div><div class="ug-stat-body"><div class="ug-stat-label">周期增长</div>',
            '<div class="ug-stat-value" style="color:' + (trendUp ? '#00ff88' : '#ff4757') + '">' + (trendUp ? '+' : '') + formatNumber(trendDelta) + ' (' + (trendUp ? '+' : '') + trendPercent + '%)</div></div></div>',
            '</div>',
            '<div class="ug-chart-shell" style="position:relative;"><canvas id="userGrowthChart"></canvas></div>',
        ].join('');

        modal.classList.add('active');
        modal.style.display = 'flex';
        showChartLoading();
        requestAnimationFrame(function () { initChart(lbls, vals, maxVal); });
    }

    function close() {
        const modal = document.getElementById('userGrowthModal');
        if (!modal) return;
        modal.classList.remove('active');
        modal.style.display = 'none';
    }

    function bindTrigger() {
        if (state.bound) return;
        const trigger = document.querySelector('[data-user-growth-trigger]');
        if (!trigger) return;
        state.bound = true;
        trigger.addEventListener('click', open);
    }

    function updateStats(stats) {
        state.stats = stats || null;
    }

    window.addEventListener('admin:stats-refreshed', event => updateStats(event.detail || null));
    document.addEventListener('DOMContentLoaded', bindTrigger);
    bindTrigger();

    window.AdminUserGrowthChart = {
        bind: bindTrigger,
        updateStats,
        open,
        close,
    };
})();
