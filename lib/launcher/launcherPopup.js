// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    BACKDROP_OPACITY, BLUR_BRIGHTNESS, BLUR_RADIUS,
    CLOSE_DURATION_MS, OPEN_DURATION_MS,
} from './constants.js';
import {IntentType, resolveIntent} from './keyboardController.js';
import {LauncherList, sectionTitle} from './launcherUI.js';
import {ScopeBar} from './scopeBar.js';
import {ActivationMode, resultKey} from './searchResult.js';
import {clamp} from './utils.js';

// Where the card sits vertically on its monitor: high enough that a long
// result list still fits below it, low enough not to look pinned to the
// top edge. Matches the Spotlight/Raycast placement people expect.
const VERTICAL_ANCHOR = 0.16;

// Gap left between the card and the work-area edge when it is anchored
// left or right, so an edge-anchored launcher still reads as a floating
// panel rather than as something welded to the side of the screen.
const EDGE_MARGIN = 24;

// How much of the card a downward offset must leave on screen -- roughly
// the search entry plus a result row. The card's real height depends on
// how many results a search returns, so this is a floor rather than a
// measurement.
const MIN_VISIBLE_HEIGHT = 120;

// The card grows from slightly small, which reads as "arriving" rather
// than "appearing". Small enough that it never looks like a zoom.
const OPEN_SCALE = 0.97;

/**
 * The launcher window: a modal card with a search entry and a result
 * list, centered on the current monitor over a dimmed desktop.
 *
 * Built once, on first use, and then kept alive hidden -- reopening is
 * a show plus a grab rather than an actor-tree construction, which is
 * what keeps opening imperceptible after the first time.
 *
 * The popup owns exactly three things: the actor tree, the modal grab,
 * and the mapping from intents to calls. It does not search (that is
 * searchController), does not decide what keys mean (keyboardController),
 * and does not draw results (launcherUI).
 */
