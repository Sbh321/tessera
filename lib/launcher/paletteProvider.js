// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    FILTERABLE_SECTIONS, PALETTE_COMMANDS_SECTION, PALETTE_FILTERS_SECTION,
    PALETTE_PREFIX, ProviderId,
} from './constants.js';
import {matchText} from './fuzzyMatcher.js';
import {sectionIconName} from './iconProvider.js';
import {SearchProvider} from './searchProvider.js';
import {normalizeText} from './utils.js';

/**
 * The bare host of a URL template, for showing where a command will
 * send you ("chatgpt.com"). Deliberately a small regex rather than a
 * URI parse: the value is a user-editable template that may contain
 * "%s" in places a strict parser would reject.
 *
 * @param {string} template
 * @returns {string} the host, or '' if it does not look like a URL
 */
function hostOf(template) {
    return /^https?:\/\/([^/?#]+)/i.exec(template)?.[1] ?? '';
}

/**
 * The slash palette: type "/" and get a menu of what the launcher can be
 * pointed at, instead of having to remember a sigil for each one.
 *
 * It is a provider like any other -- it answers a prefix exactly as
 * commandProvider answers ">" -- which is what keeps the palette out of
 * the controller, the UI and the ranking entirely. Its entries are
 * ordinary SearchResults in two sections, so they are drawn, selected,
 * quick-picked with Alt+N and activated by the same code as everything
 * else.
 *
 * Two kinds of entry, and the difference is what happens on Enter:
 *
 *  - a FILTER sets the scope chip and hands the entry back to you empty,
 *    so the next thing you type searches only that section;
 *  - a COMMAND takes an argument. Selecting it with no argument yet
 *    *completes it into the entry* ("/search ") and waits, the way a
 *    chat client's slash commands do; once an argument is typed, Enter
 *    runs it.
 *
 * Both leave the launcher open (`keepOpen`), because closing would undo
 * the thing the user just asked for.
 *
 * Adding a command later is one entry in _commandEntries().
 */
export class PaletteProvider extends SearchProvider {
    constructor(context) {
        super(ProviderId.PALETTE, context);
    }

    query(parsed) {
        if (!parsed.palette)
            return [];

        // The palette parses its own body rather than using parsed.terms:
        // only the FIRST word names the command, everything after it is
        // that command's argument. Matching "/search cats" against the
        // whole term list would look for an entry called "search cats".
        const [name = '', ...rest] = parsed.paletteBody.split(/\s+/);
        const term = normalizeText(name);
        const argument = rest.join(' ').trim();

        const results = [];

        // With an argument present the user is mid-command, so filters --
        // which take none -- stop being plausible answers.
        if (!argument) {
            for (const entry of this._filterEntries()) {
                const match = this._matchEntry(term, entry);
                if (match)
                    results.push(this._filterResult(entry, match));
            }
        }

        for (const entry of this._commandEntries()) {
            const match = this._matchEntry(term, entry);
            if (match)
                results.push(this._commandResult(entry, match, argument));
        }

        return results;
    }

    /**
     * A bare "/" lists everything in its fixed order; anything after it
     * narrows by title and keywords through the same matcher the rest of
     * the launcher uses. Typos are off here on purpose -- this is a short
     * closed menu, not a search over hundreds of apps, so a near miss
     * should show nothing rather than something surprising.
     *
     * The score comes from whichever field matched best, but the
     * highlight positions always come from the title, which is the only
     * thing drawn.
     */
    _matchEntry(term, entry) {
        if (term.length === 0)
            return {score: entry.score, positions: []};

        const titleMatch = matchText(term, entry.title, {allowTypos: false});
        let best = titleMatch;

        for (const keyword of entry.keywords) {
            const match = matchText(term, keyword, {allowTypos: false});
            if (match && (!best || match.score > best.score))
                best = match;
        }

        if (!best)
            return null;

        return {score: best.score, positions: titleMatch?.positions ?? []};
    }

    // --- Entries ----------------------------------------------------------

    /**
     * One filter per searchable section, listed in a fixed order rather
     * than a ranked one: this is a menu, and a menu whose items move
     * around as you type is a menu you cannot learn.
     */
    _filterEntries() {
        const titles = this._filterTitles();

        const entries = FILTERABLE_SECTIONS.map((sectionId, index) => ({
            id: sectionId,
            title: titles[sectionId] ?? sectionId,
            keywords: [sectionId],
            iconName: sectionIconName(sectionId),
            // Descending with list position so the fixed order survives
            // the controller's score sort.
            score: 0.9 - index * 0.01,
        }));

        // "All" clears the filter; offered last because it is only useful
        // once one is set, and first-in-the-list is prime real estate.
        entries.push({
            id: null,
            title: _('All results'),
            keywords: ['all', 'everything', 'clear', 'reset'],
            iconName: 'view-list-symbolic',
            score: 0.9 - entries.length * 0.01,
        });

        return entries;
    }

    _filterTitles() {
        return {
            [ProviderId.WINDOWS]: _('Open Windows'),
            [ProviderId.APPS]: _('Applications'),
            [ProviderId.ACTIONS]: _('Actions'),
            [ProviderId.SETTINGS]: _('System Settings'),
            [ProviderId.EXTENSIONS]: _('Extensions'),
            [ProviderId.RECENT]: _('Recent'),
            [ProviderId.CLIPBOARD]: _('Clipboard'),
        };
    }

    /** Argument-taking commands. Add new ones here. */
    _commandEntries() {
        const searchUrl = this.context.settings.launcherSearchUrl;
        const chatUrl = this.context.settings.launcherChatUrl;

        return [
            {
                id: 'search',
                title: _('Search the web'),
                keywords: ['search', 'web', 'google', 'browser', 'internet'],
                iconName: 'web-browser-symbolic',
                score: 0.95,
                argumentHint: _('Type what to search for'),
                // Naming the destination is what stops "which engine is
                // this configured to?" from being a trip to Preferences.
                detail: hostOf(searchUrl),
                describe: argument => _('Search the web for “%s”').format(argument),
                run: argument => this._openTemplate(searchUrl, argument),
            },
            {
                id: 'chat',
                title: _('Ask an AI chat'),
                keywords: [
                    'chat', 'ai', 'ask', 'gpt', 'chatgpt', 'claude', 'gemini',
                    'grok', 'deepseek', 'llm', 'assistant',
                ],
                iconName: 'chat-message-new-symbolic',
                score: 0.94,
                argumentHint: _('Type what to ask'),
                detail: hostOf(chatUrl),
                describe: argument => _('Ask “%s”').format(argument),
                run: argument => this._openTemplate(chatUrl, argument),
            },
        ];
    }

    // --- Results ----------------------------------------------------------

    _filterResult(entry, match) {
        return this.createResult({
            id: `filter:${entry.id ?? 'all'}`,
            section: PALETTE_FILTERS_SECTION,
            title: entry.title,
            subtitle: entry.id === null
                ? _('Clear the filter')
                : _('Show only these'),
            iconName: entry.iconName,
            score: match.score,
            positions: match.positions,
            // Selecting a filter is navigation inside the launcher, not a
            // launch: it must not be recorded in ranking history, and the
            // launcher must stay open for the search it enables.
            metadata: {ephemeral: true},
            keepOpen: true,
            activate: () => {
                this.context.setScope(entry.id);
                this.context.setQuery('');
            },
        });
    }

    _commandResult(entry, match, argument) {
        const hasArgument = argument.length > 0;

        return this.createResult({
            id: `command:${entry.id}`,
            section: PALETTE_COMMANDS_SECTION,
            title: hasArgument ? entry.describe(argument) : entry.title,
            subtitle: hasArgument ? entry.detail : entry.argumentHint,
            iconName: entry.iconName,
            score: match.score,
            positions: hasArgument ? [] : match.positions,
            metadata: {ephemeral: true},
            // Without an argument this only fills the command in and
            // waits, so the launcher stays open; with one it runs and
            // gets out of the way like any other result.
            keepOpen: !hasArgument,
            activate: () => {
                if (hasArgument)
                    entry.run(argument);
                else
                    this.context.setQuery(`${PALETTE_PREFIX}${entry.id} `);
            },
        });
    }

    // --- Commands ---------------------------------------------------------

    /**
     * Opens a URL template with the query substituted in, through the
     * default browser.
     *
     * Every web command is a template rather than special-cased code,
     * which is what keeps a moving target maintainable: search engines
     * and AI chats all take the prompt as a query parameter, they all
     * change it occasionally, and a template means that is a one-line
     * settings edit rather than a code change. It is also what makes
     * "custom" free -- the presets in Preferences only fill this field
     * in.
     *
     * `launch_default_for_uri` is the same call GNOME's own run dialog
     * uses to open a path, so "the default browser" means exactly what
     * it means everywhere else on the desktop -- there is no browser
     * list to keep up to date here either.
     */
    _openTemplate(template, query) {
        const uri = template.includes('%s')
            ? template.replace('%s', encodeURIComponent(query))
            : `${template}${encodeURIComponent(query)}`;

        try {
            Gio.AppInfo.launch_default_for_uri(
                uri, global.create_app_launch_context(0, -1));
        } catch (error) {
            Main.notify(_('Tessera'), _('Could not open the web browser.'));
        }
    }
}
