// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isLayoutMember, isTileable, isHelperSurface} from './windowFilter.js';

// After a workspace switch, focus changes inside this window are
// Mutter's own doing (it focuses the switched-to workspace's default
// window as part of activating it), not the user picking a window.
const SWITCH_FOCUS_SETTLE_US = 600 * GLib.USEC_PER_MSEC;

// How long a "put the next new window on this monitor" hint stays valid.
// It has to outlast a cold application start -- a browser or an Electron
// app can take several seconds to map its first window -- and no longer:
// a hint whose launch never produced a window (the app was already
// running and merely got focused, the result was an action) must not
// capture some unrelated window later.
const MONITOR_HINT_US = 10 * GLib.USEC_PER_SEC;

// The longest a new window is held invisible after it is shown. Reached
// only by a client that never lands on its tile (a minimum size larger
// than the tile, a slow first resize); everything else is revealed the
// moment it settles, typically within a frame or two.
const SETTLE_TIMEOUT_MS = 300;

// A window that has answered its tile request but not with the exact
// rectangle (size increments, a multi-step configure) counts as settled
// once its geometry has been quiet for this long.
const QUIET_MS = 60;

// How long after it is shown a new window is kept on its monitor against
// its own wishes: a client that restores remembered bounds (Chromium,
// Electron, most X11 apps) may move itself to another display a moment
// after mapping. Ended early by any interactive grab on the window --
// the user dragging it somewhere is never undone.
const PIN_MS = 3000;

// How many times one window may be put back on its monitor. A client
// that insists is left where it wants to be rather than fought.
const MAX_MONITOR_CORRECTIONS = 4;

// The fade a settled window is revealed with.
const REVEAL_FADE_MS = 120;

/**
 * Decides where a NEW application window opens and makes sure it is not
 * seen until it is there.
 *
 * WHY THIS IS ITS OWN MODULE. A new window becomes visible where Mutter
 * and the client first put it: on the pointer's monitor (or wherever an
 * X11 client asks to be), at the client's own size. The tiler then moves
 * it to the right monitor and resizes it to its tile, and some clients
 * (Chromium above all) go on adjusting their own window for a moment
 * after that. Correcting each of those *after* the window is on screen
 * is what every earlier version did, and each correction was a visible
 * jump: a window flashing on the external display before hopping to the
 * primary, a window appearing at its natural size and snapping to its
 * tile, a browser flickering as it restored its bounds. Fixing them one
 * by one only moved the flicker around. The rule here is the opposite:
 *
 *     a new window is held invisible from the moment it maps until it
 *     is on its monitor and on its tile, and only then revealed.
 *
 * WHAT IT DOES, in order, for each new window that would tile:
 *
 *  1. window-created: pick the target monitor (chooseMonitor) and start
 *     tracking the window. Nothing is moved: a just-created Wayland
 *     window has no placement or stack position, and touching its
 *     geometry there aborted the whole shell once (see GNOME_NOTES.md).
 *  2. map: cloak the window -- hold its actor at opacity 0. Opacity,
 *     not a clip or a paint-skipping effect: Mutter culls what lies
 *     under an opaque window, and only opacity tells it this one is not
 *     covering anything, so the windows beneath keep being drawn
 *     instead of leaving a hole. The shell's own map animation is
 *     switched off for this window beforehand (Main.wm.skipNextEffect,
 *     at window-created, where the actor already exists), because that
 *     animation does not start inside `map`: WindowManager._mapWindow is
 *     async and awaits the overview hiding before it animates, so it
 *     would begin AFTER this handler and animate the very opacity and
 *     scale the cloak depends on -- and a window revealed while the
 *     overview was still closing would appear at the 1% x 5% scale the
 *     shell parks it at. With the effect skipped nothing but this
 *     module touches the actor, and the reveal's fade is the window's
 *     only entrance.
 *  3. shown (placed, mapped and stacked; still before any frame is
 *     painted): move the window to its monitor if Mutter chose another,
 *     with move_resize_frame() at the window's own size -- a pure move,
 *     applied immediately.
 *  4. The tiler's ordinary relayout gives it its tile. onLayoutApplied()
 *     and the window's own geometry signals check whether it has
 *     arrived: on its monitor and exactly on its tile, or quiet for
 *     QUIET_MS after answering, or not something the layout places at
 *     all (a floating workspace, a window that opened maximized).
 *  5. Reveal: a short fade in, at the final geometry. SETTLE_TIMEOUT_MS
 *     after `shown` at the latest, whatever the client did.
 *  6. For PIN_MS after `shown` the window is kept on its monitor: if it
 *     moves itself to another display it is moved back (at most
 *     MAX_MONITOR_CORRECTIONS times, never during or after a user grab,
 *     never while maximized or fullscreen).
 *
 * A window can never be left invisible: every exit -- settle, timeout,
 * unmanaged, disable(), a thrown error, the setting being switched off
 * -- goes through the same uncloak, and while cloaked an opacity that
 * anything else resets is simply set back, so the two cannot disagree
 * about who owns it.
 *
 * The cloak is a setting (`smooth-window-open`, on by default). With it
 * off, steps 2, 4 and 5 are skipped and windows appear as they always
 * did; the monitor choice and the pin still apply.
 *
 * WHICH MONITOR (chooseMonitor), in order of precedence:
 *
 *  - an explicit hint (hintNextWindowMonitor): the Tessera launcher
 *    passes the monitor its popup was opened on. One window, valid for
 *    MONITOR_HINT_US.
 *  - the monitor of the window that had focus when this one was created
 *    -- Hyprland's rule, and the same anchor that decides which tile the
 *    newcomer splits. With one exception: under
 *    workspaces-only-on-primary the windows of a secondary monitor
 *    belong to every workspace, so switching to an empty primary
 *    workspace leaves focus on one of them (Mutter has nothing else to
 *    focus) and "the focused window's monitor" would send every launch
 *    from that empty workspace to the other display. So a workspace
 *    switch raises *primary intent*: until the user shows they are
 *    elsewhere -- a focus change after the switch has settled, or a
 *    pointer press on another monitor (which also covers clicking the
 *    sticky window that already has focus) -- a focused
 *    on-all-workspaces window on another monitor does not count.
 *  - the primary monitor.
 *
 * The host (TilingManager) is reached only through the small interface
 * passed to the constructor, so this module knows nothing about trees,
 * buckets or layout modes.
 */
