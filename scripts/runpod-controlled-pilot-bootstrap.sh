#!/usr/bin/env bash
set -euo pipefail

STARTED_LLAMA_PID=""
RUNTIME_DIR=""
FINAL_GATE_REPORTED=0

fail() {
  printf 'error=%s\n' "$1" >&2
  exit 1
}

pid_matches_configured_binary() {
  local pid="$1"
  local configured_real executable_real

  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [[ "$pid" != "$$" ]] || return 1
  configured_real="$(realpath "$LLAMA_SERVER_BIN" 2>/dev/null || printf '%s' "$LLAMA_SERVER_BIN")"

  if [[ -e "/proc/$pid/exe" ]]; then
    executable_real="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
    [[ "$executable_real" == "$configured_real" ]] && return 0
  fi
  return 1
}

configured_server_pids() {
  local proc_path pid
  [[ -d /proc ]] || return 0
  for proc_path in /proc/[0-9]*; do
    [[ -d "$proc_path" ]] || continue
    pid="${proc_path##*/}"
    pid_matches_configured_binary "$pid" && printf '%s\n' "$pid"
  done
}

port_is_free() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen(Number(process.argv[1]), "0.0.0.0", () => server.close(() => process.exit(0)));
  ' "$LLAMA_PORT" >/dev/null 2>&1
}

wait_for_port_free() {
  local attempt
  for ((attempt = 1; attempt <= LLAMA_STOP_RETRIES; attempt += 1)); do
    port_is_free && return 0
    sleep "$LLAMA_STOP_INTERVAL_SECONDS"
  done
  return 1
}

terminate_started_server() {
  local attempt
  [[ -n "$STARTED_LLAMA_PID" ]] || return 0
  kill -0 "$STARTED_LLAMA_PID" 2>/dev/null || return 0
  kill -TERM "$STARTED_LLAMA_PID" 2>/dev/null || true
  for ((attempt = 1; attempt <= LLAMA_CLEANUP_RETRIES; attempt += 1)); do
    kill -0 "$STARTED_LLAMA_PID" 2>/dev/null || {
      wait "$STARTED_LLAMA_PID" 2>/dev/null || true
      return 0
    }
    sleep "$LLAMA_CLEANUP_INTERVAL_SECONDS"
  done
  kill -KILL "$STARTED_LLAMA_PID" 2>/dev/null || true
  wait "$STARTED_LLAMA_PID" 2>/dev/null || true
}

cleanup() {
  local status="$?"
  trap - EXIT INT TERM
  if [[ "${KEEP_LLAMA_SERVER:-0}" != "1" ]]; then
    terminate_started_server
  fi
  [[ -z "$RUNTIME_DIR" ]] || rm -rf -- "$RUNTIME_DIR"
  if [[ "$status" -ne 0 && "$FINAL_GATE_REPORTED" -eq 0 ]]; then
    printf '%s\n' 'FINAL_GATE=FAIL' >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not_inside_git_repository"
cd "$REPO_ROOT"
[[ -f scripts/controlled-coding-pilot.cjs ]] || fail "missing_required_file:scripts/controlled-coding-pilot.cjs"
PILOT_DEFINITION="${CONTROLLED_PILOT_DEFINITION:-pilots/controlled-real-coding-v1/runpod-live-help/task.json}"
case "$PILOT_DEFINITION" in
  pilots/controlled-real-coding-v1/runpod-live-help/task.json)
    EXPECTED_PILOT_ID="controlled-real-coding-v1.runpod-live-help"
    ;;
  pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json)
    EXPECTED_PILOT_ID="controlled-real-coding-v2.worker-request-id-correlation"
    ;;
  *) fail "unsupported_pilot_definition" ;;
esac
[[ -f "$PILOT_DEFINITION" ]] || fail "missing_required_file:$PILOT_DEFINITION"

if [[ -f /workspace/load-env.sh ]]; then
  # shellcheck source=/dev/null
  source /workspace/load-env.sh
fi

SOURCE_COMMIT="$(git rev-parse HEAD)"
printf 'sourceCommit=%s\n' "$SOURCE_COMMIT"
if [[ -n "${EXPECTED_SOURCE_COMMIT:-}" && "$SOURCE_COMMIT" != "$EXPECTED_SOURCE_COMMIT" ]]; then
  fail "expected_source_commit_mismatch"
