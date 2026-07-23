// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
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

function addScaleRow(group, settings, key, title, subtitle, {lower, upper, step = 1}) {
    const row = new Adw.ActionRow({title, subtitle});
    const scale = new Gtk.Scale({
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
        draw_value: true,
        value_pos: Gtk.PositionType.LEFT,
        digits: 0,
        hexpand: true,
        valign: Gtk.Align.CENTER,
        width_request: 220,
    });
    settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(scale);
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

// A row of linked preset buttons. Presets are deliberately NOT a stored
// setting -- clicking one just writes the underlying keys (the spin rows
// update live through their bindings), so there is no "preset" state to
// drift out of sync when the user then fine-tunes a value by hand.
function addPresetRow(group, settings, title, subtitle, presets) {
    const row = new Adw.ActionRow({title, subtitle});
    const box = new Gtk.Box({css_classes: ['linked'], valign: Gtk.Align.CENTER});
    for (const [label, values] of presets) {
        const button = new Gtk.Button({label});
        button.connect('clicked', () => {
            for (const [key, value] of Object.entries(values))
                settings.set_int(key, value);
        });
        box.append(button);
    }
    row.add_suffix(box);
    group.add(row);
    return row;
}

// #rrggbb from a Gdk.RGBA (alpha dropped -- these settings are plain hex
// and the picker below runs with alpha disabled).
function rgbaToHex(rgba) {
    const toByte = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${toByte(rgba.red)}${toByte(rgba.green)}${toByte(rgba.blue)}`;
}

function addColorEntryRow(group, settings, key, title) {
    const row = new Adw.EntryRow({
        title,
    });
    row.set_text(settings.get_string(key));
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);

    // A swatch button that opens GTK's color chooser (which also offers the
    // screen eyedropper). Kept two-way in sync with the hex text field:
    // picking a color writes #rrggbb back, and editing/clearing the text
    // updates the swatch. Empty (== use the theme default) leaves the last
    // swatch shown; clearing the text is still how you reset to the theme.
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });

    let syncing = false;
    const syncButtonFromSettings = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key))) {
            syncing = true;
            button.set_rgba(rgba);
            syncing = false;
        }
    };
    syncButtonFromSettings();

    button.connect('notify::rgba', () => {
        if (syncing)
            return;
        const hex = rgbaToHex(button.get_rgba());
        if (hex !== settings.get_string(key))
            settings.set_string(key, hex);
    });
    settings.connect(`changed::${key}`, syncButtonFromSettings);

    row.add_suffix(button);
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
                'Shift+Super+S toggles a stacked (tabbed) layout per workspace.'),
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

        const floatingGroup = new Adw.PreferencesGroup({
            title: _('Floating'),
            description: _(
                'Shift+Super+V toggles floating for the focused window.'),
        });
        page.add(floatingGroup);
        addSpinRow(floatingGroup, settings, 'floating-window-size',
            _('Floating size'),
            _('Centered size when a window is floated, as a percentage of the monitor work area'),
            {lower: 30, upper: 95, step: 5});

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
            _('Hide GNOME’s built-in Activities button'),
            _('The workspace squares take over its job: clicking the space around them toggles the overview, scrolling over them switches workspaces'));

        const topPanelGroup = new Adw.PreferencesGroup({title: _('Top Panel')});
        page.add(topPanelGroup);
        addSwitchRow(topPanelGroup, settings, 'panel-autohide',
            _('Auto-hide the top panel'),
            _('Slide the panel off-screen like a dock and reclaim its space; reveal it by touching the top edge with the pointer.'));
        addScaleRow(topPanelGroup, settings, 'panel-slide-time', _('Slide duration'),
            _('How long the panel takes to slide in or out, in milliseconds'),
            {lower: 50, upper: 2000, step: 50});
        addScaleRow(topPanelGroup, settings, 'panel-opacity',
            _('Background opacity'),
            _('100% is the normal solid panel background; lower values make it translucent'),
            {lower: 0, upper: 100, step: 5});

        const quickMenuGroup = new Adw.PreferencesGroup({
            title: _('Quick Menu'),
            description: _('A button on the right of the top panel with the most-used controls, quick tools (port killer, color picker) and a keybinding reference.'),
        });
        page.add(quickMenuGroup);
        addSwitchRow(quickMenuGroup, settings, 'enable-quick-menu',
            _('Show the quick menu'),
            _('Adds the Tessera menu to the top panel. Off by default.'));

        const sizeGroup = new Adw.PreferencesGroup({title: _('Size & Spacing')});
        page.add(sizeGroup);
        addPresetRow(sizeGroup, settings, _('Preset'),
            _('Sets size, spacing and padding together'), [
                [_('Small'), {'square-size': 16, 'square-spacing': 1, 'square-padding': 2}],
                [_('Medium'), {'square-size': 19, 'square-spacing': 2, 'square-padding': 3}],
                [_('Large'), {'square-size': 22, 'square-spacing': 3, 'square-padding': 4}],
                [_('XL'), {'square-size': 30, 'square-spacing': 4, 'square-padding': 5}],
            ]);
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
        addComboRow(styleGroup, settings, 'label-style', _('Label style'),
            _('1 2 3 · I II III · १ २ ३ · A B C · a b c · क ख ग · ●'),
            ['numbers', 'roman', 'devanagari', 'letters', 'letters-lower',
                'devanagari-letters', 'dots']);
        addSpinRow(styleGroup, settings, 'font-size', _('Font size'),
            _('Size of the workspace number label, in points'), {lower: 6, upper: 32});
        addComboRow(styleGroup, settings, 'font-weight', _('Font weight'),
            _('Weight of the workspace number label'), ['normal', 'bold', '600']);

        const colorGroup = new Adw.PreferencesGroup({
            title: _('Colors'),
            description: _('Hex colors, e.g. #3584e4. Leave empty to use the current GNOME theme.'),
        });
        page.add(colorGroup);
        addColorEntryRow(colorGroup, settings, 'active-background-color', _('Active background'));
        addColorEntryRow(colorGroup, settings, 'inactive-background-color', _('Inactive background'));
        addColorEntryRow(colorGroup, settings, 'active-text-color', _('Active text'));
        addColorEntryRow(colorGroup, settings, 'inactive-text-color', _('Inactive text'));

        const focusBorderGroup = new Adw.PreferencesGroup({
            title: _('Focus Border'),
        });
        page.add(focusBorderGroup);
        addSwitchRow(focusBorderGroup, settings, 'enable-focus-border',
            _('Enable focus border'), '');
        addColorEntryRow(focusBorderGroup, settings, 'focus-border-color', _('Color'));
        addSpinRow(focusBorderGroup, settings, 'focus-border-width', _('Width'),
            _('Thickness of the border, in pixels'), {lower: 1, upper: 12});
        addSpinRow(focusBorderGroup, settings, 'focus-border-radius', _('Radius'),
            _('Corner radius of the border, in pixels'), {lower: 0, upper: 32});

        return page;
    }

    _buildKeybindingsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Keybindings'),
            icon_name: 'input-keyboard-symbolic',
        });

        // const masterGroup = new Adw.PreferencesGroup({
        //     description: _(
        //         'Super+1–9, Super+Left/Right and their Shift variants already ' +
        //         'control other GNOME shortcuts by default (switching to favorite ' +
        //         'apps, snapping windows, moving windows between monitors). ' +
        //         'Enabling this temporarily clears those defaults and restores them ' +
        //         'exactly when disabled.'),
        // });
        // page.add(masterGroup);
        // addSwitchRow(masterGroup, settings, 'enable-custom-keybindings',
        //     _('Enable workspace and window-move keybindings'), '');

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
        addAcceleratorEntryRow(layoutGroup, settings, 'window-toggle-floating',
            _('Toggle floating (focused window)'));
        addAcceleratorEntryRow(layoutGroup, settings, 'window-toggle-maximize',
            _('Toggle maximize (focused window)'));
        addAcceleratorEntryRow(layoutGroup, settings, 'window-toggle-fullscreen',
            _('Toggle fullscreen (focused window)'));

        const panelGroup = new Adw.PreferencesGroup({
            title: _('Panel'),
            description: _('Only active while "Auto-hide the top panel" is on (Appearance → Top Panel).'),
        });
        page.add(panelGroup);
        addAcceleratorEntryRow(panelGroup, settings, 'panel-reveal-toggle',
            _('Reveal / hide the auto-hidden panel'));

        const toolsGroup = new Adw.PreferencesGroup({
            title: _('Tools'),
            description: _('Reachable from the quick menu’s Tools tab too; these work regardless of the quick menu setting.'),
        });
        page.add(toolsGroup);
        addAcceleratorEntryRow(toolsGroup, settings, 'tool-port-killer', _('Port killer'));
        addAcceleratorEntryRow(toolsGroup, settings, 'tool-color-picker', _('Color picker'));

        return page;
    }
}
