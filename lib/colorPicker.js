// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';

// Where the lens sits relative to the pointer, and how big it is. The
// pointer keeps a precise crosshair cursor; the lens is offset from it so
// the pixel being sampled is never hidden under the preview (and so
// pick_color reads the screen, not our own lens). Sizes are also mirrored
// in stylesheet.css -- these constants only drive on-screen positioning.
const LENS_OFFSET = 28;
const LENS_WIDTH = 168;
const LENS_HEIGHT = 210;

function toHexComponent(value) {
    // Shell.Screenshot.pick_color returns a Clutter.Color with 0..255
    // integer components (verified against GNOME 46's screenshot.js, which
    // divides these by 255 for its own D-Bus reply).
    const byte = Math.max(0, Math.min(255, Math.round(value)));
    return byte.toString(16).padStart(2, '0');
}

function colorToHex(color) {
    return `#${toHexComponent(color.red)}${toHexComponent(color.green)}${toHexComponent(color.blue)}`.toUpperCase();
}

// Full-screen picker overlay. Mirrors the grab/click/pick mechanics of
// GNOME's own PickPixel (js/ui/screenshot.js) -- a stage-sized reactive
// widget under a GrabHelper, a Clutter.ClickAction to finalize, and
// Shell.Screenshot.pick_color to sample -- but replaces GNOME's tiny
// recolored cursor icon with a large color lens (a ~5x bigger swatch plus
// a live hex readout) that trails the pointer.
const ColorPickerOverlay = GObject.registerClass(
class ColorPickerOverlay extends St.Widget {
    _init() {
        super._init({visible: false, reactive: true});

        this._screenshot = new Shell.Screenshot();
        this._result = null;
        this._hex = null;
        this._inPick = false;
        this._pendingPick = null;

        Main.uiGroup.add_child(this);
        this._grabHelper = new GrabHelper.GrabHelper(this);

        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        this._lens = new St.BoxLayout({
            vertical: true,
            style_class: 'tessera-color-lens',
            reactive: false,
            visible: false,
        });
        this._swatch = new St.Widget({
            style_class: 'tessera-color-lens-swatch',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._hexLabel = new St.Label({
            style_class: 'tessera-color-lens-hex',
            text: '—',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._lens.add_child(this._swatch);
        this._lens.add_child(this._hexLabel);
        Main.uiGroup.add_child(this._lens);

        const action = new Clutter.ClickAction();
        action.connect('clicked', () => this._onClicked(action));
        this.add_action(action);
    }

    async openAsync() {
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);
        Main.uiGroup.set_child_above_sibling(this, null);
        Main.uiGroup.set_child_above_sibling(this._lens, null);
        this.show();

        this._updateAt(...global.get_pointer());

        try {
            // Resolves when the grab ends: either our click ungrabs it
            // (having set _result) or the user presses Escape (GrabHelper
            // ungrabs on its own, leaving _result null == cancelled).
            await this._grabHelper.grabAsync({actor: this});
        } finally {
            global.display.set_cursor(Meta.Cursor.DEFAULT);
            this._lens.destroy();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this.destroy();
                return GLib.SOURCE_REMOVE;
            });
        }

        return this._result;
    }

    vfunc_motion_event(event) {
        this._updateAt(...event.get_coords());
        return Clutter.EVENT_PROPAGATE;
    }

    // Sample the color under (x, y) and reposition the lens. Coalesces
    // motion while a pick is in flight so we never queue a backlog of
    // async picks -- only the most recent position is retried.
    _updateAt(x, y) {
        this._positionLens(x, y);

        if (this._inPick) {
            this._pendingPick = [x, y];
            return;
        }

        this._inPick = true;
        this._screenshot.pick_color(x, y, (source, res) => {
            this._inPick = false;

            let color = null;
            try {
                const finished = source.pick_color_finish(res);
                // Depending on whether the prototype has been promisified
                // elsewhere, finish yields either the color or [ok, color];
                // the color is always the last element.
                color = Array.isArray(finished)
                    ? finished[finished.length - 1] : finished;
            } catch (e) {
                // Transient sampling failure -- keep the previous color.
            }

            if (color)
                this._setColor(color);

            if (this._pendingPick) {
                const [px, py] = this._pendingPick;
                this._pendingPick = null;
                this._updateAt(px, py);
            }
        });
    }

    _setColor(color) {
        this._hex = colorToHex(color);
        this._swatch.set_style(`background-color: ${this._hex};`);
        this._hexLabel.text = this._hex;
        if (!this._lens.visible)
            this._lens.show();
    }

    _positionLens(x, y) {
        const monitorIndex = global.display.get_current_monitor();
        const monitor = Main.layoutManager.monitors[monitorIndex];

        let lensX = x + LENS_OFFSET;
        let lensY = y + LENS_OFFSET;

        // Flip to the other side of the pointer near a monitor edge so the
        // lens always stays fully on-screen.
        if (lensX + LENS_WIDTH > monitor.x + monitor.width)
            lensX = x - LENS_OFFSET - LENS_WIDTH;
        if (lensY + LENS_HEIGHT > monitor.y + monitor.height)
            lensY = y - LENS_OFFSET - LENS_HEIGHT;

        this._lens.set_position(Math.round(lensX), Math.round(lensY));
    }

    async _onClicked(action) {
        const [x, y] = action.get_coords();

        // Sample once more at the exact click point so the committed color
        // matches the pixel clicked, regardless of motion coalescing.
        await new Promise(resolve => {
            this._screenshot.pick_color(x, y, (source, res) => {
                try {
                    const finished = source.pick_color_finish(res);
                    const color = Array.isArray(finished)
                        ? finished[finished.length - 1] : finished;
                    if (color)
                        this._setColor(color);
                } catch (e) {
                    // Keep whatever the last hover produced.
                }
                resolve();
            });
        });

        this._result = this._hex;
        this._grabHelper.ungrab();
    }
});

/**
 * Runs the interactive color picker. On a successful pick, copies the
 * #RRGGBB hex to the clipboard, records it in the picked-colors history,
 * and shows a confirmation. Cancelling (Escape) does nothing.
 *
 * @param {import('./settingsManager.js').SettingsManager} settingsManager
 */
export async function pickColor(settingsManager) {
    const overlay = new ColorPickerOverlay();
    const hex = await overlay.openAsync();
    if (!hex)
        return;

    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, hex);
    settingsManager.recordPickedColor(hex);
    Main.notify(_('Tessera'), _('Copied %s to the clipboard').format(hex));
}
