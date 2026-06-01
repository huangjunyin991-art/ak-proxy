(function () {
    'use strict';

    const state = { stats: null, bound: false, period: 'daily' };

    function formatNumber(value) {
        const num = Number(value || 0);
        return window.formatNumber ? window.formatNumber(num) : num.toLocaleString('zh-CN');
    }

    function escapeHtml(value) {
        if (window.escapeHtml) return window.escapeHtml(value);
        return String(value ?? '').replace(/[&<>"']/g,
            ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function ensureModal() {
        let modal = document.getElementById('userGrowthModal');
        if (modal) {
            modal.querySelectorAll('.ug-period-btn').forEach(btn => {
                btn.addEventListener('click', () => onPeriodChange(btn.dataset.period));
            });
            return modal;
        }
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
        modal.addEventListener('click', event => { if (event.target === modal) close(); });
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

    function getPeriodLabel(period) {
        return { daily: '日', weekly: '周', monthly: '月' }[period] || '日';
    }

    function aggregateWeekly(data) {
        const map = {};
        data.forEach(d => {
            const dt = new Date(d.date);
            const year = dt.getFullYear();
            const week = getWeekNumber(dt);
            const key = `${year}-W${week}`;
            if (!map[key]) {
                map[key] = { increase: 0, total: 0, label: `${year}-W${week}`, count: 0 };
            }
            map[key].increase += d.increase;
            map[key].total = d.total;
            map[key].count++;
        });
        return Object.values(map).sort((a, b) => a.label.localeCompare(b.label));
    }

    function aggregateMonthly(data) {
        const map = {};
        data.forEach(d => {
            const key = d.date.slice(0, 7); // YYYY-MM
            if (!map[key]) {
                map[key] = { increase: 0, total: 0, label: key };
            }
            map[key].increase += d.increase;
            map[key].total = d.total;
        });
        return Object.values(map).sort((a, b) => a.label.localeCompare(b.label));
    }

    function getWeekNumber(d) {
        const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    }

    function buildChart(data) {
        const n = data.length;
        if (n === 0) return '';

        const maxInc = Math.max(...data.map(d => d.increase), 1);
        const minInc = Math.min(...data.map(d => d.increase), 0);
        const rangeInc = Math.max(maxInc - minInc, 1);

        const step = 100 / (n - 1 || 1);

        // 折线（仅新增加强显示，用底部 25%~85% 区域）
        const lineBottom = 85;
        const lineTop = 25;
        const lineRange = lineBottom - lineTop;
        const linePts = data.map((d, i) => {
            const norm = (d.increase - minInc) / rangeInc;
            const y = lineBottom - norm * lineRange;
            return { x: i * step, y };
        });

        const linePath = linePts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
        const fillPath = `${linePath} L${(n - 1) * step},${lineBottom} L0,${lineBottom} Z`;

        // 柱子
        const barsHtml = data.map((d, i) => {
            const h = d.increase > 0 ? Math.max((d.increase / maxInc) * 100, 3) : 0;
            const showLabel = i % 2 === 0 || i === n - 1;
            const label = showLabel ? getLabel(d, i, n) : '';
            const tooltip = `${escapeHtml(label || d.label || d.date)} 总数 ${formatNumber(d.total)}，新增 ${formatNumber(d.increase)}`;
            return `<div class="ug-col" data-tooltip="${tooltip}">
                <div class="ug-bar" style="height:${h}%;"></div>
                <div class="ug-label">${escapeHtml(label)}</div>
            </div>`;
        }).join('');

        return `
            <div class="ug-chart-area">
                <svg class="ug-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <defs>
                        <linearGradient id="ugFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="#00d4ff" stop-opacity="0.25"/>
                            <stop offset="100%" stop-color="#00d4ff" stop-opacity="0.02"/>
                        </linearGradient>
                    </defs>
                    <path d="${fillPath}" fill="url(#ugFill)" stroke="none"/>
                    <path d="${linePath}" fill="none" stroke="#00d4ff" stroke-width="0.7" stroke-linejoin="round" stroke-linecap="round"/>
                </svg>
                <div class="ug-bars">${barsHtml}</div>
            </div>`;
    }

    function bindTooltips() {
        const chart = document.querySelector('.ug-chart-area');
        if (!chart) return;
        chart.querySelectorAll('.ug-col').forEach(col => {
            const text = col.dataset.tooltip;
            if (!text) return;
            const tip = document.createElement('div');
            tip.className = 'ug-tooltip';
            tip.textContent = text;
            col.appendChild(tip);
            col.addEventListener('mouseenter', () => tip.classList.add('visible'));
            col.addEventListener('mouseleave', () => tip.classList.remove('visible'));
        });
    }

    function getLabel(d, i, n) {
        if (state.period === 'daily') return d.date.slice(5);
        if (state.period === 'weekly') return d.label;
        if (state.period === 'monthly') return d.label.slice(5);
        return d.date.slice(5);
    }

    function renderPeriodButtons() {
        const existing = document.querySelector('.ug-period-tabs');
        if (existing) {
            existing.querySelectorAll('.ug-period-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.period === state.period);
            });
        }
    }

    function renderFull(data) {
        const content = document.getElementById('userGrowthContent');
        if (!content) return;

        const last = data[data.length - 1];
        const first = data[0];
        const periodInc = data.reduce((s, d) => s + d.increase, 0);
        const trendDelta = data.length > 1 ? last.total - first.total : 0;
        const trendUp = trendDelta >= 0;
        const trendPct = data.length > 1 && first.total > 0
            ? ((trendDelta / first.total) * 100).toFixed(1) : '0';

        const periodTabs = ['daily', 'weekly', 'monthly'].map(p =>
            `<button class="ug-period-btn${p === state.period ? ' active' : ''}" data-period="${p}">${getPeriodLabel(p)}</button>`
        ).join('');

        content.innerHTML = `
            <div class="ug-summary">
                <div class="ug-stat-card">
                    <div class="ug-stat-icon" style="background:linear-gradient(135deg,#00d4ff22,#00d4ff44);">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00d4ff" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
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
                        <div class="ug-stat-label">本期新增</div>
                        <div class="ug-stat-value green">+${formatNumber(periodInc)}</div>
                    </div>
                </div>
                <div class="ug-stat-card">
                    <div class="ug-stat-icon" style="background:linear-gradient(135deg,${trendUp ? '#00ff8822' : '#ff475722'},${trendUp ? '#00ff8844' : '#ff475744'});">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${trendUp ? '#00ff88' : '#ff4757'}" stroke-width="2">${trendUp ? '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>' : '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'}</svg>
                    </div>
                    <div class="ug-stat-body">
                        <div class="ug-stat-label">累计增长</div>
                        <div class="ug-stat-value" style="color:${trendUp ? '#00ff88' : '#ff4757'}">${trendUp ? '+' : ''}${formatNumber(trendDelta)} (${trendUp ? '+' : ''}${trendPct}%)</div>
                    </div>
                </div>
            </div>
            <div class="ug-period-tabs">${periodTabs}</div>
            <div class="ug-chart-shell" id="ugChartShell">
                ${buildChart(data)}
            </div>
        `;

        document.querySelectorAll('.ug-period-btn').forEach(btn => {
            btn.addEventListener('click', () => onPeriodChange(btn.dataset.period));
        });
        bindTooltips();
    }

    function onPeriodChange(period) {
        state.period = period;
        renderPeriodButtons();
        const data = normalizeRows(state.stats && state.stats.user_growth);
        if (!data.length) return;

        let chartData = data;
        if (period === 'weekly') chartData = aggregateWeekly(data);
        if (period === 'monthly') chartData = aggregateMonthly(data);

        const shell = document.getElementById('ugChartShell');
        if (shell) shell.innerHTML = buildChart(chartData);
        bindTooltips();
    }

    function render() {
        const data = normalizeRows(state.stats && state.stats.user_growth);
        if (!data.length) {
            const content = document.getElementById('userGrowthContent');
            if (content) content.innerHTML = '<div class="ug-empty">暂无增长数据</div>';
            return;
        }
        let chartData = data;
        if (state.period === 'weekly') chartData = aggregateWeekly(data);
        if (state.period === 'monthly') chartData = aggregateMonthly(data);
        renderFull(chartData);
    }

    function open() {
        const modal = ensureModal();
        render();
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
        const modal = document.getElementById('userGrowthModal');
        if (modal && modal.style.display !== 'none') {
            render();
        }
    }

    window.addEventListener('admin:stats-refreshed', event => updateStats(event.detail || null));
    document.addEventListener('DOMContentLoaded', bindTrigger);
    bindTrigger();

    window.AdminUserGrowthChart = { bind: bindTrigger, updateStats, open, close };
})();
