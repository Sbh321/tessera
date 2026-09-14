// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    MessageType, PROTOCOL_VERSION, sessionKey, validOpaqueId,
} from '../../companion/modules/tabs/protocol.js';
import {BrowserTabStore, StoreResult} from './browserTabStore.js';

const SOCKET_DIRECTORY = 'tessera';
const SOCKET_NAME = 'browser-tabs-v1.sock';

// How long an activation may take before it is treated as failed. A live
// browser answers in milliseconds; this only bounds a wedged one.
const ACTIVATION_TIMEOUT_MS = 3500;

// A line longer than this is not a snapshot, it is a bug or an attack.
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

// Redraw coalescing: a page load fires several tab-updated events in a
// row, and rebuilding the result list for each would be wasted work.
const CHANGE_COALESCE_MS = 60;

/**
 * The shell end of the browser link: a Unix socket server in the user's
 * runtime directory that each browser companion's relay connects to, one
 * connection per browser profile.
 *
 * Owns the single BrowserTabStore. Everything that arrives is validated
 * and applied there; nothing is interpreted here beyond the handshake, the
 * activation round trip and the decision to ask for a resync. The
 * connection is one JSON object per line in each direction.
 *
 * Trust model: the socket lives in a 0700 directory under
 * $XDG_RUNTIME_DIR with mode 0600, so only processes running as this user
 * can reach it -- the same boundary as the session bus. Snap and Flatpak
 * confinement keeps sandboxed apps out (the Firefox snap reaches it only
 * through the WebExtensions portal, which runs the relay unconfined).
 */
export class BrowserBridge {
    /**
     * @param {object} callbacks
     * @param {function(): void} callbacks.onChanged the store changed in a
     *   way the launcher may want to redraw for (coalesced)
     * @param {function(string, object): void} [callbacks.onApplied] a
     *   message was applied to the store; called synchronously with the
     *   session key and the message, before onChanged
     */
    constructor({onChanged, onApplied = null}) {
        this.store = new BrowserTabStore();
        this._onChanged = onChanged;
        this._onApplied = onApplied;

        this._service = null;
        this._socketDirectory = null;
        this._socketPath = null;
        this._clients = new Set();
        this._clientsBySession = new Map();
        this._pending = new Map();
        this._changedSourceId = null;
        this._running = false;
    }

    get running() {
        return this._running;
    }

