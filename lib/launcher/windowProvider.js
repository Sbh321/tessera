// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CURRENT_WORKSPACE_BOOST, ProviderId} from './constants.js';
import {ActivationMode} from './searchResult.js';
import {SearchProvider} from './searchProvider.js';
import {collapseWhitespace} from './utils.js';

// The application leads: it is what a window IS, and it never changes,
// whereas the title is whatever the app happens to be showing -- a
// random file left open in an editor, the current page in a browser.
// The title is still searched, one notch down, so a window can be found
// by what it shows when that is what you remember.
const APP_WEIGHT = 1.0;
const TITLE_WEIGHT = 0.85;
const CLASS_WEIGHT = 0.6;

// How many windows the resting (empty-query) view lists before it stops
// being a list and starts being a wall.
const DEFAULT_VIEW_LIMIT = 8;

/**
 * Open windows, searchable by title, application and WM class.
 *
 * Ground truth is `global.display.get_tab_list(NORMAL_ALL, null)`, the
 * same most-recently-used ordering Alt+Tab walks -- which gives the
 * "recently focused" ranking for free and always reflects reality, so
 * this provider caches nothing and can never list a window that has
 * already closed.
 *
 * Selecting a window hands off to `Main.activateWindow()`, GNOME's own
 * helper: it switches workspace when needed (carrying the standard
 * animation), raises, focuses, and closes the overview. Reimplementing
 * any of that would mean fighting the window-management model Tessera
 * deliberately builds on.
 *
 * A browser window whose tabs are known (see browserTabService.js)
 * stays an ordinary window result -- Enter still focuses the window --
 * but carries its tab count as a badge and, in the resting view, its
 * tabs as expandable children. While searching it carries the badge
 * only: tabs are then searched directly by browserTabsProvider, so the
 * hierarchy would only get in the way.
 */
export class WindowProvider extends SearchProvider {
    /**
     * @param {object} context
     * @param {?import('./browserTabsProvider.js').BrowserTabsProvider} tabsProvider
     *   builds the child rows; null leaves every window plain
     */
    constructor(context, tabsProvider = null) {
        super(ProviderId.WINDOWS, context);
        this._tracker = Shell.WindowTracker.get_default();
        this._tabsProvider = tabsProvider;
    }

    get enabled() {
        return this.context.settings.launcherEnableWindows;
    }

    query(parsed) {
        const results = [];
        const windows = this._windows();
        const tabInfo = this._describeTabs(windows);

        windows.forEach((window, index) => {
            const app = this._tracker.get_window_app(window);
            // Matched against the SAME string the row will display: the
            // matcher reports highlight positions as indexes into the
            // title, so matching the raw title and then displaying a
            // collapsed one would slide every highlight out of place for
            // any window whose title contains a newline or double space.
            // The app name is the START of the subtitle (see _describe),
            // which is what lets its matches be highlighted there.
            const fields = [
                {key: 'app', text: app?.get_name() ?? '', weight: APP_WEIGHT, primary: true, highlight: 'subtitle'},
                {key: 'title', text: this._displayTitle(window, app), weight: TITLE_WEIGHT, primary: false},
                {key: 'class', text: window.get_wm_class() ?? '', weight: CLASS_WEIGHT},
            ];

            const match = this.match(parsed, fields);
            if (match) {
                results.push(this._windowResult(
                    window, app, match.score, match, index, tabInfo.get(window), false));
            }
        });

        return results;
    }

    defaultResults() {
        return this._listResults(DEFAULT_VIEW_LIMIT);
    }

    browseCount() {
        return this._windows().length;
    }

    /**
     * Every open window, not just the handful the resting view shows --
     * filtering to this section is how you ask to see them all.
     */
    browseResults() {
        return this._listResults(Number.MAX_SAFE_INTEGER);
    }

    // Descending with MRU position so both views read as an Alt+Tab
    // list: most recently used first.
    _listResults(limit) {
        const windows = this._windows().slice(0, limit);
        const tabInfo = this._describeTabs(windows);
        return windows.map((window, index) => this._windowResult(
            window, this._tracker.get_window_app(window), 0.7 - index * 0.01, null, index,
            tabInfo.get(window), true));
    }

