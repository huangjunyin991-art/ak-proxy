(function() {
    if (window.AKGuidedSaleStatisticsApi) return;

    function headers(extra) {
        var result = Object.assign({}, extra || {});
        result.Authorization = 'Bearer ' + (sessionStorage.getItem('admin_token') || '');
        return result;
    }

    function parse(response) {
        return response.json().catch(function() { return {}; }).then(function(body) {
            if (!response.ok || body.success === false || body.error) {
                throw new Error(body.message || body.detail || '指导销售统计请求失败');
            }
            return body;
        });
    }

    function query(params) {
        var search = new URLSearchParams();
        Object.keys(params || {}).forEach(function(key) {
            var value = params[key];
            if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
        });
        var text = search.toString();
        return text ? '?' + text : '';
    }

    function get(path, params) {
        return fetch('/admin/api/guided-sale-statistics' + path + query(params), {
            headers: headers(), credentials: 'same-origin'
        }).then(parse);
    }

    function post(path, payload) {
        return fetch('/admin/api/guided-sale-statistics' + path, {
            method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
            credentials: 'same-origin', body: JSON.stringify(payload || {})
        }).then(parse);
    }

    window.AKGuidedSaleStatisticsApi = {
        dashboard: function() { return get('/dashboard'); },
        refresh: function() { return post('/start', {}); },
        saveSource: function(sourceAccount) { return post('/source', { source_account: sourceAccount || '' }); },
        savePolicy: function(days) { return post('/policy', { cache_retention_days: days }); }
    };
})();
