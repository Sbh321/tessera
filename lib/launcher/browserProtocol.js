// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The wire protocol between Tessera Companion and the shell, plus the
 * record normalisers both ends share.
 *
 * THE SHELL OWNS THIS FILE. companion/modules/tabs/protocol.js is a
 * byte-for-byte copy of it: a browser extension can only import from
 * its own directory, and the shell must not import from the companion's
 * (which is not part of the packaged extension). tests/run-tests.sh
 * fails if the two ever differ -- edit here, then copy.
 *
 * Free of browser globals, GNOME imports and DOM APIs, which is also
 * what lets the protocol be unit-tested under node and gjs alike.
 *
 * Framing is the relay's business (Native Messaging on one side, one JSON
 * object per line on the Unix socket on the other); this file only defines
 * what the objects mean.
 */

export const PROTOCOL_VERSION = 2;
export const NATIVE_HOST_NAME = 'io.github.sbh321.tessera.browser_tabs';

/** Browser families. Chromium covers Chrome, Chromium, Brave, Edge, Vivaldi… */
export const BrowserType = Object.freeze({
    CHROMIUM: 'chromium',
    FIREFOX: 'firefox',
});

/** Control messages (both directions). */
export const MessageType = Object.freeze({
    /** companion -> shell, first message on every connection */
    HELLO: 'HELLO',
    /** shell -> companion: send a full SNAPSHOT */
    SYNC_REQUEST: 'SYNC_REQUEST',
    /** companion -> shell: complete state; resets the sequence baseline */
    SNAPSHOT: 'SNAPSHOT',
    /** shell -> companion: activate one exact tab */
    ACTIVATE_TAB: 'ACTIVATE_TAB',
    /** companion -> shell: the outcome of one ACTIVATE_TAB */
    ACTIVATE_RESULT: 'ACTIVATE_RESULT',
    /**
     * companion -> shell: favicon images, keyed like tab.iconKey. Side
     * data rather than state: unsequenced, sent once per key per
     * connection, and never a reason to distrust the event stream.
     */
    ICONS: 'ICONS',
});

/** Incremental state events, companion -> shell, each carrying `sequence`. */
export const BrowserEventType = Object.freeze({
    TAB_CREATED: 'TAB_CREATED',
    TAB_UPDATED: 'TAB_UPDATED',
    TAB_REMOVED: 'TAB_REMOVED',
    TAB_ACTIVATED: 'TAB_ACTIVATED',
    TAB_MOVED: 'TAB_MOVED',
    TAB_ATTACHED: 'TAB_ATTACHED',
    TAB_DETACHED: 'TAB_DETACHED',
    TAB_REPLACED: 'TAB_REPLACED',
    WINDOW_CREATED: 'WINDOW_CREATED',
    WINDOW_UPDATED: 'WINDOW_UPDATED',
    WINDOW_REMOVED: 'WINDOW_REMOVED',
    WINDOW_FOCUSED: 'WINDOW_FOCUSED',
    /** the authoritative tab list of ONE window, after a structural change */
    WINDOW_RECONCILED: 'WINDOW_RECONCILED',
});

export const SessionState = Object.freeze({
    /** connected, no snapshot yet */
    SYNCING: 'SYNCING',
    /** snapshot applied and every event since accounted for */
    READY: 'READY',
    /** something was missed; hidden until the next snapshot */
    RESYNCING: 'RESYNCING',
});

/** What the browser reports when no browser window has focus. */
export const WINDOW_ID_NONE = -1;

export const WindowType = Object.freeze({
    NORMAL: 'normal',
    POPUP: 'popup',
});

const MAX_ID_LENGTH = 160;
const MAX_TEXT_LENGTH = 4 * 1024;
const MAX_ICON_KEY_LENGTH = 64;

/** Largest favicon accepted, decoded. A 32px PNG is one or two KB. */
export const MAX_ICON_BYTES = 32 * 1024;

/** Icons per ICONS message; larger sets are split. */
export const MAX_ICONS_PER_MESSAGE = 24;

/**
 * Image types the shell will decode. SVG is deliberately absent: parsing
 * untrusted vector graphics inside the compositor process is a risk no
 * favicon is worth.
 */
export const ICON_MIME_TYPES = Object.freeze([
    'image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg',
    'image/gif', 'image/bmp',
]);

