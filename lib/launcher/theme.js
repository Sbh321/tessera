// SPDX-License-Identifier: GPL-2.0-or-later

import {buildCssDeclarations, isValidHexColor} from '../utils.js';
import {hexToRgba} from './utils.js';

const INTERFACE_COLOR_SCHEME_KEY = 'color-scheme';

// Matches FALLBACK_ACTIVE_HEX in workspaceIndicator.js and
// FALLBACK_BORDER_HEX in focusBorder.js -- one last-resort literal for
// the whole extension, used only when the accent cannot be determined.
const FALLBACK_ACCENT_HEX = '#3584e4';

// Two hand-tuned palettes rather than theme lookups, because St gives an
// extension no way to read the shell theme's own surface colors. They are
// the same neutral, theme-agnostic grays the rest of Tessera's chrome
// uses (see stylesheet.css), just opaque enough to sit over a desktop.
const PALETTE = {
    dark: {
        surface: 'rgba(28, 28, 30, 0.94)',
        surfaceBlurred: 'rgba(28, 28, 30, 0.72)',
        text: '#ffffff',
        dimText: 'rgba(255, 255, 255, 0.62)',
        border: 'rgba(255, 255, 255, 0.12)',
        entry: 'rgba(255, 255, 255, 0.08)',
        hover: 'rgba(255, 255, 255, 0.08)',
    },
    light: {
        surface: 'rgba(250, 250, 250, 0.96)',
        surfaceBlurred: 'rgba(250, 250, 250, 0.78)',
        text: '#1c1c1e',
        dimText: 'rgba(0, 0, 0, 0.55)',
        border: 'rgba(0, 0, 0, 0.12)',
        entry: 'rgba(0, 0, 0, 0.06)',
        hover: 'rgba(0, 0, 0, 0.06)',
    },
};

// Compact mode is a real density change, not just a smaller font: rows,
// icons and padding all shrink together, which is the difference between
// "smaller text" and "more results on screen".
const METRICS = {
    normal: {rowHeight: 46, iconSize: 30, rowPadding: 8, cardPadding: 10, sectionSpacing: 6},
    compact: {rowHeight: 34, iconSize: 20, rowPadding: 4, cardPadding: 6, sectionSpacing: 2},
};

/**
 * Turns settings plus the live GNOME theme into the concrete numbers and
 * CSS the launcher's actors need.
 *
 * Every color that has to follow the accent or the light/dark preference
 * is resolved here to a literal value and applied inline, never left to a
 * stylesheet class -- the discipline ARCHITECTURE.md's "Settings ->
 * rendering" section documents, for the reason recorded there: St
 * interpolates style transitions through whatever the class rule says, so
 * a hardcoded color in the stylesheet leaks through as a flash on every
 * change. stylesheet.css therefore carries only the launcher's structure
 * and neutral surfaces.
 */
export class LauncherTheme {
    /**
     * @param {import('../settingsManager.js').SettingsManager} settingsManager
     * @param {import('../accentColor.js').AccentColorTracker} accentColorTracker
     *   its `.gsettings` is org.gnome.desktop.interface, which is also
     *   where the light/dark preference lives -- so the launcher needs no
     *   Gio.Settings instance of its own.
     */
    constructor(settingsManager, accentColorTracker) {
        this._settings = settingsManager;
        this._accent = accentColorTracker;
    }

    /**
     * Dark unless GNOME says otherwise -- and only when the user asked
     * the launcher to follow the system theme at all. With that setting
     * off it stays dark, the look people expect from a Spotlight-style
     * overlay regardless of their desktop theme.
     */
    get isDark() {
        if (!this._settings.launcherFollowTheme)
            return true;

        const gsettings = this._accent.gsettings;
        if (gsettings.settings_schema.has_key(INTERFACE_COLOR_SCHEME_KEY)) {
            const scheme = gsettings.get_string(INTERFACE_COLOR_SCHEME_KEY);
            if (scheme === 'prefer-dark')
                return true;
            if (scheme === 'prefer-light')
                return false;
        }

        // 'default' means "no preference expressed", which on Ubuntu
        // still leaves the Yaru variant as the real signal.
        return gsettings.get_string('gtk-theme').endsWith('-dark');
    }

