// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Pairs the browser's own windows with the compositor's windows.
 *
 * Neither side can name the other: a WebExtension sees window ids that
 * mean nothing outside the browser, and on Wayland Mutter sees a toplevel
 * with a title, an app id and nothing else -- no window handle, no way to
 * ask the client which of its windows this is. So the pairing has to be
 * inferred, and the whole design of this file is about doing that with
 * evidence rather than guesses, in strictly descending order of trust:
 *
 *  1. FOCUS (strong). When the browser reports "window W is now focused",
 *     whatever Meta.Window holds keyboard focus at that instant IS W --
 *     Mutter hands focus to a client before the client can know about it.
 *     Recorded by the caller through bindStrong(); never overridden by a
 *     weaker rule, only by a later focus observation or the window going
 *     away. Every window the user touches is confirmed this way.
 *  2. TITLE (exact). A browser window's expected title -- the window's
 *     own title where the API exposes it (Firefox), otherwise the active
 *     tab's title plus a known suffix such as " - Google Chrome" -- equals
 *     one shell window's title, and that shell window matches no other
 *     browser window. Resolved by elimination, so two windows with
 *     different titles pair up even before either is focused.
 *  3. PREFIX (weak). The shell title starts with the active tab's title
 *     followed by a dash-like separator, for browsers whose suffix has
 *     not been learned yet. Same uniqueness rule.
 *
 * Anything still ambiguous after that -- typically two windows both on
 * "New Tab" that nobody has focused since the browser connected -- stays
 * UNBOUND, and the launcher shows those windows without tab information
 * rather than attaching the wrong window's tabs to them. Focusing either
 * one resolves both.
 *
 * Whatever the mapping says, activation never depends on it for
 * correctness: a tab is activated by its own identity, and the mapping
 * only decides which compositor window to raise afterwards.
 *
 * Pure: no GNOME imports. Shell windows arrive as plain descriptors, so
 * tests/browser-window-mapper-test.js can drive every rule directly.
 */

export const BindingStrength = Object.freeze({
    STRONG: 'strong',
    TITLE: 'title',
    PREFIX: 'prefix',
});

// Chromium separates title and product name with " - "; Firefox with an
// em dash. Both are accepted for the weak rule, along with an en dash for
// forks that use one.
const TITLE_SEPARATOR = /^\s+[-–—]\s+\S/;

// Bidi isolation and direction marks that a browser may wrap a title in
// for display, which a window title comparison must not see.
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;

/** Both sides of every comparison go through this. */
export function normalizeTitle(text) {
    return (text ?? '').replace(BIDI_MARKS, '').replace(/\s+/g, ' ').trim();
}

/**
 * The exact titles a browser window is expected to carry, given the
 * product-name suffixes known for its session.
 *
 * @param {{title: string, activeTitle: string}} browserWindow
 * @param {string[]} suffixes
 * @returns {string[]} normalized
 */
export function expectedTitles(browserWindow, suffixes) {
    const own = normalizeTitle(browserWindow.title);
    if (own)
        return [own];
    const active = normalizeTitle(browserWindow.activeTitle);
    if (!active)
        return [];
    return suffixes.map(suffix => normalizeTitle(active + suffix));
}

/**
 * The weak rule: the shell title is the active tab's title plus some
 * product-name suffix this session has not taught us yet.
 */
export function titleHasPrefix(shellTitle, activeTitle) {
    const active = normalizeTitle(activeTitle);
    if (!active || !shellTitle.startsWith(active))
        return false;
    const remainder = shellTitle.slice(active.length);
    return remainder.length === 0 || TITLE_SEPARATOR.test(remainder);
}

/**
 * What follows the active tab's title in a shell title, when it looks
 * like a product-name suffix -- learned from focus-confirmed pairs so the
 * exact rule works for browsers whose suffix was not known in advance.
 *
 * @returns {?string} the suffix with its leading separator, or null
 */
export function learnSuffix(shellTitle, activeTitle) {
    const shell = normalizeTitle(shellTitle);
    const active = normalizeTitle(activeTitle);
    if (!active || !shell.startsWith(active))
        return null;
    const remainder = shell.slice(active.length);
    return TITLE_SEPARATOR.test(remainder) ? remainder : null;
}

export class BrowserWindowMapper {
    constructor() {
        /** @type {Map<string, {sessionKey: string, windowId: number, strength: string}>} */
        this._byShell = new Map();
        /** @type {Map<string, string>} browser window key -> shell key */
        this._byBrowser = new Map();
    }

