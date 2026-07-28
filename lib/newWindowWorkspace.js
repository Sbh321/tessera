// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

// Window types that never count as a workspace's "contents": they either
// belong to every workspace or aren't real user windows, so their presence
// must not make a workspace look occupied. (Same exclusion set as
// lib/windowMover.js applies to a swap.)
const NON_CONTENT_WINDOW_TYPES = new Set([
    Meta.WindowType.DESKTOP,
    Meta.WindowType.DOCK,
]);

/**
 * Optional new-window placement: with `new-window-new-workspace` on, every
 * newly opened top-level application window is moved onto a workspace of
 * its own and the view follows it there -- one app per workspace, the
 * dynamic-workspace equivalent of Hyprland's per-app workspace habits.
 * `new-window-adjacent-workspace` picks where that workspace comes from:
 * the trailing (always-empty) workspace at the end of the strip by
 * default, or a brand-new workspace inserted immediately right of the
 * current one.
 *
 * This module decides only *whether* a given window should be relocated;
 * the move itself -- including the follow, and the shielding of the
 * emptied source workspace from a mid-animation cull -- is delegated
 * wholesale to WindowMover.moveToNewWorkspace, so there is exactly one
 * implementation of "move a window to a fresh workspace" in the extension.
 *
 * Two deliberate exclusions keep the feature from being hostile:
 *
 * - Only genuine top-level app windows qualify. Dialogs, transients,
 *   popups, skip-taskbar helpers and sticky/on-all-workspaces windows are
 *   never moved -- tearing a modal dialog away from its parent window, or
 *   "relocating" a window that lives on every workspace, is never what the
 *   setting asks for. (Under GNOME's workspaces-only-on-primary, windows
 *   on secondary monitors are marked on-all-workspaces and are therefore
 *   left alone too, which is right: they are workspace-independent.)
 *
 * - A window that opens onto an otherwise empty workspace stays put. It
 *   already has a workspace to itself, so moving it would only leave a
 *   hole behind for GNOME to cull and drag the user somewhere else for no
 *   visible gain. This is also what makes the setting settle instead of
 *   marching forward forever: open an app, land on a fresh workspace,
 *   open its dialog-free second window, and only *that* one moves on.
 *
 * The decision is deferred to an idle callback rather than taken
 * synchronously in the window-created handler. A freshly created window
 * has not necessarily finished declaring what it is -- transient parent
 * and skip-taskbar in particular arrive after window-created for a number
 * of Wayland and Electron clients (the same lag lib/tiling/tilingManager.js
 * documents around its own creation-time checks) -- so an immediate test
 * would misclassify exactly the popups this must not touch. One idle turn
 * later the client has committed its initial state, and the move still
 * lands before the user can act on the window.
 */
export class NewWindowWorkspaceManager {
    constructor(settingsManager, windowMover) {
        this._settingsManager = settingsManager;
        this._windowMover = windowMover;

        this._windowCreatedId = null;
        // Meta.Window -> {idleId, unmanagedId}: windows created but not yet
        // judged. An entry lives for exactly one idle turn, or until its
        // window is unmanaged first (an app that maps and closes a splash
        // window inside one turn), whichever comes first.
        this._pending = new Map();
    }

    enable() {
        this._windowCreatedId = global.display.connect('window-created',
            (display, window) => this._onWindowCreated(window));
    }

    disable() {
        if (this._windowCreatedId !== null) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = null;
        }

        for (const window of [...this._pending.keys()])
            this._cancel(window);
    }

    _onWindowCreated(window) {
        // Cheap pre-filter on the properties that are already reliable at
        // creation time; the authoritative test runs in _relocate, once the
        // client has settled. Checking the setting here as well means a
        // disabled feature costs nothing beyond this one comparison.
        if (!this._settingsManager.newWindowNewWorkspace)
            return;
        if (window.window_type !== Meta.WindowType.NORMAL)
            return;
        if (this._pending.has(window))
            return;

        const entry = {idleId: 0, unmanagedId: 0};
        entry.unmanagedId = window.connect('unmanaged', () => this._cancel(window));
        entry.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            // Null the id first: this source removes itself by returning
            // SOURCE_REMOVE, so _cancel must not remove it a second time.
            entry.idleId = 0;
            this._cancel(window);
            this._relocate(window);
            return GLib.SOURCE_REMOVE;
        });
        this._pending.set(window, entry);
    }

    // Drop a pending window's idle turn and signal handler. Safe to call
    // when there is nothing pending, and safe to call from inside the
    // 'unmanaged' handler it disconnects.
    _cancel(window) {
        const entry = this._pending.get(window);
        if (!entry)
            return;
        this._pending.delete(window);
        if (entry.idleId)
            GLib.Source.remove(entry.idleId);
        if (entry.unmanagedId)
            window.disconnect(entry.unmanagedId);
    }

    // The real decision, one idle turn after creation. Everything is
    // re-read rather than remembered: the settings may have been toggled
    // and the window may have declared itself a transient in the meantime.
    _relocate(window) {
        if (!this._settingsManager.newWindowNewWorkspace)
            return;
        if (!this._isRelocatable(window))
            return;

        const workspace = window.get_workspace();
        if (!workspace || this._isSoleOccupant(window, workspace))
            return;

        this._windowMover.moveToNewWorkspace(window,
            this._settingsManager.newWindowAdjacentWorkspace);
    }

    // A genuine, independent, workspace-bound application window -- the
    // only kind this feature ever moves. Same identity gate the tiler uses
    // to recognise "a real app window opening" (see
    // TilingManager._opensAsTilingApp), plus the sticky exclusion every
    // workspace move in this extension applies.
    _isRelocatable(window) {
        return window.window_type === Meta.WindowType.NORMAL &&
            window.get_transient_for() === null &&
            !window.skip_taskbar &&
            !window.on_all_workspaces;
    }

    // Whether `window` is the only real occupant of `workspace` -- i.e. the
    // workspace it opened on is already a workspace of its own, so there is
    // nothing to gain by moving it. Sticky windows and desktop/dock windows
    // never count as occupants (they are on every workspace, or aren't user
    // windows at all).
    _isSoleOccupant(window, workspace) {
        return !workspace.list_windows().some(other =>
            other !== window &&
            !other.is_on_all_workspaces() &&
            !NON_CONTENT_WINDOW_TYPES.has(other.get_window_type()));
    }
}
