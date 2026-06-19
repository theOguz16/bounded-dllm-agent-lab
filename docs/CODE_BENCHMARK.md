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

The first Nano ID cases cover:

| Case | Family | Purpose |
| --- | --- | --- |
| `nanoid-code-001` | `allowed_file_fix` | Metadata-only version update constrained to `package.json`. |
| `nanoid-code-002` | `allowed_file_fix` | Type definition comment update constrained to `index.d.ts`. |
| `nanoid-code-003` | `forbidden_file_guard` | CLI-only task that must not touch runtime generator files. |
| `nanoid-code-004` | `insufficient_context_refusal` | Missing product decision should produce refusal instead of patch. |
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
