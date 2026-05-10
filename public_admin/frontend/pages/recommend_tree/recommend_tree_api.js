(function() {
    if (window.AKRecommendTreeApi) return;

    function token() {
        return sessionStorage.getItem('admin_token') || '';
    }

    function parseResponse(response) {
        return response.json().then(function(body) {
            if (!response.ok || body.error || body.success === false) {
                var err = new Error(body.message || body.detail || '组织架构接口请求失败');
                err.code = body.code || '';
                err.status = response.status;
                err.body = body;
                throw err;
            }
            return body;
        });
    }

    function getCache(account) {
        var query = new URLSearchParams({ account: account || '' });
        return fetch('/admin/api/recommend-tree/cache?' + query.toString(), {
            headers: { 'Authorization': 'Bearer ' + token() },
            credentials: 'same-origin'
        }).then(parseResponse);
    }

    function searchAccounts(query, limit) {
        var params = new URLSearchParams({ search: query || '', limit: String(limit || 12) });
        return fetch('/admin/api/recommend-tree/accounts?' + params.toString(), {
            headers: { 'Authorization': 'Bearer ' + token() },
            credentials: 'same-origin'
        }).then(parseResponse);
    }

    function refresh(payload) {
        return fetch('/admin/api/recommend-tree/refresh', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token(),
                'Content-Type': 'application/json'
            },
            credentials: 'same-origin',
            body: JSON.stringify(payload || {})
        }).then(parseResponse);
    }

    window.AKRecommendTreeApi = {
        getCache: getCache,
        searchAccounts: searchAccounts,
        refresh: refresh
    };
})();
