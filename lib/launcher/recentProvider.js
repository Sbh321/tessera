// SPDX-License-Identifier: GPL-2.0-or-later

import Shell from 'gi://Shell';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ProviderId} from './constants.js';
import {ActivationMode} from './searchResult.js';
import {SearchProvider} from './searchProvider.js';

const RECENT_LIMIT = 6;

/**
 * The launcher's resting state: the applications you actually use.
 *
 * This provider answers ONLY the empty query. During a search, recency
 * and frequency still matter -- but as a ranking boost applied by
 * searchController to the app provider's own results, not as a second
 * copy of the same apps in a second section. Keeping "recent" to the
 * default view is what stops every search from listing Firefox twice.
 *
 * Two sources are merged, in this order:
 *
 *  1. Tessera's own launch history, which knows what was launched
 *     *through the launcher* and weights recency against frequency.
 *  2. GNOME's `Shell.AppUsage`, the shell-wide usage database behind the
 *     overview's app ranking. It makes the list useful from the very
 *     first launch, before this extension has learned anything.
 */
export class RecentProvider extends SearchProvider {
    constructor(context) {
        super(ProviderId.RECENT, context);
        this._appSystem = Shell.AppSystem.get_default();
    }

    get enabled() {
        return this.context.settings.launcherEnableRecent;
    }

    defaultResults() {
        const results = [];
        const seen = new Set();

        for (const app of this._recentApps()) {
            const id = app.get_id();
            if (seen.has(id))
                continue;
            seen.add(id);

            // Anything pinned is already shown, above, in its own
            // section; repeating it here would waste the resting view's
            // most valuable rows.
            if (this.context.favorites.isPinned(`${ProviderId.APPS}:${id}`))
                continue;

            results.push(this.createResult({
                id,
                title: app.get_name(),
                subtitle: app.get_description() ?? '',
                gicon: app.get_icon(),
                // Below favorites (which score from 1.0 down) and above
                // the open-windows list, so the resting view reads
                // favorites -> recent -> windows.
                score: 0.9 - results.length * 0.01,
                alternateLabel: _('New window'),
                activate: mode => {
                    if (mode === ActivationMode.ALTERNATE)
                        app.open_new_window(-1);
                    else
                        app.activate();
                },
            }));

            if (results.length >= RECENT_LIMIT)
                break;
        }

        return results;
    }

    _recentApps() {
        const apps = [];

        for (const key of this.context.history.topKeys(RECENT_LIMIT * 2, ProviderId.APPS)) {
            const app = this._appSystem.lookup_app(key.slice(ProviderId.APPS.length + 1));
            if (app)
                apps.push(app);
        }

        // Shell.AppUsage returns Shell.App objects already sorted by the
        // shell's own usage score. Guarded because it is the one API here
        // whose signature has changed across GNOME versions: on a shell
        // where it no longer matches, the list simply falls back to
        // Tessera's own history instead of throwing mid-search.
        try {
            for (const app of Shell.AppUsage.get_default().get_most_used())
                apps.push(app);
        } catch (error) {
            // Nothing to add; our own history above still stands.
        }

        return apps;
    }
}
