// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    isLayoutMember, isTileable, isMaximized, isExclusiveOccupant, isHelperSurface,
} from './windowFilter.js';
import {
    Direction, LayoutMode, LayoutTree, computeStackGeometry, findNeighbor,
} from './layoutEngine.js';
import {StackTabBar} from './stackTabBar.js';

// How long after a window is first tracked a maximize is still treated
// as the app restoring its own remembered map state (and undone so the
// window tiles) rather than a deliberate user action (respected: the
// window floats). Needed because most apps that "open maximized"
// (browsers, Electron apps, Files, Settings...) apply that state only
// AFTER window-created -- Wayland clients on their first commit,
// Electron sometimes later still -- so a creation-time check alone sees
// an unmaximized window and misses them entirely, which showed up in
// practice as those apps never tiling. Users essentially never click
// maximize within the first moments of a window appearing, so the
// window of misclassification is negligible.
const MAP_MAXIMIZE_GRACE_US = 2 * GLib.USEC_PER_SEC;

// The tile guard's correction budget: how many times within one window
// of time a tiled window may be re-applied because it moved off its
// tile on its own, before the guard backs off. A window is always
// re-applied via _moveResize, which only touches a window whose frame
// differs from its tile, so a client that accepts what it is asked
// converges in one round; the budget exists for a client that will
// NOT accept (a minimum size larger than its tile, a game that pins its
// own size), so that the guard can never turn into a fight. Under
// normal use the budget is never reached.
const TILE_GUARD_BUDGET = 6;
const TILE_GUARD_WINDOW_US = 2 * GLib.USEC_PER_SEC;
const TILE_GUARD_BACKOFF_US = 3 * GLib.USEC_PER_SEC;

// Per-workspace layout-mode overrides (Meta.Workspace -> LayoutMode) --
// the user's per-workspace choice on top of the global `layout-mode`
// setting, which every workspace without an entry follows (and which
// new workspaces therefore start in). Must survive the disable()/enable()
// cycle GNOME performs around screen lock. Locking pushes the session mode to 'unlock-dialog',
// which declares no parentMode of its own; since this extension's
// metadata.json declares no session-modes (defaulting to ['user'] --
// the same as almost every user extension), GNOME's own
// ExtensionManager finds neither the current nor the parent mode in
// that list and disables the extension for the duration of the lock,
// re-enabling it on unlock (verified line-by-line against the
// extracted js/ui/extensionSystem.js and js/ui/sessionMode.js -- see
// docs/GNOME_NOTES.md). That cycle discards this TilingManager instance
// and rebuilds a fresh one, but ES modules stay cached for the life of
// the shell process (the same fact docs/DEVELOPMENT.md notes as the
// reason a code change needs a full shell restart to take effect) --
// so state declared here, at module scope rather than on the instance,
// survives the cycle intact. Keyed by Meta.Workspace object: those are
// owned by mutter, not this extension, so the same objects remain valid
// keys across the cycle (nothing here ever recreates them). Cleared
// wholesale when the global mode changes: that is what "changing the
// global mode changes every workspace" means.
const workspaceModes = new Map();

// Windows the user has explicitly popped out to float (Shift+Super+D) --
// a per-window user choice, the counterpart to workspaceModes' per-
// workspace one, and module-scoped for the exact same reason: it must
// survive the disable()/enable() cycle GNOME performs around screen lock
// (see the long comment on workspaceModes above). Keyed by Meta.Window
// (mutter-owned, stable across the cycle); an entry is pruned the moment
// its window is unmanaged (_untrackWindow), so it never holds a dead
// window, and it resets wholesale only on a genuine session restart (a
// fresh module load). A floated window is not a layout member
// (windowFilter.isLayoutMember consults this set), so it leaves the tree,
// its siblings reclaim its area, and it floats freely -- exactly like a
// dialog -- until toggled back.
const floatingWindows = new Set();

// The grab ops _onGrabOpEnd cares about: an interactive move (the window
// may have been dropped onto another tile -- swap them) and an
// interactive resize (the edge the user dragged becomes the new split
// ratio). Resolved by name and filtered, so a member missing on some
// Mutter build costs that case, never a startup crash.
const MOVE_GRAB_OPS = new Set(['MOVING', 'MOVING_UNCONSTRAINED', 'KEYBOARD_MOVING']
    .map(name => Meta.GrabOp[name])
    .filter(op => op !== undefined));
const RESIZE_GRAB_OPS = new Set(Object.keys(Meta.GrabOp)
    .filter(name => name.includes('RESIZING'))
    .map(name => Meta.GrabOp[name]));

/**
 * Orchestrates automatic tiling: observes window/workspace/monitor
 * events, asks the pure layout engine for rectangles, and applies them
 * with Meta.Window.move_resize_frame(). Owns all tiling state and all
 * signal lifecycles; nothing else in the extension knows tiling exists
 * except KeybindingManager (which dispatches the stacked toggle here)
 * and extension.js (which composes it).
 *
 * Design pillars (see docs/ARCHITECTURE.md for the full rationale):
 *
 * - RECONCILED LAYOUT TREES. Each bucket owns a LayoutTree (the pure
 *   dwindle split tree in lib/tiling/layoutEngine.js) so that a new
 *   window can split the *focused* window's tile -- Hyprland's
 *   focused-container insertion -- instead of triggering a global
 *   redistribution, and so that closing a window hands its area to its
 *   sibling alone. The tree is never trusted blindly: every layout pass
 *   re-derives the bucket's membership from workspace.list_windows(),
 *   filters it (lib/tiling/windowFilter.js), and reconciles the tree
 *   against that ground truth -- windows that left are pruned, windows
 *   that appeared are inserted (at their recorded focus anchor, else at
 *   the classic dwindle-spiral tail). A tree that is re-synced to
 *   ground truth on every pass cannot go stale or corrupt; any missed
 *   event heals on the next one.
 *
 * - BUCKETS. The layout unit is (workspace x monitor). Under GNOME's
 *   workspaces-only-on-primary (this install's default), windows on
 *   secondary monitors are workspace-independent, so each secondary
 *   monitor forms one workspace-agnostic bucket instead.
 *
 * - DEBOUNCED, TARGETED RELAYOUT. Events mark workspaces dirty in a Set;
 *   one idle callback flushes them all. Rapid bursts (app startup
 *   spawning windows, workspace shifts from insertWorkspace) coalesce
 *   into a single pass over only the affected workspaces.
 *
 * - LOOP-PROOF APPLICATION. A window is only resized when its current
 *   frame rect differs from the target, so applying a layout converges
 *   instead of re-triggering itself.
 */
export class TilingManager {
    constructor(settingsManager) {
        this._settingsManager = settingsManager;

        this._enabled = false;             // mirrors the enable-tiling setting
        this._windowSignals = new Map();   // Meta.Window -> [handlerId]
        this._windowWorkspaces = new Map(); // Meta.Window -> last known Meta.Workspace
        this._tabBars = new Map();         // monitor index -> StackTabBar
        // Meta.Window -> the tile rect last applied to it, for the tile
        // guard (_onGeometryChanged): the one place the tiler remembers
        // what a window SHOULD look like, so a window that changes its
        // own geometry can be compared against it without a layout pass.
        this._targets = new Map();
        // Meta.Window -> {count, since, backoffUntil}: the guard's
        // correction budget (TILE_GUARD_BUDGET).
        this._guardState = new Map();

        // One LayoutTree per bucket: Meta.Workspace (or null for the
        // workspace-agnostic secondary-monitor buckets) -> monitor index
        // -> LayoutTree. Reconciled against ground truth on every pass.
        this._trees = new Map();
        // Meta.Window -> the toplevel focused when it was created: the
        // leaf its insertion will split. Captured at window-created and
        // consumed at first insertion, because by the time the debounced
        // layout pass runs, focus has usually moved to the new window.
        this._insertionAnchors = new Map();

        this._pendingWorkspaces = new Set();
        this._pendingAll = false;
        this._idleId = null;

        // The grab op recorded at grab-op-begin, for a grab-op-end that
        // does not carry it (see _onGrabOpEnd).
        this._activeGrabOp = null;

        this._displaySignalIds = [];
        this._wmSignalIds = [];
        this._layoutManagerSignalIds = [];
        this._overviewSignalIds = [];
        this._settingsSignalIds = [];

        // Workspace-switch gesture tracking (see enable() for why):
        // while a 3-finger swipe is in flight, _syncTabBars() treats
        // every bucket as bar-less, exactly like it already does while
        // the overview is visible -- a state check, not a one-shot
        // hide() that a later relayout flush could undo.
        this._workspaceGestureActive = false;
        this._workspaceAnimation = null;
        this._workspaceSwipeTracker = null;
        this._workspaceSwipeSignalIds = [];

        // Throwaway StackTabBars parented INTO GNOME's workspace-switch
        // animation groups so the bar slides in/out with its workspace
        // during a 3-finger swipe (see _attachSwipeTabBars). Each is
        // destroyed with the animation group that owns it -- or by
        // _detachSwipeTabBars -- and removes itself from this list on
        // 'destroy', so the list only ever holds live actors.
        this._swipeTabBars = [];
    }