export class WindowPlacer {
    /**
     * @param {import('../settingsManager.js').SettingsManager} settingsManager
     * @param {object} host
     * @param {function(): boolean} host.isEnabled whether tiling is on
     * @param {function(): Set<Meta.Window>} host.floatingWindows the
     *   user-floated windows (see windowFilter.js)
     * @param {function(Meta.Window): ?object} host.tileTargetOf the tile
     *   rectangle last applied to a window that is laid out right now, or
     *   null for a window the layout does not place
     */
    constructor(settingsManager, host) {
        this._settingsManager = settingsManager;
        this._host = host;

        // Meta.Window -> settle state (see _track).
        this._settling = new Map();

        this._hint = null;
        this._primaryIntent = false;
        this._primaryIntentSince = 0;

        this._displaySignalIds = [];
        this._workspaceSignalId = null;
        this._stageSignalId = null;
        this._mapSignalId = null;
        this._settingsSignalId = null;
    }

    enable() {
        const display = global.display;
        this._displaySignalIds = [
            display.connect('notify::focus-window', () => this._onFocusChanged()),
            display.connect('grab-op-begin', (d, window) => this._onGrabOpBegin(window)),
        ];

        this._workspaceSignalId = global.workspace_manager.connect(
            'workspace-switched', () => {
                this._primaryIntent = true;
                this._primaryIntentSince = GLib.get_monotonic_time();
            });

        // Pointer presses, for the primary-intent rule. Captured on the
        // stage, which sees presses over app windows too; always
        // propagated.
        this._stageSignalId = global.stage.connect('captured-event',
            (stage, event) => this._onStagePress(event));

        // Connected after the shell's own handler (which exists from
        // startup), so by the time this runs the shell has set up its
        // map animation and the cloak can take the actor over.
        this._mapSignalId = global.window_manager.connect('map',
            (shellwm, actor) => this._onMap(actor));

        this._settingsSignalId = this._settingsManager.gsettings.connect(
            'changed::smooth-window-open', () => {
                if (!this._settingsManager.smoothWindowOpen)
                    this._revealAll();
            });
    }

    disable() {
        for (const id of this._displaySignalIds)
            global.display.disconnect(id);
        this._displaySignalIds = [];

        if (this._workspaceSignalId !== null) {
            global.workspace_manager.disconnect(this._workspaceSignalId);
            this._workspaceSignalId = null;
        }
        if (this._stageSignalId !== null) {
            global.stage.disconnect(this._stageSignalId);
            this._stageSignalId = null;
        }
        if (this._mapSignalId !== null) {
            global.window_manager.disconnect(this._mapSignalId);
            this._mapSignalId = null;
        }
        if (this._settingsSignalId !== null) {
            this._settingsManager.gsettings.disconnect(this._settingsSignalId);
            this._settingsSignalId = null;
        }

        for (const window of [...this._settling.keys()])
            this._forget(window);

        this._hint = null;
        this._primaryIntent = false;
    }

