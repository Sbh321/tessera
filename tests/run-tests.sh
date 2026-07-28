#!/usr/bin/env bash
# Runs everything that can be verified without a live GNOME Shell:
# the GSettings schema, and the launcher's pure engine modules.
#
# The engine tests are plain ES modules with no GNOME imports, so they run
# under gjs (preferred -- it is the runtime the extension itself uses) or
# under node, whichever is installed. node needs the .mjs extension to
# treat a file as a module, hence the copy.
set -euo pipefail
cd "$(dirname "$0")/.."

./tests/schema-validate.sh

if command -v gjs >/dev/null 2>&1; then
    echo "Running launcher engine tests under gjs…"
    gjs -m tests/launcher-engine-test.js
elif command -v node >/dev/null 2>&1; then
    echo "Running launcher engine tests under node…"
    SCRATCH=$(mktemp -d)
    trap 'rm -rf "$SCRATCH"' EXIT
    cp -r lib "$SCRATCH/"
    mkdir -p "$SCRATCH/tests"
    cp tests/launcher-engine-test.js "$SCRATCH/tests/launcher-engine-test.mjs"
    node "$SCRATCH/tests/launcher-engine-test.mjs"
else
    echo "Neither gjs nor node found; skipping the launcher engine tests." >&2
    exit 1
fi
