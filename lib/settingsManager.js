// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Typed accessor over this extension's GSettings schema
 * (org.gnome.shell.extensions.tessera). Consumers that need to
 * react to setting changes should connect directly on `.gsettings`
 * (a plain Gio.Settings, a GObject, so `connectObject()` works for
 * lifecycle-tracked cleanup) rather than adding change-signal plumbing here.
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

    /** @param {number} index 0-based workspace index; only 0-8 have a jump keybinding. */
    workspaceJumpKeyName(index) {
        return `workspace-jump-${index + 1}`;
    }

    /** @param {number} index 0-based workspace index; only 0-8 have a move keybinding. */
    windowMoveKeyName(index) {
        return `window-move-${index + 1}`;
    }
}