    /**
     * Records a focus-confirmed pair. Displaces whatever either side was
     * bound to before: a window is one physical thing, so a fresh
     * observation about it outranks any older inference.
     */
    bindStrong(shellKey, sessionKey, windowId) {
        this._bind(shellKey, sessionKey, windowId, BindingStrength.STRONG);
    }

    forgetShell(shellKey) {
        const binding = this._byShell.get(shellKey);
        if (!binding)
            return;
        this._byShell.delete(shellKey);
        this._byBrowser.delete(browserKey(binding.sessionKey, binding.windowId));
    }

    forgetSession(sessionKey) {
        for (const [shellKey, binding] of [...this._byShell]) {
            if (binding.sessionKey === sessionKey)
                this.forgetShell(shellKey);
        }
    }

    /** @returns {?{sessionKey: string, windowId: number, strength: string}} */
    binding(shellKey) {
        return this._byShell.get(shellKey) ?? null;
    }

    /** @returns {?string} */
    shellKeyFor(sessionKey, windowId) {
        return this._byBrowser.get(browserKey(sessionKey, windowId)) ?? null;
    }

    /**
     * Reconciles the bindings against what currently exists and infers
     * every pair the title rules can establish without ambiguity.
     *
     * @param {Array<{key: string, title: string, family: ?string}>} shellWindows
     *   every candidate compositor window; `family` is the browser family
     *   the window's app belongs to, or null for a non-browser window
     * @param {Array<{key: string, browserType: string, suffixes: string[],
     *   windows: Array<{windowId: number, title: string, activeTitle: string}>}>} sessions
     * @returns {Map<string, {sessionKey: string, windowId: number, strength: string}>}
     *   shell key -> binding, for every bound shell window
     */
    resolve(shellWindows, sessions) {
        this._prune(shellWindows, sessions);

        const shells = shellWindows
            .filter(window => window.family && !this._byShell.has(window.key))
            .map(window => ({key: window.key, family: window.family, title: normalizeTitle(window.title)}));

        const browsers = [];
        for (const session of sessions) {
            for (const window of session.windows) {
                if (this._byBrowser.has(browserKey(session.key, window.windowId)))
                    continue;
                browsers.push({
                    sessionKey: session.key,
                    windowId: window.windowId,
                    family: session.browserType,
                    exact: new Set(expectedTitles(window, session.suffixes)),
                    activeTitle: window.activeTitle,
                });
            }
        }

        this._pairUnique(shells, browsers, BindingStrength.TITLE,
            (shell, browser) => browser.exact.has(shell.title));
        this._pairUnique(shells, browsers, BindingStrength.PREFIX,
            (shell, browser) => titleHasPrefix(shell.title, browser.activeTitle));

        return new Map(this._byShell);
    }

    /**
     * Binds every (shell, browser) pair that is each other's ONLY match
     * under `matches`, repeating until elimination finds nothing more.
     * Pools are tiny (open windows of one browser family), so the
     * repeated scans cost nothing measurable.
     */
    _pairUnique(shells, browsers, strength, matches) {
        let progress = true;
        while (progress) {
            progress = false;

            for (const browser of browsers) {
                const candidates = shells.filter(shell =>
                    shell.family === browser.family && matches(shell, browser));
                if (candidates.length !== 1)
                    continue;
                const shell = candidates[0];
                const rivals = browsers.filter(other =>
                    other.family === shell.family && matches(shell, other));
                if (rivals.length !== 1)
                    continue;

                this._bind(shell.key, browser.sessionKey, browser.windowId, strength);
                shells.splice(shells.indexOf(shell), 1);
                browsers.splice(browsers.indexOf(browser), 1);
                progress = true;
                break;
            }
        }
    }

    _prune(shellWindows, sessions) {
        const liveShell = new Set(shellWindows.map(window => window.key));
        const liveBrowser = new Set();
        for (const session of sessions) {
            for (const window of session.windows)
                liveBrowser.add(browserKey(session.key, window.windowId));
        }
        for (const [shellKey, binding] of [...this._byShell]) {
            if (!liveShell.has(shellKey) ||
                !liveBrowser.has(browserKey(binding.sessionKey, binding.windowId)))
                this.forgetShell(shellKey);
        }
    }

    _bind(shellKey, sessionKey, windowId, strength) {
        this.forgetShell(shellKey);
        const previousShell = this._byBrowser.get(browserKey(sessionKey, windowId));
        if (previousShell !== undefined)
            this.forgetShell(previousShell);

        this._byShell.set(shellKey, {sessionKey, windowId, strength});
        this._byBrowser.set(browserKey(sessionKey, windowId), shellKey);
    }
}

function browserKey(sessionKey, windowId) {
    return `${sessionKey}#${windowId}`;
}
