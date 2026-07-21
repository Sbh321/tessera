// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// How often the reveal/conceal decision is re-evaluated while auto-hide
// is active. One cheap global.get_pointer() call per tick answers every
// input this feature needs (pointer position AND held modifiers), so a
// single low-frequency poll replaces what would otherwise be a web of
// barriers, hot-edge actors, and global key grabs -- and, like every
// recompute-from-ground-truth loop in this project, it cannot get stuck
// in a stale state: whatever a tick misses, the next one corrects.
const POLL_INTERVAL_MS = 100;

// How tall the invisible "hot edge" band at the top of the primary
// monitor is while the panel is hidden.
const REVEAL_EDGE_PX = 1;

// The exact background declaration this module contributes to
// Main.panel.style, and a matcher for stripping it back out. The shell
// OWNS that property: overview.js overwrites it with a
// transition-duration during gesture transitions and resets it to null
// in _hideDone() after every overview exit (verified in this install's
// extracted js/ui/overview.js). So the opacity style can never be
// "set and forget" -- it is composed into whatever the shell currently
// has and re-asserted from notify::style whenever the shell clobbers it.
//
// The declaration ALSO pins `transition-duration: 0ms`. The stock theme
// sets `#panel { transition-duration: 250ms }` permanently (verified in
// the extracted gnome-shell-dark.css), and the panel background is solid
// black. So every time overview.js clobbers Main.panel.style -- dropping
// our rgba -- the panel's computed background reverts to that solid
// black, and when our notify::style handler re-adds the rgba the change
// *animates* back over 250ms instead of snapping. That eased fade,
// solid-black -> translucent on every overview exit, is exactly the
// "split-second flash" the panel shows on a 3-finger swipe out of the
// overview. Pinning the panel's own transition to 0 makes the background
// snap; there is nothing we ever want to animate on a constant-color
// background, so no visual is lost. See docs/GNOME_NOTES.md.
const opacityDecl = alpha =>
    `background-color: rgba(0, 0, 0, ${alpha}); transition-duration: 0ms;`;
const OPACITY_DECL_RE =
    /\s*background-color: rgba\(0, 0, 0, [0-9.]+\); transition-duration: 0ms;/;
// Any transition-duration declaration, ours or the shell's. Stripped
// from the base while the feature is active so the panel background
// carries ONLY our `transition-duration: 0ms` -- never the theme's or
// overview's 250ms, which is what would animate (flash) our re-applied
// background. Never stripped while the feature is off (opacity 100),
// preserving this module's zero-footprint-when-idle guarantee.
const TRANSITION_DURATION_RE = /\s*transition-duration:\s*\d+m?s;?/g;

// panelBox's original chrome-tracking parameters, verbatim from this
// install's extracted js/ui/layout.js (addChrome(panelBox,
// {affectsStruts: true, trackFullscreen: true}) plus the
// affectsInputRegion: true default) -- what disable() must restore.
const PANEL_BOX_CHROME_PARAMS = {
    affectsStruts: true,
    trackFullscreen: true,
    affectsInputRegion: true,
};

