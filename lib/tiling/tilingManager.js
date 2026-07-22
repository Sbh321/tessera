// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isLayoutMember, isTileable, isMaximized, isExclusiveOccupant} from './windowFilter.js';
import {LayoutMode, LayoutTree, computeStackGeometry} from './layoutEngine.js';
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

// How long after a window is created it is watched for self-driven
// geometry changes so its tile is re-applied. A freshly mapped window --
// Chromium/Electron/GTK apps especially -- finalizes its size/position
// across several async configures AFTER window-created/shown: client-side-
// decoration frame extents arriving, an opens-maximized state being
// undone, or a multi-step Wayland configure. The first layout pass can
// land before that settles, so the window ignores the size we asked for
// and keeps its own -- the visible symptom is a tiled window whose right
// and bottom outer gaps vanish (it is wider/taller than its tile) while
// the left and top look enlarged, "stuck" until some unrelated event
// (opening another window, switching workspace) triggers a relayout that
// finally lands. Watching size/position for a short grace after creation
// and re-applying the tile (loop-proof via _moveResize) heals it the
// instant the window settles, instead of leaving it wrong until later.
const MAP_SETTLE_GRACE_MS = 2500;

// Which workspaces are in stacked mode -- a per-workspace user choice
// that must survive the disable()/enable() cycle GNOME performs around
// screen lock. Locking pushes the session mode to 'unlock-dialog',
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
// keys across the cycle (nothing here ever recreates them).
const stackedWorkspaces = new Set();

