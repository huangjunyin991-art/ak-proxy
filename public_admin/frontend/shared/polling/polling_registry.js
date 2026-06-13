(function(global) {
    'use strict';

    if (global.AKPollingRegistry) return;

    var config = {
        sendWsMessage: null,
        isWsOpen: null,
        logger: global.console || null
    };
    var tasks = {};
    var ownerTasks = {};
    var activeOwners = {};
    var topicHandlers = {};
    var topicOwners = {};
    var topicFreshness = {};
    var inFlight = {};

    function logError(message, error) {
        try {
            if (config.logger && typeof config.logger.error === 'function') {
                config.logger.error('[AKPollingRegistry] ' + message, error || '');
            }
        } catch (e) {}
    }

    function now() {
        return Date.now ? Date.now() : new Date().getTime();
    }

    function wsOpen() {
        try {
            return typeof config.isWsOpen === 'function' ? !!config.isWsOpen() : false;
        } catch (e) {
            return false;
        }
    }

    function sendWs(payload) {
        try {
            if (typeof config.sendWsMessage === 'function' && wsOpen()) {
                return !!config.sendWsMessage(payload);
            }
        } catch (e) {
            logError('WS send failed', e);
        }
        return false;
    }

    function canRunTask(task) {
        if (!task) return false;
        if (typeof task.runWhen !== 'function') return true;
        try {
            return !!task.runWhen();
        } catch (e) {
            logError('runWhen failed for ' + task.id, e);
            return false;
        }
    }

    function scheduleTask(task) {
        if (!task || task.timer) return;
        var interval = Math.max(1000, Number(task.intervalMs || 1000));
        var jitter = Math.max(0, Number(task.jitterMs || 0));
        var firstDelay = task.immediate ? 0 : interval;
        if (jitter) firstDelay += Math.floor(Math.random() * jitter);
        task.timer = global.setTimeout(function tick() {
            task.timer = null;
            runTask(task.id);
            if (activeOwners[task.owner]) {
                task.timer = global.setTimeout(tick, interval + (jitter ? Math.floor(Math.random() * jitter) : 0));
            }
        }, firstDelay);
    }

    function stopTask(task) {
        if (!task || !task.timer) return;
        global.clearTimeout(task.timer);
        task.timer = null;
    }

    function runTask(id) {
        var task = tasks[id];
        if (!task || !activeOwners[task.owner] || !canRunTask(task)) return Promise.resolve(false);
        var key = task.dedupeKey || id;
        if (inFlight[key]) return inFlight[key];
        var promise;
        try {
            promise = Promise.resolve(task.task({ reason: 'interval' }));
        } catch (e) {
            promise = Promise.reject(e);
        }
        inFlight[key] = promise.catch(function(error) {
            logError('task failed: ' + id, error);
        }).finally(function() {
            delete inFlight[key];
        });
        return inFlight[key];
    }

    function register(task) {
        if (!task || !task.id || !task.owner || typeof task.task !== 'function') return false;
        if (tasks[task.id]) stopTask(tasks[task.id]);
        tasks[task.id] = {
            id: String(task.id),
            owner: String(task.owner),
            intervalMs: Number(task.intervalMs || 1000),
            jitterMs: Number(task.jitterMs || 0),
            immediate: task.immediate !== false,
            runWhen: task.runWhen,
            task: task.task,
            dedupeKey: task.dedupeKey || task.id,
            timer: null
        };
        ownerTasks[tasks[task.id].owner] = ownerTasks[tasks[task.id].owner] || {};
        ownerTasks[tasks[task.id].owner][tasks[task.id].id] = true;
        if (activeOwners[tasks[task.id].owner]) scheduleTask(tasks[task.id]);
        return true;
    }

    function registerTopic(options) {
        if (!options || !options.topic || !options.owner) return false;
        var topic = String(options.topic);
        var owner = String(options.owner);
        topicOwners[topic] = topicOwners[topic] || {};
        topicOwners[topic][owner] = true;
        if (typeof options.onData === 'function') {
            topicHandlers[topic] = topicHandlers[topic] || {};
            topicHandlers[topic][owner] = options.onData;
        }
        if (typeof options.fallbackTask === 'function') {
            register({
                id: 'topic-fallback:' + topic,
                owner: owner,
                intervalMs: options.intervalMs || 15000,
                jitterMs: options.jitterMs || 1000,
                immediate: false,
                dedupeKey: 'topic-fallback:' + topic,
                runWhen: function() {
                    if (typeof options.runWhen === 'function' && !options.runWhen()) return false;
                    var fresh = topicFreshness[topic] || 0;
                    var fallbackAfter = Math.max(1000, Number(options.fallbackAfterMs || (Number(options.intervalMs || 15000) * 2)));
                    return !wsOpen() || now() - fresh > fallbackAfter;
                },
                task: options.fallbackTask
            });
        }
        if (activeOwners[owner]) subscribeTopic(topic);
        return true;
    }

    function startOwner(owner) {
        owner = String(owner || '');
        if (!owner) return;
        activeOwners[owner] = true;
        Object.keys(tasks).forEach(function(id) {
            if (tasks[id].owner === owner) scheduleTask(tasks[id]);
        });
        Object.keys(topicOwners).forEach(function(topic) {
            if (topicOwners[topic][owner]) subscribeTopic(topic);
        });
    }

    function stopOwner(owner) {
        owner = String(owner || '');
        if (!owner) return;
        delete activeOwners[owner];
        Object.keys(tasks).forEach(function(id) {
            if (tasks[id].owner === owner) stopTask(tasks[id]);
        });
        Object.keys(topicOwners).forEach(function(topic) {
            if (topicOwners[topic][owner]) unsubscribeTopic(topic);
        });
    }

    function pauseAll() {
        Object.keys(tasks).forEach(function(id) { stopTask(tasks[id]); });
        Object.keys(topicOwners).forEach(function(topic) { unsubscribeTopic(topic); });
    }

    function resumeOwners() {
        Object.keys(activeOwners).forEach(startOwner);
    }

    function subscribeTopic(topic) {
        return sendWs({ type: 'admin_topic_subscribe', topics: [String(topic || '')] });
    }

    function unsubscribeTopic(topic) {
        return sendWs({ type: 'admin_topic_unsubscribe', topics: [String(topic || '')] });
    }

    function requestTopic(topic) {
        return sendWs({ type: 'admin_topic_refresh', topic: String(topic || '') });
    }

    function handleWebSocketMessage(message) {
        if (!message || message.type !== 'admin_topic_data') return false;
        var topic = String(message.topic || '');
        if (!topic) return false;
        topicFreshness[topic] = now();
        var handlers = topicHandlers[topic] || {};
        Object.keys(handlers).forEach(function(owner) {
            var handler = handlers[owner];
            try {
                handler(message.data || {}, message);
            } catch (e) {
                logError('topic handler failed: ' + topic, e);
            }
        });
        return true;
    }

    function configure(nextConfig) {
        nextConfig = nextConfig || {};
        Object.keys(nextConfig).forEach(function(key) {
            config[key] = nextConfig[key];
        });
    }

    global.AKPollingRegistry = {
        configure: configure,
        register: register,
        registerTopic: registerTopic,
        startOwner: startOwner,
        stopOwner: stopOwner,
        pauseAll: pauseAll,
        resumeOwners: resumeOwners,
        requestTopic: requestTopic,
        handleWebSocketMessage: handleWebSocketMessage,
        isWsOpen: wsOpen
    };
})(window);
