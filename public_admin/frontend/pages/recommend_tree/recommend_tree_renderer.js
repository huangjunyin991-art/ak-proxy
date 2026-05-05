(function() {
    if (window.AKRecommendTreeRenderer) return;

    var utils = window.AKRecommendTreeUtils;

    function render(root, store) {
        var state = store.state;
        root.innerHTML = '' +
            '<div class="rt-root">' +
                renderHeader(state) +
                renderStats(state) +
                renderControls(state) +
                renderBody(state) +
            '</div>';
    }

    function renderHeader(state) {
        var meta = state.meta || {};
        var status = state.refreshing ? '正在更新...' : state.loading ? '正在读取...' : state.cached ? '已缓存' : '未缓存';
        return '<section class="rt-header">' +
            '<div class="rt-title"><h3>推荐树 / 血脉线</h3><p>按账号缓存推荐树数据，默认读取缓存，手动更新才重新拉取。</p></div>' +
            '<div class="rt-query-row">' +
                '<input class="rt-input" id="rtAccountInput" value="' + utils.escapeHtml(state.account || '') + '" placeholder="输入账号">' +
                '<button class="rt-btn" id="rtLoadBtn" ' + (state.loading || state.refreshing ? 'disabled' : '') + '>查看血脉线</button>' +
                '<button class="rt-btn primary" id="rtRefreshBtn" ' + (state.loading || state.refreshing ? 'disabled' : '') + '>更新数据</button>' +
            '</div>' +
            '<div class="rt-cache-line"><span>' + utils.escapeHtml(status) + '</span><span>更新时间 ' + utils.escapeHtml(meta.fetchedAt || '-') + '</span></div>' +
        '</section>';
    }

    function renderStats(state) {
        var payload = state.payload || {};
        var meta = state.meta || {};
        var total = payload.totalNodes || meta.nodeCount || 0;
        return '<section class="rt-stats">' +
            statCard(total, '节点总数') +
            statCard(payload.maxDepth || meta.maxDepth || 0, '最大代数') +
            statCard(payload.branchCount || meta.branchCount || 0, '动态玩家') +
            statCard(payload.leafCount || meta.leafCount || 0, '静态玩家') +
            statCard(state.filtered.length || 0, '当前显示') +
        '</section>';
    }

    function statCard(value, label) {
        return '<div class="rt-stat"><b>' + utils.escapeHtml(value) + '</b><span>' + utils.escapeHtml(label) + '</span></div>';
    }

    function renderControls(state) {
        var payload = state.payload || {};
        var depths = Object.keys(payload.nodesByDepth || {}).map(function(key) { return Number(key); }).filter(function(value) { return value >= 1; }).sort(function(a, b) { return a - b; });
        var generationButtons = ['<button class="rt-pill ' + (state.generation === '' ? 'active' : '') + '" data-generation="">全部血脉线</button>'].concat(depths.map(function(depth) {
            return '<button class="rt-pill ' + (String(depth) === String(state.generation) ? 'active' : '') + '" data-generation="' + depth + '">第' + depth + '代</button>';
        })).join('');
        return '<section class="rt-controls">' +
            '<input class="rt-input" id="rtSearchInput" value="' + utils.escapeHtml(state.query || '') + '" placeholder="搜索账号/姓名/id">' +
            '<div class="rt-generation-row">' + generationButtons + '</div>' +
        '</section>';
    }

    function renderBody(state) {
        if (state.error) return '<section class="rt-empty error">' + utils.escapeHtml(state.error) + '</section>';
        if (!state.payload) return '<section class="rt-empty">输入账号后点击“查看血脉线”；没有缓存时点击“更新数据”拉取并保存。</section>';
        if (!state.filtered.length) return '<section class="rt-empty">没有匹配的血脉线。</section>';
        return '<section class="rt-path-list">' + state.filtered.map(function(node) { return renderPathItem(state, node); }).join('') + '</section>';
    }

    function renderPathItem(state, node) {
        var pathNodes = utils.getPathNodes(state.index, node);
        var rankClass = utils.nodeRankClass(node);
        var pathHtml = pathNodes.map(function(pathNode, index) {
            var arrow = index < pathNodes.length - 1 ? '<span class="rt-path-arrow">›</span>' : '';
            return renderPathNode(state, pathNode, index === pathNodes.length - 1) + arrow;
        }).join('');
        return '<article class="rt-path-item ' + utils.escapeHtml(rankClass) + '" data-id="' + utils.escapeHtml(node.id) + '">' +
            '<div class="rt-path-title">' +
                '<div><strong>' + utils.escapeHtml(utils.shortText(utils.nodeDisplayName(node), 22)) + '</strong><span>第' + utils.escapeHtml(node.depth) + '代 · ' + utils.escapeHtml(utils.nodeAccount(node)) + '</span></div>' +
                '<b class="rt-end-level ' + utils.escapeHtml(rankClass) + '">' + utils.escapeHtml(utils.nodeRankLabel(node)) + '</b>' +
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

    function metric(label, value) {
        return '<span class="rt-metric"><span>' + utils.escapeHtml(label) + '</span><b>' + utils.escapeHtml(value || 0) + '</b></span>';
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
