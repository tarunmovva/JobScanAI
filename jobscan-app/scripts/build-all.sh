#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "=== JobScan AI — Full Build (Mac ARM64) ==="
echo ""

echo "Step 1/5: Install Python build dependency..."
pip3 install setuptools --quiet
echo "  ✓ setuptools ready"
echo ""

echo "Step 2/5: Install Node dependencies..."
npm install --ignore-scripts
echo "  ✓ npm install done"
echo ""

echo "Step 3/5: Cross-compile Go CLI + copy Codex binary..."
bash scripts/build-go.sh
# Codex binary: copy from optional dep installed by npm install
NM="$(pwd)/node_modules"
BIN="$(pwd)/resources/bin"
SRC="$NM/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"
# 0.153+ moved the binary to vendor/<triple>/bin/; older pins keep it in codex/.
[ -f "$SRC" ] || SRC="$NM/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex"
if [ -f "$SRC" ]; then
  cp "$SRC" "$BIN/codex-mac-arm64"
  chmod +x "$BIN/codex-mac-arm64"
  echo "  ✓ codex mac-arm64 copied from node_modules"
else
  echo "  ! codex-mac-arm64 not in node_modules — Codex login may fail"
fi
echo ""

echo "Step 4/5: Bundle Python for this Mac platform..."
bash scripts/build-python.sh
echo ""

echo "Step 5/5: Package Mac DMG..."
npm run dist:mac
echo ""

echo "=== Done — dist-package/JobScan AI-0.0.1-arm64.dmg ==="