    // The per-workspace mode overrides are module-scoped state (see the
    // top of this file) so they survive the disable()/enable() cycle
    // GNOME performs around screen lock; this getter keeps every other
    // method in this class unaware of that -- they just see a Map that
    // behaves like an ordinary instance property.
    get _workspaceModes() {
        return workspaceModes;
    }

    // Module-scoped for the same lock-survival reason as
    // _workspaceModes (see the top of this file); this getter keeps
    // the rest of the class treating it like an ordinary instance Set.
    get _floatingWindows() {
        return floatingWindows;
    }

    // The mode a workspace is SET to: its override, else the global
    // setting. A null workspace (a workspace-agnostic secondary-monitor
    // bucket) is always tiled -- stacking is a per-workspace property and
    // those windows belong to no workspace (documented limitation).
    _modeOf(workspace) {
        if (!workspace)
            return LayoutMode.TILED;
        return this._workspaceModes.get(workspace) ?? this._settingsManager.layoutMode;
    }

    // The mode a workspace LAYS OUT in right now. Stacked is a group
    // posture: with fewer than two member windows there is nothing to
    // stack -- a lone window under a one-tab bar is strictly worse than
    // the same window tiled full-area -- so such a workspace lays out as
    // tiled while keeping its stacked setting, and the tab bar appears
    // the moment a second window arrives. The count is of *members*,
    // not currently-tileable windows, deliberately: a minimized or
    // user-maximized window keeps its tree slot and keeps the stack
    // alive; only close/move end membership.
    _effectiveModeOf(workspace) {
        const mode = this._modeOf(workspace);
        if (mode === LayoutMode.STACKED && this._stackableMemberCount(workspace) < 2)
            return LayoutMode.TILED;
        return mode;
    }

    _isStacked(workspace) {
        return this._effectiveModeOf(workspace) === LayoutMode.STACKED;
    }

    _isFloating(workspace) {
        return this._modeOf(workspace) === LayoutMode.FLOATING;
    }

    enable() {
        this._enabled = this._settingsManager.enableTiling;

        const display = global.display;
        this._displaySignalIds = [
            display.connect('window-created',
                (d, window) => this._onWindowCreated(window)),
            display.connect('grab-op-begin',
                (d, window, op) => this._onGrabOpBegin(op)),
            display.connect('grab-op-end',
                (d, window, op) => this._onGrabOpEnd(window, op)),
            display.connect('workareas-changed', () => this._queueRelayoutAll()),
            display.connect('window-entered-monitor', () => this._queueRelayoutAll()),
            display.connect('notify::focus-window', () => this._onFocusChanged()),
        ];

        const workspaceManager = global.workspace_manager;
        this._wmSignalIds = [
            workspaceManager.connect('workspace-switched', () => {
                // For a gesture switch this fires when the settle
                // animation completes and GNOME finally activate()s the
                // target -- i.e. the moment the user has really arrived
                // -- so it doubles as the authoritative end of the
                // bar-hiding gesture window opened below.
                this._workspaceGestureActive = false;
                this._queueRelayout(workspaceManager.get_active_workspace());
            }),
            workspaceManager.connect('workspace-removed', (wm, workspace) => {
                this._workspaceModes.delete(workspace);
                this._trees.delete(workspace);
            }),
        ];

        // Hide the tab bars for the whole lifetime of a 3-finger
        // workspace-switch swipe, exactly like the focus border and the
        // indicator's gesture preview already treat this same tracker
        // (this project's one documented private-API surface; identical
        // defensive posture -- optional chaining, typeof guard,
        // try/catch, so a mismatch on another GNOME build only costs
        // this enhancement, never correctness). 'begin' raises a state
        // flag that _syncTabBars() honors -- a plain hide() here proved
        // insufficient in practice, because any relayout flush landing
        // mid-drag would re-show the bar for the still-active origin
        // workspace. The flag drops on 'workspace-switched' (real
        // switch, fires at settle -- above) or, for a cancelled swipe
        // that lands back on the origin and therefore never fires
        // 'workspace-switched' at all (verified: workspaceAnimation.js
        // only calls activate() when the landing workspace isn't
        // already active), on 'end' via the same round(endProgress)
        // mapping GNOME itself resolves the gesture with.
        try {
            this._workspaceAnimation = Main.wm._workspaceAnimation ?? null;
            this._workspaceSwipeTracker =
                this._workspaceAnimation?._swipeTracker ?? null;
        } catch (error) {
            this._workspaceAnimation = null;
            this._workspaceSwipeTracker = null;
        }
        if (typeof this._workspaceSwipeTracker?.connect === 'function') {
            try {
                this._workspaceSwipeSignalIds = [
                    this._workspaceSwipeTracker.connect('begin', () => {
                        this._workspaceGestureActive = true;
                        this._hideTabBars();
                        this._attachSwipeTabBars();
                    }),
                    this._workspaceSwipeTracker.connect('end',
                        (tracker, duration, endProgress) =>
                            this._onWorkspaceGestureEnd(endProgress)),
                ];
            } catch (error) {
                this._workspaceSwipeTracker = null;
                this._workspaceSwipeSignalIds = [];
            }
        } else {
            this._workspaceSwipeTracker = null;
        }

        this._layoutManagerSignalIds = [
            Main.layoutManager.connect('monitors-changed', () => {
                // Monitor indexes reshuffle on topology changes, so bucket
                // trees keyed by them are meaningless afterwards: drop
                // them all and let reconciliation rebuild each bucket in
                // creation order (same posture as the tab bars).
                this._trees.clear();
                this._destroyTabBars();
                this._queueRelayoutAll();
            }),
        ];

        // The tab bar is layout chrome; without this it would float on
        // top of the Activities overview. This hide is effective for
        // BOTH overview entry paths (Super key and 3-finger swipe up)
        // only because the bars are no longer added with
        // trackFullscreen (see _syncTabBars): the gesture path emits
        // 'showing' BEFORE calling layoutManager.showOverview(), whose
        // _updateVisibility() force-reasserts visible=true on every
        // trackFullscreen actor -- which used to overwrite this hide a
        // moment after it ran, but only for the gesture path (the Super
        // path calls showOverview() first and emits 'showing' after).
        this._overviewSignalIds = [
            Main.overview.connect('showing', () => this._hideTabBars()),
            Main.overview.connect('hidden', () =>
                this._queueRelayout(global.workspace_manager.get_active_workspace())),
        ];

        const gsettings = this._settingsManager.gsettings;
        this._settingsSignalIds = [
            gsettings.connect('changed::enable-tiling', () => this._syncEnabled()),
            gsettings.connect('changed::layout-mode', () => this._onGlobalModeChanged()),
            gsettings.connect('changed::tiling-gap-inner', () => this._queueRelayoutAll()),
            gsettings.connect('changed::tiling-gap-outer', () => this._queueRelayoutAll()),
        ];

        // Adopt everything already open (enable-time, shell restart,
        // unlock): identical treatment to newly created windows.
        for (const actor of global.get_window_actors())
            this._trackWindow(actor.meta_window);
        this._queueRelayoutAll();
    }

