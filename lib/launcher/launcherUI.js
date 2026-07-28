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
import {ActivationMode} from './searchResult.js';
import {markupWithHighlights} from './utils.js';

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

        this.icon = new St.Icon({y_align: Clutter.ActorAlign.CENTER});

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

        // A prominent trailing value (an arithmetic answer), shown only
        // for results that carry one.
        this.value = new St.Label({y_align: Clutter.ActorAlign.CENTER});

        this.hint = new St.Label({y_align: Clutter.ActorAlign.CENTER});

        const box = new St.BoxLayout({style_class: 'tessera-launcher-row-box', x_expand: true});
        box.add_child(this.icon);
        box.add_child(this.text);
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
     */
    fill(result, metrics, gicon, index) {
        this.result = result;

        this.icon.visible = metrics.showIcons;
        if (metrics.showIcons) {
            this.icon.gicon = gicon;
            this.icon.icon_size = metrics.iconSize;
        }

        this.title.clutter_text.set_markup(
            markupWithHighlights(result.title, result.positions));

        const hasSubtitle = metrics.showDescriptions && result.subtitle.length > 0;
        this.subtitle.visible = hasSubtitle;
        if (hasSubtitle)
            this.subtitle.text = result.subtitle;

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
     * Replaces the whole list.
     *
     * @param {Array<{id: string, results: object[]}>} sections
     */
    setSections(sections) {
        const metrics = this._theme.metrics;

        // Detach without destroying: every actor is still referenced by
        // its pool and will be re-used on the next update.
        this._content.remove_all_children();
        this._rows = [];
        this._sectionStarts = [];

        let rowIndex = 0;
        let headerIndex = 0;

        for (const section of sections) {
            if (section.results.length === 0)
                continue;

            this._sectionStarts.push(rowIndex);

            const header = this._header(headerIndex++);
            header.text = sectionTitle(section.id);
            header.set_style(this._theme.sectionHeaderStyle());
            this._content.add_child(header);

            for (const result of section.results) {
                const row = this._row(rowIndex);
                row.fill(result, metrics, this._iconProvider.resolve(result), rowIndex);
                row.actor.set_style(this._theme.rowStyle(false));
                row.subtitle.set_style(this._theme.subtitleStyle());
                row.value.set_style(this._theme.valueStyle());
                row.hint.set_style(this._theme.hintStyle());
                this._content.add_child(row.actor);
                this._rows.push(row);
                rowIndex++;
            }
        }

        this._selectedIndex = -1;
        this.setSelectedIndex(0);

        // Re-anchor the hover gate to wherever the pointer is now. Rows
        // have just been rebuilt underneath it, so the enter events that
        // follow describe a list that moved, not a pointer that did.
        this._samplePointer();
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

        if (this._rows[this._selectedIndex])
            this._rows[this._selectedIndex].actor.set_style(this._theme.rowStyle(false));

        this._selectedIndex = next;
        const row = this._rows[next];
        row.actor.set_style(this._theme.rowStyle(true));

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
        this._rows.forEach((row, index) => {
            row.actor.set_style(this._theme.rowStyle(index === this._selectedIndex));
            row.subtitle.set_style(this._theme.subtitleStyle());
            row.value.set_style(this._theme.valueStyle());
            row.hint.set_style(this._theme.hintStyle());
        });
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
