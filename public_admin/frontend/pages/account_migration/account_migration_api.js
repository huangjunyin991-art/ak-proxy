(function() {
    if (window.AKAccountMigrationApi) return;

    function token() {
        return sessionStorage.getItem('admin_token') || '';
    }

    function authHeaders(extra) {
        var headers = Object.assign({}, extra || {});
        headers.Authorization = 'Bearer ' + token();
        return headers;
    }

    function parseResponse(response) {
        return response.json().catch(function() {
            return {};
        }).then(function(body) {
            if (!response.ok || body.error || body.success === false) {
                var err = new Error(body.message || body.detail || '账号迁移接口请求失败');
                err.status = response.status;
                err.body = body;
                throw err;
            }
            return body;
        });
    }

    function buildQuery(params) {
        var query = new URLSearchParams();
        Object.keys(params || {}).forEach(function(key) {
            var value = params[key];
            if (value === undefined || value === null || value === '') return;
            query.set(key, String(value));
        });
        return query.toString() ? '?' + query.toString() : '';
    }

    function get(path, params) {
        return fetch('/admin/api/account-identity' + path + buildQuery(params), {
            headers: authHeaders(),
            credentials: 'same-origin'
        }).then(parseResponse);
    }

    function post(path, payload) {
        return fetch('/admin/api/account-identity' + path, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            credentials: 'same-origin',
            body: JSON.stringify(payload || {})
        }).then(parseResponse);
    }

    window.AKAccountMigrationApi = {
        dashboard: function(params) {
            return get('/dashboard', {
                search: params && params.search ? params.search : '',
                limit: params && params.limit ? params.limit : 50,
                offset: params && params.offset ? params.offset : 0,
                runs_limit: params && params.runsLimit ? params.runsLimit : 20,
                force_stats: params && params.forceStats ? '1' : ''
            });
        },
        policy: function() {
            return get('/policy');
        },
        savePolicy: function(payload) {
            return post('/policy', payload || {});
        },
        startSync: function(payload) {
            return post('/sync', payload || {});
        }
    };
})();
