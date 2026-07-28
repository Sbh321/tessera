// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ProviderId} from './constants.js';
import {ActivationMode} from './searchResult.js';
import {SearchProvider} from './searchProvider.js';
import {collapseWhitespace, ellipsize} from './utils.js';

const HISTORY_KEY = 'launcher-clipboard-history';
const PINNED_KEY = 'launcher-clipboard-pinned';

// How much of an entry is shown on the row, and the hard ceiling on what
// is stored at all. The ceiling exists because this history lives in
// dconf: a copied 2 MB log file would bloat the user's settings database
// for something no one will ever paste from a launcher row.
const PREVIEW_LENGTH = 120;
const MAX_ENTRY_LENGTH = 10000;

// Mime types that mark a clipboard offer as a secret. Password managers
// set these precisely so that clipboard histories skip them, and honoring
// the convention is the difference between a clipboard history and a
// password logger.
const SECRET_MIME_TYPES = [
    'x-kde-passwordManagerHint',
    'application/x-secret-service',
];

const PREVIEW_WEIGHT = 1.0;
const BODY_WEIGHT = 0.9;

/**
 * Searchable clipboard history.
 *
 * OFF BY DEFAULT, and the only provider that is: a clipboard history is a
 * transcript of everything you copy, kept in dconf in plain text. That is
 * a genuinely useful tool and a genuinely sensitive record, so the user
 * opts in, and three rules limit the blast radius even then:
 *
 *  - offers advertising a password-manager mime type are never recorded;
 *  - nothing is recorded while the session is locked;
 *  - clipboard results are marked `ephemeral`, so the launcher's own
 *    ranking history never stores their text (see searchController).
 *
 * Change detection is event-driven, not polled: Mutter's selection object
 * (`global.display.get_selection()`) emits `owner-changed` whenever the
 * clipboard's owner changes, which is the same signal the shell's own
 * clipboard plumbing uses. The text itself is then read through
 * St.Clipboard, whose async getter is the supported, one-call way to ask
 * for it -- no stream transfers to manage, and no timer running when
 * nothing is being copied.
 */
export class ClipboardProvider extends SearchProvider {
    constructor(context) {
        super(ProviderId.CLIPBOARD, context);

        this._clipboard = St.Clipboard.get_default();
        this._selection = null;
        this._ownerChangedId = null;
        this._settingsChangedId = null;
    }

    get enabled() {
        return this.context.settings.launcherEnableClipboard;
    }

    enable() {
        // Monitoring follows the setting live: turning the feature off
        // must stop the recording immediately, not at the next restart.
        this._settingsChangedId = this.context.settings.gsettings.connect(
            'changed::launcher-enable-clipboard', () => this._syncMonitor());
        this._syncMonitor();
    }

    disable() {
        this._stopMonitor();

        if (this._settingsChangedId !== null) {
            this.context.settings.gsettings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
    }

    query(parsed) {
        const results = [];
        const pinned = new Set(this._pinned);

        for (const text of [...this._pinned, ...this._history]) {
            if (results.some(result => result.id === text))
                continue;

            const preview = this._preview(text);
            const match = this.match(parsed, [
                {key: 'title', text: preview, weight: PREVIEW_WEIGHT},
                {key: 'body', text, weight: BODY_WEIGHT},
            ]);
            if (!match)
                continue;

            results.push(this._entryResult(text, preview, pinned.has(text), match));
        }

        return results;
    }

    _entryResult(text, preview, isPinned, match) {
        return this.createResult({
            id: text,
            title: preview,
            subtitle: isPinned
                ? _('Pinned · Enter to copy')
                : _('%d characters · Enter to copy').format(text.length),
            iconName: isPinned ? 'starred-symbolic' : 'edit-paste-symbolic',
            score: match.score,
            positions: match.positions,
            // Never pinnable through the shared favorites list: that list
            // stores result keys, and a key here IS the copied text.
            pinnable: false,
            metadata: {ephemeral: true},
            alternateLabel: isPinned ? _('Unpin') : _('Pin'),
            activate: mode => this._activate(text, mode),
            remove: () => this._forget(text),
        });
    }

    _activate(text, mode) {
        if (mode === ActivationMode.ALTERNATE) {
            this._togglePin(text);
            return;
        }
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    }

    // --- Monitoring -------------------------------------------------------

    _syncMonitor() {
        if (this.enabled)
            this._startMonitor();
        else
            this._stopMonitor();
    }

    _startMonitor() {
        if (this._ownerChangedId !== null)
            return;

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect(
            'owner-changed', (selection, type) => this._onOwnerChanged(selection, type));
    }

    _stopMonitor() {
        if (this._ownerChangedId !== null) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = null;
        }
        this._selection = null;
    }

    _onOwnerChanged(selection, type) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;

        // Nothing copied on the lock screen is ours to remember.
        if (Main.sessionMode.isLocked)
            return;

        if (this._offersSecret(selection))
            return;

        this._clipboard.get_text(St.ClipboardType.CLIPBOARD,
            (clipboard, text) => this._record(text));
    }

    _offersSecret(selection) {
        try {
            const mimeTypes = selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD);
            return mimeTypes.some(mimeType =>
                SECRET_MIME_TYPES.some(secret => mimeType.includes(secret)));
        } catch (error) {
            // If the offer cannot be inspected, err towards recording
            // nothing rather than towards recording a secret.
            return true;
        }
    }

    _record(text) {
        if (!text)
            return;

        const trimmed = text.trim();
        if (trimmed.length === 0 || text.length > MAX_ENTRY_LENGTH)
            return;

        // Move-to-front rather than append: re-copying something is a
        // statement about what matters now.
        const next = [text, ...this._history.filter(entry => entry !== text)]
            .slice(0, this.context.settings.launcherClipboardSize);
        this.context.settings.gsettings.set_strv(HISTORY_KEY, next);
    }

    _forget(text) {
        const gsettings = this.context.settings.gsettings;
        gsettings.set_strv(HISTORY_KEY, this._history.filter(entry => entry !== text));
        gsettings.set_strv(PINNED_KEY, this._pinned.filter(entry => entry !== text));
    }

    _togglePin(text) {
        const gsettings = this.context.settings.gsettings;
        const pinned = this._pinned;

        if (pinned.includes(text))
            gsettings.set_strv(PINNED_KEY, pinned.filter(entry => entry !== text));
        else
            gsettings.set_strv(PINNED_KEY, [...pinned, text]);
    }

    _preview(text) {
        return ellipsize(collapseWhitespace(text), PREVIEW_LENGTH);
    }

    get _history() {
        return this.context.settings.gsettings.get_strv(HISTORY_KEY);
    }

    get _pinned() {
        return this.context.settings.gsettings.get_strv(PINNED_KEY);
    }
}
