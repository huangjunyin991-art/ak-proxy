(function() {
    if (window.AKSellLedgerApi) return;
    var base = '/admin/api/ak-sell-ledger';
    function headers(extra) {
        return Object.assign({ Authorization: 'Bearer ' + (sessionStorage.getItem('admin_token') || '') }, extra || {});
    }
    function parse(response) {
        return response.json().catch(function() { return {}; }).then(function(body) {
            if (!response.ok || body.success === false) throw new Error(body.message || body.detail || 'AK流水请求失败');
            return body;
        });
    }
    function get(path, params) {
        var query = new URLSearchParams();
        Object.keys(params || {}).forEach(function(key) { if (params[key] !== '' && params[key] != null) query.set(key, params[key]); });
        return fetch(base + path + (query.toString() ? '?' + query.toString() : ''), { credentials: 'same-origin', headers: headers() }).then(parse);
    }
    function post(path, payload) {
        return fetch(base + path, { method: 'POST', credentials: 'same-origin', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload || {}) }).then(parse);
    }
    window.AKSellLedgerApi = {
        dashboard: function(filters) { return get('/dashboard', filters); },
        saveConfig: function(days) { return post('/config', { retention_days: days }); },
        cleanup: function() { return post('/cleanup', {}); }
    };
})();
