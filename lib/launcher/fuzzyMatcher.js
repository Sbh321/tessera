// SPDX-License-Identifier: GPL-2.0-or-later

import {normalizeText, wordStartIndexes, clamp} from './utils.js';

/**
 * The launcher's matcher: pure, allocation-light, and the single place
 * that decides how well a query describes a piece of text. Providers only
 * supply text; ranking (frecency, favorites, provider weight) happens
 * later in searchController.js, so this file answers exactly one
 * question -- "how well do these two strings match" -- and answers it the
 * same way for every provider.
 *
 * Every tier returns a score in 0..1 with the tiers deliberately
 * NON-overlapping, so a weaker kind of match can never outrank a stronger
 * one no matter how the bonuses land. That ordering is the reason
 * "term" finds Terminal (prefix) ahead of any app that merely contains
 * those letters scattered about (subsequence).
 */

/** @enum {string} Which rule produced a match -- exposed for tests/debug. */
export const MatchTier = {
    EXACT: 'exact',
    PREFIX: 'prefix',
    WORD_PREFIX: 'word-prefix',
    ACRONYM: 'acronym',
    SUBSTRING: 'substring',
    SUBSEQUENCE: 'subsequence',
    TYPO: 'typo',
};

// Score floors per tier. Each tier's bonuses are budgeted to stay below
// the next tier's floor (see the individual functions).
const SCORE = {
    [MatchTier.EXACT]: 1.0,
    [MatchTier.PREFIX]: 0.88,
    [MatchTier.WORD_PREFIX]: 0.78,
    [MatchTier.ACRONYM]: 0.72,
    [MatchTier.SUBSTRING]: 0.62,
    [MatchTier.SUBSEQUENCE]: 0.30,
    [MatchTier.TYPO]: 0.10,
};

// A typo has to be a near miss on a reasonably long query, otherwise
// three-letter queries match half the system.
const MIN_TYPO_QUERY_LENGTH = 4;
const LONG_QUERY_LENGTH = 8;

function range(start, length) {
    const out = new Array(length);
    for (let i = 0; i < length; i++)
        out[i] = start + i;
    return out;
}

/**
 * Query characters must appear as the initials of consecutive words:
 * "vsc" -> Visual Studio Code, "vs" -> the first two of them.
 */
function matchAcronym(query, folded, starts) {
    if (query.length < 2 || query.length > starts.length)
        return null;
    for (let i = 0; i < query.length; i++) {
        if (folded[starts[i]] !== query[i])
            return null;
    }
    return starts.slice(0, query.length);
}

/**
 * Left-to-right subsequence match, then a backward tightening pass.
 *
 * The forward pass only establishes feasibility and an end bound; the
 * backward pass re-derives each position as late as possible before its
 * successor, which pulls the matched characters into the tightest run
 * ending there. Without it, greedy-forward matching of "code" against
 * "Chromium Code Editor" scatters across the first word and scores as a
 * poor match despite an obvious tight one existing.
 */
function matchSubsequence(query, folded, startSet) {
    let cursor = 0;
    for (let i = 0; i < query.length; i++) {
        const found = folded.indexOf(query[i], cursor);
        if (found < 0)
            return null;
        cursor = found + 1;
    }

    const positions = new Array(query.length);
    let limit = cursor - 1;
    for (let i = query.length - 1; i >= 0; i--) {
        positions[i] = folded.lastIndexOf(query[i], limit);
        limit = positions[i] - 1;
    }

    let consecutive = 0;
    let boundaryHits = 0;
    for (let i = 0; i < positions.length; i++) {
        if (i > 0 && positions[i] === positions[i - 1] + 1)
            consecutive++;
        if (startSet.has(positions[i]))
            boundaryHits++;
    }

    const span = positions[positions.length - 1] - positions[0] + 1;
    const density = query.length / span;
    const leadingGap = positions[0] / folded.length;

    // Budget: base 0.30 + at most 0.31 of bonuses stays under the
    // SUBSTRING floor of 0.62, so a real substring always wins.
    const score = SCORE[MatchTier.SUBSEQUENCE] +
        clamp(consecutive * 0.04, 0, 0.12) +
        clamp(boundaryHits * 0.03, 0, 0.09) +
        density * 0.10 -
        leadingGap * 0.06;

    return {
        score: clamp(score, 0.05, 0.61),
        positions,
        tier: MatchTier.SUBSEQUENCE,
    };
}

/**
 * Damerau-Levenshtein distance, abandoned as soon as it provably exceeds
 * `maxDistance`. Bounded early-exit matters: this runs only for queries
 * that already failed every cheaper tier, but it still runs against every
 * candidate, so an unbounded O(n*m) fill would be the one slow path in
 * the pipeline.
 */
