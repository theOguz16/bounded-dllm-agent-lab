# Bounded Agent Runtime v0.1 Quickstart

## What this repository provides

v0.1 is a local/self-hosted bounded-context execution and reliability runtime for producing evidence-backed code changes on disposable repository state.

The package root for `@bounded-dllm-agent-lab/product-runtime` exposes only the canonical runtime surface. Historical mock and research APIs remain repository-internal.

## Verify the release evidence

```bash
npm install
npm run build
npm run verify:release
```

A successful v0.1 evidence candidate returns exit code `0` and:

```text
repository_release_evidence_ready
releaseReady: true
```

## Canonical API

The source-level canonical entrypoint is:

```text
packages/product-runtime/src/canonical-runtime.ts
```

The canonical coordinator is:

```ts
import {
  runIntegratedDisposableApply
} from "./packages/product-runtime/src/canonical-runtime.js";
```

The complete input contract requires current context authorization, context-to-apply binding, acceptance criteria, durable registry paths and isolated validation evidence. See:

```text
scripts/integrated-disposable-apply-coordinator-smoke.cjs
```

for an executable repository fixture.

## Release reports

- Architecture: `docs/release/ARCHITECTURE.md`
- Threat model: `docs/release/THREAT_MODEL.md`
- Unified benchmark: `reports/release/UNIFIED_BENCHMARK.json`
- Context sufficiency: `reports/release/CONTEXT_SUFFICIENCY.json`
- Scope drift: `reports/release/SCOPE_DRIFT.json`
- Acceptance coverage: `reports/release/ACCEPTANCE_COVERAGE.json`
- Observed token/cost: `reports/release/OBSERVED_TOKEN_COST.json`
- Fail-closed matrix: `docs/release/FAIL_CLOSED_MATRIX.md`
- Gap closure audit: `docs/release/GAP_CLOSURE_AUDIT.md`
- Known limitations: `docs/release/KNOWN_LIMITATIONS.md`

## Important boundaries

- No automatic merge or production deployment.
- Local SQLite durability is not distributed durability.
- Hash integrity is tamper-evident, not authenticated against a malicious local administrator.
- The normalized token-cost snapshot is not full RunPod infrastructure TCO.
- The observed benchmark task set is intentionally small and is not a universal coding benchmark.
