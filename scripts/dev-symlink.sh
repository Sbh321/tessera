#!/usr/bin/env bash
# Symlinks this repo directly into the user extensions directory, for fast
# local iteration: edit source files here and just reload the shell, no
# repack/reinstall step needed. Refuses to touch a pre-existing real
# install so it never clobbers a zip-installed copy by accident.
set -euo pipefail
cd "$(dirname "$0")/.."

UUID=$(grep -oP '"uuid"\s*:\s*"\K[^"]+' metadata.json)
TARGET="$HOME/.local/share/gnome-shell/extensions/${UUID}"

if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
    echo "Refusing to overwrite non-symlink at $TARGET" >&2
    exit 1
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
