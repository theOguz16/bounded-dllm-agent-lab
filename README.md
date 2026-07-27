# Bounded dLLM Agent Lab

An open-source agentic-coding runtime prototype that constrains model execution with bounded repository context, explicit scope and authority, deterministic verification, controlled apply, and tamper-evident delivery evidence.

The project is not a finished autonomous software engineering platform. It is a provider-independent runtime and research environment for testing whether coding agents can operate inside narrow, auditable boundaries.

## Canonical runtime

```text
repository intelligence
→ planner + preventive minimality
→ bounded coder
→ deterministic verifier v2
→ disposable apply + validation
→ governance + handoff
→ durable receipt / registry
```

The public coordinator is `runBoundedTask()` from `packages/product-runtime/src/canonical-runtime.ts`.

## What is implemented

- versioned runtime, failure, path, and receipt contracts;
- canonical repository intelligence and context binding;
- bounded planner and minimality contracts;
- coder mutation validation;
- deterministic verifier v2 with stable rules, explicit allowlists, traversal and symlink rejection;
- successful, blocked, and apply-approved `runBoundedTask()` flows;
- disposable apply, validation, rollback, recovery, governance, handoff, and registry primitives;
- guided OpenAI-compatible provider validation.

These controls prove deterministic contract and boundary behavior for tested fixtures. They do not prove semantic correctness, complete security, token savings, or general model superiority.

## Requirements

- Node.js 22 LTS
- npm with lockfile support
- Git for clean-clone validation

```bash
nvm use
npm ci
npm run typecheck
npm run build
```

## Product validation commands

The canonical product checks are separated from the historical research suite:

```bash
node scripts/product-maintenance-contract-smoke.cjs
node scripts/product-unit-smoke.cjs
node scripts/product-integration-smoke.cjs
node scripts/product-acceptance-smoke.cjs
bash scripts/product-clean-clone.sh
```

The clean-clone command creates a local clone, runs `npm ci`, typechecks, builds, and executes all three product suites from the clone.

## Evidence boundaries

- `deterministic_fixture`: contract, routing, integrity, and fail-closed behavior for controlled inputs.
- `guided_live_contract`: provider adapter and contract-chain execution with provider-visible expected outcomes.
- `unguided_live_selection`: hidden-oracle selection evidence.
- `comparative_benchmark`: same-task comparison across alternatives.
- `external_validation`: external repositories, maintainers, or independently reviewed tasks.

The single current-state source is [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md). The canonical evidence vocabulary is in [`docs/EVIDENCE_CLAIMS.md`](docs/EVIDENCE_CLAIMS.md).

## Security and non-goals

Read [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) before connecting the runtime to repositories or privileged apply adapters.

The current prototype does not provide autonomous production deployment, unrestricted shell or network authority, hosted enterprise services, compliance certification, or semantic correctness guarantees.

## Repository layout

```text
packages/product-runtime/   canonical runtime contracts and coordinator
scripts/                    deterministic fixtures, reports, and maintenance checks
apps/                       historical CLI, API, web, and worker experiments
docs/                       current state, evidence boundaries, research, and security
examples/                   controlled fixtures and evidence artifacts
```

## Research history

The repository retains the earlier bounded-context, shared-workspace, dLLM, remask, benchmark, and live-provider experiments. Those records remain useful evidence but do not override the current product claims in `docs/CURRENT_STATE.md`.

## License

MIT
