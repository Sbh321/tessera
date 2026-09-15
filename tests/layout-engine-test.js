// SPDX-License-Identifier: GPL-2.0-or-later
//
// Unit tests for the tiling subsystem's pure layout engine: the dwindle
// LayoutTree (insertion, removal, hidden leaves, leaf swaps, split
// ratios driven by resizeLeaf), the directional neighbor search, and
// the stacked geometry split.
//
// lib/tiling/layoutEngine.js imports no GNOME namespace, which is what
// makes it testable here; everything that applies these rectangles to
// real windows is covered by tests/MANUAL_TESTS.md instead.
//
// Run with either runtime:
//     gjs -m tests/layout-engine-test.js
//     tests/run-tests.sh          (picks whichever is installed)

import {
    Direction, LayoutTree, MIN_SPLIT_RATIO, STACK_TAB_BAR_HEIGHT,
    computeStackGeometry, findNeighbor,
} from '../lib/tiling/layoutEngine.js';

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

function rectEqual(actual, expected, description) {
    const same = actual && actual.x === expected.x && actual.y === expected.y &&
        actual.width === expected.width && actual.height === expected.height;
    check(same, `${description} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function section(name) {
    console.log(name);
}

const AREA = {x: 0, y: 0, width: 1000, height: 500};
const GAPS = {inner: 10, outer: 0};

function treeOf(...keys) {
    const tree = new LayoutTree();
    for (const key of keys)
        tree.insert(key);
    return tree;
}

section('Dwindle splits at 50/50 by default');
{
    const tree = treeOf('a', 'b');
    const rects = tree.computeRects(AREA, GAPS);
    rectEqual(rects.get('a'), {x: 0, y: 0, width: 495, height: 500}, 'first half');
    rectEqual(rects.get('b'), {x: 505, y: 0, width: 495, height: 500}, 'second half');

    tree.insert('c');
    const three = tree.computeRects(AREA, GAPS);
    rectEqual(three.get('a'), {x: 0, y: 0, width: 495, height: 500}, 'a untouched by the third window');
    rectEqual(three.get('b'), {x: 505, y: 0, width: 495, height: 245}, 'b splits vertically');
    rectEqual(three.get('c'), {x: 505, y: 255, width: 495, height: 245}, 'c takes the bottom');
    equal(tree.keys().join(''), 'abc', 'tree order is insertion order for spiral inserts');
}

section('Anchored insertion splits the anchor');
{
    const tree = treeOf('a', 'b');
    tree.insert('c', 'a');
    const rects = tree.computeRects(AREA, GAPS);
    rectEqual(rects.get('b'), {x: 505, y: 0, width: 495, height: 500}, 'b does not move');
    rectEqual(rects.get('a'), {x: 0, y: 0, width: 495, height: 245}, 'a keeps the first half of its tile');
    rectEqual(rects.get('c'), {x: 0, y: 255, width: 495, height: 245}, 'c takes the second half');
    equal(tree.keys().join(''), 'acb', 'tree order reflects the split');
}

section('Removal hands the area to the sibling');
{
    const tree = treeOf('a', 'b', 'c');
    tree.remove('c');
    const rects = tree.computeRects(AREA, GAPS);
    rectEqual(rects.get('b'), {x: 505, y: 0, width: 495, height: 500}, 'b reclaims the whole right half');
    tree.remove('a');
    rectEqual(tree.computeRects(AREA, GAPS).get('b'), AREA, 'the survivor gets everything');
    tree.remove('b');
    equal(tree.size, 0, 'empty after removing the last leaf');
    equal(tree.computeRects(AREA, GAPS).size, 0, 'no rects for an empty tree');
}

section('Hidden leaves yield their area but keep their slot');
{
    const tree = treeOf('a', 'b', 'c');
    const rects = tree.computeRects(AREA, GAPS, new Set(['a', 'c']));
    equal(rects.has('b'), false, 'hidden leaf gets no rect');
    rectEqual(rects.get('c'), {x: 505, y: 0, width: 495, height: 500}, 'sibling takes the hidden area');
    const restored = tree.computeRects(AREA, GAPS);
    rectEqual(restored.get('b'), {x: 505, y: 0, width: 495, height: 245}, 'restored leaf is back in its slot');
}

section('swap() exchanges two leaves in place');
{
    const tree = treeOf('a', 'b', 'c');
    equal(tree.swap('a', 'c'), true, 'swap succeeds');
    equal(tree.keys().join(''), 'cba', 'order reflects the swap');
    const rects = tree.computeRects(AREA, GAPS);
    rectEqual(rects.get('c'), {x: 0, y: 0, width: 495, height: 500}, 'c took the big left tile');
    rectEqual(rects.get('a'), {x: 505, y: 255, width: 495, height: 245}, 'a took the bottom-right tile');
    equal(tree.swap('a', 'zzz'), false, 'swap with an unknown key fails');
    equal(tree.swap('a', 'a'), false, 'swap with itself fails');
    equal(tree.keys().join(''), 'cba', 'failed swaps change nothing');
    tree.remove('c');
    equal(tree.keys().join(''), 'ba', 'removal after a swap removes the right leaf');
}

section('resizeLeaf() moves the split boundary an edge sits on');
{
    const tree = treeOf('a', 'b');
    let rects = tree.computeRects(AREA, GAPS);
    const before = rects.get('a');
    // Drag a's right edge from 495 to 600.
    equal(tree.resizeLeaf('a', {x: 0, y: 0, width: 600, height: 500}, before, GAPS.inner),
        true, 'right edge moved -> ratio changed');
    rects = tree.computeRects(AREA, GAPS);
    rectEqual(rects.get('a'), {x: 0, y: 0, width: 600, height: 500}, 'a is now 600 wide');
    rectEqual(rects.get('b'), {x: 610, y: 0, width: 390, height: 500}, 'b is the remainder past the gap');

    // Drag b's LEFT edge instead: it owns the same boundary from the other side.
    const bBefore = rects.get('b');
    equal(tree.resizeLeaf('b', {x: 410, y: 0, width: 590, height: 500}, bBefore, GAPS.inner),
        true, 'left edge of the second child moves the same split');
    rects = tree.computeRects(AREA, GAPS);
    rectEqual(rects.get('a'), {x: 0, y: 0, width: 400, height: 500}, 'a shrank to 400');
    rectEqual(rects.get('b'), {x: 410, y: 0, width: 590, height: 500}, 'b grew');

    // Edges on the work-area border own no split: nothing changes.
    const aBefore = rects.get('a');
    equal(tree.resizeLeaf('a', {x: 50, y: 0, width: 350, height: 500}, aBefore, GAPS.inner),
        false, 'left screen edge cannot move');
    equal(tree.resizeLeaf('a', {x: 0, y: 20, width: 400, height: 460}, aBefore, GAPS.inner),
        false, 'top/bottom edges with no vertical split cannot move');
    equal(tree.resizeLeaf('a', aBefore, aBefore, GAPS.inner), false, 'no edge moved -> no change');
    equal(tree.resizeLeaf('nope', aBefore, aBefore, GAPS.inner), false, 'unknown key -> no change');
}

section('resizeLeaf() clamps to MIN_SPLIT_RATIO');
{
    const tree = treeOf('a', 'b');
    const before = tree.computeRects(AREA, GAPS).get('a');
    tree.resizeLeaf('a', {x: 0, y: 0, width: 990, height: 500}, before, GAPS.inner);
    const rects = tree.computeRects(AREA, GAPS);
    const available = AREA.width - GAPS.inner;
    equal(rects.get('a').width, Math.round(available * (1 - MIN_SPLIT_RATIO)), 'first child capped');
    equal(rects.get('b').width, available - rects.get('a').width, 'second child keeps the minimum');
    tree.resizeLeaf('a', {x: 0, y: 0, width: 1, height: 500}, rects.get('a'), GAPS.inner);
    equal(tree.computeRects(AREA, GAPS).get('a').width, Math.round(available * MIN_SPLIT_RATIO),
        'first child floored');
}

section('resizeLeaf() walks past splits of the other axis and pass-through splits');
{
    // A taller area, so the right column stays taller than wide (and
    // therefore vertically split) after it is widened below.
    const TALL = {x: 0, y: 0, width: 1000, height: 800};
    // a | (b / c): b's left edge is the ROOT's boundary, two levels up.
    const tree = treeOf('a', 'b', 'c');
    let rects = tree.computeRects(TALL, GAPS);
    rectEqual(rects.get('b'), {x: 505, y: 0, width: 495, height: 395}, 'baseline b');
    const bBefore = rects.get('b');
    equal(tree.resizeLeaf('b', {x: 505, y: 0, width: 400, height: 395}, bBefore, GAPS.inner),
        false, 'b\'s right edge is on the screen border');
    equal(tree.resizeLeaf('b', {x: 405, y: 0, width: 595, height: 395}, bBefore, GAPS.inner),
        true, 'b\'s left edge moves the root split');
    rects = tree.computeRects(TALL, GAPS);
    rectEqual(rects.get('a'), {x: 0, y: 0, width: 395, height: 800}, 'a shrank');
    rectEqual(rects.get('b'), {x: 405, y: 0, width: 595, height: 395}, 'b widened');
    rectEqual(rects.get('c'), {x: 405, y: 405, width: 595, height: 395}, 'c widened with it');

    // b's bottom edge is the inner vertical split.
    const bNow = rects.get('b');
    equal(tree.resizeLeaf('b', {x: 405, y: 0, width: 595, height: 300}, bNow, GAPS.inner),
        true, 'bottom edge moves the vertical split');
    rects = tree.computeRects(TALL, GAPS);
    rectEqual(rects.get('b'), {x: 405, y: 0, width: 595, height: 300}, 'b is shorter');
    rectEqual(rects.get('c'), {x: 405, y: 310, width: 595, height: 490}, 'c is the remainder');

    // With c hidden the inner split is passed through; a's right edge
    // still finds the root split, and b's bottom edge finds nothing.
    rects = tree.computeRects(TALL, GAPS, new Set(['a', 'b']));
    rectEqual(rects.get('b'), {x: 405, y: 0, width: 595, height: 800}, 'b fills the column while c is hidden');
    equal(tree.resizeLeaf('b', {x: 405, y: 0, width: 595, height: 400}, rects.get('b'), GAPS.inner),
        false, 'a pass-through split owns no edge');
    equal(tree.resizeLeaf('a', {x: 0, y: 0, width: 500, height: 800}, rects.get('a'), GAPS.inner),
        true, 'the root split is still reachable');
    rects = tree.computeRects(TALL, GAPS);
    equal(rects.get('a').width, 500, 'a is 500 wide again');
    equal(rects.get('c').height, 490, 'the hidden-then-restored split kept its ratio');
}

section('Resizing may flip a split\'s axis, by design');
{
    // The axis is chosen from the area\'s aspect at compute time: widen
    // the right column of a 1000x500 area past 500 and its inner split
    // turns side-by-side. Same rule that reflows a tree across monitors.
    const tree = treeOf('a', 'b', 'c');
    const rects = tree.computeRects(AREA, GAPS);
    tree.resizeLeaf('b', {x: 405, y: 0, width: 595, height: 245}, rects.get('b'), GAPS.inner);
    const after = tree.computeRects(AREA, GAPS);
    equal(after.get('b').height, 500, 'b now spans the full height');
    equal(after.get('b').x + after.get('b').width < after.get('c').x, true, 'b and c are side by side');
}

section('findNeighbor(): strict tier on tiles');
{
    const tree = treeOf('a', 'b', 'c');
    const rects = tree.computeRects(AREA, GAPS);
    equal(findNeighbor(rects, 'a', Direction.RIGHT), 'b', 'right of a is b (first in tree order on a tie)');
    equal(findNeighbor(rects, 'a', Direction.LEFT), null, 'nothing left of a');
    equal(findNeighbor(rects, 'a', Direction.UP), null, 'nothing above a');
    equal(findNeighbor(rects, 'b', Direction.LEFT), 'a', 'left of b is a');
    equal(findNeighbor(rects, 'b', Direction.DOWN), 'c', 'below b is c');
    equal(findNeighbor(rects, 'c', Direction.UP), 'b', 'above c is b');
    equal(findNeighbor(rects, 'c', Direction.LEFT), 'a', 'left of c is a');
    equal(findNeighbor(rects, 'c', Direction.RIGHT), null, 'nothing right of c');
    equal(findNeighbor(rects, 'zzz', Direction.RIGHT), null, 'unknown origin');
}

section('findNeighbor(): overlap decides between equally near candidates');
{
    const rects = new Map([
        ['origin', {x: 0, y: 100, width: 100, height: 200}],
        ['top', {x: 110, y: 0, width: 100, height: 150}],       // overlaps 50
        ['middle', {x: 110, y: 150, width: 100, height: 100}],  // overlaps 100
        ['far', {x: 300, y: 100, width: 100, height: 200}],     // farther
        ['above', {x: 110, y: 0, width: 100, height: 100}],     // touches at y=100: no overlap
    ]);
    equal(findNeighbor(rects, 'origin', Direction.RIGHT), 'middle', 'largest overlap wins a tie');
}

section('findNeighbor(): lax tier for overlapping / offset floating windows');
{
    const rects = new Map([
        ['origin', {x: 100, y: 100, width: 300, height: 300}],
        ['overlapping', {x: 250, y: 150, width: 300, height: 300}],  // partly over origin
        ['offsetBelow', {x: 600, y: 500, width: 100, height: 100}],
    ]);
    equal(findNeighbor(rects, 'origin', Direction.RIGHT), 'overlapping', 'center to the right wins');
    equal(findNeighbor(rects, 'origin', Direction.DOWN), 'overlapping', 'center below wins');
    equal(findNeighbor(rects, 'origin', Direction.LEFT), null, 'nothing has its center to the left');
    equal(findNeighbor(rects, 'offsetBelow', Direction.UP), 'overlapping', 'nearest by weighted distance');
}

section('computeStackGeometry()');
{
    const {barRect, contentRect} = computeStackGeometry(AREA, {inner: 10, outer: 8});
    rectEqual(barRect, {x: 8, y: 8, width: 984, height: STACK_TAB_BAR_HEIGHT}, 'bar inside the outer gap');
    rectEqual(contentRect,
        {x: 8, y: 8 + STACK_TAB_BAR_HEIGHT + 10, width: 984, height: 500 - 8 - (8 + STACK_TAB_BAR_HEIGHT + 10)},
        'content below the bar and inner gap');
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) {
    console.log(`${failures} FAILED`);
    throw new Error('layout-engine-test failed');
}
