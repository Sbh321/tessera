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

// A row of linked buttons that each write one string value. Same
// one-shot idea as addPresetRow: clicking a preset just fills the key
// (the entry row above updates through its binding), so there is no
// "which preset is active" state to drift once the value is hand-edited.
function addStringPresetRow(group, settings, key, title, subtitle, presets) {
    const row = new Adw.ActionRow({title, subtitle});
    const box = new Gtk.Box({css_classes: ['linked'], valign: Gtk.Align.CENTER});

    for (const [label, value] of presets) {
        const button = new Gtk.Button({label});
        button.connect('clicked', () => settings.set_string(key, value));
        box.append(button);
    }

    row.add_suffix(box);
    group.add(row);
    return row;
}

// A row whose only control is a button -- used for the destructive
// "forget what the launcher has learned" actions, which are one-shot
// operations rather than settings.
function addButtonRow(group, title, subtitle, label, onClick, {destructive = false} = {}) {
    const row = new Adw.ActionRow({title, subtitle});
    const button = new Gtk.Button({
        label,
        valign: Gtk.Align.CENTER,
        css_classes: destructive ? ['destructive-action'] : [],
    });
    button.connect('clicked', () => onClick(button));
    row.add_suffix(button);
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

// Keyvals that are modifiers on their own -- ignored while recording, so we
// keep waiting for a real key to complete the combo.
const MODIFIER_KEYVALS = new Set([
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
    Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R,
    Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
    Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_ISO_Level5_Shift,
    Gdk.KEY_Caps_Lock, Gdk.KEY_Num_Lock,
]);

// Tracks every shortcut row on the page so it can flag when two of the
// extension's own bindings share the same accelerator. (System-wide
// conflicts with other apps aren't checked -- there is no cheap, reliable
// way to enumerate every grabbed shortcut, and the extension already clears
// the GNOME defaults it collides with.)
function createShortcutRegistry(settings) {
    const entries = [];

    const refresh = () => {
        const byAccel = new Map();
        for (const entry of entries) {
            const value = settings.get_strv(entry.key);
            const accel = value.length > 0 ? value[0] : '';
            if (!accel)
                continue;
            if (!byAccel.has(accel))
                byAccel.set(accel, []);
            byAccel.get(accel).push(entry);
        }

        for (const entry of entries) {
            const value = settings.get_strv(entry.key);
            const accel = value.length > 0 ? value[0] : '';
            const clashers = accel
                ? byAccel.get(accel).filter(other => other !== entry)
                : [];
            if (clashers.length > 0) {
                entry.row.set_subtitle(
                    `⚠ ${_('Also bound to')}: ${clashers.map(o => o.title).join(', ')}`);
                entry.row.add_css_class('warning');
            } else {
                entry.row.set_subtitle('');
                entry.row.remove_css_class('warning');
            }
        }
    };

    return {
        register: (key, title, row) => entries.push({key, title, row}),
        refresh,
    };
}

// A shortcut-recorder row: a button showing the current accelerator that,
// when clicked, records the next key combo pressed. Uses the Wayland
// shortcuts-inhibit protocol (Gdk.Toplevel.inhibit_system_shortcuts) while
// recording so combos the compositor/this extension globally grab -- like
// Super+1 -- actually reach us instead of firing their action.
function addShortcutRow(group, settings, key, title, registry) {
    const row = new Adw.ActionRow({title});

    const shortcutLabel = new Gtk.ShortcutLabel({
        valign: Gtk.Align.CENTER,
        disabled_text: _('Disabled'),
    });
    const button = new Gtk.Button({
        valign: Gtk.Align.CENTER,
        child: shortcutLabel,
        tooltip_text: _('Click, then press a shortcut. Backspace clears, Esc cancels.'),
    });
    row.add_suffix(button);
    row.activatable_widget = button;

    const showStored = () => {
        const value = settings.get_strv(key);
        shortcutLabel.set_accelerator(value.length > 0 ? value[0] : '');
    };
    showStored();

    let capturing = false;
    let toplevel = null;

    const stopCapture = () => {
        if (!capturing)
            return;
        capturing = false;
        button.remove_css_class('suggested-action');
        shortcutLabel.set_disabled_text(_('Disabled'));
        showStored();
        if (toplevel) {
            toplevel.restore_system_shortcuts();
            toplevel = null;
        }
    };

    const startCapture = () => {
        if (capturing) {
            stopCapture();
            return;
        }
        capturing = true;
        button.add_css_class('suggested-action');
        shortcutLabel.set_accelerator('');
        shortcutLabel.set_disabled_text(_('Press a shortcut…'));

        toplevel = button.get_native()?.get_surface?.() ?? null;
        if (typeof toplevel?.inhibit_system_shortcuts === 'function')
            toplevel.inhibit_system_shortcuts(null);
        else
            toplevel = null;

        button.grab_focus();
    };

    button.connect('clicked', startCapture);

    const controller = new Gtk.EventControllerKey();
    controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    button.add_controller(controller);
    controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
        if (!capturing)
            return Gdk.EVENT_PROPAGATE;

        let mask = state & Gtk.accelerator_get_default_mod_mask();
        mask &= ~Gdk.ModifierType.LOCK_MASK;

        if (keyval === Gdk.KEY_Escape && mask === 0) {
            stopCapture();
            return Gdk.EVENT_STOP;
        }
        if ((keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) && mask === 0) {
            settings.set_strv(key, []);
            stopCapture();
            registry.refresh();
            return Gdk.EVENT_STOP;
        }
        if (MODIFIER_KEYVALS.has(keyval))
            return Gdk.EVENT_STOP; // still holding only modifiers
        if (!Gtk.accelerator_valid(keyval, mask))
            return Gdk.EVENT_STOP; // e.g. a bare letter -- keep waiting

        settings.set_strv(key, [Gtk.accelerator_name(keyval, mask)]);
        stopCapture();
        registry.refresh();
        return Gdk.EVENT_STOP;
    });

    // If focus leaves the button mid-recording (the user clicked elsewhere
    // without pressing a combo), cancel cleanly so system shortcuts are
    // never left inhibited.
    const focusController = new Gtk.EventControllerFocus();
    button.add_controller(focusController);
    focusController.connect('leave', () => stopCapture());

    settings.connect(`changed::${key}`, () => {
        if (!capturing)
            showStored();
        registry.refresh();
    });

    group.add(row);
    registry.register(key, title, row);
    return row;
}