    disable() {
        if (this._idleId !== null) {
            GLib.Source.remove(this._idleId);
            this._idleId = null;
        }

        for (const id of this._displaySignalIds)
            global.display.disconnect(id);
        for (const id of this._wmSignalIds)
            global.workspace_manager.disconnect(id);
        for (const id of this._layoutManagerSignalIds)
            Main.layoutManager.disconnect(id);
        for (const id of this._overviewSignalIds)
            Main.overview.disconnect(id);
        for (const id of this._settingsSignalIds)
            this._settingsManager.gsettings.disconnect(id);
        this._displaySignalIds = [];
        this._wmSignalIds = [];
        this._layoutManagerSignalIds = [];
        this._overviewSignalIds = [];
        this._settingsSignalIds = [];

        if (this._workspaceSwipeTracker) {
            for (const id of this._workspaceSwipeSignalIds)
                this._workspaceSwipeTracker.disconnect(id);
        }
        this._workspaceSwipeTracker = null;
        this._workspaceSwipeSignalIds = [];
        this._workspaceGestureActive = false;
        // Destroy any tab bars still riding a mid-flight swipe animation
        // (their owning groups would normally reap them at settle).
        this._detachSwipeTabBars();
        this._workspaceAnimation = null;

        this._targets.clear();
        this._guardState.clear();
        this._activeGrabOp = null;

        for (const [window, ids] of this._windowSignals) {
            for (const id of ids)
                window.disconnect(id);
        }
        this._windowSignals.clear();
        this._windowWorkspaces.clear();
        this._trees.clear();
        this._insertionAnchors.clear();

        this._destroyTabBars();
        this._pendingWorkspaces.clear();
        this._pendingAll = false;

        // Deliberately NOT clearing _workspaceModes or _floatingWindows:
        // both are module-scoped state (see the top of this file) that
        // must outlive this instance, specifically to survive the
        // disable()/enable() cycle GNOME performs around screen lock.
        // _workspaceModes only loses entries via the 'workspace-removed'
        // handler above and a global-mode change; _floatingWindows only
        // via _untrackWindow pruning an unmanaged window; both reset
        // wholesale only on a genuine session restart (a fresh module
        // load).
        //
        // Windows keep their last tiled geometry -- ordinary, freely
        // movable windows; there is no prior "untiled" geometry to
        // restore because tiling repositions windows continuously from
        // the moment they map (same posture as every tiling WM).
    }

    /**
     * The three layout modes are one per-workspace choice on top of one
     * global default. `setWorkspaceMode` puts the active workspace into
     * `mode` (an override on top of the global setting; setting it to
     * the global mode simply drops the override). `toggleWorkspaceMode`
     * is what the three Shift+Super+T/S/V keys call: it sets the mode,
     * unless the workspace is already in that mode, in which case it
     * returns the workspace to the global default -- so with the default
     * layout tiled, Shift+Super+S toggles stacking on and off exactly as
     * it always has, and with the default stacked, Shift+Super+T is the
     * "tile just this one" escape and pressing it again re-stacks.
     *
     * Any mode change is an explicit "re-lay-out now" gesture: leaving
     * floating or entering a layout releases maximized windows on the
     * workspace so the layout lands on the real window set (TRUE
     * fullscreen is left alone); entering floating instead forgets the
     * workspace's tile targets so the tile guard has nothing to correct.
     * The bucket trees persist through every mode -- reconciliation runs
     * in all three -- so returning to tiled restores the arrangement the
     * workspace had, including windows opened meanwhile, which took their
     * focus-anchored place in the tree even when the geometry didn't
     * show it.
     *
     * @param {string} mode one of layoutEngine.LayoutMode
     * @param {?Meta.Workspace} [workspace] defaults to the active one
     */
    setWorkspaceMode(mode, workspace = null) {
        if (!this._enabled || !Object.values(LayoutMode).includes(mode))
            return;
        const target = workspace ?? global.workspace_manager.get_active_workspace();
        this._applyModeChange(target, mode);
    }

    /**
     * @param {string} mode one of layoutEngine.LayoutMode
     */
    toggleWorkspaceMode(mode) {
        if (!this._enabled)
            return;
        const workspace = global.workspace_manager.get_active_workspace();
        const current = this._modeOf(workspace);
        const next = current === mode ? this._settingsManager.layoutMode : mode;
        this._applyModeChange(workspace, next);
    }

    _applyModeChange(workspace, mode) {
        const previous = this._modeOf(workspace);
        if (mode === this._settingsManager.layoutMode)
            this._workspaceModes.delete(workspace);
        else
            this._workspaceModes.set(workspace, mode);
        if (mode === previous)
            return;
        this._enterMode(workspace, mode);
        this._queueRelayout(workspace);
    }

    // The side effects of a workspace arriving in `mode` (see
    // setWorkspaceMode). Relayout is the caller's job.
    _enterMode(workspace, mode) {
        if (mode === LayoutMode.FLOATING)
            this._forgetTargets(workspace);
        else
            this._exitMaximized(workspace, null);
    }

    // The global `layout-mode` setting changed (Preferences, the quick
    // menu, the launcher): every workspace follows it from now on --
    // per-workspace overrides are dropped, not kept -- and every open
    // window is laid out accordingly.
    _onGlobalModeChanged() {
        const mode = this._settingsManager.layoutMode;
        const workspaceManager = global.workspace_manager;
        const previous = new Map();
        for (let i = 0; i < workspaceManager.n_workspaces; i++) {
            const workspace = workspaceManager.get_workspace_by_index(i);
            previous.set(workspace, this._modeOf(workspace));
        }
        this._workspaceModes.clear();
        if (!this._enabled)
            return;
        for (const [workspace, was] of previous) {
            if (was !== mode)
                this._enterMode(workspace, mode);
        }
        this._queueRelayoutAll();
    }

    /**
     * Toggle the focused window between tiled and floating -- Hyprland's
     * per-window `togglefloating`, deliberately NOT a per-workspace mode
     * like stacked. Floating is a membership change, not a transient
     * tileable state: a floated window leaves the layout tree entirely
     * (windowFilter.isLayoutMember consults _floatingWindows), so its
     * siblings reclaim its area, and it rejoins the layout when toggled
     * back. Only windows that could tile in the first place can be
     * toggled -- a dialog/utility/sticky window already floats by
     * identity and has nothing to switch.
     */
    toggleFloating(target = null) {
        if (!this._enabled)
            return;

        const window = this._focusedToplevel(target);
        // Identity-only check (no floating set passed): "is this the kind
        // of window that participates in the layout at all", regardless
        // of whether it currently floats by user choice.
        if (!window || !isLayoutMember(window))
            return;

        const workspace = window.get_workspace();
        // On a floating-layout workspace every window already floats and
        // nothing is laid out, so there is no membership to toggle: the
        // per-window flag is left as it is (it matters again once the
        // workspace returns to a layout).
        if (this._isFloating(workspace))
            return;

        if (this._floatingWindows.has(window)) {
            // Re-tile: reconciliation re-inserts it (at the dwindle tail,
            // since its old anchor was long since consumed) on the pass
            // queued below.
            this._floatingWindows.delete(window);
        } else {
            this._floatingWindows.add(window);
            this._floatWindow(window);
        }

        // Relayout the affected bucket(s): drop/insert the window's leaf
        // and reflow its siblings. A null workspace (a sticky/secondary-
        // monitor window under workspaces-only-on-primary) reflows all.
        this._queueRelayout(workspace);
    }

