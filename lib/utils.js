// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Validates a string as a CSS hex color (#rgb, #rrggbb, #rrggbbaa).
 * Used before interpolating user-supplied settings values into inline
 * St widget styles, since St.set_style() takes a raw CSS string.
 */
export function isValidHexColor(value) {
    return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
}

// Label styles for the workspace squares. Pure formatting -- every style
// maps a 0-based workspace index to a short label string.
const DEVANAGARI_DIGITS = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
const ROMAN_VALUES = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'],
    [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'],
    [5, 'V'], [4, 'IV'], [1, 'I'],
];
const LATIN_UPPER = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const LATIN_LOWER = [...'abcdefghijklmnopqrstuvwxyz'];
// The Devanagari consonant sequence (varnamala order).
const DEVANAGARI_LETTERS = [...'कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह'];

// Spreadsheet-style alphabetic numbering over any alphabet: the whole
// alphabet first, then two-symbol combinations (A..Z, AA, AB...).
function alphabetLabel(alphabet, ordinal) {
    let n = ordinal;
    let out = '';
    while (n > 0) {
        n -= 1;
        out = alphabet[n % alphabet.length] + out;
        n = Math.floor(n / alphabet.length);
    }
    return out;
}

/**
 * Formats a workspace's label for the panel indicator.
 *
 * @param {string} style one of: numbers, roman, devanagari, letters,
 *   letters-lower, devanagari-letters, dots (anything unrecognized falls
 *   back to numbers, so a stale/hand-edited gsettings value can never
 *   break rendering)
 * @param {number} index 0-based workspace index
 * @returns {string} the label text
 */
export function workspaceLabel(style, index) {
    const ordinal = index + 1;
    switch (style) {
    case 'roman': {
        let n = ordinal;
        let out = '';
        for (const [value, numeral] of ROMAN_VALUES) {
            while (n >= value) {
                out += numeral;
                n -= value;
            }
        }
        return out;
    }
    case 'devanagari':
        return [...String(ordinal)]
            .map(digit => DEVANAGARI_DIGITS[Number(digit)] ?? digit)
            .join('');
    case 'letters':
        return alphabetLabel(LATIN_UPPER, ordinal);
    case 'letters-lower':
        return alphabetLabel(LATIN_LOWER, ordinal);
    case 'devanagari-letters':
        return alphabetLabel(DEVANAGARI_LETTERS, ordinal);
    case 'dots':
        return '●';
    default:
        return String(ordinal);
    }
}

/**
 * Builds a CSS declaration string from a plain object, skipping any
 * property whose value is null, undefined, or an empty string. Property
 * names are used verbatim, so callers must pass valid CSS property names.
 */
export function buildCssDeclarations(properties) {
    return Object.entries(properties)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([name, value]) => `${name}: ${value};`)
        .join(' ');
}