    /**
     * Ask for the next new app window to open on `monitorIndex`, whatever
     * is focused and wherever the pointer is. For callers that KNOW where
     * the user is: the launcher passes the monitor its popup was opened
     * on. One window, and only for MONITOR_HINT_US.
     *
     * @param {number} monitorIndex an index into Main.layoutManager.monitors
     */
    hintNextWindowMonitor(monitorIndex) {
        if (!Number.isInteger(monitorIndex) || !Main.layoutManager.monitors[monitorIndex])
            return;
        this._hint = {
            index: monitorIndex,
            expires: GLib.get_monotonic_time() + MONITOR_HINT_US,
        };
    }

    /**
     * A window was just created. Called by the host from its own
     * window-created handler, with the toplevel that had focus at that
     * instant.
     *
     * @param {Meta.Window} window
     * @param {?Meta.Window} anchor the focused toplevel, if any
     */
    onWindowCreated(window, anchor) {
        if (!this._host.isEnabled() || this._settling.has(window))
            return;
        // Only windows that would tile: dialogs, transients, popups and
        // clipboard helper surfaces appear exactly as they always have.
        if (!isLayoutMember(window))
            return;

        const multiMonitor = Main.layoutManager.monitors.length > 1;
        const target = multiMonitor ? this._chooseMonitor(anchor) : null;
        const cloak = this._settingsManager.smoothWindowOpen;
        if (target === null && !cloak)
            return;

        this._track(window, target, cloak);
    }

    /**
     * The host finished a layout pass: every window it lays out now has
     * its tile recorded, and every window it does not has been passed
     * over. Either is an answer for a window waiting to be revealed.
     */
    onLayoutApplied() {
        for (const [window, state] of this._settling) {
            if (!state.shown)
                continue;
            state.laidOut = true;
            this._checkSettled(window, state);
        }
    }

    // --- Which monitor ----------------------------------------------------

    _chooseMonitor(anchor) {
        const primary = Main.layoutManager.primaryIndex;
        const hinted = this._takeHint();
        if (hinted !== null)
            return hinted;

        let target = anchor?.get_monitor() ?? -1;
        if (target >= 0 && target !== primary && this._primaryIntent &&
            Meta.prefs_get_workspaces_only_on_primary() && anchor.is_on_all_workspaces())
            target = primary;
        if (target < 0)
            target = primary;
        return target >= 0 ? target : null;
    }

    // The live hint's monitor, consuming it; null when there is none, it
    // has expired, or its monitor has since been unplugged.
    _takeHint() {
        const hint = this._hint;
        this._hint = null;
        if (!hint || GLib.get_monotonic_time() > hint.expires)
            return null;
        return Main.layoutManager.monitors[hint.index] ? hint.index : null;
    }

    _onFocusChanged() {
        const focus = global.display.focus_window;
        // A clipboard helper's momentary focus surface says nothing
        // about where the user is.
        if (focus && isHelperSurface(focus))
            return;
        // A focus change well after the last workspace switch is the
        // user choosing a window; one inside the settle window is
        // Mutter focusing the workspace's default window.
        if (this._primaryIntent &&
            GLib.get_monotonic_time() - this._primaryIntentSince > SWITCH_FOCUS_SETTLE_US)
            this._primaryIntent = false;
    }

