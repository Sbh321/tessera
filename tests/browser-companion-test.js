// SPDX-License-Identifier: GPL-2.0-or-later
//
// Drives Tessera Companion's Tabs module under node against a mocked
// Chromium API: module enable/disable, the handshake, the snapshot,
// event ordering and sequence numbers, sibling reconciliation, favicon
// delivery, exact activation, and refusal to activate a tab that no
// longer exists. Also checks the module registry the host and options
// page share.
//
//     node tests/browser-companion-test.js   (run-tests.sh copies it to .mjs)

class FakeEvent {
    constructor() {
        this.listeners = [];
    }

    addListener(listener) {
        this.listeners.push(listener);
    }

    emit(...args) {
        for (const listener of this.listeners)
            listener(...args);
    }
}

class FakePort {
    constructor() {
        this.onMessage = new FakeEvent();
        this.onDisconnect = new FakeEvent();
        this.sent = [];
        this.disconnected = false;
    }

    postMessage(message) {
        this.sent.push(message);
    }

    disconnect() {
        this.disconnected = true;
    }
}

async function waitFor(predicate, message) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate())
            return;
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error(message);
}

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const settle = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

// --- Registry ---------------------------------------------------------------------

const {MODULES, resolveSettings} = await import('../companion/modules/registry.js');
assert(MODULES.some(module => module.id === 'tabs'), 'the tabs module is registered');
assert(resolveSettings(undefined).tabs === true, 'tabs is on by default');
assert(resolveSettings({tabs: false}).tabs === false, 'a stored setting wins');
assert(resolveSettings({tabs: 'yes'}).tabs === true, 'a malformed setting falls back to the default');

// --- Tabs module ---------------------------------------------------------------------

const events = {
    created: new FakeEvent(), updated: new FakeEvent(), removed: new FakeEvent(),
    activated: new FakeEvent(), moved: new FakeEvent(), attached: new FakeEvent(),
    detached: new FakeEvent(), replaced: new FakeEvent(), focused: new FakeEvent(),
    windowCreated: new FakeEvent(), windowRemoved: new FakeEvent(), alarm: new FakeEvent(),
};
const ports = [];
const tabs = new Map();
const windows = new Map();
const updateCalls = [];
const focusCalls = [];
const fetched = [];
let snapshotGate = Promise.resolve();

const tabA = {id: 1, windowId: 10, index: 0, title: 'A', url: 'https://a.test/', active: true, pinned: false,
    favIconUrl: 'https://a.test/favicon.ico'};
const tabB = {id: 2, windowId: 10, index: 1, title: 'B', url: 'https://b.test/', active: false, pinned: false,
    favIconUrl: 'data:image/png;base64,iVBORw0KGgo='};
tabs.set(1, tabA);
tabs.set(2, tabB);
windows.set(10, {id: 10, focused: true, type: 'normal', incognito: false});

globalThis.fetch = async url => {
    fetched.push(url);
    return {
        ok: true,
        headers: {get: () => 'image/png'},
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    };
};

const sessionStore = {};
globalThis.chrome = {
    tabs: {
        onCreated: events.created, onUpdated: events.updated, onRemoved: events.removed,
        onActivated: events.activated, onMoved: events.moved, onAttached: events.attached,
        onDetached: events.detached, onReplaced: events.replaced,
        query: async ({windowId}) => [...tabs.values()].filter(tab => tab.windowId === windowId),
        get: async id => {
            const found = tabs.get(id);
            if (!found)
                throw new Error('No tab with id');
            return found;
        },
        update: async (id, change) => {
            updateCalls.push({id, change});
            const found = tabs.get(id);
            if (!found)
                throw new Error('No tab with id');
            found.active = change.active;
            return found;
        },
    },
    windows: {
        onCreated: events.windowCreated, onRemoved: events.windowRemoved, onFocusChanged: events.focused,
        getAll: async () => {
            await snapshotGate;
            return [...windows.values()].map(window => ({
                ...window, tabs: [...tabs.values()].filter(tab => tab.windowId === window.id),
            }));
        },
        get: async id => windows.get(id),
        update: async (id, change) => {
            focusCalls.push({id, change});
            return {id, ...change};
        },
    },
    alarms: {onAlarm: events.alarm, async create() {}, async clear() {}},
    storage: {
        local: {async get() { return {}; }, async set() {}},
        session: {
            async get(key) { return {[key]: sessionStore[key]}; },
            async set(values) { Object.assign(sessionStore, values); },
        },
    },
    runtime: {
        connectNative: () => {
            const port = new FakePort();
            ports.push(port);
            return port;
        },
        getURL: path => `chrome-extension://test${path}`,
    },
};

