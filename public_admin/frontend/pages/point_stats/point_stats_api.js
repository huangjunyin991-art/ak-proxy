(function() {
    if (window.AKPointStatsApi) return;

    function token() {
        return sessionStorage.getItem('admin_token') || '';
    }

    function parseResponse(response) {
        return response.json().then(function(body) {
            if (!response.ok || body.error || body.success === false) {
                throw new Error(body.message || body.detail || '点数统计接口请求失败');
            }
            return body;
        });
    }

    function authHeaders(extra) {
        var headers = Object.assign({}, extra || {});
        headers.Authorization = 'Bearer ' + token();
        return headers;
    }

    function getStats(payload) {
        var params = new URLSearchParams();
        if (payload && payload.username) params.set('username', payload.username);
        if (payload && payload.pointType) params.set('point_type', payload.pointType);
        params.set('limit', String(payload && payload.limit ? payload.limit : 80));
        return fetch('/admin/api/point-stats?' + params.toString(), {
            headers: authHeaders(),
            credentials: 'same-origin'
        }).then(parseResponse);
    }

    function searchUsers(query, limit) {
        var params = new URLSearchParams();
        if (query) params.set('search', query);
        params.set('limit', String(limit || 12));
        return fetch('/admin/api/point-stats/users?' + params.toString(), {
            headers: authHeaders(),
            credentials: 'same-origin'
        }).then(parseResponse);
    }

    function syncRecords(payload) {
        return fetch('/admin/api/point-stats/sync', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            credentials: 'same-origin',
            body: JSON.stringify({
                username: payload && payload.username ? payload.username : '',
                point_type: payload && payload.pointType ? payload.pointType : 'EP',
                page_size: payload && payload.pageSize ? payload.pageSize : 50
            })
        }).then(parseResponse);
    }

    window.AKPointStatsApi = {
        getStats: getStats,
        searchUsers: searchUsers,
        syncRecords: syncRecords
    };
})();
