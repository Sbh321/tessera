// SPDX-License-Identifier: GPL-2.0-or-later
//
// Unit tests for the browser tab store: the pure reducer that turns the
// companion's snapshot and event stream into the launcher's view of every
// connected browser. Drives every correctness case the feature promises
// -- closing a sibling, reordering, moving between windows, stale
// identities, duplicate titles, session replacement -- without a browser
// or a shell.
//
//     gjs -m tests/browser-tab-store-test.js      (or node, via run-tests.sh)

import {BrowserTabStore, StoreResult} from '../lib/launcher/browserTabStore.js';
import {
    BrowserEventType, MessageType, SessionState, WINDOW_ID_NONE, iconKeyFor,
    normalizeIcon, normalizeTab, tabIdentityId,
} from '../companion/modules/tabs/protocol.js';

let failures = 0;
let checks = 0;

function check(condition, description) {
    checks++;
    if (condition)
        return;
    failures++;
    console.log(`  FAIL: ${description}`);
}

function equal(actual, expected, description) {
    check(actual === expected,
        `${description} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function section(name) {
    console.log(name);
}

function hello(overrides = {}) {
    return {
        type: MessageType.HELLO, protocolVersion: 2, browserType: 'chromium',
        browserName: 'Google Chrome', profileId: 'profile-a', sessionId: 'session-1',
        ...overrides,
    };
}

function tab(tabId, windowId, index, title, extra = {}) {
    return {
        tabId, windowId, index, title, url: `https://${title.toLowerCase()}.test/`,
        active: index === 0, pinned: false, audible: false, discarded: false,
        lastAccessed: 0, ...extra,
    };
}

function window(windowId, focused = false, extra = {}) {
    return {windowId, type: 'normal', focused, incognito: false, title: '', ...extra};
}

/** A store with one READY session holding windows 10 (A, B, C) and 20 (D). */
function readyStore() {
    const store = new BrowserTabStore();
    const key = store.beginSession(hello());
    const result = store.applySnapshot(key, {
        type: MessageType.SNAPSHOT, sessionId: 'session-1', sequence: 1,
        windows: [window(10, true), window(20)],
        tabs: [tab(1, 10, 0, 'A'), tab(2, 10, 1, 'B'), tab(3, 10, 2, 'C'), tab(4, 20, 0, 'D')],
    });
    equal(result, StoreResult.APPLIED, 'fixture snapshot applies');
    return {store, key, next: 2};
}

function event(store, fixture, type, payload) {
    return store.applyEvent(fixture.key, {
        type, sessionId: 'session-1', sequence: fixture.next++, ...payload,
    });
}

const identity = tabId => ({browserType: 'chromium', profileId: 'profile-a', sessionId: 'session-1', tabId});

// --- Snapshot ---------------------------------------------------------------

section('store: initial snapshot');
{
    const store = new BrowserTabStore();
    equal(store.beginSession({type: 'HELLO'}), null, 'a hello without identity is refused');
    const key = store.beginSession(hello());
    equal(store.sessionState(key), SessionState.SYNCING, 'a new session is not yet visible');
    equal(store.listTabs().length, 0, 'nothing is listed before the snapshot');
    equal(store.applyEvent(key, {
        type: BrowserEventType.TAB_CREATED, sessionId: 'session-1', sequence: 5, tab: tab(9, 10, 0, 'X'),
    }), StoreResult.IGNORED, 'events before the snapshot are ignored, not fatal');

    equal(store.applySnapshot(key, {type: 'SNAPSHOT', sessionId: 'other', sequence: 1, tabs: []}),
        StoreResult.REJECTED, 'a snapshot for another session is rejected');
    equal(store.applySnapshot(key, {
        type: 'SNAPSHOT', sessionId: 'session-1', sequence: 1, tabs: [tab(1, 10, 0, 'A'), tab(1, 10, 1, 'A')],
    }), StoreResult.REJECTED, 'duplicate tab ids in a snapshot are rejected');
}
{
    const {store, key} = readyStore();
    equal(store.sessionState(key), SessionState.READY, 'snapshot makes the session READY');
    equal(store.listTabs().length, 4, 'every tab is listed');
    equal(store.tabCount, 4, 'tabCount agrees');
    const sessions = store.sessions();
    equal(sessions.length, 1, 'one session view');
    equal(sessions[0].windows.length, 2, 'two windows');
    equal(sessions[0].windows.find(w => w.windowId === 10).tabCount, 3, 'window 10 counts 3 tabs');
    equal(sessions[0].windows.find(w => w.windowId === 20).tabCount, 1, 'window 20 counts 1 tab');
    equal(sessions[0].windows.find(w => w.windowId === 10).activeTitle, 'A', 'active title follows the active tab');
    equal(sessions[0].focusedWindowId, 10, 'focused window comes from the snapshot');
    equal(store.listTabs()[0].title, 'A', 'the focused window lists first');
    equal(store.tabsOf(key, 10).map(t => t.title).join(''), 'ABC', 'tabsOf is in strip order');
    check(store.resolve(identity(2))?.title === 'B', 'resolve finds a live tab');
    equal(store.resolve({...identity(2), sessionId: 'session-0'}), null,
        'an identity from another session never resolves');
}

