// SPDX-License-Identifier: GPL-2.0-or-later

import {
    BrowserEventType, BrowserType, ICON_MIME_TYPES, MAX_ICONS_PER_MESSAGE, MAX_ICON_BYTES,
    MessageType, NATIVE_HOST_NAME, PROTOCOL_VERSION, WINDOW_ID_NONE, WindowType,
    iconKeyFor, normalizeTab, normalizeWindow,
} from './protocol.js';

/**
 * The Tabs module of Tessera Companion: mirrors this browser profile's
 * windows and tabs to the Tessera GNOME Shell extension over Native
 * Messaging, and activates the exact tab Tessera asks for.
 *
 * One instance runs per browser profile that has the companion loaded.
 * It is a pure mirror: no UI, no content scripts, no network. The only
 * things it reads are tab titles, URLs, favicons and window/tab
 * identifiers, and the only place they go is the local relay
 * (native-host/) which forwards them to a socket in the user's runtime
 * directory.
 *
 * This module is the only owner of the native port. It registers its
 * browser listeners at import time (a service worker is woken for
 * events only if the listener exists when it starts) and gates them on
 * `enabled`, which the module host flips from the companion's settings.
 *
 * Correctness model, in one paragraph: on every connection the shell
 * asks for a SNAPSHOT (every window and tab), after which every change is
 * sent as an event with a strictly increasing sequence number. Anything
 * that breaks that promise -- an API call failing mid-event, a tab that
 * vanished before it could be read -- is answered with a fresh snapshot
 * rather than a guess. Tabs are identified to the shell by their browser
 * ids scoped by a per-browser-session id, so an id reused after a
 * restart can never be mistaken for the old tab.
 *
 * Chromium-family browsers only (Chrome, Chromium, Brave, Edge, Vivaldi):
 * the companion is a Manifest V3 extension and relies on the `favicon`
 * permission and on a native port keeping the service worker alive,
 * both Chromium behaviours. The shell side is browser-agnostic.
 */

export const id = 'tabs';

const api = globalThis.chrome;
const browserType = BrowserType.CHROMIUM;

const WINDOW_TYPES = [WindowType.NORMAL, WindowType.POPUP];
const PROFILE_ID_KEY = 'tesseraProfileId';
const SESSION_ID_KEY = 'tesseraSessionId';
const WATCHDOG_ALARM = 'tessera-watchdog';

// Reconnect backoff for the quick retries; beyond it the once-a-minute
// watchdog alarm takes over, so a Tessera that is off costs one failed
// relay spawn per minute and nothing else.
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 16000;

// Which tab properties matter to the shell. Chromium fires onUpdated for
// favicons, load status and more; forwarding those would be pure noise.
const RELEVANT_TAB_CHANGES = ['title', 'url', 'pinned', 'audible', 'discarded'];

let port = null;
let profileId = null;
let sessionId = null;
let browserName = 'Chromium';
let enabled = false;
let initialized = false;
let sequence = 0;
let ready = false;
let connectionGeneration = 0;
let reconnectDelayMs = RECONNECT_MIN_MS;
let reconnectTimer = null;
let queue = Promise.resolve();
let reconcileTimer = null;
const reconcileWindows = new Set();

// Favicons: which keys this connection has already delivered, which are
// waiting to be fetched, and the URL to fetch each from.
const sentIcons = new Set();
const pendingIcons = new Map();
const iconSources = new Map();
let iconTimer = null;

// Listeners are registered synchronously at load, before any await, so
// the browser can wake this script for them (Chromium service workers)
// and so no event can slip between "read the snapshot" and "start
// listening": events are serialised behind the snapshot on `queue`.
api.tabs.onCreated.addListener(tab => {
    enqueueEvent(BrowserEventType.TAB_CREATED, async () => ({tab: tabRecord(tab)}));
    scheduleReconcile(tab.windowId);
});

