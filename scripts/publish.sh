#!/usr/bin/env bash
# Publishes the current version to npm under both package names:
#   xkg             — the name going forward
#   mnemos-capture  — the old name, kept so existing installs, MCP configs and
#                     hooks that run `npx mnemos-capture@latest` keep updating
#
# Usage: scripts/publish.sh [dist-tag] [extra npm publish flags…]
#   scripts/publish.sh                      # by hand: latest
#   scripts/publish.sh latest --provenance  # from the release workflow
#
# Run it from a clean checkout of the commit being released: npm records that
# commit as the package's gitHead, and the release workflow checks it.
# A name that already has this version from this commit is skipped, so the
# script is safe to re-run after one of the two publishes fails.
set -euo pipefail
cd "$(dirname "$0")/.."

DIST_TAG="${1:-latest}"
shift || true

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean; publish from a clean checkout." >&2
  exit 1
fi

VERSION=$(node -p 'require("./package.json").version')
HEAD=$(git rev-parse HEAD)

publish_as() {
  local name=$1
  shift
  if npm view "$name@$VERSION" version >/dev/null 2>&1; then
    local published
    published=$(npm view "$name@$VERSION" gitHead 2>/dev/null || true)
    if [ "$published" != "$HEAD" ]; then
      echo "error: $name@$VERSION is already on npm from ${published:-an unknown commit}. Bump the version." >&2
      exit 1
    fi
    echo "$name@$VERSION is already published from this commit; skipping."
    return
  fi
  echo "Publishing $name@$VERSION ($DIST_TAG)…"
  npm publish --access public --tag "$DIST_TAG" "$@"
}

publish_as xkg "$@"

# Same tarball under the old name: rename in package.json for one publish,
# then put it back whatever happens.
cp package.json package.json.publish-backup
trap 'mv package.json.publish-backup package.json' EXIT
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.name = "mnemos-capture";
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'
publish_as mnemos-capture "$@"
