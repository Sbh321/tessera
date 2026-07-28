// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

// Terminals in the order a GNOME desktop would prefer them. Tried through
// the app system first so the terminal opens as a proper, tracked
// application (icon, window matching, favorites) rather than a bare
// process; the NEEDS_TERMINAL fallback below covers everything else.
const TERMINAL_APP_IDS = [
    'org.gnome.Console.desktop',
    'org.gnome.Terminal.desktop',
    'kgx.desktop',
    'terminator.desktop',
    'alacritty.desktop',
    'kitty.desktop',
    'xterm.desktop',
];

const LOGIN1_BUS = 'org.freedesktop.login1';
const LOGIN1_PATH = '/org/freedesktop/login1';
const LOGIN1_MANAGER = 'org.freedesktop.login1.Manager';

/**
 * The static action catalogue: everything the launcher can *do* rather
 * than open.
 *
 * Three families live here behind one uniform descriptor, because from
 * the user's side they are the same thing -- type a verb, press Enter:
 *
 *  - system actions (lock, suspend, log out, power off), delegated to
 *    GNOME's own SystemActions singleton so they honour the same lockdown
 *    keys and inhibitors as the system menu, and are simply absent when
 *    the session says they are unavailable;
 *  - shell actions (open Settings, Extensions, a terminal, restart the
 *    shell on X11);
 *  - Tessera's own features -- every toggle and workspace operation the
 *    keybindings expose, made searchable.
 *
 * The third family is the point of the whole provider: it means a Tessera
 * capability needs no new keybinding to be reachable, and adding one
 * later is a single entry in this list.
 *
 * Descriptor shape:
 *   {id, title, subtitle|(): string, iconName, keywords[], run(),
 *    isAvailable?(): boolean}
 */
export class ActionRegistry {
    /**
     * @param {object} context the launcher's shared context (see
     *   launcher.js); `context.tessera` carries the managers this
     *   registry drives, and `context.targetWindow()` yields the window
     *   that was focused when the popup opened.
     */
    constructor(context) {
        this._context = context;
        this._systemActions = SystemActions.getDefault();
        this._actions = null;
        this._canHibernate = false;
        this._hibernateCancellable = null;
    }

    enable() {
        this._queryHibernateSupport();
    }

    disable() {
        this._hibernateCancellable?.cancel();
        this._hibernateCancellable = null;
        this._actions = null;
    }

    /** @returns {Array<object>} descriptors currently offerable */
    get actions() {
        if (!this._actions)
            this._actions = [...this._systemDescriptors(), ...this._shellDescriptors(), ...this._tesseraDescriptors()];

        return this._actions.filter(action => !action.isAvailable || action.isAvailable());
    }

    /**
     * @param {string} id
     * @returns {object|null}
     */
    find(id) {
        return this.actions.find(action => action.id === id) ?? null;
    }

    // --- System ----------------------------------------------------------

