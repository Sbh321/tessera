// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Pure string/number helpers for the launcher. No GNOME imports and no
 * state, exactly like lib/utils.js -- everything here is directly
 * testable outside the shell (see tests/launcher-engine-test.js).
 */

/** Clamps `value` into [min, max]. */
export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Case- and accent-folds one character to a single character.
 *
 * The single-character guarantee is the whole point: the fuzzy matcher
 * reports match *positions* that the UI turns into highlight ranges over
 * the ORIGINAL text, so folding must never change the string's length.
 * A naive `str.normalize('NFD').replace(diacritics, '')` breaks that for
 * pre-composed characters (é -> "e" + combining accent = 2 chars), which
 * shifts every later highlight. Folding per character and keeping only
 * the decomposition's base character preserves the 1:1 index mapping.
 */
function foldChar(character) {
    const decomposed = character.normalize('NFD');
    return decomposed[0].toLowerCase();
}

/**
 * Lowercases and strips diacritics while preserving length, so index i of
 * the result always corresponds to index i of the input.
 */
export function normalizeText(text) {
    // Fast path: plain ASCII (the overwhelming majority of app names and
    // window titles) needs no per-character work at all.
    if (!/[^\x20-\x7e]/.test(text))
        return text.toLowerCase();

    let out = '';
    for (const character of text)
        out += foldChar(character);
    return out;
}

/** Characters that start a new "word" for acronym/word-prefix matching. */
const WORD_SEPARATORS = new Set([' ', '-', '_', '.', '/', '\\', ':', '(', ')', '[', ']', '+', ',']);

/**
 * Indexes at which a new word starts: after a separator, at the string
 * start, and at a lower-to-upper camelCase transition (so "VSCode" and
 * "LibreOffice Writer" both expose useful initials).
 *
 * @param {string} text the ORIGINAL (unfolded) text -- case matters here
 * @returns {number[]} ascending word-start indexes
 */
export function wordStartIndexes(text) {
    const starts = [];
    for (let i = 0; i < text.length; i++) {
        const character = text[i];
        if (WORD_SEPARATORS.has(character))
            continue;

        const previous = i > 0 ? text[i - 1] : null;
        const isFirst = previous === null;
        const afterSeparator = previous !== null && WORD_SEPARATORS.has(previous);
        const camelBoundary = previous !== null &&
            previous === previous.toLowerCase() && previous !== previous.toUpperCase() &&
            character === character.toUpperCase() && character !== character.toLowerCase();

        if (isFirst || afterSeparator || camelBoundary)
            starts.push(i);
    }
    return starts;
}

/** Escapes text for use inside Pango markup (St labels use markup). */
export function escapeMarkup(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Wraps the matched characters of `text` in <b> runs for Pango.
 *
 * @param {string} text the original text
 * @param {number[]} positions ascending indexes of matched characters
 * @returns {string} Pango markup
 */
export function markupWithHighlights(text, positions) {
    if (!positions || positions.length === 0)
        return escapeMarkup(text);

    const matched = new Set(positions);
    let out = '';
    let inRun = false;
    for (let i = 0; i < text.length; i++) {
        const isMatch = matched.has(i);
        if (isMatch && !inRun) {
            out += '<b>';
            inRun = true;
        } else if (!isMatch && inRun) {
            out += '</b>';
            inRun = false;
        }
        out += escapeMarkup(text[i]);
    }
    if (inRun)
        out += '</b>';
    return out;
}

/**
 * Collapses runs of whitespace and trims -- window titles and clipboard
 * entries routinely contain newlines and tabs that would otherwise break
 * single-line row layout.
 */
export function collapseWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
}

/** Shortens to `limit` characters with an ellipsis, for one-line previews. */
export function ellipsize(text, limit) {
    if (text.length <= limit)
        return text;
    return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Converts #rgb / #rrggbb to a CSS rgba() string at the given alpha.
 *
 * St's CSS engine has no color-mix or opacity-on-a-color function, so an
 * accent-tinted surface has to be composed here, in JS, and handed over
 * as a literal -- which is also what lets the launcher follow the live
 * accent color the way the workspace squares and focus border do.
 *
 * @param {string} hex a valid #rgb or #rrggbb color
 * @param {number} alpha 0..1
 * @returns {?string} null when `hex` is not a color this can parse
 */
export function hexToRgba(hex, alpha) {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex ?? '');
    if (!match)
        return null;

    const digits = match[1].length === 3
        ? [...match[1]].map(digit => digit + digit).join('')
        : match[1];

    const red = parseInt(digits.slice(0, 2), 16);
    const green = parseInt(digits.slice(2, 4), 16);
    const blue = parseInt(digits.slice(4, 6), 16);

    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/**
 * Exponential decay used by the frecency ranking: 1 at `timestamp` ===
 * now, 0.5 one half-life later, asymptotically 0. Pure so the ranking is
 * reproducible in tests by passing an explicit `now`.
 */
export function decayFactor(timestamp, now, halfLifeMs) {
    if (!Number.isFinite(timestamp) || timestamp <= 0)
        return 0;
    const age = Math.max(0, now - timestamp);
    return Math.pow(0.5, age / halfLifeMs);
}
