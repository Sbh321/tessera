// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    BrowserEventType, BrowserType, MessageType, WINDOW_ID_NONE,
} from '../../companion/modules/tabs/protocol.js';
import {BrowserBridge} from './browserBridge.js';
import {
    BrowserWindowMapper, learnSuffix, normalizeTitle, titleHasPrefix,
} from './browserWindowMapper.js';

// Which browser family a compositor window belongs to, from its app id /
// WM class. Deliberately loose: forks and packaging variants (snap,
// flatpak) all carry the product name somewhere in there.
const FAMILY_PATTERNS = [
    [BrowserType.CHROMIUM, /chrom|brave|microsoft-edge|vivaldi|opera|thorium/i],
    [BrowserType.FIREFOX, /firefox|librewolf|waterfox|floorp|mullvad|zen[-_.]?browser/i],
];

// Product-name suffixes each family puts after the page title. Chromium
// adds the browser's own name (learned from the companion), Firefox its
// fixed strings -- and Firefox also reports the whole title outright, so
// its suffixes are only a fallback.
function defaultSuffixes(browserType, browserName) {
    if (browserType === BrowserType.FIREFOX) {
        return [
            ' — Mozilla Firefox', ' — Mozilla Firefox Private Browsing',
            ` — ${browserName}`, ` — ${browserName} Private Browsing`,
        ];
    }
    return [` - ${browserName}`, ` - ${browserName} (Incognito)`];
}

// After a tab is activated its window's title changes to that tab's
// title, which is what lets an as-yet-unmapped window be found by the
// title rule; these retries give the browser time to retitle.
const FOCUS_RETRY_MS = 150;
const FOCUS_RETRIES = 4;

// How many learned suffixes / classes one session may accumulate.
const MAX_LEARNED = 8;

// Decoded favicons kept as Gio.Icons across every session. Well above
// what a few hundred tabs on distinct sites need; when exceeded the
// whole cache is dropped and rebuilt lazily from the store.
const MAX_ICON_CACHE = 1024;

// The browser's own icon, for the corner badge and as the fallback for
// tabs without a favicon. The mapped window's app is authoritative;
// these desktop ids cover a browser that has connected but whose
// windows are not mapped yet.
const BROWSER_DESKTOP_IDS = {
    'Google Chrome': ['google-chrome.desktop', 'com.google.Chrome.desktop'],
    'Chromium': ['chromium.desktop', 'chromium-browser.desktop', 'org.chromium.Chromium.desktop'],
    'Brave': ['brave-browser.desktop', 'com.brave.Browser.desktop'],
    'Microsoft Edge': ['microsoft-edge.desktop', 'com.microsoft.Edge.desktop'],
    'Vivaldi': ['vivaldi-stable.desktop', 'vivaldi.desktop'],
    'Opera': ['opera.desktop', 'com.opera.Opera.desktop'],
    'Firefox': ['firefox.desktop', 'firefox_firefox.desktop', 'org.mozilla.firefox.desktop'],
};

/**
 * Everything the launcher knows about browser tabs, behind one object.
 *
 * Owns the socket bridge (and through it the tab store) and the window
 * mapper, and is the only place that touches Mutter on their behalf.
 * Providers ask it two things: which tabs belong to a given Meta.Window
 * (for the count and the expandable children), and for the flat list of
 * every tab (for searching). Activation goes through it too, so that the
 * exact-tab guarantee and the "raise the right compositor window
 * afterwards" step live together.
 *
 * Runs only while `launcher-enable-tabs` is on; off, it holds no socket,
 * no signals and no state.
 */
export class BrowserTabService {
    /**
     * @param {import('../settingsManager.js').SettingsManager} settings
     */
    constructor(settings) {
        this._settings = settings;
        this._bridge = new BrowserBridge({
            onChanged: () => this.onChanged?.(),
            onApplied: (sessionKey, message) => this._onApplied(sessionKey, message),
        });
        this._mapper = new BrowserWindowMapper();
        // Per session key: product-name suffixes and WM classes confirmed
        // by focus pairing, so unfamiliar browsers teach us their shape.
        this._learnedSuffixes = new Map();
        this._learnedClasses = new Map();
        this._settingsSignalId = null;
        this._retrySourceIds = new Set();
        // `${sessionKey}#${iconKey}` -> Gio.BytesIcon, built lazily.
        this._iconCache = new Map();
        // session key -> Gio.Icon of the browser application, or null.
        this._browserIcons = new Map();
        this._tracker = Shell.WindowTracker.get_default();

        /** @type {?function(): void} the launcher's "please redraw" hook */
        this.onChanged = null;
    }

    enable() {
        this._settingsSignalId = this._settings.gsettings.connect(
            'changed::launcher-enable-tabs', () => this._syncEnabled());
        this._syncEnabled();
    }

    disable() {
        if (this._settingsSignalId !== null) {
            this._settings.gsettings.disconnect(this._settingsSignalId);
            this._settingsSignalId = null;
        }
        for (const id of this._retrySourceIds)
            GLib.Source.remove(id);
        this._retrySourceIds.clear();
        this._bridge.stop();
        this._mapper = new BrowserWindowMapper();
        this._learnedSuffixes.clear();
        this._learnedClasses.clear();
        this._iconCache.clear();
        this._browserIcons.clear();
        this.onChanged = null;
    }

