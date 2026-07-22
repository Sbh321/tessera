#!/usr/bin/env bash
# Launches a nested GNOME Shell in a window for fast extension iteration --
# no logout/login of your real session required. Edit source, close the
# nested window, re-run this script; the new code loads in seconds.
#
# The nested shell reads the same ~/.local/share/gnome-shell/extensions/
# and dconf as your login session, so it picks up the dev symlink created
# by scripts/dev-symlink.sh. Requires a Wayland login session (Fedora's
# default) -- nested mode needs a Wayland host compositor.
set -euo pipefail
cd "$(dirname "$0")/.."

UUID=$(grep -oP '"uuid"\s*:\s*"\K[^"]+' metadata.json)
TARGET="$HOME/.local/share/gnome-shell/extensions/${UUID}"

# Make sure the dev symlink is in place and schemas are compiled.
if [ ! -L "$TARGET" ]; then
    echo "Dev symlink missing -- running scripts/dev-symlink.sh first."
    ./scripts/dev-symlink.sh
else
    glib-compile-schemas "$(pwd)/schemas"
fi

# Enable it (shared dconf, so this persists) before the nested shell starts,
# so it's active the moment the window opens.
gnome-extensions enable "$UUID" || true

# Window size of the nested shell. Override with: WINDOW_SIZE=1920x1080 ...
export MUTTER_DEBUG_DUMMY_MODE_SPECS="${WINDOW_SIZE:-1600x900}"

echo "Launching nested GNOME Shell (${MUTTER_DEBUG_DUMMY_MODE_SPECS}). Close the window to stop."
exec dbus-run-session -- gnome-shell --nested --wayland
