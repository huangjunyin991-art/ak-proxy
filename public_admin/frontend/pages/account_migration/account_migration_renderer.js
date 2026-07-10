(function() {
    if (window.AKAccountMigrationRenderer) return;

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatTime(value) {
        var text = String(value || '').trim();
        return text || '--';
    }

    function formatNumber(value) {
        var number = Number(value || 0);
        return number.toLocaleString('zh-CN');
    }

    function percentText(value) {
        var number = Number(value || 0);
        return number.toFixed(2) + '%';
    }

    function sumBackfillRows(run, key) {
        var summary = run && run.summary;
        var rows = summary && Array.isArray(summary.backfill_results) ? summary.backfill_results : [];
        return rows.reduce(function(total, item) {
            return total + Number(item && item[key] || 0);
        }, 0);
    }

    function statusMeta(status) {
        var value = String(status || '').toLowerCase();
        if (value === 'running') return { label: '运行中', tone: 'info' };
        if (value === 'succeeded') return { label: '已完成', tone: 'success' };
        if (value === 'failed') return { label: '失败', tone: 'danger' };
        if (value === 'ok') return { label: '正常', tone: 'success' };
        if (value === 'ensured') return { label: '已检查', tone: 'success' };
        if (value === 'updated') return { label: '已回填', tone: 'success' };
        if (value === 'dry_run') return { label: '演练', tone: 'warning' };
        if (value === 'missing_table') return { label: '缺表', tone: 'danger' };
        if (value === 'missing_account_id_column') return { label: '缺列', tone: 'danger' };
        if (value === 'skipped_missing_table') return { label: '跳过', tone: 'muted' };
        return { label: value || '--', tone: 'muted' };
    }

    function renderMetric(label, value, meta) {
        return '' +
            '<div class="amp-metric">' +
                '<div class="amp-metric-label">' + escapeHtml(label) + '</div>' +
                '<div class="amp-metric-value">' + escapeHtml(value) + '</div>' +
                (meta ? '<div class="amp-metric-meta">' + escapeHtml(meta) + '</div>' : '') +
            '</div>';
    }

    function renderPhasePlan(plan) {
        var items = Array.isArray(plan) ? plan : [];
        if (!items.length) {
            return '<div class="amp-empty-inline">暂无阶段计划</div>';
        }
        return items.map(function(item) {
            return '' +
                '<div class="amp-phase-card">' +
                    '<div class="amp-phase-title-row">' +
                        '<strong>' + escapeHtml(item.title || item.key || '--') + '</strong>' +
                        '<span class="amp-badge amp-badge-muted">' + escapeHtml(item.key || '--') + '</span>' +
                    '</div>' +
                    '<div class="amp-phase-desc">' + escapeHtml(item.description || '') + '</div>' +
                    '<div class="amp-phase-meta">' +
                        '<span>映射数 ' + escapeHtml(formatNumber(item.column_count || 0)) + '</span>' +
                        '<span>范围 ' + escapeHtml((item.tables || []).join(', ') || '--') + '</span>' +
                    '</div>' +
                '</div>';
        }).join('');
    }

    function renderPhaseStats(rows) {
        var items = Array.isArray(rows) ? rows : [];
        if (!items.length) {
            return '<tr><td colspan="7" class="amp-empty-row">暂无统计</td></tr>';
        }
        return items.map(function(item) {
            var meta = statusMeta(item.status);
            return '' +
                '<tr>' +
                    '<td>' + escapeHtml(item.phase || '--') + '</td>' +
                    '<td>' + escapeHtml(item.table_name || '--') + '</td>' +
                    '<td>' + escapeHtml(item.username_column || '--') + '</td>' +
                    '<td>' + escapeHtml(item.account_id_column || '--') + '</td>' +
                    '<td><span class="amp-badge amp-badge-' + escapeHtml(meta.tone) + '">' + escapeHtml(meta.label) + '</span></td>' +
                    '<td>' + escapeHtml(formatNumber(item.missing_rows || 0)) + '</td>' +
                    '<td>' + escapeHtml(percentText(item.fill_ratio || 0)) + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderAliasList(aliases) {
        var items = Array.isArray(aliases) ? aliases : [];
        if (!items.length) {
            return '<span class="amp-empty-inline">--</span>';
        }
        return items.map(function(alias) {
            return '<span class="amp-chip">' + escapeHtml(alias) + '</span>';
        }).join('');
    }

    function renderIdentityRows(payload) {
        var rows = payload && Array.isArray(payload.rows) ? payload.rows : [];
        if (!rows.length) {
            return '<tr><td colspan="5" class="amp-empty-row">暂无账号变更记录</td></tr>';
        }
        return rows.map(function(item) {
            return '' +
                '<tr>' +
                    '<td>' + escapeHtml(item.canonical_username || '--') + '</td>' +
                    '<td>' + escapeHtml(formatNumber(item.account_id || 0)) + '</td>' +
                    '<td>' + renderAliasList(item.aliases) + '</td>' +
                    '<td>' + escapeHtml(formatNumber(item.alias_count || 0)) + '</td>' +
                    '<td>' + escapeHtml(formatTime(item.last_renamed_at || item.updated_at)) + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderRunRows(rows) {
        var items = Array.isArray(rows) ? rows : [];
        if (!items.length) {
            return '<tr><td colspan="7" class="amp-empty-row">暂无同步记录</td></tr>';
        }
        return items.map(function(item) {
            var meta = statusMeta(item.status);
            return '' +
                '<tr>' +
                    '<td>#' + escapeHtml(String(item.id || '--')) + '</td>' +
                    '<td>' + escapeHtml(item.trigger_mode || '--') + '</td>' +
                    '<td>' + escapeHtml(item.triggered_by || '--') + '</td>' +
                    '<td><span class="amp-badge amp-badge-' + escapeHtml(meta.tone) + '">' + escapeHtml(meta.label) + '</span></td>' +
                    '<td>' + escapeHtml(formatNumber(sumBackfillRows(item, 'matched_rows'))) + '</td>' +
                    '<td>' + escapeHtml(formatNumber(sumBackfillRows(item, 'updated_rows'))) + '</td>' +
                    '<td>' + escapeHtml(formatTime(item.started_at)) + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderCurrentRun(run) {
        if (!run) {
            return '<div class="amp-empty-inline">当前无运行中的同步任务</div>';
        }
        var meta = statusMeta(run.status);
        return '' +
            '<div class="amp-current-run">' +
                '<div class="amp-current-run-row">' +
                    '<strong>任务 #' + escapeHtml(String(run.id || '--')) + '</strong>' +
                    '<span class="amp-badge amp-badge-' + escapeHtml(meta.tone) + '">' + escapeHtml(meta.label) + '</span>' +
                '</div>' +
                '<div class="amp-current-run-grid">' +
                    '<span>阶段：' + escapeHtml(run.phase_key || 'all') + '</span>' +
                    '<span>模式：' + escapeHtml(run.trigger_mode || '--') + '</span>' +
                    '<span>状态：' + escapeHtml(run.stage || '--') + '</span>' +
                    '<span>开始：' + escapeHtml(formatTime(run.started_at)) + '</span>' +
                '</div>' +
                (run.error_message ? '<div class="amp-run-error">' + escapeHtml(run.error_message) + '</div>' : '') +
            '</div>';
    }

    function render(state) {
        var dashboard = state && state.dashboard ? state.dashboard : {};
        var summary = dashboard.identity_summary || {};
        var policy = state && state.policyDraft ? state.policyDraft : {};
        var currentRun = dashboard.current_run || (dashboard.scheduler && dashboard.scheduler.current_run) || null;
        var syncing = !!(state && (state.startingSync || (currentRun && String(currentRun.status || '').toLowerCase() === 'running')));

        return '' +
            '<div class="amp-root">' +
                '<section class="amp-toolbar">' +
                    '<div>' +
                        '<div class="amp-title">账号迁移</div>' +
                        '<div class="amp-subtitle">最近刷新 ' + escapeHtml(state && state.lastRefreshedAt || '--') + '</div>' +
                    '</div>' +
                    '<div class="amp-actions">' +
                        '<button type="button" class="amp-button amp-button-secondary" data-action="refresh">刷新</button>' +
                        '<button type="button" class="amp-button amp-button-primary" data-action="start-sync"' + (syncing ? ' disabled' : '') + '>' + (syncing ? '同步中...' : '立即全量同步') + '</button>' +
                    '</div>' +
                '</section>' +

                (state && state.error ? '<div class="amp-alert amp-alert-danger">' + escapeHtml(state.error) + '</div>' : '') +

                '<section class="amp-metrics">' +
                    renderMetric('身份总数', formatNumber(summary.total_identities || 0), '主账号标识') +
                    renderMetric('别名总数', formatNumber(summary.total_aliases || 0), '历史账号轨迹') +
                    renderMetric('有变更账号', formatNumber(summary.changed_identities || 0), formatTime(summary.last_renamed_at)) +
                    renderMetric('下次自动同步', dashboard.next_auto_run_at || '--', policy.enabled ? '已启用' : '未启用') +
                    renderMetric('当前任务', currentRun ? (currentRun.stage || 'running') : '空闲', currentRun ? (currentRun.trigger_mode || '--') : '--') +
                '</section>' +

                '<section class="amp-layout">' +
                    '<div class="amp-section">' +
                        '<div class="amp-section-head">' +
                            '<h3>自动同步</h3>' +
                            '<span class="amp-section-meta">' + escapeHtml(policy.enabled ? '已启用' : '未启用') + '</span>' +
                        '</div>' +
                        '<div class="amp-form-grid">' +
                            '<label class="amp-toggle-row">' +
                                '<input type="checkbox" class="amp-checkbox" data-field="enabled"' + (policy.enabled ? ' checked' : '') + '>' +
                                '<span>启用每日自动同步</span>' +
                            '</label>' +
                            '<label class="amp-field">' +
                                '<span>执行时间</span>' +
                                '<input type="time" class="amp-input" data-field="daily_time" value="' + escapeHtml(policy.daily_time || '03:30') + '">' +
                            '</label>' +
                            '<label class="amp-field">' +
                                '<span>单表限额</span>' +
                                '<input type="number" min="0" step="1" class="amp-input" data-field="limit_per_spec" value="' + escapeHtml(String(policy.limit_per_spec || 0)) + '">' +
                            '</label>' +
                        '</div>' +
                        '<div class="amp-form-actions">' +
                            '<button type="button" class="amp-button amp-button-secondary" data-action="save-policy"' + (state && state.savingPolicy ? ' disabled' : '') + '>' + (state && state.savingPolicy ? '保存中...' : '保存配置') + '</button>' +
                        '</div>' +
                    '</div>' +

                    '<div class="amp-section">' +
                        '<div class="amp-section-head">' +
                            '<h3>运行状态</h3>' +
                            '<span class="amp-section-meta">' + escapeHtml((dashboard.scheduler && dashboard.scheduler.last_auto_trigger_at) || '--') + '</span>' +
                        '</div>' +
                        renderCurrentRun(currentRun) +
                        '<div class="amp-phase-list">' + renderPhasePlan(dashboard.phase_plan) + '</div>' +
                    '</div>' +
                '</section>' +

                '<section class="amp-section">' +
                    '<div class="amp-section-head">' +
                        '<h3>迁移覆盖率</h3>' +
                        '<span class="amp-section-meta">' + escapeHtml(formatNumber((dashboard.phase_stats || []).length)) + ' 项</span>' +
                    '</div>' +
                    '<div class="amp-table-wrap">' +
                        '<table class="amp-table">' +
                            '<thead><tr><th>阶段</th><th>表</th><th>账号列</th><th>ID 列</th><th>状态</th><th>待补</th><th>覆盖率</th></tr></thead>' +
                            '<tbody>' + renderPhaseStats(dashboard.phase_stats) + '</tbody>' +
                        '</table>' +
                    '</div>' +
                '</section>' +

                '<section class="amp-section">' +
                    '<div class="amp-section-head amp-section-head-search">' +
                        '<h3>账号变更</h3>' +
                        '<div class="amp-inline-actions">' +
                            '<input type="search" id="accountMigrationSearchInput" class="amp-input amp-search-input" placeholder="搜索账号或别名" value="' + escapeHtml(state && state.searchInput || '') + '">' +
                            '<button type="button" class="amp-button amp-button-secondary" data-action="search">搜索</button>' +
                            '<button type="button" class="amp-button amp-button-ghost" data-action="clear-search">清空</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="amp-table-wrap">' +
                        '<table class="amp-table">' +
                            '<thead><tr><th>当前账号</th><th>身份 ID</th><th>账号轨迹</th><th>别名数</th><th>最近变更</th></tr></thead>' +
                            '<tbody>' + renderIdentityRows(dashboard.identities) + '</tbody>' +
                        '</table>' +
                    '</div>' +
                '</section>' +

                '<section class="amp-section">' +
                    '<div class="amp-section-head">' +
                        '<h3>最近同步</h3>' +
                        '<span class="amp-section-meta">' + escapeHtml(formatNumber((dashboard.recent_runs || []).length)) + ' 条</span>' +
                    '</div>' +
                    '<div class="amp-table-wrap">' +
                        '<table class="amp-table">' +
                            '<thead><tr><th>任务</th><th>触发</th><th>执行者</th><th>状态</th><th>匹配</th><th>更新</th><th>开始时间</th></tr></thead>' +
                            '<tbody>' + renderRunRows(dashboard.recent_runs) + '</tbody>' +
                        '</table>' +
                    '</div>' +
                '</section>' +
            '</div>';
    }

    window.AKAccountMigrationRenderer = {
        render: render
    };
})();
