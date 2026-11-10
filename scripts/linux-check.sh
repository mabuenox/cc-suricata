#!/usr/bin/env bash
# Linux check inside a node container (the author works on Windows): unit tests, a fake ~/.claude, notify-send, code, fs.watch.
# Run from the repo root: docker run --rm -v "$PWD:/app:ro" node:22 bash /app/scripts/linux-check.sh
set -euo pipefail
cd /app
echo "== node $(node --version) on $(uname -s)"

echo "== 1. unit tests"
node --test > /tmp/t.log 2>&1 || { cat /tmp/t.log; exit 1; }
grep -E "^# (tests|pass|fail)" /tmp/t.log

echo "== 2. fake ~/.claude"
export HOME=/tmp/home
mkdir -p "$HOME/.claude/sessions" "$HOME/.claude/projects/-home-user-acme-shop"
sleep 600 & KEEP=$!   # a live pid for the registry
CWD=/home/user/acme-shop
mkdir -p "$CWD/src/orders" && echo x > "$CWD/src/orders/list.tsx"
cat > "$HOME/.claude/sessions/$KEEP.json" <<EOF
{"pid":$KEEP,"sessionId":"s-ask","cwd":"$CWD","startedAt":1767261600000,"kind":"interactive","status":"busy","updatedAt":1767265320000,"statusUpdatedAt":1767265320000,"name":"acme-shop"}
EOF
# the fixture is a Windows transcript: rewrite its paths the way Claude Code on Linux would write them
sed -e "s#C:\\\\\\\\Workspace\\\\\\\\acme-shop#$CWD#g" -e '/file-history-delta/ s#\\\\#/#g' test/fixtures/ask.jsonl > "$HOME/.claude/projects/-home-user-acme-shop/s-ask.jsonl"
grep -o '"trackingPath":"[^"]*"' "$HOME/.claude/projects/-home-user-acme-shop/s-ask.jsonl" | head -1
cp test/fixtures/history.jsonl "$HOME/.claude/history.jsonl"
# a plugin-spawned session under the temp dir must be hidden
cat > "$HOME/.claude/sessions/1.json" <<EOF
{"pid":1,"sessionId":"s-tmp","cwd":"/tmp/claude/plugin-run","startedAt":1,"kind":"interactive","status":"busy","updatedAt":1}
EOF
node server.mjs --once > /tmp/once.json
node -e '
const j = JSON.parse(require("fs").readFileSync("/tmp/once.json", "utf8"))
const [s] = j.sessions
console.log("live:", j.sessions.length, "| status:", s.status, "| question:", s.waitingQuestion, "| files:", JSON.stringify(s.editedFiles), "| recent:", j.recent.length)
if (j.sessions.length !== 1 || s.status !== "waiting" || s.editedFiles[0] !== "src/orders/list.tsx") { console.log("FAIL --once"); process.exit(1) }
'

echo "== 3. fake notify-send and code on the PATH"
for b in notify-send code; do printf '#!/bin/sh\necho "%s $*" >> /tmp/calls.log\n' "$b" > /usr/local/bin/$b; chmod +x /usr/local/bin/$b; done
printf '#!/bin/sh\necho "claude $*" >> /tmp/calls.log\ncat > /tmp/prompt.txt\necho "acme-shop has been asking you for ages."\n' > /usr/local/bin/claude; chmod +x /usr/local/bin/claude
: > /tmp/calls.log
node server.mjs --no-open --notify > /tmp/server.log 2>&1 & SRV=$!
sleep 1.5
curl -sf -o /dev/null http://localhost:4747/ && echo "page: 200"
curl -s -o /dev/null -w "wrong host: %{http_code}\n" -H "Host: evil.test:4747" http://localhost:4747/
CROSS=$(curl -s -o /dev/null -w "%{http_code}" -H "Sec-Fetch-Site: cross-site" "http://localhost:4747/summary?force=1"); echo "cross-site summary: $CROSS"
LINK=$(curl -s -o /dev/null -w "%{http_code}" -H "Sec-Fetch-Site: cross-site" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Dest: document" http://localhost:4747/); echo "page from a link elsewhere: $LINK"

echo "== 4. /open spawns code --goto"
curl -s -o /dev/null -w "open listed: %{http_code}\n" -X POST -d '{"sessionId":"s-ask","file":"src/orders/list.tsx"}' http://localhost:4747/open
curl -s -o /dev/null -w "open unlisted: %{http_code}\n" -X POST -d '{"sessionId":"s-ask","file":"../../etc/passwd"}' http://localhost:4747/open

echo "== 4b. /summary runs the fake claude with the findings on stdin"
curl -s http://localhost:4747/summary | grep -o '"text":"[^"]*"'
grep -c "^- acme-shop has been asking you" /tmp/prompt.txt | sed 's/^/finding lines in prompt: /'

echo "== 5. fs.watch recursive: a new transcript line reaches SSE"
(timeout 6 curl -sN http://localhost:4747/events > /tmp/sse.log 2>/dev/null || true) &
sleep 1
cat >> "$HOME/.claude/projects/-home-user-acme-shop/s-ask.jsonl" <<'EOF'
{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_ask","content":"Ascending"}]},"timestamp":"2026-01-01T11:03:00.000Z","sessionId":"s-ask"}
EOF
sleep 2 # a refresh of its own: the server must see "busy, no question" before the change below
echo "== 6. question answered + registry idle -> notify-send 'has finished'"
sed -i 's/"status":"busy"/"status":"idle"/' "$HOME/.claude/sessions/$KEEP.json"
sleep 4
node server.mjs --once | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const [x]=JSON.parse(s).sessions;console.log("final status:",x.status,"| question:",x.waitingQuestion)})'
echo "sse events: $(grep -c '^data:' /tmp/sse.log) (2+ means the watcher fired)"
echo "calls:"; cat /tmp/calls.log
echo "server log:"; cat /tmp/server.log
kill $SRV $KEEP 2>/dev/null || true
[ "$LINK" = 200 ] && [ "$CROSS" = 403 ] && grep -q '^notify-send ' /tmp/calls.log && grep -q '^code --goto /home/user/acme-shop/src/orders/list.tsx' /tmp/calls.log && grep -q '^claude -p --no-session-persistence' /tmp/calls.log && grep -q '^- acme-shop has been asking you' /tmp/prompt.txt && [ "$(grep -c '^data:' /tmp/sse.log)" -ge 2 ] && echo "ALL OK" || { echo "FAIL"; exit 1; }
