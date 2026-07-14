// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const MUTTER_KEYBINDINGS_SCHEMA = 'org.gnome.mutter.keybindings';
const DASH_TO_DOCK_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock';
const DASH_TO_DOCK_HOTKEYS_KEY = 'hot-keys';

// These defaults collide with the Super+Number / Super+Arrow accelerators
// this extension wants to own (confirmed against a stock Ubuntu 24.04 /
// GNOME 46 install; see docs/GNOME_NOTES.md). switch-to-application-N is
// GNOME's "activate Nth favorite app" shortcut; toggle-tiled-left/right is
// the half-screen window snap shortcut.
const SHELL_KEYS_TO_CLEAR = [
    'switch-to-application-1', 'switch-to-application-2', 'switch-to-application-3',
    'switch-to-application-4', 'switch-to-application-5', 'switch-to-application-6',
    'switch-to-application-7', 'switch-to-application-8', 'switch-to-application-9',
];
const MUTTER_KEYS_TO_CLEAR = ['toggle-tiled-left', 'toggle-tiled-right'];

// Ubuntu Dock (the preinstalled "ubuntu-dock" extension, a Dash to Dock
// fork sharing its schema) is a SECOND, independent owner of Super+1..0:
// its `hot-keys` master switch (default true) makes it grab those combos
// itself -- plus the Shift/Ctrl variants -- to activate the Nth pinned
// dock app. Clearing org.gnome.shell.keybindings above never touched these
// grabs, which is why Super+N could still intermittently launch a dock app
// instead of switching workspace (and why e.g. Super+5 with only 3
// workspaces launched the 5th dock app). Flipping this one boolean makes
// the dock itself remove all of its number-key grabs; the exact prior
// value is saved and restored on disable() like everything else here.
//
// The schema only exists when Ubuntu Dock / Dash to Dock is installed, so
// it must be looked up through the schema source rather than constructed
// directly -- new Gio.Settings({schema_id}) hard-aborts the whole
// gnome-shell process on a missing schema instead of failing recoverably.
function lookupOptionalSettings(schemaId, requiredKey) {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true);
    if (!schema?.has_key(requiredKey))
        return null;
    return new Gio.Settings({settings_schema: schema});
}

const ACTION_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

// GNOME's own handler for a default keybinding we clear reacts to that
// change asynchronously -- it lives on its own separate Gio.Settings
// instance (inside windowManager.js, not ours), so it only learns of our
// write after a real dconf round trip, not synchronously like our own
// instance does. That race is what let GNOME's original binding
// occasionally win and fire instead of ours. Re-asserting our grab once
// shortly after the initial bind gives that reaction time to finish first,
// so we reliably end up grabbing last.
const REASSERT_DELAY_MS = 250;

/**
 * Owns the extension's Super+1..9 / Super+Left / Super+Right keybindings.
 *
 * Mutter dispatches only one action per accelerator, so to make these
 * bindings reliable this manager temporarily neutralizes every OTHER owner
 * of the same combos for as long as the extension is enabled -- the GNOME
 * shell/mutter defaults listed above, plus Ubuntu Dock's own Super+Number
 * hot-keys (see DASH_TO_DOCK_SCHEMA above) -- and restores the user's
 * exact prior values, not the schema defaults, on disable(). This is the
 * only place in the extension that reaches outside its own GSettings
 * schema, and it is fully reversible.
 *
 * Two defenses keep this robust rather than a one-shot best-effort clear:
 * 1. A short delayed re-assertion of both the clear and the grab, to win
 *    the async race described above.
 * 2. A persistent watch on every cleared key: if anything (GNOME itself,
 *    a settings sync, another tool) ever repopulates one of them while
 *    this extension is enabled, it's cleared again immediately and our
 *    keybindings are re-grabbed.
 */
export class KeybindingManager {
    constructor(settingsManager) {
        this._settingsManager = settingsManager;
        this._shellKeybindingsSettings = new Gio.Settings({schema_id: SHELL_KEYBINDINGS_SCHEMA});
        this._mutterKeybindingsSettings = new Gio.Settings({schema_id: MUTTER_KEYBINDINGS_SCHEMA});
        this._dashToDockSettings = lookupOptionalSettings(
            DASH_TO_DOCK_SCHEMA, DASH_TO_DOCK_HOTKEYS_KEY);

        this._savedShellValues = null;
        this._savedMutterValues = null;
        this._savedDashToDockHotKeys = null;
        this._boundNames = [];
        this._settingsChangedId = null;
        this._conflictWatchIds = [];
        this._reassertSourceId = null;
    }

    enable() {
        this._settingsChangedId = this._settingsManager.gsettings.connect(
            'changed::enable-custom-keybindings', () => this._syncEnabled());
        this._syncEnabled();
    }