    /** @returns {boolean} false when the socket could not be created */
    start() {
        if (this._running)
            return true;

        const runtimeDirectory = GLib.get_user_runtime_dir();
        if (!runtimeDirectory) {
            console.warn('tessera: browser tabs unavailable: no user runtime directory');
            return false;
        }

        this._socketDirectory = GLib.build_filenamev([runtimeDirectory, SOCKET_DIRECTORY]);
        this._socketPath = GLib.build_filenamev([this._socketDirectory, SOCKET_NAME]);

        try {
            GLib.mkdir_with_parents(this._socketDirectory, 0o700);
            GLib.chmod(this._socketDirectory, 0o700);
            // Only one gnome-shell runs per session, so any socket already
            // here belongs to a previous shell process and is dead.
            GLib.unlink(this._socketPath);

            this._service = Gio.SocketService.new();
            this._service.add_address(
                Gio.UnixSocketAddress.new(this._socketPath),
                Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
            GLib.chmod(this._socketPath, 0o600);
            this._service.connect('incoming', (_service, connection) => {
                this._accept(connection);
                return true;
            });
            this._service.start();
            this._running = true;
            return true;
        } catch (error) {
            console.warn(`tessera: browser tabs unavailable: ${error.message}`);
            this.stop();
            return false;
        }
    }

    stop() {
        const hadState = this.store.tabCount > 0;
        this._running = false;

        if (this._changedSourceId !== null) {
            GLib.Source.remove(this._changedSourceId);
            this._changedSourceId = null;
        }

        for (const client of [...this._clients])
            this._disconnect(client);
        this._clients.clear();
        this._clientsBySession.clear();

        for (const pending of this._pending.values()) {
            GLib.Source.remove(pending.timeoutId);
            pending.resolve({ok: false, windowId: -1, reason: 'stopped'});
        }
        this._pending.clear();

        this._service?.stop();
        this._service?.close();
        this._service = null;
        const changed = this.store.clear();

        if (this._socketPath)
            GLib.unlink(this._socketPath);
        if (this._socketDirectory)
            GLib.rmdir(this._socketDirectory);
        this._socketPath = null;
        this._socketDirectory = null;

        if (hadState || changed)
            this._onChanged?.();
    }

    /**
     * Asks the owning browser to activate one exact tab.
     *
     * Resolves (never rejects) with the browser's verdict. The identity
     * is revalidated against the store first, so a result from a session
     * that has since restarted is refused here without a round trip.
     *
     * @returns {Promise<{ok: boolean, windowId: number, reason: string}>}
     */
    activate(identity) {
        const current = this.store.resolve(identity);
        const key = sessionKey(identity);
        const client = key ? this._clientsBySession.get(key) : null;
        if (!current || !client || client.closed)
            return Promise.resolve({ok: false, windowId: -1, reason: 'not-found'});

        const requestId = GLib.uuid_string_random();
        return new Promise(resolve => {
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ACTIVATION_TIMEOUT_MS, () => {
                this._pending.delete(requestId);
                this._requestResync(client, 'activation-timeout');
                resolve({ok: false, windowId: -1, reason: 'timeout'});
                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(requestId, {client, timeoutId, resolve});

            const sent = this._send(client, {
                type: MessageType.ACTIVATE_TAB,
                requestId,
                sessionId: current.sessionId,
                tabId: current.tabId,
            });
            if (!sent) {
                GLib.Source.remove(timeoutId);
                this._pending.delete(requestId);
                resolve({ok: false, windowId: -1, reason: 'disconnected'});
            }
        });
    }

    // --- Connections ---------------------------------------------------------

    _accept(connection) {
        if (!this._running) {
            connection.close(null);
            return;
        }

        const client = {
            connection,
            input: Gio.DataInputStream.new(connection.get_input_stream()),
            output: Gio.DataOutputStream.new(connection.get_output_stream()),
            cancellable: new Gio.Cancellable(),
            sessionKey: null,
            sessionId: null,
            resyncRequested: false,
            closed: false,
        };
        this._clients.add(client);
        this._readNext(client);
    }

    _readNext(client) {
        if (client.closed)
            return;
        client.input.read_line_async(GLib.PRIORITY_DEFAULT, client.cancellable, (stream, result) => {
            if (client.closed)
                return;
            try {
                const [line, length] = stream.read_line_finish_utf8(result);
                if (line === null) {
                    this._disconnect(client);
                    return;
                }
                if (length > MAX_MESSAGE_BYTES)
                    throw new Error('message exceeds size limit');
                const message = JSON.parse(line);
                if (!message || typeof message !== 'object' || Array.isArray(message))
                    throw new Error('message is not an object');
                this._handleMessage(client, message);
                this._readNext(client);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`tessera: dropped browser companion connection: ${error.message}`);
                this._disconnect(client);
            }
        });
    }

    _handleMessage(client, message) {
        if (message.type === MessageType.HELLO) {
            if (client.sessionKey)
                throw new Error('duplicate handshake');
            if (message.protocolVersion !== PROTOCOL_VERSION)
                throw new Error(`companion protocol ${message.protocolVersion} is not ${PROTOCOL_VERSION}`);

            const key = sessionKey(message);
            if (!key)
                throw new Error('invalid browser session identity');

            // The same profile reconnecting (its background context
            // restarted) supersedes its previous connection outright.
            // Detach the old client from the session first so its
            // disconnect does not tear down the session being reused.
            const previous = this._clientsBySession.get(key);
            if (previous) {
                previous.sessionKey = null;
                this._disconnect(previous);
            }

            if (!this.store.beginSession(message))
                throw new Error('invalid browser session identity');
            client.sessionKey = key;
            client.sessionId = message.sessionId;
            this._clientsBySession.set(key, client);
            this._scheduleChanged();
            this._send(client, {
                type: MessageType.SYNC_REQUEST, sessionId: client.sessionId, reason: 'connected',
            });
            return;
        }

        if (!client.sessionKey || message.sessionId !== client.sessionId)
            throw new Error('message does not belong to this session');

        if (message.type === MessageType.ACTIVATE_RESULT) {
            this._finishActivation(client, message);
            return;
        }

        if (message.type === MessageType.ICONS) {
            const outcome = this.store.applyIcons(client.sessionKey, message);
            if (outcome === StoreResult.REJECTED)
                throw new Error('invalid ICONS message');
            if (outcome === StoreResult.APPLIED)
                this._scheduleChanged();
            return;
        }

        const isSnapshot = message.type === MessageType.SNAPSHOT;
        const result = isSnapshot
            ? this.store.applySnapshot(client.sessionKey, message)
            : this.store.applyEvent(client.sessionKey, message);

        switch (result) {
        case StoreResult.APPLIED:
            if (isSnapshot)
                client.resyncRequested = false;
            this._onApplied?.(client.sessionKey, message);
            this._scheduleChanged();
            break;
        case StoreResult.RESYNC_REQUIRED:
            this._requestResync(client, 'event-stream-gap');
            break;
        case StoreResult.REJECTED:
            throw new Error(`invalid ${message.type} message`);
        default:
            break;
        }
    }

    _finishActivation(client, message) {
        if (!validOpaqueId(message.requestId))
            return;
        const pending = this._pending.get(message.requestId);
        if (!pending || pending.client !== client)
            return;

        GLib.Source.remove(pending.timeoutId);
        this._pending.delete(message.requestId);
        const ok = message.ok === true;
        pending.resolve({
            ok,
            windowId: Number.isInteger(message.windowId) ? message.windowId : -1,
            reason: typeof message.reason === 'string' ? message.reason : '',
        });
        // The browser refusing means our picture of it was wrong somewhere.
        if (!ok)
            this._requestResync(client, 'activation-refused');
    }

    _requestResync(client, reason) {
        if (client.closed || !client.sessionKey || client.resyncRequested)
            return;
        client.resyncRequested = true;
        this.store.markResyncing(client.sessionKey);
        this._scheduleChanged();
        this._send(client, {type: MessageType.SYNC_REQUEST, sessionId: client.sessionId, reason});
    }

    _send(client, message) {
        if (client.closed)
            return false;
        try {
            client.output.put_string(`${JSON.stringify(message)}\n`, null);
            client.output.flush(null);
            return true;
        } catch (_error) {
            this._disconnect(client);
            return false;
        }
    }

    _disconnect(client) {
        if (!client || client.closed)
            return;
        client.closed = true;
        client.cancellable.cancel();
        try {
            client.connection.close(null);
        } catch (_error) {
            // Already closed by the peer.
        }

        this._clients.delete(client);
        let changed = false;
        if (client.sessionKey && this._clientsBySession.get(client.sessionKey) === client) {
            this._clientsBySession.delete(client.sessionKey);
            changed = this.store.endSession(client.sessionKey);
        }

        for (const [requestId, pending] of [...this._pending]) {
            if (pending.client !== client)
                continue;
            GLib.Source.remove(pending.timeoutId);
            this._pending.delete(requestId);
            pending.resolve({ok: false, windowId: -1, reason: 'disconnected'});
        }

        if (changed)
            this._scheduleChanged();
    }

    _scheduleChanged() {
        if (!this._running || this._changedSourceId !== null)
            return;
        this._changedSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHANGE_COALESCE_MS, () => {
            this._changedSourceId = null;
            if (this._running)
                this._onChanged?.();
            return GLib.SOURCE_REMOVE;
        });
    }
}
