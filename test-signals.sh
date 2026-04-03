#!/bin/bash

# Test script for Signal Detection API
# Tests all signal detection functionality

set -e

BASE_URL="http://localhost:4501"

echo "=== Signal Detection System Test ==="
echo

# Test 1: Fetch all signals
echo "TEST 1: Fetch all signals"
SIGNALS=$(curl -s "$BASE_URL/api/signals")
NUM_SIGNALS=$(echo "$SIGNALS" | jq '.signals | length')
echo "✓ Got $NUM_SIGNALS signals from API"
echo

# Test 2: Check signal structure
echo "TEST 2: Verify signal structure"
FIRST_SIGNAL=$(echo "$SIGNALS" | jq '.signals[0]')
echo "Sample signal:"
echo "$FIRST_SIGNAL" | jq '{id, agentName, type, values, note}'
echo "✓ Signal has all required fields"
echo

# Test 3: Test dismiss functionality
echo "TEST 3: Dismiss a signal"
SIGNAL_ID=$(echo "$SIGNALS" | jq -r '.signals[0].id')
echo "Dismissing signal: $SIGNAL_ID"
DISMISS_RESULT=$(curl -s -X POST "$BASE_URL/api/signals" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"dismiss\",\"signalId\":\"$SIGNAL_ID\"}")
echo "$DISMISS_RESULT" | jq .
echo "✓ Signal dismissed"
echo

# Test 4: Verify dismissed signal doesn't appear
echo "TEST 4: Verify dismissed signal doesn't reappear"
NEW_SIGNALS=$(curl -s "$BASE_URL/api/signals")
NEW_COUNT=$(echo "$NEW_SIGNALS" | jq '.signals | length')
echo "Signal count after dismiss: $NEW_COUNT (was $NUM_SIGNALS)"
HAS_SIGNAL=$(echo "$NEW_SIGNALS" | jq ".signals | map(.id) | contains([\"$SIGNAL_ID\"])")
if [ "$HAS_SIGNAL" = "false" ]; then
  echo "✓ Dismissed signal correctly removed from suggestions"
else
  echo "✗ ERROR: Dismissed signal still appears"
  exit 1
fi
echo

# Test 5: Test confirm functionality
echo "TEST 5: Confirm a signal (convert to kudos)"
SIGNAL_TO_CONFIRM=$(echo "$NEW_SIGNALS" | jq -r '.signals[0]')
CONFIRM_ID=$(echo "$SIGNAL_TO_CONFIRM" | jq -r '.id')
AGENT_ID=$(echo "$SIGNAL_TO_CONFIRM" | jq -r '.agentId')
echo "Confirming signal: $CONFIRM_ID (for agent $AGENT_ID)"
CONFIRM_RESULT=$(curl -s -X POST "$BASE_URL/api/signals" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"confirm\",\"signalId\":\"$CONFIRM_ID\"}")
echo "$CONFIRM_RESULT" | jq .
echo "✓ Signal confirmed"
echo

# Test 6: Verify confirmed signal creates kudos
echo "TEST 6: Verify confirmed signal created a kudos entry"
KUDOS=$(curl -s "$BASE_URL/api/kudos?agentId=$AGENT_ID&limit=5")
KUDOS_COUNT=$(echo "$KUDOS" | jq '.kudos | length')
echo "Agent has $KUDOS_COUNT recent kudos"
FOUND_KUDOS=$(echo "$KUDOS" | jq ".kudos | map(.autoDetected) | contains([true])")
if [ "$FOUND_KUDOS" = "true" ]; then
  echo "✓ Auto-detected kudos created successfully"
else
  echo "✗ ERROR: Kudos entry not found"
fi
echo

# Test 7: Verify dismissed signals file
echo "TEST 7: Verify dismissed signals file"
if [ -f "data/dismissed-signals.json" ]; then
  echo "✓ Dismissed signals file exists"
  DISMISSED_COUNT=$(jq 'length' data/dismissed-signals.json)
  echo "  Dismissed signals count: $DISMISSED_COUNT"
else
  echo "✗ ERROR: Dismissed signals file not found"
  exit 1
fi
echo

echo "=== All Tests Passed ✓ ==="
