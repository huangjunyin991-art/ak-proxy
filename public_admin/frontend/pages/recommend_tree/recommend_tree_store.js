(function() {
    if (window.AKRecommendTreeStore) return;

    var utils = window.AKRecommendTreeUtils;

    function createStore() {
        var state = {
            account: '',
            loading: false,
            refreshing: false,
            policyLoading: false,
            policySaving: false,
            policyLoaded: false,
            isSuperAdmin: false,
            query: '',
            generation: '',
            viewMode: 'level',
            cached: false,
            accountQuery: '',
            accountOptions: [],
            accountSearching: false,
            accountDropdownOpen: false,
            accountAuthRequired: false,
            selectedAccountMeta: null,
            meta: null,
            payload: null,
            nodes: [],
            filtered: [],
            expandedLevelGroups: {},
            index: utils.buildNodeIndex([]),
            error: '',
            promotionPolicy: null
        };

        function setPayload(account, result) {
            var payload = result && result.payload ? result.payload : null;
            state.account = account || state.account;
            state.cached = !!(result && result.cached);
            state.meta = result && result.meta ? result.meta : null;
            state.payload = payload;
            state.nodes = payload && Array.isArray(payload.nodes) ? payload.nodes : [];
            state.expandedLevelGroups = {};
            state.index = utils.buildNodeIndex(state.nodes);
            applyFilter();
        }

        function setAccountQuery(value) {
            state.accountQuery = value || '';
            state.account = value || '';
            state.accountDropdownOpen = true;
        }

        function setAccountOptions(rows) {
            state.accountOptions = Array.isArray(rows) ? rows : [];
            state.accountSearching = false;
        }

        function setPromotionPolicy(policy) {
            state.promotionPolicy = policy && typeof policy === 'object' ? policy : null;
            state.policyLoaded = !!state.promotionPolicy;
        }

        function selectAccount(row) {
            var account = row && row.account ? row.account : '';
            state.account = account;
            state.accountQuery = account;
            state.selectedAccountMeta = row || null;
            state.cached = !!(row && row.hasCache);
            state.accountDropdownOpen = false;
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

        function setViewMode(value) {
            var next = String(value || 'level');
            state.viewMode = ['level', 'depth', 'path'].indexOf(next) >= 0 ? next : 'level';
        }

        function toggleLevelGroup(value, defaultExpanded) {
            var key = String(value || '');
            var current = state.expandedLevelGroups[key];
            var active = current == null ? !!defaultExpanded : !!current;
            state.expandedLevelGroups[key] = !active;
        }

        function resetStatus() {
            state.loading = false;
            state.refreshing = false;
            state.accountSearching = false;
            state.error = '';
        }

        return {
            state: state,
            setPayload: setPayload,
            setAccountQuery: setAccountQuery,
            setAccountOptions: setAccountOptions,
            setPromotionPolicy: setPromotionPolicy,
            selectAccount: selectAccount,
            applyFilter: applyFilter,
            setQuery: setQuery,
            setGeneration: setGeneration,
            setViewMode: setViewMode,
            toggleLevelGroup: toggleLevelGroup,
            resetStatus: resetStatus
        };
    }

    window.AKRecommendTreeStore = {
        createStore: createStore
    };
})();