function boundedEditDistance(a, b, maxDistance) {
    if (Math.abs(a.length - b.length) > maxDistance)
        return maxDistance + 1;

    let previous = range(0, b.length + 1);
    let beforePrevious = null;

    for (let i = 1; i <= a.length; i++) {
        const current = new Array(b.length + 1);
        current[0] = i;
        let rowBest = current[0];

        for (let j = 1; j <= b.length; j++) {
            const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
            let best = Math.min(substitution, previous[j] + 1, current[j - 1] + 1);
            // Transposition ("teh" -> "the"), the single most common typo.
            if (beforePrevious && i > 1 && j > 1 &&
                a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                best = Math.min(best, beforePrevious[j - 2] + 1);
            current[j] = best;
            rowBest = Math.min(rowBest, best);
        }

        if (rowBest > maxDistance)
            return maxDistance + 1;

        beforePrevious = previous;
        previous = current;
    }

    return previous[b.length];
}

/**
 * Last-resort tier: the query is a near miss for the whole string or for
 * one of its words. Highlight positions cover the matched word rather
 * than individual characters -- with an edit distance involved there is
 * no exact character correspondence to highlight.
 */
function matchTypo(query, folded, starts) {
    if (query.length < MIN_TYPO_QUERY_LENGTH)
        return null;
    const maxDistance = query.length > LONG_QUERY_LENGTH ? 2 : 1;

    const candidates = [{start: 0, text: folded}];
    for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        const end = i + 1 < starts.length ? starts[i + 1] : folded.length;
        candidates.push({start, text: folded.slice(start, end).trim()});
    }

    let best = null;
    for (const candidate of candidates) {
        if (candidate.text.length === 0)
            continue;
        const distance = boundedEditDistance(query, candidate.text, maxDistance);
        if (distance > maxDistance)
            continue;
        const score = SCORE[MatchTier.TYPO] * (1 - distance / (query.length + 1));
        if (!best || score > best.score) {
            best = {
                score,
                positions: range(candidate.start, candidate.text.length),
                tier: MatchTier.TYPO,
            };
        }
    }
    return best;
}

/**
 * Scores a single already-normalized term against one piece of text.
 *
 * @param {string} term normalized (see utils.normalizeText), non-empty
 * @param {string} text the original text; folding happens here
 * @param {object} [options]
 * @param {boolean} [options.allowTypos] enable the edit-distance tier
 * @returns {{score: number, positions: number[], tier: string}|null}
 */
export function matchText(term, text, options = {}) {
    const {allowTypos = true} = options;
    if (!term || !text)
        return null;

    const folded = normalizeText(text);
    if (folded === term)
        return {score: SCORE[MatchTier.EXACT], positions: range(0, text.length), tier: MatchTier.EXACT};

    const coverage = term.length / folded.length;

    if (folded.startsWith(term)) {
        return {
            score: SCORE[MatchTier.PREFIX] + coverage * 0.09,
            positions: range(0, term.length),
            tier: MatchTier.PREFIX,
        };
    }

    const starts = wordStartIndexes(text);

    for (const start of starts) {
        if (folded.startsWith(term, start)) {
            return {
                score: SCORE[MatchTier.WORD_PREFIX] + coverage * 0.08 - (start / folded.length) * 0.04,
                positions: range(start, term.length),
                tier: MatchTier.WORD_PREFIX,
            };
        }
    }

    const acronym = matchAcronym(term, folded, starts);
    if (acronym)
        return {score: SCORE[MatchTier.ACRONYM] + coverage * 0.05, positions: acronym, tier: MatchTier.ACRONYM};

    const index = folded.indexOf(term);
    if (index >= 0) {
        return {
            score: SCORE[MatchTier.SUBSTRING] + coverage * 0.07 - (index / folded.length) * 0.06,
            positions: range(index, term.length),
            tier: MatchTier.SUBSTRING,
        };
    }

    const subsequence = matchSubsequence(term, folded, new Set(starts));
    if (subsequence)
        return subsequence;

    if (allowTypos)
        return matchTypo(term, folded, starts);

    return null;
}

/**
 * Scores a whole (possibly multi-term) query against a result's several
 * pieces of text.
 *
 * EVERY term must match SOME field -- that is what makes "vs code" narrow
 * rather than widen the result set. The combined score leans on the
 * average but keeps a quarter of its weight on the worst term, so one
 * strong term cannot carry a weak one ("firefox zzz" must not rank
 * Firefox highly).
 *
 * @param {string[]} terms normalized query terms, at least one
 * @param {Array<{key: string, text: string, weight: number}>} fields
 * @param {object} [options] forwarded to matchText
 * @returns {{score: number, positions: number[]}|null} positions are
 *   indexes into the field named 'title' only (the only field the UI
 *   highlights); empty when no term matched the title.
 */
export function matchFields(terms, fields, options = {}) {
    if (!terms || terms.length === 0)
        return null;

    let total = 0;
    let worst = 1;
    const titlePositions = new Set();

    for (const term of terms) {
        let bestScore = 0;
        for (const field of fields) {
            if (!field.text)
                continue;
            const match = matchText(term, field.text, options);
            if (!match)
                continue;
            const weighted = match.score * field.weight;
            if (weighted > bestScore)
                bestScore = weighted;
            if (field.key === 'title') {
                for (const position of match.positions)
                    titlePositions.add(position);
            }
        }

        if (bestScore === 0)
            return null;

        total += bestScore;
        worst = Math.min(worst, bestScore);
    }

    const average = total / terms.length;
    return {
        score: average * 0.75 + worst * 0.25,
        positions: [...titlePositions].sort((a, b) => a - b),
    };
}
