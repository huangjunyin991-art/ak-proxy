(function(global) {
    'use strict';

    const API_BASE = '';
    const FEATURE_KEYS = ['ai_chat', 'polish_translate', 'chat_summary', 'semantic_search', 'search_summary'];
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

    function providerById(id) {
        const target = Number(id || 0);
        return state.providers.find(function(item) {
            return Number(item && item.id || 0) === target;
        }) || null;
    }

    function selectedProvider() {
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
            #aiAssistant .ai-table input{width:100%;height:32px;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary);color:var(--text-primary);padding:0 8px}
            #aiAssistant .ai-feature-list{display:flex;flex-wrap:wrap;gap:6px}
            #aiAssistant .ai-feature-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary)}
            #aiAssistant .ai-code-box{margin-top:10px;border:1px dashed rgba(0,212,255,.35);border-radius:10px;padding:10px;background:rgba(0,212,255,.05);font-size:12px;color:var(--text-primary);line-height:1.8;word-break:break-all}
            #aiAssistant .ai-empty{padding:26px;text-align:center;color:var(--text-secondary)}
            @media (max-width: 1100px){#aiAssistant .ai-admin-grid{grid-template-columns:1fr}#aiAssistant .ai-form-grid{grid-template-columns:1fr}}
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

    function renderProviderForm() {
        const item = selectedProvider() || {};
        const id = Number(item.id || 0);
        return `
            <div class="ai-card">
                <div class="ai-card-title">
                    <span>中转站 Provider</span>
                    <span class="ai-tag">${id ? '#' + id : '新增'}</span>
                </div>
                <div class="ai-form-grid">
                    <div class="ai-field"><label>名称</label><input class="ai-input" id="aiProviderName" value="${escapeHtml(item.provider_name || 'OpenAI-Compatible Relay')}"></div>
                    <div class="ai-field"><label>Base URL</label><input class="ai-input" id="aiProviderBaseUrl" placeholder="https://relay.example.com" value="${escapeHtml(item.base_url || '')}"></div>
                    <div class="ai-field"><label>聊天模型</label><input class="ai-input" id="aiProviderChatModel" value="${escapeHtml(item.chat_model || 'gpt-5-mini')}"></div>
                    <div class="ai-field"><label>摘要模型</label><input class="ai-input" id="aiProviderSummaryModel" value="${escapeHtml(item.summary_model || item.chat_model || 'gpt-5-mini')}"></div>
                    <div class="ai-field"><label>Embedding 模型</label><input class="ai-input" id="aiProviderEmbeddingModel" value="${escapeHtml(item.embedding_model || '')}"></div>
                    <div class="ai-field"><label>余额接口</label><input class="ai-input" id="aiProviderBalanceEndpoint" placeholder="/v1/dashboard/billing/credit_grants" value="${escapeHtml(item.balance_endpoint || '')}"></div>
                    <div class="ai-field"><label>余额缓存秒</label><input class="ai-input" id="aiProviderBalanceTtl" type="number" min="30" value="${Number(item.balance_cache_ttl_seconds || 600)}"></div>
                    <div class="ai-field"><label>低余额阈值</label><input class="ai-input" id="aiProviderLowBalance" type="number" min="0" step="0.01" value="${Number(item.low_balance_threshold || 0)}"></div>
                </div>
                <div class="ai-actions">
                    <label class="ai-feature-chip"><input type="checkbox" id="aiProviderEnabled" ${item.enabled ? 'checked' : ''}> 启用</label>
                    <label class="ai-feature-chip"><input type="checkbox" id="aiProviderBalanceSupported" ${item.balance_supported ? 'checked' : ''}> 支持余额查询</label>
                </div>
                <div class="ai-actions">
                    <button class="ai-btn primary" data-action="save-provider">${id ? '保存 Provider' : '新增 Provider'}</button>
                    <button class="ai-btn" data-action="new-provider">清空新增</button>
                    ${id ? '<button class="ai-btn warn" data-action="test-provider">测试连接</button><button class="ai-btn" data-action="refresh-balance">刷新余额</button>' : ''}
                </div>
                ${id ? `
                    <div class="ai-actions">
                        <input class="ai-input" id="aiProviderSecret" type="password" placeholder="粘贴 sk 密钥，保存后只显示指纹" style="max-width:420px;">
                        <button class="ai-btn success" data-action="save-secret">导入 sk</button>
                    </div>
                    <div class="ai-meta" id="aiProviderBalanceInfo">余额信息刷新后显示在这里。</div>
                ` : ''}
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
                        return '<label class="ai-feature-chip"><input type="checkbox" data-feature="' + escapeHtml(key) + '" ' + (features[key] ? 'checked' : '') + '> ' + escapeHtml(key) + '</label>';
                    }).join('')}</div></td>
                    <td><label class="ai-feature-chip"><input type="checkbox" data-field="enabled" ${item.enabled ? 'checked' : ''}> 启用</label></td>
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
                        ${renderTiers()}
                    </div>
                    <div>
                        <div class="ai-card">
                            <div class="ai-card-title"><span>Provider 列表</span><span class="ai-tag">${state.providers.length} 个</span></div>
                            <div class="ai-provider-list">${renderProviderList()}</div>
                        </div>
                        ${renderProviderForm()}
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
                api('/admin/api/ai/tiers'),
                api('/admin/api/ai/redeem-codes')
            ]);
            state.config = unwrapItem(results[0], {});
            state.diagnostics = unwrapItem(results[1], {});
            state.providers = unwrapItems(results[2]);
            state.tiers = unwrapItems(results[3]);
            state.redeemCodes = unwrapItems(results[4]);
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

    async function saveProvider() {
        const payload = readProviderPayload();
        const method = payload.id ? 'PUT' : 'POST';
        const path = payload.id ? '/admin/api/ai/providers/' + payload.id : '/admin/api/ai/providers';
        const data = await api(path, { method: method, body: JSON.stringify(payload) });
        const item = unwrapItem(data, null);
        if (item && item.id) state.selectedProviderId = Number(item.id);
        showToast('Provider 已保存');
        await loadAll();
    }

    async function saveSecret() {
        const provider = selectedProvider();
        const secret = document.getElementById('aiProviderSecret')?.value || '';
        if (!provider || !provider.id) throw new Error('请先选择 Provider');
        if (!secret.trim()) throw new Error('请粘贴 sk 密钥');
        await api('/admin/api/ai/providers/' + provider.id + '/secret', {
            method: 'POST',
            body: JSON.stringify({ secret: secret })
        });
        showToast('sk 已导入，只会保存加密密文和指纹');
        await loadAll();
    }

    async function testProvider() {
        const provider = selectedProvider();
        if (!provider || !provider.id) throw new Error('请先选择 Provider');
        const data = await api('/admin/api/ai/providers/' + provider.id + '/test', { method: 'POST', body: '{}' });
        const item = unwrapItem(data, {});
        const probeText = item.probe ? (' · ' + item.probe) : '';
        showToast(item.ok ? ('连接测试成功：' + item.latency_ms + 'ms' + probeText) : ('连接测试失败：' + (item.message || '-')), item.ok ? undefined : 'error');
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
        if (action === 'save-provider') return saveProvider();
        if (action === 'save-secret') return saveSecret();
        if (action === 'test-provider') return testProvider();
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
