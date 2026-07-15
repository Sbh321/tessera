// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

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
 * Tabs share the bar width equally and ellipsize their labels, the same
 * overflow behavior as browser tabs (and as Hyprland's own tab bar,
 * which likewise shrinks title segments rather than scrolling).
 *
 * Title changes are tracked per-tab with connectObject bound to the tab
 * button itself, so destroying a tab (or the whole bar) disconnects
 * everything automatically -- no manual signal bookkeeping to leak.
 */
export const StackTabBar = GObject.registerClass(
class StackTabBar extends St.BoxLayout {
    constructor() {
        super({
            style_class: 'tessera-stack-bar',
            reactive: true,
        });

        // Meta.Window -> St.Button, for incremental updates: title and
        // active-state changes touch one child; only a changed window
        // *set or order* rebuilds the tab row.
        this._tabs = new Map();
        this._activeWindow = null;
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

        this.destroy_all_children();
        this._tabs.clear();

        for (const window of windows) {
            const tab = this._buildTab(window);
            this._tabs.set(window, tab);
            this.add_child(tab);
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
            text: window.title ?? '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
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
});
