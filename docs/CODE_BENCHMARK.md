# Code Patch Benchmark

This document defines the transition from behavior benchmarks to real code patch
benchmarks.

## Selected OSS Repository

The first pinned open-source repository is:

| Field | Value |
| --- | --- |
| Repository | `ai/nanoid` |
| URL | `https://github.com/ai/nanoid.git` |
| Commit | `e4b7a9a7323006474ec939112aec68944b0da097` |
| License | MIT |
| Local path | `benchmarks/repos/nanoid` |

Nano ID was selected because it is a small real JavaScript library with a compact
source surface, tests, clear public APIs, and limited enough scope for fast patch
experiments.

## Prepare The Repository

Run:

```bash
npm run oss:prepare
```

The command clones the pinned repository into `benchmarks/repos/nanoid` and
checks out the exact commit. The cloned code is intentionally ignored by git.

## Why Not Vendor The Repository?

The benchmark should be reproducible without copying third-party source code into
this research repository. Pinning by URL and commit gives us a stable target
while keeping ownership and licensing boundaries clear.

## First Patch Benchmark Direction

The first code benchmark cases should measure:

- whether the agent changes only allowed files,
- whether forbidden files remain untouched,
- whether the relevant fast test or check passes,
- whether the patch is minimal,
- whether the agent refuses when context is insufficient.

The next implementation step is the patch fixture schema:

```text
Issue 22: Define OSS code patch benchmark schema
```

The schema should include:

- `repoId`,
- `baseCommit`,
- `task`,
- `allowedFiles`,
- `forbiddenFiles`,
- `relevantFiles`,
- `expectedChangedFiles`,
- `forbiddenChangePatterns`,
- `testCommand`,
- `successCriteria`.

## Current Schema And Fixtures

The initial code patch benchmark schema lives in:

```text
packages/code-benchmark/src/index.ts
```

The Nano ID code benchmark now contains 50 positive model-facing cases plus
negative controls for scorer validation. The cases are separated into three
reality levels:

| Reality level | What it represents | Example |
| --- | --- | --- |
| `micro_patch` | Small scoped edits common in daily maintenance work. | Type docs, CLI wording, README wording. |
| `module_patch` | Multi-file consistency work inside one owned module or release surface. | `package.json` + `jsr.json` release metadata updates. |
| `enterprise_boundary` | Corporate boundary cases where the correct action may be refusal. | Product decision missing, runtime default should not be guessed. |

The cases cover:

| Case | Family | Purpose |
| --- | --- | --- |
| `nanoid-code-001` | `allowed_file_fix` | Metadata-only version update constrained to `package.json`. |
| `nanoid-code-002` | `allowed_file_fix` | Type definition comment update constrained to `index.d.ts`. |
| `nanoid-code-003` | `forbidden_file_guard` | CLI-only task that must not touch runtime generator files. |
| `nanoid-code-004` | `insufficient_context_refusal` | Missing product decision should produce refusal instead of patch. |
| `nanoid-code-001..050` | mixed positive cases | Micro patch, module patch, and enterprise boundary tasks. |
| `nanoid-code-neg-001` | `forbidden_file_guard` | Negative control: intentionally touches a forbidden runtime file. |
| `nanoid-code-neg-002` | `allowed_file_fix` | Negative control: intentionally performs an incomplete multi-file metadata update. |
| `nanoid-code-neg-003` | `insufficient_context_refusal` | Negative control: intentionally guesses a code change when context is missing. |

Positive controls verify that valid, bounded patches pass. Negative controls
verify that the scorer catches invalid patches. This distinction matters because
a benchmark that only accepts good examples can still be blind to dangerous
scope drift, partial patches, or speculative edits.

Run the deterministic mock benchmark with:

```bash
npm run build
npm run oss:prepare
npm run code:benchmark
```

