// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';

import {QUICK_SELECT_COUNT} from './constants.js';

/**
 * What a key press means to the launcher.
 *
 * @enum {string}
 */
export const IntentType = {
    NONE: 'none',
    CLOSE: 'close',
    ACTIVATE: 'activate',
    ACTIVATE_ALTERNATE: 'activate-alternate',
    ACTIVATE_SECONDARY: 'activate-secondary',
    MOVE: 'move',
    PAGE: 'page',
    FIRST: 'first',
    LAST: 'last',
    SECTION: 'section',
    QUICK_SELECT: 'quick-select',
    TOGGLE_PIN: 'toggle-pin',
    REORDER_FAVORITE: 'reorder-favorite',
    REMOVE: 'remove',
    CLEAR_QUERY: 'clear-query',
};

const NONE = {type: IntentType.NONE};

/**
 * Translates a key press into an intent, and nothing else.
 *
 * Isolated from the popup so the entire key map is readable in one
 * screen and can be changed without touching actor code -- and so the
 * popup's own key handler stays a switch over intents rather than a
 * thicket of keyval and modifier tests.
 *
 * Two deliberate decisions worth knowing before changing this:
 *
 *  - Left/Right and plain Backspace/Delete are NOT intercepted. They
 *    belong to the search entry, and a launcher whose text cursor cannot
 *    move is worse than one without every navigation shortcut.
 *  - Home/End DO navigate the list rather than the text (the text cursor
 *    equivalents are Ctrl+A / Ctrl+E, which ClutterText handles). A
 *    launcher query is a few words long; jumping to the last result is
 *    the more valuable binding on those keys.
 *
 * @param {number} keyval a Clutter key symbol
 * @param {number} state the event's modifier state
 * @returns {{type: string, delta?: number, index?: number}}
 */
export function resolveIntent(keyval, state) {
    const control = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
    const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
    const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;

    switch (keyval) {
    case Clutter.KEY_Escape:
        return {type: IntentType.CLOSE};

    case Clutter.KEY_Return:
    case Clutter.KEY_KP_Enter:
    case Clutter.KEY_ISO_Enter:
        if (control)
            return {type: IntentType.ACTIVATE_ALTERNATE};
        if (shift)
            return {type: IntentType.ACTIVATE_SECONDARY};
        return {type: IntentType.ACTIVATE};

    case Clutter.KEY_Up:
    case Clutter.KEY_KP_Up:
        if (control && shift)
            return {type: IntentType.REORDER_FAVORITE, delta: -1};
        return {type: IntentType.MOVE, delta: -1};

    case Clutter.KEY_Down:
    case Clutter.KEY_KP_Down:
        if (control && shift)
            return {type: IntentType.REORDER_FAVORITE, delta: 1};
        return {type: IntentType.MOVE, delta: 1};

    case Clutter.KEY_Page_Up:
    case Clutter.KEY_KP_Page_Up:
        return {type: IntentType.PAGE, delta: -1};

    case Clutter.KEY_Page_Down:
    case Clutter.KEY_KP_Page_Down:
        return {type: IntentType.PAGE, delta: 1};

    case Clutter.KEY_Home:
    case Clutter.KEY_KP_Home:
        return {type: IntentType.FIRST};

    case Clutter.KEY_End:
    case Clutter.KEY_KP_End:
        return {type: IntentType.LAST};

    case Clutter.KEY_Tab:
    case Clutter.KEY_ISO_Left_Tab:
        // Tab cycles between sections rather than between widgets: the
        // popup has exactly one focusable widget (the entry), so the
        // usual focus-chain meaning would do nothing at all.
        return {type: IntentType.SECTION, delta: shift ? -1 : 1};

    case Clutter.KEY_n:
    case Clutter.KEY_N:
        return control ? {type: IntentType.MOVE, delta: 1} : NONE;

    case Clutter.KEY_p:
    case Clutter.KEY_P:
        return control ? {type: IntentType.MOVE, delta: -1} : NONE;

    case Clutter.KEY_d:
    case Clutter.KEY_D:
        return control ? {type: IntentType.TOGGLE_PIN} : NONE;

    case Clutter.KEY_BackSpace:
        return control ? {type: IntentType.CLEAR_QUERY} : NONE;

    case Clutter.KEY_Delete:
    case Clutter.KEY_KP_Delete:
        return control ? {type: IntentType.REMOVE} : NONE;

    default:
        break;
    }

    if (alt) {
        // Alt+1..9 jumps straight to the Nth visible result.
        const digit = digitOf(keyval);
        if (digit !== null && digit >= 1 && digit <= QUICK_SELECT_COUNT)
            return {type: IntentType.QUICK_SELECT, index: digit - 1};
    }

    return NONE;
}

function digitOf(keyval) {
    if (keyval >= Clutter.KEY_1 && keyval <= Clutter.KEY_9)
        return keyval - Clutter.KEY_1 + 1;
    if (keyval >= Clutter.KEY_KP_1 && keyval <= Clutter.KEY_KP_9)
        return keyval - Clutter.KEY_KP_1 + 1;
    return null;
}
