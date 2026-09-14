// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Native Messaging relay: its framing helpers, and the real
// executable run as a subprocess against the real socket bridge --
// a framed HELLO in on stdin, a framed SYNC_REQUEST back on stdout,
// clean exit when the browser side closes, non-zero exit when there is
// no Tessera to connect to. Needs XDG_RUNTIME_DIR pointed at scratch.
//
//     XDG_RUNTIME_DIR=$(mktemp -d) gjs -m tests/native-host-test.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BrowserBridge} from '../lib/launcher/browserBridge.js';
import {
    MAX_OUTGOING_BYTES, ProtocolError, decodeLength, encodeNativeMessage,
    parseMessage, readNativeMessage, socketPath,
} from '../native-host/relay.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

// --- Framing -------------------------------------------------------------------

const framed = encodeNativeMessage({type: 'HELLO', unicode: 'ट्याब'});
const length = decodeLength(framed.subarray(0, 4));
assert(length === framed.length - 4, 'length prefix covers the payload');
assert(parseMessage(framed.subarray(4)).unicode === 'ट्याब', 'payload round-trips utf-8');
for (const bad of ['[1,2]', 'null', '"x"', '{']) {
    let refused = false;
    try {
        parseMessage(new TextEncoder().encode(bad));
    } catch (error) {
        refused = error instanceof ProtocolError;
    }
    assert(refused, `non-object payload ${bad} is refused`);
}
let oversized = false;
try {
    encodeNativeMessage({x: 'y'.repeat(MAX_OUTGOING_BYTES + 1)});
} catch (error) {
    oversized = error instanceof ProtocolError;
}
assert(oversized, 'an oversized outgoing message is refused');

const memory = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(framed));
const parsed = await readNativeMessage(memory, null);
assert(parsed.type === 'HELLO', 'readNativeMessage decodes a framed message');
assert(await readNativeMessage(memory, null) === null, 'end of stream reads as null');

let truncated = false;
try {
    await readNativeMessage(Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(framed.subarray(0, 6))), null);
} catch (error) {
    truncated = error instanceof ProtocolError;
}
assert(truncated, 'a truncated message is refused');

// --- The executable against the bridge -------------------------------------------------

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const host = GLib.build_filenamev([here, '..', 'native-host', 'tessera-browser-host']);
assert(GLib.file_test(host, GLib.FileTest.IS_EXECUTABLE), 'the relay is executable in the checkout');

function spawnHost() {
    const launcher = Gio.SubprocessLauncher.new(
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    return launcher.spawnv([host]);
}

function waitFor(process) {
    return new Promise(resolve => {
        process.wait_async(null, (source, result) => {
            source.wait_finish(result);
            resolve(source.get_exit_status());
        });
    });
}

// No Tessera listening: the relay must exit non-zero so the browser
// reconnects later, without hanging on stdin.
const orphan = spawnHost();
orphan.get_stdin_pipe().close(null);
assert(await waitFor(orphan) === 1, 'a relay with no socket exits 1');

const bridge = new BrowserBridge({onChanged: () => {}});
assert(bridge.start(), 'bridge starts');
assert(GLib.file_test(socketPath(), GLib.FileTest.EXISTS), 'the relay and the bridge agree on the socket path');

const relay = spawnHost();
const stdin = relay.get_stdin_pipe();
const stdout = relay.get_stdout_pipe();
stdin.write_all(encodeNativeMessage({
    type: 'HELLO', protocolVersion: 2, browserType: 'chromium', browserName: 'Chromium',
    profileId: 'profile-relay', sessionId: 'session-relay',
}), null);
stdin.flush(null);

const reply = await readNativeMessage(stdout, null);
assert(reply?.type === 'SYNC_REQUEST' && reply.sessionId === 'session-relay',
    `the bridge's SYNC_REQUEST came back framed (got ${JSON.stringify(reply)})`);
assert(bridge.store.sessionState('chromium/profile-relay/session-relay') === 'SYNCING',
    'the bridge registered the relayed session');

stdin.close(null);
assert(await waitFor(relay) === 0, 'closing the browser side ends the relay cleanly');
await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => (resolve(), GLib.SOURCE_REMOVE)));
assert(bridge.store.sessionState('chromium/profile-relay/session-relay') === null,
    'the bridge dropped the session when the relay exited');

// Tessera going away ends the relay too.
const second = spawnHost();
second.get_stdin_pipe().write_all(encodeNativeMessage({
    type: 'HELLO', protocolVersion: 2, browserType: 'chromium', browserName: 'Chromium',
    profileId: 'profile-relay', sessionId: 'session-two',
}), null);
second.get_stdin_pipe().flush(null);
await readNativeMessage(second.get_stdout_pipe(), null);
bridge.stop();
assert(await waitFor(second) === 1, 'the relay exits when Tessera closes the socket');

print('native-host: framing and relay lifecycle passed');
