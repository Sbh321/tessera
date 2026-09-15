// SPDX-License-Identifier: GPL-2.0-or-later

import {
    BrowserEventType, MessageType, SessionState, WINDOW_ID_NONE, WindowType,
    normalizeIcon, normalizeTab, normalizeWindow, sessionKey, validIntegerId,
    validSequence, validSessionIdentity, validTabIdentity,
} from './browserProtocol.js';

// Favicons kept per session. Beyond this the oldest are dropped; a tab
// whose icon was dropped simply shows the fallback until the companion
// reconnects and sends it again.
const MAX_ICONS_PER_SESSION = 512;

/** What applying a message did. */
export const StoreResult = Object.freeze({
    APPLIED: 'applied',
    /** valid but changed nothing worth redrawing for */
    IGNORED: 'ignored',
    /** malformed; the connection that sent it should be dropped */
    REJECTED: 'rejected',
    /** the session's incremental stream can no longer be trusted */
    RESYNC_REQUIRED: 'resync-required',
});

/**
 * The single, ephemeral, normalised view of every connected browser.
 *
 * Three levels: a SESSION (one browser profile's live connection), its
 * WINDOWS, and their TABS. Everything is keyed by the ids the browser
 * itself hands out, scoped by session so that a numeric id reused after a
 * restart can never resolve to the wrong thing. Nothing here is ever
 * persisted; when a session disconnects its state is gone.
 *
 * The browser is the only source of truth. A session becomes visible
 * (READY) when a complete snapshot arrives and stays visible only while
 * every event since has arrived in order. The moment a sequence gap or an
 * event that does not fit the current state shows up, the session is
 * hidden (RESYNCING) and the bridge asks for a fresh snapshot -- guessing
 * what was missed is exactly how a launcher ends up activating the wrong
 * tab.
 *
 * No GNOME imports: this file is driven directly by
 * tests/browser-tab-store-test.js.
 */
export class BrowserTabStore {
    constructor() {
        this._sessions = new Map();
        // Bumped on every change that could alter what the launcher shows,
        // so consumers can cache derived data against it.
        this._version = 0;
    }

    get version() {
        return this._version;
    }

    /**
     * Registers (or replaces) the session a HELLO describes.
     *
     * @returns {?string} the session key, or null for an invalid hello
     */
    beginSession(hello) {
        if (hello?.type !== MessageType.HELLO || !validSessionIdentity(hello))
            return null;

        const key = sessionKey(hello);
        this._sessions.set(key, {
            key,
            browserType: hello.browserType,
            browserName: safeName(hello.browserName) ||
                (hello.browserType === 'firefox' ? 'Firefox' : 'Chromium'),
            profileId: hello.profileId,
            sessionId: hello.sessionId,
            state: SessionState.SYNCING,
            lastSequence: -1,
            focusedWindowId: WINDOW_ID_NONE,
            windows: new Map(),
            tabs: new Map(),
            // key -> {mime, data}; side data, survives resyncs, cleared
            // with the session (the companion resends per connection).
            icons: new Map(),
        });
        this._version++;
        return key;
    }

    /** @returns {boolean} whether a session was actually removed */
    endSession(key) {
        const removed = this._sessions.delete(key);
        if (removed)
            this._version++;
        return removed;
    }

    /** @returns {boolean} whether anything was removed */
    clear() {
        const changed = this._sessions.size > 0;
        this._sessions.clear();
        if (changed)
            this._version++;
        return changed;
    }