const module = await import('../companion/modules/tabs/module.js');
assert(module.id === 'tabs', 'module id');
await settle();
assert(ports.length === 0, 'a module that has not been enabled opens no native port');
assert(module.status().enabled === false, 'status reports off');

await module.setEnabled(true);
await waitFor(() => ports.length === 1 && ports[0].sent.some(message => message.type === 'HELLO'), 'no HELLO after enabling');
const nativePort = ports[0];
const hello = nativePort.sent.find(message => message.type === 'HELLO');
assert(hello.protocolVersion === 2 && hello.browserType === 'chromium', 'handshake identity');
assert(hello.browserName === 'Chromium', 'browser name without client hints');
assert(sessionStore.tesseraSessionId === hello.sessionId, 'session id is persisted in session storage');
assert(module.status().enabled && !module.status().connected, 'enabled but not yet synchronised');

// Hold the snapshot back and fire an event meanwhile: it must be queued
// behind the snapshot, not lost and not sent ahead of it.
let releaseSnapshot;
snapshotGate = new Promise(resolve => releaseSnapshot = resolve);
nativePort.onMessage.emit({type: 'SYNC_REQUEST', sessionId: hello.sessionId});
const tabC = {id: 3, windowId: 10, index: 2, title: 'C', url: 'https://c.test/', active: false, pinned: false};
tabs.set(3, tabC);
events.created.emit(tabC);
await settle();
assert(!nativePort.sent.some(message => message.type === 'SNAPSHOT'), 'snapshot sent too early');
releaseSnapshot();
await waitFor(() => nativePort.sent.some(message => message.type === 'WINDOW_RECONCILED'), 'no reconciliation after create');
assert(module.status().connected, 'connected once synchronised');

const stateMessages = nativePort.sent.filter(message => message.sequence !== undefined);
assert(stateMessages[0].type === 'SNAPSHOT' && stateMessages[0].sequence === 1, 'snapshot first, sequence 1');
assert(stateMessages[0].windows.length === 1 && stateMessages[0].focusedWindowId === 10, 'snapshot carries windows');
assert(stateMessages[1].type === 'TAB_CREATED' && stateMessages[1].sequence === 2, 'queued event follows with sequence 2');
assert(stateMessages[2].type === 'WINDOW_RECONCILED' && stateMessages[2].sequence === 3 && stateMessages[2].tabs.length === 3,
    'reconciliation is authoritative');
const wireTab = stateMessages[0].tabs.find(tab => tab.tabId === 1);
assert(/^[0-9a-f]{16}$/.test(wireTab.iconKey), 'tabs carry an icon key');
assert(!('favIconUrl' in wireTab) && !('iconSource' in wireTab), 'icon sources stay off the wire');
assert(stateMessages[0].tabs.find(tab => tab.tabId === 3).iconKey === '', 'no favicon, no key');

await waitFor(() => nativePort.sent.some(message => message.type === 'ICONS'), 'no ICONS message');
await settle(10);
const delivered = nativePort.sent.filter(message => message.type === 'ICONS').flatMap(message => message.icons);
const dataIcon = delivered.find(icon => icon.key === stateMessages[0].tabs.find(tab => tab.tabId === 2).iconKey);
assert(dataIcon?.mime === 'image/png' && dataIcon.data === 'iVBORw0KGgo=', 'a data: favicon is decoded in place');
const cachedIcon = delivered.find(icon => icon.key === wireTab.iconKey);
assert(cachedIcon?.mime === 'image/png' && cachedIcon.data === 'iVBORw==', 'an https favicon comes from the browser cache');
assert(fetched.length === 1 && fetched[0].startsWith('chrome-extension://test/_favicon/?pageUrl=https%3A%2F%2Fa.test%2F'),
    `favicon endpoint used exactly once (${fetched.join(',')})`);
