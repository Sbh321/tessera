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
    }

    disable() {
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
