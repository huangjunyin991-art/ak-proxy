(function() {
    if (window.AKAccountMigrationStore) return;

    function clonePolicy(policy) {
        var next = policy && typeof policy === 'object' ? Object.assign({}, policy) : {};
        return {
            enabled: !!next.enabled,
            daily_time: String(next.daily_time || '03:30'),
            limit_per_spec: Math.max(0, Number(next.limit_per_spec || 0) || 0),
            phases: Array.isArray(next.phases) ? next.phases.slice() : []
        };
    }

    function createStore() {
        return {
            state: {
                loading: false,
                savingPolicy: false,
                startingSync: false,
                error: '',
                searchInput: '',
                search: '',
                limit: 50,
                offset: 0,
                runsLimit: 20,
                dashboard: null,
                policyDraft: clonePolicy(null),
                policyDirty: false,
                lastRefreshedAt: '',
                lastMessage: ''
            },

            setDashboard: function(payload) {
                this.state.dashboard = payload || {};
                this.state.error = '';
                this.state.lastMessage = '';
                if (!this.state.policyDirty) {
                    this.state.policyDraft = clonePolicy(payload && payload.policy);
                }
                this.state.lastRefreshedAt = new Date().toLocaleString('zh-CN', { hour12: false });
            },

            setError: function(message) {
                this.state.error = String(message || '');
                this.state.lastMessage = this.state.error;
            },

            applyPolicy: function(policy) {
                this.state.policyDraft = clonePolicy(policy);
                this.state.policyDirty = false;
                if (this.state.dashboard) {
                    this.state.dashboard.policy = clonePolicy(policy);
                }
            },

            updatePolicyField: function(key, value) {
                if (!this.state.policyDraft) this.state.policyDraft = clonePolicy(null);
                this.state.policyDraft[key] = value;
                this.state.policyDirty = true;
            }
        };
    }

    window.AKAccountMigrationStore = {
        createStore: createStore
    };
})();