/**
 * Dock-style auto-hide for the GNOME top panel: the panel slides off the
 * top edge and slides back in when the pointer touches that edge or
 * while the Super key is held. Off by default (`panel-autohide`); with
 * the setting off (and `panel-opacity` at its default 100) this module
 * has zero footprint beyond two settings signals.
 *
 * Auto-hide never restyles, reparents, or hides the panel -- only its
 * `translation_y` moves, which is the exact property GNOME's own
 * startup animation slides the panel with (layout.js), and deliberately
 * NOT `visible`, which layout.js owns for trackFullscreen chrome and
 * force-reasserts (the lesson learned on the stacked tab bar -- see
 * docs/GNOME_NOTES.md). Fullscreen therefore keeps working exactly as
 * GNOME intends: layout.js hides the panelBox itself, and this module
 * never reveals while it is invisible.
 *
 * Reclaiming the panel's screen space uses only public LayoutManager
 * API: untrackChrome() + trackChrome() re-registers the panelBox with
 * `affectsStruts: false` while auto-hide is on (windows extend to the
 * top edge; the revealed panel overlays them, exactly like Ubuntu
 * Dock's autohide) and restores the original parameters on disable.
 * The resulting `workareas-changed` retiles tiled workspaces
 * automatically -- no coupling to the tiling subsystem needed.
 *
 * The reveal conditions, evaluated per poll tick (and immediately on
 * overview showing/hiding and session-mode changes, the triggers where
 * poll latency shows):
 * - the session is locked (the unlock dialog's panel must be visible
 *   and stock; auto-hide stays active so struts never churn on
 *   lock/unlock), or
 * - the overview is shown or being shown (visibleTarget -- flips false
 *   the moment it starts closing, so the conceal starts with the
 *   overview's own zoom-out instead of after it), or
 * - the active workspace is empty (no unminimized window on the primary
 *   monitor -- there is nothing for the panel to obscure), or
 * - Super is held (MOD4; a quick glance at the clock/indicators), or
 * - a panel menu is open (never yank a menu's anchor away), or
 * - keyboard focus is inside the panel (Ctrl+Alt+Tab navigation), or
 * - the pointer is inside the panel strip (revealed) / touching the
 *   top hot edge (hidden -- the asymmetry is the hysteresis that
 *   prevents flapping at the boundary).
 *
 * Independent of auto-hide, this module also applies `panel-opacity`:
 * below 100 a rgba(0,0,0,a) background declaration is composed into
 * `Main.panel.style` -- composed, not assigned, and re-asserted from
 * notify::style, because overview.js overwrites that property wholesale
 * on overview transitions (see OPACITY_DECL_RE above). The declaration
 * also pins `transition-duration: 0ms`, so the re-applied background
 * snaps rather than fading through the theme's permanent 250ms panel
 * transition (which otherwise flashed on every overview exit). At the
 * default 100 nothing is ever written and the shell fully owns its style.
 */
export class PanelAutoHideManager {
    constructor(settingsManager) {
        this._settingsManager = settingsManager;

        this._active = false;    // auto-hide currently applied to the shell
        this._revealed = true;   // current slide state while active
        this._pollId = null;
        this._settingsSignalId = null;
        this._opacitySignalId = null;
        this._panelStyleSignalId = null;
        this._sessionModeSignalId = null;
        this._overviewSignalIds = [];
    }

    enable() {
        this._settingsSignalId = this._settingsManager.gsettings.connect(
            'changed::panel-autohide', () => this._sync());
        this._opacitySignalId = this._settingsManager.gsettings.connect(
            'changed::panel-opacity', () => this._applyOpacity());
        // Re-assert the opacity background whenever anything (in
        // practice: overview.js, on every overview exit) rewrites the
        // panel's inline style. _applyOpacity is idempotent and only
        // writes when the current style is missing the declaration, so
        // its own set_style() does not re-trigger this handler.
        this._panelStyleSignalId = Main.panel.connect(
            'notify::style', () => this._applyOpacity());
        // Lock/unlock transitions (the extension stays enabled across
        // them -- metadata session-modes): the opacity styling defers to
        // the lock screen's own panel style, and an active auto-hide
        // force-reveals the panel while locked (see _shouldReveal), so
        // re-evaluate both immediately instead of waiting a poll tick.
        this._sessionModeSignalId = Main.sessionMode.connect('updated', () => {
            this._applyOpacity();
            if (this._active)
                this._poll();
        });
        this._sync();
        this._applyOpacity();
    }

    disable() {
        if (this._settingsSignalId !== null) {
            this._settingsManager.gsettings.disconnect(this._settingsSignalId);
            this._settingsSignalId = null;
        }
        if (this._opacitySignalId !== null) {
            this._settingsManager.gsettings.disconnect(this._opacitySignalId);
            this._opacitySignalId = null;
        }
        if (this._panelStyleSignalId !== null) {
            Main.panel.disconnect(this._panelStyleSignalId);
            this._panelStyleSignalId = null;
        }
        if (this._sessionModeSignalId !== null) {
            Main.sessionMode.disconnect(this._sessionModeSignalId);
            this._sessionModeSignalId = null;
        }
        this._removeOpacityStyle();
        this._deactivate();
    }

    _sync() {
        if (this._settingsManager.panelAutohide)
            this._activate();
        else
            this._deactivate();
    }