export default class TesseraPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // One registry across every page, so the launcher's shortcut is
        // checked for conflicts against the workspace and tool shortcuts
        // too -- they all end up in the same accelerator namespace.
        const registry = createShortcutRegistry(settings);

        const pages = {
            appearance: this._buildAppearancePage(settings),
            tiling: this._buildTilingPage(settings),
            launcher: this._buildLauncherPage(settings, registry),
            keybindings: this._buildKeybindingsPage(settings, registry),
        };
        for (const page of Object.values(pages))
            window.add(page);

        // Flag any pre-existing duplicate accelerators on open.
        registry.refresh();

        this._openRequestedPage(window, settings, pages);
    }

    // The shell cannot ask openExtensionPrefs for a particular page, so
    // it leaves the wanted one in GSettings just before opening this
    // window (the launcher's settings gear does this). The note is
    // consumed here, so the next manual open lands on the usual first
    // page instead of wherever the last shortcut pointed.
    _openRequestedPage(window, settings, pages) {
        const requested = settings.get_string('prefs-initial-page');
        if (!requested)
            return;

        settings.set_string('prefs-initial-page', '');
        if (pages[requested])
            window.set_visible_page(pages[requested]);
    }

    _buildLauncherPage(settings, registry) {
        const page = new Adw.PreferencesPage({
            title: _('Launcher'),
            icon_name: 'edit-find-symbolic',
        });

        const generalGroup = new Adw.PreferencesGroup({
            description: _(
                'A Spotlight-style search popup for applications, open windows, ' +
                'settings panels, extensions, Tessera’s own actions and arithmetic. ' +
                'Super+Space is GNOME’s “switch input source” shortcut by default: ' +
                'while the launcher is enabled that shortcut is cleared, and it is ' +
                'restored exactly as it was when the launcher is turned off again.'),
        });
        page.add(generalGroup);
        addSwitchRow(generalGroup, settings, 'enable-launcher',
            _('Enable the launcher'), '');
        addShortcutRow(generalGroup, settings, 'launcher-toggle',
            _('Open the launcher'), registry);
        addSpinRow(generalGroup, settings, 'launcher-max-results', _('Maximum results'),
            _('Across all sections; each section is additionally capped'),
            {lower: 5, upper: 100, step: 5});
        addSwitchRow(generalGroup, settings, 'launcher-remember-history',
            _('Remember what you launch'),
            _('Rank future searches by how often and how recently you pick each result'));

        const sourcesGroup = new Adw.PreferencesGroup({
            title: _('What to Search'),
            description: _(
                'Actions, GNOME Settings panels and extensions are always searched.'),
        });
        page.add(sourcesGroup);
        addSwitchRow(sourcesGroup, settings, 'launcher-enable-apps',
            _('Installed applications'), '');
        addSwitchRow(sourcesGroup, settings, 'launcher-enable-windows',
            _('Open windows'), '');
        addSwitchRow(sourcesGroup, settings, 'launcher-enable-recent',
            _('Recent applications'),
            _('Shown when the search box is empty'));
        addSwitchRow(sourcesGroup, settings, 'launcher-enable-calculator',
            _('Calculator'),
            _('“2+2”, “sqrt(144)”, “200 + 15%”, “0xff * 2”. Enter copies the result.'));
        addSwitchRow(sourcesGroup, settings, 'launcher-enable-commands',
            _('Run commands'),
            _('Type “>” or “$” first. Commands never go through a shell, so “;” and “|” have no special meaning.'));
        const terminalRow = addSwitchRow(sourcesGroup, settings, 'launcher-command-in-terminal',
            _('Run commands in a terminal'),
            _('Ctrl+Enter always does the opposite for one command'));
        settings.bind('launcher-enable-commands', terminalRow, 'sensitive',
            Gio.SettingsBindFlags.GET);

        const clipboardGroup = new Adw.PreferencesGroup({
            title: _('Clipboard History'),
            description: _(
                'Off by default: this keeps a plain-text record of everything you copy ' +
                'in your settings database. Entries that password managers mark as ' +
                'secrets are never recorded, nothing is recorded while the screen is ' +
                'locked, and clipboard entries never enter the ranking history.'),
        });
        page.add(clipboardGroup);
        addSwitchRow(clipboardGroup, settings, 'launcher-enable-clipboard',
            _('Keep a searchable clipboard history'), '');
        const clipboardSizeRow = addSpinRow(clipboardGroup, settings, 'launcher-clipboard-size',
            _('Entries to keep'),
            _('Pinned entries are kept regardless of this limit'),
            {lower: 5, upper: 500, step: 5});
        settings.bind('launcher-enable-clipboard', clipboardSizeRow, 'sensitive',
            Gio.SettingsBindFlags.GET);

        const paletteGroup = new Adw.PreferencesGroup({
            title: _('Slash Palette'),
            description: _(
                'Typing “/” as the first character opens a palette: pick a section to ' +
                'filter the results to, or run a command such as “/search” or “/chat”. The result ' +
                'list is also filterable directly from the chips under the search box ' +
                '(click them, or move between them with Ctrl+Tab).'),
        });
        page.add(paletteGroup);
        const searchUrlRow = new Adw.EntryRow({title: _('Web search URL')});
        settings.bind('launcher-search-url', searchUrlRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        paletteGroup.add(searchUrlRow);
        addStringPresetRow(paletteGroup, settings, 'launcher-search-url',
            _('Search engine'),
            _(''), [
                [_('Google'), 'https://www.google.com/search?q=%s'],
                [_('DuckDuckGo'), 'https://duckduckgo.com/?q=%s'],
                [_('Bing'), 'https://www.bing.com/search?q=%s'],
            ]);

        const chatUrlRow = new Adw.EntryRow({title: _('AI chat URL')});
        settings.bind('launcher-chat-url', chatUrlRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        paletteGroup.add(chatUrlRow);
        addStringPresetRow(paletteGroup, settings, 'launcher-chat-url',
            _('AI chat service'),
            _(''), [
                ['ChatGPT', 'https://chatgpt.com/?q=%s'],
                ['Claude', 'https://claude.ai/new?q=%s'],
                ['Gemini', 'https://gemini.google.com/app?q=%s'],
                ['Grok', 'https://grok.com/?q=%s'],
                ['DeepSeek', 'https://chat.deepseek.com/?q=%s'],
            ]);

        const searchGroup = new Adw.PreferencesGroup({title: _('Matching')});
        page.add(searchGroup);
        addSwitchRow(searchGroup, settings, 'launcher-fuzzy',
            _('Tolerate typos'),
            _('Exact, prefix, word and initials matches always rank above fuzzy ones'));
        addSpinRow(searchGroup, settings, 'launcher-search-delay', _('Search delay'),
            _('Milliseconds to wait after a keystroke; 0 searches immediately'),
            {lower: 0, upper: 500, step: 10});

        const placementGroup = new Adw.PreferencesGroup({
            title: _('Placement'),
            description: _(
                'The launcher opens on whichever monitor the pointer is on, near the ' +
                'upper third of it.'),
        });
        page.add(placementGroup);
        addComboRow(placementGroup, settings, 'launcher-position', _('Horizontal position'),
            _('Left and right anchor to the work area, clear of docks and side panels'),
            ['center', 'left', 'right']);
        addSpinRow(placementGroup, settings, 'launcher-offset-y', _('Vertical offset'),
            _('Nudge up or down from the default height, in pixels: negative moves up, positive moves down'),
            {lower: -2000, upper: 2000, step: 10});

        const appearanceGroup = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(appearanceGroup);
        addSpinRow(appearanceGroup, settings, 'launcher-width', _('Width'),
            _('Width of the popup, in pixels'), {lower: 420, upper: 1400, step: 20});
        addSpinRow(appearanceGroup, settings, 'launcher-height', _('Result list height'),
            _('Maximum height of the result list, in pixels'), {lower: 200, upper: 1200, step: 20});
        addSpinRow(appearanceGroup, settings, 'launcher-corner-radius', _('Corner radius'),
            _('Corner rounding of the popup, in pixels'), {lower: 0, upper: 40});
        addSpinRow(appearanceGroup, settings, 'launcher-font-size', _('Font size'),
            _('Base font size, in points'), {lower: 8, upper: 24});
        addSwitchRow(appearanceGroup, settings, 'launcher-compact', _('Compact mode'),
            _('Shorter rows and smaller icons, so more results fit'));
        addSwitchRow(appearanceGroup, settings, 'launcher-show-icons', _('Show icons'), '');
        addSwitchRow(appearanceGroup, settings, 'launcher-show-descriptions',
            _('Show descriptions'), _('The second line of each result'));
        addSwitchRow(appearanceGroup, settings, 'launcher-animations', _('Animate'),
            _('Also skipped whenever GNOME’s “reduce animations” setting is on'));
        addSwitchRow(appearanceGroup, settings, 'launcher-blur', _('Blur the background'),
            _('Off by default: the shell’s blur always fills a rectangle, so it leaves faintly blurred square corners around the rounded popup'));
        addSwitchRow(appearanceGroup, settings, 'launcher-follow-theme',
            _('Follow the system light/dark theme'),
            _('When off, the launcher stays dark'));
        addSwitchRow(appearanceGroup, settings, 'launcher-follow-accent',
            _('Follow the system accent color'),
            _('Tints the selected result; uses the custom active color if one is set'));

        const dataGroup = new Adw.PreferencesGroup({
            title: _('Stored Data'),
            description: _('All of this lives in Tessera’s own settings and is safe to clear.'),
        });
        page.add(dataGroup);
        addButtonRow(dataGroup, _('Ranking history'),
            _('What you have launched, and how recently'),
            _('Forget'), button => {
                settings.set_string('launcher-history', '{}');
                button.set_label(_('Forgotten'));
            }, {destructive: true});
        addButtonRow(dataGroup, _('Pinned results'), _('Everything pinned with Ctrl+D'),
            _('Clear'), button => {
                settings.set_strv('launcher-favorites', []);
                button.set_label(_('Cleared'));
            }, {destructive: true});
        addButtonRow(dataGroup, _('Clipboard history'),
            _('Recorded and pinned clipboard entries'),
            _('Clear'), button => {
                settings.set_strv('launcher-clipboard-history', []);
                settings.set_strv('launcher-clipboard-pinned', []);
                button.set_label(_('Cleared'));
            }, {destructive: true});

        // Everything below the master switch is meaningless while the
        // launcher is off, and the shell ignores it -- so the rows say so
        // instead of pretending to have an effect (the same GET-only
        // binding pattern the tiling page uses).
        for (const group of [sourcesGroup, clipboardGroup, paletteGroup, searchGroup, placementGroup,
            appearanceGroup])
            settings.bind('enable-launcher', group, 'sensitive', Gio.SettingsBindFlags.GET);

        return page;
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

        const newWindowGroup = new Adw.PreferencesGroup({
            title: _('New Windows'),
            description: _(
                'Dialogs, popups and windows pinned to all workspaces are never ' +
                'moved. An empty workspace that already exists is used instead of ' +
                'creating another one: a window opening on an empty workspace stays ' +
                'where it is, and one that opens elsewhere while you are looking at ' +
                'an empty workspace comes to you.'),
        });
        page.add(newWindowGroup);
        addSwitchRow(newWindowGroup, settings, 'new-window-new-workspace',
            _('Open each new window on its own workspace'),
            _('Move a newly opened application window to a fresh workspace and follow it there'));
        const adjacentRow = addSwitchRow(newWindowGroup, settings,
            'new-window-adjacent-workspace',
            _('Place that workspace next to the current one'),
            _('Insert the new workspace immediately to the right of the current one instead of using the trailing workspace at the end'));
        // Only meaningful while the switch above is on -- the shell ignores
        // it otherwise, so the row follows suit instead of pretending to
        // have an effect. GET-only: this reads the master switch, it must
        // never write back to it.
        settings.bind('new-window-new-workspace', adjacentRow, 'sensitive',
            Gio.SettingsBindFlags.GET);

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

    _buildKeybindingsPage(settings, registry) {
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

        const addShortcut = (grp, key, ttl) =>
            addShortcutRow(grp, settings, key, ttl, registry);

        const jumpGroup = new Adw.PreferencesGroup({
            title: _('Jump to Workspace'),
            description: _('Click a shortcut, then press the keys. Backspace clears it, Esc cancels. Conflicts within these bindings are flagged below the row.'),
        });
        page.add(jumpGroup);
        for (let i = 1; i <= 9; i++)
            addShortcut(jumpGroup, `workspace-jump-${i}`, `${_('Workspace')} ${i}`);
        addShortcut(jumpGroup, 'workspace-jump-last', _('Trailing workspace'));

        const navigateGroup = new Adw.PreferencesGroup({title: _('Navigate')});
        page.add(navigateGroup);
        addShortcut(navigateGroup, 'workspace-previous', _('Previous workspace'));
        addShortcut(navigateGroup, 'workspace-next', _('Next workspace'));

        const moveGroup = new Adw.PreferencesGroup({
            title: _('Move Window to Workspace'),
            description: _('Moves the focused window and follows it'),
        });
        page.add(moveGroup);
        for (let i = 1; i <= 9; i++)
            addShortcut(moveGroup, `window-move-${i}`, `${_('Workspace')} ${i}`);
        addShortcut(moveGroup, 'window-move-last', _('Trailing workspace'));

        const moveNewGroup = new Adw.PreferencesGroup({
            title: _('Move Window to New Workspace'),
            description: _('Inserts a new workspace beside the current one (dynamic workspaces only) and moves the focused window into it'),
        });
        page.add(moveNewGroup);
        addShortcut(moveNewGroup, 'window-move-new-left', _('Insert left'));
        addShortcut(moveNewGroup, 'window-move-new-right', _('Insert right'));

        const swapGroup = new Adw.PreferencesGroup({
            title: _('Swap Workspace Contents'),
            description: _('Exchanges all windows between the current workspace and the chosen one, then follows the content there. Does nothing if the current workspace is empty.'),
        });
        page.add(swapGroup);
        for (let i = 1; i <= 9; i++)
            addShortcut(swapGroup, `workspace-swap-${i}`, `${_('Workspace')} ${i}`);

        const layoutGroup = new Adw.PreferencesGroup({title: _('Layout')});
        page.add(layoutGroup);
        addShortcut(layoutGroup, 'layout-toggle-stacked', _('Toggle stacked layout'));
        addShortcut(layoutGroup, 'window-toggle-floating', _('Toggle floating (focused window)'));
        addShortcut(layoutGroup, 'window-toggle-maximize', _('Toggle maximize (focused window)'));
        addShortcut(layoutGroup, 'window-toggle-fullscreen', _('Toggle fullscreen (focused window)'));

        const panelGroup = new Adw.PreferencesGroup({
            title: _('Panel'),
            description: _('Only active while "Auto-hide the top panel" is on (Appearance → Top Panel).'),
        });
        page.add(panelGroup);
        addShortcut(panelGroup, 'panel-reveal-toggle', _('Reveal / hide the auto-hidden panel'));

        const toolsGroup = new Adw.PreferencesGroup({
            title: _('Tools'),
            description: _('Reachable from the quick menu’s Tools tab too; these work regardless of the quick menu setting.'),
        });
        page.add(toolsGroup);
        addShortcut(toolsGroup, 'tool-port-killer', _('Port killer'));
        addShortcut(toolsGroup, 'tool-color-picker', _('Color picker'));

        return page;
    }
}
