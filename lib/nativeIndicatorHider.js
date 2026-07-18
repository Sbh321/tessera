// SPDX-License-Identifier: GPL-2.0-or-later

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GNOME Shell 46's own Activities button (top-left) renders small
// ".workspace-dot" actors representing each workspace, and clicking it
// toggles the Activities overview. With this extension's own squares in
// the panel the whole button is redundant, so `hide-native-activities-dots`
// (on by default) hides it entirely -- and the WorkspaceIndicator takes
// over its click-to-overview and scroll-to-switch-workspace roles (see
// lib/workspaceIndicator.js vfunc_event).
//
// Hiding is two independent layers:
//
// 1. The button itself: `Main.panel.statusArea.activities.container` is
//    hidden. Panel._updatePanel() calls container.show() on every
//    indicator it lays out and runs on every session-mode change
//    (verified in this install's extracted js/ui/panel.js,
//    _addToPanelBox), so the hide is re-asserted on sessionMode
//    'updated' rather than set once.
// 2. The ".workspace-dot" CSS collapse (stylesheet.css), kept as a
//    defensive layer: the dots class is internal and undocumented (found
//    via Looking Glass, not public API), and if a future GNOME renames
//    the "activities" statusArea role, layer 1 quietly stops working --
//    a version mismatch must mean "override stops doing anything", not
//    a crash. The marker class scopes the CSS so it can be turned off
//    from Preferences.
const MARKER_STYLE_CLASS = 'tessera-hide-native-dots';

export class NativeIndicatorHider {
    constructor(settingsManager) {
        this._settingsManager = settingsManager;
        this._settingsChangedId = null;
        this._sessionModeChangedId = null;
    }

    enable() {
        this._settingsChangedId = this._settingsManager.gsettings.connect(
            'changed::hide-native-activities-dots', () => this._sync());
        this._sessionModeChangedId = Main.sessionMode.connect(
            'updated', () => this._sync());
        this._sync();
    }

    disable() {
        if (this._settingsChangedId !== null) {
            this._settingsManager.gsettings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._sessionModeChangedId !== null) {
            Main.sessionMode.disconnect(this._sessionModeChangedId);
            this._sessionModeChangedId = null;
        }

        Main.panel.remove_style_class_name(MARKER_STYLE_CLASS);
        this._setActivitiesButtonVisible(true);
    }

    _sync() {
        const hide = this._settingsManager.hideNativeActivitiesDots;

        if (hide)
            Main.panel.add_style_class_name(MARKER_STYLE_CLASS);
        else
            Main.panel.remove_style_class_name(MARKER_STYLE_CLASS);

        this._setActivitiesButtonVisible(!hide);
    }

    _setActivitiesButtonVisible(visible) {
        const activities = Main.panel.statusArea.activities;
        if (activities)
            activities.container.visible = visible;
    }
}
