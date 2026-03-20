#!/usr/bin/env bash
# verify-package.sh — Validates the project is packaging-safe
set -euo pipefail

EXIT_CODE=0

echo "═══════════════════════════════════════════════"
echo "  Central Core V3 — Package Integrity Check"
echo "═══════════════════════════════════════════════"

# 1. No real .env files
echo ""
echo "▸ Checking no real .env in package..."
ENV_FILES=$(find . -maxdepth 3 -name '.env' -o -name '.env.local' -o -name '.env.*.local' 2>/dev/null | grep -v node_modules | grep -v '.env.example' || true)
if [ -n "$ENV_FILES" ]; then
  echo "  ✗ FAIL: Real .env files would be included:"
  echo "$ENV_FILES" | sed 's/^/    /'
  EXIT_CODE=1
else
  echo "  ✓ No real .env files"
fi

# 2. .env.example present
echo ""
echo "▸ Checking .env.example..."
if [ -f ".env.example" ]; then
  echo "  ✓ .env.example present"
else
  echo "  ✗ FAIL: .env.example missing"
  EXIT_CODE=1
fi

# 3. README present
echo ""
echo "▸ Checking README..."
if [ -f "README.md" ]; then
  echo "  ✓ README.md present"
else
  echo "  ✗ FAIL: README.md missing"
  EXIT_CODE=1
fi

# 4. Docs directory present
echo ""
echo "▸ Checking docs..."
if [ -d "docs" ] && [ "$(ls -A docs/*.md 2>/dev/null | wc -l)" -gt 0 ]; then
  DOC_COUNT=$(ls docs/*.md 2>/dev/null | wc -l)
  echo "  ✓ docs/ present with $DOC_COUNT documents"
else
  echo "  ✗ FAIL: docs/ missing or empty"
  EXIT_CODE=1
fi

# 5. No dev-only artifacts that shouldn't ship
echo ""
echo "▸ Checking for dev-only artifacts..."
DEV_ARTIFACTS=(.env .env.local .env.development.local .env.production.local .env.test.local)
FOUND_DEV=""
for artifact in "${DEV_ARTIFACTS[@]}"; do
  if [ -f "$artifact" ]; then
    FOUND_DEV="$FOUND_DEV $artifact"
  fi
done
if [ -n "$FOUND_DEV" ]; then
  echo "  ✗ FAIL: Dev-only files found:$FOUND_DEV"
  EXIT_CODE=1
else
  echo "  ✓ No dev-only artifacts"
fi

# 6. Build output exists (if post-build)
echo ""
echo "▸ Checking build output..."
if [ -d "dist" ]; then
  echo "  ✓ dist/ present"
else
  echo "  ⚠ dist/ not found — run build first if packaging"
fi

echo ""
echo "═══════════════════════════════════════════════"
if [ $EXIT_CODE -eq 0 ]; then
  echo "  ✓ PACKAGE CHECK PASSED"
else
  echo "  ✗ PACKAGE CHECK FAILED"
fi
echo "═══════════════════════════════════════════════"

exit $EXIT_CODE
