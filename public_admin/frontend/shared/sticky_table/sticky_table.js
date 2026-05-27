(function() {
    'use strict';

    var DEFAULTS = {
        stickyFirstColumn: true,
        stickyHeader: true,
        firstColumnMinWidth: 96,
        firstColumnMaxWidth: 180,
        firstColumnPadding: 28,
        minWidth: 0,
        compact: true,
        scrollHint: true
    };
    var EDGE_THRESHOLD = 8;

    function toNumber(value, fallback) {
        var num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    }

    function optionFromDataset(container) {
        var data = container.dataset || {};
        return {
            stickyFirstColumn: data.akStickyFirstColumn !== '0',
            stickyHeader: data.akStickyHeader !== '0',
            firstColumnMinWidth: toNumber(data.akStickyFirstColumnMin, DEFAULTS.firstColumnMinWidth),
            firstColumnMaxWidth: toNumber(data.akStickyFirstColumnMax, DEFAULTS.firstColumnMaxWidth),
            firstColumnPadding: toNumber(data.akStickyFirstColumnPadding, DEFAULTS.firstColumnPadding),
            minWidth: toNumber(data.akStickyTableMinWidth, DEFAULTS.minWidth),
            compact: data.akStickyDensity !== 'normal',
            scrollHint: data.akStickyScrollHint !== '0'
        };
    }

    function mergeOptions(container, options) {
        var datasetOptions = optionFromDataset(container);
        var merged = {};
        Object.keys(DEFAULTS).forEach(function(key) {
            merged[key] = DEFAULTS[key];
        });
        Object.keys(datasetOptions).forEach(function(key) {
            merged[key] = datasetOptions[key];
        });
        if (options) {
            Object.keys(options).forEach(function(key) {
                merged[key] = options[key];
            });
        }
        return merged;
    }

    function tableOf(container) {
        if (!container) return null;
        if (container.tagName && container.tagName.toLowerCase() === 'table') return container;
        return container.querySelector('table');
    }

    function textWidth(text, element) {
        var span = document.createElement('span');
        var style = element ? window.getComputedStyle(element) : null;
        span.textContent = String(text || '');
        span.style.position = 'absolute';
        span.style.visibility = 'hidden';
        span.style.whiteSpace = 'nowrap';
        span.style.font = style ? style.font : '12px sans-serif';
        document.body.appendChild(span);
        var width = span.getBoundingClientRect().width;
        span.parentNode.removeChild(span);
        return width;
    }

    function measureFirstColumn(container, table, options) {
        if (!table || !options.stickyFirstColumn) return;
        var cells = Array.prototype.slice.call(table.querySelectorAll('thead th:first-child, tbody td:first-child'));
        var maxWidth = 0;
        cells.slice(0, 120).forEach(function(cell) {
            maxWidth = Math.max(maxWidth, textWidth(cell.textContent || '', cell));
        });
        var width = Math.max(options.firstColumnMinWidth, Math.min(options.firstColumnMaxWidth, Math.ceil(maxWidth + options.firstColumnPadding)));
        container.style.setProperty('--ak-sticky-table-first-col-width', width + 'px');
    }

    function updateScrollState(container, table) {
        if (!container || !table) return;
        var maxScrollLeft = Math.max(0, table.scrollWidth - container.clientWidth);
        container.classList.toggle('ak-sticky-table-can-scroll-x', maxScrollLeft > 12);
        container.classList.toggle('ak-sticky-table-scrolled-x', container.scrollLeft > EDGE_THRESHOLD && maxScrollLeft > 12);
    }

    function createHint() {
        var hint = document.createElement('button');
        hint.type = 'button';
        hint.className = 'ak-sticky-table-hint';
        hint.setAttribute('aria-label', '滚动表格');
        hint.innerHTML = '<span>&gt;</span><span>&gt;</span><span>&gt;</span>';
        return hint;
    }

    function setHintDirection(hint, direction) {
        var isLeft = direction === 'left';
        hint.dataset.direction = isLeft ? 'left' : 'right';
        hint.innerHTML = isLeft ? '<span>&lt;</span><span>&lt;</span><span>&lt;</span>' : '<span>&gt;</span><span>&gt;</span><span>&gt;</span>';
        hint.setAttribute('aria-label', isLeft ? '滚动到最左侧' : '滚动到最右侧');
    }

    function bindHint(container, table, options) {
        if (!options.scrollHint || container.__akStickyTableHint) return;
        var hint = createHint();
        container.appendChild(hint);
        container.__akStickyTableHint = hint;
        setHintDirection(hint, 'right');
        hint.addEventListener('click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            var maxScrollLeft = Math.max(0, table.scrollWidth - container.clientWidth);
            var direction = hint.dataset.direction || 'right';
            container.scrollTo({ left: direction === 'left' ? 0 : maxScrollLeft, behavior: 'auto' });
            refresh(container);
        });
    }

    function syncHint(container, table) {
        var hint = container.__akStickyTableHint;
        if (!hint || !table) return;
        var maxScrollLeft = Math.max(0, table.scrollWidth - container.clientWidth);
        if (maxScrollLeft <= 12 || !container.getClientRects().length) {
            hint.classList.remove('is-visible');
            return;
        }
        if (container.scrollLeft <= EDGE_THRESHOLD) {
            setHintDirection(hint, 'right');
        } else if (container.scrollLeft >= maxScrollLeft - EDGE_THRESHOLD) {
            setHintDirection(hint, 'left');
        }
        var direction = hint.dataset.direction || 'right';
        var hintWidth = hint.offsetWidth || 36;
        var left = direction === 'left' ? container.scrollLeft + 10 : container.scrollLeft + container.clientWidth - hintWidth - 10;
        hint.style.left = Math.max(0, left) + 'px';
        hint.classList.toggle('is-visible', direction === 'right' ? container.scrollLeft < maxScrollLeft - EDGE_THRESHOLD : container.scrollLeft > EDGE_THRESHOLD);
    }

    function syncScrollUi(container, table) {
        updateScrollState(container, table);
        syncHint(container, table);
    }

    function scheduleScrollSync(container, table) {
        if (container.__akStickyTableScrollFrame) return;
        container.__akStickyTableScrollFrame = window.requestAnimationFrame(function() {
            container.__akStickyTableScrollFrame = 0;
            syncScrollUi(container, tableOf(container) || table);
        });
    }

    function refresh(container) {
        if (!container) return;
        var table = tableOf(container);
        var options = container.__akStickyTableOptions || mergeOptions(container);
        if (!table) return;
        if (options.minWidth > 0) table.style.minWidth = options.minWidth + 'px';
        measureFirstColumn(container, table, options);
        syncScrollUi(container, table);
    }

    function enhance(container, options) {
        if (!container) return null;
        var table = tableOf(container);
        if (!table) return null;
        var merged = mergeOptions(container, options);
        container.__akStickyTableOptions = merged;
        container.classList.add('ak-sticky-table-wrap', 'ak-sticky-table-ready');
        container.classList.toggle('ak-sticky-table-compact', !!merged.compact);
        container.dataset.akStickyFirstColumn = merged.stickyFirstColumn ? '1' : '0';
        container.dataset.akStickyHeader = merged.stickyHeader ? '1' : '0';
        table.classList.add('ak-sticky-table');
        bindHint(container, table, merged);
        if (container.__akStickyTableScrollBound !== '1') {
            container.__akStickyTableScrollBound = '1';
            container.addEventListener('scroll', function() {
                scheduleScrollSync(container, table);
            }, { passive: true });
        }
        if (!container.__akStickyTableResizeObserver && 'ResizeObserver' in window) {
            container.__akStickyTableResizeObserver = new ResizeObserver(function() {
                refresh(container);
            });
            container.__akStickyTableResizeObserver.observe(container);
            container.__akStickyTableResizeObserver.observe(table);
        }
        refresh(container);
        return container;
    }

    function enhanceAll(root) {
        var scope = root || document;
        Array.prototype.slice.call(scope.querySelectorAll('[data-ak-sticky-table]')).forEach(function(container) {
            enhance(container);
        });
    }

    window.AKStickyTable = {
        enhance: enhance,
        enhanceAll: enhanceAll,
        refresh: refresh
    };

    window.addEventListener('resize', function() {
        enhanceAll(document);
    });
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { enhanceAll(document); });
    } else {
        enhanceAll(document);
    }
})();
