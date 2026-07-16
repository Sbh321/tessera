// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {buildCssDeclarations, isValidHexColor} from './utils.js';

// Matches FALLBACK_ACTIVE_HEX in workspaceIndicator.js -- same last-resort
// literal, used only when the accent color can't be determined at all.
const FALLBACK_BORDER_HEX = '#3584e4';

// Which windows get a border. Deliberately NOT the tiling subsystem's
// isTileable() -- that answers "should this be auto-arranged", a
// different question from "is this a real user window worth
// highlighting". A focused dialog should get a border; it should never
// be tiled. Menus, tooltips, docks, the desktop, and other chrome-ish
// types are excluded because they either can't sensibly hold keyboard
// focus or would look wrong outlined.
const HIGHLIGHTABLE_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
]);

/**
 * Draws a Hyprland-style hint border around the currently focused window,
 * on every workspace and monitor -- purely cosmetic chrome, entirely
 * independent of lib/tiling/: a floating window gets a border exactly
 * like a tiled one, and the whole feature works even with tiling
 * disabled.
 *
 * Tracks exactly one window at a time (whichever is focused), so its
 * signal bookkeeping is far lighter than TilingManager's -- no per-window
 * map, just connect on focus-in, disconnect on focus-out.
 *
 * Colors are ALWAYS resolved to a concrete inline value, never left to a
 * stylesheet class rule -- the same discipline as
 * WorkspaceSquare._resolveBackgroundColor(), for the same reason: a
 * class-rule color would leak through as a flash on every focus change.
 * See stylesheet.css's `.tessera-focus-border` rule for why it carries
 * no color properties at all.
 */