    /** @returns {string} one of StoreResult */
    applySnapshot(key, message) {
        const session = this._sessions.get(key);
        if (!session || message?.type !== MessageType.SNAPSHOT ||
            message.sessionId !== session.sessionId ||
            !validSequence(message.sequence) || !Array.isArray(message.tabs) ||
            (message.windows !== undefined && !Array.isArray(message.windows)))
            return StoreResult.REJECTED;

        const windows = new Map();
        for (const candidate of message.windows ?? []) {
            const window = normalizeWindow(candidate);
            if (!window || windows.has(window.windowId))
                return StoreResult.REJECTED;
            windows.set(window.windowId, window);
        }

        const tabs = new Map();
        for (const candidate of message.tabs) {
            const tab = normalizeTab(candidate);
            if (!tab || tabs.has(tab.tabId))
                return StoreResult.REJECTED;
            tabs.set(tab.tabId, tab);
        }

        session.windows = windows;
        session.tabs = tabs;
        for (const tab of tabs.values())
            this._ensureWindow(session, tab.windowId);

        const focused = [...windows.values()].find(window => window.focused);
        this._setFocusedWindow(session, focused ? focused.windowId :
            validIntegerId(message.focusedWindowId) ? message.focusedWindowId : WINDOW_ID_NONE);

        // A snapshot RESETS the sequence baseline rather than extending it:
        // the companion restarts its counter whenever its background
        // context restarts, and the snapshot is what makes that safe.
        session.lastSequence = message.sequence;
        session.state = SessionState.READY;
        this._version++;
        return StoreResult.APPLIED;
    }

    /** @returns {string} one of StoreResult */
    applyEvent(key, message) {
        const session = this._sessions.get(key);
        if (!session || message?.sessionId !== session.sessionId ||
            !Object.values(BrowserEventType).includes(message?.type) ||
            !validSequence(message.sequence))
            return StoreResult.REJECTED;

        // Events before the first snapshot (or after a gap) are simply
        // superseded by the snapshot that is already on its way.
        if (session.state !== SessionState.READY)
            return StoreResult.IGNORED;

        if (message.sequence !== session.lastSequence + 1)
            return this._requireResync(session);

        if (!this._reduce(session, message))
            return this._requireResync(session);

        session.lastSequence = message.sequence;
        this._version++;
        return StoreResult.APPLIED;
    }

    /**
     * Stores favicons. Accepted in any session state: icons are keyed
     * content, not ordered state, so they can never be "out of order".
     *
     * @returns {string} one of StoreResult
     */
    applyIcons(key, message) {
        const session = this._sessions.get(key);
        if (!session || message?.type !== MessageType.ICONS ||
            message.sessionId !== session.sessionId || !Array.isArray(message.icons))
            return StoreResult.REJECTED;

        let stored = 0;
        for (const candidate of message.icons) {
            const icon = normalizeIcon(candidate);
            if (!icon)
                return StoreResult.REJECTED;
            if (session.icons.has(icon.key))
                continue;
            while (session.icons.size >= MAX_ICONS_PER_SESSION)
                session.icons.delete(session.icons.keys().next().value);
            session.icons.set(icon.key, {mime: icon.mime, data: icon.data});
            stored++;
        }

        if (stored === 0)
            return StoreResult.IGNORED;
        this._version++;
        return StoreResult.APPLIED;
    }

    /**
     * @returns {?{mime: string, data: string}} base64 image data for a
     *   tab's iconKey, or null when the session has no such icon
     */
    icon(key, iconKey) {
        if (!iconKey)
            return null;
        return this._sessions.get(key)?.icons.get(iconKey) ?? null;
    }

    /** Hides a session until its next snapshot. */
    markResyncing(key) {
        const session = this._sessions.get(key);
        if (!session)
            return false;
        this._requireResync(session);
        return true;
    }

    /** @returns {?string} */
    sessionState(key) {
        return this._sessions.get(key)?.state ?? null;
    }

    /**
     * Every READY session with its windows -- the shape the window mapper
     * consumes. Tabs are not included; ask tabsOf() per window.
     */
    sessions() {
        const views = [];
        for (const session of this._sessions.values()) {
            if (session.state !== SessionState.READY)
                continue;
            views.push({
                key: session.key,
                browserType: session.browserType,
                browserName: session.browserName,
                profileId: session.profileId,
                sessionId: session.sessionId,
                focusedWindowId: session.focusedWindowId,
                windows: this._windowViews(session),
            });
        }
        return views;
    }