section('store: windows implied by tabs');
{
    const store = new BrowserTabStore();
    const key = store.beginSession(hello());
    store.applySnapshot(key, {
        type: 'SNAPSHOT', sessionId: 'session-1', sequence: 1, focusedWindowId: 30,
        tabs: [tab(7, 30, 0, 'Lonely')],
    });
    equal(store.sessions()[0].windows.length, 1, 'a tab without a window record implies one');
    equal(store.sessions()[0].focusedWindowId, 30, 'focusedWindowId fallback is honoured');
}

// --- Events -----------------------------------------------------------------

section('store: create, update, remove');
{
    const fixture = readyStore();
    const {store, key} = fixture;
    equal(event(store, fixture, BrowserEventType.TAB_CREATED, {tab: tab(5, 20, 1, 'E', {active: false})}),
        StoreResult.APPLIED, 'create applies');
    equal(store.windowOf(key, 20).tabCount, 2, 'count follows creation');
    event(store, fixture, BrowserEventType.TAB_UPDATED, {tab: {...tab(5, 20, 1, 'E renamed'), active: false}});
    equal(store.resolve(identity(5)).title, 'E renamed', 'update changes metadata');
    equal(store.resolve(identity(5)).tabId, 5, 'update keeps identity');
    event(store, fixture, BrowserEventType.TAB_REMOVED, {tabId: 5, windowId: 20});
    equal(store.resolve(identity(5)), null, 'removed tab no longer resolves');
    equal(store.windowOf(key, 20).tabCount, 1, 'count follows removal');
    const version = store.version;
    equal(event(store, fixture, BrowserEventType.TAB_REMOVED, {tabId: 'x'}), StoreResult.RESYNC_REQUIRED,
        'a malformed event forces a resync');
    check(store.version > version, 'hiding the session bumps the version');
    equal(store.sessionState(key), SessionState.RESYNCING, 'session is hidden');
    equal(store.listTabs().length, 0, 'hidden sessions list nothing');
}

section('store: closing another tab keeps identities exact');
{
    const fixture = readyStore();
    const {store} = fixture;
    const b = identity(2);
    event(store, fixture, BrowserEventType.TAB_REMOVED, {tabId: 1, windowId: 10});
    event(store, fixture, BrowserEventType.WINDOW_RECONCILED, {
        windowId: 10, tabs: [tab(2, 10, 0, 'B'), tab(3, 10, 1, 'C', {active: false})],
    });
    equal(store.resolve(b).title, 'B', 'B still resolves after A closed');
    equal(store.resolve(b).index, 0, 'B moved up one slot');
    equal(store.resolve(identity(3)).title, 'C', 'C is untouched');
}

section('store: reorder');
{
    const fixture = readyStore();
    const {store, key} = fixture;
    event(store, fixture, BrowserEventType.TAB_MOVED, {tab: tab(2, 10, 2, 'B', {active: false})});
    event(store, fixture, BrowserEventType.WINDOW_RECONCILED, {
        windowId: 10, tabs: [tab(1, 10, 0, 'A'), tab(3, 10, 1, 'C', {active: false}), tab(2, 10, 2, 'B', {active: false})],
    });
    equal(store.tabsOf(key, 10).map(t => t.title).join(''), 'ACB', 'strip order follows the move');
    equal(store.resolve(identity(2)).title, 'B', 'B resolves after the move');
    equal(store.resolve(identity(2)).index, 2, 'with its new index');
}

