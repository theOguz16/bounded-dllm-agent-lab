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
cat > /tmp/dream_openai_server.py <<'PY'
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModel, AutoTokenizer


MODEL_PATH = os.environ.get("DREAM_SNAPSHOT", "/tmp/hf-cache/models--Dream-org--Dream-Coder-v0-Instruct-7B/snapshots/")
MODEL_ID = os.environ.get("DREAM_MODEL_ID", "dream-coder-v0-instruct-7b")
HOST = os.environ.get("DREAM_HOST", "0.0.0.0")
PORT = int(os.environ.get("DREAM_PORT", "8002"))
MAX_NEW_TOKENS = int(os.environ.get("DREAM_MAX_NEW_TOKENS", "128"))
DEFAULT_STEPS = int(os.environ.get("DREAM_STEPS", str(MAX_NEW_TOKENS)))
DEFAULT_TEMPERATURE = float(os.environ.get("DREAM_TEMPERATURE", "0"))
DEFAULT_TOP_P = float(os.environ.get("DREAM_TOP_P", "0.95"))
LOCAL_FILES_ONLY = os.environ.get("DREAM_LOCAL_FILES_ONLY", "1") != "0"


def clamp_int(value, default, minimum, maximum):
    try:
        parsed = int(value)
    except Exception:
        return default

    return max(minimum, min(maximum, parsed))


def response(status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return status, body, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": str(len(body)),
    }


print(json.dumps({
    "status": "loading",
    "server": "dream-openai-compatible-server",
    "model": MODEL_PATH,
    "servedModel": MODEL_ID,
    "port": PORT,
    "cuda_available": torch.cuda.is_available(),
    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    "local_files_only": LOCAL_FILES_ONLY,
}, ensure_ascii=False), flush=True)

tokenizer = AutoTokenizer.from_pretrained(
    MODEL_PATH,
    trust_remote_code=True,
    local_files_only=LOCAL_FILES_ONLY,
)

model = AutoModel.from_pretrained(
    MODEL_PATH,
    trust_remote_code=True,
    torch_dtype=torch.float16,
    device_map="auto",
    local_files_only=LOCAL_FILES_ONLY,
)

model.eval()
MODEL_DEVICE = next(model.parameters()).device

print(json.dumps({
    "status": "ready",
    "server": "dream-openai-compatible-server",
    "modelClass": model.__class__.__name__,
    "hasDiffusionGenerate": hasattr(model, "diffusion_generate"),
    "device": str(MODEL_DEVICE),
    "memoryAllocatedGb": round(torch.cuda.memory_allocated() / 1024**3, 2) if torch.cuda.is_available() else 0,
    "memoryReservedGb": round(torch.cuda.memory_reserved() / 1024**3, 2) if torch.cuda.is_available() else 0,
}, ensure_ascii=False), flush=True)


def normalize_messages(messages):
    normalized = []

    for message in messages:
        if not isinstance(message, dict):
            continue

        role = str(message.get("role", "user") or "user")
        content = str(message.get("content", "") or "")

        if role not in {"system", "user", "assistant"}:
            role = "user"

        normalized.append({"role": role, "content": content})

    if not normalized:
        normalized.append({"role": "user", "content": "Return exactly one JSON object with decision needs_review."})

    return normalized


def add_json_contract_reminder(messages):
    contract = (
        "\n\nFinal output reminder:\n"
        "Return exactly one valid JSON object and nothing else.\n"
        "Do not use markdown fences.\n"
        "Do not write analysis prose.\n"
        "Required shape: {\"decision\":\"approve|needs_review|reject\",\"reasoning\":\"short reason\",\"confidence\":0.0}"
    )

    copied = [dict(message) for message in messages]

    for index in range(len(copied) - 1, -1, -1):
        if copied[index]["role"] == "user":
            copied[index]["content"] += contract
            return copied

    copied.append({"role": "user", "content": contract.strip()})
    return copied


def message_text(messages):
    normalized = add_json_contract_reminder(normalize_messages(messages))

    try:
        return tokenizer.apply_chat_template(
            normalized,
            tokenize=False,
            add_generation_prompt=True,
        )
    except Exception:
        parts = []

        for message in normalized:
            role = message.get("role", "user")
            content = message.get("content", "")
            parts.append(f"<|{role}|>\n{content}")

        parts.append("<|assistant|>\n")
        return "\n\n".join(parts)


