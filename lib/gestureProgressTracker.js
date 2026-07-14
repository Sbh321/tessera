// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Best-effort only. GNOME's 3-finger-swipe workspace switch is driven by a
// private SwipeTracker inside js/ui/workspaceAnimation.js -- unlike every
// other GNOME touchpoint in this project, this field is not part of any
// public extension API, isn't guaranteed stable across GNOME versions or
// distro patches, and could be named or structured differently on another
// machine. Every access below is defensive (optional chaining + try/catch)
// specifically so that a mismatch on some other device just means this one
// enhancement quietly does nothing -- the indicator still falls back to
// updating on gesture-end only, exactly like GNOME's own bundled
// workspace-indicator extension already does (see docs/GNOME_NOTES.md).
//
// This only ever *previews* the active square during the gesture; it never
// calls workspace.activate(). The real switch still happens through
// GNOME's own workspace-switched signal (see workspaceIndicator.js), which
// always overwrites whatever this tracker guessed with the real answer.
//
// How the raw `progress` value maps to a workspace: WorkspaceAnimation-
// Controller calls SwipeTracker.confirmSwipe() with one snap point per
// workspace at that workspace's strip position, so `progress` is an
// ABSOLUTE fractional workspace index (e.g. 2.4 = between workspaces 3 and
// 4), NOT a delta from wherever the gesture started. GNOME's own
// gesture-end handler picks the final workspace as the closest snap point
// -- i.e. round(endProgress). Math.round(progress) here is therefore not a
// guess but the exact same mapping GNOME itself applies, which is why the
// preview can be live from the very first gesture with no calibration
// pass. (An earlier version modeled progress as a delta and tried to
// self-calibrate a sign/scale from gesture outcomes; because the value is
// actually absolute, the learned scale depended on which workspace the
// gesture happened to start from, and the preview lagged or misfired --
// see docs/GNOME_NOTES.md for the history.)

// Verification is event-driven, NOT a fixed delay: GNOME only calls
// workspace.activate() in the onComplete of its settle animation, whose
// duration is up to MAX_ANIMATION_DURATION * log2(1 + nWorkspaces) --
// over a full second with 5+ workspaces. A fixed-delay ground-truth read
// (an earlier version used 350ms) routinely fired before that activate(),
// read the STALE workspace index, counted the perfectly correct
// prediction as a miss, and tripped the safety valve below mid-session --
// reported as the live preview silently dying after a few swipes. So each
// gesture's prediction is now checked on the next workspace-switched
// signal (the exact moment GNOME commits the switch, however long the
// animation took). The timer below is only a fallback for gestures that
// never emit workspace-switched -- cancelled swipes and round trips back
// to the origin workspace -- where there is no race at all, because the
// active workspace never changed. Both are dropped if a new gesture
// begins first.
const VERIFY_FALLBACK_DELAY_MS = 1500;

// Safety valve for the absolute-index assumption above: if it's ever wrong
// on some GNOME build, predictions will disagree with where gestures
// actually land. After this many consecutive mispredictions the live
// preview pauses, reverting to the settle-on-end behavior of GNOME's own
// bundled indicator. Two rather than one so a single confounded reading
// (e.g. a keybinding switch landing between gesture end and verify) can't
// pause the feature. Pause, not kill: predictions keep being verified
// while paused, and the same number of consecutive CORRECT ones turns the
// preview back on -- so a transient confounder costs a few swipes of
// liveness, never the rest of the session.
const CONSECUTIVE_RESULTS_TO_TOGGLE = 2;

export class GestureProgressTracker {
    constructor() {
        this._swipeTracker = null;
        this._beginHandlerId = null;
        this._updateHandlerId = null;
        this._endHandlerId = null;
        this._verifySourceId = null;
        this._verifySwitchedHandlerId = null;
        this._onProgress = null;
        this._lastProgress = null;
        this._missStreak = 0;
        this._matchStreak = 0;
        this._previewEnabled = true;
    }

