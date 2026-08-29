# Bounded dLLM Agent Lab

An open-source, provider-independent agentic-coding runtime prototype for executing repository changes inside bounded, auditable authority.

The canonical runtime combines repository intelligence, bounded context, explicit mutation scope, deterministic verification, controlled apply, and tamper-evident evidence. Earlier dLLM, shared-workspace, remask, synthetic-context, and benchmark experiments remain in the repository as research history; they no longer define the product surface.

## Canonical runtime

```text
repository intelligence
→ planner + preventive minimality
→ bounded coder
→ deterministic verifier
→ disposable apply + validation
→ governance + delivery
→ durable evidence / receipts
```

The public coordinator is `runBoundedTask()` in `packages/product-runtime/`. The controlled-coding pilot uses the same bounded-authority direction with task-owned context, provider-neutral execution failures, deterministic verification, and immutable evidence tooling.

## Source of truth

Documentation is descriptive, not authoritative experiment state.

- Runtime behavior: code and CI on `main`.
- Experiment/evidence status: [`evidence/index.json`](evidence/index.json).
- Human-readable evidence index: [`docs/EVIDENCE_INDEX.md`](docs/EVIDENCE_INDEX.md), generated from the machine-readable registry.
- Product/runtime narrative: [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md).
- Claim vocabulary and limits: [`docs/EVIDENCE_CLAIMS.md`](docs/EVIDENCE_CLAIMS.md).

A fixture, harness, or green CI job is not automatically a live observed result. Pending experiments remain pending until durable evidence is committed and registered.

## Current evidence boundary

The repository currently contains durable observed evidence for the legacy unified release benchmark and Controlled Coding Pilot V1. Gate 5 A–E has a deterministic fixture contract but no registered durable live artifact. Mode F C/E/F and Controlled Coding Pilot V2 observed runs remain pending in the evidence registry.

Do not infer a stronger status from old benchmark notes or historical PR descriptions; query `evidence/index.json` instead.

## Requirements

- Node.js 22
- npm with lockfile support
- Git

```bash
nvm use
npm ci
npm run typecheck
npm run build
```

## Canonical validation

The repository keeps broad historical research commands, but current product validation is centered on deterministic runtime and maintenance checks plus the evidence registry:

```bash
node scripts/product-maintenance-contract-smoke.cjs
node scripts/product-unit-smoke.cjs
node scripts/product-integration-smoke.cjs
node scripts/product-acceptance-smoke.cjs
node scripts/evidence-index.cjs verify
```

Controlled Pilot V2 also has a dedicated offline CI gate. Live-provider experiments are intentionally separate from PR CI.

## Repository layout

```text
packages/product-runtime/   canonical runtime contracts and coordinator
packages/repo-intelligence/ repository analysis primitives
packages/integrations/      provider/executor integrations
scripts/controlled-pilot/   controlled pilot policy/runtime modules
pilots/                     bounded pilot task definitions and evidence
scripts/                    fixtures, research runners, verification tooling
evidence/                   machine-readable experiment/evidence registry
docs/                       narrative, research history, runbooks, security
examples/                   controlled fixtures and retained artifacts
```

## Research history

Historical benchmark and experiment documents explain how older measurements were produced. They are retained for reproducibility, not as competing current-state documents. Their claims are bounded by the canonical evidence registry.

## Security and non-goals

Read [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) before connecting privileged repository or apply capabilities.

The current prototype does not claim autonomous production deployment, semantic correctness guarantees, complete security, enterprise SLA/compliance, or general superiority over other coding-agent architectures.

## License

MIT
