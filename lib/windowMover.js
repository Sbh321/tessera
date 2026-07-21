// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Focused-window actions, Hyprland-style: move it between workspaces, and
 * toggle its maximized state. Pure action methods with no state, signals,
 * or timers -- there is deliberately nothing to enable() or disable()
 * here, so this module can never leak. KeybindingManager dispatches into
 * it; nothing else knows it exists. (True fullscreen -- the immersive,
 * panel-covering kind -- lives in lib/fullscreenManager.js instead,
 * because it needs state and signals to support its exit triggers.)
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
     */
    moveFocusedToWorkspace(index) {
        const window = this._movableFocusedWindow();
        if (!window)
            return;

        const workspace = global.workspace_manager.get_workspace_by_index(index);
        if (!workspace || workspace === window.get_workspace())
            return;

        Main.wm.actionMoveWindow(window, workspace);
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
     */
    moveFocusedToNewWorkspace(direction) {
        const window = this._movableFocusedWindow();
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

        const target = workspaceManager.get_workspace_by_index(targetIndex);
        if (!target || target === window.get_workspace())
            return;

        Main.wm.actionMoveWindow(window, target);
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
     */
    toggleFocusedMaximize() {
        const focus = global.display.focus_window;
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
    _movableFocusedWindow() {
        const focus = global.display.focus_window;
        if (!focus)
            return null;

        const window = focus.find_root_ancestor?.() ?? focus;
        if (window.on_all_workspaces)
            return null;

        return window;
    }
}