assert(!nativePort.sent.some(message => message.type === 'ICONS' && message.sequence !== undefined), 'ICONS are unsequenced');

// Irrelevant tab updates (favicons, load status) are not forwarded.
const before = nativePort.sent.length;
events.updated.emit(1, {status: 'complete', favIconUrl: 'x'}, tabA);
await settle();
assert(nativePort.sent.length === before, 'noise update forwarded');
events.updated.emit(1, {title: 'A2'}, {...tabA, title: 'A2'});
await waitFor(() => nativePort.sent.some(message => message.type === 'TAB_UPDATED'), 'relevant update not forwarded');
await settle(70);
assert(delivered.length === nativePort.sent.filter(message => message.type === 'ICONS').flatMap(m => m.icons).length,
    'an icon already sent is never resent');

// Closing a whole window must not query the window afterwards.
const reconciliations = nativePort.sent.filter(message => message.type === 'WINDOW_RECONCILED').length;
events.removed.emit(3, {windowId: 10, isWindowClosing: true});
await waitFor(() => nativePort.sent.some(message => message.type === 'TAB_REMOVED' && message.tabId === 3), 'removal not published');
await settle();
assert(nativePort.sent.filter(message => message.type === 'WINDOW_RECONCILED').length === reconciliations, 'reconciled a closing window');
tabs.delete(3);

events.focused.emit(-1);
events.focused.emit(10);
await waitFor(() => nativePort.sent.filter(message => message.type === 'WINDOW_FOCUSED').length === 2, 'focus events');
const focusMessages = nativePort.sent.filter(message => message.type === 'WINDOW_FOCUSED');
assert(focusMessages[0].windowId === -1 && focusMessages[1].windowId === 10, 'focus ids');

// Exact activation.
nativePort.onMessage.emit({type: 'ACTIVATE_TAB', requestId: 'r1', sessionId: hello.sessionId, tabId: 2});
await waitFor(() => nativePort.sent.some(message => message.type === 'ACTIVATE_RESULT' && message.requestId === 'r1'), 'no activation result');
const ok = nativePort.sent.find(message => message.type === 'ACTIVATE_RESULT' && message.requestId === 'r1');
assert(ok.ok === true && ok.windowId === 10, 'activation succeeded with window id');
assert(updateCalls.length === 1 && updateCalls[0].id === 2 && updateCalls[0].change.active === true, 'tabs.update for exactly tab 2');
assert(focusCalls.length === 1 && focusCalls[0].id === 10, 'window focused');

// A closed tab: nothing else is activated.
tabs.delete(2);
tabs.set(4, {id: 4, windowId: 10, index: 1, title: 'D', url: 'https://d.test/', active: false, pinned: false});
nativePort.onMessage.emit({type: 'ACTIVATE_TAB', requestId: 'r2', sessionId: hello.sessionId, tabId: 2});
await waitFor(() => nativePort.sent.some(message => message.type === 'ACTIVATE_RESULT' && message.requestId === 'r2'), 'no stale result');
const stale = nativePort.sent.find(message => message.type === 'ACTIVATE_RESULT' && message.requestId === 'r2');
assert(stale.ok === false && updateCalls.length === 1, 'a stale tab activated something');

// A message for another session is ignored outright.
nativePort.onMessage.emit({type: 'ACTIVATE_TAB', requestId: 'r3', sessionId: 'someone-else', tabId: 4});
await settle();
assert(!nativePort.sent.some(message => message.requestId === 'r3') && updateCalls.length === 1, 'foreign session answered');

// Disabling the module drops the port and stays down; re-enabling reconnects.
await module.setEnabled(false);
assert(nativePort.disconnected && !module.status().enabled && !module.status().connected, 'disable drops the port');
nativePort.onDisconnect.emit();
await settle(30);
assert(ports.length === 1, 'a disabled module does not reconnect');
await module.setEnabled(true);
await waitFor(() => ports.length === 2 && ports[1].sent.some(message => message.type === 'HELLO'), 'no reconnect after re-enable');
assert(ports[1].sent[0].sessionId === hello.sessionId, 'the session id survives a module restart');

delete globalThis.chrome;
delete globalThis.fetch;
console.log('browser-companion: registry, module lifecycle, sync, events, favicons and exact activation passed');