    /** The accent color, or a neutral highlight when following is off. */
    get accentHex() {
        if (!this._settings.launcherFollowAccent)
            return this.isDark ? '#8e8e93' : '#5a5a5f';

        const custom = this._settings.activeBackgroundColor;
        if (isValidHexColor(custom))
            return custom;

        return this._accent.hex ?? FALLBACK_ACCENT_HEX;
    }

    get palette() {
        return this.isDark ? PALETTE.dark : PALETTE.light;
    }

    get metrics() {
        const base = this._settings.launcherCompact ? METRICS.compact : METRICS.normal;
        return {
            ...base,
            width: this._settings.launcherWidth,
            maxHeight: this._settings.launcherHeight,
            position: this._settings.launcherPosition,
            offsetY: this._settings.launcherOffsetY,
            radius: this._settings.launcherCornerRadius,
            fontSize: this._settings.launcherFontSize,
            showIcons: this._settings.launcherShowIcons,
            showDescriptions: this._settings.launcherShowDescriptions,
        };
    }

    /** Inline style for the popup card. */
    cardStyle() {
        const {palette} = this;
        const {radius, width, fontSize, cardPadding} = this.metrics;

        return buildCssDeclarations({
            'background-color': this._settings.launcherBlur
                ? palette.surfaceBlurred : palette.surface,
            'border': `1px solid ${palette.border}`,
            'border-radius': `${radius}px`,
            'padding': `${cardPadding}px`,
            // St's CSS engine implements min-/max-width but NOT a plain
            // `width` property (verified against libst-14), so a fixed
            // width has to be expressed as an equal min and max.
            'min-width': `${width}px`,
            'max-width': `${width}px`,
            'color': palette.text,
            'font-size': `${fontSize}pt`,
        });
    }

    entryStyle() {
        const {palette} = this;
        const {radius, fontSize} = this.metrics;

        return buildCssDeclarations({
            'background-color': palette.entry,
            'border-radius': `${Math.max(6, radius - 6)}px`,
            'color': palette.text,
            'font-size': `${fontSize + 3}pt`,
        });
    }

    /**
     * Inline style for one result row.
     *
     * @param {boolean} selected
     * @returns {string}
     */
    rowStyle(selected) {
        const {palette} = this;
        const {rowHeight, rowPadding, radius} = this.metrics;

        return buildCssDeclarations({
            'min-height': `${rowHeight}px`,
            'padding': `0 ${rowPadding + 4}px`,
            'border-radius': `${Math.max(4, radius - 8)}px`,
            'color': palette.text,
            'background-color': selected
                // Accent at low alpha reads as a selection on both light
                // and dark surfaces without needing two accent colors.
                ? hexToRgba(this.accentHex, this.isDark ? 0.32 : 0.22) ?? palette.hover
                : 'transparent',
        });
    }

    sectionHeaderStyle() {
        const {fontSize, sectionSpacing} = this.metrics;
        return buildCssDeclarations({
            'color': this.palette.dimText,
            'font-size': `${Math.max(7, fontSize - 3)}pt`,
            'font-weight': 'bold',
            'padding': `${sectionSpacing + 2}px 8px ${sectionSpacing}px 8px`,
        });
    }

    subtitleStyle() {
        return buildCssDeclarations({
            'color': this.palette.dimText,
            'font-size': `${Math.max(7, this.metrics.fontSize - 2)}pt`,
        });
    }

    /** Style for the small trailing hint labels (Alt+N, key hints). */
    hintStyle() {
        return buildCssDeclarations({
            'color': this.palette.dimText,
            'font-size': `${Math.max(7, this.metrics.fontSize - 3)}pt`,
        });
    }

    footerStyle() {
        const {palette} = this;
        return buildCssDeclarations({
            'color': palette.dimText,
            'font-size': `${Math.max(7, this.metrics.fontSize - 3)}pt`,
            'border-top': `1px solid ${palette.border}`,
            'padding': '6px 8px 2px 8px',
        });
    }
}
