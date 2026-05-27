#!/usr/bin/env bash
# Pull the latest from git, reinstall deps, and restart the control service.
set -euo pipefail

cd "$(dirname "$0")/.."

git pull --ff-only

.venv/bin/pip install -r services/control/requirements.txt

sudo systemctl restart port-range.service
sudo systemctl status --no-pager port-range.service
