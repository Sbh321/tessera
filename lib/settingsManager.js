// SPDX-License-Identifier: GPL-2.0-or-later

// Newest-first, de-duplicated, capped-length string list. Shared shape for
// both tool-history lists (picked colors, killed ports).
const HISTORY_CAP = 20;

/**
 * Typed accessor over this extension's GSettings schema
 * (org.gnome.shell.extensions.tessera). Mostly read-only getters;
 * the only writers are the small tool-history helpers at the bottom
 * (recordPickedColor / recordKilledPort), which keep a capped MRU list.
 * Consumers that need to react to setting changes should connect directly
 * on `.gsettings` (a plain Gio.Settings, a GObject, so `connectObject()`
 * works for lifecycle-tracked cleanup) rather than adding change-signal
 * plumbing here.
 */
export class SettingsManager {
    constructor(gsettings) {
        this.gsettings = gsettings;
    }

    get panelPosition() {
        return this.gsettings.get_string('panel-position');
    }

    get hideNativeActivitiesDots() {
        return this.gsettings.get_boolean('hide-native-activities-dots');
    }

    get squareSize() {
        return this.gsettings.get_int('square-size');
    }

    get squareSpacing() {
        return this.gsettings.get_int('square-spacing');
    }

    get squareBorderRadius() {
        return this.gsettings.get_int('square-border-radius');
    }

    get squarePadding() {
        return this.gsettings.get_int('square-padding');
    }

    get fontSize() {
        return this.gsettings.get_int('font-size');
    }

    get fontWeight() {
        return this.gsettings.get_string('font-weight');
    }

    get indicatorStyle() {
        return this.gsettings.get_string('indicator-style');
    }

    get labelStyle() {
        return this.gsettings.get_string('label-style');
    }

    get activeBackgroundColor() {
        return this.gsettings.get_string('active-background-color');
    }

    get inactiveBackgroundColor() {
        return this.gsettings.get_string('inactive-background-color');
    }

    get activeTextColor() {
        return this.gsettings.get_string('active-text-color');
    }

    get inactiveTextColor() {
        return this.gsettings.get_string('inactive-text-color');
    }

    get enableCustomKeybindings() {
        return this.gsettings.get_boolean('enable-custom-keybindings');
    }

    get panelAutohide() {
        return this.gsettings.get_boolean('panel-autohide');
    }

    get panelSlideTime() {
        return this.gsettings.get_int('panel-slide-time');
    }

    get panelOpacity() {
        return this.gsettings.get_int('panel-opacity');
    }

    get enableQuickMenu() {
        return this.gsettings.get_boolean('enable-quick-menu');
    }

    get pickedColors() {
        return this.gsettings.get_strv('picked-colors');
    }

    get killedPorts() {
        return this.gsettings.get_strv('killed-ports');
    }

    /** Record a picked color hex at the top of the MRU history. */
    recordPickedColor(hex) {
        this._pushHistory('picked-colors', hex);
    }

    /** Record a killed-port display string at the top of the MRU history. */
    recordKilledPort(entry) {
        this._pushHistory('killed-ports', entry);
    }

    _pushHistory(key, value) {
        const next = [value, ...this.gsettings.get_strv(key).filter(v => v !== value)]
            .slice(0, HISTORY_CAP);
        this.gsettings.set_strv(key, next);
    }

    get enableTiling() {
        return this.gsettings.get_boolean('enable-tiling');
    }

    get tilingGapInner() {
        return this.gsettings.get_int('tiling-gap-inner');
    }

    get tilingGapOuter() {
        return this.gsettings.get_int('tiling-gap-outer');
    }

    get floatingWindowSize() {
        return this.gsettings.get_int('floating-window-size');
    }

    get newWindowNewWorkspace() {
        return this.gsettings.get_boolean('new-window-new-workspace');
    }

    get newWindowAdjacentWorkspace() {
        return this.gsettings.get_boolean('new-window-adjacent-workspace');
    }

