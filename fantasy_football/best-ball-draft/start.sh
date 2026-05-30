#!/bin/bash
cd "$(dirname "$0")"
pkill -f "flask.*app.app" 2>/dev/null
sleep 0.3
python -m flask -A app.app run --no-reload --port 8000 --host 0.0.0.0 --cert ssl.crt --key ssl.key
