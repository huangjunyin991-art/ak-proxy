(function() {
    if (window.AKPointStatsStore) return;

    function createStore() {
        var state = {
            types: ['EP', 'SP', 'TP', 'RP'],
            pointType: 'EP',
            username: '',
            accountQuery: '',
            accountOptions: [],
            accountDropdownOpen: false,
            accountSearching: false,
            selectedAccountIndex: -1,
            loading: false,
            syncing: false,
            status: '请输入账号，选择点数类型后开始统计。',
            error: '',
            payload: null,
            expandedCategory: null
        };

        function setPointType(type) {
            if (state.types.indexOf(type) < 0) return;
            state.pointType = type;
            state.expandedCategory = null;
        }

        function setAccountQuery(value) {
            state.accountQuery = value || '';
            state.username = value || '';
            state.accountDropdownOpen = true;
            state.selectedAccountIndex = -1;
        }

        function setAccountOptions(rows) {
            state.accountOptions = Array.isArray(rows) ? rows : [];
            state.accountSearching = false;
            state.accountDropdownOpen = true;
            state.selectedAccountIndex = state.accountOptions.length ? 0 : -1;
        }

        function selectAccount(row) {
            var username = row && row.username ? row.username : '';
            state.username = username;
            state.accountQuery = username;
            state.accountDropdownOpen = false;
            state.selectedAccountIndex = -1;
            state.expandedCategory = null;
        }

        function moveAccountSelection(delta) {
            if (!state.accountOptions.length) return;
            state.selectedAccountIndex = (state.selectedAccountIndex + delta + state.accountOptions.length) % state.accountOptions.length;
        }

        function clearAccount() {
            state.username = '';
            state.accountQuery = '';
            state.accountOptions = [];
            state.accountDropdownOpen = false;
            state.selectedAccountIndex = -1;
            state.expandedCategory = null;
        }

        function setPayload(payload) {
            state.payload = payload || null;
        }

        function setStatus(message, isError) {
            state.status = message || '';
            state.error = isError ? message || '' : '';
        }

        function toggleCategory(name) {
            state.expandedCategory = state.expandedCategory === name ? null : name;
        }

        return {
            state: state,
            setPointType: setPointType,
            setAccountQuery: setAccountQuery,
            setAccountOptions: setAccountOptions,
            selectAccount: selectAccount,
            moveAccountSelection: moveAccountSelection,
            clearAccount: clearAccount,
            setPayload: setPayload,
            setStatus: setStatus,
            toggleCategory: toggleCategory
        };
    }

    window.AKPointStatsStore = {
        createStore: createStore
    };
})();
