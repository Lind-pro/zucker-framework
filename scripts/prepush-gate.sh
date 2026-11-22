#!/bin/sh
# Local gate for pushing main (see docs/package-release.md). Run it before `git push`:
#
#   pnpm verify:prepush && git push origin main
#
# The gate takes many minutes. Running it inside the pre-push hook keeps the push's SSH
# connection idle for that long, and GitHub may close it, so git dies with SIGPIPE (exit
# 141) after every check passed. When this script passes on a clean worktree it records the
# verified commit, and the hook then lets exactly that commit through without rerunning.
set -eu

root="$(git rev-parse --show-toplevel)"
cd "$root"

step() { printf '\n▶ pre-push gate: %s\n' "$1" >&2; }

head_sha="$(git rev-parse HEAD)"
clean=1
# Only a clean worktree proves the checked bytes are the committed bytes.
if ! git diff --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  clean=0
  echo "pre-push gate: worktree has uncommitted changes; checks run but the commit is not recorded as verified" >&2
fi

step "build packages"
pnpm build:packages

step "package content + legal"
pnpm legal:prepare >/dev/null
pnpm verify:package-content

step "unit tests"
pnpm test
pnpm test:web

step "lint"
pnpm lint

step "package artifacts (same check as CI)"
# The script refuses to overwrite an existing output directory; keep older review bundles.
bundle="artifacts/review-prepush-$(date +%s)"
node scripts/verify-package-artifacts.mjs --output "$bundle" --allow-dirty

step "registry version preflight (dry run; no upload)"
node scripts/publish-packages.mjs --bundle "$bundle" --dry-run --allow-dirty --tag latest --new-packages-report "$bundle/new-packages.json"

if [ "$clean" -eq 1 ] && [ "$(git rev-parse HEAD)" = "$head_sha" ]; then
  printf '%s\n' "$head_sha" > "$(git rev-parse --git-path zucker-prepush-verified)"
  printf '\n✅ pre-push gate: passed; %s may be pushed to main\n' "$head_sha" >&2
else
  printf '\n✅ pre-push gate: passed, but the commit was not recorded (uncommitted changes or HEAD moved)\n' >&2
fi
