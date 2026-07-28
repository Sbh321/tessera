// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// The internal accelerator (see the schema key of the same name) grabbed
// ONLY while a window this module fullscreened is focused, so Escape
// leaves that fullscreen.
const ESCAPE_KEY = 'window-fullscreen-escape';

const ACTION_MODES = Shell.ActionMode.NORMAL;

/**
 * Owns "keybind fullscreen": true, immersive fullscreen (Mutter's
 * make_fullscreen -- covers the whole monitor, panel included) toggled by
 * Super+F, as distinct from Maximize (WindowMover.toggleFocusedMaximize,
 * which keeps the panel). It is its own module rather than a stateless
 * WindowMover action because, unlike a plain toggle, it has exit triggers
 * that need state and signals:
 *
 * - Toggling the key again leaves fullscreen (plain).
 * - Opening a new application window leaves it -- so the new window is
 *   visible instead of hidden behind a fullscreen one (mirrors the tiler's
 *   _exitMaximized for maximize).
 * - While such a window is FOCUSED, Escape leaves it.
 *
 * The critical scoping decision: this module only ever touches windows the
 * user fullscreened THROUGH this module (tracked in `_fullscreened`). A
 * window that fullscreens *itself* (a video player, a game, YouTube) is
 * never tracked and never force-exited -- so the exit triggers can never
 * interrupt real fullscreen content. `_fullscreened` is kept honest by a
 * per-window notify::fullscreen watch that drops a window the instant it
 * leaves fullscreen by ANY means, and an unmanaged watch that drops it if
 * it closes.
 *
 * The Escape grab is likewise scoped by FOCUS, not merely by "something is
 * fullscreen": it is added only while the focused toplevel is one of our
 * tracked windows and removed the moment focus moves elsewhere, so Escape
 * is intercepted from exactly the one window the user is looking at in our
 * fullscreen -- never globally, never from an ordinary window on another
 * workspace. Intercepting Escape from that focused window is the accepted
 * trade-off of the feature (an app that needs Escape itself, e.g. vim,
 * won't receive it while kept in this fullscreen).
 */
export class FullscreenManager {
    constructor(settingsManager) {
        this._settingsManager = settingsManager;

        // Meta.Window we fullscreened via toggleFocused (not app-initiated
        // fullscreen, which we never track or touch).
        this._fullscreened = new Set();
        // Meta.Window -> [handlerId] (notify::fullscreen, unmanaged).
        this._windowSignals = new Map();

        this._displaySignalId = null;
        this._focusSignalId = null;
        this._escapeBound = false;
    }

    enable() {
        this._displaySignalId = global.display.connect('window-created',
            (d, window) => this._onWindowCreated(window));
        this._focusSignalId = global.display.connect('notify::focus-window',
            () => this._syncEscape());
    }

    disable() {
        if (this._displaySignalId !== null) {
            global.display.disconnect(this._displaySignalId);
            this._displaySignalId = null;
        }
        if (this._focusSignalId !== null) {
            global.display.disconnect(this._focusSignalId);
            this._focusSignalId = null;
        }
        for (const [window, ids] of this._windowSignals) {
            for (const id of ids)
                window.disconnect(id);
        }
        this._windowSignals.clear();
        this._fullscreened.clear();
        this._unbindEscape();
        // Windows keep their fullscreen state: this module never forces a
        // window out of a state the user asked for just because the
        // extension is being disabled (e.g. around screen lock).
    }

    /**
     * Super+F: fullscreen the focused window, or leave fullscreen if it is
     * already in the fullscreen we put it in. Toplevel resolved via
     * find_root_ancestor; only NORMAL windows (never a dock/desktop/panel).
     */
    toggleFocused(target = null) {
        // An explicit target overrides live focus -- the launcher passes
        // the window that was focused when its (modal) popup opened, so
        // the action never depends on focus-restoration timing.
        const focus = target?.get_compositor_private()
            ? target
            : global.display.focus_window;
        if (!focus)
            return;

        const window = focus.find_root_ancestor?.() ?? focus;
        if (window.window_type !== Meta.WindowType.NORMAL)
            return;

        if (window.is_fullscreen()) {
            // Only untracks via the notify::fullscreen watch below; here we
            // just ask Mutter to leave fullscreen.
            window.unmake_fullscreen();
        } else {
            window.make_fullscreen();
            this._track(window);
        }
    }

