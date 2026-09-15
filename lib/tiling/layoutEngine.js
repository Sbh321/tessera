// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Pure layout structure and mathematics -- plain {x, y, width, height}
 * objects, no GNOME imports, no side effects, so everything here is
 * deterministic and testable in isolation. Applying rectangles to real
 * windows is TilingManager's job.
 *
 * The tiled layout is a LayoutTree: Hyprland's dwindle model made
 * explicit as a binary split tree over opaque keys (the manager uses
 * Meta.Window objects as keys; this module never touches their API).
 * Inserting a window splits the *anchor* leaf -- the focused window --
 * in half, leaving every other leaf's area untouched; removing a leaf
 * hands its share back to its sibling subtree alone. That per-leaf
 * locality is exactly what a count-based strategy cannot express, and
 * is the whole reason the tree exists (see docs/ARCHITECTURE.md).
 *
 * On top of the structure the tree carries the two pieces of per-node
 * state the interactive operations need: every split has a ratio (the
 * share its first child gets, 0.5 until the user resizes) and remembers
 * the axis and area it was last laid out with, so that an edge the user
 * dragged can be mapped back to "which split boundary moved, and to
 * what ratio". Leaves can be swapped in place (window movement, tab
 * reordering), and findNeighbor() answers "which rectangle lies in that
 * direction" for directional focus and movement.
 *
 * The stacked layout needs no structure -- every window shares one
 * content rectangle -- so it stays a pure geometry function
 * (computeStackGeometry).
 */

export const LayoutMode = {
    TILED: 'tiled',
    STACKED: 'stacked',
    FLOATING: 'floating',
};

// Directions for the directional focus / move operations. Strings rather
// than Meta.MotionDirection so this module stays GNOME-free; the
// keybinding layer maps its own names onto these.
export const Direction = {
    LEFT: 'left',
    RIGHT: 'right',
    UP: 'up',
    DOWN: 'down',
};

// Height of the stacked-mode tab bar, shared with stackTabBar.js so the
// content rectangle and the bar can never disagree about the split.
export const STACK_TAB_BAR_HEIGHT = 36;

// A split's ratio is clamped so neither side can be resized away
// entirely: a window that can't be seen can't be grabbed to resize it
// back. 10% of the split's area is enough to see and grab.
export const MIN_SPLIT_RATIO = 0.1;

/**
 * The dwindle split tree. Leaves are opaque keys; internal nodes are
 * binary splits whose axis is chosen at *compute* time from the aspect
 * ratio of the area being split (wider than tall -> side by side, else
 * stacked vertically), so the same tree reflows correctly across
 * monitor/work-area changes. Splits are integer arithmetic: the first
 * child gets the rounded share of the split's ratio, the second is
 * defined as exactly the remainder, so siblings always abut across the
 * inner gap with no drift, overlap, or rounding holes at any depth or
 * fractional scale. With every ratio at its 0.5 default this is the
 * classic 50/50 dwindle bit-for-bit.
 *
 * Inserting with no anchor splits the most recently inserted leaf
 * (falling back to the tail of the second-child chain), which for
 * sequential insertions reproduces the classic dwindle spiral -- first
 * window 100%, second 50/50, each further window splitting the last --
 * bit-for-bit identical to the count-based strategy this class
 * replaced. Inserting with an anchor splits that leaf instead: the
 * anchor keeps the first (left/top) half, the new key takes the second
 * (right/bottom) half, matching Hyprland's focused-window insertion.
 *
 * Keys may be temporarily *hidden* at compute time (minimized,
 * maximized, fullscreen windows...): a hidden leaf keeps its structural
 * position but its area flows to its sibling, so restoring it later
 * returns it to exactly the slot it left.
 */
export class LayoutTree {
    constructor() {
        // Nodes are plain objects: leaves are {key, parent}, splits are
        // {first, second, parent, ratio, horizontal, area}; `first !==
        // undefined` identifies a split. `horizontal` and `area` are
        // recorded by the last computeRects() pass (null for a split
        // that pass walked straight through because one side had no
        // visible leaf) and consulted by resizeLeaf(). Keys must be
        // non-null (they are Meta.Windows in practice, but any object or
        // primitive works).
        this._root = null;
        this._leaves = new Map();   // key -> leaf node
        this._lastInserted = null;  // leaf node; anchorless-insert target
    }

    get size() {
        return this._leaves.size;
    }

    /**
     * @param {*} key
     * @returns {boolean} whether the key is a leaf of this tree
     */
    has(key) {
        return this._leaves.has(key);
    }

