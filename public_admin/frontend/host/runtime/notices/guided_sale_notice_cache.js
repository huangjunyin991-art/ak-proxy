(function() {
    'use strict';

    var RESULT_PREFIX = 'AKNoticeGuidance:result:';
    var PENDING_PREFIX = 'AKNoticeGuidance:pending:';
    var RESULT_INDEX_KEY = 'AKNoticeGuidance:result:index:v1';
    var PENDING_INDEX_KEY = 'AKNoticeGuidance:pending:index:v1';
    var MAX_RESULT_ENTRIES = 128;
    var MAX_PENDING_ENTRIES = 64;

    function trimString(value) {
        return String(value == null ? '' : value).trim();
    }

    function getStorage() {
        try {
            return window.localStorage || null;
        } catch (e) {}
        return null;
    }

    function parseJsonText(text) {
        try {
            var data = JSON.parse(text);
            return data && typeof data === 'object' ? data : null;
        } catch (e) {}
        return null;
    }

    function readJson(storage, key) {
        if (!storage || !key) return null;
        try {
            var raw = storage.getItem(key);
            if (!raw) return null;
            return parseJsonText(raw);
        } catch (e) {}
        return null;
    }

    function writeText(storage, key, text) {
        if (!storage || !key) return false;
        try {
            storage.setItem(key, String(text == null ? '' : text));
            return true;
        } catch (e) {}
        return false;
    }

    function removeItem(storage, key) {
        if (!storage || !key) return;
        try {
            storage.removeItem(key);
        } catch (e) {}
    }

    function normalizeIndex(value) {
        if (!Array.isArray(value)) return [];
        var result = [];
        var seen = {};
        for (var i = 0; i < value.length; i++) {
            var item = value[i];
            var key = trimString(item && item.key ? item.key : item);
            if (!key || seen[key]) continue;
            seen[key] = 1;
            result.push({
                key: key,
                updatedAt: parseInt(item && item.updatedAt, 10) || 0
            });
        }
        return result;
    }

    function writeIndex(storage, indexKey, index) {
        return writeText(storage, indexKey, JSON.stringify(index || []));
    }

    function removeFromIndex(storage, indexKey, cacheKey) {
        var key = trimString(cacheKey);
        if (!storage || !key) return;
        var index = normalizeIndex(readJson(storage, indexKey));
        var next = [];
        for (var i = 0; i < index.length; i++) {
            if (index[i].key === key) continue;
            next.push(index[i]);
        }
        writeIndex(storage, indexKey, next);
    }

    function readEntry(prefix, indexKey, cacheKey) {
        var key = trimString(cacheKey);
        var storage = getStorage();
        if (!storage || !key) return null;
        var entry = readJson(storage, prefix + key);
        if (!entry || typeof entry !== 'object' || !entry.payload || typeof entry.payload !== 'object') {
            removeItem(storage, prefix + key);
            removeFromIndex(storage, indexKey, key);
            return null;
        }
        return entry.payload;
    }

    function writeEntry(prefix, indexKey, maxEntries, cacheKey, payload) {
        var key = trimString(cacheKey);
        var storage = getStorage();
        if (!storage || !key || !payload || typeof payload !== 'object') return false;
        var timestamp = Date.now();
        var entryText = JSON.stringify({
            version: 1,
            updatedAt: timestamp,
            payload: payload
        });
        var index = normalizeIndex(readJson(storage, indexKey));
        var nextIndex = [{ key: key, updatedAt: timestamp }];
        for (var i = 0; i < index.length; i++) {
            if (index[i].key === key) continue;
            nextIndex.push(index[i]);
        }
        while (nextIndex.length > maxEntries) {
            var removed = nextIndex.pop();
            if (removed && removed.key) removeItem(storage, prefix + removed.key);
        }
        var attempts = nextIndex.length + 1;
        for (var attempt = 0; attempt < attempts; attempt++) {
            var wroteEntry = writeText(storage, prefix + key, entryText);
            var wroteIndex = wroteEntry && writeIndex(storage, indexKey, nextIndex);
            if (wroteEntry && wroteIndex) return true;
            var evicted = nextIndex.pop();
            if (!evicted || evicted.key === key) break;
            removeItem(storage, prefix + evicted.key);
        }
        return false;
    }

    function clearEntry(prefix, indexKey, cacheKey) {
        var key = trimString(cacheKey);
        var storage = getStorage();
        if (!storage || !key) return false;
        removeItem(storage, prefix + key);
        removeFromIndex(storage, indexKey, key);
        return true;
    }

    window.AKClientRuntimeNoticeGuidanceCache = window.AKClientRuntimeNoticeGuidanceCache || {};
    window.AKClientRuntimeNoticeGuidanceCache.getResultEntry = function(cacheKey) {
        return readEntry(RESULT_PREFIX, RESULT_INDEX_KEY, cacheKey);
    };
    window.AKClientRuntimeNoticeGuidanceCache.setResultEntry = function(cacheKey, payload) {
        return writeEntry(RESULT_PREFIX, RESULT_INDEX_KEY, MAX_RESULT_ENTRIES, cacheKey, payload);
    };
    window.AKClientRuntimeNoticeGuidanceCache.clearResultEntry = function(cacheKey) {
        return clearEntry(RESULT_PREFIX, RESULT_INDEX_KEY, cacheKey);
    };
    window.AKClientRuntimeNoticeGuidanceCache.getPendingEntry = function(cacheKey) {
        return readEntry(PENDING_PREFIX, PENDING_INDEX_KEY, cacheKey);
    };
    window.AKClientRuntimeNoticeGuidanceCache.setPendingEntry = function(cacheKey, payload) {
        return writeEntry(PENDING_PREFIX, PENDING_INDEX_KEY, MAX_PENDING_ENTRIES, cacheKey, payload);
    };
    window.AKClientRuntimeNoticeGuidanceCache.clearPendingEntry = function(cacheKey) {
        return clearEntry(PENDING_PREFIX, PENDING_INDEX_KEY, cacheKey);
    };
})();
