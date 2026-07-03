# RunPod Qwen + Dream Live Benchmark Runbook

## Purpose

This runbook makes the Phase N live benchmark repeatable on RunPod with two OpenAI-compatible endpoints:

- LLM slot: `Qwen2.5-Coder-7B`
- dLLM/verifier slot: `Dream-Coder-v0-Instruct-7B`

The goal is to run live acceptance and the live mini benchmark against the same pod:

- `npm run verify:model-worker:runpod-live`
- `npm run report:live-mini-benchmark`

Use this as a reproducibility checklist. Do not treat a single run as a broad model-quality claim; it is evidence for this repo's bounded-agent acceptance and mini benchmark tasks under the exact hardware, model, prompt, and runtime settings recorded in the artifacts.

## Environment

Expected environment:

- RunPod GPU pod
- RTX 3090 24 GB
- Node.js 24.x
- `llama.cpp` Qwen server
- Python `transformers` Dream server

Quick GPU check:

```bash
nvidia-smi
```

If GPU memory is tight, lower the Qwen context size first. If Dream responses are too slow, lower max tokens for the Dream smoke and benchmark.

## Clone And Install

Clone the repo under `/tmp` so RunPod workspace quota pressure does not affect the working tree:

```bash
cd /tmp
git clone https://github.com/<owner>/bounded-dllm-agent-lab.git
cd bounded-dllm-agent-lab
```

Install with the npm cache under `/tmp`:

```bash
export npm_config_cache=/tmp/npm-cache
npm install --no-audit --no-fund
```

Verify Node.js:

```bash
node --version
npm --version
```

The expected major version is Node.js 24.x.

## Start Qwen Server

Find `llama-server`:

```bash
command -v llama-server
find / -name llama-server -type f 2>/dev/null | head
```

Set a Qwen GGUF path. Adjust the path to the actual model location on the pod:

```bash
export QWEN_GGUF=/workspace/models/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf
test -f "$QWEN_GGUF"
```

Start the Qwen OpenAI-compatible server on port `8000`:

```bash
llama-server \
  -m "$QWEN_GGUF" \
  --host 0.0.0.0 \
  --port 8000 \
  --ctx-size 4096 \
  --parallel 1
```

If the pod runs out of memory, stop the server and retry with a smaller context:

```bash
llama-server \
  -m "$QWEN_GGUF" \
  --host 0.0.0.0 \
  --port 8000 \
  --ctx-size 2048 \
  --parallel 1
```

Smoke `/v1/models`:

```bash
curl -sS http://127.0.0.1:8000/v1/models | python3 -m json.tool
```

Smoke `/v1/chat/completions`:

```bash
curl -sS http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen2.5-coder-7b",
    "messages": [
      {
        "role": "user",
        "content": "Return a compact JSON object with decision approve."
      }
    ],
    "temperature": 0,
    "max_tokens": 64
  }' | python3 -m json.tool
```

## Start Dream Server

Set Hugging Face and Python cache directories to `/tmp`:

```bash
export HF_HOME=/tmp/hf-home
export HF_HUB_CACHE=/tmp/hf-cache
export TRANSFORMERS_CACHE=/tmp/transformers-cache
export TORCH_HOME=/tmp/torch-cache
mkdir -p "$HF_HOME" "$HF_HUB_CACHE" "$TRANSFORMERS_CACHE" "$TORCH_HOME"
```

Set a Dream snapshot path. Adjust this to the actual snapshot path on the pod:

```bash
export DREAM_SNAPSHOT=/tmp/hf-cache/models--Dream-org--Dream-Coder-v0-Instruct-7B/snapshots/<snapshot-id>
test -d "$DREAM_SNAPSHOT"
```

Install Python dependencies if the image does not already include them:

```bash
python3 -m pip install --upgrade --no-cache-dir \
  "torch" \
  "transformers" \
  "accelerate" \
  "sentencepiece"
```

Create `/tmp/dream_openai_server.py`:

```bash
cp scripts/dream-openai-server.py /tmp/dream_openai_server.py
python3 -m py_compile /tmp/dream_openai_server.py
```

Start the Dream OpenAI-compatible server on port `8002`:

```bash
export DREAM_PORT=8002
export DREAM_MODEL_ID=dream-coder-v0-instruct-7b
export DREAM_MAX_NEW_TOKENS=128
python3 /tmp/dream_openai_server.py
```

If Dream is too slow for the smoke or mini benchmark, lower `DREAM_MAX_NEW_TOKENS`:

```bash
export DREAM_MAX_NEW_TOKENS=64
python3 /tmp/dream_openai_server.py
```

Smoke `/healthz`:

```bash
curl -sS http://127.0.0.1:8002/healthz | python3 -m json.tool
```

Smoke `/v1/models`:

```bash
curl -sS http://127.0.0.1:8002/v1/models | python3 -m json.tool
```

Smoke `/v1/chat/completions`:

```bash
curl -sS http://127.0.0.1:8002/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "dream-coder-v0-instruct-7b",
    "messages": [
      {
        "role": "user",
        "content": "Return a compact JSON object with decision needs_review."
      }
    ],
    "temperature": 0,
    "max_tokens": 64
  }' | python3 -m json.tool
```

## Configure Repo Environment

From the repo root:

