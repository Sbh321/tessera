// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Shared, translation-free constants for the launcher subsystem.
 *
 * Deliberately holds no gettext strings: gettext (`_`) may only be called
 * from within extension code at runtime, never during module evaluation
 * at import time (the same rule lib/quickMenu.js documents), so every
 * user-visible label is built lazily by the module that renders it.
 */

/**
 * Stable provider identifiers. These are persisted -- they appear inside
 * history and favorites keys ("apps:firefox.desktop") -- so renaming one
 * silently invalidates a user's ranking data. Add, don't rename.
 *
 * @enum {string}
 */
export const ProviderId = {
    CALCULATOR: 'calculator',
    COMMANDS: 'commands',
    ACTIONS: 'actions',
    APPS: 'apps',
    WINDOWS: 'windows',
    RECENT: 'recent',
    CLIPBOARD: 'clipboard',
    SETTINGS: 'settings',
    EXTENSIONS: 'extensions',
};

/**
 * The pseudo-section pinned results are promoted into. Providers never
 * emit it themselves -- the controller moves a result here when
 * FavoritesManager says it is pinned, which is what keeps every provider
 * unaware that favorites exist at all.
 */
export const FAVORITES_SECTION = 'favorites';

/**
 * Sections that always sort above the score-ordered rest, in this order.
 *
 * Open windows lead unconditionally: switching to something already open
 * is the most common thing a launcher is asked to do, and unlike every
 * other section its entries are things the user put on screen
 * themselves. Pinning the section (rather than inflating window scores)
 * keeps that promise exact -- a window is never pushed below an app
 * because some other result happened to match a character better.
 */
export const PRIORITY_SECTIONS = [ProviderId.WINDOWS];

/**
 * Tie-break order for sections whose best result scores identically.
 * Sections are otherwise ordered by their own best score, so this only
 * decides genuine ties (and the order of the empty-query default view).
 */
export const SECTION_ORDER = [
    ProviderId.WINDOWS,
    ProviderId.CALCULATOR,
    ProviderId.COMMANDS,
    FAVORITES_SECTION,
    ProviderId.APPS,
    ProviderId.ACTIONS,
    ProviderId.RECENT,
    ProviderId.CLIPBOARD,
    ProviderId.SETTINGS,
    ProviderId.EXTENSIONS,
];

/**
 * Multiplicative prior on every provider's match score, applied before
 * the additive boosts below. These express "when two things match the
 * query equally well, which did the user more likely mean" -- an app
 * beats an extension entry with the same spelling. Kept close to 1 so
 * they only ever break near-ties; match quality dominates.
 */
export const PROVIDER_WEIGHT = {
    [ProviderId.CALCULATOR]: 1.0,
    [ProviderId.COMMANDS]: 1.0,
    // Level with applications, not below them: an open window and an app
    // that match a query equally well are equally good answers, and which
    // one is shown first is decided by PRIORITY_SECTIONS rather than by
    // quietly discounting one of them here.
    [ProviderId.WINDOWS]: 1.0,
    [ProviderId.APPS]: 1.0,
    [ProviderId.ACTIONS]: 0.94,
    [ProviderId.RECENT]: 0.92,
    [ProviderId.SETTINGS]: 0.86,
    [ProviderId.CLIPBOARD]: 0.85,
    [ProviderId.EXTENSIONS]: 0.82,
};

/**
 * Additive ranking boosts. All small relative to the 0..1 match score, so
 * they reorder near-equal matches (which is the point of adaptive
 * ranking) without ever floating a poor match above a good one.
 */
export const FAVORITE_BOOST = 0.12;
export const FRECENCY_MAX_BOOST = 0.10;
export const CURRENT_WORKSPACE_BOOST = 0.04;
export const FOCUSED_APP_BOOST = 0.03;

/** How long a launch keeps its full frecency weight before decaying. */
export const FRECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** Launch records kept in GSettings; pruned lowest-frecency-first. */
export const MAX_HISTORY_ENTRIES = 300;

/**
 * Per-section result cap. The global cap is the user's "maximum results"
 * setting; this stops one prolific provider (e.g. 200 matching apps) from
 * consuming the whole list before the others are seen.
 */
export const MAX_RESULTS_PER_SECTION = 8;

/** Prefixes that route a query exclusively to the command provider. */
export const COMMAND_PREFIXES = ['>', '$'];

/** Popup open/close animation durations, in milliseconds. */
export const OPEN_DURATION_MS = 140;
export const CLOSE_DURATION_MS = 100;

/**
 * Background blur strength when "blur background" is on.
 *
 * Brightness is deliberately 1.0 -- no darkening. Shell.BlurEffect paints
 * over the card's whole bounding RECTANGLE and cannot be clipped to its
 * rounded corners (see the launcher section of docs/GNOME_NOTES.md), so
 * the corner regions the rounding excludes always receive the effect's
 * output. Darkening it there is what turned an almost-invisible "slightly
 * blurrier" corner into a visible grey square, and the card's own
 * translucent tint already supplies all the contrast the text needs.
 */
export const BLUR_RADIUS = 48;
export const BLUR_BRIGHTNESS = 1.0;

/** Backdrop dim, independent of blur (blur alone leaves text unreadable). */
export const BACKDROP_OPACITY = 90;

/**
 * How many results Alt+1..Alt+9 can address. Fixed at 9 because that is
 * how many number keys there are; the 0 key is deliberately unused so it
 * stays available for a future "10th result" convention.
 */
export const QUICK_SELECT_COUNT = 9;
