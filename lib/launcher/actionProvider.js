// SPDX-License-Identifier: GPL-2.0-or-later

import Shell from 'gi://Shell';
import Meta from 'gi://Meta';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ProviderId} from './constants.js';
import {SearchProvider} from './searchProvider.js';
import {matchText} from './fuzzyMatcher.js';

const TITLE_WEIGHT = 1.0;
const KEYWORD_WEIGHT = 0.8;
const SUBTITLE_WEIGHT = 0.45;

// Uniform score while browsing the filtered section; see
// SearchProvider.browseResults().
const BROWSE_SCORE = 0.5;

// Words that introduce a workspace command. Kept short and unambiguous;
// they only take effect when followed by a number, so an app called
// "Workspace Manager" is still found by typing its name.
const WORKSPACE_WORDS = new Set(['workspace', 'ws', 'w']);
const MOVE_WORDS = new Set(['move', 'send', 'throw']);

/**
 * Parses Tessera's workspace mini-grammar out of a query.
 *
 * Pure, and deliberately conservative: every form requires a literal
 * workspace NUMBER, so ordinary searches can never be swallowed by it.
 *
 *   workspace 5 / ws 5 / w 5   switch to workspace 5
 *   move 4                     move the focused window to workspace 4
 *   move firefox 4             move Firefox's window to workspace 4
 *
 * @param {string[]} terms normalized query terms
 * @returns {?{kind: string, index: number, appTerms: string[]}}
 *   `index` is 0-based; null when the query is not a workspace command.
 */
function parseWorkspaceCommand(terms) {
    if (terms.length < 2)
        return null;

    const asIndex = term => {
        if (!/^\d+$/.test(term))
            return null;
        const number = Number.parseInt(term, 10);
        // 1-based in the grammar, matching the panel indicator's labels
        // and the Super+N keybindings.
        return number >= 1 ? number - 1 : null;
    };

    const [head, ...rest] = terms;

    if (WORKSPACE_WORDS.has(head) && rest.length === 1) {
        const index = asIndex(rest[0]);
        return index === null ? null : {kind: 'switch', index, appTerms: []};
    }

    if (MOVE_WORDS.has(head) && rest.length >= 1) {
        const index = asIndex(rest[rest.length - 1]);
        if (index === null)
            return null;
        return {kind: 'move', index, appTerms: rest.slice(0, -1)};
    }

    return null;
}

/**
 * Everything Tessera and the session can *do*, made searchable.
 *
 * Two kinds of result share this provider because they are one idea to
 * the user -- "tell the launcher to do something":
 *
 *  - the static catalogue from actionRegistry.js, matched by title,
 *    keywords and description;
 *  - a tiny argument-taking grammar ("workspace 5", "move firefox 4")
 *    that no fixed catalogue could express, because the argument is part
 *    of the request.
 *
 * The grammar is what makes the launcher a peer of Tessera's keybindings
 * rather than a separate world: it reaches workspaces 10 and up, which
 * Super+1..9 cannot address at all.
 */
export class ActionProvider extends SearchProvider {
    /**
     * @param {object} context launcher context
     * @param {import('./actionRegistry.js').ActionRegistry} registry
     */
    constructor(context, registry) {
        super(ProviderId.ACTIONS, context);
        this._registry = registry;
        this._tracker = Shell.WindowTracker.get_default();
    }

    query(parsed) {
        const results = [];

        for (const action of this._registry.actions) {
            const match = this.match(parsed, this._fieldsFor(action));
            if (match)
                results.push(this._actionResult(action, match.score, match.positions));
        }

        const command = parseWorkspaceCommand(parsed.terms);
        if (command)
            results.push(...this._commandResults(command));

        return results;
    }

    /**
     * The whole catalogue, in registry order -- system actions, then
     * shell, then Tessera's own. That grouping is meaningful, so it is
     * kept rather than re-sorted alphabetically into one flat jumble.
     */
    browseResults() {
        return this._registry.actions
            .map(action => this._actionResult(action, BROWSE_SCORE, []));
    }