    _activate() {
        if (this._active)
            return;
        this._active = true;

        // Swap the panelBox's strut participation off so windows (and
        // the tiler, via workareas-changed) reclaim the top space.
        // untrackChrome/trackChrome are the public, documented way to
        // change tracking parameters; _trackActor reconnects the same
        // lifecycle signals and queues the region update itself.
        const panelBox = Main.layoutManager.panelBox;
        Main.layoutManager.untrackChrome(panelBox);
        Main.layoutManager.trackChrome(panelBox,
            {...PANEL_BOX_CHROME_PARAMS, affectsStruts: false});

        // Start revealed and let the first tick decide -- if the
        // pointer is away and no reveal condition holds, the panel
        // slides out with the normal animation rather than vanishing.
        this._revealed = true;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            POLL_INTERVAL_MS, () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            });

        // The overview transitions are the one reveal/conceal trigger
        // where waiting out the poll tick is visible (the panel would
        // hang around up to 100ms after the overview starts closing),
        // so re-evaluate immediately on them.
        this._overviewSignalIds = [
            Main.overview.connect('showing', () => this._poll()),
            Main.overview.connect('hiding', () => this._poll()),
        ];
    }

    _deactivate() {
        if (!this._active)
            return;
        this._active = false;

        if (this._pollId !== null) {
            GLib.Source.remove(this._pollId);
            this._pollId = null;
        }

        for (const id of this._overviewSignalIds)
            Main.overview.disconnect(id);
        this._overviewSignalIds = [];

        const panelBox = Main.layoutManager.panelBox;
        panelBox.remove_transition('translation-y');
        panelBox.translation_y = 0;
        this._revealed = true;

        Main.layoutManager.untrackChrome(panelBox);
        Main.layoutManager.trackChrome(panelBox, PANEL_BOX_CHROME_PARAMS);
    }

    _poll() {
        const panelBox = Main.layoutManager.panelBox;

        // Fullscreen (or any other state where layout.js decided the
        // panel is not shown): the box is invisible, translation is
        // moot, and revealing over a fullscreen window would be wrong.
        // Leave the slide state exactly as it is until it returns.
        if (!panelBox.visible)
            return;

        this._setRevealed(this._shouldReveal(panelBox), panelBox);
    }

    _shouldReveal(panelBox) {
        // Locked (unlock-dialog session mode): the lock screen's own
        // panel (clock, battery...) must be visible and stock. Auto-hide
        // stays ACTIVE across the lock -- deactivating would restore the
        // strut and reflow/retile every window on each lock and again on
        // each unlock -- it just holds the panel revealed until the
        // session unlocks, then the normal conditions resume.
        if (Main.sessionMode.isLocked)
            return true;

        // visibleTarget, not visible: `visible` stays true until the
        // overview's zoom-out animation completes, while visibleTarget
        // flips the moment hiding begins -- so the panel's slide-out
        // starts together with the overview's own animation instead of
        // trailing it.
        if (Main.overview.visibleTarget)
            return true;

        // An empty workspace has nothing for the panel to obscure, so
        // keep it visible. The strut stays released while auto-hide is
        // active, so the first window to open still gets the full
        // height -- the panel just slides away over it.
        if (this._workspaceIsEmpty())
            return true;

        const [pointerX, pointerY, modifiers] = global.get_pointer();

        // Super held: on this install Super is MOD4 (the standard X11
        // and Mutter mapping); SUPER_MASK is included defensively for
        // stacks that report it as a virtual modifier instead.
        if (modifiers &
            (Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK))
            return true;

        // An open panel menu (calendar, quick settings...) extends
        // below the panel; hiding would tear the menu off its anchor.
        if (Main.panel.menuManager.activeMenu)
            return true;

        // Keyboard navigation into the top bar (Ctrl+Alt+Tab).
        const keyFocus = global.stage.get_key_focus();
        if (keyFocus && panelBox.contains(keyFocus))
            return true;

        // Pointer geometry, relative to the panel's untranslated home
        // (panelBox.x/y are stage coordinates at the primary monitor's
        // top edge; translation_y does not affect them). Hysteresis:
        // once revealed, the whole panel strip keeps it open; while
        // hidden, only the thin top edge reveals.
        if (pointerX < panelBox.x || pointerX >= panelBox.x + panelBox.width)
            return false;
        const band = this._revealed
            ? panelBox.height : REVEAL_EDGE_PX;
        return pointerY < panelBox.y + band;
    }

    // "Empty" from the panel's point of view: no unminimized,
    // taskbar-worthy window on the primary monitor (the only monitor
    // the panel occupies) in the active workspace.
    _workspaceIsEmpty() {
        const primaryMonitor = Main.layoutManager.primaryIndex;
        return !global.workspace_manager.get_active_workspace()
            .list_windows()
            .some(w => !w.minimized && !w.is_skip_taskbar() &&
                w.get_monitor() === primaryMonitor);
    }

    // Bring Main.panel.style into agreement with the panel-opacity
    // setting without disturbing whatever else the shell has put there
    // (overview.js writes transition-duration declarations during
    // gesture transitions). The stock top bar background is solid black
    // in every GNOME theme variant, so rgba(0,0,0,a) fades the default
    // look faithfully. Idempotent: writes only when the style actually
    // differs, so calling it from notify::style cannot loop.
    _applyOpacity() {
        // While locked, the lock screen's own panel styling (the
        // 'unlock-screen' panelStyle class) owns the look entirely --
        // contribute nothing, and strip any declaration already there.
        const percent = Main.sessionMode.isLocked
            ? 100 : this._settingsManager.panelOpacity;
        const current = Main.panel.get_style() ?? '';

        let desired;
        if (percent >= 100) {
            // Feature off (or locked): remove ONLY our own declaration and
            // leave everything else -- including any transition-duration
            // the shell put there -- exactly as the shell has it, so the
            // panel is bit-for-bit stock whenever this feature is idle.
            const base = current.replace(OPACITY_DECL_RE, '').trim();
            desired = base || null;
        } else {
            // Active: strip our declaration AND any transition-duration
            // (the theme's permanent 250ms and overview.js's inline
            // re-assertions), then compose ours -- which re-pins the
            // transition to 0ms so the background snaps rather than fades
            // when overview clobbers and we restore it (see the flash
            // explanation on opacityDecl above).
            const base = current
                .replace(OPACITY_DECL_RE, '')
                .replace(TRANSITION_DURATION_RE, '')
                .trim();
            desired = base
                ? `${base} ${opacityDecl(percent / 100)}`
                : opacityDecl(percent / 100);
        }

        if ((current || null) !== desired)
            Main.panel.set_style(desired);
    }

    _removeOpacityStyle() {
        const current = Main.panel.get_style();
        if (current === null)
            return;
        const base = current.replace(OPACITY_DECL_RE, '').trim();
        Main.panel.set_style(base || null);
    }

    _setRevealed(revealed, panelBox) {
        const target = revealed ? 0 : -panelBox.height;

        if (this._revealed !== revealed) {
            // State flip: run the slide. The duration comes from the
            // `panel-slide-time` setting, read per animation so changes
            // apply to the very next slide; one value and one symmetric
            // EASE_IN_OUT curve for both directions so reveal and
            // conceal feel identical (ease-out front-loads the motion,
            // which reads as a snap on the way in). ease() replaces any
            // opposing slide already in flight, retargeting from the
            // current position -- no snap on quick direction reversals.
            this._revealed = revealed;
            panelBox.ease({
                translation_y: target,
                duration: this._settingsManager.panelSlideTime,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            });
            return;
        }

        // Same state: the panel's height can still change under a
        // hidden panel (scale/font changes), so snap the offset back
        // into agreement -- but NEVER while a slide is running, since
        // a direct property set kills the running implicit transition.
        // Clutter keys implicit transitions by the property's canonical
        // DASHED name: get_transition('translation_y') always returns
        // null (the shell's own ease() converts underscores to dashes
        // before this exact lookup, environment.js _easeActor), and
        // with the wrong name this guard fired one poll tick into every
        // slide, truncating it at ~100ms regardless of the configured
        // duration.
        if (!panelBox.get_transition('translation-y') &&
            panelBox.translation_y !== target)
            panelBox.translation_y = target;
    }
}
