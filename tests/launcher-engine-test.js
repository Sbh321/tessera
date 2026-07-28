// SPDX-License-Identifier: GPL-2.0-or-later
//
// Unit tests for the launcher's pure engine: the fuzzy matcher, the
// arithmetic evaluator, the string helpers, and the two ranking stores.
//
// None of those modules import a GNOME namespace, which is exactly why
// they can be tested at all -- everything that touches St/Meta/Shell is
// covered by tests/MANUAL_TESTS.md instead (see docs/DEVELOPMENT.md for
// why there is no automated UI harness).
//
// Run with either runtime:
//     gjs -m tests/launcher-engine-test.js
//     tests/run-tests.sh          (picks whichever is installed)

import {
    matchText, matchFields, MatchTier,
} from '../lib/launcher/fuzzyMatcher.js';
import {
    alternateForms, evaluate, formatValue,
} from '../lib/launcher/calculatorEngine.js';
import {
    collapseWhitespace, decayFactor, ellipsize, hexToRgba,
    markupWithHighlights, normalizeText, wordStartIndexes,
} from '../lib/launcher/utils.js';
import {HistoryManager} from '../lib/launcher/historyManager.js';
import {FavoritesManager} from '../lib/launcher/favoritesManager.js';
import {FRECENCY_HALF_LIFE_MS, MAX_HISTORY_ENTRIES} from '../lib/launcher/constants.js';

let failures = 0;
let checks = 0;

function check(condition, description) {
    checks++;
    if (condition)
        return;
    failures++;
    console.log(`  FAIL: ${description}`);
}

