#!/usr/bin/env bash
# scripts/sync-skills.sh — Sync the canonical org-studio-api skill into every
# OpenClaw agent workspace that has it installed.
#
# What this does:
#   1. Discovers agent workspaces at $OPENCLAW_WORKSPACES_ROOT (default:
#      ~/.openclaw) matching the pattern  workspace-*/skills/org-studio-api/.
#   2. For each, overwrites SKILL.md and references/*.md from the canonical
#      repo source at skills/org-studio-api/. (No other files touched —
#      agents may keep workspace-specific notes elsewhere in their skill dir.)
#   3. Idempotent: re-running is a no-op (skips files that already match).
#   4. Skips workspaces that don't have the skill dir yet (does NOT
#      bootstrap a new install — that's an explicit op).
#
# Why this exists:
#   The repo skills/org-studio-api/ is the ClawHub-bundle source.
#   ~/.openclaw/workspace-*/skills/org-studio-api/ is what agents READ on
#   session start. Without this script the two silently drift; v0.4.0 release
#   surfaced 6/7 stale workspaces. (Filed as #1537.)
#
# Usage:
#   npm run sync-skills              # uses default workspaces root
#   OPENCLAW_WORKSPACES_ROOT=/tmp/x npm run sync-skills
#   bash scripts/sync-skills.sh --dry-run
#   bash scripts/sync-skills.sh --quiet
#
# Exit codes:
#   0  success (any number of workspaces synced, including zero)
#   1  fatal error (missing source, IO failure)

set -euo pipefail

DRY_RUN=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --quiet)   QUIET=1 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/skills/org-studio-api"
WORKSPACES_ROOT="${OPENCLAW_WORKSPACES_ROOT:-$HOME/.openclaw}"

log()  { [[ $QUIET -eq 1 ]] || echo "$@"; }
logf() { [[ $QUIET -eq 1 ]] || printf "$@"; }

if [[ ! -f "$SRC_DIR/SKILL.md" ]]; then
  echo "ERROR: canonical source missing: $SRC_DIR/SKILL.md" >&2
  exit 1
fi

if [[ ! -d "$WORKSPACES_ROOT" ]]; then
  log "Workspaces root not found: $WORKSPACES_ROOT (nothing to sync)"
  exit 0
fi

log "Syncing skill from canonical source:"
log "  source:    $SRC_DIR"
log "  workspaces: $WORKSPACES_ROOT/workspace-*/skills/org-studio-api/"
[[ $DRY_RUN -eq 1 ]] && log "  mode:      DRY RUN (no writes)"
log ""

# Build list of canonical files to mirror (SKILL.md + references/*.md only).
# Anything else in the source dir is ignored.
CANONICAL_FILES=()
while IFS= read -r canonical_file; do
  CANONICAL_FILES+=("$canonical_file")
done < <(
  cd "$SRC_DIR" && {
    [[ -f SKILL.md ]] && echo "SKILL.md"
    [[ -d references ]] && find references -maxdepth 1 -type f -name '*.md' | sort
  }
)

if [[ ${#CANONICAL_FILES[@]} -eq 0 ]]; then
  echo "ERROR: no canonical files found in $SRC_DIR" >&2
  exit 1
fi

# Discover target workspaces. Only those that ALREADY have the skill dir —
# we don't bootstrap installs here.
TARGETS=()
while IFS= read -r target_workspace; do
  TARGETS+=("$target_workspace")
done < <(
  find "$WORKSPACES_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'workspace-*' 2>/dev/null \
    | while read -r ws; do
        [[ -d "$ws/skills/org-studio-api" ]] && echo "$ws"
      done \
    | sort
)

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  log "No agent workspaces found with skills/org-studio-api/ — nothing to sync."
  exit 0
fi

SYNCED=0
SKIPPED=0
UPDATED_WORKSPACES=0

for ws in "${TARGETS[@]}"; do
  ws_name="$(basename "$ws")"
  ws_changed=0
  for rel in "${CANONICAL_FILES[@]}"; do
    src="$SRC_DIR/$rel"
    dst="$ws/skills/org-studio-api/$rel"
    dst_dir="$(dirname "$dst")"

    if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
      SKIPPED=$((SKIPPED+1))
      continue
    fi

    if [[ $DRY_RUN -eq 1 ]]; then
      logf "  [dry] %s ← %s\n" "$ws_name/$rel" "(canonical)"
    else
      mkdir -p "$dst_dir"
      cp "$src" "$dst"
      logf "  ✓ %s\n" "$ws_name/$rel"
    fi
    SYNCED=$((SYNCED+1))
    ws_changed=1
  done
  if [[ $ws_changed -eq 1 ]]; then
    UPDATED_WORKSPACES=$((UPDATED_WORKSPACES+1))
  fi
done

log ""
log "Sync complete:"
log "  workspaces inspected: ${#TARGETS[@]}"
log "  workspaces updated:   $UPDATED_WORKSPACES"
log "  files written:        $SYNCED"
log "  files already in sync: $SKIPPED"
if [[ $DRY_RUN -eq 1 ]]; then
  log "  (dry run — no files actually changed)"
fi