    _systemDescriptors() {
        const system = this._systemActions;

        return [
            {
                id: 'lock-screen',
                title: _('Lock Screen'),
                subtitle: _('Lock the session'),
                iconName: 'system-lock-screen-symbolic',
                keywords: ['lock', 'screen', 'secure'],
                isAvailable: () => system.canLockScreen,
                run: () => system.activateLockScreen(),
            },
            {
                id: 'suspend',
                title: _('Suspend'),
                subtitle: _('Sleep, keeping the session in memory'),
                iconName: 'weather-clear-night-symbolic',
                keywords: ['sleep', 'standby'],
                isAvailable: () => system.canSuspend,
                run: () => system.activateSuspend(),
            },
            {
                id: 'hibernate',
                title: _('Hibernate'),
                subtitle: _('Save the session to disk and power off'),
                iconName: 'media-floppy-symbolic',
                keywords: ['sleep', 'suspend', 'disk'],
                // GNOME's SystemActions has no hibernate; this goes
                // straight to logind's public D-Bus API, and the action
                // only appears once logind has confirmed support.
                isAvailable: () => this._canHibernate,
                run: () => this._hibernate(),
            },
            {
                id: 'logout',
                title: _('Log Out'),
                subtitle: _('End the session'),
                iconName: 'system-log-out-symbolic',
                keywords: ['sign out', 'exit', 'session'],
                isAvailable: () => system.canLogout,
                run: () => system.activateLogout(),
            },
            {
                id: 'power-off',
                title: _('Power Off'),
                subtitle: _('Shut the computer down'),
                iconName: 'system-shutdown-symbolic',
                keywords: ['shutdown', 'halt', 'off'],
                isAvailable: () => system.canPowerOff,
                run: () => system.activatePowerOff(),
            },
            {
                id: 'restart',
                title: _('Restart'),
                subtitle: _('Reboot the computer'),
                iconName: 'system-reboot-symbolic',
                keywords: ['reboot'],
                isAvailable: () => system.canRestart,
                run: () => system.activateRestart(),
            },
            {
                id: 'switch-user',
                title: _('Switch User'),
                subtitle: _('Leave this session running and log in as someone else'),
                iconName: 'system-users-symbolic',
                keywords: ['user', 'account'],
                isAvailable: () => system.canSwitchUser,
                run: () => system.activateSwitchUser(),
            },
            {
                id: 'screenshot',
                title: _('Take a Screenshot'),
                subtitle: _('Open the screenshot and screencast tool'),
                iconName: 'camera-photo-symbolic',
                keywords: ['screenshot', 'capture', 'screencast', 'record'],
                run: () => system.activateScreenshotUI(),
            },
        ];
    }

    // --- Shell -----------------------------------------------------------

    _shellDescriptors() {
        return [
            {
                id: 'settings',
                title: _('Settings'),
                subtitle: _('Open GNOME Settings'),
                iconName: 'preferences-system-symbolic',
                keywords: ['control center', 'preferences', 'system'],
                run: () => this._launchAppId([
                    'org.gnome.Settings.desktop', 'gnome-control-center.desktop']),
            },
            {
                id: 'extensions',
                title: _('Extensions'),
                subtitle: _('Manage GNOME Shell extensions'),
                iconName: 'application-x-addon-symbolic',
                keywords: ['addons', 'plugins'],
                run: () => this._launchAppId(['org.gnome.Extensions.desktop']),
            },
            {
                id: 'terminal',
                title: _('Open Terminal'),
                subtitle: _('Start a terminal in your home directory'),
                iconName: 'utilities-terminal-symbolic',
                keywords: ['shell', 'console', 'command line'],
                run: () => this._openTerminal(),
            },
            {
                id: 'restart-shell',
                title: _('Restart GNOME Shell'),
                subtitle: _('Reloads the shell in place, keeping apps running (X11 only)'),
                iconName: 'view-refresh-symbolic',
                keywords: ['reload', 'shell', 'gnome'],
                // Mutter can only restart in place under X11; on Wayland
                // it would end the session and take every app with it, so
                // the action is simply not offered there.
                isAvailable: () => !Meta.is_wayland_compositor(),
                run: () => Meta.restart(_('Restarting…'), global.context),
            },
        ];
    }

    // --- Tessera ---------------------------------------------------------

