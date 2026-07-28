// SPDX-License-Identifier: GPL-2.0-or-later

import {matchFields} from './fuzzyMatcher.js';
import {createResult} from './searchResult.js';

/**
 * Base class and interface contract for every launcher provider.
 *
 * The whole point of this file is that adding a provider later is a new
 * subclass and one line in launcher.js -- nothing in the controller, the
 * UI, or the ranking has to learn about it. Subclasses override at most
 * five things:
 *
 *   get enabled()          whether the user's settings want this provider
 *   warmUp()               optional: build caches off the critical path
 *   query(parsed)          the search itself; returns results or a Promise
 *   defaultResults()       what to show for an empty query (optional)
 *   enable() / disable()   signals and other resources (optional)
 *
 * Rules a provider must follow, all of them load-bearing:
 *
 *  - It never creates or touches an St actor. Results are plain data;
 *    the UI decides how to draw them.
 *  - `query()` is called on every keystroke and must be cheap. Anything
 *    expensive (enumerating .desktop files, spawning a process) belongs
 *    in `warmUp()` or behind a cache invalidated by a signal.
 *  - It returns results already scored 0..1 by relevance to the query --
 *    `match()` below is the shared implementation, so scores are
 *    comparable across providers.
 *  - Everything it allocates or connects in `enable()` is released in
 *    `disable()`; the launcher subsystem must leave no trace when the
 *    extension is disabled.
 */
export class SearchProvider {
    /**
     * @param {string} id one of constants.ProviderId
     * @param {object} context shared services (settings, history,
     *   favorites, icons and the Tessera managers) -- see launcher.js,
     *   which is the only place that assembles it
     */
    constructor(id, context) {
        this.id = id;
        this.context = context;
    }

    /** Settings-driven master switch, consulted before every query. */
    get enabled() {
        return true;
    }

    /** Optional: called once off the critical path to prime caches. */
    warmUp() {
    }

    /** Optional: connect signals here, not in the constructor. */
    enable() {
    }

    /** Optional: must undo everything enable() did. */
    disable() {
    }

    /**
     * @param {object} _parsed see searchController.parseQuery()
     * @returns {Array<object>|Promise<Array<object>>} scored results
     */
    query(_parsed) {
        return [];
    }

    /**
     * Results for an empty query (the launcher's resting state). Default
     * is nothing -- only providers with a meaningful "before you type"
     * view (recent, favorites-bearing) override this.
     *
     * @returns {Array<object>}
     */
    defaultResults() {
        return [];
    }

    /**
     * Everything this provider has, unfiltered -- what the user sees
     * after picking its filter and before typing anything.
     *
     * Distinct from defaultResults(), which is this provider's
     * contribution to the launcher's RESTING view and is deliberately a
     * curated handful. "Show me the applications" means all of them;
     * "show me the launcher's home screen" does not. Providers whose
     * answers only exist in response to a query (calculator, commands)
     * inherit the default and offer nothing to browse.
     *
     * Ordering matters here in a way it does not for a search: there is
     * no match quality to rank by, so give every entry the same score
     * and return them in the order they should read (alphabetical, or
     * most-recent-first). Equal scores keep that order through the
     * controller's stable sort, while frecency still floats the things
     * you actually use to the top.
     *
     * @returns {Array<object>}
     */
    browseResults() {
        return this.defaultResults();
    }

    /**
     * How many results browseResults() would return.
     *
     * Separate from it because the scope bar needs the NUMBER for every
     * section on every resting keystroke, while only one section's
     * results are ever drawn -- building three hundred application
     * records to print "312" would be absurd. Providers that already
     * know their size answer in O(1); the default pays for the list.
     *
     * @returns {number}
     */
    browseCount() {
        return this.browseResults().length;
    }

    /**
     * Resolves one of this provider's own ids (the part of a favorites
     * key after "providerId:") back into a live result. Only providers
     * whose entries can be pinned need to implement it; the default is
     * "I cannot resolve that", which simply drops a stale pin.
     *
     * @param {string} _id
     * @returns {object|null}
     */
    resultForKey(_id) {
        return null;
    }

    /**
     * Shared scoring helper. Providers pass the searchable text of one
     * candidate; this returns the fuzzy score plus the highlight
     * positions to attach to the result, or null when the candidate does
     * not match at all.
     *
     * @param {object} parsed the parsed query
     * @param {Array<{key: string, text: string, weight: number}>} fields
     * @returns {{score: number, positions: number[]}|null}
     */
    match(parsed, fields) {
        return matchFields(parsed.terms, fields, {allowTypos: parsed.allowTypos});
    }

    /**
     * createResult() with this provider's id filled in -- so a provider
     * can never accidentally emit results attributed to another one.
     *
     * @param {object} fields see searchResult.createResult()
     * @returns {object|null}
     */
    createResult(fields) {
        return createResult({providerId: this.id, ...fields});
    }
}
