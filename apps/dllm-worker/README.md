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

The mock `/refine` endpoint echoes the workspace back. A real dLLM worker will
later replace that echo behavior with masked refinement, but the request and
response shape should stay stable.

The separation is intentional:

- TypeScript owns benchmark rules.
- TypeScript owns masking policy.
- TypeScript owns verifier and scope decisions.
- Python owns model inference only.

This keeps research comparisons fair. If Python worker logic knew benchmark
answers, the experiment would become contaminated.