    /** @returns {?object} one READY window view, or null */
    windowOf(key, windowId) {
        const session = this._sessions.get(key);
        if (!session || session.state !== SessionState.READY)
            return null;
        const window = session.windows.get(windowId);
        return window ? this._windowView(session, window) : null;
    }

    /**
     * The tabs of one window in tab-strip order, each carrying its
     * session identity so a result can be built from it directly.
     */
    tabsOf(key, windowId) {
        const session = this._sessions.get(key);
        if (!session || session.state !== SessionState.READY)
            return [];
        const tabs = [];
        for (const tab of session.tabs.values()) {
            if (tab.windowId === windowId)
                tabs.push(this._tabView(session, tab));
        }
        return tabs.sort((a, b) => a.index - b.index);
    }

    /**
     * Every tab of every READY session: focused window first, then the
     * other windows in creation order, tabs in tab-strip order.
     */
    listTabs() {
        const found = [];
        for (const session of this._sessions.values()) {
            if (session.state !== SessionState.READY)
                continue;
            const windowOrder = new Map();
            let position = 0;
            for (const windowId of session.windows.keys())
                windowOrder.set(windowId, windowId === session.focusedWindowId ? -1 : position++);
            const tabs = [...session.tabs.values()].sort((a, b) =>
                (windowOrder.get(a.windowId) ?? 0) - (windowOrder.get(b.windowId) ?? 0) ||
                a.index - b.index);
            for (const tab of tabs)
                found.push(this._tabView(session, tab));
        }
        return found;
    }

    /** @returns {number} how many tabs listTabs() would return */
    get tabCount() {
        let count = 0;
        for (const session of this._sessions.values()) {
            if (session.state === SessionState.READY)
                count += session.tabs.size;
        }
        return count;
    }

    /**
     * Looks one identity up again -- the revalidation every activation
     * starts with. Null for anything not currently in a READY session,
     * including every identity from a session that has since restarted.
     */
    resolve(identity) {
        if (!validTabIdentity(identity))
            return null;
        const session = this._sessions.get(sessionKey(identity));
        if (!session || session.state !== SessionState.READY)
            return null;
        const tab = session.tabs.get(identity.tabId);
        return tab ? this._tabView(session, tab) : null;
    }

    // --- Internals ----------------------------------------------------------

    _reduce(session, message) {
        switch (message.type) {
        case BrowserEventType.TAB_CREATED:
        case BrowserEventType.TAB_UPDATED:
        case BrowserEventType.TAB_MOVED:
        case BrowserEventType.TAB_ATTACHED: {
            const tab = normalizeTab(message.tab);
            if (!tab)
                return false;
            this._ensureWindow(session, tab.windowId);
            session.tabs.set(tab.tabId, tab);
            if (tab.active)
                this._deactivateSiblings(session, tab);
            return true;
        }

        case BrowserEventType.TAB_ACTIVATED: {
            const tab = normalizeTab(message.tab);
            if (!tab)
                return false;
            this._ensureWindow(session, tab.windowId);
            const active = Object.freeze({...tab, active: true});
            session.tabs.set(active.tabId, active);
            this._deactivateSiblings(session, active);
            return true;
        }

        case BrowserEventType.TAB_REMOVED:
            if (!validIntegerId(message.tabId))
                return false;
            session.tabs.delete(message.tabId);
            return true;

        case BrowserEventType.TAB_DETACHED: {
            if (!validIntegerId(message.tabId) || !validIntegerId(message.oldWindowId))
                return false;
            // Detached tabs are re-announced by TAB_ATTACHED moments later;
            // between the two they belong to no window. A tab already
            // re-attached (events can interleave) is left where it is.
            const current = session.tabs.get(message.tabId);
            if (current && current.windowId === message.oldWindowId)
                session.tabs.delete(message.tabId);
            return true;
        }

        case BrowserEventType.TAB_REPLACED: {
            const tab = normalizeTab(message.tab);
            if (!tab || !validIntegerId(message.replacedTabId))
                return false;
            session.tabs.delete(message.replacedTabId);
            this._ensureWindow(session, tab.windowId);
            session.tabs.set(tab.tabId, tab);
            return true;
        }

        case BrowserEventType.WINDOW_CREATED:
        case BrowserEventType.WINDOW_UPDATED: {
            const window = normalizeWindow(message.window);
            if (!window)
                return false;
            session.windows.set(window.windowId, window);
            if (window.focused)
                this._setFocusedWindow(session, window.windowId);
            return true;
        }

        case BrowserEventType.WINDOW_REMOVED:
            if (!validIntegerId(message.windowId))
                return false;
            session.windows.delete(message.windowId);
            for (const [tabId, tab] of session.tabs) {
                if (tab.windowId === message.windowId)
                    session.tabs.delete(tabId);
            }
            if (session.focusedWindowId === message.windowId)
                this._setFocusedWindow(session, WINDOW_ID_NONE);
            return true;

        case BrowserEventType.WINDOW_FOCUSED:
            if (message.windowId !== WINDOW_ID_NONE && !validIntegerId(message.windowId))
                return false;
            this._setFocusedWindow(session, message.windowId);
            return true;

        case BrowserEventType.WINDOW_RECONCILED: {
            if (!validIntegerId(message.windowId) || !Array.isArray(message.tabs))
                return false;
            const replacements = new Map();
            for (const candidate of message.tabs) {
                const tab = normalizeTab(candidate);
                if (!tab || tab.windowId !== message.windowId || replacements.has(tab.tabId))
                    return false;
                replacements.set(tab.tabId, tab);
            }
            for (const [tabId, tab] of session.tabs) {
                if (tab.windowId === message.windowId)
                    session.tabs.delete(tabId);
            }
            this._ensureWindow(session, message.windowId);
            for (const [tabId, tab] of replacements)
                session.tabs.set(tabId, tab);
            return true;
        }

        default:
            return false;
        }
    }

