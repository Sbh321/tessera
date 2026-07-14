#!/usr/bin/env bash
# Compiles the GSettings schema in strict mode into a scratch directory,
# catching typos/type errors before they reach a real install. Run from
# anywhere; safe to wire into CI.
set -euo pipefail
cd "$(dirname "$0")/.."

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

cp schemas/*.gschema.xml "$SCRATCH/"
glib-compile-schemas --strict "$SCRATCH"

echo "Schema OK."