def extract_sequence(outputs):
    if hasattr(outputs, "sequences"):
        seq = outputs.sequences
        return seq[0] if getattr(seq, "ndim", 1) > 1 else seq

    if isinstance(outputs, torch.Tensor):
        return outputs[0] if outputs.ndim > 1 else outputs

    if isinstance(outputs, (tuple, list)) and outputs:
        first = outputs[0]

        if isinstance(first, torch.Tensor):
            return first[0] if first.ndim > 1 else first

    raise RuntimeError(f"Unsupported generation output type: {type(outputs)}")


def first_balanced_json_object(text):
    source = str(text or "")

    for start in [index for index, char in enumerate(source) if char == "{"]:
        depth = 0
        in_string = False
        escaped = False

        for index in range(start, len(source)):
            char = source[index]

            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue

            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1

                if depth == 0:
                    candidate = source[start:index + 1]

                    try:
                        parsed = json.loads(candidate)
                    except Exception:
                        break

                    if isinstance(parsed, dict):
                        return candidate

    return None


def clean_model_text(text):
    stripped = str(text or "").strip()
    json_object = first_balanced_json_object(stripped)

    if json_object:
        return json_object

    return stripped


def generate_completion(prompt, max_tokens, steps, temperature, top_p):
    encoded = tokenizer(prompt, return_tensors="pt")
    input_ids = encoded["input_ids"].to(MODEL_DEVICE)
    attention_mask = encoded.get("attention_mask")

    if attention_mask is not None:
        attention_mask = attention_mask.to(MODEL_DEVICE)

    prompt_tokens = int(input_ids.shape[-1])

    with torch.inference_mode():
        if hasattr(model, "diffusion_generate"):
            try:
                outputs = model.diffusion_generate(
                    inputs=input_ids,
                    attention_mask=attention_mask,
                    max_new_tokens=max_tokens,
                    steps=steps,
                    temperature=temperature,
                    top_p=top_p,
                )
            except TypeError:
                outputs = model.diffusion_generate(
                    inputs=input_ids,
                    attention_mask=attention_mask,
                    max_new_tokens=max_tokens,
                    steps=steps,
                )
        else:
            outputs = model.generate(
                input_ids=input_ids,
                attention_mask=attention_mask,
                max_new_tokens=max_tokens,
                do_sample=temperature > 0,
                temperature=max(temperature, 1e-5),
                top_p=top_p,
            )

    sequence = extract_sequence(outputs).detach().cpu()
    generated = sequence[prompt_tokens:]
    completion_tokens = int(generated.shape[-1])
    text = tokenizer.decode(generated, skip_special_tokens=True).strip()

    return clean_model_text(text), {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            self.send_json(200, {"ok": True, "model": MODEL_ID})
            return

        if self.path == "/v1/models":
            self.send_json(200, {
                "object": "list",
                "data": [
                    {
                        "id": MODEL_ID,
                        "object": "model",
                        "created": int(time.time()),
                        "owned_by": "runpod",
                    }
                ],
            })
            return

        self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"error": "not_found"})
            return

        started = time.time()
        length = int(self.headers.get("Content-Length", "0"))

        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            messages = payload.get("messages", [])

            max_tokens = clamp_int(payload.get("max_tokens", MAX_NEW_TOKENS), MAX_NEW_TOKENS, 8, 256)
            steps = clamp_int(payload.get("steps", DEFAULT_STEPS), DEFAULT_STEPS, 8, 256)
            temperature = float(payload.get("temperature", DEFAULT_TEMPERATURE))
            top_p = float(payload.get("top_p", DEFAULT_TOP_P))

            prompt = message_text(messages)
            text, usage = generate_completion(
                prompt=prompt,
                max_tokens=max_tokens,
                steps=steps,
                temperature=temperature,
                top_p=top_p,
            )

            self.send_json(200, {
                "id": f"chatcmpl-dream-{int(time.time())}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": payload.get("model", MODEL_ID),
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": text},
                        "finish_reason": "stop",
                    }
                ],
                "usage": usage,
                "timings": {
                    "latency_ms": round((time.time() - started) * 1000),
                },
            })

        except Exception as error:
            self.send_json(500, {
                "error": {
                    "message": str(error),
                    "type": error.__class__.__name__,
                }
            })

    def send_json(self, status, payload):
        status, body, headers = response(status, payload)
        self.send_response(status)

        for key, value in headers.items():
            self.send_header(key, value)

        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Dream OpenAI-compatible server listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()

PY
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
