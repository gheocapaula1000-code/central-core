#!/usr/bin/env bash
# audit-release.sh — Full pre-release audit: secrets + package + lint + test + build
set -euo pipefail

echo "═══════════════════════════════════════════════"
echo "  Central Core V3 — Release Audit"
echo "  Version: $(node -p "require('./package.json').version")"
echo "  Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "═══════════════════════════════════════════════"

STEP=0
FAIL=0

run_step() {
  STEP=$((STEP + 1))
  echo ""
  echo "── Step $STEP: $1 ──"
  if eval "$2"; then
    echo "  ✓ $1 passed"
  else
    echo "  ✗ $1 FAILED"
    FAIL=$((FAIL + 1))
  fi
}

run_step "Secret scan"     "bash scripts/verify-secrets.sh"
run_step "Package check"   "bash scripts/verify-package.sh"
run_step "Lint"            "npx eslint . --max-warnings 0"
run_step "Typecheck"       "npx tsc --noEmit"
run_step "Tests"           "npx vitest run"
run_step "Build"           "npx vite build"

echo ""
echo "═══════════════════════════════════════════════"
echo "  AUDIT SUMMARY: $STEP steps, $FAIL failures"
if [ $FAIL -eq 0 ]; then
  echo "  ✓ RELEASE AUDIT PASSED"
else
  echo "  ✗ RELEASE AUDIT FAILED — fix $FAIL issue(s)"
fi
echo "═══════════════════════════════════════════════"

exit $FAIL
