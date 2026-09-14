// SPDX-License-Identifier: GPL-2.0-or-later

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {
    FAVORITES_SECTION, PALETTE_COMMANDS_SECTION, PALETTE_FILTERS_SECTION,
    ProviderId, QUICK_SELECT_COUNT,
} from './constants.js';
import {ActivationMode, resultKey} from './searchResult.js';
import {markupWithHighlights} from './utils.js';

// The disclosure glyphs on an expandable row: pointing right while
// collapsed, down while expanded -- the convention every tree view uses.
const CHEVRON_COLLAPSED = '\u25b8';
const CHEVRON_EXPANDED = '\u25be';

// Mouse buttons, mapped to the same three activation modes as the
// keyboard: left is Enter, middle is Ctrl+Enter, right is Shift+Enter.
const BUTTON_MODE = {
    1: ActivationMode.DEFAULT,
    2: ActivationMode.ALTERNATE,
    3: ActivationMode.SECONDARY,
};

/**
 * Section titles. A function rather than a constant because gettext must
 * not run at module-evaluation time (see constants.js).
 *
 * @param {string} sectionId
 * @returns {string}
 */
export function sectionTitle(sectionId) {
    switch (sectionId) {
    case PALETTE_FILTERS_SECTION:
        return _('Filter Results');
    case PALETTE_COMMANDS_SECTION:
        return _('Commands');
    case FAVORITES_SECTION:
        return _('Favorites');
    case ProviderId.CALCULATOR:
        return _('Calculator');
    case ProviderId.COMMANDS:
        return _('Run Command');
    case ProviderId.APPS:
        return _('Applications');
    case ProviderId.WINDOWS:
        return _('Open Windows');
    case ProviderId.BROWSER_TABS:
        return _('Browser Tabs');
    case ProviderId.ACTIONS:
        return _('Actions');
    case ProviderId.RECENT:
        return _('Recent');
    case ProviderId.CLIPBOARD:
        return _('Clipboard');
    case ProviderId.SETTINGS:
        return _('System Settings');
    case ProviderId.EXTENSIONS:
        return _('Extensions');
    default:
        return sectionId;
    }
}

/**
 * One reusable result row: a button holding an icon, a title, a subtitle
 * and a trailing hint.
 *
 * Rows are pooled and re-filled rather than created per keystroke. That
 * is the single biggest reason the list can be rebuilt from scratch on
 * every character typed: constructing ~30 St actor trees per keystroke
 * would allocate and lay out constantly, while re-filling labels is a
 * handful of property writes.
 */
class ResultRow {
    constructor() {
        this.result = null;
        // 0 for a top-level result, 1 for a child shown under an expanded
        // parent. Set by fill(); read by the list's expand/collapse logic.
        this.depth = 0;

        // The disclosure control of an expandable row, drawn just before
        // the tab count at the row's end. A button of its own inside the
        // row button so a click on it toggles instead of activating:
        // St.Button handles the press it receives, so the outer row
        // never sees a click that landed here.
        this.chevron = new St.Button({
            style_class: 'tessera-launcher-chevron',
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Label({text: CHEVRON_COLLAPSED, y_align: Clutter.ActorAlign.CENTER}),
            visible: false,
        });

        this.icon = new St.Icon({y_align: Clutter.ActorAlign.CENTER});

        // A small mark over the icon's bottom-right corner (a tab's
        // browser). Placed by coordinates in a fixed layout rather than
        // by alignment in a bin: St allocates an icon the whole bin and
        // centres the image inside it, which put the mark dead centre.
        this.iconBadge = new St.Icon({visible: false});
        this.iconStack = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.iconStack.add_child(this.icon);
        this.iconStack.add_child(this.iconBadge);

        this.title = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this.title.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this.subtitle = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this.subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this.text = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.text.add_child(this.title);
        this.text.add_child(this.subtitle);

        // A quiet trailing detail ("12 tabs"), shown only for results
        // that carry one.
        this.badge = new St.Label({y_align: Clutter.ActorAlign.CENTER});

        // A prominent trailing value (an arithmetic answer), shown only
        // for results that carry one.
        this.value = new St.Label({y_align: Clutter.ActorAlign.CENTER});

        this.hint = new St.Label({y_align: Clutter.ActorAlign.CENTER});

        const box = new St.BoxLayout({style_class: 'tessera-launcher-row-box', x_expand: true});
        box.add_child(this.iconStack);
        box.add_child(this.text);
        // The chevron sits with the count it belongs to: "▸ 12 tabs"
        // reads as one control at the end of the row, and the icon and
        // title stay flush left with every other row.
        box.add_child(this.chevron);
        box.add_child(this.badge);
        box.add_child(this.value);
        box.add_child(this.hint);

        this.actor = new St.Button({
            style_class: 'tessera-launcher-row',
            x_expand: true,
            // The search entry keeps key focus for the whole session, so
            // rows must never take it -- selection is drawn, not focused.
            can_focus: false,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            child: box,
        });
        this.actor.accessible_role = Atk.Role.LIST_ITEM;
    }

