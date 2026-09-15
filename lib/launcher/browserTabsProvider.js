// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {tabIdentityId} from './browserProtocol.js';
import {ProviderId} from './constants.js';
import {SearchProvider} from './searchProvider.js';
import {collapseWhitespace, normalizeText} from './utils.js';

// The site leads: "github" is how a tab is remembered, and the host is
// the one thing about it that does not change from page to page. The
// title is still searched, one notch down.
const HOST_WEIGHT = 1.0;
const TITLE_WEIGHT = 0.85;

// A match found only in the URL's path or query never outranks a title
// match: paths are long and full of incidental words.
const URL_ONLY_SCORE = 0.5;

// Only when neither the favicon nor the browser's own icon is known.
const TAB_ICON = 'web-browser-symbolic';

/**
 * Browser tabs as search results.
 *
 * Two roles, deliberately different:
 *
 *  - With a QUERY, every tab of every connected browser is searched
 *    directly, by title, host and URL, as its own flat "Browser Tabs"
 *    section. Whether its window is expanded, or what that window's title
 *    currently is, plays no part -- the tab you want is usually not the
 *    one its window is showing.
 *  - With NO query it contributes nothing of its own: at rest, tabs are
 *    shown as the expandable children of their windows in Open Windows,
 *    which is where windowProvider.js asks this provider to build them
 *    (childResults). Filtering to the Browser Tabs section browses the
 *    complete flat list instead.
 *
 * Results carry only the tab's IDENTITY. Title, URL, index and window
 * are display data; activation resolves the identity again through the
 * service, so a row built before a tab moved, was reordered or closed
 * either reaches that same tab or does nothing.
 */
export class BrowserTabsProvider extends SearchProvider {
    /**
     * @param {object} context
     * @param {import('./browserTabService.js').BrowserTabService} service
     */
    constructor(context, service) {
        super(ProviderId.BROWSER_TABS, context);
        this._service = service;
    }

    get enabled() {
        return this.context.settings.launcherEnableTabs;
    }

    query(parsed) {
        const results = [];
        for (const tab of this._service.listTabs()) {
            const title = this._title(tab);
            const host = hostOf(tab.url);
            // The host is the START of the subtitle (see _subtitle), which
            // is what lets its matches be highlighted there.
            const match = this.match(parsed, [
                {key: 'host', text: host, weight: HOST_WEIGHT, primary: true, highlight: 'subtitle'},
                {key: 'title', text: title, weight: TITLE_WEIGHT, primary: false},
            ]);
            if (match) {
                results.push(this.tabResult(tab, {
                    score: match.score, positions: match.positions,
                    subtitlePositions: match.subtitlePositions,
                }));
                continue;
            }
            if (urlContainsEveryTerm(tab.url, parsed.terms))
                results.push(this.tabResult(tab, {score: URL_ONLY_SCORE, positions: []}));
        }
        return results;
    }

    browseResults() {
        return this._service.listTabs()
            .map((tab, index) => this.tabResult(tab, {score: 0.7 - index * 0.0001, positions: []}));
    }

    browseCount() {
        return this._service.tabCount;
    }

    /**
     * The child rows of one browser window in the resting view: its tabs
     * in tab-strip order, subtitled by host only since the parent row
     * already names the browser.
     *
     * @param {{tabs: function(): object[]}} windowInfo from
     *   BrowserTabService.describeWindows()
     * @returns {object[]}
     */
    childResults(windowInfo) {
        return windowInfo.tabs()
            .map(tab => this.tabResult(tab, {score: 0, positions: [], child: true}))
            .filter(Boolean);
    }

    /**
     * @param {object} tab a store tab view
     * @param {{score: number, positions: number[], child?: boolean}} options
     * @returns {?object}
     */
    tabResult(tab, {score, positions, subtitlePositions = [], child = false}) {
        const identity = Object.freeze({
            browserType: tab.browserType,
            profileId: tab.profileId,
            sessionId: tab.sessionId,
            tabId: tab.tabId,
        });

        // The favicon, marked in one corner with the browser it belongs
        // to; a tab without a favicon shows the browser's icon alone.
        const favicon = this._service.iconFor(tab);
        const browserIcon = this._service.browserIconFor(tab);

        return this.createResult({
            id: tabIdentityId(identity),
            title: this._title(tab),
            subtitle: child ? this._childSubtitle(tab) : this._subtitle(tab),
            gicon: favicon ?? browserIcon,
            badgeGicon: favicon ? browserIcon : null,
            iconName: TAB_ICON,
            score,
            positions,
            subtitlePositions,
            // Never enters the ranking history: the key embeds a session
            // token that changes on every browser restart, so recording
            // it would only accumulate dead entries -- and page titles
            // are not something to write into a settings database.
            metadata: {ephemeral: true, browserTabIdentity: identity},
            activateLabel: _('Switch to Tab'),
            activate: () => {
                void this._service.activate(identity);
            },
        });
    }

    _title(tab) {
        return collapseWhitespace(tab.title) || _('Untitled tab');
    }

    _subtitle(tab) {
        const parts = [hostOf(tab.url) || tab.url, tab.browserName];
        if (tab.incognito)
            parts.push(_('Private'));
        return parts.filter(Boolean).join(' · ');
    }

    _childSubtitle(tab) {
        const parts = [hostOf(tab.url) || tab.url];
        if (tab.pinned)
            parts.push(_('Pinned'));
        if (tab.audible)
            parts.push(_('Playing audio'));
        return parts.filter(Boolean).join(' · ');
    }
}

/** The host of a URL, or '' for internal pages (about:blank, chrome://…). */
function hostOf(url) {
    if (!url)
        return '';
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() ?? '';
    } catch (_error) {
        return '';
    }
}

/**
 * The URL fallback: every term, three characters or longer, must appear
 * verbatim somewhere in the URL. Plain substring rather than the fuzzy
 * matcher on purpose -- subsequence matching against a hundred long
 * URLs would make short queries match nearly every tab.
 */
function urlContainsEveryTerm(url, terms) {
    // A one- or two-letter term is in every URL there is.
    if (!url || terms.length === 0 || terms.some(term => term.length < 3))
        return false;
    const folded = normalizeText(url);
    return terms.every(term => folded.includes(term));
}
