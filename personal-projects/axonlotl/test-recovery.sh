#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8787}"
BASE_URL="${BASE_URL:-http://localhost:$PORT}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1" >&2; exit 1; }; }
need curl
need node

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

start_server() {
  if curl -sS "$BASE_URL/healthz" >/dev/null 2>&1; then
    echo "Server already running at $BASE_URL"
    return 0
  fi

  echo "Starting server..."
  PORT="$PORT" HOST="127.0.0.1" node src/server.js >"$tmpdir/server.log" 2>&1 &
  SERVER_PID="$!"

  for _ in {1..80}; do
    if curl -sS "$BASE_URL/healthz" >/dev/null 2>&1; then
      echo "Server ready (pid=$SERVER_PID)"
      return 0
    fi
    sleep 0.15
  done

  echo "Server failed to start. Log:" >&2
  sed -n '1,120p' "$tmpdir/server.log" >&2 || true
  exit 11
}

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap stop_server EXIT

echo "== Axonlotl Recovery Test =="
echo "Base URL: $BASE_URL"
echo

start_server

echo "1) Check Baseline (all 5 agents health=1.0)"
curl -sS "$BASE_URL/api/state" > "$tmpdir/state.json"
node -e "import fs from 'fs'; const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const agents=data?.state?.agents??{}; const keys=Object.keys(agents); console.log('agents:', keys.join(', ')); if(keys.length!==5) process.exit(2); const ok=Object.values(agents).every(a=>a.health===1); console.log('allHealthy:', ok); if(!ok) process.exit(3);" "$tmpdir/state.json"
echo

echo "2) Lesion Injection (KILL reviewer)"
curl -sS -X POST "$BASE_URL/inject_fault" \
  -H "content-type: application/json" \
  -d '{"agentName":"reviewer","faultType":"kill"}' | tee "$tmpdir/kill.json" >/dev/null
node -e "import fs from 'fs'; const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const h=data?.state?.health; console.log('reviewer.health:', h); if(h!==0) process.exit(4);" "$tmpdir/kill.json"
echo

echo "3) Run Pipeline (task: secure express login route) in Axonlotl mode"
curl -sS -X POST "$BASE_URL/run_pipeline" \
  -H "content-type: application/json" \
  -d '{"task":"Create a secure express login route","mode":"axonlotl"}' > "$tmpdir/run.json"
node -e "import fs from 'fs'; const run=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const events=run?.events??[]; const reroute=events.find(e=>e.type==='reroute' && e.failedAgent==='reviewer'); console.log('rerouteEvent:', reroute ? { from: reroute.from, failedAgent: reroute.failedAgent, to: reroute.to, coverage: reroute.coverage } : null); if(!reroute) process.exit(5);" "$tmpdir/run.json"
echo

echo "4) Brain Diagnosis (Managed Agent clinical diagnosis)"
curl -sS -X POST "$BASE_URL/api/diagnose" \
  -H "content-type: application/json" \
  -d '{}' > "$tmpdir/diagnose.json"
node -e "import fs from 'fs'; const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const diag=data?.diagnosis; console.log('diagnosis.success:', Boolean(diag?.success)); console.log('doctorNote:', diag?.report?.summary ?? diag?.raw ?? diag?.error ?? '(none)');" "$tmpdir/diagnose.json"

echo
echo "Artifacts:"
echo "  $tmpdir/state.json"
echo "  $tmpdir/kill.json"
echo "  $tmpdir/run.json"
echo "  $tmpdir/diagnose.json"
