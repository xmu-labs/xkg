#!/usr/bin/env bash
# Publishes the current version to npm under both package names:
#   xkg             — the name going forward
#   mnemos-capture  — the old name, kept so existing installs, MCP configs and
#                     hooks that run `npx mnemos-capture@latest` keep updating
#
# Usage: scripts/publish.sh [dist-tag] [extra npm publish flags…]
#   scripts/publish.sh                      # by hand: latest
#   scripts/publish.sh next                 # by hand, for a GitHub pre-release
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

PACKAGES=(xkg mnemos-capture)

# Check every name before publishing any: npm versions can never be replaced,
# so a conflict found after the first publish would leave the names out of sync.
# Only npm's E404 means "not published": any other lookup failure (network,
# auth, registry) aborts, so an unknown state is never taken as safe.
TO_PUBLISH=()
for name in "${PACKAGES[@]}"; do
  if ! lookup=$(npm view "$name@$VERSION" version 2>&1); then
    if ! grep -q "E404" <<<"$lookup"; then
      echo "error: could not check $name@$VERSION on npm:" >&2
      echo "$lookup" >&2
      exit 1
    fi
    TO_PUBLISH+=("$name")
  else
    published=$(npm view "$name@$VERSION" gitHead)
    if [ "$published" != "$HEAD" ]; then
      echo "error: $name@$VERSION is already on npm from ${published:-an unknown commit}. Bump the version." >&2
      exit 1
    fi
    echo "$name@$VERSION is already published from this commit; skipping."
  fi
done

# The other names publish the same tarball: rename in package.json for each,
# then put it back whatever happens.
cp package.json package.json.publish-backup
trap 'mv package.json.publish-backup package.json' EXIT

for name in "${TO_PUBLISH[@]}"; do
  NAME="$name" node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json.publish-backup", "utf8"));
    pkg.name = process.env.NAME;
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  '
  echo "Publishing $name@$VERSION ($DIST_TAG)…"
  npm publish --access public --tag "$DIST_TAG" "$@"
done
