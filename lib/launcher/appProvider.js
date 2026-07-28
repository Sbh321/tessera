// SPDX-License-Identifier: GPL-2.0-or-later

import Shell from 'gi://Shell';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

import {FOCUSED_APP_BOOST, ProviderId} from './constants.js';
import {ActivationMode} from './searchResult.js';
import {SearchProvider} from './searchProvider.js';

// Field weights. The visible name is what people type; keywords and the
// description are worth searching but must not let a description match
// outrank a name match on some other app.
const NAME_WEIGHT = 1.0;
const KEYWORD_WEIGHT = 0.72;
const DESCRIPTION_WEIGHT = 0.5;

// A .desktop action ("New Private Window") is a way INTO an app, so it
// must never outrank the app itself for the same query.
const ACTION_SCORE_FACTOR = 0.88;

/**
 * Installed applications -- the launcher's primary provider.
 *
 * The candidate list is cached and rebuilt only when GNOME says the set
 * of installed apps changed ('installed-changed'), because enumerating
 * and unpacking every .desktop file costs milliseconds and would
 * otherwise be paid on every keystroke. Everything the matcher needs
 * (name, keywords, description, executable, .desktop actions) is
 * flattened into plain strings at cache-build time, so a query is nothing
 * but string matching over an array.
 *
 * Apps hidden from the user by GNOME itself are excluded exactly as
 * GNOME's own app grid excludes them: `should_show()` (NoDisplay /
 * OnlyShowIn) plus the parental-controls filter. The Settings panels that
 * `should_show()` hides are surfaced separately by settingsProvider.js.
 */
export class AppProvider extends SearchProvider {
    constructor(context) {
        super(ProviderId.APPS, context);

        this._entries = null;
        this._appSystem = Shell.AppSystem.get_default();
        this._parentalControls = ParentalControlsManager.getDefault();
        this._installedChangedId = null;
    }

    get enabled() {
        return this.context.settings.launcherEnableApps;
    }

    enable() {
        this._installedChangedId = this._appSystem.connect(
            'installed-changed', () => {
                this._entries = null;
            });
    }

    disable() {
        if (this._installedChangedId !== null) {
            this._appSystem.disconnect(this._installedChangedId);
            this._installedChangedId = null;
        }
        this._entries = null;
    }

    warmUp() {
        this._ensureEntries();
    }

    query(parsed) {
        const results = [];

        for (const entry of this._ensureEntries()) {
            const match = this.match(parsed, entry.fields);
            if (match)
                results.push(this._appResult(entry, match));

            for (const action of entry.actions) {
                const actionMatch = this.match(parsed, action.fields);
                if (actionMatch)
                    results.push(this._actionResult(entry, action, actionMatch));
            }
        }

        return results;
    }

    resultForKey(id) {
        const entry = this._ensureEntries().find(candidate => candidate.id === id);
        if (!entry)
            return null;
        return this._appResult(entry, {score: 1, positions: []});
    }

    _appResult(entry, match) {
        const app = entry.app;
        const isRunning = app.get_n_windows() > 0;

        return this.createResult({
            id: entry.id,
            title: app.get_name(),
            subtitle: entry.description,
            gicon: app.get_icon(),
            score: match.score,
            positions: match.positions,
            pinnable: true,
            // A running app is a likely switch target, so it edges ahead
            // of an identically-matching app that would have to launch.
            metadata: {contextBoost: isRunning ? FOCUSED_APP_BOOST : 0},
            alternateLabel: _('New window'),
            secondaryLabel: _('Open on a new workspace'),
            activate: mode => this._launch(app, mode),
        });
    }

    _actionResult(entry, action, match) {
        return this.createResult({
            id: `${entry.id}!${action.name}`,
            title: action.title,
            subtitle: entry.app.get_name(),
            gicon: entry.app.get_icon(),
            score: match.score * ACTION_SCORE_FACTOR,
            positions: match.positions,
            activate: () => entry.appInfo.launch_action(action.name, null),
        });
    }

    /**
     * Enter launches or focuses (GNOME's own `activate()` semantics),
     * Ctrl+Enter always opens a new window, and Shift+Enter opens one on
     * the trailing workspace -- the same "fresh workspace at the end of
     * the strip" the Super+0 keybinding and new-window placement already
     * mean elsewhere in Tessera, so the concept is the same everywhere.
     */
    _launch(app, mode) {
        if (mode === ActivationMode.ALTERNATE) {
            app.open_new_window(-1);
            return;
        }

        if (mode === ActivationMode.SECONDARY) {
            const workspaceManager = global.workspace_manager;
            const trailingIndex = workspaceManager.n_workspaces - 1;
            // Activate first, then open there: a window opened while a
            // switch is still settling is pinned to the ORIGIN workspace
            // by GNOME's own startup-sequence tracking (see
            // docs/GNOME_NOTES.md). A keyboard activate() commits
            // immediately, so this ordering is race-free.
            workspaceManager.get_workspace_by_index(trailingIndex)
                ?.activate(global.get_current_time());
            app.open_new_window(trailingIndex);
            return;
        }

        app.activate();
    }

    _ensureEntries() {
        if (this._entries)
            return this._entries;

        this._entries = [];

        for (const appInfo of this._appSystem.get_installed()) {
            let id;
            try {
                // GNOME's own app grid wraps this identically: a
                // .desktop file with a broken filename encoding throws
                // here rather than returning null.
                id = appInfo.get_id();
            } catch (error) {
                continue;
            }

            if (!id || !appInfo.should_show() || !this._parentalControls.shouldShowApp(appInfo))
                continue;

            const app = this._appSystem.lookup_app(id);
            if (!app)
                continue;

            this._entries.push(this._buildEntry(id, app, appInfo));
        }

        return this._entries;
    }

    _buildEntry(id, app, appInfo) {
        const name = app.get_name();
        const description = appInfo.get_description() ?? '';

        // One flattened keyword blob rather than a field per keyword:
        // word-prefix and acronym matching already work per word inside
        // it, and one matchText() call per app keeps a full pass over a
        // few hundred apps comfortably inside the frame budget.
        const keywords = [
            appInfo.get_generic_name?.() ?? '',
            ...(appInfo.get_keywords?.() ?? []),
            appInfo.get_executable?.() ?? '',
            id.replace(/\.desktop$/, ''),
        ].filter(Boolean).join(' ');

        const actions = (appInfo.list_actions?.() ?? []).map(actionName => ({
            name: actionName,
            title: appInfo.get_action_name(actionName),
            fields: [
                {key: 'title', text: appInfo.get_action_name(actionName), weight: NAME_WEIGHT},
                {key: 'app', text: name, weight: KEYWORD_WEIGHT},
            ],
        }));

        return {
            id,
            app,
            appInfo,
            description,
            actions,
            fields: [
                {key: 'title', text: name, weight: NAME_WEIGHT},
                {key: 'keywords', text: keywords, weight: KEYWORD_WEIGHT},
                {key: 'description', text: description, weight: DESCRIPTION_WEIGHT},
            ],
        };
    }
}