    /**
     * @param {?Meta.Workspace} [workspace] defaults to the active one
     * @returns {string} the workspace's LayoutMode
     */
    layoutModeOf(workspace = null) {
        return this._modeOf(workspace ?? global.workspace_manager.get_active_workspace());
    }

    /**
     * Move keyboard focus to the window in `direction` from the focused
     * one -- Hyprland's `movefocus`. Purely spatial, on the windows'
     * real frame rectangles, so it works in every layout mode and with
     * tiling off entirely: tiles, floating windows and other monitors
     * (rectangles are absolute) are all candidates. The one non-spatial
     * case is a stacked workspace, where Left/Right step through the
     * tabs in tab order, since every stacked window shares one
     * rectangle; past either end, and for Up/Down, the spatial search
     * takes over (reaching a floating window or another monitor).
     *
     * @param {string} direction one of layoutEngine.Direction
     */
    focusDirection(direction) {
        const focus = this._focusedToplevel();
        if (!focus)
            return;

        const workspace = focus.get_workspace() ??
            global.workspace_manager.get_active_workspace();
        let next = null;

        if (this._enabled && this._isStacked(workspace) &&
            (direction === Direction.LEFT || direction === Direction.RIGHT)) {
            const bucket = this._bucketOf(focus);
            if (bucket.workspace === workspace) {
                const tabs = this._reconcileTree(workspace, bucket.monitorIndex).keys()
                    .filter(w => isTileable(w, this._floatingWindows));
                const index = tabs.indexOf(focus);
                if (index >= 0)
                    next = tabs[direction === Direction.LEFT ? index - 1 : index + 1] ?? null;
            }
        }

        if (!next)
            next = findNeighbor(this._frameRects(workspace, focus), focus, direction);
        if (next)
            Main.activateWindow(next);
    }

    /**
     * Move the focused window one step in `direction` within its layout
     * -- Hyprland's `movewindow`. In a tiled bucket the window swaps
     * tiles with its spatial neighbour in that direction (the neighbour
     * found on the tree's own rectangles, so only tiles of the same
     * bucket qualify); in a stacked bucket Left/Up and Right/Down move
     * its tab one place along the tab row. A floating-layout workspace,
     * a floating window and a window with nothing in that direction are
     * clean no-ops. The window keeps focus, so repeated presses walk it
     * across the layout.
     *
     * @param {string} direction one of layoutEngine.Direction
     */
    swapDirection(direction) {
        if (!this._enabled)
            return;

        const focus = this._focusedToplevel();
        if (!focus || !isTileable(focus, this._floatingWindows))
            return;

        const {workspace, monitorIndex} = this._bucketOf(focus);
        if (this._isFloating(workspace))
            return;

        const tree = this._reconcileTree(workspace, monitorIndex);
        if (!tree.has(focus))
            return;
        const visible = tree.keys().filter(w => isTileable(w, this._floatingWindows));

        let other = null;
        if (this._isStacked(workspace)) {
            const index = visible.indexOf(focus);
            const backward = direction === Direction.LEFT || direction === Direction.UP;
            other = visible[backward ? index - 1 : index + 1] ?? null;
        } else {
            const workArea = (workspace ?? global.workspace_manager.get_active_workspace())
                .get_work_area_for_monitor(monitorIndex);
            const rects = tree.computeRects(workArea, this._gaps(), new Set(visible));
            other = findNeighbor(rects, focus, direction);
        }

        if (other === null || !tree.swap(focus, other))
            return;
        this._queueRelayout(workspace);
    }

    // Pop a window out to a centered floating rectangle and raise it.
    // Un-maximizes first (a maximized window ignores move_resize_frame),
    // then sizes to the configured percentage of its monitor work area,
    // centered. The tiler never touches it again while it floats (it is
    // not a member); the user owns its geometry from here, and every
    // relayout pass just keeps it stacked above the tiled windows
    // (_raiseFloating).
    _floatWindow(window) {
        if (window.maximized_horizontally || window.maximized_vertically)
            window.unmaximize(Meta.MaximizeFlags.BOTH);

        const monitorIndex = window.get_monitor();
        const workspace = window.get_workspace() ??
            global.workspace_manager.get_active_workspace();
        const workArea = workspace.get_work_area_for_monitor(monitorIndex);

        const pct = Math.max(30, Math.min(95,
            this._settingsManager.floatingWindowSize)) / 100;
        const width = Math.max(1, Math.round(workArea.width * pct));
        const height = Math.max(1, Math.round(workArea.height * pct));
        const x = workArea.x + Math.round((workArea.width - width) / 2);
        const y = workArea.y + Math.round((workArea.height - height) / 2);

        window.move_resize_frame(false, x, y, width, height);
        window.raise();
    }

    // Keep this bucket's user-floated windows stacked above its tiled
    // ones, Hyprland-style (floating windows live above the tiling layer).
    // Called at the end of every tiled/stacked application pass; raise()
    // only restacks, it never steals focus. Minimized floaters are left
    // alone (nothing to raise).
    _raiseFloating(workspace, monitorIndex) {
        if (this._floatingWindows.size === 0)
            return;
        const source = workspace
            ? workspace.list_windows()
            : global.get_window_actors().map(actor => actor.meta_window);
        for (const window of source) {
            if (window.get_monitor() === monitorIndex &&
                this._floatingWindows.has(window) && !window.minimized)
                window.raise();
        }
    }

    _syncEnabled() {
        this._enabled = this._settingsManager.enableTiling;
        if (this._enabled)
            this._queueRelayoutAll();
        else
            this._hideTabBars();
    }

    // Idempotent and cheap; the next _syncTabBars() pass (queued by
    // whichever authoritative signal follows) decides whether to show
    // the bars again. Only effective because the bars are NOT
    // trackFullscreen chrome -- see _syncTabBars.
    _hideTabBars() {
        for (const bar of this._tabBars.values())
            bar.hide();
    }

    // Make the stacked tab bar slide with its workspace during a 3-finger
    // switch, instead of blinking out at gesture begin. GNOME's
    // workspaceAnimation.js builds, per switch, one MonitorGroup per
    // monitor holding one WorkspaceGroup per workspace; each WorkspaceGroup
    // clones that workspace's window ACTORS and the whole thing slides on a
    // `progress` property. A chrome actor is not a window actor, so it is
    // never cloned in -- which is why the real bars are hidden for the
    // gesture's duration (the _workspaceGestureActive flag). Here we mirror
    // exactly what GNOME does for windows: drop a throwaway StackTabBar
    // into each stacked workspace's WorkspaceGroup, positioned monitor-
    // locally like the window clones, so it rides the same slide -- the
    // outgoing workspace's bar slides out, the incoming one's slides in.
    //
    // This is the project's one private-API surface (the swipe tracker,
    // GNOME_NOTES.md) extended by two more private reaches -- switchData
    // .monitors and MonitorGroup._workspaceGroups -- so it carries the
    // same defensive posture: everything optional-chained inside one
    // try/catch, and on ANY failure we simply fall back to the real bars
    // staying hidden for the gesture (today's behavior), never a broken
    // state. The throwaway bars are owned by the animation groups: GNOME
    // destroys those groups when the switch settles or cancels
    // (_finishWorkspaceSwitch), taking our bars with them, and each bar
    // drops itself from _swipeTabBars on 'destroy' so the list self-cleans.
    _attachSwipeTabBars() {
        this._detachSwipeTabBars();
        if (!this._enabled)
            return;
        try {
            const switchData = this._workspaceAnimation?._switchData;
            const monitorGroups = switchData?.monitors;
            if (!monitorGroups)
                return;

            const gaps = this._gaps();
            const primary = Main.layoutManager.primaryIndex;
            const primaryOnly = Meta.prefs_get_workspaces_only_on_primary();
            const focus = this._focusedToplevel();

            for (const monitorGroup of monitorGroups) {
                const monitorIndex = monitorGroup?.index;
                const wsGroups = monitorGroup?._workspaceGroups;
                const geom = Main.layoutManager.monitors[monitorIndex];
                if (monitorIndex === undefined || !wsGroups || !geom)
                    continue;

                // Same stackability rule as _syncTabBars: secondary
                // monitors under workspaces-only-on-primary never stack.
                if (primaryOnly && monitorIndex !== primary)
                    continue;

                for (const wsGroup of wsGroups) {
                    const workspace = wsGroup?.workspace;
                    if (!workspace || !this._isStacked(workspace))
                        continue;
                    if (this._bucketHasExclusiveWindow(workspace, monitorIndex))
                        continue;

                    const windows = this._reconcileTree(workspace, monitorIndex)
                        .keys().filter(w => isTileable(w, this._floatingWindows));
                    if (windows.length === 0)
                        continue;

                    const workArea =
                        workspace.get_work_area_for_monitor(monitorIndex);
                    const {barRect} = computeStackGeometry(workArea, gaps);

                    const bar = new StackTabBar();
                    bar.setWindows(windows);
                    bar.setActiveWindow(focus);
                    // WorkspaceGroup children live in monitor-local coords
                    // (the window clones use windowActor.x - monitor.x); the
                    // group itself carries the per-workspace slide offset.
                    bar.set_position(barRect.x - geom.x, barRect.y - geom.y);
                    bar.set_size(barRect.width, barRect.height);
                    wsGroup.add_child(bar);
                    wsGroup.set_child_above_sibling(bar, null);

                    bar.connect('destroy', () => {
                        const i = this._swipeTabBars.indexOf(bar);
                        if (i >= 0)
                            this._swipeTabBars.splice(i, 1);
                    });
                    this._swipeTabBars.push(bar);
                }
            }
        } catch (error) {
            // Private-API shape changed on this GNOME build: abandon the
            // slide enhancement (real bars stay hidden for the gesture).
            this._detachSwipeTabBars();
        }
    }