    /**
     * The favicon of one tab as a Gio.Icon, or null when the browser has
     * not delivered one. Decoded once per session and icon key; the
     * bytes come from the store, which is the only copy of them.
     *
     * @param {object} tab a store tab view
     * @returns {?Gio.Icon}
     */
    iconFor(tab) {
        if (!tab?.iconKey || !tab.sessionKey)
            return null;
        const cacheKey = `${tab.sessionKey}#${tab.iconKey}`;
        const cached = this._iconCache.get(cacheKey);
        if (cached !== undefined)
            return cached;

        const stored = this._bridge.store.icon(tab.sessionKey, tab.iconKey);
        if (!stored)
            return null;

        let icon = null;
        try {
            icon = Gio.BytesIcon.new(GLib.Bytes.new(GLib.base64_decode(stored.data)));
        } catch (_error) {
            // Undecodable data stays a fallback icon; the entry is cached
            // as null so it is not retried on every keystroke.
        }
        if (this._iconCache.size >= MAX_ICON_CACHE)
            this._iconCache.clear();
        this._iconCache.set(cacheKey, icon);
        return icon;
    }

    /**
     * The icon of the browser application a tab belongs to -- drawn as a
     * small badge over its favicon, and standing in for the favicon when
     * there is none.
     *
     * @param {object} tab a store tab view
     * @returns {?Gio.Icon}
     */
    browserIconFor(tab) {
        const cached = this._browserIcons.get(tab.sessionKey);
        if (cached !== undefined)
            return cached;

        // A window already mapped to this session names the app exactly,
        // whatever the browser is called; the desktop-id table is only
        // for a browser none of whose windows has been paired yet.
        let app = null;
        for (const metaWindow of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)) {
            const binding = this._mapper.binding(shellKey(metaWindow));
            if (binding?.sessionKey === tab.sessionKey) {
                app = this._tracker.get_window_app(metaWindow);
                break;
            }
        }
        if (!app) {
            const appSystem = Shell.AppSystem.get_default();
            for (const id of BROWSER_DESKTOP_IDS[tab.browserName] ?? []) {
                app = appSystem.lookup_app(id);
                if (app)
                    break;
            }
        }

