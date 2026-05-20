#!/usr/bin/env bash
# Pull the latest from git and rebuild + restart the control container.
set -euo pipefail

cd "$(dirname "$0")/.."

git pull --ff-only

docker compose build control
docker compose up -d control

docker compose ps
