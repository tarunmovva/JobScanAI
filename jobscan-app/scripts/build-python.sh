#!/usr/bin/env bash
# Downloads python-build-standalone for the current Mac platform and installs deps.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/.." && pwd)"
JOBSCAN_SRC="$REPO_ROOT/jobscan"

ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  PLATFORM_TAG="mac-arm64"
  PBS_TRIPLE="aarch64-apple-darwin"
else
  PLATFORM_TAG="mac-x64"
  PBS_TRIPLE="x86_64-apple-darwin"
fi

PYTHON_OUT="$APP_DIR/resources/python/$PLATFORM_TAG"
mkdir -p "$PYTHON_OUT"

# python-build-standalone — check https://github.com/indygreg/python-build-standalone/releases for latest
PBS_VERSION="20241016"
PBS_PYVER="3.12.7"
PBS_FILE="cpython-${PBS_PYVER}+${PBS_VERSION}-${PBS_TRIPLE}-install_only.tar.gz"
PBS_URL="https://github.com/indygreg/python-build-standalone/releases/download/${PBS_VERSION}/${PBS_FILE}"

TMPDIR_PBS=$(mktemp -d)
trap "rm -rf $TMPDIR_PBS" EXIT

echo "Downloading python-build-standalone $PBS_PYVER for $PLATFORM_TAG..."
curl -fL -o "$TMPDIR_PBS/$PBS_FILE" "$PBS_URL"

echo "Extracting..."
tar -xzf "$TMPDIR_PBS/$PBS_FILE" -C "$TMPDIR_PBS"
cp -r "$TMPDIR_PBS/python/." "$PYTHON_OUT/"

PYTHON_BIN="$PYTHON_OUT/bin/python3"
echo "Python: $($PYTHON_BIN --version)"

echo "Installing Python packages..."
$PYTHON_BIN -m pip install --upgrade pip --quiet
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  $PYTHON_BIN -m pip install \
    playwright \
    "undetected-playwright>=0.3.0" \
    PyPDF2 \
    requests \
    "beautifulsoup4>=4.12.0" \
    "lxml>=4.9.0" \
    geocoder \
    --quiet
echo "  ✓ packages installed"

echo "Copying job_application_automator source..."
mkdir -p "$APP_DIR/resources/python-src"
cp -r "$JOBSCAN_SRC/job_application_automator" "$APP_DIR/resources/python-src/"
cp "$JOBSCAN_SRC/"*.py "$APP_DIR/resources/python-src/" 2>/dev/null || true
echo "  ✓ source copied"

echo "Done. resources/python/$PLATFORM_TAG/ ready."
