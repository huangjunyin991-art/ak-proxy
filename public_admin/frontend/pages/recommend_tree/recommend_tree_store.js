(function() {
    if (window.AKRecommendTreeStore) return;

    var utils = window.AKRecommendTreeUtils;

    function createStore() {
        var state = {
            account: '',
            loading: false,
            refreshing: false,
            query: '',
            generation: '',
            cached: false,
            meta: null,
            payload: null,
            nodes: [],
            filtered: [],
            index: utils.buildNodeIndex([]),
            error: ''
        };

        function setPayload(account, result) {
            var payload = result && result.payload ? result.payload : null;
            state.account = account || state.account;
            state.cached = !!(result && result.cached);
            state.meta = result && result.meta ? result.meta : null;
            state.payload = payload;
            state.nodes = payload && Array.isArray(payload.nodes) ? payload.nodes : [];
            state.index = utils.buildNodeIndex(state.nodes);
            applyFilter();
        }

        function applyFilter() {
            var query = String(state.query || '').trim().toLowerCase();
            var keywords = query.split(/\s+/).filter(Boolean);
            var generation = state.generation === '' ? null : Number(state.generation);
            state.filtered = state.nodes.filter(function(node) {
                if (Number(node.depth || 0) < 1) return false;
                if (generation != null && Number(node.depth || 0) !== generation) return false;
                if (!keywords.length) return true;
                var text = utils.searchText(state.index, node);
                return keywords.every(function(keyword) { return text.indexOf(keyword) >= 0; });
            });
            return state.filtered;
        }

        function setQuery(value) {
            state.query = value || '';
            applyFilter();
        }

        function setGeneration(value) {
            state.generation = value == null ? '' : String(value);
            applyFilter();
        }

        function resetStatus() {
            state.loading = false;
            state.refreshing = false;
            state.error = '';
        }

        return {
            state: state,
            setPayload: setPayload,
            applyFilter: applyFilter,
            setQuery: setQuery,
            setGeneration: setGeneration,
            resetStatus: resetStatus
        };
    }

    window.AKRecommendTreeStore = {
        createStore: createStore
    };
})();