        const icon = app?.get_icon() ?? null;
        // Only a positive answer is cached: the mapped window that names
        // the app may not exist yet.
        if (icon)
            this._browserIcons.set(tab.sessionKey, icon);
        return icon;
    }

    /** @returns {boolean} whether the socket is up (not whether anything is connected) */
    get running() {
        return this._bridge.running;
    }

    /** @returns {number} tabs across every synchronised browser */
    get tabCount() {
        return this._bridge.store.tabCount;
    }

    /** @returns {object[]} every tab of every synchronised browser */
    listTabs() {
        return this._bridge.store.listTabs();
    }

    /**
     * Resolves which of the given compositor windows are browser windows
     * with known tabs.
     *
     * The mapping is recomputed against EVERY open window, not just the
     * ones asked about: elimination only works when the whole pool is
     * visible, and a window outside the launcher's eight-row resting
     * view can still be the true owner of a title.
     *
     * @param {Meta.Window[]} metaWindows
     * @returns {Map<Meta.Window, {sessionKey: string, windowId: number,
     *   browserName: string, tabCount: number, tabs: function(): object[]}>}
     */
    describeWindows(metaWindows) {
        const described = new Map();
        if (!this._bridge.running)
            return described;

        const store = this._bridge.store;
        const sessions = store.sessions();
        if (sessions.length === 0)
            return described;

        const bindings = this._resolveBindings(sessions);
        for (const metaWindow of metaWindows) {
            const binding = bindings.get(shellKey(metaWindow));
            if (!binding)
                continue;
            const view = store.windowOf(binding.sessionKey, binding.windowId);
            if (!view)
                continue;
            described.set(metaWindow, {
                sessionKey: view.sessionKey,
                windowId: view.windowId,
                browserName: view.browserName,
                tabCount: view.tabCount,
                tabs: () => store.tabsOf(view.sessionKey, view.windowId),
            });
        }
        return described;
    }

    /**
     * Activates one exact tab, then raises the compositor window that
     * holds it. The invariant: either THAT tab is activated or no tab is.
     *
     * @param {{browserType: string, profileId: string, sessionId: string,
     *   tabId: number}} identity
     * @returns {Promise<boolean>}
     */
    async activate(identity) {
        const current = this._bridge.store.resolve(identity);
        if (!current) {
            this._notifyGone();
            return false;
        }

        const verdict = await this._bridge.activate(identity);
        if (!verdict.ok) {
            this._notifyGone();
            return false;
        }

        this._raiseBrowserWindow(current.sessionKey, verdict.windowId, 0);
        return true;
    }

    // --- Internals ----------------------------------------------------------

    _syncEnabled() {
        if (this._settings.launcherEnableTabs) {
            this._bridge.start();
        } else {
            this._bridge.stop();
            this._mapper = new BrowserWindowMapper();
            this._iconCache.clear();
            this._browserIcons.clear();
        }
    }

    _notifyGone() {
        Main.notify(_('Tessera'), _('That browser tab is no longer open.'));
    }

    /**
     * The focus rule. Runs for every snapshot and focus event: the
     * compositor's focus window at the moment the browser reports "window
     * W has focus" is W, provided it is a window of that browser family
     * whose title agrees -- the agreement check is what makes a
     * message that arrives a beat late harmless.
     */
    _onApplied(sessionKey, message) {
        let windowId = WINDOW_ID_NONE;
        if (message.type === MessageType.SNAPSHOT)
            windowId = this._bridge.store.sessions().find(s => s.key === sessionKey)?.focusedWindowId ?? WINDOW_ID_NONE;
        else if (message.type === BrowserEventType.WINDOW_FOCUSED)
            windowId = message.windowId;
        else if (message.type === BrowserEventType.WINDOW_CREATED && message.window?.focused)
            windowId = message.window.windowId;

        if (windowId === WINDOW_ID_NONE)
            return;

        const focused = global.display.focus_window;
        if (!focused)
            return;
        const view = this._bridge.store.windowOf(sessionKey, windowId);
        if (!view)
            return;

        const wmClass = windowClass(focused);
        const family = this._family(focused, wmClass);
        if (family !== view.browserType)
            return;

        const shellTitle = normalizeTitle(focused.get_title());
        const consistent = view.title
            ? shellTitle === normalizeTitle(view.title)
            : !view.activeTitle || titleHasPrefix(shellTitle, view.activeTitle);
        if (!consistent)
            return;

        this._mapper.bindStrong(shellKey(focused), sessionKey, windowId);
        this._learn(this._learnedSuffixes, sessionKey, learnSuffix(shellTitle, view.activeTitle));
        this._learn(this._learnedClasses, sessionKey, wmClass);
    }

    _learn(registry, sessionKey, value) {
        if (!value)
            return;
        let learned = registry.get(sessionKey);
        if (!learned) {
            learned = new Set();
            registry.set(sessionKey, learned);
        }
        if (learned.size < MAX_LEARNED)
            learned.add(value);
    }

    _family(metaWindow, wmClass = windowClass(metaWindow)) {
        for (const [browserType, pattern] of FAMILY_PATTERNS) {
            if (pattern.test(wmClass))
                return browserType;
        }
        for (const session of this._bridge.store.sessions()) {
            if (this._learnedClasses.get(session.key)?.has(wmClass))
                return session.browserType;
        }
        return null;
    }

    _resolveBindings(sessions) {
        const shellWindows = global.display
            .get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .map(metaWindow => ({
                key: shellKey(metaWindow),
                title: metaWindow.get_title() ?? '',
                family: this._family(metaWindow),
            }));

        const mapperSessions = sessions.map(session => ({
            key: session.key,
            browserType: session.browserType,
            suffixes: [
                ...this._learnedSuffixes.get(session.key) ?? [],
                ...defaultSuffixes(session.browserType, session.browserName),
            ],
            windows: session.windows.map(window => ({
                windowId: window.windowId,
                title: window.title,
                activeTitle: window.activeTitle,
            })),
        }));

        return this._mapper.resolve(shellWindows, mapperSessions);
    }

    _raiseBrowserWindow(sessionKey, windowId, attempt) {
        if (!this._bridge.running || windowId === WINDOW_ID_NONE)
            return;

        const sessions = this._bridge.store.sessions();
        this._resolveBindings(sessions);
        const key = this._mapper.shellKeyFor(sessionKey, windowId);
        const metaWindow = key
            ? global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
                .find(candidate => shellKey(candidate) === key)
            : null;

        if (metaWindow) {
            Main.activateWindow(metaWindow);
            return;
        }

        // Unmapped so far: the browser has just retitled this window to
        // the activated tab, so the title rule can catch it on retry. If
        // it never does, the browser's own focus request stands and the
        // tab is still activated -- only the raise is missed.
        if (attempt >= FOCUS_RETRIES)
            return;
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOCUS_RETRY_MS, () => {
            this._retrySourceIds.delete(sourceId);
            this._raiseBrowserWindow(sessionKey, windowId, attempt + 1);
            return GLib.SOURCE_REMOVE;
        });
        this._retrySourceIds.add(sourceId);
    }
}

/**
 * The mapper's name for a compositor window: Mutter's monotonic creation
 * sequence, unique and stable for the window's lifetime -- the same key
 * windowProvider.js uses for its result ids.
 */
function shellKey(metaWindow) {
    return `w${metaWindow.get_stable_sequence()}`;
}

/** Every identifier a window carries that could name its application. */
function windowClass(metaWindow) {
    return [
        metaWindow.get_wm_class(),
        metaWindow.get_gtk_application_id(),
        metaWindow.get_sandboxed_app_id(),
    ].filter(Boolean).join(' ');
}