section('store: moving between windows');
{
    const fixture = readyStore();
    const {store, key} = fixture;
    event(store, fixture, BrowserEventType.TAB_DETACHED, {tabId: 2, oldWindowId: 10});
    equal(store.windowOf(key, 10).tabCount, 2, 'source window count drops');
    equal(store.resolve(identity(2)), null, 'a detached tab is in limbo, not activatable');
    event(store, fixture, BrowserEventType.TAB_ATTACHED, {tab: tab(2, 20, 1, 'B', {active: false})});
    equal(store.windowOf(key, 20).tabCount, 2, 'destination window count rises');
    equal(store.resolve(identity(2)).windowId, 20, 'B now belongs to window 20');
    equal(store.tabsOf(key, 20).map(t => t.title).join(''), 'DB', 'placed at its new index');
    // A detach that arrives AFTER the attach must not delete the moved tab.
    event(store, fixture, BrowserEventType.TAB_DETACHED, {tabId: 2, oldWindowId: 10});
    equal(store.resolve(identity(2)).windowId, 20, 'a late detach for the old window is ignored');
}

section('store: activation state');
{
    const fixture = readyStore();
    const {store, key} = fixture;
    event(store, fixture, BrowserEventType.TAB_ACTIVATED, {tab: tab(3, 10, 2, 'C')});
    equal(store.resolve(identity(3)).active, true, 'activated tab is active');
    equal(store.resolve(identity(1)).active, false, 'previous active tab is not');
    equal(store.windowOf(key, 10).activeTitle, 'C', 'window active title follows');
    event(store, fixture, BrowserEventType.WINDOW_FOCUSED, {windowId: 20});
    equal(store.sessions()[0].focusedWindowId, 20, 'focus follows the event');
    equal(store.windowOf(key, 20).focused, true, 'window record flags focus');
    equal(store.windowOf(key, 10).focused, false, 'only one window is focused');
    event(store, fixture, BrowserEventType.WINDOW_FOCUSED, {windowId: WINDOW_ID_NONE});
    equal(store.sessions()[0].focusedWindowId, WINDOW_ID_NONE, 'focus can leave the browser');
    equal(event(store, fixture, BrowserEventType.WINDOW_FOCUSED, {windowId: -7}),
        StoreResult.RESYNC_REQUIRED, 'an impossible focus id is rejected');
}

section('store: windows');
{
    const fixture = readyStore();
    const {store, key} = fixture;
    event(store, fixture, BrowserEventType.WINDOW_CREATED, {window: window(30, true, {incognito: true})});
    equal(store.sessions()[0].windows.length, 3, 'new window appears');
    equal(store.sessions()[0].focusedWindowId, 30, 'a focused new window takes focus');
    event(store, fixture, BrowserEventType.TAB_CREATED, {tab: tab(8, 30, 0, 'Private')});
    equal(store.resolve(identity(8)).incognito, true, 'tabs inherit the window incognito flag');
    event(store, fixture, BrowserEventType.WINDOW_UPDATED, {window: window(30, true, {title: 'Private — Mozilla Firefox'})});
    equal(store.windowOf(key, 30).title, 'Private — Mozilla Firefox', 'window title updates');
    event(store, fixture, BrowserEventType.WINDOW_REMOVED, {windowId: 30});
    equal(store.resolve(identity(8)), null, 'closing a window drops its tabs');
    equal(store.sessions()[0].focusedWindowId, WINDOW_ID_NONE, 'closing the focused window clears focus');
    equal(store.sessions()[0].windows.length, 2, 'window record is gone');
}

section('store: replaced tabs');
{
    const fixture = readyStore();
    const {store} = fixture;
    event(store, fixture, BrowserEventType.TAB_REPLACED, {tab: tab(99, 10, 1, 'B prerendered', {active: false}), replacedTabId: 2});
    equal(store.resolve(identity(2)), null, 'the replaced id is gone');
    equal(store.resolve(identity(99)).title, 'B prerendered', 'the replacement is live');
}

section('store: duplicate titles and urls stay independent');
{
    const store = new BrowserTabStore();
    const key = store.beginSession(hello());
    store.applySnapshot(key, {
        type: 'SNAPSHOT', sessionId: 'session-1', sequence: 1, windows: [window(10, true)],
        tabs: [tab(1, 10, 0, 'Same'), tab(2, 10, 1, 'Same', {active: false}), tab(3, 10, 2, 'Same', {active: false})],
    });
    equal(store.listTabs().length, 3, 'three identical-looking tabs are three tabs');
    check(store.resolve(identity(1)).index === 0 && store.resolve(identity(2)).index === 1 &&
        store.resolve(identity(3)).index === 2, 'each resolves to its own slot');
    const ids = new Set(store.listTabs().map(t => tabIdentityId(t)));
    equal(ids.size, 3, 'result ids are distinct');
}