    browseCount() {
        return this._registry.actions.length;
    }

    resultForKey(id) {
        const action = this._registry.find(id);
        return action ? this._actionResult(action, 1, []) : null;
    }

    _fieldsFor(action) {
        return [
            {key: 'title', text: action.title, weight: TITLE_WEIGHT},
            {key: 'keywords', text: action.keywords.join(' '), weight: KEYWORD_WEIGHT},
            {key: 'subtitle', text: this._subtitleOf(action), weight: SUBTITLE_WEIGHT},
        ];
    }

    // A toggle's subtitle reports its current state, so it is resolved
    // per query rather than baked in when the catalogue is built.
    _subtitleOf(action) {
        return typeof action.subtitle === 'function' ? action.subtitle() : action.subtitle;
    }

    _actionResult(action, score, positions) {
        return this.createResult({
            id: action.id,
            title: action.title,
            subtitle: this._subtitleOf(action),
            iconName: action.iconName,
            score,
            positions,
            pinnable: true,
            activate: () => action.run(),
        });
    }

    // --- Workspace grammar ------------------------------------------------

    _commandResults(command) {
        const workspaceManager = global.workspace_manager;
        const workspace = workspaceManager.get_workspace_by_index(command.index);
        if (!workspace)
            return [];

        const label = `${_('Workspace')} ${command.index + 1}`;

        if (command.kind === 'switch') {
            return [this.createResult({
                id: `switch-workspace-${command.index}`,
                title: _('Switch to %s').format(label),
                subtitle: this._describeWorkspace(workspace),
                iconName: 'view-grid-symbolic',
                score: 1,
                activate: () => workspace.activate(global.get_current_time()),
            })];
        }

        if (command.appTerms.length === 0) {
            return [this.createResult({
                id: `move-focused-${command.index}`,
                title: _('Move the focused window to %s').format(label),
                subtitle: this._describeWorkspace(workspace),
                iconName: 'go-next-symbolic',
                score: 1,
                activate: () => this.context.tessera.windowMover.moveFocusedToWorkspace(
                    command.index, this.context.targetWindow()),
            })];
        }

        return this._moveAppResults(command, workspace, label);
    }

    // "move firefox 4": the app name is fuzzy-matched against the windows
    // that actually exist, so it can only ever resolve to something
    // movable -- and offers each candidate window rather than guessing
    // when several match.
    _moveAppResults(command, workspace, label) {
        const needle = command.appTerms.join(' ');

        return global.display
            .get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .filter(window => !window.is_skip_taskbar() && !window.is_on_all_workspaces())
            .map(window => {
                const app = this._tracker.get_window_app(window);
                const candidates = [app?.get_name(), window.get_wm_class(), window.get_title()];
                let best = 0;
                for (const candidate of candidates) {
                    const match = candidate ? matchText(needle, candidate) : null;
                    if (match && match.score > best)
                        best = match.score;
                }
                return {window, app, score: best};
            })
            // Only confident matches: a subsequence-grade hit on a window
            // title would move the wrong window, which is not a mistake
            // worth being clever about.
            .filter(entry => entry.score >= 0.6 && entry.window.get_workspace() !== workspace)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(entry => this.createResult({
                id: `move-w${entry.window.get_stable_sequence()}-${command.index}`,
                title: _('Move %s to %s').format(
                    entry.app?.get_name() ?? entry.window.get_title() ?? _('window'), label),
                subtitle: entry.window.get_title() ?? '',
                gicon: entry.app?.get_icon() ?? null,
                iconName: 'go-next-symbolic',
                score: entry.score,
                activate: () => this.context.tessera.windowMover.moveToWorkspace(
                    entry.window, command.index),
            }));
    }

    _describeWorkspace(workspace) {
        const count = workspace.list_windows()
            .filter(window => !window.is_skip_taskbar()).length;
        if (count === 0)
            return _('Empty');
        return count === 1
            ? _('1 window')
            : _('%d windows').format(count);
    }
}
