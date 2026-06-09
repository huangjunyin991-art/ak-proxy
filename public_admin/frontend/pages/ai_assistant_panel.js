(function(global) {
    'use strict';

    const API_BASE = '';
    const FEATURE_KEYS = ['ai_chat', 'polish_translate', 'chat_summary', 'semantic_search', 'search_summary'];
    const FEATURE_LABELS = {
        ai_chat: 'AI 聊天',
        polish_translate: '润色翻译',
        chat_summary: '聊天总结',
        semantic_search: '语义搜索',
        search_summary: '搜索总结'
    };
    const TIER_LABELS = {
        trial: '试用',
        basic: '普通',
        advanced: '进阶',
        honor: '荣耀',
        supreme: '至尊'
    };

    const state = {
        loaded: false,
        loading: false,
        config: null,
        diagnostics: null,
        providers: [],
        billingConfig: null,
        billingOverview: null,
        fluapiStatus: null,
        tiers: [],
        redeemCodes: [],
        generatedCodes: [],
        selectedProviderId: 0,
        error: ''
    };

    function headers(extra) {
        return Object.assign({
            'Authorization': 'Bearer ' + (sessionStorage.getItem('admin_token') || ''),
            'Content-Type': 'application/json'
        }, extra || {});
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] || ch;
        });
    }

    function showToast(message, type) {
        if (typeof global.showToast === 'function') {
            global.showToast(message, type);
            return;
        }
        if (type === 'error') console.error(message);
        else console.log(message);
    }

    async function api(path, options) {
        const res = await fetch(API_BASE + path, Object.assign({
            credentials: 'same-origin',
            headers: headers()
        }, options || {}));
        const text = await res.text();
        let data = {};
        if (text.trim()) {
            try {
                data = JSON.parse(text);
            } catch (e) {
                data = { error: true, message: text.slice(0, 300) };
            }
        }
        if (!res.ok || data.error) {
            throw new Error(data.message || ('请求失败：' + res.status));
        }
        return data;
    }

    function unwrapItem(data, fallback) {
        if (data && Object.prototype.hasOwnProperty.call(data, 'item')) return data.item;
        return data == null ? fallback : data;
    }

    function unwrapItems(data) {
        const item = unwrapItem(data, null);
        if (Array.isArray(item)) return item;
        if (Array.isArray(data && data.items)) return data.items;
        return [];
    }

    function fmtTime(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value).replace('T', ' ').slice(0, 16);
        return date.toLocaleString('zh-CN', { hour12: false });
    }

    function fmtNumber(value, digits) {
        const num = Number(value || 0);
        if (!Number.isFinite(num)) return '0';
        return num.toLocaleString('zh-CN', {
            minimumFractionDigits: Number(digits || 0),
            maximumFractionDigits: Number(digits || 0)
        });
    }

    function fmtUSD(value) {
        return '$' + fmtNumber(value, 2);
    }

    function providerById(id) {
        const target = Number(id || 0);
        return state.providers.find(function(item) {
            return Number(item && item.id || 0) === target;
        }) || null;
    }

    function selectedProvider() {
        if (Number(state.selectedProviderId || 0) <= 0) return null;
        return providerById(state.selectedProviderId) || state.providers[0] || null;
    }

    function mount() {
        return document.getElementById('aiAssistantPanelMount');
    }

    function injectStyle() {
        if (document.getElementById('ak-ai-admin-style')) return;
        const style = document.createElement('style');
        style.id = 'ak-ai-admin-style';
        style.textContent = `
            #aiAssistant .ai-admin-shell{display:flex;flex-direction:column;gap:16px}
            #aiAssistant .ai-admin-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:18px;border:1px solid rgba(0,212,255,.18);border-radius:14px;background:linear-gradient(135deg,rgba(0,212,255,.10),rgba(0,255,136,.07))}
            #aiAssistant .ai-admin-title{font-size:20px;font-weight:800;color:var(--text-primary);margin-bottom:6px}
            #aiAssistant .ai-admin-sub{font-size:13px;color:var(--text-secondary);line-height:1.7}
            #aiAssistant .ai-admin-diagnostics{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}
            #aiAssistant .ai-admin-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(340px,.9fr);gap:16px}
            #aiAssistant .ai-card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px;min-width:0}
            #aiAssistant .ai-card-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;color:var(--accent);font-size:15px;font-weight:800}
            #aiAssistant .ai-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
            #aiAssistant .ai-field{display:flex;flex-direction:column;gap:6px;min-width:0}
            #aiAssistant .ai-field label{font-size:12px;color:var(--text-secondary)}
            #aiAssistant .ai-input,#aiAssistant .ai-select{height:38px;border:1px solid var(--border);border-radius:9px;background:var(--bg-primary);color:var(--text-primary);padding:0 10px;outline:none}
            #aiAssistant .ai-input:focus,#aiAssistant .ai-select:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(0,212,255,.12)}
            #aiAssistant .ai-switch-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
            #aiAssistant .ai-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}
            #aiAssistant .ai-btn{height:36px;border:0;border-radius:9px;padding:0 13px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-weight:700}
            #aiAssistant .ai-btn.primary{background:linear-gradient(135deg,var(--accent),#008ed0);color:#fff}
            #aiAssistant .ai-btn.success{background:linear-gradient(135deg,#00ff88,#00b96b);color:#052d1b}
            #aiAssistant .ai-btn.warn{background:linear-gradient(135deg,#ffa502,#e67e22);color:#1f1300}
            #aiAssistant .ai-provider-list{display:flex;flex-direction:column;gap:8px;max-height:360px;overflow:auto}
            #aiAssistant .ai-provider-item{border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.03);padding:11px;cursor:pointer}
            #aiAssistant .ai-provider-item.active{border-color:var(--accent);box-shadow:0 0 0 1px rgba(0,212,255,.16) inset;background:rgba(0,212,255,.06)}
            #aiAssistant .ai-provider-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
            #aiAssistant .ai-provider-name{font-weight:800;color:var(--text-primary)}
            #aiAssistant .ai-tag{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:999px;background:rgba(255,255,255,.07);font-size:12px;color:var(--text-secondary)}
            #aiAssistant .ai-tag.ok{background:rgba(0,255,136,.12);color:var(--accent-green)}
            #aiAssistant .ai-tag.bad{background:rgba(255,71,87,.12);color:var(--accent-red)}
            #aiAssistant .ai-tag.warn{background:rgba(255,165,2,.14);color:#ffa502}
            #aiAssistant .ai-meta{font-size:12px;color:var(--text-secondary);line-height:1.6;word-break:break-all}
            #aiAssistant .ai-table{width:100%;border-collapse:collapse}
            #aiAssistant .ai-table th,#aiAssistant .ai-table td{padding:9px 8px;border-bottom:1px solid var(--border);text-align:left;font-size:12px;vertical-align:middle}
            #aiAssistant .ai-table th{color:var(--text-secondary);font-weight:700}
            #aiAssistant .ai-table input:not([type="checkbox"]){width:100%;height:32px;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary);color:var(--text-primary);padding:0 8px}
            #aiAssistant .ai-feature-list{display:flex;flex-wrap:wrap;gap:6px}
            #aiAssistant .ai-check{position:relative;display:inline-flex;align-items:center;min-height:28px;cursor:pointer;user-select:none}
            #aiAssistant .ai-check input{position:absolute;opacity:0;pointer-events:none}
            #aiAssistant .ai-check span{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:0 10px;border:1px solid var(--border);border-radius:999px;background:rgba(255,255,255,.035);color:var(--text-secondary);font-size:12px;font-weight:700;transition:background .16s ease,border-color .16s ease,color .16s ease,box-shadow .16s ease}
            #aiAssistant .ai-check input:checked + span{border-color:rgba(0,255,136,.55);background:rgba(0,255,136,.14);color:var(--accent-green);box-shadow:0 0 0 1px rgba(0,255,136,.10) inset}
            #aiAssistant .ai-check input:focus-visible + span{box-shadow:0 0 0 3px rgba(0,212,255,.18)}
            #aiAssistant .ai-check.small span{min-height:24px;padding:0 8px;font-size:11px}
            #aiAssistant .ai-feature-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary)}
            #aiAssistant .ai-code-box{margin-top:10px;border:1px dashed rgba(0,212,255,.35);border-radius:10px;padding:10px;background:rgba(0,212,255,.05);font-size:12px;color:var(--text-primary);line-height:1.8;word-break:break-all}
            #aiAssistant .ai-stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}
            #aiAssistant .ai-stat{border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.035);padding:10px;min-width:0}
            #aiAssistant .ai-stat-label{font-size:12px;color:var(--text-secondary);margin-bottom:5px}
            #aiAssistant .ai-stat-value{font-size:18px;font-weight:800;color:var(--text-primary);font-variant-numeric:tabular-nums}
            #aiAssistant .ai-secret-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;margin-top:10px}
            #aiAssistant .ai-secret-row.provider{grid-template-columns:minmax(0,1fr) auto}
            #aiAssistant .ai-empty{padding:26px;text-align:center;color:var(--text-secondary)}
            @media (max-width: 1100px){#aiAssistant .ai-admin-grid{grid-template-columns:1fr}#aiAssistant .ai-form-grid{grid-template-columns:1fr}#aiAssistant .ai-stat-grid{grid-template-columns:1fr}#aiAssistant .ai-secret-row,#aiAssistant .ai-secret-row.provider{grid-template-columns:1fr}}
        `;
        document.head.appendChild(style);
    }

    function renderProviderList() {
        if (!state.providers.length) {
            return '<div class="ai-empty">还没有配置中转站，先在右侧新增一个 Provider。</div>';
        }
        return state.providers.map(function(item) {
            const active = Number(item.id || 0) === Number(state.selectedProviderId || 0);
            return `
                <div class="ai-provider-item ${active ? 'active' : ''}" data-action="select-provider" data-id="${Number(item.id || 0)}">
                    <div class="ai-provider-head">
                        <div class="ai-provider-name">${escapeHtml(item.provider_name || 'OpenAI-Compatible Relay')}</div>
                        <span class="ai-tag ${item.enabled ? 'ok' : 'bad'}">${item.enabled ? '启用' : '停用'}</span>
                    </div>
                    <div class="ai-meta">${escapeHtml(item.base_url || '-')}</div>
                    <div class="ai-meta">模型：${escapeHtml(item.chat_model || '-')} · 密钥：${escapeHtml(item.secret_fingerprint || '未导入')}</div>
                    <div class="ai-meta">最近测试：${escapeHtml(item.last_test_status || '-')} · 最近使用：${escapeHtml(fmtTime(item.last_used_at))}</div>
                </div>
            `;
        }).join('');
    }

    function renderModelInput(id, label, value, models, placeholder) {
        const listId = id + 'Options';
        const options = (models || []).map(function(model) {
            return '<option value="' + escapeHtml(model) + '"></option>';
        }).join('');
        return `
            <div class="ai-field">
                <label>${escapeHtml(label)}</label>
                <input class="ai-input" id="${escapeHtml(id)}" list="${escapeHtml(listId)}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder || '导入 API Key 后刷新模型')}">
                <datalist id="${escapeHtml(listId)}">${options}</datalist>
            </div>
        `;
    }

    function renderProviderForm() {
        const item = selectedProvider() || {};
        const id = Number(item.id || 0);
        const providerEnabled = id ? !!item.enabled : true;
        const models = Array.isArray(item.available_models) ? item.available_models : [];
        return `
            <div class="ai-card">
                <div class="ai-card-title">
                    <span>中转站 Provider</span>
                    <span class="ai-tag">${id ? '#' + id : '新增'}</span>
                </div>
                <div class="ai-form-grid">
                    <div class="ai-field"><label>名称</label><input class="ai-input" id="aiProviderName" value="${escapeHtml(item.provider_name || 'OpenAI-Compatible Relay')}"></div>
                    <div class="ai-field"><label>Base URL</label><input class="ai-input" id="aiProviderBaseUrl" placeholder="https://new.fluapi.com/v1" value="${escapeHtml(item.base_url || '')}"></div>
                    ${renderModelInput('aiProviderChatModel', '聊天模型', item.chat_model || '', models, '先导入 API Key 获取模型')}
                    ${renderModelInput('aiProviderSummaryModel', '摘要模型', item.summary_model || item.chat_model || '', models, '可与聊天模型相同')}
                    ${renderModelInput('aiProviderEmbeddingModel', 'Embedding 模型', item.embedding_model || '', models, '需要语义搜索时选择')}
                    <div class="ai-field"><label>余额接口</label><input class="ai-input" id="aiProviderBalanceEndpoint" placeholder="/v1/dashboard/billing/credit_grants" value="${escapeHtml(item.balance_endpoint || '')}"></div>
                    <div class="ai-field"><label>余额缓存秒</label><input class="ai-input" id="aiProviderBalanceTtl" type="number" min="30" value="${Number(item.balance_cache_ttl_seconds || 600)}"></div>
                    <div class="ai-field"><label>低余额阈值</label><input class="ai-input" id="aiProviderLowBalance" type="number" min="0" step="0.01" value="${Number(item.low_balance_threshold || 0)}"></div>
                </div>
                <div class="ai-actions">
                    <label class="ai-check"><input type="checkbox" id="aiProviderEnabled" ${providerEnabled ? 'checked' : ''}><span>启用 Provider</span></label>
                    <label class="ai-check"><input type="checkbox" id="aiProviderBalanceSupported" ${item.balance_supported ? 'checked' : ''}><span>支持余额查询</span></label>
                </div>
                <div class="ai-actions">
                    <button class="ai-btn primary" data-action="save-provider">${id ? '保存 Provider' : '新增 Provider'}</button>
                    <button class="ai-btn" data-action="new-provider">清空新增</button>
                    ${id ? '<button class="ai-btn" data-action="refresh-provider-models">刷新模型</button><button class="ai-btn" data-action="refresh-balance">刷新余额</button>' : ''}
                </div>
                <div class="ai-secret-row provider">
                    <input class="ai-input" id="aiProviderSecret" type="password" placeholder="中转站 API Key / sk 密钥，保存后只显示指纹">
                    <button class="ai-btn success" data-action="save-secret">${id ? '导入 API Key' : '新增并导入 API Key'}</button>
                </div>
                ${id ? '<div class="ai-secret-row provider"><input class="ai-input" id="aiProviderTestPrompt" value="请用一句话回复：AI 通道可用" placeholder="测试 prompt"><button class="ai-btn warn" data-action="test-provider">测试模型回复</button></div>' : ''}
                <div class="ai-meta">Base URL 填中转站 OpenAI-compatible 地址，例如 https://new.fluapi.com/v1；API Key 填中转站控制台生成的 sk。</div>
                <div class="ai-meta">模型列表来自 Provider 的 /v1/models，共 ${models.length} 个；如果中转站禁用了模型接口，也可以手动填写模型名。</div>
                <div class="ai-meta" id="aiProviderBalanceInfo">${id ? '余额信息刷新后显示在这里。' : '新增 Provider 后可测试连接和刷新余额。'}</div>
            </div>
        `;
    }

    function renderConfig() {
        const cfg = state.config || { enabled: true, context_summary_min_count: 70, context_recent_keep_count: 30 };
        return `
            <div class="ai-card">
                <div class="ai-card-title"><span>运行策略</span><span class="ai-tag ${cfg.enabled ? 'ok' : 'bad'}">${cfg.enabled ? '已开启' : '已关闭'}</span></div>
                <div class="ai-form-grid">
                    <div class="ai-field">
                        <label>AI 助手开关</label>
                        <select class="ai-select" id="aiConfigEnabled">
                            <option value="true" ${cfg.enabled ? 'selected' : ''}>开启</option>
                            <option value="false" ${!cfg.enabled ? 'selected' : ''}>关闭</option>
                        </select>
                    </div>
                    <div class="ai-field"><label>多少条后压缩上下文</label><input class="ai-input" id="aiConfigSummaryMin" type="number" min="20" value="${Number(cfg.context_summary_min_count || 70)}"></div>
                    <div class="ai-field"><label>保留最近原文条数</label><input class="ai-input" id="aiConfigRecentKeep" type="number" min="12" max="80" value="${Number(cfg.context_recent_keep_count || 30)}"></div>
                </div>
                <div class="ai-actions"><button class="ai-btn primary" data-action="save-config">保存运行策略</button></div>
                <div class="ai-meta">压缩任务在 AI 回复成功后异步执行，不阻塞用户聊天。</div>
            </div>
        `;
    }

    function renderFluAPI() {
        const status = state.fluapiStatus || {};
        const cfg = status.config || {};
        const balance = status.latest_balance || null;
        return `
            <div class="ai-card">
                <div class="ai-card-title">
                    <span>中转站账号与上游余额</span>
                    <span class="ai-tag ${cfg.enabled ? 'ok' : 'bad'}">${cfg.enabled ? '已启用' : '未启用'}</span>
                </div>
                <div class="ai-stat-grid">
                    <div class="ai-stat"><div class="ai-stat-label">剩余额度</div><div class="ai-stat-value">${balance ? fmtUSD(balance.balance_usd) : '-'}</div></div>
                    <div class="ai-stat"><div class="ai-stat-label">已用额度</div><div class="ai-stat-value">${balance ? fmtUSD(balance.used_usd) : '-'}</div></div>
                    <div class="ai-stat"><div class="ai-stat-label">总额度</div><div class="ai-stat-value">${balance ? fmtUSD(balance.total_usd) : '-'}</div></div>
                </div>
                <div class="ai-form-grid">
                    <div class="ai-field">
                        <label>同步开关</label>
                        <select class="ai-select" id="aiFluapiEnabled">
                            <option value="true" ${cfg.enabled ? 'selected' : ''}>启用</option>
                            <option value="false" ${!cfg.enabled ? 'selected' : ''}>关闭</option>
                        </select>
                    </div>
                    <div class="ai-field"><label>Base URL</label><input class="ai-input" id="aiFluapiBaseUrl" value="${escapeHtml(cfg.base_url || 'https://www.fluapi.com')}"></div>
                    <div class="ai-field"><label>控制台账号</label><input class="ai-input" id="aiFluapiUsername" value="${escapeHtml(cfg.username || '')}" placeholder="FluAPI 登录账号"></div>
                    <div class="ai-field"><label>New-Api-User</label><input class="ai-input" id="aiFluapiUserId" value="${escapeHtml(cfg.user_id || '')}" placeholder="登录后自动获取"></div>
                    <div class="ai-field"><label>1 USD 对应 quota</label><input class="ai-input" id="aiFluapiQuotaPerUsd" type="number" min="1" value="${Number(cfg.quota_per_usd || 500000)}"></div>
                    <div class="ai-field"><label>低余额告警 USD</label><input class="ai-input" id="aiFluapiLowBalance" type="number" min="0" step="0.01" value="${Number(cfg.low_balance_usd || 10)}"></div>
                </div>
                <div class="ai-secret-row">
                    <input class="ai-input" id="aiFluapiCredentialUsername" value="${escapeHtml(cfg.username || '')}" placeholder="中转站控制台账号">
                    <input class="ai-input" id="aiFluapiPassword" type="password" placeholder="${cfg.has_password ? '已保存密码，留空则不更新' : '中转站控制台密码'}">
                    <button class="ai-btn success" data-action="save-fluapi-credentials">导入并登录</button>
                </div>
                <div class="ai-actions">
                    <button class="ai-btn primary" data-action="save-fluapi-config">保存上游配置</button>
                    <button class="ai-btn" data-action="fluapi-login">重新登录</button>
                    <button class="ai-btn warn" data-action="fluapi-sync">同步余额</button>
                </div>
                <div class="ai-meta">状态：密码 ${cfg.has_password ? '已加密保存' : '未保存'} · session ${cfg.has_session ? '已保存' : '未保存'} · 最近登录 ${escapeHtml(fmtTime(cfg.last_login_at))} · 最近同步 ${escapeHtml(fmtTime(cfg.last_sync_at))}</div>
                <div class="ai-meta">这里用于登录中转站控制台同步余额；实际模型调用使用下方 Provider 的 Base URL 和 API Key。</div>
                ${cfg.last_error ? '<div class="ai-meta" style="color:var(--accent-red);">最近错误：' + escapeHtml(cfg.last_error) + '</div>' : ''}
            </div>
        `;
    }

    function renderBilling() {
        const overview = state.billingOverview || {};
        const cfg = state.billingConfig || overview.config || {};
        const tierCredits = cfg.tier_monthly_credit_units || {};
        const tierOrder = ['trial', 'basic', 'advanced', 'honor', 'supreme'];
        const rows = tierOrder.map(function(tier) {
            return `
                <tr>
                    <td>${escapeHtml(TIER_LABELS[tier] || tier)}<div class="ai-meta">${escapeHtml(tier)}</div></td>
                    <td><input data-billing-tier="${escapeHtml(tier)}" type="number" min="0" value="${Number(tierCredits[tier] || 0)}"></td>
                </tr>
            `;
        }).join('');
        const ledgerRows = (overview.recent_ledger || []).slice(0, 8).map(function(item) {
            return `
                <tr>
                    <td>${escapeHtml(item.username || '-')}</td>
                    <td>${escapeHtml(item.model || '-')}</td>
                    <td>${Number(item.total_tokens || item.estimated_tokens || 0)}</td>
                    <td>${Number(item.user_charge_units || 0)} ${escapeHtml(cfg.unit_label || 'AI额度')}</td>
                    <td>${escapeHtml(fmtTime(item.settled_at || item.created_at))}</td>
                </tr>
            `;
        }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);">暂无扣费流水</td></tr>';
        return `
            <div class="ai-card">
                <div class="ai-card-title">
                    <span>计费策略</span>
                    <span class="ai-tag ${cfg.enabled !== false ? 'ok' : 'bad'}">${cfg.enabled !== false ? '已启用' : '已关闭'}</span>
                </div>
                <div class="ai-stat-grid">
                    <div class="ai-stat"><div class="ai-stat-label">今日消耗</div><div class="ai-stat-value">${fmtNumber(overview.today_units || 0, 0)}</div></div>
                    <div class="ai-stat"><div class="ai-stat-label">本月消耗</div><div class="ai-stat-value">${fmtNumber(overview.month_units || 0, 0)}</div></div>
                    <div class="ai-stat"><div class="ai-stat-label">本月任务</div><div class="ai-stat-value">${fmtNumber(overview.month_tasks || 0, 0)}</div></div>
                </div>
                <div class="ai-form-grid">
                    <div class="ai-field">
                        <label>计费开关</label>
                        <select class="ai-select" id="aiBillingEnabled">
                            <option value="true" ${cfg.enabled !== false ? 'selected' : ''}>启用</option>
                            <option value="false" ${cfg.enabled === false ? 'selected' : ''}>关闭</option>
                        </select>
                    </div>
                    <div class="ai-field"><label>单位名称</label><input class="ai-input" id="aiBillingUnitLabel" value="${escapeHtml(cfg.unit_label || 'AI额度')}"></div>
                    <div class="ai-field"><label>每 1K tokens 扣费</label><input class="ai-input" id="aiBillingUnitsPer1k" type="number" min="0.01" step="0.01" value="${Number(cfg.user_units_per_1k_tokens || 1)}"></div>
                    <div class="ai-field"><label>默认倍率</label><input class="ai-input" id="aiBillingMarkup" type="number" min="0.01" step="0.01" value="${Number(cfg.default_markup || 1)}"></div>
                    <div class="ai-field"><label>单次最低扣费</label><input class="ai-input" id="aiBillingMinimum" type="number" min="0" value="${Number(cfg.minimum_charge_units || 1)}"></div>
                </div>
                <div style="overflow:auto;margin-top:12px;">
                    <table class="ai-table">
                        <thead><tr><th>档位</th><th>每月 AI额度</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
                <div class="ai-actions"><button class="ai-btn primary" data-action="save-billing-config">保存计费策略</button></div>
                <div style="overflow:auto;margin-top:12px;">
                    <table class="ai-table">
                        <thead><tr><th>用户</th><th>模型</th><th>tokens</th><th>扣费</th><th>时间</th></tr></thead>
                        <tbody>${ledgerRows}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    function renderDiagnostics() {
        const diag = state.diagnostics || {};
        if (!state.loaded && !state.diagnostics) return '';
        const tags = [
            { label: '总开关：' + (diag.enabled ? '开启' : '关闭'), cls: diag.enabled ? 'ok' : 'bad' },
            { label: 'Provider：' + (diag.provider_ready ? '可用' : '未就绪'), cls: diag.provider_ready ? 'ok' : 'bad' },
            { label: 'sk：' + (diag.active_provider_has_secret ? '已导入' : '未导入'), cls: diag.active_provider_has_secret ? 'ok' : 'warn' },
            { label: '并发：' + Number(diag.queue_concurrency || 0), cls: Number(diag.queue_concurrency || 0) > 0 ? 'ok' : 'warn' }
        ];
        if (diag.active_provider_name) {
            tags.push({ label: '当前：' + diag.active_provider_name, cls: 'ok' });
        }
        if (diag.provider_message) {
            tags.push({ label: String(diag.provider_message).slice(0, 80), cls: 'bad' });
        }
        return '<div class="ai-admin-diagnostics">' + tags.map(function(item) {
            return '<span class="ai-tag ' + item.cls + '">' + escapeHtml(item.label) + '</span>';
        }).join('') + '</div>';
    }

    function renderTiers() {
        const tiers = state.tiers.slice().sort(function(a, b) {
            return Number(a.priority || 0) - Number(b.priority || 0);
        });
        if (!tiers.length) return '<div class="ai-card"><div class="ai-empty">档位配置加载中...</div></div>';
        const rows = tiers.map(function(item) {
            const features = item.features || {};
            return `
                <tr data-tier="${escapeHtml(item.tier)}">
                    <td><strong>${escapeHtml(TIER_LABELS[item.tier] || item.tier)}</strong><div class="ai-meta">${escapeHtml(item.tier)}</div></td>
                    <td><input data-field="tier_name" value="${escapeHtml(item.tier_name || TIER_LABELS[item.tier] || item.tier)}"></td>
                    <td><input data-field="daily_limit" type="number" min="0" value="${Number(item.daily_limit || 0)}"></td>
                    <td><input data-field="monthly_limit" type="number" min="0" value="${Number(item.monthly_limit || 0)}"></td>
                    <td><input data-field="memory_retention_days" type="number" min="1" value="${Number(item.memory_retention_days || 30)}"></td>
                    <td><div class="ai-feature-list">${FEATURE_KEYS.map(function(key) {
                        return '<label class="ai-check small"><input type="checkbox" data-feature="' + escapeHtml(key) + '" ' + (features[key] ? 'checked' : '') + '><span>' + escapeHtml(FEATURE_LABELS[key] || key) + '</span></label>';
                    }).join('')}</div></td>
                    <td><label class="ai-check small"><input type="checkbox" data-field="enabled" ${item.enabled ? 'checked' : ''}><span>启用</span></label></td>
                    <td><button class="ai-btn" data-action="save-tier" data-tier="${escapeHtml(item.tier)}">保存</button></td>
                </tr>
            `;
        }).join('');
        return `
            <div class="ai-card">
                <div class="ai-card-title"><span>权益档位</span><span class="ai-tag">试用 / 普通 / 进阶 / 荣耀 / 至尊</span></div>
                <div style="overflow:auto;">
                    <table class="ai-table">
                        <thead><tr><th>档位</th><th>显示名</th><th>日额度</th><th>月额度</th><th>记忆天数</th><th>功能</th><th>状态</th><th>操作</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    function renderRedeem() {
        const generated = state.generatedCodes.length ? `
            <div class="ai-code-box">
                <strong>本次生成的兑换码，只显示这一次：</strong><br>
                ${state.generatedCodes.map(function(item) { return escapeHtml(item.code || ''); }).join('<br>')}
            </div>
        ` : '';
        const rows = state.redeemCodes.slice(0, 12).map(function(item) {
            return `
                <tr>
                    <td>${escapeHtml(TIER_LABELS[item.tier] || item.tier)}</td>
                    <td>${Number(item.duration_days || 0)} 天</td>
                    <td>${Number(item.used_count || 0)} / ${Number(item.max_uses || 1)}</td>
                    <td>${escapeHtml(item.bind_username || '-')}</td>
                    <td>${escapeHtml(fmtTime(item.created_at))}</td>
                </tr>
            `;
        }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);">暂无兑换码</td></tr>';
        return `
            <div class="ai-card">
                <div class="ai-card-title"><span>兑换码</span><span class="ai-tag">仅兑换码开通</span></div>
                <div class="ai-form-grid">
                    <div class="ai-field"><label>档位</label><select class="ai-select" id="aiRedeemTier">${['basic','advanced','honor','supreme'].map(function(t) { return '<option value="' + t + '">' + (TIER_LABELS[t] || t) + '</option>'; }).join('')}</select></div>
                    <div class="ai-field"><label>有效天数</label><input class="ai-input" id="aiRedeemDuration" type="number" min="1" value="30"></div>
                    <div class="ai-field"><label>生成数量</label><input class="ai-input" id="aiRedeemCount" type="number" min="1" max="200" value="1"></div>
                    <div class="ai-field"><label>绑定账号，可空</label><input class="ai-input" id="aiRedeemBind" placeholder="cyh6699"></div>
                </div>
                <div class="ai-actions"><button class="ai-btn success" data-action="create-redeem">生成兑换码</button></div>
                ${generated}
                <div style="overflow:auto;margin-top:12px;">
                    <table class="ai-table">
                        <thead><tr><th>档位</th><th>时长</th><th>使用</th><th>绑定</th><th>创建时间</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    function render() {
        injectStyle();
        const el = mount();
        if (!el) return;
        if (state.loading && !state.loaded) {
            el.innerHTML = '<div class="ai-card"><div class="ai-empty">正在加载 AI 助手控制台...</div></div>';
            return;
        }
        if (state.error) {
            el.innerHTML = '<div class="ai-card"><div class="ai-empty" style="color:var(--accent-red);">' + escapeHtml(state.error) + '</div></div>';
            return;
        }
        const provider = selectedProvider();
        el.innerHTML = `
            <div class="ai-admin-shell">
                <div class="ai-admin-hero">
                    <div>
                        <div class="ai-admin-title">AI 助手控制台</div>
                        <div class="ai-admin-sub">管理 IM AI 助手的中转站、权益额度、上下文压缩策略和兑换码。AI 模块独立运行，关闭或异常时不会影响普通聊天。</div>
                        ${renderDiagnostics()}
                    </div>
                    <button class="ai-btn primary" data-action="reload">刷新</button>
                </div>
                <div class="ai-admin-grid">
                    <div>
                        ${renderConfig()}
                        ${renderBilling()}
                        ${renderTiers()}
                    </div>
                    <div>
                        ${renderFluAPI()}
                        ${renderProviderForm()}
                        <div class="ai-card">
                            <div class="ai-card-title"><span>Provider 列表</span><span class="ai-tag">${state.providers.length} 个</span></div>
                            <div class="ai-provider-list">${renderProviderList()}</div>
                        </div>
                        ${renderRedeem()}
                    </div>
                </div>
            </div>
        `;
        if (provider && provider.id) loadBalance(provider.id, false);
    }

    function readProviderPayload() {
        const current = selectedProvider() || {};
        return {
            id: Number(current.id || 0),
            provider_name: document.getElementById('aiProviderName')?.value || 'OpenAI-Compatible Relay',
            base_url: document.getElementById('aiProviderBaseUrl')?.value || '',
            chat_model: document.getElementById('aiProviderChatModel')?.value || 'gpt-5-mini',
            summary_model: document.getElementById('aiProviderSummaryModel')?.value || '',
            embedding_model: document.getElementById('aiProviderEmbeddingModel')?.value || '',
            balance_supported: !!document.getElementById('aiProviderBalanceSupported')?.checked,
            balance_endpoint: document.getElementById('aiProviderBalanceEndpoint')?.value || '',
            balance_cache_ttl_seconds: Number(document.getElementById('aiProviderBalanceTtl')?.value || 600),
            low_balance_threshold: Number(document.getElementById('aiProviderLowBalance')?.value || 0),
            enabled: !!document.getElementById('aiProviderEnabled')?.checked
        };
    }

    async function loadAll() {
        state.loading = true;
        state.error = '';
        render();
        try {
            const results = await Promise.all([
                api('/admin/api/ai/config'),
                api('/admin/api/ai/diagnostics'),
                api('/admin/api/ai/providers'),
                api('/admin/api/ai/billing/config'),
                api('/admin/api/ai/billing/overview'),
                api('/admin/api/ai/fluapi'),
                api('/admin/api/ai/tiers'),
                api('/admin/api/ai/redeem-codes')
            ]);
            state.config = unwrapItem(results[0], {});
            state.diagnostics = unwrapItem(results[1], {});
            state.providers = unwrapItems(results[2]);
            state.billingConfig = unwrapItem(results[3], {});
            state.billingOverview = unwrapItem(results[4], {});
            state.fluapiStatus = unwrapItem(results[5], {});
            state.tiers = unwrapItems(results[6]);
            state.redeemCodes = unwrapItems(results[7]);
            if (!providerById(state.selectedProviderId)) {
                state.selectedProviderId = Number(state.providers[0] && state.providers[0].id || 0);
            }
            state.loaded = true;
        } catch (e) {
            state.error = e.message || 'AI 控制台加载失败';
        } finally {
            state.loading = false;
            render();
        }
    }

    async function saveConfig() {
        const payload = {
            enabled: document.getElementById('aiConfigEnabled')?.value !== 'false',
            context_summary_min_count: Number(document.getElementById('aiConfigSummaryMin')?.value || 70),
            context_recent_keep_count: Number(document.getElementById('aiConfigRecentKeep')?.value || 30)
        };
        const data = await api('/admin/api/ai/config', { method: 'POST', body: JSON.stringify(payload) });
        state.config = unwrapItem(data, payload);
        showToast('AI 运行策略已保存');
        render();
    }

    function readBillingPayload() {
        const tierMonthlyCreditUnits = {};
        document.querySelectorAll('[data-billing-tier]').forEach(function(input) {
            tierMonthlyCreditUnits[input.dataset.billingTier] = Number(input.value || 0);
        });
        return {
            enabled: document.getElementById('aiBillingEnabled')?.value !== 'false',
            unit_label: document.getElementById('aiBillingUnitLabel')?.value || 'AI额度',
            user_units_per_1k_tokens: Number(document.getElementById('aiBillingUnitsPer1k')?.value || 1),
            default_markup: Number(document.getElementById('aiBillingMarkup')?.value || 1),
            minimum_charge_units: Number(document.getElementById('aiBillingMinimum')?.value || 1),
            tier_monthly_credit_units: tierMonthlyCreditUnits
        };
    }

    async function saveBillingConfig() {
        const payload = readBillingPayload();
        const data = await api('/admin/api/ai/billing/config', { method: 'POST', body: JSON.stringify(payload) });
        state.billingConfig = unwrapItem(data, payload);
        showToast('AI 计费策略已保存');
        await loadBillingOverview();
    }

    async function loadBillingOverview() {
        const data = await api('/admin/api/ai/billing/overview');
        state.billingOverview = unwrapItem(data, {});
        render();
    }

    function readFluAPIConfigPayload() {
        return {
            enabled: document.getElementById('aiFluapiEnabled')?.value !== 'false',
            base_url: document.getElementById('aiFluapiBaseUrl')?.value || 'https://www.fluapi.com',
            username: document.getElementById('aiFluapiUsername')?.value || '',
            user_id: document.getElementById('aiFluapiUserId')?.value || '',
            quota_per_usd: Number(document.getElementById('aiFluapiQuotaPerUsd')?.value || 500000),
            low_balance_usd: Number(document.getElementById('aiFluapiLowBalance')?.value || 10)
        };
    }

    async function saveFluAPIConfig() {
        const data = await api('/admin/api/ai/fluapi/config', {
            method: 'POST',
            body: JSON.stringify(readFluAPIConfigPayload())
        });
        state.fluapiStatus = unwrapItem(data, {});
        showToast('FluAPI 上游配置已保存');
        render();
    }

    async function saveFluAPICredentials() {
        const username = document.getElementById('aiFluapiCredentialUsername')?.value || document.getElementById('aiFluapiUsername')?.value || '';
        const password = document.getElementById('aiFluapiPassword')?.value || '';
        if (!username.trim() || !password.trim()) throw new Error('请输入 FluAPI 账号和密码');
        const data = await api('/admin/api/ai/fluapi/credentials', {
            method: 'POST',
            body: JSON.stringify({ username: username, password: password })
        });
        state.fluapiStatus = unwrapItem(data, {});
        showToast('FluAPI 已登录，session 已加密保存');
        render();
    }

    async function fluAPILogin() {
        const data = await api('/admin/api/ai/fluapi/login', { method: 'POST', body: '{}' });
        const cfg = unwrapItem(data, {});
        state.fluapiStatus = Object.assign({}, state.fluapiStatus || {}, { config: cfg });
        showToast('FluAPI 重新登录成功');
        render();
    }

    async function fluAPISync() {
        const data = await api('/admin/api/ai/fluapi/sync', { method: 'POST', body: '{}' });
        const balance = unwrapItem(data, {});
        state.fluapiStatus = Object.assign({}, state.fluapiStatus || {}, { latest_balance: balance });
        showToast('FluAPI 余额已同步');
        await loadAll();
    }

    async function saveProvider() {
        const payload = readProviderPayload();
        const method = payload.id ? 'PUT' : 'POST';
        const path = payload.id ? '/admin/api/ai/providers/' + payload.id : '/admin/api/ai/providers';
        const data = await api(path, { method: method, body: JSON.stringify(payload) });
        const item = unwrapItem(data, null);
        if (item && item.id) state.selectedProviderId = Number(item.id);
        showToast('Provider 已保存');
        await loadAll();
        return item;
    }

    async function saveSecret() {
        const secret = document.getElementById('aiProviderSecret')?.value || '';
        if (!secret.trim()) throw new Error('请粘贴 sk 密钥');
        let provider = selectedProvider();
        if (!provider || !provider.id) {
            const payload = readProviderPayload();
            const data = await api('/admin/api/ai/providers', { method: 'POST', body: JSON.stringify(payload) });
            provider = unwrapItem(data, null);
            if (provider && provider.id) state.selectedProviderId = Number(provider.id);
        }
        if (!provider || !provider.id) throw new Error('Provider 创建失败，无法导入 API Key');
        const data = await api('/admin/api/ai/providers/' + provider.id + '/secret', {
            method: 'POST',
            body: JSON.stringify({ secret: secret })
        });
        const item = unwrapItem(data, {});
        const models = Array.isArray(item.available_models) ? item.available_models : [];
        const status = item.last_test_status ? ('；状态：' + item.last_test_status) : '';
        showToast(models.length ? ('API Key 已导入，已获取 ' + models.length + ' 个模型') : ('API Key 已导入，暂未获取模型列表' + status), models.length ? undefined : 'error');
        await loadAll();
    }

    async function testProvider() {
        const provider = selectedProvider();
        if (!provider || !provider.id) throw new Error('请先选择 Provider');
        const prompt = document.getElementById('aiProviderTestPrompt')?.value || '';
        const data = await api('/admin/api/ai/providers/' + provider.id + '/test', {
            method: 'POST',
            body: JSON.stringify({ prompt: prompt })
        });
        const item = unwrapItem(data, {});
        const probeText = item.probe ? (' · ' + item.probe) : '';
        const modelText = item.model ? (' · ' + item.model) : '';
        const contentText = item.content ? (' · 回复：' + item.content) : '';
        const message = item.ok
            ? ('模型回复测试成功：' + item.latency_ms + 'ms' + probeText + modelText + contentText)
            : ('模型回复测试失败：' + (item.message || '-'));
        const info = document.getElementById('aiProviderBalanceInfo');
        if (info) info.textContent = message;
        showToast(message, item.ok ? undefined : 'error');
        await loadAll();
    }

    async function refreshProviderModels() {
        const provider = selectedProvider();
        if (!provider || !provider.id) throw new Error('请先选择 Provider');
        const data = await api('/admin/api/ai/providers/' + provider.id + '/models', { method: 'POST', body: '{}' });
        const item = unwrapItem(data, {});
        const models = Array.isArray(item.models) ? item.models : [];
        showToast(models.length ? ('已获取 ' + models.length + ' 个模型') : '模型列表为空，可手动填写模型名', models.length ? undefined : 'error');
        await loadAll();
    }

    async function loadBalance(providerId, refresh) {
        const info = document.getElementById('aiProviderBalanceInfo');
        if (!info || !providerId) return;
        try {
            const path = refresh
                ? '/admin/api/ai/providers/' + providerId + '/balance/refresh'
                : '/admin/api/ai/providers/' + providerId + '/balance';
            const data = await api(path, { method: refresh ? 'POST' : 'GET', body: refresh ? '{}' : undefined });
            const item = unwrapItem(data, {});
            if (!item.supported) {
                info.textContent = item.last_error || '当前 Provider 未开启余额查询。';
                return;
            }
            info.textContent = '余额：' + Number(item.balance_amount || 0) + ' ' + (item.balance_currency || item.raw_unit || '') +
                ' · 低余额：' + (item.low_balance ? '是' : '否') +
                ' · 刷新：' + fmtTime(item.last_refresh_at || item.updated_at);
        } catch (e) {
            info.textContent = e.message || '余额查询失败';
        }
    }

    async function saveTier(tier) {
        const row = Array.prototype.slice.call(document.querySelectorAll('#aiAssistant tr[data-tier]')).find(function(item) {
            return String(item.dataset.tier || '') === String(tier || '');
        });
        if (!row) return;
        const features = {};
        row.querySelectorAll('[data-feature]').forEach(function(input) {
            features[input.dataset.feature] = !!input.checked;
        });
        const payload = {
            tier: tier,
            tier_name: row.querySelector('[data-field="tier_name"]')?.value || TIER_LABELS[tier] || tier,
            daily_limit: Number(row.querySelector('[data-field="daily_limit"]')?.value || 0),
            monthly_limit: Number(row.querySelector('[data-field="monthly_limit"]')?.value || 0),
            memory_retention_days: Number(row.querySelector('[data-field="memory_retention_days"]')?.value || 30),
            features: features,
            enabled: !!row.querySelector('[data-field="enabled"]')?.checked
        };
        await api('/admin/api/ai/tiers', { method: 'POST', body: JSON.stringify(payload) });
        showToast('档位已保存');
        await loadAll();
    }

    async function createRedeem() {
        const payload = {
            tier: document.getElementById('aiRedeemTier')?.value || 'basic',
            duration_days: Number(document.getElementById('aiRedeemDuration')?.value || 30),
            count: Number(document.getElementById('aiRedeemCount')?.value || 1),
            max_uses: 1,
            bind_username: document.getElementById('aiRedeemBind')?.value || ''
        };
        const data = await api('/admin/api/ai/redeem-codes', { method: 'POST', body: JSON.stringify(payload) });
        state.generatedCodes = unwrapItems(data);
        showToast('兑换码已生成');
        await loadAll();
    }

    async function handleAction(action, target) {
        if (action === 'reload') return loadAll();
        if (action === 'select-provider') {
            state.selectedProviderId = Number(target.dataset.id || 0);
            render();
            return;
        }
        if (action === 'new-provider') {
            state.selectedProviderId = 0;
            render();
            return;
        }
        if (action === 'save-config') return saveConfig();
        if (action === 'save-billing-config') return saveBillingConfig();
        if (action === 'save-fluapi-config') return saveFluAPIConfig();
        if (action === 'save-fluapi-credentials') return saveFluAPICredentials();
        if (action === 'fluapi-login') return fluAPILogin();
        if (action === 'fluapi-sync') return fluAPISync();
        if (action === 'save-provider') return saveProvider();
        if (action === 'save-secret') return saveSecret();
        if (action === 'test-provider') return testProvider();
        if (action === 'refresh-provider-models') return refreshProviderModels();
        if (action === 'refresh-balance') {
            const provider = selectedProvider();
            if (provider && provider.id) await loadBalance(provider.id, true);
            return;
        }
        if (action === 'save-tier') return saveTier(target.dataset.tier || '');
        if (action === 'create-redeem') return createRedeem();
    }

    function bindEvents() {
        const el = mount();
        if (!el || el.dataset.aiBound === '1') return;
        el.dataset.aiBound = '1';
        el.addEventListener('click', function(event) {
            const target = event.target.closest('[data-action]');
            if (!target || !el.contains(target)) return;
            event.preventDefault();
            const action = target.dataset.action || '';
            Promise.resolve(handleAction(action, target)).catch(function(e) {
                showToast(e.message || '操作失败', 'error');
            });
        });
    }

    function start() {
        injectStyle();
        bindEvents();
        if (!state.loaded && !state.loading) {
            loadAll();
            return;
        }
        render();
    }

    global.AKAIAssistantPanel = {
        start: start,
        reload: loadAll
    };
})(window);
