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

// Every tab in the bar is the same width, browser-style: the bar's width
// shared equally, clamped to this range. The cap keeps two tabs on a
// wide monitor from becoming half-screen slabs (and stops one long title
// from claiming more room than its neighbours); the floor keeps a tab
// wide enough to show an icon, the start of its title and its close
// button before the strip starts scrolling instead of shrinking.
const TAB_MIN_WIDTH = 112;
const TAB_MAX_WIDTH = 240;

// Fallbacks for the CSS geometry consulted when sizing tabs, used only
// until the bar has a theme node (a bar sized before it is on stage).
const DEFAULT_BAR_PADDING = 3;
const DEFAULT_TAB_SPACING = 3;

/**
 * The stacked-mode tab bar: one browser-style tab per tiled window on a
 * stacked workspace, active tab highlighted, click to raise/focus,
 * middle-click (a three-finger tap on a touchpad) or the tab's own close
 * button to close the window. Purely presentational -- it never
 * computes layout or tracks windows itself; TilingManager tells it the
 * window list (setWindows) and the focused window (setActiveWindow),
 * and clicking a tab just calls Meta.Window.activate(), letting GNOME's
 * normal focus/raise rules do the rest (which TilingManager then
 * observes via notify::focus-window, closing the loop -- there is
 * deliberately no local selected-tab state to drift out of sync).
 * Closing likewise only asks the window to close (Meta.Window.delete);
 * the tab disappears when the manager observes the window going away,
 * never before -- an app that prompts "save changes?" keeps its tab.
 *
 * Tabs are uniform: the bar's width is shared equally between them,
 * clamped to [TAB_MIN_WIDTH, TAB_MAX_WIDTH], and each title is
 * ellipsized to fit -- so a long-titled window never claims more of the
 * bar than its neighbours, as it did when tabs took their natural
 * widths. Once the tabs no longer fit at their minimum width the strip
 * scrolls horizontally, with a faded edge wherever more tabs lie beyond
 * it. There is no scrollbar: the wheel scrolls it, and the active tab is
 * kept in view, so the tab you are on is never off the edge.
 *
 * The bar's HEIGHT is fixed by the layout engine (STACK_TAB_BAR_HEIGHT)
 * and nothing here changes it, so the windows below never reflow
 * because a tab was opened.
 *
 * Title and attention changes are tracked per-tab with connectObject
 * bound to the tab button itself, so destroying a tab (or the whole
 * bar) disconnects everything automatically -- no manual signal
 * bookkeeping to leak.
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
        // Tab widths derive from the bar's width (set by the manager)
        // and its CSS padding/spacing (known once styled): recompute on
        // either, and on a rebuild.
        this.connect('notify::width', () => this._layoutTabs());
        this.connect('style-changed', () => this._layoutTabs());
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

        this._layoutTabs();
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
            // Left and middle buttons: a left click activates, a middle
            // click closes (browser convention; libinput reports a
            // three-finger touchpad tap or click as a middle click).
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
        });

        const box = new St.BoxLayout({
            style_class: 'tessera-stack-tab-content',
            x_expand: true,
        });

        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const icon = app?.create_icon_texture(16) ?? null;
        if (icon) {
            icon.y_align = Clutter.ActorAlign.CENTER;
            box.add_child(icon);
        }

        const label = new St.Label({
            style_class: 'tessera-stack-tab-label',
            text: window.title ?? '',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Tabs have a fixed width (_layoutTabs), so the title is what
        // gives: ellipsized at the end, like a browser tab.
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);

        const close = new St.Button({
            style_class: 'tessera-stack-tab-close',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: false,
        });
        // St.Button consumes the press it handles, so the tab beneath
        // never sees a click on its close button as an activate.
        close.connect('clicked', () => {
            window.delete(global.get_current_time());
        });
        box.add_child(close);

        tab.set_child(box);

        // Bound to the tab button: destroying the tab disconnects them.
        const syncAttention = () => {
            if (window.demands_attention || window.urgent)
                tab.add_style_class_name('attention');
            else
                tab.remove_style_class_name('attention');
        };
        window.connectObject(
            'notify::title', () => {
                label.text = window.title ?? '';
            },
            'notify::demands-attention', syncAttention,
            'notify::urgent', syncAttention,
            tab);
        syncAttention();

        tab.connect('clicked', (_actor, button) => {
            if (button === Clutter.BUTTON_MIDDLE)
                window.delete(global.get_current_time());
            else
                window.activate(global.get_current_time());
        });

        return tab;
    }

    // Give every tab the same width: the bar's content width shared
    // equally, clamped to [TAB_MIN_WIDTH, TAB_MAX_WIDTH]. Fixed widths
    // are what make the strip's natural width exceed the bar once the
    // tabs no longer fit at their minimum, which is what makes it
    // scroll; without the cap, few tabs would stretch to fill the bar.
    _layoutTabs() {
        const count = this._tabs.size;
        if (count === 0)
            return;

        const barNode = this.peek_theme_node();
        const stripNode = this._strip.peek_theme_node();
        const padding = barNode
            ? barNode.get_horizontal_padding()
            : 2 * DEFAULT_BAR_PADDING;
        const spacing = stripNode
            ? stripNode.get_length('spacing')
            : DEFAULT_TAB_SPACING;

        const available = this.width - padding - spacing * (count - 1);
        if (available <= 0)
            return;

        const width = Math.floor(Math.max(TAB_MIN_WIDTH,
            Math.min(TAB_MAX_WIDTH, available / count)));
        for (const tab of this._tabs.values()) {
            if (tab.width !== width)
                tab.set_width(width);
        }
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
