// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';

/**
 * Decides which windows participate in tiling. Pure classification -- no
 * state, no signals; evaluated fresh on every layout pass so a window
 * whose properties change (gains a transient parent, becomes sticky, gets
 * minimized or maximized) drifts in or out of the layout automatically
 * with no bookkeeping to go stale.
 *
 * Everything not tileable simply floats: the tiler never touches it.
 */

/**
 * @param {Meta.Window} window any window
 * @returns {boolean} whether it should be tiled
 */
export function isTileable(window) {
    // Dialogs, utility/splash/menu/dock/desktop/notification windows etc.
    // all float. NORMAL is the only type a tiler should ever manage --
    // same classification Mutter itself uses for "is this a real app
    // window".
    if (window.window_type !== Meta.WindowType.NORMAL)
        return false;

    // Transients (modal or not) belong visually to their parent; tiling
    // them as independent leaves would tear dialogs away from their
    // window.
    if (window.get_transient_for() !== null)
        return false;

    // Skip-taskbar NORMAL windows (portals, some launchers) behave like
    // popups; float them.
    if (window.skip_taskbar)
        return false;

    // A window that can't be freely moved/resized can't honor a computed
    // tile rectangle.
    if (!window.allows_resize() || !window.allows_move())
        return false;

    // Minimized windows leave the layout (GNOME users expect minimize to
    // reclaim the space; Hyprland has no minimize so there is no behavior
    // to mirror) and rejoin on restore -- both transitions retile via
    // notify::minimized.
    if (window.minimized)
        return false;

    // A user-maximized window floats at its GNOME-managed full-work-area
    // size rather than being forcibly un-maximized -- fighting an
    // explicit user action would be hostile, and maximized windows ignore
    // move_resize_frame() anyway. (Windows that *map* maximized are
    // un-maximized once at creation so they join the layout; see
    // TilingManager._onWindowCreated.)
    if (window.maximized_horizontally && window.maximized_vertically)
        return false;

    // Sticky windows: a window the user pinned to all workspaces has no
    // single home layout -- float it. The exception is windows on
    // non-primary monitors under workspaces-only-on-primary, which Mutter
    // marks on-all-workspaces as an implementation detail; those are
    // ordinary windows and tile within their monitor (see the
    // GLOBAL_BUCKET handling in tilingManager.js).
    if (window.is_on_all_workspaces()) {
        const primaryMonitor = window.get_display().get_primary_monitor();
        const onSecondaryUnderPrimaryOnly =
            Meta.prefs_get_workspaces_only_on_primary() &&
            window.get_monitor() !== primaryMonitor;
        if (!onSecondaryUnderPrimaryOnly)
            return false;
    }

    return true;
}