// Windows the user has explicitly popped out to float (Shift+Super+V) --
// a per-window user choice, the counterpart to stackedWorkspaces' per-
// workspace one, and module-scoped for the exact same reason: it must
// survive the disable()/enable() cycle GNOME performs around screen lock
// (see the long comment on stackedWorkspaces above). Keyed by Meta.Window
// (mutter-owned, stable across the cycle); an entry is pruned the moment
// its window is unmanaged (_untrackWindow), so it never holds a dead
// window, and it resets wholesale only on a genuine session restart (a
// fresh module load). A floated window is not a layout member
// (windowFilter.isLayoutMember consults this set), so it leaves the tree,
// its siblings reclaim its area, and it floats freely -- exactly like a
// dialog -- until toggled back.
const floatingWindows = new Set();

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
        // Meta.Window -> {ids: [handlerId], timerId}: the transient
        // size/position watch on a just-created window (see MAP_SETTLE_
        // GRACE_MS and _watchSettling); torn down when the grace ends, the
        // window is unmanaged, or disable() runs.
        this._settling = new Map();

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

    // Stacked-mode membership is module-scoped state (see the top of
    // this file) so it survives the disable()/enable() cycle GNOME
    // performs around screen lock; this getter keeps every other method
    // in this class unaware of that -- they just see a Set that behaves
    // like an ordinary instance property.
    get _stackedWorkspaces() {
        return stackedWorkspaces;
    }

    // Module-scoped for the same lock-survival reason as
    // _stackedWorkspaces (see the top of this file); this getter keeps
    // the rest of the class treating it like an ordinary instance Set.
    get _floatingWindows() {
        return floatingWindows;
    }

    enable() {
        this._enabled = this._settingsManager.enableTiling;

        const display = global.display;
        this._displaySignalIds = [
            display.connect('window-created',
                (d, window) => this._onWindowCreated(window)),
            display.connect('grab-op-end',
                (d, window) => this._queueRelayout(window?.get_workspace() ?? null)),
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
                this._stackedWorkspaces.delete(workspace);
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

        // Tear down any in-flight settling watches (transient per-window
        // signals + grace timers) before dropping the window signal map.
        for (const window of [...this._settling.keys()])
            this._stopSettling(window);

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

        // Deliberately NOT clearing _stackedWorkspaces or
        // _floatingWindows: both are module-scoped state (see the top of
        // this file) that must outlive this instance, specifically to
        // survive the disable()/enable() cycle GNOME performs around
        // screen lock. _stackedWorkspaces only loses entries via the
        // 'workspace-removed' handler above; _floatingWindows only via
        // _untrackWindow pruning an unmanaged window; both reset wholesale
        // only on a genuine session restart (a fresh module load).
        //
        // Windows keep their last tiled geometry -- ordinary, freely
        // movable windows; there is no prior "untiled" geometry to
        // restore because tiling repositions windows continuously from
        // the moment they map (same posture as every tiling WM).
    }

    /**
     * Toggle the active workspace between tiled and stacked layout.
     * Stacking is a *group* posture: with fewer than two member windows
     * on the workspace's stackable buckets there is nothing to stack,
     * so turning it ON is a clean no-op (and a stacked workspace that
     * later drops below two members reverts to tiled automatically --
     * see the auto-exit check in _flush()). Turning it OFF is always
     * allowed, as a defensive escape hatch.
     */
    toggleStacked() {
        if (!this._enabled)
            return;

        const workspace = global.workspace_manager.get_active_workspace();

        // Toggling the layout mode is an explicit "re-tile now" gesture:
        // un-maximize any maximized window on the workspace first so the
        // toggle acts on the real window set (same intent as a freshly
        // opened app). TRUE fullscreen is left alone. Member count is
        // unaffected -- a maximized window is still a layout member -- so
        // the < 2 guard below still sees the true count.
        this._exitMaximized(workspace, null);

        if (this._stackedWorkspaces.has(workspace)) {
            this._stackedWorkspaces.delete(workspace);
        } else {
            if (this._stackableMemberCount(workspace) < 2)
                return;
            this._stackedWorkspaces.add(workspace);
        }

        // The bucket trees persist through stacked mode (reconciliation
        // runs in both modes), so leaving it restores the tiled
        // arrangement the workspace had -- including windows opened
        // while stacked, which took their focus-anchored place in the
        // tree even though the stacked geometry didn't show it.
        this._queueRelayout(workspace);
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
    toggleFloating() {
        if (!this._enabled)
            return;

        const window = this._focusedToplevel();
        // Identity-only check (no floating set passed): "is this the kind
        // of window that participates in the layout at all", regardless
        // of whether it currently floats by user choice.
        if (!window || !isLayoutMember(window))
            return;

        const workspace = window.get_workspace();
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
                    if (!workspace || !this._stackedWorkspaces.has(workspace))
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

        // Re-apply the tile whenever the window finishes settling its own
        // geometry over the next few seconds (see MAP_SETTLE_GRACE_MS).
        this._watchSettling(window);
    }

    // Watch a just-created window's self-driven size/position changes for a
    // short grace, re-queuing its layout each time so the tile is re-applied
    // once the client stops fighting it (CSD extents, opens-maximized undo,
    // multi-step Wayland configures). We deliberately do NOT watch these in
    // steady state -- a tiled window at rest never moves, and a permanent
    // watch would relayout on every drag of a floating window and fight a
    // user resizing a tiled window frame-by-frame (grab-op-end already snaps
    // those back). The re-apply is loop-proof: _moveResize only touches a
    // window whose frame differs from its target, so once the window lands
    // on its tile the resulting size-changed is a no-op and it converges.
    _watchSettling(window) {
        if (this._settling.has(window))
            return;

        const reapply = () => {
            // Don't fight an interactive move/resize: while the user is
            // dragging, leave the window alone -- grab-op-end snaps it back
            // to its tile when the drag ends, exactly as in steady state.
            let grabOp = Meta.GrabOp.NONE;
            try {
                grabOp = global.display.get_grab_op();
            } catch (error) {
                // get_grab_op unavailable on this build: don't guard.
            }
            if (grabOp === Meta.GrabOp.NONE)
                this._queueRelayout(window.get_workspace());
        };
        const ids = [];
        // position-changed exists on Meta.Window in current GNOME, but guard
        // it so a future/edge build that lacks it still gets size-changed.
        for (const signal of ['size-changed', 'position-changed']) {
            try {
                ids.push(window.connect(signal, reapply));
            } catch (error) {
                // Signal absent on this build: skip it.
            }
        }
        if (ids.length === 0)
            return;

        const entry = {ids, timerId: 0};
        entry.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            MAP_SETTLE_GRACE_MS, () => {
                // Null the id first: the source removes itself by returning
                // SOURCE_REMOVE, so _stopSettling must not remove it again.
                entry.timerId = 0;
                this._stopSettling(window);
                return GLib.SOURCE_REMOVE;
            });
        this._settling.set(window, entry);
    }

    // Tear down a window's settling watch (grace expired, unmanaged, or
    // disable). Safe to call when there is nothing to tear down.
    _stopSettling(window) {
        const entry = this._settling.get(window);
        if (!entry)
            return;
        this._settling.delete(window);
        if (entry.timerId)
            GLib.Source.remove(entry.timerId);
        for (const id of entry.ids)
            window.disconnect(id);
    }

    // Whether a just-created window is the kind that, on opening, should
    // pull the workspace out of a maximize. Same identity gate as
    // _maybeUndoMapMaximize: a real, taskbar-worthy top-level app window,
    // never a dialog/transient/popup.
    _opensAsTilingApp(window) {
        return this._enabled &&
            window.window_type === Meta.WindowType.NORMAL &&
            window.get_transient_for() === null &&
            !window.skip_taskbar;
    }

    // Undo an app-restored "open maximized" state so the window tiles.
    // Only for windows that would otherwise be tileable -- dialogs,
    // transients and the like are never touched.
    _maybeUndoMapMaximize(window) {
        if (this._enabled &&
            window.window_type === Meta.WindowType.NORMAL &&
            window.get_transient_for() === null &&
            !window.skip_taskbar &&
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
        this._stopSettling(window);

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
        for (const bar of this._tabBars.values())
            bar.setActiveWindow(focus);

        const active = global.workspace_manager.get_active_workspace();
        if (focus && this._enabled && this._stackedWorkspaces.has(active) &&
            isTileable(focus, this._floatingWindows) &&
            focus.get_workspace() === active)
            focus.raise();
    }

    _focusedToplevel() {
        const focus = global.display.focus_window;
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

        // Stacked mode is a group posture: a stacked workspace that has
        // dropped below two member windows (the last-but-one closed or
        // moved away) reverts to tiled automatically, so the survivor
        // gets the full work area back instead of sitting alone under a
        // one-tab bar. Checked here, against the same ground truth the
        // buckets below are about to be reconciled with -- every event
        // path that changes membership (close, workspace move, monitor
        // move) already queues the affected workspaces into this flush,
        // so the mode heals on the same pass, and a pendingAll flush
        // sweeps every workspace (self-healing for any missed event).
        for (const workspace of workspaces) {
            if (this._stackedWorkspaces.has(workspace) &&
                this._stackableMemberCount(workspace) < 2)
                this._stackedWorkspaces.delete(workspace);
        }

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
    // workspaces-only-on-primary, every monitor otherwise). Counts
    // *members*, not currently-tileable windows, deliberately: a
    // minimized or user-maximized window still counts toward stacked
    // mode staying alive, matching the tree-slot-retention rule --
    // auto-exiting a deliberate user mode because of a transient state
    // like a minimize would be lossy, whereas closing or moving a
    // window away genuinely ends its membership.
    _stackableMemberCount(workspace) {
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
    _exitMaximized(workspace, exceptWindow) {
        if (!workspace)
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
        // Members that are only *temporarily* out of the layout
        // (minimized, user-maximized...) keep their leaf but get no
        // rectangle; their area flows to their tree sibling, and they
        // reclaim the exact same slot when they return.
        const windows = tree.keys().filter(w => isTileable(w, this._floatingWindows));
        if (windows.length === 0)
            return;

        const mode = workspace && this._stackedWorkspaces.has(workspace)
            ? LayoutMode.STACKED : LayoutMode.TILED;
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
    // re-triggering itself.
    _moveResize(window, target) {
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
                this._stackedWorkspaces.has(active) &&
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
