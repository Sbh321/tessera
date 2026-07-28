// SPDX-License-Identifier: GPL-2.0-or-later

import {clamp} from './utils.js';

const FAVORITES_KEY = 'launcher-favorites';

/**
 * The user's pinned results, in the order they chose.
 *
 * Stored as searchResult.resultKey strings ("apps:firefox.desktop"), not
 * as resolved objects: a pin has to survive an app being uninstalled and
 * reinstalled, an extension being disabled, and the shell restarting. A
 * key whose provider can no longer resolve it is simply skipped when the
 * favorites section is built (searchController._favoriteResults), so a
 * stale pin costs nothing and repairs itself if the app comes back.
 *
 * Order is user-controlled through Ctrl+Shift+Up/Down in the launcher.
 * Drag-ordering is deliberately not offered -- the popup runs under a
 * modal pointer/keyboard grab, where a drag gesture would have to fight
 * that grab for a keyboard-first surface that has no other pointer-only
 * affordance.
 */
export class FavoritesManager {
    constructor(gsettings) {
        this._gsettings = gsettings;
    }

    /** @returns {string[]} pinned keys, in user order */
    get keys() {
        return this._gsettings.get_strv(FAVORITES_KEY);
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    isPinned(key) {
        return this.keys.includes(key);
    }

    /**
     * Pins or unpins a key.
     *
     * @param {string} key
     * @returns {boolean} the new pinned state
     */
    toggle(key) {
        const current = this.keys;
        const index = current.indexOf(key);

        if (index >= 0) {
            current.splice(index, 1);
            this._gsettings.set_strv(FAVORITES_KEY, current);
            return false;
        }

        current.push(key);
        this._gsettings.set_strv(FAVORITES_KEY, current);
        return true;
    }

    /**
     * Moves a pinned key within the order.
     *
     * @param {string} key
     * @param {number} delta -1 to move earlier, +1 to move later
     * @returns {boolean} whether anything moved
     */
    move(key, delta) {
        const current = this.keys;
        const index = current.indexOf(key);
        if (index < 0)
            return false;

        const target = clamp(index + delta, 0, current.length - 1);
        if (target === index)
            return false;

        current.splice(index, 1);
        current.splice(target, 0, key);
        this._gsettings.set_strv(FAVORITES_KEY, current);
        return true;
    }

    /** Unpins everything; exposed through Preferences. */
    clear() {
        this._gsettings.set_strv(FAVORITES_KEY, []);
    }
}
