// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The companion's modules, as the options page and the module host see
 * them: metadata only, no browser listeners, so this file is safe to
 * import from any context. Each module's code lives in
 * modules/<id>/module.js and exports `id`, `setEnabled(bool)` and
 * `status()`; the host in background.js wires the two together.
 *
 * Adding a module: a folder with a module.js, one entry here, and the
 * permissions it needs in manifest.json. Nothing else changes.
 */
export const MODULES = Object.freeze([
    Object.freeze({
        id: 'tabs',
        name: 'Launcher tabs',
        description: 'Lets the Tessera launcher on this computer show, search and switch ' +
            'to this browser’s tabs. Needs Tessera’s browser integration turned on ' +
            'in its Preferences.',
        defaultEnabled: true,
    }),
]);

export const SETTINGS_KEY = 'modules';

/** @returns {Object<string, boolean>} module id -> enabled, with defaults filled in */
export function resolveSettings(stored) {
    const settings = {};
    for (const module of MODULES)
        settings[module.id] = typeof stored?.[module.id] === 'boolean' ? stored[module.id] : module.defaultEnabled;
    return settings;
}
