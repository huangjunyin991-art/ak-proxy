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
                <h3 class="ug-title">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                    ????????
                </h3>
                <div id="userGrowthContent"></div>
                <div class="modal-buttons" style="display: flex; justify-content: center; margin-top: 18px;">
                    <button class="btn" id="userGrowthCloseBtn" style="min-width: 140px; background: var(--accent); color: white;">??</button>
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
            content.innerHTML = '<div class="ug-empty">??????</div>';
            return;
        }
        const first = data[0];
        const last = data[data.length - 1];
        const periodIncrease = data.reduce((sum, item) => sum + item.increase, 0);
        const maxTotal = Math.max(...data.map(item => item.total), 1);
        const bars = data.map((item, index) => {
            const height = Math.max((item.total / maxTotal) * 100, 3);
            const label = index % 5 === 0 || index === data.length - 1 ? item.date.slice(5) : '';
            const tooltip = `${escapeHtml(item.date)} ?? ${formatNumber(item.total)}??? ${formatNumber(item.increase)}`;
            return {
                bar: `<div class="ug-bar" style="height:${height}%;" data-tip="${tooltip}"></div>`,
                label: `<div class="ug-label">${escapeHtml(label)}</div>`,
            };
        });
        content.innerHTML = `
            <div class="ug-summary">
                <div class="ug-stat">
                    <div class="ug-stat-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00d4ff" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                    </div>
                    <div>
                        <div class="ug-stat-label">??????</div>
                        <div class="ug-stat-value">${formatNumber(last.total)}</div>
                    </div>
                </div>
                <div class="ug-stat">
                    <div class="ug-stat-icon" style="background:rgba(0,255,136,0.12);">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00ff88" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 5 5 12"/></svg>
                    </div>
                    <div>
                        <div class="ug-stat-label">?${data.length}???</div>
                        <div class="ug-stat-value" style="color:#00ff88;">+${formatNumber(periodIncrease)}</div>
                    </div>
                </div>
                <div class="ug-stat">
                    <div class="ug-stat-icon" style="background:rgba(255,255,255,0.06);">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a0a0a0" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    </div>
                    <div>
                        <div class="ug-stat-label">????</div>
                        <div class="ug-stat-value" style="font-size:16px;color:var(--text-secondary);">${escapeHtml(first.date.slice(5))} - ${escapeHtml(last.date.slice(5))}</div>
                    </div>
                </div>
            </div>
            <div class="ug-chart-shell">
                <div class="ug-chart">${bars.map(item => item.bar).join('')}</div>
                <div class="ug-labels">${bars.map(item => item.label).join('')}</div>
            </div>
        `;
        bindTips();
    }

    function bindTips() {
        const chart = document.querySelector('.ug-chart');
        if (!chart) return;
        chart.querySelectorAll('.ug-bar').forEach(bar => {
            const text = bar.dataset.tip;
            if (!text) return;
            const tip = document.createElement('div');
            tip.className = 'ug-tip';
            tip.textContent = text;
            bar.appendChild(tip);
            bar.addEventListener('mouseenter', () => tip.classList.add('show'));
            bar.addEventListener('mouseleave', () => tip.classList.remove('show'));
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
