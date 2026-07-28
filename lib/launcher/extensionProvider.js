// SPDX-License-Identifier: GPL-2.0-or-later

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {ProviderId} from './constants.js';
import {ActivationMode} from './searchResult.js';
import {SearchProvider} from './searchProvider.js';

const NAME_WEIGHT = 1.0;
const DESCRIPTION_WEIGHT = 0.5;

/**
 * Installed GNOME Shell extensions: enable, disable, or open preferences
 * without a detour through the Extensions app.
 *
 * Read live from `Main.extensionManager` on every query rather than
 * cached, because state is exactly what the user is here to change --
 * a cache would show "Enabled" on the row they just disabled.
 *
 * Enabling and disabling go through ExtensionManager, which rewrites
 * GNOME's own enabled-extensions / disabled-extensions lists, so the
 * change persists and behaves identically to the Extensions app's switch.
 */
export class ExtensionProvider extends SearchProvider {
    constructor(context) {
        super(ProviderId.EXTENSIONS, context);
    }

    query(parsed) {
        const results = [];

        for (const uuid of Main.extensionManager.getUuids()) {
            const extension = Main.extensionManager.lookup(uuid);
            if (!extension?.metadata)
                continue;

            const fields = [
                {key: 'title', text: extension.metadata.name ?? uuid, weight: NAME_WEIGHT},
                {
                    key: 'description',
                    text: extension.metadata.description ?? '',
                    weight: DESCRIPTION_WEIGHT,
                },
            ];

            const match = this.match(parsed, fields);
            if (match)
                results.push(this._extensionResult(extension, match.score, match.positions));
        }

        return results;
    }

    resultForKey(uuid) {
        const extension = Main.extensionManager.lookup(uuid);
        return extension ? this._extensionResult(extension, 1, []) : null;
    }

    _extensionResult(extension, score, positions) {
        const isActive = extension.state === ExtensionState.ACTIVE;
        const name = extension.metadata.name ?? extension.uuid;

        return this.createResult({
            id: extension.uuid,
            title: name,
            subtitle: isActive
                ? _('Enabled · Enter to disable')
                : _('Disabled · Enter to enable'),
            iconName: 'application-x-addon-symbolic',
            score,
            positions,
            pinnable: true,
            alternateLabel: extension.hasPrefs ? _('Extension settings') : '',
            activate: mode => this._activate(extension, isActive, mode),
        });
    }

    _activate(extension, isActive, mode) {
        if (mode === ActivationMode.ALTERNATE && extension.hasPrefs) {
            Main.extensionManager.openExtensionPrefs(extension.uuid, '', {});
            return;
        }

        if (isActive)
            Main.extensionManager.disableExtension(extension.uuid);
        else
            Main.extensionManager.enableExtension(extension.uuid);
    }
}