fi

PILOT_DEFINITION_COMMITTED_HASH="$(git rev-parse "$SOURCE_COMMIT:$PILOT_DEFINITION" 2>/dev/null)" || \
  fail "pilot_definition_missing_at_source_commit"
PILOT_DEFINITION_WORKTREE_HASH="$(git hash-object -- "$PILOT_DEFINITION")" || \
  fail "pilot_definition_hash_failed"
[[ "$PILOT_DEFINITION_WORKTREE_HASH" == "$PILOT_DEFINITION_COMMITTED_HASH" ]] || \
  fail "pilot_definition_source_mismatch"

if ! PILOT_TARGETS_OUTPUT="$(node - "$PILOT_DEFINITION" "$EXPECTED_PILOT_ID" <<'NODE'
const fs = require("node:fs");
const { validateDefinition } = require("./scripts/controlled-coding-pilot.cjs");
const [definitionPath, expectedPilotId] = process.argv.slice(2);
try {
  const definition = validateDefinition(JSON.parse(fs.readFileSync(definitionPath, "utf8")));
  if (definition.pilotId !== expectedPilotId) throw new Error("pilot mismatch");
  process.stdout.write(definition.allowedMutationPaths.join("\n") + "\n");
} catch {
  process.stderr.write("error=pilot_definition_invalid\n");
  process.exit(1);
}
NODE
)"; then
  exit 1
fi
SOURCE_TARGETS=()
while IFS= read -r target; do
  [[ -z "$target" ]] || SOURCE_TARGETS+=("$target")