    _detachSwipeTabBars() {
        // Copy first: destroy() fires 'destroy', which splices the list.
        for (const bar of [...this._swipeTabBars])
            bar.destroy();
        this._swipeTabBars = [];
    }

    // Fingers lifted mid-gesture. If GNOME's own landing resolution --
    // findClosestWorkspace(endProgress), i.e. round() clamped to the
    // strip (the exact mapping lib/gestureProgressTracker.js mirrors,
    // verified against extracted js/ui/workspaceAnimation.js) -- says
    // the gesture settles back on the already-active workspace, then it
    // was a cancel and 'workspace-switched' will never fire: end the
    // bar-hiding window here so the origin's bar returns once the
    // snap-back settles. For a real switch, keep hiding; the
    // 'workspace-switched' at settle-completion re-shows (and also
    // heals this flag if the prediction was ever wrong, since every
    // real switch fires it).
    _onWorkspaceGestureEnd(endProgress) {
        if (!this._workspaceGestureActive)
            return;

        const workspaceManager = global.workspace_manager;
        const landing = Math.max(0, Math.min(workspaceManager.n_workspaces - 1,
            Math.round(endProgress)));
        if (landing === workspaceManager.get_active_workspace_index()) {
            this._workspaceGestureActive = false;
            this._queueRelayout(workspaceManager.get_active_workspace());
        }
    }

    _onWindowCreated(window) {
        this._trackWindow(window);

        // Record the insertion anchor NOW, synchronously: the window
        // will split the tile of whatever toplevel is focused at this
        // instant, mirroring Hyprland's insert-into-focused-container.
        // Waiting until the debounced layout pass would be too late --
        // the new window itself usually holds focus by then.
        const anchor = this._focusedToplevel();
        if (anchor && anchor !== window)
            this._insertionAnchors.set(window, anchor);

        // Windows already maximized at creation (X11 apps that map
        // maximized) are un-maximized so they join the layout instead of
        // floating forever. Windows that maximize themselves shortly
        // AFTER creation -- the far more common case on Wayland -- are
        // caught by the grace-period check in _trackWindow's
        // notify::maximized handler.
        this._maybeUndoMapMaximize(window);

        // A newly opened real app window un-maximizes any maximized window
        // already on its workspace, so it joins a normal layout instead of
        // mapping hidden behind it. Guarded to genuine top-level app
        // windows -- a dialog, popup or transient must never do this -- and
        // it never touches the new window's own state (it is the exception,
        // and a map-maximize was already undone just above). Type/transient
        // can still be settling at window-created for some clients; a miss
        // here is benign (the maximized window just stays) and never a
        // wrong break. TRUE fullscreen is intentionally left alone.
        if (this._opensAsTilingApp(window))
            this._exitMaximized(window.get_workspace(), window);

        this._queueRelayout(window.get_workspace());
    }

    /**
     * The tile guard: a tiled window that changes its own geometry is put
     * back on its tile, whenever that happens.
     *
     * Freshly mapped windows -- Chromium/Electron/GTK apps especially --
     * finalize their size and position across several async configures
     * AFTER window-created and shown: client-side-decoration extents
     * arriving, an opens-maximized state being undone, a multi-step
     * Wayland configure, and above all a browser restoring its remembered
     * window bounds once its session has loaded. The visible symptom is a
     * tiled window whose right and bottom outer gaps vanish while the
     * left and top look doubled, stuck until some unrelated relayout.
     *
     * An earlier fix watched a window for a fixed 2.5 s after creation.
     * That is exactly what failed for the first browser opened after a
     * cold boot: with the disk busy and a dozen tabs to restore, the
     * browser's own resize can land well after any fixed grace, and once
     * the watch was gone nobody corrected it. So there is no grace period
     * any more. Every tracked window is watched for as long as it lives;
     * the watch is cheap (a rect comparison against the tile recorded by
     * _moveResize, no layout pass unless the window is actually off it),
     * and it is safe:
     *
     *  - it never fights the user: an interactive move or resize is a
     *    grab op, during which the guard stays silent and grab-op-end
     *    snaps the window back exactly as before;
     *  - it never touches a window that is not a tiled member at that
     *    moment (floating, minimized, user-maximized, fullscreen);
     *  - it cannot loop: _moveResize only acts on a window off its tile,
     *    so the ack of a correction is a no-op, and a client that refuses
     *    its tile outright runs into the correction budget and is left
     *    alone for a while rather than argued with.
     */
    _onGeometryChanged(window) {
        if (!this._enabled)
            return;
        const target = this._targets.get(window);
        if (!target)
            return;

        // A floating-layout workspace is GNOME's: a window there may
        // hold a stale target from before the mode switch (or from the
        // workspace it was moved in from) and must never be corrected.
        if (this._isFloating(window.get_workspace()))
            return;

        let grabOp = Meta.GrabOp.NONE;
        try {
            grabOp = global.display.get_grab_op();
        } catch (error) {
            // get_grab_op unavailable on this build: don't guard.
        }
        if (grabOp !== Meta.GrabOp.NONE)
            return;

        if (!isLayoutMember(window, this._floatingWindows) ||
            !isTileable(window, this._floatingWindows))
            return;

        const frame = window.get_frame_rect();
        if (frame.x === target.x && frame.y === target.y &&
            frame.width === target.width && frame.height === target.height)
            return;

        if (!this._chargeGuardBudget(window))
            return;
        this._queueRelayout(window.get_workspace());
    }

    _onGrabOpBegin(op) {
        this._activeGrabOp = op ?? null;
    }

