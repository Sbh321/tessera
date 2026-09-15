// SPDX-License-Identifier: GPL-2.0-or-later
//
// Exercises the real socket bridge under gjs with a fake companion on the
// other end of the socket: handshake, snapshot, activation round trip,
// sequence-gap resync, stale activation, duplicate-session replacement
// and shutdown. Needs XDG_RUNTIME_DIR pointed at a scratch directory.
//
//     XDG_RUNTIME_DIR=$(mktemp -d) gjs -m tests/browser-bridge-test.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BrowserEventType, MessageType} from '../lib/launcher/browserProtocol.js';
import {BrowserBridge} from '../lib/launcher/browserBridge.js';

let changes = 0;
const applied = [];
const bridge = new BrowserBridge({
    onChanged: () => changes++,
    onApplied: (key, message) => applied.push([key, message.type]),
});
if (!bridge.start())
    throw new Error('bridge did not start');
if (!bridge.running)
    throw new Error('bridge does not report running');

const socketPath = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'tessera', 'browser-tabs-v1.sock']);

function connect() {
    const connection = Gio.SocketClient.new().connect(Gio.UnixSocketAddress.new(socketPath), null);
    const input = Gio.DataInputStream.new(connection.get_input_stream());
    const output = Gio.DataOutputStream.new(connection.get_output_stream());
    return {
        connection,
        send(message) {
            output.put_string(`${JSON.stringify(message)}\n`, null);
            output.flush(null);
        },
        receive() {
            const [line] = input.read_line_utf8(null);
            if (line === null)
                throw new Error('bridge closed the connection unexpectedly');
            return JSON.parse(line);
        },
        closed() {
            const [line] = input.read_line_utf8(null);
            return line === null;
        },
    };
}

function delay(milliseconds = 90) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function tab(tabId, windowId, index, title) {
    return {tabId, windowId, index, title, url: `https://${title}.test/`, active: index === 0};
}

const hello = {
    type: MessageType.HELLO, protocolVersion: 2, browserType: 'chromium',
    browserName: 'Google Chrome', profileId: 'profile-test', sessionId: 'session-test',
};

// Wrong protocol version: refused.
const old = connect();
old.send({...hello, protocolVersion: 1});
await delay();
if (!old.closed())
    throw new Error('a companion speaking an old protocol was accepted');

const companion = connect();
companion.send(hello);
await delay();
if (companion.receive().type !== MessageType.SYNC_REQUEST)
    throw new Error('bridge did not request an initial snapshot');

companion.send({
    type: MessageType.SNAPSHOT, sessionId: 'session-test', sequence: 1,
    windows: [{windowId: 10, type: 'normal', focused: true, incognito: false, title: ''}],
    tabs: [tab(7, 10, 0, 'exact')],
});
await delay();
if (bridge.store.listTabs().length !== 1)
    throw new Error('snapshot was not applied');
if (!applied.some(([, type]) => type === MessageType.SNAPSHOT))
    throw new Error('onApplied was not called for the snapshot');
if (changes === 0)
    throw new Error('onChanged was not called after the snapshot');

const identity = {browserType: 'chromium', profileId: 'profile-test', sessionId: 'session-test', tabId: 7};
const activation = bridge.activate(identity);
const request = companion.receive();
if (request.type !== MessageType.ACTIVATE_TAB || request.tabId !== 7 || request.sessionId !== 'session-test')
    throw new Error('activation request is not the exact tab');
companion.send({
    type: MessageType.ACTIVATE_RESULT, sessionId: 'session-test',
    requestId: request.requestId, ok: true, reason: 'ok', windowId: 10,
});
const verdict = await activation;
if (!verdict.ok || verdict.windowId !== 10)
    throw new Error('activation verdict was not relayed');

// A sequence gap hides the session and asks for a snapshot.
companion.send({
    type: BrowserEventType.TAB_UPDATED, sessionId: 'session-test', sequence: 3, tab: tab(7, 10, 0, 'skipped'),
});
await delay();
if (bridge.store.listTabs().length !== 0)
    throw new Error('sequence gap did not hide the session');
