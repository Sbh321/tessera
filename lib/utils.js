// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Validates a string as a CSS hex color (#rgb, #rrggbb, #rrggbbaa).
 * Used before interpolating user-supplied settings values into inline
 * St widget styles, since St.set_style() takes a raw CSS string.
 */
export function isValidHexColor(value) {
    return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
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
