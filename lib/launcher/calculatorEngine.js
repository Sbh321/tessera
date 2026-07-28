// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * A small, safe arithmetic evaluator: tokenizer + recursive-descent
 * parser, no `eval()` and no Function constructor anywhere.
 *
 * Split out of calculatorProvider.js purely so it stays free of GNOME
 * imports and can therefore be unit-tested outside the shell
 * (tests/launcher-engine-test.js) -- the same reason
 * lib/tiling/layoutEngine.js is separate from tilingManager.js.
 *
 * Grammar:
 *
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/' | 'mod') unary)*
 *   unary      := ('-' | '+') unary | power
 *   power      := postfix ('^' unary)?          right-associative
 *   postfix    := primary '%'?
 *   primary    := number | constant | ident '(' args ')' | '(' expression ')'
 *
 * Deliberate design choices, both because this serves a *launcher* rather
 * than a spreadsheet:
 *
 *  - Trigonometry works in DEGREES (`sin(90)` is 1), which is what
 *    someone typing into a search box means. The radian forms are
 *    available as `sinr`/`cosr`/`tanr`.
 *  - `%` is a percentage, not a modulo: `15%` is 0.15, `200 + 15%` is
 *    230, and `200 * 15%` is 30 -- the behaviour of every pocket
 *    calculator. Modulo is spelled `mod`.
 */

const CONSTANTS = {
    pi: Math.PI,
    π: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
};

const toRadians = degrees => degrees * Math.PI / 180;
const toDegrees = radians => radians * 180 / Math.PI;

const FUNCTIONS = {
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    abs: Math.abs,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    trunc: Math.trunc,
    sign: Math.sign,
    exp: Math.exp,
    ln: Math.log,
    log: Math.log10,
    log2: Math.log2,
    log10: Math.log10,
    sin: value => Math.sin(toRadians(value)),
    cos: value => Math.cos(toRadians(value)),
    tan: value => Math.tan(toRadians(value)),
    asin: value => toDegrees(Math.asin(value)),
    acos: value => toDegrees(Math.acos(value)),
    atan: value => toDegrees(Math.atan(value)),
    sinr: Math.sin,
    cosr: Math.cos,
    tanr: Math.tan,
    min: Math.min,
    max: Math.max,
    pow: Math.pow,
    hypot: Math.hypot,
};

// Functions taking more than one argument; everything else is arity 1 and
// rejects extra arguments, so `sqrt(4, 9)` is an error rather than a
// silently ignored typo.
const VARIADIC_FUNCTIONS = new Set(['min', 'max', 'pow', 'hypot']);

class ParseError extends Error {}

/**
 * Splits the input into tokens.
 *
 * @param {string} input
 * @returns {Array<{type: string, value: (number|string)}>}
 * @throws {ParseError} on any character the grammar does not define --
 *   which is what keeps a stray backtick or semicolon from ever being
 *   silently skipped.
 */
function tokenize(input) {
    const tokens = [];
    let index = 0;

    while (index < input.length) {
        const character = input[index];

        if (/\s/.test(character)) {
            index++;
            continue;
        }

        if (/[0-9.]/.test(character)) {
            const rest = input.slice(index);
            // Base-prefixed integers first, so the "0" of 0x1f is never
            // consumed as a decimal number on its own.
            const based = /^0([xbo])([0-9a-f]+)/i.exec(rest);
            if (based) {
                const radix = {x: 16, b: 2, o: 8}[based[1].toLowerCase()];
                const value = parseInt(based[2], radix);
                if (Number.isNaN(value))
                    throw new ParseError('bad literal');
                // Flagged so a bare "0xff" still answers 255: converting
                // a base literal IS the operation the user asked for,
                // even though no operator was typed.
                tokens.push({type: 'number', value, based: true});
                index += based[0].length;
                continue;
            }

            const decimal = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(rest);
            if (!decimal)
                throw new ParseError('bad number');
            tokens.push({type: 'number', value: Number.parseFloat(decimal[0])});
            index += decimal[0].length;
            continue;
        }

        if (/[a-zπ]/i.test(character)) {
            const word = /^[a-zπ][a-z0-9π]*/i.exec(input.slice(index))[0];
            tokens.push({type: 'identifier', value: word.toLowerCase()});
            index += word.length;
            continue;
        }

        if ('+-*/^%(),'.includes(character)) {
            tokens.push({type: character});
            index++;
            continue;
        }

        // Typographic operators people paste in from documents.
        if (character === '×' || character === '·') {
            tokens.push({type: '*'});
            index++;
            continue;
        }
        if (character === '÷') {
            tokens.push({type: '/'});
            index++;
            continue;
        }
        if (character === '−') {
            tokens.push({type: '-'});
            index++;
            continue;
        }

        throw new ParseError(`unexpected character "${character}"`);
    }

    return tokens;
}