    _tesseraDescriptors() {
        const {tessera} = this._context;
        const gsettings = this._context.settings.gsettings;
        const stateOf = key => gsettings.get_boolean(key)
            ? _('Currently on') : _('Currently off');

        return [
            {
                id: 'tessera-preferences',
                title: _('Tessera Preferences'),
                subtitle: _('Open this extension’s settings'),
                iconName: 'preferences-other-symbolic',
                keywords: ['tessera', 'settings', 'configure', 'options'],
                run: () => tessera.openPreferences(),
            },
            {
                id: 'tessera-tiling',
                title: _('Toggle Automatic Tiling'),
                subtitle: () => stateOf('enable-tiling'),
                iconName: 'view-grid-symbolic',
                keywords: ['tile', 'tiling', 'layout', 'dwindle', 'off', 'on'],
                run: () => this._toggleBoolean('enable-tiling'),
            },
            {
                id: 'tessera-stacked',
                title: _('Toggle Stacked Layout'),
                subtitle: _('Tabbed layout for this workspace'),
                iconName: 'view-paged-symbolic',
                keywords: ['stack', 'stacked', 'tab', 'tabbed', 'layout'],
                run: () => tessera.tilingManager.toggleStacked(),
            },
            {
                id: 'tessera-floating',
                title: _('Toggle Floating Window'),
                subtitle: _('Pop the focused window out of the layout, or return it'),
                iconName: 'focus-windows-symbolic',
                keywords: ['float', 'floating', 'unfloat', 'window'],
                run: () => tessera.tilingManager.toggleFloating(this._context.targetWindow()),
            },
            {
                id: 'tessera-maximize',
                title: _('Toggle Maximize'),
                subtitle: _('Maximize or restore the focused window'),
                iconName: 'view-fullscreen-symbolic',
                keywords: ['maximize', 'unmaximize', 'window', 'restore'],
                run: () => tessera.windowMover.toggleFocusedMaximize(this._context.targetWindow()),
            },
            {
                id: 'tessera-fullscreen',
                title: _('Toggle Fullscreen'),
                subtitle: _('True fullscreen for the focused window, panel included'),
                iconName: 'view-fullscreen-symbolic',
                keywords: ['fullscreen', 'window'],
                run: () => tessera.fullscreenManager.toggleFocused(this._context.targetWindow()),
            },
            {
                id: 'tessera-focus-border',
                title: _('Toggle Focus Border'),
                subtitle: () => stateOf('enable-focus-border'),
                iconName: 'focus-top-bar-symbolic',
                keywords: ['border', 'focus', 'highlight', 'outline'],
                run: () => this._toggleBoolean('enable-focus-border'),
            },
            {
                id: 'tessera-panel-autohide',
                title: _('Toggle Panel Auto-hide'),
                subtitle: () => stateOf('panel-autohide'),
                iconName: 'focus-top-bar-symbolic',
                keywords: ['panel', 'top bar', 'autohide', 'hide'],
                run: () => this._toggleBoolean('panel-autohide'),
            },
            {
                id: 'tessera-quick-menu',
                title: _('Toggle Quick Menu'),
                subtitle: () => stateOf('enable-quick-menu'),
                iconName: 'view-grid-symbolic',
                keywords: ['menu', 'panel', 'quick'],
                run: () => this._toggleBoolean('enable-quick-menu'),
            },
            {
                id: 'tessera-workspace-new',
                title: _('New Workspace'),
                subtitle: _('Switch to the empty workspace at the end of the strip'),
                iconName: 'list-add-symbolic',
                keywords: ['workspace', 'new', 'create', 'empty', 'trailing'],
                run: () => this._activateWorkspace(global.workspace_manager.n_workspaces - 1),
            },
            {
                id: 'tessera-workspace-next',
                title: _('Next Workspace'),
                subtitle: '',
                iconName: 'go-next-symbolic',
                keywords: ['workspace', 'next', 'right'],
                run: () => this._stepWorkspace(Meta.MotionDirection.RIGHT),
            },
            {
                id: 'tessera-workspace-previous',
                title: _('Previous Workspace'),
                subtitle: '',
                iconName: 'go-previous-symbolic',
                keywords: ['workspace', 'previous', 'left', 'back'],
                run: () => this._stepWorkspace(Meta.MotionDirection.LEFT),
            },
            {
                id: 'tessera-window-trailing',
                title: _('Move Window to the Trailing Workspace'),
                subtitle: _('Send the focused window to the empty workspace at the end'),
                iconName: 'go-last-symbolic',
                keywords: ['move', 'window', 'workspace', 'end', 'trailing'],
                run: () => tessera.windowMover.moveFocusedToLastWorkspace(
                    this._context.targetWindow()),
            },
            {
                id: 'tessera-window-new-workspace',
                title: _('Move Window to a New Workspace'),
                subtitle: _('Insert a workspace to the right and move the focused window into it'),
                iconName: 'go-next-symbolic',
                keywords: ['move', 'window', 'workspace', 'new', 'insert'],
                run: () => tessera.windowMover.moveFocusedToNewWorkspace(
                    Meta.MotionDirection.RIGHT, this._context.targetWindow()),
            },
            {
                id: 'tessera-port-killer',
                title: _('Port Killer'),
                subtitle: _('Terminate whatever is listening on a TCP port'),
                iconName: 'application-exit-symbolic',
                keywords: ['port', 'kill', 'server', 'process', 'tcp'],
                run: () => tessera.openPortKiller(),
            },
            {
                id: 'tessera-color-picker',
                title: _('Color Picker'),
                subtitle: _('Pick a screen color and copy its hex code'),
                iconName: 'color-select-symbolic',
                keywords: ['color', 'colour', 'pick', 'hex', 'eyedropper'],
                run: () => tessera.openColorPicker(),
            },
            {
                id: 'tessera-disable',
                title: _('Disable Tessera'),
                subtitle: _('Turn the extension off; re-enable it from the Extensions app'),
                iconName: 'process-stop-symbolic',
                keywords: ['disable', 'off', 'stop', 'tessera'],
                run: () => this._disableSelf(),
            },
        ];
    }

