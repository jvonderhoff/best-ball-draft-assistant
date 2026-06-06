#!/bin/bash
# pull_db.sh — Download the live drafts.db from Render before deploying.
#
# Usage:
#   ./pull_db.sh
#
# Set these once in your shell profile (~/.zshrc or ~/.bash_profile):
#   export BBA_API_KEY="your-key-from-render-env"
#   export BBA_SERVER="https://best-ball-draft-assistant.onrender.com"

set -e

SERVER="${BBA_SERVER:-https://best-ball-draft-assistant.onrender.com}"
API_KEY="${BBA_API_KEY:-}"

if [ -z "$API_KEY" ]; then
  echo "❌  BBA_API_KEY not set. Add to ~/.zshrc:"
  echo "    export BBA_API_KEY=\"your-key\""
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$SCRIPT_DIR/drafts.db"

echo "⬇️  Downloading drafts.db from $SERVER..."
curl -fsSL \
  -H "X-Api-Key: $API_KEY" \
  "$SERVER/api/db/download" \
  -o "$DEST"

echo "✅  Saved to $DEST"
echo ""
echo "Next steps:"
echo "  git add drafts.db"
echo "  git commit -m \"Sync drafts.db before deploy\""
echo "  git push"
