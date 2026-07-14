#!/usr/bin/env bash
# Builds the extension and installs it for the current user via
# `gnome-extensions install`. Does not enable it -- see the printed
# instructions for that, since Wayland sessions only notice a newly
# installed extension after a logout/login.
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/build.sh

UUID=$(grep -oP '"uuid"\s*:\s*"\K[^"]+' metadata.json)
ZIP="build/${UUID}.shell-extension.zip"

gnome-extensions install --force "$ZIP"

cat <<EOF
Installed ${UUID} to ~/.local/share/gnome-shell/extensions/

GNOME Shell (Wayland) only notices a brand-new extension after you log out
and back in. (On X11 you can instead reload the shell with Alt+F2, r, Enter.)
If you're updating an already-enabled extension, no relogin is needed.

Once the shell has noticed it, enable with:
  gnome-extensions enable ${UUID}
EOF
