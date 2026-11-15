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

echo "Step 3/5: Cross-compile Go CLI..."
bash scripts/build-go.sh
echo ""

echo "Step 4/5: Bundle Python for this Mac platform..."
bash scripts/build-python.sh
echo ""

echo "Step 5/5: Package Mac DMG..."
npm run dist:mac
echo ""

echo "=== Done — dist-package/JobScan AI-0.0.1-arm64.dmg ==="
