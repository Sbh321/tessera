// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The one data structure every provider produces and the UI consumes.
 *
 * Providers never render and the UI never searches, so this record is the
 * entire contract between them: if something is not expressible here, it
 * belongs in `metadata` (opaque to the UI) rather than in a new provider
 * hook. Keeping it flat and plain also means results are cheap to sort,
 * cap, and discard -- the search pipeline rebuilds the whole list on every
 * keystroke.
 */

/**
 * How a result was activated. Providers decide what each mode means for
 * them and advertise it through `alternateLabel` / `secondaryLabel`, which
 * the popup shows as a hint for the selected row.
 *
 * @enum {string}
 */
export const ActivationMode = {
    /** Enter. */
    DEFAULT: 'default',
    /** Ctrl+Enter -- typically "new instance" / "open prefs". */
    ALTERNATE: 'alternate',
    /** Shift+Enter -- typically "open on a new workspace". */
    SECONDARY: 'secondary',
};

/**
 * The stable identity of a result across searches and sessions. Used as
 * the key for launch history, favorites and row recycling, so it must not
 * embed anything volatile (a window title, a match score, an index).
 *
 * @param {{providerId: string, id: string}} result
 * @returns {string}
 */
export function resultKey(result) {
    return `${result.providerId}:${result.id}`;
}

/**
 * Builds a validated result record.
 *
 * Invalid records are dropped with a warning rather than thrown: a
 * provider bug must degrade to "this one entry is missing" instead of
 * taking down the search (and with it the compositor's key handling)
 * mid-keystroke.
 *
 * @param {object} fields
 * @param {string} fields.providerId owning provider (constants.ProviderId)
 * @param {string} fields.id provider-unique, stable identity
 * @param {string} fields.title primary line
 * @param {function(string): void} fields.activate called with an ActivationMode
 * @param {string} [fields.subtitle] secondary line
 * @param {string} [fields.section] display section; defaults to providerId
 * @param {import('gi://Gio').Icon} [fields.gicon] preferred icon source
 * @param {string} [fields.iconName] fallback themed icon name
 * @param {number} [fields.score] 0..1 relevance from the provider
 * @param {number[]} [fields.positions] matched indexes in `title`
 * @param {string[]} [fields.keywords] extra searchable words (not shown)
 * @param {object} [fields.metadata] opaque provider payload
 * @param {boolean} [fields.pinnable] may be pinned to favorites
 * @param {boolean} [fields.keepOpen] leave the launcher open after
 *   activating. For results that change what the launcher is SHOWING
 *   rather than doing something outside it -- picking a scope filter,
 *   completing a slash command -- where closing would undo the very
 *   thing the user just asked for.
 * @param {string} [fields.display] a prominent, right-aligned value
 *   drawn in large type at the end of the row -- for results whose
 *   POINT is a value rather than a name (an arithmetic answer, and
 *   later a conversion or a count). Purely presentational; the row
 *   falls back to a plain title/subtitle when it is absent.
 * @param {string} [fields.activateLabel] what Enter does, for the
 *   footer hint; defaults to "Open"
 * @param {string} [fields.alternateLabel] hint for Ctrl+Enter
 * @param {string} [fields.secondaryLabel] hint for Shift+Enter
 * @param {function(): void} [fields.remove] Ctrl+Delete handler (history-like results)
 * @returns {object|null}
 */
export function createResult(fields) {
    const {providerId, id, title, activate} = fields;

    if (!providerId || !id || !title || typeof activate !== 'function') {
        console.warn(`tessera: launcher dropped an invalid result from "${providerId ?? 'unknown'}"`);
        return null;
    }

    return {
        providerId,
        id,
        title,
        subtitle: fields.subtitle ?? '',
        section: fields.section ?? providerId,
        gicon: fields.gicon ?? null,
        iconName: fields.iconName ?? null,
        score: fields.score ?? 0.5,
        positions: fields.positions ?? [],
        keywords: fields.keywords ?? [],
        metadata: fields.metadata ?? {},
        display: fields.display ?? '',
        pinnable: fields.pinnable ?? false,
        keepOpen: fields.keepOpen ?? false,
        activateLabel: fields.activateLabel ?? '',
        alternateLabel: fields.alternateLabel ?? '',
        secondaryLabel: fields.secondaryLabel ?? '',
        remove: fields.remove ?? null,
        activate,
    };
}