    /**
     * @param {object} result
     * @param {object} metrics from LauncherTheme
     * @param {Gio.Icon} gicon resolved by IconProvider
     * @param {number} index position in the flat result list
     * @param {object} [placement]
     * @param {number} [placement.depth] 0 for top level, 1 for a child
     * @param {boolean} [placement.expanded] whether this row's children
     *   are currently shown beneath it
     */
    fill(result, metrics, gicon, index, {depth = 0, expanded = false} = {}) {
        this.result = result;
        this.depth = depth;

        const expandable = result.children.length > 0;
        this.chevron.visible = expandable;
        if (expandable)
            this.chevron.child.text = expanded ? CHEVRON_EXPANDED : CHEVRON_COLLAPSED;

        this.iconStack.visible = metrics.showIcons;
        if (metrics.showIcons) {
            this.icon.gicon = gicon;
            this.icon.icon_size = metrics.iconSize;
            this.icon.set_position(0, 0);
            this.iconStack.set_size(metrics.iconSize, metrics.iconSize);
        }
        const hasIconBadge = metrics.showIcons && result.badgeGicon !== null;
        this.iconBadge.visible = hasIconBadge;
        if (hasIconBadge) {
            this.iconBadge.gicon = result.badgeGicon;
            // Under half the icon: recognisable, never dominant.
            const badgeSize = Math.max(10, Math.round(metrics.iconSize * 0.45));
            this.iconBadge.icon_size = badgeSize;
            // Flush with the icon's bottom-right corner; the +2 is the
            // 1px backing padding (theme.iconBadgeStyle) on each side.
            const corner = metrics.iconSize - badgeSize - 2;
            this.iconBadge.set_position(corner, corner);
        }

        this.title.clutter_text.set_markup(
            markupWithHighlights(result.title, result.positions));

        const hasSubtitle = metrics.showDescriptions && result.subtitle.length > 0;
        this.subtitle.visible = hasSubtitle;
        if (hasSubtitle) {
            this.subtitle.clutter_text.set_markup(
                markupWithHighlights(result.subtitle, result.subtitlePositions));
        }

        const hasBadge = result.badge.length > 0;
        this.badge.visible = hasBadge;
        if (hasBadge)
            this.badge.text = result.badge;

        const hasValue = result.display.length > 0;
        this.value.visible = hasValue;
        if (hasValue)
            this.value.text = result.display;

        const quickSelect = index < QUICK_SELECT_COUNT ? `Alt+${index + 1}` : '';
        this.hint.visible = quickSelect.length > 0;
        this.hint.text = quickSelect;

        // The value comes first for a screen reader too: on a row that
        // has one, it is the answer and the title is the question.
        this.actor.accessible_name = [
            hasValue ? result.display : '',
            result.title,
            hasSubtitle ? result.subtitle : '',
            hasBadge ? result.badge : '',
            expandable ? (expanded ? _('Expanded') : _('Collapsed')) : '',
        ].filter(Boolean).join('. ');
    }
}

/**
 * The scrolling, grouped result list.
 *
 * Presentational only: it is handed already-ranked sections and reports
 * activation back through plain callbacks. It never searches, never
 * ranks, and never decides what a key means -- those are
 * searchController.js and keyboardController.js respectively.
 */