    /**
     * An interactive move or resize just ended. Before the relayout that
     * has always followed (and that used to be the whole story: the
     * window snapped back to its tile), read the user's intent off the
     * drag: a tiled window dropped onto another tile swaps places with
     * it (_swapAfterDrag), and a tiled window whose edge was dragged
     * keeps that edge -- the split boundary it sits on takes the new
     * ratio (_resizeAfterDrag). Both only touch the tree; the queued
     * relayout is what applies the result, and for a drag that meant
     * neither (dropped over nothing, an edge on the screen border) it
     * snaps the window back exactly as before. The op comes with the
     * signal on current Mutter; the value recorded at grab-op-begin is
     * the fallback.
     */
    _onGrabOpEnd(window, op) {
        const grabOp = op ?? this._activeGrabOp ?? Meta.GrabOp.NONE;
        this._activeGrabOp = null;

        if (window && this._enabled) {
            if (MOVE_GRAB_OPS.has(grabOp))
                this._swapAfterDrag(window, grabOp);
            else if (RESIZE_GRAB_OPS.has(grabOp))
                this._resizeAfterDrag(window);
        }
        this._queueRelayout(window?.get_workspace() ?? null);
    }

    // Drag-to-swap: the tile under the drop point -- the pointer for a
    // mouse drag, the window's own centre for a keyboard move (Alt+F7)
    // -- takes the dragged window's slot and vice versa. Only within the
    // bucket the window was already laid out in (a window dragged onto
    // another monitor simply joins that bucket at the tail through
    // ordinary reconciliation, as before), and only in the tiled layout:
    // stacked windows all share one rectangle and a floating workspace
    // is not laid out at all.
    _swapAfterDrag(window, grabOp) {
        if (!isTileable(window, this._floatingWindows))
            return;
        const {workspace, monitorIndex} = this._bucketOf(window);
        if (this._effectiveModeOf(workspace) !== LayoutMode.TILED)
            return;
        const tree = this._trees.get(workspace)?.get(monitorIndex);
        if (!tree?.has(window))
            return;

        let x, y;
        if (grabOp === Meta.GrabOp.KEYBOARD_MOVING) {
            const frame = window.get_frame_rect();
            x = frame.x + frame.width / 2;
            y = frame.y + frame.height / 2;
        } else {
            [x, y] = global.get_pointer();
        }

        for (const other of tree.keys()) {
            if (other === window || !isTileable(other, this._floatingWindows))
                continue;
            const tile = this._targets.get(other);
            if (tile && x >= tile.x && x < tile.x + tile.width &&
                y >= tile.y && y < tile.y + tile.height) {
                tree.swap(window, other);
                return;
            }
        }
    }

    // Drag-to-resize: the edges the user moved (frame vs the tile last
    // applied) become new split ratios on the tree (LayoutTree
    // .resizeLeaf); the relayout then lays every affected tile out to
    // match. Same layout/bucket conditions as _swapAfterDrag.
    _resizeAfterDrag(window) {
        if (!isTileable(window, this._floatingWindows))
            return;
        const target = this._targets.get(window);
        if (!target)
            return;
        const {workspace, monitorIndex} = this._bucketOf(window);
        if (this._effectiveModeOf(workspace) !== LayoutMode.TILED)
            return;
        const tree = this._trees.get(workspace)?.get(monitorIndex);
        if (!tree?.has(window))
            return;

        const frame = window.get_frame_rect();
        tree.resizeLeaf(window,
            {x: frame.x, y: frame.y, width: frame.width, height: frame.height},
            target, this._gaps().inner);
    }

    // The bucket a window belongs to: (its workspace, its monitor), or
    // (null, its monitor) on a secondary monitor under
    // workspaces-only-on-primary -- the same rule _flush applies.
    _bucketOf(window) {
        const monitorIndex = window.get_monitor();
        const primaryOnly = Meta.prefs_get_workspaces_only_on_primary();
        const workspace = primaryOnly && monitorIndex !== Main.layoutManager.primaryIndex
            ? null : window.get_workspace();
        return {workspace, monitorIndex};
    }

    // The frame rectangles of every window a directional focus move may
    // land on from `focus`, on `workspace` (which, under
    // workspaces-only-on-primary, includes the secondary monitors'
    // sticky windows): real app windows that are not minimized, whether
    // tiled, user-floated, maximized or fullscreen. The origin is always
    // included so the search has somewhere to start from even when it is
    // a window the layout ignores.
    _frameRects(workspace, focus) {
        const rects = new Map();
        for (const window of workspace.list_windows()) {
            if (window !== focus && (!isLayoutMember(window) || window.minimized))
                continue;
            const frame = window.get_frame_rect();
            rects.set(window, {x: frame.x, y: frame.y, width: frame.width, height: frame.height});
        }
        if (!rects.has(focus)) {
            const frame = focus.get_frame_rect();
            rects.set(focus, {x: frame.x, y: frame.y, width: frame.width, height: frame.height});
        }
        return rects;
    }

    // Drop the remembered tiles (and guard budgets) of a workspace's
    // windows: on entering the floating layout there is no tile for the
    // guard to put them back on.
    _forgetTargets(workspace) {
        for (const window of workspace.list_windows()) {
            this._targets.delete(window);
            this._guardState.delete(window);
        }
    }

    // The correction budget: TILE_GUARD_BUDGET corrections per
    // TILE_GUARD_WINDOW_US, then TILE_GUARD_BACKOFF_US of silence.
    _chargeGuardBudget(window) {
        const now = GLib.get_monotonic_time();
        let state = this._guardState.get(window);
        if (!state) {
            state = {count: 0, since: now, backoffUntil: 0};
            this._guardState.set(window, state);
        }
        if (now < state.backoffUntil)
            return false;
        if (now - state.since > TILE_GUARD_WINDOW_US) {
            state.count = 0;
            state.since = now;
        }
        state.count++;
        if (state.count > TILE_GUARD_BUDGET) {
            state.backoffUntil = now + TILE_GUARD_BACKOFF_US;
            state.count = 0;
            state.since = now;
            return false;
        }
        return true;
    }

    // Whether a just-created window is the kind that, on opening, should
    // pull the workspace out of a maximize. Same identity gate as
    // _maybeUndoMapMaximize: a real, taskbar-worthy top-level app window,
    // never a dialog/transient/popup.
    _opensAsTilingApp(window) {
        // Identity-only membership (no floating set): the same gate the
        // layout uses, so a helper surface (wl-copy's momentary focus
        // window) can no more un-maximize a neighbour than it can tile.
        return this._enabled && isLayoutMember(window);
    }

    // Undo an app-restored "open maximized" state so the window tiles.
    // Only for windows that would otherwise be tileable -- dialogs,
    // transients and the like are never touched.
    // Never on a floating-layout workspace: there an app that opens
    // maximized stays maximized, as it would on stock GNOME.
    _maybeUndoMapMaximize(window) {
        if (this._isFloating(window.get_workspace()))
            return;
        if (this._enabled && isLayoutMember(window) &&
            window.maximized_horizontally && window.maximized_vertically)
            window.unmaximize(Meta.MaximizeFlags.BOTH);
    }

    _trackWindow(window) {
        if (this._windowSignals.has(window))
            return;

        this._windowWorkspaces.set(window, window.get_workspace());

        const adoptedAt = GLib.get_monotonic_time();
        const relayoutOwn = () => this._queueRelayout(window.get_workspace());
        const onMaximizedChanged = () => {
            // Within the grace period a maximize is the app restoring its
            // remembered map state, not a user action: undo it so the
            // window tiles (the resulting unmaximize notify triggers the
            // actual relayout). Afterwards, maximize means the user wants
            // the window floating full-size and is respected.
            if (window.maximized_horizontally && window.maximized_vertically &&
                GLib.get_monotonic_time() - adoptedAt < MAP_MAXIMIZE_GRACE_US) {
                this._maybeUndoMapMaximize(window);
                return;
            }
            relayoutOwn();
        };

        this._windowSignals.set(window, [
            window.connect('unmanaged', () => {
                this._untrackWindow(window);
                this._queueRelayoutAll();
            }),
            window.connect('workspace-changed', () => {
                // Both sides of a move retile: the remembered source
                // workspace and the new one.
                const previous = this._windowWorkspaces.get(window);
                const current = window.get_workspace();
                this._windowWorkspaces.set(window, current);
                this._queueRelayout(previous);
                this._queueRelayout(current);
            }),
            // First real map: some apps only reach their final
            // type/size/transient state here, after window-created.
            window.connect('shown', relayoutOwn),
            window.connect('notify::minimized', relayoutOwn),
            window.connect('notify::fullscreen', relayoutOwn),
            window.connect('notify::maximized-horizontally', onMaximizedChanged),
            window.connect('notify::maximized-vertically', onMaximizedChanged),
            // The tile guard (see _onGeometryChanged). position-changed
            // exists on Meta.Window in current GNOME; size-changed alone
            // would still catch every case that matters if it ever went.
            window.connect('size-changed', () => this._onGeometryChanged(window)),
            window.connect('position-changed', () => this._onGeometryChanged(window)),
        ]);
    }

