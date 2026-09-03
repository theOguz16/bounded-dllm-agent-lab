#!/usr/bin/env bash
set -euo pipefail

LLAMA_SERVER_BIN="${GATE6_LLAMA_SERVER_BIN:-/workspace/runtime/llama.cpp/bin/llama-server}"
MODEL_PATH="${GATE6_MODEL_PATH:-/workspace/models/qwen3-coder-30b/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf}"
MODEL_ALIAS="qwen3-coder-30b-a3b-q4-kxl-ctx16k-q8kv"
SERVER_LOG="${GATE6_LLAMA_SERVER_LOG:-/workspace/runtime/gate6-qwen3-server.log}"
HOST="${GATE6_LLAMA_HOST:-127.0.0.1}"
PORT="${GATE6_LLAMA_PORT:-8000}"

[[ -x "$LLAMA_SERVER_BIN" ]] || { printf 'ERROR_CODE=RUNPOD_LLAMA_SERVER_MISSING\n' >&2; exit 1; }
[[ -f "$MODEL_PATH" ]] || { printf 'ERROR_CODE=RUNPOD_MODEL_MISSING\n' >&2; exit 1; }
mkdir -p "$(dirname "$SERVER_LOG")"

export LD_LIBRARY_PATH="$(dirname "$LLAMA_SERVER_BIN"):${LD_LIBRARY_PATH:-}"

nohup "$LLAMA_SERVER_BIN" \
  --model "$MODEL_PATH" \
  --alias "$MODEL_ALIAS" \
  --host "$HOST" \
  --port "$PORT" \
  --ctx-size 16384 \
  --n-gpu-layers 99 \
  --flash-attn on \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --parallel 1 \
  --jinja \
  --load-mode none \
  >"$SERVER_LOG" 2>&1 &

printf 'RUNPOD_GATE6_LLAMA_STARTED=1\nPID=%s\nLOG=%s\nMODEL_ALIAS=%s\nMODEL_N_CTX=16384\n' "$!" "$SERVER_LOG" "$MODEL_ALIAS"
