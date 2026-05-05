(function() {
    if (window.AKRecommendTreeUtils) return;

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>'"]/g, function(ch) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[ch] || ch;
        });
    }

    function shortText(value, max) {
        var text = String(value || '');
        var limit = Number(max || 18);
        if (text.length <= limit) return text;
        return text.slice(0, Math.max(3, limit - 6)) + '...' + text.slice(-3);
    }

    function safeNumber(value) {
        var n = Number(value || 0);
        return isFinite(n) ? n : 0;
    }

    function nodeFlowNumber(node) {
        return String((node && node.flowNumber) || '').trim();
    }

    function nodeCreateTime(node) {
        return String((node && node.createTime) || '').trim();
    }

    function nodeAccount(node) {
        return String((node && (node.account || nodeFlowNumber(node) || node.id)) || '').trim();
    }

    function nodeDisplayName(node) {
        return String((node && (node.name || node.account || nodeFlowNumber(node) || node.id)) || '').trim();
    }

    function nodeMLevel(node) {
        var label = String((node && node.honorLevel) || 'M0').toUpperCase();
        if (label.charAt(0) !== 'M') return 5;
        var value = parseInt(label.slice(1), 10);
        return isFinite(value) ? value : 0;
    }

    function nodeALevel(node) {
        var label = String((node && node.honorLevel) || '').toUpperCase();
        if (label.charAt(0) !== 'A') return 0;
        var value = parseInt(label.slice(1), 10);
        return isFinite(value) ? value : 0;
    }

    function nodeRankLabel(node) {
        return String((node && node.honorLevel) || 'M0').toUpperCase();
    }

    function nodeRankClass(node) {
        var aLevel = nodeALevel(node);
        if (aLevel > 0) return 'a-rank level-5';
        return 'level-' + Math.max(0, Math.min(5, nodeMLevel(node)));
    }

    function buildNodeIndex(nodes) {
        var byId = new Map();
        var childrenByParent = new Map();
        (nodes || []).forEach(function(node) {
            byId.set(String(node.id), node);
            var parentId = node.parentId == null ? '' : String(node.parentId);
            if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
            childrenByParent.get(parentId).push(node);
        });
        return { byId: byId, childrenByParent: childrenByParent };
    }

    function getChildren(index, node) {
        return index.childrenByParent.get(String(node && node.id)) || [];
    }

    function getPathNodes(index, node) {
        var path = [];
        var cursor = node;
        var seen = new Set();
        while (cursor && !seen.has(String(cursor.id))) {
            path.unshift(cursor);
            seen.add(String(cursor.id));
            if (cursor.parentId == null || cursor.parentId === '') break;
            cursor = index.byId.get(String(cursor.parentId));
        }
        return path;
    }

    function findFirstQualifiedInLine(index, root, targetLevel) {
        var queue = [root];
        var visited = new Set();
        while (queue.length) {
            var current = queue.shift();
            if (!current || visited.has(String(current.id))) continue;
            visited.add(String(current.id));
            if (nodeMLevel(current) >= targetLevel) return current;
            queue = queue.concat(getChildren(index, current));
        }
        return null;
    }

    function getPromotionProgress(index, node) {
        if (nodeALevel(node) > 0) return { currentLevel: 0, targetLevel: 0, accounts: [] };
        var currentLevel = nodeMLevel(node);
        if (currentLevel < 2) return { currentLevel: currentLevel, targetLevel: currentLevel + 1, accounts: [] };
        var accounts = getChildren(index, node).map(function(child) {
            return findFirstQualifiedInLine(index, child, currentLevel);
        }).filter(Boolean).slice(0, 3);
        return { currentLevel: currentLevel, targetLevel: currentLevel + 1, accounts: accounts };
    }

    function searchText(index, node) {
        return [
            node.id,
            node.name,
            node.account,
            nodeFlowNumber(node),
            nodeCreateTime(node),
            nodeRankLabel(node),
            getPathNodes(index, node).map(function(item) {
                return [nodeDisplayName(item), nodeAccount(item), nodeFlowNumber(item)].join(' ');
            }).join(' ')
        ].join(' ').toLowerCase();
    }

    window.AKRecommendTreeUtils = {
        escapeHtml: escapeHtml,
        shortText: shortText,
        safeNumber: safeNumber,
        nodeFlowNumber: nodeFlowNumber,
        nodeCreateTime: nodeCreateTime,
        nodeAccount: nodeAccount,
        nodeDisplayName: nodeDisplayName,
        nodeMLevel: nodeMLevel,
        nodeALevel: nodeALevel,
        nodeRankLabel: nodeRankLabel,
        nodeRankClass: nodeRankClass,
        buildNodeIndex: buildNodeIndex,
        getChildren: getChildren,
        getPathNodes: getPathNodes,
        getPromotionProgress: getPromotionProgress,
        searchText: searchText
    };
})();