if (companion.receive().type !== MessageType.SYNC_REQUEST)
    throw new Error('sequence gap did not request a resync');
if ((await bridge.activate(identity)).ok)
    throw new Error('a hidden session accepted an activation');

companion.send({
    type: MessageType.SNAPSHOT, sessionId: 'session-test', sequence: 0,
    windows: [{windowId: 10, type: 'normal', focused: true}], tabs: [tab(7, 10, 0, 'recovered')],
});
await delay();
if (bridge.store.listTabs()[0]?.title !== 'recovered')
    throw new Error('resync snapshot did not restore the session');

// Favicons ride alongside the state stream.
const changesBeforeIcons = changes;
companion.send({type: MessageType.ICONS, sessionId: 'session-test', icons: [{key: 'f00d', mime: 'image/png', data: 'iVBORw0KGgo='}]});
await delay();
if (bridge.store.icon('chromium/profile-test/session-test', 'f00d')?.mime !== 'image/png')
    throw new Error('icons were not stored');
if (changes <= changesBeforeIcons)
    throw new Error('new icons did not request a redraw');
companion.send({type: MessageType.ICONS, sessionId: 'session-test', icons: [{key: 'f00d', mime: 'image/png', data: 'iVBORw0KGgo='}]});
await delay();
if (bridge.store.listTabs()[0]?.title !== 'recovered')
    throw new Error('a repeated icon disturbed the session');

// Closing the tab makes the old identity inert.
companion.send({type: BrowserEventType.TAB_REMOVED, sessionId: 'session-test', sequence: 1, tabId: 7, windowId: 10});
await delay();
if ((await bridge.activate(identity)).ok)
    throw new Error('a closed tab was activated');

// Timeout: the browser never answers.
companion.send({type: BrowserEventType.TAB_CREATED, sessionId: 'session-test', sequence: 2, tab: tab(8, 10, 0, 'slow')});
await delay();
const slow = bridge.activate({...identity, tabId: 8});
companion.receive();
const timedOut = await slow;
if (timedOut.ok || timedOut.reason !== 'timeout')
    throw new Error('an unanswered activation did not time out');
if (companion.receive().type !== MessageType.SYNC_REQUEST)
    throw new Error('a timed-out activation did not request a resync');

// The same profile reconnecting replaces the old connection.
const replacement = connect();
replacement.send(hello);
await delay();
if (replacement.receive().type !== MessageType.SYNC_REQUEST)
    throw new Error('replacement connection was not greeted');
if (!companion.closed())
    throw new Error('the superseded connection was left open');
if (bridge.store.sessionState('chromium/profile-test/session-test') !== 'SYNCING')
    throw new Error('replacement session is not awaiting its snapshot');

// Garbage closes the connection.
const rude = connect();
rude.send({...hello, profileId: 'rude'});
await delay();
rude.receive();
rude.send({type: 'SNAPSHOT', sessionId: 'session-test', sequence: 'x', tabs: []});
await delay();
if (!rude.closed())
    throw new Error('a malformed snapshot did not drop the connection');

const badIcon = connect();
badIcon.send({...hello, profileId: 'icons'});
await delay();
badIcon.receive();
badIcon.send({type: MessageType.ICONS, sessionId: 'session-test', icons: [{key: 'x', mime: 'image/svg+xml', data: 'AAAA'}]});
await delay();
if (!badIcon.closed())
    throw new Error('a refused image type did not drop the connection');

const beforeStop = changes;
bridge.stop();
if (bridge.running || bridge.store.listTabs().length !== 0)
    throw new Error('stop did not clear state');
if (GLib.file_test(socketPath, GLib.FileTest.EXISTS))
    throw new Error('stop left the socket behind');
if (!replacement.closed())
    throw new Error('stop left a client connected');
if (bridge.start() !== true)
    throw new Error('bridge cannot be restarted');
bridge.stop();

print(`browser-bridge: socket lifecycle passed (${changes} change notifications, ${beforeStop} before stop)`);
