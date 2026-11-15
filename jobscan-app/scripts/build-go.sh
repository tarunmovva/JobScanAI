#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/.." && pwd)"
JOBSCAN_SRC="$REPO_ROOT/jobscan"
BIN_DIR="$APP_DIR/resources/bin"
NM="$APP_DIR/node_modules"

mkdir -p "$BIN_DIR"
echo "Building jobscan for all platforms..."

GOOS=windows GOARCH=amd64 go build -C "$JOBSCAN_SRC" -ldflags="-s -w" -o "$BIN_DIR/jobscan-win-x64.exe" .
echo "  ✓ jobscan win-x64"

GOOS=darwin GOARCH=arm64 go build -C "$JOBSCAN_SRC" -ldflags="-s -w" -o "$BIN_DIR/jobscan-mac-arm64" .
echo "  ✓ jobscan mac-arm64"

GOOS=darwin GOARCH=amd64 go build -C "$JOBSCAN_SRC" -ldflags="-s -w" -o "$BIN_DIR/jobscan-mac-x64" .
echo "  ✓ jobscan mac-x64"

chmod +x "$BIN_DIR/jobscan-mac-arm64" "$BIN_DIR/jobscan-mac-x64"

echo "Done. resources/bin/ populated (JobScan uses the user's own Codex CLI; none is bundled)."
