(function(global) {
    'use strict';

    const DEFAULT_MAP_ZOOM = 16;
    const LOCATION_PROVIDER = 'amap';
    const LOCATION_COORDINATE = 'gaode';

    const locationManageModule = {
        ctx: null,
        styleReady: false,
        pickerEl: null,
        mapEl: null,
        titleEl: null,
        addressEl: null,
        metaEl: null,
        statusEl: null,
        locateBtnEl: null,
        confirmBtnEl: null,
        cancelBtnEl: null,
        map: null,
        marker: null,
        geocoder: null,
        geocoderPromise: null,
        geolocation: null,
        geolocationPromise: null,
        amapPromise: null,
        selectedPayload: null,
        isSending: false,
        isLocating: false,

        init(ctx) {
            this.ctx = ctx || null;
            this.ensureStyle();
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
                .ak-im-location-picker-mask{position:absolute;inset:0;background:rgba(15,23,42,.42)}
                .ak-im-location-picker-sheet{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(92vw,480px);max-height:min(88vh,760px);display:flex;flex-direction:column;overflow:hidden;border-radius:24px;background:#ffffff;box-shadow:0 24px 60px rgba(15,23,42,.28)}
                .ak-im-location-picker-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 18px 14px;border-bottom:1px solid rgba(15,23,42,.08)}
                .ak-im-location-picker-title{font-size:18px;font-weight:700;line-height:1.3;color:#0f172a}
                .ak-im-location-picker-close{border:none;background:transparent;color:#64748b;font-size:14px;font-weight:600;cursor:pointer;padding:6px 8px;border-radius:10px}
                .ak-im-location-picker-close:disabled{opacity:.5;cursor:default}
                .ak-im-location-picker-body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:12px;min-height:0}
                .ak-im-location-picker-hint{font-size:12px;line-height:1.5;color:#64748b}
                .ak-im-location-picker-map{height:min(42vh,340px);border-radius:18px;overflow:hidden;background:#f8fafc}
                .ak-im-location-picker-summary{padding:14px 14px 12px;border-radius:18px;background:#f8fafc;display:flex;flex-direction:column;gap:4px}
                .ak-im-location-picker-summary-title{font-size:15px;font-weight:700;line-height:1.35;color:#0f172a;word-break:break-word}
                .ak-im-location-picker-summary-address{font-size:13px;line-height:1.5;color:#475569;word-break:break-word}
                .ak-im-location-picker-summary-meta{font-size:12px;line-height:1.45;color:#64748b;word-break:break-word}
                .ak-im-location-picker-status{min-height:20px;font-size:12px;line-height:1.5;color:#64748b}
                .ak-im-location-picker-status.is-error{color:#dc2626}
                .ak-im-location-picker-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px}
                .ak-im-location-picker-btn{height:40px;border:none;border-radius:14px;padding:0 16px;font-size:14px;font-weight:700;cursor:pointer}
                .ak-im-location-picker-btn:disabled{opacity:.48;cursor:default}
                .ak-im-location-picker-btn.is-secondary{background:#eef2f7;color:#0f172a}
                .ak-im-location-picker-btn.is-primary{background:#07c160;color:#ffffff}
                @media (max-width: 520px){
                    .ak-im-location-picker-sheet{left:12px;right:12px;top:auto;bottom:12px;transform:none;width:auto;max-height:min(88vh,760px);border-radius:22px}
                    .ak-im-location-picker-map{height:min(40vh,300px)}
                    .ak-im-location-picker-actions{flex-wrap:wrap}
                    .ak-im-location-picker-btn{flex:1 1 calc(50% - 5px)}
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
                '<div class="ak-im-location-picker-mask" data-ak-im-location-close="1"></div>' +
                '<div class="ak-im-location-picker-sheet" role="dialog" aria-modal="true" aria-label="位置选择器">' +
                    '<div class="ak-im-location-picker-header">' +
                        '<div class="ak-im-location-picker-title">发送位置</div>' +
                        '<button type="button" class="ak-im-location-picker-close" data-ak-im-location-close-btn="1">取消</button>' +
                    '</div>' +
                    '<div class="ak-im-location-picker-body">' +
                        '<div class="ak-im-location-picker-hint">优先尝试定位当前所在位置，也可以直接点击地图选择具体坐标。</div>' +
                        '<div class="ak-im-location-picker-map" data-ak-im-location-map="1"></div>' +
                        '<div class="ak-im-location-picker-summary">' +
                            '<div class="ak-im-location-picker-summary-title" data-ak-im-location-title="1">等待选择位置</div>' +
                            '<div class="ak-im-location-picker-summary-address" data-ak-im-location-address="1">打开地图后可定位当前坐标，或点击地图重新选点。</div>' +
                            '<div class="ak-im-location-picker-summary-meta" data-ak-im-location-meta="1">支持当前定位与地图点选</div>' +
                        '</div>' +
                        '<div class="ak-im-location-picker-status" data-ak-im-location-status="1"></div>' +
                        '<div class="ak-im-location-picker-actions">' +
                            '<button type="button" class="ak-im-location-picker-btn is-secondary" data-ak-im-location-locate="1">定位当前</button>' +
                            '<button type="button" class="ak-im-location-picker-btn is-secondary" data-ak-im-location-cancel="1">取消</button>' +
                            '<button type="button" class="ak-im-location-picker-btn is-primary" data-ak-im-location-confirm="1" disabled>发送位置</button>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            (document.body || document.documentElement).appendChild(wrapper);
            this.pickerEl = wrapper;
            this.mapEl = wrapper.querySelector('[data-ak-im-location-map="1"]');
            this.titleEl = wrapper.querySelector('[data-ak-im-location-title="1"]');
            this.addressEl = wrapper.querySelector('[data-ak-im-location-address="1"]');
            this.metaEl = wrapper.querySelector('[data-ak-im-location-meta="1"]');
            this.statusEl = wrapper.querySelector('[data-ak-im-location-status="1"]');
            this.locateBtnEl = wrapper.querySelector('[data-ak-im-location-locate="1"]');
            this.confirmBtnEl = wrapper.querySelector('[data-ak-im-location-confirm="1"]');
            this.cancelBtnEl = wrapper.querySelector('[data-ak-im-location-cancel="1"]');
            const self = this;
            const closePicker = function(event) {
                if (event) {
                    event.preventDefault();
                    event.stopPropagation();
                }
                self.closePicker();
            };
            const maskEl = wrapper.querySelector('[data-ak-im-location-close="1"]');
            const closeBtnEl = wrapper.querySelector('[data-ak-im-location-close-btn="1"]');
            if (maskEl) maskEl.addEventListener('click', closePicker);
            if (closeBtnEl) closeBtnEl.addEventListener('click', closePicker);
            if (this.cancelBtnEl) this.cancelBtnEl.addEventListener('click', closePicker);
            if (this.locateBtnEl) {
                this.locateBtnEl.addEventListener('click', function(event) {
                    event.preventDefault();
                    event.stopPropagation();
                    self.locateCurrentPosition().catch(function(error) {
                        self.renderPickerStatus(error && error.message ? error.message : '定位失败，请点击地图选择位置', true);
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
            this.statusEl.classList.toggle('is-error', !!isError && !!this.statusEl.textContent);
        },

        updateSelectionDisplay(payload) {
            const normalizedPayload = this.normalizePayload(payload);
            if (!normalizedPayload) {
                if (this.titleEl) this.titleEl.textContent = '等待选择位置';
                if (this.addressEl) this.addressEl.textContent = '打开地图后可定位当前坐标，或点击地图重新选点。';
                if (this.metaEl) this.metaEl.textContent = '支持当前定位与地图点选';
                return;
            }
            const longitudeText = this.formatCoordinate(normalizedPayload.longitude);
            const latitudeText = this.formatCoordinate(normalizedPayload.latitude);
            if (this.titleEl) this.titleEl.textContent = normalizedPayload.name || '共享位置';
            if (this.addressEl) this.addressEl.textContent = normalizedPayload.address || '已选择坐标，可直接发送给对方';
            if (this.metaEl) this.metaEl.textContent = '经度 ' + longitudeText + ' · 纬度 ' + latitudeText;
        },

        syncPickerButtons() {
            if (this.locateBtnEl) {
                this.locateBtnEl.disabled = !!this.isSending || !!this.isLocating;
                this.locateBtnEl.textContent = this.isLocating ? '定位中...' : '定位当前';
            }
            if (this.cancelBtnEl) {
                this.cancelBtnEl.disabled = !!this.isSending;
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
                self.geolocation = new AMap.Geolocation({
                    enableHighAccuracy: true,
                    timeout: 10000,
                    showButton: false,
                    showMarker: false,
                    showCircle: false,
                    zoomToAccuracy: false
                });
                return self.geolocation;
            }).catch(function(error) {
                self.geolocationPromise = null;
                throw error;
            });
            return this.geolocationPromise;
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
            return this.ensureGeolocation().then(function(geolocation) {
                return new Promise(function(resolve, reject) {
                    try {
                        geolocation.getCurrentPosition(function(status, result) {
                            if (status !== 'complete' || !result || !result.position) {
                                reject(new Error('定位失败，请点击地图选择位置'));
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

        buildMessageBubbleMarkup(item) {
            const payload = this.resolveMessagePayload(item);
            if (!payload) return '';
            const longitudeText = this.formatCoordinate(payload.longitude);
            const latitudeText = this.formatCoordinate(payload.latitude);
            const titleText = payload.name || '共享位置';
            const addressText = payload.address || '经度 ' + longitudeText + ' · 纬度 ' + latitudeText;
            const metaText = '点击打开地图 · ' + longitudeText + ', ' + latitudeText;
            const openMapUrl = this.buildOpenMapUrl(payload);
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
            return '<a class="ak-im-location-bubble-link" href="' + this.escapeAttribute(openMapUrl) + '" target="_blank" rel="noopener noreferrer">' + iconMarkup + bodyMarkup + '</a>';
        },

        getMessageBubbleClassName(item) {
            return this.resolveMessagePayload(item) ? 'ak-im-bubble-location' : '';
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.locationManage = locationManageModule;
})(window);
