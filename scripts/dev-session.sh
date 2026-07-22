#!/usr/bin/env bash
# Launches a FULL GNOME Shell display server on the current VT, for testing
# things a nested shell can't handle -- most importantly touchpad gestures
# (3-finger swipe, pinch), which the host compositor grabs at the seat level
# and never forwards into a nested window.
#
# Unlike scripts/dev-nested.sh, this MUST be run from a text console on a
# spare virtual terminal (e.g. Ctrl+Alt+F4, then log in), NOT from inside
# your graphical session: only the active console session is granted the
# input/DRM seat by logind. Your main session keeps running on its own VT --
# switch back with Ctrl+Alt+F1 (or F2). Nothing is logged out.
#
# It reads the same extensions dir and dconf as your login session, so it
# picks up the dev symlink from scripts/dev-symlink.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${DISPLAY:-}" ]; then
    echo "Refusing to run: a graphical session is already active here." >&2
    echo "Switch to a free text console first (e.g. Ctrl+Alt+F4, log in), then re-run." >&2
    exit 1
fi

UUID=$(grep -oP '"uuid"\s*:\s*"\K[^"]+' metadata.json)
TARGET="$HOME/.local/share/gnome-shell/extensions/${UUID}"

if [ ! -L "$TARGET" ]; then
    echo "Dev symlink missing -- running scripts/dev-symlink.sh first."
    ./scripts/dev-symlink.sh
else
    glib-compile-schemas "$(pwd)/schemas"
fi

gnome-extensions enable "$UUID" || true

echo "Launching full GNOME Shell on this VT. Ctrl+Alt+F1/F2 returns to your main session."
exec dbus-run-session -- gnome-shell --display-server --wayland
