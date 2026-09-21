#!/usr/bin/env bash
# Headless regression battery for pi-agentdeck-agents.
# Read-only: exercises verify scripts + extension commands, asserts outputs.
# Usage: ./scripts/smoke.sh   (or: npm run smoke)
set -u
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
MODEL_ARGS=(--provider opencode-go --model deepseek-v4.1-flash)

pi_cmd() {
  timeout 150 pi -p "${MODEL_ARGS[@]}" --no-session "$1" 2>&1 | tail -40
}

expect_contains() { # name, needle, haystack
  if printf '%s' "$3" | grep -qF "$2"; then
    echo "ok   $1"
    PASS=$((PASS + 1))
  else
    echo "FAIL $1 (missing: $2)"
    FAIL=$((FAIL + 1))
  fi
}

npm run --silent verify:fidelity 2>&1 | grep -q "12/12 identical" \
  && { echo "ok   fidelity"; PASS=$((PASS + 1)); } \
  || { echo "FAIL fidelity"; FAIL=$((FAIL + 1)); }

npm run --silent verify:models 2>&1 | grep -q "resolve locally" \
  && { echo "ok   models"; PASS=$((PASS + 1)); } \
  || { echo "FAIL models"; FAIL=$((FAIL + 1)); }

expect_contains "doctor-baseline" "baseline:" "$(pi_cmd "/agentdeck doctor")"
expect_contains "doctor-overlay" "overlay:" "$(pi_cmd "/agentdeck doctor")"
expect_contains "doctor-spend" "spend today:" "$(pi_cmd "/agentdeck doctor")"
expect_contains "routing" "Available agents" "$(pi_cmd "/agentdeck-routing")"
expect_contains "flow-classify-plan" "→ plan" "$(pi_cmd "/agentdeck-flow test 帮我重构这个模块")"
expect_contains "flow-classify-none" "→ none" "$(pi_cmd "/agentdeck-flow test 改个注释里的错别字")"
expect_contains "budget-show" "spend today:" "$(pi_cmd "/agentdeck budget")"
expect_contains "tooldesc-status" "Agent tool description" "$(pi_cmd "/agentdeck-tooldesc")"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
