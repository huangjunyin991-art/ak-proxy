(function(global) {
    'use strict';

    if (global.AKClientRuntimeScheduler) return;

    var nextId = 1;
    var consoleRef = global.console || null;

    function normalizeDelay(value, fallback) {
        var num = Number(value);
        if (!isFinite(num)) num = Number(fallback || 0);
        return Math.max(0, num || 0);
    }

    function logError(label, error) {
        try {
            if (consoleRef && typeof consoleRef.error === 'function') {
                consoleRef.error('[AKClientRuntimeScheduler] ' + String(label || 'task') + ' failed', error || '');
            }
        } catch (e) {}
    }

    function runTask(task, label) {
        if (typeof task !== 'function') return;
        try {
            task();
        } catch (error) {
            logError(label, error);
        }
    }

    function createHandle(type, label) {
        return {
            id: nextId++,
            type: String(type || 'task'),
            label: String(label || ''),
            active: true,
            cancel: function() {
                this.active = false;
            }
        };
    }

    function delay(task, delayMs, options) {
        var opts = options || {};
        var handle = createHandle('timeout', opts.label);
        var timer = global.setTimeout(function() {
            if (!handle.active) return;
            handle.active = false;
            runTask(task, handle.label);
        }, normalizeDelay(delayMs, 0));
        handle.cancel = function() {
            if (!handle.active) return;
            handle.active = false;
            global.clearTimeout(timer);
        };
        return handle;
    }

    function every(task, intervalMs, options) {
        var opts = options || {};
        var handle = createHandle('interval', opts.label);
        var timer = global.setInterval(function() {
            if (!handle.active) return;
            runTask(task, handle.label);
        }, Math.max(1, normalizeDelay(intervalMs, 1000)));
        handle.cancel = function() {
            if (!handle.active) return;
            handle.active = false;
            global.clearInterval(timer);
        };
        return handle;
    }

    function cancel(handle) {
        if (!handle) return false;
        if (typeof handle.cancel === 'function') {
            handle.cancel();
            return true;
        }
        return false;
    }

    function group(handles, label) {
        var handle = createHandle('group', label);
        handle.cancel = function() {
            if (!handle.active) return;
            handle.active = false;
            (handles || []).forEach(cancel);
        };
        return handle;
    }

    function afterLoad(task, delayMs, options) {
        var opts = options || {};
        var wait = normalizeDelay(delayMs, 0);
        if (!global.document || global.document.readyState === 'complete') {
            return delay(task, wait, opts);
        }
        var handles = [];
        var loadHandler = function() {
            handles.push(delay(task, wait, { label: opts.label ? opts.label + ':load-delay' : '' }));
        };
        global.addEventListener('load', loadHandler, { once: true });
        handles.push({
            cancel: function() {
                try {
                    global.removeEventListener('load', loadHandler);
                } catch (e) {}
            }
        });
        return group(handles, opts.label || 'after-load');
    }

    function defer(task, options) {
        var opts = options || {};
        var wait = normalizeDelay(opts.delayMs, 1200);
        var label = opts.label || 'deferred-startup';
        var lightBoot = !!opts.lightBoot;
        var started = false;
        var handles = [];

        function runOnce() {
            if (started) return;
            started = true;
            runTask(task, label);
        }

        if (!lightBoot) {
            handles.push(delay(runOnce, 0, { label: label }));
            return group(handles, label);
        }

        if (typeof global.requestIdleCallback === 'function') {
            var idleId = global.requestIdleCallback(runOnce, { timeout: wait + 1500 });
            handles.push({
                cancel: function() {
                    try {
                        if (typeof global.cancelIdleCallback === 'function') global.cancelIdleCallback(idleId);
                    } catch (e) {}
                }
            });
        }

        handles.push(afterLoad(runOnce, wait, { label: label }));
        if (!global.document || global.document.readyState !== 'complete') {
            handles.push(delay(runOnce, wait + 2500, { label: label + ':fallback' }));
        }

        return group(handles, label);
    }

    global.AKClientRuntimeScheduler = {
        delay: delay,
        every: every,
        afterLoad: afterLoad,
        defer: defer,
        cancel: cancel
    };
})(window);
