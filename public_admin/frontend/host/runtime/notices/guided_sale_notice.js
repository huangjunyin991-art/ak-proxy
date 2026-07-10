(function() {
    'use strict';

    var PAGE_SIZE = 15;
    var PAGE_INTERVAL_MS = 500;
    var DEFAULT_MAX_LINE_LENGTH = 24;
    var MAX_ANALYSIS_CACHE = 24;

    var BLOCK_TAGS = {
        P: true,
        DIV: true,
        LI: true,
        UL: true,
        OL: true,
        SECTION: true,
        ARTICLE: true,
        HEADER: true,
        FOOTER: true,
        H1: true,
        H2: true,
        H3: true,
        H4: true,
        H5: true,
        H6: true
    };

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

    function normalizeLineText(value) {
        return normalizeInlineText(value).replace(/\n+/g, '\n');
    }

    function htmlEscape(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function createHtmlDocument(html) {
        try {
            return new DOMParser().parseFromString('<!doctype html><html><body>' + String(html || '') + '</body></html>', 'text/html');
        } catch (e) {}
        return null;
    }

    function pushLine(lines, buffer) {
        var line = normalizeLineText(buffer.join(''));
        buffer.length = 0;
        if (line) lines.push(line);
    }

    function extractLinesFromHtml(html) {
        var doc = createHtmlDocument(html);
        if (!doc || !doc.body) {
            var fallback = normalizeLineText(String(html || '').replace(/<[^>]+>/g, ' '));
            return fallback ? [fallback] : [];
        }
        var lines = [];
        var buffer = [];

        function walk(node) {
            if (!node) return;
            if (node.nodeType === 3) {
                buffer.push(String(node.nodeValue || '').replace(/\u00a0/g, ' '));
                return;
            }
            if (node.nodeType !== 1) return;
            var tagName = String(node.tagName || '').toUpperCase();
            if (tagName === 'BR') {
                pushLine(lines, buffer);
                return;
            }
            var isBlock = !!BLOCK_TAGS[tagName];
            if (isBlock && buffer.length) pushLine(lines, buffer);
            var children = node.childNodes || [];
            for (var i = 0; i < children.length; i++) {
                walk(children[i]);
            }
            if (isBlock) pushLine(lines, buffer);
        }

        walk(doc.body);
        pushLine(lines, buffer);
        return lines;
    }

    function extractLongestLineLength(lines, fallbackLine) {
        var maxLength = 0;
        for (var i = 0; i < lines.length; i++) {
            var length = normalizeLineText(lines[i]).length;
            if (length > maxLength) maxLength = length;
        }
        if (!maxLength) maxLength = normalizeLineText(fallbackLine || '').length;
        return maxLength > 0 ? maxLength : DEFAULT_MAX_LINE_LENGTH;
    }

    function buildRpcV() {
        var now = new Date();
        return String(
            now.getFullYear()
            + (now.getMonth() + 1)
            + now.getDate()
            + now.getHours()
            + now.getMinutes()
        );
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

    function parseDateKey(value) {
        var text = trimString(value).replace(/\u00a0/g, ' ');
        if (!text) return 0;
        var match = text.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
        if (!match) return 0;
        var year = parseInt(match[1], 10);
        var month = parseInt(match[2], 10);
        var day = parseInt(match[3], 10);
        if (!year || month < 1 || month > 12 || day < 1 || day > 31) return 0;
        return year * 10000 + month * 100 + day;
    }

    function formatDateKey(year, month, day) {
        return (year * 10000) + (month * 100) + day;
    }

    function normalizeDateLabel(year, month, day) {
        return year + '年' + month + '月' + day + '日';
    }

    function buildAnalysisCacheKey(info, auth) {
        return [
            trimString(auth && auth.account).toLowerCase(),
            trimString(info && info.noticeId),
            trimString(info && info.title),
            trimString(info && info.startDateLabel),
            trimString(info && info.endDateLabel)
        ].join('|');
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
        var message = '例如您的账户' + accounts.join('，') + '处于此指导周期内！';
        return {
            text: message,
            lines: wrapTextByLength(message, maxLineLength)
        };
    }

    function extractGuidedSaleWindow(detail) {
        if (!detail || typeof detail !== 'object') return null;
        var title = trimString(detail.Title || detail.title);
        var html = String(detail.Text || detail.text || '');
        if (!title && !html) return null;
        var lines = extractLinesFromHtml(html);
        var contentText = lines.join('\n');
        if (!/指导销售/.test(title + '\n' + contentText)) return null;
        var targetLine = '';
        var match = null;
        var matcher = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:[-~—－]|至|到)\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*之间注册的账户/;
        for (var i = 0; i < lines.length; i++) {
            match = normalizeLineText(lines[i]).match(matcher);
            if (match) {
                targetLine = normalizeLineText(lines[i]);
                break;
            }
        }
        if (!match) {
            match = contentText.match(matcher);
            if (match) targetLine = normalizeLineText(match[0]);
        }
        if (!match) return null;
        var startYear = parseInt(match[1], 10);
        var startMonth = parseInt(match[2], 10);
        var startDay = parseInt(match[3], 10);
        var endYear = parseInt(match[4], 10);
        var endMonth = parseInt(match[5], 10);
        var endDay = parseInt(match[6], 10);
        var startKey = formatDateKey(startYear, startMonth, startDay);
        var endKey = formatDateKey(endYear, endMonth, endDay);
        if (!startKey || !endKey) return null;
        return {
            noticeId: trimString(detail.Id || detail.id),
            title: title,
            html: html,
            lines: lines,
            targetLine: targetLine || normalizeDateLabel(startYear, startMonth, startDay) + '-' + normalizeDateLabel(endYear, endMonth, endDay) + '之间注册的账户',
            startDateKey: startKey,
            endDateKey: endKey,
            startDateLabel: normalizeDateLabel(startYear, startMonth, startDay),
            endDateLabel: normalizeDateLabel(endYear, endMonth, endDay),
            maxLineLength: extractLongestLineLength(lines, targetLine)
        };
    }

    function buildSubaccountRequestBody(page, auth) {
        var params = new URLSearchParams();
        params.set('p', String(page));
        params.set('size', String(PAGE_SIZE));
        params.set('key', String(auth.key || ''));
        params.set('UserID', String(auth.userId || ''));
        params.set('v', buildRpcV());
        params.set('lang', 'cn');
        return params.toString();
    }

    function sleep(ms) {
        return new Promise(function(resolve) {
            setTimeout(resolve, Math.max(0, Number(ms) || 0));
        });
    }

    async function fetchSubaccountPage(page, auth) {
        var response = await window.fetch('/RPC/My_Subaccount', {
            method: 'POST',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: buildSubaccountRequestBody(page, auth),
            credentials: 'include'
        });
        if (!response || !response.ok) {
            throw new Error('My_Subaccount HTTP ' + String(response ? response.status : 0));
        }
        var payload = await response.json();
        if (!payload || typeof payload !== 'object') {
            throw new Error('My_Subaccount 返回不是对象');
        }
        if (payload.Error) {
            throw new Error(trimString(payload.Msg || payload.Message) || 'My_Subaccount Error=true');
        }
        var data = payload.Data;
        if (!data || typeof data !== 'object') {
            throw new Error('My_Subaccount Data 缺失');
        }
        var rows = Array.isArray(data.List) ? data.List : [];
        return {
            rows: rows,
            count: rows.length,
            pageSize: parseInt(data.PageSize, 10) || PAGE_SIZE,
            totalCount: parseInt(data.Count, 10) || 0
        };
    }

    async function scanSubaccountsWithinWindow(info, auth) {
        var page = 1;
        var matchedRows = [];
        var seenAccounts = {};
        var pagesScanned = 0;
        var stopReason = 'empty';
        while (true) {
            var result = await fetchSubaccountPage(page, auth);
            pagesScanned += 1;
            var rows = result.rows || [];
            if (!rows.length) {
                stopReason = page === 1 ? 'first_page_empty' : 'page_empty';
                break;
            }
            var newestDateKey = 0;
            var oldestDateKey = 0;
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i] || {};
                var account = trimString(row.MemberNo || row.member_no || row.memberNo || row.Account || row.account);
                var createTime = trimString(row.CreateTime || row.create_time || row.createTime);
                var dateKey = parseDateKey(createTime);
                if (dateKey > newestDateKey) newestDateKey = dateKey;
                if (!oldestDateKey || (dateKey && dateKey < oldestDateKey)) oldestDateKey = dateKey;
                if (!account || !dateKey) continue;
                if (dateKey >= info.startDateKey && dateKey <= info.endDateKey && !seenAccounts[account]) {
                    seenAccounts[account] = true;
                    matchedRows.push({
                        account: account,
                        createTime: createTime,
                        raw: row
                    });
                }
            }
            if (page === 1 && newestDateKey && newestDateKey < info.startDateKey) {
                stopReason = 'first_page_before_start';
                break;
            }
            if (oldestDateKey && oldestDateKey < info.startDateKey) {
                stopReason = 'reached_before_start';
                break;
            }
            if (rows.length < PAGE_SIZE) {
                stopReason = 'page_not_full';
                break;
            }
            page += 1;
            await sleep(PAGE_INTERVAL_MS);
        }
        matchedRows.sort(function(a, b) {
            var aKey = parseDateKey(a && a.createTime);
            var bKey = parseDateKey(b && b.createTime);
            if (aKey !== bKey) return bKey - aKey;
            return String(a && a.account || '').localeCompare(String(b && b.account || ''));
        });
        var accounts = matchedRows.map(function(item) { return item.account; });
        return {
            accounts: accounts,
            rows: matchedRows,
            pagesScanned: pagesScanned,
            stopReason: stopReason
        };
    }

    function buildNoticeResult(info, auth, scanResult) {
        var hint = buildHintMessage(scanResult.accounts || [], info.maxLineLength);
        return {
            noticeKey: buildAnalysisCacheKey(info, auth),
            noticeId: info.noticeId,
            title: info.title,
            targetLine: info.targetLine,
            startDateLabel: info.startDateLabel,
            endDateLabel: info.endDateLabel,
            maxLineLength: info.maxLineLength,
            accounts: scanResult.accounts || [],
            rows: scanResult.rows || [],
            pagesScanned: scanResult.pagesScanned || 0,
            stopReason: scanResult.stopReason || '',
            hintText: hint.text,
            hintLines: hint.lines,
            hintHtml: hint.lines.map(htmlEscape).join('<br />')
        };
    }

    async function analyzeGuidedSaleNotice(detail) {
        var info = extractGuidedSaleWindow(detail);
        if (!info) return null;
        var auth = readCurrentAuth();
        if (!auth.key || !auth.userId) {
            logWarn('跳过指导销售提示：当前登录态缺少 key 或 UserID');
            return null;
        }
        var cacheKey = buildAnalysisCacheKey(info, auth);
        if (analysisPromiseCache[cacheKey]) return analysisPromiseCache[cacheKey];
        var promise = scanSubaccountsWithinWindow(info, auth)
            .then(function(scanResult) {
                return buildNoticeResult(info, auth, scanResult);
            })
            .catch(function(error) {
                logWarn('扫描指导销售账号失败', String(error && error.message || error || 'unknown'));
                return null;
            });
        analysisPromiseCache[cacheKey] = promise;
        rememberAnalysisCacheKey(cacheKey);
        return promise;
    }

    function extractNoticeDetail(detailEnvelope) {
        if (!detailEnvelope || typeof detailEnvelope !== 'object') return null;
        if (detailEnvelope.Error === true) return null;
        var data = detailEnvelope.Data;
        if (!data || typeof data !== 'object') return null;
        if (!trimString(data.Title || data.title) && !trimString(data.Text || data.text)) return null;
        return data;
    }

    async function analyzeGuidedSaleNoticeEnvelope(detailEnvelope) {
        var detail = extractNoticeDetail(detailEnvelope);
        if (!detail) return null;
        return analyzeGuidedSaleNotice(detail);
    }

    window.AKClientRuntimeNotices = window.AKClientRuntimeNotices || {};
    window.AKClientRuntimeNotices.extractGuidedSaleWindow = extractGuidedSaleWindow;
    window.AKClientRuntimeNotices.analyzeGuidedSaleNotice = analyzeGuidedSaleNotice;
    window.AKClientRuntimeNotices.analyzeGuidedSaleNoticeEnvelope = analyzeGuidedSaleNoticeEnvelope;
    window.AKClientRuntimeNotices.extractNoticeDetail = extractNoticeDetail;
})();
