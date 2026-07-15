// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function addSpinRow(group, settings, key, title, subtitle, {lower, upper, step = 1}) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function addSwitchRow(group, settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function addComboRow(group, settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices),
    });

    const currentIndex = choices.indexOf(settings.get_string(key));
    row.selected = currentIndex >= 0 ? currentIndex : 0;

    row.connect('notify::selected', () => {
        settings.set_string(key, choices[row.selected]);
    });
    settings.connect(`changed::${key}`, () => {
        const index = choices.indexOf(settings.get_string(key));
        if (index >= 0 && index !== row.selected)
            row.selected = index;
    });

    group.add(row);
    return row;
}

function addColorEntryRow(group, settings, key, title) {
    const row = new Adw.EntryRow({
        title,
    });
    row.set_text(settings.get_string(key));
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function addAcceleratorEntryRow(group, settings, key, title) {
    const row = new Adw.EntryRow({title});

    const current = settings.get_strv(key);
    row.set_text(current.length > 0 ? current[0] : '');

    row.connect('notify::text', () => {
        const text = row.get_text().trim();
        settings.set_strv(key, text.length > 0 ? [text] : []);
    });
    settings.connect(`changed::${key}`, () => {
        const value = settings.get_strv(key);
        const text = value.length > 0 ? value[0] : '';
        if (text !== row.get_text())
            row.set_text(text);
    });

    group.add(row);
    return row;
}

export default class TesseraPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._buildAppearancePage(settings));
        window.add(this._buildTilingPage(settings));
        window.add(this._buildKeybindingsPage(settings));
    }

    _buildTilingPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Tiling'),
            icon_name: 'view-grid-symbolic',
        });

        const tilingGroup = new Adw.PreferencesGroup({
            description: _(
                'Hyprland-style automatic tiling: normal windows are arranged ' +
                'in a dwindle layout per workspace. Dialogs, minimized and ' +
                'maximized windows float. Shift+Super+S toggles a stacked ' +
                '(tabbed) layout per workspace.'),
        });
        page.add(tilingGroup);
        addSwitchRow(tilingGroup, settings, 'enable-tiling',
            _('Enable automatic tiling'), '');

        const gapsGroup = new Adw.PreferencesGroup({title: _('Gaps')});
        page.add(gapsGroup);
        addSpinRow(gapsGroup, settings, 'tiling-gap-inner', _('Inner gap'),
            _('Space between adjacent tiled windows, in pixels'), {lower: 0, upper: 64});
        addSpinRow(gapsGroup, settings, 'tiling-gap-outer', _('Outer gap'),
            _('Space between tiled windows and the screen edge, in pixels'), {lower: 0, upper: 64});

        return page;
    }

    _buildAppearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        const placementGroup = new Adw.PreferencesGroup({title: _('Placement')});
        page.add(placementGroup);
        addComboRow(placementGroup, settings, 'panel-position', _('Panel position'),
            _('Which panel box the indicator sits in'), ['left', 'center', 'right']);
        addSwitchRow(placementGroup, settings, 'hide-native-activities-dots',
            _('Hide GNOME’s built-in Activities-button dots'),
            _('GNOME Shell renders its own small workspace dots inside the Activities button; hide them so only this indicator is visible'));

        const sizeGroup = new Adw.PreferencesGroup({title: _('Size & Spacing')});
        page.add(sizeGroup);
        addSpinRow(sizeGroup, settings, 'square-size', _('Square size'),
            _('Width and height of each square, in pixels'), {lower: 12, upper: 64});
        addSpinRow(sizeGroup, settings, 'square-spacing', _('Spacing'),
            _('Gap between squares, in pixels'), {lower: 0, upper: 24});
        addSpinRow(sizeGroup, settings, 'square-border-radius', _('Border radius'),
            _('Corner rounding of each square, in pixels'), {lower: 0, upper: 32});
        addSpinRow(sizeGroup, settings, 'square-padding', _('Padding'),
            _('Space between a square’s border and its label, in pixels'), {lower: 0, upper: 20});

        const styleGroup = new Adw.PreferencesGroup({title: _('Style')});
        page.add(styleGroup);
        addComboRow(styleGroup, settings, 'indicator-style', _('Indicator style'),
            _('Filled squares or outlined squares'), ['filled', 'outline']);
        addSpinRow(styleGroup, settings, 'font-size', _('Font size'),
            _('Size of the workspace number label, in points'), {lower: 6, upper: 32});
        addComboRow(styleGroup, settings, 'font-weight', _('Font weight'),
            _('Weight of the workspace number label'), ['normal', 'bold', '600']);
        addSwitchRow(styleGroup, settings, 'show-empty-workspaces', _('Show trailing empty workspace'),
            _('GNOME keeps one empty workspace at the end when dynamic workspaces are on'));

        const colorGroup = new Adw.PreferencesGroup({
            title: _('Colors'),
            description: _('Hex colors, e.g. #3584e4. Leave empty to use the current GNOME theme.'),
        });
        page.add(colorGroup);
        addColorEntryRow(colorGroup, settings, 'active-background-color', _('Active background'));
        addColorEntryRow(colorGroup, settings, 'inactive-background-color', _('Inactive background'));
        addColorEntryRow(colorGroup, settings, 'active-text-color', _('Active text'));
        addColorEntryRow(colorGroup, settings, 'inactive-text-color', _('Inactive text'));

        return page;
    }

    _buildKeybindingsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Keybindings'),
            icon_name: 'input-keyboard-symbolic',
        });

        const masterGroup = new Adw.PreferencesGroup({
            description: _(
                'Super+1–9, Super+Left/Right and their Shift variants already ' +
                'control other GNOME shortcuts by default (switching to favorite ' +
                'apps, snapping windows, moving windows between monitors). ' +
                'Enabling this temporarily clears those defaults and restores them ' +
                'exactly when disabled.'),
        });
        page.add(masterGroup);
        addSwitchRow(masterGroup, settings, 'enable-custom-keybindings',
            _('Enable workspace and window-move keybindings'), '');

        const jumpGroup = new Adw.PreferencesGroup({
            title: _('Jump to Workspace'),
            description: _('Accelerator format, e.g. <Super>1'),
        });
        page.add(jumpGroup);
        for (let i = 1; i <= 9; i++) {
            addAcceleratorEntryRow(jumpGroup, settings, `workspace-jump-${i}`,
                `${_('Workspace')} ${i}`);
        }

        const navigateGroup = new Adw.PreferencesGroup({title: _('Navigate')});
        page.add(navigateGroup);
        addAcceleratorEntryRow(navigateGroup, settings, 'workspace-previous', _('Previous workspace'));
        addAcceleratorEntryRow(navigateGroup, settings, 'workspace-next', _('Next workspace'));

        const moveGroup = new Adw.PreferencesGroup({
            title: _('Move Window to Workspace'),
            description: _('Moves the focused window and follows it'),
        });
        page.add(moveGroup);
        for (let i = 1; i <= 9; i++) {
            addAcceleratorEntryRow(moveGroup, settings, `window-move-${i}`,
                `${_('Workspace')} ${i}`);
        }

        const moveNewGroup = new Adw.PreferencesGroup({
            title: _('Move Window to New Workspace'),
            description: _('Inserts a new workspace beside the current one (dynamic workspaces only) and moves the focused window into it'),
        });
        page.add(moveNewGroup);
        addAcceleratorEntryRow(moveNewGroup, settings, 'window-move-new-left', _('Insert left'));
        addAcceleratorEntryRow(moveNewGroup, settings, 'window-move-new-right', _('Insert right'));

        const layoutGroup = new Adw.PreferencesGroup({title: _('Layout')});
        page.add(layoutGroup);
        addAcceleratorEntryRow(layoutGroup, settings, 'layout-toggle-stacked',
            _('Toggle stacked layout'));

        return page;
    }
}
