#!/bin/bash
# safe-deploy.sh - pre/post-deploy safety wrapper for vendyai-com-worker.
#
# Built 2026-09-24, generalizing workers/venture-fleet/safe-deploy.sh's
# proven pattern (see /Users/johnmobley/mascom/safe-deploy-lib.sh) to this
# repo. vendyai.com is its own dedicated git repo (not part of the shared
# nginx/ multi-venture tree), but the same underlying hazard applies -
# AGENTS.md incident #4b: multiple concurrent Claude Code
# sessions/agents can read/write/deploy from this SAME on-disk checkout.
#
# Why this one matters more than most: per mascom/CLAUDE.md's "vendyai for
# selling, AuthFor for auth" standing policy, VendyAI is the shared checkout
# backend every registered venture's billing routes call through (weylandai.com,
# authfor.com, and others per that policy and ventures.json's `consumes`
# field). A silently dropped DB binding here wouldn't just break vendyai.com
# itself, it would break every consumer venture's checkout path at once -
# the same blast-radius shape as the MOBLEYBOOKS_STORE incident this pattern
# exists to prevent.
#
# Real binding found by reading this repo's own wrangler.toml (not guessed):
# DB (d1_databases, database_name "vendyai_ledger") - the only binding
# declared, backing every venture registration, checkout session, and the
# daily stale-checkout-session prune cron.
#
# Usage: ./safe-deploy.sh [extra wrangler deploy args]

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source /Users/johnmobley/mascom/safe-deploy-lib.sh

REPO_ROOT="$(git rev-parse --show-toplevel)"
CONFIG="wrangler.toml"

sd_banner "vendyai-com-worker"

# 1. Branch check.
sd_require_branch "$REPO_ROOT" main

# 2. Clean-tree check - this is a dedicated single-venture repo, so check
#    the whole tree rather than scoping to a subpath.
sd_require_clean_tree "$REPO_ROOT"

# 3. Positive binding assertion - the one D1 database this whole worker's
#    ledger (venture registrations, checkout sessions) depends on.
sd_require_config_lines "$CONFIG" \
  'binding = "DB"||D1 database (vendyai_ledger) backing venture registration + every checkout session across every registered consumer venture'

echo "Pre-deploy checks passed: on main, clean tree, required bindings present."

# 4. Deploy for real.
sd_deploy "$CONFIG" "$@"

# 5. Post-deploy live verification against the real, unauthenticated health
#    probe (GET /health) - checks for a real field rather than just a bare
#    200, so a fallback/wrong-worker response wouldn't false-pass.
echo ""
echo "== post-deploy verification =="
sd_verify_response_body \
  "https://vendyai.com/health" \
  '"service": "vendyai-com-worker"'

sd_banner_done "vendyai-com-worker"