    /**
     * @returns {Array<*>} all keys in tree order (in-order leaf
     *   traversal) -- the natural "reading order" of the layout, used
     *   for the stacked tab bar
     */
    keys() {
        const keys = [];
        const walk = node => {
            if (node.first !== undefined) {
                walk(node.first);
                walk(node.second);
            } else {
                keys.push(node.key);
            }
        };
        if (this._root)
            walk(this._root);
        return keys;
    }

    /**
     * Insert a key by splitting the anchor leaf in half; the anchor
     * keeps the first half, the new key takes the second. With no (or
     * an unknown) anchor, the most recently inserted leaf is split
     * instead -- the dwindle-spiral tail. No-op if already present.
     *
     * @param {*} key the key to insert
     * @param {*} [anchorKey] the leaf to split (the focused window)
     */
    insert(key, anchorKey = null) {
        if (this._leaves.has(key))
            return;

        const leaf = {key, parent: null};
        this._leaves.set(key, leaf);

        if (this._root === null) {
            this._root = leaf;
            this._lastInserted = leaf;
            return;
        }

        const anchor = this._leaves.get(anchorKey) ??
            this._lastInserted ?? this._tailLeaf();
        const split = {
            first: anchor, second: leaf, parent: anchor.parent,
            ratio: 0.5, horizontal: null, area: null,
        };
        this._replaceChild(anchor.parent, anchor, split);
        anchor.parent = split;
        leaf.parent = split;
        this._lastInserted = leaf;
    }

    /**
     * Remove a key; its sibling subtree absorbs the freed area by
     * taking the parent split's place. No-op if absent.
     *
     * @param {*} key the key to remove
     */
    remove(key) {
        const leaf = this._leaves.get(key);
        if (!leaf)
            return;

        this._leaves.delete(key);
        if (this._lastInserted === leaf)
            this._lastInserted = null;

        const split = leaf.parent;
        if (split === null) {
            this._root = null;
            return;
        }
        const sibling = split.first === leaf ? split.second : split.first;
        this._replaceChild(split.parent, split, sibling);
        sibling.parent = split.parent;
    }

    /**
     * Exchange the positions of two leaves: each key takes the other's
     * slot, and nothing else in the tree changes -- Hyprland's
     * `movewindow`/`swapwindow` applied to the structure. Also what
     * reorders tabs in stacked mode, since tab order is tree order.
     *
     * @param {*} keyA
     * @param {*} keyB
     * @returns {boolean} whether both keys were leaves and got swapped
     */
    swap(keyA, keyB) {
        const a = this._leaves.get(keyA);
        const b = this._leaves.get(keyB);
        if (!a || !b || a === b)
            return false;
        a.key = keyB;
        b.key = keyA;
        this._leaves.set(keyA, b);
        this._leaves.set(keyB, a);
        return true;
    }

    /**
     * Re-fit a leaf to a rectangle the user resized it to, by moving the
     * split boundaries its edges sit on. Each of the four edges is
     * compared with `previous` (the rectangle the leaf was last laid out
     * at); an edge that moved is traced up the tree to the nearest split
     * of the matching axis whose boundary it is -- for a right edge, the
     * nearest horizontal ancestor the leaf sits on the *first* side of;
     * for a left edge, one it sits on the *second* side of; likewise
     * top/bottom for vertical splits -- and that split's ratio is set so
     * its boundary lands on the new edge. An edge with no such split is
     * on the work-area border and simply cannot move (the caller's
     * relayout snaps it back). Requires a prior computeRects() on this
     * tree, which is what records each split's axis and area.
     *
     * @param {*} key the resized leaf
     * @param {{x: number, y: number, width: number, height: number}} rect
     *   the rectangle the user resized it to
     * @param {{x: number, y: number, width: number, height: number}} previous
     *   the rectangle it was laid out at before the resize
     * @param {number} inner the inner gap the layout was computed with
     * @returns {boolean} whether any ratio changed
     */
    resizeLeaf(key, rect, previous, inner) {
        const leaf = this._leaves.get(key);
        if (!leaf)
            return false;

        let changed = false;
        if (rect.x !== previous.x)
            changed = this._moveEdge(leaf, true, false, rect.x, inner) || changed;
        if (rect.x + rect.width !== previous.x + previous.width)
            changed = this._moveEdge(leaf, true, true, rect.x + rect.width, inner) || changed;
        if (rect.y !== previous.y)
            changed = this._moveEdge(leaf, false, false, rect.y, inner) || changed;
        if (rect.y + rect.height !== previous.y + previous.height)
            changed = this._moveEdge(leaf, false, true, rect.y + rect.height, inner) || changed;
        return changed;
    }