export const FocusBorderManager = GObject.registerClass(
class FocusBorderManager extends St.Widget {
    constructor(settingsManager, accentColorTracker) {
        super({
            style_class: 'tessera-focus-border',
            visible: false,
            reactive: false,
        });

        this._settingsManager = settingsManager;
        this._accentColorTracker = accentColorTracker;

        this._trackedWindow = null;
        this._windowSignalIds = [];
        this._displaySignalId = null;
        this._windowManagerSignalId = null;
        this._workspaceManagerSignalId = null;
        this._overviewSignalIds = [];
        this._settingsSignalIds = [];
        this._accentSignalId = null;
        this._gestureBeginHandlerId = null;
        this._swipeTracker = null;
    }

    enable() {
        Main.layoutManager.addChrome(this, {affectsInputRegion: false});

        this._displaySignalId = global.display.connect(
            'notify::focus-window', () => this._onFocusChanged());

        // global.window_manager (Shell.WM, a public GObject -- distinct
        // from the private field GestureProgressTracker reaches into)
        // emits 'switch-workspace' at the start of every keyboard- or
        // mouse-driven workspace-switch animation. The border is chrome
        // (UI group), so it does NOT slide with the animated window
        // group; left alone during the animation it would appear to
        // hang motionless while the real window slides away beneath it.
        // Hiding here and resyncing on the authoritative
        // 'workspace-switched' (below) brackets the animation cleanly.
        this._windowManagerSignalId = global.window_manager.connect(
            'switch-workspace', () => this.hide());

        this._workspaceManagerSignalId = global.workspace_manager.connect(
            'workspace-switched', () => this._onFocusChanged());

        // Best-effort only, mirroring lib/gestureProgressTracker.js
        // exactly: 'switch-workspace' above covers keyboard/mouse
        // switches, but a 3-finger swipe's live drag is driven entirely
        // by a private SwipeTracker that never touches the active
        // workspace (and so never fires 'switch-workspace') until the
        // gesture commits. Without this, the border would hang at its
        // pre-swipe position for the live-drag portion of every gesture
        // switch. Same defensive posture as that file: optional
        // chaining, a typeof guard, try/catch -- a mismatch on some
        // other GNOME build just means the border lags slightly during
        // gesture swipes specifically, corrected the instant the gesture
        // commits and 'workspace-switched' fires, never a crash and
        // never a permanently wrong position.
        try {
            this._swipeTracker = Main.wm._workspaceAnimation?._swipeTracker ?? null;
        } catch (error) {
            this._swipeTracker = null;
        }
        if (typeof this._swipeTracker?.connect === 'function') {
            try {
                this._gestureBeginHandlerId = this._swipeTracker.connect(
                    'begin', () => this.hide());
            } catch (error) {
                this._swipeTracker = null;
            }
        } else {
            this._swipeTracker = null;
        }

        this._overviewSignalIds = [
            Main.overview.connect('showing', () => this.hide()),
            Main.overview.connect('hidden', () => this._onFocusChanged()),
        ];

        const gsettings = this._settingsManager.gsettings;
        this._settingsSignalIds = [
            gsettings.connect('changed::enable-focus-border', () => this._sync()),
            gsettings.connect('changed::focus-border-color', () => this._sync()),
            gsettings.connect('changed::focus-border-width', () => this._sync()),
            gsettings.connect('changed::focus-border-radius', () => this._sync()),
        ];
        this._accentSignalId = this._accentColorTracker.gsettings.connect(
            'changed::gtk-theme', () => this._sync());

        this._onFocusChanged();
    }

    disable() {
        this._untrackWindow();

        if (this._displaySignalId !== null) {
            global.display.disconnect(this._displaySignalId);
            this._displaySignalId = null;
        }
        if (this._windowManagerSignalId !== null) {
            global.window_manager.disconnect(this._windowManagerSignalId);
            this._windowManagerSignalId = null;
        }
        if (this._workspaceManagerSignalId !== null) {
            global.workspace_manager.disconnect(this._workspaceManagerSignalId);
            this._workspaceManagerSignalId = null;
        }
        if (this._swipeTracker && this._gestureBeginHandlerId !== null)
            this._swipeTracker.disconnect(this._gestureBeginHandlerId);
        this._swipeTracker = null;
        this._gestureBeginHandlerId = null;

        for (const id of this._overviewSignalIds)
            Main.overview.disconnect(id);
        this._overviewSignalIds = [];

        for (const id of this._settingsSignalIds)
            this._settingsManager.gsettings.disconnect(id);
        this._settingsSignalIds = [];

        if (this._accentSignalId !== null) {
            this._accentColorTracker.gsettings.disconnect(this._accentSignalId);
            this._accentSignalId = null;
        }

        Main.layoutManager.removeChrome(this);
        this.destroy();
    }

    _onFocusChanged() {
        this._untrackWindow();

        const window = global.display.focus_window;
        if (window && HIGHLIGHTABLE_TYPES.has(window.window_type))
            this._trackWindow(window);

        this._sync();
    }

    _trackWindow(window) {
        this._trackedWindow = window;
        const resync = () => this._sync();
        this._windowSignalIds = [
            window.connect('position-changed', resync),
            window.connect('size-changed', resync),
            window.connect('notify::fullscreen', resync),
            window.connect('notify::minimized', resync),
            window.connect('unmanaged', () => this._onFocusChanged()),
        ];
    }

    _untrackWindow() {
        if (this._trackedWindow) {
            for (const id of this._windowSignalIds)
                this._trackedWindow.disconnect(id);
        }
        this._trackedWindow = null;
        this._windowSignalIds = [];
    }

    _sync() {
        const s = this._settingsManager;
        const window = this._trackedWindow;

        if (!s.enableFocusBorder || !window || window.minimized ||
            window.is_fullscreen() || Main.overview.visible) {
            this.hide();
            return;
        }

        const width = s.focusBorderWidth;
        const color = this._resolveColor();

        this.set_style(buildCssDeclarations({
            'border-width': `${width}px`,
            'border-color': color,
            'border-radius': `${s.focusBorderRadius}px`,
        }));

        // Drawn entirely OUTSIDE the window's frame (a picture frame, not
        // an overlap) so it never obscures window content and never
        // interferes with clicks -- reactive:false above already ensures
        // that structurally, this is just visual placement.
        const frame = window.get_frame_rect();
        this.set_position(frame.x - width, frame.y - width);
        this.set_size(frame.width + width * 2, frame.height + width * 2);
        this.show();
    }

    // Same fallback chain as WorkspaceSquare._resolveBackgroundColor():
    // user's explicit hex, else the system accent color, else a
    // hardcoded literal -- always a valid hex, never null, so the inline
    // border-color is never omitted (omitting it would let a stylesheet
    // rule show through for a frame on every focus change, the exact
    // flash bug already fixed once for the workspace squares).
    _resolveColor() {
        const s = this._settingsManager;
        if (isValidHexColor(s.focusBorderColor))
            return s.focusBorderColor;
        return this._accentColorTracker.hex ?? FALLBACK_BORDER_HEX;
    }
});
