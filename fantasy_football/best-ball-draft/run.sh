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
python -m flask -A app.app run --debug --no-reload --host 0.0.0.0 --port 8000
