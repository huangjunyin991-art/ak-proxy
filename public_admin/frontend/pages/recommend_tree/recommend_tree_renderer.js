(function() {
    if (window.AKRecommendTreeRenderer) return;

    var utils = window.AKRecommendTreeUtils;

    function render(root, store) {
        var state = store.state;
        root.innerHTML = '' +
            '<div class="rt-root ' + ((state.loading || state.refreshing) ? 'is-busy' : '') + '">' +
                renderHero(state) +
                renderStats(state) +
                renderControls(state) +
                renderViewTabs(state) +
                renderBody(state) +
                renderBusyLayer(state) +
            '</div>';
    }

    function renderHero(state) {
        var meta = state.meta || {};
        var cached = state.cached || (state.selectedAccountMeta && state.selectedAccountMeta.hasCache);
        var statusText = state.refreshing ? '正在重新获取' : state.loading ? '正在读取缓存' : cached ? '已缓存' : '未缓存';
        return '<section class="rt-hero">' +
            '<div class="rt-hero-top">' +
                '<div class="rt-title"><strong>组织架构</strong><span>查看推荐组织关系与层级分布，默认读取缓存，手动更新时重新拉取</span></div>' +
                '<span class="rt-cache-badge ' + (cached ? 'cached' : '') + '">' + utils.escapeHtml(statusText) + '</span>' +
            '</div>' +
            '<div class="rt-account-wrap">' +
                '<input class="rt-input rt-account-input" id="rtAccountInput" value="' + utils.escapeHtml(state.accountQuery || state.account || '') + '" placeholder="在账号管理中搜索账号/姓名">' +
                renderAccountDropdown(state) +
            '</div>' +
            '<div class="rt-action-row">' +
                '<button class="rt-btn" id="rtLoadBtn" ' + disabled(state) + '>查看组织架构</button>' +
                '<button class="rt-btn primary" id="rtRefreshBtn" ' + disabled(state) + '>' + (state.refreshing ? '<span class="rt-mini-spinner"></span>获取中' : '更新数据') + '</button>' +
            '</div>' +
            '<div class="rt-cache-line"><span>' + utils.escapeHtml(cached ? '缓存可用' : '暂无缓存标记') + '</span><span>更新时间 ' + utils.escapeHtml(meta.fetchedAt || (state.selectedAccountMeta && state.selectedAccountMeta.fetchedAt) || '-') + '</span></div>' +
        '</section>';
    }

    function renderAccountDropdown(state) {
        if (!state.accountDropdownOpen) return '';
        var rows = state.accountOptions || [];
        if (state.accountSearching) {
            return '<div class="rt-account-dropdown"><div class="rt-account-loading"><span class="rt-mini-spinner"></span>正在搜索账号管理表</div></div>';
        }
        if (!rows.length) {
            return '<div class="rt-account-dropdown"><div class="rt-account-empty">没有匹配账号</div></div>';
        }
        return '<div class="rt-account-dropdown">' + rows.map(function(row) {
            return '<button type="button" class="rt-account-option" data-account="' + utils.escapeHtml(row.account || '') + '">' +
                '<span><b>' + utils.escapeHtml(row.account || '-') + '</b><small>' + utils.escapeHtml(row.realName || '未记录姓名') + '</small></span>' +
                '<span class="rt-option-side">' + (row.hasCache ? '<em>已缓存</em>' : '<i>未缓存</i>') + '<small>' + utils.escapeHtml(row.nodeCount || 0) + ' 节点</small></span>' +
            '</button>';
        }).join('') + '</div>';
    }

    function renderStats(state) {
        var nodes = Array.isArray(state.nodes) ? state.nodes : [];
        var umbrellaNodes = nodes.filter(function(node) { return Number(node.depth || 0) >= 1; });
        var parentIds = {};
        nodes.forEach(function(node) {
            if (node.parentId != null && node.parentId !== '') parentIds[String(node.parentId)] = true;
        });
        var total = umbrellaNodes.length;
        var maxDepth = nodes.reduce(function(max, node) { return Math.max(max, Number(node.depth || 0)); }, 0);
        var branchCount = umbrellaNodes.filter(function(node) { return !!parentIds[String(node.id)]; }).length;
        var leafCount = total - branchCount;
        return '<section class="rt-stats">' +
            statCard(total, '伞下玩家') +
            statCard(maxDepth, '最大代数') +
            statCard(branchCount, '动态玩家') +
            statCard(leafCount, '静态玩家') +
        '</section>';
    }

    function statCard(value, label) {
        return '<div class="rt-stat"><b>' + utils.escapeHtml(value) + '</b><span>' + utils.escapeHtml(label) + '</span></div>';
    }

    function renderControls(state) {
        var payload = state.payload || {};
        var depths = Object.keys(payload.nodesByDepth || {}).map(function(key) { return Number(key); }).filter(function(value) { return value >= 1; }).sort(function(a, b) { return a - b; });
        var generationOptions = [{ value: '', label: '全部组织' }].concat(depths.map(function(depth) {
            return { value: String(depth), label: '第' + depth + '代成员' };
        }));
        var activeGeneration = generationOptions.find(function(option) {
            return option.value === String(state.generation || '');
        }) || generationOptions[0];
        var generationMenu = generationOptions.map(function(option) {
            var active = option.value === String(state.generation || '') ? ' active' : '';
            return '<button class="rt-generation-option' + active + '" type="button" data-generation="' + utils.escapeHtml(option.value) + '">' + utils.escapeHtml(option.label) + '</button>';
        }).join('');
        return '<section class="rt-controls">' +
            '<input class="rt-input rt-search-input" id="rtSearchInput" value="' + utils.escapeHtml(state.query || '') + '" placeholder="搜索账号/姓名/id/组织路径">' +
            '<div class="rt-generation-filter" id="rtGenerationFilter">' +
                '<button class="rt-btn rt-generation-trigger" id="rtGenerationTrigger" type="button">' + utils.escapeHtml(activeGeneration.label) + '</button>' +
                '<div class="rt-generation-menu" id="rtGenerationMenu">' + generationMenu + '</div>' +
            '</div>' +
        '</section>';
    }

    function renderViewTabs(state) {
        var active = state.viewMode || 'level';
        var tabs = [
            { value: 'level', label: '等级视图' },
            { value: 'depth', label: '代数视图' },
            { value: 'path', label: '血脉视图' }
        ];
        return '<section class="rt-view-tabs">' + tabs.map(function(tab) {
            return '<button type="button" class="rt-view-tab ' + (active === tab.value ? 'active' : '') + '" data-view-mode="' + utils.escapeHtml(tab.value) + '">' + utils.escapeHtml(tab.label) + '</button>';
        }).join('') + '</section>';
    }

    function renderBody(state) {
        if (state.error) return '<section class="rt-empty error">' + utils.escapeHtml(state.error) + '</section>';
        if (!state.payload) return '<section class="rt-empty">从账号管理表搜索账号，已有缓存会显示“已缓存”；没有缓存时点击“更新数据”。</section>';
        if (!state.filtered.length) return '<section class="rt-empty">没有匹配的组织成员。</section>';
        if ((state.viewMode || 'level') === 'depth') return renderDepthBody(state);
        if ((state.viewMode || 'level') === 'path') return renderPathBody(state);
        return renderLevelBody(state);
    }

    function renderLevelBody(state) {
        return renderGroupedBody(state, '等级视图。按会员等级归类成员，卡片颜色跟随等级；点击成员查看完整节点信息。', function(node) {
            return utils.nodeRankLabel(node);
        }, function(a, b) {
            return rankOrder(a) - rankOrder(b);
        }, function(label, nodes) {
            return '<span>' + utils.escapeHtml(label) + '</span><span>' + utils.escapeHtml(nodes.length) + ' 人</span>';
        });
    }

    function renderDepthBody(state) {
        return renderGroupedBody(state, '代数视图。按不同代数归类成员，适合查看每一层人数、等级与核心数据；点击成员查看完整节点信息。', function(node) {
            return Number(node.depth || 0);
        }, function(a, b) {
            return Number(a) - Number(b);
        }, function(label, nodes) {
            return '<span>第' + utils.escapeHtml(label) + '代</span><span>' + utils.escapeHtml(nodes.length) + ' 人</span>';
        });
    }

    function renderGroupedBody(state, note, groupGetter, groupSorter, headRenderer) {
        var groups = {};
        state.filtered.forEach(function(node) {
            var key = groupGetter(node);
            if (!groups[key]) groups[key] = [];
            groups[key].push(node);
        });
        var html = Object.keys(groups).sort(groupSorter).map(function(key) {
            var nodes = groups[key] || [];
            return '<section class="rt-layer-section">' +
                '<div class="rt-layer-head">' + headRenderer(key, nodes) + '</div>' +
                '<div class="rt-layer-grid">' + nodes.map(renderMemberCard).join('') + '</div>' +
            '</section>';
        }).join('');
        return '<section class="rt-layer-panel">' +
            '<div class="rt-scheme-note">' + utils.escapeHtml(note) + '</div>' +
            (html || '<div class="rt-empty">无匹配成员</div>') +
        '</section>';
    }

    function renderMemberCard(node) {
        var rankClass = utils.nodeRankClass(node);
        return '<button type="button" class="rt-layer-card rt-node-open ' + utils.escapeHtml(rankClass) + '" data-id="' + utils.escapeHtml(node.id) + '">' +
            '<span class="rt-layer-card-head"><b>' + utils.escapeHtml(utils.nodeDisplayName(node)) + '</b><em class="rt-layer-rank ' + utils.escapeHtml(rankClass) + '">' + utils.escapeHtml(utils.nodeRankLabel(node)) + '</em></span>' +
            '<span class="rt-layer-account">账号 ' + utils.escapeHtml(utils.nodeAccount(node)) + '</span>' +
            '<span class="rt-layer-time">注册时间 ' + utils.escapeHtml(utils.nodeCreateTime(node) || '-') + '</span>' +
            '<span class="rt-layer-metrics">' +
                '<i>左区 ' + utils.escapeHtml(node.L || 0) + '</i>' +
                '<i>右区 ' + utils.escapeHtml(node.R || 0) + '</i>' +
                '<i>直推 ' + utils.escapeHtml(node.F || 0) + '</i>' +
                '<i>子账号 ' + utils.escapeHtml(node.S || 0) + '</i>' +
            '</span>' +
        '</button>';
    }

    function rankOrder(label) {
        var text = String(label || '').toUpperCase();
        var prefix = text.charAt(0);
        var value = parseInt(text.slice(1), 10);
        if (!isFinite(value)) value = 0;
        return prefix === 'A' ? 100 + value : value;
    }

    function renderPathBody(state) {
        var selectedDepth = state.generation === '' ? null : Number(state.generation);
        var generationLabel = selectedDepth == null ? '全部血脉路径' : '第' + selectedDepth + '代血脉路径';
        return '<section class="rt-path-panel">' +
            '<div class="rt-scheme-note">血脉视图。当前显示：' + utils.escapeHtml(generationLabel) + '。卡片左色和右上徽章代表终点等级；点击任意节点查看完整节点信息。</div>' +
            '<div class="rt-level-legend">' +
                '<span class="rt-level-token level-0">M0 白</span><span class="rt-level-token level-1">M1 绿</span><span class="rt-level-token level-2">M2 蓝</span><span class="rt-level-token level-3">M3 紫</span><span class="rt-level-token level-4">M4 红</span><span class="rt-level-token level-5">M5 金</span><span class="rt-level-token a-rank">A1-A5</span>' +
            '</div>' +
            '<div class="rt-path-list">' + state.filtered.map(function(node) { return renderPathItem(state, node); }).join('') + '</div>' +
        '</section>';
    }

    function renderPathItem(state, node) {
        var pathNodes = utils.getPathNodes(state.index, node);
        var rankClass = utils.nodeRankClass(node);
        var pathHtml = pathNodes.map(function(pathNode, index) {
            var arrow = index < pathNodes.length - 1 ? '<span class="rt-path-arrow"></span>' : '';
            return renderPathNode(state, pathNode, index === pathNodes.length - 1) + arrow;
        }).join('');
        return '<article class="rt-path-item ' + utils.escapeHtml(rankClass) + '" data-id="' + utils.escapeHtml(node.id) + '">' +
            '<div class="rt-path-title">' +
                '<div class="rt-path-title-main">' + utils.escapeHtml(utils.shortText(utils.nodeDisplayName(node), 18)) + '</div>' +
                '<div class="rt-path-title-sub">第' + utils.escapeHtml(node.depth) + '代 · ' + utils.escapeHtml(utils.nodeAccount(node)) + '</div>' +
                '<span class="rt-end-level ' + utils.escapeHtml(rankClass) + '">' + utils.escapeHtml(utils.nodeRankLabel(node)) + '</span>' +
            '</div>' +
            '<div class="rt-path-metrics">' + metric('左区', node.L) + metric('右区', node.R) + metric('直推', node.F) + metric('子账号', node.S) + '</div>' +
            '<div class="rt-path-text">' + pathHtml + '</div>' +
        '</article>';
    }

    function renderPathNode(state, node, endpoint) {
        var rankClass = utils.nodeRankClass(node);
        var promotionHtml = renderPromotion(state, node);
        return '<button class="rt-path-node ' + utils.escapeHtml(rankClass) + (endpoint ? ' endpoint' : '') + (promotionHtml ? ' has-promotion' : '') + '" data-node-id="' + utils.escapeHtml(node.id) + '">' +
            '<span class="rt-level-badge ' + utils.escapeHtml(rankClass) + '">' + utils.escapeHtml(utils.nodeRankLabel(node)) + '</span>' +
            '<span class="rt-node-name">' + utils.escapeHtml(utils.shortText(utils.nodeDisplayName(node), 16)) + '</span>' +
            '<span class="rt-node-account">' + utils.escapeHtml(utils.shortText(utils.nodeAccount(node), 16)) + '</span>' +
            promotionHtml +
        '</button>';
    }

    function renderPromotion(state, node) {
        var result = utils.getPromotionProgress(state.index, node);
        if (result.currentLevel < 2) return '';
        var filled = Math.min(3, result.accounts.length);
        var targetLabel = result.targetLevel > 5 ? 'A1' : 'M' + result.targetLevel;
        var rankClass = result.targetLevel > 5 ? 'next-a-rank' : 'next-level-' + result.targetLevel;
        var segments = [0, 1, 2].map(function(index) {
            return '<span class="rt-promotion-segment ' + (index < filled ? 'filled' : '') + '"></span>';
        }).join('');
        var rows = result.accounts.map(function(item) {
            return '<span class="rt-promotion-item"><span>' + utils.escapeHtml(utils.nodeAccount(item)) + '</span><b class="' + utils.escapeHtml(utils.nodeRankClass(item)) + '">' + utils.escapeHtml(utils.nodeRankLabel(item)) + '</b></span>';
        }).join('');
        return '<span class="rt-promotion ' + utils.escapeHtml(rankClass) + '">' +
            '<span class="rt-promotion-title"><span>下一等级 ' + utils.escapeHtml(targetLabel) + '</span><b>' + filled + '/3</b></span>' +
            '<span class="rt-promotion-bars">' + segments + '</span>' +
            (rows ? '<span class="rt-promotion-list">' + rows + '</span>' : '') +
        '</span>';
    }

    function renderBusyLayer(state) {
        if (!state.loading && !state.refreshing) return '';
        var title = state.refreshing ? '正在远端获取组织架构' : '正在读取缓存';
        var desc = state.refreshing ? '正在分页拉取组织成员，请不要关闭页面' : '正在从数据库读取已缓存数据';
        return '<div class="rt-busy-layer"><div class="rt-busy-card"><span class="rt-orbit"></span><b>' + utils.escapeHtml(title) + '</b><small>' + utils.escapeHtml(desc) + '</small><span class="rt-busy-bar"></span></div></div>';
    }

    function metric(label, value) {
        return '<span class="rt-metric"><span class="rt-metric-label">' + utils.escapeHtml(label) + '</span><b class="rt-metric-value">' + utils.escapeHtml(value || 0) + '</b></span>';
    }

    function disabled(state) {
        return state.loading || state.refreshing ? 'disabled' : '';
    }

    function showDetail(node, anchor) {
        if (!node) return;
        document.querySelectorAll('.rt-detail-overlay').forEach(function(item) { item.remove(); });
        var overlay = document.createElement('div');
        overlay.className = 'rt-detail-overlay';
        overlay.innerHTML = '<div class="rt-detail-sheet">' +
            '<div class="rt-detail-head"><div><b>' + utils.escapeHtml(utils.nodeDisplayName(node)) + '</b><span>账号 ' + utils.escapeHtml(node.account || '-') + ' · id ' + utils.escapeHtml(utils.nodeFlowNumber(node) || '-') + '</span><span>注册时间 ' + utils.escapeHtml(utils.nodeCreateTime(node) || '-') + '</span></div><button type="button" class="rt-detail-close">×</button></div>' +
            '<div class="rt-detail-grid">' + metric('左区', node.L) + metric('右区', node.R) + metric('直推', node.F) + metric('子账号', node.S) + '</div>' +
        '</div>';
        overlay.querySelector('.rt-detail-close').onclick = function() { overlay.remove(); };
        overlay.onclick = function(event) { if (event.target === overlay) overlay.remove(); };
        document.body.appendChild(overlay);
        var sheet = overlay.querySelector('.rt-detail-sheet');
        var rect = anchor ? anchor.getBoundingClientRect() : { left: 20, top: 20, bottom: 20 };
        var left = Math.max(12, Math.min(rect.left, window.innerWidth - sheet.offsetWidth - 12));
        var top = rect.bottom + 8;
        if (top + sheet.offsetHeight > window.innerHeight - 12) top = rect.top - sheet.offsetHeight - 8;
        sheet.style.left = left + 'px';
        sheet.style.top = Math.max(12, top) + 'px';
    }

    window.AKRecommendTreeRenderer = {
        render: render,
        showDetail: showDetail
    };
})();
