// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {ProviderId} from './constants.js';
import {ActivationMode} from './searchResult.js';
import {SearchProvider} from './searchProvider.js';

const TERMINAL_SCHEMA = 'org.gnome.desktop.default-applications.terminal';
const TERMINAL_EXEC_KEY = 'exec';
const TERMINAL_EXEC_ARG_KEY = 'exec-arg';

/**
 * Runs a command line, explicitly requested with a `>` or `$` prefix.
 *
 * SECURITY: no shell is ever involved. The command is split by
 * `GLib.shell_parse_argv()` -- which *parses* quoting rules, it does not
 * execute anything -- and the resulting argv is handed to
 * `GLib.spawn_async()` through GNOME's own `Util.trySpawnCommandLine()`,
 * exactly as the shell's Alt+F2 run dialog does. So `> foo; rm -rf ~`
 * tries to run a program literally named "foo;" and fails: there is no
 * interpreter to honour the `;`, the backticks, or a `$(...)`.
 *
 * The prefix requirement is part of that safety story too. Commands are
 * never inferred from a bare query, so a plain search can never
 * accidentally execute anything -- the user has to state the intent with
 * a character no application name starts with.
 */
export class CommandProvider extends SearchProvider {
    constructor(context) {
        super(ProviderId.COMMANDS, context);
        this._terminalSettings = null;
    }

    get enabled() {
        return this.context.settings.launcherEnableCommands;
    }

    enable() {
        // Looked up through the schema source rather than constructed
        // directly: `new Gio.Settings()` on a missing schema aborts the
        // whole gnome-shell process (see lib/keybindingManager.js), and
        // this schema, while part of gsettings-desktop-schemas, is not
        // ours to assume.
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup(TERMINAL_SCHEMA, true);
        if (schema?.has_key(TERMINAL_EXEC_KEY))
            this._terminalSettings = new Gio.Settings({settings_schema: schema});
    }

    disable() {
        this._terminalSettings = null;
    }

    query(parsed) {
        if (!parsed.prefix || parsed.commandBody.length === 0)
            return [];

        const command = parsed.commandBody;
        const program = this._programOf(command);
        const path = program ? GLib.find_program_in_path(program) : null;
        const inTerminal = this.context.settings.launcherCommandInTerminal;

        return [this.createResult({
            id: command,
            title: command,
            // Telling the user whether the program exists BEFORE they
            // press Enter is the difference between a launcher and a
            // guessing game; a missing program is still runnable (the
            // spawn error is reported), it is just flagged.
            subtitle: this._describe(path, program, inTerminal),
            iconName: inTerminal ? 'utilities-terminal-symbolic' : 'system-run-symbolic',
            // Always the top result: the prefix made the intent explicit,
            // and this provider is the only one consulted for it.
            score: 1,
            alternateLabel: inTerminal ? _('Run without a terminal') : _('Run in a terminal'),
            activate: mode => this._run(command, mode === ActivationMode.ALTERNATE
                ? !inTerminal : inTerminal),
        })];
    }

    _describe(path, program, inTerminal) {
        if (!program)
            return _('Enter a command to run');
        if (!path)
            return _('“%s” was not found in PATH').format(program);
        return inTerminal ? _('Run in a terminal: %s').format(path) : _('Run: %s').format(path);
    }

    // The executable is the first parsed argument -- parsed, not
    // whitespace-split, so `> "/opt/my app/run" --flag` resolves the
    // quoted path rather than "/opt/my".
    _programOf(command) {
        try {
            const [, argv] = GLib.shell_parse_argv(command);
            return argv?.[0] ?? null;
        } catch (error) {
            return null;
        }
    }

    _run(command, inTerminal) {
        let commandLine = command;

        if (inTerminal) {
            const exec = this._terminalSettings?.get_string(TERMINAL_EXEC_KEY);
            const execArg = this._terminalSettings?.get_string(TERMINAL_EXEC_ARG_KEY);
            if (!exec) {
                Main.notify(_('Tessera'), _('No terminal application is configured.'));
                return;
            }
            commandLine = `${exec} ${execArg} ${command}`;
        }

        try {
            Util.trySpawnCommandLine(commandLine);
        } catch (error) {
            Main.notify(_('Tessera'), _('Could not run “%s”').format(command));
        }
    }
}