    /**
     * Which of these windows are browser windows with known tabs. Empty
     * whenever tab search is off or no browser is connected, in which
     * case every window is exactly what it was before this feature.
     *
     * @returns {Map<Meta.Window, object>}
     */
    _describeTabs(windows) {
        if (!this._tabsProvider?.enabled || !this.context.browserTabs)
            return new Map();
        return this.context.browserTabs.describeWindows(windows);
    }

    /**
     * Every window a user could reasonably want to switch to. NORMAL_ALL
     * spans every workspace and monitor; skip-taskbar windows (splashes,
     * tool palettes) are dropped for the same reason the window switcher
     * drops them -- they are not independent destinations.
     */
    _windows() {
        return global.display
            .get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .filter(window => !window.is_skip_taskbar());
    }

    /** The one title string used for both matching and display. */
    _displayTitle(window, app) {
        return collapseWhitespace(window.get_title() ?? '') ||
            app?.get_name() || _('Untitled window');
    }

    /**
     * @param {?{positions: number[], subtitlePositions: number[]}} match
     *   the matcher's highlight positions, or null at rest
     * @param {?object} tabInfo the browser window behind this window, from
     *   BrowserTabService.describeWindows(), or null for any other window
     * @param {boolean} withChildren whether to attach its tabs as
     *   expandable children (resting view only)
     */
    _windowResult(window, app, score, match, mruIndex, tabInfo = null, withChildren = false) {
        const activeWorkspace = global.workspace_manager.get_active_workspace();
        const onActiveWorkspace = window.is_on_all_workspaces() ||
            window.get_workspace() === activeWorkspace;

        const tabCount = tabInfo?.tabCount ?? 0;
        const badge = tabCount > 0
            ? ngettext('%d tab', '%d tabs', tabCount).format(tabCount) : '';
        const children = tabCount > 0 && withChildren
            ? this._tabsProvider.childResults(tabInfo) : [];

        // A browser window is recognised by what it is showing: its
        // active tab's favicon leads, and the browser's own icon moves
        // to the corner -- the same treatment its tab rows get, so a
        // window and its tabs read as one family.
        const appIcon = app?.get_icon() ?? null;
        const favicon = tabCount > 0
            ? this.context.browserTabs.iconFor(tabInfo.tabs().find(tab => tab.active) ?? {}) : null;

        return this.createResult({
            // get_stable_sequence() is Mutter's monotonic per-window
            // creation id: unique, and stable for the window's whole
            // lifetime, unlike the title (which changes as the user
            // works) or the index in this list.
            id: `w${window.get_stable_sequence()}`,
            title: this._displayTitle(window, app),
            subtitle: this._describe(window, app),
            gicon: favicon ?? appIcon,
            badgeGicon: favicon ? appIcon : null,
            score,
            positions: match?.positions ?? [],
            subtitlePositions: match?.subtitlePositions ?? [],
            badge,
            children,
            metadata: {
                // Ranking follows the eye: a window already on screen is
                // a likelier target than an identically-named one three
                // workspaces away. MRU position breaks the remaining
                // ties, so repeatedly hopping between two windows keeps
                // them both at the top.
                contextBoost: (onActiveWorkspace ? CURRENT_WORKSPACE_BOOST : 0) +
                    Math.max(0, 0.02 - mruIndex * 0.002),
            },
            alternateLabel: _('Bring to this workspace'),
            activate: mode => this._activate(window, mode),
        });
    }

    _describe(window, app) {
        const appName = app?.get_name() ?? window.get_wm_class() ?? '';

        if (window.is_on_all_workspaces())
            return appName ? `${appName} · ${_('All workspaces')}` : _('All workspaces');

        const index = window.get_workspace()?.index();
        if (index === undefined || index === null)
            return appName;

        // 1-based, matching the panel indicator's own numbering.
        const workspaceLabel = `${_('Workspace')} ${index + 1}`;
        return appName ? `${appName} · ${workspaceLabel}` : workspaceLabel;
    }

    /**
     * Enter goes to the window; Ctrl+Enter brings the window here
     * instead -- the two halves of "I want to be looking at this", which
     * is exactly the choice Tessera's Super+N / Shift+Super+N pair
     * already offers for the focused window.
     */
    _activate(window, mode) {
        if (mode === ActivationMode.ALTERNATE && !window.is_on_all_workspaces()) {
            const activeWorkspace = global.workspace_manager.get_active_workspace();
            if (window.get_workspace() !== activeWorkspace)
                window.change_workspace(activeWorkspace);
        }

        Main.activateWindow(window);
    }
}