api.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!RELEVANT_TAB_CHANGES.some(key => Object.hasOwn(changeInfo, key)))
        return;
    enqueueEvent(BrowserEventType.TAB_UPDATED, async () => ({tab: tabRecord(tab)}));
});

api.tabs.onRemoved.addListener((tabId, removeInfo) => {
    enqueueEvent(BrowserEventType.TAB_REMOVED,
        async () => ({tabId, windowId: removeInfo.windowId}));
    // A closing window has no siblings left to renumber, and asking it
    // can fail once windows.onRemoved has fired.
    if (!removeInfo.isWindowClosing)
        scheduleReconcile(removeInfo.windowId);
});

api.tabs.onActivated.addListener(activeInfo => {
    enqueueEvent(BrowserEventType.TAB_ACTIVATED,
        async () => ({tab: tabRecord(await api.tabs.get(activeInfo.tabId))}));
});

api.tabs.onMoved.addListener((tabId, moveInfo) => {
    enqueueEvent(BrowserEventType.TAB_MOVED,
        async () => ({tab: tabRecord(await api.tabs.get(tabId))}));
    // onMoved names only the tab that was dragged; every sibling whose
    // index shifted is silent, hence the reconciliation.
    scheduleReconcile(moveInfo.windowId);
});

api.tabs.onAttached.addListener((tabId, attachInfo) => {
    enqueueEvent(BrowserEventType.TAB_ATTACHED,
        async () => ({tab: tabRecord(await api.tabs.get(tabId))}));
    scheduleReconcile(attachInfo.newWindowId);
});

api.tabs.onDetached.addListener((tabId, detachInfo) => {
    enqueueEvent(BrowserEventType.TAB_DETACHED,
        async () => ({tabId, oldWindowId: detachInfo.oldWindowId}));
    scheduleReconcile(detachInfo.oldWindowId);
});

// Chromium swaps a tab's id when a prerendered page takes over.
api.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    enqueueEvent(BrowserEventType.TAB_REPLACED, async () => ({
        tab: tabRecord(await api.tabs.get(addedTabId)), replacedTabId: removedTabId,
    }));
});

api.windows.onCreated.addListener(window => {
    if (!WINDOW_TYPES.includes(window.type))
        return;
    enqueueEvent(BrowserEventType.WINDOW_CREATED,
        async () => ({window: windowRecord(await api.windows.get(window.id))}));
});

api.windows.onRemoved.addListener(windowId => {
    enqueueEvent(BrowserEventType.WINDOW_REMOVED, async () => ({windowId}));
});

api.windows.onFocusChanged.addListener(windowId => {
    enqueueEvent(BrowserEventType.WINDOW_FOCUSED, async () => ({
        windowId: Number.isInteger(windowId) && windowId >= 0 ? windowId : WINDOW_ID_NONE,
    }));
});

api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === WATCHDOG_ALARM && enabled && !port)
        connectNative();
});

// --- Module lifecycle -----------------------------------------------------------

/**
 * Turns the module on or off. Called by the host with the stored
 * setting at startup and whenever it changes. Off means no native
 * port, no relay process and no reconnect attempts -- Tessera simply
 * sees no session from this profile.
 *
 * @param {boolean} wanted
 */
export async function setEnabled(wanted) {
    if (wanted === enabled)
        return;
    enabled = wanted;

    if (!wanted) {
        clearReconnect();
        const open = port;
        port = null;
        ready = false;
        try {
            open?.disconnect();
        } catch (_error) {
            // Already gone.
        }
        void api.alarms.clear(WATCHDOG_ALARM);
        return;
    }

    if (!initialized) {
        initialized = true;
        profileId = await persistentId(api.storage.local, PROFILE_ID_KEY);
        // storage.session survives a background restart but not a
        // browser restart -- exactly the lifetime a session id needs.
        sessionId = api.storage.session
            ? await persistentId(api.storage.session, SESSION_ID_KEY) : randomId();
        browserName = detectBrowserName();
        if (!enabled)
            return;
    }

    try {
        await api.alarms.create(WATCHDOG_ALARM, {periodInMinutes: 1});
    } catch (_error) {
        // Without the watchdog only the quick retries remain.
    }
    connectNative();
}