done <<< "$PILOT_TARGETS_OUTPUT"
((${#SOURCE_TARGETS[@]} > 0)) || fail "pilot_definition_has_no_source_targets"
printf 'pilotDefinition=%s\n' "$PILOT_DEFINITION"

SOURCE_TARGET_HASHES=()
for source_target in "${SOURCE_TARGETS[@]}"; do
  [[ -f "$source_target" ]] || fail "missing_source_target:$source_target"
  committed_hash="$(git rev-parse "$SOURCE_COMMIT:$source_target" 2>/dev/null)" || \
    fail "source_target_missing_at_source_commit:$source_target"
  current_hash="$(git hash-object -- "$source_target")" || fail "source_target_hash_failed"
  [[ "$current_hash" == "$committed_hash" ]] || fail "source_target_source_mismatch:$source_target"
  SOURCE_TARGET_HASHES+=("$committed_hash")
done

verify_source_targets_unchanged() {
  local current_hash index source_target
  for ((index = 0; index < ${#SOURCE_TARGETS[@]}; index += 1)); do
    source_target="${SOURCE_TARGETS[$index]}"
    [[ -f "$source_target" ]] || fail "source_target_changed"
    current_hash="$(git hash-object -- "$source_target")"
    [[ "$current_hash" == "${SOURCE_TARGET_HASHES[$index]}" ]] || fail "source_target_changed"
  done
}

LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-/workspace/llama.cpp-b9754/build/bin/llama-server}"
LLAMA_MODEL_PATH="${LLAMA_MODEL_PATH:-/workspace/models/qwen2.5-coder-7b/qwen2.5-coder-7b-instruct-q4_k_m.gguf}"
LLAMA_PORT="${LLAMA_PORT:-8000}"
LLAMA_HOST="${LLAMA_HOST:-0.0.0.0}"
LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-16384}"
LLAMA_MODEL_ALIAS="${LLAMA_MODEL_ALIAS:-qwen2.5-coder-7b}"
LLAMA_SERVER_LOG="${LLAMA_SERVER_LOG:-/workspace/llama-server-controlled-pilot.log}"
LLAMA_EXPECTED_BUILD="${LLAMA_EXPECTED_BUILD:-9754}"
LLAMA_EXPECTED_COMMIT_PREFIX="${LLAMA_EXPECTED_COMMIT_PREFIX-52b3df002}"
LLAMA_STOP_RETRIES="${LLAMA_STOP_RETRIES:-40}"
LLAMA_STOP_INTERVAL_SECONDS="${LLAMA_STOP_INTERVAL_SECONDS:-0.25}"
LLAMA_CLEANUP_RETRIES="${LLAMA_CLEANUP_RETRIES:-40}"
LLAMA_CLEANUP_INTERVAL_SECONDS="${LLAMA_CLEANUP_INTERVAL_SECONDS:-0.25}"
LOCAL_READY_RETRIES="${LOCAL_READY_RETRIES:-120}"
PROXY_READY_RETRIES="${PROXY_READY_RETRIES:-120}"
READINESS_INTERVAL_SECONDS="${READINESS_INTERVAL_SECONDS:-1}"

[[ -x "$LLAMA_SERVER_BIN" ]] || fail "llama_server_missing_or_not_executable:$LLAMA_SERVER_BIN"
[[ -f "$LLAMA_MODEL_PATH" ]] || fail "llama_model_missing:$LLAMA_MODEL_PATH"
[[ "$LLAMA_PORT" =~ ^[0-9]+$ ]] && ((LLAMA_PORT >= 1 && LLAMA_PORT <= 65535)) || \
  fail "invalid_llama_port"
[[ "$LLAMA_CTX_SIZE" =~ ^[0-9]+$ ]] && ((LLAMA_CTX_SIZE >= 1)) || fail "invalid_llama_ctx_size"
[[ -n "$LLAMA_HOST" && -n "$LLAMA_MODEL_ALIAS" ]] || fail "invalid_llama_configuration"
[[ "$LLAMA_EXPECTED_BUILD" =~ ^[0-9]+$ ]] || fail "invalid_llama_expected_build"
[[ -z "$LLAMA_EXPECTED_COMMIT_PREFIX" || \
  "$LLAMA_EXPECTED_COMMIT_PREFIX" =~ ^[0-9A-Fa-f]{1,40}$ ]] || \
  fail "invalid_llama_expected_commit_prefix"

if ! LLAMA_PROVENANCE_FIELDS="$(node - "$LLAMA_SERVER_BIN" "$LLAMA_EXPECTED_BUILD" \
  "$LLAMA_EXPECTED_COMMIT_PREFIX" <<'NODE'
const { spawnSync } = require("node:child_process");
const [binary, expectedBuild, expectedCommitPrefix] = process.argv.slice(2);
const result = spawnSync(binary, ["--version"], {
  encoding: "utf8",
  timeout: 5_000,
  maxBuffer: 16_384
});
const stdout = typeof result.stdout === "string" ? result.stdout : "";
const stderr = typeof result.stderr === "string" ? result.stderr : "";
const output = `${stdout}\n${stderr}`;
const matches = output.length <= 16_384
  ? [...output.matchAll(/^version:\s*([0-9]+)\s+\(([0-9A-Fa-f]{1,40})\)\s*$/gm)]
  : [];
const actualBuild = matches.length === 1 ? matches[0][1] : undefined;
const actualCommit = matches.length === 1 ? matches[0][2] : undefined;
const invocationPassed = !result.error && result.status === 0 && output.length <= 16_384;
const buildPassed = invocationPassed && actualBuild === expectedBuild;
const commitPassed = invocationPassed && actualCommit !== undefined &&
  (!expectedCommitPrefix || actualCommit.toLowerCase().startsWith(expectedCommitPrefix.toLowerCase()));
if (!buildPassed || !commitPassed) {
  process.stderr.write([
    "error=llama_provenance_verification_failed",
    `expectedBuild=${expectedBuild}`,
    `actualBuild=${actualBuild ?? "unavailable"}`,
    `expectedCommitPrefix=${expectedCommitPrefix || "disabled"}`,
    `actualCommit=${actualCommit ?? "unavailable"}`
  ].join("\n") + "\n");
  process.exit(1);
}
process.stdout.write(`${actualBuild}\n${actualCommit}\n`);
NODE
)"; then
  exit 1
fi
LLAMA_ACTUAL_BUILD="${LLAMA_PROVENANCE_FIELDS%%$'\n'*}"
LLAMA_ACTUAL_COMMIT="${LLAMA_PROVENANCE_FIELDS#*$'\n'}"
printf '%s\n' \
  "llama_build=$LLAMA_ACTUAL_BUILD" \
  "llama_commit=$LLAMA_ACTUAL_COMMIT" \
  'llama_provenance=verified'

if [[ -z "${LLAMA_API_KEY:-}" ]]; then
  LLAMA_API_KEY="$(openssl rand -hex 32)" || fail "api_key_generation_failed"
fi
export LLAMA_API_KEY

RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/runpod-controlled-pilot.XXXXXX")"

EXISTING_LLAMA_PIDS=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] && EXISTING_LLAMA_PIDS+=("$pid")
done < <(configured_server_pids)
if ((${#EXISTING_LLAMA_PIDS[@]} > 0)); then
  for pid in "${EXISTING_LLAMA_PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
fi
wait_for_port_free || fail "llama_port_remained_occupied:$LLAMA_PORT"

mkdir -p "$(dirname "$LLAMA_SERVER_LOG")"
nohup "$LLAMA_SERVER_BIN" \
  -m "$LLAMA_MODEL_PATH" \
  --host "$LLAMA_HOST" \
  --port "$LLAMA_PORT" \
  --ctx-size "$LLAMA_CTX_SIZE" \
  --parallel 1 \
  --n-gpu-layers 999 \
  --alias "$LLAMA_MODEL_ALIAS" \
  --api-key "$LLAMA_API_KEY" \
  >"$LLAMA_SERVER_LOG" 2>&1 &
STARTED_LLAMA_PID="$!"

MODEL_RESPONSE_FILE="$RUNTIME_DIR/models.json"
poll_models_endpoint() {
  local url="$1"
  local retries="$2"
  local attempt status
  for ((attempt = 1; attempt <= retries; attempt += 1)); do
    status="$(curl -sS --max-time 5 -o "$MODEL_RESPONSE_FILE" -w '%{http_code}' \
      -H "Authorization: Bearer $LLAMA_API_KEY" "$url" 2>/dev/null || true)"
    if [[ "$status" =~ ^2[0-9][0-9]$ ]] && node -e '
      const fs = require("node:fs");
      try {
        const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const expected = process.argv[2];
        process.exit(Array.isArray(body.data) && body.data.some((item) => item && item.id === expected) ? 0 : 1);
      } catch { process.exit(1); }
    ' "$MODEL_RESPONSE_FILE" "$LLAMA_MODEL_ALIAS"; then
      return 0
    fi
    sleep "$READINESS_INTERVAL_SECONDS"
  done
  LAST_HTTP_STATUS="${status:-unavailable}"
  return 1
}

if ! poll_models_endpoint "http://127.0.0.1:${LLAMA_PORT}/v1/models" "$LOCAL_READY_RETRIES"; then
  printf 'error=local_llama_server_not_ready httpStatus=%s\n' "$LAST_HTTP_STATUS" >&2
  if [[ -f "$LLAMA_SERVER_LOG" ]]; then
    tail -n 100 "$LLAMA_SERVER_LOG" | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const secret = process.env.LLAMA_API_KEY || "";
        process.stderr.write(secret ? input.split(secret).join("[REDACTED]") : input);
      });
    ' || true
  fi
  exit 1
fi
printf '%s\n' 'local_model=ready'

if [[ -z "${RUNPOD_POD_ID:-}" && -r /proc/1/environ ]]; then
  RUNPOD_POD_ID="$(node -e '
    const fs = require("node:fs");
    const entry = fs.readFileSync("/proc/1/environ").toString().split("\0")
      .find((value) => value.startsWith("RUNPOD_POD_ID="));
    if (entry) process.stdout.write(entry.slice("RUNPOD_POD_ID=".length));
  ')"
fi
[[ -n "${RUNPOD_POD_ID:-}" ]] || fail "runpod_pod_id_unavailable"
[[ "$RUNPOD_POD_ID" =~ ^[A-Za-z0-9-]+$ ]] || fail "invalid_runpod_pod_id"

RUNPOD_BASE_URL="${RUNPOD_BASE_URL:-https://${RUNPOD_POD_ID}-${LLAMA_PORT}.proxy.runpod.net/v1}"
RUNPOD_BASE_URL="${RUNPOD_BASE_URL%/}"
export RUNPOD_BASE_URL
export RUNPOD_MODEL="$LLAMA_MODEL_ALIAS"
export LLM_UPSTREAM_URL="${RUNPOD_BASE_URL}/chat/completions"
export DLLM_UPSTREAM_URL="$LLM_UPSTREAM_URL"
export LLM_UPSTREAM_API_KEY="$LLAMA_API_KEY"
export DLLM_UPSTREAM_API_KEY="$LLAMA_API_KEY"
export LLM_MODEL_ID="$RUNPOD_MODEL"
export DLLM_MODEL_ID="$RUNPOD_MODEL"
export RUNPOD_LIVE_REQUIRED=1

if ! poll_models_endpoint "${RUNPOD_BASE_URL}/models" "$PROXY_READY_RETRIES"; then
  printf 'error=runpod_proxy_not_ready httpStatus=%s localModel=ready\n' "$LAST_HTTP_STATUS" >&2
  exit 1
fi
printf '%s\n' 'runpod_proxy=ready' "model=$RUNPOD_MODEL"

CONTROLLED_PILOT_OUTPUT_DIR="${CONTROLLED_PILOT_OUTPUT_DIR:-reports/controlled-coding-pilot}"
OUTPUT_ABSOLUTE="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' \
  "$CONTROLLED_PILOT_OUTPUT_DIR")"
[[ "$OUTPUT_ABSOLUTE" != "/" && "$OUTPUT_ABSOLUTE" != "$REPO_ROOT" ]] || \
  fail "unsafe_controlled_pilot_output_directory"
case "$REPO_ROOT/" in
  "$OUTPUT_ABSOLUTE/"*) fail "unsafe_controlled_pilot_output_directory" ;;
esac
rm -rf -- "$CONTROLLED_PILOT_OUTPUT_DIR"

PILOT_STATUS=0
CONTROLLED_PILOT_DEBUG=1 npm run run:controlled-coding-pilot-live -- \
  --execute-provider \
  --confirm-live \
  --definition "$PILOT_DEFINITION" \
  --output "$CONTROLLED_PILOT_OUTPUT_DIR" || PILOT_STATUS="$?"
verify_source_targets_unchanged
[[ "$PILOT_STATUS" -eq 0 ]] || fail "controlled_pilot_execution_failed"

REPORT_PATH="$CONTROLLED_PILOT_OUTPUT_DIR/pilot-report.json"
[[ -f "$REPORT_PATH" ]] || fail "pilot_report_missing"
if ! node - "$REPORT_PATH" "$SOURCE_COMMIT" "${EXPECTED_SOURCE_COMMIT:-}" \
  "$LLAMA_ACTUAL_BUILD" "$LLAMA_ACTUAL_COMMIT" "$EXPECTED_PILOT_ID" <<'NODE'
const fs = require("node:fs");
const [reportPath, head, expected, llamaBuild, llamaCommit, expectedPilotId] = process.argv.slice(2);
let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch {
  process.stderr.write("error=pilot_report_invalid_json\n");
  process.exit(1);
}
const required = {
  pilotId: expectedPilotId,
  status: "completed",
  sourceCommit: head,
  providerCallCount: 1,
  retryCount: 0,
  authorityPassed: true,
  verifierPassed: true,
  artifactProduced: true,
  artifactValid: true,
  sourceWorktreeMutated: false,
  githubMutationObserved: false,
  budgetExceeded: false,
  cleanupCompleted: true,
  failureCode: null
};
for (const [key, value] of Object.entries(required)) {
  if (report[key] !== value) {
    process.stderr.write(`error=pilot_report_gate_failed field=${key}\n`);
    process.exit(1);
  }
}
if (expected && report.sourceCommit !== expected) {
  process.stderr.write("error=pilot_report_expected_commit_mismatch\n");
  process.exit(1);
}
if (!Number.isInteger(report.patchLineCount) || report.patchLineCount < 0 ||
    typeof report.modelId !== "string" || report.modelId.length === 0) {
  process.stderr.write("error=pilot_report_summary_invalid\n");
  process.exit(1);
}
process.stdout.write([
  "FINAL_GATE=PASS",
  `sourceCommit=${report.sourceCommit}`,
  `modelId=${report.modelId}`,
  `llamaBuild=${llamaBuild}`,
  `llamaCommit=${llamaCommit}`,
  "providerCallCount=1",
  "retryCount=0",
  `patchLineCount=${report.patchLineCount}`
].join("\n") + "\n");
NODE
then
  exit 1
fi
FINAL_GATE_REPORTED=1
