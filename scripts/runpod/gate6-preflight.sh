#!/usr/bin/env bash
set -euo pipefail

EXPECTED_MODEL_SHA256="2841aa314d916434860cfb8990347528dcdfe5c350dbcb9d1461dbee88ff2533"
EXPECTED_MODEL_ALIAS="qwen3-coder-30b-a3b-q4-kxl-ctx16k-q8kv"
EXPECTED_N_CTX="16384"

REPO_ROOT="${GATE6_REPO_ROOT:-/workspace/repos/bounded-dllm-agent-lab}"
LLAMA_SERVER_BIN="${GATE6_LLAMA_SERVER_BIN:-/workspace/runtime/llama.cpp/bin/llama-server}"
MODEL_PATH="${GATE6_MODEL_PATH:-/workspace/models/qwen3-coder-30b/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf}"
LLAMA_BASE_URL="${GATE6_LLAMA_BASE_URL:-http://127.0.0.1:8000}"
READY_RETRIES="${GATE6_PREFLIGHT_READY_RETRIES:-120}"
READY_INTERVAL="${GATE6_PREFLIGHT_READY_INTERVAL_SECONDS:-1}"
PUBLIC_GIT_PROBE="${GATE6_PUBLIC_GIT_PROBE:-https://github.com/ai/nanoid.git}"
NODE_INSTALL_COMMAND="curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"

fail() {
  local code="$1"
  shift || true
  printf 'RUNPOD_GATE6_PREFLIGHT=FAIL\n' >&2
  printf 'ERROR_CODE=%s\n' "$code" >&2
  if (($# > 0)); then printf 'DETAIL=%s\n' "$*" >&2; fi
  if [[ "$code" == "RUNPOD_PREFLIGHT_NODE_MISSING" || "$code" == "RUNPOD_PREFLIGHT_NODE_VERSION_UNSUPPORTED" ]]; then
    printf 'INSTALL_COMMAND=%s\n' "$NODE_INSTALL_COMMAND" >&2
  fi
  exit 1
}

need_exec() {
  command -v "$1" >/dev/null 2>&1 || fail "$2"
}

[[ -d "$REPO_ROOT/.git" ]] || fail RUNPOD_PREFLIGHT_REPOSITORY_MISSING "$REPO_ROOT"
need_exec git RUNPOD_PREFLIGHT_GIT_MISSING
need_exec node RUNPOD_PREFLIGHT_NODE_MISSING
need_exec npm RUNPOD_PREFLIGHT_NPM_MISSING
need_exec curl RUNPOD_PREFLIGHT_CURL_MISSING
need_exec sha256sum RUNPOD_PREFLIGHT_SHA256SUM_MISSING

NODE_VERSION="$(node --version 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || fail RUNPOD_PREFLIGHT_NODE_VERSION_INVALID "$NODE_VERSION"
(( NODE_MAJOR >= 22 )) || fail RUNPOD_PREFLIGHT_NODE_VERSION_UNSUPPORTED "$NODE_VERSION"

[[ -x "$LLAMA_SERVER_BIN" ]] || fail RUNPOD_PREFLIGHT_LLAMA_SERVER_MISSING "$LLAMA_SERVER_BIN"
[[ -f "$MODEL_PATH" ]] || fail RUNPOD_PREFLIGHT_MODEL_MISSING "$MODEL_PATH"

MODEL_SHA256="$(sha256sum "$MODEL_PATH" | awk '{print $1}')"
[[ "$MODEL_SHA256" == "$EXPECTED_MODEL_SHA256" ]] || fail RUNPOD_PREFLIGHT_MODEL_SHA_MISMATCH "$MODEL_SHA256"

LLAMA_BIN_DIR="$(cd "$(dirname "$LLAMA_SERVER_BIN")" && pwd -P)"
case ":${LD_LIBRARY_PATH:-}:" in
  *":$LLAMA_BIN_DIR:"*) ;;
  *) fail RUNPOD_PREFLIGHT_LD_LIBRARY_PATH_INVALID "$LLAMA_BIN_DIR" ;;
esac
if ! LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}" "$LLAMA_SERVER_BIN" --version >/dev/null 2>&1; then
  fail RUNPOD_PREFLIGHT_LLAMA_SHARED_LIBRARY_UNUSABLE
fi

cd "$REPO_ROOT"
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] || fail RUNPOD_PREFLIGHT_WORKTREE_DIRTY

