(function () {
    'use strict';

    const state = {
        stats: null,
        bound: false,
    };

    function formatNumber(value) {
        const num = Number(value || 0);
        if (window.formatNumber) return window.formatNumber(num);
        return num.toLocaleString('zh-CN');
    }

    function escapeHtml(value) {
        if (window.escapeHtml) return window.escapeHtml(value);
        return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
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

    function normalizeRows(rows) {
        return Array.isArray(rows) ? rows.map(item => ({
            date: String(item.date || ''),
            increase: Number(item.increase || 0),
            total: Number(item.total || 0),
        })).filter(item => item.date) : [];
    }

    function render(rows) {
        const content = document.getElementById('userGrowthContent');
        if (!content) return;
        const data = normalizeRows(rows);
        if (!data.length) {
            content.innerHTML = '<div class="ug-empty">暂无增长数据</div>';
            return;
        }

        const first = data[0];
        const last = data[data.length - 1];
        const periodIncrease = data.reduce((sum, item) => sum + item.increase, 0);
        const maxIncrease = Math.max(...data.map(item => item.increase), 0);
        const minTotal = Math.min(...data.map(item => item.total));
        const maxTotal = Math.max(...data.map(item => item.total));
        const rangeTotal = maxTotal - minTotal || 1;

        // 趋势箭头
        const trendDelta = data.length > 1 ? last.total - data[0].total : 0;
        const trendUp = trendDelta >= 0;
        const trendPercent = data.length > 1 && data[0].total > 0
            ? ((trendDelta / data[0].total) * 100).toFixed(1)
            : '0';

        // 构建数据点
        const points = data.map((item, i) => {
            const barH = maxIncrease > 0 && item.increase > 0
                ? Math.max((item.increase / maxIncrease) * 100, 4)
                : 0;
            const lineY = 100 - ((item.total - minTotal) / rangeTotal * 100);
            const label = (i % 5 === 0 || i === data.length - 1) ? item.date.slice(5) : '';
            const isFirst = i === 0;
            const isLast = i === data.length - 1;
            return { item, barH, lineY, label, isFirst, isLast, index: i };
        });

        // 构建 SVG 路径
        const svgW = 100; // viewBox 百分比单位
        const step = svgW / (points.length - 1 || 1);
        const linePath = points.map((p, i) =>
            `${i === 0 ? 'M' : 'L'}${i * step},${p.lineY}`
        ).join(' ');

        // 填充路径（闭合到底部）
        const fillPath = `${linePath} L${(points.length - 1) * step},100 L0,100 Z`;

        // 背景网格
        const gridLines = [25, 50, 75].map(v =>
            `<line x1="0" y1="${v}" x2="100" y2="${v}" stroke="rgba(255,255,255,0.05)" stroke-width="0.3"/>`
        ).join('');

        // 标签行（独立于柱状图之外）
        const labelsHtml = points.map(p =>
            `<div class="ug-label" style="flex:1;min-width:0;">${escapeHtml(p.label)}</div>`
        ).join('');

        const barsHtml = points.map(p =>
            `<div class="ug-bar-col" style="flex:1;min-width:0;">
                <div class="ug-bar" style="height:${p.barH}%;" data-tooltip="${escapeHtml(p.item.date)} 总数 ${formatNumber(p.item.total)}，新增 ${formatNumber(p.item.increase)}"></div>
            </div>`
        ).join('');

        content.innerHTML = `
            <div class="ug-summary">
                <div class="ug-stat-card">
                    <div class="ug-stat-icon" style="background:linear-gradient(135deg,#00d4ff22,#00d4ff44);">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00d4ff" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    </div>
                    <div class="ug-stat-body">
                        <div class="ug-stat-label">当前总用户数</div>
                        <div class="ug-stat-value accent">${formatNumber(last.total)}</div>
                    </div>
                </div>
                <div class="ug-stat-card">
                    <div class="ug-stat-icon" style="background:linear-gradient(135deg,#00ff8822,#00ff8844);">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00ff88" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 5 5 12"/></svg>
                    </div>
                    <div class="ug-stat-body">
                        <div class="ug-stat-label">近${data.length}天新增</div>
                        <div class="ug-stat-value green">+${formatNumber(periodIncrease)}</div>
                    </div>
                </div>
                <div class="ug-stat-card">
                    <div class="ug-stat-icon" style="background:linear-gradient(135deg,${trendUp ? '#00ff8822' : '#ff475722'},${trendUp ? '#00ff8844' : '#ff475744'});">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${trendUp ? '#00ff88' : '#ff4757'}" stroke-width="2">${trendUp ? '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>' : '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'}</svg>
                    </div>
                    <div class="ug-stat-body">
                        <div class="ug-stat-label">周期增长</div>
                        <div class="ug-stat-value" style="color:${trendUp ? '#00ff88' : '#ff4757'}">${trendUp ? '+' : ''}${formatNumber(trendDelta)} (${trendUp ? '+' : ''}${trendPercent}%)</div>
                    </div>
                </div>
            </div>

            <div class="ug-chart-shell">
                <div class="ug-chart-inner">
                    <svg class="ug-svg-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
                        ${gridLines}
                        <defs>
                            <linearGradient id="ugLineGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stop-color="#00d4ff" stop-opacity="0.35"/>
                                <stop offset="100%" stop-color="#00d4ff" stop-opacity="0.02"/>
                            </linearGradient>
                        </defs>
                        <path d="${fillPath}" fill="url(#ugLineGrad)" stroke="none"/>
                        <path d="${linePath}" fill="none" stroke="#00d4ff" stroke-width="0.6" stroke-linejoin="round" stroke-linecap="round"/>
                    </svg>
                    ${barsHtml}
                    <div class="ug-crosshair" id="ugCrosshair" style="display:none;">
                        <div class="ug-crosshair-line"></div>
                        <div class="ug-crosshair-dot"></div>
                        <div class="ug-crosshair-value" id="ugCrosshairValue"></div>
                    </div>
                </div>
                <div class="ug-labels-row">${labelsHtml}</div>
            </div>
        `;

        bindCrosshair();
    }

    function animateBars() {
        const bars = document.querySelectorAll('.ug-bar');
        bars.forEach((bar, i) => {
            const target = bar.style.height;
            bar.style.height = '0';
            bar.style.transition = 'none';
            setTimeout(() => {
                bar.style.transition = `height 0.6s cubic-bezier(0.34,1.56,0.64,1) ${i * 15}ms`;
                bar.style.height = target;
            }, 50);
        });
    }

    function bindCrosshair() {
        const shell = document.querySelector('.ug-chart-inner');
        const crosshair = document.getElementById('ugCrosshair');
        const valueEl = document.getElementById('ugCrosshairValue');
        if (!shell || !crosshair) return;
        const cols = shell.querySelectorAll('.ug-bar-col');
        cols.forEach((col, i) => {
            const bar = col.querySelector('.ug-bar');
            const tooltip = bar ? bar.dataset.tooltip : '';
            col.addEventListener('mouseenter', () => {
                const rect = col.getBoundingClientRect();
                const shellRect = shell.getBoundingClientRect();
                const cx = rect.left + rect.width / 2 - shellRect.left;
                crosshair.style.left = cx + 'px';
                crosshair.style.display = 'flex';
                if (valueEl && tooltip) {
                    valueEl.textContent = tooltip;
                    valueEl.style.display = 'block';
                }
            });
            col.addEventListener('mouseleave', () => {
                crosshair.style.display = 'none';
                if (valueEl) valueEl.style.display = 'none';
            });
        });
    }

    function bindBarTooltips() {
        const chart = document.querySelector('.ug-chart-inner');
        if (!chart) return;
        chart.querySelectorAll('.ug-bar').forEach(bar => {
            const tooltipText = bar.dataset.tooltip;
            if (!tooltipText) return;
            const tooltip = document.createElement('div');
            tooltip.className = 'ug-tooltip';
            tooltip.textContent = tooltipText;
            bar.appendChild(tooltip);
            bar.addEventListener('mouseenter', () => tooltip.classList.add('visible'));
            bar.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));
        });
    }

    function open() {
        const modal = ensureModal();
        render(state.stats && state.stats.user_growth);
        modal.classList.add('active');
        modal.style.display = 'flex';
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