export const LauncherPopup = GObject.registerClass(
class LauncherPopup extends St.Widget {
    /**
     * @param {object} context the launcher's shared context
     * @param {import('./searchController.js').SearchController} controller
     * @param {import('./theme.js').LauncherTheme} theme
     */
    constructor(context, controller, theme) {
        super({
            visible: false,
            reactive: true,
            x: 0,
            y: 0,
        });

        this._context = context;
        this._controller = controller;
        this._theme = theme;

        this._grab = null;
        this._isOpen = false;
        this._searchSourceId = null;
        this._targetWindow = null;

        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        this._buildBackdrop();
        this._buildCard();

        Main.layoutManager.modalDialogGroup.add_child(this);

        // Async provider results arrive through the controller rather
        // than through search()'s return value.
        this._controller.onResults = sections => this._showSections(sections);
    }

    /**
     * The window that was focused when the launcher opened.
     *
     * Actions that operate on "the focused window" must use this rather
     * than reading focus when they run: the popup holds a modal grab, so
     * live focus during an activation is not necessarily the window the
     * user was looking at when they started typing.
     *
     * @returns {?Meta.Window}
     */
    get targetWindow() {
        return this._targetWindow;
    }

    get isOpen() {
        return this._isOpen;
    }

    /**
     * @returns {boolean} false when the modal grab could not be taken
     *   (another grab is already up, e.g. a panel menu) -- the caller
     *   simply does nothing in that case rather than half-opening.
     */
    open() {
        if (this._isOpen)
            return true;

        // Captured before the grab, while focus is still the user's.
        this._targetWindow = global.display.focus_window;

        // The overview is a full-screen surface of its own; leaving it up
        // behind the launcher would stack two "everything" UIs.
        if (Main.overview.visibleTarget)
            Main.overview.hide();

        this.applyTheme();
        this.reactive = true;
        this._backdrop.reactive = true;
        this.show();

        const grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        if (grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(grab);
            this.hide();
            return false;
        }

        this._grab = grab;
        this._isOpen = true;

        // Every open starts from the same place: no query, no filter.
        // A scope left over from last time would be invisible state
        // silently hiding results.
        this._controller.setScope(null);
        this._entry.set_text('');
        this._entry.grab_key_focus();
        this._refresh();
        this._animateOpen();

        return true;
    }

    close() {
        if (!this._isOpen)
            return;

        this._isOpen = false;
        this._cancelPendingSearch();

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        // The fade-out lasts long enough to swallow a click aimed at
        // whatever the launcher just opened, since the backdrop still
        // covers the screen while it plays. Going inert at the moment
        // the grab is released -- not when the animation ends -- means
        // the desktop is usable again immediately.
        this.reactive = false;
        this._backdrop.reactive = false;

        this._animateClose();
    }

    toggle() {
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    /** Re-reads every visual setting; safe to call while open. */
    applyTheme() {
        const metrics = this._theme.metrics;

        this._card.set_style(this._theme.cardStyle());
        this._entry.set_style(this._theme.entryStyle());
        this._footer.set_style(this._theme.footerStyle());
        this._footerHints.set_style(this._theme.hintStyle());
        this._syncSettingsButton();
        this._emptyLabel.set_style(this._theme.subtitleStyle());
        this._list.set_style(`max-height: ${metrics.maxHeight}px;`);
        this._list.applyTheme();
        this._scopeBar.applyTheme();
        this._syncBlur();

        // Compact mode drops the hint text but keeps the bar, so the
        // gear never disappears.
        this._footerHints.visible = !this._context.settings.launcherCompact;

        // Placement depends on the width and position settings, so it is
        // part of "apply the current appearance" rather than a separate
        // step -- which is what makes moving the launcher in Preferences
        // update an already-open popup.
        this._positionCard();
    }

    destroy() {
        this._cancelPendingSearch();

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        this._controller.onResults = null;
        this._list.destroyPool();
        this._scopeBar.destroyPool();
        super.destroy();
    }

    // --- Construction -----------------------------------------------------

    _buildBackdrop() {
        this._backdrop = new St.Widget({
            style_class: 'tessera-launcher-backdrop',
            reactive: true,
            opacity: 0,
        });
        this._backdrop.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        // Clicking anywhere outside the card dismisses, the one mouse
        // gesture every launcher is expected to honour.
        this._backdrop.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this.add_child(this._backdrop);
    }

    _buildCard() {
        this._card = new St.BoxLayout({
            style_class: 'tessera-launcher-card',
            vertical: true,
            reactive: true,
        });

        this._entry = new St.Entry({
            style_class: 'tessera-launcher-entry',
            hint_text: _('Search apps, windows, actions…'),
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({
            style_class: 'tessera-launcher-entry-icon',
            icon_name: 'edit-find-symbolic',
        }));
        this._entry.clutter_text.connect('text-changed', () => this._onTextChanged());
        this._entry.clutter_text.connect(
            'key-press-event', (actor, event) => this._onKeyPress(event));
        this._card.add_child(this._entry);

        this._scopeBar = new ScopeBar(this._theme);
        this._scopeBar.onScopeSelected = scope => this._onScopeSelected(scope);
        this._card.add_child(this._scopeBar);

        this._list = new LauncherList(this._theme, this._context.icons);
        this._list.onActivate = (result, mode) => this._activate(result, mode);
        this._list.onSelectionChanged = result => this._syncFooter(result);
        this._card.add_child(this._list);

        this._emptyLabel = new St.Label({
            style_class: 'tessera-launcher-empty',
            text: _('No results'),
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._card.add_child(this._emptyLabel);

        this._buildFooter();

        this.add_child(this._card);
    }

    /**
     * Places the card on the monitor the pointer is on: horizontally by
     * the position setting, vertically at the standard anchor plus the
     * user's offset.
     *
     * Both axes are resolved against the monitor's WORK AREA rather than
     * its full rectangle, so an edge-anchored launcher lands beside a
     * dock or side panel instead of underneath it, and a negative offset
     * cannot slide the card up behind the top panel. For a centered
     * launcher on a screen with no side struts the horizontal result is
     * identical to the raw monitor rectangle, so this changes nothing for
     * most setups.
     */
    /**
     * The bar along the bottom: key hints on the left, a settings gear
     * on the right.
     *
     * The gear stays even in compact mode, where the hints are hidden --
     * density is worth trading text for, but not the one affordance that
     * says "this thing is configurable". It is deliberately the only
     * pointer-only control in the popup; the keyboard path to the same
     * place is the "Tessera Preferences" action.
     */
    _buildFooter() {
        this._footerHints = new St.Label({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._settingsButton = new St.Button({
            style_class: 'tessera-launcher-icon-button',
            // The entry keeps key focus for the whole session.
            can_focus: false,
            child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}),
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Launcher settings'),
        });
        this._settingsButton.connect('clicked', () => this._openPreferences());
        this._settingsButton.connect('notify::hover',
            () => this._syncSettingsButton());

        this._footer = new St.BoxLayout({
            style_class: 'tessera-launcher-footer',
            x_expand: true,
        });
        this._footer.add_child(this._footerHints);
        this._footer.add_child(this._settingsButton);
        this._card.add_child(this._footer);
    }

    // Opens Preferences on the Launcher page. Closes first: the
    // preferences window is another window, and it cannot take focus
    // while this popup still holds the modal grab.
    _openPreferences() {
        this.close();
        this._context.tessera.openPreferences('launcher');
    }

    _syncSettingsButton() {
        this._settingsButton.set_style(
            this._theme.iconButtonStyle(this._settingsButton.hover));
    }

    _positionCard() {
        const monitor = Main.layoutManager.currentMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const {width, position, offsetY} = this._theme.metrics;

        let x;
        if (position === 'left')
            x = workArea.x + EDGE_MARGIN;
        else if (position === 'right')
            x = workArea.x + workArea.width - width - EDGE_MARGIN;
        else
            x = workArea.x + Math.round((workArea.width - width) / 2);

        x = clamp(x, workArea.x, workArea.x + Math.max(0, workArea.width - width));

        // The vertical anchor is a fraction of the MONITOR (a proportion
        // of the screen, not of whatever the panel left over), which the
        // offset then nudges: negative up, positive down.
        //
        // Clamping matters more here than horizontally, because the card
        // grows downwards as results come in and its final height is not
        // known when it is placed. Rather than guess at that height, the
        // bottom limit keeps at least MIN_VISIBLE_HEIGHT of it -- the
        // search entry and a row or two -- inside the work area. An
        // offset beyond that parks it at the limit instead of putting the
        // launcher somewhere the user cannot see, which would leave them
        // unable to reach the setting that did it.
        const anchorY = monitor.y + Math.round(monitor.height * VERTICAL_ANCHOR);
        const y = clamp(anchorY + offsetY, workArea.y,
            workArea.y + Math.max(0, workArea.height - MIN_VISIBLE_HEIGHT));

        this._card.set_position(Math.round(x), Math.round(y));
    }

    _syncBlur() {
        const wanted = this._context.settings.launcherBlur;
        const existing = this._card.get_effect('blur');

        if (wanted && !existing) {
            // BACKGROUND mode blurs what is *behind* the card, which is
            // why the card's own background color carries alpha. The
            // blur rectangle does not follow the rounded corners -- an
            // accepted, documented cosmetic limitation of St/Shell
            // blurring, not something an extension can fix.
            this._card.add_effect_with_name('blur', new Shell.BlurEffect({
                radius: BLUR_RADIUS,
                brightness: BLUR_BRIGHTNESS,
                mode: Shell.BlurMode.BACKGROUND,
            }));
        } else if (!wanted && existing) {
            this._card.remove_effect_by_name('blur');
        }
    }

    // --- Searching --------------------------------------------------------

    _onTextChanged() {
        const delay = this._context.settings.launcherSearchDelay;

        this._cancelPendingSearch();

        // Delay 0 means "search on the keystroke", which is the default:
        // every provider is synchronous and a full pass is well under a
        // millisecond, so a debounce would only add latency. The setting
        // exists for very large app sets or slow machines.
        if (delay <= 0) {
            this._refresh();
            return;
        }

        this._searchSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._searchSourceId = null;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPendingSearch() {
        if (this._searchSourceId !== null) {
            GLib.Source.remove(this._searchSourceId);
            this._searchSourceId = null;
        }
    }

    _refresh() {
        this._showSections(this._controller.search(this._entry.get_text()));
    }

    _showSections({sections, counts, total}) {
        this._list.setSections(sections);
        this._scopeBar.setSections(counts, this._controller.scope, total);

        const isEmpty = sections.length === 0;
        this._emptyLabel.visible = isEmpty;
        this._list.visible = !isEmpty;
        if (isEmpty)
            this._emptyLabel.text = this._emptyText();

        this._syncFooter(this._list.selectedResult);
    }

    /**
     * Nothing to show can mean three different things, and saying which
     * is the difference between a dead end and an obvious next step.
     */
    _emptyText() {
        const scope = this._controller.scope;
        if (scope)
            return _('No results in %s').format(sectionTitle(scope));

        // An untouched launcher on a fresh profile has nothing to show
        // yet -- that is not the same as "your search found nothing".
        return this._entry.get_text().trim().length === 0
            ? _('Type to search') : _('No results');
    }

    /**
     * Applies a scope chosen from the bar, the arrow keys or the palette.
     *
     * @param {?string} scope a section id, or null for everything
     */
    setScope(scope) {
        if (this._controller.scope === scope)
            return;

        this._controller.setScope(scope);
        this._refresh();
    }

    /**
     * Replaces the query text -- how the palette completes a command
     * ("/search ") or clears itself after applying a filter. Setting the
     * text re-runs the search through the entry's own change handler.
     *
     * @param {string} text
     */
    setQuery(text) {
        this._entry.set_text(text);
        this._entry.clutter_text.set_cursor_position(-1);
    }

    // A chip click already moved the bar's own selection, so this only
    // has to make the search agree with it.
    _onScopeSelected(scope) {
        this._controller.setScope(scope);
        this._refresh();
    }

    _syncFooter(result) {
        if (!this._footerHints.visible)
            return;

        const hints = [`↵ ${result?.activateLabel || _('Open')}`];
        if (result?.alternateLabel)
            hints.push(`Ctrl+↵ ${result.alternateLabel}`);
        if (result?.secondaryLabel)
            hints.push(`Shift+↵ ${result.secondaryLabel}`);
        if (result?.pinnable)
            hints.push(`Ctrl+D ${_('Pin')}`);
        if (result?.remove)
            hints.push(`Ctrl+Del ${_('Remove')}`);
        hints.push(`Esc ${_('Close')}`);

        this._footerHints.text = hints.join('   ·   ');
    }

    // --- Input ------------------------------------------------------------

    _onKeyPress(event) {
        const intent = resolveIntent(event.get_key_symbol(), event.get_state());

        switch (intent.type) {
        case IntentType.CLOSE:
            this.close();
            return Clutter.EVENT_STOP;

        case IntentType.ACTIVATE:
            return this._activateSelected(ActivationMode.DEFAULT);
        case IntentType.ACTIVATE_ALTERNATE:
            return this._activateSelected(ActivationMode.ALTERNATE);
        case IntentType.ACTIVATE_SECONDARY:
            return this._activateSelected(ActivationMode.SECONDARY);

        case IntentType.MOVE:
            this._list.moveSelection(intent.delta);
            return Clutter.EVENT_STOP;
        case IntentType.PAGE:
            this._list.pageSelection(intent.delta);
            return Clutter.EVENT_STOP;
        case IntentType.SECTION:
            this._list.moveSection(intent.delta);
            return Clutter.EVENT_STOP;
        case IntentType.FIRST:
            this._list.selectFirst();
            return Clutter.EVENT_STOP;
        case IntentType.LAST:
            this._list.selectLast();
            return Clutter.EVENT_STOP;

        case IntentType.QUICK_SELECT: {
            const results = this._list.results;
            if (intent.index < results.length)
                this._activate(results[intent.index], ActivationMode.DEFAULT);
            return Clutter.EVENT_STOP;
        }

        case IntentType.TOGGLE_PIN:
            this._togglePin();
            return Clutter.EVENT_STOP;

        case IntentType.REORDER_FAVORITE:
            this._reorderFavorite(intent.delta);
            return Clutter.EVENT_STOP;

        case IntentType.REMOVE:
            this._removeSelected();
            return Clutter.EVENT_STOP;

        case IntentType.SCOPE:
            this._scopeBar.moveSelection(intent.delta);
            return Clutter.EVENT_STOP;

        case IntentType.CLEAR_SCOPE:
            if (this._entry.get_text().length > 0 || this._controller.scope === null)
                return Clutter.EVENT_PROPAGATE;
            this.setScope(null);
            return Clutter.EVENT_STOP;

        case IntentType.CLEAR_QUERY:
            this._entry.set_text('');
            return Clutter.EVENT_STOP;

        default:
            // Everything else -- typing, Left/Right, plain Backspace --
            // belongs to the entry.
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _activateSelected(mode) {
        const result = this._list.selectedResult;
        if (!result)
            return Clutter.EVENT_STOP;

        this._activate(result, mode);
        return Clutter.EVENT_STOP;
    }

    /**
     * Closes FIRST, then runs the action.
     *
     * Ordering matters: popping the modal grab before the action runs
     * means window operations act on a normal shell, and anything the
     * action opens (a dialog, an overlay, another modal) is not fighting
     * this one for the grab.
     */
    _activate(result, mode) {
        // `keepOpen` results change what the launcher is SHOWING rather
        // than doing something outside it -- picking a scope filter,
        // completing a slash command -- so closing would undo the very
        // thing that was just asked for.
        if (!result.keepOpen)
            this.close();

        this._controller.activate(result, mode);
    }

    _togglePin() {
        const result = this._list.selectedResult;
        if (!result?.pinnable)
            return;

        this._context.favorites.toggle(resultKey(result));
        this._refreshKeepingSelection();
    }

    _reorderFavorite(delta) {
        const result = this._list.selectedResult;
        if (!result)
            return;

        if (this._context.favorites.move(resultKey(result), delta))
            this._refreshKeepingSelection();
    }

    _removeSelected() {
        const result = this._list.selectedResult;
        if (!result?.remove)
            return;

        result.remove();
        this._refreshKeepingSelection();
    }

    // Mutating a list under the user's cursor should not throw them back
    // to the top of it.
    _refreshKeepingSelection() {
        const index = this._list.selectedIndex;
        this._refresh();
        this._list.setSelectedIndex(index);
    }

    // --- Animation --------------------------------------------------------

    get _animationDuration() {
        // Two independent reasons to skip animation, both honoured: the
        // launcher's own setting, and GNOME's global reduced-motion
        // preference (accessibility -- St.Settings.enable_animations is
        // what the shell's own animations check).
        if (!this._context.settings.launcherAnimations || !St.Settings.get().enable_animations)
            return 0;
        return OPEN_DURATION_MS;
    }

    _animateOpen() {
        const duration = this._animationDuration;

        this._backdrop.remove_all_transitions();
        this._card.remove_all_transitions();

        this._backdrop.ease({
            opacity: BACKDROP_OPACITY,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._card.set_pivot_point(0.5, 0.5);
        this._card.opacity = duration > 0 ? 0 : 255;
        this._card.scale_x = duration > 0 ? OPEN_SCALE : 1;
        this._card.scale_y = this._card.scale_x;
        this._card.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _animateClose() {
        const duration = this._animationDuration > 0 ? CLOSE_DURATION_MS : 0;

        this._backdrop.remove_all_transitions();
        this._card.remove_all_transitions();

        this._backdrop.ease({
            opacity: 0,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._card.ease({
            opacity: 0,
            scale_x: OPEN_SCALE,
            scale_y: OPEN_SCALE,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            // With a zero duration St's ease() creates no transition and
            // invokes onComplete synchronously, so this covers both the
            // animated and the reduced-motion path. A transition that is
            // *cancelled* (by a re-open mid-close) never reports
            // finished, so it can never hide a freshly opened popup.
            onComplete: () => this.hide(),
        });
    }
});
