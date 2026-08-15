#!/bin/bash
# Run the Best Ball Fantasy Draft App

cd "$(dirname "$0")"

echo "🏈 Starting Best Ball Fantasy Draft..."
echo "📱 Open http://localhost:8000 in your browser"
echo "📱 On phone: http://192.168.1.161:8000"
echo ""

# Set PYTHONPATH to current directory
export PYTHONPATH="${PWD}:${PYTHONPATH}"

# Run Flask app (using port 8000 as port 5000 is occupied by system service)
# Use the project venv explicitly rather than whatever `python` happens to resolve to.
# This was a bare `python` until 2026-08-14, which meant it ran against whichever
# interpreter came first on PATH — anaconda's 3.9, with the dependencies installed
# globally rather than in a venv.
.venv/bin/python -m flask -A app.app run --debug --no-reload --host 0.0.0.0 --port 8000