    /**
     * Compute one rectangle per *visible* leaf.
     *
     * @param {{x: number, y: number, width: number, height: number}} workArea
     *   the monitor work area (already excludes panel/dock struts)
     * @param {{inner: number, outer: number}} gaps gap sizes in pixels
     * @param {?Set<*>} [visibleKeys] leaves to lay out; hidden leaves
     *   keep their structural position but yield their area to their
     *   sibling subtree. null means all leaves are visible.
     * @returns {Map<*, {x: number, y: number, width: number, height: number}>}
     *   rect per visible key
     */
    computeRects(workArea, gaps, visibleKeys = null) {
        const rects = new Map();
        if (this._root === null)
            return rects;

        // One counting pass so the split walk knows, per subtree, how
        // many visible leaves it holds -- a zero-visible side passes its
        // whole area to the other side.
        const counts = new Map();
        const countVisible = node => {
            let count;
            if (node.first !== undefined)
                count = countVisible(node.first) + countVisible(node.second);
            else
                count = visibleKeys === null || visibleKeys.has(node.key) ? 1 : 0;
            counts.set(node, count);
            return count;
        };
        if (countVisible(this._root) === 0)
            return rects;

        const walk = (node, area) => {
            if (node.first === undefined) {
                rects.set(node.key, area);
                return;
            }
            if (counts.get(node.first) === 0) {
                // Passed straight through: this split has no boundary
                // on screen right now, so it owns no edge to resize.
                node.horizontal = null;
                node.area = null;
                walk(node.second, area);
                return;
            }
            if (counts.get(node.second) === 0) {
                node.horizontal = null;
                node.area = null;
                walk(node.first, area);
                return;
            }

            const horizontal = area.width >= area.height;
            node.horizontal = horizontal;
            node.area = area;
            // Clamped so absurd window counts degrade to 1px slivers
            // instead of negative rectangles -- ugly but valid, never a
            // crash.
            const available = Math.max(2,
                (horizontal ? area.width : area.height) - gaps.inner);
            const firstSize = Math.min(available - 1,
                Math.max(1, Math.round(available * node.ratio)));
            const secondSize = available - firstSize;

            let first, second;
            if (horizontal) {
                first = {x: area.x, y: area.y, width: firstSize, height: area.height};
                second = {
                    x: area.x + firstSize + gaps.inner, y: area.y,
                    width: secondSize, height: area.height,
                };
            } else {
                first = {x: area.x, y: area.y, width: area.width, height: firstSize};
                second = {
                    x: area.x, y: area.y + firstSize + gaps.inner,
                    width: area.width, height: secondSize,
                };
            }
            walk(node.first, first);
            walk(node.second, second);
        };
        walk(this._root, insetRect(workArea, gaps.outer));
        return rects;
    }

    // Move one edge of a leaf to `position` by re-ratioing the split
    // whose boundary that edge is (see resizeLeaf). `trailing` is the
    // right/bottom edge (the leaf lies on the split's first side),
    // otherwise the left/top edge (second side). Walking up, a split of
    // the other axis, or one the leaf is on the non-boundary side of,
    // does not own this edge and is skipped; the walk stops at the
    // first owner.
    _moveEdge(leaf, horizontal, trailing, position, inner) {
        let node = leaf;
        for (let split = node.parent; split !== null; node = split, split = split.parent) {
            if (split.horizontal !== horizontal)
                continue;
            const owns = trailing ? split.first === node : split.second === node;
            if (!owns)
                continue;

            const area = split.area;
            const start = horizontal ? area.x : area.y;
            const available = Math.max(2,
                (horizontal ? area.width : area.height) - inner);
            const firstSize = trailing ? position - start : position - inner - start;
            const ratio = Math.min(1 - MIN_SPLIT_RATIO,
                Math.max(MIN_SPLIT_RATIO, firstSize / available));
            if (ratio === split.ratio)
                return false;
            split.ratio = ratio;
            return true;
        }
        return false;
    }

    // The deepest second-child leaf -- where the classic dwindle spiral
    // would put the next window. Only consulted when _lastInserted was
    // removed; the root is never null when this runs (insert checks).
    _tailLeaf() {
        let node = this._root;
        while (node.first !== undefined)
            node = node.second;
        return node;
    }

    _replaceChild(parent, oldChild, newChild) {
        if (parent === null)
            this._root = newChild;
        else if (parent.first === oldChild)
            parent.first = newChild;
        else
            parent.second = newChild;
    }
}

