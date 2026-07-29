(function() {
    if (window.AKEPAutoPurchaseApi) return;
    var base = '/admin/api/ep-auto-purchase';

    async function request(path, options) {
        var response = await fetch(base + path, Object.assign({ credentials: 'same-origin' }, options || {}));
        var body = await response.json().catch(function() { return {}; });
        if (!response.ok || body.success === false) {
            throw new Error(body.message || body.detail || 'EP 自动抢购请求失败');
        }
        return body;
    }

    window.AKEPAutoPurchaseApi = {
        dashboard: function() { return request('/dashboard'); },
        listingDiagnostic: function() { return request('/listing-diagnostic', { cache: 'no-store' }); },
        saveConfig: function(payload) {
            return request('/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload || {})
            });
        }
    };
})();
