#!/usr/bin/env bash
# OCR Corpus Generator — bootstrap wrapper
# Sets FONTCONFIG_PATH so sharp/libvips finds bundled fonts on both macOS and Ubuntu CI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORPUS_DIR="$SCRIPT_DIR/.."
FONT_DIR="$CORPUS_DIR/templates/fonts"
CONF_DIR="$CORPUS_DIR/templates"

# Generate fonts.conf with correct absolute path (deterministic — no timestamps)
cat > "$CONF_DIR/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>$FONT_DIR</dir>
</fontconfig>
EOF

export FONTCONFIG_PATH="$CONF_DIR"

exec npx ts-node "$SCRIPT_DIR/generate.ts"
