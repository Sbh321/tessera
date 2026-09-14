// SPDX-License-Identifier: GPL-2.0-or-later

import {MODULES, SETTINGS_KEY, resolveSettings} from './modules/registry.js';
import * as tabs from './modules/tabs/module.js';

/**
 * Tessera Companion's module host.
 *
 * The companion is one extension made of independent modules, each in
 * its own folder under modules/. This file owns nothing but the wiring:
 * it reads which modules the user has turned on, tells each module,
 * follows changes to that setting, and answers the options page's
 * status requests. Modules register their own browser listeners at
 * import time -- a Manifest V3 service worker is woken for an event
 * only when the listener already exists -- and gate them on the enabled
 * flag the host hands them.
 */
const IMPLEMENTATIONS = {
    [tabs.id]: tabs,
};

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[SETTINGS_KEY])
        applySettings(changes[SETTINGS_KEY].newValue);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'status')
        return false;
    const status = {};
    for (const module of MODULES)
        status[module.id] = IMPLEMENTATIONS[module.id]?.status() ?? null;
    sendResponse(status);
    return false;
});

chrome.runtime.onInstalled.addListener(() => {
    // Opening the options page once on first install is the whole
    // onboarding: it says what the modules do and links to Tessera.
    void chrome.runtime.openOptionsPage?.();
});

void (async () => {
    const stored = await chrome.storage.sync.get(SETTINGS_KEY);
    applySettings(stored[SETTINGS_KEY]);
})();

function applySettings(stored) {
    const settings = resolveSettings(stored);
    for (const module of MODULES)
        void IMPLEMENTATIONS[module.id]?.setEnabled(settings[module.id]);
}
