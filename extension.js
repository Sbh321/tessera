// SPDX-License-Identifier: GPL-2.0-or-later

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SettingsManager} from './lib/settingsManager.js';
import {WorkspaceIndicator} from './lib/workspaceIndicator.js';
import {KeybindingManager} from './lib/keybindingManager.js';
import {NativeIndicatorHider} from './lib/nativeIndicatorHider.js';
import {AccentColorTracker} from './lib/accentColor.js';
import {WindowMover} from './lib/windowMover.js';
import {TilingManager} from './lib/tiling/tilingManager.js';
import {FocusBorderManager} from './lib/focusBorder.js';
import {PanelAutoHideManager} from './lib/panelAutoHide.js';

// SESSION-MODES JUSTIFICATION (metadata.json declares
// ["user", "unlock-dialog"], which cannot carry this comment itself):
//
// This extension modifies persistent top-panel state -- it hides GNOME's
// Activities button, changes the panelBox's strut registration for
// auto-hide, and contributes an inline panel background style. If it were
// disabled on every lock (the default without unlock-dialog), disable()
// would dutifully restore all of that and enable() would re-apply it on
// unlock, producing a visible flash of the restored Activities button and
// a full window reflow/retile (strut restored, then released again) on
// EVERY lock/unlock cycle. Running through unlock-dialog exists solely to
// keep that panel state stable across the lock.
//
// While the session is locked the extension deliberately goes inert:
// - the workspace-squares indicator hides its own container
//   (lib/workspaceIndicator.js) -- nothing is added to the lock screen;
// - panel auto-hide force-reveals the panel so the unlock dialog's
//   clock/battery are visible and stock (lib/panelAutoHide.js);
// - the panel-opacity style contributes nothing, deferring to GNOME's
//   own 'unlock-screen' panel styling (lib/panelAutoHide.js);
// - all keybindings are registered with ActionMode.NORMAL | OVERVIEW
//   (lib/keybindingManager.js) and are therefore inactive on the lock
//   screen; gestures are action-mode-gated by the shell itself.
//
// No input surface, shortcut, or UI this extension adds is reachable from
// the lock screen.
export default class TesseraExtension extends Extension {
    enable() {
        this._settingsManager = new SettingsManager(this.getSettings());
        this._accentColorTracker = new AccentColorTracker();

        this._createIndicator();
        this._panelPositionChangedId = this._settingsManager.gsettings.connect(
            'changed::panel-position', () => this._createIndicator());

        this._windowMover = new WindowMover();

        this._tilingManager = new TilingManager(this._settingsManager);
        this._tilingManager.enable();

        this._keybindingManager = new KeybindingManager(
            this._settingsManager, this._windowMover, this._tilingManager);
        this._keybindingManager.enable();

        this._nativeIndicatorHider = new NativeIndicatorHider(this._settingsManager);
        this._nativeIndicatorHider.enable();

        this._focusBorderManager = new FocusBorderManager(
            this._settingsManager, this._accentColorTracker);
        this._focusBorderManager.enable();

        this._panelAutoHideManager = new PanelAutoHideManager(this._settingsManager);
        this._panelAutoHideManager.enable();
    }

    disable() {
        this._panelAutoHideManager.disable();
        this._panelAutoHideManager = null;

        this._focusBorderManager.disable();
        this._focusBorderManager = null;

        this._nativeIndicatorHider.disable();
        this._nativeIndicatorHider = null;

        this._settingsManager.gsettings.disconnect(this._panelPositionChangedId);
        this._panelPositionChangedId = null;

        this._keybindingManager.disable();
        this._keybindingManager = null;

        this._tilingManager.disable();
        this._tilingManager = null;

        // Stateless (no signals/timers/keybindings of its own) -- nothing
        // to tear down beyond dropping the reference.
        this._windowMover = null;

        this._indicator.destroy();
        this._indicator = null;

        this._accentColorTracker = null;
        this._settingsManager = null;
    }

    // Re-created (rather than moved) on every panel-position change: GNOME's
    // panel API has no supported way to move an existing status-area actor
    // between boxes, only to add one to a chosen box at creation time.
    _createIndicator() {
        if (this._indicator)
            this._indicator.destroy();

        this._indicator = new WorkspaceIndicator(this._settingsManager, this._accentColorTracker);
        Main.panel.addToStatusArea(
            this.uuid, this._indicator, 0, this._settingsManager.panelPosition);
    }
}
