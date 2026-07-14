// SPDX-License-Identifier: GPL-2.0-or-later

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GNOME Shell 46's own Activities button renders small ".workspace-dot"
// actors representing each workspace. This wasn't found by reading
// js/ui/panel.js directly -- it isn't available as loose source on this
// system, only compiled into the shell (see docs/GNOME_NOTES.md) -- but was
// confirmed by inspecting the live actor tree with Looking Glass and
// cross-referencing the class name against the (unrelated) Just Perfection
// extension's stylesheet, which recolors the same dots.
//
// This is an internal, undocumented style class, not a public API, and
// could change or disappear in a future GNOME version. Rather than hide it
// unconditionally, this manager only adds a marker style class to
// Main.panel when the user has the corresponding setting on, so a version
// mismatch just means the override quietly stops doing anything -- not a
// crash -- and can be turned off from Preferences.
const MARKER_STYLE_CLASS = 'tessera-hide-native-dots';

export class NativeIndicatorHider {
    constructor(settingsManager) {
        this._settingsManager = settingsManager;
        this._settingsChangedId = null;
    }

    enable() {
        this._settingsChangedId = this._settingsManager.gsettings.connect(
            'changed::hide-native-activities-dots', () => this._sync());
        this._sync();
    }

    disable() {
        Main.panel.remove_style_class_name(MARKER_STYLE_CLASS);

        if (this._settingsChangedId !== null) {
            this._settingsManager.gsettings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
    }

    _sync() {
        if (this._settingsManager.hideNativeActivitiesDots)
            Main.panel.add_style_class_name(MARKER_STYLE_CLASS);
        else
            Main.panel.remove_style_class_name(MARKER_STYLE_CLASS);
    }
}
