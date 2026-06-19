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
