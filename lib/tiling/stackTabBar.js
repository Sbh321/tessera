// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

// How far one wheel notch moves the strip, in pixels -- about one tab.
const WHEEL_STEP = 120;

// Room left beside a tab that had to be scrolled into view, so it never
// sits flush against the edge looking clipped.
const SCROLL_MARGIN = 12;

// Width of the fade painted over an edge that has more tabs beyond it
// -- the bar's overflow cue, in place of a scrollbar.
const FADE_WIDTH = 32;

/**
 * The stacked-mode tab bar: one browser-style tab per tiled window on a
 * stacked workspace, active tab highlighted, click to raise/focus.
 * Purely presentational -- it never computes layout or tracks windows
 * itself; TilingManager tells it the window list (setWindows) and the
 * focused window (setActiveWindow), and clicking a tab just calls
 * Meta.Window.activate(), letting GNOME's normal focus/raise rules do
 * the rest (which TilingManager then observes via notify::focus-window,
 * closing the loop -- there is deliberately no local selected-tab
 * state to drift out of sync).
 *
 * Tabs keep their natural width and are never truncated. While they
 * fit they share the bar equally, like browser tabs; once they do not,
 * the strip scrolls horizontally, with a faded edge wherever more tabs
 * lie beyond it, rather than squeezing every title down to an ellipsis
 * -- a bar of "Goo…", "Goo…", "Goo…" tells you nothing. There is no
 * scrollbar: the wheel scrolls it, and the active tab is kept in view,
 * so the tab you are on is never off the edge.
 *
 * The bar's HEIGHT is fixed by the layout engine (STACK_TAB_BAR_HEIGHT)
 * and nothing here changes it, so the windows below never reflow
 * because a tab was opened.
 *
 * Title changes are tracked per-tab with connectObject bound to the tab
 * button itself, so destroying a tab (or the whole bar) disconnects
 * everything automatically -- no manual signal bookkeeping to leak.
 */
export const StackTabBar = GObject.registerClass(
class StackTabBar extends St.ScrollView {
    constructor() {
        const strip = new St.BoxLayout({
            style_class: 'tessera-stack-bar-strip',
            x_expand: true,
        });

        super({
            style_class: 'tessera-stack-bar',
            reactive: true,
            // EXTERNAL: scrollable, but no scrollbar of its own -- the
            // fade below is the overflow cue.
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            child: strip,
        });

        // St fades an edge only while there is content beyond it.
        this.update_fade_effect(new Clutter.Margin({left: FADE_WIDTH, right: FADE_WIDTH}));

        this._strip = strip;
        // Meta.Window -> St.Button, for incremental updates: title and
        // active-state changes touch one child; only a changed window
        // *set or order* rebuilds the tab row.
        this._tabs = new Map();
        this._activeWindow = null;

        this.connect('scroll-event', (_actor, event) => this._onScroll(event));
        // A fresh strip has no allocation to scroll within; once it is
        // laid out (and whenever the bar is resized) bring the active
        // tab back into view.
        strip.connect('notify::allocation', () => this._scrollToActive());
    }

    /**
     * Sync the tab row to `windows` (already filtered and ordered by the
     * manager). Rebuilds only when the set or order actually changed.
     *
     * @param {Meta.Window[]} windows tiled windows on the stacked bucket
     */
    setWindows(windows) {
        const current = [...this._tabs.keys()];
        const unchanged = current.length === windows.length &&
            current.every((w, i) => w === windows[i]);
        if (unchanged)
            return;

        this._strip.destroy_all_children();
        this._tabs.clear();

        for (const window of windows) {
            const tab = this._buildTab(window);
            this._tabs.set(window, tab);
            this._strip.add_child(tab);
        }

        this.setActiveWindow(this._activeWindow);
    }

    /**
     * Highlight the tab of `window` (or none). Called by the manager on
     * every focus change; also re-applied after rebuilds.
     *
     * @param {?Meta.Window} window the focused toplevel, if any
     */
    setActiveWindow(window) {
        this._activeWindow = window;
        for (const [tabWindow, tab] of this._tabs) {
            if (tabWindow === window)
                tab.add_style_class_name('active');
            else
                tab.remove_style_class_name('active');
        }
        this._scrollToActive();
    }

    _buildTab(window) {
        const tab = new St.Button({
            style_class: 'tessera-stack-tab',
            can_focus: true,
            x_expand: true,
        });

        const box = new St.BoxLayout({
            style_class: 'tessera-stack-tab-content',
            x_align: Clutter.ActorAlign.CENTER,
        });

        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const icon = app?.create_icon_texture(16) ?? null;
        if (icon)
            box.add_child(icon);

        const label = new St.Label({
            style_class: 'tessera-stack-tab-label',
            text: window.title ?? '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Never ellipsized: St labels ellipsize by default, which makes
        // their minimum width a few pixels, and a scrollable St box
        // extends only as far as its children's MINIMUM widths -- so an
        // ellipsizable title gets squeezed instead of scrolled. With
        // ellipsizing off the minimum is the full text and the strip
        // grows to hold it.
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(label);

        tab.set_child(box);

        // Bound to the tab button: destroying the tab disconnects it.
        window.connectObject('notify::title', () => {
            label.text = window.title ?? '';
        }, tab);

        tab.connect('clicked', () => {
            window.activate(global.get_current_time());
        });

        return tab;
    }

    /**
     * The wheel scrolls the strip whichever way it turns: a vertical
     * wheel is the only one most mice have, and a horizontal-only bar
     * has nothing else to do with it.
     */
    _onScroll(event) {
        const adjustment = this.hadjustment;
        if (!adjustment)
            return Clutter.EVENT_PROPAGATE;

        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            delta = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            delta = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            delta = dx !== 0 ? dx : dy;
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        if (delta === 0)
            return Clutter.EVENT_PROPAGATE;

        const [value, lower, upper, , , pageSize] = adjustment.get_values();
        const limit = Math.max(lower, upper - pageSize);
        adjustment.set_value(Math.max(lower, Math.min(limit, value + delta * WHEEL_STEP)));
        return Clutter.EVENT_STOP;
    }

    // Keeps the active tab inside the visible strip. Horizontal, so
    // GNOME's own ensureActorVisibleInScrollView (vertical only) does
    // not apply; the arithmetic is the same, on the other axis.
    _scrollToActive() {
        const tab = this._activeWindow ? this._tabs.get(this._activeWindow) : null;
        const adjustment = this.hadjustment;
        if (!tab || !adjustment)
            return;

        const [value, , upper, , , pageSize] = adjustment.get_values();
        if (pageSize <= 0)
            return;

        const box = tab.get_allocation_box();
        if (box.x1 < value)
            adjustment.set_value(Math.max(0, box.x1 - SCROLL_MARGIN));
        else if (box.x2 > value + pageSize)
            adjustment.set_value(Math.min(Math.max(0, upper - pageSize),
                box.x2 - pageSize + SCROLL_MARGIN));
    }
});