    // --- Shared runners ---------------------------------------------------

    _toggleBoolean(key) {
        const gsettings = this._context.settings.gsettings;
        gsettings.set_boolean(key, !gsettings.get_boolean(key));
    }

    _activateWorkspace(index) {
        global.workspace_manager.get_workspace_by_index(index)
            ?.activate(global.get_current_time());
    }

    _stepWorkspace(direction) {
        global.workspace_manager.get_active_workspace()
            .get_neighbor(direction)
            ?.activate(global.get_current_time());
    }

    _launchAppId(candidateIds) {
        const appSystem = Shell.AppSystem.get_default();
        for (const id of candidateIds) {
            const app = appSystem.lookup_app(id);
            if (app) {
                app.activate();
                return true;
            }
        }
        return false;
    }

    _openTerminal() {
        if (this._launchAppId(TERMINAL_APP_IDS))
            return;

        // Nothing recognisable installed: hand the user's login shell to
        // GIO's NEEDS_TERMINAL launcher, which finds whatever terminal
        // this system actually has.
        try {
            const shell = GLib.getenv('SHELL') ?? '/bin/sh';
            Gio.AppInfo.create_from_commandline(
                shell, null, Gio.AppInfoCreateFlags.NEEDS_TERMINAL).launch([], null);
        } catch (error) {
            Main.notify(_('Tessera'), _('No terminal application was found.'));
        }
    }

    // ExtensionManager.disableExtension() moves the uuid from
    // enabled-extensions to disabled-extensions, so this persists across
    // restarts exactly like the Extensions app's own switch -- which is
    // why the subtitle says so rather than implying it is temporary.
    // Deferred by one idle turn because disabling tears down the very
    // launcher this call is running inside.
    _disableSelf() {
        const uuid = this._context.tessera.uuid;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            Main.extensionManager.disableExtension(uuid);
            return GLib.SOURCE_REMOVE;
        });
    }

    _queryHibernateSupport() {
        this._hibernateCancellable = new Gio.Cancellable();
        Gio.DBus.system.call(
            LOGIN1_BUS, LOGIN1_PATH, LOGIN1_MANAGER, 'CanHibernate',
            null, new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, -1,
            this._hibernateCancellable,
            (connection, result) => {
                try {
                    const [answer] = connection.call_finish(result).deepUnpack();
                    // "challenge" means logind will ask for authentication
                    // rather than refuse -- still worth offering.
                    this._canHibernate = answer === 'yes' || answer === 'challenge';
                } catch (error) {
                    this._canHibernate = false;
                }
            });
    }

    _hibernate() {
        Gio.DBus.system.call(
            LOGIN1_BUS, LOGIN1_PATH, LOGIN1_MANAGER, 'Hibernate',
            // true == "interactive": let logind raise a polkit prompt
            // instead of failing outright when authentication is needed.
            new GLib.Variant('(b)', [true]), null, Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (error) {
                    Main.notify(_('Tessera'), _('Hibernation failed.'));
                }
            });
    }
}
