#!/usr/bin/env bash
# scripts/deploy.sh — atomic local deploy for the Org Studio dashboard.
#
# Why this exists (#1261, 2026-05-06):
# The dashboard runs in production mode (`dev = false` in server.mjs), so a
# `systemctl --user restart mc-dashboard.service` alone serves the *previously
# compiled* `.next/` bundle. Forgetting to run `npm run build` first means
# source changes never reach the user. This script makes "deploy the
# dashboard" idempotent: build → restart → wait healthy → print the running
# BUILD_ID + git SHA so it is obvious which commit is live.
#
# Usage:
#   ./scripts/deploy.sh              # build + restart + verify
#   ./scripts/deploy.sh --skip-build # restart only (e.g. after rotating env)
#   ./scripts/deploy.sh --no-restart # build only (CI / dry run)
#
# Exit codes:
#   0  success (or no-restart build success)
#   1  build failed
#   2  restart failed (service not active within timeout)
#   3  health check failed (service active but homepage not reachable)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SERVICE="mc-dashboard.service"
HEALTH_URL="http://localhost:4501/"
HEALTH_TIMEOUT=20  # seconds to wait for service + homepage

SKIP_BUILD=0
NO_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --no-restart) NO_RESTART=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "deploy.sh: unknown arg: $arg" >&2
      exit 64
      ;;
  esac
done

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
echo "==> deploying org-studio @ $BRANCH ($GIT_SHA)"

# Refuse to deploy a dirty tree by default — easy to forget commits otherwise.
# Override by setting DEPLOY_ALLOW_DIRTY=1 (rare; only for ad-hoc local tries).
if [[ -z "${DEPLOY_ALLOW_DIRTY:-}" ]] && ! git diff --quiet HEAD --; then
  echo "==> WARN: working tree is dirty; uncommitted changes will be in the build." >&2
  echo "    set DEPLOY_ALLOW_DIRTY=1 to silence this." >&2
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> npm run build"
  npm run build
else
  echo "==> --skip-build set; not rebuilding"
fi

if [[ "$NO_RESTART" -eq 1 ]]; then
  echo "==> --no-restart set; build only, exiting."
  exit 0
fi

echo "==> systemctl --user restart $SERVICE"
systemctl --user restart "$SERVICE"

# Wait for service to become active (systemd may take a moment).
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while :; do
  state="$(systemctl --user is-active "$SERVICE" || true)"
  if [[ "$state" == "active" ]]; then break; fi
  if [[ "$(date +%s)" -ge "$deadline" ]]; then
    echo "==> ERROR: $SERVICE did not reach active within ${HEALTH_TIMEOUT}s (state=$state)" >&2
    exit 2
  fi
  sleep 1
done

# Wait for homepage to respond (any 2xx/3xx).
while :; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL" || echo 000)"
  if [[ "$code" =~ ^[23] ]]; then break; fi
  if [[ "$(date +%s)" -ge "$deadline" ]]; then
    echo "==> ERROR: homepage health check failed (last code=$code)" >&2
    exit 3
  fi
  sleep 1
done

BUILD_ID="$(cat .next/BUILD_ID 2>/dev/null || echo unknown)"
echo "==> live: BUILD_ID=$BUILD_ID  SHA=$GIT_SHA  branch=$BRANCH"
echo "==> $HEALTH_URL responded $code"