export const LauncherList = GObject.registerClass(
class LauncherList extends St.ScrollView {
    constructor(theme, iconProvider) {
        const content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'tessera-launcher-list',
        });

        super({
            style_class: 'tessera-launcher-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            child: content,
        });

        this._theme = theme;
        this._iconProvider = iconProvider;
        this._content = content;
        this._content.accessible_role = Atk.Role.LIST;

        this._rowPool = [];
        this._headerPool = [];
        this._rows = [];
        this._sectionStarts = [];
        this._selectedIndex = -1;

        // The sections most recently handed over, kept so that expanding
        // or collapsing a row can rebuild the flat row list without a
        // new search.
        this._sections = [];
        // Keys (searchResult.resultKey) of the results whose children are
        // shown. Keyed rather than indexed so an expansion survives the
        // list being rebuilt around it on every keystroke and refresh.
        this._expanded = new Set();

        // Where the pointer was the last time hover was evaluated. See
        // _pointerHasMoved(): hover only steers the selection when it is
        // the result of the user actually moving the mouse.
        this._hoverPointerX = -1;
        this._hoverPointerY = -1;

        /** @type {?function(object, string): void} (result, ActivationMode) */
        this.onActivate = null;
        /** @type {?function(?object): void} */
        this.onSelectionChanged = null;
    }

    /** @returns {object[]} every visible result, in display order */
    get results() {
        return this._rows.map(row => row.result);
    }

    /** @returns {?object} */
    get selectedResult() {
        return this._rows[this._selectedIndex]?.result ?? null;
    }

    get selectedIndex() {
        return this._selectedIndex;
    }

    /**
     * How the selected row sits in the hierarchy, for the footer hints.
     *
     * @returns {?{depth: number, expandable: boolean, expanded: boolean}}
     */
    get selectedRowInfo() {
        const row = this._rows[this._selectedIndex];
        if (!row)
            return null;
        return {
            depth: row.depth,
            expandable: row.result.children.length > 0,
            expanded: this.isExpanded(row.result),
        };
    }

    /**
     * Replaces the whole list.
     *
     * @param {Array<{id: string, results: object[]}>} sections
     */
    setSections(sections) {
        this._sections = sections;
        this._rebuild();

        this._selectedIndex = -1;
        this.setSelectedIndex(0);

        // Re-anchor the hover gate to wherever the pointer is now. Rows
        // have just been rebuilt underneath it, so the enter events that
        // follow describe a list that moved, not a pointer that did.
        this._samplePointer();
    }

    /** @returns {boolean} whether `result`'s children are shown */
    isExpanded(result) {
        return this._expanded.has(resultKey(result));
    }

    /** Collapses everything; called on every open so each starts flat. */
    resetExpansion() {
        this._expanded.clear();
    }

    /**
     * Right on an expandable row shows its children; Right on a row
     * already expanded steps into the first child.
     *
     * @returns {boolean} whether the key was consumed
     */
    expandSelected() {
        const row = this._rows[this._selectedIndex];
        if (!row || row.depth !== 0 || row.result.children.length === 0)
            return false;

        if (this.isExpanded(row.result)) {
            this.setSelectedIndex(this._selectedIndex + 1);
            return true;
        }

        this._expanded.add(resultKey(row.result));
        this._rebuildKeepingSelection();
        return true;
    }

    /**
     * Left on a child returns to its parent; Left on an expanded parent
     * hides its children. Two presses from any child back to a flat
     * list, and each is reversible with Right.
     *
     * @returns {boolean} whether the key was consumed
     */
    collapseSelected() {
        const row = this._rows[this._selectedIndex];
        if (!row)
            return false;

        if (row.depth > 0) {
            this.setSelectedIndex(this._parentIndex(this._selectedIndex));
            return true;
        }

        if (!this.isExpanded(row.result))
            return false;

        this._expanded.delete(resultKey(row.result));
        this._rebuildKeepingSelection();
        return true;
    }

    /**
     * The mouse's way in: the chevron on a row toggles that row.
     *
     * @param {number} index a top-level row
     */
    toggleExpanded(index) {
        const row = this._rows[index];
        if (!row || row.depth !== 0 || row.result.children.length === 0)
            return;

        const key = resultKey(row.result);
        if (this._expanded.has(key))
            this._expanded.delete(key);
        else
            this._expanded.add(key);

        this._rebuild();
        this._selectedIndex = -1;
        this.setSelectedIndex(index);
        this._samplePointer();
    }

    _parentIndex(index) {
        for (let candidate = index - 1; candidate >= 0; candidate--) {
            if (this._rows[candidate].depth === 0)
                return candidate;
        }
        return 0;
    }

    // Toggling a row changes the rows below it, never the row itself, so
    // the selected index is still the same row after a rebuild.
    _rebuildKeepingSelection() {
        const index = this._selectedIndex;
        this._rebuild();
        this._selectedIndex = -1;
        this.setSelectedIndex(index);
        this._samplePointer();
    }

    /**
     * Lays the current sections out as a flat list of rows: every
     * section's results in order, and under each expanded result its
     * children. Children are ordinary rows at depth 1, which is what
     * lets every other operation here -- selection, paging, quick
     * select, activation -- treat them exactly like their parents.
     */
    _rebuild() {
        const metrics = this._theme.metrics;

        // Detach without destroying: every actor is still referenced by
        // its pool and will be re-used on the next update.
        this._content.remove_all_children();
        this._rows = [];
        this._sectionStarts = [];

        let rowIndex = 0;
        let headerIndex = 0;

        for (const section of this._sections) {
            if (section.results.length === 0)
                continue;

            this._sectionStarts.push(rowIndex);

            const header = this._header(headerIndex++);
            header.text = sectionTitle(section.id);
            header.set_style(this._theme.sectionHeaderStyle());
            this._content.add_child(header);

            for (const result of section.results) {
                const expanded = result.children.length > 0 && this.isExpanded(result);
                this._addRow(result, rowIndex++, metrics, {depth: 0, expanded});
                if (!expanded)
                    continue;
                for (const child of result.children)
                    this._addRow(child, rowIndex++, metrics, {depth: 1, expanded: false});
            }
        }
    }

    _addRow(result, rowIndex, metrics, placement) {
        const row = this._row(rowIndex);
        row.fill(result, metrics, this._iconProvider.resolve(result), rowIndex, placement);
        this._styleRow(row, false);
        this._content.add_child(row.actor);
        this._rows.push(row);
    }

    _styleRow(row, selected) {
        row.actor.set_style(this._theme.rowStyle(selected, row.depth));
        row.subtitle.set_style(this._theme.subtitleStyle());
        row.badge.set_style(this._theme.badgeStyle());
        row.iconBadge.set_style(this._theme.iconBadgeStyle());
        row.chevron.set_style(this._theme.chevronStyle(row.chevron.hover));
        row.value.set_style(this._theme.valueStyle());
        row.hint.set_style(this._theme.hintStyle());
    }

    /**
     * @param {number} index clamped into range; -1 when the list is empty
     */
    setSelectedIndex(index) {
        if (this._rows.length === 0) {
            this._selectedIndex = -1;
            this.onSelectionChanged?.(null);
            return;
        }

        const next = Math.max(0, Math.min(this._rows.length - 1, index));
        if (next === this._selectedIndex)
            return;

        const previous = this._rows[this._selectedIndex];
        if (previous)
            previous.actor.set_style(this._theme.rowStyle(false, previous.depth));

        this._selectedIndex = next;
        const row = this._rows[next];
        row.actor.set_style(this._theme.rowStyle(true, row.depth));

        // Deferred to the next layout pass: a row added moments ago has
        // no allocation yet, and scrolling to an unallocated actor would
        // scroll to zero.
        this._scrollToSelected();
        this.onSelectionChanged?.(row.result);
    }

    /**
     * @param {number} delta rows to move, wrapping at both ends so a
     *   press of Down on the last result returns to the first
     */
    moveSelection(delta) {
        if (this._rows.length === 0)
            return;

        const count = this._rows.length;
        const next = (this._selectedIndex + delta % count + count) % count;
        this.setSelectedIndex(next);
    }

    /** Moves by roughly one visible page. */
    pageSelection(delta) {
        const rowHeight = Math.max(1, this._theme.metrics.rowHeight);
        const rowsPerPage = Math.max(1, Math.floor(this.height / rowHeight) - 1);
        this.setSelectedIndex(this._selectedIndex + delta * rowsPerPage);
    }

    /** Jumps to the first result of the next/previous section (Tab). */
    moveSection(delta) {
        if (this._sectionStarts.length === 0)
            return;

        const current = this._sectionStarts.findLastIndex(
            start => start <= this._selectedIndex);
        const count = this._sectionStarts.length;
        const next = (current + delta % count + count) % count;
        this.setSelectedIndex(this._sectionStarts[next]);
    }

    selectFirst() {
        this.setSelectedIndex(0);
    }

    selectLast() {
        this.setSelectedIndex(this._rows.length - 1);
    }

    /** Re-applies styles after a settings change, without rebuilding. */
    applyTheme() {
        this._rows.forEach((row, index) => this._styleRow(row, index === this._selectedIndex));
        for (const header of this._headerPool)
            header.set_style(this._theme.sectionHeaderStyle());
    }

    /** Drops every pooled actor; called when the popup is destroyed. */
    destroyPool() {
        this._content.remove_all_children();
        for (const row of this._rowPool)
            row.actor.destroy();
        for (const header of this._headerPool)
            header.destroy();
        this._rowPool = [];
        this._headerPool = [];
        this._rows = [];
    }

    _scrollToSelected() {
        const row = this._rows[this._selectedIndex];
        if (!row)
            return;

        try {
            ensureActorVisibleInScrollView(this, row.actor);
        } catch (error) {
            // The row is not laid out yet (first fill of a fresh list);
            // the next selection change scrolls correctly, and the list
            // is already at the top, which is where index 0 is anyway.
        }
    }

    _row(index) {
        let row = this._rowPool[index];
        if (!row) {
            row = new ResultRow();
            row.actor.connect('clicked', (actor, button) =>
                this._onRowClicked(row, button));
            row.actor.connect('notify::hover', () => {
                if (row.actor.hover && this._pointerHasMoved())
                    this.setSelectedIndex(this._rows.indexOf(row));
            });
            row.chevron.connect('clicked', () => {
                const rowIndex = this._rows.indexOf(row);
                if (rowIndex >= 0)
                    this.toggleExpanded(rowIndex);
            });
            row.chevron.connect('notify::hover', () =>
                row.chevron.set_style(this._theme.chevronStyle(row.chevron.hover)));
            this._rowPool[index] = row;
        }
        return row;
    }

    /**
     * Whether the pointer has moved since hover was last considered --
     * the gate that stops a *stationary* mouse from stealing the
     * keyboard's selection.
     *
     * A hover event does not mean "the user pointed at this row". It
     * means "this row is now under the pointer", which also happens when
     * the row moves rather than the pointer: opening the launcher under
     * a resting cursor, rebuilding the list on every keystroke, and
     * scrolling all fire hover for a mouse nobody touched. Without this
     * check, opening the launcher with the cursor over the list selected
     * whatever it happened to land on instead of the first result, and
     * typing kept re-stealing the selection from underneath the user.
     *
     * Comparing the pointer's position is enough to tell the two apart,
     * and needs no motion handler of its own: if the coordinates are
     * unchanged, the list moved, not the mouse. Clicks are unaffected --
     * they set the selection explicitly (_onRowClicked), so any row can
     * still be clicked whether or not hover selected it first.
     *
     * @returns {boolean}
     */
    _pointerHasMoved() {
        const [x, y] = global.get_pointer();
        const moved = x !== this._hoverPointerX || y !== this._hoverPointerY;
        this._hoverPointerX = x;
        this._hoverPointerY = y;
        return moved;
    }

    _samplePointer() {
        [this._hoverPointerX, this._hoverPointerY] = global.get_pointer();
    }

    _header(index) {
        let header = this._headerPool[index];
        if (!header) {
            header = new St.Label({style_class: 'tessera-launcher-section'});
            this._headerPool[index] = header;
        }
        return header;
    }

    _onRowClicked(row, button) {
        const index = this._rows.indexOf(row);
        if (index < 0)
            return;

        this.setSelectedIndex(index);
        this.onActivate?.(row.result, BUTTON_MODE[button] ?? ActivationMode.DEFAULT);
    }
});
