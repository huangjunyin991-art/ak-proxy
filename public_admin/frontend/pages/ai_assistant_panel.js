(function(global) {
    'use strict';

    const API_BASE = '';
    const TIER_LABELS = {
        trial: '试用',
        basic: '普通',
        advanced: '进阶',
        honor: '荣耀',
        supreme: '至尊'
    };
    const TIER_ORDER = ['trial', 'basic', 'advanced', 'honor', 'supreme'];
    const RELAY_ADAPTERS = [
        { value: 'newapi', label: 'New API / Dream Field', displayName: 'Dream Field', baseUrl: 'https://www.dreamfield.top' },
        { value: 'x5m5x', label: '极速 API Gateway', displayName: '极速 API Gateway', baseUrl: 'https://api.x5m5x.com' }
    ];

    const state = {
        loaded: false,
        loading: false,
        config: null,
        diagnostics: null,
        providers: [],
        billingConfig: null,
        billingOverview: null,
        taskRetention: null,
        tableStorage: null,
        relayConsoleStatus: null,
        relayConsoleTokens: {},
        relayConsoleModels: {},
        relayConsoleAvailableModels: {},
        relayConsoleAccountUsage: {},
        tiers: [],
        redeemCodes: [],
        generatedCodes: [],
        selectedProviderId: 0,
        selectedRelayConsoleId: 0,
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

    function fmtQuota(value) {
        if (value === 'unlimited') return '无限';
        return fmtNumber(value || 0, 0);
    }

    function fmtBytes(value) {
        const num = Number(value || 0);
        if (!Number.isFinite(num) || num <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = num;
        let index = 0;
        while (size >= 1024 && index < units.length - 1) {
            size = size / 1024;
            index += 1;
        }
        if (index === 0) return Math.round(size) + ' ' + units[index];
        return (size >= 100 ? size.toFixed(0) : size.toFixed(1)) + ' ' + units[index];
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

    function relayConsoleAccounts() {
        const status = state.relayConsoleStatus || {};
        return Array.isArray(status.accounts) ? status.accounts : [];
    }

    function relayConsoleById(id) {
        const target = Number(id || 0);
        return relayConsoleAccounts().find(function(item) {
            return Number(item && item.id || 0) === target;
        }) || null;
    }

    function selectedRelayConsole() {
        if (Number(state.selectedRelayConsoleId || 0) <= 0) return null;
        return relayConsoleById(state.selectedRelayConsoleId) || relayConsoleAccounts()[0] || null;
    }

    function relayTokenSummary(tokens) {
        const rows = Array.isArray(tokens) ? tokens : [];
        const hasUnlimited = rows.some(function(token) { return !!token.unlimited_quota; });
        const used = rows.reduce(function(sum, token) {
            return sum + Number(token.used_quota || 0);
        }, 0);
        const available = rows.reduce(function(sum, token) {
            return sum + Number(token.remain_quota || 0);
        }, 0);
        return {
            available: hasUnlimited ? 'unlimited' : available,
            used: used,
            total: hasUnlimited ? 'unlimited' : available + used,
            count_label: 'Token',
            count_value: rows.length || 0,
            source: 'token'
        };
    }

    function relayConsoleSummary(consoleId, balance, tokens) {
        if (balance) {
            return {
                available: balance.unlimited_quota ? 'unlimited' : Number(balance.total_available || 0),
                used: Number(balance.total_used || 0),
                total: balance.unlimited_quota ? 'unlimited' : Number(balance.total_granted || 0),
                count_label: 'Token',
                count_value: (tokens || []).length || 0,
                source: 'usage'
            };
        }
        const accountUsage = state.relayConsoleAccountUsage[consoleId];
        if (accountUsage) {
            return {
                available: Number(accountUsage.quota || 0),
                used: Number(accountUsage.used_quota || 0),
                total: Number(accountUsage.total_quota || 0),
                count_label: '请求次数',
                count_value: Number(accountUsage.request_count || 0),
                source: 'self'
            };
        }
        return relayTokenSummary(tokens);
    }

    function looksLikeApiKey(value) {
        return /^sk-[A-Za-z0-9_-]{12,}/.test(String(value || '').trim());
    }

    function isLikelyNonChatModel(model) {
        const lower = String(model || '').trim().toLowerCase();
        if (!lower) return false;
        return [
            'embedding', 'embed', 'rerank', 'ranker', 'moderation',
            'tts', 'whisper', 'speech', 'transcribe', 'audio',
            'image', 'dall-e', 'dalle', 'stable-diffusion', 'sd-'
        ].some(function(keyword) {
            return lower.indexOf(keyword) >= 0;
        });
    }

    function firstModelValue(models, mode) {
        const normalized = (models || []).map(function(model) {
            return String(model || '').trim();
        }).filter(Boolean);
        if (!normalized.length) return '';
        if (mode === 'chat') {
            return normalized.find(function(model) {
                return !isLikelyNonChatModel(model);
            }) || normalized[0] || '';
        }
        return normalized[0] || '';
    }

    function modelExists(models, value) {
        const target = String(value || '').trim();
        if (!target) return false;
        const targetLower = target.toLowerCase();
        return (models || []).some(function(model) {
            return String(model || '').trim().toLowerCase() === targetLower;
        });
    }

    function safeModelValue(models, value, fallbackValue) {
        const target = String(value || '').trim();
        if (!target) return fallbackValue || '';
        if (Array.isArray(models) && models.length && !modelExists(models, target)) {
            return fallbackValue || '';
        }
        return target;
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
            #aiAssistant .ai-model-field{position:relative}
            #aiAssistant .ai-model-label{display:flex;align-items:center;justify-content:space-between;gap:8px}
            #aiAssistant .ai-model-count{font-size:11px;color:var(--text-secondary);opacity:.78;font-variant-numeric:tabular-nums}
            #aiAssistant .ai-model-control{position:relative;display:flex;align-items:center}
            #aiAssistant .ai-model-control:focus-within .ai-model-input{border-color:var(--accent);box-shadow:0 0 0 2px rgba(0,212,255,.12)}
            #aiAssistant .ai-model-control .ai-model-input{width:100%;padding-right:48px}
            #aiAssistant .ai-model-toggle{position:absolute;right:1px;top:1px;bottom:1px;display:flex;align-items:center;justify-content:center;width:42px;border:0;border-left:1px solid rgba(255,255,255,.06);border-radius:0 8px 8px 0;background:linear-gradient(90deg,rgba(5,10,18,.1),rgba(0,212,255,.055));cursor:pointer;transition:background .16s ease,border-color .16s ease}
            #aiAssistant .ai-model-toggle::before{content:"";width:7px;height:7px;border-right:2px solid var(--text-secondary);border-bottom:2px solid var(--text-secondary);transform:rotate(45deg) translate(-1px,-1px);transition:border-color .16s ease,transform .16s ease}
            #aiAssistant .ai-model-toggle:hover,#aiAssistant .ai-model-field.open .ai-model-toggle{border-left-color:rgba(0,212,255,.22);background:linear-gradient(90deg,rgba(0,212,255,.04),rgba(0,212,255,.14))}
            #aiAssistant .ai-model-toggle:hover::before,#aiAssistant .ai-model-field.open .ai-model-toggle::before{border-color:var(--accent)}
            #aiAssistant .ai-model-field.open .ai-model-toggle::before{transform:rotate(225deg) translate(-1px,-1px)}
            #aiAssistant .ai-model-menu{position:absolute;z-index:80;left:0;right:0;top:calc(100% + 6px);max-height:276px;overflow:auto;padding:5px;border:1px solid rgba(0,212,255,.22);border-radius:10px;background:linear-gradient(180deg,rgba(13,19,29,.99),rgba(7,12,20,.99));box-shadow:0 18px 42px rgba(0,0,0,.36),0 0 0 1px rgba(255,255,255,.035) inset}
            #aiAssistant .ai-model-menu::-webkit-scrollbar{width:8px}
            #aiAssistant .ai-model-menu::-webkit-scrollbar-track{background:rgba(255,255,255,.035);border-radius:999px}
            #aiAssistant .ai-model-menu::-webkit-scrollbar-thumb{background:rgba(0,212,255,.45);border-radius:999px;border:2px solid rgba(7,12,20,.99)}
            #aiAssistant .ai-model-option,#aiAssistant .ai-model-empty{width:100%;min-height:34px;border:0;border-radius:7px;background:transparent;color:var(--text-primary);padding:0 10px;text-align:left;font-size:12px;line-height:34px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            #aiAssistant .ai-model-option{display:block;cursor:pointer}
            #aiAssistant .ai-model-option:hover{background:rgba(255,255,255,.055);color:#fff}
            #aiAssistant .ai-model-option.active{background:rgba(0,212,255,.12);color:#fff;box-shadow:3px 0 0 var(--accent) inset;font-weight:800}
            #aiAssistant .ai-model-empty{color:var(--text-secondary);cursor:default}
            #aiAssistant .ai-select-field{position:relative}
            #aiAssistant .ai-select-hidden{display:none}
            #aiAssistant .ai-select-display{position:relative;display:flex;align-items:center;justify-content:space-between;width:100%;height:38px;border:1px solid var(--border);border-radius:9px;background:var(--bg-primary);color:var(--text-primary);padding:0 42px 0 12px;outline:none;cursor:pointer;text-align:left;font-weight:800;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}
            #aiAssistant .ai-select-display::after{content:"";position:absolute;right:14px;top:50%;width:7px;height:7px;border-right:2px solid var(--text-secondary);border-bottom:2px solid var(--text-secondary);transform:translateY(-65%) rotate(45deg);transition:border-color .16s ease,transform .16s ease}
            #aiAssistant .ai-select-field.open .ai-select-display,#aiAssistant .ai-select-display:hover{border-color:var(--accent);box-shadow:0 0 0 2px rgba(0,212,255,.12);background:rgba(0,212,255,.035)}
            #aiAssistant .ai-select-field.open .ai-select-display::after{border-color:var(--accent);transform:translateY(-25%) rotate(225deg)}
            #aiAssistant .ai-select-menu{position:absolute;z-index:70;left:0;right:0;top:calc(100% + 6px);padding:5px;border:1px solid rgba(0,212,255,.22);border-radius:10px;background:linear-gradient(180deg,rgba(13,19,29,.99),rgba(7,12,20,.99));box-shadow:0 18px 42px rgba(0,0,0,.36),0 0 0 1px rgba(255,255,255,.035) inset}
            #aiAssistant .ai-select-option{display:block;width:100%;height:36px;border:0;border-radius:7px;background:transparent;color:var(--text-primary);padding:0 12px;text-align:left;font-size:13px;font-weight:800;cursor:pointer}
            #aiAssistant .ai-select-option:hover{background:rgba(255,255,255,.055);color:#fff}
            #aiAssistant .ai-select-option.active{background:rgba(0,212,255,.12);color:#fff;box-shadow:3px 0 0 var(--accent) inset}
            #aiAssistant .ai-switch-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
            #aiAssistant .ai-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}
            #aiAssistant .ai-btn{height:36px;border:0;border-radius:9px;padding:0 13px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-weight:700;white-space:nowrap}
            #aiAssistant .ai-btn:disabled{opacity:.5;cursor:not-allowed;filter:grayscale(.25)}
            #aiAssistant .ai-btn.primary{background:linear-gradient(135deg,var(--accent),#008ed0);color:#fff}
            #aiAssistant .ai-btn.success{background:linear-gradient(135deg,#00ff88,#00b96b);color:#052d1b}
            #aiAssistant .ai-btn.warn{background:linear-gradient(135deg,#ffa502,#e67e22);color:#1f1300}
            #aiAssistant .ai-btn.danger{background:rgba(255,71,87,.13);border:1px solid rgba(255,71,87,.38);color:var(--accent-red)}
            #aiAssistant .ai-btn.danger:hover{background:rgba(255,71,87,.22);color:#fff}
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
            #aiAssistant .ai-check{position:relative;display:inline-flex;align-items:center;min-height:28px;cursor:pointer;user-select:none}
            #aiAssistant .ai-check input{position:absolute;opacity:0;pointer-events:none}
            #aiAssistant .ai-check span{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:0 10px;border:1px solid var(--border);border-radius:999px;background:rgba(255,255,255,.035);color:var(--text-secondary);font-size:12px;font-weight:700;white-space:nowrap;transition:background .16s ease,border-color .16s ease,color .16s ease,box-shadow .16s ease}
            #aiAssistant .ai-check input:checked + span{border-color:rgba(0,255,136,.55);background:rgba(0,255,136,.14);color:var(--accent-green);box-shadow:0 0 0 1px rgba(0,255,136,.10) inset}
            #aiAssistant .ai-check input:focus-visible + span{box-shadow:0 0 0 3px rgba(0,212,255,.18)}
            #aiAssistant .ai-check.small span{min-height:24px;padding:0 8px;font-size:11px}
            #aiAssistant .ai-tier-table th:nth-last-child(-n+2),#aiAssistant .ai-tier-table td:nth-last-child(-n+2){text-align:center;white-space:nowrap}
            #aiAssistant .ai-tier-status .ai-check.small span{min-width:54px;min-height:30px;border-radius:10px;padding:0 12px}
            #aiAssistant .ai-tier-save{height:30px;min-width:58px;border:1px solid rgba(0,212,255,.30);border-radius:9px;background:rgba(0,212,255,.09);color:var(--accent);box-shadow:0 0 0 1px rgba(0,212,255,.06) inset}
            #aiAssistant .ai-tier-save:hover{background:rgba(0,212,255,.16);border-color:rgba(0,212,255,.52);color:#fff}
            #aiAssistant .ai-model-chip-list{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
            #aiAssistant .ai-model-chip{display:inline-flex;align-items:center;max-width:180px;height:22px;padding:0 8px;border:1px solid rgba(0,212,255,.22);border-radius:999px;background:rgba(0,212,255,.07);color:var(--text-primary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            #aiAssistant .ai-model-chip.muted{color:var(--text-secondary);background:rgba(255,255,255,.05);border-color:var(--border)}
            #aiAssistant .ai-code-box{margin-top:10px;border:1px dashed rgba(0,212,255,.35);border-radius:10px;padding:10px;background:rgba(0,212,255,.05);font-size:12px;color:var(--text-primary);line-height:1.8;word-break:break-all}
            #aiAssistant .ai-stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}
            #aiAssistant .ai-stat-grid.relay{grid-template-columns:repeat(4,minmax(0,1fr))}
            #aiAssistant .ai-stat{border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.035);padding:10px;min-width:0}
            #aiAssistant .ai-stat-label{font-size:12px;color:var(--text-secondary);margin-bottom:5px}
            #aiAssistant .ai-stat-value{font-size:18px;font-weight:800;color:var(--text-primary);font-variant-numeric:tabular-nums}
            #aiAssistant .ai-maintenance-split{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:14px;align-items:start}
            #aiAssistant .ai-storage-list{display:flex;flex-direction:column;gap:8px;max-height:330px;overflow:auto;padding-right:2px}
            #aiAssistant .ai-storage-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.03);padding:10px}
            #aiAssistant .ai-storage-name{font-size:12px;font-weight:800;color:var(--text-primary);word-break:break-all}
            #aiAssistant .ai-storage-size{font-size:13px;font-weight:900;color:var(--accent);font-variant-numeric:tabular-nums;white-space:nowrap}
            #aiAssistant .ai-storage-meta{grid-column:1/-1;font-size:11px;color:var(--text-secondary);line-height:1.6}
            #aiAssistant .ai-secret-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;margin-top:10px}
            #aiAssistant .ai-secret-row.provider{grid-template-columns:minmax(0,1fr) auto}
            #aiAssistant .ai-empty{padding:26px;text-align:center;color:var(--text-secondary)}
            @media (max-width: 1100px){#aiAssistant .ai-admin-grid{grid-template-columns:1fr}#aiAssistant .ai-form-grid{grid-template-columns:1fr}#aiAssistant .ai-stat-grid,#aiAssistant .ai-stat-grid.relay{grid-template-columns:1fr}#aiAssistant .ai-maintenance-split{grid-template-columns:1fr}#aiAssistant .ai-secret-row,#aiAssistant .ai-secret-row.provider{grid-template-columns:1fr}}
        `;
        document.head.appendChild(style);
    }

    function renderProviderList() {
        if (!state.providers.length) {
            return '<div class="ai-empty">还没有配置中转站，先在右侧新增一个 Provider。</div>';
        }
        return state.providers.map(function(item) {
            const active = Number(item.id || 0) === Number(state.selectedProviderId || 0);
            const itemModels = Array.isArray(item.available_models) ? item.available_models : [];
            const displayModel = safeModelValue(itemModels, item.chat_model, firstModelValue(itemModels, 'chat')) || '-';
            return `
                <div class="ai-provider-item ${active ? 'active' : ''}" data-action="select-provider" data-id="${Number(item.id || 0)}">
                    <div class="ai-provider-head">
                        <div class="ai-provider-name">${escapeHtml(item.provider_name || 'OpenAI-Compatible Relay')}</div>
                        <span class="ai-tag ${item.enabled ? 'ok' : 'bad'}">${item.enabled ? '启用' : '停用'}</span>
                    </div>
                    <div class="ai-meta">${escapeHtml(item.base_url || '-')}</div>
                    <div class="ai-meta">模型：${escapeHtml(displayModel)} · 密钥：${escapeHtml(item.secret_fingerprint || '未导入')}</div>
                    <div class="ai-meta">最近测试：${escapeHtml(item.last_test_status || '-')} · 最近使用：${escapeHtml(fmtTime(item.last_used_at))}</div>
                </div>
            `;
        }).join('');
    }

    function renderModelInput(id, label, value, models, placeholder, fallbackValue) {
        const seen = {};
        const normalizedModels = (models || []).filter(function(model) {
            const key = String(model || '').trim();
            if (!key || seen[key]) return false;
            seen[key] = true;
            return true;
        });
        const currentValue = String(value || fallbackValue || '');
        const options = normalizedModels.map(function(model) {
            const modelName = String(model || '');
            return '<button type="button" class="ai-model-option ' + (modelName === currentValue ? 'active' : '') + '" data-model-option="1" data-model-value="' + escapeHtml(modelName) + '">' + escapeHtml(modelName) + '</button>';
        }).join('');
        return `
            <div class="ai-field ai-model-field" data-model-picker="1">
                <label class="ai-model-label"><span>${escapeHtml(label)}</span>${normalizedModels.length ? '<span class="ai-model-count">' + normalizedModels.length + ' 个</span>' : ''}</label>
                <div class="ai-model-control">
                    <input class="ai-input ai-model-input" id="${escapeHtml(id)}" value="${escapeHtml(currentValue)}" placeholder="${escapeHtml(placeholder || '导入 API Key 后刷新模型')}" autocomplete="off" spellcheck="false" data-model-input="1">
                    <button class="ai-model-toggle" type="button" data-model-toggle="1" aria-label="展开模型列表" title="展开模型列表"></button>
                </div>
                <div class="ai-model-menu" data-model-menu="1" hidden>
                    ${options || '<div class="ai-model-empty">暂无模型，先导入 API Key 或手动输入</div>'}
                    <div class="ai-model-empty ai-model-no-match" hidden>没有匹配模型，可直接手动输入</div>
                </div>
            </div>
        `;
    }

    function renderSelectPicker(id, label, value, options) {
        const currentValue = String(value || '');
        const items = (options || []).filter(function(item) {
            return item && String(item.value || '').trim();
        });
        const current = items.find(function(item) {
            return String(item.value) === currentValue;
        }) || items[0] || { value: currentValue, label: currentValue || '-' };
        const optionHtml = items.map(function(item) {
            const optionValue = String(item.value || '');
            const optionLabel = String(item.label || optionValue);
            return '<button type="button" class="ai-select-option ' + (optionValue === String(current.value || '') ? 'active' : '') + '" data-select-option="1" data-select-value="' + escapeHtml(optionValue) + '">' + escapeHtml(optionLabel) + '</button>';
        }).join('');
        return `
            <div class="ai-field ai-select-field" data-select-picker="1">
                <label>${escapeHtml(label)}</label>
                <input class="ai-select-hidden" id="${escapeHtml(id)}" type="hidden" value="${escapeHtml(String(current.value || ''))}">
                <button class="ai-select-display" type="button" data-select-toggle="1"><span data-select-label>${escapeHtml(current.label || current.value || '-')}</span></button>
                <div class="ai-select-menu" data-select-menu="1" hidden>${optionHtml}</div>
            </div>
        `;
    }

    function relayAdapterOptions() {
        return RELAY_ADAPTERS.map(function(item) {
            return { value: item.value, label: item.label };
        });
    }

    function relayAdapterMeta(adapterKey) {
        adapterKey = String(adapterKey || '').trim().toLowerCase();
        return RELAY_ADAPTERS.find(function(item) {
            return item.value === adapterKey;
        }) || RELAY_ADAPTERS[0];
    }

    function isRelayDefaultDisplayName(value) {
        const current = String(value || '').trim().toLowerCase();
        if (!current) return false;
        if (current === 'new api') return true;
        return RELAY_ADAPTERS.some(function(item) {
            return current === String(item.displayName || '').trim().toLowerCase() ||
                current === String(item.label || '').trim().toLowerCase();
        });
    }

    function relayDisplayNameFor(adapterKey, displayName) {
        const meta = relayAdapterMeta(adapterKey);
        const current = String(displayName || '').trim();
        if (!current) return meta.displayName;
        if (isRelayDefaultDisplayName(current) && current.toLowerCase() !== String(meta.displayName || '').toLowerCase()) {
            return meta.displayName;
        }
        return current;
    }

    function renderProviderForm() {
        const item = selectedProvider() || {};
        const id = Number(item.id || 0);
        const providerEnabled = id ? !!item.enabled : true;
        const models = Array.isArray(item.available_models) ? item.available_models : [];
        const baseUrl = String(item.base_url || '');
        const baseUrlLooksKey = looksLikeApiKey(baseUrl);
        const fallbackChatModel = firstModelValue(models, 'chat');
        const chatModelValue = safeModelValue(models, item.chat_model, fallbackChatModel);
        const summaryModelValue = safeModelValue(models, item.summary_model || chatModelValue, chatModelValue || fallbackChatModel);
        return `
            <div class="ai-card">
                <div class="ai-card-title">
                    <span>中转站 Provider</span>
                    <span class="ai-tag">${id ? '#' + id : '新增'}</span>
                </div>
                <div class="ai-form-grid">
                    <div class="ai-field"><label>名称</label><input class="ai-input" id="aiProviderName" value="${escapeHtml(item.provider_name || 'OpenAI-Compatible Relay')}"></div>
                    <div class="ai-field"><label>Base URL（不是 API Key）</label><input class="ai-input" id="aiProviderBaseUrl" placeholder="例如：https://www.dreamfield.top/v1" value="${escapeHtml(baseUrl)}"></div>
                </div>
                ${baseUrlLooksKey ? '<div class="ai-meta" style="color:var(--accent-red);">你把 API Key 填到了 Base URL。Base URL 应该是 https://.../v1，sk 请填到下面的 API Key 输入框。</div>' : ''}
                <div class="ai-secret-row provider">
                    <input class="ai-input" id="aiProviderSecret" type="password" placeholder="API Key / sk 密钥，保存后只显示指纹">
                    <button class="ai-btn success" data-action="save-secret">${id ? '导入 API Key' : '新增并导入 API Key'}</button>
                </div>
                ${id ? '<div class="ai-secret-row provider"><input class="ai-input" id="aiProviderTestPrompt" value="请用一句话回复：AI 通道可用" placeholder="测试 prompt"><button class="ai-btn warn" data-action="test-provider">测试模型回复</button></div>' : ''}
                <div class="ai-form-grid">
                    ${renderModelInput('aiProviderChatModel', '聊天模型', chatModelValue, models, '先导入 API Key 获取模型', fallbackChatModel)}
                    ${renderModelInput('aiProviderSummaryModel', '上下文压缩模型', summaryModelValue, models, '可与聊天模型相同，低成本模型通常足够', fallbackChatModel)}
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
                    ${id ? '<button class="ai-btn" data-action="refresh-provider-models">刷新模型</button>' : ''}
                    ${id ? '<button class="ai-btn danger" data-action="delete-provider">删除 Provider</button>' : ''}
                </div>
            </div>
        `;
    }

    function renderConfig() {
        const cfg = state.config || { enabled: true, context_summary_min_tokens: 12000, context_recent_keep_tokens: 4000, context_scan_max_count: 200, chat_context_max_messages: 1000, chat_context_max_tokens: 12000, group_mention_enabled: true, chat_max_output_tokens: 1000, summary_max_output_tokens: 600, summary_memory_max_tokens: 2000, queue_concurrency: 3 };
        return `
            <div class="ai-card">
                <div class="ai-card-title"><span>运行策略</span><span class="ai-tag ${cfg.enabled ? 'ok' : 'bad'}">${cfg.enabled ? '已开启' : '已关闭'}</span></div>
                <div class="ai-form-grid">
                    ${renderSelectPicker('aiConfigEnabled', 'AI 助手开关', cfg.enabled ? 'true' : 'false', [{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }])}
                    <div class="ai-field"><label>AI 并发执行数</label><input class="ai-input" id="aiConfigQueueConcurrency" type="number" min="1" max="20" step="1" value="${Number(cfg.queue_concurrency || 3)}"></div>
                    <div class="ai-field"><label>超过多少 tokens 后压缩</label><input class="ai-input" id="aiConfigSummaryTokens" type="number" min="2000" step="500" value="${Number(cfg.context_summary_min_tokens || 12000)}"></div>
                    <div class="ai-field"><label>保留最近原文 tokens</label><input class="ai-input" id="aiConfigRecentTokens" type="number" min="800" step="200" value="${Number(cfg.context_recent_keep_tokens || 4000)}"></div>
                    <div class="ai-field"><label>最多扫描消息条数</label><input class="ai-input" id="aiConfigScanMax" type="number" min="50" max="1000" step="10" value="${Number(cfg.context_scan_max_count || 200)}"></div>
                    ${renderSelectPicker('aiConfigGroupMentionEnabled', '群聊 @小A', cfg.group_mention_enabled !== false ? 'true' : 'false', [{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }])}
                    <div class="ai-field"><label>@小A 最多读取消息</label><input class="ai-input" id="aiConfigChatContextMessages" type="number" min="50" max="5000" step="50" value="${Number(cfg.chat_context_max_messages || 1000)}"></div>
                    <div class="ai-field"><label>@小A 上下文 tokens</label><input class="ai-input" id="aiConfigChatContextTokens" type="number" min="1000" step="500" value="${Number(cfg.chat_context_max_tokens || 12000)}"></div>
                    <div class="ai-field"><label>AI 回复输出上限 tokens</label><input class="ai-input" id="aiConfigChatMaxTokens" type="number" min="0" step="100" value="${Number(cfg.chat_max_output_tokens ?? 1000)}"></div>
                    <div class="ai-field"><label>压缩输出上限 tokens</label><input class="ai-input" id="aiConfigSummaryMaxTokens" type="number" min="0" step="100" value="${Number(cfg.summary_max_output_tokens ?? 600)}"></div>
                    <div class="ai-field"><label>长期记忆总上限 tokens</label><input class="ai-input" id="aiConfigSummaryMemoryTokens" type="number" min="0" step="100" value="${Number(cfg.summary_memory_max_tokens ?? 2000)}"></div>
                </div>
                <div class="ai-actions"><button class="ai-btn primary" data-action="save-config">保存运行策略</button></div>
            </div>
        `;
    }

    function renderMaintenance() {
        const retention = state.taskRetention || {};
        const policy = retention.policy || (retention.status && retention.status.policy) || { enabled: true, retention_days: 30, cleanup_interval_hours: 24, batch_limit: 1000 };
        const status = retention.status || {};
        const storage = state.tableStorage || {};
        const rows = Array.isArray(storage.items) ? storage.items : [];
        const storageRows = rows.map(function(item) {
            return `
                <div class="ai-storage-item">
                    <div class="ai-storage-name">${escapeHtml(item.table_name || '-')}</div>
                    <div class="ai-storage-size">${escapeHtml(item.total_pretty || fmtBytes(item.total_bytes))}</div>
                    <div class="ai-storage-meta">数据 ${escapeHtml(item.heap_pretty || fmtBytes(item.heap_bytes))} · 索引 ${escapeHtml(item.index_pretty || fmtBytes(item.index_bytes))} · 估算行数 ${fmtNumber(item.row_estimate || 0, 0)}</div>
                </div>
            `;
        }).join('') || '<div class="ai-empty">暂无 AI 表占用数据</div>';
        const lastDeleted = Number(status.last_deleted_tasks || 0) + Number(status.last_deleted_request_logs || 0) + Number(status.last_deleted_reply_suggestions || 0);
        return `
            <div class="ai-card">
                <div class="ai-card-title">
                    <span>AI 数据维护</span>
                    <span class="ai-tag ${policy.enabled !== false ? 'ok' : 'warn'}">${policy.enabled !== false ? '自动清理' : '保留全部'}</span>
                </div>
                <div class="ai-maintenance-split">
                    <div>
                        <div class="ai-stat-grid">
                            <div class="ai-stat"><div class="ai-stat-label">保留天数</div><div class="ai-stat-value">${fmtNumber(policy.retention_days || 30, 0)}</div></div>
                            <div class="ai-stat"><div class="ai-stat-label">上次清理</div><div class="ai-stat-value">${lastDeleted ? fmtNumber(lastDeleted, 0) : '-'}</div></div>
                            <div class="ai-stat"><div class="ai-stat-label">AI 表总占用</div><div class="ai-stat-value">${escapeHtml(storage.total_pretty || fmtBytes(storage.total_bytes))}</div></div>
                        </div>
                        <div class="ai-form-grid">
                            ${renderSelectPicker('aiTaskRetentionEnabled', '诊断清理', policy.enabled === false ? 'false' : 'true', [{ value: 'true', label: '启用' }, { value: 'false', label: '关闭' }])}
                            <div class="ai-field"><label>保留天数</label><input class="ai-input" id="aiTaskRetentionDays" type="number" min="1" max="3650" value="${Number(policy.retention_days || 30)}"></div>
                            <div class="ai-field"><label>清理周期（小时）</label><input class="ai-input" id="aiTaskRetentionInterval" type="number" min="1" max="168" value="${Number(policy.cleanup_interval_hours || 24)}"></div>
                            <div class="ai-field"><label>单批上限</label><input class="ai-input" id="aiTaskRetentionBatch" type="number" min="50" max="10000" step="50" value="${Number(policy.batch_limit || 1000)}"></div>
                        </div>
                        <div class="ai-meta" style="margin-top:10px;">
                            上次：${escapeHtml(fmtTime(status.last_finished_at || status.last_run_at))} · 下次：${escapeHtml(fmtTime(status.next_run_at))}<br>
                            任务 ${fmtNumber(status.last_deleted_tasks || 0, 0)} · 请求日志 ${fmtNumber(status.last_deleted_request_logs || 0, 0)} · 回复建议 ${fmtNumber(status.last_deleted_reply_suggestions || 0, 0)} · 耗时 ${fmtNumber(status.last_duration_ms || 0, 0)} ms
                        </div>
                        ${status.last_error ? '<div class="ai-meta" style="color:var(--accent-red);margin-top:6px;">最近错误：' + escapeHtml(status.last_error) + '</div>' : ''}
                        ${status.last_message ? '<div class="ai-meta" style="margin-top:6px;">状态：' + escapeHtml(status.last_message) + '</div>' : ''}
                        <div class="ai-actions">
                            <button class="ai-btn primary" data-action="save-task-retention">保存维护策略</button>
                            <button class="ai-btn warn" data-action="run-task-retention">立即清理一批</button>
                            <button class="ai-btn" data-action="reload-table-storage">刷新表占用</button>
                        </div>
                    </div>
                    <div>
                        <div class="ai-meta" style="margin-bottom:8px;">生成时间：${escapeHtml(fmtTime(storage.generated_at))} · 表数量：${fmtNumber(storage.existing_rows || rows.length || 0, 0)}</div>
                        <div class="ai-storage-list">${storageRows}</div>
                    </div>
                </div>
            </div>
        `;
    }

    function renderRelayConsole() {
        const status = state.relayConsoleStatus || {};
        const accounts = relayConsoleAccounts();
        const item = selectedRelayConsole() || {};
        const id = Number(item.id || 0);
        const adapterKey = item.adapter_key || 'newapi';
        const adapterMeta = relayAdapterMeta(adapterKey);
        const displayName = relayDisplayNameFor(adapterKey, item.display_name);
        const balance = id ? ((status.latest_balances && status.latest_balances[id]) || status.latest_balance || null) : null;
        const tokens = id ? (state.relayConsoleTokens[id] || []) : [];
        const availableModels = id ? (state.relayConsoleAvailableModels[id] || []) : [];
        const summary = relayConsoleSummary(id, balance, tokens);
        const accountOptions = (id ? [] : [{ value: '0', label: '新建中转站' }]).concat(accounts.map(function(account) {
            const name = relayDisplayNameFor(account.adapter_key, account.display_name);
            const label = (name || account.console_base_url || '中转站') + ' #' + account.id;
            return { value: String(account.id), label: label };
        }));
        const availableModelsHtml = availableModels.length
            ? '<div class="ai-model-chip-list">' + availableModels.slice(0, 36).map(function(model) {
                return '<span class="ai-model-chip">' + escapeHtml(model) + '</span>';
            }).join('') + (availableModels.length > 36 ? '<span class="ai-model-chip muted">+' + (availableModels.length - 36) + '</span>' : '') + '</div>'
            : '';
        const emptyTokenRow = availableModels.length
            ? '<tr><td colspan="4"><div class="ai-meta" style="margin-bottom:8px;">暂无 API Key，已读取控制台可用模型；先在中转站创建 Key 后再导入 Provider。</div>' + availableModelsHtml + '</td></tr>'
            : '<tr><td colspan="4" style="text-align:center;color:var(--text-secondary);">登录后点击“刷新 Token”</td></tr>';
        const tokenRows = tokens.map(function(token) {
            const modelKey = relayModelCacheKey(id, token.id);
            const models = state.relayConsoleModels[modelKey] || [];
            const modelHtml = models.length
                ? '<div class="ai-model-chip-list">' + models.slice(0, 18).map(function(model) {
                    return '<span class="ai-model-chip">' + escapeHtml(model) + '</span>';
                }).join('') + (models.length > 18 ? '<span class="ai-model-chip muted">+' + (models.length - 18) + '</span>' : '') + '</div>'
                : '';
            return `
                <tr>
                    <td>${escapeHtml(token.name || '-')}<div class="ai-meta">${escapeHtml(token.key_masked || token.id || '')}</div>${modelHtml}</td>
                    <td>${token.unlimited_quota ? '无限' : fmtNumber(token.remain_quota || 0, 0)}</td>
                    <td>${fmtNumber(token.used_quota || 0, 0)}</td>
                    <td>
                        <button class="ai-tier-save" data-action="relay-load-models" data-token-id="${escapeHtml(token.id)}">模型</button>
                        <button class="ai-tier-save" data-action="relay-sync" data-token-id="${escapeHtml(token.id)}">同步</button>
                        <button class="ai-tier-save" data-action="relay-import-provider" data-token-id="${escapeHtml(token.id)}">导入</button>
                    </td>
                </tr>
            `;
        }).join('') || emptyTokenRow;
        return `
            <div class="ai-card">
                <div class="ai-card-title">
                    <span>中转站控制台</span>
                    <span class="ai-tag ${item.enabled !== false ? 'ok' : 'bad'}">${item.enabled !== false ? '已启用' : '已停用'}</span>
                </div>
                <div class="ai-stat-grid relay">
                    <div class="ai-stat"><div class="ai-stat-label">可用 quota</div><div class="ai-stat-value">${summary.source === 'token' && !tokens.length ? '-' : fmtQuota(summary.available)}</div></div>
                    <div class="ai-stat"><div class="ai-stat-label">已用 quota</div><div class="ai-stat-value">${summary.source === 'token' && !tokens.length ? '-' : fmtQuota(summary.used)}</div></div>
                    <div class="ai-stat"><div class="ai-stat-label">总 quota</div><div class="ai-stat-value">${summary.source === 'token' && !tokens.length ? '-' : fmtQuota(summary.total)}</div></div>
                    <div class="ai-stat"><div class="ai-stat-label">${escapeHtml(summary.count_label || 'Token')}</div><div class="ai-stat-value">${summary.source === 'token' && !tokens.length ? '-' : fmtNumber(summary.count_value || 0, 0)}</div></div>
                </div>
                <div class="ai-form-grid">
                    ${renderSelectPicker('aiRelayConsoleSelected', '当前中转站', String(id || 0), accountOptions.length ? accountOptions : [{ value: '0', label: '新建中转站' }])}
                    ${renderSelectPicker('aiRelayConsoleAdapter', '适配器类型', adapterKey, relayAdapterOptions())}
                    <div class="ai-field"><label>显示名称</label><input class="ai-input" id="aiRelayDisplayName" value="${escapeHtml(displayName || adapterMeta.displayName)}"></div>
                    <div class="ai-field"><label>控制台地址</label><input class="ai-input" id="aiRelayBaseUrl" value="${escapeHtml(item.console_base_url || adapterMeta.baseUrl)}"></div>
                    <div class="ai-field"><label>控制台账号</label><input class="ai-input" id="aiRelayUsername" value="${escapeHtml(item.username || '')}" placeholder="登录邮箱或用户名"></div>
                    <div class="ai-field"><label>控制台用户 ID</label><input class="ai-input" id="aiRelayUserId" value="${escapeHtml(item.user_id || '')}" placeholder="登录后自动获取"></div>
                    <div class="ai-field"><label>低余额告警 quota</label><input class="ai-input" id="aiRelayLowBalance" type="number" min="0" step="1" value="${Number(item.low_balance_quota || 0)}"></div>
                    ${renderSelectPicker('aiRelayEnabled', '控制台开关', item.enabled === false ? 'false' : 'true', [{ value: 'true', label: '启用' }, { value: 'false', label: '停用' }])}
                </div>
                <div class="ai-secret-row provider">
                    <input class="ai-input" id="aiRelayPassword" type="password" placeholder="${item.has_password ? '已保存密码，留空则不更新' : '中转站控制台密码'}">
                    <button class="ai-btn success" data-action="relay-save-credentials" ${id ? '' : 'disabled title="请先保存控制台"'}>导入并登录</button>
                </div>
                <div class="ai-actions">
                    <button class="ai-btn primary" data-action="relay-save-console">${id ? '保存控制台' : '新增控制台'}</button>
                    <button class="ai-btn" data-action="relay-new-console">新建</button>
                    <button class="ai-btn" data-action="relay-login" ${item.has_password ? '' : 'disabled title="请先导入并登录"'}>重新登录</button>
                    <button class="ai-btn warn" data-action="relay-load-tokens" ${id ? '' : 'disabled'}>刷新 Token</button>
                </div>
                <table class="ai-table" style="margin-top:12px">
                    <thead><tr><th>Token / 模型</th><th>剩余</th><th>已用</th><th>操作</th></tr></thead>
                    <tbody>${tokenRows}</tbody>
                </table>
                ${item.last_error ? '<div class="ai-meta" style="color:var(--accent-red);margin-top:10px;">最近错误：' + escapeHtml(item.last_error) + '</div>' : ''}
            </div>
        `;
    }

    function relayModelCacheKey(consoleId, tokenId) {
        return String(consoleId || 0) + ':' + String(tokenId || '');
    }

    function renderBilling() {
        const overview = state.billingOverview || {};
        const cfg = state.billingConfig || overview.config || {};
        const tierCredits = cfg.tier_monthly_credit_units || {};
        const deductionMode = cfg.deduction_mode || 'per_request';
        const deductionModeLabel = deductionMode === 'per_token' ? '按 tokens 扣费' : '按次扣费';
        const rows = TIER_ORDER.map(function(tier) {
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
                    <span class="ai-tag">${escapeHtml(deductionModeLabel)}</span>
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
                    <div class="ai-field">
                        <label>扣费方式</label>
                        <select class="ai-select" id="aiBillingDeductionMode">
                            <option value="per_request" ${deductionMode !== 'per_token' ? 'selected' : ''}>按次扣额度</option>
                            <option value="per_token" ${deductionMode === 'per_token' ? 'selected' : ''}>按 tokens 扣额度</option>
                        </select>
                    </div>
                    <div class="ai-field"><label>单位名称</label><input class="ai-input" id="aiBillingUnitLabel" value="${escapeHtml(cfg.unit_label || 'AI额度')}"></div>
                    <div class="ai-field"><label>每次扣除额度</label><input class="ai-input" id="aiBillingUnitsPerRequest" type="number" min="1" step="1" value="${Number(cfg.user_units_per_request || 1)}"></div>
                    <div class="ai-field"><label>按 tokens：每 1K 扣费</label><input class="ai-input" id="aiBillingUnitsPer1k" type="number" min="0.01" step="0.01" value="${Number(cfg.user_units_per_1k_tokens || 1)}"></div>
                    <div class="ai-field"><label>按 tokens：倍率</label><input class="ai-input" id="aiBillingMarkup" type="number" min="0.01" step="0.01" value="${Number(cfg.default_markup || 1)}"></div>
                    <div class="ai-field"><label>按 tokens：最低扣费</label><input class="ai-input" id="aiBillingMinimum" type="number" min="0" value="${Number(cfg.minimum_charge_units || 1)}"></div>
                </div>
                <div class="ai-meta" style="margin-top:8px;">按次模式只在 AI 成功回复并写入聊天后扣除固定额度；失败、排队、额度不足不会扣费。</div>
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
            { label: '并发：' + Number(diag.queue_concurrency || 0), cls: Number(diag.queue_concurrency || 0) > 0 ? 'ok' : 'warn' },
            { label: '运行中：' + Number(diag.queue_running || 0), cls: Number(diag.queue_running || 0) > 0 ? 'warn' : 'ok' },
            { label: '排队中：' + Number(diag.queue_waiting || 0), cls: Number(diag.queue_waiting || 0) > 0 ? 'warn' : 'ok' }
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
        const tierRank = TIER_ORDER.reduce(function(acc, tier, index) {
            acc[tier] = index;
            return acc;
        }, {});
        const tiers = state.tiers.slice().sort(function(a, b) {
            const leftRank = Object.prototype.hasOwnProperty.call(tierRank, a.tier) ? tierRank[a.tier] : 999;
            const rightRank = Object.prototype.hasOwnProperty.call(tierRank, b.tier) ? tierRank[b.tier] : 999;
            if (leftRank !== rightRank) return leftRank - rightRank;
            return String(a.tier || '').localeCompare(String(b.tier || ''));
        });
        if (!tiers.length) return '<div class="ai-card"><div class="ai-empty">档位配置加载中...</div></div>';
        const rows = tiers.map(function(item) {
            return `
                <tr data-tier="${escapeHtml(item.tier)}">
                    <td><strong>${escapeHtml(TIER_LABELS[item.tier] || item.tier)}</strong><div class="ai-meta">${escapeHtml(item.tier)}</div></td>
                    <td><input data-field="tier_name" value="${escapeHtml(item.tier_name || TIER_LABELS[item.tier] || item.tier)}"></td>
                    <td><input data-field="daily_limit" type="number" min="0" value="${Number(item.daily_limit || 0)}"></td>
                    <td><input data-field="monthly_limit" type="number" min="0" value="${Number(item.monthly_limit || 0)}"></td>
                    <td><input data-field="memory_retention_days" type="number" min="1" value="${Number(item.memory_retention_days || 30)}"></td>
                    <td class="ai-tier-status"><label class="ai-check small"><input type="checkbox" data-field="enabled" ${item.enabled ? 'checked' : ''}><span>启用</span></label></td>
                    <td><button class="ai-btn ai-tier-save" data-action="save-tier" data-tier="${escapeHtml(item.tier)}">保存</button></td>
                </tr>
            `;
        }).join('');
        return `
            <div class="ai-card">
                <div class="ai-card-title"><span>权益档位</span><span class="ai-tag">试用 / 普通 / 进阶 / 荣耀 / 至尊</span></div>
                <div style="overflow:auto;">
                    <table class="ai-table ai-tier-table">
                        <thead><tr><th>档位</th><th>显示名</th><th>日额度</th><th>月额度</th><th>记忆天数</th><th>状态</th><th>操作</th></tr></thead>
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
                    ${renderSelectPicker('aiRedeemTier', '档位', 'basic', ['basic','advanced','honor','supreme'].map(function(t) { return { value: t, label: TIER_LABELS[t] || t }; }))}
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
                        ${renderMaintenance()}
                        ${renderBilling()}
                        ${renderTiers()}
                    </div>
                    <div>
                        ${renderRelayConsole()}
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
    }

    function readProviderPayload() {
        const current = selectedProvider() || {};
        const baseUrl = document.getElementById('aiProviderBaseUrl')?.value || '';
        if (looksLikeApiKey(baseUrl)) {
            throw new Error('Base URL 不能填写 sk 密钥，请填写 https://.../v1，并把 sk 填到 API Key 输入框');
        }
        return {
            id: Number(current.id || 0),
            provider_name: document.getElementById('aiProviderName')?.value || 'OpenAI-Compatible Relay',
            base_url: baseUrl,
            chat_model: document.getElementById('aiProviderChatModel')?.value || '',
            summary_model: document.getElementById('aiProviderSummaryModel')?.value || '',
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
                api('/admin/api/ai/task-retention'),
                api('/admin/api/ai/table-storage'),
                api('/admin/api/ai/relay-consoles'),
                api('/admin/api/ai/tiers'),
                api('/admin/api/ai/redeem-codes')
            ]);
            state.config = unwrapItem(results[0], {});
            state.diagnostics = unwrapItem(results[1], {});
            state.providers = unwrapItems(results[2]);
            state.billingConfig = unwrapItem(results[3], {});
            state.billingOverview = unwrapItem(results[4], {});
            state.taskRetention = unwrapItem(results[5], {});
            state.tableStorage = unwrapItem(results[6], {});
            state.relayConsoleStatus = unwrapItem(results[7], {});
            state.tiers = unwrapItems(results[8]);
            state.redeemCodes = unwrapItems(results[9]);
            if (!providerById(state.selectedProviderId)) {
                state.selectedProviderId = Number(state.providers[0] && state.providers[0].id || 0);
            }
            if (!relayConsoleById(state.selectedRelayConsoleId)) {
                const accounts = relayConsoleAccounts();
                state.selectedRelayConsoleId = Number(accounts[0] && accounts[0].id || 0);
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
            queue_concurrency: Number(document.getElementById('aiConfigQueueConcurrency')?.value || 3),
            context_summary_min_tokens: Number(document.getElementById('aiConfigSummaryTokens')?.value || 12000),
            context_recent_keep_tokens: Number(document.getElementById('aiConfigRecentTokens')?.value || 4000),
            context_scan_max_count: Number(document.getElementById('aiConfigScanMax')?.value || 200),
            group_mention_enabled: document.getElementById('aiConfigGroupMentionEnabled')?.value !== 'false',
            chat_context_max_messages: Number(document.getElementById('aiConfigChatContextMessages')?.value || 1000),
            chat_context_max_tokens: Number(document.getElementById('aiConfigChatContextTokens')?.value || 12000),
            chat_max_output_tokens: Number(document.getElementById('aiConfigChatMaxTokens')?.value || 0),
            summary_max_output_tokens: Number(document.getElementById('aiConfigSummaryMaxTokens')?.value || 0),
            summary_memory_max_tokens: Number(document.getElementById('aiConfigSummaryMemoryTokens')?.value || 0)
        };
        const data = await api('/admin/api/ai/config', { method: 'POST', body: JSON.stringify(payload) });
        state.config = unwrapItem(data, payload);
        if (state.diagnostics) {
            state.diagnostics.queue_concurrency = state.config.queue_concurrency;
        }
        showToast('AI 运行策略已保存');
        render();
    }

    function readTaskRetentionPayload() {
        return {
            enabled: document.getElementById('aiTaskRetentionEnabled')?.value !== 'false',
            retention_days: Number(document.getElementById('aiTaskRetentionDays')?.value || 30),
            cleanup_interval_hours: Number(document.getElementById('aiTaskRetentionInterval')?.value || 24),
            batch_limit: Number(document.getElementById('aiTaskRetentionBatch')?.value || 1000)
        };
    }

    async function loadTaskRetention() {
        const data = await api('/admin/api/ai/task-retention');
        state.taskRetention = unwrapItem(data, {});
        render();
    }

    async function loadTableStorage() {
        const data = await api('/admin/api/ai/table-storage');
        state.tableStorage = unwrapItem(data, {});
        render();
    }

    async function saveTaskRetention() {
        const payload = readTaskRetentionPayload();
        const data = await api('/admin/api/ai/task-retention', { method: 'POST', body: JSON.stringify(payload) });
        const policy = unwrapItem(data, payload);
        state.taskRetention = Object.assign({}, state.taskRetention || {}, {
            policy: policy,
            status: Object.assign({}, (state.taskRetention || {}).status || {}, { policy: policy })
        });
        showToast('AI 维护策略已保存');
        await loadTaskRetention();
    }

    async function runTaskRetentionCleanup() {
        const data = await api('/admin/api/ai/task-retention/cleanup', { method: 'POST', body: '{}' });
        const result = unwrapItem(data, {});
        showToast(result.skipped ? (result.message || '暂未清理') : 'AI 诊断数据已清理');
        await Promise.all([loadTaskRetention(), loadTableStorage()]);
    }

    function readBillingPayload() {
        const tierMonthlyCreditUnits = {};
        document.querySelectorAll('[data-billing-tier]').forEach(function(input) {
            tierMonthlyCreditUnits[input.dataset.billingTier] = Number(input.value || 0);
        });
        return {
            enabled: document.getElementById('aiBillingEnabled')?.value !== 'false',
            deduction_mode: document.getElementById('aiBillingDeductionMode')?.value || 'per_request',
            unit_label: document.getElementById('aiBillingUnitLabel')?.value || 'AI额度',
            user_units_per_request: Number(document.getElementById('aiBillingUnitsPerRequest')?.value || 1),
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

    function readRelayConsolePayload() {
        const current = selectedRelayConsole() || {};
        const adapterKey = document.getElementById('aiRelayConsoleAdapter')?.value || 'newapi';
        const adapterMeta = relayAdapterMeta(adapterKey);
        return {
            id: Number(current.id || 0),
            adapter_key: adapterKey,
            display_name: relayDisplayNameFor(adapterKey, document.getElementById('aiRelayDisplayName')?.value || adapterMeta.displayName),
            console_base_url: document.getElementById('aiRelayBaseUrl')?.value || adapterMeta.baseUrl,
            username: document.getElementById('aiRelayUsername')?.value || '',
            user_id: document.getElementById('aiRelayUserId')?.value || '',
            enabled: document.getElementById('aiRelayEnabled')?.value !== 'false',
            low_balance_quota: Number(document.getElementById('aiRelayLowBalance')?.value || 0)
        };
    }

    async function saveRelayConsole() {
        const data = await api('/admin/api/ai/relay-consoles', {
            method: 'POST',
            body: JSON.stringify(readRelayConsolePayload())
        });
        const item = unwrapItem(data, {});
        if (item && item.id) state.selectedRelayConsoleId = Number(item.id);
        showToast('中转站控制台已保存');
        await loadAll();
    }

    async function saveRelayCredentials() {
        const item = selectedRelayConsole();
        if (!item || !item.id) throw new Error('请先保存中转站控制台');
        const username = document.getElementById('aiRelayUsername')?.value || '';
        const password = document.getElementById('aiRelayPassword')?.value || '';
        if (!username.trim() || !password.trim()) throw new Error('请输入中转站控制台账号和密码');
        const data = await api('/admin/api/ai/relay-consoles/' + item.id + '/credentials', {
            method: 'POST',
            body: JSON.stringify({ username: username, password: password })
        });
        const saved = unwrapItem(data, {});
        if (saved && saved.id) state.selectedRelayConsoleId = Number(saved.id);
        showToast('中转站已登录，session 已加密保存');
        await loadAll();
    }

    async function relayLogin() {
        const item = selectedRelayConsole();
        if (!item || !item.id) throw new Error('请先选择中转站控制台');
        if (!item.has_password) throw new Error('请先导入控制台账号密码');
        await api('/admin/api/ai/relay-consoles/' + item.id + '/login', { method: 'POST', body: '{}' });
        showToast('中转站重新登录成功');
        await loadAll();
    }

    async function loadRelayTokens() {
        const item = selectedRelayConsole();
        if (!item || !item.id) throw new Error('请先选择中转站控制台');
        const data = await api('/admin/api/ai/relay-consoles/' + item.id + '/tokens');
        const payload = unwrapItem(data, {});
        state.relayConsoleTokens[item.id] = Array.isArray(payload.tokens) ? payload.tokens : [];
        state.relayConsoleAvailableModels[item.id] = Array.isArray(payload.available_models) ? payload.available_models : [];
        if (payload.account_usage) state.relayConsoleAccountUsage[item.id] = payload.account_usage;
        const tokenCount = state.relayConsoleTokens[item.id].length;
        const modelCount = state.relayConsoleAvailableModels[item.id].length;
        showToast(tokenCount ? ('已获取 ' + tokenCount + ' 个 Token') : (modelCount ? ('暂无 Token，已读取 ' + modelCount + ' 个可用模型') : '没有获取到 Token'));
        render();
    }

    async function syncRelayBalance(tokenId) {
        const item = selectedRelayConsole();
        if (!item || !item.id) throw new Error('请先选择中转站控制台');
        if (!String(tokenId || '').trim()) throw new Error('缺少 token_id');
        await api('/admin/api/ai/relay-consoles/' + item.id + '/sync', {
            method: 'POST',
            body: JSON.stringify({ token_id: String(tokenId || '') })
        });
        showToast('中转站余额已同步');
        await loadAll();
    }

    async function loadRelayModels(tokenId) {
        const item = selectedRelayConsole();
        if (!item || !item.id) throw new Error('请先选择中转站控制台');
        if (!String(tokenId || '').trim()) throw new Error('缺少 token_id');
        const data = await api('/admin/api/ai/relay-consoles/' + item.id + '/models', {
            method: 'POST',
            body: JSON.stringify({ token_id: String(tokenId || '') })
        });
        const payload = unwrapItem(data, {});
        const models = Array.isArray(payload.models) ? payload.models : [];
        state.relayConsoleModels[relayModelCacheKey(item.id, tokenId)] = models;
        showToast(models.length ? ('已获取 ' + models.length + ' 个模型') : '模型列表为空', models.length ? undefined : 'error');
        render();
    }

    async function importRelayProvider(tokenId) {
        const item = selectedRelayConsole();
        if (!item || !item.id) throw new Error('请先选择中转站控制台');
        if (!String(tokenId || '').trim()) throw new Error('缺少 token_id');
        const data = await api('/admin/api/ai/relay-consoles/' + item.id + '/import-provider', {
            method: 'POST',
            body: JSON.stringify({ token_id: String(tokenId || '') })
        });
        const provider = unwrapItem(data, {});
        if (provider && provider.id) state.selectedProviderId = Number(provider.id);
        showToast('Token 已导入为 Provider');
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
        const baseUrl = document.getElementById('aiProviderBaseUrl')?.value || '';
        if (looksLikeApiKey(baseUrl)) {
            throw new Error('你把 sk 填到了 Base URL。请先把 Base URL 改成 https://.../v1，再导入 API Key');
        }
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
        const model = document.getElementById('aiProviderChatModel')?.value || '';
        const data = await api('/admin/api/ai/providers/' + provider.id + '/test', {
            method: 'POST',
            body: JSON.stringify({ prompt: prompt, model: model })
        });
        const item = unwrapItem(data, {});
        const probeText = item.probe ? (' · ' + item.probe) : '';
        const modelText = item.model ? (' · ' + item.model) : '';
        const contentText = item.content ? (' · 回复：' + item.content) : '';
        const message = item.ok
            ? ('模型回复测试成功：' + item.latency_ms + 'ms' + probeText + modelText + contentText)
            : ('模型回复测试失败：' + (item.message || '-'));
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

    async function deleteProvider() {
        const provider = selectedProvider();
        if (!provider || !provider.id) throw new Error('请先选择 Provider');
        const name = provider.provider_name || ('#' + provider.id);
        if (!confirm('确定删除 Provider「' + name + '」吗？')) return;
        await api('/admin/api/ai/providers/' + provider.id, { method: 'DELETE' });
        state.selectedProviderId = 0;
        showToast('Provider 已删除');
        await loadAll();
    }

    async function saveTier(tier) {
        const row = Array.prototype.slice.call(document.querySelectorAll('#aiAssistant tr[data-tier]')).find(function(item) {
            return String(item.dataset.tier || '') === String(tier || '');
        });
        if (!row) return;
        const payload = {
            tier: tier,
            tier_name: row.querySelector('[data-field="tier_name"]')?.value || TIER_LABELS[tier] || tier,
            daily_limit: Number(row.querySelector('[data-field="daily_limit"]')?.value || 0),
            monthly_limit: Number(row.querySelector('[data-field="monthly_limit"]')?.value || 0),
            memory_retention_days: Number(row.querySelector('[data-field="memory_retention_days"]')?.value || 30),
            enabled: !!row.querySelector('[data-field="enabled"]')?.checked
        };
        const data = await api('/admin/api/ai/tiers', { method: 'POST', body: JSON.stringify(payload) });
        const saved = unwrapItem(data, payload);
        state.tiers = state.tiers.map(function(item) {
            return String(item.tier || '') === String(saved.tier || tier) ? Object.assign({}, item, saved) : item;
        });
        if (!state.tiers.some(function(item) { return String(item.tier || '') === String(saved.tier || tier); })) {
            state.tiers.push(saved);
        }
        showToast('设置已保存');
        render();
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
        if (action === 'relay-new-console') {
            state.selectedRelayConsoleId = 0;
            render();
            return;
        }
        if (action === 'save-config') return saveConfig();
        if (action === 'save-task-retention') return saveTaskRetention();
        if (action === 'run-task-retention') return runTaskRetentionCleanup();
        if (action === 'reload-table-storage') return loadTableStorage();
        if (action === 'save-billing-config') return saveBillingConfig();
        if (action === 'relay-save-console') return saveRelayConsole();
        if (action === 'relay-save-credentials') return saveRelayCredentials();
        if (action === 'relay-login') return relayLogin();
        if (action === 'relay-load-tokens') return loadRelayTokens();
        if (action === 'relay-load-models') return loadRelayModels(target.dataset.tokenId || '');
        if (action === 'relay-sync') return syncRelayBalance(target.dataset.tokenId || '');
        if (action === 'relay-import-provider') return importRelayProvider(target.dataset.tokenId || '');
        if (action === 'save-provider') return saveProvider();
        if (action === 'save-secret') return saveSecret();
        if (action === 'test-provider') return testProvider();
        if (action === 'refresh-provider-models') return refreshProviderModels();
        if (action === 'delete-provider') return deleteProvider();
        if (action === 'save-tier') return saveTier(target.dataset.tier || '');
        if (action === 'create-redeem') return createRedeem();
    }

    function closeModelMenus(exceptField) {
        document.querySelectorAll('#aiAssistant [data-model-picker]').forEach(function(field) {
            if (exceptField && field === exceptField) return;
            const menu = field.querySelector('[data-model-menu]');
            if (menu) menu.hidden = true;
            field.classList.remove('open');
        });
    }

    function updateModelMenu(field, showAll) {
        if (!field) return;
        const input = field.querySelector('[data-model-input]');
        const selectedValue = String(input && input.value || '').trim();
        const term = showAll ? '' : selectedValue.toLowerCase();
        let visibleCount = 0;
        field.querySelectorAll('[data-model-option]').forEach(function(option) {
            const value = String(option.dataset.modelValue || option.textContent || '').trim();
            const matched = !term || value.toLowerCase().indexOf(term) >= 0;
            option.hidden = !matched;
            option.classList.toggle('active', !!selectedValue && value === selectedValue);
            if (matched) visibleCount += 1;
        });
        const noMatch = field.querySelector('.ai-model-no-match');
        if (noMatch) noMatch.hidden = visibleCount > 0 || !term;
    }

    function openModelMenu(field, showAll) {
        if (!field) return;
        const menu = field.querySelector('[data-model-menu]');
        if (!menu) return;
        closeModelMenus(field);
        closeSelectMenus();
        updateModelMenu(field, !!showAll);
        menu.hidden = false;
        field.classList.add('open');
    }

    function selectModelOption(option) {
        if (!option) return;
        const field = option.closest('[data-model-picker]');
        const input = field && field.querySelector('[data-model-input]');
        if (!input) return;
        input.value = String(option.dataset.modelValue || option.textContent || '').trim();
        input.dispatchEvent(new Event('change', { bubbles: true }));
        closeModelMenus();
        input.blur();
    }

    function closeSelectMenus(exceptField) {
        document.querySelectorAll('#aiAssistant [data-select-picker]').forEach(function(field) {
            if (exceptField && field === exceptField) return;
            const menu = field.querySelector('[data-select-menu]');
            if (menu) menu.hidden = true;
            field.classList.remove('open');
        });
    }

    function openSelectMenu(field) {
        if (!field) return;
        const menu = field.querySelector('[data-select-menu]');
        if (!menu) return;
        closeSelectMenus(field);
        closeModelMenus();
        menu.hidden = false;
        field.classList.add('open');
    }

    function applyRelayAdapterDefaults(adapterKey) {
        const meta = relayAdapterMeta(adapterKey);
        const displayInput = document.getElementById('aiRelayDisplayName');
        const baseInput = document.getElementById('aiRelayBaseUrl');
        if (displayInput) {
            const current = String(displayInput.value || '').trim();
            if (!current || isRelayDefaultDisplayName(current)) displayInput.value = meta.displayName;
        }
        if (baseInput) {
            const current = String(baseInput.value || '').trim().replace(/\/+$/, '');
            const isKnownDefault = RELAY_ADAPTERS.some(function(item) {
                return current === item.baseUrl;
            });
            if (!current || isKnownDefault) baseInput.value = meta.baseUrl;
        }
    }

    function selectPickerOption(option) {
        if (!option) return;
        const field = option.closest('[data-select-picker]');
        const input = field && field.querySelector('.ai-select-hidden');
        const label = field && field.querySelector('[data-select-label]');
        if (!input) return;
        const value = String(option.dataset.selectValue || option.textContent || '').trim();
        input.value = value;
        if (label) label.textContent = String(option.textContent || value).trim();
        field.querySelectorAll('[data-select-option]').forEach(function(item) {
            item.classList.toggle('active', item === option);
        });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (input.id === 'aiRelayConsoleSelected') {
            state.selectedRelayConsoleId = Number(value || 0);
            closeSelectMenus();
            render();
            return;
        }
        if (input.id === 'aiRelayConsoleAdapter') {
            applyRelayAdapterDefaults(value);
        }
        closeSelectMenus();
    }

    function bindEvents() {
        const el = mount();
        if (!el || el.dataset.aiBound === '1') return;
        el.dataset.aiBound = '1';
        el.addEventListener('click', function(event) {
            const selectOption = event.target.closest('[data-select-option]');
            if (selectOption && el.contains(selectOption)) {
                event.preventDefault();
                selectPickerOption(selectOption);
                return;
            }

            const selectToggle = event.target.closest('[data-select-toggle]');
            if (selectToggle && el.contains(selectToggle)) {
                event.preventDefault();
                const field = selectToggle.closest('[data-select-picker]');
                if (field && field.classList.contains('open')) closeSelectMenus();
                else openSelectMenu(field);
                return;
            }

            const modelOption = event.target.closest('[data-model-option]');
            if (modelOption && el.contains(modelOption)) {
                event.preventDefault();
                selectModelOption(modelOption);
                return;
            }

            const modelToggle = event.target.closest('[data-model-toggle]');
            if (modelToggle && el.contains(modelToggle)) {
                event.preventDefault();
                const field = modelToggle.closest('[data-model-picker]');
                if (field && field.classList.contains('open')) closeModelMenus();
                else openModelMenu(field, true);
                return;
            }

            const modelInput = event.target.closest('[data-model-input]');
            if (modelInput && el.contains(modelInput)) {
                openModelMenu(modelInput.closest('[data-model-picker]'), true);
                return;
            }

            const target = event.target.closest('[data-action]');
            if (!target || !el.contains(target)) return;
            event.preventDefault();
            const action = target.dataset.action || '';
            Promise.resolve(handleAction(action, target)).catch(function(e) {
                showToast(e.message || '操作失败', 'error');
            });
        });
        el.addEventListener('focusin', function(event) {
            const modelInput = event.target.closest('[data-model-input]');
            if (modelInput && el.contains(modelInput)) {
                openModelMenu(modelInput.closest('[data-model-picker]'), true);
            }
        });
        el.addEventListener('input', function(event) {
            const modelInput = event.target.closest('[data-model-input]');
            if (modelInput && el.contains(modelInput)) {
                const field = modelInput.closest('[data-model-picker]');
                openModelMenu(field, false);
            }
        });
        if (!global.__AKAIAssistantModelPickerBound) {
            global.__AKAIAssistantModelPickerBound = true;
            document.addEventListener('click', function(event) {
                if (event.target.closest && event.target.closest('#aiAssistant [data-model-picker]')) return;
                if (event.target.closest && event.target.closest('#aiAssistant [data-select-picker]')) return;
                closeModelMenus();
                closeSelectMenus();
            });
            document.addEventListener('keydown', function(event) {
                if (event.key === 'Escape') {
                    closeModelMenus();
                    closeSelectMenus();
                }
            });
        }
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
