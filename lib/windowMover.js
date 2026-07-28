// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// How long to keep a just-emptied source workspace alive after a
// follow-move, so GNOME's WorkspaceTracker culls it only AFTER the
// workspace-switch animation settles rather than mid-slide. Sized to
// clear js/ui/workspaceAnimation.js's WINDOW_ANIMATION_TIME (250ms) with
// a margin (see _moveFollowing for the glitch this prevents).
const SOURCE_CULL_DELAY_MS = 400;

// Window types that never count as workspace "contents" and are never
// moved by a swap -- they either belong to every workspace or aren't real
// user windows. (on-all-workspaces / sticky windows are filtered
// separately, which also covers docks/desktop and, under
// workspaces-only-on-primary, everything on non-primary monitors.)
const NON_CONTENT_WINDOW_TYPES = new Set([
    Meta.WindowType.DESKTOP,
    Meta.WindowType.DOCK,
]);

/**
 * Window and workspace-content actions, Hyprland-style: move a window
 * between workspaces (the keybinding entry points act on the focused
 * window; moveToNewWorkspace takes any window, for the automatic
 * new-window placement in lib/newWindowWorkspace.js), swap two
 * workspaces' contents, and toggle a window's maximized state. Pure
 * action methods with no state or signals
 * of its own -- there is deliberately nothing to enable() or disable()
 * here, so this module can never leak. (A move may ask GNOME to keep the
 * emptied source workspace alive briefly; that timer is owned and
 * self-cleared by GNOME's own WorkspaceTracker, not by this module --
 * see _moveFollowing.) KeybindingManager dispatches into it; nothing else
 * knows it exists. (True fullscreen -- the immersive, panel-covering
 * kind -- lives in lib/fullscreenManager.js instead, because it needs
 * state and signals to support its exit triggers.)
 *
 * Both actions are thin compositions of GNOME Shell's own WindowManager
 * methods (Main.wm.actionMoveWindow / Main.wm.insertWorkspace) -- the same
 * code paths GNOME's built-in move-window keybindings use -- rather than
 * re-implementations, so window edge cases (fullscreen/maximized state,
 * attached dialogs, the switch animation carrying the window along,
 * focus handover) behave exactly as native GNOME moves do. See
 * docs/GNOME_NOTES.md for how both methods were verified against this
 * GNOME version's real source.
 *
 * Follow behavior: after a move, the view follows the window to its new
 * workspace with focus preserved. Both GNOME (actionMoveWindow calls
 * workspace.activate_with_focus) and Hyprland (movetoworkspace) follow by
 * default, so this matches every native expectation. If a "silent" move
 * variant (Hyprland's movetoworkspacesilent) is ever wanted, it belongs
 * here as a setting-gated alternative.
 */
export class WindowMover {
    /**
     * Move the focused window to the existing workspace at `index`.
     * No-ops cleanly when there is no movable focused window, the index
     * is out of range (consistent with Super+N jumps: no implicit
     * workspace creation), or the window is already there.
     *
     * @param {number} index 0-based workspace index
     * @param {?Meta.Window} [target] move this window instead of resolving
     *   the focused one (see _movableFocusedWindow)
     */
    moveFocusedToWorkspace(index, target = null) {
        const window = this._movableFocusedWindow(target);
        if (!window)
            return;

        this.moveToWorkspace(window, index);
    }

    /**
     * Move an explicit window to the existing workspace at `index`,
     * following it there. The general form behind
     * moveFocusedToWorkspace(); the launcher uses it directly for
     * "move <app> to workspace N", where the window is found by name
     * rather than by focus.
     *
     * @param {Meta.Window} window a movable, non-sticky window
     * @param {number} index 0-based workspace index
     */
    moveToWorkspace(window, index) {
        if (!window || window.on_all_workspaces)
            return;

        const workspace = global.workspace_manager.get_workspace_by_index(index);
        if (!workspace || workspace === window.get_workspace())
            return;

        this._moveFollowing(window, workspace);
    }

    /**
     * Move the focused window to the *trailing* workspace -- the last one
     * on the strip. With dynamic workspaces (GNOME's default) that
     * workspace is always the empty one the shell keeps at the end, so
     * this is the "hand this window a fresh workspace, appended at the
     * end" counterpart to moveFocusedToNewWorkspace's insert-beside; GNOME
     * then appends a new trailing workspace behind it. With static
     * workspaces it is simply "move to the last workspace".
     *
     * Clean no-op with no movable focused window, or when the window is
     * already on the trailing workspace (so repeated presses never churn
     * the workspace strip).
     *
     * @param {?Meta.Window} [target] move this window instead of the
     *   focused one (see _movableFocusedWindow)
     */
    moveFocusedToLastWorkspace(target = null) {
        const window = this._movableFocusedWindow(target);
        if (!window)
            return;

        const workspaceManager = global.workspace_manager;
        const destination = workspaceManager.get_workspace_by_index(
            workspaceManager.n_workspaces - 1);
        if (!destination || destination === window.get_workspace())
            return;

        this._moveFollowing(window, destination);
    }

