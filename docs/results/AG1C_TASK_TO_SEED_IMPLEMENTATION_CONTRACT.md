# AG.1c — Task-to-Seed Implementation Contract

## Status

AG.1c binds a task identity to a deterministic implementation contract before
the repository-aware coder flow may run.

```text
taskId + objectiveHash
→ seed files
→ required symbols
→ required tests
→ acceptance criteria contract
→ repository graph audit
→ intelligence snapshot lock
→ AG.1b context binding
→ coder provider
```

## Contract boundary

The implementation contract binds:

- `taskId`;
- `objectiveHash`;
- seed files;
- required symbols;
- required tests;
- the existing Acceptance Criteria Contract hash.

Acceptance criteria are not duplicated. AG.1c recreates and verifies the
existing contract, then requires the same task and objective identity.

## Deterministic graph audit

The audit:

- runs Canonical Repo Intelligence;
- verifies the intelligence hash;
- resolves every required symbol inside the seed dependency closure;
- verifies required test files exist in the same repository snapshot;
- emits a canonical-JSON-hashed audit receipt.

Missing seeds, symbols or tests stop before any context-request or coder
provider call.

## Snapshot drift boundary

The audit intelligence hash is passed into AG.1b as
`requiredIntelligenceHash`. AG.1b scans again immediately before adaptive
context execution. If repository bytes changed, it returns
`repo_context_intelligence_snapshot_mismatch` and does not call either
provider.

This intentionally pays for two deterministic read-only scans in AG.1c.
Correctness and TOCTOU safety take precedence over scan optimization.

## Execution binding

A successful run produces a hash-linked execution receipt containing:

- implementation contract hash;
- audit hash;
- intelligence hash;
- AG.1b context-binding hash;
- coder context hash.

## Evidence

Commands:

```bash
npm run generate:ag1c-evidence
npm run verify:ag1c
```

Artifact:

```text
reports/ag/AG1C_TASK_TO_SEED_IMPLEMENTATION_CONTRACT.json
```

Expected deterministic fixture result:

```text
decision=ag1c_evidence_ready
checkCount=14
reportHash=sha256:0feaa6b75df605c506749d7830aa952f45f10baf89904f5a5173352c06e86128
```

The artifact is `deterministic_fixture` evidence. It does not claim observed
live-model task quality, token savings, latency or infrastructure cost.
