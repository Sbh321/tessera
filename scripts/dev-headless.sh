#!/usr/bin/env bash
# Runs an ISOLATED headless GNOME Shell with the packed extension enabled,
# for smoke-testing code paths that can only be exercised inside a live
# compositor (window creation, placement, multi-monitor) without touching
# the login session: a scratch XDG_DATA_HOME/XDG_CONFIG_HOME and a scratch
# dconf profile, all exported BEFORE dbus-run-session so the session bus,
# dconf-service and the shell inherit them (exporting them inside the
# session is too late: dconf-service is spawned by dbus-daemon with the
# daemon's environment and would write to ~/.config/dconf/user -- the
# real database). A throwaway "unsafe@test" extension turns on
# global.context.unsafe_mode so org.gnome.Shell.Eval works over D-Bus.
#
#   scripts/dev-headless.sh [MONITORS] [-- COMMAND...]
#
# MONITORS (default 2) virtual 1280x720 monitors are created. With a
# COMMAND, it runs inside the session once the shell is up (the shell's
# Wayland display is $WAYLAND_DISPLAY_TEST; use `ev '<js>'` for Eval and
# `client TITLE` to open a Gtk4 window), then everything is torn down.
# Without one, the session stays up until Ctrl+C.
set -euo pipefail
cd "$(dirname "$0")/.."

MONITORS=2
if [ "${1:-}" != "" ] && [ "${1:-}" != "--" ]; then MONITORS="$1"; shift; fi
[ "${1:-}" = "--" ] && shift

UUID=$(grep -oP '"uuid"\s*:\s*"\K[^"]+' metadata.json)
./scripts/build.sh >/dev/null
ZIP="$(pwd)/build/${UUID}.shell-extension.zip"

S=$(mktemp -d -t tessera-headless-XXXXXX)
trap 'rm -rf "$S"' EXIT
export XDG_DATA_HOME="$S/data" XDG_CONFIG_HOME="$S/config" XDG_CACHE_HOME="$S/cache"
export DCONF_PROFILE="$S/dconf-profile"
mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions/$UUID" "$XDG_CONFIG_HOME/dconf" "$XDG_CACHE_HOME"
echo "user-db:user" > "$DCONF_PROFILE"
unzip -q -o "$ZIP" -d "$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
# pack ships the schema XML only; the installer normally compiles it.
glib-compile-schemas "$XDG_DATA_HOME/gnome-shell/extensions/$UUID/schemas"
U="$XDG_DATA_HOME/gnome-shell/extensions/unsafe@test"; mkdir -p "$U"
echo '{"uuid":"unsafe@test","name":"unsafe","description":"test","shell-version":["46"]}' > "$U/metadata.json"
echo 'export default class E { enable() { global.context.unsafe_mode = true; } disable() {} }' > "$U/extension.js"

cat > "$S/client.js" <<'JS'
imports.gi.versions.Gtk = '4.0';
const {Gtk, GLib} = imports.gi;
Gtk.init();
const w = new Gtk.Window({title: ARGV[0] ?? 'T', default_width: 400, default_height: 300});
w.present();
const loop = GLib.MainLoop.new(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();
JS

cat > "$S/inner.sh" <<INNER
set -u
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$UUID','unsafe@test']"
export WAYLAND_DISPLAY_TEST=tessera-headless-\$\$
ARGS=""; for i in \$(seq 1 $MONITORS); do ARGS="\$ARGS --virtual-monitor 1280x720"; done
gnome-shell --headless \$ARGS --wayland-display "\$WAYLAND_DISPLAY_TEST" > "$S/shell.log" 2>&1 &
SHELL_PID=\$!
sleep 9
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "\$1" 2>&1 | tail -1; }
client() { GDK_BACKEND=wayland WAYLAND_DISPLAY="\$WAYLAND_DISPLAY_TEST" gjs "$S/client.js" "\$1" & }
export -f ev client
echo "shell pid \$SHELL_PID, wayland display \$WAYLAND_DISPLAY_TEST, extension state \$(ev "Main.extensionManager.lookup('$UUID').state") (1 = active), log $S/shell.log"
if [ \$# -gt 0 ]; then
    bash -c "\$*"
    STATUS=\$?
    kill -0 \$SHELL_PID 2>/dev/null && echo "shell survived" || { echo "SHELL DIED"; STATUS=1; }
    grep -E "JS ERROR|tessera|Segmentation|assert" "$S/shell.log" | grep -v "gnome-shell-disable-extensions" || true
    kill \$SHELL_PID 2>/dev/null; wait \$SHELL_PID 2>/dev/null
    exit \$STATUS
fi
wait \$SHELL_PID
INNER

exec dbus-run-session -- bash "$S/inner.sh" "$@"
