// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import {ProviderId} from './constants.js';

// Last resort when a provider offers neither a GIcon nor an icon name,
// and when the named icon is missing from the current theme.
const FALLBACK_ICON_NAME = 'application-x-executable-symbolic';

// Per-provider fallbacks, so a result without its own icon still reads as
// the KIND of thing it is rather than as a generic blank.
const PROVIDER_FALLBACK_ICON = {
    [ProviderId.APPS]: 'application-x-executable-symbolic',
    [ProviderId.WINDOWS]: 'focus-windows-symbolic',
    [ProviderId.ACTIONS]: 'system-run-symbolic',
    [ProviderId.COMMANDS]: 'utilities-terminal-symbolic',
    [ProviderId.CALCULATOR]: 'accessories-calculator-symbolic',
    [ProviderId.RECENT]: 'document-open-recent-symbolic',
    [ProviderId.CLIPBOARD]: 'edit-paste-symbolic',
    [ProviderId.SETTINGS]: 'preferences-system-symbolic',
    [ProviderId.EXTENSIONS]: 'application-x-addon-symbolic',
};

/**
 * Resolves every result to a concrete Gio.Icon, so the UI never has to
 * branch on which flavour of icon a provider happened to supply and never
 * shows an empty box.
 *
 * Themed icons are built through new_with_default_fallbacks(), which is
 * what makes a name like "org.gnome.Settings-display-symbolic" degrade to
 * "org.gnome.Settings-display" and then to the generic form instead of
 * failing outright on a theme that lacks the exact variant -- the usual
 * reason icons go missing on non-Adwaita icon themes.
 *
 * Named icons are cached because the same handful (action and fallback
 * icons) is requested on every keystroke; app icons are already owned by
 * Shell.App and are passed straight through.
 */
export class IconProvider {
    constructor() {
        this._themedByName = new Map();
    }

    /**
     * @param {object} result a searchResult record
     * @returns {Gio.Icon} never null
     */
    resolve(result) {
        if (result.gicon)
            return result.gicon;

        if (result.iconName)
            return this._themed(result.iconName);

        return this._themed(PROVIDER_FALLBACK_ICON[result.providerId] ?? FALLBACK_ICON_NAME);
    }

    /** Drops the cache; called from the launcher's disable(). */
    disable() {
        this._themedByName.clear();
    }

    _themed(name) {
        let icon = this._themedByName.get(name);
        if (!icon) {
            icon = Gio.ThemedIcon.new_with_default_fallbacks(name);
            this._themedByName.set(name, icon);
        }
        return icon;
    }
}