    enable(onProgress) {
        this._onProgress = onProgress;

        try {
            this._swipeTracker = Main.wm._workspaceAnimation?._swipeTracker ?? null;
        } catch (error) {
            this._swipeTracker = null;
        }

        if (typeof this._swipeTracker?.connect !== 'function') {
            this._swipeTracker = null;
            return;
        }

        try {
            this._beginHandlerId = this._swipeTracker.connect('begin', () => {
                // A fast next swipe can start before the previous gesture's
                // verify timer fires; reading the "final" workspace now
                // would sample mid-gesture noise, so drop that check.
                this._cancelVerify();
                this._lastProgress = null;
            });
            this._updateHandlerId = this._swipeTracker.connect('update', (tracker, progress) => {
                if (!Number.isFinite(progress))
                    return;
                this._lastProgress = progress;
                if (this._previewEnabled)
                    this._onProgress(this._progressToIndex(progress));
            });
            // 'end' fires the moment the fingers lift, before GNOME's own
            // snap animation (and thus the authoritative workspace-switched
            // signal) completes. Previewing the final square immediately
            // here is what makes releasing a swipe feel instant instead of
            // trailing the animation by a few hundred ms.
            this._endHandlerId = this._swipeTracker.connect('end', (tracker, duration, endProgress) => {
                const progress = Number.isFinite(endProgress)
                    ? endProgress : this._lastProgress;
                if (progress === null)
                    return;
                this._lastProgress = progress;
                if (this._previewEnabled)
                    this._onProgress(this._progressToIndex(progress));
                this._startVerify(this._progressToIndex(progress));
            });
        } catch (error) {
            this.disable();
        }
    }

    disable() {
        this._cancelVerify();

        if (this._swipeTracker) {
            if (this._beginHandlerId !== null)
                this._swipeTracker.disconnect(this._beginHandlerId);
            if (this._updateHandlerId !== null)
                this._swipeTracker.disconnect(this._updateHandlerId);
            if (this._endHandlerId !== null)
                this._swipeTracker.disconnect(this._endHandlerId);
        }

        this._swipeTracker = null;
        this._beginHandlerId = null;
        this._updateHandlerId = null;
        this._endHandlerId = null;
        this._onProgress = null;
    }

    _progressToIndex(progress) {
        const lastIndex = global.workspace_manager.n_workspaces - 1;
        return Math.clamp(Math.round(progress), 0, lastIndex);
    }

    _cancelVerify() {
        if (this._verifySourceId !== null) {
            GLib.Source.remove(this._verifySourceId);
            this._verifySourceId = null;
        }
        if (this._verifySwitchedHandlerId !== null) {
            global.workspace_manager.disconnect(this._verifySwitchedHandlerId);
            this._verifySwitchedHandlerId = null;
        }
    }

    // Checks this gesture's prediction the moment GNOME commits the switch
    // (workspace-switched), or after the fallback delay if no switch ever
    // happens (cancelled swipe / round trip -- race-free, see the constant
    // above). Whichever fires first resolves the check and cancels the
    // other.
    _startVerify(predicted) {
        this._cancelVerify();

        this._verifySwitchedHandlerId = global.workspace_manager.connect(
            'workspace-switched', () => this._resolveVerify(predicted));
        this._verifySourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, VERIFY_FALLBACK_DELAY_MS, () => {
                this._verifySourceId = null;
                this._resolveVerify(predicted);
                return GLib.SOURCE_REMOVE;
            });
    }

    _resolveVerify(predicted) {
        this._cancelVerify();

        const actual = global.workspace_manager.get_active_workspace_index();
        if (predicted === actual) {
            this._missStreak = 0;
            if (this._previewEnabled)
                return;
            this._matchStreak++;
            if (this._matchStreak >= CONSECUTIVE_RESULTS_TO_TOGGLE) {
                this._previewEnabled = true;
                this._matchStreak = 0;
                console.log(
                    'tessera: gesture predictions are matching ' +
                    'real outcomes again; live swipe preview re-enabled');
            }
            return;
        }

        this._matchStreak = 0;
        this._missStreak++;
        if (this._previewEnabled &&
            this._missStreak >= CONSECUTIVE_RESULTS_TO_TOGGLE) {
            this._previewEnabled = false;
            console.warn(
                'tessera: gesture progress predictions ' +
                'disagreed with real outcomes; pausing live swipe preview ' +
                '(indicator updates on gesture end; auto re-enables once ' +
                'predictions match again)');
        }
    }
}
