#!/bin/bash
# Sync recommender.js from the extension to the Flask app static folder,
# then commit and push both to GitHub.

set -e
cd "$(dirname "$0")"

SRC="best-ball-extension/recommender.js"
DST="best-ball-draft/static/recommender.js"

echo "Copying $SRC → $DST"
cp "$SRC" "$DST"

echo "Committing..."
git add "$SRC" "$DST"
git commit -m "Update recommender logic

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

echo "Pushing..."
git push origin reorganize/fantasy-football-folder

echo "✓ Done — both extension and Render will use the updated recommender."