/**
 * Which rectangle lies in `direction` from `key`'s rectangle -- the
 * spatial lookup behind directional focus and directional window
 * movement (Hyprland's movefocus / movewindow).
 *
 * Two tiers. The first is every tiled case: a candidate wholly beyond
 * the origin's edge in that direction (its near edge at or past the
 * origin's far edge -- the inner gap is fine) that overlaps the origin
 * on the other axis; the nearest wins, ties broken by the larger
 * overlap. That picks the tile you would point at. Only when nothing
 * qualifies does the second tier run, for floating windows: any
 * candidate whose center lies that way and that either sits wholly
 * beyond the edge (off to one side, not lined up) or at least *extends*
 * further that way than the origin does (a cascade, an overlap), nearest
 * by a distance between centers that weights sideways offset double so
 * candidates roughly in line win. A tile that does not reach past the
 * origin's edge is never "in that direction", so pressing Up beside a
 * full-height tile does nothing rather than jumping to a tile in the
 * next column.
 *
 * @param {Map<*, {x: number, y: number, width: number, height: number}>} rects
 *   every candidate's rectangle, keyed like the tree (absolute
 *   coordinates, so rectangles on several monitors compose naturally)
 * @param {*} key the origin; must be a key of `rects`
 * @param {string} direction one of Direction
 * @returns {*} the neighbor key, or null if nothing lies that way
 */
export function findNeighbor(rects, key, direction) {
    const origin = rects.get(key);
    if (!origin)
        return null;

    const horizontal = direction === Direction.LEFT || direction === Direction.RIGHT;
    const forward = direction === Direction.RIGHT || direction === Direction.DOWN;

    // Per-axis helpers: the origin's edges and center along the
    // direction axis, and its span on the other axis.
    const edge = (rect, far) => {
        const start = horizontal ? rect.x : rect.y;
        const length = horizontal ? rect.width : rect.height;
        return (far === forward) ? start + length : start;
    };
    const center = (rect, along) => {
        const wantX = horizontal === along;
        return wantX ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
    };
    const originFar = edge(origin, true);
    const originAlong = center(origin, true);
    const originAcross = center(origin, false);

    const best = [null, null];
    const bestScore = [Infinity, Infinity];
    let bestOverlap = -1;

    for (const [candidate, rect] of rects) {
        if (candidate === key)
            continue;

        const along = center(rect, true) - originAlong;
        if (forward ? along <= 0 : along >= 0)
            continue;
        const across = center(rect, false) - originAcross;
        const score = Math.abs(along) + 2 * Math.abs(across);

        // Signed gap between the origin's far edge and the candidate's
        // near edge, positive when the candidate is wholly beyond it.
        const distance = forward
            ? edge(rect, false) - originFar
            : originFar - edge(rect, false);
        const overlap = horizontal
            ? overlap1d(origin.y, origin.height, rect.y, rect.height)
            : overlap1d(origin.x, origin.width, rect.x, rect.width);
        const extendsBeyond = forward
            ? edge(rect, true) > originFar
            : edge(rect, true) < originFar;

        if (distance >= 0 && overlap > 0) {
            if (distance < bestScore[0] ||
                (distance === bestScore[0] && overlap > bestOverlap)) {
                best[0] = candidate;
                bestScore[0] = distance;
                bestOverlap = overlap;
            }
        } else if ((distance >= 0 || extendsBeyond) && score < bestScore[1]) {
            best[1] = candidate;
            bestScore[1] = score;
        }
    }
    return best[0] ?? best[1] ?? null;
}

function overlap1d(aStart, aLength, bStart, bLength) {
    return Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart);
}

/**
 * The stacked-mode geometry split: where the tab bar sits and where the
 * single shared content area sits, both inside the outer gap. Which
 * window is on top is a stacking/focus concern, not a geometry one.
 *
 * @param {{x: number, y: number, width: number, height: number}} workArea
 * @param {{inner: number, outer: number}} gaps
 * @returns {{barRect: object, contentRect: object}}
 */
export function computeStackGeometry(workArea, gaps) {
    const area = insetRect(workArea, gaps.outer);
    const barRect = {
        x: area.x,
        y: area.y,
        width: area.width,
        height: STACK_TAB_BAR_HEIGHT,
    };
    const contentTop = barRect.y + barRect.height + gaps.inner;
    const contentRect = {
        x: area.x,
        y: contentTop,
        width: area.width,
        height: Math.max(1, area.y + area.height - contentTop),
    };
    return {barRect, contentRect};
}

function insetRect(rect, inset) {
    return {
        x: rect.x + inset,
        y: rect.y + inset,
        width: Math.max(1, rect.width - 2 * inset),
        height: Math.max(1, rect.height - 2 * inset),
    };
}
