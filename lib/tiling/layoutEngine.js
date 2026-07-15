// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Pure layout mathematics. Given a work area, a window count, a mode,
 * and gap sizes, produces one rectangle per window slot -- plain
 * {x, y, width, height} objects, no GNOME imports, no side effects, so
 * every strategy is deterministic and testable in isolation. Applying
 * rectangles to real windows is TilingManager's job.
 *
 * Layouts are strategies keyed by LayoutMode; adding a future layout
 * (master, grid, spiral variants...) means adding one pure function to
 * STRATEGIES and nothing anywhere else.
 */

export const LayoutMode = {
    TILED: 'tiled',
    STACKED: 'stacked',
};

// Height of the stacked-mode tab bar, shared with stackTabBar.js so the
// content rectangle and the bar can never disagree about the split.
export const STACK_TAB_BAR_HEIGHT = 36;

/**
 * @param {string} mode a LayoutMode value
 * @param {{x: number, y: number, width: number, height: number}} workArea
 *   the monitor work area (already excludes panel/dock struts)
 * @param {number} count how many windows to lay out
 * @param {{inner: number, outer: number}} gaps gap sizes in pixels
 * @returns {Array<{x: number, y: number, width: number, height: number}>}
 *   one rect per window, in the same order as the caller's window list
 */
export function computeLayout(mode, workArea, count, gaps) {
    if (count <= 0)
        return [];

    const strategy = STRATEGIES[mode] ?? STRATEGIES[LayoutMode.TILED];
    return strategy(insetRect(workArea, gaps.outer), count, gaps.inner);
}

/**
 * The stacked-mode geometry split: where the tab bar sits and where the
 * single visible content area sits, both inside the outer gap.
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

const STRATEGIES = {
    // Hyprland's default "dwindle" layout: a binary split where the first
    // window takes half the area and the remaining windows recurse into
    // the other half, each split axis chosen from the aspect ratio of the
    // area being split (wider than tall -> side by side, else stacked
    // vertically). One window fills everything; two sit 50/50; the third
    // splits the second's half; and so on in the familiar spiral.
    //
    // All arithmetic is integer: the first child is rounded, the second
    // child is defined as exactly the remainder, so siblings always abut
    // across the inner gap with no drift, overlap, or rounding holes at
    // any depth or fractional scale.
    [LayoutMode.TILED]: function dwindle(area, count, innerGap) {
        if (count === 1)
            return [area];

        const horizontal = area.width >= area.height;
        // Clamped so absurd window counts degrade to 1px slivers instead
        // of negative rectangles -- ugly but valid, never a crash.
        const available = Math.max(2, (horizontal ? area.width : area.height) - innerGap);
        const firstSize = Math.max(1, Math.round(available / 2));
        const secondSize = Math.max(1, available - firstSize);

        let first, second;
        if (horizontal) {
            first = {x: area.x, y: area.y, width: firstSize, height: area.height};
            second = {
                x: area.x + firstSize + innerGap, y: area.y,
                width: secondSize, height: area.height,
            };
        } else {
            first = {x: area.x, y: area.y, width: area.width, height: firstSize};
            second = {
                x: area.x, y: area.y + firstSize + innerGap,
                width: area.width, height: secondSize,
            };
        }

        return [first, ...dwindle(second, count - 1, innerGap)];
    },

    // Hyprland's "stacked" layout: every window occupies the same content
    // rectangle below a tab bar; only the raised (focused) one is
    // visible. The engine just reports the shared rectangle -- which
    // window is on top is a stacking/focus concern, not a geometry one.
    [LayoutMode.STACKED]: function stacked(area, count, innerGap) {
        // insetRect was already applied by computeLayout; recover the
        // outer work area shape computeStackGeometry expects by passing
        // a zero outer gap.
        const {contentRect} = computeStackGeometry(area, {inner: innerGap, outer: 0});
        return Array.from({length: count}, () => ({...contentRect}));
    },
};

function insetRect(rect, inset) {
    return {
        x: rect.x + inset,
        y: rect.y + inset,
        width: Math.max(1, rect.width - 2 * inset),
        height: Math.max(1, rect.height - 2 * inset),
    };
}
