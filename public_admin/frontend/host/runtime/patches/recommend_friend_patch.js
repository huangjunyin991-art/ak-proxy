(function() {
    'use strict';

    function isRecommendFriendPage() {
        try {
            return String(window.location.pathname || '').toLowerCase() === '/pages/center/my.friend.html';
        } catch(e) {
            return false;
        }
    }

    function getRecommendFriendItemKey(item) {
        if (!item || typeof item !== 'object') return '';
        var id = item.Id != null && item.Id !== '' ? item.Id : item.id;
        if (id != null && id !== '') return 'id:' + String(id);
        var flowNumber = item.FlowNumber != null && item.FlowNumber !== '' ? item.FlowNumber : item.flowNumber;
        if (flowNumber != null && flowNumber !== '') return 'fn:' + String(flowNumber);
        return '';
    }

    function isSameRecommendFriendItem(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        var aKey = getRecommendFriendItemKey(a);
        var bKey = getRecommendFriendItemKey(b);
        return !!aKey && aKey === bKey;
    }

    function installRecommendFriendFirstCardBackPatch() {
        if (!isRecommendFriendPage() || window.__AKRecommendFriendFirstCardBackPatched) return;
        window.__AKRecommendFriendFirstCardBackPatched = true;
        var attempts = 0;
        var timer = setInterval(function() {
            attempts += 1;
            var vm = window._vue;
            if (!vm || typeof vm.choiceUser !== 'function') {
                if (attempts >= 80) clearInterval(timer);
                return;
            }
            clearInterval(timer);
            if (vm.__akFirstCardBackPatched) return;
            vm.__akFirstCardBackPatched = true;
            var originalChoiceUser = vm.choiceUser;
            vm.choiceUser = function(item) {
                var firstItem = null;
                try {
                    if (Array.isArray(this.getList) && this.getList.length > 0) {
                        firstItem = this.getList[0];
                    } else if (this.Current && typeof this.Current === 'object') {
                        firstItem = this.Current;
                    }
                } catch(e) {
                    firstItem = null;
                }
                if (isSameRecommendFriendItem(item, firstItem)) {
                    if (Array.isArray(this.teamList) && this.teamList.length > 0 && typeof this.gotoBack === 'function') {
                        return this.gotoBack();
                    }
                    return;
                }
                return originalChoiceUser.apply(this, arguments);
            };
        }, 100);
    }

    window.AKClientRuntimePatches = window.AKClientRuntimePatches || {};
    window.AKClientRuntimePatches.installRecommendFriendFirstCardBackPatch = installRecommendFriendFirstCardBackPatch;
})();
