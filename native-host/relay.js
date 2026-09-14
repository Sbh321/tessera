// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * The relay between a browser's Native Messaging port and Tessera's
 * socket, as a library so its framing can be unit-tested; the
 * executable next to it (tessera-browser-host) just calls runRelay().
 *
 * The browser starts one relay per companion connection and talks to it
 * over stdin/stdout in Native Messaging framing: a 4-byte native-endian
 * length, then UTF-8 JSON. The relay connects to the Tessera extension's
 * Unix socket in the user's runtime directory and forwards every message
 * both ways, one JSON object per line on the socket side. It neither
 * interprets nor stores anything.
 *
 * GJS rather than Python so the extension depends on nothing the shell
 * itself does not already provide. When either end goes away the
 * process exits, which is how the other end learns about it: the
 * browser sees a disconnected port and reconnects later; Tessera sees a
 * closed socket and drops the session.
 */

export const SOCKET_DIRECTORY = 'tessera';
export const SOCKET_NAME = 'browser-tabs-v1.sock';

// Native Messaging's own limits: 64 MiB browser -> host, 1 MiB host -> browser.
export const MAX_INCOMING_BYTES = 64 * 1024 * 1024;
export const MAX_OUTGOING_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});

// Native Messaging uses the machine's byte order for the length prefix.
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export class ProtocolError extends Error {
}

/** Where Tessera listens. */
export function socketPath() {
    const runtimeDirectory = GLib.get_user_runtime_dir() || `/run/user/${GLib.get_user_name()}`;
    return GLib.build_filenamev([runtimeDirectory, SOCKET_DIRECTORY, SOCKET_NAME]);
}

/** @returns {number} the length a 4-byte Native Messaging header encodes */
export function decodeLength(header) {
    if (header.length !== 4)
        throw new ProtocolError('truncated native message header');
    return new DataView(header.buffer, header.byteOffset, 4).getUint32(0, LITTLE_ENDIAN);
}

/** @returns {Uint8Array} one framed Native Messaging message */
export function encodeNativeMessage(message) {
    const payload = encoder.encode(JSON.stringify(message));
    if (payload.length === 0 || payload.length > MAX_OUTGOING_BYTES)
        throw new ProtocolError('invalid outgoing native message length');
    const framed = new Uint8Array(4 + payload.length);
    new DataView(framed.buffer).setUint32(0, payload.length, LITTLE_ENDIAN);
    framed.set(payload, 4);
    return framed;
}

/** @returns {object} the JSON object a payload holds, or throws ProtocolError */
export function parseMessage(bytes) {
    let message;
    try {
        message = JSON.parse(decoder.decode(bytes));
    } catch (_error) {
        throw new ProtocolError('invalid message JSON');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message))
        throw new ProtocolError('message must be an object');
    return message;
}

/** Reads exactly `count` bytes, or null at a clean end of stream. */
export async function readExact(stream, count, cancellable) {
    const chunks = [];
    let received = 0;
    while (received < count) {
        const bytes = await new Promise((resolve, reject) => {
            stream.read_bytes_async(count - received, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                try {
                    resolve(source.read_bytes_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        });
        const data = bytes.get_data() ?? new Uint8Array(0);
        if (data.length === 0) {
            if (received === 0)
                return null;
            throw new ProtocolError('truncated native message');
        }
        chunks.push(data);
        received += data.length;
    }
    const out = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

/** Reads one framed message from the browser, or null at end of stream. */
export async function readNativeMessage(stream, cancellable) {
    const header = await readExact(stream, 4, cancellable);
    if (header === null)
        return null;
    const length = decodeLength(header);
    if (length === 0 || length > MAX_INCOMING_BYTES)
        throw new ProtocolError('invalid native message length');
    const payload = await readExact(stream, length, cancellable);
    if (payload === null)
        throw new ProtocolError('truncated native message');
    return parseMessage(payload);
}

function writeAll(stream, bytes) {
    stream.write_all(bytes, null);
    stream.flush(null);
}

/**
 * Runs the relay until either side closes.
 *
 * @param {object} [options]
 * @param {Gio.InputStream} [options.input] the browser's side, default stdin
 * @param {Gio.OutputStream} [options.output] the browser's side, default stdout
 * @param {string} [options.path] the socket, default socketPath()
 * @returns {Promise<number>} the exit code: 0 for a clean end, 1 otherwise
 */
export async function runRelay({
    input = Gio.UnixInputStream.new(0, false),
    output = Gio.UnixOutputStream.new(1, false),
    path = socketPath(),
} = {}) {
    let connection;
    try {
        connection = Gio.SocketClient.new().connect(Gio.UnixSocketAddress.new(path), null);
    } catch (error) {
        printerr(`tessera-browser-host: ${error.message}`);
        return 1;
    }

    const cancellable = new Gio.Cancellable();
    const socketInput = Gio.DataInputStream.new(connection.get_input_stream());
    const socketOutput = connection.get_output_stream();

    // Two independent pumps; whichever ends first ends the relay, and
    // cancelling the other's read is what unblocks it.
    const fromTessera = (async () => {
        for (;;) {
            const [line, length] = await new Promise((resolve, reject) => {
                socketInput.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                    try {
                        resolve(source.read_line_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            if (line === null)
                throw new ProtocolError('Tessera closed the connection');
            if (length > MAX_INCOMING_BYTES)
                throw new ProtocolError('Tessera message exceeds size limit');
            writeAll(output, encodeNativeMessage(parseMessage(line)));
        }
    })();

    const fromBrowser = (async () => {
        for (;;) {
            const message = await readNativeMessage(input, cancellable);
            if (message === null)
                return 0;
            writeAll(socketOutput, encoder.encode(`${JSON.stringify(message)}\n`));
        }
    })();

    let code;
    try {
        code = await Promise.race([fromTessera, fromBrowser]);
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            printerr(`tessera-browser-host: ${error.message}`);
        code = 1;
    }
    cancellable.cancel();
    try {
        connection.close(null);
    } catch (_error) {
        // Already closed by the peer.
    }
    return code;
}
