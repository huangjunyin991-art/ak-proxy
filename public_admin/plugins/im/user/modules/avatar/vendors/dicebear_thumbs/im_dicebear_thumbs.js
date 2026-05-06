(function(global) {
    'use strict';

    const MIN = -2147483648;
    const MAX = 2147483647;

    const coreDefaults = {
        flip: false,
        rotate: 0,
        scale: 100,
        radius: 0,
        backgroundType: ['solid'],
        backgroundRotation: [0, 360],
        translateX: 0,
        translateY: 0,
        clip: true,
        randomizeIds: false
    };

    const thumbsDefaults = {
        backgroundColor: ['0a5b83', '1c799f', '69d2e7', 'f1f4dc', 'f88c49'],
        eyes: [
            'variant1W10', 'variant1W12', 'variant1W14', 'variant1W16',
            'variant2W10', 'variant2W12', 'variant2W14', 'variant2W16',
            'variant3W10', 'variant3W12', 'variant3W14', 'variant3W16',
            'variant4W10', 'variant4W12', 'variant4W14', 'variant4W16',
            'variant5W10', 'variant5W12', 'variant5W14', 'variant5W16',
            'variant6W10', 'variant6W12', 'variant6W14', 'variant6W16',
            'variant7W10', 'variant7W12', 'variant7W14', 'variant7W16',
            'variant8W10', 'variant8W12', 'variant8W14', 'variant8W16',
            'variant9W10', 'variant9W12', 'variant9W14', 'variant9W16'
        ],
        eyesColor: ['000000', 'ffffff'],
        face: ['variant1', 'variant2', 'variant3', 'variant5', 'variant4'],
        faceOffsetX: [-15, 15],
        faceOffsetY: [-15, 15],
        faceRotation: [-20, 20],
        mouth: ['variant2', 'variant1', 'variant3', 'variant4', 'variant5'],
        mouthColor: ['000000', 'ffffff'],
        shape: ['default'],
        shapeColor: ['0a5b83', '1c799f', '69d2e7', 'f1f4dc', 'f88c49'],
        shapeOffsetX: [-5, 5],
        shapeOffsetY: [-5, 5],
        shapeRotation: [-20, 20]
    };

    function xml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/'/g, '&apos;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function xorshift(value) {
        value ^= value << 13;
        value ^= value >> 17;
        value ^= value << 5;
        return value;
    }

    function hashSeed(seed) {
        let hash = 0;
        for (let i = 0; i < seed.length; i += 1) {
            hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
            hash = xorshift(hash);
        }
        return hash;
    }

    function createPrng(seed) {
        seed = String(seed == null ? '' : seed);
        let value = hashSeed(seed) || 1;
        const next = function() {
            value = xorshift(value);
            return value;
        };
        const integer = function(min, max) {
            return Math.floor(((next() - MIN) / (MAX - MIN)) * (max + 1 - min) + min);
        };
        return {
            seed: seed,
            next: next,
            bool: function(likelihood) {
                return integer(1, 100) <= (likelihood == null ? 50 : likelihood);
            },
            integer: integer,
            pick: function(arr, fallback) {
                const list = Array.isArray(arr) ? arr : [];
                if (list.length === 0) {
                    next();
                    return fallback;
                }
                const picked = list[integer(0, list.length - 1)];
                return picked == null ? fallback : picked;
            },
            shuffle: function(arr) {
                const internalPrng = createPrng(next().toString());
                const workingArray = Array.isArray(arr) ? arr.slice() : [];
                for (let i = workingArray.length - 1; i > 0; i -= 1) {
                    const j = internalPrng.integer(0, i);
                    const tmp = workingArray[i];
                    workingArray[i] = workingArray[j];
                    workingArray[j] = tmp;
                }
                return workingArray;
            },
            string: function(length, characters) {
                const chars = String(characters || 'abcdefghijklmnopqrstuvwxyz1234567890');
                const internalPrng = createPrng(next().toString());
                let result = '';
                for (let i = 0; i < length; i += 1) {
                    result += chars[internalPrng.integer(0, chars.length - 1)];
                }
                return result;
            }
        };
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function mergeOptions(options) {
        return clone(Object.assign({}, coreDefaults, thumbsDefaults, options || {}));
    }

    function convertColor(color) {
        return color === 'transparent' ? color : '#' + color;
    }

    function getBackgroundColors(prng, backgroundColor, backgroundType) {
        let shuffledBackgroundColors = prng.shuffle(backgroundColor || []);
        if (shuffledBackgroundColors.length <= 1) {
            shuffledBackgroundColors = backgroundColor || [];
            prng.next();
        } else if ((backgroundColor || []).length === 2 && backgroundType === 'gradientLinear') {
            shuffledBackgroundColors = backgroundColor || [];
            prng.next();
        } else {
            shuffledBackgroundColors = prng.shuffle(backgroundColor || []);
        }
        if (shuffledBackgroundColors.length === 0) shuffledBackgroundColors = ['transparent'];
        const primary = shuffledBackgroundColors[0];
        const secondary = shuffledBackgroundColors[1] == null ? shuffledBackgroundColors[0] : shuffledBackgroundColors[1];
        return {
            primary: convertColor(primary),
            secondary: convertColor(secondary)
        };
    }

    const eyes = {
        variant1W10: function(components, colors) { return '<path d="M.25 8.12C1.66 11.86 12 16 12 16s5.17-9.58 3.76-13.32c0 0-1.41-3.74-5.3-2.38-3.87 1.36-2.7 4.48-2.7 4.48S6.6 1.66 2.73 3.02C-1.16 4.38.25 8.12.25 8.12ZM26.24 2.68C24.84 6.42 30 16 30 16s10.34-4.14 11.75-7.88c0 0 1.41-3.74-2.47-5.1-3.87-1.36-5.05 1.76-5.05 1.76s1.18-3.12-2.7-4.48c-3.88-1.36-5.29 2.38-5.29 2.38Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant1W12: function(components, colors) { return '<path d="M-.75 8.12C.66 11.86 11 16 11 16s5.17-9.58 3.76-13.32c0 0-1.41-3.74-5.3-2.38-3.87 1.36-2.7 4.48-2.7 4.48S5.6 1.66 1.73 3.02c-3.88 1.36-2.47 5.1-2.47 5.1ZM27.24 2.68C25.84 6.42 31 16 31 16s10.34-4.14 11.75-7.88c0 0 1.41-3.74-2.47-5.1-3.87-1.36-5.05 1.76-5.05 1.76s1.18-3.12-2.7-4.48c-3.88-1.36-5.29 2.38-5.29 2.38Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant1W14: function(components, colors) { return '<path d="M-1.75 8.12C-.34 11.86 10 16 10 16s5.17-9.58 3.76-13.32c0 0-1.41-3.74-5.3-2.38-3.87 1.36-2.7 4.48-2.7 4.48S4.6 1.66.73 3.02c-3.88 1.36-2.47 5.1-2.47 5.1ZM28.24 2.68C26.84 6.42 32 16 32 16s10.34-4.14 11.75-7.88c0 0 1.41-3.74-2.47-5.1-3.87-1.36-5.05 1.76-5.05 1.76s1.18-3.12-2.7-4.48c-3.88-1.36-5.29 2.38-5.29 2.38Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant1W16: function(components, colors) { return '<path d="M-2.75 8.12C-1.34 11.86 9 16 9 16s5.17-9.58 3.76-13.32c0 0-1.41-3.74-5.3-2.38-3.87 1.36-2.7 4.48-2.7 4.48S3.6 1.66-.27 3.02c-3.88 1.36-2.47 5.1-2.47 5.1ZM29.24 2.68C27.84 6.42 33 16 33 16s10.34-4.14 11.75-7.88c0 0 1.41-3.74-2.47-5.1-3.87-1.36-5.05 1.76-5.05 1.76s1.18-3.12-2.7-4.48c-3.88-1.36-5.29 2.38-5.29 2.38Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant2W10: function(components, colors) { return '<path d="M9.5 10c-3.88 0-7.11-4.23-6.4-4.85.71-.62 2.63 1.3 6.4 1.3 3.77 0 5.69-2 6.4-1.3S13.38 10 9.5 10ZM32.5 10c-3.88 0-7.11-4.23-6.4-4.85.71-.62 2.63 1.3 6.4 1.3 3.77 0 5.69-2 6.4-1.3S36.38 10 32.5 10Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant2W12: function(components, colors) { return '<path d="M8.5 10c-3.88 0-7.11-4.23-6.4-4.85.71-.62 2.63 1.3 6.4 1.3 3.77 0 5.69-2 6.4-1.3S12.38 10 8.5 10ZM33.5 10c-3.88 0-7.11-4.23-6.4-4.85.71-.62 2.63 1.3 6.4 1.3 3.77 0 5.69-2 6.4-1.3S37.38 10 33.5 10Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant2W14: function(components, colors) { return '<path d="M7.5 10C3.62 10 .39 5.77 1.1 5.15c.71-.62 2.63 1.3 6.4 1.3 3.77 0 5.69-2 6.4-1.3S11.38 10 7.5 10ZM34.5 10c-3.88 0-7.11-4.23-6.4-4.85.71-.62 2.63 1.3 6.4 1.3 3.77 0 5.69-2 6.4-1.3S38.38 10 34.5 10Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant2W16: function(components, colors) { return '<path d="M6.5 10C2.62 10-.61 5.77.1 5.15c.71-.62 2.63 1.3 6.4 1.3 3.77 0 5.69-2 6.4-1.3S10.38 10 6.5 10ZM35.5 10c-3.88 0-7.11-4.23-6.4-4.85.71-.62 2.63 1.3 6.4 1.3 3.77 0 5.69-2 6.4-1.3S39.38 10 35.5 10Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant3W10: function(components, colors) { return '<path d="M11.86 7.5c0-1.42-4.14-2.85-4.82-4.98C6.34.4 16 5.37 16 7.5c0 2.13-9.65 7.11-8.96 4.98.68-2.13 4.82-3.56 4.82-4.98ZM30.14 7.5c0-1.42 4.14-2.85 4.82-4.98C35.66.4 26 5.37 26 7.5c0 2.13 9.65 7.11 8.96 4.98-.68-2.13-4.82-3.56-4.82-4.98Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant3W12: function(components, colors) { return '<path d="M10.86 7.5c0-1.42-4.14-2.85-4.82-4.98C5.34.4 15 5.37 15 7.5c0 2.13-9.65 7.11-8.96 4.98.68-2.13 4.82-3.56 4.82-4.98ZM31.14 7.5c0-1.42 4.14-2.85 4.82-4.98C36.66.4 27 5.37 27 7.5c0 2.13 9.65 7.11 8.96 4.98-.68-2.13-4.82-3.56-4.82-4.98Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant3W14: function(components, colors) { return '<path d="M9.86 7.5c0-1.42-4.14-2.85-4.82-4.98C4.34.4 14 5.37 14 7.5c0 2.13-9.65 7.11-8.96 4.98.68-2.13 4.82-3.56 4.82-4.98ZM32.14 7.5c0-1.42 4.14-2.85 4.82-4.98C37.66.4 28 5.37 28 7.5c0 2.13 9.65 7.11 8.96 4.98-.68-2.13-4.82-3.56-4.82-4.98Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant3W16: function(components, colors) { return '<path d="M8.86 7.5c0-1.42-4.14-2.85-4.82-4.98C3.34.4 13 5.37 13 7.5c0 2.13-9.65 7.11-8.96 4.98.68-2.13 4.82-3.56 4.82-4.98ZM33.14 7.5c0-1.42 4.14-2.85 4.82-4.98C38.66.4 29 5.37 29 7.5c0 2.13 9.65 7.11 8.96 4.98-.68-2.13-4.82-3.56-4.82-4.98Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant4W10: function(components, colors) { return '<path d="M8 8.36S8 4 12 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S9.33 12 8.67 12C8 12 8 11.27 8 11.27v-2.9ZM26 8.36S26 4 30 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S27.33 12 26.67 12c-.67 0-.67-.73-.67-.73v-2.9Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant4W12: function(components, colors) { return '<path d="M7 8.36S7 4 11 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S8.33 12 7.67 12C7 12 7 11.27 7 11.27v-2.9ZM27 8.36S27 4 31 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S28.33 12 27.67 12c-.67 0-.67-.73-.67-.73v-2.9Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant4W14: function(components, colors) { return '<path d="M6 8.36S6 4 10 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S7.33 12 6.67 12C6 12 6 11.27 6 11.27v-2.9ZM28 8.36S28 4 32 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S29.33 12 28.67 12c-.67 0-.67-.73-.67-.73v-2.9Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant4W16: function(components, colors) { return '<path d="M5 8.36S5 4 9 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S6.33 12 5.67 12C5 12 5 11.27 5 11.27v-2.9ZM29 8.36S29 4 33 4s4 4.36 4 4.36v2.91s0 .73-.67.73c-.66 0-.66-2.9-3.33-2.9S30.33 12 29.67 12c-.67 0-.67-.73-.67-.73v-2.9Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant5W10: function(components, colors) { return '<path d="M16 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4ZM32 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant5W12: function(components, colors) { return '<path d="M15 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4ZM33 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant5W14: function(components, colors) { return '<path d="M14 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4ZM34 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant5W16: function(components, colors) { return '<path d="M13 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4ZM35 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant6W10: function(components, colors) { return '<path d="M16 8c0 3.31-1.34 6-3 6s-3-2.69-3-6 1.34-6 3-6 3 2.69 3 6ZM32 8c0 3.31-1.34 6-3 6s-3-2.69-3-6 1.34-6 3-6 3 2.69 3 6Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant6W12: function(components, colors) { return '<path d="M15 8c0 3.31-1.34 6-3 6s-3-2.69-3-6 1.34-6 3-6 3 2.69 3 6ZM33 8c0 3.31-1.34 6-3 6s-3-2.69-3-6 1.34-6 3-6 3 2.69 3 6Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant6W14: function(components, colors) { return '<path d="M14 8c0 3.31-1.34 6-3 6s-3-2.69-3-6 1.34-6 3-6 3 2.69 3 6ZM34 8c0 3.31-1.34 6-3 6s-3-2.69-3-6 1.34-6 3-6 3 2.69 3 6Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant6W16: function(components, colors) { return '<path d="M13 8c0 3.31-1.34 6-3 6s-3-2.69-3-6 1.34-6 3-6 3 2.69 3 6ZM35 8c0 3.31-1.34 6-3 6s-3-2.69-3-6 1.34-6 3-6 3 2.69 3 6Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant7W10: function(components, colors) { return '<path d="M11.5 6C8.29 6 7 7.36 7 8.04c0 3.4 1.29 1.35 4.5 1.35S16 11.43 16 8.04C16 7.36 14.71 6 11.5 6ZM30.5 6C27.29 6 26 7.36 26 8.04c0 3.4 1.29 1.35 4.5 1.35S35 11.43 35 8.04C35 7.36 33.71 6 30.5 6Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant7W12: function(components, colors) { return '<path d="M10.5 6C7.29 6 6 7.36 6 8.04c0 3.4 1.29 1.35 4.5 1.35S15 11.43 15 8.04C15 7.36 13.71 6 10.5 6ZM31.5 6C28.29 6 27 7.36 27 8.04c0 3.4 1.29 1.35 4.5 1.35S36 11.43 36 8.04C36 7.36 34.71 6 31.5 6Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant7W14: function(components, colors) { return '<path d="M9.5 6C6.29 6 5 7.36 5 8.04c0 3.4 1.29 1.35 4.5 1.35S14 11.43 14 8.04C14 7.36 12.71 6 9.5 6ZM32.5 6C29.29 6 28 7.36 28 8.04c0 3.4 1.29 1.35 4.5 1.35S37 11.43 37 8.04C37 7.36 35.71 6 32.5 6Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant7W16: function(components, colors) { return '<path d="M8.5 6C5.29 6 4 7.36 4 8.04c0 3.4 1.29 1.35 4.5 1.35S13 11.43 13 8.04C13 7.36 11.71 6 8.5 6ZM33.5 6C30.29 6 29 7.36 29 8.04c0 3.4 1.29 1.35 4.5 1.35S38 11.43 38 8.04C38 7.36 36.71 6 33.5 6Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant8W10: function(components, colors) { return '<path d="M16 8c0 1.66-1.12 3-2.5 3S11 9.66 11 8s1.12-3 2.5-3S16 6.34 16 8ZM31 8c0 1.66-1.12 3-2.5 3S26 9.66 26 8s1.12-3 2.5-3S31 6.34 31 8Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant8W12: function(components, colors) { return '<path d="M15 8c0 1.66-1.12 3-2.5 3S10 9.66 10 8s1.12-3 2.5-3S15 6.34 15 8ZM32 8c0 1.66-1.12 3-2.5 3S27 9.66 27 8s1.12-3 2.5-3S32 6.34 32 8Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant8W14: function(components, colors) { return '<path d="M14 8c0 1.66-1.12 3-2.5 3S9 9.66 9 8s1.12-3 2.5-3S14 6.34 14 8ZM33 8c0 1.66-1.12 3-2.5 3S28 9.66 28 8s1.12-3 2.5-3S33 6.34 33 8Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant8W16: function(components, colors) { return '<path d="M13 8c0 1.66-1.12 3-2.5 3S8 9.66 8 8s1.12-3 2.5-3S13 6.34 13 8ZM34 8c0 1.66-1.12 3-2.5 3S29 9.66 29 8s1.12-3 2.5-3S34 6.34 34 8Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant9W10: function(components, colors) { return '<path d="M14 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4ZM28.5 5C25.29 5 24 6.36 24 7.04c0 3.4 1.29 1.35 4.5 1.35S33 10.43 33 7.04C33 6.36 31.71 5 28.5 5Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant9W12: function(components, colors) { return '<path d="M13 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4ZM29.5 5C26.29 5 25 6.36 25 7.04c0 3.4 1.29 1.35 4.5 1.35S34 10.43 34 7.04C34 6.36 32.71 5 29.5 5Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant9W14: function(components, colors) { return '<path d="M12 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4ZM30.5 5C27.29 5 26 6.36 26 7.04c0 3.4 1.29 1.35 4.5 1.35S35 10.43 35 7.04C35 6.36 33.71 5 30.5 5Z" fill="' + xml(colors.eyes) + '"/>'; },
        variant9W16: function(components, colors) { return '<path d="M11 8c0 2.2-1.34 4-3 4s-3-1.8-3-4 1.34-4 3-4 3 1.8 3 4ZM31.5 5C28.29 5 27 6.36 27 7.04c0 3.4 1.29 1.35 4.5 1.35S36 10.43 36 7.04C36 6.36 34.71 5 31.5 5Z" fill="' + xml(colors.eyes) + '"/>'; }
    };

    const mouth = {
        variant2: function(components, colors) { return '<path d="M15 14C1.9 14-.72 1.29.15.23 1.03-.83 6.27 2.11 15 2.11S28.97-.83 29.85.23C30.72 1.3 28.1 14 15 14Z" fill="' + xml(colors.mouth) + '"/>'; },
        variant1: function(components, colors) { return '<path d="M15 11C4.52 11 2.42 2.82 3.12 2.14 3.82 1.46 8.02 3.5 15 3.5c6.99 0 11.18-2.04 11.88-1.36.7.68-1.4 8.86-11.88 8.86Z" fill="' + xml(colors.mouth) + '"/>'; },
        variant3: function(components, colors) { return '<path d="M15.5 10c-5.07 0-9.3-5.23-8.37-5.88.93-.65 3.45 2.15 8.37 2.15 4.92 0 7.44-2.88 8.37-2.15.93.73-3.3 5.88-8.37 5.88Z" fill="' + xml(colors.mouth) + '"/>'; },
        variant4: function(components, colors) { return '<path d="M15 10C6.79 10 3.02 3.88 4.22 3.12 5.42 2.35 6.1 6.6 15 6.49c8.9-.12 9.58-4.23 10.78-3.37C26.98 3.98 23.21 10 15 10Z" fill="' + xml(colors.mouth) + '"/>'; },
        variant5: function(components, colors) { return '<path d="M15.2 3.84c0-.67-4.2-2-4.2-2.67 0-.66 7 .67 7 2.67S13.8 6.5 13.8 6.5s4.2.67 4.2 2.66c0 2-7 3.33-7 2.67 0-.67 4.2-2 4.2-2.67 0-.66-3.5-1.33-3.5-2.66s3.5-2 3.5-2.66Z" fill="' + xml(colors.mouth) + '"/>'; }
    };

    const face = {
        variant1: function(components, colors) { return '<g transform="translate(0 5)">' + componentValue(components.eyes, components, colors) + '</g><g transform="translate(6 23)">' + componentValue(components.mouth, components, colors) + '</g>'; },
        variant2: function(components, colors) { return '<g transform="translate(0 4)">' + componentValue(components.eyes, components, colors) + '</g><g transform="translate(6 24)">' + componentValue(components.mouth, components, colors) + '</g>'; },
        variant3: function(components, colors) { return '<g transform="translate(0 3)">' + componentValue(components.eyes, components, colors) + '</g><g transform="translate(6 25)">' + componentValue(components.mouth, components, colors) + '</g>'; },
        variant5: function(components, colors) { return '<g transform="translate(0 1)">' + componentValue(components.eyes, components, colors) + '</g><g transform="translate(6 27)">' + componentValue(components.mouth, components, colors) + '</g>'; },
        variant4: function(components, colors) { return '<g transform="translate(0 2)">' + componentValue(components.eyes, components, colors) + '</g><g transform="translate(6 26)">' + componentValue(components.mouth, components, colors) + '</g>'; }
    };

    const shape = {
        default: function(components, colors) { return '<path d="M95 53.33C95 29.4 74.85 10 50 10S5 29.4 5 53.33V140h90V53.33Z" fill="' + xml(colors.shape) + '"/><g transform="translate(29 33)">' + componentValue(components.face, components, colors) + '</g>'; }
    };

    const componentCollections = {
        shape: shape,
        face: face,
        eyes: eyes,
        mouth: mouth
    };

    function componentValue(component, components, colors) {
        return component && typeof component.value === 'function' ? component.value(components, colors) : '';
    }

    function pickComponent(params) {
        const group = params.group;
        const collection = componentCollections[group] || {};
        const key = params.prng.pick(params.values || []);
        const rotation = params.rotation || [0];
        const offsetX = params.offsetX || [0];
        const offsetY = params.offsetY || [0];
        const pickedRotation = params.prng.integer(Math.min.apply(Math, rotation), Math.max.apply(Math, rotation));
        const pickedOffsetX = params.prng.integer(Math.min.apply(Math, offsetX), Math.max.apply(Math, offsetX));
        const pickedOffsetY = params.prng.integer(Math.min.apply(Math, offsetY), Math.max.apply(Math, offsetY));
        if (!key || !collection[key]) return undefined;
        return {
            name: key,
            rotation: pickedRotation,
            offsetX: pickedOffsetX,
            offsetY: pickedOffsetY,
            value: function(components, colors) {
                let result = collection[key](components, colors);
                if (this.rotation || this.offsetX || this.offsetY) {
                    result = '<g transform="translate(' + (this.offsetX == null ? 0 : this.offsetX) + ', ' + (this.offsetY == null ? 0 : this.offsetY) + ') rotate(' + (this.rotation == null ? 0 : this.rotation) + ' ' + (params.width / 2) + ' ' + (params.height / 2) + ')">' + result + '</g>';
                }
                return result;
            }
        };
    }

    function getComponents(prng, options) {
        return {
            shape: pickComponent({ prng: prng, group: 'shape', values: options.shape, width: 100, height: 140, rotation: options.shapeRotation && options.shapeRotation.length ? options.shapeRotation : [0], offsetX: options.shapeOffsetX && options.shapeOffsetX.length ? options.shapeOffsetX : [0], offsetY: options.shapeOffsetY && options.shapeOffsetY.length ? options.shapeOffsetY : [0] }),
            face: pickComponent({ prng: prng, group: 'face', values: options.face, width: 42, height: 42, rotation: options.faceRotation && options.faceRotation.length ? options.faceRotation : [0], offsetX: options.faceOffsetX && options.faceOffsetX.length ? options.faceOffsetX : [0], offsetY: options.faceOffsetY && options.faceOffsetY.length ? options.faceOffsetY : [0] }),
            eyes: pickComponent({ prng: prng, group: 'eyes', values: options.eyes, width: 42, height: 16, rotation: [0], offsetX: [0], offsetY: [0] }),
            mouth: pickComponent({ prng: prng, group: 'mouth', values: options.mouth, width: 30, height: 14, rotation: [0], offsetX: [0], offsetY: [0] })
        };
    }

    function getColors(prng, options) {
        return {
            shape: convertColor(prng.pick(options.shapeColor || [], 'transparent')),
            mouth: convertColor(prng.pick(options.mouthColor || [], 'transparent')),
            eyes: convertColor(prng.pick(options.eyesColor || [], 'transparent'))
        };
    }

    function onPostCreate(options, colors) {
        function getContrastYiq(hexcolor) {
            const r = parseInt(hexcolor.slice(1, 3), 16);
            const g = parseInt(hexcolor.slice(3, 5), 16);
            const b = parseInt(hexcolor.slice(5, 7), 16);
            const yiq = (r * 299 + g * 587 + b * 114) / 1000;
            return yiq >= 200 ? '#000000' : '#ffffff';
        }
        const possibleBackgroundColors = (options.backgroundColor || []).filter(function(value) {
            return value !== colors.shape.replace('#', '');
        });
        if (possibleBackgroundColors.length) options.backgroundColor = possibleBackgroundColors;
        const shapeContrast = colors.shape.charAt(0) === '#' ? getContrastYiq(colors.shape) : undefined;
        if (!shapeContrast) return;
        if ((options.eyesColor || []).length === 2 && options.eyesColor.indexOf('000000') >= 0 && options.eyesColor.indexOf('ffffff') >= 0) colors.eyes = shapeContrast;
        if ((options.mouthColor || []).length === 2 && options.mouthColor.indexOf('000000') >= 0 && options.mouthColor.indexOf('ffffff') >= 0) colors.mouth = shapeContrast;
    }

    function getViewBox(result) {
        const viewBox = String(result.attributes.viewBox || '0 0 100 100').split(' ');
        return {
            x: parseInt(viewBox[0], 10),
            y: parseInt(viewBox[1], 10),
            width: parseInt(viewBox[2], 10),
            height: parseInt(viewBox[3], 10)
        };
    }

    function addBackground(result, primaryColor, secondaryColor, type, rotation) {
        const viewBox = getViewBox(result);
        const solidBackground = '<rect fill="' + primaryColor + '" width="' + viewBox.width + '" height="' + viewBox.height + '" x="' + viewBox.x + '" y="' + viewBox.y + '" />';
        if (type === 'gradientLinear') {
            return '<rect fill="url(#backgroundLinear)" width="' + viewBox.width + '" height="' + viewBox.height + '" x="' + viewBox.x + '" y="' + viewBox.y + '" /><defs><linearGradient id="backgroundLinear" gradientTransform="rotate(' + rotation + ' 0.5 0.5)"><stop stop-color="' + primaryColor + '"/><stop offset="1" stop-color="' + secondaryColor + '"/></linearGradient></defs>' + result.body;
        }
        return solidBackground + result.body;
    }

    function addScale(result, scale) {
        const viewBox = getViewBox(result);
        const percent = scale ? (scale - 100) / 100 : 0;
        const translateX = (viewBox.width / 2 + viewBox.x) * percent * -1;
        const translateY = (viewBox.height / 2 + viewBox.y) * percent * -1;
        return '<g transform="translate(' + translateX + ' ' + translateY + ') scale(' + (scale / 100) + ')">' + result.body + '</g>';
    }

    function addTranslate(result, x, y) {
        const viewBox = getViewBox(result);
        const translateX = (viewBox.width + viewBox.x * 2) * ((x == null ? 0 : x) / 100);
        const translateY = (viewBox.height + viewBox.y * 2) * ((y == null ? 0 : y) / 100);
        return '<g transform="translate(' + translateX + ' ' + translateY + ')">' + result.body + '</g>';
    }

    function addRotate(result, rotate) {
        const viewBox = getViewBox(result);
        return '<g transform="rotate(' + rotate + ', ' + (viewBox.width / 2 + viewBox.x) + ', ' + (viewBox.height / 2 + viewBox.y) + ')">' + result.body + '</g>';
    }

    function addFlip(result) {
        const viewBox = getViewBox(result);
        return '<g transform="scale(-1 1) translate(' + (viewBox.width * -1 - viewBox.x * 2) + ' 0)">' + result.body + '</g>';
    }

    function addViewboxMask(result, radius) {
        const viewBox = getViewBox(result);
        const rx = radius ? (viewBox.width * radius) / 100 : 0;
        const ry = radius ? (viewBox.height * radius) / 100 : 0;
        return '<mask id="viewboxMask"><rect width="' + viewBox.width + '" height="' + viewBox.height + '" rx="' + rx + '" ry="' + ry + '" x="' + viewBox.x + '" y="' + viewBox.y + '" fill="#fff" /></mask><g mask="url(#viewboxMask)">' + result.body + '</g>';
    }

    function createAttrString(result) {
        const attrs = Object.assign({ xmlns: 'http://www.w3.org/2000/svg' }, result.attributes || {});
        return Object.keys(attrs).map(function(key) {
            return xml(key) + '="' + xml(attrs[key]) + '"';
        }).join(' ');
    }

    function createStyleResult(prng, options) {
        const components = getComponents(prng, options);
        const colors = getColors(prng, options);
        onPostCreate(options, colors);
        return {
            attributes: {
                viewBox: '0 0 100 100',
                fill: 'none',
                'shape-rendering': 'auto'
            },
            body: componentValue(components.shape, components, colors)
        };
    }

    function createThumbsSvg(seed, inputOptions) {
        const options = mergeOptions(Object.assign({}, inputOptions || {}, { seed: String(seed || 'user') }));
        const prng = createPrng(options.seed);
        const result = createStyleResult(prng, options);
        const backgroundType = prng.pick(options.backgroundType || [], 'solid');
        const colors = getBackgroundColors(prng, options.backgroundColor || [], backgroundType);
        const backgroundRotation = prng.integer(options.backgroundRotation && options.backgroundRotation.length ? Math.min.apply(Math, options.backgroundRotation) : 0, options.backgroundRotation && options.backgroundRotation.length ? Math.max.apply(Math, options.backgroundRotation) : 0);
        if (options.size) {
            result.attributes.width = String(options.size);
            result.attributes.height = String(options.size);
        }
        if (options.scale !== undefined && options.scale !== 100) result.body = addScale(result, options.scale);
        if (options.flip) result.body = addFlip(result);
        if (options.rotate) result.body = addRotate(result, options.rotate);
        if (options.translateX || options.translateY) result.body = addTranslate(result, options.translateX, options.translateY);
        if (colors.primary !== 'transparent' && colors.secondary !== 'transparent') result.body = addBackground(result, colors.primary, colors.secondary, backgroundType, backgroundRotation);
        if (options.radius || options.clip) result.body = addViewboxMask(result, options.radius || 0);
        return '<svg ' + createAttrString(result) + '>' + result.body + '</svg>';
    }

    function createThumbsDataUri(seed, options) {
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(createThumbsSvg(seed, options || {}));
    }

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.dicebearThumbs = {
        createThumbsSvg: createThumbsSvg,
        createThumbsDataUri: createThumbsDataUri
    };
})(window);
