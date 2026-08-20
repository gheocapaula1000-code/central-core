#!/usr/bin/env bash
# verify-secrets.sh — Checks that no real secrets are present in the codebase
set -euo pipefail

EXIT_CODE=0

echo "═══════════════════════════════════════════════"
echo "  Central Core V3 — Secret Leak Scanner"
echo "═══════════════════════════════════════════════"

# 1. Check for real .env files (not .env.example)
echo ""
echo "▸ Checking for real .env files..."
# Note: ./.env is auto-managed by Lovable Cloud at runtime and excluded from git.
# We check for NON-root .env files and dangerous variants that should never exist.
DANGEROUS_ENV=$(find . -maxdepth 3 \( -name '.env.local' -o -name '.env.development.local' -o -name '.env.production.local' -o -name '.env.test.local' \) 2>/dev/null | grep -v node_modules || true)
if [ -n "$DANGEROUS_ENV" ]; then
  echo "  ✗ FAIL: Dangerous .env variants found:"
  echo "$DANGEROUS_ENV" | sed 's/^/    /'
  EXIT_CODE=1
else
  echo "  ✓ No dangerous .env variants found"
fi
if [ -f ".env" ]; then
  echo "  ⚠ .env present (auto-managed by platform, excluded from git)"
fi

# 2. Check for hardcoded API keys patterns
echo ""
echo "▸ Scanning for hardcoded API key patterns..."
PATTERNS=(
  'sk-[a-zA-Z0-9]{20,}'
  'sk-proj-[a-zA-Z0-9]'
  'sk-ant-[a-zA-Z0-9]'
  'whsec_[a-zA-Z0-9]'
  'pk_live_[a-zA-Z0-9]'
  'sk_live_[a-zA-Z0-9]'
  'ghp_[a-zA-Z0-9]{36}'
  'glpat-[a-zA-Z0-9]'
)

for pattern in "${PATTERNS[@]}"; do
  MATCHES=$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' --include='*.md' -E "$pattern" . --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null || true)
  if [ -n "$MATCHES" ]; then
    echo "  ✗ FAIL: Pattern '$pattern' found:"
    echo "$MATCHES" | head -5 | sed 's/^/    /'
    EXIT_CODE=1
  fi
done

if [ $EXIT_CODE -eq 0 ]; then
  echo "  ✓ No hardcoded API keys detected"
fi

# 3. Check for JWT tokens hardcoded in source files (not .env, not .env.example)
echo ""
echo "▸ Scanning for hardcoded JWT tokens in source..."
JWT_MATCHES=$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' 'eyJhbGci' . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=src/test \
  --exclude='*.test.ts' --exclude='*.test.tsx' 2>/dev/null || true)
if [ -n "$JWT_MATCHES" ]; then
  echo "  ✗ FAIL: Hardcoded JWT tokens found in source:"
  echo "$JWT_MATCHES" | head -5 | sed 's/^/    /'
  EXIT_CODE=1
else
  echo "  ✓ No hardcoded JWT tokens in source"
fi

# 4. Verify .env.example exists
echo ""
echo "▸ Checking .env.example presence..."
if [ -f ".env.example" ]; then
  echo "  ✓ .env.example present"
else
  echo "  ✗ FAIL: .env.example missing"
  EXIT_CODE=1
fi

# 5. Verify .gitignore blocks .env
echo ""
echo "▸ Checking .gitignore rules..."
if grep -q '^\.env$' .gitignore 2>/dev/null; then
  echo "  ✓ .gitignore blocks .env"
else
  echo "  ✗ FAIL: .gitignore does not explicitly block .env"
  EXIT_CODE=1
fi

# 6. Check for localhost URLs in build output
echo ""
echo "▸ Checking for localhost URLs in dist/..."
if [ -d "dist" ]; then
  # supabase-js / gotrue-js embed http://localhost:9999 as a library default.
  LOCALHOST_HITS=$(grep -rn --include='*.js' --include='*.html' -E 'https?://localhost[:/]' dist/ 2>/dev/null \
    | grep -v '//# sourceMappingURL' \
    | grep -v 'http://localhost:9999' \
    || true)
  if [ -n "$LOCALHOST_HITS" ]; then
    echo "  ✗ FAIL: localhost URLs found in build output:"
    echo "$LOCALHOST_HITS" | head -5 | sed 's/^/    /'
    EXIT_CODE=1
  else
    echo "  ✓ No localhost URLs in dist/"
  fi
else
  echo "  ⚠ dist/ not found — skipping localhost check"
fi

echo ""
echo "═══════════════════════════════════════════════"
if [ $EXIT_CODE -eq 0 ]; then
  echo "  ✓ ALL CHECKS PASSED — no secrets detected"
else
  echo "  ✗ CHECKS FAILED — review findings above"
fi
echo "═══════════════════════════════════════════════"

exit $EXIT_CODE
