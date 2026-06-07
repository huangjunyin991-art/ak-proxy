(function() {
    if (window.AKPointStatsApi) return;

    function token() {
        return sessionStorage.getItem('admin_token') || '';
    }

    function parseResponse(response) {
        return response.json().then(function(body) {
            if (!response.ok || body.error || body.success === false) {
                var err = new Error(body.message || body.detail || '点数统计接口请求失败');
                err.code = body.code || '';
                err.status = response.status;
                err.body = body;
                throw err;
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
        if (payload && payload.startDate) params.set('start_date', payload.startDate);
        if (payload && payload.endDate) params.set('end_date', payload.endDate);
        params.set('limit', String(payload && payload.limit ? payload.limit : 80));
        return fetch('/admin/api/point-stats?' + params.toString(), {
            headers: authHeaders(),
            credentials: 'same-origin'
        }).then(parseResponse);
    }

    function getDetail(payload) {
        var params = new URLSearchParams();
        if (payload && payload.username) params.set('username', payload.username);
        if (payload && payload.pointType) params.set('point_type', payload.pointType);
        if (payload && payload.category) params.set('category', payload.category);
        if (payload && payload.startDate) params.set('start_date', payload.startDate);
        if (payload && payload.endDate) params.set('end_date', payload.endDate);
        params.set('page', String(payload && payload.page ? payload.page : 1));
        params.set('page_size', String(payload && payload.pageSize ? payload.pageSize : 50));
        return fetch('/admin/api/point-stats/detail?' + params.toString(), {
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
                page_size: payload && payload.pageSize ? payload.pageSize : 50,
                max_pages: payload && payload.maxPages ? payload.maxPages : 0
            })
        }).then(parseResponse);
    }

    function syncStatus(payload) {
        var params = new URLSearchParams();
        if (payload && payload.username) params.set('username', payload.username);
        if (payload && payload.pointType) params.set('point_type', payload.pointType);
        return fetch('/admin/api/point-stats/sync/status?' + params.toString(), {
            headers: authHeaders(),
            credentials: 'same-origin'
        }).then(parseResponse);
    }

    function getQuota() {
        return fetch('/admin/api/point-stats/quota', {
            headers: authHeaders(),
            credentials: 'same-origin'
        }).then(parseResponse);
    }

    function getBackfillStatus(payload) {
        var params = new URLSearchParams();
        if (payload && payload.includeCounts) params.set('include_counts', 'true');
        return fetch('/admin/api/point-stats/backfill/status?' + params.toString(), {
            headers: authHeaders(),
            credentials: 'same-origin'
        }).then(parseResponse);
    }

    function runBackfill(payload) {
        return fetch('/admin/api/point-stats/backfill/run', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            credentials: 'same-origin',
            body: JSON.stringify({
                batch_size: payload && payload.batchSize ? payload.batchSize : 1000,
                max_batches: payload && payload.maxBatches ? payload.maxBatches : 0
            })
        }).then(parseResponse);
    }

    window.AKPointStatsApi = {
        getStats: getStats,
        getDetail: getDetail,
        searchUsers: searchUsers,
        syncRecords: syncRecords,
        syncStatus: syncStatus,
        getQuota: getQuota,
        getBackfillStatus: getBackfillStatus,
        runBackfill: runBackfill
    };
})();
