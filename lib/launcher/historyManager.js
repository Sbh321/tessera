// SPDX-License-Identifier: GPL-2.0-or-later

import {FRECENCY_HALF_LIFE_MS, MAX_HISTORY_ENTRIES} from './constants.js';
import {decayFactor} from './utils.js';

// One GSettings string holding compact JSON, rather than one key per
// statistic or a strv of encoded records: the shape is an implementation
// detail of the ranking, it changes as the ranking is tuned, and nothing
// outside this file ever reads it. A malformed value (hand-edited dconf,
// a downgrade) degrades to "no history yet" instead of breaking search.
const HISTORY_KEY = 'launcher-history';

/**
 * Remembers what the user launches, so the launcher gets better at
 * guessing. Feeds exactly one number into ranking -- `frecency()`, in
 * 0..1 -- which searchController scales by FRECENCY_MAX_BOOST.
 *
 * "Frecency" combines both halves of what makes a result likely: how
 * OFTEN it has been launched (count) and how RECENTLY (exponential decay
 * with a two-week half-life). Frequency alone entrenches whatever was
 * popular months ago; recency alone forgets the tools used every day but
 * not today.
 */
export class HistoryManager {
    constructor(gsettings) {
        this._gsettings = gsettings;
        /** @type {Map<string, {count: number, last: number}>} */
        this._entries = new Map();
        this._loaded = false;
    }

    /** Parses the stored history; called lazily on first use. */
    _ensureLoaded() {
        if (this._loaded)
            return;
        this._loaded = true;

        try {
            const stored = JSON.parse(this._gsettings.get_string(HISTORY_KEY) || '{}');
            for (const [key, value] of Object.entries(stored)) {
                if (Array.isArray(value) && Number.isFinite(value[0]) && Number.isFinite(value[1]))
                    this._entries.set(key, {count: value[0], last: value[1]});
            }
        } catch (error) {
            console.warn(`tessera: launcher history unreadable, starting fresh (${error})`);
            this._entries.clear();
        }
    }

    /**
     * Records one activation of `key` (a searchResult.resultKey).
     *
     * @param {string} key
     */
    record(key) {
        this._ensureLoaded();

        const entry = this._entries.get(key) ?? {count: 0, last: 0};
        entry.count += 1;
        entry.last = Date.now();
        this._entries.set(key, entry);

        this._prune();
        this._save();
    }

    /**
     * @param {string} key
     * @param {number} [now] injectable for deterministic tests
     * @returns {number} 0..1 adaptive-ranking weight
     */
    frecency(key, now = Date.now()) {
        this._ensureLoaded();

        const entry = this._entries.get(key);
        if (!entry)
            return 0;

        const value = entry.count * decayFactor(entry.last, now, FRECENCY_HALF_LIFE_MS);
        // Saturating rather than linear: the difference between one and
        // five launches should matter much more than between 50 and 55,
        // and the boost must stay bounded so it can never outweigh a
        // genuinely better text match.
        return value / (value + 2);
    }

    /**
     * The best-known keys, strongest first -- the "recent applications"
     * view's data source.
     *
     * @param {number} limit
     * @param {string} [providerPrefix] restrict to one provider's keys
     * @returns {string[]}
     */
    topKeys(limit, providerPrefix = null) {
        this._ensureLoaded();

        const now = Date.now();
        const keys = [...this._entries.keys()]
            .filter(key => !providerPrefix || key.startsWith(`${providerPrefix}:`));

        return keys
            .sort((a, b) => this.frecency(b, now) - this.frecency(a, now))
            .slice(0, limit);
    }

    /** Forgets everything; exposed through Preferences. */
    clear() {
        this._entries.clear();
        this._loaded = true;
        this._save();
    }

    // Keeps the stored blob bounded. Pruning by frecency rather than by
    // age keeps the daily drivers and drops the one-offs.
    _prune() {
        if (this._entries.size <= MAX_HISTORY_ENTRIES)
            return;

        const now = Date.now();
        const survivors = [...this._entries.keys()]
            .sort((a, b) => this.frecency(b, now) - this.frecency(a, now))
            .slice(0, MAX_HISTORY_ENTRIES);

        const kept = new Map();
        for (const key of survivors)
            kept.set(key, this._entries.get(key));
        this._entries = kept;
    }

    _save() {
        const plain = {};
        for (const [key, {count, last}] of this._entries)
            plain[key] = [count, last];
        this._gsettings.set_string(HISTORY_KEY, JSON.stringify(plain));
    }
}