    /**
     * Move any window -- not necessarily the focused one -- onto a
     * workspace of its own, following it there. The general form behind
     * the "open every new window on its own workspace" setting
     * (lib/newWindowWorkspace.js), which needs to relocate a window that
     * may not have taken focus yet; the keybinding-driven moves above stay
     * focused-window-only.
     *
     * @param {Meta.Window} window a window to relocate
     * @param {boolean} adjacent true: insert a brand-new workspace
     *   immediately to the right of the window's own workspace. false: use
     *   the trailing workspace at the end of the strip (always empty under
     *   dynamic workspaces), leaving the workspace order chronological.
     */
    moveToNewWorkspace(window, adjacent) {
        if (!window || window.on_all_workspaces)
            return;

        const source = window.get_workspace();
        if (!source)
            return;

        const workspaceManager = global.workspace_manager;
        const target = adjacent
            ? this._insertWorkspaceAfter(source)
            : workspaceManager.get_workspace_by_index(
                workspaceManager.n_workspaces - 1);
        if (!target || target === source)
            return;

        this._moveFollowing(window, target);
    }

    /**
     * Insert a brand-new workspace immediately after `source` and return
     * it. Same GNOME primitive, caveats and degradation as
     * moveFocusedToNewWorkspace: Main.wm.insertWorkspace only acts with
     * dynamic workspaces on, so with static workspaces (or a shell without
     * the method) this falls back to whatever workspace already sits in
     * that position, or null at the end of the strip.
     *
     * insertWorkspace shifts the *windows* of every workspace at index >=
     * the insert position one workspace along -- it never reorders the
     * Meta.Workspace objects themselves -- so `source`, which sits one
     * index below, keeps both its index and its remaining windows, and the
     * workspace now at that position is freshly empty. When the insert
     * lands at or before the *active* workspace (possible here whenever
     * the window opened on a workspace other than the viewed one) it also
     * re-activates the shifted origin, animations blocked, so the user
     * sees no spurious switch -- and the follow that comes next takes them
     * to the window regardless.
     *
     * @param {Meta.Workspace} source the workspace to insert after
     * @returns {?Meta.Workspace} the workspace to move into, or null
     */
    _insertWorkspaceAfter(source) {
        const workspaceManager = global.workspace_manager;
        const insertIndex = source.index() + 1;

        if (typeof Main.wm.insertWorkspace === 'function')
            Main.wm.insertWorkspace(insertIndex);

        return workspaceManager.get_workspace_by_index(insertIndex) ?? null;
    }

    /**
     * Insert a brand-new workspace immediately left/right of the current
     * one and move the focused window into it. Uses GNOME's own
     * Main.wm.insertWorkspace, which only operates when dynamic
     * workspaces are on (matching GNOME's own workspace model); with
     * static workspaces -- or on a GNOME build without insertWorkspace --
     * this degrades to moving the window into the existing neighbor
     * workspace in that direction, or a clean no-op at the strip's edge.
     *
     * @param {Meta.MotionDirection} direction LEFT or RIGHT
     * @param {?Meta.Window} [target] move this window instead of the
     *   focused one (see _movableFocusedWindow)
     */
    moveFocusedToNewWorkspace(direction, target = null) {
        const window = this._movableFocusedWindow(target);
        if (!window)
            return;

        const workspaceManager = global.workspace_manager;
        const activeIndex = workspaceManager.get_active_workspace_index();
        const insertIndex = direction === Meta.MotionDirection.RIGHT
            ? activeIndex + 1 : activeIndex;

        // insertWorkspace shifts every window at index >= insertIndex one
        // workspace to the right (skipping transients/sticky/OR windows,
        // which must not move) and re-activates the shifted origin
        // without animation, leaving a freshly-emptied workspace at
        // insertIndex. It no-ops entirely in static-workspaces mode.
        const countBefore = workspaceManager.n_workspaces;
        if (typeof Main.wm.insertWorkspace === 'function')
            Main.wm.insertWorkspace(insertIndex);
        const inserted = workspaceManager.n_workspaces > countBefore;

        const targetIndex = inserted
            ? insertIndex
            : activeIndex + (direction === Meta.MotionDirection.RIGHT ? 1 : -1);
        if (targetIndex < 0)
            return;

        const destination = workspaceManager.get_workspace_by_index(targetIndex);
        if (!destination || destination === window.get_workspace())
            return;

        this._moveFollowing(window, destination);
    }