export function validOpaqueId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

export function validIntegerId(value) {
    return Number.isInteger(value) && value >= 0;
}

export function validSequence(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

export function validIconKey(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_ICON_KEY_LENGTH &&
        /^[0-9a-z]+$/.test(value);
}

/**
 * A cheap, synchronous cache key for a favicon URL: two FNV-1a passes
 * with different seeds, as 16 hex characters. It only has to be stable
 * within a session and unlikely to collide across a few hundred URLs;
 * a collision would show the wrong favicon, nothing worse -- which is
 * why a cryptographic hash (asynchronous in a service worker) is not
 * needed.
 */
export function iconKeyFor(text) {
    if (typeof text !== 'string' || text.length === 0)
        return '';
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193) >>> 0;
        b = Math.imul(b ^ code, 0x9e3779b1) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * One favicon record inside an ICONS message.
 *
 * @returns {?{key: string, mime: string, data: string}} data is base64
 */
export function normalizeIcon(icon) {
    if (!icon || !validIconKey(icon.key) || !ICON_MIME_TYPES.includes(icon.mime) ||
        typeof icon.data !== 'string' || icon.data.length === 0 ||
        // base64 grows bytes by 4/3; anything past that cannot fit the cap.
        icon.data.length > Math.ceil(MAX_ICON_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(icon.data))
        return null;
    return Object.freeze({key: icon.key, mime: icon.mime, data: icon.data});
}

function boundedString(value) {
    if (typeof value !== 'string')
        return '';
    return value.length <= MAX_TEXT_LENGTH ? value : value.slice(0, MAX_TEXT_LENGTH);
}

/**
 * The one tab record both ends agree on. Anything not listed here is
 * dropped, so a browser cannot smuggle unexpected fields into the shell.
 *
 * @returns {?object} null when the record lacks a usable identity
 */
export function normalizeTab(tab) {
    if (!tab || !validIntegerId(tab.tabId) || !validIntegerId(tab.windowId) ||
        !Number.isInteger(tab.index) || tab.index < 0)
        return null;

    return Object.freeze({
        tabId: tab.tabId,
        windowId: tab.windowId,
        index: tab.index,
        title: boundedString(tab.title),
        url: boundedString(tab.url),
        active: tab.active === true,
        pinned: tab.pinned === true,
        audible: tab.audible === true,
        discarded: tab.discarded === true,
        lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0,
        // Names the tab's favicon in the session's icon cache; '' when
        // the browser has none for it.
        iconKey: validIconKey(tab.iconKey) ? tab.iconKey : '',
    });
}

/**
 * One browser window. `title` is only ever non-empty for browsers whose
 * API exposes the window's own title (Firefox); Chromium leaves it empty
 * and the shell derives the expected title from the active tab instead.
 *
 * @returns {?object}
 */
export function normalizeWindow(window) {
    if (!window || !validIntegerId(window.windowId))
        return null;

    return Object.freeze({
        windowId: window.windowId,
        type: window.type === WindowType.POPUP ? WindowType.POPUP : WindowType.NORMAL,
        focused: window.focused === true,
        incognito: window.incognito === true,
        title: boundedString(window.title),
    });
}

export function validSessionIdentity(identity) {
    return Object.values(BrowserType).includes(identity?.browserType) &&
        validOpaqueId(identity.profileId) && validOpaqueId(identity.sessionId);
}

export function validTabIdentity(identity) {
    return validSessionIdentity(identity) && validIntegerId(identity.tabId);
}

/**
 * The key one connected browser session is filed under. Three parts
 * because each guards against a different collision: the family (two
 * browsers can both hand out tab id 5), the profile (so can two profiles
 * of one browser) and the session (so can the same profile after a
 * restart, which is the reuse this whole design exists to make harmless).
 *
 * @returns {?string}
 */
export function sessionKey(identity) {
    if (!validSessionIdentity(identity))
        return null;
    return `${identity.browserType}/${encodeURIComponent(identity.profileId)}/` +
        `${encodeURIComponent(identity.sessionId)}`;
}

/** The launcher result id of one tab: its session key plus its tab id. */
export function tabIdentityId(identity) {
    if (!validTabIdentity(identity))
        return null;
    return `${sessionKey(identity)}/${identity.tabId}`;
}