    _untrackWindow(window) {
        const ids = this._windowSignals.get(window);
        if (!ids)
            return;
        for (const id of ids)
            window.disconnect(id);
        this._windowSignals.delete(window);
        this._windowWorkspaces.delete(window);
        this._targets.delete(window);
        this._guardState.delete(window);

        // Purge the window from layout state eagerly rather than waiting
        // for the next reconciliation, so no tree or anchor entry ever
        // outlives its Meta.Window -- both as leaf and as someone else's
        // recorded anchor.
        for (const monitorTrees of this._trees.values()) {
            for (const tree of monitorTrees.values())
                tree.remove(window);
        }
        this._insertionAnchors.delete(window);
        for (const [pending, anchor] of this._insertionAnchors) {
            if (anchor === window)
                this._insertionAnchors.delete(pending);
        }

        // Drop any user-float choice for this window now that it is gone,
        // so the module-scoped set never holds a dead Meta.Window (the
        // one way an entry leaves the set short of a session restart).
        this._floatingWindows.delete(window);
    }

    _onFocusChanged() {
        // Cheap path: only the tab highlight (and stacked raise) update;
        // no geometry recomputation on plain focus changes.
        const focus = this._focusedToplevel();
        // A clipboard helper's momentary focus surface (see
        // windowFilter.isHelperSurface): leave the active tab highlight
        // where it is rather than clearing it and restoring it a few
        // milliseconds later -- the same blink the focus border avoids.
        if (focus && isHelperSurface(focus))
            return;
        for (const bar of this._tabBars.values())
            bar.setActiveWindow(focus);

        const active = global.workspace_manager.get_active_workspace();
        if (focus && this._enabled && this._isStacked(active) &&
            isTileable(focus, this._floatingWindows) &&
            focus.get_workspace() === active)
            focus.raise();
    }

    // An explicit `candidate` overrides live focus: the launcher runs its
    // actions from under a modal grab, so it captures the window that was
    // focused when it opened and passes it here rather than letting the
    // action depend on when Mutter restores focus. A candidate whose
    // actor is already gone falls back to live focus.
    _focusedToplevel(candidate = null) {
        const focus = candidate?.get_compositor_private()
            ? candidate
            : global.display.focus_window;
        if (!focus)
            return null;
        return focus.find_root_ancestor?.() ?? focus;
    }

    _queueRelayout(workspace) {
        if (workspace)
            this._pendingWorkspaces.add(workspace);
        else
            this._pendingAll = true;
        this._ensureFlushScheduled();
    }

    _queueRelayoutAll() {
        this._pendingAll = true;
        this._ensureFlushScheduled();
    }

