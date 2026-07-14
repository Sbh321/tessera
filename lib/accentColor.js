// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

// Ubuntu's Settings > Appearance accent-color picker has no standalone
// accent-color key on this GNOME version -- `gsettings list-keys
// org.gnome.desktop.interface` has no `accent-color` entry on GNOME 46 /
// Ubuntu 24.04. It works by switching `gtk-theme` between Yaru color
// variants instead. Each variant's real accent hex below was extracted
// directly from its compiled GTK4 theme resource (the
// `theme_selected_bg_color` GTK color variable), not guessed -- see
// docs/GNOME_NOTES.md for the exact extraction commands, so this can be
// re-verified or extended if Ubuntu adds more variants.
const YARU_ACCENT_HEX = {
    yaru: '#E95420',
    bark: '#787859',
    blue: '#0073E5',
    magenta: '#B34CB3',
    olive: '#4B8501',
    prussiangreen: '#308280',
    purple: '#7764D8',
    red: '#DA3450',
    sage: '#657B69',
    viridian: '#03875B',
};

/**
 * Read-only view of the user's current Ubuntu accent color, derived from
 * `org.gnome.desktop.interface gtk-theme`. Never writes to that schema.
 * `.hex` is null for any theme that isn't a recognized Yaru variant --
 * there's no general, theme-agnostic accent-color API on this GNOME
 * version, so callers should fall back to their own default in that case.
 */
export class AccentColorTracker {
    constructor() {
        this.gsettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
    }

    get hex() {
        let themeName = this.gsettings.get_string('gtk-theme');
        if (themeName.endsWith('-dark'))
            themeName = themeName.slice(0, -'-dark'.length);

        const colorName = themeName === 'Yaru'
            ? 'yaru'
            : themeName.replace(/^Yaru-/, '').toLowerCase();

        return YARU_ACCENT_HEX[colorName] ?? null;
    }
}