    /**
     * Move `window` to `targetWorkspace` with GNOME's own follow-the-window
     * action, then shield the transition from a dynamic-workspace glitch:
     * if the window was the only occupant of its source workspace, that
     * workspace becomes empty and non-active (focus followed the window
     * away), so GNOME's WorkspaceTracker would cull it on the very next
     * BEFORE_REDRAW -- i.e. *during* the workspace-switch animation.
     * Removing it there reindexes every later workspace, including the
     * destination's, which jerks the slide and momentarily desyncs the
     * active-workspace highlight (most visible moving an app off the
     * viewed workspace onto the trailing one, which culls the source and
     * appends a new trailing at once). Keeping the emptied source alive
     * for the animation defers that cull to a single clean pass after the
     * user has arrived. A no-op when the source keeps other windows (it
     * would not be culled anyway) or when keepWorkspaceAlive is missing on
     * some future shell (the unshielded move still works, just as before).
     *
     * @param {Meta.Window} window a movable, non-sticky window
     * @param {Meta.Workspace} targetWorkspace where it is going
     */
    _moveFollowing(window, targetWorkspace) {
        const source = window.get_workspace();

        if (targetWorkspace.active) {
            // actionMoveWindow deliberately does NOTHING when the
            // destination is already active (verified in the extracted
            // windowManager.js: its whole body is inside `if
            // (!workspace.active)`). That is right for its own callers --
            // it exists to move a window *and take the user with it*, and
            // there is nowhere to go -- but here the move still has to
            // happen: the window is on some other workspace and the user
            // is looking at the destination. Reachable from the
            // launcher's "move <app> N" and from new-window placement
            // onto the viewed workspace; the keybindings can never hit it
            // (their window is on the active workspace by definition, and
            // that case returns earlier).
            window.change_workspace(targetWorkspace);
            Main.activateWindow(window);
        } else {
            Main.wm.actionMoveWindow(window, targetWorkspace);
        }

        if (source && source !== targetWorkspace &&
            this._isEmptyWorkspace(source) &&
            typeof Main.wm.keepWorkspaceAlive === 'function')
            Main.wm.keepWorkspaceAlive(source, SOURCE_CULL_DELAY_MS);
    }

    // Whether `workspace` now holds no window that would keep it from
    // being culled -- the same test WorkspaceTracker._checkWorkspaces uses
    // (any non-sticky window actor on it makes it non-empty). Read after
    // the move, so the just-moved window is already counted on its
    // destination, not here.
    _isEmptyWorkspace(workspace) {
        return !global.get_window_actors().some(actor => {
            const win = actor.meta_window;
            return !win.is_on_all_workspaces() &&
                win.get_workspace() === workspace;
        });
    }

    /**
     * Swap the entire contents (all movable windows) of the current
     * workspace with the workspace at `index`, then follow the swapped-in
     * content to that workspace. Modelled on the same GNOME primitives as
     * the moves above, so tiling re-lays out both sides for free (the
     * tiler retiles both source and destination on each window's
     * workspace-changed).
     *
     * Behavior, matching the feature spec:
     * - Current workspace empty (no movable windows): clean no-op.
     * - Swapping with self / an out-of-range index: clean no-op.
     * - Target non-empty: a true swap -- the two workspaces exchange their
     *   windows and the view follows to the target.
     * - Target empty: the current windows move over and the view follows;
     *   the now-empty current workspace is culled by GNOME (dynamic
     *   workspaces) once the switch settles, or simply left empty under
     *   static workspaces.
     *
     * All moves are issued synchronously with change_workspace (a silent
     * move that does not switch the view), so GNOME's dynamic-workspace
     * culler -- which runs on a later idle pass -- never sees a workspace
     * transiently emptied mid-swap and never removes the wrong one.
     *
     * @param {number} index 0-based target workspace index
     */
    swapWithWorkspace(index) {
        const workspaceManager = global.workspace_manager;
        const current = workspaceManager.get_active_workspace();
        const target = workspaceManager.get_workspace_by_index(index);
        if (!target || target === current)
            return;

        const currentWindows = this._movableWindowsOn(current);
        if (currentWindows.length === 0)
            return;

        const targetWindows = this._movableWindowsOn(target);
        const targetWasEmpty = targetWindows.length === 0;

        // Preserve which window keeps focus, so it stays in front of the
        // user on the workspace they land on.
        const focused = this._movableFocusedWindow();
        const followFocused = focused && currentWindows.includes(focused);

        for (const window of currentWindows)
            window.change_workspace(target);
        for (const window of targetWindows)
            window.change_workspace(current);

        const time = global.get_current_time();
        if (followFocused)
            target.activate_with_focus(focused, time);
        else
            target.activate(time);

        // Target-empty case: `current` is now empty and no longer active,
        // so GNOME would cull it on the next redraw -- i.e. mid-animation,
        // the same reindex glitch _moveFollowing guards against. Defer the
        // cull past the switch. (No-op when it kept windows, or on a shell
        // without keepWorkspaceAlive.)
        if (targetWasEmpty && this._isEmptyWorkspace(current) &&
            typeof Main.wm.keepWorkspaceAlive === 'function')
            Main.wm.keepWorkspaceAlive(current, SOURCE_CULL_DELAY_MS);
    }

