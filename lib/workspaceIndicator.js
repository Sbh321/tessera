// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {buildCssDeclarations, isValidHexColor, workspaceLabel} from './utils.js';
import {GestureProgressTracker} from './gestureProgressTracker.js';

// GNOME's stock accent blue, used only as a last-resort inline value (see
// _resolveBackgroundColor below) when the system accent color can't be
// determined at all (non-Yaru theme). The active square's colors are
// ALWAYS resolved to concrete inline values -- never left to a stylesheet
// class rule -- because class-rule colors leaked through St's style
// transitions as a wrong-color flash during fast switches (see
// stylesheet.css and setActive below).
const FALLBACK_ACTIVE_HEX = '#3584e4';

/**
 * A single numbered square. Mirrors WorkspaceThumbnail from GNOME's bundled
 * workspace-indicator extension in structure (St.Button, click activates the
 * workspace) but renders a number instead of a live window preview.
 */
const Tessera = GObject.registerClass(
class Tessera extends St.Button {
    constructor(index, settingsManager, accentColorTracker) {
        super({
            style_class: 'tessera-square',
            label: workspaceLabel(settingsManager.labelStyle, index),
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._index = index;
        this._settingsManager = settingsManager;
        this._accentColorTracker = accentColorTracker;
        this._active = false;

        this.connect('clicked', () => this._activate());
        this.applySettings();
    }

    get index() {
        return this._index;
    }

    setActive(active) {
        if (this._active === active)
            return;

        // Inline style before class toggle, never the other way around:
        // the inline style is what carries the real colors, and St's
        // transition engine keys off every intermediate style state. With
        // the class flipped first, the square briefly resolves to the bare
        // .active class rules (stale inline colors), and the 100ms
        // transition starts animating toward that -- which is exactly the
        // wrong-color flash users saw on fast Super+Number switches.
        this._active = active;
        this.applySettings();

        if (active)
            this.add_style_class_name('active');
        else
            this.remove_style_class_name('active');
    }

    applySettings() {
        const s = this._settingsManager;
        const outline = s.indicatorStyle === 'outline';

        const label = workspaceLabel(s.labelStyle, this._index);
        if (this.label !== label)
            this.label = label;

        if (outline)
            this.add_style_class_name('outline');
        else
            this.remove_style_class_name('outline');

        const backgroundColor = this._resolveBackgroundColor();
        const textColor = this._resolveTextColor(backgroundColor, outline);

        // In outline mode there is no fill, so the "background" color
        // setting is reused as the outline color instead.
        this.set_style(buildCssDeclarations({
            'min-width': `${s.squareSize}px`,
            'min-height': `${s.squareSize}px`,
            'border-radius': `${s.squareBorderRadius}px`,
            'padding': `${s.squarePadding}px`,
            'font-size': `${s.fontSize}pt`,
            'font-weight': s.fontWeight,
            'background-color': !outline && isValidHexColor(backgroundColor)
                ? backgroundColor : null,
            'border-color': outline && isValidHexColor(backgroundColor)
                ? backgroundColor : null,
            'color': isValidHexColor(textColor) ? textColor : null,
        }));
    }

    _activate() {
        const workspace = global.workspace_manager.get_workspace_by_index(this._index);
        if (workspace)
            workspace.activate(global.get_current_time());
    }

    // A user-set active-background-color always wins; otherwise the active
    // square follows the system accent color (see lib/accentColor.js).
    // Always returns a valid hex when active -- never null/empty -- so the
    // inline background-color is never omitted (see FALLBACK_ACTIVE_HEX
    // above for why that matters). Inactive squares never use the accent
    // color and keep falling back to the CSS theme default via null.
    _resolveBackgroundColor() {
        const s = this._settingsManager;
        if (!this._active)
            return s.inactiveBackgroundColor;

        if (isValidHexColor(s.activeBackgroundColor))
            return s.activeBackgroundColor;

        return this._accentColorTracker.hex ?? FALLBACK_ACTIVE_HEX;
    }

    // Like the background, the ACTIVE text color is always resolved to a
    // concrete inline value rather than left to a stylesheet class rule --
    // the old .active rules hardcoded GNOME's default blue / plain white,
    // which showed through (statically in outline mode, as a transition
    // flash in filled mode) whenever the real accent color wasn't blue.
    // Inactive squares keep falling back to the theme default via null.
    _resolveTextColor(activeColor, outline) {
        const s = this._settingsManager;
        if (!this._active)
            return s.inactiveTextColor;

        if (isValidHexColor(s.activeTextColor))
            return s.activeTextColor;

        // Outline mode has no fill, so the label itself takes the accent
        // color; filled mode gets white text on the accent fill.
        return outline ? activeColor : '#ffffff';
    }
});

/**
 * Panel indicator: a row of Tessera buttons reflecting
 * global.workspace_manager. No popup menu — squares are always visible
 * directly in the panel, Hyprland-style.
 */
export const WorkspaceIndicator = GObject.registerClass(
class WorkspaceIndicator extends PanelMenu.Button {
    constructor(settingsManager, accentColorTracker) {
        super(0.5, _('Tessera'), true);

        this._settingsManager = settingsManager;
        this._accentColorTracker = accentColorTracker;
        this._squares = [];

        this._box = new St.BoxLayout({
            style_class: 'tessera-box',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        // workspaces-reordered: the active workspace object keeps its
        // identity but its *index* changes (overview thumbnail drag,
        // Main.wm.insertWorkspace during a move-to-new-workspace action),
        // and neither of the other two signals fires for it.
        global.workspace_manager.connectObject(
            'notify::n-workspaces', () => this._rebuild(),
            'workspace-switched', () => this._syncActive(),
            'workspaces-reordered', () => this._syncActive(),
            this);

        this._settingsManager.gsettings.connectObject(
            'changed::square-spacing', () => this._applySpacing(),
            'changed::square-size', () => this._applyAllSquareSettings(),
            'changed::square-border-radius', () => this._applyAllSquareSettings(),
            'changed::square-padding', () => this._applyAllSquareSettings(),
            'changed::font-size', () => this._applyAllSquareSettings(),
            'changed::font-weight', () => this._applyAllSquareSettings(),
            'changed::indicator-style', () => this._applyAllSquareSettings(),
            'changed::label-style', () => this._applyAllSquareSettings(),
            'changed::active-background-color', () => this._applyAllSquareSettings(),
            'changed::inactive-background-color', () => this._applyAllSquareSettings(),
            'changed::active-text-color', () => this._applyAllSquareSettings(),
            'changed::inactive-text-color', () => this._applyAllSquareSettings(),
            'changed::show-empty-workspaces', () => this._rebuild(),
            this);

        this._accentColorTracker.gsettings.connectObject(
            'changed::gtk-theme', () => this._applyAllSquareSettings(),
            this);

        this._gestureProgressTracker = new GestureProgressTracker();
        this._gestureProgressTracker.enable(index => this._setActiveIndex(index));

        this._applySpacing();
        this._rebuild();
    }

    _onDestroy() {
        this._gestureProgressTracker.disable();
        super._onDestroy();
    }

    // The indicator takes over the hidden Activities button's job (see
    // lib/nativeIndicatorHider.js): clicking it toggles the overview and
    // scrolling over it switches workspaces. Both mirror the stock
    // ActivitiesButton verbatim (extracted js/ui/panel.js), including the
    // shouldToggleByCornerOrButton() guard (no toggling mid-animation or
    // on the lock screen). The squares are St.Buttons that consume the
    // press/release events they handle, so a click only reaches here from
    // the outer hover patch -- the padding around and between the squares
    // -- never from a square itself (which switches workspace instead).
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.TOUCH_END ||
            event.type() === Clutter.EventType.BUTTON_RELEASE) {
            if (Main.overview.shouldToggleByCornerOrButton())
                Main.overview.toggle();
        }

        return Main.wm.handleWorkspaceScroll(event);
    }

    // Keyboard parity with the stock button (Ctrl+Alt+Tab to the top
    // bar, then Return/space on the focused indicator).
    vfunc_key_release_event(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_space) {
            if (Main.overview.shouldToggleByCornerOrButton()) {
                Main.overview.toggle();
                return Clutter.EVENT_STOP;
            }
        }
        return super.vfunc_key_release_event(event);
    }

    _applySpacing() {
        this._box.set_style(`spacing: ${this._settingsManager.squareSpacing}px;`);
    }

    _rebuild() {
        this._box.destroy_all_children();
        this._squares = [];

        const workspaceManager = global.workspace_manager;
        let count = workspaceManager.n_workspaces;

        // Mutter keeps one empty trailing workspace when dynamic workspaces
        // are on; hide it if the user doesn't want it rendered.
        const activeIndex = workspaceManager.get_active_workspace_index();
        if (!this._settingsManager.showEmptyWorkspaces && count > 1 && activeIndex !== count - 1) {
            const lastWorkspace = workspaceManager.get_workspace_by_index(count - 1);
            if (lastWorkspace && lastWorkspace.list_windows().length === 0)
                count -= 1;
        }

        for (let i = 0; i < count; i++) {
            const square = new Tessera(i, this._settingsManager, this._accentColorTracker);
            this._box.add_child(square);
            this._squares.push(square);
        }

        this._syncActive();
    }

    // Authoritative sync, called on workspace-switched (gesture-end,
    // keyboard, or click) and whenever squares are rebuilt.
    _syncActive() {
        this._setActiveIndex(global.workspace_manager.get_active_workspace_index());
    }

    // Also called by GestureProgressTracker as a live, self-correcting
    // preview during an in-progress 3-finger swipe -- see
    // lib/gestureProgressTracker.js.
    _setActiveIndex(activeIndex) {
        for (const square of this._squares)
            square.setActive(square.index === activeIndex);
    }

    _applyAllSquareSettings() {
        for (const square of this._squares)
            square.applySettings();
    }
});
