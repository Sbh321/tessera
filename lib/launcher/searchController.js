// SPDX-License-Identifier: GPL-2.0-or-later

import {
    COMMAND_PREFIXES, FAVORITES_SECTION, FRECENCY_MAX_BOOST, FAVORITE_BOOST,
    MAX_RESULTS_PER_SECTION, PALETTE_PREFIX, PRIORITY_SECTIONS,
    PROVIDER_WEIGHT, ProviderId, SECTION_ORDER,
} from './constants.js';
import {normalizeText} from './utils.js';
import {resultKey} from './searchResult.js';

/**
 * Turns raw entry text into the query object every provider receives.
 *
 * Parsing lives here rather than in each provider so that the meaning of
 * a prefix, of whitespace, and of "empty" is decided exactly once.
 *
 * @param {string} raw the entry's text, verbatim
 * @param {object} [options]
 * @param {boolean} [options.allowTypos] whether fuzzy typo matching is on
 * @returns {object} parsed query
 */
export function parseQuery(raw, options = {}) {
    const trimmed = raw.trim();
    const prefix = COMMAND_PREFIXES.find(candidate => trimmed.startsWith(candidate)) ?? null;
    // Everything after the prefix, with its own leading space eaten, so
    // "> ls -la" and ">ls -la" are the same command.
    const commandBody = prefix ? trimmed.slice(prefix.length).trim() : '';

    // The palette opens only on a LEADING slash: one typed later belongs
    // to the query (paths, dates, "and/or").
    const palette = !prefix && trimmed.startsWith(PALETTE_PREFIX);
    const paletteBody = palette ? trimmed.slice(PALETTE_PREFIX.length).trim() : '';

    let searchable = trimmed;
    if (prefix)
        searchable = commandBody;
    else if (palette)
        searchable = paletteBody;

    return {
        raw,
        trimmed,
        isEmpty: trimmed.length === 0,
        prefix,
        commandBody,
        palette,
        paletteBody,
        terms: searchable.length > 0
            ? normalizeText(searchable).split(/\s+/).filter(Boolean)
            : [],
        allowTypos: options.allowTypos ?? true,
    };
}

/**
 * Owns the providers and turns a query into ranked, grouped sections.
 *
 * The split that makes the rest of the subsystem simple: providers know
 * *what* matches, this controller knows *how much it matters* and *where
 * it goes*, and launcherUI knows how to draw it. Nothing else ranks, and
 * nothing else groups.
 *
 * Results are recomputed from scratch on every keystroke -- the same
 * "re-derive from ground truth, never trust cached state" posture the
 * tiling subsystem uses. At the scale involved (a few hundred apps, tens
 * of windows) a full pass costs well under a millisecond, and there is no
 * incremental-update state that can go stale.
 */
export class SearchController {
    /**
     * @param {object} context shared services; see launcher.js
     */
    constructor(context) {
        this._context = context;
        this._providers = [];
        this._providersById = new Map();
        // Bumped on every search so a late async provider result can be
        // recognised as stale and dropped instead of overwriting the list
        // the user is already looking at.
        this._generation = 0;
        this._lastParsed = parseQuery('');
        this._currentResults = [];
        // Which section the user has filtered to, or null for "all". A
        // display filter over the full result set rather than a narrower
        // search: every provider still runs, which is what keeps the
        // scope bar's counts honest about what is hiding behind the
        // filter you are currently in.
        this._scope = null;
        /** @type {?function(object): void} set by the popup. */
        this.onResults = null;
    }

    /** @returns {?string} the section the search is filtered to */
    get scope() {
        return this._scope;
    }

    /**
     * @param {?string} sectionId a section id, or null for everything
     */
    setScope(sectionId) {
        this._scope = sectionId;
    }

    /**
     * @param {Array<import('./searchProvider.js').SearchProvider>} providers
     *   in no particular order -- section order comes from the ranking,
     *   not from this list.
     */
    setProviders(providers) {
        this._providers = providers;
        this._providersById = new Map(providers.map(provider => [provider.id, provider]));
    }

    enable() {
        for (const provider of this._providers)
            provider.enable();
    }

    disable() {
        for (const provider of this._providers)
            provider.disable();
        this._providers = [];
        this._providersById.clear();
        this.onResults = null;
    }