section('store: sequence gaps and resync');
{
    const fixture = readyStore();
    const {store, key} = fixture;
    fixture.next += 1;
    equal(event(store, fixture, BrowserEventType.TAB_UPDATED, {tab: tab(1, 10, 0, 'A2')}),
        StoreResult.RESYNC_REQUIRED, 'a skipped sequence number hides the session');
    equal(store.listTabs().length, 0, 'nothing is trusted meanwhile');
    equal(store.applyEvent(key, {type: BrowserEventType.TAB_UPDATED, sessionId: 'session-1', sequence: 99, tab: tab(1, 10, 0, 'A3')}),
        StoreResult.IGNORED, 'events while resyncing are ignored');
    equal(store.applySnapshot(key, {
        type: 'SNAPSHOT', sessionId: 'session-1', sequence: 0, windows: [window(10, true)], tabs: [tab(1, 10, 0, 'A4')],
    }), StoreResult.APPLIED, 'a snapshot with a RESET sequence is accepted');
    equal(store.resolve(identity(1)).title, 'A4', 'the snapshot replaces the cleared state');
    equal(store.applyEvent(key, {type: BrowserEventType.TAB_UPDATED, sessionId: 'session-1', sequence: 1, tab: tab(1, 10, 0, 'A5')}),
        StoreResult.APPLIED, 'events continue from the snapshot baseline');
    check(store.markResyncing(key), 'markResyncing hides a session on request');
    equal(store.listTabs().length, 0, 'hidden');
}

section('store: session replacement and disconnect');
{
    const fixture = readyStore();
    const {store, key} = fixture;
    const stale = identity(2);
    check(store.endSession(key), 'disconnect removes the session');
    equal(store.listTabs().length, 0, 'no tabs after disconnect');
    equal(store.resolve(stale), null, 'old identity does not resolve');

    // The browser restarts: same profile, new session, and it reuses tab id 2.
    const restarted = store.beginSession(hello({sessionId: 'session-2'}));
    store.applySnapshot(restarted, {
        type: 'SNAPSHOT', sessionId: 'session-2', sequence: 1, windows: [window(10, true)],
        tabs: [tab(2, 10, 0, 'Completely different page')],
    });
    equal(store.resolve(stale), null, 'a reused numeric id in a new session never resolves the old identity');
    equal(store.resolve({...stale, sessionId: 'session-2'}).title, 'Completely different page',
        'the new identity resolves to the new tab');

    // Reconnecting with the SAME session key (companion restart) starts SYNCING again.
    const same = store.beginSession(hello({sessionId: 'session-2'}));
    equal(same, restarted, 'same identity maps to the same key');
    equal(store.sessionState(same), SessionState.SYNCING, 'a reconnect is untrusted until its snapshot');
    equal(store.listTabs().length, 0, 'and lists nothing meanwhile');
}

section('store: multiple profiles cannot collide');
{
    const store = new BrowserTabStore();
    const a = store.beginSession(hello({profileId: 'profile-a'}));
    const b = store.beginSession(hello({profileId: 'profile-b', sessionId: 'session-1'}));
    check(a !== b, 'different profiles get different keys');
    store.applySnapshot(a, {type: 'SNAPSHOT', sessionId: 'session-1', sequence: 1, windows: [window(10, true)], tabs: [tab(1, 10, 0, 'Work')]});
    store.applySnapshot(b, {type: 'SNAPSHOT', sessionId: 'session-1', sequence: 1, windows: [window(10)], tabs: [tab(1, 10, 0, 'Home')]});
    equal(store.listTabs().length, 2, 'both profiles are listed');
    equal(store.resolve({browserType: 'chromium', profileId: 'profile-b', sessionId: 'session-1', tabId: 1}).title, 'Home',
        'identical numeric ids resolve per profile');
    const firefox = store.beginSession(hello({browserType: 'firefox', browserName: 'Firefox', profileId: 'profile-a'}));
    check(firefox !== a, 'a different browser family is a different session');
}

