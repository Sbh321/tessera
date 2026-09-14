// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Preferences-side installer for the Native Messaging relay, run
// against a throwaway config root and a fake extension directory.
//
//     gjs -m tests/browser-integration-test.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Integration from '../lib/browserIntegration.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function read(path) {
    return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
}

const scratch = GLib.dir_make_tmp('tessera-integration-XXXXXX');
const configRoot = GLib.build_filenamev([scratch, 'config']);
const extensionDir = GLib.build_filenamev([scratch, 'extension']);
GLib.mkdir_with_parents(GLib.build_filenamev([extensionDir, 'native-host']), 0o755);
GLib.mkdir_with_parents(GLib.build_filenamev([configRoot, 'BraveSoftware', 'Brave-Browser']), 0o755);

const relay = Integration.relayPath(extensionDir);
GLib.file_set_contents(relay, '#!/bin/sh\n');
GLib.chmod(relay, 0o644);

assert(!Integration.status(extensionDir, configRoot).installed, 'nothing installed initially');
assert(Integration.targetBrowsers(configRoot).map(b => b.id).join(',') === 'google-chrome,chromium,brave',
    'targets are the always-on browsers plus installed ones');

const registered = Integration.install(extensionDir, configRoot);
assert(registered.join(',') === 'Google Chrome,Chromium,Brave', `registered ${registered}`);

const chrome = read(Integration.manifestPath(Integration.BROWSERS[0], configRoot));
assert(chrome.name === Integration.HOST_NAME, 'manifest names the host');
assert(chrome.path === relay, 'manifest points at the relay inside the extension directory');
assert(chrome.type === 'stdio', 'stdio host');
assert(chrome.allowed_origins[0] === `chrome-extension://${Integration.COMPANION_EXTENSION_ID}/`,
    'allow-list names the companion');
assert(!GLib.file_test(Integration.manifestPath(Integration.BROWSERS.find(b => b.id === 'vivaldi'), configRoot), GLib.FileTest.EXISTS),
    'a browser that is not installed gets no manifest');

const info = Gio.File.new_for_path(relay).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
assert((info.get_attribute_uint32('unix::mode') & 0o111) === 0o111, 'the relay was made executable');

let state = Integration.status(extensionDir, configRoot);
assert(state.installed && state.current && state.browsers.length === 3, 'status reports the install');

// A manifest from an older location is reported as stale, and a
// reinstall rewrites it in place.
GLib.file_set_contents(Integration.manifestPath(Integration.BROWSERS[1], configRoot),
    JSON.stringify({name: Integration.HOST_NAME, path: '/old/place', type: 'stdio', allowed_origins: []}));
state = Integration.status(extensionDir, configRoot);
assert(state.installed && !state.current, 'a manifest pointing elsewhere is reported as stale');
Integration.install(extensionDir, configRoot);
assert(Integration.status(extensionDir, configRoot).current, 'reinstalling makes it current again');

// Foreign manifests with our file name but another host are not ours.
GLib.file_set_contents(Integration.manifestPath(Integration.BROWSERS[0], configRoot),
    JSON.stringify({name: 'someone.else', path: '/x'}));
assert(!Integration.status(extensionDir, configRoot).browsers.includes('Google Chrome'),
    'a manifest for another host is not counted');

Integration.uninstall(configRoot);
assert(!Integration.status(extensionDir, configRoot).installed, 'uninstall removes the manifests');
assert(!GLib.file_test(Integration.manifestPath(Integration.BROWSERS[1], configRoot), GLib.FileTest.EXISTS),
    'manifest file is gone');
assert(GLib.file_test(relay, GLib.FileTest.EXISTS), 'the relay itself is untouched');

Gio.File.new_for_path(scratch).trash?.(null) ?? null;
print('browser-integration: install, status and uninstall passed');
