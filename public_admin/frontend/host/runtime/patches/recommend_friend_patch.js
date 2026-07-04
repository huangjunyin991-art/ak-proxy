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

    var relationLabelKeys = {
        F: 'RELATION_DIRECT',
        S: 'RELATION_SUB_ACCOUNT',
        L: 'RELATION_LEFT_ZONE',
        R: 'RELATION_RIGHT_ZONE'
    };

    var relationLabelFallbacks = {
        cn: { F: '直推', S: '子账号', L: '左区', R: '右区' },
        en: { F: 'Direct', S: 'Sub Account', L: 'Left Zone', R: 'Right Zone' },
        de: { F: 'Direkt', S: 'Unterkonto', L: 'Linke Zone', R: 'Rechte Zone' },
        es: { F: 'Directo', S: 'Subcuenta', L: 'Zona izquierda', R: 'Zona derecha' },
        fr: { F: 'Direct', S: 'Sous-compte', L: 'Zone gauche', R: 'Zone droite' },
        jp: { F: '直接紹介', S: 'サブアカウント', L: '左区', R: '右区' },
        kr: { F: '직추천', S: '하위 계정', L: '왼쪽 구역', R: '오른쪽 구역' },
        pt: { F: 'Direto', S: 'Subconta', L: 'Zona esquerda', R: 'Zona direita' },
        th: { F: 'แนะนำตรง', S: 'บัญชีย่อย', L: 'โซนซ้าย', R: 'โซนขวา' }
    };

    var languageAliases = {
        zh: 'cn',
        'zh-cn': 'cn',
        'zh-hans': 'cn',
        ja: 'jp',
        'ja-jp': 'jp',
        ko: 'kr',
        'ko-kr': 'kr',
        'pt-br': 'pt'
    };

    function normalizeLanguageCode(value) {
        var code = String(value || '').trim().toLowerCase().replace('_', '-');
        return languageAliases[code] || code || 'cn';
    }

    function readLocalStorage(key) {
        try {
            return window.localStorage ? window.localStorage.getItem(key) : '';
        } catch(e) {
            return '';
        }
    }

    function getCurrentLanguageCode() {
        try {
            if (window.LSE && typeof window.LSE.currentLanguage === 'function') {
                return normalizeLanguageCode(window.LSE.currentLanguage());
            }
        } catch(e) {}
        try {
            if (window.APP && APP.CONFIG && APP.CONFIG.SYSTEM_KEYS && APP.CONFIG.SYSTEM_KEYS.LANGUAGE_KEY) {
                var configured = readLocalStorage(APP.CONFIG.SYSTEM_KEYS.LANGUAGE_KEY);
                if (configured) return normalizeLanguageCode(configured);
            }
        } catch(e) {}
        return normalizeLanguageCode(
            readLocalStorage('AK_current_langeuage') ||
            document.documentElement.getAttribute('lang') ||
            navigator.language ||
            'cn'
        );
    }

    function getRecommendFriendLanguagePack() {
        try {
            if (window._vue && window._vue.language && typeof window._vue.language === 'object') {
                return window._vue.language;
            }
        } catch(e) {}
        return {};
    }

    function getRelationLabel(code) {
        code = String(code || '').trim();
        var languageKey = relationLabelKeys[code];
        if (!languageKey) return code;
        var pack = getRecommendFriendLanguagePack();
        if (pack && pack[languageKey]) return String(pack[languageKey]);
        var fallbackPack = relationLabelFallbacks[getCurrentLanguageCode()] || relationLabelFallbacks.cn || relationLabelFallbacks.en;
        return (fallbackPack && fallbackPack[code]) || code;
    }

    function patchRecommendFriendRelationLabels(root) {
        if (!isRecommendFriendPage()) return;
        var nodes = [];
        var scope = root && root.nodeType === 1 ? root : document;
        try {
            if (scope.matches && scope.matches('.user-info-center .item .label')) nodes.push(scope);
        } catch(e) {}
        try {
            var found = scope.querySelectorAll ? scope.querySelectorAll('.user-info-center .item .label') : [];
            for (var i = 0; i < found.length; i++) nodes.push(found[i]);
        } catch(e2) {}
        for (var n = 0; n < nodes.length; n++) {
            var el = nodes[n];
            if (!el) continue;
            var code = String(el.getAttribute('data-ak-relation-code') || el.textContent || '').trim();
            if (!relationLabelKeys[code]) continue;
            var label = getRelationLabel(code);
            if (!label) continue;
            if (el.textContent !== label) el.textContent = label;
            el.setAttribute('data-ak-relation-code', code);
        }
    }

    function installRecommendFriendRelationLabelPatch() {
        if (!isRecommendFriendPage() || window.__AKRecommendFriendRelationLabelPatched) return;
        window.__AKRecommendFriendRelationLabelPatched = true;
        var run = function(root) {
            try {
                patchRecommendFriendRelationLabels(root || document);
            } catch(e) {}
        };
        var attempts = 0;
        var timer = setInterval(function() {
            attempts += 1;
            run(document);
            if (attempts >= 80) clearInterval(timer);
        }, 100);
        function observe() {
            run(document);
            if (!document.body || typeof MutationObserver !== 'function') return;
            var observer = new MutationObserver(function(records) {
                for (var i = 0; i < records.length; i++) {
                    var added = records[i].addedNodes || [];
                    for (var j = 0; j < added.length; j++) run(added[j]);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', observe, { once: true });
        } else {
            observe();
        }
    }

    function installRecommendFriendFirstCardBackPatch() {
        installRecommendFriendRelationLabelPatch();
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
    window.AKClientRuntimePatches.installRecommendFriendRelationLabelPatch = installRecommendFriendRelationLabelPatch;
    window.AKClientRuntimePatches.installRecommendFriendFirstCardBackPatch = installRecommendFriendFirstCardBackPatch;
})();
