#!/usr/bin/env bash
# Package a clean submission ZIP for Google Drive upload (excludes heavy caches)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIP_NAME="NEXUS-Hackathon-Submission.zip"

cd "$ROOT_DIR"
echo "==> Creating $ZIP_NAME..."

# Remove old zip if present
rm -f "$ZIP_NAME"

# Zip project files while excluding large cache/binary directories
zip -r "$ZIP_NAME" . \
  -x "target/*" \
  -x "src-tauri/target/*" \
  -x "frontend/node_modules/*" \
  -x "frontend/dist/*" \
  -x ".git/*" \
  -x ".github/*" \
  -x "*.zip" \
  -x ".env" \
  -x ".env.*"

echo "==> Done! Created $ROOT_DIR/$ZIP_NAME"
ls -lh "$ZIP_NAME"
