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
 * The stacked layout needs no structure -- every window shares one
 * content rectangle -- so it stays a pure geometry function
 * (computeStackGeometry).
 */

export const LayoutMode = {
    TILED: 'tiled',
    STACKED: 'stacked',
};

// Height of the stacked-mode tab bar, shared with stackTabBar.js so the
// content rectangle and the bar can never disagree about the split.
export const STACK_TAB_BAR_HEIGHT = 36;

/**
 * The dwindle split tree. Leaves are opaque keys; internal nodes are
 * binary splits whose axis is chosen at *compute* time from the aspect
 * ratio of the area being split (wider than tall -> side by side, else
 * stacked vertically), so the same tree reflows correctly across
 * monitor/work-area changes. Splits are 50/50 in integer arithmetic:
 * the first child is rounded, the second is defined as exactly the
 * remainder, so siblings always abut across the inner gap with no
 * drift, overlap, or rounding holes at any depth or fractional scale.
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
        // {first, second, parent}; `first !== undefined` identifies a
        // split. Keys must be non-null (they are Meta.Windows in
        // practice, but any object or primitive works).
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
        const split = {first: anchor, second: leaf, parent: anchor.parent};
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
                walk(node.second, area);
                return;
            }
            if (counts.get(node.second) === 0) {
                walk(node.first, area);
                return;
            }

            const horizontal = area.width >= area.height;
            // Clamped so absurd window counts degrade to 1px slivers
            // instead of negative rectangles -- ugly but valid, never a
            // crash.
            const available = Math.max(2,
                (horizontal ? area.width : area.height) - gaps.inner);
            const firstSize = Math.max(1, Math.round(available / 2));
            const secondSize = Math.max(1, available - firstSize);

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
