// SPDX-License-Identifier: GPL-2.0-or-later

import {MODULES, SETTINGS_KEY, resolveSettings} from './modules/registry.js';

const container = document.getElementById('modules');
const rows = new Map();

for (const module of MODULES) {
    const row = document.createElement('label');
    row.className = 'module';

    const title = document.createElement('strong');
    title.textContent = module.name;
    const description = document.createElement('p');
    description.textContent = module.description;
    const status = document.createElement('p');
    status.className = 'status';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.addEventListener('change', () => save());

    row.append(title, toggle, description, status);
    container.append(row);
    rows.set(module.id, {toggle, status});
}

async function load() {
    const stored = await chrome.storage.sync.get(SETTINGS_KEY);
    const settings = resolveSettings(stored[SETTINGS_KEY]);
    for (const module of MODULES)
        rows.get(module.id).toggle.checked = settings[module.id];
    await refreshStatus();
}

async function save() {
    const settings = {};
    for (const module of MODULES)
        settings[module.id] = rows.get(module.id).toggle.checked;
    await chrome.storage.sync.set({[SETTINGS_KEY]: settings});
    setTimeout(refreshStatus, 400);
}

async function refreshStatus() {
    let status = {};
    try {
        status = await chrome.runtime.sendMessage({type: 'status'}) ?? {};
    } catch (_error) {
        // The service worker is starting; the next refresh will get it.
    }
    for (const module of MODULES) {
        const element = rows.get(module.id).status;
        const state = status[module.id];
        if (!state?.enabled) {
            element.textContent = 'Off';
            element.className = 'status off';
        } else if (state.connected) {
            element.textContent = `Connected to Tessera as ${state.browserName}`;
            element.className = 'status on';
        } else {
            element.textContent = 'On, waiting for Tessera (is its browser integration turned on?)';
            element.className = 'status off';
        }
    }
}

void load();
setInterval(refreshStatus, 3000);
