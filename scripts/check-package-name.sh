#!/usr/bin/env sh
# Fail if any doc/example/source still refers to the package by its old
# unscoped name. The published name is @hitansh8/tinywatch; unscoped
# `tinywatch` is not ours on the registry, so a stale `npx tinywatch migrate`
# would 404 today and could run a squatted package tomorrow.
#
# Deliberately NOT matched: `tinywatch.config*` (config filename), the
# `tinywatch:` log prefix, the `tinywatch` bin name in package.json, and prose
# uses of the bare word. Only import specifiers and install/run commands.
set -eu
cd "$(dirname "$0")/.."

PATTERN='"tinywatch"|'"'"'tinywatch'"'"'|"tinywatch/|'"'"'tinywatch/|npx tinywatch|npm install tinywatch|Usage: tinywatch'
TARGETS="README.md CHANGELOG.md examples src test tinywatch-scaffold.md"

hits=$(grep -rnE "$PATTERN" $TARGETS 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "Found references to the unscoped package name; use @hitansh8/tinywatch instead:"
  echo "$hits"
  exit 1
fi
echo "✓ no unscoped package-name references"
