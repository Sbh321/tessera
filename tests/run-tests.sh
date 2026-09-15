#!/usr/bin/env bash
# Runs everything that can be verified without a live GNOME Shell or a
# browser: the GSettings schema, the launcher's pure engine modules, the
# browser tab store and window mapper, the socket bridge, the Native
# Messaging relay, the Preferences-side relay installer, and Tessera
# Companion's Tabs module.
#
# The pure modules are plain ES modules with no GNOME imports, so they run
# under gjs (preferred -- it is the runtime the extension itself uses) or
# under node, whichever is installed. node needs the .mjs extension to
# treat a file as a module, hence the copies. The bridge, relay and
# installer need Gio and therefore gjs; the companion is browser
# JavaScript and needs node.
set -euo pipefail
cd "$(dirname "$0")/.."

./tests/schema-validate.sh

# The shell owns the wire protocol; the companion carries a verbatim copy
# (a browser extension cannot import outside its own directory, and the
# packaged extension does not include the companion). Catch any drift.
if ! cmp -s lib/launcher/browserProtocol.js companion/modules/tabs/protocol.js; then
    echo "companion/modules/tabs/protocol.js differs from lib/launcher/browserProtocol.js; copy it over." >&2
    exit 1
fi

PURE_TESTS=(launcher-engine-test layout-engine-test browser-tab-store-test browser-window-mapper-test)

if command -v gjs >/dev/null 2>&1; then
    for test in "${PURE_TESTS[@]}"; do
        echo "Running ${test} under gjs…"
        gjs -m "tests/${test}.js"
    done
    for test in browser-bridge-test native-host-test; do
        echo "Running ${test} under gjs…"
        RUNTIME=$(mktemp -d)
        XDG_RUNTIME_DIR="$RUNTIME" gjs -m "tests/${test}.js"
        rm -rf "$RUNTIME"
    done
    echo "Running browser-integration-test under gjs…"
    gjs -m tests/browser-integration-test.js
elif command -v node >/dev/null 2>&1; then
    SCRATCH=$(mktemp -d)
    trap 'rm -rf "$SCRATCH"' EXIT
    cp -r lib companion "$SCRATCH/"
    mkdir -p "$SCRATCH/tests"
    for test in "${PURE_TESTS[@]}"; do
        echo "Running ${test} under node…"
        cp "tests/${test}.js" "$SCRATCH/tests/${test}.mjs"
        node "$SCRATCH/tests/${test}.mjs"
    done
    echo "gjs not found; skipping the bridge, relay and installer tests." >&2
else
    echo "Neither gjs nor node found; skipping the launcher engine tests." >&2
    exit 1
fi

if command -v node >/dev/null 2>&1; then
    echo "Running the Tessera Companion tests under node…"
    COMPANION_SCRATCH=$(mktemp -d)
    cp -r companion "$COMPANION_SCRATCH/"
    mkdir -p "$COMPANION_SCRATCH/tests"
    cp tests/browser-companion-test.js "$COMPANION_SCRATCH/tests/browser-companion-test.mjs"
    node "$COMPANION_SCRATCH/tests/browser-companion-test.mjs"
    rm -rf "$COMPANION_SCRATCH"
else
    echo "node not found; skipping the Tessera Companion tests." >&2
fi

echo "All automated checks passed."
