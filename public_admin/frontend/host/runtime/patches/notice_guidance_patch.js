(function() {
    'use strict';

    var NOTICE_DETAIL_PATH = '/pages/subpages/last.notice.detail.html';
    var ROUTE_POLL_MS = 700;
    var observer = null;
    var lastRouteKey = '';
    var latestResult = null;
    var latestNoticeKey = '';
    var installedNetworkHooks = false;
    var observerApplyTimer = 0;
    var domProbeMutationTimer = 0;
    var domProbeScheduleToken = 0;
    var latestDomProbeSignature = '';

    function matchesNoticeDetailRoute(value) {
        try {
            return String(value || '').toLowerCase().indexOf(NOTICE_DETAIL_PATH) >= 0;
        } catch (e) {}
        return false;
    }

    function isNoticeDetailPage() {
        try {
            if (matchesNoticeDetailRoute(window.location.pathname || '')) return true;
            if (matchesNoticeDetailRoute(window.location.hash || '')) return true;
            return false;
        } catch (e) {}
        return false;
    }

    function currentRouteKey() {
        try {
            return String(window.location.pathname || '').toLowerCase() + '|' + String(window.location.search || '') + '|' + String(window.location.hash || '');
        } catch (e) {}
        return '';
    }

    function normalizeText(value) {
        return String(value == null ? '' : value)
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t\r\f\v]+/g, ' ')
            .trim();
    }

    function htmlEscape(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function safeParseJson(text) {
        if (text && typeof text === 'object') return text;
        var raw = String(text == null ? '' : text).trim();
        if (!raw || raw.charAt(0) !== '{') return null;
        try {
            var parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (e) {}
        return null;
    }

    function logWarn(message, extra) {
        try {
            if (extra === undefined) {
                console.warn('[AKNoticeGuidancePatch]', message);
                return;
            }
            console.warn('[AKNoticeGuidancePatch]', message, extra);
        } catch (e) {}
    }

    function getNoticeService() {
        try {
            return window.AKClientRuntimeNotices || null;
        } catch (e) {}
        return null;
    }

    function containsGuidedSaleKeyword(value) {
        return String(value || '').indexOf('\u6307\u5bfc\u9500\u552e') >= 0;
    }

    function hasGuidedSaleDateWindow(value) {
        return /\d{4}\s*[-\/\u5e74]\s*\d{1,2}\s*[-\/\u6708]\s*\d{1,2}.*\d{4}\s*[-\/\u5e74]\s*\d{1,2}\s*[-\/\u6708]\s*\d{1,2}.*\u6ce8\u518c/.test(String(value || ''));
    }

    function extractQueryParam(name, source) {
        var query = String(source || '');
        if (!query) return '';
        var questionIndex = query.indexOf('?');
        if (questionIndex >= 0) query = query.slice(questionIndex + 1);
        if (query.charAt(0) === '?') query = query.slice(1);
        if (!query) return '';
        try {
            return String(new URLSearchParams(query).get(name) || '').trim();
        } catch (e) {}
        var parts = query.split('&');
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            if (!part) continue;
            var eqIndex = part.indexOf('=');
            var key = eqIndex >= 0 ? part.slice(0, eqIndex) : part;
            if (key !== name) continue;
            var rawValue = eqIndex >= 0 ? part.slice(eqIndex + 1) : '';
            try {
                return decodeURIComponent(rawValue).trim();
            } catch (e2) {
                return rawValue.trim();
            }
        }
        return '';
    }

    function getCurrentNoticeId() {
        var noticeId = '';
        try {
            noticeId = extractQueryParam('nId', window.location.search || '');
        } catch (e) {}
        if (noticeId) return noticeId;
        try {
            noticeId = extractQueryParam('nId', window.location.hash || '');
        } catch (e2) {}
        return noticeId || '';
    }

    function isGenericTitleLine(value) {
        var text = normalizeText(value);
        if (!text) return true;
        if (/^(back|return|close)$/i.test(text)) return true;
        if (text === '\u516c\u544a' || text === '\u516c\u544a\u8be6\u60c5' || text === '\u8a73\u60c5' || text === '\u8be6\u60c5') return true;
        return false;
    }

    function normalizeLineList(lines) {
        var result = [];
        var seen = {};
        for (var i = 0; i < lines.length; i++) {
            var line = normalizeText(lines[i]);
            if (!line || seen[line]) continue;
            seen[line] = 1;
            result.push(line);
        }
        return result;
    }

    function readNodeVisibleText(node) {
        if (!node) return '';
        try {
            return String(node.innerText || node.textContent || '');
        } catch (e) {}
        return '';
    }

    function scoreNoticeContentNode(node) {
        if (!node || node.nodeType !== 1) return 0;
        var text = normalizeText(readNodeVisibleText(node));
        if (!text || text.length < 24) return 0;
        var score = text.length;
        if (containsGuidedSaleKeyword(text)) score += 4000;
        try {
            if (node.querySelector && node.querySelector('p,br,li,article,section')) score += 180;
        } catch (e) {}
        var marker = '';
        try {
            marker = String(node.className || '') + ' ' + String(node.id || '');
        } catch (e2) {}
        if (/notice|detail|content|article|rich|news/i.test(marker)) score += 120;
        return score;
    }

    function findBestNoticeContentRoot(root) {
        if (!root) return null;
        var selectors = [
            '[data-notice-content]',
            '.notice-content',
            '.notice-detail',
            '.notice-detail-content',
            '.detail-content',
            '.article-content',
            '.news-content',
            '.rich-text',
            '.content',
            '.page-content'
        ];
        var best = null;
        var bestScore = 0;
        for (var i = 0; i < selectors.length; i++) {
            var nodes = [];
            try {
                nodes = root.querySelectorAll(selectors[i]);
            } catch (e) {
                nodes = [];
            }
            for (var j = 0; j < nodes.length; j++) {
                var score = scoreNoticeContentNode(nodes[j]);
                if (score > bestScore) {
                    best = nodes[j];
                    bestScore = score;
                }
            }
        }
        return best || root;
    }

    function extractLinesFromNode(node) {
        var text = readNodeVisibleText(node).replace(/\r/g, '\n');
        var normalized = normalizeLineList(text.split(/\n+/));
        var result = [];
        for (var i = 0; i < normalized.length; i++) {
            var line = normalized[i];
            if (isGenericTitleLine(line) && result.length === 0) continue;
            result.push(line);
        }
        return result;
    }

    function chooseDomNoticeTitle(root, lines) {
        var selectors = [
            'h1',
            'h2',
            'h3',
            '.title',
            '.notice-title',
            '.detail-title',
            '.article-title',
            '.news-title',
            '.main-title'
        ];
        var best = '';
        for (var i = 0; i < selectors.length; i++) {
            var nodes = [];
            try {
                nodes = root.querySelectorAll(selectors[i]);
            } catch (e) {
                nodes = [];
            }
            for (var j = 0; j < nodes.length; j++) {
                var text = normalizeText(readNodeVisibleText(nodes[j]));
                if (!text || isGenericTitleLine(text)) continue;
                if (containsGuidedSaleKeyword(text)) return text;
                if (!best || text.length > best.length) best = text;
            }
        }
        if (best) return best;
        for (var k = 0; k < lines.length; k++) {
            var line = normalizeText(lines[k]);
            if (!line || isGenericTitleLine(line)) continue;
            if (containsGuidedSaleKeyword(line) && line.length <= 80) return line;
            if (line.indexOf('\u516c\u544a') >= 0 && line.length <= 80) return line;
        }
        for (var m = 0; m < lines.length; m++) {
            var fallback = normalizeText(lines[m]);
            if (!fallback || isGenericTitleLine(fallback)) continue;
            if (fallback.length >= 4 && fallback.length <= 80) return fallback;
        }
        return '';
    }

    function extractNoticeCreateTime(lines) {
        for (var i = 0; i < lines.length; i++) {
            var line = normalizeText(lines[i]);
            if (/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(line)) return line;
        }
        return '';
    }

    function buildDomNoticePayload() {
        if (!isNoticeDetailPage()) return null;
        var root = null;
        try {
            root = document.querySelector('#app') || document.body || document.documentElement || null;
        } catch (e) {
            root = document.body || document.documentElement || null;
        }
        if (!root) return null;
        var contentRoot = findBestNoticeContentRoot(root);
        var lines = extractLinesFromNode(contentRoot);
        if (!lines.length && contentRoot !== root) lines = extractLinesFromNode(root);
        if (!lines.length) return null;
        var title = chooseDomNoticeTitle(root, lines);
        var combined = [title].concat(lines).join('\n');
        if (!containsGuidedSaleKeyword(combined) && !hasGuidedSaleDateWindow(combined)) return null;
        if (!hasGuidedSaleDateWindow(combined) && lines.length < 4) return null;
        return {
            Id: getCurrentNoticeId(),
            Title: title,
            Text: lines.map(function(line) {
                return '<p>' + htmlEscape(line) + '</p>';
            }).join(''),
            CreateTime: extractNoticeCreateTime(lines)
        };
    }

    function buildDomNoticeSignature(notice) {
        return [
            currentRouteKey(),
            normalizeText(notice && notice.Id),
            normalizeText(notice && notice.Title),
            normalizeText(notice && notice.CreateTime),
            String((notice && notice.Text && notice.Text.length) || 0)
        ].join('|');
    }

    function clearStaleHints(currentKey) {
        var nodes = [];
        try {
            nodes = document.querySelectorAll('[data-ak-guided-sale-hint="1"]');
        } catch (e) {
            nodes = [];
        }
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (!node) continue;
            if (currentKey && node.getAttribute('data-ak-notice-key') === currentKey) continue;
            if (node.parentNode) node.parentNode.removeChild(node);
        }
    }

    function chooseAnchorElement(targetLine) {
        if (!targetLine) return null;
        var selectors = 'p, div, li, article, section, span';
        var candidates = [];
        try {
            candidates = document.querySelectorAll(selectors);
        } catch (e) {
            candidates = [];
        }
        var best = null;
        var bestScore = Number.MAX_SAFE_INTEGER;
        var normalizedTarget = normalizeText(targetLine);
        for (var i = 0; i < candidates.length; i++) {
            var node = candidates[i];
            if (!node || node.getAttribute('data-ak-guided-sale-hint') === '1') continue;
            var text = normalizeText(node.textContent || '');
            if (!text || text.indexOf(normalizedTarget) < 0) continue;
            var score = Math.abs(text.length - normalizedTarget.length);
            if (text === normalizedTarget) score -= 1000;
            if (score < bestScore) {
                best = node;
                bestScore = score;
            }
        }
        if (!best) return null;
        var tag = String(best.tagName || '').toUpperCase();
        if (tag === 'SPAN' && best.parentElement) {
            var parentTag = String(best.parentElement.tagName || '').toUpperCase();
            if (parentTag === 'P' || parentTag === 'DIV' || parentTag === 'LI') return best.parentElement;
        }
        return best;
    }

    function removeIdsDeep(node) {
        if (!node || node.nodeType !== 1) return;
        node.removeAttribute('id');
        var children = node.querySelectorAll ? node.querySelectorAll('[id]') : [];
        for (var i = 0; i < children.length; i++) {
            children[i].removeAttribute('id');
        }
    }

    function buildHintElement(anchor, result) {
        var tagName = (anchor && anchor.tagName && /^(P|DIV|LI)$/i.test(anchor.tagName)) ? anchor.tagName : 'P';
        var note = document.createElement(tagName);
        if (anchor && anchor.nodeType === 1) {
            if (anchor.className) note.className = anchor.className;
            var style = anchor.getAttribute('style');
            if (style) note.setAttribute('style', style);
        }
        note.setAttribute('data-ak-guided-sale-hint', '1');
        note.setAttribute('data-ak-notice-key', result.noticeKey || '');
        removeIdsDeep(note);

        var templateChild = anchor && anchor.firstElementChild ? anchor.firstElementChild.cloneNode(false) : null;
        if (templateChild) {
            removeIdsDeep(templateChild);
            templateChild.innerHTML = result.hintHtml || '';
            note.appendChild(templateChild);
        } else {
            note.innerHTML = result.hintHtml || '';
        }
        return note;
    }

    function applyGuidedSaleHint(result) {
        if (!isNoticeDetailPage() || !result || !result.noticeKey) return false;
        clearStaleHints(result.noticeKey);
        var existingNodes = [];
        try {
            existingNodes = document.querySelectorAll('[data-ak-guided-sale-hint="1"]');
        } catch (e) {
            existingNodes = [];
        }
        for (var i = 0; i < existingNodes.length; i++) {
            if (existingNodes[i] && existingNodes[i].getAttribute('data-ak-notice-key') === result.noticeKey) {
                return true;
            }
        }
        var anchor = chooseAnchorElement(result.targetLine);
        if (!anchor || !anchor.parentNode) return false;
        var note = buildHintElement(anchor, result);
        if (!note) return false;
        if (anchor.nextSibling) {
            anchor.parentNode.insertBefore(note, anchor.nextSibling);
        } else {
            anchor.parentNode.appendChild(note);
        }
        return true;
    }

    function applyAnalysisResult(result) {
        if (!result || !result.noticeKey) return false;
        latestResult = result;
        latestNoticeKey = result.noticeKey;
        scheduleHintApply();
        return true;
    }

    function scheduleHintApply() {
        if (!latestResult || !isNoticeDetailPage()) return;
        if (applyGuidedSaleHint(latestResult)) return;
        setTimeout(function() {
            if (latestResult) applyGuidedSaleHint(latestResult);
        }, 80);
        setTimeout(function() {
            if (latestResult) applyGuidedSaleHint(latestResult);
        }, 300);
    }

    function probeNoticeFromDom() {
        if (!isNoticeDetailPage()) return;
        var service = getNoticeService();
        if (!service || typeof service.analyzeGuidedSaleNotice !== 'function') return;
        var notice = buildDomNoticePayload();
        if (!notice) return;
        var signature = buildDomNoticeSignature(notice);
        if (!signature || signature === latestDomProbeSignature) return;
        latestDomProbeSignature = signature;
        service.analyzeGuidedSaleNotice(notice)
            .then(function(result) {
                applyAnalysisResult(result);
            })
            .catch(function(error) {
                logWarn('failed to analyze notice from dom', String(error && error.message || error || 'unknown'));
            });
    }

    function scheduleDomProbeSequence() {
        if (!isNoticeDetailPage()) return;
        var token = ++domProbeScheduleToken;
        var delays = [0, 120, 450, 1200, 2600];
        for (var i = 0; i < delays.length; i++) {
            (function(delay) {
                setTimeout(function() {
                    if (token !== domProbeScheduleToken) return;
                    probeNoticeFromDom();
                }, delay);
            })(delays[i]);
        }
    }

    function handleNoticePayload(detailEnvelope) {
        if (!isNoticeDetailPage()) return;
        var service = getNoticeService();
        if (!service || typeof service.analyzeGuidedSaleNoticeEnvelope !== 'function') return;
        service.analyzeGuidedSaleNoticeEnvelope(detailEnvelope)
            .then(function(result) {
                applyAnalysisResult(result);
            })
            .catch(function(error) {
                logWarn('failed to analyze notice envelope', String(error && error.message || error || 'unknown'));
            });
    }

    function inspectResponsePayload(responseText) {
        if (!isNoticeDetailPage()) return;
        var payload = safeParseJson(responseText);
        if (!payload) return;
        var service = getNoticeService();
        if (!service || typeof service.extractNoticeDetail !== 'function') return;
        if (!service.extractNoticeDetail(payload)) return;
        handleNoticePayload(payload);
    }

    function installXhrHook() {
        if (!window.XMLHttpRequest) return;
        var originalOpen = XMLHttpRequest.prototype.open;
        if (!originalOpen || originalOpen.__akNoticeGuidanceWrapped) return;
        var wrappedOpen = function(method, url) {
            try {
                if (!this.__akNoticeGuidanceLoadBound) {
                    this.__akNoticeGuidanceLoadBound = true;
                    this.addEventListener('load', function() {
                        try {
                            if (!isNoticeDetailPage()) return;
                            if (this.status && this.status !== 200) return;
                            var payloadSource = null;
                            if (this.responseType === 'json' && this.response && typeof this.response === 'object') {
                                payloadSource = this.response;
                            } else if (typeof this.response === 'string' && this.response) {
                                payloadSource = this.response;
                            } else if (!this.responseType || this.responseType === 'text' || this.responseType === '') {
                                payloadSource = this.responseText || '';
                            }
                            if (payloadSource == null) return;
                            inspectResponsePayload(payloadSource);
                        } catch (e) {}
                    });
                }
            } catch (e2) {}
            return originalOpen.apply(this, arguments);
        };
        wrappedOpen.__akNoticeGuidanceWrapped = true;
        XMLHttpRequest.prototype.open = wrappedOpen;
    }

    function installFetchHook() {
        if (typeof window.fetch !== 'function' || window.fetch.__akNoticeGuidanceWrapped) return;
        var originalFetch = window.fetch;
        var wrappedFetch = function(input, init) {
            var promise = originalFetch.apply(this, arguments);
            promise.then(function(response) {
                try {
                    if (!isNoticeDetailPage() || !response || !response.ok) return;
                    response.clone().text().then(function(text) {
                        inspectResponsePayload(text);
                    }).catch(function() {});
                } catch (e) {}
            }).catch(function() {});
            return promise;
        };
        wrappedFetch.__akNoticeGuidanceWrapped = true;
        window.fetch = wrappedFetch;
    }

    function installNetworkHooks() {
        if (installedNetworkHooks) return;
        installedNetworkHooks = true;
        installXhrHook();
        installFetchHook();
    }

    function resetNoticeState() {
        latestResult = null;
        latestNoticeKey = '';
        latestDomProbeSignature = '';
        domProbeScheduleToken += 1;
    }

    function installRouteHooks() {
        if (window.__AKNoticeGuidanceRouteHooksInstalled) return;
        window.__AKNoticeGuidanceRouteHooksInstalled = true;
        function schedule() {
            if (!isNoticeDetailPage()) {
                resetNoticeState();
                clearStaleHints('');
                return;
            }
            scheduleHintApply();
            scheduleDomProbeSequence();
        }
        try {
            var originalPushState = history.pushState;
            if (typeof originalPushState === 'function' && !originalPushState.__akNoticeGuidanceWrapped) {
                var wrappedPushState = function() {
                    var result = originalPushState.apply(history, arguments);
                    setTimeout(schedule, 0);
                    return result;
                };
                wrappedPushState.__akNoticeGuidanceWrapped = true;
                history.pushState = wrappedPushState;
            }
        } catch (e) {}
        try {
            var originalReplaceState = history.replaceState;
            if (typeof originalReplaceState === 'function' && !originalReplaceState.__akNoticeGuidanceWrapped) {
                var wrappedReplaceState = function() {
                    var result = originalReplaceState.apply(history, arguments);
                    setTimeout(schedule, 0);
                    return result;
                };
                wrappedReplaceState.__akNoticeGuidanceWrapped = true;
                history.replaceState = wrappedReplaceState;
            }
        } catch (e2) {}
        try {
            window.addEventListener('popstate', schedule, true);
            window.addEventListener('hashchange', schedule, true);
        } catch (e3) {}
        setInterval(function() {
            var nextRouteKey = currentRouteKey();
            if (nextRouteKey !== lastRouteKey) {
                lastRouteKey = nextRouteKey;
                schedule();
            }
        }, ROUTE_POLL_MS);
    }

    function installObserver() {
        if (observer || typeof MutationObserver !== 'function') return;
        observer = new MutationObserver(function() {
            if (!isNoticeDetailPage()) return;
            if (latestResult && latestNoticeKey) {
                if (observerApplyTimer) return;
                observerApplyTimer = window.setTimeout(function() {
                    observerApplyTimer = 0;
                    if (latestResult) applyGuidedSaleHint(latestResult);
                }, 60);
                return;
            }
            if (domProbeMutationTimer) return;
            domProbeMutationTimer = window.setTimeout(function() {
                domProbeMutationTimer = 0;
                probeNoticeFromDom();
            }, 90);
        });
        try {
            observer.observe(document.documentElement || document.body, {
                subtree: true,
                childList: true
            });
        } catch (e) {}
    }

    function installNoticeGuidancePatch() {
        if (window.__AKNoticeGuidancePatchInstalled) return;
        window.__AKNoticeGuidancePatchInstalled = true;
        lastRouteKey = currentRouteKey();
        installNetworkHooks();
        installRouteHooks();
        installObserver();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
                scheduleHintApply();
                scheduleDomProbeSequence();
            }, { once: true });
        } else {
            scheduleHintApply();
            scheduleDomProbeSequence();
        }
    }

    window.AKClientRuntimePatches = window.AKClientRuntimePatches || {};
    window.AKClientRuntimePatches.installNoticeGuidancePatch = installNoticeGuidancePatch;
})();