/**
 * What the options page shows for this module.
 *
 * @returns {{enabled: boolean, connected: boolean, browserName: string}}
 */
export function status() {
    return {enabled, connected: port !== null && ready, browserName};
}

async function persistentId(area, key) {
    try {
        const stored = await area.get(key);
        if (typeof stored?.[key] === 'string' && stored[key].length > 0)
            return stored[key];
        const fresh = randomId();
        await area.set({[key]: fresh});
        return fresh;
    } catch (_error) {
        // A storage failure only costs the id its persistence; a fresh
        // one is still unique, which is all the shell relies on.
        return randomId();
    }
}

function detectBrowserName() {
    // Client hints name the product ("Google Chrome", "Brave", "Microsoft
    // Edge") alongside the generic "Chromium" and a nonsense brand.
    const brands = globalThis.navigator?.userAgentData?.brands ?? [];
    const product = brands
        .map(entry => entry?.brand ?? '')
        .find(brand => brand && !/not.?a.?brand/i.test(brand) && brand !== 'Chromium');
    return product ?? 'Chromium';
}

function connectNative() {
    if (!enabled || port || !profileId || !sessionId)
        return;

    clearReconnect();
    const generation = ++connectionGeneration;
    sequence = 0;
    ready = false;
    queue = Promise.resolve();
    sentIcons.clear();
    pendingIcons.clear();

    try {
        port = api.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (_error) {
        port = null;
        scheduleReconnect();
        return;
    }

    const connected = port;
    connected.onMessage.addListener(message => {
        if (port === connected)
            onNativeMessage(message, generation);
    });
    connected.onDisconnect.addListener(() => {
        if (port === connected)
            dropConnection();
    });

    send({
        type: MessageType.HELLO,
        protocolVersion: PROTOCOL_VERSION,
        browserType,
        browserName,
        profileId,
        sessionId,
    });
}

function onNativeMessage(message, generation) {
    if (!message || message.sessionId !== sessionId || generation !== connectionGeneration)
        return;

    if (message.type === MessageType.SYNC_REQUEST)
        enqueue(() => synchronize(generation));
    else if (message.type === MessageType.ACTIVATE_TAB)
        enqueue(() => activateTab(message, generation));
}

function dropConnection() {
    const failed = port;
    port = null;
    ready = false;
    if (reconcileTimer !== null) {
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
    }
    reconcileWindows.clear();
    if (iconTimer !== null) {
        clearTimeout(iconTimer);
        iconTimer = null;
    }
    pendingIcons.clear();
    try {
        failed?.disconnect();
    } catch (_error) {
        // Already gone.
    }
    scheduleReconnect();
}

function scheduleReconnect() {
    if (!enabled || reconnectTimer !== null)
        return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!port)
            connectNative();
    }, delay);
}