class Parser {
    constructor(tokens, variables) {
        this._tokens = tokens;
        this._position = 0;
        this._variables = variables;
        /** Set when anything beyond a bare literal is seen. */
        this.sawOperation = false;
    }

    parse() {
        const value = this._expression();
        if (this._position < this._tokens.length)
            throw new ParseError('trailing input');
        return value;
    }

    _peek() {
        return this._tokens[this._position];
    }

    _take(type) {
        const token = this._peek();
        if (!token || token.type !== type)
            throw new ParseError(`expected ${type}`);
        this._position++;
        return token;
    }

    _expression() {
        let left = this._term();

        for (;;) {
            const token = this._peek();
            if (!token || (token.type !== '+' && token.type !== '-'))
                return left;
            this._position++;
            this.sawOperation = true;

            const right = this._term();
            // "200 + 15%" means 15% OF 200, the pocket-calculator rule.
            const delta = right.isPercent ? left.value * right.value / 100 : right.value;
            left = {value: token.type === '+' ? left.value + delta : left.value - delta};
        }
    }

    _term() {
        let left = this._unary();

        for (;;) {
            const token = this._peek();
            const isMod = token?.type === 'identifier' && token.value === 'mod';
            // "of" reads as multiplication: "15% of 200".
            const isOf = token?.type === 'identifier' && token.value === 'of';

            if (!token || (token.type !== '*' && token.type !== '/' && !isMod && !isOf))
                return left;

            this._position++;
            this.sawOperation = true;

            const right = this._unary();
            const rightValue = right.isPercent ? right.value / 100 : right.value;
            const leftValue = left.isPercent ? left.value / 100 : left.value;

            if (token.type === '/')
                left = {value: leftValue / rightValue};
            else if (isMod)
                left = {value: leftValue % rightValue};
            else
                left = {value: leftValue * rightValue};
        }
    }

    _unary() {
        const token = this._peek();
        if (token?.type === '-') {
            this._position++;
            this.sawOperation = true;
            const operand = this._unary();
            return {value: -operand.value, isPercent: operand.isPercent};
        }
        if (token?.type === '+') {
            this._position++;
            return this._unary();
        }
        return this._power();
    }

    _power() {
        const base = this._postfix();
        if (this._peek()?.type !== '^')
            return base;

        this._position++;
        this.sawOperation = true;
        // Right-associative: 2^3^2 is 2^(3^2).
        const exponent = this._unary();
        return {value: Math.pow(base.value, exponent.value)};
    }

    _postfix() {
        const primary = this._primary();
        if (this._peek()?.type === '%') {
            this._position++;
            this.sawOperation = true;
            return {value: primary.value, isPercent: true};
        }
        return primary;
    }

