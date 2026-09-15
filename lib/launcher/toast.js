// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

// How long a toast stays before fading, and how long the fades take.
// Short: it confirms something the user just did and must never feel
// like a dialog to wait out.
const HOLD_MS = 1400;
const FADE_MS = 120;

// Gap between the toast and the footer it floats above.
const MARGIN = 8;

/**
 * A small transient confirmation inside the launcher card -- "Added to
 * Favorites" -- floating over the result list just above the footer.
 *
 * In-launcher rather than a system notification because the launcher
 * is modal: a banner from the message tray would appear behind the
 * dimmed backdrop, or after the popup has closed, and either way not
 * where the user is looking. The toast is deliberately inert (not
 * reactive, no focus): it confirms, it never interrupts.
 *
 * One instance per popup, reused: showing while a toast is up replaces
 * its text and restarts the hold, so a run of Ctrl+D presses reads as
 * one toast updating rather than a stack of them. Any part of the
 * launcher can raise one through `context.toast(text, {iconName})`.
 */
export const LauncherToast = GObject.registerClass(
class LauncherToast extends St.BoxLayout {
    constructor(theme) {
        super({
            style_class: 'tessera-launcher-toast',
            reactive: false,
            can_focus: false,
            opacity: 0,
            visible: false,
        });

        this._theme = theme;
        this._hideSourceId = null;

        this._icon = new St.Icon({y_align: Clutter.ActorAlign.CENTER, icon_size: 16});
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._icon);
        this.add_child(this._label);
    }

    /**
     * @param {string} text
     * @param {object} options
     * @param {Clutter.Actor} options.card the launcher card, for centering
     * @param {Clutter.Actor} options.above the actor to float above (the footer)
     * @param {?string} [options.iconName] a themed icon, or none
     * @param {boolean} [options.animate] whether to fade (false under
     *   reduced motion)
     */
    show(text, {card, above, iconName = null, animate = true}) {
        this._cancelHide();

        this._label.text = text;
        this._icon.visible = iconName !== null;
        if (iconName !== null)
            this._icon.icon_name = iconName;
        this.set_style(this._theme.toastStyle());

        // Measure after the text is set, then center on the card and sit
        // just above the footer. Stage coordinates are the popup's own
        // coordinates (it is bound to the stage), so transformed positions
        // can be used directly.
        const [, , naturalWidth, naturalHeight] = this.get_preferred_size();
        const [cardX] = card.get_transformed_position();
        const [, aboveY] = above.get_transformed_position();
        this.set_position(
            Math.round(cardX + (card.width - naturalWidth) / 2),
            Math.round(aboveY - naturalHeight - MARGIN));

        this.show();
        this.remove_all_transitions();
        this.ease({opacity: 255, duration: animate ? FADE_MS : 0, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        this._hideSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_MS, () => {
            this._hideSourceId = null;
            this.dismiss(animate);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Fades out now (or hides instantly), e.g. when the popup closes. */
    dismiss(animate = true) {
        this._cancelHide();
        this.remove_all_transitions();
        if (!animate || !this.visible) {
            this.opacity = 0;
            this.hide();
            return;
        }
        this.ease({
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.hide(),
        });
    }

    applyTheme() {
        this.set_style(this._theme.toastStyle());
    }

    destroy() {
        this._cancelHide();
        super.destroy();
    }

    _cancelHide() {
        if (this._hideSourceId !== null) {
            GLib.Source.remove(this._hideSourceId);
            this._hideSourceId = null;
        }
    }
});