section('store: favicons');
{
    equal(iconKeyFor('https://a.test/favicon.ico').length, 16, 'icon keys are 16 hex characters');
    equal(iconKeyFor('https://a.test/favicon.ico'), iconKeyFor('https://a.test/favicon.ico'), 'icon keys are stable');
    check(iconKeyFor('https://a.test/favicon.ico') !== iconKeyFor('https://b.test/favicon.ico'), 'different urls, different keys');
    equal(iconKeyFor(''), '', 'no url, no key');
    check(/^[0-9a-f]{16}$/.test(iconKeyFor('x')), 'keys are lowercase hex');
    equal(normalizeTab({...tab(1, 10, 0, 'A'), iconKey: 'not hex!'}).iconKey, '', 'an invalid icon key is dropped');
    equal(normalizeTab({...tab(1, 10, 0, 'A'), iconKey: 'abc123'}).iconKey, 'abc123', 'a valid icon key survives');
    equal(normalizeIcon({key: 'abc', mime: 'image/svg+xml', data: 'AAAA'}), null, 'svg is refused');
    equal(normalizeIcon({key: 'abc', mime: 'image/png', data: 'not base64!'}), null, 'non-base64 data is refused');
    equal(normalizeIcon({key: 'abc', mime: 'image/png', data: 'A'.repeat(60000)}), null, 'oversized data is refused');
    check(normalizeIcon({key: 'abc', mime: 'image/png', data: 'iVBORw0KGgo='}) !== null, 'a small png is accepted');

    const store = new BrowserTabStore();
    const key = store.beginSession(hello());
    const icons = {type: MessageType.ICONS, sessionId: 'session-1', icons: [{key: 'aa11', mime: 'image/png', data: 'iVBORw0KGgo='}]};
    equal(store.applyIcons(key, icons), StoreResult.APPLIED, 'icons apply before the snapshot');
    equal(store.icon(key, 'aa11')?.mime, 'image/png', 'icon is stored');
    equal(store.icon(key, 'zz99'), null, 'unknown icon key is null');
    equal(store.icon(key, ''), null, 'empty icon key is null');
    equal(store.applyIcons(key, icons), StoreResult.IGNORED, 'a repeated icon changes nothing');
    equal(store.applyIcons(key, {...icons, sessionId: 'other'}), StoreResult.REJECTED, 'wrong session is rejected');
    equal(store.applyIcons(key, {...icons, icons: [{key: 'bb', mime: 'image/svg+xml', data: 'AAAA'}]}),
        StoreResult.REJECTED, 'an invalid icon rejects the message');
    equal(store.applyIcons('missing', icons), StoreResult.REJECTED, 'unknown session is rejected');

    store.applySnapshot(key, {type: 'SNAPSHOT', sessionId: 'session-1', sequence: 1, windows: [window(10, true)],
        tabs: [{...tab(1, 10, 0, 'A'), iconKey: 'aa11'}]});
    equal(store.resolve(identity(1)).iconKey, 'aa11', 'tabs carry their icon key');
    store.markResyncing(key);
    equal(store.icon(key, 'aa11')?.mime, 'image/png', 'icons survive a resync');

    const before = store.version;
    for (let i = 0; i < 600; i++)
        store.applyIcons(key, {type: MessageType.ICONS, sessionId: 'session-1', icons: [{key: `k${i}`, mime: 'image/png', data: 'AAAA'}]});
    equal(store.icon(key, 'aa11'), null, 'the oldest icon is evicted past the cap');
    equal(store.icon(key, 'k599')?.data, 'AAAA', 'the newest is kept');
    check(store.version > before, 'icon changes bump the version');

    store.endSession(key);
    equal(store.icon(key, 'k599'), null, 'icons go with the session');
}

section('store: scale');
{
    const store = new BrowserTabStore();
    const key = store.beginSession(hello());
    const tabs = [];
    for (let i = 0; i < 600; i++)
        tabs.push(tab(i, 10 + (i % 6), Math.floor(i / 6), `Tab ${i}`, {active: i < 6}));
    const started = Date.now();
    equal(store.applySnapshot(key, {type: 'SNAPSHOT', sessionId: 'session-1', sequence: 1, tabs}),
        StoreResult.APPLIED, '600-tab snapshot applies');
    for (let sequence = 2; sequence < 402; sequence++) {
        store.applyEvent(key, {
            type: BrowserEventType.TAB_UPDATED, sessionId: 'session-1', sequence,
            tab: tab(sequence, 10 + (sequence % 6), Math.floor(sequence / 6), `Renamed ${sequence}`, {active: false}),
        });
    }
    equal(store.listTabs().length, 600, 'all tabs remain after 400 updates');
    check(Date.now() - started < 1000, `a 600-tab snapshot plus 400 events takes well under a second (${Date.now() - started}ms)`);
}

console.log('');
if (failures > 0) {
    console.log(`${failures} of ${checks} checks FAILED`);
    throw new Error(`browser tab store tests failed (${failures}/${checks})`);
}
console.log(`All ${checks} browser tab store checks passed.`);
