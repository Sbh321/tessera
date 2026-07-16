// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isLayoutMember, isTileable} from './windowFilter.js';
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
        this._stackedWorkspaces = new Set(); // Meta.Workspace -> stacked mode
        this._windowSignals = new Map();   // Meta.Window -> [handlerId]
        this._windowWorkspaces = new Map(); // Meta.Window -> last known Meta.Workspace
        this._tabBars = new Map();         // monitor index -> StackTabBar

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
            workspaceManager.connect('workspace-switched',
                () => this._queueRelayout(workspaceManager.get_active_workspace())),
            workspaceManager.connect('workspace-removed', (wm, workspace) => {
                this._stackedWorkspaces.delete(workspace);
                this._trees.delete(workspace);
            }),
        ];

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
        // top of the Activities overview.
        this._overviewSignalIds = [
            Main.overview.connect('showing', () => {
                for (const bar of this._tabBars.values())
                    bar.hide();
            }),
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

        for (const [window, ids] of this._windowSignals) {
            for (const id of ids)
                window.disconnect(id);
        }
        this._windowSignals.clear();
        this._windowWorkspaces.clear();
        this._trees.clear();
        this._insertionAnchors.clear();

        this._destroyTabBars();
        this._stackedWorkspaces.clear();
        this._pendingWorkspaces.clear();
        this._pendingAll = false;

        // Windows keep their last tiled geometry -- ordinary, freely
        // movable windows; there is no prior "untiled" geometry to
        // restore because tiling repositions windows continuously from
        // the moment they map (same posture as every tiling WM).
    }

    /** Toggle the active workspace between tiled and stacked layout. */
    toggleStacked() {
        if (!this._enabled)
            return;

        const workspace = global.workspace_manager.get_active_workspace();
        if (this._stackedWorkspaces.has(workspace))
            this._stackedWorkspaces.delete(workspace);
        else
            this._stackedWorkspaces.add(workspace);

        // The bucket trees persist through stacked mode (reconciliation
        // runs in both modes), so leaving it restores the tiled
        // arrangement the workspace had -- including windows opened
        // while stacked, which took their focus-anchored place in the
        // tree even though the stacked geometry didn't show it.
        this._queueRelayout(workspace);
    }

    _syncEnabled() {
        this._enabled = this._settingsManager.enableTiling;
        if (this._enabled) {
            this._queueRelayoutAll();
        } else {
            for (const bar of this._tabBars.values())
                bar.hide();
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

        this._queueRelayout(window.get_workspace());
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
    }

    _onFocusChanged() {
        // Cheap path: only the tab highlight (and stacked raise) update;
        // no geometry recomputation on plain focus changes.
        const focus = this._focusedToplevel();
        for (const bar of this._tabBars.values())
            bar.setActiveWindow(focus);

        const active = global.workspace_manager.get_active_workspace();
        if (focus && this._enabled && this._stackedWorkspaces.has(active) &&
            isTileable(focus) && focus.get_workspace() === active)
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

    // All layout-member windows of a bucket, in creation order (the
    // deterministic insertion order for windows with no focus anchor:
    // enable-time adoption, workspace merges).
    _bucketMembers(workspace, monitorIndex) {
        const source = workspace
            ? workspace.list_windows()
            : global.get_window_actors().map(actor => actor.meta_window);
        return source
            .filter(window => window.get_monitor() === monitorIndex &&
                isLayoutMember(window))
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

    // True while any window on this bucket is fullscreen: tiling for the
    // bucket is suspended entirely (never resize a fullscreen window,
    // never reflow beneath it), and resumes on the notify::fullscreen
    // relayout when it ends.
    _bucketHasFullscreen(workspace, monitorIndex) {
        const source = workspace
            ? workspace.list_windows()
            : global.get_window_actors().map(actor => actor.meta_window);
        return source.some(window =>
            window.get_monitor() === monitorIndex && window.is_fullscreen());
    }

    _applyBucket(workspace, monitorIndex, gaps) {
        if (this._bucketHasFullscreen(workspace, monitorIndex))
            return;

        const tree = this._reconcileTree(workspace, monitorIndex);
        // Members that are only *temporarily* out of the layout
        // (minimized, user-maximized...) keep their leaf but get no
        // rectangle; their area flows to their tree sibling, and they
        // reclaim the exact same slot when they return.
        const windows = tree.keys().filter(isTileable);
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
            const stacked = this._enabled && stackable &&
                !Main.overview.visible &&
                this._stackedWorkspaces.has(active) &&
                !this._bucketHasFullscreen(active, monitor.index);
            // Tabs in tree order, not raw creation order: with
            // focus-anchored insertion the two can differ, and tree
            // order is what Hyprland's own tab bar shows. Reconcile on
            // read -- the bucket may not have been part of this flush.
            const windows = stacked
                ? this._reconcileTree(active, monitor.index).keys()
                    .filter(isTileable)
                : [];

            if (windows.length === 0) {
                this._tabBars.get(monitor.index)?.hide();
                continue;
            }

            let bar = this._tabBars.get(monitor.index);
            if (!bar) {
                bar = new StackTabBar();
                Main.layoutManager.addChrome(bar,
                    {affectsInputRegion: true, trackFullscreen: true});
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
