// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {ActionProvider} from './actionProvider.js';
import {ActionRegistry} from './actionRegistry.js';
import {AppProvider} from './appProvider.js';
import {CalculatorProvider} from './calculatorProvider.js';
import {ClipboardProvider} from './clipboardProvider.js';
import {CommandProvider} from './commandProvider.js';
import {ExtensionProvider} from './extensionProvider.js';
import {IconProvider} from './iconProvider.js';
import {FavoritesManager} from './favoritesManager.js';
import {HistoryManager} from './historyManager.js';
import {LauncherPopup} from './launcherPopup.js';
import {LauncherTheme} from './theme.js';
import {RecentProvider} from './recentProvider.js';
import {SearchController} from './searchController.js';
import {SettingsProvider} from './settingsProvider.js';
import {WindowProvider} from './windowProvider.js';

// Settings that change how the launcher LOOKS. Anything here is applied
// to a live popup immediately; provider-enable settings are deliberately
// absent because providers consult their own setting on every query and
// therefore need no invalidation at all.
const APPEARANCE_KEYS = [
    'launcher-width',
    'launcher-height',
    'launcher-position',
    'launcher-offset-y',
    'launcher-font-size',
    'launcher-compact',
    'launcher-show-icons',
    'launcher-show-descriptions',
    'launcher-corner-radius',
    'launcher-blur',
    'launcher-animations',
    'launcher-follow-theme',
    'launcher-follow-accent',
    'active-background-color',
];

// Long enough after enable() that it never competes with the shell's own
// startup work, short enough that the first Super+Space is already warm.
const WARM_UP_DELAY_MS = 3000;

/**
 * The launcher subsystem's entry point: builds the providers, owns the
 * popup, and exposes exactly one verb to the rest of the extension --
 * `toggle()`, which KeybindingManager dispatches to.
 *
 * Nothing outside lib/launcher/ knows how search works, and this file is
 * the only one inside it that knows Tessera exists: it assembles the
 * shared `context` every provider receives, which is where the tiling
 * manager, the window mover and the quick tools are handed over. That is
 * the whole coupling surface between the launcher and the rest of the
 * extension.
 *
 * The subsystem is fully inert while `enable-launcher` is off: no
 * providers, no signals, no popup, no caches (extension.js still
 * constructs this object, which is nothing but field initialisation).
 */
export class LauncherManager {
    /**
     * @param {import('../settingsManager.js').SettingsManager} settingsManager
     * @param {import('../accentColor.js').AccentColorTracker} accentColorTracker
     * @param {object} tessera the managers and helpers launcher actions
     *   drive: {tilingManager, windowMover, fullscreenManager,
     *   openPreferences, openPortKiller, openColorPicker, uuid}
     */
    constructor(settingsManager, accentColorTracker, tessera) {
        this._settings = settingsManager;
        this._tessera = tessera;

        this._theme = new LauncherTheme(settingsManager, accentColorTracker);
        this._accentColorTracker = accentColorTracker;
        this._icons = new IconProvider();
        this._history = new HistoryManager(settingsManager.gsettings);
        this._favorites = new FavoritesManager(settingsManager.gsettings);

        this._context = null;
        this._registry = null;
        this._controller = null;
        this._popup = null;

        this._settingsSignalIds = [];
        this._accentSignalIds = [];
        this._warmUpSourceId = null;
    }

    enable() {
        const gsettings = this._settings.gsettings;

        this._settingsSignalIds.push(
            gsettings.connect('changed::enable-launcher', () => this._syncEnabled()));

        for (const key of APPEARANCE_KEYS) {
            this._settingsSignalIds.push(
                gsettings.connect(`changed::${key}`, () => this._popup?.applyTheme()));
        }

        // The launcher follows the system light/dark preference and the
        // accent color live, from the same schema lib/accentColor.js
        // already watches.
        for (const key of ['changed::gtk-theme', 'changed::color-scheme']) {
            this._accentSignalIds.push(
                this._accentColorTracker.gsettings.connect(key, () => this._popup?.applyTheme()));
        }

        this._syncEnabled();
    }

    disable() {
        const gsettings = this._settings.gsettings;
        for (const id of this._settingsSignalIds)
            gsettings.disconnect(id);
        this._settingsSignalIds = [];

        for (const id of this._accentSignalIds)
            this._accentColorTracker.gsettings.disconnect(id);
        this._accentSignalIds = [];

        this._deactivate();
        this._icons.disable();
    }

    /** @returns {boolean} */
    get enabled() {
        return this._settings.enableLauncher;
    }

    /**
     * Opens the launcher, or closes it if it is already open. The one
     * entry point KeybindingManager dispatches into.
     */
    toggle() {
        // The controller check is not redundant with the setting: both
        // this manager and KeybindingManager watch enable-launcher, and
        // nothing guarantees whose handler runs first, so the accelerator
        // can in principle be grabbed a moment before the providers
        // exist. Doing nothing for that one keystroke beats a null
        // dereference inside a key handler.
        if (!this.enabled || !this._controller)
            return;

        if (!this._popup) {
            // Built on first use rather than at enable(): the actor tree
            // costs a few milliseconds that a user who never presses the
            // shortcut should not pay, and every later open reuses it.
            this._popup = new LauncherPopup(this._context, this._controller, this._theme);
        }

        this._popup.toggle();
    }

    /** Closes the popup if it is open; used when the feature is turned off. */
    close() {
        this._popup?.close();
    }

    _syncEnabled() {
        if (this.enabled)
            this._activate();
        else
            this._deactivate();
    }

    _activate() {
        if (this._controller)
            return;

        this._context = {
            settings: this._settings,
            history: this._history,
            favorites: this._favorites,
            icons: this._icons,
            tessera: this._tessera,
            // Resolved through the popup so every action sees the window
            // that was focused when the launcher opened, not whatever
            // holds focus under the modal grab. Falls back to live focus
            // before the popup exists.
            targetWindow: () => this._popup?.targetWindow ?? global.display.focus_window,
        };

        this._registry = new ActionRegistry(this._context);
        this._registry.enable();

        this._controller = new SearchController(this._context);
        this._controller.setProviders([
            new AppProvider(this._context),
            new WindowProvider(this._context),
            new ActionProvider(this._context, this._registry),
            new CommandProvider(this._context),
            new CalculatorProvider(this._context),
            new RecentProvider(this._context),
            new ClipboardProvider(this._context),
            new SettingsProvider(this._context),
            new ExtensionProvider(this._context),
        ]);
        this._controller.enable();

        this._scheduleWarmUp();
    }

    _deactivate() {
        this._cancelWarmUp();

        if (this._popup) {
            this._popup.close();
            this._popup.destroy();
            this._popup = null;
        }

        this._controller?.disable();
        this._controller = null;

        this._registry?.disable();
        this._registry = null;

        this._context = null;
    }

    // Building the app and settings-panel caches means reading every
    // .desktop file on the system. Doing it on an idle a few seconds
    // after enable keeps that off both the shell's startup path and the
    // first keystroke.
    _scheduleWarmUp() {
        this._cancelWarmUp();
        this._warmUpSourceId = GLib.timeout_add(
            GLib.PRIORITY_LOW, WARM_UP_DELAY_MS, () => {
                this._warmUpSourceId = null;
                this._controller?.warmUp();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelWarmUp() {
        if (this._warmUpSourceId !== null) {
            GLib.Source.remove(this._warmUpSourceId);
            this._warmUpSourceId = null;
        }
    }
}