git -c http.version=HTTP/1.1 fetch --quiet origin main || fail RUNPOD_PREFLIGHT_ORIGIN_FETCH_FAILED
HEAD_SHA="$(git rev-parse HEAD)"
ORIGIN_MAIN_SHA="$(git rev-parse origin/main)"
[[ "$HEAD_SHA" == "$ORIGIN_MAIN_SHA" ]] || fail RUNPOD_PREFLIGHT_SOURCE_SHA_MISMATCH "HEAD=$HEAD_SHA origin/main=$ORIGIN_MAIN_SHA"
if [[ -n "${GATE6_EXPECTED_SOURCE_SHA:-}" && "$HEAD_SHA" != "$GATE6_EXPECTED_SOURCE_SHA" ]]; then
  fail RUNPOD_PREFLIGHT_SOURCE_SHA_MISMATCH "HEAD=$HEAD_SHA expected=$GATE6_EXPECTED_SOURCE_SHA"
fi

if ! node scripts/gate6-verify.cjs >/dev/null; then
  fail RUNPOD_PREFLIGHT_GATE6_VERIFY_FAILED
fi

if ! git -c http.version=HTTP/1.1 ls-remote --exit-code "$PUBLIC_GIT_PROBE" HEAD >/dev/null; then
  fail RUNPOD_PREFLIGHT_PUBLIC_GIT_HTTP11_FAILED "$PUBLIC_GIT_PROBE"
fi

TMP_MODELS="$(mktemp)"
TMP_PROPS="$(mktemp)"
cleanup() { rm -f "$TMP_MODELS" "$TMP_PROPS"; }
trap cleanup EXIT INT TERM

MODEL_LOADING_SEEN=0
READY=0
LAST_STATUS="unavailable"
for ((attempt=1; attempt<=READY_RETRIES; attempt+=1)); do
  LAST_STATUS="$(curl -sS --max-time 5 -o "$TMP_MODELS" -w '%{http_code}' "$LLAMA_BASE_URL/v1/models" 2>/dev/null || true)"
  if [[ "$LAST_STATUS" == "503" ]]; then
    MODEL_LOADING_SEEN=1
    printf 'LLAMA_READINESS=MODEL_LOADING\n' >&2
    sleep "$READY_INTERVAL"
    continue
  fi
  if [[ "$LAST_STATUS" != "200" ]]; then
    sleep "$READY_INTERVAL"
    continue
  fi

  if ! node - "$TMP_MODELS" "$EXPECTED_MODEL_ALIAS" <<'NODE'
const fs = require('node:fs');
const [file, expected] = process.argv.slice(2);
try {
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = Array.isArray(body?.data) ? body.data.map(x => x?.id).filter(x => typeof x === 'string') : [];
  process.exit(ids.length === 1 && ids[0] === expected ? 0 : 1);
} catch { process.exit(1); }
NODE
  then
    fail RUNPOD_PREFLIGHT_MODEL_ALIAS_MISMATCH
  fi

  PROPS_STATUS="$(curl -sS --max-time 5 -o "$TMP_PROPS" -w '%{http_code}' "$LLAMA_BASE_URL/props" 2>/dev/null || true)"
  [[ "$PROPS_STATUS" == "200" ]] || fail RUNPOD_PREFLIGHT_LLAMA_PROPS_UNREACHABLE "$PROPS_STATUS"
  if ! node - "$TMP_PROPS" "$EXPECTED_N_CTX" <<'NODE'
const fs = require('node:fs');
const [file, expected] = process.argv.slice(2);
try {
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const value = body?.default_generation_settings?.n_ctx;
  process.exit(Number(value) === Number(expected) ? 0 : 1);
} catch { process.exit(1); }
NODE
  then
    fail RUNPOD_PREFLIGHT_N_CTX_MISMATCH
  fi
  READY=1
  break
done

if [[ "$READY" -ne 1 ]]; then
  if [[ "$MODEL_LOADING_SEEN" -eq 1 ]]; then
    fail RUNPOD_PREFLIGHT_LLAMA_NOT_READY MODEL_LOADING
  fi
  fail RUNPOD_PREFLIGHT_LLAMA_UNREACHABLE "$LAST_STATUS"
fi

printf 'RUNPOD_GATE6_PREFLIGHT=PASS\n'
printf 'GATE6_SOURCE_SHA=%s\n' "$HEAD_SHA"
printf 'NODE_VERSION=%s\n' "$NODE_VERSION"
printf 'MODEL_SHA256=%s\n' "$MODEL_SHA256"
printf 'MODEL_ALIAS=%s\n' "$EXPECTED_MODEL_ALIAS"
printf 'MODEL_N_CTX=%s\n' "$EXPECTED_N_CTX"
printf 'GATE6_VERIFY=PASS\n'
