(function() {
    'use strict';

    var DEFAULT_MAX_LINE_LENGTH = 24;
    var MAX_ANALYSIS_CACHE = 24;

    var analysisPromiseCache = {};
    var analysisCacheKeys = [];

    function logWarn(message, extra) {
        try {
            if (extra === undefined) {
                console.warn('[AKNoticeGuidance]', message);
                return;
            }
            console.warn('[AKNoticeGuidance]', message, extra);
        } catch (e) {}
    }

    function trimString(value) {
        return String(value == null ? '' : value).trim();
    }

    function normalizeInlineText(value) {
        return trimString(value)
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t\r\f\v]+/g, ' ');
    }

    function htmlEscape(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function parseStoredJson(key) {
        try {
            var raw = window.localStorage ? window.localStorage.getItem(key) : '';
            if (!raw) return null;
            var data = JSON.parse(raw);
            return data && typeof data === 'object' ? data : null;
        } catch (e) {}
        return null;
    }

    function firstNonEmpty(values) {
        for (var i = 0; i < values.length; i++) {
            var value = trimString(values[i]);
            if (value) return value;
        }
        return '';
    }

    function stripHtmlTags(value) {
        return String(value == null ? '' : value).replace(/<[^>]*>/g, ' ');
    }

    function buildNoticeTextFingerprint(value) {
        var normalized = normalizeInlineText(stripHtmlTags(value));
        if (!normalized) return '';
        return String(normalized.length) + ':' + normalized.slice(0, 160);
    }

    function readCurrentAuth() {
        var model = null;
        try {
            model = window.APP && APP.USER && APP.USER.MODEL && typeof APP.USER.MODEL === 'object'
                ? APP.USER.MODEL
                : null;
        } catch (e) {}
        if (!model) {
            try {
                model = window.USER_MODEL && typeof window.USER_MODEL === 'object' ? window.USER_MODEL : null;
            } catch (e2) {}
        }
        var loginResult = parseStoredJson('ak_login_result') || {};
        var storedUserModel = parseStoredJson('AK_user_model') || {};
        var userData = loginResult && typeof loginResult.UserData === 'object' ? loginResult.UserData : {};
        var account = firstNonEmpty([
            model && (model.UserName || model.Username || model.username || model.Account || model.account || model.LoginName || model.loginName),
            userData && (userData.UserName || userData.Username || userData.username || userData.Account || userData.account),
            storedUserModel && (storedUserModel.UserName || storedUserModel.username || storedUserModel.Account),
            window.localStorage ? window.localStorage.getItem('ak_username') : ''
        ]).toLowerCase();
        var key = firstNonEmpty([
            model && (model.Key || model.key || model.UserKey || model.userkey),
            loginResult && (loginResult.Key || loginResult.key),
            userData && (userData.Key || userData.key),
            window.localStorage ? window.localStorage.getItem('userkey') : '',
            window.localStorage ? window.localStorage.getItem('UserKey') : ''
        ]);
        var userId = firstNonEmpty([
            model && (model.Id || model.ID || model.UserID || model.userid || model.id),
            userData && (userData.Id || userData.ID || userData.UserID || userData.userid || userData.id),
            loginResult && (loginResult.UserID || loginResult.user_id || loginResult.userid)
        ]);
        return {
            account: account,
            key: key,
            userId: userId
        };
    }

    function buildNoticeIdentityKey(notice) {
        var noticeId = trimString(notice && (notice.Id || notice.id));
        if (noticeId) return 'id:' + noticeId;
        var title = normalizeInlineText(notice && (notice.Title || notice.title));
        var createTime = trimString(notice && (notice.CreateTime || notice.createTime || notice.create_time));
        if (title || createTime) {
            return 'meta:' + title + '|' + createTime;
        }
        var textFingerprint = buildNoticeTextFingerprint(notice && (notice.Text || notice.text));
        return textFingerprint ? ('text:' + textFingerprint) : '';
    }

    function buildAnalysisCacheKey(notice, auth) {
        return [
            trimString(auth && auth.account).toLowerCase() || trimString(auth && auth.userId),
            buildNoticeIdentityKey(notice)
        ].join('|');
    }

    function getGuidedSaleCache() {
        try {
            return window.AKClientRuntimeNoticeGuidanceCache || null;
        } catch (e) {}
        return null;
    }

    function buildCachedNoticeMeta(notice) {
        return {
            noticeId: trimString(notice && (notice.Id || notice.id)),
            title: trimString(notice && (notice.Title || notice.title)),
            createTime: trimString(notice && (notice.CreateTime || notice.createTime || notice.create_time))
        };
    }

    function buildCachedAuthMeta(auth) {
        return {
            account: trimString(auth && auth.account).toLowerCase(),
            userId: trimString(auth && auth.userId)
        };
    }

    function readPersistentGuidedSaleResult(cacheKey) {
        var key = trimString(cacheKey);
        var cache = getGuidedSaleCache();
        if (!key || !cache || typeof cache.getResultEntry !== 'function') return null;
        var entry = cache.getResultEntry(key);
        if (!entry || typeof entry !== 'object') return null;
        return decorateGuidedSaleResult(entry.rawResult || entry.result || null);
    }

    function storePersistentGuidedSalePending(cacheKey, notice, auth, extra) {
        var key = trimString(cacheKey);
        var cache = getGuidedSaleCache();
        if (!key || !cache || typeof cache.setPendingEntry !== 'function') return;
        var payload = {
            startedAt: Date.now(),
            notice: buildCachedNoticeMeta(notice),
            auth: buildCachedAuthMeta(auth)
        };
        if (extra && typeof extra === 'object') {
            for (var prop in extra) {
                if (!Object.prototype.hasOwnProperty.call(extra, prop)) continue;
                payload[prop] = extra[prop];
            }
        }
        cache.setPendingEntry(key, payload);
    }

    function clearPersistentGuidedSalePending(cacheKey) {
        var key = trimString(cacheKey);
        var cache = getGuidedSaleCache();
        if (!key || !cache || typeof cache.clearPendingEntry !== 'function') return;
        cache.clearPendingEntry(key);
    }

    function storePersistentGuidedSaleResult(cacheKey, notice, auth, rawResult) {
        var key = trimString(cacheKey);
        var cache = getGuidedSaleCache();
        if (!key || !cache || typeof cache.setResultEntry !== 'function') return;
        cache.setResultEntry(key, {
            savedAt: Date.now(),
            notice: buildCachedNoticeMeta(notice),
            auth: buildCachedAuthMeta(auth),
            rawResult: rawResult
        });
        clearPersistentGuidedSalePending(key);
    }

    function rememberAnalysisCacheKey(key) {
        if (!key) return;
        if (analysisCacheKeys.indexOf(key) >= 0) return;
        analysisCacheKeys.push(key);
        while (analysisCacheKeys.length > MAX_ANALYSIS_CACHE) {
            var removed = analysisCacheKeys.shift();
            if (removed && Object.prototype.hasOwnProperty.call(analysisPromiseCache, removed)) {
                delete analysisPromiseCache[removed];
            }
        }
    }

    function wrapTextByLength(text, maxLineLength) {
        var normalized = normalizeInlineText(text);
        if (!normalized) return [];
        var limit = Math.max(8, parseInt(maxLineLength, 10) || DEFAULT_MAX_LINE_LENGTH);
        if (normalized.length <= limit) return [normalized];
        var lines = [];
        var cursor = 0;
        while (cursor < normalized.length) {
            var next = Math.min(normalized.length, cursor + limit);
            if (next < normalized.length) {
                var breakIndex = -1;
                for (var i = next; i > cursor + Math.floor(limit * 0.4); i--) {
                    var ch = normalized.charAt(i - 1);
                    if (ch === '，' || ch === ',' || ch === '、' || ch === '；' || ch === ';' || ch === ' ') {
                        breakIndex = i;
                        break;
                    }
                }
                if (breakIndex > cursor) next = breakIndex;
            }
            lines.push(trimString(normalized.slice(cursor, next)));
            cursor = next;
        }
        return lines.filter(function(line) { return !!line; });
    }

    function buildHintMessage(accounts, maxLineLength) {
        if (!accounts || !accounts.length) {
            return {
                text: '您当前没有账户处于此指导周期！',
                lines: wrapTextByLength('您当前没有账户处于此指导周期！', maxLineLength)
            };
        }
        var message = '您的账户' + accounts.join('，') + '处于此指导周期内！';
        return {
            text: message,
            lines: wrapTextByLength(message, maxLineLength)
        };
    }

    function extractNoticeDetail(detailEnvelope) {
        if (!detailEnvelope || typeof detailEnvelope !== 'object') return null;
        if (detailEnvelope.Error === true) return null;
        var data = detailEnvelope.Data;
        if (!data || typeof data !== 'object') return null;
        if (!trimString(data.Title || data.title) && !trimString(data.Text || data.text)) return null;
        return data;
    }

    async function requestGuidedSaleAnalysis(notice, auth) {
        var response = await window.fetch('/api/notice-guidance/guided-sale', {
            method: 'POST',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            credentials: 'include',
            body: JSON.stringify({
                notice: {
                    Id: trimString(notice.Id || notice.id),
                    Title: String(notice.Title || notice.title || ''),
                    Text: String(notice.Text || notice.text || ''),
                    CreateTime: trimString(notice.CreateTime || notice.createTime || notice.create_time)
                },
                auth: {
                    account: trimString(auth.account),
                    key: trimString(auth.key),
                    userId: trimString(auth.userId)
                }
            })
        });
        var payload = null;
        try {
            payload = await response.json();
        } catch (e) {
            payload = null;
        }
        if (!response || !response.ok) {
            throw new Error(trimString(payload && payload.message) || ('notice guidance http ' + String(response ? response.status : 0)));
        }
        if (!payload || payload.success !== true) {
            throw new Error(trimString(payload && payload.message) || 'notice guidance failed');
        }
        if (!payload.enabled || !payload.result || typeof payload.result !== 'object') {
            return null;
        }
        return payload.result;
    }

    function decorateGuidedSaleResult(result) {
        if (!result || typeof result !== 'object') return null;
        var accounts = Array.isArray(result.accounts) ? result.accounts.filter(function(item) {
            return !!trimString(item);
        }) : [];
        var maxLineLength = Math.max(8, parseInt(result.maxLineLength, 10) || DEFAULT_MAX_LINE_LENGTH);
        var hint = buildHintMessage(accounts, maxLineLength);
        return {
            noticeKey: trimString(result.noticeKey),
            noticeId: trimString(result.noticeId),
            title: trimString(result.title),
            targetLine: trimString(result.targetLine),
            startDateLabel: trimString(result.startDateLabel),
            endDateLabel: trimString(result.endDateLabel),
            maxLineLength: maxLineLength,
            accounts: accounts,
            rows: Array.isArray(result.rows) ? result.rows : [],
            pagesScanned: parseInt(result.pagesScanned, 10) || 0,
            stopReason: trimString(result.stopReason),
            hintText: hint.text,
            hintLines: hint.lines,
            hintHtml: hint.lines.map(htmlEscape).join('<br />')
        };
    }

    async function analyzeGuidedSaleNotice(notice) {
        if (!notice || typeof notice !== 'object') return null;
        var auth = readCurrentAuth();
        if (!auth.key || !auth.userId) {
            logWarn('skip guided sale analysis: missing key or UserID');
            return null;
        }
        var cacheKey = buildAnalysisCacheKey(notice, auth);
        if (cacheKey && analysisPromiseCache[cacheKey]) {
            return analysisPromiseCache[cacheKey];
        }
        var cachedResult = cacheKey ? readPersistentGuidedSaleResult(cacheKey) : null;
        if (cachedResult) {
            if (cacheKey) {
                analysisPromiseCache[cacheKey] = Promise.resolve(cachedResult);
                rememberAnalysisCacheKey(cacheKey);
            }
            return cachedResult;
        }
        if (cacheKey) {
            storePersistentGuidedSalePending(cacheKey, notice, auth, {
                status: 'pending',
                lastAttemptAt: Date.now()
            });
        }
        var promise = requestGuidedSaleAnalysis(notice, auth)
            .then(function(result) {
                clearPersistentGuidedSalePending(cacheKey);
                if (!result || typeof result !== 'object') return null;
                var decoratedResult = decorateGuidedSaleResult(result);
                if (cacheKey && decoratedResult) {
                    storePersistentGuidedSaleResult(cacheKey, notice, auth, result);
                }
                return decoratedResult;
            })
            .catch(function(error) {
                if (cacheKey && Object.prototype.hasOwnProperty.call(analysisPromiseCache, cacheKey)) {
                    delete analysisPromiseCache[cacheKey];
                }
                if (cacheKey) {
                    storePersistentGuidedSalePending(cacheKey, notice, auth, {
                        status: 'error',
                        lastAttemptAt: Date.now(),
                        lastError: trimString(error && error.message || error || 'unknown')
                    });
                }
                logWarn('guided sale analysis failed', String(error && error.message || error || 'unknown'));
                return null;
            });
        if (cacheKey) {
            analysisPromiseCache[cacheKey] = promise;
            rememberAnalysisCacheKey(cacheKey);
        }
        return promise;
    }

    async function analyzeGuidedSaleNoticeEnvelope(detailEnvelope) {
        var notice = extractNoticeDetail(detailEnvelope);
        if (!notice) return null;
        return analyzeGuidedSaleNotice(notice);
    }

    function getCachedGuidedSaleResultByNoticeId(noticeId) {
        var normalizedNoticeId = trimString(noticeId);
        if (!normalizedNoticeId) return null;
        var auth = readCurrentAuth();
        var cacheKey = buildAnalysisCacheKey({ Id: normalizedNoticeId }, auth);
        if (!cacheKey) return null;
        var cachedResult = readPersistentGuidedSaleResult(cacheKey);
        if (!cachedResult) return null;
        analysisPromiseCache[cacheKey] = Promise.resolve(cachedResult);
        rememberAnalysisCacheKey(cacheKey);
        return cachedResult;
    }

    window.AKClientRuntimeNotices = window.AKClientRuntimeNotices || {};
    window.AKClientRuntimeNotices.extractNoticeDetail = extractNoticeDetail;
    window.AKClientRuntimeNotices.getCachedGuidedSaleResultByNoticeId = getCachedGuidedSaleResultByNoticeId;
    window.AKClientRuntimeNotices.analyzeGuidedSaleNotice = analyzeGuidedSaleNotice;
    window.AKClientRuntimeNotices.analyzeGuidedSaleNoticeEnvelope = analyzeGuidedSaleNoticeEnvelope;
})();
