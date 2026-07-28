// SPDX-License-Identifier: GPL-2.0-or-later

import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ProviderId} from './constants.js';
import {SearchProvider} from './searchProvider.js';
import {alternateForms, evaluate, formatValue} from './calculatorEngine.js';
import {collapseWhitespace} from './utils.js';

/**
 * Inline arithmetic: type an expression, see the answer, press Enter to
 * copy it.
 *
 * All the arithmetic lives in calculatorEngine.js (pure, testable); this
 * file is only the provider seam -- detection, presentation, clipboard,
 * and the one piece of state a calculator needs: `ans`, the previous
 * answer, so results can be chained ("ans * 2"). That memory is
 * session-scoped on purpose; a stale number surviving a reboot would be
 * a confusing thing to silently substitute into an expression.
 */
export class CalculatorProvider extends SearchProvider {
    constructor(context) {
        super(ProviderId.CALCULATOR, context);
        this._lastAnswer = null;
    }

    get enabled() {
        return this.context.settings.launcherEnableCalculator;
    }

    disable() {
        this._lastAnswer = null;
    }

    query(parsed) {
        const variables = this._lastAnswer === null ? {} : {ans: this._lastAnswer};
        const evaluation = evaluate(parsed.trimmed, variables);

        // A bare number is not a question. Answering "5" with "= 5"
        // would push a real result off the top of the list on every
        // numeric query (a port number, a workspace number, a version).
        if (!evaluation || evaluation.isTrivial)
            return [];

        const text = formatValue(evaluation.value);
        const forms = alternateForms(evaluation.value);

        return [this.createResult({
            // Keyed by the expression, so repeatedly evaluating the same
            // thing does not fragment launch history.
            id: parsed.trimmed,
            // Expression on the left, answer large on the right. The row
            // then reads as the question you asked and the answer to it,
            // rather than as a result whose name happens to be a number
            // -- and the answer, which is the whole point, is the biggest
            // thing on screen instead of ordinary title text.
            title: collapseWhitespace(parsed.trimmed),
            subtitle: forms.join('   ·   '),
            display: `= ${text}`,
            iconName: 'accessories-calculator-symbolic',
            score: 1,
            metadata: {value: evaluation.value},
            activateLabel: _('Copy'),
            activate: () => this._copy(evaluation.value, text),
        })];
    }

    _copy(value, text) {
        this._lastAnswer = value;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        Main.notify(_('Tessera'), _('Copied %s to the clipboard').format(text));
    }
}
