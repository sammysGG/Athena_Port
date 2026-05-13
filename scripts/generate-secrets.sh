#!/usr/bin/env bash
# Populate PORT_SESSION_SECRET and PORT_OPERATOR_PASSWORD in .env if they're
# still placeholders. Safe to run repeatedly — existing real values aren't
# overwritten.
set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env"
EXAMPLE_FILE="$(dirname "$0")/../.env.example"

if [ ! -f "$ENV_FILE" ]; then
  cp "$EXAMPLE_FILE" "$ENV_FILE"
  echo "created $ENV_FILE from .env.example"
fi

replace_if_placeholder() {
  local key="$1"
  local generator="$2"
  local current
  current="$(grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
  if [ -z "$current" ] || [[ "$current" == CHANGE_ME* ]]; then
    local value
    value="$($generator)"
    # Use a different delimiter so secrets containing / don't break sed.
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    rm -f "${ENV_FILE}.bak"
    echo "set $key"
  else
    echo "$key already set, leaving alone"
  fi
}

gen_hex() { openssl rand -hex 32; }
gen_pw()  { openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-24; }

replace_if_placeholder PORT_SESSION_SECRET gen_hex
replace_if_placeholder PORT_OPERATOR_PASSWORD gen_pw

chmod 600 "$ENV_FILE"
echo "wrote $ENV_FILE (mode 600)"