    disable() {
        this._unbindAll();

        if (this._settingsChangedId !== null) {
            this._settingsManager.gsettings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
    }

    _syncEnabled() {
        const shouldBeBound = this._settingsManager.enableCustomKeybindings;
        const isBound = this._boundNames.length > 0;

        if (shouldBeBound && !isBound)
            this._bindAll();
        else if (!shouldBeBound && isBound)
            this._unbindAll();
    }

    _bindAll() {
        this._savedShellValues = this._clearKeys(
            this._shellKeybindingsSettings, SHELL_KEYS_TO_CLEAR);
        this._savedMutterValues = this._clearKeys(
            this._mutterKeybindingsSettings, MUTTER_KEYS_TO_CLEAR);

        if (this._dashToDockSettings) {
            this._savedDashToDockHotKeys =
                this._dashToDockSettings.get_boolean(DASH_TO_DOCK_HOTKEYS_KEY);
            this._disableDashToDockHotKeys();
        }

        this._grabAll();
        this._watchForConflicts();

        this._reassertSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REASSERT_DELAY_MS, () => {
            this._clearKeys(this._shellKeybindingsSettings, SHELL_KEYS_TO_CLEAR);
            this._clearKeys(this._mutterKeybindingsSettings, MUTTER_KEYS_TO_CLEAR);
            this._disableDashToDockHotKeys();
            this._grabAll();
            this._reassertSourceId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _disableDashToDockHotKeys() {
        if (this._dashToDockSettings?.get_boolean(DASH_TO_DOCK_HOTKEYS_KEY))
            this._dashToDockSettings.set_boolean(DASH_TO_DOCK_HOTKEYS_KEY, false);
    }

    _unbindAll() {
        if (this._reassertSourceId !== null) {
            GLib.Source.remove(this._reassertSourceId);
            this._reassertSourceId = null;
        }

        for (const [settings, handlerId] of this._conflictWatchIds)
            settings.disconnect(handlerId);
        this._conflictWatchIds = [];

        for (const name of this._boundNames)
            Main.wm.removeKeybinding(name);
        this._boundNames = [];

        if (this._savedShellValues)
            this._restoreKeys(this._shellKeybindingsSettings, this._savedShellValues);
        if (this._savedMutterValues)
            this._restoreKeys(this._mutterKeybindingsSettings, this._savedMutterValues);
        if (this._dashToDockSettings && this._savedDashToDockHotKeys !== null) {
            this._dashToDockSettings.set_boolean(
                DASH_TO_DOCK_HOTKEYS_KEY, this._savedDashToDockHotKeys);
        }

        this._savedShellValues = null;
        this._savedMutterValues = null;
        this._savedDashToDockHotKeys = null;
    }

    // Watches every key we cleared for as long as we're enabled. If one
    // becomes non-empty again for any reason, it's cleared right back and
    // our own keybindings are re-grabbed defensively.
    _watchForConflicts() {
        const watch = (settings, key) => {
            const handlerId = settings.connect(`changed::${key}`, () => {
                if (settings.get_strv(key).length === 0)
                    return;
                settings.set_strv(key, []);
                this._grabAll();
            });
            this._conflictWatchIds.push([settings, handlerId]);
        };

        for (const key of SHELL_KEYS_TO_CLEAR)
            watch(this._shellKeybindingsSettings, key);
        for (const key of MUTTER_KEYS_TO_CLEAR)
            watch(this._mutterKeybindingsSettings, key);

        if (this._dashToDockSettings) {
            const handlerId = this._dashToDockSettings.connect(
                `changed::${DASH_TO_DOCK_HOTKEYS_KEY}`, () => {
                    if (!this._dashToDockSettings.get_boolean(DASH_TO_DOCK_HOTKEYS_KEY))
                        return;
                    this._dashToDockSettings.set_boolean(DASH_TO_DOCK_HOTKEYS_KEY, false);
                    this._grabAll();
                });
            this._conflictWatchIds.push([this._dashToDockSettings, handlerId]);
        }
    }

    _grabAll() {
        for (let i = 0; i < 9; i++) {
            const index = i;
            this._addKeybinding(
                this._settingsManager.workspaceJumpKeyName(index),
                () => this._jumpTo(index));
        }

        this._addKeybinding('workspace-previous', () => this._step(Meta.MotionDirection.LEFT));
        this._addKeybinding('workspace-next', () => this._step(Meta.MotionDirection.RIGHT));
    }

    // Safe to call more than once for the same name (used both for the
    // first bind and every re-assertion below): removes any grab this
    // manager already holds for that name first, rather than relying on
    // Main.wm.addKeybinding's own idempotency for a re-grab we initiate
    // ourselves, as opposed to it reacting to its own settings watch.
    _addKeybinding(name, handler) {
        if (this._boundNames.includes(name))
            Main.wm.removeKeybinding(name);
        else
            this._boundNames.push(name);

        const action = Main.wm.addKeybinding(
            name,
            this._settingsManager.gsettings,
            Meta.KeyBindingFlags.NONE,
            ACTION_MODES,
            handler);

        if (!action)
            console.warn(`tessera: failed to grab keybinding "${name}"`);
    }

    _clearKeys(settings, keys) {
        const saved = new Map();
        for (const key of keys) {
            saved.set(key, settings.get_strv(key));
            settings.set_strv(key, []);
        }
        return saved;
    }

    _restoreKeys(settings, saved) {
        for (const [key, value] of saved)
            settings.set_strv(key, value);
    }

    _jumpTo(index) {
        const workspace = global.workspace_manager.get_workspace_by_index(index);
        if (workspace)
            workspace.activate(global.get_current_time());
    }

    _step(direction) {
        const neighbor = global.workspace_manager.get_active_workspace().get_neighbor(direction);
        if (neighbor)
            neighbor.activate(global.get_current_time());
    }
}
