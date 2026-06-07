(function() {
    if (window.AKPointStatsStore) return;

    var datePicker = window.AKPointDatePicker;

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
            expandedCategory: null,
            detailPageSize: 50,
            detailPageMap: {},
            detailMap: {},
            detailLoadingMap: {},
            detailErrorMap: {},
            datePicker: datePicker && datePicker.available() ? datePicker.createState() : null,
            quota: {
                isSuperAdmin: false,
                limit: 3,
                usedCount: 0,
                usedAccounts: [],
                cooldownSeconds: 300,
                cooldownMap: {},
                fetchedAt: 0
            },
            backfill: {
                status: 'idle',
                loading: false,
                message: '',
                pendingTotal: null,
                pendingRecordDate: null,
                pendingCategory: null,
                totalRecords: null,
                processed: 0,
                updated: 0,
                batches: 0,
                checked: false,
                error: ''
            }
        };

        function setPointType(type) {
            if (state.types.indexOf(type) < 0) return;
            state.pointType = type;
            state.expandedCategory = null;
            state.detailPageMap = {};
            state.detailMap = {};
            state.detailLoadingMap = {};
            state.detailErrorMap = {};
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
            state.detailPageMap = {};
            state.detailMap = {};
            state.detailLoadingMap = {};
            state.detailErrorMap = {};
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
            state.detailPageMap = {};
            state.detailMap = {};
            state.detailLoadingMap = {};
            state.detailErrorMap = {};
            state.datePicker = datePicker && datePicker.available() ? datePicker.createState() : null;
        }

        function setPayload(payload) {
            state.payload = payload || null;
            state.expandedCategory = null;
            state.detailPageMap = {};
            state.detailMap = {};
            state.detailLoadingMap = {};
            state.detailErrorMap = {};
            if (datePicker && datePicker.available() && !state.datePicker) {
                state.datePicker = datePicker.createState();
            }
            if (datePicker && state.datePicker) {
                datePicker.syncDataRange(state.datePicker, payload);
            }
        }

        function setStatus(message, isError) {
            state.status = message || '';
            state.error = isError ? message || '' : '';
        }

        function toggleCategory(name) {
            state.expandedCategory = state.expandedCategory === name ? null : name;
            if (state.expandedCategory && state.detailPageMap[state.expandedCategory] == null) {
                state.detailPageMap[state.expandedCategory] = 1;
            }
        }

        function setDetailPage(name, page) {
            if (!name) return;
            var p = parseInt(page, 10);
            if (!isFinite(p) || p < 1) p = 1;
            state.detailPageMap[name] = p;
        }

        function setDetailLoading(name, loading) {
            if (!name) return;
            state.detailLoadingMap[name] = !!loading;
            if (loading) state.detailErrorMap[name] = '';
        }

        function setDetailError(name, message) {
            if (!name) return;
            state.detailErrorMap[name] = message || '';
            state.detailLoadingMap[name] = false;
        }

        function setDetailData(name, payload) {
            if (!name || !payload) return;
            state.detailMap[name] = payload;
            state.detailPageMap[name] = payload.page || state.detailPageMap[name] || 1;
            state.detailLoadingMap[name] = false;
            state.detailErrorMap[name] = '';
        }

        function _cooldownKey(account, pointType) {
            return String(account || '').toLowerCase() + '|' + String(pointType || '').toUpperCase();
        }

        function setQuota(payload) {
            if (!payload || typeof payload !== 'object') return;
            var now = Date.now();
            state.quota.isSuperAdmin = !!payload.is_super_admin;
            state.quota.limit = payload.limit == null ? null : Number(payload.limit);
            state.quota.usedCount = Number(payload.used_count || 0);
            state.quota.usedAccounts = Array.isArray(payload.used_accounts) ? payload.used_accounts.slice() : [];
            state.quota.cooldownSeconds = Number(payload.cooldown_seconds || 300);
            var map = {};
            (Array.isArray(payload.cooldowns) ? payload.cooldowns : []).forEach(function(item) {
                if (!item) return;
                var k = _cooldownKey(item.account, item.point_type);
                map[k] = now + Number(item.remaining_seconds || 0) * 1000;
            });
            state.quota.cooldownMap = map;
            state.quota.fetchedAt = now;
        }

        function setBackfillStatus(payload) {
            if (!payload || typeof payload !== 'object') return;
            state.backfill.status = payload.status || 'idle';
            state.backfill.message = payload.message || '';
            state.backfill.pendingTotal = payload.pending_total == null ? state.backfill.pendingTotal : Number(payload.pending_total || 0);
            state.backfill.pendingRecordDate = payload.pending_record_date == null ? state.backfill.pendingRecordDate : Number(payload.pending_record_date || 0);
            state.backfill.pendingCategory = payload.pending_category == null ? state.backfill.pendingCategory : Number(payload.pending_category || 0);
            state.backfill.totalRecords = payload.total_records == null ? state.backfill.totalRecords : Number(payload.total_records || 0);
            state.backfill.processed = Number(payload.processed || 0);
            state.backfill.updated = Number(payload.updated || 0);
            state.backfill.batches = Number(payload.batches || 0);
            state.backfill.error = payload.error || '';
            state.backfill.checked = state.backfill.checked || payload.pending_total != null || !!(payload.structured_ready && payload.structured_ready.checked_at);
            state.backfill.loading = false;
        }

        function markCooldown(account, pointType) {
            if (!account || !pointType) return;
            var k = _cooldownKey(account, pointType);
            var seconds = Number(state.quota.cooldownSeconds || 300);
            state.quota.cooldownMap[k] = Date.now() + seconds * 1000;
            var lower = String(account || '').toLowerCase();
            if (state.quota.usedAccounts.indexOf(lower) < 0) {
                state.quota.usedAccounts.push(lower);
                state.quota.usedCount = state.quota.usedAccounts.length;
            }
        }

        function getCooldownRemaining(account, pointType) {
            if (!account || !pointType) return 0;
            var expireAt = state.quota.cooldownMap[_cooldownKey(account, pointType)];
            if (!expireAt) return 0;
            var remain = Math.max(0, Math.ceil((expireAt - Date.now()) / 1000));
            return remain;
        }

        function isQuotaExhausted() {
            if (state.quota.isSuperAdmin) return false;
            if (state.quota.limit == null) return false;
            return state.quota.usedCount >= state.quota.limit;
        }

        function isAccountInQuota(account) {
            if (!account) return false;
            return state.quota.usedAccounts.indexOf(String(account).toLowerCase()) >= 0;
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
            toggleCategory: toggleCategory,
            setDetailPage: setDetailPage,
            setDetailLoading: setDetailLoading,
            setDetailError: setDetailError,
            setDetailData: setDetailData,
            setQuota: setQuota,
            setBackfillStatus: setBackfillStatus,
            markCooldown: markCooldown,
            getCooldownRemaining: getCooldownRemaining,
            isQuotaExhausted: isQuotaExhausted,
            isAccountInQuota: isAccountInQuota
        };
    }

    window.AKPointStatsStore = {
        createStore: createStore
    };
})();
