# dLLM Worker

This folder is reserved for the isolated inference worker.

The main research system is TypeScript-first. The worker can use Python later because most open-source dLLM implementations are released with PyTorch or Hugging Face tooling.

The worker should expose a small HTTP API:

```text
POST /refine
POST /infill
POST /resolve-conflict
GET /health
```

The worker must not contain benchmark rules, product logic, memory policy, or scope policy. Those belong to the TypeScript side.

## Current Mock Worker

`worker.py` is a dependency-free mock worker. It exists only to test the
TypeScript-to-Python HTTP/JSON boundary.

Run it with:

```bash
python3 apps/dllm-worker/worker.py
```

Then check:

```bash
curl -sS http://127.0.0.1:8765/health
```

The mock worker currently supports:

```text
GET /health
POST /refine
POST /infill
POST /resolve-conflict
```

The mock `/refine` endpoint echoes the workspace back. The mock `/infill`
endpoint returns deterministic placeholder text for one region. The mock
`/resolve-conflict` endpoint returns a deterministic placeholder resolution.

A real dLLM worker will later replace those mock behaviors with masked
refinement, infill, and conflict-resolution inference, but the request and
response shapes should stay stable.

After building TypeScript, run the worker smoke check:

```bash
npm run build
npm run worker:smoke
```

Before a full benchmark, run a tiny dry-run:

```bash
npm run build
npm run worker:dry-run
```

After dry-run succeeds, run the mini benchmark:

```bash
npm run build
npm run worker:mini-benchmark
```

The mini benchmark is not a code unit test. It is a small research run: one
scenario from each benchmark family is sent to the live worker. Use it to inspect
whether the worker handles correction override, sensitive boundaries, scope
control, insufficient context, and conflict resolution before paying for a full
50-scenario run.

After the mini benchmark is healthy, run the full benchmark:

```bash
npm run build
npm run worker:full-benchmark
```

The full benchmark sends all 50 scenarios to the live worker. It prints progress
for each scenario and writes JSON, Markdown, and manifest artifacts under
`reports/`.

Long GPU runs can fail for boring infrastructure reasons: a web terminal can
disconnect, a worker process can restart, or a socket can close while the model
is generating. The full benchmark writes a checkpoint after every scenario so a
research run does not need to start from zero after one transient failure.

Resume the latest full benchmark checkpoint with:

```bash
BENCHMARK_RESUME=1 npm run worker:full-benchmark
```

Resume a specific run with:

```bash
BENCHMARK_RUN_ID=2026-06-19T13-50-39-964Z-worker-full-benchmark BENCHMARK_RESUME=1 npm run worker:full-benchmark
```

After the base full benchmark is healthy, run the hard worker benchmark:

```bash
npm run worker:hard-benchmark
```

The hard worker benchmark sends the 25 hard fixtures to the same live worker.
It keeps the same JSON, Markdown, manifest, output snapshot, retry, and
checkpoint behavior as the full benchmark.

Resume the latest hard worker benchmark checkpoint with:

```bash
BENCHMARK_RESUME=1 npm run worker:hard-benchmark
```

The checkpoint is intentionally an experiment artifact, not just a convenience
file. It records which scenarios finished, their scores, and their output
snapshots. That makes long benchmark execution cheaper, repeatable, and easier
to audit when we compare dLLM, LLM, and retrieval-augmented baselines.

For a remote worker:

```bash
DLLM_WORKER_URL=https://your-worker.example.com npm run worker:dry-run
```

The dry-run uses only a small fixture subset. It proves worker health, refine
response shape, report writing, and manifest writing before spending time on a
full benchmark.

The separation is intentional:

- TypeScript owns benchmark rules.
- TypeScript owns masking policy.
- TypeScript owns verifier and scope decisions.
- Python owns model inference only.

This keeps research comparisons fair. If Python worker logic knew benchmark
answers, the experiment would become contaminated.

## Dream-Coder Worker

`dream_worker.py` is the first real dLLM worker for RunPod experiments. It uses
`Dream-org/Dream-Coder-v0-Instruct-7B` through Hugging Face `trust_remote_code`.

Install the pinned dependencies on a GPU pod:

```bash
python3 -m pip install -r apps/dllm-worker/requirements-dream.txt
```

Use `/workspace` for model cache on RunPod:

```bash
mkdir -p /workspace/hf-cache
export HF_HOME=/workspace/hf-cache
export HUGGINGFACE_HUB_CACHE=/workspace/hf-cache/hub
```

Run the real worker:

```bash
python3 apps/dllm-worker/dream_worker.py
```

Then, from a second terminal:

```bash
curl -sS http://127.0.0.1:8765/health
npm run worker:dry-run
```

The Dream-Coder worker keeps the same HTTP contract as the mock worker:

- `GET /health` returns `mode: "dllm"`.
- `POST /refine` receives a masked workspace and returns the workspace with a
  model-produced `finalResult`.
- `POST /infill` fills one requested workspace region.
- `POST /resolve-conflict` is intentionally deterministic for now.

Important research note: the worker extracts fenced code blocks when Dream-Coder
adds markdown or explanation. This does not remove the need to measure scope
drift. It only keeps the TypeScript benchmark contract stable while the raw
model behavior is studied through generated reports and failure reviews.
