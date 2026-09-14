// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Registers Tessera's Native Messaging relay with the Chromium-family
 * browsers on this machine, so Tessera Companion can start it.
 *
 * Runs in the Preferences process (prefs.js), on the user's explicit
 * toggle -- the one time this extension writes outside its own
 * directory and its own settings schema. What it writes is exactly one
 * small JSON manifest per browser, naming the relay INSIDE the
 * extension directory (nothing is copied anywhere), and it removes
 * exactly those files again. The same shape GSConnect has shipped on
 * extensions.gnome.org for years.
 *
 * No GNOME Shell imports: usable from prefs.js and testable under gjs.
 */

export const HOST_NAME = 'io.github.sbh321.tessera.browser_tabs';

/** Fixed by the companion manifest's public key; see companion/manifest.json. */
export const COMPANION_EXTENSION_ID = 'dcalnkplbhcblhdidppkmgoooggflphg';

/** Where the companion will live once published. */
export const COMPANION_STORE_URL =
    `https://chromewebstore.google.com/detail/${COMPANION_EXTENSION_ID}`;

export const RELAY_RELATIVE_PATH = 'native-host/tessera-browser-host';

/**
 * Chromium-family browsers and where each keeps its user-level Native
 * Messaging manifests (relative to the XDG config directory). Chrome
 * and Chromium are always registered; the rest only when their config
 * directory exists, so nothing is littered for browsers not installed.
 */
export const BROWSERS = Object.freeze([
    {id: 'google-chrome', name: 'Google Chrome', configDir: 'google-chrome', always: true},
    {id: 'chromium', name: 'Chromium', configDir: 'chromium', always: true},
    {id: 'google-chrome-beta', name: 'Google Chrome Beta', configDir: 'google-chrome-beta', always: false},
    {id: 'google-chrome-unstable', name: 'Google Chrome Dev', configDir: 'google-chrome-unstable', always: false},
    {id: 'brave', name: 'Brave', configDir: 'BraveSoftware/Brave-Browser', always: false},
    {id: 'microsoft-edge', name: 'Microsoft Edge', configDir: 'microsoft-edge', always: false},
    {id: 'vivaldi', name: 'Vivaldi', configDir: 'vivaldi', always: false},
]);

export function relayPath(extensionDir) {
    return GLib.build_filenamev([extensionDir, RELAY_RELATIVE_PATH]);
}

export function manifestPath(browser, configRoot = GLib.get_user_config_dir()) {
    return GLib.build_filenamev([configRoot, browser.configDir, 'NativeMessagingHosts', `${HOST_NAME}.json`]);
}

/** Browsers that should get a manifest: the two always-on ones plus any installed. */
export function targetBrowsers(configRoot = GLib.get_user_config_dir()) {
    return BROWSERS.filter(browser => browser.always ||
        GLib.file_test(GLib.build_filenamev([configRoot, browser.configDir]), GLib.FileTest.IS_DIR));
}

/**
 * The current state, for the Preferences switch.
 *
 * @returns {{installed: boolean, browsers: string[], current: boolean}}
 *   `browsers` names those with a manifest; `current` is false when a
 *   manifest points somewhere other than this extension's relay (an
 *   older install or a moved extension directory) and needs rewriting
 */
export function status(extensionDir, configRoot = GLib.get_user_config_dir()) {
    const relay = relayPath(extensionDir);
    const browsers = [];
    let current = true;
    for (const browser of BROWSERS) {
        const manifest = readManifest(manifestPath(browser, configRoot));
        if (!manifest)
            continue;
        browsers.push(browser.name);
        if (manifest.path !== relay)
            current = false;
    }
    return {installed: browsers.length > 0, browsers, current};
}

/**
 * Writes the manifests and makes the relay executable.
 *
 * The executable bit matters: an extension zip installed by
 * gnome-extensions does not reliably preserve file modes, and a browser
 * refuses a host it cannot execute.
 *
 * @returns {string[]} the names of the browsers registered
 */
export function install(extensionDir, configRoot = GLib.get_user_config_dir()) {
    const relay = relayPath(extensionDir);
    const relayFile = Gio.File.new_for_path(relay);
    if (!relayFile.query_exists(null))
        throw new Error(`relay not found at ${relay}`);
    relayFile.set_attribute_uint32('unix::mode', 0o755, Gio.FileQueryInfoFlags.NONE, null);

    const manifest = JSON.stringify({
        name: HOST_NAME,
        description: 'Relay between Tessera Companion and the Tessera GNOME Shell extension',
        path: relay,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${COMPANION_EXTENSION_ID}/`],
    }, null, 2);

    const registered = [];
    for (const browser of targetBrowsers(configRoot)) {
        const file = Gio.File.new_for_path(manifestPath(browser, configRoot));
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw error;
        }
        file.replace_contents(`${manifest}\n`, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        registered.push(browser.name);
    }
    return registered;
}

/** Removes every manifest install() may have written; nothing else. */
export function uninstall(configRoot = GLib.get_user_config_dir()) {
    for (const browser of BROWSERS) {
        const file = Gio.File.new_for_path(manifestPath(browser, configRoot));
        try {
            file.delete(null);
        } catch (_error) {
            // Not there; nothing to remove.
        }
    }
}

function readManifest(path) {
    try {
        const [, contents] = GLib.file_get_contents(path);
        const manifest = JSON.parse(new TextDecoder().decode(contents));
        return manifest?.name === HOST_NAME ? manifest : null;
    } catch (_error) {
        return null;
    }
}