    /** Primes provider caches; safe to call more than once. */
    warmUp() {
        for (const provider of this._providers) {
            if (provider.enabled)
                provider.warmUp();
        }
    }

    /**
     * Runs a search. Synchronous providers are ranked and returned
     * immediately (that is the common case and what keeps typing feel
     * instant); a provider that returns a Promise has its results merged
     * in through `onResults` when it settles, provided no newer query has
     * started meanwhile.
     *
     * @param {string} raw the entry text
     * @returns {{sections: Array<{id: string, results: Array<object>}>,
     *   counts: Map<string, number>}} the sections to draw (filtered by
     *   the current scope) and the UNFILTERED per-section totals the
     *   scope bar needs -- computing both from one pass is what makes
     *   the chips' counts free and always accurate.
     */
    search(raw) {
        const parsed = parseQuery(raw, {allowTypos: this._context.settings.launcherFuzzy});
        this._lastParsed = parsed;
        const generation = ++this._generation;

        const collected = [];
        const pending = [];

        if (parsed.isEmpty) {
            collected.push(...this._restingResults());
        } else {
            for (const provider of this._activeProviders()) {
                // A command prefix is an explicit instruction, not a
                // search: it addresses the command provider alone, so
                // "> rm" can never be interpreted as an app named rm.
                // The palette's slash works the same way.
                if (parsed.prefix && provider.id !== ProviderId.COMMANDS)
                    continue;
                if (parsed.palette && provider.id !== ProviderId.PALETTE)
                    continue;

                const produced = provider.query(parsed);
                if (produced instanceof Promise)
                    pending.push(produced);
                else
                    collected.push(...produced);
            }
        }

        this._currentResults = collected.filter(Boolean);

        for (const promise of pending) {
            promise.then(results => {
                if (generation !== this._generation || !this.onResults)
                    return;
                this._currentResults.push(...results.filter(Boolean));
                this.onResults(this._buildSections(this._currentResults, parsed));
            }).catch(error => {
                console.warn(`tessera: launcher provider failed: ${error}`);
            });
        }

        return this._buildSections(this._currentResults, parsed);
    }

    /**
     * Activates a result and records the launch for adaptive ranking.
     *
     * @param {object} result
     * @param {string} mode a searchResult.ActivationMode
     */
    activate(result, mode) {
        // `ephemeral` results opt out of ranking history entirely --
        // clipboard entries use it, because their key IS the copied text
        // and recording it would write clipboard contents into a second
        // settings key the user never asked for.
        if (this._context.settings.launcherRememberHistory && !result.metadata.ephemeral)
            this._context.history.record(resultKey(result));

        try {
            result.activate(mode);
        } catch (error) {
            console.warn(`tessera: launcher failed to activate "${result.title}": ${error}`);
        }
    }

    _activeProviders() {
        return this._providers.filter(provider => provider.enabled);
    }

    /**
     * What an empty query shows, which depends on whether a filter is
     * set.
     *
     * Unfiltered it is the launcher's resting view: pinned results, then
     * each provider's curated handful. Filtered, "empty" stops meaning
     * "show me the home screen" and starts meaning "show me everything
     * in here" -- picking Applications and being met with a blank list
     * until you type would make the filter feel broken, when browsing is
     * exactly what a filter is for.
     */
    _restingResults() {
        if (!this._scope) {
            const results = [...this._favoriteResults()];
            for (const provider of this._activeProviders())
                results.push(...provider.defaultResults());
            return results;
        }

        // Filterable sections are named after their provider, so the
        // scope resolves straight to the one being browsed.
        const provider = this._providersById.get(this._scope);
        return provider?.enabled ? provider.browseResults() : [];
    }

    /**
     * Resolves the user's pinned keys back into live results by asking
     * each owning provider. Pinned entries are shown as their own
     * section only in the resting (empty-query) state; while searching
     * they stay in their natural section and are merely boosted, so a
     * search never reshuffles familiar groupings.
     */
    _favoriteResults() {
        const results = [];
        const keys = this._context.favorites.keys;

        keys.forEach((key, index) => {
            const separator = key.indexOf(':');
            if (separator < 0)
                return;

            const provider = this._providersById.get(key.slice(0, separator));
            if (!provider?.enabled)
                return;

            const result = provider.resultForKey(key.slice(separator + 1));
            if (!result)
                return;

            result.section = FAVORITES_SECTION;
            // Descending by pin order, above every provider's default
            // results, so the favorites section sorts to the top and
            // keeps the user's chosen order within it.
            result.score = 1 - index * 0.001;
            results.push(result);
        });

        return results;
    }