function equal(actual, expected, description) {
    check(actual === expected, `${description} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function near(actual, expected, description, tolerance = 1e-9) {
    check(Math.abs(actual - expected) < tolerance,
        `${description} (got ${actual}, expected ~${expected})`);
}

function section(name) {
    console.log(name);
}

/** A stand-in for Gio.Settings covering only what the stores use. */
function fakeSettings() {
    const strings = new Map();
    const strvs = new Map();
    return {
        get_string: key => strings.get(key) ?? '',
        set_string: (key, value) => strings.set(key, value),
        get_strv: key => [...(strvs.get(key) ?? [])],
        set_strv: (key, value) => strvs.set(key, [...value]),
    };
}

// --- Fuzzy matcher --------------------------------------------------------

section('fuzzy matcher: tiers');

equal(matchText('firefox', 'Firefox').tier, MatchTier.EXACT, 'exact match');
equal(matchText('firefox', 'Firefox').score, 1, 'exact match scores 1');
equal(matchText('fire', 'Firefox').tier, MatchTier.PREFIX, 'prefix match');
equal(matchText('code', 'Visual Studio Code').tier, MatchTier.WORD_PREFIX, 'word-prefix match');
equal(matchText('vsc', 'Visual Studio Code').tier, MatchTier.ACRONYM, 'full acronym');
equal(matchText('vs', 'Visual Studio Code').tier, MatchTier.ACRONYM, 'partial acronym');
equal(matchText('gimp', 'GNU Image Manipulation Program').tier, MatchTier.ACRONYM,
    'acronym across four words');
equal(matchText('udio', 'Visual Studio Code').tier, MatchTier.SUBSTRING, 'substring match');
equal(matchText('ff', 'Firefox').tier, MatchTier.SUBSEQUENCE, 'subsequence match');
// A DELETION ("firfox") is still a subsequence of the target, so it never
// reaches the typo tier -- the cheaper tier already handles it. The typo
// tier exists for the mistakes subsequence matching cannot absorb:
// transposed and substituted characters.
equal(matchText('firfox', 'Firefox').tier, MatchTier.SUBSEQUENCE,
    'a dropped character is caught by subsequence matching');
equal(matchText('fierfox', 'Firefox').tier, MatchTier.TYPO, 'transposed characters');
equal(matchText('zzzz', 'Firefox'), null, 'no match at all');

section('fuzzy matcher: tier ordering');

const tierScores = [
    matchText('firefox', 'Firefox').score,
    matchText('fire', 'Firefox').score,
    matchText('code', 'Visual Studio Code').score,
    matchText('vsc', 'Visual Studio Code').score,
    matchText('udio', 'Visual Studio Code').score,
    matchText('ff', 'Firefox').score,
    matchText('fierfox', 'Firefox').score,
];
for (let i = 1; i < tierScores.length; i++) {
    check(tierScores[i - 1] > tierScores[i],
        `tier ${i - 1} outranks tier ${i} (${tierScores[i - 1]} > ${tierScores[i]})`);
}

section('fuzzy matcher: options and positions');

equal(matchText('fierfox', 'Firefox', {allowTypos: false}), null,
    'typo tier is disabled by allowTypos:false');
check(matchText('ff', 'Firefox', {allowTypos: false}) !== null,
    'disabling typos does not disable subsequence matching');

const positions = matchText('code', 'Visual Studio Code').positions;
equal(JSON.stringify(positions), JSON.stringify([14, 15, 16, 17]),
    'positions point at the matched characters');
equal(matchText('cafe', 'Café').tier, MatchTier.EXACT, 'accents fold for matching');
equal(matchText('cafe', 'Café').positions.length, 4,
    'folding preserves one position per original character');

section('fuzzy matcher: multi-term queries');

const fields = [
    {key: 'title', text: 'Visual Studio Code', weight: 1},
    {key: 'keywords', text: 'editor ide programming', weight: 0.7},
];
check(matchFields(['vs', 'code'], fields) !== null, 'both terms match');
equal(matchFields(['vs', 'zzzz'], fields), null, 'every term must match');
check(matchFields(['code'], fields).score > matchFields(['ide'], fields).score,
    'a title match outranks a keyword match');
equal(matchFields([], fields), null, 'an empty term list matches nothing');

// --- Calculator -----------------------------------------------------------

section('calculator: arithmetic');

equal(evaluate('2+2').value, 4, '2+2');
equal(evaluate('4*18').value, 72, '4*18');
equal(evaluate('10/4').value, 2.5, '10/4');
equal(evaluate('2 + 3 * 4').value, 14, 'multiplication binds tighter than addition');
equal(evaluate('(2 + 3) * 4').value, 20, 'parentheses');
equal(evaluate('2^3^2').value, 512, 'exponentiation is right-associative');
equal(evaluate('-3 + 1').value, -2, 'unary minus');
equal(evaluate('7 mod 3').value, 1, 'mod');

section('calculator: functions and constants');

equal(evaluate('sqrt(144)').value, 12, 'sqrt');
near(evaluate('sin(90)').value, 1, 'sin works in degrees');
near(evaluate('cos(0)').value, 1, 'cos(0)');
near(evaluate('sinr(0)').value, 0, 'radian variant exists');
near(evaluate('pi').value, Math.PI, 'pi constant');
equal(evaluate('max(3, 9, 4)').value, 9, 'variadic function');
equal(evaluate('sqrt(4, 9)'), null, 'extra arguments to a unary function are rejected');
equal(evaluate('log10(1000)').value, 3, 'log10');

section('calculator: percentages');

near(evaluate('15%').value, 0.15, 'a bare percentage is a fraction');
equal(evaluate('200 + 15%').value, 230, 'addition takes the percentage OF the left side');
equal(evaluate('200 - 10%').value, 180, 'subtraction likewise');
equal(evaluate('200 * 15%').value, 30, 'multiplication uses the plain fraction');
equal(evaluate('15% of 200').value, 30, '"of" reads as multiplication');

section('calculator: number bases');

equal(evaluate('0xff + 1').value, 256, 'hex literal');
equal(evaluate('0b1010 * 2').value, 20, 'binary literal');
equal(evaluate('0o17 + 0').value, 15, 'octal literal');
equal(evaluate('0xff').isTrivial, false, 'a bare base literal is still worth answering');
equal(evaluate('5').isTrivial, true, 'a bare decimal number is not a question');

section('calculator: memory and rejection');

equal(evaluate('ans * 2', {ans: 21}).value, 42, 'ans refers to the previous answer');
equal(evaluate('ans * 2'), null, 'ans is unknown when nothing has been evaluated');
equal(evaluate('abc'), null, 'unknown names are rejected');
equal(evaluate('2 +'), null, 'incomplete expressions are rejected');
equal(evaluate(''), null, 'empty input is rejected');
equal(evaluate('firefox'), null, 'an ordinary search term is not an expression');

// The evaluator must never be a path to command execution: these are the
// shapes that would matter if it were ever backed by eval().
equal(evaluate('rm -rf /'), null, 'a command line is not an expression');
equal(evaluate('2+2; rm -rf /'), null, 'a statement separator is rejected outright');
equal(evaluate('`id`'), null, 'backticks are rejected');
equal(evaluate('$(id)'), null, 'command substitution is rejected');
equal(evaluate('globalThis'), null, 'JavaScript identifiers are not in scope');

section('calculator: formatting');

equal(formatValue(4), '4', 'integers format plainly');
equal(formatValue(0.1 + 0.2), '0.3', 'floating-point noise is trimmed');
equal(formatValue(2.5), '2.5', 'decimals survive');
check(alternateForms(255).includes('0xFF'), 'hex alternate form');
check(alternateForms(255).includes('0b11111111'), 'binary alternate form');
check(alternateForms(1234).includes('1,234'), 'thousands separators for large integers');
equal(alternateForms(2.5).length, 0, 'no alternate forms for non-integers');

// --- Utilities ------------------------------------------------------------

section('utils');

equal(normalizeText('Café').length, 4, 'folding preserves string length');
equal(normalizeText('Café'), 'cafe', 'folding lowercases and strips diacritics');
equal(normalizeText('ASCII Fast Path'), 'ascii fast path', 'ascii fast path folds too');
equal(JSON.stringify(wordStartIndexes('Visual Studio Code')), JSON.stringify([0, 7, 14]),
    'word starts after spaces');
equal(JSON.stringify(wordStartIndexes('gnome-control-center')),
    JSON.stringify([0, 6, 14]), 'word starts after hyphens');
check(wordStartIndexes('camelCase').includes(5), 'camelCase boundary is a word start');

equal(markupWithHighlights('a<b', []), 'a&lt;b', 'markup is escaped');
equal(markupWithHighlights('abc', [0, 1]), '<b>ab</b>c', 'contiguous highlights share one run');
equal(markupWithHighlights('abc', [0, 2]), '<b>a</b>b<b>c</b>', 'gaps split runs');

equal(hexToRgba('#3584e4', 0.5), 'rgba(53, 132, 228, 0.5)', 'hex to rgba');
equal(hexToRgba('#fff', 1), 'rgba(255, 255, 255, 1)', 'short hex expands');
equal(hexToRgba('not-a-color', 1), null, 'invalid colors return null');

equal(collapseWhitespace('  a\n\tb  '), 'a b', 'whitespace collapses');
equal(ellipsize('abcdef', 4), 'abc…', 'ellipsize');
equal(ellipsize('abc', 4), 'abc', 'short strings are untouched');

const now = 1_700_000_000_000;
near(decayFactor(now, now, FRECENCY_HALF_LIFE_MS), 1, 'no decay at zero age');
near(decayFactor(now - FRECENCY_HALF_LIFE_MS, now, FRECENCY_HALF_LIFE_MS), 0.5,
    'half the weight after one half-life');
equal(decayFactor(0, now, FRECENCY_HALF_LIFE_MS), 0, 'an unset timestamp decays to zero');

// --- History --------------------------------------------------------------

section('history manager');

const history = new HistoryManager(fakeSettings());
equal(history.frecency('apps:a.desktop'), 0, 'unknown keys have no weight');

history.record('apps:a.desktop');
check(history.frecency('apps:a.desktop') > 0, 'a recorded launch has weight');

history.record('apps:b.desktop');
history.record('apps:b.desktop');
history.record('apps:b.desktop');
check(history.frecency('apps:b.desktop') > history.frecency('apps:a.desktop'),
    'more launches outweigh fewer');
check(history.frecency('apps:b.desktop') < 1, 'the weight stays bounded below 1');

const aged = now - 4 * FRECENCY_HALF_LIFE_MS;
check(history.frecency('apps:b.desktop', Date.now()) >
    history.frecency('apps:b.desktop', Date.now() + 4 * FRECENCY_HALF_LIFE_MS),
    'weight decays as time passes');
check(aged < now, 'sanity: aged timestamps precede now');

history.record('windows:w1');
equal(history.topKeys(10, 'apps').length, 2, 'topKeys filters by provider');
equal(history.topKeys(10, 'apps')[0], 'apps:b.desktop', 'topKeys is ordered by frecency');
equal(history.topKeys(1, 'apps').length, 1, 'topKeys honours its limit');

const persistence = fakeSettings();
const firstRun = new HistoryManager(persistence);
firstRun.record('apps:persisted.desktop');
const secondRun = new HistoryManager(persistence);
check(secondRun.frecency('apps:persisted.desktop') > 0, 'history round-trips through settings');

const pruning = new HistoryManager(fakeSettings());
for (let i = 0; i < MAX_HISTORY_ENTRIES + 50; i++)
    pruning.record(`apps:app${i}.desktop`);
equal(pruning.topKeys(MAX_HISTORY_ENTRIES + 100, 'apps').length, MAX_HISTORY_ENTRIES,
    'history is pruned to its cap');

const cleared = new HistoryManager(fakeSettings());
cleared.record('apps:a.desktop');
cleared.clear();
equal(cleared.frecency('apps:a.desktop'), 0, 'clear() forgets everything');

// --- Favorites ------------------------------------------------------------

section('favorites manager');

const favorites = new FavoritesManager(fakeSettings());
equal(favorites.isPinned('apps:a.desktop'), false, 'nothing is pinned initially');
equal(favorites.toggle('apps:a.desktop'), true, 'toggle pins and reports the new state');
equal(favorites.isPinned('apps:a.desktop'), true, 'the pin took effect');
equal(favorites.toggle('apps:a.desktop'), false, 'toggling again unpins');

favorites.toggle('apps:a.desktop');
favorites.toggle('apps:b.desktop');
favorites.toggle('apps:c.desktop');
equal(JSON.stringify(favorites.keys),
    JSON.stringify(['apps:a.desktop', 'apps:b.desktop', 'apps:c.desktop']),
    'pins keep insertion order');

equal(favorites.move('apps:c.desktop', -1), true, 'move reports that it moved something');
equal(JSON.stringify(favorites.keys),
    JSON.stringify(['apps:a.desktop', 'apps:c.desktop', 'apps:b.desktop']),
    'move reorders');
equal(favorites.move('apps:a.desktop', -1), false, 'moving past the start is a no-op');
equal(favorites.move('apps:missing', 1), false, 'moving an unpinned key is a no-op');

favorites.clear();
equal(favorites.keys.length, 0, 'clear() unpins everything');

// --- Result -------------------------------------------------------------

console.log('');
if (failures > 0) {
    console.log(`${failures} of ${checks} checks FAILED`);
    throw new Error(`launcher engine tests failed (${failures}/${checks})`);
}
console.log(`All ${checks} launcher engine checks passed.`);
