#!/usr/bin/env bash
# End-to-end through the HTTP API with a real model: create a bot, send a
# message, answer the approval, confirm the side effect landed in the sandbox.
#
#   ADA_TOKEN=... pnpm e2e
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${ADA_TOKEN:-}" ]; then
  echo "ADA_TOKEN is not set — the e2e needs a real model. Skipping."
  exit 0
fi

PORT=${PORT:-4245}
B="http://127.0.0.1:${PORT}"
rm -f data/e2e.db data/e2e.db-wal data/e2e.db-shm
rm -rf data/workspaces/e2e

# A fixed token for the test run, so curl does not have to read it back.
E2E_TOKEN="e2e-$(date +%s)-$$"
auth=(-H "Authorization: Bearer ${E2E_TOKEN}")

AUTH_TOKEN="$E2E_TOKEN" SANDBOX_DRIVER=local SANDBOX_ALLOW_LOCAL=1 OWNER_ID=e2e \
  LOCAL_SANDBOX_ROOT=./data/test/workspaces \
  DB_PATH=./data/test/e2e.db PORT="$PORT" MCP_CONFIG=/dev/null \
  pnpm tsx src/server/index.ts > /tmp/e2e.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  curl -sf "${auth[@]}" "$B/api/bots" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "== auth is enforced =="
code=$(curl -sS -o /dev/null -w '%{http_code}' "$B/api/bots")
[ "$code" = "401" ] || { echo "FAIL: unauthenticated request returned $code, expected 401" >&2; exit 1; }
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "$B/api/bots")
[ "$code" = "401" ] || { echo "FAIL: a bad token returned $code, expected 401" >&2; exit 1; }
code=$(curl -sS -o /dev/null -w '%{http_code}' "${auth[@]}" -H 'Origin: http://evil.example' "$B/api/bots")
[ "$code" = "403" ] || { echo "FAIL: cross-origin returned $code, expected 403" >&2; exit 1; }
echo "   401 without a token, 401 with a bad one, 403 cross-origin"


jqp() { python3 -c "import sys,json;print($1)"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

ID=$(curl -sS "${auth[@]}" -X POST "$B/api/bots" -H 'content-type: application/json' \
      -d '{"name":"E2E","job":"do what the user asks"}' | jqp 'json.load(sys.stdin)["id"]')

echo "== send a message that needs approval =="
RUN=$(curl -sS "${auth[@]}" -X POST "$B/api/bots/$ID/messages" -H 'content-type: application/json' \
  -d '{"text":"Create a file named e2e.txt containing exactly: ok. Use the write tool."}' \
  | jqp 'json.load(sys.stdin)["id"]')

echo "== wait for the approval request =="
AP=""
for _ in $(seq 1 180); do
  AP=$(curl -sS "${auth[@]}" "$B/api/approvals" | jqp 'next(iter([a["id"] for a in json.load(sys.stdin)]), "")')
  [ -n "$AP" ] && break
  sleep 1
done
[ -n "$AP" ] || fail "no approval was requested within 180s"
echo "   parked: $AP"

[ -f "data/workspaces/e2e/e2e.txt" ] && fail "the file exists before approval"
echo "   nothing written while parked"

echo "== approve =="
curl -sS "${auth[@]}" -X POST "$B/api/approvals/$AP" -H 'content-type: application/json' \
  -d '{"approved":true}' >/dev/null

for _ in $(seq 1 180); do
  S=$(curl -sS "${auth[@]}" "$B/api/runs/$RUN" | jqp 'json.load(sys.stdin)["run"]["status"]')
  [ "$S" != "running" ] && break
  sleep 1
done
echo "   run status: $S"
[ "$S" = "done" ] || fail "run ended as $S"

grep -q 'ok' data/workspaces/e2e/e2e.txt 2>/dev/null || fail "the file was not written after approval"
echo "   file written: $(cat data/workspaces/e2e/e2e.txt)"

echo "== a second message reuses the same pi session =="
RUN2=$(curl -sS "${auth[@]}" -X POST "$B/api/bots/$ID/messages" -H 'content-type: application/json' \
  -d '{"text":"What filename did you just create? Answer with the name only."}' \
  | jqp 'json.load(sys.stdin)["id"]')
for _ in $(seq 1 180); do
  S2=$(curl -sS "${auth[@]}" "$B/api/runs/$RUN2" | jqp 'json.load(sys.stdin)["run"]["status"]')
  [ "$S2" != "running" ] && break
  sleep 1
done
SAID=$(curl -sS "${auth[@]}" "$B/api/runs/$RUN2" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(" ".join(s["body"] for s in d["steps"] if s["kind"]=="assistant_text"))')
echo "   said: ${SAID:0:120}"
case "$SAID" in
  *e2e.txt*) echo "   session memory: OK" ;;
  *) fail "the bot did not recall the filename; session continuity is broken" ;;
esac

echo
echo "e2e passed"