    // A press on the primary monitor asserts primary intent; one on any
    // other monitor withdraws it. Only presses: key events also carry
    // workspace shortcuts and overview typing, which say nothing about
    // which monitor the user is on.
    _onStagePress(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (Main.layoutManager.monitors.length < 2)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const monitor = Main.layoutManager.monitors.find(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        if (monitor)
            this._primaryIntent = monitor.index === Main.layoutManager.primaryIndex;
        return Clutter.EVENT_PROPAGATE;
    }

    // --- Settling ---------------------------------------------------------

    _track(window, target, cloak) {
        const state = {
            target,                 // monitor index, or null (single monitor)
            wantCloak: cloak,
            cloaked: false,
            revealed: !cloak,       // nothing to reveal without a cloak
            shown: false,
            laidOut: false,         // a layout pass has run since `shown`
            corrections: 0,
            pinned: false,
            windowSignalIds: [],
            actor: null,
            actorSignalId: null,
            settleTimeoutId: null,
            quietTimeoutId: null,
            pinTimeoutId: null,
        };

        // See the class comment, step 2. Without skipNextEffect (another
        // shell version) the cloak still works through its opacity
        // guard; the reveal then defers to the shell's animation.
        if (cloak) {
            const actor = window.get_compositor_private();
            if (actor && typeof Main.wm?.skipNextEffect === 'function')
                Main.wm.skipNextEffect(actor);
        }

        const onGeometry = () => this._onGeometryChanged(window, state);
        state.windowSignalIds = [
            window.connect('shown', () => this._onShown(window, state)),
            window.connect('position-changed', onGeometry),
            window.connect('size-changed', onGeometry),
            window.connect('unmanaged', () => this._forget(window)),
        ];
        this._settling.set(window, state);
    }

    _onMap(actor) {
        const window = actor?.meta_window;
        const state = window ? this._settling.get(window) : null;
        if (!state || !state.wantCloak || state.revealed || state.cloaked)
            return;
        this._guarded(window, () => this._cloak(actor, state));
    }

    // Hold the actor invisible. The shell's map effect was skipped for
    // it (see _track), so its opacity is ours alone; the guard is the
    // safety net for anything that sets it regardless while the window
    // is cloaked (a shell without skipNextEffect starting its animation
    // late): it is simply set back.
    _cloak(actor, state) {
        actor.remove_all_transitions();
        actor.opacity = 0;

        state.cloaked = true;
        state.actor = actor;
        state.actorSignalId = actor.connect('notify::opacity', () => {
            if (state.cloaked && actor.opacity !== 0)
                actor.opacity = 0;
        });
    }

    _onShown(window, state) {
        if (state.shown)
            return;
        state.shown = true;

        this._guarded(window, () => {
            // The shell maps before it emits `shown`, so the cloak is
            // normally up already; this covers an actor the map handler
            // did not see.
            if (state.wantCloak && !state.cloaked && !state.revealed) {
                const actor = window.get_compositor_private();
                if (actor)
                    this._cloak(actor, state);
                else
                    state.revealed = true;
            }

            this._enforceMonitor(window, state);

            if (state.target !== null) {
                state.pinned = true;
                state.pinTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PIN_MS, () => {
                    state.pinTimeoutId = null;
                    state.pinned = false;
                    this._forgetIfDone(window, state);
                    return GLib.SOURCE_REMOVE;
                });
            }

            if (state.cloaked) {
                state.settleTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, SETTLE_TIMEOUT_MS, () => {
                        state.settleTimeoutId = null;
                        this._reveal(window, state);
                        return GLib.SOURCE_REMOVE;
                    });
            }

            this._forgetIfDone(window, state);
        });
    }

    _onGeometryChanged(window, state) {
        if (!state.shown)
            return;
        this._guarded(window, () => {
            if (state.pinned)
                this._enforceMonitor(window, state);
            this._checkSettled(window, state);
        });
    }

    // Any interactive grab on the window ends its pin: wherever the user
    // takes it is where it belongs.
    _onGrabOpBegin(window) {
        const state = window ? this._settling.get(window) : null;
        if (!state)
            return;
        state.pinned = false;
        state.target = null;
        if (state.cloaked)
            this._reveal(window, state);
        this._forgetIfDone(window, state);
    }

    // Put the window on its monitor if it is on another one. A pure move
    // at the window's own size (clamped to the work area), centered:
    // the relayout that window-entered-monitor queues gives it its tile.
    // Never for a window the layout would not place right now
    // (maximized, fullscreen, minimized, unresizable): a presenter view
    // that fullscreens itself on the other display stays there.
    _enforceMonitor(window, state) {
        const target = state.target;
        if (target === null)
            return;
        if (!Main.layoutManager.monitors[target]) {
            state.target = null;
            return;
        }
        if (window.get_monitor() === target)
            return;
        if (state.corrections >= MAX_MONITOR_CORRECTIONS)
            return;
        if (!window.get_compositor_private())
            return;
        if (!isTileable(window, this._host.floatingWindows()))
            return;

        let grabOp = Meta.GrabOp.NONE;
        try {
            grabOp = global.display.get_grab_op();
        } catch (error) {
            // get_grab_op unavailable on this build: carry on.
        }
        if (grabOp !== Meta.GrabOp.NONE)
            return;

        const frame = window.get_frame_rect();
        if (frame.width <= 0 || frame.height <= 0)
            return;

        const workspace = window.get_workspace() ??
            global.workspace_manager.get_active_workspace();
        const area = workspace.get_work_area_for_monitor(target);
        const width = Math.min(frame.width, area.width);
        const height = Math.min(frame.height, area.height);
        const x = area.x + Math.round((area.width - width) / 2);
        const y = area.y + Math.round((area.height - height) / 2);

        state.corrections++;
        window.move_resize_frame(false, x, y, width, height);
    }

    _checkSettled(window, state) {
        if (!state.cloaked || state.revealed || !state.shown)
            return;

        // Still on the wrong monitor and still allowed to be moved: the
        // move (or the next geometry signal) will bring us back here.
        if (state.target !== null && window.get_monitor() !== state.target &&
            state.corrections < MAX_MONITOR_CORRECTIONS &&
            isTileable(window, this._host.floatingWindows()))
            return;

        const tile = this._host.tileTargetOf(window);
        if (!tile) {
            // Not something the layout places. Once a pass has had the
            // chance to say otherwise, there is nothing to wait for.
            if (state.laidOut)
                this._reveal(window, state);
            return;
        }

        const frame = window.get_frame_rect();
        if (frame.x === tile.x && frame.y === tile.y &&
            frame.width === tile.width && frame.height === tile.height) {
            this._reveal(window, state);
            return;
        }

        // Has a tile, is not exactly on it: reveal once its geometry has
        // been quiet for a moment (restarted by every further change).
        if (state.quietTimeoutId !== null)
            GLib.Source.remove(state.quietTimeoutId);
        state.quietTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUIET_MS, () => {
            state.quietTimeoutId = null;
            this._reveal(window, state);
            return GLib.SOURCE_REMOVE;
        });
    }

    _reveal(window, state) {
        if (state.revealed)
            return;
        state.revealed = true;
        this._clearTimeout(state, 'settleTimeoutId');
        this._clearTimeout(state, 'quietTimeoutId');

        const actor = state.actor;
        const wasCloaked = state.cloaked;
        state.cloaked = false;
        if (actor && state.actorSignalId !== null) {
            actor.disconnect(state.actorSignalId);
            state.actorSignalId = null;
        }
        state.actor = null;

        if (wasCloaked && actor && window.get_compositor_private() === actor) {
            try {
                // A scale other than 1 means the shell is (about to be)
                // animating this actor after all: step aside and let its
                // animation be the entrance rather than fading a window
                // it has scaled down.
                const shellAnimating = actor.scale_x !== 1 || actor.scale_y !== 1;
                if (shellAnimating) {
                    actor.opacity = 255;
                } else if (St.Settings.get().enable_animations &&
                    typeof actor.ease === 'function') {
                    actor.ease({
                        opacity: 255,
                        duration: REVEAL_FADE_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } else {
                    actor.opacity = 255;
                }
            } catch (error) {
                actor.opacity = 255;
            }
        }

        this._forgetIfDone(window, state);
    }

    _revealAll() {
        for (const [window, state] of this._settling)
            this._reveal(window, state);
    }

    // Tracking ends when there is nothing left to do for the window:
    // it is revealed and no longer pinned.
    _forgetIfDone(window, state) {
        if (state.shown && state.revealed && !state.pinned)
            this._forget(window);
    }

    _forget(window) {
        const state = this._settling.get(window);
        if (!state)
            return;
        this._settling.delete(window);

        this._clearTimeout(state, 'settleTimeoutId');
        this._clearTimeout(state, 'quietTimeoutId');
        this._clearTimeout(state, 'pinTimeoutId');

        for (const id of state.windowSignalIds)
            window.disconnect(id);
        state.windowSignalIds = [];

        // Never leave a window invisible, whatever ended its tracking.
        const actor = state.actor;
        if (actor) {
            try {
                if (state.actorSignalId !== null)
                    actor.disconnect(state.actorSignalId);
                if (state.cloaked)
                    actor.opacity = 255;
            } catch (error) {
                // The actor is already gone with its window.
            }
        }
        state.actorSignalId = null;
        state.actor = null;
        state.cloaked = false;
        state.revealed = true;
    }

    _clearTimeout(state, key) {
        if (state[key] !== null) {
            GLib.Source.remove(state[key]);
            state[key] = null;
        }
    }

    // Run one step of the settle machinery; if it throws, the window is
    // dropped from it (and therefore revealed) rather than left in
    // whatever state the failure interrupted.
    _guarded(window, step) {
        try {
            step();
        } catch (error) {
            console.warn(`tessera: new-window placement failed, revealing: ${error}`);
            this._forget(window);
        }
    }
}
