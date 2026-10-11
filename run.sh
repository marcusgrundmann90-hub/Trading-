#!/usr/bin/env bash
# Start the trading app (backend + frontend) on http://localhost:8000
# Use TRADING_DATA_MODE=demo ./run.sh for offline synthetic data.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q --upgrade pip
pip install -q -r backend/requirements.txt

exec uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000 --reload