    _ensureFlushScheduled() {
        if (this._idleId !== null || !this._enabled)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = null;
            this._flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flush() {
        if (!this._enabled)
            return;

        const workspaceManager = global.workspace_manager;
        let workspaces;
        if (this._pendingAll) {
            workspaces = [];
            for (let i = 0; i < workspaceManager.n_workspaces; i++)
                workspaces.push(workspaceManager.get_workspace_by_index(i));
        } else {
            // A pended workspace may have been removed (dynamic
            // workspaces) between queue and flush; drop dead references.
            workspaces = [...this._pendingWorkspaces].filter(ws =>
                workspaceManager.get_workspace_by_index(ws.index()) === ws);
        }
        this._pendingAll = false;
        this._pendingWorkspaces.clear();

        const gaps = this._gaps();
        const primary = Main.layoutManager.primaryIndex;
        const primaryOnly = Meta.prefs_get_workspaces_only_on_primary();

        for (const monitor of Main.layoutManager.monitors) {
            if (primaryOnly && monitor.index !== primary) {
                // Workspace-agnostic secondary-monitor bucket.
                this._applyBucket(null, monitor.index, gaps);
            } else {
                for (const workspace of workspaces)
                    this._applyBucket(workspace, monitor.index, gaps);
            }
        }

        this._syncTabBars(gaps);
    }

    _gaps() {
        return {
            inner: this._settingsManager.tilingGapInner,
            outer: this._settingsManager.tilingGapOuter,
        };
    }

    // How many layout-member windows the workspace has across its
    // stackable buckets (the primary monitor under
    // workspaces-only-on-primary, every monitor otherwise) -- the input
    // to _effectiveModeOf's "stacked needs two" rule. Counts *members*,
    // not currently-tileable windows, deliberately (see there). A null
    // workspace has no stackable bucket.
    _stackableMemberCount(workspace) {
        if (!workspace)
            return 0;
        const primary = Main.layoutManager.primaryIndex;
        const primaryOnly = Meta.prefs_get_workspaces_only_on_primary();
        let count = 0;
        for (const monitor of Main.layoutManager.monitors) {
            if (primaryOnly && monitor.index !== primary)
                continue;
            count += this._bucketMembers(workspace, monitor.index).length;
        }
        return count;
    }

    // All layout-member windows of a bucket, in creation order (the
    // deterministic insertion order for windows with no focus anchor:
    // enable-time adoption, workspace merges).
    _bucketMembers(workspace, monitorIndex) {
        const source = workspace
            ? workspace.list_windows()
            : global.get_window_actors().map(actor => actor.meta_window);
        return source
            .filter(window => window.get_monitor() === monitorIndex &&
                isLayoutMember(window, this._floatingWindows))
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    }

    // Sync the bucket's layout tree against ground truth and return it:
    // prune leaves whose window left the bucket (closed, moved
    // workspace/monitor, changed identity), insert windows that arrived
    // -- each at its recorded focus anchor when that anchor is a leaf of
    // this same tree, else at the dwindle-spiral tail. Idempotent and
    // cheap when nothing changed, so callers reconcile-on-read.
    _reconcileTree(workspace, monitorIndex) {
        let monitorTrees = this._trees.get(workspace);
        if (!monitorTrees) {
            monitorTrees = new Map();
            this._trees.set(workspace, monitorTrees);
        }
        let tree = monitorTrees.get(monitorIndex);
        if (!tree) {
            tree = new LayoutTree();
            monitorTrees.set(monitorIndex, tree);
        }

        const members = this._bucketMembers(workspace, monitorIndex);
        const memberSet = new Set(members);
        for (const window of tree.keys()) {
            if (!memberSet.has(window))
                tree.remove(window);
        }
        for (const window of members) {
            if (tree.has(window))
                continue;
            // Consumed on first insertion wherever it lands: the window
            // has found its home; later bucket moves are ordinary
            // tail insertions.
            const anchor = this._insertionAnchors.get(window);
            this._insertionAnchors.delete(window);
            tree.insert(window, tree.has(anchor) ? anchor : null);
        }
        return tree;
    }

    // True while any window on this bucket exclusively occupies it --
    // fullscreen, or a maximized real app window whether tiled OR
    // user-floated (see isExclusiveOccupant). Tiling for the bucket is
    // suspended entirely (never resize such a window, never reflow
    // beneath it -- it already covers its siblings) and the stacked tab
    // bar hides; both resume on the notify::fullscreen /
    // notify::maximized-* relayout when the state ends.
    _bucketHasExclusiveWindow(workspace, monitorIndex) {
        const source = workspace
            ? workspace.list_windows()
            : global.get_window_actors().map(actor => actor.meta_window);
        return source.some(window =>
            window.get_monitor() === monitorIndex &&
            isExclusiveOccupant(window));
    }

    // Un-maximize every user-maximized member on a workspace, so those
    // windows fall back into the tiled/stacked layout. Used when an
    // explicit user action -- opening a new app, toggling stacked mode --
    // should take priority over a maximize one of them is in. TRUE
    // fullscreen is deliberately NOT touched here (a fullscreen video must
    // not be yanked out by an unrelated app opening or a mode toggle); it
    // still suspends the bucket and hides the tab bar via
    // _bucketHasExclusiveWindow, it just isn't force-exited. Purely a
    // request to Mutter: the resulting notify::maximized-* on each
    // affected window drives the relayout, so this lays out nothing here.
    // A floating-layout workspace is left alone: a maximize there is the
    // user's (or the app's) and nothing is being laid out under it.
    _exitMaximized(workspace, exceptWindow) {
        if (!workspace || this._isFloating(workspace))
            return;
        for (const window of workspace.list_windows()) {
            if (window === exceptWindow)
                continue;
            if (isLayoutMember(window, this._floatingWindows) && isMaximized(window))
                window.unmaximize(Meta.MaximizeFlags.BOTH);
        }
    }

    _applyBucket(workspace, monitorIndex, gaps) {
        if (this._bucketHasExclusiveWindow(workspace, monitorIndex))
            return;

        const tree = this._reconcileTree(workspace, monitorIndex);
        // A floating-layout workspace is reconciled -- so the tree stays
        // current and the return to tiling restores a layout that knows
        // about every window opened meanwhile, exactly as through
        // stacked mode -- but nothing is applied: GNOME owns every
        // window's geometry there.
        if (this._isFloating(workspace))
            return;
        // Members that are only *temporarily* out of the layout
        // (minimized, user-maximized...) keep their leaf but get no
        // rectangle; their area flows to their tree sibling, and they
        // reclaim the exact same slot when they return.
        const windows = tree.keys().filter(w => isTileable(w, this._floatingWindows));
        if (windows.length === 0)
            return;

        const mode = this._effectiveModeOf(workspace);
        const workArea = (workspace ?? global.workspace_manager.get_active_workspace())
            .get_work_area_for_monitor(monitorIndex);

        if (mode === LayoutMode.STACKED) {
            // All windows share the one content rectangle; make sure the
            // focused one is the visible one.
            const {contentRect} = computeStackGeometry(workArea, gaps);
            for (const window of windows)
                this._moveResize(window, contentRect);
            const focus = this._focusedToplevel();
            if (focus && windows.includes(focus))
                focus.raise();
        } else {
            const rects = tree.computeRects(workArea, gaps, new Set(windows));
            for (const window of windows)
                this._moveResize(window, rects.get(window));
        }

        // Keep any user-floated windows in this bucket stacked above the
        // tiled ones we just placed (Hyprland-style floating layer).
        this._raiseFloating(workspace, monitorIndex);
    }

    // Loop-proof application: only touch a window whose frame actually
    // differs from its target, so applying a layout converges instead of
    // re-triggering itself. The target is remembered either way: it is
    // what the tile guard compares the window against when the window
    // later changes its own geometry.
    _moveResize(window, target) {
        this._targets.set(window, {
            x: target.x, y: target.y, width: target.width, height: target.height,
        });
        const frame = window.get_frame_rect();
        if (frame.x === target.x && frame.y === target.y &&
            frame.width === target.width && frame.height === target.height)
            return;
        window.move_resize_frame(false,
            target.x, target.y, target.width, target.height);
    }

    // Tab bars exist only for the *active* workspace's stacked buckets --
    // they are panel-like chrome, not per-workspace actors. Hidden (not
    // destroyed) when the active workspace is tiled; destroyed only on
    // monitor topology changes and disable().
    _syncTabBars(gaps) {
        const workspaceManager = global.workspace_manager;
        const active = workspaceManager.get_active_workspace();
        const primary = Main.layoutManager.primaryIndex;
        const primaryOnly = Meta.prefs_get_workspaces_only_on_primary();
        const focus = this._focusedToplevel();

        for (const monitor of Main.layoutManager.monitors) {
            // Secondary buckets under workspaces-only-on-primary are
            // workspace-agnostic and always dwindle-tiled (documented
            // limitation), so never show a bar there.
            const stackable = !(primaryOnly && monitor.index !== primary);
            // _workspaceGestureActive: while a 3-finger workspace swipe
            // is in flight the bars stay down no matter what triggers a
            // flush mid-drag -- same posture as the overview.visible
            // check next to it (a state the sync respects, not an event
            // that raced it).
            const stacked = this._enabled && stackable &&
                !Main.overview.visible &&
                !this._workspaceGestureActive &&
                this._isStacked(active) &&
                !this._bucketHasExclusiveWindow(active, monitor.index);
            // Tabs in tree order, not raw creation order: with
            // focus-anchored insertion the two can differ, and tree
            // order is what Hyprland's own tab bar shows. Reconcile on
            // read -- the bucket may not have been part of this flush.
            const windows = stacked
                ? this._reconcileTree(active, monitor.index).keys()
                    .filter(w => isTileable(w, this._floatingWindows))
                : [];

            if (windows.length === 0) {
                this._tabBars.get(monitor.index)?.hide();
                continue;
            }

            let bar = this._tabBars.get(monitor.index);
            if (!bar) {
                bar = new StackTabBar();
                // Deliberately NOT trackFullscreen chrome. layout.js's
                // _updateActorVisibility() force-writes `visible` on
                // every trackFullscreen actor -- from showOverview(),
                // fullscreen changes, and window restacks -- which in
                // practice overwrote this manager's own hide() calls at
                // unpredictable moments (the tab bar reappearing over a
                // gesture-opened overview and mid workspace-swipe were
                // both this). This manager is the sole owner of bar
                // visibility instead: fullscreen/maximize are already
                // handled above (the _bucketHasExclusiveWindow part of
                // `stacked`, relayout-driven via notify::fullscreen and
                // notify::maximized-*), the overview and gesture states
                // are checked in `stacked` too, so
                // nothing is lost -- and no shell code fights hide().
                Main.layoutManager.addChrome(bar, {affectsInputRegion: true});
                // The bar is workspace chrome, so it must sit in the
                // WINDOW layer, not the system-chrome layer. addChrome()
                // drops a new actor just below top_window_group -- above
                // every earlier chrome actor, i.e. above the panel, the
                // lock-screen shield (screenShieldGroup) and the overview,
                // and above notification banners (messageTray). Left
                // there the bar drew OVER an auto-hidden panel sliding
                // down, OVER the lock screen, and over notifications.
                // Restack it directly above global.window_group instead
                // (both window_group and top_window_group are uiGroup
                // children -- see layout.js): now it is below the panel,
                // the lock shield, the overview, menus/tooltips
                // (top_window_group) and notifications -- everything that
                // should cover it does -- while still above ordinary app
                // windows in window_group. This is the one line that makes
                // it behave like part of the workspace rather than a
                // free-floating overlay; the auto-hide panel reveals over
                // it and the lock screen hides it, both purely by z-order,
                // no extra signals. The overview/fullscreen hide()s remain
                // as belt-and-suspenders.
                Main.layoutManager.uiGroup.set_child_above_sibling(
                    bar, global.window_group);
                this._tabBars.set(monitor.index, bar);
            }

            const workArea = active.get_work_area_for_monitor(monitor.index);
            const {barRect} = computeStackGeometry(workArea, gaps);
            bar.set_position(barRect.x, barRect.y);
            bar.set_size(barRect.width, barRect.height);
            bar.setWindows(windows);
            bar.setActiveWindow(focus);
            bar.show();
        }
    }

    _destroyTabBars() {
        for (const bar of this._tabBars.values()) {
            Main.layoutManager.removeChrome(bar);
            bar.destroy();
        }
        this._tabBars.clear();
    }
}
