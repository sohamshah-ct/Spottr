#!/usr/bin/env bash
# deploy_modal.sh — safe Modal deploy for spottr-detection
#
# USAGE: bash backend/scripts/deploy_modal.sh
#
# This is the ONLY way Modal should be deployed going forward.
# Running `modal deploy` directly leaves the previous app version
# running (billing GPU idle) until Modal's own overlap window ends.
# This script explicitly stops the old deployed version first.
#
# What it does:
#   1. Find the currently deployed spottr-detection app (if any)
#   2. Deploy the new version  (Modal starts new containers)
#   3. Stop the old app by ID  (prevents double-billing during overlap)

set -euo pipefail

APP_NAME="spottr-detection"
DETECT_PY="backend/modal/detect.py"

# Resolve script location so this works from any working directory
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "==> Looking for currently deployed $APP_NAME app..."

# Grab the app ID of the currently deployed version before we overwrite it.
# `modal app list --json` emits a JSON array; we pick the first entry whose
# State is "deployed" and Description matches our app name.
OLD_APP_ID=$(python -m modal app list --json 2>/dev/null \
  | python -c "
import sys, json
apps = json.load(sys.stdin)
for a in apps:
    if a.get('State') == 'deployed' and '$APP_NAME' in a.get('Description', ''):
        print(a['App ID'])
        break
" 2>/dev/null || true)

if [ -n "$OLD_APP_ID" ]; then
  echo "    Found deployed app: $OLD_APP_ID"
else
  echo "    No currently deployed app found — clean deploy."
fi

echo "==> Deploying $DETECT_PY ..."
python -m modal deploy "$DETECT_PY"

if [ -n "$OLD_APP_ID" ]; then
  echo "==> Stopping old app $OLD_APP_ID to end GPU billing..."
  python -m modal app stop "$OLD_APP_ID"
  echo "    Stopped."
fi

echo "==> Done. Verify with: python -m modal app list"