    // A tab can be announced a beat before its window (a new window's
    // first tab, a tab dragged out into a window of its own), so the
    // window record is created on demand and filled in when it arrives.
    _ensureWindow(session, windowId) {
        if (!session.windows.has(windowId)) {
            session.windows.set(windowId, normalizeWindow({
                windowId, type: WindowType.NORMAL, focused: false, incognito: false, title: '',
            }));
        }
    }

    _deactivateSiblings(session, active) {
        for (const [tabId, tab] of session.tabs) {
            if (tab.windowId === active.windowId && tab.active && tabId !== active.tabId)
                session.tabs.set(tabId, Object.freeze({...tab, active: false}));
        }
    }

    _setFocusedWindow(session, windowId) {
        session.focusedWindowId = windowId;
        for (const [id, window] of session.windows) {
            const focused = id === windowId;
            if (window.focused !== focused)
                session.windows.set(id, Object.freeze({...window, focused}));
        }
    }

    _requireResync(session) {
        session.state = SessionState.RESYNCING;
        session.windows.clear();
        session.tabs.clear();
        session.focusedWindowId = WINDOW_ID_NONE;
        this._version++;
        return StoreResult.RESYNC_REQUIRED;
    }

    _windowViews(session) {
        return [...session.windows.values()].map(window => this._windowView(session, window));
    }

    _windowView(session, window) {
        let activeTab = null;
        let tabCount = 0;
        for (const tab of session.tabs.values()) {
            if (tab.windowId !== window.windowId)
                continue;
            tabCount++;
            if (tab.active)
                activeTab = tab;
        }
        return {
            sessionKey: session.key,
            browserType: session.browserType,
            browserName: session.browserName,
            ...window,
            activeTitle: activeTab?.title ?? '',
            tabCount,
        };
    }

    _tabView(session, tab) {
        return {
            sessionKey: session.key,
            browserType: session.browserType,
            browserName: session.browserName,
            profileId: session.profileId,
            sessionId: session.sessionId,
            incognito: session.windows.get(tab.windowId)?.incognito === true,
            windowFocused: tab.windowId === session.focusedWindowId,
            ...tab,
        };
    }
}

function safeName(value) {
    return typeof value === 'string' && value.length <= 120 ? value.trim() : '';
}
