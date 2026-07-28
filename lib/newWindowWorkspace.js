// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

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
 * - An empty workspace that already exists is used instead of creating
 *   another one. A window opening onto an empty workspace stays put --
 *   it already has a workspace to itself, and moving it would only leave
 *   a hole behind for GNOME to cull while dragging the user elsewhere
 *   for no visible gain. If the window instead opened somewhere occupied
 *   (an already-running app usually places new windows beside its
 *   existing ones) while the workspace the user is *looking at* is
 *   empty, it goes there rather than onto a freshly manufactured
 *   workspace beside the occupied one. Both cases are the same rule --
 *   never manufacture an empty workspace when one is already there -- and
 *   the first is also what makes the setting settle instead of marching
 *   forward forever: open an app, land on a fresh workspace, and only
 *   its *second* window moves on.
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
        if (!this._isContentWindow(window))
            return;

        const workspace = window.get_workspace();
        if (!workspace)
            return;

        // It opened onto an empty workspace: it already has one to
        // itself, so there is nothing to gain by moving it.
        if (this._isEmptyOfContent(workspace, window))
            return;

        // The workspace the user is LOOKING at is empty, but the window
        // opened somewhere else (an already-running app usually places a
        // new window beside its existing ones). Put it where the user
        // is, rather than manufacturing a second empty workspace next to
        // the occupied one and dragging them off to that instead: an
        // empty workspace that already exists is exactly what this
        // feature was about to create.
        const activeWorkspace = global.workspace_manager.get_active_workspace();
        if (activeWorkspace && activeWorkspace !== workspace &&
            this._isEmptyOfContent(activeWorkspace, window)) {
            this._windowMover.moveToWorkspace(window, activeWorkspace.index());
            return;
        }

        this._windowMover.moveToNewWorkspace(window,
            this._settingsManager.newWindowAdjacentWorkspace);
    }

    /**
     * A genuine, independent, workspace-bound application window.
     *
     * ONE predicate answers both of this module's questions -- "is this
     * worth relocating?" and "does this make a workspace occupied?" --
     * and they have to be the same question. When they were not, a
     * workspace holding nothing but a splash screen, a skip-taskbar
     * helper or a stray dialog counted as occupied, so a window opening
     * onto a visibly empty workspace was relocated off it anyway: the
     * user's screen said "empty", the check said "occupied". Anything
     * this feature would not bother moving is now equally something it
     * does not count as being in the way.
     *
     * Same identity gate the tiler uses to recognise "a real app window
     * opening" (TilingManager._opensAsTilingApp), plus the sticky
     * exclusion every workspace move in this extension applies -- which
     * also covers secondary-monitor windows under
     * workspaces-only-on-primary, since Mutter marks those
     * on-all-workspaces.
     *
     * @param {Meta.Window} window
     * @returns {boolean}
     */
    _isContentWindow(window) {
        return window.get_window_type() === Meta.WindowType.NORMAL &&
            window.get_transient_for() === null &&
            !window.is_skip_taskbar() &&
            !window.is_on_all_workspaces();
    }

    /**
     * Whether `workspace` holds no real user window, ignoring
     * `exceptWindow` (the one being judged, which is already on it).
     *
     * @param {Meta.Workspace} workspace
     * @param {?Meta.Window} exceptWindow
     * @returns {boolean}
     */
    _isEmptyOfContent(workspace, exceptWindow) {
        return !workspace.list_windows().some(other =>
            other !== exceptWindow && this._isContentWindow(other));
    }
}
