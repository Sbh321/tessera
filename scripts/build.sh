#!/usr/bin/env bash
# Packs the extension into a distributable .shell-extension.zip using the
# official `gnome-extensions pack` tool (validates metadata.json and
# compiles the GSettings schema as part of packing).
set -euo pipefail
cd "$(dirname "$0")/.."

UUID=$(grep -oP '"uuid"\s*:\s*"\K[^"]+' metadata.json)
OUT_DIR="build"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

gnome-extensions pack \
    --force \
    --extra-source=lib \
    --out-dir="$OUT_DIR" \
    .

echo "Packed: ${OUT_DIR}/${UUID}.shell-extension.zip"
