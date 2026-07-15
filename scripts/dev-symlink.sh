#!/usr/bin/env bash
# Symlinks this repo directly into the user extensions directory, for fast
# local iteration: edit source files here and just reload the shell, no
# repack/reinstall step needed.
#
# Mode switching is safe in both directions: if the target is a real
# directory that is an installed copy of THIS extension (same uuid in its
# metadata.json -- e.g. left behind by scripts/install.sh), it's replaced
# by the symlink, since this repo is that copy's source of truth. Anything
# else at the target path is refused, never clobbered.
set -euo pipefail
cd "$(dirname "$0")/.."

UUID=$(grep -oP '"uuid"\s*:\s*"\K[^"]+' metadata.json)
TARGET="$HOME/.local/share/gnome-shell/extensions/${UUID}"

if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
    INSTALLED_UUID=$(grep -oP '"uuid"\s*:\s*"\K[^"]+' "$TARGET/metadata.json" 2>/dev/null || true)
    if [ "$INSTALLED_UUID" != "$UUID" ]; then
        echo "Refusing to overwrite $TARGET -- not an installed copy of this extension" >&2
        exit 1
    fi
    echo "Replacing installed copy at $TARGET with dev symlink."
    rm -rf "$TARGET"
fi

rm -f "$TARGET"
ln -s "$(pwd)" "$TARGET"
glib-compile-schemas "$(pwd)/schemas"

cat <<EOF
Symlinked $(pwd) -> ${TARGET}

Reload the shell (Wayland: log out/in, X11: Alt+F2, r, Enter) then run:
  gnome-extensions enable ${UUID}

After editing schemas/*.gschema.xml, re-run this script to recompile them.
EOF
