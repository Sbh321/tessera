// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';

/**
 * Decides which windows participate in tiling. Pure classification -- no
 * state, no signals; evaluated fresh on every layout pass so a window
 * whose properties change drifts in or out of the layout automatically
 * with no bookkeeping to go stale.
 *
 * Two levels, matching the two questions the layout tree asks:
 *
 * - isLayoutMember(): "does this window belong in the bucket's layout
 *   tree at all?" -- identity-level properties (window type, transient
 *   parent, taskbar presence, stickiness) that are effectively fixed
 *   for a window's life, plus one explicit user override: a window the
 *   user has toggled to float (Shift+Super+V) leaves the layout as if
 *   it were a dialog, dropping its tree leaf so its siblings reclaim the
 *   area, and rejoins when toggled back.
 * - isTileable(): "should this window occupy its tile *right now*?" --
 *   membership plus transient states (minimized, user-maximized,
 *   unresizable). A member that fails these keeps its leaf in the tree
 *   but yields its area to its sibling, so minimize-then-restore or
 *   maximize-then-unmaximize returns a window to exactly the slot it
 *   left instead of reinserting it somewhere new.
 *
 * Everything that is not a member simply floats: the tiler never
 * touches it.
 *
 * These functions stay pure: the user-float state they consult is
 * *injected* by the caller (TilingManager passes its module-scoped
 * floating-window Set), never read from module state here, so the same
 * "evaluated fresh every pass, no bookkeeping to go stale" property
 * holds. Callers that do not track floating (e.g. lib/focusBorder.js,
 * which has its own filter) pass nothing and get the identity-only
 * classification.
 */

/**
 * @param {Meta.Window} window any window
 * @param {?Set<Meta.Window>} [floating] windows the user has toggled to
 *   float; such a window is treated as a non-member. null/omitted means
 *   "consider no window user-floated" (identity-only classification).
 * @returns {boolean} whether it belongs in a bucket's layout tree
 */
export function isLayoutMember(window, floating = null) {
    // User-floated windows leave the layout entirely, exactly like a
    // dialog or sticky window would -- this is the one explicit override
    // over the identity-level rules below (see TilingManager.toggleFloating).
    if (floating?.has(window))
        return false;

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

    // Sticky windows: a window the user pinned to all workspaces has no
    // single home layout -- float it (it would otherwise join every
    // workspace's tree at once). The exception is windows on
    // non-primary monitors under workspaces-only-on-primary, which Mutter
    // marks on-all-workspaces as an implementation detail; those are
    // ordinary windows and tile within their monitor (see the
    // secondary-monitor bucket handling in tilingManager.js).
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

/**
 * @param {Meta.Window} window any window
 * @param {?Set<Meta.Window>} [floating] see isLayoutMember
 * @returns {boolean} whether it should occupy its tile right now
 */
export function isTileable(window, floating = null) {
    if (!isLayoutMember(window, floating))
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
    if (isMaximized(window))
        return false;

    return true;
}

/**
 * @param {Meta.Window} window any window
 * @returns {boolean} whether it is user-maximized in both directions
 */
export function isMaximized(window) {
    return window.maximized_horizontally && window.maximized_vertically;
}

/**
 * A window that, while it holds the state, occupies its whole bucket to
 * the exclusion of everything else: fullscreen (any window kind -- Mutter
 * gives it the whole monitor) or a maximized real app window (it covers
 * the full work area). The tiler treats the two identically: while a
 * bucket has one, tiling for that bucket is suspended (no sibling is
 * reflowed beneath a window that already covers it -- that reflow was
 * visible as a brief "zoom" of the other tiles, most noticeable with the
 * top panel auto-hidden) and the stacked tab bar hides (it is chrome
 * drawn above windows and must not float over a fullscreen/maximized
 * window).
 *
 * Fullscreen is checked for any window because Mutter fullscreens the
 * toplevel regardless of tiling membership. Maximize is gated on
 * *identity-level* membership -- `isLayoutMember(window)` with NO
 * floating set passed -- deliberately: a window the user has toggled to
 * float is not a layout *member*, but a maximized floating window still
 * covers the whole work area and so must suspend reflow and hide the tab
 * bar exactly like a maximized tiled window would (otherwise the tab bar
 * keeps drawing over it -- the "tabs remain over a maximized floating
 * window" bug). Only a *stray* maximized dialog/utility/skip-taskbar
 * popup -- which fails the identity checks -- never suspends a bucket.
 * (True fullscreen of a floating window is already covered by the
 * is_fullscreen() check above.)
 *
 * @param {Meta.Window} window any window
 * @returns {boolean} whether it exclusively occupies its bucket
 */
export function isExclusiveOccupant(window) {
    if (window.is_fullscreen())
        return true;
    return isLayoutMember(window) && isMaximized(window);
}
