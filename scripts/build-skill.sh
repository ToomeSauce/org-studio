#!/usr/bin/env bash
# scripts/build-skill.sh — Build the org-studio-api skill bundle for ClawHub.
#
# What this does:
#   1. Validates the canonical source at skills/org-studio-api/ (SKILL.md must exist).
#   2. Zips the directory contents into skills/dist/org-studio-api.skill
#   3. Stamps the zip with the current git short SHA in a sidecar file.
#
# What this does NOT do (yet):
#   - Publish to ClawHub. That step is currently manual.
#     See README "Publishing the org-studio-api skill" section.
#
# Usage:
#   npm run build:skill
#   or:  bash scripts/build-skill.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/skills/org-studio-api"
OUT_DIR="$REPO_ROOT/skills/dist"
OUT_FILE="$OUT_DIR/org-studio-api.skill"
SIDECAR="$OUT_DIR/org-studio-api.skill.sha"

if [[ ! -f "$SRC_DIR/SKILL.md" ]]; then
  echo "ERROR: missing $SRC_DIR/SKILL.md — nothing to build." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

if ! command -v zip >/dev/null 2>&1; then
  echo "ERROR: 'zip' is not installed. Install with: sudo apt-get install zip" >&2
  exit 1
fi

# Pull current git SHA (best-effort — works even if uncommitted edits exist)
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
PKG_VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo 'unknown')"

# Clean previous build
rm -f "$OUT_FILE" "$SIDECAR"

echo "Building skill bundle..."
echo "  source:  $SRC_DIR"
echo "  output:  $OUT_FILE"
echo "  version: $PKG_VERSION (git $GIT_SHA)"

# Zip from inside the skill dir so paths are relative (SKILL.md, references/...)
(cd "$SRC_DIR" && zip -rq "$OUT_FILE" . -x "*.DS_Store" "node_modules/*" ".git/*")

# Sidecar with build metadata (NOT zipped — for human inspection / CI)
cat > "$SIDECAR" <<EOF
skill: org-studio-api
package_version: $PKG_VERSION
git_sha: $GIT_SHA
built_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
size_bytes: $(stat -c '%s' "$OUT_FILE")
EOF

echo
echo "✓ Built $(stat -c '%s' "$OUT_FILE") bytes → $OUT_FILE"
echo "✓ Metadata → $SIDECAR"
echo
echo "Next step: publish to ClawHub. See README 'Publishing the org-studio-api skill'."