    get enableFocusBorder() {
        return this.gsettings.get_boolean('enable-focus-border');
    }

    get focusBorderColor() {
        return this.gsettings.get_string('focus-border-color');
    }

    get focusBorderWidth() {
        return this.gsettings.get_int('focus-border-width');
    }

    get focusBorderRadius() {
        return this.gsettings.get_int('focus-border-radius');
    }

    // --- Launcher (lib/launcher/) ----------------------------------------

    get enableLauncher() {
        return this.gsettings.get_boolean('enable-launcher');
    }

    get launcherWidth() {
        return this.gsettings.get_int('launcher-width');
    }

    get launcherHeight() {
        return this.gsettings.get_int('launcher-height');
    }

    get launcherMaxResults() {
        return this.gsettings.get_int('launcher-max-results');
    }

    get launcherRememberHistory() {
        return this.gsettings.get_boolean('launcher-remember-history');
    }

    get launcherEnableRecent() {
        return this.gsettings.get_boolean('launcher-enable-recent');
    }

    get launcherEnableWindows() {
        return this.gsettings.get_boolean('launcher-enable-windows');
    }

    get launcherEnableApps() {
        return this.gsettings.get_boolean('launcher-enable-apps');
    }

    get launcherEnableCommands() {
        return this.gsettings.get_boolean('launcher-enable-commands');
    }

    get launcherCommandInTerminal() {
        return this.gsettings.get_boolean('launcher-command-in-terminal');
    }

    get launcherEnableCalculator() {
        return this.gsettings.get_boolean('launcher-enable-calculator');
    }

    get launcherEnableClipboard() {
        return this.gsettings.get_boolean('launcher-enable-clipboard');
    }

    get launcherClipboardSize() {
        return this.gsettings.get_int('launcher-clipboard-size');
    }

    get launcherSearchUrl() {
        return this.gsettings.get_string('launcher-search-url');
    }

    get launcherChatUrl() {
        return this.gsettings.get_string('launcher-chat-url');
    }

    get launcherFuzzy() {
        return this.gsettings.get_boolean('launcher-fuzzy');
    }

    get launcherShowIcons() {
        return this.gsettings.get_boolean('launcher-show-icons');
    }

    get launcherShowDescriptions() {
        return this.gsettings.get_boolean('launcher-show-descriptions');
    }

    get launcherCompact() {
        return this.gsettings.get_boolean('launcher-compact');
    }

    get launcherAnimations() {
        return this.gsettings.get_boolean('launcher-animations');
    }

    get launcherFollowTheme() {
        return this.gsettings.get_boolean('launcher-follow-theme');
    }

    get launcherFollowAccent() {
        return this.gsettings.get_boolean('launcher-follow-accent');
    }

    get launcherBlur() {
        return this.gsettings.get_boolean('launcher-blur');
    }

    get launcherPosition() {
        return this.gsettings.get_string('launcher-position');
    }

    get launcherOffsetY() {
        return this.gsettings.get_int('launcher-offset-y');
    }

    get launcherCornerRadius() {
        return this.gsettings.get_int('launcher-corner-radius');
    }

    get launcherSearchDelay() {
        return this.gsettings.get_int('launcher-search-delay');
    }

    get launcherFontSize() {
        return this.gsettings.get_int('launcher-font-size');
    }

    /** @param {number} index 0-based workspace index; only 0-8 have a jump keybinding. */
    workspaceJumpKeyName(index) {
        return `workspace-jump-${index + 1}`;
    }

    /** @param {number} index 0-based workspace index; only 0-8 have a move keybinding. */
    windowMoveKeyName(index) {
        return `window-move-${index + 1}`;
    }

    /** @param {number} index 0-based workspace index; only 0-8 have a swap keybinding. */
    workspaceSwapKeyName(index) {
        return `workspace-swap-${index + 1}`;
    }
}
