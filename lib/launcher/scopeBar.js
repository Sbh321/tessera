// SPDX-License-Identifier: GPL-2.0-or-later

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SECTION_ORDER} from './constants.js';
import {sectionTitle} from './launcherUI.js';

/**
 * The row of scope chips under the search entry:
 *
 *     [ All 27 ]  Windows 4   Apps 12   Settings 3
 *
 * Its whole job is to answer "what else matched, and how do I get
 * there?" -- the question that made a merged list hard to use once every
 * section had something to say. Counts are the point: they are what tell
 * you Settings has three answers hiding under twelve applications.
 *
 * Presentational only, like lib/tiling/stackTabBar.js: it is told which
 * sections exist and which one is selected, and reports clicks back
 * through a callback. It never searches, filters or decides anything.
 *
 * Two deliberate ordering rules:
 *
 *  - Chips follow SECTION_ORDER, NOT the ranked order the results use. A
 *    strip that reshuffles itself as you type is one you can never build
 *    muscle memory for, and muscle memory is the entire value of a
 *    filter bar.
 *  - Only sections that actually matched get a chip. A fixed strip of
 *    ten mostly-empty chips would be noise, and "the chip is there"
 *    would stop meaning "there is something in it".
 */
export const ScopeBar = GObject.registerClass(
class ScopeBar extends St.BoxLayout {
    constructor(theme) {
        super({
            style_class: 'tessera-launcher-scopebar',
            x_expand: true,
            visible: false,
        });

        this._theme = theme;
        this._chipPool = [];
        /** @type {Array<{id: ?string, actor: St.Button}>} in display order */
        this._chips = [];
        this._scope = null;

        this.accessible_role = Atk.Role.TOOL_BAR;

        /** @type {?function(?string): void} called with the chosen scope */
        this.onScopeSelected = null;
    }

    /** @returns {?string} the selected section id, or null for "All" */
    get scope() {
        return this._scope;
    }

    /**
     * Rebuilds the strip.
     *
     * @param {Map<string, number>} counts per-section result totals, from
     *   the UNSCOPED result set -- otherwise selecting a chip would erase
     *   the very numbers that let you leave it again
     * @param {?string} scope the selected section id, or null
     */
    setSections(counts, scope) {
        this._scope = scope;
        this.remove_all_children();
        this._chips = [];

        if (counts.size === 0 && scope === null) {
            this.hide();
            return;
        }

        let total = 0;
        for (const count of counts.values())
            total += count;

        // The section being filtered to always gets a chip, even with
        // nothing in it. Dropping it because it came up empty would
        // leave the strip with no selection at all while a filter was
        // plainly in force -- "Open Windows 0" says what happened;
        // a bar with nothing highlighted says the launcher is broken.
        const ids = new Set(counts.keys());
        if (scope !== null)
            ids.add(scope);

        const sections = [...ids]
            .sort((a, b) => SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b));

        this._addChip(null, _('All'), total);
        for (const sectionId of sections)
            this._addChip(sectionId, sectionTitle(sectionId), counts.get(sectionId) ?? 0);

        this.show();
        this._applyChipStyles();
    }

    /**
     * Moves the selection along the strip, wrapping at both ends.
     *
     * Wrapping because the key that drives this is Ctrl+Tab: a key you
     * hold and repeat, on the gesture that cycles browser tabs. Stopping
     * dead at the last chip means reaching for the opposite chord to get
     * back, which is exactly the friction a cycling key exists to avoid.
     *
     * @param {number} delta -1 for the chip to the left, +1 to the right
     * @returns {boolean} whether the selection changed
     */
    moveSelection(delta) {
        const count = this._chips.length;
        if (count === 0)
            return false;

        const current = this._chips.findIndex(chip => chip.id === this._scope);
        const from = current < 0 ? 0 : current;
        const next = (from + delta % count + count) % count;
        if (next === current)
            return false;

        this._select(this._chips[next].id);
        return true;
    }

    /** Re-applies colors after a settings or theme change. */
    applyTheme() {
        this._applyChipStyles();
    }

    /** Drops every pooled actor; called when the popup is destroyed. */
    destroyPool() {
        this.remove_all_children();
        for (const chip of this._chipPool)
            chip.destroy();
        this._chipPool = [];
        this._chips = [];
    }

    _addChip(id, label, count) {
        const chip = this._chip(this._chips.length);
        chip.labelActor.text = label;
        chip.countActor.text = `${count}`;
        chip.accessible_name = `${label}, ${count}`;
        chip.scopeId = id;

        this.add_child(chip);
        this._chips.push({id, actor: chip});
    }

    _chip(index) {
        let chip = this._chipPool[index];
        if (!chip) {
            const labelActor = new St.Label({y_align: Clutter.ActorAlign.CENTER});
            const countActor = new St.Label({y_align: Clutter.ActorAlign.CENTER});

            const box = new St.BoxLayout({style_class: 'tessera-launcher-chip-box'});
            box.add_child(labelActor);
            box.add_child(countActor);

            chip = new St.Button({
                style_class: 'tessera-launcher-chip',
                // The search entry keeps key focus for the whole session.
                can_focus: false,
                child: box,
            });
            chip.labelActor = labelActor;
            chip.countActor = countActor;
            chip.connect('clicked', () => this._select(chip.scopeId));

            this._chipPool[index] = chip;
        }
        return chip;
    }

    _select(id) {
        if (id === this._scope)
            return;

        this._scope = id;
        this._applyChipStyles();
        this.onScopeSelected?.(id);
    }

    _applyChipStyles() {
        for (const {id, actor} of this._chips) {
            const selected = id === this._scope;
            actor.set_style(this._theme.chipStyle(selected));
            actor.countActor.set_style(this._theme.chipCountStyle());
        }
    }
});
