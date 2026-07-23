// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

// Discover the PIDs listening on a TCP port, then (on confirm) terminate
// them. Two independent tools are tried and their output merged, so this
// works whether the box ships lsof, iproute2's ss, or both -- the port
// number is validated to an integer before it is ever interpolated into
// the shell command, so nothing user-typed reaches the shell verbatim.
function buildDiscoveryArgv(port) {
    const script =
        `lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null; ` +
        `ss -tlnpH "sport = :${port}" 2>/dev/null | grep -oP 'pid=\\K[0-9]+'`;
    return ['sh', '-c', script];
}

function readProcessName(pid) {
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/comm`);
        if (ok)
            return new TextDecoder().decode(bytes).trim();
    } catch (e) {
        // Process gone or unreadable -- fall back to the bare PID.
    }
    return null;
}

/**
 * A small modal: type a port, hit Kill, and every process listening on it
 * gets SIGTERM. Reports the outcome inline in the dialog and via a
 * notification. Purely a convenience for local development servers.
 */
export const PortKillerDialog = GObject.registerClass(
class PortKillerDialog extends ModalDialog.ModalDialog {
    _init(settingsManager) {
        super._init({styleClass: 'tessera-port-dialog', destroyOnClose: true});

        this._settingsManager = settingsManager;

        const content = new St.BoxLayout({
            vertical: true,
            style_class: 'tessera-dialog-content',
        });
        this.contentLayout.add_child(content);

        content.add_child(new St.Label({
            text: _('Kill process on port'),
            style_class: 'tessera-dialog-title',
        }));
        content.add_child(new St.Label({
            text: _('Sends SIGTERM to whatever is listening on the port.'),
            style_class: 'tessera-dialog-subtitle',
        }));

        this._entry = new St.Entry({
            style_class: 'tessera-dialog-entry',
            hint_text: _('e.g. 3000'),
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => this._kill());
        content.add_child(this._entry);

        this._status = new St.Label({style_class: 'tessera-dialog-status'});
        this._status.hide();
        content.add_child(this._status);

        this.addButton({
            label: _('Cancel'),
            key: Clutter.KEY_Escape,
            action: () => this.close(),
        });
        this.addButton({
            label: _('Kill'),
            default: true,
            action: () => this._kill(),
        });
    }

    open() {
        super.open();
        // Focus the entry once the dialog is mapped so typing lands there.
        this._entry.grab_key_focus();
    }

    _showStatus(text) {
        this._status.text = text;
        this._status.show();
    }

    _kill() {
        const raw = this._entry.get_text().trim();
        const port = Number.parseInt(raw, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            this._showStatus(_('Enter a port number between 1 and 65535.'));
            return;
        }

        let proc;
        try {
            proc = Gio.Subprocess.new(
                buildDiscoveryArgv(port),
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._showStatus(_('Could not run the port lookup.'));
            return;
        }

        proc.communicate_utf8_async(null, null, (source, res) => {
            let stdout = '';
            try {
                [, stdout] = source.communicate_utf8_finish(res);
            } catch (e) {
                this._showStatus(_('Could not read the port lookup output.'));
                return;
            }

            const pids = [...new Set(
                stdout.split(/\s+/).map(s => s.trim()).filter(s => /^\d+$/.test(s)))];

            if (pids.length === 0) {
                this._showStatus(_('Nothing is listening on port %d.').format(port));
                return;
            }

            this._terminate(port, pids);
        });
    }

    _terminate(port, pids) {
        const resolved = pids.map(pid => ({pid, name: readProcessName(pid)}));
        const names = resolved.map(({pid, name}) => name ? `${name} (${pid})` : pid);

        try {
            Gio.Subprocess.new(
                ['kill', '-TERM', ...pids],
                Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._showStatus(_('Failed to signal %s.').format(names.join(', ')));
            return;
        }

        // Record a compact history entry: "3000 · node" (first process
        // name) or just the port when no name could be resolved.
        const firstName = resolved.find(({name}) => name)?.name;
        this._settingsManager?.recordKilledPort(
            firstName ? `${port} · ${firstName}` : `${port}`);

        Main.notify(
            _('Tessera'),
            _('Killed on port %d: %s').format(port, names.join(', ')));
        this.close();
    }
});
