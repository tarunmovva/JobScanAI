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

echo "Copying Codex native binaries..."
# The vendored binary moved from vendor/<triple>/codex/ to vendor/<triple>/bin/
# somewhere between 0.128 and 0.153. Probing both keeps a pin bump from silently
# shipping no binary (or leaving a stale one in resources/bin).
copy_codex() {
  pkg="$1"; triple="$2"; exe="$3"; dest="$4"; label="$5"
  for sub in bin codex; do
    src="$NM/@openai/$pkg/vendor/$triple/$sub/$exe"
    if [ -f "$src" ]; then
      cp "$src" "$dest"
      chmod +x "$dest" 2>/dev/null || true
      echo "  ✓ codex $label (vendor/$triple/$sub)"
      return 0
    fi
  done
  echo "  ! codex $label not found under vendor/$triple/{bin,codex}"
  return 1
}

copy_codex codex-win32-x64    x86_64-pc-windows-msvc codex.exe "$BIN_DIR/codex-win-x64.exe" win-x64
copy_codex codex-darwin-arm64 aarch64-apple-darwin   codex     "$BIN_DIR/codex-mac-arm64"   mac-arm64
copy_codex codex-darwin-x64   x86_64-apple-darwin    codex     "$BIN_DIR/codex-mac-x64"     mac-x64

echo "Done. resources/bin/ populated."