    // Movable "contents" of a workspace: real user windows on it, excluding
    // sticky/on-all-workspaces windows and non-content types (desktop,
    // dock). Same exclusion rules as _movableFocusedWindow, applied to a
    // whole workspace.
    _movableWindowsOn(workspace) {
        return workspace.list_windows().filter(window =>
            !window.is_on_all_workspaces() &&
            !NON_CONTENT_WINDOW_TYPES.has(window.get_window_type()));
    }

    /**
     * Toggle maximize on the focused window: maximize it to fill the work
     * area (keeping the top panel and title bar -- the same state the
     * window's own maximize button / a title-bar double-click produces),
     * or restore it if already maximized. A thin wrapper over Mutter's own
     * maximize()/unmaximize(), so it behaves identically to native
     * maximize.
     *
     * With tiling enabled this composes for free with the tiler's existing
     * user-maximize handling: a maximized member becomes an exclusive
     * occupant (its bucket suspends and the stacked tab bar hides), opening
     * a new app un-maximizes it (TilingManager._exitMaximized), and
     * restoring re-tiles it -- no extra code here. With tiling disabled it
     * is just a plain maximize toggle.
     *
     * Resolves to the toplevel via find_root_ancestor (a focused dialog
     * maximizes its window, never itself) and only acts on NORMAL windows,
     * so a dock/desktop/panel is never maximized. Clean no-op when there
     * is no focused window.
     *
     * @param {?Meta.Window} [target] act on this window instead of the
     *   focused one (see _movableFocusedWindow)
     */
    toggleFocusedMaximize(target = null) {
        const focus = target?.get_compositor_private()
            ? target
            : global.display.focus_window;
        if (!focus)
            return;

        const window = focus.find_root_ancestor?.() ?? focus;
        if (window.window_type !== Meta.WindowType.NORMAL)
            return;

        if (window.maximized_horizontally && window.maximized_vertically)
            window.unmaximize(Meta.MaximizeFlags.BOTH);
        else
            window.maximize(Meta.MaximizeFlags.BOTH);
    }

    // The window a move actually applies to, or null for a clean no-op.
    //
    // - No focused window (desktop focus): nothing to move.
    // - A focused transient (modal/attached dialog) must never be moved
    //   alone -- find_root_ancestor() resolves to the toplevel it belongs
    //   to (or the window itself), and Mutter then carries all transients
    //   along with that ancestor.
    // - Sticky/on-all-workspaces windows (including every window on
    //   non-primary monitors under workspaces-only-on-primary, plus
    //   desktop/dock windows): a workspace move is meaningless and
    //   change_workspace would silently un-stick a user-pinned window, so
    //   they are left strictly alone.
    // - An explicit `candidate` overrides the live focus entirely. Only
    //   the launcher passes one: its popup runs under a modal grab, so by
    //   the time an action fires, "the focused window" may no longer be
    //   the window the user was looking at when they opened it. The
    //   launcher captures that window on open and passes it here, which
    //   makes the outcome deterministic rather than dependent on when
    //   Mutter restores focus. A candidate whose actor is already gone
    //   (closed while the launcher was open) falls back to live focus.
    _movableFocusedWindow(candidate = null) {
        const focus = candidate?.get_compositor_private()
            ? candidate
            : global.display.focus_window;
        if (!focus)
            return null;

        const window = focus.find_root_ancestor?.() ?? focus;
        if (window.on_all_workspaces)
            return null;

        return window;
    }
}
