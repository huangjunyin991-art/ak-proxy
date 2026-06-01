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
                <h3 style="color: var(--accent); border-bottom: 1px solid rgba(0,212,255,0.2); padding-bottom: 12px; margin-bottom: 16px;">用户数量增长趋势</h3>
                <div id="userGrowthContent"></div>
                <div class="modal-buttons" style="display: flex; justify-content: center; margin-top: 18px;">
                    <button class="btn" id="userGrowthCloseBtn" style="min-width: 140px; background: var(--accent); color: white;">关闭</button>
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
            content.innerHTML = '<div class="user-growth-empty">暂无增长数据</div>';
            return;
        }
        const first = data[0];
        const last = data[data.length - 1];
        const periodIncrease = data.reduce((sum, item) => sum + item.increase, 0);
        const maxIncrease = Math.max(...data.map(item => item.increase), 0);
        const bars = data.map((item, index) => {
            const height = item.increase > 0 && maxIncrease > 0 ? Math.max((item.increase / maxIncrease) * 100, 4) : 0;
            const label = index % 5 === 0 || index === data.length - 1 ? item.date.slice(5) : '';
            const tooltip = `${escapeHtml(item.date)} 总数 ${formatNumber(item.total)}，新增 ${formatNumber(item.increase)}`;
            return {
                bar: `<div class="user-growth-bar" style="height:${height}%;" data-tooltip="${tooltip}"></div>`,
                label: `<div class="user-growth-label">${escapeHtml(label)}</div>`,
            };
        });
        content.innerHTML = `
            <div class="user-growth-summary">
                <div class="user-growth-summary-item">
                    <div class="user-growth-summary-label">当前总用户数</div>
                    <div class="user-growth-summary-value">${formatNumber(last.total)}</div>
                </div>
                <div class="user-growth-summary-item">
                    <div class="user-growth-summary-label">近${data.length}天新增</div>
                    <div class="user-growth-summary-value">${formatNumber(periodIncrease)}</div>
                </div>
                <div class="user-growth-summary-item">
                    <div class="user-growth-summary-label">统计区间</div>
                    <div class="user-growth-summary-value" style="font-size:16px;">${escapeHtml(first.date.slice(5))} - ${escapeHtml(last.date.slice(5))}</div>
                </div>
            </div>
            <div class="user-growth-chart-shell">
                <div class="user-growth-chart">${bars.map(item => item.bar).join('')}</div>
                <div class="user-growth-labels">${bars.map(item => item.label).join('')}</div>
            </div>
        `;
        bindBarTooltips();
    }

    function bindBarTooltips() {
        const chart = document.querySelector('.user-growth-chart');
        if (!chart) return;
        chart.querySelectorAll('.user-growth-bar').forEach(bar => {
            const tooltipText = bar.dataset.tooltip;
            if (!tooltipText) return;
            const tooltip = document.createElement('div');
            tooltip.className = 'user-growth-tooltip';
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
