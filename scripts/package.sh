#!/usr/bin/env bash
# Build a Chrome Web Store-ready zip of the extension.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="dist/insta-unfollowers-v$VERSION.zip"

mkdir -p dist
rm -f "$OUT"
zip -r "$OUT" manifest.json icons src -x '*.DS_Store'
echo "Built $OUT"
