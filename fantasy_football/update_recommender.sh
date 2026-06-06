#!/bin/bash
# Manual sync of recommender.js from extension → Flask static.
# Not needed during normal commits — the pre-commit hook handles that automatically.
# Use this only if you need to sync without making a commit.

set -e
cd "$(dirname "$0")"

SRC="best-ball-extension/recommender.js"
DST="best-ball-draft/static/recommender.js"

cp "$SRC" "$DST"
echo "✓ Copied $SRC → $DST"