    /**
     * Adaptive ranking: match quality, weighted by which provider found
     * it, plus small additive boosts for the things a launcher learns
     * about its user (what they pin, what they launch, what they are
     * looking at right now).
     */
    _rank(result, now) {
        const weight = PROVIDER_WEIGHT[result.providerId] ?? 0.9;
        let score = result.score * weight;

        const key = resultKey(result);
        if (this._context.favorites.isPinned(key))
            score += FAVORITE_BOOST;

        if (this._context.settings.launcherRememberHistory)
            score += FRECENCY_MAX_BOOST * this._context.history.frecency(key, now);

        // Providers declare their own context relevance (a window on the
        // current workspace, an app that is already running) because only
        // they know what "relevant right now" means for their domain.
        score += result.metadata.contextBoost ?? 0;

        return score;
    }

    _buildSections(results, parsed) {
        const now = Date.now();
        const seen = new Set();
        const ranked = [];

        for (const result of results) {
            const key = resultKey(result);
            if (seen.has(key))
                continue;
            seen.add(key);
            ranked.push({result, rank: this._rank(result, now)});
        }

        // Priority sections are filled first, so they also get first
        // claim on the total-results budget -- otherwise "windows lead"
        // would be a promise the cap could quietly break on a small
        // maximum-results setting. Within each group the order is still
        // pure rank, which keeps every section's own best result first.
        ranked.sort((a, b) => {
            const priority = this._sectionPriority(a.result.section) -
                this._sectionPriority(b.result.section);
            if (priority !== 0)
                return priority;
            return b.rank - a.rank;
        });

        // Counted BEFORE any capping or filtering, so a chip reports how
        // many results a section really has, not how many survived.
        const counts = new Map();
        for (const {result} of ranked)
            counts.set(result.section, (counts.get(result.section) ?? 0) + 1);

        // An explicit prefix overrides the scope: "/" and ">" are the
        // user asking for something specific right now, and hiding their
        // answers because a filter was set earlier would be obtuse.
        const scope = parsed.prefix || parsed.palette ? null : this._scope;

        const maxResults = this._context.settings.launcherMaxResults;
        // Filtered to one section, that section is all there is to show,
        // so it gets the whole budget rather than the eight rows it
        // would be rationed to while sharing.
        const perSectionCap = scope ? maxResults : MAX_RESULTS_PER_SECTION;
        const perSection = new Map();
        const sections = new Map();
        let total = 0;

        for (const {result, rank} of ranked) {
            if (total >= maxResults)
                break;

            const sectionId = result.section;
            if (scope && sectionId !== scope)
                continue;

            const used = perSection.get(sectionId) ?? 0;
            if (used >= perSectionCap)
                continue;

            if (!sections.has(sectionId))
                sections.set(sectionId, {id: sectionId, results: [], bestRank: rank});
            sections.get(sectionId).results.push(result);
            perSection.set(sectionId, used + 1);
            total++;
        }

        // Priority sections (open windows) lead unconditionally whenever
        // they have anything to show -- resting view and search alike.
        // Below them, sections lead with whichever holds the strongest
        // single result, so the best of the rest is still the next row.
        // Ties fall back to a fixed order so the layout never shuffles
        // between identical searches.
        const ordered = [...sections.values()].sort((a, b) => {
            const priority = this._sectionPriority(a.id) - this._sectionPriority(b.id);
            if (priority !== 0)
                return priority;
            if (b.bestRank !== a.bestRank)
                return b.bestRank - a.bestRank;
            return SECTION_ORDER.indexOf(a.id) - SECTION_ORDER.indexOf(b.id);
        });

        return {sections: ordered, counts};
    }

    /** Lower sorts earlier; everything unlisted shares the last rank. */
    _sectionPriority(sectionId) {
        const index = PRIORITY_SECTIONS.indexOf(sectionId);
        return index < 0 ? PRIORITY_SECTIONS.length : index;
    }

    /** The query the last search() ran with; used by the UI for hints. */
    get lastQuery() {
        return this._lastParsed;
    }
}
