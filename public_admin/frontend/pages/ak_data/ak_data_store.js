(function() {
    if (window.AKDataStore) return;

    function createStore() {
        var state = {
            loading: false,
            error: '',
            status: null,
            storage: [],
            dashboardDays: 7,
            dashboard: [],
            recentTrades: [],
            visibleTrades: [],
            tableMode: 'orders',
            queryType: 'seller',
            accountId: '',
            queryLoading: false,
            queryTotal: 0,
            selectedTradeId: 0,
            buyerRows: [],
            buyerLoading: false,
            buyerError: '',
            lastMessage: '正在初始化 AK 数据...'
        };

        function setError(message) {
            state.error = message || '';
            if (message) state.lastMessage = message;
        }

        function setBootstrap(payload) {
            state.status = payload.status || null;
            state.storage = Array.isArray(payload.storage) ? payload.storage : [];
            state.dashboard = Array.isArray(payload.dashboard) ? payload.dashboard : [];
            state.recentTrades = Array.isArray(payload.recentTrades) ? payload.recentTrades : [];
            if (!state.visibleTrades.length) state.visibleTrades = state.recentTrades.slice();
            state.lastMessage = 'AK 数据已就绪';
            state.error = '';
        }

        function setDashboard(days, rows) {
            state.dashboardDays = Number(days || 7);
            state.dashboard = Array.isArray(rows) ? rows : [];
        }

        function setQueryResult(payload) {
            state.queryLoading = false;
            state.tableMode = 'orders';
            state.queryType = payload.query_type || state.queryType;
            state.accountId = payload.account_id || state.accountId;
            state.queryTotal = Number(payload.total || 0);
            state.visibleTrades = Array.isArray(payload.rows) ? payload.rows : [];
            state.selectedTradeId = state.visibleTrades[0] ? Number(state.visibleTrades[0].trade_id || 0) : 0;
            state.buyerRows = [];
            state.buyerError = '';
            state.lastMessage = state.visibleTrades.length ? '已返回 ' + state.visibleTrades.length + ' 笔关联订单' : '暂无匹配数据';
        }

        function resetToRecent() {
            state.tableMode = 'orders';
            state.visibleTrades = state.recentTrades.slice();
            state.queryTotal = 0;
            state.selectedTradeId = 0;
            state.buyerRows = [];
            state.buyerError = '';
            state.lastMessage = '已显示最近订单';
        }

        function setBuyerRows(tradeId, rows) {
            state.tableMode = 'buyers';
            state.selectedTradeId = Number(tradeId || 0);
            state.buyerLoading = false;
            state.buyerRows = Array.isArray(rows) ? rows : [];
            state.buyerError = '';
        }

        return {
            state: state,
            setError: setError,
            setBootstrap: setBootstrap,
            setDashboard: setDashboard,
            setQueryResult: setQueryResult,
            resetToRecent: resetToRecent,
            setBuyerRows: setBuyerRows
        };
    }

    window.AKDataStore = {
        createStore: createStore
    };
})();