The mock benchmark does not measure model quality yet. It verifies that the
schema, fixture boundaries, patch application, git-diff scoring, test command,
refusal scoring, and negative-control detection work before connecting a real
model.

Read these metrics together:

- `Positive control pass rate`: valid fixture patches were accepted.
- `Negative control detection rate`: intentionally bad fixture patches were
  rejected for the expected reason.
- `Expected outcome accuracy`: both positive and negative controls behaved as
  the benchmark expected.
- `Test pass rate`: raw test success. This can be below 100% when negative
  controls intentionally break tests, so it is not the main lab-health metric
  for this scaffold run.

## Model Patch Benchmark

After the deterministic scaffold passes, run the model-generated patch
benchmark:

```bash
LLM_API_BASE_URL=http://127.0.0.1:8000/v1 \
LLM_MODEL=qwen2.5-coder-7b-instruct-q4_k_m \
npm run code:model-benchmark
```

Use `CODE_MODEL_CASE_LIMIT=4` only for quick smoke runs. The default model
benchmark runs all 50 positive cases.

This command uses the same Nano ID cases, but replaces the deterministic mock
patch plans with patch plans generated by an OpenAI-compatible local model
server. The model sees task, allowed files, forbidden files, and relevant file
contents. It does not see evaluator-only fields such as expected changed files
or success criteria. It does see `realityLevel`, which lets reports compare
micro, module, and enterprise-boundary behavior separately.

The benchmark asks the model to return one of two JSON shapes:

```json
{ "kind": "file_edit", "changes": [{ "file": "index.d.ts", "search": "old text", "replace": "new text" }] }
```

or:

```json
{ "kind": "refusal", "reason": "insufficient_context: ..." }
```

If the model returns invalid JSON or an unapplyable patch, the run does not
crash. The case is scored with a `patch_application_failure` signal so model
behavior remains measurable.

For long files such as `README.md`, the model benchmark sends a bounded excerpt
around the task-relevant text instead of the whole file. This is not an oracle
shortcut: expected changed files and scoring criteria remain hidden. It simply
keeps the code benchmark aligned with bounded-context agent behavior.

## dLLM Patch Benchmark

After the autoregressive LLM run, run the same 50 positive Nano ID cases through
the dLLM worker:

```bash
DLLM_WORKER_URL=http://127.0.0.1:8765 \
npm run code:dllm-benchmark
```

This runner uses the Dream-Coder worker's `/infill` endpoint instead of the
behavior benchmark's `/refine` endpoint. That distinction matters:

- `/refine` applies the shared-workspace grounding protocol used by behavior
  benchmarks.
- `/infill` asks the dLLM worker to fill the code patch plan directly.

For code patch scoring, `/infill` is the cleaner comparison because the patch
plan should come from the model-facing task, scope, and file context, not from a
canonical grounding fact. The dLLM runner therefore uses the same hidden-oracle
discipline as the LLM runner:

- the model sees task, allowed files, forbidden files, forbidden patterns, and
  bounded file contents,
- the model does not see expected changed files,
- the model does not see success criteria,
- the same deterministic scorer applies the returned patch to a fresh repo copy.

The two model-facing code patch commands now answer a focused research question:

```text
Given the same bounded code patch packet, does the dLLM infill worker produce
safer or more boundary-aware patch plans than the autoregressive LLM baseline?
```

Use `CODE_MODEL_CASE_LIMIT=4` for a quick dLLM smoke run before spending GPU
time on the full 50-case benchmark.

The dLLM run writes a checkpoint after every generated patch plan. If the worker
or terminal closes during a long run, restart the worker and resume with:

```bash
BENCHMARK_RESUME=1 \
DLLM_WORKER_URL=http://127.0.0.1:8765 \
npm run code:dllm-benchmark
```

This resume behavior is part of the measurement discipline. A disconnected
worker should not be silently scored as a model refusal; it is an operational
failure, so the runner stops and preserves completed cases for the next run.
