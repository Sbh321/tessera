// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CURRENT_WORKSPACE_BOOST, ProviderId} from './constants.js';
import {ActivationMode} from './searchResult.js';
import {SearchProvider} from './searchProvider.js';
import {collapseWhitespace} from './utils.js';

const TITLE_WEIGHT = 1.0;
const APP_WEIGHT = 0.85;
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
 */
export class WindowProvider extends SearchProvider {
    constructor(context) {
        super(ProviderId.WINDOWS, context);
        this._tracker = Shell.WindowTracker.get_default();
    }

    get enabled() {
        return this.context.settings.launcherEnableWindows;
    }

    query(parsed) {
        const results = [];

        this._windows().forEach((window, index) => {
            const app = this._tracker.get_window_app(window);
            // Matched against the SAME string the row will display: the
            // matcher reports highlight positions as indexes into the
            // title, so matching the raw title and then displaying a
            // collapsed one would slide every highlight out of place for
            // any window whose title contains a newline or double space.
            const fields = [
                {key: 'title', text: this._displayTitle(window, app), weight: TITLE_WEIGHT},
                {key: 'app', text: app?.get_name() ?? '', weight: APP_WEIGHT},
                {key: 'class', text: window.get_wm_class() ?? '', weight: CLASS_WEIGHT},
            ];

            const match = this.match(parsed, fields);
            if (match)
                results.push(this._windowResult(window, app, match.score, match.positions, index));
        });

        return results;
    }

    defaultResults() {
        return this._listResults(DEFAULT_VIEW_LIMIT);
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
        return this._windows()
            .slice(0, limit)
            .map((window, index) => this._windowResult(
                window, this._tracker.get_window_app(window), 0.7 - index * 0.01, [], index));
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

    _windowResult(window, app, score, positions, mruIndex) {
        const activeWorkspace = global.workspace_manager.get_active_workspace();
        const onActiveWorkspace = window.is_on_all_workspaces() ||
            window.get_workspace() === activeWorkspace;

        return this.createResult({
            // get_stable_sequence() is Mutter's monotonic per-window
            // creation id: unique, and stable for the window's whole
            // lifetime, unlike the title (which changes as the user
            // works) or the index in this list.
            id: `w${window.get_stable_sequence()}`,
            title: this._displayTitle(window, app),
            subtitle: this._describe(window, app),
            gicon: app?.get_icon() ?? null,
            score,
            positions,
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
