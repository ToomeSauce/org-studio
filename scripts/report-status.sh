#!/bin/bash
# Usage: report-status.sh <agent> <status> [detail]
# Example: report-status.sh mikey "editing garage.py" "Adding write API endpoints"
# Clear:   report-status.sh mikey clear

AGENT="$1"
STATUS="$2"
DETAIL="$3"
MC_URL="${MC_URL:-http://localhost:4501}"

if [ -z "$AGENT" ] || [ -z "$STATUS" ]; then
  echo "Usage: report-status.sh <agent> <status> [detail]"
  exit 1
fi

if [ "$STATUS" = "clear" ] || [ "$STATUS" = "idle" ]; then
  curl -s "$MC_URL/api/activity-status" -X DELETE \
    -H "Content-Type: application/json" \
    -d "{\"agent\":\"$AGENT\"}" > /dev/null
  echo "Cleared status for $AGENT"
else
  BODY="{\"agent\":\"$AGENT\",\"status\":\"$STATUS\""
  if [ -n "$DETAIL" ]; then
    BODY="$BODY,\"detail\":\"$DETAIL\""
  fi
  BODY="$BODY}"
  curl -s "$MC_URL/api/activity-status" -X POST \
    -H "Content-Type: application/json" \
    -d "$BODY" > /dev/null
  echo "Reported: $AGENT → $STATUS"
fi
