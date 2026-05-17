(function() {
    'use strict';

    function call(fn, fallback, args) {
        try {
            return typeof fn === 'function' ? fn.apply(null, args || []) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function createScheduler(context) {
        const ctx = context || {};
        let mutationObserver = null;
        let globalEventsBound = false;

        function isActive() {
            return !!call(ctx.isActive, false);
        }

        function isManagedRoute(route) {
            return !!call(ctx.isManagedRoute, false, [route]);
        }

        function getRoute() {
            return String(call(ctx.normalizeRoute, '', []) || '');
        }

        function isWidgetTarget(target) {
            return !!call(ctx.isWidgetTarget, false, [target]);
        }

        function isFormFieldTarget(target) {
            return !!call(ctx.isFormFieldTarget, false, [target]);
        }

        function shouldIgnoreTarget(target) {
            try {
                return !target || isWidgetTarget(target);
            } catch (e) {
                return true;
            }
        }

        function stopDomObserver() {
            if (!mutationObserver) return;
            try {
                mutationObserver.disconnect();
            } catch (e) {}
            mutationObserver = null;
            call(ctx.clearSnapshotTimer, undefined);
            call(ctx.clearOverlaySnapshotTimer, undefined);
        }

        function startDomObserver() {
            stopDomObserver();
            if (!isActive() || !document.body || typeof MutationObserver === 'undefined') return;
            mutationObserver = new MutationObserver(function(mutations) {
                if (!isManagedRoute()) return;
                if (call(ctx.isSnapshotSuppressed, false)) return;
                const shouldRefresh = (mutations || []).some(function(mutation) {
                    const target = mutation && mutation.target && mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target;
                    return !shouldIgnoreTarget(target);
                });
                if (!shouldRefresh) return;
                if (call(ctx.isScrollSettling, false)) return;
                call(ctx.scheduleSnapshot, undefined, [600, 'mutation']);
            });
            mutationObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true
            });
        }

        function handleWindowScroll() {
            if (!isActive()) return;
            const route = getRoute();
            if (!isManagedRoute(route)) return;
            call(ctx.logScrollCapture, undefined, ['window', window]);
            call(ctx.rememberScrollTarget, undefined, [window]);
            call(ctx.scheduleRouteFastScrollSync, undefined, [route, Number(ctx.routeFastScrollDelay || 120)]);
            call(ctx.scheduleScroll, undefined, [Number(ctx.scrollSettleDelay || 240)]);
        }

        function handleDocumentScroll(event) {
            if (!isActive()) return;
            const route = getRoute();
            if (!isManagedRoute(route)) return;
            const target = event && event.target;
            if (isWidgetTarget(target)) return;
            call(ctx.logScrollCapture, undefined, ['document', target]);
            call(ctx.rememberScrollTarget, undefined, [target]);
            call(ctx.scheduleRouteFastScrollSync, undefined, [route, Number(ctx.routeFastScrollDelay || 120)]);
            call(ctx.scheduleScroll, undefined, [Number(ctx.scrollSettleDelay || 240)]);
        }

        function handleClick(event) {
            if (!isActive()) return;
            const target = event && event.target;
            if (isWidgetTarget(target)) return;
            if (!isManagedRoute()) return;
            call(ctx.sendEvent, undefined, ['click_highlight', call(ctx.pickMeta, {}, [target])]);
            if (!isFormFieldTarget(target)) {
                call(ctx.scheduleSnapshot, undefined, [100, 'click_interaction']);
            }
        }

        function handleFormValueChange(event) {
            if (!isActive()) return;
            const target = event && event.target;
            if (!isFormFieldTarget(target) || isWidgetTarget(target)) return;
            if (!isManagedRoute()) return;
            call(ctx.scheduleSnapshot, undefined, [120, 'form_input']);
        }

        function handleViewportResize() {
            if (!isActive()) return;
            if (!isManagedRoute()) return;
            call(ctx.scheduleSnapshot, undefined, [180, 'viewport_resize']);
        }

        function bindGlobalEvents() {
            if (globalEventsBound) return true;
            window.addEventListener('scroll', handleWindowScroll, { passive: true });
            window.addEventListener('resize', handleViewportResize);
            document.addEventListener('scroll', handleDocumentScroll, true);
            document.addEventListener('click', handleClick, true);
            document.addEventListener('input', handleFormValueChange, true);
            document.addEventListener('change', handleFormValueChange, true);
            globalEventsBound = true;
            return true;
        }

        return {
            startDomObserver: startDomObserver,
            stopDomObserver: stopDomObserver,
            bindGlobalEvents: bindGlobalEvents
        };
    }

    window.AKClientRuntimeAssistRealtime = window.AKClientRuntimeAssistRealtime || {};
    window.AKClientRuntimeAssistRealtime.createScheduler = createScheduler;
})();
