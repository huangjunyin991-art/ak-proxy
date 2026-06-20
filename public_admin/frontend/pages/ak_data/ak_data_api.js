(function() {
    if (window.AKDataApi) return;

    function token() {
        return sessionStorage.getItem('admin_token') || '';
    }

    function authHeaders(extra) {
        var headers = Object.assign({}, extra || {});
        headers.Authorization = 'Bearer ' + token();
        return headers;
    }

    function parseResponse(response) {
        return response.json().then(function(body) {
            if (!response.ok || body.error || body.success === false) {
                var err = new Error(body.message || body.detail || 'AK 数据接口请求失败');
                err.status = response.status;
                err.body = body;
                throw err;
            }
            return body;
        });
    }

    function get(path, params) {
        var query = new URLSearchParams();
        Object.keys(params || {}).forEach(function(key) {
            if (params[key] !== undefined && params[key] !== null && params[key] !== '') query.set(key, String(params[key]));
        });
        var url = '/admin/api/ak-data' + path + (query.toString() ? '?' + query.toString() : '');
        return fetch(url, {
            headers: authHeaders(),
            credentials: 'same-origin'
        }).then(parseResponse);
    }

    function post(path, payload) {
        return fetch('/admin/api/ak-data' + path, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            credentials: 'same-origin',
            body: JSON.stringify(payload || {})
        }).then(parseResponse);
    }

    window.AKDataApi = {
        status: function() { return get('/status'); },
        config: function() { return get('/config'); },
        saveConfig: function(payload) { return post('/config', payload || {}); },
        storage: function() { return get('/storage'); },
        dashboard: function(days) { return get('/dashboard', { days: days || 7 }); },
        marketValue: function(days) { return get('/market-value', { days: days || 7 }); },
        recentTrades: function(limit) { return get('/trades/recent', { limit: limit || 50 }); },
        backfillStatus: function() { return get('/backfill/status'); },
        startBackfill: function(payload) { return post('/backfill/start', payload || {}); },
        pauseBackfill: function() { return post('/backfill/pause', {}); },
        startProbe: function(payload) { return post('/probe/start', payload || {}); },
        cleanup: function() { return post('/cleanup', {}); },
        accountQuery: function(payload) {
            return get('/account-query', {
                query_type: payload && payload.queryType ? payload.queryType : 'seller',
                account_id: payload && payload.accountId ? payload.accountId : '',
                limit: payload && payload.limit ? payload.limit : 500
            });
        },
        tradeBuyers: function(tradeId) { return get('/trades/' + encodeURIComponent(tradeId) + '/buyers'); }
    };
})();
