#!/usr/bin/env bash
# Install claude-hud-enhanced plugin from this fork (with proxy support)
# Works on Linux, macOS, and Windows (Git Bash/MSYS2)
set -euo pipefail

REPO_URL="https://github.com/AnFuran/claude-hud-enhanced.git"
PLUGIN_NAME="claude-hud-enhanced"
CLAUDE_DIR="${HOME}/.claude"
PLUGIN_DIR="${CLAUDE_DIR}/plugins/${PLUGIN_NAME}"

echo "[1/4] Cloning repository..."
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
git clone --depth 1 "$REPO_URL" "$TMPDIR/repo" 2>&1 | tail -1

echo "[2/4] Installing plugin to ${PLUGIN_DIR}..."
rm -rf "$PLUGIN_DIR"
cp -r "$TMPDIR/repo/plugins/${PLUGIN_NAME}" "$PLUGIN_DIR"

echo "[3/4] Installing dependencies and building..."
cd "$PLUGIN_DIR"
npm install --silent 2>&1 | tail -3

echo "[4/4] Configuring statusLine..."
# Detect runtime
RUNTIME=$(command -v bun 2>/dev/null || command -v node 2>/dev/null || true)
if [ -z "$RUNTIME" ]; then
  echo "ERROR: Neither bun nor node found. Install Node.js 18+ or Bun first."
  exit 1
fi

# On Windows, resolve to .exe if needed
if [[ "$OSTYPE" == msys* || "$OSTYPE" == mingw* || "$OSTYPE" == cygwin* ]]; then
  # Check if runtime is a real executable or a shell wrapper
  if [[ ! "$RUNTIME" =~ \.exe$ ]]; then
    RUNTIME_DIR=$(dirname "$RUNTIME")
    RUNTIME_NAME=$(basename "$RUNTIME")
    for candidate in "${RUNTIME_DIR}/${RUNTIME_NAME}.exe" "${RUNTIME_DIR}/node_modules/${RUNTIME_NAME}/bin/${RUNTIME_NAME}.exe"; do
      if [ -f "$candidate" ]; then
        RUNTIME="$candidate"
        break
      fi
    done
  fi
fi

# Determine source file
if [[ "$(basename "$RUNTIME")" == bun* ]]; then
  SOURCE="src/index.ts"
else
  SOURCE="dist/index.js"
fi

# Build the statusLine command
STATUSLINE_CMD="bash -c 'exec \"${RUNTIME}\" \"${PLUGIN_DIR}/${SOURCE}\"'"

# Read existing settings, merge statusLine config
SETTINGS_FILE="${CLAUDE_DIR}/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  # Use node to safely merge JSON
  node -e "
    const fs = require('fs');
    const settings = JSON.parse(fs.readFileSync('${SETTINGS_FILE}', 'utf8'));
    settings.statusLine = { type: 'command', command: $(node -e "process.stdout.write(JSON.stringify('$STATUSLINE_CMD'))") };
    fs.writeFileSync('${SETTINGS_FILE}', JSON.stringify(settings, null, 2) + '\n');
  "
else
  node -e "
    const fs = require('fs');
    const settings = { statusLine: { type: 'command', command: $(node -e "process.stdout.write(JSON.stringify('$STATUSLINE_CMD'))") } };
    fs.writeFileSync('${SETTINGS_FILE}', JSON.stringify(settings, null, 2) + '\n');
  "
fi

echo ""
echo "Done! Plugin installed to: ${PLUGIN_DIR}"
echo "StatusLine command: ${STATUSLINE_CMD}"
echo ""
echo "Restart Claude Code to see the HUD."
echo "If you use a proxy, it will be auto-detected from:"
echo "  - Environment variables (HTTP_PROXY / HTTPS_PROXY)"
echo "  - ~/.claude.json env field"