    /**
     * Leave any of OUR fullscreens on `workspace` (null = all of them).
     * Used by the stacked-mode toggle (composed in KeybindingManager), so
     * switching a workspace to/from stacked actually takes effect instead
     * of staying hidden behind a fullscreen window -- the same intent as
     * TilingManager._exitMaximized clearing a maximize on that toggle.
     * Scoped, like every trigger here, to windows WE fullscreened: an
     * app's own video fullscreen is never touched.
     *
     * @param {?Meta.Workspace} workspace only exit fullscreens here; null
     *   means every tracked fullscreen regardless of workspace
     */
    exitWorkspace(workspace) {
        if (this._fullscreened.size === 0)
            return;
        for (const window of [...this._fullscreened]) {
            if (window.is_fullscreen() &&
                (workspace === null || window.get_workspace() === workspace))
                window.unmake_fullscreen();
        }
    }

    _track(window) {
        this._fullscreened.add(window);
        if (!this._windowSignals.has(window)) {
            this._windowSignals.set(window, [
                window.connect('notify::fullscreen', () => {
                    if (!window.is_fullscreen())
                        this._untrack(window);
                }),
                window.connect('unmanaged', () => this._untrack(window)),
            ]);
        }
        this._syncEscape();
    }

    _untrack(window) {
        this._fullscreened.delete(window);
        const ids = this._windowSignals.get(window);
        if (ids) {
            for (const id of ids)
                window.disconnect(id);
            this._windowSignals.delete(window);
        }
        this._syncEscape();
    }

    // A new real application window opened: leave any of OUR fullscreens on
    // that window's workspace, so the new window isn't hidden behind one.
    // Gated to genuine top-level app windows (a dialog/transient/popup must
    // not trigger this), matching TilingManager._opensAsTilingApp.
    _onWindowCreated(window) {
        if (window.window_type !== Meta.WindowType.NORMAL ||
            window.get_transient_for() !== null || window.skip_taskbar)
            return;
        if (this._fullscreened.size === 0)
            return;

        const workspace = window.get_workspace() ??
            global.workspace_manager.get_active_workspace();
        for (const other of [...this._fullscreened]) {
            if (other !== window && other.is_fullscreen() &&
                (other.get_workspace() === workspace || workspace === null))
                other.unmake_fullscreen();
        }
    }

    // Escape should leave fullscreen only when the user is actually looking
    // at one of our fullscreened windows -- so the grab exists precisely
    // when the focused toplevel is tracked, and never otherwise.
    _syncEscape() {
        const focus = global.display.focus_window;
        const toplevel = focus?.find_root_ancestor?.() ?? focus;
        if (toplevel && this._fullscreened.has(toplevel))
            this._bindEscape();
        else
            this._unbindEscape();
    }

    _bindEscape() {
        if (this._escapeBound)
            return;
        const action = Main.wm.addKeybinding(
            ESCAPE_KEY,
            this._settingsManager.gsettings,
            Meta.KeyBindingFlags.NONE,
            ACTION_MODES,
            () => this._onEscape());
        if (action)
            this._escapeBound = true;
        else
            console.warn('tessera: failed to grab fullscreen-escape keybinding');
    }

    _unbindEscape() {
        if (!this._escapeBound)
            return;
        Main.wm.removeKeybinding(ESCAPE_KEY);
        this._escapeBound = false;
    }

    _onEscape() {
        const focus = global.display.focus_window;
        const toplevel = focus?.find_root_ancestor?.() ?? focus;
        if (toplevel && this._fullscreened.has(toplevel) && toplevel.is_fullscreen())
            toplevel.unmake_fullscreen();
    }
}
