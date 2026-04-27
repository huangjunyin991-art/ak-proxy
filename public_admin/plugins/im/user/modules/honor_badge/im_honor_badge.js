(function(global) {
    'use strict';

    const modules = global.AKIMUserModules = global.AKIMUserModules || {};

    let uidSeed = 0;

    const LEVEL_TOKENS = {
        M0: { start: '#fffdf8', end: '#dde3ee', accent: '#f7f8fb', rim: '#fffaf0', glow: '#f6f1e8', banner: '#7b8798', jewel: '#ebe3d3', shadow: '#c1c8d2' },
        M1: { start: '#d9f7ea', end: '#4fba84', accent: '#effcf5', rim: '#f8fffb', glow: '#dff7ea', banner: '#0c7146', jewel: '#79d9a7', shadow: '#4c8f6f' },
        M2: { start: '#dae7ff', end: '#5a88e8', accent: '#eef4ff', rim: '#f8fbff', glow: '#e1ebff', banner: '#1d4faa', jewel: '#8aacff', shadow: '#5872ae' },
        M3: { start: '#eadcff', end: '#9270ee', accent: '#f4eeff', rim: '#fcf8ff', glow: '#f1e8ff', banner: '#6434c1', jewel: '#b497ff', shadow: '#7861ad' },
        M4: { start: '#ffd9df', end: '#e06a82', accent: '#fff0f3', rim: '#fff8f8', glow: '#ffe7ec', banner: '#a61d3f', jewel: '#ff9db0', shadow: '#a76978' },
        M5: { start: '#fce8b3', end: '#e3a82a', accent: '#fff3cf', rim: '#fff8e6', glow: '#faedbf', banner: '#8b5b07', jewel: '#ffd26a', shadow: '#b6852e' },
        A1: { start: '#6f5428', end: '#261b0d', accent: '#987339', rim: '#f0d597', glow: '#d5b26b', banner: '#f6deb0', jewel: '#d8ae59', shadow: '#181109' },
        A2: { start: '#725628', end: '#281c0d', accent: '#9a7438', rim: '#f2d9a1', glow: '#d8bc7a', banner: '#f7e1b7', jewel: '#78c1aa', shadow: '#181109' },
        A3: { start: '#76592a', end: '#291c0d', accent: '#a07939', rim: '#f4dca7', glow: '#dcc183', banner: '#f9e6c1', jewel: '#84abff', shadow: '#181109' },
        A4: { start: '#7b5d2c', end: '#2b1d0e', accent: '#a77e3b', rim: '#f6dfae', glow: '#e0c68a', banner: '#fae8c9', jewel: '#ef9fb1', shadow: '#19110a' },
        A5: { start: '#8d692f', end: '#2f210d', accent: '#c99845', rim: '#fff0c0', glow: '#efd38d', banner: '#fff1c9', jewel: '#fff3cf', shadow: '#1b1308' }
    };

    function nextUid(prefix) {
        uidSeed += 1;
        return prefix + '-' + uidSeed;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function hexToRgb(hex) {
        const normalized = String(hex || '').replace('#', '').trim();
        if (normalized.length !== 6) return { r: 255, g: 255, b: 255 };
        return {
            r: parseInt(normalized.slice(0, 2), 16),
            g: parseInt(normalized.slice(2, 4), 16),
            b: parseInt(normalized.slice(4, 6), 16)
        };
    }

    function rgba(hex, alpha) {
        const rgb = hexToRgb(hex);
        return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + clamp(alpha, 0, 1) + ')';
    }

    function normalizeHonorLevel(value) {
        const input = String(value || '').trim().toUpperCase();
        if (!input) return '';
        const exactMatch = input.match(/^(M[0-5]|A[1-5])$/);
        if (exactMatch) return exactMatch[1];
        const fuzzyMatch = input.match(/(?:^|[^A-Z0-9])(M[0-5]|A[1-5])(?:$|[^A-Z0-9])/);
        return fuzzyMatch ? fuzzyMatch[1] : '';
    }

    function getLevelInfo(levelCode) {
        const code = normalizeHonorLevel(levelCode) || 'M0';
        return {
            code: code,
            elite: code.charAt(0) === 'A',
            step: Number(code.slice(1)) || 0
        };
    }

    function getToken(levelInfo) {
        return LEVEL_TOKENS[levelInfo.code] || LEVEL_TOKENS.M0;
    }

    function createMemberDefs(ids, token) {
        return '' +
            '<linearGradient id="' + ids.outer + '" x1="0%" y1="0%" x2="100%" y2="100%">' +
                '<stop offset="0%" stop-color="' + rgba(token.rim, 0.98) + '"></stop>' +
                '<stop offset="52%" stop-color="' + rgba(token.accent, 0.92) + '"></stop>' +
                '<stop offset="100%" stop-color="' + rgba(token.shadow, 0.92) + '"></stop>' +
            '</linearGradient>' +
            '<linearGradient id="' + ids.inner + '" x1="18%" y1="0%" x2="82%" y2="100%">' +
                '<stop offset="0%" stop-color="' + token.start + '"></stop>' +
                '<stop offset="48%" stop-color="' + token.accent + '"></stop>' +
                '<stop offset="100%" stop-color="' + token.end + '"></stop>' +
            '</linearGradient>' +
            '<linearGradient id="' + ids.sheen + '" x1="0%" y1="0%" x2="0%" y2="100%">' +
                '<stop offset="0%" stop-color="' + rgba(token.rim, 0.42) + '"></stop>' +
                '<stop offset="100%" stop-color="' + rgba(token.rim, 0) + '"></stop>' +
            '</linearGradient>' +
            '<radialGradient id="' + ids.glow + '" cx="50%" cy="50%" r="68%">' +
                '<stop offset="0%" stop-color="' + rgba(token.glow, 0.14) + '"></stop>' +
                '<stop offset="100%" stop-color="' + rgba(token.glow, 0) + '"></stop>' +
            '</radialGradient>';
    }

    function buildMemberHighlightMarkup(ids, bubbleX, bubbleY, bubbleWidth) {
        return '<path d="M' + (bubbleX + 8) + ' ' + (bubbleY + 5) + ' H' + (bubbleX + bubbleWidth - 8) + ' C' + (bubbleX + bubbleWidth - 20) + ' ' + (bubbleY + 5) + ', ' + (bubbleX + bubbleWidth - 24) + ' ' + (bubbleY + 12) + ', ' + (bubbleX + bubbleWidth - 30) + ' ' + (bubbleY + 12) + ' H' + (bubbleX + 24) + ' C' + (bubbleX + 18) + ' ' + (bubbleY + 12) + ', ' + (bubbleX + 14) + ' ' + (bubbleY + 8) + ', ' + (bubbleX + 8) + ' ' + (bubbleY + 5) + ' Z" fill="url(#' + ids.sheen + ')" opacity="0.3"></path>';
    }

    function renderMemberSvg(levelInfo) {
        const token = getToken(levelInfo);
        const ids = {
            outer: nextUid('ak-im-member-outer'),
            inner: nextUid('ak-im-member-inner'),
            sheen: nextUid('ak-im-member-sheen'),
            glow: nextUid('ak-im-member-glow')
        };
        const bubbleWidth = 92;
        const bubbleHeight = 28;
        const bubbleX = 34;
        const bubbleY = 34;
        const innerInset = 2;
        return '' +
            '<svg class="ak-im-honor-badge-svg" viewBox="28 28 104 40" role="img" aria-label="' + escapeHtml(levelInfo.code) + '" xmlns="http://www.w3.org/2000/svg">' +
                '<defs>' + createMemberDefs(ids, token) + '</defs>' +
                '<ellipse cx="80" cy="48" rx="56" ry="20" fill="url(#' + ids.glow + ')" opacity="0.88"></ellipse>' +
                '<ellipse cx="80" cy="63" rx="44" ry="8" fill="' + rgba(token.shadow, 0.12) + '"></ellipse>' +
                '<rect x="' + bubbleX + '" y="' + bubbleY + '" width="' + bubbleWidth + '" height="' + bubbleHeight + '" rx="14" fill="url(#' + ids.outer + ')" stroke="' + rgba(token.rim, 0.68) + '" stroke-width="1.15"></rect>' +
                '<rect x="' + (bubbleX + innerInset) + '" y="' + (bubbleY + innerInset) + '" width="' + (bubbleWidth - innerInset * 2) + '" height="' + (bubbleHeight - innerInset * 2) + '" rx="12" fill="url(#' + ids.inner + ')" stroke="' + rgba(token.rim, 0.54) + '" stroke-width="0.75"></rect>' +
                buildMemberHighlightMarkup(ids, bubbleX, bubbleY, bubbleWidth) +
                '<path d="M' + (bubbleX + 6) + ' ' + (bubbleY + bubbleHeight - 6) + ' H' + (bubbleX + bubbleWidth - 6) + '" stroke="' + rgba(token.shadow, 0.1) + '" stroke-width="1.4" stroke-linecap="round"></path>' +
                '<text x="80" y="54" text-anchor="middle" font-size="20" font-weight="900" letter-spacing="0.22" fill="' + token.banner + '" stroke="' + rgba(token.rim, 0.22) + '" stroke-width="0.24" paint-order="stroke">' + escapeHtml(levelInfo.code) + '</text>' +
            '</svg>';
    }

    function createEliteDefs(ids, token, bubbleX, bubbleY, bubbleWidth, bubbleHeight, innerInset) {
        return '' +
            '<linearGradient id="' + ids.outer + '" x1="0%" y1="0%" x2="0%" y2="100%">' +
                '<stop offset="0%" stop-color="' + rgba(token.shadow, 0.98) + '"></stop>' +
                '<stop offset="18%" stop-color="' + rgba(token.banner, 0.42) + '"></stop>' +
                '<stop offset="100%" stop-color="' + rgba(token.shadow, 0.98) + '"></stop>' +
            '</linearGradient>' +
            '<linearGradient id="' + ids.inner + '" x1="0%" y1="0%" x2="0%" y2="100%">' +
                '<stop offset="0%" stop-color="' + token.start + '"></stop>' +
                '<stop offset="38%" stop-color="' + token.accent + '"></stop>' +
                '<stop offset="100%" stop-color="' + token.end + '"></stop>' +
            '</linearGradient>' +
            '<linearGradient id="' + ids.sheen + '" x1="0%" y1="0%" x2="0%" y2="100%">' +
                '<stop offset="0%" stop-color="' + rgba(token.rim, 0.34) + '"></stop>' +
                '<stop offset="100%" stop-color="' + rgba(token.rim, 0) + '"></stop>' +
            '</linearGradient>' +
            '<radialGradient id="' + ids.glow + '" cx="50%" cy="52%" r="62%">' +
                '<stop offset="0%" stop-color="' + rgba(token.glow, 0.09) + '"></stop>' +
                '<stop offset="100%" stop-color="' + rgba(token.glow, 0) + '"></stop>' +
            '</radialGradient>' +
            '<linearGradient id="' + ids.edge + '" x1="0%" y1="0%" x2="100%" y2="0%">' +
                '<stop offset="0%" stop-color="' + rgba(token.rim, 0) + '"></stop>' +
                '<stop offset="18%" stop-color="' + rgba(token.rim, 0.72) + '"></stop>' +
                '<stop offset="50%" stop-color="' + rgba(token.jewel, 0.82) + '"></stop>' +
                '<stop offset="82%" stop-color="' + rgba(token.rim, 0.72) + '"></stop>' +
                '<stop offset="100%" stop-color="' + rgba(token.rim, 0) + '"></stop>' +
            '</linearGradient>' +
            '<linearGradient id="' + ids.band + '" x1="0%" y1="0%" x2="100%" y2="0%">' +
                '<stop offset="0%" stop-color="' + rgba(token.rim, 0) + '"></stop>' +
                '<stop offset="14%" stop-color="' + rgba(token.rim, 0.16) + '"></stop>' +
                '<stop offset="50%" stop-color="' + rgba(token.jewel, 0.34) + '"></stop>' +
                '<stop offset="86%" stop-color="' + rgba(token.rim, 0.16) + '"></stop>' +
                '<stop offset="100%" stop-color="' + rgba(token.rim, 0) + '"></stop>' +
            '</linearGradient>' +
            '<radialGradient id="' + ids.scan + '" cx="50%" cy="50%" r="52%">' +
                '<stop offset="0%" stop-color="' + rgba('#fffef4', 0.74) + '"></stop>' +
                '<stop offset="36%" stop-color="' + rgba('#fff7dc', 0.26) + '"></stop>' +
                '<stop offset="100%" stop-color="' + rgba('#fff7dc', 0) + '"></stop>' +
            '</radialGradient>' +
            '<radialGradient id="' + ids.scanSoft + '" cx="50%" cy="50%" r="60%">' +
                '<stop offset="0%" stop-color="' + rgba('#fffef4', 0.26) + '"></stop>' +
                '<stop offset="44%" stop-color="' + rgba('#fff7dc', 0.1) + '"></stop>' +
                '<stop offset="100%" stop-color="' + rgba('#fff7dc', 0) + '"></stop>' +
            '</radialGradient>' +
            '<clipPath id="' + ids.scanClip + '">' +
                '<rect x="' + (bubbleX + innerInset) + '" y="' + (bubbleY + innerInset) + '" width="' + (bubbleWidth - innerInset * 2) + '" height="' + (bubbleHeight - innerInset * 2) + '" rx="13"></rect>' +
            '</clipPath>';
    }

    function buildEliteHighlightMarkup(ids, bubbleX, bubbleY, bubbleWidth) {
        return '<rect x="' + (bubbleX + 11) + '" y="' + (bubbleY + 5) + '" width="' + (bubbleWidth - 22) + '" height="5" rx="2.5" fill="url(#' + ids.sheen + ')" opacity="0.2"></rect>';
    }

    function buildEliteScanMarkup(ids, bubbleX, bubbleY, bubbleWidth, bubbleHeight) {
        const centerY = bubbleY + bubbleHeight / 2;
        return '' +
            '<g clip-path="url(#' + ids.scanClip + ')">' +
                '<g transform="rotate(18 80 48)">' +
                    '<ellipse cx="' + (bubbleX - 30) + '" cy="' + centerY + '" rx="26" ry="42" fill="url(#' + ids.scanSoft + ')" opacity="0.48">' +
                        '<animate attributeName="cx" values="' + (bubbleX - 30) + ';' + (bubbleX + bubbleWidth + 18) + '" dur="3.4s" repeatCount="indefinite"></animate>' +
                    '</ellipse>' +
                    '<ellipse cx="' + (bubbleX - 20) + '" cy="' + centerY + '" rx="12" ry="38" fill="url(#' + ids.scan + ')" opacity="0.74">' +
                        '<animate attributeName="cx" values="' + (bubbleX - 20) + ';' + (bubbleX + bubbleWidth + 28) + '" dur="3.4s" repeatCount="indefinite"></animate>' +
                    '</ellipse>' +
                    '<ellipse cx="' + (bubbleX - 12) + '" cy="' + centerY + '" rx="5" ry="32" fill="' + rgba('#fffef4', 0.12) + '">' +
                        '<animate attributeName="cx" values="' + (bubbleX - 12) + ';' + (bubbleX + bubbleWidth + 36) + '" dur="3.4s" repeatCount="indefinite"></animate>' +
                    '</ellipse>' +
                '</g>' +
            '</g>';
    }

    function renderEliteSvg(levelInfo) {
        const token = getToken(levelInfo);
        const ids = {
            outer: nextUid('ak-im-elite-outer'),
            inner: nextUid('ak-im-elite-inner'),
            sheen: nextUid('ak-im-elite-sheen'),
            glow: nextUid('ak-im-elite-glow'),
            edge: nextUid('ak-im-elite-edge'),
            band: nextUid('ak-im-elite-band'),
            scan: nextUid('ak-im-elite-scan'),
            scanSoft: nextUid('ak-im-elite-scan-soft'),
            scanClip: nextUid('ak-im-elite-scan-clip')
        };
        const bubbleWidth = 96;
        const bubbleHeight = 30;
        const bubbleX = 32;
        const bubbleY = 33;
        const innerInset = 2.5;
        return '' +
            '<svg class="ak-im-honor-badge-svg" viewBox="28 28 104 40" role="img" aria-label="' + escapeHtml(levelInfo.code) + '" xmlns="http://www.w3.org/2000/svg">' +
                '<defs>' + createEliteDefs(ids, token, bubbleX, bubbleY, bubbleWidth, bubbleHeight, innerInset) + '</defs>' +
                '<ellipse cx="80" cy="49" rx="52" ry="18" fill="url(#' + ids.glow + ')" opacity="0.58"></ellipse>' +
                '<ellipse cx="80" cy="66" rx="44" ry="6.5" fill="' + rgba(token.shadow, 0.14) + '"></ellipse>' +
                '<rect x="' + bubbleX + '" y="' + bubbleY + '" width="' + bubbleWidth + '" height="' + bubbleHeight + '" rx="15" fill="url(#' + ids.outer + ')" stroke="' + rgba(token.rim, 0.62) + '" stroke-width="1.05"></rect>' +
                '<rect x="' + (bubbleX + innerInset) + '" y="' + (bubbleY + innerInset) + '" width="' + (bubbleWidth - innerInset * 2) + '" height="' + (bubbleHeight - innerInset * 2) + '" rx="13" fill="url(#' + ids.inner + ')" stroke="' + rgba(token.rim, 0.42) + '" stroke-width="0.72"></rect>' +
                '<path d="M' + (bubbleX + 14) + ' ' + (bubbleY + 4.5) + ' H' + (bubbleX + bubbleWidth - 14) + '" stroke="url(#' + ids.edge + ')" stroke-width="1.05" stroke-linecap="round"></path>' +
                buildEliteHighlightMarkup(ids, bubbleX, bubbleY, bubbleWidth) +
                buildEliteScanMarkup(ids, bubbleX, bubbleY, bubbleWidth, bubbleHeight) +
                '<rect x="' + (bubbleX + 10) + '" y="' + (bubbleY + 14) + '" width="' + (bubbleWidth - 20) + '" height="4" rx="2" fill="url(#' + ids.band + ')" opacity="0.72"></rect>' +
                '<path d="M' + (bubbleX + 10) + ' ' + (bubbleY + bubbleHeight - 5.5) + ' H' + (bubbleX + bubbleWidth - 10) + '" stroke="' + rgba(token.shadow, 0.18) + '" stroke-width="1.3" stroke-linecap="round"></path>' +
                '<text x="80" y="54.2" text-anchor="middle" font-size="19.5" font-weight="900" letter-spacing="0.25" fill="' + token.banner + '" stroke="' + rgba(token.shadow, 0.34) + '" stroke-width="0.42" paint-order="stroke">' + escapeHtml(levelInfo.code) + '</text>' +
            '</svg>';
    }

    function buildBadgeMarkup(honorName, className) {
        const levelCode = normalizeHonorLevel(honorName);
        if (!levelCode) return '';
        const badgeClassName = String(className || 'ak-im-honor-badge').trim() || 'ak-im-honor-badge';
        const levelInfo = getLevelInfo(levelCode);
        const svgMarkup = levelInfo.elite ? renderEliteSvg(levelInfo) : renderMemberSvg(levelInfo);
        return '<span class="' + badgeClassName + ' ak-im-honor-badge--rich" data-ak-im-honor-level="' + levelCode + '">' + svgMarkup + '</span>';
    }

    modules.honorBadge = {
        normalizeHonorLevel: normalizeHonorLevel,
        buildBadgeMarkup: buildBadgeMarkup
    };
})(window);
