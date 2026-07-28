// SPDX-License-Identifier: GPL-2.0-or-later

import Shell from 'gi://Shell';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ProviderId} from './constants.js';
import {SearchProvider} from './searchProvider.js';

// The category every GNOME Settings panel declares. Enumerating by this
// marker rather than hardcoding a list of panels means the set adapts to
// the machine: Ubuntu's extra "Ubuntu" panel, missing Wacom/Wwan panels
// on hardware that has none, and whatever a future release adds all come
// along for free -- and each panel arrives with its own translated name,
// description, icon and search keywords.
const SETTINGS_PANEL_CATEGORY = 'X-GNOME-Settings-Panel';

const NAME_WEIGHT = 1.0;
const KEYWORD_WEIGHT = 0.75;
const DESCRIPTION_WEIGHT = 0.5;

// Uniform score while browsing the filtered section; see
// SearchProvider.browseResults().
const BROWSE_SCORE = 0.5;

/**
 * Individual GNOME Settings panels ("Displays", "Bluetooth", "Sound"),
 * so the launcher lands on the right page instead of the front door.
 *
 * These are ordinary .desktop files marked NoDisplay, which is exactly
 * why appProvider.js cannot surface them: it filters on `should_show()`
 * as GNOME's own app grid does. This provider deliberately looks at the
 * hidden ones -- the two providers partition the same list rather than
 * competing over it, so a panel can never appear twice.
 */
export class SettingsProvider extends SearchProvider {
    constructor(context) {
        super(ProviderId.SETTINGS, context);
        this._entries = null;
        this._appSystem = Shell.AppSystem.get_default();
        this._installedChangedId = null;
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
                results.push(this._entryResult(entry, match.score, match.positions));
        }

        return results;
    }

    /** Every Settings panel, alphabetically. */
    browseResults() {
        return [...this._ensureEntries()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(entry => this._entryResult(entry, BROWSE_SCORE, []));
    }

    resultForKey(id) {
        const entry = this._ensureEntries().find(candidate => candidate.id === id);
        return entry ? this._entryResult(entry, 1, []) : null;
    }

    _entryResult(entry, score, positions) {
        return this.createResult({
            id: entry.id,
            title: entry.name,
            // Naming the host application is what makes a bare panel name
            // ("Displays") legible as a place to go rather than a thing
            // that already happened.
            subtitle: entry.description
                ? `${_('Settings')} · ${entry.description}`
                : _('Settings'),
            gicon: entry.appInfo.get_icon(),
            score,
            positions,
            pinnable: true,
            activate: () => entry.appInfo.launch([], global.create_app_launch_context(0, -1)),
        });
    }

    _ensureEntries() {
        if (this._entries)
            return this._entries;

        this._entries = [];

        for (const appInfo of this._appSystem.get_installed()) {
            let id;
            try {
                id = appInfo.get_id();
            } catch (error) {
                continue;
            }

            const categories = appInfo.get_categories?.() ?? '';
            if (!id || !categories.includes(SETTINGS_PANEL_CATEGORY))
                continue;

            const name = appInfo.get_name();
            const description = appInfo.get_description() ?? '';
            const keywords = (appInfo.get_keywords?.() ?? []).join(' ');

            this._entries.push({
                id,
                appInfo,
                name,
                description,
                fields: [
                    {key: 'title', text: name, weight: NAME_WEIGHT},
                    {key: 'keywords', text: keywords, weight: KEYWORD_WEIGHT},
                    {key: 'description', text: description, weight: DESCRIPTION_WEIGHT},
                ],
            });
        }

        return this._entries;
    }
}
