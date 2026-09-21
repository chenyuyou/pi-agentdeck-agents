#!/usr/bin/env bash
# Publish the full version history (v0.1.0 … current) to npm.
#
# Each tag carries its own package.json version, so every release is published
# from a clean checkout of that tag. Requires an authenticated npm CLI
# (`npm whoami` must succeed) — `npm login --auth-type=web` is the easiest way.
#
#   ./scripts/publish-history.sh            # publish every tag, oldest first
#   ./scripts/publish-history.sh --dry-run  # show what would be published
set -euo pipefail

cd "$(dirname "$0")/.."
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

npm whoami >/dev/null 2>&1 || { echo "not logged in to npm — run: npm login --auth-type=web" >&2; exit 1; }

start_branch=$(git rev-parse --abbrev-ref HEAD)
echo "publishing tags (starting from $start_branch)"
trap 'git checkout -q "$start_branch"' EXIT

for tag in $(git tag --sort=creatordate); do
  version=$(git show "$tag:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
  if npm view "pi-agentdeck-agents@$version" version >/dev/null 2>&1; then
    echo "skip   $tag ($version) — already on npm"
    continue
  fi
  echo "publish $tag ($version)"
  git checkout -q "$tag"
  if [ "$DRY" = "1" ]; then
    npm publish --dry-run --access public | tail -3
  else
    npm publish --access public
  fi
done

echo "done"
