#!/usr/bin/env bash
# Assembles the GitHub Pages site into _site/ (index + images).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/_site"
rm -rf "$OUT" && mkdir -p "$OUT/images/fa"
cp "$ROOT/site/index.html" "$OUT/"
cp "$ROOT"/docs/images/*.png "$OUT/images/"
cp "$ROOT"/docs/images/fa/*.png "$OUT/images/fa/"
cp "$ROOT/packaging/setup/claude-status.svg" "$OUT/images/icon.svg"
touch "$OUT/.nojekyll"
echo "site built in $OUT"
