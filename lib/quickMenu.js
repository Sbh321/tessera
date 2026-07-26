// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {pickColor} from './colorPicker.js';
import {PortKillerDialog} from './portKiller.js';

// Gaps share this range with the GSettings schema and the preferences spin
// rows; kept here so the steppers clamp to the same bounds.
const GAP_MIN = 0;
const GAP_MAX = 64;

// Recent-color swatches are laid out in fixed-width rows so 20 entries wrap
// tidily rather than stretching the menu.
const CHIPS_PER_ROW = 8;

// The keybindings shown, read-only, in the Keys tab. Mirrors the grouping
// of the preferences Keybindings tab (prefs.js) so the panel reference and
// the editor stay recognizably the same list; each entry is a
// [schema-key, label] pair. Built lazily (not a module-level const) because
// gettext (`_`) may only be called from within extension code at runtime,
// never during module evaluation at import time.
function buildKeybindingGroups() {
    return [
        {
            title: _('Tools'),
            keys: [
                ['tool-port-killer', _('Port killer')],
                ['tool-color-picker', _('Color picker')],
            ],
        },
        {
            title: _('Jump to Workspace'),
            keys: Array.from({length: 9}, (_unused, i) =>
                [`workspace-jump-${i + 1}`, `${_('Workspace')} ${i + 1}`]),
        },
        {
            title: _('Navigate'),
            keys: [
                ['workspace-previous', _('Previous workspace')],
                ['workspace-next', _('Next workspace')],
            ],
        },
        {
            title: _('Move Window to Workspace'),
            keys: Array.from({length: 9}, (_unused, i) =>
                [`window-move-${i + 1}`, `${_('Workspace')} ${i + 1}`]),
        },
        {
            title: _('Move Window to New Workspace'),
            keys: [
                ['window-move-new-left', _('Insert left')],
                ['window-move-new-right', _('Insert right')],
            ],
        },
        {
            title: _('Swap Workspace Contents'),
            keys: Array.from({length: 9}, (_unused, i) =>
                [`workspace-swap-${i + 1}`, `${_('Workspace')} ${i + 1}`]),
        },
        {
            title: _('Layout'),
            keys: [
                ['layout-toggle-stacked', _('Toggle stacked layout')],
                ['window-toggle-floating', _('Toggle floating')],
                ['window-toggle-maximize', _('Toggle maximize')],
                ['window-toggle-fullscreen', _('Toggle fullscreen')],
            ],
        },
        {
            title: _('Panel'),
            keys: [
                ['panel-reveal-toggle', _('Reveal / hide auto-hidden panel')],
            ],
        },
    ];
}

// Turns a GTK accelerator string (<Super>1, <Shift><Super>Left) into a
// compact human label (Super+1, Shift+Super+Left) for the read-only list.
// Unset bindings render as an em dash.
function prettyAccelerator(accel) {
    if (!accel)
        return '—';
    return accel
        .replace(/<Super>/g, 'Super+')
        .replace(/<Shift>/g, 'Shift+')
        .replace(/<Ctrl>/g, 'Ctrl+')
        .replace(/<Control>/g, 'Ctrl+')
        .replace(/<Alt>/g, 'Alt+')
        .replace(/<Primary>/g, 'Ctrl+');
}

/**
 * The Tessera quick menu: a single panel button whose popup is organised
 * into three tabs -- Overview (quick toggles + gap steppers + a settings
 * shortcut), Tools (port killer, color picker, and their recent history),
 * and Keys (a read-only keybinding reference). Created only while the
 * enable-quick-menu setting is on; TesseraExtension owns that lifecycle
 * (see extension.js).
 */
