#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CLONE="$TMP/repo"
git clone --quiet --no-local "$ROOT" "$CLONE"
cd "$CLONE"

npm ci
npm run typecheck
npm run build
node scripts/product-unit-smoke.cjs
node scripts/product-integration-smoke.cjs
node scripts/product-acceptance-smoke.cjs

printf '%s\n' '{"ok":true,"decision":"product_clean_clone_ready"}'
