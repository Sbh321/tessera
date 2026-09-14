// SPDX-License-Identifier: GPL-2.0-or-later
//
// Unit tests for the browser-window <-> compositor-window mapper. The
// descriptors are plain objects standing in for Meta.Window and for the
// tab store's window views, so every pairing rule -- focus, exact title,
// prefix, elimination, ambiguity -- is exercised without a shell.

import {
    BindingStrength, BrowserWindowMapper, expectedTitles, learnSuffix,
    normalizeTitle, titleHasPrefix,
} from '../lib/launcher/browserWindowMapper.js';

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
    check(actual === expected,
        `${description} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function section(name) {
    console.log(name);
}

const CHROME = [' - Google Chrome', ' - Google Chrome (Incognito)'];
const FIREFOX = [' — Mozilla Firefox'];

function shell(key, title, family = 'chromium') {
    return {key, title, family};
}

function session(key, windows, browserType = 'chromium', suffixes = CHROME) {
    return {key, browserType, suffixes, windows};
}

function bw(windowId, activeTitle, title = '') {
    return {windowId, activeTitle, title};
}

section('mapper: helpers');
equal(normalizeTitle('  A ‎- B\n'), 'A - B', 'bidi marks and whitespace are normalised');
equal(JSON.stringify(expectedTitles(bw(1, 'GitHub'), CHROME)),
    JSON.stringify(['GitHub - Google Chrome', 'GitHub - Google Chrome (Incognito)']),
    'expected titles combine the active title with every suffix');
equal(JSON.stringify(expectedTitles(bw(1, 'GitHub', 'GitHub — Mozilla Firefox'), FIREFOX)),
    JSON.stringify(['GitHub — Mozilla Firefox']), 'a window with its own title expects exactly that');
equal(expectedTitles(bw(1, ''), CHROME).length, 0, 'no active title, no expectation');
check(titleHasPrefix('GitHub - Brave', 'GitHub'), 'prefix with an unknown suffix');
check(titleHasPrefix('GitHub', 'GitHub'), 'a bare title counts as a prefix match');
check(!titleHasPrefix('GitHub Issues - Brave', 'GitHub'), 'the separator must follow directly');
check(!titleHasPrefix('Something else', 'GitHub'), 'no prefix, no match');
equal(learnSuffix('GitHub - Brave', 'GitHub'), ' - Brave', 'suffix learning');
equal(learnSuffix('GitHub Issues', 'GitHub'), null, 'a non-separator remainder is not a suffix');
equal(learnSuffix('GitHub - Brave', ''), null, 'nothing to learn from an empty active title');

section('mapper: exact titles by elimination');
{
    const mapper = new BrowserWindowMapper();
    const bindings = mapper.resolve(
        [shell('m1', 'GitHub - Google Chrome'), shell('m2', 'YouTube - Google Chrome'), shell('m3', 'Terminal', null)],
        [session('s', [bw(10, 'GitHub'), bw(20, 'YouTube')])]);
    equal(bindings.get('m1')?.windowId, 10, 'GitHub window pairs by exact title');
    equal(bindings.get('m2')?.windowId, 20, 'YouTube window pairs by exact title');
    equal(bindings.get('m1')?.strength, BindingStrength.TITLE, 'strength is TITLE');
    equal(bindings.has('m3'), false, 'non-browser windows are never bound');
    equal(mapper.shellKeyFor('s', 20), 'm2', 'reverse lookup works');
}

section('mapper: incognito suffix and prefix fallback');
{
    const mapper = new BrowserWindowMapper();
    const bindings = mapper.resolve(
        [shell('m1', 'Secret - Google Chrome (Incognito)'), shell('m2', 'Docs - Brave')],
        [session('s', [bw(10, 'Secret'), bw(20, 'Docs')])]);
    equal(bindings.get('m1')?.windowId, 10, 'incognito suffix is an exact match');
    equal(bindings.get('m2')?.windowId, 20, 'an unlearned suffix still pairs by prefix');
    equal(bindings.get('m2')?.strength, BindingStrength.PREFIX, 'and is marked as the weak rule');
}

section('mapper: exact beats prefix when both could apply');
{
    const mapper = new BrowserWindowMapper();
    const bindings = mapper.resolve(
        [shell('m1', 'GitHub - Google Chrome'), shell('m2', 'GitHub - Issues - Google Chrome')],
        [session('s', [bw(10, 'GitHub'), bw(20, 'GitHub - Issues')])]);
    equal(bindings.get('m1')?.windowId, 10, 'the shorter title pairs with the shorter active tab');
    equal(bindings.get('m2')?.windowId, 20, 'the longer with the longer');
}

section('mapper: ambiguity stays unbound');
{
    const mapper = new BrowserWindowMapper();
    const bindings = mapper.resolve(
        [shell('m1', 'New Tab - Google Chrome'), shell('m2', 'New Tab - Google Chrome')],
        [session('s', [bw(10, 'New Tab'), bw(20, 'New Tab')])]);
    equal(bindings.size, 0, 'two identical windows bind neither');

    mapper.bindStrong('m2', 's', 20);
    const resolved = mapper.resolve(
        [shell('m1', 'New Tab - Google Chrome'), shell('m2', 'New Tab - Google Chrome')],
        [session('s', [bw(10, 'New Tab'), bw(20, 'New Tab')])]);
    equal(resolved.get('m2')?.strength, BindingStrength.STRONG, 'focus confirms one');
    equal(resolved.get('m1')?.windowId, 10, 'and the other follows by elimination');
}

section('mapper: strong bindings displace and persist');
{
    const mapper = new BrowserWindowMapper();
    mapper.resolve([shell('m1', 'GitHub - Google Chrome')], [session('s', [bw(10, 'GitHub')])]);
    equal(mapper.binding('m1')?.strength, BindingStrength.TITLE, 'starts as a title binding');
    mapper.bindStrong('m1', 's', 10);
    equal(mapper.binding('m1')?.strength, BindingStrength.STRONG, 'upgraded by focus');
    // Titles diverge for a moment (the browser reported a new title first).
    const bindings = mapper.resolve([shell('m1', 'Loading… - Google Chrome')], [session('s', [bw(10, 'GitHub')])]);
    equal(bindings.get('m1')?.windowId, 10, 'a strong binding survives a title disagreement');

    // A later focus observation moves the browser window to another shell window.
    mapper.bindStrong('m2', 's', 10);
    equal(mapper.binding('m1'), null, 'the old shell window is released');
    equal(mapper.shellKeyFor('s', 10), 'm2', 'the browser window now points at the new one');

    mapper.bindStrong('m2', 's', 30);
    equal(mapper.shellKeyFor('s', 10), null, 'a shell window can hold only one browser window');
    equal(mapper.binding('m2')?.windowId, 30, 'and takes the newest');
}

section('mapper: stale bindings are pruned');
{
    const mapper = new BrowserWindowMapper();
    mapper.bindStrong('m1', 's', 10);
    mapper.bindStrong('m2', 's', 20);
    mapper.resolve([shell('m2', 'x')], [session('s', [bw(20, 'x')])]);
    equal(mapper.binding('m1'), null, 'a closed shell window loses its binding');
    mapper.resolve([shell('m2', 'x')], [session('s', [])]);
    equal(mapper.binding('m2'), null, 'a closed browser window loses its binding');
    mapper.bindStrong('m3', 's', 30);
    mapper.forgetSession('s');
    equal(mapper.binding('m3'), null, 'a disconnected session releases everything');
}

section('mapper: families and multiple browsers');
{
    const mapper = new BrowserWindowMapper();
    const bindings = mapper.resolve(
        [shell('c1', 'Docs - Google Chrome', 'chromium'), shell('f1', 'Docs — Mozilla Firefox', 'firefox')],
        [session('chrome', [bw(1, 'Docs')]), session('fox', [bw(1, 'Docs', 'Docs — Mozilla Firefox')], 'firefox', FIREFOX)]);
    equal(bindings.get('c1')?.sessionKey, 'chrome', 'chromium window pairs within its family');
    equal(bindings.get('f1')?.sessionKey, 'fox', 'firefox window pairs within its family');

    // Two Chrome profiles, same numeric window id, different titles.
    const two = new BrowserWindowMapper();
    const result = two.resolve(
        [shell('a', 'Work - Google Chrome'), shell('b', 'Home - Google Chrome')],
        [session('p1', [bw(1, 'Work')]), session('p2', [bw(1, 'Home')])]);
    equal(result.get('a')?.sessionKey, 'p1', 'profile 1 window');
    equal(result.get('b')?.sessionKey, 'p2', 'profile 2 window with the same numeric id');
}

console.log('');
if (failures > 0) {
    console.log(`${failures} of ${checks} checks FAILED`);
    throw new Error(`browser window mapper tests failed (${failures}/${checks})`);
}
console.log(`All ${checks} browser window mapper checks passed.`);
