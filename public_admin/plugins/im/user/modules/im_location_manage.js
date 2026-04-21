(function(global) {
    'use strict';

    const DEFAULT_MAP_ZOOM = 16;
    const HIGH_ACCURACY_LOCATION_TIMEOUT = 10000;
    const BASIC_LOCATION_TIMEOUT = 18000;
    const SEARCH_SUGGESTION_LIMIT = 6;
    const SEARCH_RESULT_LIMIT = 6;
    const SEARCH_DEBOUNCE_MS = 180;
    const OPEN_MAP_APP_FALLBACK_DELAY_MS = 900;
    const LOCATION_PROVIDER = 'amap';
    const LOCATION_COORDINATE = 'gaode';
    const LOCATION_SOURCE_APPLICATION = 'ak-proxy';

    const locationManageModule = {
        ctx: null,
        styleReady: false,
        pickerEl: null,
        mapEl: null,
        titleEl: null,
        addressEl: null,
        metaEl: null,
        statusEl: null,
        confirmBtnEl: null,
        searchInputEl: null,
        searchSubmitEl: null,
        searchTipsEl: null,
        searchResultsEl: null,
        map: null,
        marker: null,
        geocoder: null,
        geocoderPromise: null,
        geolocation: null,
        geolocationPromise: null,
        geolocationAttached: false,
        coarseGeolocation: null,
        coarseGeolocationPromise: null,
        coarseGeolocationAttached: false,
        amapPromise: null,
        autocomplete: null,
        autocompletePromise: null,
        placeSearch: null,
        placeSearchPromise: null,
        selectedPayload: null,
        isSending: false,
        isLocating: false,
        isSearching: false,
        searchSuggestionItems: null,
        searchResultItems: null,
        searchDebounceTimer: null,
        searchRequestToken: 0,
        bubbleLinkBound: false,

        init(ctx) {
            this.ctx = ctx || null;
            this.ensureStyle();
            this.ensureBubbleLinkBinding();
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        escapeHtml(value) {
            if (this.ctx && typeof this.ctx.escapeHtml === 'function') {
                return this.ctx.escapeHtml(value);
            }
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },

        escapeAttribute(value) {
            return this.escapeHtml(value).replace(/`/g, '&#96;');
        },

        getLocationConfig() {
            const raw = global.__AK_IM_LOCATION__;
            if (!raw || typeof raw !== 'object') {
                return {
                    amapWebKey: '',
                    amapSecurityJsCode: ''
                };
            }
            return {
                amapWebKey: String(raw.amapWebKey || '').trim(),
                amapSecurityJsCode: String(raw.amapSecurityJsCode || '').trim()
            };
        },

        normalizeCoordinate(value, min, max) {
            const numericValue = Number(value);
            if (!isFinite(numericValue)) return null;
            if (numericValue < min || numericValue > max) return null;
            return Math.round(numericValue * 1000000) / 1000000;
        },

        formatCoordinate(value) {
            const numericValue = Number(value);
            if (!isFinite(numericValue)) return '';
            return (Math.round(numericValue * 1000000) / 1000000).toFixed(6);
        },

        extractErrorText(raw) {
            if (!raw) return '';
            if (typeof raw === 'string') {
                return String(raw || '').trim();
            }
            const candidates = [raw.message, raw.info, raw.reason, raw.details, raw.type];
            for (let index = 0; index < candidates.length; index += 1) {
                const candidate = String(candidates[index] || '').trim();
                if (candidate) return candidate;
            }
            return '';
        },

        buildErrorDetailText(raw) {
            if (!raw) return '';
            if (typeof raw === 'string') {
                return String(raw || '').trim();
            }
            const fields = ['info', 'message', 'reason', 'details', 'type'];
            const seen = {};
            const parts = [];
            for (let index = 0; index < fields.length; index += 1) {
                const fieldName = fields[index];
                const fieldValue = String(raw[fieldName] || '').trim();
                if (!fieldValue || seen[fieldValue]) continue;
                seen[fieldValue] = true;
                parts.push(fieldName + '=' + fieldValue);
            }
            return parts.join(' | ');
        },

        reportGeolocationDiagnostics(status, detail) {
            if (!global.console || typeof global.console.warn !== 'function') return;
            global.console.warn('[AKIM][location] geolocation failed', {
                status: String(status || '').trim(),
                detail: detail || null,
                isSecureContext: !!global.isSecureContext,
                userAgent: String(global.navigator && global.navigator.userAgent || '').trim()
            });
        },

        buildGeolocationContextText(status) {
            const parts = [];
            const statusText = String(status || '').trim();
            if (statusText) parts.push('status=' + statusText);
            parts.push('secureContext=' + String(!!global.isSecureContext));
            return parts.join(' | ');
        },

        buildSearchFallbackMessage() {
            return '当前浏览器不支持稳定自动定位，请使用QQ浏览器，或通过搜索定位/地图选点';
        },

        buildGeolocationErrorMessage(status, detail) {
            const statusText = String(status || '').trim();
            const detailText = this.extractErrorText(detail);
            const detailLine = this.buildErrorDetailText(detail);
            const contextLine = this.buildGeolocationContextText(statusText);
            const debugLine = [contextLine, detailLine].filter(Boolean).join(' | ');
            const combinedText = [statusText, detailText, detailLine].filter(Boolean).join(' ');
            this.reportGeolocationDiagnostics(statusText, detail);
            if (/get geolocation time\s*out/i.test(combinedText) && /get iplocation failed/i.test(combinedText)) {
                if (this.isMobileBrowser()) {
                    return this.buildSearchFallbackMessage();
                }
            }
            if (/permission|denied|forbidden|unauthorized|定位权限|授权/i.test(combinedText)) {
                if (this.isMobileBrowser()) {
                    return '当前浏览器自动定位不可用，请检查定位权限，或通过搜索定位/地图选点';
                }
                return '定位权限被拒绝，请开启浏览器定位权限后重试';
            }
            if (/timeout|超时/i.test(combinedText)) {
                if (this.isMobileBrowser()) {
                    return '自动定位超时，请通过搜索定位或地图选点';
                }
                return '定位超时，请重试或点击地图选择位置';
            }
            if (/https|secure|insecure|origin|protocol/i.test(combinedText)) {
                return '当前环境不支持浏览器定位，请通过搜索定位或地图选点';
            }
            if (this.isMobileBrowser()) {
                return '自动定位失败，请通过搜索定位或地图选点';
            }
            if (detailText) {
                return '定位失败：' + detailText;
            }
            if (statusText) {
                return '定位失败：status=' + statusText;
            }
            return '定位失败，请点击地图选择位置';
        },

        isMobileBrowser() {
            const userAgent = String(global.navigator && global.navigator.userAgent || '').trim();
            return /android|iphone|ipad|ipod|mobile|harmonyos/i.test(userAgent);
        },

        isAndroidBrowser() {
            const userAgent = String(global.navigator && global.navigator.userAgent || '').trim();
            return /android/i.test(userAgent);
        },

        isIOSBrowser() {
            const userAgent = String(global.navigator && global.navigator.userAgent || '').trim();
            return /iphone|ipad|ipod/i.test(userAgent);
        },

        isMobileEdgeBrowser() {
            const userAgent = String(global.navigator && global.navigator.userAgent || '').trim();
            return /edga|edgios|edge/i.test(userAgent) && this.isMobileBrowser();
        },

        isMobileChromiumBrowser() {
            const userAgent = String(global.navigator && global.navigator.userAgent || '').trim();
            return this.isMobileBrowser() && /chrome|crios|edga|edgios/i.test(userAgent) && !/qqbrowser/i.test(userAgent);
        },

        isGeolocationTimeoutError(error) {
            const message = String(error && error.message || '').trim();
            return /定位超时|timeout|超时/i.test(message);
        },

        ensureBubbleLinkBinding() {
            if (this.bubbleLinkBound || !global.document || typeof global.document.addEventListener !== 'function') return;
            const self = this;
            global.document.addEventListener('click', function(event) {
                self.handleLocationBubbleClick(event);
            }, true);
            this.bubbleLinkBound = true;
        },

        handleLocationBubbleClick(event) {
            const target = event && event.target && typeof event.target.closest === 'function'
                ? event.target.closest('[data-ak-im-location-open="1"]')
                : null;
            if (!target || !this.isMobileBrowser()) return;
            const appUrl = String(target.getAttribute('data-ak-im-location-app-url') || '').trim();
            if (!appUrl) return;
            const webUrl = String(target.getAttribute('data-ak-im-location-web-url') || target.getAttribute('href') || '').trim();
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            this.openMapWithFallback(appUrl, webUrl);
        },

        navigateToMapUrl(url, target) {
            const nextUrl = String(url || '').trim();
            if (!nextUrl) return;
            if (target === '_blank' && typeof global.open === 'function') {
                const openedWindow = global.open(nextUrl, '_blank', 'noopener,noreferrer');
                if (openedWindow && typeof openedWindow.opener !== 'undefined') {
                    try {
                        openedWindow.opener = null;
                    } catch (error) {
                    }
                }
                return;
            }
            if (global.location && typeof global.location.assign === 'function') {
                global.location.assign(nextUrl);
                return;
            }
            if (global.location) {
                global.location.href = nextUrl;
            }
        },

        openMapWithFallback(appUrl, webUrl) {
            const finalAppUrl = String(appUrl || '').trim();
            const finalWebUrl = String(webUrl || '').trim();
            if (!finalAppUrl) {
                this.navigateToMapUrl(finalWebUrl, this.isMobileBrowser() ? '_self' : '_blank');
                return;
            }
            const self = this;
            const doc = global.document;
            let cleaned = false;
            let fallbackTimer = null;
            const cleanup = function() {
                if (cleaned) return;
                cleaned = true;
                if (fallbackTimer) {
                    global.clearTimeout(fallbackTimer);
                    fallbackTimer = null;
                }
                if (doc && typeof doc.removeEventListener === 'function') {
                    doc.removeEventListener('visibilitychange', handleVisibilityChange, true);
                }
                if (typeof global.removeEventListener === 'function') {
                    global.removeEventListener('pagehide', handlePageExit, true);
                    global.removeEventListener('blur', handlePageExit, true);
                }
            };
            const handleVisibilityChange = function() {
                if (doc && doc.hidden) {
                    cleanup();
                }
            };
            const handlePageExit = function() {
                cleanup();
            };
            if (doc && typeof doc.addEventListener === 'function') {
                doc.addEventListener('visibilitychange', handleVisibilityChange, true);
            }
            if (typeof global.addEventListener === 'function') {
                global.addEventListener('pagehide', handlePageExit, true);
                global.addEventListener('blur', handlePageExit, true);
            }
            fallbackTimer = global.setTimeout(function() {
                cleanup();
                if (finalWebUrl) {
                    self.navigateToMapUrl(finalWebUrl, '_self');
                }
            }, OPEN_MAP_APP_FALLBACK_DELAY_MS);
            try {
                this.navigateToMapUrl(finalAppUrl, '_self');
            } catch (error) {
                cleanup();
                if (finalWebUrl) {
                    this.navigateToMapUrl(finalWebUrl, '_self');
                }
            }
        },

        attachGeolocationControl(geolocation, attachedFlagKey) {
            if (!this.map || !geolocation || !attachedFlagKey || this[attachedFlagKey]) return;
            if (typeof this.map.addControl !== 'function') return;
            try {
                this.map.addControl(geolocation);
                this[attachedFlagKey] = true;
            } catch (error) {
                this[attachedFlagKey] = false;
            }
        },

        buildGeolocationOptions(overrides) {
            return Object.assign({
                enableHighAccuracy: true,
                timeout: HIGH_ACCURACY_LOCATION_TIMEOUT,
                showButton: false,
                showMarker: false,
                showCircle: false,
                zoomToAccuracy: false
            }, overrides || {});
        },

        normalizePayload(raw) {
            let payload = raw;
            if (typeof payload === 'string') {
                const contentText = String(payload || '').trim();
                if (!contentText) return null;
                try {
                    payload = JSON.parse(contentText);
                } catch (e) {
                    return null;
                }
            }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
            const longitude = this.normalizeCoordinate(payload.longitude != null ? payload.longitude : (payload.lng != null ? payload.lng : payload.lon), -180, 180);
            const latitude = this.normalizeCoordinate(payload.latitude != null ? payload.latitude : payload.lat, -90, 90);
            if (longitude == null || latitude == null) return null;
            return {
                longitude: longitude,
                latitude: latitude,
                name: String(payload.name || payload.title || '').trim(),
                address: String(payload.address || payload.formattedAddress || '').trim(),
                coordinate: String(payload.coordinate || LOCATION_COORDINATE).trim() || LOCATION_COORDINATE,
                provider: String(payload.provider || LOCATION_PROVIDER).trim() || LOCATION_PROVIDER
            };
        },

        resolveMessagePayload(item) {
            if (String(item && item.message_type || '').trim().toLowerCase() !== 'location') return null;
            return this.normalizePayload(item && item.content);
        },

        buildStyleText() {
            return `
                #ak-im-root .ak-im-bubble.ak-im-bubble-location{padding:0;display:block;white-space:normal;overflow:hidden;border-radius:18px;min-width:0}
                #ak-im-root .ak-im-location-bubble-link,#ak-im-root .ak-im-location-bubble-surface{display:flex;align-items:center;gap:12px;min-width:min(236px,64vw);padding:12px 14px;box-sizing:border-box;color:inherit;text-decoration:none;background:linear-gradient(135deg,#ecfeff 0%,#f8fafc 100%)}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-location-bubble-link,#ak-im-root .ak-im-message-row.ak-self .ak-im-location-bubble-surface{background:linear-gradient(135deg,#daf6c6 0%,#eef9dd 100%)}
                #ak-im-root .ak-im-location-bubble-icon{width:48px;height:48px;border-radius:16px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;background:linear-gradient(180deg,#0ea5e9 0%,#2563eb 100%);color:#ffffff;box-shadow:0 8px 18px rgba(37,99,235,.18)}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-location-bubble-icon{background:linear-gradient(180deg,#16a34a 0%,#22c55e 100%);box-shadow:0 8px 18px rgba(34,197,94,.18)}
                #ak-im-root .ak-im-location-bubble-icon svg{width:24px;height:24px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
                #ak-im-root .ak-im-location-bubble-body{min-width:0;display:flex;flex-direction:column;gap:4px}
                #ak-im-root .ak-im-location-bubble-badge{display:inline-flex;align-items:center;justify-content:center;width:fit-content;max-width:100%;padding:0 8px;height:20px;border-radius:999px;background:rgba(37,99,235,.12);color:#1d4ed8;font-size:11px;font-weight:700;line-height:1}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-location-bubble-badge{background:rgba(22,163,74,.14);color:#166534}
                #ak-im-root .ak-im-location-bubble-title{font-size:14px;font-weight:700;line-height:1.35;color:#0f172a;word-break:break-word}
                #ak-im-root .ak-im-location-bubble-address{font-size:12px;line-height:1.45;color:#475569;word-break:break-word}
                #ak-im-root .ak-im-location-bubble-meta{font-size:11px;line-height:1.45;color:#64748b;word-break:break-word}
                .ak-im-location-picker{position:fixed;inset:0;z-index:2147483647;display:none}
                .ak-im-location-picker.is-open{display:block}
                .ak-im-location-picker-page{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;overflow:hidden;background:#ededed}
                .ak-im-location-picker-topbar{height:calc(56px + env(safe-area-inset-top, 0px));padding:calc(env(safe-area-inset-top, 0px) + 8px) 12px 8px;display:grid;grid-template-columns:52px 1fr 52px;align-items:center;background:#ededed;border-bottom:1px solid rgba(15,23,42,.06);box-sizing:border-box}
                .ak-im-location-picker-nav{height:34px;border:none;background:transparent;color:#111827;padding:0 8px;font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:10px}
                .ak-im-location-picker-nav svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
                .ak-im-location-picker-topbar-title{text-align:center;min-width:0;font-size:17px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                .ak-im-location-picker-topbar-side{width:34px;height:34px;justify-self:end}
                .ak-im-location-picker-search-strip{padding:10px 12px 12px;background:#ededed;border-bottom:1px solid rgba(15,23,42,.04)}
                .ak-im-location-picker-hint{font-size:12px;line-height:1.6;color:#6b7280}
                .ak-im-location-picker-search{margin-top:10px;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;border-radius:14px;background:#ffffff;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                .ak-im-location-picker-search input{flex:1 1 auto;min-width:0;height:36px;border:none;outline:none;background:transparent;color:#111827;font-size:14px;line-height:1.4}
                .ak-im-location-picker-search input::placeholder{color:#9ca3af}
                .ak-im-location-picker-search-btn{height:36px;border:none;border-radius:12px;padding:0 14px;background:#f3f4f6;color:#111827;font-size:14px;font-weight:600;cursor:pointer;flex:0 0 auto}
                .ak-im-location-picker-search-btn:disabled{opacity:.55;cursor:default}
                .ak-im-location-picker-body{position:relative;flex:1;overflow:auto;padding:12px 12px calc(92px + env(safe-area-inset-bottom, 0px));display:flex;flex-direction:column;gap:12px;min-height:0;background:#f7f7f7}
                .ak-im-location-picker-search-tips,.ak-im-location-picker-search-results{display:flex;flex-direction:column;gap:10px}
                .ak-im-location-picker-search-tips:empty,.ak-im-location-picker-search-results:empty{display:none}
                .ak-im-location-picker-search-card{border:none;background:#ffffff;border-radius:18px;padding:14px 14px;display:flex;flex-direction:column;gap:6px;align-items:flex-start;text-align:left;box-shadow:0 1px 2px rgba(15,23,42,.04);cursor:pointer}
                .ak-im-location-picker-search-card.is-passive{cursor:default}
                .ak-im-location-picker-search-card-title{font-size:14px;font-weight:700;line-height:1.4;color:#111827;word-break:break-word}
                .ak-im-location-picker-search-card-meta{font-size:12px;line-height:1.5;color:#6b7280;word-break:break-word}
                .ak-im-location-picker-search-card-tag{display:inline-flex;align-items:center;justify-content:center;min-height:20px;padding:0 8px;border-radius:999px;background:rgba(7,193,96,.12);color:#16a34a;font-size:11px;font-weight:700}
                .ak-im-location-picker-map{height:min(38vh,320px);border-radius:18px;overflow:hidden;background:#eef2f7;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                .ak-im-location-picker-summary{padding:16px 14px;border-radius:18px;background:#ffffff;box-shadow:0 1px 2px rgba(15,23,42,.04);display:flex;flex-direction:column;gap:6px}
                .ak-im-location-picker-summary-title{font-size:15px;font-weight:700;line-height:1.4;color:#111827;word-break:break-word}
                .ak-im-location-picker-summary-address{font-size:13px;line-height:1.6;color:#4b5563;word-break:break-word}
                .ak-im-location-picker-summary-meta{font-size:12px;line-height:1.5;color:#9ca3af;word-break:break-word}
                .ak-im-location-picker-status{display:none;padding:11px 12px;border-radius:14px;font-size:13px;line-height:1.6;border:1px solid transparent}
                .ak-im-location-picker-status.has-text{display:block}
                .ak-im-location-picker-status.is-error{background:rgba(239,68,68,.08);color:#dc2626;border-color:rgba(239,68,68,.12)}
                .ak-im-location-picker-status.has-text:not(.is-error){background:#eff6ff;color:#2563eb;border-color:#bfdbfe}
                .ak-im-location-picker-footer{position:absolute;left:0;right:0;bottom:0;padding:12px 12px calc(12px + env(safe-area-inset-bottom, 0px));background:linear-gradient(180deg,rgba(247,247,247,0) 0%,#f7f7f7 28%,#f7f7f7 100%)}
                .ak-im-location-picker-btn{width:100%;height:48px;border:none;border-radius:14px;font-size:16px;font-weight:700;cursor:pointer}
                .ak-im-location-picker-btn:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
                .ak-im-location-picker-btn.is-primary{background:#07c160;color:#ffffff;box-shadow:0 10px 24px rgba(7,193,96,.18)}
                @media (max-width: 520px){
                    .ak-im-location-picker-topbar{padding:calc(env(safe-area-inset-top, 0px) + 8px) 10px 8px}
                    .ak-im-location-picker-search-strip{padding:10px 10px 12px}
                    .ak-im-location-picker-body{padding:12px 10px calc(90px + env(safe-area-inset-bottom, 0px))}
                    .ak-im-location-picker-footer{padding:12px 10px calc(12px + env(safe-area-inset-bottom, 0px))}
                    .ak-im-location-picker-map{height:min(40vh,330px)}
                }
            `;
        },

        ensureStyle() {
            if (this.styleReady) return;
            let styleEl = document.getElementById('ak-im-location-manage-style');
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = 'ak-im-location-manage-style';
                styleEl.textContent = this.buildStyleText();
                (document.head || document.documentElement).appendChild(styleEl);
            }
            this.styleReady = true;
        },

        ensurePicker() {
            if (this.pickerEl) return;
            const wrapper = document.createElement('div');
            wrapper.className = 'ak-im-location-picker';
            wrapper.setAttribute('aria-hidden', 'true');
            wrapper.innerHTML = '' +
                '<div class="ak-im-location-picker-page" role="dialog" aria-modal="true" aria-label="位置选择器">' +
                    '<div class="ak-im-location-picker-topbar">' +
                        '<button type="button" class="ak-im-location-picker-nav" data-ak-im-location-close-btn="1" aria-label="返回聊天页面">' +
                            '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6"></path></svg>' +
                        '</button>' +
                        '<div class="ak-im-location-picker-topbar-title">发送位置</div>' +
                        '<div class="ak-im-location-picker-topbar-side" aria-hidden="true"></div>' +
                    '</div>' +
                    '<div class="ak-im-location-picker-search-strip">' +
                        '<div class="ak-im-location-picker-hint">优先尝试定位当前位置；自动定位不稳定时，可直接搜索地点或点击地图选点。</div>' +
                        '<div class="ak-im-location-picker-search">' +
                            '<input type="search" autocomplete="off" enterkeyhint="search" placeholder="搜索小区、商场、写字楼、地铁站" data-ak-im-location-search-input="1" />' +
                            '<button type="button" class="ak-im-location-picker-search-btn" data-ak-im-location-search-submit="1">搜索</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="ak-im-location-picker-body">' +
                        '<div class="ak-im-location-picker-search-tips" data-ak-im-location-search-tips="1"></div>' +
                        '<div class="ak-im-location-picker-search-results" data-ak-im-location-search-results="1"></div>' +
                        '<div class="ak-im-location-picker-map" data-ak-im-location-map="1"></div>' +
                        '<div class="ak-im-location-picker-summary">' +
                            '<div class="ak-im-location-picker-summary-title" data-ak-im-location-title="1">等待选择位置</div>' +
                            '<div class="ak-im-location-picker-summary-address" data-ak-im-location-address="1">打开地图后可定位当前坐标，或点击地图重新选点。</div>' +
                            '<div class="ak-im-location-picker-summary-meta" data-ak-im-location-meta="1">支持当前定位与地图点选</div>' +
                        '</div>' +
                        '<div class="ak-im-location-picker-status" data-ak-im-location-status="1"></div>' +
                    '</div>' +
                    '<div class="ak-im-location-picker-footer">' +
                            '<button type="button" class="ak-im-location-picker-btn is-primary" data-ak-im-location-confirm="1" disabled>发送位置</button>' +
                    '</div>' +
                '</div>';
            (document.body || document.documentElement).appendChild(wrapper);
            this.pickerEl = wrapper;
            this.mapEl = wrapper.querySelector('[data-ak-im-location-map="1"]');
            this.titleEl = wrapper.querySelector('[data-ak-im-location-title="1"]');
            this.addressEl = wrapper.querySelector('[data-ak-im-location-address="1"]');
            this.metaEl = wrapper.querySelector('[data-ak-im-location-meta="1"]');
            this.statusEl = wrapper.querySelector('[data-ak-im-location-status="1"]');
            this.confirmBtnEl = wrapper.querySelector('[data-ak-im-location-confirm="1"]');
            this.searchInputEl = wrapper.querySelector('[data-ak-im-location-search-input="1"]');
            this.searchSubmitEl = wrapper.querySelector('[data-ak-im-location-search-submit="1"]');
            this.searchTipsEl = wrapper.querySelector('[data-ak-im-location-search-tips="1"]');
            this.searchResultsEl = wrapper.querySelector('[data-ak-im-location-search-results="1"]');
            const self = this;
            const closePicker = function(event) {
                if (event) {
                    event.preventDefault();
                    event.stopPropagation();
                }
                self.closePicker();
            };
            const closeBtnEl = wrapper.querySelector('[data-ak-im-location-close-btn="1"]');
            if (closeBtnEl) closeBtnEl.addEventListener('click', closePicker);
            if (this.searchInputEl) {
                this.searchInputEl.addEventListener('input', function() {
                    const keyword = self.getSearchKeyword();
                    if (!keyword) {
                        self.clearSearchDebounceTimer();
                        self.renderSearchTips([]);
                        self.renderSearchResults([]);
                        return;
                    }
                    self.scheduleSuggestionSearch(keyword);
                });
                this.searchInputEl.addEventListener('keydown', function(event) {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    event.stopPropagation();
                    self.runSearchFromInput().catch(function(error) {
                        self.renderPickerStatus(error && error.message ? error.message : '地点搜索失败', true);
                    });
                });
            }
            if (this.searchSubmitEl) {
                this.searchSubmitEl.addEventListener('click', function(event) {
                    event.preventDefault();
                    event.stopPropagation();
                    self.runSearchFromInput().catch(function(error) {
                        self.renderPickerStatus(error && error.message ? error.message : '地点搜索失败', true);
                    });
                });
            }
            if (this.searchTipsEl) {
                this.searchTipsEl.addEventListener('click', function(event) {
                    const target = event.target && typeof event.target.closest === 'function'
                        ? event.target.closest('[data-ak-im-location-tip-index]')
                        : null;
                    if (!target) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const index = Number(target.getAttribute('data-ak-im-location-tip-index'));
                    const item = Array.isArray(self.searchSuggestionItems) ? self.searchSuggestionItems[index] : null;
                    self.handleSuggestionSelection(item).catch(function(error) {
                        self.renderPickerStatus(error && error.message ? error.message : '地点选择失败', true);
                    });
                });
            }
            if (this.searchResultsEl) {
                this.searchResultsEl.addEventListener('click', function(event) {
                    const target = event.target && typeof event.target.closest === 'function'
                        ? event.target.closest('[data-ak-im-location-result-index]')
                        : null;
                    if (!target) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const index = Number(target.getAttribute('data-ak-im-location-result-index'));
                    const item = Array.isArray(self.searchResultItems) ? self.searchResultItems[index] : null;
                    self.applySearchSelection(item).catch(function(error) {
                        self.renderPickerStatus(error && error.message ? error.message : '地点选择失败', true);
                    });
                });
            }
            if (this.confirmBtnEl) {
                this.confirmBtnEl.addEventListener('click', function(event) {
                    event.preventDefault();
                    event.stopPropagation();
                    self.confirmSelection().catch(function(error) {
                        window.alert(error && error.message ? error.message : '位置发送失败');
                    });
                });
            }
            this.syncPickerButtons();
        },

        renderPickerStatus(text, isError) {
            if (!this.statusEl) return;
            this.statusEl.textContent = String(text || '').trim();
            this.statusEl.classList.toggle('has-text', !!this.statusEl.textContent);
            this.statusEl.classList.toggle('is-error', !!isError && !!this.statusEl.textContent);
        },

        focusSearchInput() {
            const self = this;
            if (!this.searchInputEl || typeof this.searchInputEl.focus !== 'function') return;
            setTimeout(function() {
                if (!self.searchInputEl || self.searchInputEl.disabled) return;
                try {
                    self.searchInputEl.focus({ preventScroll: true });
                } catch (error) {
                    self.searchInputEl.focus();
                }
            }, 0);
        },

        clearSearchDebounceTimer() {
            if (!this.searchDebounceTimer) return;
            global.clearTimeout(this.searchDebounceTimer);
            this.searchDebounceTimer = null;
        },

        getSearchKeyword() {
            return String(this.searchInputEl && this.searchInputEl.value || '').replace(/\s+/g, ' ').trim();
        },

        joinTextParts(parts) {
            const values = [];
            const seen = {};
            const source = Array.isArray(parts) ? parts : [];
            for (let index = 0; index < source.length; index += 1) {
                const value = String(source[index] || '').trim();
                if (!value || seen[value]) continue;
                seen[value] = true;
                values.push(value);
            }
            return values.join(' ');
        },

        resetSearchPanels(options) {
            const settings = options || {};
            this.clearSearchDebounceTimer();
            this.searchRequestToken += 1;
            this.searchSuggestionItems = [];
            this.searchResultItems = [];
            this.isSearching = false;
            if (!settings.keepKeyword && this.searchInputEl) {
                this.searchInputEl.value = '';
            }
            this.renderSearchTips([]);
            this.renderSearchResults([]);
            this.syncPickerButtons();
        },

        buildSearchItemMarkup(item, options) {
            const settings = options || {};
            const titleText = String(item && item.name || '').trim() || '未命名地点';
            const metaText = this.joinTextParts([item && item.address, item && item.meta]);
            const tagText = String(settings.tag || '').trim();
            const attrName = String(settings.attrName || '').trim();
            const attrValue = settings.attrValue;
            const tagMarkup = tagText ? '<span class="ak-im-location-picker-search-card-tag">' + this.escapeHtml(tagText) + '</span>' : '';
            const titleMarkup = '<span class="ak-im-location-picker-search-card-title">' + this.escapeHtml(titleText) + '</span>';
            const metaMarkup = metaText ? '<span class="ak-im-location-picker-search-card-meta">' + this.escapeHtml(metaText) + '</span>' : '';
            if (!attrName) {
                return '<div class="ak-im-location-picker-search-card is-passive">' + tagMarkup + titleMarkup + metaMarkup + '</div>';
            }
            return '<button type="button" class="ak-im-location-picker-search-card" ' + attrName + '="' + this.escapeAttribute(String(attrValue)) + '">' + tagMarkup + titleMarkup + metaMarkup + '</button>';
        },

        renderSearchTips(items) {
            const list = Array.isArray(items) ? items : [];
            this.searchSuggestionItems = list;
            if (!this.searchTipsEl) return;
            if (!list.length) {
                this.searchTipsEl.innerHTML = '';
                return;
            }
            this.searchTipsEl.innerHTML = list.map(function(item, index) {
                return this.buildSearchItemMarkup(item, {
                    tag: '联想',
                    attrName: 'data-ak-im-location-tip-index',
                    attrValue: index
                });
            }, this).join('');
        },

        renderSearchResults(items) {
            const list = Array.isArray(items) ? items : [];
            this.searchResultItems = list;
            if (!this.searchResultsEl) return;
            if (!list.length) {
                this.searchResultsEl.innerHTML = '';
                return;
            }
            this.searchResultsEl.innerHTML = list.map(function(item, index) {
                return this.buildSearchItemMarkup(item, {
                    tag: '结果',
                    attrName: 'data-ak-im-location-result-index',
                    attrValue: index
                });
            }, this).join('');
        },

        updateSelectionDisplay(payload) {
            const normalizedPayload = this.normalizePayload(payload);
            if (!normalizedPayload) {
                if (this.titleEl) this.titleEl.textContent = '等待选择位置';
                if (this.addressEl) this.addressEl.textContent = '可搜索地点、自动定位当前位置，或点击地图重新选点。';
                if (this.metaEl) this.metaEl.textContent = '支持搜索结果选点、当前位置与地图点选';
                return;
            }
            const longitudeText = this.formatCoordinate(normalizedPayload.longitude);
            const latitudeText = this.formatCoordinate(normalizedPayload.latitude);
            if (this.titleEl) this.titleEl.textContent = normalizedPayload.name || '共享位置';
            if (this.addressEl) this.addressEl.textContent = normalizedPayload.address || '已选择坐标，可直接发送给对方';
            if (this.metaEl) this.metaEl.textContent = '经度 ' + longitudeText + ' · 纬度 ' + latitudeText;
        },

        syncPickerButtons() {
            if (this.searchInputEl) {
                this.searchInputEl.disabled = !!this.isSending;
            }
            if (this.searchSubmitEl) {
                this.searchSubmitEl.disabled = !!this.isSending || !!this.isSearching;
                this.searchSubmitEl.textContent = this.isSearching ? '搜索中...' : '搜索';
            }
            if (this.confirmBtnEl) {
                this.confirmBtnEl.disabled = !!this.isSending || !this.normalizePayload(this.selectedPayload);
                this.confirmBtnEl.textContent = this.isSending ? '发送中...' : '发送位置';
            }
        },

        resizeMap() {
            const self = this;
            if (!this.map || typeof this.map.resize !== 'function') return;
            setTimeout(function() {
                if (self.map && typeof self.map.resize === 'function') {
                    self.map.resize();
                }
            }, 0);
        },

        openPicker() {
            const state = this.getState();
            if (!state || !state.allowed || !state.activeConversationId) {
                return Promise.reject(new Error('请先进入会话后再发送位置'));
            }
            this.ensureStyle();
            this.ensurePicker();
            this.resetSearchPanels();
            this.pickerEl.classList.add('is-open');
            this.pickerEl.setAttribute('aria-hidden', 'false');
            this.renderPickerStatus('正在加载地图...', false);
            this.updateSelectionDisplay(this.selectedPayload);
            this.syncPickerButtons();
            const self = this;
            return this.ensureAmap().then(function() {
                return self.ensureMap();
            }).then(function() {
                self.resizeMap();
                if (self.selectedPayload) {
                    return self.applySelection(self.selectedPayload, {
                        shouldGeocode: false,
                        shouldCenter: true
                    }).then(function() {
                        self.renderPickerStatus('已恢复上次选择的位置', false);
                        return null;
                    });
                }
                return self.locateCurrentPosition().catch(function(error) {
                    self.renderPickerStatus(error && error.message ? error.message : '定位失败，请点击地图选择位置', true);
                    return null;
                });
            }).catch(function(error) {
                self.renderPickerStatus(error && error.message ? error.message : '地图加载失败', true);
                throw error;
            });
        },

        closePicker() {
            if (!this.pickerEl) return;
            this.pickerEl.classList.remove('is-open');
            this.pickerEl.setAttribute('aria-hidden', 'true');
            this.resetSearchPanels();
            this.renderPickerStatus('', false);
            this.syncPickerButtons();
        },

        ensureAmap() {
            if (global.AMap && typeof global.AMap.Map === 'function') {
                return Promise.resolve(global.AMap);
            }
            if (this.amapPromise) return this.amapPromise;
            const config = this.getLocationConfig();
            if (!config.amapWebKey) {
                return Promise.reject(new Error('未配置高德地图 Web Key'));
            }
            if (config.amapSecurityJsCode) {
                global._AMapSecurityConfig = {
                    securityJsCode: config.amapSecurityJsCode
                };
            }
            const self = this;
            this.amapPromise = new Promise(function(resolve, reject) {
                const handleResolve = function() {
                    if (global.AMap && typeof global.AMap.Map === 'function') {
                        resolve(global.AMap);
                        return;
                    }
                    self.amapPromise = null;
                    reject(new Error('高德地图加载失败'));
                };
                const handleReject = function() {
                    self.amapPromise = null;
                    reject(new Error('高德地图脚本加载失败'));
                };
                const existingScript = document.querySelector('script[data-ak-im-location-amap="1"]');
                if (existingScript) {
                    if (global.AMap && typeof global.AMap.Map === 'function') {
                        handleResolve();
                        return;
                    }
                    existingScript.addEventListener('load', handleResolve, { once: true });
                    existingScript.addEventListener('error', handleReject, { once: true });
                    return;
                }
                const script = document.createElement('script');
                script.async = true;
                script.dataset.akImLocationAmap = '1';
                script.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(config.amapWebKey) + '&plugin=AMap.Scale,AMap.ToolBar';
                script.addEventListener('load', handleResolve, { once: true });
                script.addEventListener('error', handleReject, { once: true });
                (document.head || document.documentElement).appendChild(script);
            });
            return this.amapPromise;
        },

        ensureAmapPlugin(pluginName) {
            return this.ensureAmap().then(function(AMap) {
                return new Promise(function(resolve, reject) {
                    if (!AMap || typeof AMap.plugin !== 'function') {
                        reject(new Error('高德地图插件不可用'));
                        return;
                    }
                    try {
                        AMap.plugin([pluginName], function() {
                            resolve(AMap);
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        },

        normalizeLngLat(raw) {
            if (!raw) return null;
            if (Array.isArray(raw) && raw.length >= 2) {
                const longitude = this.normalizeCoordinate(raw[0], -180, 180);
                const latitude = this.normalizeCoordinate(raw[1], -90, 90);
                return longitude == null || latitude == null ? null : {
                    longitude: longitude,
                    latitude: latitude
                };
            }
            if (typeof raw.getLng === 'function' && typeof raw.getLat === 'function') {
                const longitude = this.normalizeCoordinate(raw.getLng(), -180, 180);
                const latitude = this.normalizeCoordinate(raw.getLat(), -90, 90);
                return longitude == null || latitude == null ? null : {
                    longitude: longitude,
                    latitude: latitude
                };
            }
            if (typeof raw === 'string' && raw.indexOf(',') > -1) {
                const parts = raw.split(',');
                return this.normalizeLngLat(parts);
            }
            const longitude = this.normalizeCoordinate(raw.longitude != null ? raw.longitude : (raw.lng != null ? raw.lng : raw.lon), -180, 180);
            const latitude = this.normalizeCoordinate(raw.latitude != null ? raw.latitude : raw.lat, -90, 90);
            return longitude == null || latitude == null ? null : {
                longitude: longitude,
                latitude: latitude
            };
        },

        buildPoiAddress(raw) {
            return this.joinTextParts([
                raw && raw.pname,
                raw && raw.cityname,
                raw && raw.adname,
                raw && raw.address,
                raw && raw.district
            ]);
        },

        normalizeSuggestionItem(raw) {
            if (!raw || typeof raw !== 'object') return null;
            const name = String(raw.name || '').trim();
            if (!name) return null;
            const location = this.normalizeLngLat(raw.location);
            return {
                name: name,
                address: this.joinTextParts([raw.district, raw.address]),
                meta: '',
                keyword: this.joinTextParts([name, raw.district]),
                longitude: location ? location.longitude : null,
                latitude: location ? location.latitude : null
            };
        },

        normalizeSearchResultItem(raw) {
            if (!raw || typeof raw !== 'object') return null;
            const name = String(raw.name || raw.title || '').trim();
            const location = this.normalizeLngLat(raw.location || raw.position || raw.lnglat);
            if (!name || !location) return null;
            return {
                name: name,
                address: this.buildPoiAddress(raw),
                meta: String(raw.type || '').trim(),
                longitude: location.longitude,
                latitude: location.latitude
            };
        },

        ensureAutocomplete() {
            if (this.autocomplete) return Promise.resolve(this.autocomplete);
            if (this.autocompletePromise) return this.autocompletePromise;
            const self = this;
            this.autocompletePromise = this.ensureAmapPlugin('AMap.AutoComplete').then(function(AMap) {
                if (!AMap || typeof AMap.AutoComplete !== 'function') {
                    throw new Error('地点联想服务不可用');
                }
                self.autocomplete = new AMap.AutoComplete({
                    citylimit: false
                });
                return self.autocomplete;
            }).catch(function(error) {
                self.autocompletePromise = null;
                throw error;
            });
            return this.autocompletePromise;
        },

        ensurePlaceSearch() {
            if (this.placeSearch) return Promise.resolve(this.placeSearch);
            if (this.placeSearchPromise) return this.placeSearchPromise;
            const self = this;
            this.placeSearchPromise = this.ensureAmapPlugin('AMap.PlaceSearch').then(function(AMap) {
                if (!AMap || typeof AMap.PlaceSearch !== 'function') {
                    throw new Error('地点搜索服务不可用');
                }
                self.placeSearch = new AMap.PlaceSearch({
                    pageSize: SEARCH_RESULT_LIMIT,
                    pageIndex: 1,
                    extensions: 'all'
                });
                return self.placeSearch;
            }).catch(function(error) {
                self.placeSearchPromise = null;
                throw error;
            });
            return this.placeSearchPromise;
        },

        fetchSuggestionList(keyword, token) {
            const self = this;
            return this.ensureAutocomplete().then(function(autocomplete) {
                return new Promise(function(resolve, reject) {
                    try {
                        autocomplete.search(keyword, function(status, result) {
                            if (token !== self.searchRequestToken) {
                                resolve([]);
                                return;
                            }
                            if (status !== 'complete' || !result || !Array.isArray(result.tips)) {
                                resolve([]);
                                return;
                            }
                            resolve(result.tips.map(function(item) {
                                return self.normalizeSuggestionItem(item);
                            }).filter(Boolean).slice(0, SEARCH_SUGGESTION_LIMIT));
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        },

        scheduleSuggestionSearch(keyword) {
            const self = this;
            this.clearSearchDebounceTimer();
            const requestToken = this.searchRequestToken + 1;
            this.searchRequestToken = requestToken;
            this.searchDebounceTimer = global.setTimeout(function() {
                self.fetchSuggestionList(keyword, requestToken).then(function(items) {
                    if (requestToken !== self.searchRequestToken || keyword !== self.getSearchKeyword()) return;
                    self.renderSearchTips(items);
                }).catch(function() {
                    if (requestToken !== self.searchRequestToken) return;
                    self.renderSearchTips([]);
                });
            }, SEARCH_DEBOUNCE_MS);
        },

        runKeywordSearch(keyword) {
            const normalizedKeyword = String(keyword || '').replace(/\s+/g, ' ').trim();
            if (!normalizedKeyword) {
                return Promise.reject(new Error('请输入地点关键词'));
            }
            const self = this;
            this.clearSearchDebounceTimer();
            this.renderSearchTips([]);
            this.isSearching = true;
            this.syncPickerButtons();
            this.renderPickerStatus('正在搜索地点...', false);
            return this.ensurePlaceSearch().then(function(placeSearch) {
                return new Promise(function(resolve, reject) {
                    try {
                        placeSearch.search(normalizedKeyword, function(status, result) {
                            if (status !== 'complete' || !result || !result.poiList || !Array.isArray(result.poiList.pois)) {
                                resolve([]);
                                return;
                            }
                            resolve(result.poiList.pois.map(function(item) {
                                return self.normalizeSearchResultItem(item);
                            }).filter(Boolean).slice(0, SEARCH_RESULT_LIMIT));
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            }).then(function(items) {
                self.isSearching = false;
                self.syncPickerButtons();
                self.renderSearchResults(items);
                if (!items.length) {
                    self.renderPickerStatus('未找到相关地点，请换个关键词试试', false);
                    return items;
                }
                self.renderPickerStatus('请选择一个搜索结果，或点击地图微调坐标', false);
                return items;
            }, function(error) {
                self.isSearching = false;
                self.syncPickerButtons();
                throw error;
            });
        },

        runSearchFromInput() {
            return this.runKeywordSearch(this.getSearchKeyword());
        },

        handleSuggestionSelection(item) {
            if (!item) {
                return Promise.reject(new Error('请选择有效的联想地点'));
            }
            const keyword = String(item.keyword || item.name || '').trim();
            if (this.searchInputEl) {
                this.searchInputEl.value = keyword;
            }
            this.renderSearchTips([]);
            if (item.longitude != null && item.latitude != null) {
                return this.applySearchSelection(item);
            }
            return this.runKeywordSearch(keyword);
        },

        applySearchSelection(item) {
            if (!item || item.longitude == null || item.latitude == null) {
                return Promise.reject(new Error('该地点缺少坐标，请换一个结果'));
            }
            const self = this;
            return this.applySelection({
                longitude: item.longitude,
                latitude: item.latitude,
                name: String(item.name || '').trim(),
                address: String(item.address || '').trim(),
                coordinate: LOCATION_COORDINATE,
                provider: LOCATION_PROVIDER
            }, {
                shouldGeocode: false,
                shouldCenter: true
            }).then(function(result) {
                self.renderSearchTips([]);
                self.renderSearchResults([]);
                self.renderPickerStatus('已选择搜索结果，可直接发送或点击地图微调', false);
                return result;
            });
        },

        ensureMap() {
            if (this.map) {
                this.resizeMap();
                return Promise.resolve(this.map);
            }
            if (!this.mapEl) {
                return Promise.reject(new Error('地图容器初始化失败'));
            }
            const AMap = global.AMap;
            if (!AMap || typeof AMap.Map !== 'function') {
                return Promise.reject(new Error('高德地图未就绪'));
            }
            this.map = new AMap.Map(this.mapEl, {
                zoom: DEFAULT_MAP_ZOOM,
                resizeEnable: true,
                viewMode: '2D'
            });
            this.marker = new AMap.Marker({
                map: this.map,
                anchor: 'bottom-center'
            });
            try {
                if (typeof AMap.Scale === 'function') this.map.addControl(new AMap.Scale());
            } catch (e) {}
            try {
                if (typeof AMap.ToolBar === 'function') this.map.addControl(new AMap.ToolBar());
            } catch (e) {}
            const self = this;
            this.map.on('click', function(event) {
                if (!event || !event.lnglat) return;
                self.applySelection({
                    longitude: typeof event.lnglat.getLng === 'function' ? event.lnglat.getLng() : event.lnglat.lng,
                    latitude: typeof event.lnglat.getLat === 'function' ? event.lnglat.getLat() : event.lnglat.lat
                }).catch(function(error) {
                    self.renderPickerStatus(error && error.message ? error.message : '位置选择失败', true);
                });
            });
            this.attachGeolocationControl(this.geolocation, 'geolocationAttached');
            this.attachGeolocationControl(this.coarseGeolocation, 'coarseGeolocationAttached');
            this.resizeMap();
            return Promise.resolve(this.map);
        },

        ensureGeocoder() {
            if (this.geocoder) return Promise.resolve(this.geocoder);
            if (this.geocoderPromise) return this.geocoderPromise;
            const self = this;
            this.geocoderPromise = this.ensureAmapPlugin('AMap.Geocoder').then(function(AMap) {
                self.geocoder = new AMap.Geocoder({
                    radius: 1000,
                    extensions: 'all'
                });
                return self.geocoder;
            }).catch(function(error) {
                self.geocoderPromise = null;
                throw error;
            });
            return this.geocoderPromise;
        },

        ensureGeolocation() {
            if (this.geolocation) return Promise.resolve(this.geolocation);
            if (this.geolocationPromise) return this.geolocationPromise;
            const self = this;
            this.geolocationPromise = this.ensureAmapPlugin('AMap.Geolocation').then(function(AMap) {
                self.geolocation = new AMap.Geolocation(self.buildGeolocationOptions({
                    enableHighAccuracy: true,
                    timeout: HIGH_ACCURACY_LOCATION_TIMEOUT
                }));
                self.attachGeolocationControl(self.geolocation, 'geolocationAttached');
                return self.geolocation;
            }).catch(function(error) {
                self.geolocationPromise = null;
                throw error;
            });
            return this.geolocationPromise;
        },

        ensureCoarseGeolocation() {
            if (this.coarseGeolocation) return Promise.resolve(this.coarseGeolocation);
            if (this.coarseGeolocationPromise) return this.coarseGeolocationPromise;
            const self = this;
            this.coarseGeolocationPromise = this.ensureAmapPlugin('AMap.Geolocation').then(function(AMap) {
                self.coarseGeolocation = new AMap.Geolocation(self.buildGeolocationOptions({
                    enableHighAccuracy: false,
                    timeout: BASIC_LOCATION_TIMEOUT
                }));
                self.attachGeolocationControl(self.coarseGeolocation, 'coarseGeolocationAttached');
                return self.coarseGeolocation;
            }).catch(function(error) {
                self.coarseGeolocationPromise = null;
                throw error;
            });
            return this.coarseGeolocationPromise;
        },

        requestGeolocationPosition(geolocationLoader) {
            const self = this;
            return Promise.resolve(typeof geolocationLoader === 'function' ? geolocationLoader.call(this) : null).then(function(geolocation) {
                if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
                    throw new Error('定位服务不可用');
                }
                return new Promise(function(resolve, reject) {
                    try {
                        geolocation.getCurrentPosition(function(status, result) {
                            if (status !== 'complete' || !result || !result.position) {
                                reject(new Error(self.buildGeolocationErrorMessage(status, result)));
                                return;
                            }
                            const longitude = typeof result.position.getLng === 'function' ? result.position.getLng() : result.position.lng;
                            const latitude = typeof result.position.getLat === 'function' ? result.position.getLat() : result.position.lat;
                            resolve({
                                longitude: longitude,
                                latitude: latitude
                            });
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        },

        setMapPosition(longitude, latitude) {
            if (!this.map || !this.marker) return;
            const position = [longitude, latitude];
            this.marker.setPosition(position);
            if (typeof this.map.setZoomAndCenter === 'function') {
                this.map.setZoomAndCenter(DEFAULT_MAP_ZOOM, position);
                return;
            }
            if (typeof this.map.setCenter === 'function') this.map.setCenter(position);
            if (typeof this.map.setZoom === 'function') this.map.setZoom(DEFAULT_MAP_ZOOM);
        },

        reverseGeocode(longitude, latitude) {
            const self = this;
            return this.ensureGeocoder().then(function(geocoder) {
                return new Promise(function(resolve, reject) {
                    try {
                        geocoder.getAddress([longitude, latitude], function(status, result) {
                            if (status !== 'complete' || !result || result.info !== 'OK' || !result.regeocode) {
                                reject(new Error('地址解析失败，请点击地图重新选择'));
                                return;
                            }
                            const regeocode = result.regeocode || {};
                            const firstPoi = Array.isArray(regeocode.pois) && regeocode.pois.length ? regeocode.pois[0] : null;
                            const firstAoi = Array.isArray(regeocode.aois) && regeocode.aois.length ? regeocode.aois[0] : null;
                            resolve({
                                name: String((firstPoi && firstPoi.name) || (firstAoi && firstAoi.name) || '').trim(),
                                address: String(regeocode.formattedAddress || '').trim(),
                                coordinate: LOCATION_COORDINATE,
                                provider: LOCATION_PROVIDER
                            });
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            }).catch(function(error) {
                self.renderPickerStatus(error && error.message ? error.message : '地址解析失败，请点击地图重新选择', true);
                throw error;
            });
        },

        applySelection(rawPayload, options) {
            const payload = this.normalizePayload(rawPayload);
            if (!payload) {
                return Promise.reject(new Error('无效的位置坐标'));
            }
            this.selectedPayload = payload;
            this.updateSelectionDisplay(payload);
            this.renderSearchTips([]);
            this.renderSearchResults([]);
            if (this.map && this.marker && (!options || options.shouldCenter !== false)) {
                this.setMapPosition(payload.longitude, payload.latitude);
            } else if (this.map && this.marker) {
                this.marker.setPosition([payload.longitude, payload.latitude]);
            }
            this.syncPickerButtons();
            if (options && options.shouldGeocode === false) {
                return Promise.resolve(payload);
            }
            const self = this;
            this.renderPickerStatus('正在解析地址...', false);
            return this.reverseGeocode(payload.longitude, payload.latitude).then(function(extraPayload) {
                self.selectedPayload = Object.assign({}, payload, extraPayload || {});
                self.updateSelectionDisplay(self.selectedPayload);
                self.renderPickerStatus('点击地图可以重新选择位置', false);
                self.syncPickerButtons();
                return self.selectedPayload;
            }).catch(function() {
                self.updateSelectionDisplay(self.selectedPayload);
                self.syncPickerButtons();
                return self.selectedPayload;
            });
        },

        locateCurrentPosition() {
            if (!this.map) {
                return this.ensureMap().then(this.locateCurrentPosition.bind(this));
            }
            const self = this;
            this.isLocating = true;
            this.syncPickerButtons();
            this.renderPickerStatus('正在定位当前坐标...', false);
            return this.requestGeolocationPosition(this.ensureGeolocation).catch(function(error) {
                const finalError = error instanceof Error ? error : new Error(self.buildSearchFallbackMessage());
                if (self.isMobileChromiumBrowser()) {
                    self.focusSearchInput();
                    throw finalError;
                }
                if (!self.isGeolocationTimeoutError(finalError)) {
                    throw finalError;
                }
                self.renderPickerStatus('高精度定位超时，正在切换基础定位...', false);
                return self.requestGeolocationPosition(self.ensureCoarseGeolocation);
            }).then(function(payload) {
                return self.applySelection(payload).then(function(result) {
                    self.isLocating = false;
                    self.syncPickerButtons();
                    return result;
                }, function(error) {
                    self.isLocating = false;
                    self.syncPickerButtons();
                    throw error;
                });
            }, function(error) {
                self.isLocating = false;
                self.syncPickerButtons();
                if (self.isMobileBrowser()) {
                    self.focusSearchInput();
                }
                throw error;
            });
        },

        confirmSelection() {
            const payload = this.normalizePayload(this.selectedPayload);
            if (!payload) {
                return Promise.reject(new Error('请先选择位置'));
            }
            if (!this.ctx || typeof this.ctx.sendLocationMessage !== 'function') {
                return Promise.reject(new Error('位置发送模块暂不可用'));
            }
            if (this.isSending) return Promise.resolve(null);
            const self = this;
            this.isSending = true;
            this.syncPickerButtons();
            this.renderPickerStatus('正在发送位置消息...', false);
            return Promise.resolve(this.ctx.sendLocationMessage(payload)).then(function(result) {
                self.isSending = false;
                self.syncPickerButtons();
                self.closePicker();
                return result;
            }, function(error) {
                self.isSending = false;
                self.syncPickerButtons();
                self.renderPickerStatus(error && error.message ? error.message : '位置发送失败', true);
                throw error;
            });
        },

        buildOpenMapUrl(payload) {
            const normalizedPayload = this.normalizePayload(payload);
            if (!normalizedPayload) return '';
            const url = new URL('https://uri.amap.com/marker');
            url.searchParams.set('position', normalizedPayload.longitude + ',' + normalizedPayload.latitude);
            url.searchParams.set('name', normalizedPayload.name || normalizedPayload.address || '共享位置');
            url.searchParams.set('src', 'ak-proxy');
            url.searchParams.set('coordinate', normalizedPayload.coordinate || LOCATION_COORDINATE);
            url.searchParams.set('callnative', '1');
            return url.toString();
        },

        buildOpenMapAppUrl(payload) {
            const normalizedPayload = this.normalizePayload(payload);
            if (!normalizedPayload || !this.isMobileBrowser()) return '';
            const params = new URLSearchParams();
            params.set('sourceApplication', LOCATION_SOURCE_APPLICATION);
            params.set('poiname', normalizedPayload.name || normalizedPayload.address || '共享位置');
            params.set('lat', String(normalizedPayload.latitude));
            params.set('lon', String(normalizedPayload.longitude));
            params.set('dev', '0');
            if (this.isAndroidBrowser()) {
                return 'androidamap://viewMap?' + params.toString();
            }
            if (this.isIOSBrowser()) {
                return 'iosamap://viewMap?' + params.toString();
            }
            return '';
        },

        buildOpenMapTargets(payload) {
            return {
                webUrl: this.buildOpenMapUrl(payload),
                appUrl: this.buildOpenMapAppUrl(payload)
            };
        },

        buildMessageBubbleMarkup(item) {
            const payload = this.resolveMessagePayload(item);
            if (!payload) return '';
            const longitudeText = this.formatCoordinate(payload.longitude);
            const latitudeText = this.formatCoordinate(payload.latitude);
            const titleText = payload.name || '共享位置';
            const addressText = payload.address || '经度 ' + longitudeText + ' · 纬度 ' + latitudeText;
            const metaText = '点击打开地图 · ' + longitudeText + ', ' + latitudeText;
            const openTargets = this.buildOpenMapTargets(payload);
            const openMapUrl = openTargets.webUrl;
            const openMapAppUrl = openTargets.appUrl;
            const iconMarkup = '<span class="ak-im-location-bubble-icon" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24"><path d="M12 21s6-5.373 6-11a6 6 0 1 0-12 0c0 5.627 6 11 6 11Z"></path><circle cx="12" cy="10" r="2.5"></circle></svg>' +
            '</span>';
            const bodyMarkup = '<span class="ak-im-location-bubble-body">' +
                '<span class="ak-im-location-bubble-badge">位置</span>' +
                '<span class="ak-im-location-bubble-title">' + this.escapeHtml(titleText) + '</span>' +
                '<span class="ak-im-location-bubble-address">' + this.escapeHtml(addressText) + '</span>' +
                '<span class="ak-im-location-bubble-meta">' + this.escapeHtml(metaText) + '</span>' +
            '</span>';
            if (!openMapUrl) {
                return '<div class="ak-im-location-bubble-surface">' + iconMarkup + bodyMarkup + '</div>';
            }
            const openTarget = this.isMobileBrowser() ? '_self' : '_blank';
            return '<a class="ak-im-location-bubble-link" data-ak-im-location-open="1" data-ak-im-location-web-url="' + this.escapeAttribute(openMapUrl) + '" data-ak-im-location-app-url="' + this.escapeAttribute(openMapAppUrl) + '" href="' + this.escapeAttribute(openMapUrl) + '" target="' + this.escapeAttribute(openTarget) + '" rel="noopener noreferrer">' + iconMarkup + bodyMarkup + '</a>';
        },

        getMessageBubbleClassName(item) {
            return this.resolveMessagePayload(item) ? 'ak-im-bubble-location' : '';
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.locationManage = locationManageModule;
})(window);