    _primary() {
        const token = this._peek();
        if (!token)
            throw new ParseError('unexpected end');

        if (token.type === 'number') {
            this._position++;
            if (token.based)
                this.sawOperation = true;
            return {value: token.value};
        }

        if (token.type === '(') {
            this._position++;
            const inner = this._expression();
            this._take(')');
            this.sawOperation = true;
            return {value: inner.isPercent ? inner.value / 100 : inner.value};
        }

        if (token.type === 'identifier') {
            this._position++;
            const name = token.value;

            if (this._peek()?.type === '(') {
                const handler = FUNCTIONS[name];
                if (!handler)
                    throw new ParseError(`unknown function ${name}`);
                this._position++;
                const args = [this._argumentValue()];
                while (this._peek()?.type === ',') {
                    this._position++;
                    args.push(this._argumentValue());
                }
                this._take(')');
                if (args.length > 1 && !VARIADIC_FUNCTIONS.has(name))
                    throw new ParseError(`${name} takes one argument`);
                this.sawOperation = true;
                return {value: handler(...args)};
            }

            if (name in CONSTANTS) {
                this.sawOperation = true;
                return {value: CONSTANTS[name]};
            }

            if (this._variables && name in this._variables) {
                this.sawOperation = true;
                return {value: this._variables[name]};
            }

            throw new ParseError(`unknown name ${name}`);
        }

        throw new ParseError(`unexpected token ${token.type}`);
    }

    _argumentValue() {
        const argument = this._expression();
        return argument.isPercent ? argument.value / 100 : argument.value;
    }
}

/**
 * Evaluates an arithmetic expression.
 *
 * @param {string} input the raw query text
 * @param {object} [variables] extra names, e.g. {ans: 42}
 * @returns {{value: number, isTrivial: boolean}|null} null when the input
 *   is not an expression at all (the overwhelmingly common case for a
 *   launcher query, so failure must be silent and cheap). `isTrivial` is
 *   true for a bare literal like "5", which callers suppress rather than
 *   answering a question nobody asked.
 */
export function evaluate(input, variables = {}) {
    const trimmed = input.trim();
    if (trimmed.length === 0 || trimmed.length > 200)
        return null;

    // Cheap pre-filter: an expression has to contain a digit or a known
    // name, and this runs on every keystroke ahead of the parser.
    if (!/[0-9]/.test(trimmed) && !/[a-zπ]/i.test(trimmed))
        return null;

    try {
        const parser = new Parser(tokenize(trimmed), variables);
        const result = parser.parse();
        const value = result.isPercent ? result.value / 100 : result.value;

        if (!Number.isFinite(value))
            return null;

        return {value, isTrivial: !parser.sawOperation};
    } catch (error) {
        return null;
    }
}

/**
 * Formats a result for display: full precision without floating-point
 * noise (0.1 + 0.2 must read as 0.3, not 0.30000000000000004).
 *
 * @param {number} value
 * @returns {string}
 */
export function formatValue(value) {
    if (Number.isInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER)
        return String(value);

    const rounded = Number.parseFloat(value.toPrecision(12));
    if (Math.abs(rounded) >= 1e15 || (Math.abs(rounded) < 1e-6 && rounded !== 0))
        return rounded.toExponential(6).replace(/e([+-])(\d)$/, 'e$10$2');
    return String(rounded);
}

/**
 * Alternate representations of an integer result (hex, binary, octal and
 * a thousands-separated form), which is why "0xff + 1" is useful in a
 * launcher at all.
 *
 * @param {number} value
 * @returns {string[]} possibly empty
 */
export function alternateForms(value) {
    if (!Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
        return [];

    const forms = [];
    const magnitude = Math.abs(value);
    const sign = value < 0 ? '-' : '';

    if (magnitude >= 1000)
        forms.push(value.toLocaleString('en-US'));
    if (magnitude <= 0xffffffff) {
        forms.push(`${sign}0x${magnitude.toString(16).toUpperCase()}`);
        forms.push(`${sign}0b${magnitude.toString(2)}`);
        forms.push(`${sign}0o${magnitude.toString(8)}`);
    }

    return forms;
}
