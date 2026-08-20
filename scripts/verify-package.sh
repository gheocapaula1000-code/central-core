#!/usr/bin/env bash
# verify-package.sh — Validates the project is packaging-safe
set -euo pipefail

EXIT_CODE=0

echo "═══════════════════════════════════════════════"
echo "  Central Core V3 — Package Integrity Check"
echo "═══════════════════════════════════════════════"

# 1. No real .env files
echo ""
echo "▸ Checking no dangerous .env variants in package..."
# Note: root .env is auto-managed by Lovable Cloud and excluded from git — skip it.
ENV_FILES=$(find . -maxdepth 3 \( -name '.env.local' -o -name '.env.*.local' \) 2>/dev/null | grep -v node_modules || true)
if [ -n "$ENV_FILES" ]; then
  echo "  ✗ FAIL: Dangerous .env variants found:"
  echo "$ENV_FILES" | sed 's/^/    /'
  EXIT_CODE=1
else
  echo "  ✓ No dangerous .env variants"
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
DEV_ARTIFACTS=(.env.local .env.development.local .env.production.local .env.test.local)
FOUND_DEV=""
for artifact in "${DEV_ARTIFACTS[@]}"; do
  if [ -f "$artifact" ]; then
    FOUND_DEV="$FOUND_DEV $artifact"
  fi
done
# Note: root .env is auto-managed by Lovable Cloud and excluded from git — not a packaging concern.
if [ -n "$FOUND_DEV" ]; then
  echo "  ✗ FAIL: Dev-only files found:$FOUND_DEV"
  EXIT_CODE=1
else
  echo "  ✓ No dev-only artifacts"
fi

# 5b. No dump/cache/temp files in tracked repo
echo ""
echo "▸ Checking for dump/cache/temp files..."
JUNK_FILES=$(find . -maxdepth 3 \( -name '*.dump' -o -name '*.bak' -o -name '*.tmp' -o -name '*.log' -o -name '*.cache' -o -name '.DS_Store' -o -name 'Thumbs.db' -o -name '*.swp' -o -name '*.swo' \) -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' 2>/dev/null || true)
if [ -n "$JUNK_FILES" ]; then
  echo "  ✗ FAIL: Junk files found:"
  echo "$JUNK_FILES" | sed 's/^/    /'
  EXIT_CODE=1
else
  echo "  ✓ No junk files"
fi

# 6. Build output exists (if post-build)
echo ""
echo "▸ Checking build output..."
if [ -d "dist" ]; then
  echo "  ✓ dist/ present"
  # 6b. Ensure no .env leaked into dist
  ENV_IN_DIST=$(find dist -name '.env*' 2>/dev/null || true)
  if [ -n "$ENV_IN_DIST" ]; then
    echo "  ✗ FAIL: .env files found in dist/:"
    echo "$ENV_IN_DIST" | sed 's/^/    /'
    EXIT_CODE=1
  else
    echo "  ✓ No .env in dist/"
  fi
else
  echo "  ⚠ dist/ not found — run build first if packaging"
fi

# 7. Lockfile consistency
echo ""
echo "▸ Checking lockfile..."
if [ -f "package-lock.json" ]; then
  echo "  ✓ package-lock.json present (canonical: npm)"
else
  echo "  ⚠ package-lock.json missing — run npm install"
fi

# 8. Operational docs presence
echo ""
echo "▸ Checking operational docs..."
REQUIRED_DOCS=("docs/changelog.md" "docs/release-acceptance-checklist.md" "docs/release-pipeline.md" "docs/contract-registry.md" "docs/operational-checklist.md" "docs/edge-function-auth-matrix.md")
MISSING_DOCS=""
for doc in "${REQUIRED_DOCS[@]}"; do
  if [ ! -f "$doc" ]; then
    MISSING_DOCS="$MISSING_DOCS $doc"
  fi
done
if [ -n "$MISSING_DOCS" ]; then
  echo "  ✗ FAIL: Required operational docs missing:$MISSING_DOCS"
  EXIT_CODE=1
else
  echo "  ✓ All required operational docs present (${#REQUIRED_DOCS[@]})"
fi

# 8b. Deploy headers artifact
echo ""
echo "▸ Checking deploy headers artifact..."
if [ -f "public/_headers" ]; then
  echo "  ✓ public/_headers present"
else
  echo "  ✗ FAIL: public/_headers missing"
  EXIT_CODE=1
fi

# 8c. index.html security meta baseline
echo ""
echo "▸ Checking index.html security meta..."
INDEX_FAIL=0
# Security headers are enforced via public/_headers (single authoritative source)
# index.html should NOT contain http-equiv CSP or X-Content-Type-Options
if grep -q 'http-equiv="Content-Security-Policy"' index.html 2>/dev/null; then
  echo "  ✗ FAIL: index.html contains redundant CSP meta (must be in _headers only)"
  INDEX_FAIL=1
fi
if grep -q 'http-equiv="X-Content-Type-Options"' index.html 2>/dev/null; then
  echo "  ✗ FAIL: index.html contains redundant X-Content-Type-Options meta (must be in _headers only)"
  INDEX_FAIL=1
fi
if ! grep -q 'noindex' index.html 2>/dev/null; then
  echo "  ✗ FAIL: index.html missing noindex"
  INDEX_FAIL=1
fi
if ! grep -q '_headers' index.html 2>/dev/null; then
  echo "  ✗ FAIL: index.html missing reference to _headers as authoritative source"
  INDEX_FAIL=1
fi
if [ $INDEX_FAIL -eq 0 ]; then
  echo "  ✓ index.html security meta baseline OK"
else
  EXIT_CODE=1
fi

# 9. No localhost in build output
echo ""
echo "▸ Checking for localhost in build output..."
if [ -d "dist" ]; then
  LOCALHOST_IN_DIST=$(grep -rn --include='*.js' --include='*.html' -E 'https?://localhost[:/]' dist/ 2>/dev/null \
    | grep -v '//# sourceMappingURL' \
    | grep -v 'http://localhost:9999' \
    || true)
  if [ -n "$LOCALHOST_IN_DIST" ]; then
    echo "  ✗ FAIL: localhost URLs found in dist/:"
    echo "$LOCALHOST_IN_DIST" | head -3 | sed 's/^/    /'
    EXIT_CODE=1
  else
    echo "  ✓ No localhost URLs in dist/"
  fi
else
  echo "  ⚠ dist/ not found — skipping"
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