```bash
export LLM_UPSTREAM_URL=http://127.0.0.1:8000/v1/chat/completions
export DLLM_UPSTREAM_URL=http://127.0.0.1:8002/v1/chat/completions

export LLM_MODEL_ID=qwen2.5-coder-7b
export DLLM_MODEL_ID=dream-coder-v0-instruct-7b

export RUNPOD_LIVE_REQUIRED=1
export LIVE_MINI_BENCHMARK_REQUIRED=1
export LIVE_MINI_BENCHMARK_STRICT=0

export MODEL_WORKER_PROXY_TIMEOUT_MS=300000
export LIVE_MINI_BENCHMARK_TIMEOUT_MS=300000
export LIVE_MINI_BENCHMARK_MAX_TOKENS=128
```

Keep `LIVE_MINI_BENCHMARK_STRICT=0` for exploratory live research runs. Strict mode can be enabled later when the acceptance threshold is intentionally fixed.

## Run Live Acceptance

Run the live model-worker acceptance:

```bash
npm run verify:model-worker:runpod-live
```

Expected artifact directories:

```text
reports/model-worker-acceptance/
reports/model-worker-live-smoke/
```

If this fails, inspect the newest Markdown and JSON files in both directories before changing model settings.

## Run Live Mini Benchmark

Run the live mini benchmark:

```bash
npm run report:live-mini-benchmark
```

Expected artifact directory:

```text
reports/live-mini-benchmark/
```

For a required RunPod run, `LIVE_MINI_BENCHMARK_REQUIRED=1` should be set so missing endpoints fail instead of silently producing only skipped reports.

## Save Artifacts

Create one compressed artifact bundle from the repo root:

```bash
tar -czf /tmp/runpod-qwen-dream-live-benchmark-artifacts.tar.gz \
  reports/model-worker-acceptance \
  reports/model-worker-live-smoke \
  reports/live-mini-benchmark
```

Check the archive:

```bash
ls -lh /tmp/runpod-qwen-dream-live-benchmark-artifacts.tar.gz
tar -tzf /tmp/runpod-qwen-dream-live-benchmark-artifacts.tar.gz | head
```

Preserve:

- raw JSON reports
- Markdown summaries
- terminal command transcript
- `nvidia-smi` output
- model paths or snapshot identifiers, without secrets

## Stop Servers

Stop Qwen:

```bash
pkill -f "llama-server"
```

Stop Dream:

```bash
pkill -f "dream_openai_server.py"
```

Confirm GPU memory is released:

```bash
nvidia-smi
```

## Interpretation Notes

Safe interpretation:

- This run demonstrates that the repo can route two live OpenAI-compatible endpoints into the LLM and dLLM/verifier slots.
- Acceptance artifacts show whether each endpoint satisfied the model-worker contract for the checked prompts.
- Mini benchmark artifacts show bounded-agent decision behavior on the included case set, including decision accuracy, JSON compliance, latency, and token usage.

Avoid overclaiming:

- Do not claim general model superiority from one mini benchmark.
- Do not compare runs unless hardware, model builds, quantization, prompts, env vars, and benchmark commit are recorded.
- Do not hide skipped or failed reports; they are part of the reproducibility evidence.
- Treat `LIVE_MINI_BENCHMARK_STRICT=0` as exploratory unless a separate strict threshold is documented.

## Troubleshooting

### Workspace quota or slow install

Use `/tmp` for the repo, npm cache, Hugging Face cache, Torch cache, and generated server files:

```bash
export npm_config_cache=/tmp/npm-cache
export HF_HOME=/tmp/hf-home
export HF_HUB_CACHE=/tmp/hf-cache
export TRANSFORMERS_CACHE=/tmp/transformers-cache
export TORCH_HOME=/tmp/torch-cache
```

If the pod image has an old checkout in `/workspace`, do not mix artifacts from that checkout with the `/tmp` clone.

### Dream `AssertionError: inputs is not None`

This usually means the Dream generation API was called with the wrong argument name. Use:

```python
outputs = model.diffusion_generate(
    inputs=input_ids,
    attention_mask=attention_mask,
    max_new_tokens=max_tokens,
)
```

Do not call Dream with only `input_ids=...` if the model implementation asserts `inputs is not None`.

### Node ESM/CommonJS `.cjs`

The repo is `"type": "module"`. CommonJS helper scripts should use `.cjs`, as `scripts/live-mini-benchmark.cjs` does. If a copied local helper uses `require(...)`, name it with a `.cjs` extension or convert it to ESM imports.

### Endpoint missing skipped reports

Without endpoint env vars, local runs are expected to produce skipped reports:

```text
LLM_UPSTREAM_URL missing
DLLM_UPSTREAM_URL missing
```

For a real RunPod live run, set:

```bash
export RUNPOD_LIVE_REQUIRED=1
export LIVE_MINI_BENCHMARK_REQUIRED=1
```

Then rerun:

```bash
npm run verify:model-worker:runpod-live
npm run report:live-mini-benchmark
```

### Qwen OOM

Check GPU memory:

```bash
nvidia-smi
```

Retry Qwen with a smaller context:

```bash
--ctx-size 2048
```

Keep `--parallel 1` on 24 GB GPUs unless there is clear headroom.

### Dream is too slow

Lower the Dream server max tokens and benchmark max tokens:

```bash
export DREAM_MAX_NEW_TOKENS=64
export LIVE_MINI_BENCHMARK_MAX_TOKENS=64
```

If latency is still high, keep the run and report it honestly rather than trimming cases after seeing results.
