#!/bin/bash
# Load Testing k6 runner start script. Runs inside one Fargate task.
# Inputs (env): RUN_ID RUNNER_NO RUNNERS SEGMENT SEQUENCE START_AT MAX_SECONDS MAX_VUS BUCKET
# Always exits 0 after uploading exit.json, so Step Functions waits for every runner
# and the Merge step decides pass/fail from the uploaded exit codes.
set -uo pipefail
cd /work

: "${RUN_ID:?}" "${RUNNER_NO:?}" "${BUCKET:?}"
RUNNERS="${RUNNERS:-1}"
START_AT="${START_AT:-0}"
MAX_SECONDS="${MAX_SECONDS:-3600}"
MAX_VUS="${MAX_VUS:-0}"
SCRIPT_FILE="${SCRIPT_FILE:-archive.tar}"   # archive.tar from the CLI, script.js from the web app
PREFIX="s3://$BUCKET/runs/$RUN_ID"
OUT="$PREFIX/runner-$RUNNER_NO"
LATE=0
TIMED_OUT_FLAG=/work/.timed_out

# Scripts may not call private networks, the AWS metadata/credential endpoints or localhost.
BLOCK="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,169.254.0.0/16,100.64.0.0/10,0.0.0.0/8,::1/128,fc00::/7,fe80::/10"

log() { echo "[load-testing-k6 runner $RUNNER_NO/$RUNNERS] $*"; }
s3cp() { aws s3 cp --only-show-errors "$@"; }

phase() {
  jq -nc --arg p "$1" --argjson t "$(date +%s)" --argjson r "$RUNNER_NO" '{phase:$p,t:$t,runner:$r}' > progress.json
  s3cp progress.json "$OUT/progress.json" || true
}

finish() {
  local code="$1" msg="${2:-}"
  jq -nc --argjson c "$code" --arg e "$msg" --argjson late "$LATE" \
    '{exitCode:$c, error:(if $e == "" then null else $e end), startedLate:($late == 1)}' > exit.json
  [ -f summary.json ] && s3cp summary.json "$OUT/summary.json"
  [ -f report.html ] && s3cp report.html "$OUT/report.html" --content-type "text/html; charset=utf-8"
  phase finished
  s3cp exit.json "$OUT/exit.json" || log "could not upload exit.json"
  log "finished, k6 exit code $code ${msg:+($msg)}"
  exit 0
}

# 1. Download the test archive and this project's secrets.
log "run $RUN_ID: downloading test"
case "$SCRIPT_FILE" in archive.tar|script.js) ;; *) finish 2 "bad SCRIPT_FILE";; esac
s3cp "$PREFIX/$SCRIPT_FILE" "$SCRIPT_FILE" || finish 2 "could not download the test script"
ENV_ARGS=()
if s3cp "$PREFIX/env.json" env.json 2>/dev/null; then
  while IFS= read -r -d '' kv; do ENV_ARGS+=(-e "$kv"); done < <(jq -j 'to_entries[] | "\(.key)=\(.value)\u0000"' env.json)
  rm -f env.json
fi

# 2. Re-check the script's VUs against what the API approved.
VUS=$(k6 inspect --execution-requirements "${ENV_ARGS[@]}" "$SCRIPT_FILE" 2>/dev/null | jq -r '.maxVUs // empty')
[ -n "$VUS" ] || finish 104 "k6 could not read the test script (syntax error?)"
if [ "$VUS" -gt "$MAX_VUS" ]; then
  finish 3 "script asks for $VUS VUs but the run was approved for $MAX_VUS"
fi
phase ready

# 3. Wait for the shared start time so all runners start together.
NOW=$(date +%s)
if [ "$START_AT" -gt "$NOW" ]; then
  log "waiting $((START_AT - NOW))s for the shared start"
  sleep $((START_AT - NOW))
elif [ "$START_AT" -gt 0 ] && [ $((NOW - START_AT)) -gt 15 ]; then
  LATE=1
  log "WARNING: started $((NOW - START_AT))s after the shared start time"
fi

SEG_ARGS=()
if [ "$RUNNERS" -gt 1 ]; then
  SEG_ARGS=(--execution-segment "$SEGMENT" --execution-segment-sequence "$SEQUENCE")
fi

# 4. Progress: every 10 s read k6's local REST API and upload a small progress.json.
(
  while sleep 10; do
    m=$(curl -sf --max-time 3 http://127.0.0.1:6565/v1/metrics) || continue
    echo "$m" | jq -c --argjson t "$(date +%s)" --argjson r "$RUNNER_NO" '
      (.data | map({key: .id, value: .attributes.sample}) | from_entries) as $m
      | {phase: "running", t: $t, runner: $r,
         vus: ($m.vus.value // 0),
         requests: ($m.http_reqs.count // 0),
         failedRate: ($m.http_req_failed.rate // 0),
         p95Ms: ($m.http_req_duration["p(95)"] // null),
         iterations: ($m.iterations.count // 0)}' > progress.tmp && mv progress.tmp progress.json \
      && s3cp progress.json "$OUT/progress.json"
  done
) &
PROGRESS_PID=$!

# 5. Run k6. Command-line flags beat script options, so a script cannot lift the IP block.
log "starting k6 (${SEGMENT:-full test})"
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_HOST=127.0.0.1 K6_WEB_DASHBOARD_EXPORT=report.html \
k6 run -q --no-usage-report \
  --address 127.0.0.1:6565 \
  --include-system-env-vars=false \
  "${SEG_ARGS[@]}" "${ENV_ARGS[@]}" \
  --blacklist-ip "$BLOCK" \
  --summary-trend-stats 'avg,min,med,max,p(90),p(95),p(99)' \
  --summary-export summary.json \
  --tag run_id="$RUN_ID" --tag runner="$RUNNER_NO" \
  "$SCRIPT_FILE" &
K6_PID=$!

# ECS stop / Spot reclaim sends SIGTERM to us: pass it to k6 so it stops gracefully and writes its summary.
trap 'log "stop requested, stopping k6"; kill -TERM "$K6_PID" 2>/dev/null' TERM INT

# Hard time limit, in case the script runs longer than declared.
( sleep "$MAX_SECONDS"; touch "$TIMED_OUT_FLAG"; kill -TERM "$K6_PID" 2>/dev/null; sleep 45; kill -KILL "$K6_PID" 2>/dev/null ) &
WATCHDOG_PID=$!

wait "$K6_PID"; CODE=$?
while kill -0 "$K6_PID" 2>/dev/null; do wait "$K6_PID"; CODE=$?; done
kill "$WATCHDOG_PID" "$PROGRESS_PID" 2>/dev/null

if [ -f "$TIMED_OUT_FLAG" ]; then
  finish 124 "hit the time limit of ${MAX_SECONDS}s"
fi
finish "$CODE"