export const QuickMenu = GObject.registerClass(
class QuickMenu extends PanelMenu.Button {
    _init(settingsManager, openPreferences) {
        super._init(0.5, _('Tessera Quick Menu'), false);

        this._settingsManager = settingsManager;
        this._openPreferences = openPreferences;
        this._accelLabels = new Map();
        this._sections = {};
        this._tabButtons = {};

        this.add_child(new St.Icon({
            style_class: 'system-status-icon',
            icon_name: 'view-grid-symbolic',
        }));

        this._buildTabBar();

        this._sections.overview = this._buildOverviewSection();
        this._sections.tools = this._buildToolsSection();
        this._sections.keys = this._buildKeysSection();

        this._selectTab('overview');

        // Keep the read-only accelerator labels current: they may have been
        // edited in the preferences window while this menu already existed.
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this._refreshAccelerators();
        });

        // Rebuild the Tools-tab history whenever a tool records something,
        // from this menu or a keybinding or another monitor's menu.
        this._settingsManager.gsettings.connectObject(
            'changed::picked-colors', () => this._rebuildColorHistory(),
            'changed::killed-ports', () => this._rebuildPortHistory(),
            this);

        // Same lock-screen discipline as the workspace indicator: nothing
        // this extension adds should be reachable from the lock screen (see
        // the session-modes justification in extension.js). Hide the whole
        // container while locked.
        this._sessionModeChangedId = Main.sessionMode.connect(
            'updated', () => this._syncLockedVisibility());
        this._syncLockedVisibility();
    }

    _onDestroy() {
        if (this._sessionModeChangedId !== null) {
            Main.sessionMode.disconnect(this._sessionModeChangedId);
            this._sessionModeChangedId = null;
        }
        super._onDestroy();
    }

    _syncLockedVisibility() {
        this.container.visible = !Main.sessionMode.isLocked;
    }

    // --- Tabs -------------------------------------------------------------

    _buildTabBar() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'tessera-tabbar-item',
        });
        const bar = new St.BoxLayout({style_class: 'tessera-tabbar', x_expand: true});

        for (const [key, label] of [
            ['overview', _('Overview')],
            ['tools', _('Tools')],
            ['keys', _('Keys')],
        ]) {
            const button = new St.Button({
                style_class: 'tessera-tab',
                label,
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', () => this._selectTab(key));
            bar.add_child(button);
            this._tabButtons[key] = button;
        }

        item.add_child(bar);
        this.menu.addMenuItem(item);
    }

    _selectTab(name) {
        for (const [key, section] of Object.entries(this._sections))
            section.actor.visible = key === name;

        for (const [key, button] of Object.entries(this._tabButtons)) {
            if (key === name)
                button.add_style_class_name('selected');
            else
                button.remove_style_class_name('selected');
        }
    }

    // --- Overview tab -----------------------------------------------------

    _buildOverviewSection() {
        const section = new PopupMenu.PopupMenuSection();

        this._addSwitch(section, _('Automatic tiling'), 'enable-tiling');
        this._addSwitch(section, _('Focus border'), 'enable-focus-border');
        this._addSwitch(section, _('Auto-hide top panel'), 'panel-autohide');

        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addGapStepper(section, _('Inner gap'), 'tiling-gap-inner');
        this._addGapStepper(section, _('Outer gap'), 'tiling-gap-outer');

        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupImageMenuItem(
            _('Open full settings…'), 'emblem-system-symbolic');
        settingsItem.connect('activate', () => {
            this.menu.close();
            this._openPreferences();
        });
        section.addMenuItem(settingsItem);

        this.menu.addMenuItem(section);
        return section;
    }

    // --- Tools tab --------------------------------------------------------

    _buildToolsSection() {
        const section = new PopupMenu.PopupMenuSection();

        this._addToolRow(section, 'application-exit-symbolic', _('Port killer'),
            'tool-port-killer',
            () => new PortKillerDialog(this._settingsManager).open());
        this._addToolRow(section, 'color-select-symbolic', _('Color picker'),
            'tool-color-picker',
            () => pickColor(this._settingsManager));

        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Recent colors')));
        this._colorHistoryBox = this._addHistoryContainer(section);
        this._rebuildColorHistory();

        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Recently killed ports')));
        this._portHistoryBox = this._addHistoryContainer(section);
        this._rebuildPortHistory();

        this.menu.addMenuItem(section);
        return section;
    }

    _addToolRow(section, iconName, label, key, onActivate) {
        const item = new PopupMenu.PopupBaseMenuItem();
        item.add_child(new St.Icon({
            icon_name: iconName,
            style_class: 'popup-menu-icon',
        }));
        item.add_child(new St.Label({
            text: label,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const accel = new St.Label({
            style_class: 'tessera-keybinding-accel',
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(accel);
        this._accelLabels.set(key, accel);

        item.connect('activate', () => {
            this.menu.close();
            onActivate();
        });
        section.addMenuItem(item);
    }

    _addHistoryContainer(section) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'tessera-history',
        });
        item.add_child(box);
        section.addMenuItem(item);
        return box;
    }

    _rebuildColorHistory() {
        const box = this._colorHistoryBox;
        box.destroy_all_children();

        const colors = this._settingsManager.pickedColors;
        if (colors.length === 0) {
            box.add_child(new St.Label({
                text: _('No colors picked yet'),
                style_class: 'tessera-history-empty',
            }));
            return;
        }

        let row = null;
        colors.forEach((hex, i) => {
            if (i % CHIPS_PER_ROW === 0) {
                row = new St.BoxLayout({style_class: 'tessera-chip-row'});
                box.add_child(row);
            }
            row.add_child(this._makeColorChip(hex));
        });
    }

    _makeColorChip(hex) {
        const chip = new St.Button({
            style_class: 'tessera-color-chip',
            can_focus: true,
            accessible_name: hex,
        });
        chip.set_style(`background-color: ${hex};`);
        chip.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, hex);
            Main.notify(_('Tessera'), _('Copied %s to the clipboard').format(hex));
            this.menu.close();
        });
        return chip;
    }

    _rebuildPortHistory() {
        const box = this._portHistoryBox;
        box.destroy_all_children();

        const ports = this._settingsManager.killedPorts;
        if (ports.length === 0) {
            box.add_child(new St.Label({
                text: _('No ports killed yet'),
                style_class: 'tessera-history-empty',
            }));
            return;
        }

        for (const entry of ports) {
            box.add_child(new St.Label({
                text: entry,
                style_class: 'tessera-history-port',
            }));
        }
    }

    // --- Keys tab ---------------------------------------------------------

    // The full keybinding reference is long (~30 rows), so it is laid out
    // in two columns inside a single non-reactive item rather than one row
    // per menu item -- otherwise the popup runs off the bottom of the
    // screen. Groups are packed greedily into whichever column is currently
    // shorter (weighted by header + row count) to keep the two balanced.
    _buildKeysSection() {
        const section = new PopupMenu.PopupMenuSection();

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'tessera-keys-item',
        });
        const columns = new St.BoxLayout({style_class: 'tessera-keys-columns'});
        const columnBoxes = [
            new St.BoxLayout({vertical: true, style_class: 'tessera-keys-column'}),
            new St.BoxLayout({vertical: true, style_class: 'tessera-keys-column'}),
        ];
        columnBoxes.forEach(box => columns.add_child(box));
        item.add_child(columns);
        section.addMenuItem(item);

        const heights = [0, 0];
        for (const group of buildKeybindingGroups()) {
            const target = heights[0] <= heights[1] ? 0 : 1;
            this._renderKeyGroup(columnBoxes[target], group);
            heights[target] += 1 + group.keys.length;
        }

        this.menu.addMenuItem(section);
        return section;
    }

    _renderKeyGroup(columnBox, group) {
        columnBox.add_child(new St.Label({
            text: group.title,
            style_class: 'tessera-keys-header',
        }));

        for (const [key, label] of group.keys) {
            const row = new St.BoxLayout({
                style_class: 'tessera-keys-row',
                x_expand: true,
            });
            row.add_child(new St.Label({
                text: label,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));

            const accelLabel = new St.Label({
                style_class: 'tessera-keybinding-accel',
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(accelLabel);
            this._accelLabels.set(key, accelLabel);

            columnBox.add_child(row);
        }
    }

    _refreshAccelerators() {
        const gsettings = this._settingsManager.gsettings;
        for (const [key, accelLabel] of this._accelLabels) {
            const value = gsettings.get_strv(key);
            accelLabel.text = prettyAccelerator(value.length > 0 ? value[0] : '');
        }
    }

    // --- Shared row builders ---------------------------------------------

    _addSwitch(section, label, key) {
        const gsettings = this._settingsManager.gsettings;
        const item = new PopupMenu.PopupSwitchMenuItem(label, gsettings.get_boolean(key));
        item.connect('toggled', (menuItem, state) =>
            gsettings.set_boolean(key, state));
        gsettings.connectObject(`changed::${key}`, () =>
            item.setToggleState(gsettings.get_boolean(key)), this);

        // Keep the menu open when a quick toggle is flipped. By default
        // PopupSwitchMenuItem.activate() calls super.activate(), which
        // closes the menu; overriding it to only toggle lets the user flip
        // several settings in one session. (Only the Tools rows and "Open
        // full settings" deliberately close the menu.)
        item.activate = () => item.toggle();

        section.addMenuItem(item);
    }

    // A non-activating row: [ label ][ − value + ]. The buttons nudge the
    // gsettings int within the gap range; the value label follows the
    // setting (so external edits, e.g. via preferences, stay reflected).
    _addGapStepper(section, label, key) {
        const gsettings = this._settingsManager.gsettings;

        const item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.add_child(new St.Label({
            text: label,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const stepper = new St.BoxLayout({
            style_class: 'tessera-stepper',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const valueLabel = new St.Label({
            style_class: 'tessera-stepper-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const syncValue = () => {
            valueLabel.text = `${gsettings.get_int(key)}`;
        };

        const step = delta => {
            const next = Math.max(GAP_MIN, Math.min(GAP_MAX,
                gsettings.get_int(key) + delta));
            gsettings.set_int(key, next);
        };

        stepper.add_child(this._makeStepButton('list-remove-symbolic', () => step(-1)));
        stepper.add_child(valueLabel);
        stepper.add_child(this._makeStepButton('list-add-symbolic', () => step(1)));
        item.add_child(stepper);

        gsettings.connectObject(`changed::${key}`, syncValue, this);
        syncValue();

        section.addMenuItem(item);
    }

    _makeStepButton(iconName, onClick) {
        const button = new St.Button({
            style_class: 'tessera-stepper-button',
            can_focus: true,
            child: new St.Icon({icon_name: iconName, icon_size: 14}),
        });
        button.connect('clicked', () => onClick());
        return button;
    }
});
