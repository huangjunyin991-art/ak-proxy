(function() {
    'use strict';

    if (window.AKNotificationAdminPanelLoaded) return;
    window.AKNotificationAdminPanelLoaded = true;

    const API_ROOT = (typeof API_BASE === 'string' && API_BASE) ? API_BASE : window.location.origin;

    const state = {
        mounted: false,
        initialized: false,
        loadingTypes: false,
        loadingHistory: false,
        loadingAudience: false,
        sending: false,
        types: [],
        historyRows: [],
        historyTotal: 0,
        onlineRows: [],
        whitelistRows: [],
        audienceMode: 'manual',
        notificationType: 'general',
        whitelistSearch: '',
        selectedOnline: new Set(),
        selectedWhitelist: new Set(),
        accessScopeUsernames: null,
        sourceRefreshTimer: null
    };

    const refs = {};

    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    function formatTime(value) {
        if (!value) return '-';
        try {
            const date = value instanceof Date ? value : new Date(value);
            if (Number.isNaN(date.getTime())) return String(value || '-');
            return date.toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            return String(value || '-');
        }
    }

    function getHeadersSafe(extra) {
        const base = typeof getHeaders === 'function' ? getHeaders() : {};
        return Object.assign({}, base, extra || {});
    }

    function checkResponseSafe(response) {
        if (typeof checkTokenValid === 'function') {
            return checkTokenValid(response);
        }
        return !!response;
    }

    function isSubAdminRole() {
        return String(sessionStorage.getItem('admin_role') || '').trim() === 'sub_admin';
    }

    function showToastSafe(message, type) {
        if (typeof showToast === 'function') {
            showToast(message, type || 'info');
            return;
        }
        console.log('[NotificationAdminPanel]', type || 'info', message);
    }

    function isActivePanel() {
        const panel = document.querySelector('.panel.active');
        return !!panel && panel.id === 'notifications';
    }

    function ensureStyle() {
        if (document.getElementById('ak-notification-admin-style')) return;
        const style = document.createElement('style');
        style.id = 'ak-notification-admin-style';
        style.textContent = `
#notificationAdminMount {
    min-height: 480px;
}
#notificationAdminMount .ak-notify-shell {
    display: flex;
    flex-direction: column;
    gap: 16px;
}
#notificationAdminMount .ak-notify-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) minmax(300px, 0.9fr);
    gap: 16px;
}
#notificationAdminMount .ak-notify-card {
    background: linear-gradient(180deg, rgba(17, 28, 45, 0.96) 0%, rgba(10, 18, 31, 0.98) 100%);
    border: 1px solid rgba(0, 212, 255, 0.12);
    border-radius: 16px;
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.22);
    overflow: hidden;
}
#notificationAdminMount .ak-notify-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 16px 18px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
#notificationAdminMount .ak-notify-card-title {
    color: var(--text-primary);
    font-size: 16px;
    font-weight: 700;
}
#notificationAdminMount .ak-notify-card-sub {
    color: var(--text-secondary);
    font-size: 12px;
}
#notificationAdminMount .ak-notify-card-body {
    padding: 16px 18px 18px;
}
#notificationAdminMount .ak-notify-form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
}
#notificationAdminMount .ak-notify-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
#notificationAdminMount .ak-notify-field.full {
    grid-column: 1 / -1;
}
#notificationAdminMount .ak-notify-label {
    color: rgba(205, 231, 236, 0.88);
    font-size: 12px;
    font-weight: 600;
}
#notificationAdminMount .ak-notify-input,
#notificationAdminMount .ak-notify-select,
#notificationAdminMount .ak-notify-textarea {
    width: 100%;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-primary);
    padding: 10px 12px;
    font-size: 13px;
    outline: none;
}
#notificationAdminMount .ak-notify-input:focus,
#notificationAdminMount .ak-notify-select:focus,
#notificationAdminMount .ak-notify-textarea:focus {
    border-color: rgba(0, 212, 255, 0.36);
    box-shadow: 0 0 0 3px rgba(0, 212, 255, 0.12);
}
#notificationAdminMount .ak-notify-textarea {
    min-height: 92px;
    resize: vertical;
}
#notificationAdminMount .ak-notify-mode-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}
#notificationAdminMount .ak-notify-mode-btn {
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-secondary);
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
}
#notificationAdminMount .ak-notify-mode-btn.active {
    background: rgba(0, 212, 255, 0.16);
    border-color: rgba(0, 212, 255, 0.24);
    color: #dffbff;
}
#notificationAdminMount .ak-notify-audience-box {
    margin-top: 12px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.03);
    padding: 12px;
}
#notificationAdminMount .ak-notify-source-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
    flex-wrap: wrap;
}
#notificationAdminMount .ak-notify-source-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
#notificationAdminMount .ak-notify-mini-btn,
#notificationAdminMount .ak-notify-primary-btn,
#notificationAdminMount .ak-notify-secondary-btn {
    border-radius: 10px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
}
#notificationAdminMount .ak-notify-mini-btn {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-secondary);
    padding: 7px 10px;
}
#notificationAdminMount .ak-notify-primary-btn {
    border: none;
    background: linear-gradient(135deg, #00c9b7, #33d3ff);
    color: #072130;
    padding: 11px 16px;
}
#notificationAdminMount .ak-notify-primary-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
}
#notificationAdminMount .ak-notify-secondary-btn {
    border: 1px solid rgba(0, 212, 255, 0.24);
    background: rgba(0, 212, 255, 0.1);
    color: #dffbff;
    padding: 10px 14px;
}
#notificationAdminMount .ak-notify-source-list {
    max-height: 260px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
#notificationAdminMount .ak-notify-source-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.03);
}
#notificationAdminMount .ak-notify-source-item-main {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
}
#notificationAdminMount .ak-notify-source-item strong {
    color: var(--text-primary);
    font-size: 13px;
}
#notificationAdminMount .ak-notify-source-meta {
    color: var(--text-secondary);
    font-size: 11px;
}
#notificationAdminMount .ak-notify-empty {
    padding: 20px 12px;
    text-align: center;
    color: var(--text-secondary);
    font-size: 12px;
}
#notificationAdminMount .ak-notify-history-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 760px;
    overflow: auto;
}
#notificationAdminMount .ak-notify-history-item {
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.03);
}
#notificationAdminMount .ak-notify-history-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}
#notificationAdminMount .ak-notify-badge {
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    height: 20px;
    border-radius: 999px;
    font-size: 11px;
    background: rgba(0, 212, 255, 0.14);
    color: #c5f9ff;
    border: 1px solid rgba(0, 212, 255, 0.18);
}
#notificationAdminMount .ak-notify-badge.meeting {
    color: #ffe3b0;
    background: rgba(255, 168, 51, 0.14);
    border-color: rgba(255, 168, 51, 0.18);
}
#notificationAdminMount .ak-notify-history-title {
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.4;
}
#notificationAdminMount .ak-notify-history-content {
    color: rgba(224, 243, 247, 0.9);
    font-size: 12px;
    line-height: 1.6;
    margin-top: 6px;
    white-space: pre-wrap;
    word-break: break-word;
}
#notificationAdminMount .ak-notify-history-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
    color: var(--text-secondary);
    font-size: 11px;
}
#notificationAdminMount .ak-notify-actions-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 16px;
    flex-wrap: wrap;
}
#notificationAdminMount .ak-notify-status-text {
    color: var(--text-secondary);
    font-size: 12px;
}
#notificationAdminMount .ak-notify-muted {
    color: var(--text-secondary);
    font-size: 11px;
}
#notificationAdminMount .ak-notify-hidden {
    display: none !important;
}
@media (max-width: 1180px) {
    #notificationAdminMount .ak-notify-grid {
        grid-template-columns: 1fr;
    }
}
        `;
        document.head.appendChild(style);
    }

    function ensureMounted() {
        if (state.mounted) return true;
        const mount = document.getElementById('notificationAdminMount');
        if (!mount) return false;
        ensureStyle();
        mount.innerHTML = `
            <div class="ak-notify-shell">
                <div class="ak-notify-grid">
                    <section class="ak-notify-card">
                        <div class="ak-notify-card-head">
                            <div>
                                <div class="ak-notify-card-title">通知编排中心</div>
                                <div class="ak-notify-card-sub" id="akNotifyComposeMeta">准备发送通知</div>
                            </div>
                            <button type="button" class="ak-notify-secondary-btn" id="akNotifyReloadAllBtn">刷新数据</button>
                        </div>
                        <div class="ak-notify-card-body">
                            <div class="ak-notify-form-grid">
                                <div class="ak-notify-field">
                                    <span class="ak-notify-label">通知类型</span>
                                    <select class="ak-notify-select" id="akNotifyTypeSelect"></select>
                                </div>
                                <div class="ak-notify-field">
                                    <span class="ak-notify-label">目标选择方式</span>
                                    <div class="ak-notify-mode-row" id="akNotifyModeRow">
                                        <button type="button" class="ak-notify-mode-btn active" data-mode="manual">手动输入</button>
                                        <button type="button" class="ak-notify-mode-btn" data-mode="online">在线用户</button>
                                        <button type="button" class="ak-notify-mode-btn" data-mode="whitelist">白名单</button>
                                    </div>
                                </div>
                                <div class="ak-notify-field full" id="akNotifyManualWrap">
                                    <span class="ak-notify-label">用户名列表</span>
                                    <textarea class="ak-notify-textarea" id="akNotifyManualUsernames" placeholder="支持逗号、分号、换行分隔多个用户名"></textarea>
                                    <span class="ak-notify-muted">适合精确指定目标用户。</span>
                                </div>
                                <div class="ak-notify-field full ak-notify-hidden" id="akNotifyAudienceWrap">
                                    <span class="ak-notify-label" id="akNotifyAudienceLabel">候选用户</span>
                                    <div class="ak-notify-audience-box">
                                        <div class="ak-notify-source-toolbar">
                                            <div class="ak-notify-source-actions">
                                                <input type="text" class="ak-notify-input ak-notify-hidden" id="akNotifyWhitelistSearch" placeholder="搜索白名单用户">
                                                <span class="ak-notify-muted" id="akNotifyAudienceMeta">尚未加载</span>
                                            </div>
                                            <div class="ak-notify-source-actions">
                                                <button type="button" class="ak-notify-mini-btn" id="akNotifySelectAllBtn">全选</button>
                                                <button type="button" class="ak-notify-mini-btn" id="akNotifyClearSelectBtn">清空</button>
                                                <button type="button" class="ak-notify-mini-btn" id="akNotifyLoadAudienceBtn">刷新候选</button>
                                            </div>
                                        </div>
                                        <div class="ak-notify-source-list" id="akNotifyAudienceList"></div>
                                    </div>
                                </div>
                                <div class="ak-notify-field full">
                                    <span class="ak-notify-label">标题</span>
                                    <input type="text" class="ak-notify-input" id="akNotifyTitle" maxlength="120" placeholder="一般通知可只填标题；会议通知建议填写会议标题">
                                </div>
                                <div class="ak-notify-field full">
                                    <span class="ak-notify-label">内容</span>
                                    <textarea class="ak-notify-textarea" id="akNotifyContent" placeholder="通知正文"></textarea>
                                </div>
                                <div class="ak-notify-field full ak-notify-hidden" id="akNotifyMeetingWrap">
                                    <div class="ak-notify-form-grid">
                                        <div class="ak-notify-field">
                                            <span class="ak-notify-label">会议标题</span>
                                            <input type="text" class="ak-notify-input" id="akNotifyMeetingTitle" maxlength="120" placeholder="例如：周会 / 培训会">
                                        </div>
                                        <div class="ak-notify-field">
                                            <span class="ak-notify-label">开始时间</span>
                                            <input type="text" class="ak-notify-input" id="akNotifyMeetingStartTime" maxlength="64" placeholder="例如：今天 19:30">
                                        </div>
                                        <div class="ak-notify-field">
                                            <span class="ak-notify-label">会议号</span>
                                            <input type="text" class="ak-notify-input" id="akNotifyMeetingCode" maxlength="64" placeholder="腾讯会议号">
                                        </div>
                                        <div class="ak-notify-field">
                                            <span class="ak-notify-label">会议密码</span>
                                            <input type="text" class="ak-notify-input" id="akNotifyMeetingPassword" maxlength="64" placeholder="可选">
                                        </div>
                                        <div class="ak-notify-field full">
                                            <span class="ak-notify-label">网页回退地址</span>
                                            <input type="text" class="ak-notify-input" id="akNotifyMeetingWebFallback" placeholder="https://meeting.tencent.com/...">
                                        </div>
                                        <div class="ak-notify-field">
                                            <span class="ak-notify-label">桌面端拉起地址</span>
                                            <input type="text" class="ak-notify-input" id="akNotifyMeetingDesktopUrl" placeholder="wemeet://page/inmeeting?...">
                                        </div>
                                        <div class="ak-notify-field">
                                            <span class="ak-notify-label">移动端拉起地址</span>
                                            <input type="text" class="ak-notify-input" id="akNotifyMeetingMobileUrl" placeholder="wemeet://page/inmeeting?...">
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div class="ak-notify-actions-row">
                                <div class="ak-notify-status-text" id="akNotifySendStatus">未发送</div>
                                <button type="button" class="ak-notify-primary-btn" id="akNotifySendBtn">发送通知</button>
                            </div>
                        </div>
                    </section>
                    <aside class="ak-notify-card">
                        <div class="ak-notify-card-head">
                            <div>
                                <div class="ak-notify-card-title">发送历史</div>
                                <div class="ak-notify-card-sub" id="akNotifyHistoryMeta">最近 30 条活动</div>
                            </div>
                            <button type="button" class="ak-notify-mini-btn" id="akNotifyReloadHistoryBtn">刷新历史</button>
                        </div>
                        <div class="ak-notify-card-body">
                            <div class="ak-notify-history-list" id="akNotifyHistoryList"></div>
                        </div>
                    </aside>
                </div>
            </div>
        `;
        refs.typeSelect = document.getElementById('akNotifyTypeSelect');
        refs.modeRow = document.getElementById('akNotifyModeRow');
        refs.manualWrap = document.getElementById('akNotifyManualWrap');
        refs.manualUsernames = document.getElementById('akNotifyManualUsernames');
        refs.audienceWrap = document.getElementById('akNotifyAudienceWrap');
        refs.audienceLabel = document.getElementById('akNotifyAudienceLabel');
        refs.audienceMeta = document.getElementById('akNotifyAudienceMeta');
        refs.audienceList = document.getElementById('akNotifyAudienceList');
        refs.whitelistSearch = document.getElementById('akNotifyWhitelistSearch');
        refs.title = document.getElementById('akNotifyTitle');
        refs.content = document.getElementById('akNotifyContent');
        refs.meetingWrap = document.getElementById('akNotifyMeetingWrap');
        refs.meetingTitle = document.getElementById('akNotifyMeetingTitle');
        refs.meetingStartTime = document.getElementById('akNotifyMeetingStartTime');
        refs.meetingCode = document.getElementById('akNotifyMeetingCode');
        refs.meetingPassword = document.getElementById('akNotifyMeetingPassword');
        refs.meetingWebFallback = document.getElementById('akNotifyMeetingWebFallback');
        refs.meetingDesktopUrl = document.getElementById('akNotifyMeetingDesktopUrl');
        refs.meetingMobileUrl = document.getElementById('akNotifyMeetingMobileUrl');
        refs.sendStatus = document.getElementById('akNotifySendStatus');
        refs.sendBtn = document.getElementById('akNotifySendBtn');
        refs.historyList = document.getElementById('akNotifyHistoryList');
        refs.historyMeta = document.getElementById('akNotifyHistoryMeta');
        refs.composeMeta = document.getElementById('akNotifyComposeMeta');
        refs.reloadAllBtn = document.getElementById('akNotifyReloadAllBtn');
        refs.reloadHistoryBtn = document.getElementById('akNotifyReloadHistoryBtn');
        refs.selectAllBtn = document.getElementById('akNotifySelectAllBtn');
        refs.clearSelectBtn = document.getElementById('akNotifyClearSelectBtn');
        refs.loadAudienceBtn = document.getElementById('akNotifyLoadAudienceBtn');

        refs.modeRow.querySelectorAll('[data-mode]').forEach(function(button) {
            button.addEventListener('click', function() {
                setAudienceMode(button.dataset.mode || 'manual');
            });
        });
        refs.typeSelect.addEventListener('change', function() {
            state.notificationType = String(refs.typeSelect.value || 'general');
            syncFormState();
        });
        refs.whitelistSearch.addEventListener('keydown', function(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                state.whitelistSearch = String(refs.whitelistSearch.value || '').trim();
                loadAudience(true);
            }
        });
        refs.reloadAllBtn.addEventListener('click', function() {
            loadAll(true);
        });
        refs.reloadHistoryBtn.addEventListener('click', function() {
            loadHistory(true);
        });
        refs.loadAudienceBtn.addEventListener('click', function() {
            state.whitelistSearch = String(refs.whitelistSearch.value || '').trim();
            loadAudience(true);
        });
        refs.selectAllBtn.addEventListener('click', function() {
            selectAllAudience();
        });
        refs.clearSelectBtn.addEventListener('click', function() {
            clearAudienceSelection();
        });
        refs.sendBtn.addEventListener('click', function() {
            sendNotification();
        });

        state.mounted = true;
        syncFormState();
        renderAudience();
        renderHistory();
        return true;
    }

    function setAudienceMode(mode) {
        const nextMode = String(mode || 'manual').trim().toLowerCase() || 'manual';
        if (state.audienceMode === nextMode) return;
        state.audienceMode = nextMode;
        if (nextMode === 'online') state.selectedWhitelist.clear();
        if (nextMode === 'whitelist') state.selectedOnline.clear();
        syncFormState();
        renderAudience();
        loadAudience();
    }

    function getSelectedAudienceSet() {
        return state.audienceMode === 'whitelist' ? state.selectedWhitelist : state.selectedOnline;
    }

    function getCurrentAudienceRows() {
        if (state.audienceMode === 'online') return state.onlineRows;
        if (state.audienceMode === 'whitelist') return state.whitelistRows;
        return [];
    }

    function syncFormState() {
        if (!state.mounted) return;
        refs.modeRow.querySelectorAll('[data-mode]').forEach(function(button) {
            button.classList.toggle('active', button.dataset.mode === state.audienceMode);
        });
        refs.manualWrap.classList.toggle('ak-notify-hidden', state.audienceMode !== 'manual');
        refs.audienceWrap.classList.toggle('ak-notify-hidden', state.audienceMode === 'manual');
        refs.whitelistSearch.classList.toggle('ak-notify-hidden', state.audienceMode !== 'whitelist');
        refs.meetingWrap.classList.toggle('ak-notify-hidden', state.notificationType !== 'meeting');
        refs.audienceLabel.textContent = state.audienceMode === 'online' ? '在线用户候选' : '白名单候选';
        const selectedCount = getSelectedAudienceSet().size;
        if (state.audienceMode === 'manual') {
            refs.composeMeta.textContent = '通过手动输入用户名发送通知';
        } else if (state.audienceMode === 'online') {
            refs.composeMeta.textContent = `从在线用户中选择目标，当前已选 ${selectedCount} 个`;
        } else {
            refs.composeMeta.textContent = `从白名单中选择目标，当前已选 ${selectedCount} 个`;
        }
    }

    function renderTypeOptions() {
        if (!state.mounted) return;
        const rows = Array.isArray(state.types) && state.types.length
            ? state.types
            : [{ key: 'general', label: '一般通知' }, { key: 'meeting', label: '会议通知' }];
        refs.typeSelect.innerHTML = rows.map(function(item) {
            return `<option value="${escapeHtml(item.key || '')}">${escapeHtml(item.label || item.key || '')}</option>`;
        }).join('');
        if (!rows.some(function(item) { return String(item.key || '') === state.notificationType; })) {
            state.notificationType = String(rows[0] && rows[0].key || 'general');
        }
        refs.typeSelect.value = state.notificationType;
        syncFormState();
    }

    function renderAudience() {
        if (!state.mounted) return;
        const rows = getCurrentAudienceRows();
        const selected = getSelectedAudienceSet();
        const sourceName = state.audienceMode === 'online' ? '在线用户' : '白名单';
        if (state.audienceMode === 'manual') {
            refs.audienceMeta.textContent = '手动输入模式不展示候选列表';
            refs.audienceList.innerHTML = '';
            return;
        }
        refs.audienceMeta.textContent = state.loadingAudience
            ? `正在加载${sourceName}...`
            : `${sourceName} ${rows.length} 个，已选 ${selected.size} 个`;
        if (!rows.length) {
            refs.audienceList.innerHTML = `<div class="ak-notify-empty">暂无${sourceName}数据</div>`;
            return;
        }
        refs.audienceList.innerHTML = rows.map(function(row) {
            const username = String(row.username || '').trim();
            const checked = selected.has(username);
            const meta = state.audienceMode === 'online'
                ? `${row.online_time || '-'} · ${row.page || '-'}`
                : `${row.status || 'active'} · ${formatTime(row.expire_time)}`;
            return `
                <label class="ak-notify-source-item">
                    <div class="ak-notify-source-item-main">
                        <input type="checkbox" data-username="${escapeHtml(username)}" ${checked ? 'checked' : ''}>
                        <div>
                            <strong>${escapeHtml(username)}</strong>
                            <div class="ak-notify-source-meta">${escapeHtml(meta)}</div>
                        </div>
                    </div>
                    <div class="ak-notify-source-meta">${escapeHtml(String(row.nickname || row.added_by || '').trim() || (state.audienceMode === 'online' ? '在线' : '授权'))}</div>
                </label>
            `;
        }).join('');
        refs.audienceList.querySelectorAll('input[type="checkbox"]').forEach(function(input) {
            input.addEventListener('change', function() {
                const username = String(input.dataset.username || '').trim();
                if (!username) return;
                if (input.checked) {
                    selected.add(username);
                } else {
                    selected.delete(username);
                }
                syncFormState();
                renderAudience();
            });
        });
    }

    function renderHistory() {
        if (!state.mounted) return;
        refs.historyMeta.textContent = state.loadingHistory
            ? '正在加载历史...'
            : `共 ${state.historyTotal} 条，展示最近 ${state.historyRows.length} 条`;
        if (!state.historyRows.length) {
            refs.historyList.innerHTML = '<div class="ak-notify-empty">暂无通知发送记录</div>';
            return;
        }
        refs.historyList.innerHTML = state.historyRows.map(function(row) {
            const type = String(row.notification_type || '').trim().toLowerCase();
            const typeLabel = type === 'meeting' ? '会议通知' : '一般通知';
            const createdBy = String(row.created_by || '').trim() || '-';
            return `
                <article class="ak-notify-history-item">
                    <div class="ak-notify-history-head">
                        <span class="ak-notify-badge ${type === 'meeting' ? 'meeting' : ''}">${typeLabel}</span>
                        <span class="ak-notify-muted">${escapeHtml(formatTime(row.published_at || row.created_at))}</span>
                    </div>
                    <div class="ak-notify-history-title">${escapeHtml(row.title || (type === 'meeting' ? '会议通知' : '系统通知'))}</div>
                    <div class="ak-notify-history-content">${escapeHtml(row.content || '')}</div>
                    <div class="ak-notify-history-meta">
                        <span>目标 ${Number(row.target_count || 0)} 人</span>
                        <span>已读 ${Number(row.read_count || 0)}</span>
                        <span>未读 ${Number(row.unread_count || 0)}</span>
                        <span>创建者 ${escapeHtml(createdBy)}</span>
                    </div>
                </article>
            `;
        }).join('');
    }

    function selectAllAudience() {
        const selected = getSelectedAudienceSet();
        getCurrentAudienceRows().forEach(function(row) {
            const username = String(row.username || '').trim();
            if (username) selected.add(username);
        });
        syncFormState();
        renderAudience();
    }

    function clearAudienceSelection() {
        getSelectedAudienceSet().clear();
        syncFormState();
        renderAudience();
    }

    async function loadTypes(force) {
        if (state.loadingTypes && !force) return;
        state.loadingTypes = true;
        try {
            const res = await fetch(`${API_ROOT}/admin/api/notifications/types`, {
                headers: getHeadersSafe()
            });
            if (!checkResponseSafe(res)) return;
            const data = await res.json();
            state.types = Array.isArray(data.rows) ? data.rows : [];
            renderTypeOptions();
        } catch (e) {
            showToastSafe(`通知类型加载失败：${e.message || e}`, 'error');
        } finally {
            state.loadingTypes = false;
        }
    }

    async function loadHistory(force) {
        if (state.loadingHistory && !force) return;
        state.loadingHistory = true;
        renderHistory();
        try {
            const res = await fetch(`${API_ROOT}/admin/api/notifications/history?limit=30&offset=0`, {
                headers: getHeadersSafe()
            });
            if (!checkResponseSafe(res)) return;
            const data = await res.json();
            state.historyRows = Array.isArray(data.rows) ? data.rows : [];
            state.historyTotal = Number(data.total || state.historyRows.length || 0);
        } catch (e) {
            showToastSafe(`通知历史加载失败：${e.message || e}`, 'error');
        } finally {
            state.loadingHistory = false;
            renderHistory();
        }
    }

    async function loadAccessScopeUsernames(force) {
        if (!isSubAdminRole()) {
            state.accessScopeUsernames = null;
            return null;
        }
        if (state.accessScopeUsernames instanceof Set && !force) {
            return state.accessScopeUsernames;
        }
        const params = new URLSearchParams({ limit: '5000', offset: '0', status: 'active' });
        const res = await fetch(`${API_ROOT}/admin/api/whitelist?${params.toString()}`, {
            headers: getHeadersSafe()
        });
        if (!checkResponseSafe(res)) return null;
        const data = await res.json();
        const rows = Array.isArray(data.rows) ? data.rows : [];
        state.accessScopeUsernames = new Set(rows.map(function(item) {
            return String(item && item.username || '').trim();
        }).filter(Boolean));
        return state.accessScopeUsernames;
    }

    async function loadOnlineAudience(force) {
        const res = await fetch(`${API_ROOT}/admin/api/online`, {
            headers: getHeadersSafe()
        });
        if (!checkResponseSafe(res)) return;
        const data = await res.json();
        let rows = Array.isArray(data) ? data.map(function(item) {
            return {
                username: String(item.username || '').trim(),
                page: String(item.page || '').trim(),
                online_time: String(item.online_time || '').trim()
            };
        }).filter(function(item) { return item.username; }) : [];
        const accessScope = await loadAccessScopeUsernames(force);
        if (accessScope instanceof Set) {
            rows = rows.filter(function(item) {
                return accessScope.has(item.username);
            });
        }
        state.onlineRows = rows;
        const valid = new Set(state.onlineRows.map(function(item) { return item.username; }));
        state.selectedOnline.forEach(function(username) {
            if (!valid.has(username)) state.selectedOnline.delete(username);
        });
    }

    async function loadWhitelistAudience() {
        const params = new URLSearchParams({ limit: '200', offset: '0', status: 'active' });
        if (state.whitelistSearch) params.append('search', state.whitelistSearch);
        const res = await fetch(`${API_ROOT}/admin/api/whitelist?${params.toString()}`, {
            headers: getHeadersSafe()
        });
        if (!checkResponseSafe(res)) return;
        const data = await res.json();
        const rows = Array.isArray(data.rows) ? data.rows : [];
        state.whitelistRows = rows.map(function(item) {
            return {
                username: String(item.username || '').trim(),
                nickname: String(item.nickname || '').trim(),
                status: String(item.status || '').trim(),
                expire_time: item.expire_time,
                added_by: String(item.added_by || '').trim()
            };
        }).filter(function(item) { return item.username; });
        const valid = new Set(state.whitelistRows.map(function(item) { return item.username; }));
        state.selectedWhitelist.forEach(function(username) {
            if (!valid.has(username)) state.selectedWhitelist.delete(username);
        });
    }

    async function loadAudience(force) {
        if (state.audienceMode === 'manual') {
            renderAudience();
            return;
        }
        if (state.loadingAudience && !force) return;
        state.loadingAudience = true;
        renderAudience();
        try {
            if (state.audienceMode === 'online') {
                await loadOnlineAudience(force);
            } else if (state.audienceMode === 'whitelist') {
                await loadWhitelistAudience();
            }
        } catch (e) {
            showToastSafe(`候选用户加载失败：${e.message || e}`, 'error');
        } finally {
            state.loadingAudience = false;
            syncFormState();
            renderAudience();
        }
    }

    function normalizeManualUsernames() {
        const raw = String(refs.manualUsernames.value || '');
        return raw.replace(/;/g, ',').replace(/\n/g, ',').split(',').map(function(item) {
            return String(item || '').trim().toLowerCase();
        }).filter(function(item, index, list) {
            return item && list.indexOf(item) === index;
        });
    }

    function validateBeforeSend(payload) {
        const audience = payload && payload.audience && typeof payload.audience === 'object' ? payload.audience : {};
        const usernames = Array.isArray(audience.usernames) ? audience.usernames.filter(Boolean) : [];
        if (state.audienceMode === 'manual' && usernames.length === 0) {
            throw new Error('请至少填写一个目标用户名');
        }
        if ((state.audienceMode === 'online' || state.audienceMode === 'whitelist') && usernames.length === 0) {
            throw new Error('请先勾选目标用户；如果要全量发送，请先点击“全选”');
        }
    }

    function buildPayload() {
        const baseType = String(refs.typeSelect.value || state.notificationType || 'general').trim().toLowerCase();
        const meetingTitle = String(refs.meetingTitle.value || '').trim();
        const title = String(refs.title.value || '').trim() || (baseType === 'meeting' ? meetingTitle : '');
        const content = String(refs.content.value || '').trim();
        const audience = { mode: state.audienceMode };
        if (state.audienceMode === 'manual') {
            const usernames = normalizeManualUsernames();
            audience.usernames = usernames;
            audience.usernames_text = String(refs.manualUsernames.value || '').trim();
        } else if (state.audienceMode === 'online') {
            audience.usernames = Array.from(state.selectedOnline);
        } else if (state.audienceMode === 'whitelist') {
            audience.usernames = Array.from(state.selectedWhitelist);
            if (state.whitelistSearch) audience.search = state.whitelistSearch;
            audience.status = 'active';
        }
        const payload = {
            type: baseType,
            title: title,
            content: content,
            audience: audience
        };
        if (baseType === 'meeting') {
            payload.meeting = {
                meeting_title: meetingTitle,
                meeting_code: String(refs.meetingCode.value || '').trim(),
                meeting_password: String(refs.meetingPassword.value || '').trim(),
                start_time: String(refs.meetingStartTime.value || '').trim(),
                web_fallback_url: String(refs.meetingWebFallback.value || '').trim(),
                desktop_launch_url: String(refs.meetingDesktopUrl.value || '').trim(),
                mobile_launch_url: String(refs.meetingMobileUrl.value || '').trim()
            };
        }
        return payload;
    }

    async function sendNotification() {
        if (state.sending) return;
        const payload = buildPayload();
        try {
            validateBeforeSend(payload);
        } catch (e) {
            const message = String((e && e.message) || e || '发送校验失败');
            refs.sendStatus.textContent = message;
            showToastSafe(message, 'error');
            return;
        }
        state.sending = true;
        refs.sendBtn.disabled = true;
        refs.sendStatus.textContent = '发送中...';
        try {
            const res = await fetch(`${API_ROOT}/admin/api/notifications/send`, {
                method: 'POST',
                headers: getHeadersSafe({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload)
            });
            if (!checkResponseSafe(res)) return;
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.message || '通知发送失败');
            }
            refs.sendStatus.textContent = data.message || '发送成功';
            showToastSafe(data.message || '通知发送成功', 'success');
            await loadHistory(true);
        } catch (e) {
            const message = String((e && e.message) || e || '通知发送失败');
            refs.sendStatus.textContent = message;
            showToastSafe(message, 'error');
        } finally {
            state.sending = false;
            refs.sendBtn.disabled = false;
        }
    }

    async function loadAll(force) {
        if (!ensureMounted()) return;
        await loadTypes(force);
        await Promise.all([
            loadHistory(force),
            loadAudience(force)
        ]);
        state.initialized = true;
    }

    function scheduleAudienceRefresh() {
        if (state.sourceRefreshTimer) {
            clearTimeout(state.sourceRefreshTimer);
        }
        state.sourceRefreshTimer = setTimeout(function() {
            state.sourceRefreshTimer = null;
            if (isActivePanel() && state.audienceMode !== 'manual') {
                loadAudience(true);
            }
        }, 300);
    }

    function onPanelChanged(event) {
        const detail = event && event.detail && typeof event.detail === 'object' ? event.detail : {};
        const panel = String(detail.panel || '').trim();
        if (panel !== 'notifications') return;
        loadAll(false);
    }

    function onWebSocketMessage(event) {
        const data = event && event.detail && typeof event.detail === 'object' ? event.detail : {};
        if (!data.type) return;
        if (data.type === 'notification_campaign_created') {
            if (isActivePanel()) {
                loadHistory(true);
            }
            const title = data.data && data.data.title ? `：${data.data.title}` : '';
            showToastSafe(`收到新的通知投递事件${title}`, 'info');
            return;
        }
        if (data.type === 'user_online' || data.type === 'user_offline') {
            if (state.audienceMode === 'online') {
                scheduleAudienceRefresh();
            }
        }
    }

    window.addEventListener('ak-admin-panel-changed', onPanelChanged);
    window.addEventListener('ak-admin-ws-message', onWebSocketMessage);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            ensureMounted();
            if (isActivePanel()) loadAll(false);
        });
    } else {
        ensureMounted();
        if (isActivePanel()) loadAll(false);
    }

    window.AKNotificationAdminPanel = {
        reload: function() {
            return loadAll(true);
        }
    };
})();