function clearReconnect() {
    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

// --- State ------------------------------------------------------------------------

/**
 * Every window and tab, sent as one message. Also the recovery path: the
 * shell asks for it whenever it stops trusting the event stream.
 */
async function synchronize(generation) {
    if (!port || generation !== connectionGeneration)
        return;

    ready = false;
    const windows = await api.windows.getAll({populate: true, windowTypes: WINDOW_TYPES});
    if (!port || generation !== connectionGeneration)
        return;

    const windowRecords = windows.map(windowRecord).filter(Boolean);
    const tabs = [];
    for (const window of windows) {
        for (const tab of window.tabs ?? []) {
            const record = tabRecord(tab);
            if (record)
                tabs.push(record);
        }
    }
    const focused = windows.find(window => window.focused);

    send({
        type: MessageType.SNAPSHOT,
        sessionId,
        sequence: ++sequence,
        windows: windowRecords,
        focusedWindowId: Number.isInteger(focused?.id) ? focused.id : WINDOW_ID_NONE,
        tabs,
    });
    ready = true;
    reconnectDelayMs = RECONNECT_MIN_MS;
    tabs.forEach(requestIcon);
}

// --- Favicons -----------------------------------------------------------------------

/**
 * Queues a tab's favicon for delivery if this connection has not sent
 * it yet. Coalesced so a snapshot's worth of tabs becomes a few ICONS
 * messages, and always AFTER the state message that named the key: a
 * row shows the fallback icon for a moment rather than the stream
 * waiting on an image.
 */
function requestIcon(record) {
    const key = record?.iconKey;
    const source = key ? iconSources.get(key) : null;
    if (!key || !source || sentIcons.has(key) || pendingIcons.has(key))
        return;
    pendingIcons.set(key, source);
    if (iconTimer === null)
        iconTimer = setTimeout(deliverIcons, 50);
}

function deliverIcons() {
    iconTimer = null;
    const batch = [...pendingIcons];
    pendingIcons.clear();
    for (const [key] of batch)
        sentIcons.add(key);

    enqueue(async () => {
        const icons = [];
        for (const [key, source] of batch) {
            const icon = await loadIcon(source);
            if (icon)
                icons.push({key, ...icon});
            if (icons.length === MAX_ICONS_PER_MESSAGE) {
                send({type: MessageType.ICONS, sessionId, icons: icons.splice(0)});
            }
        }
        if (icons.length > 0)
            send({type: MessageType.ICONS, sessionId, icons});
    });
}

/**
 * The image bytes for one favicon source, as base64, or null.
 *
 * Nothing here touches the network. A data: URL is decoded in place;
 * anything else is read from the browser's own favicon cache through
 * the `_favicon/` endpoint the `favicon` permission provides.
 */
async function loadIcon(source) {
    if (source.startsWith('data:')) {
        const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(source);
        if (!match || !ICON_MIME_TYPES.includes(match[1]) ||
            match[2].length > Math.ceil(MAX_ICON_BYTES / 3) * 4)
            return null;
        return {mime: match[1], data: match[2]};
    }

    if (typeof api.runtime.getURL !== 'function')
        return null;

    try {
        const url = api.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(source)}&size=32`);
        const response = await fetch(url);
        if (!response.ok)
            return null;
        const mime = (response.headers.get('content-type') ?? 'image/png').split(';')[0].trim();
        if (!ICON_MIME_TYPES.includes(mime))
            return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES)
            return null;
        return {mime, data: toBase64(bytes)};
    } catch (_error) {
        return null;
    }
}

function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}


function enqueue(task) {
    queue = queue.then(task).catch(() => {
        // An API failure inside a task means the stream can no longer be
        // vouched for; reconnecting forces a complete snapshot.
        dropConnection();
    });
}

function enqueueEvent(type, payloadFactory) {
    const generation = connectionGeneration;
    enqueue(async () => {
        if (!port || !ready || generation !== connectionGeneration)
            return;

        let payload;
        try {
            payload = await payloadFactory();
        } catch (_error) {
            // The object this event describes is already gone (a tab
            // closed before it could be read). What the browser looks
            // like NOW is the only trustworthy answer.
            await synchronize(generation);
            return;
        }
        if (Object.values(payload).some(value => value === null)) {
            await synchronize(generation);
            return;
        }

        send({type, sessionId, sequence: ++sequence, ...payload});
        for (const value of Object.values(payload)) {
            if (value?.iconKey)
                requestIcon(value);
            else if (Array.isArray(value))
                value.forEach(requestIcon);
        }
    });
}

/**
 * After any structural change, re-reads the affected window's tabs and
 * sends them whole. The browser only announces the tab that moved or
 * closed; the shifted indexes of its siblings are announced by nobody,
 * and this is what keeps the shell's tab-strip order honest. Coalesced
 * per event burst (a zero-delay timer), never a correctness delay.
 */
function scheduleReconcile(windowId) {
    if (!Number.isInteger(windowId) || windowId < 0)
        return;
    reconcileWindows.add(windowId);
    if (reconcileTimer !== null)
        return;

    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        const windowIds = [...reconcileWindows];
        reconcileWindows.clear();
        for (const id of windowIds) {
            enqueueEvent(BrowserEventType.WINDOW_RECONCILED, async () => {
                let tabs;
                try {
                    tabs = await api.tabs.query({windowId: id});
                } catch (_error) {
                    // The window closed meanwhile; WINDOW_REMOVED covers it.
                    tabs = [];
                }
                return {windowId: id, tabs: tabs.map(tabRecord).filter(Boolean)};
            });
        }
    }, 0);
}

// --- Activation ---------------------------------------------------------------------

/**
 * Activates exactly the tab named, or nothing. The tab is looked up by
 * id immediately before acting; a tab that has moved to another window
 * is still that tab and is activated where it now lives, and the window
 * it turned out to be in is reported back so the shell can raise it.
 */
async function activateTab(request, generation) {
    if (!port || !ready || generation !== connectionGeneration) {
        reply(request, false, 'not-ready');
        return;
    }

    let tab;
    try {
        tab = await api.tabs.get(request.tabId);
    } catch (_error) {
        reply(request, false, 'tab-not-found');
        return;
    }
    if (!tab || tab.id !== request.tabId) {
        reply(request, false, 'tab-not-found');
        return;
    }

    try {
        await api.tabs.update(tab.id, {active: true});
        const current = await api.tabs.get(tab.id);
        await api.windows.update(current.windowId, {focused: true});
        reply(request, true, 'ok', current.windowId);
    } catch (_error) {
        reply(request, false, 'activation-failed');
    }
}

function reply(request, ok, reason, windowId = WINDOW_ID_NONE) {
    send({
        type: MessageType.ACTIVATE_RESULT,
        sessionId,
        requestId: typeof request?.requestId === 'string' ? request.requestId : '',
        ok,
        reason,
        windowId,
    });
}

// --- Helpers ---------------------------------------------------------------------------

function send(message) {
    try {
        port?.postMessage(message);
    } catch (_error) {
        dropConnection();
    }
}

function tabRecord(tab) {
    const favIconUrl = typeof tab?.favIconUrl === 'string' ? tab.favIconUrl : '';
    const record = normalizeTab({
        tabId: tab?.id,
        windowId: tab?.windowId,
        index: tab?.index,
        title: tab?.title ?? '',
        url: tab?.url ?? '',
        active: tab?.active,
        pinned: tab?.pinned,
        audible: tab?.audible,
        discarded: tab?.discarded,
        lastAccessed: tab?.lastAccessed ?? 0,
        // Keyed by the icon's URL, so every tab of one site shares one
        // cache entry and one transfer.
        iconKey: iconKeyFor(favIconUrl),
    });
    // Where to load the icon from -- the data: URL itself, or the page
    // URL for the browser's favicon cache -- is kept off the wire in a
    // side table for requestIcon().
    if (record?.iconKey && !iconSources.has(record.iconKey))
        iconSources.set(record.iconKey, favIconUrl.startsWith('data:') ? favIconUrl : record.url);
    return record;
}

function windowRecord(window) {
    if (!window || !WINDOW_TYPES.includes(window.type))
        return null;
    return normalizeWindow({
        windowId: window.id,
        type: window.type,
        focused: window.focused,
        incognito: window.incognito,
        title: window.title ?? '',
    });
}

function randomId() {
    if (typeof crypto.randomUUID === 'function')
        return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}
