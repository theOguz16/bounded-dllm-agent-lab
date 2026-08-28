# Current State

> This file is a narrative snapshot of product and runtime status. Experiment and evidence status is authoritative only in [`evidence/index.json`](../evidence/index.json); [`EVIDENCE_INDEX.md`](./EVIDENCE_INDEX.md) is generated from that machine-readable registry. Historical research and release documents remain evidence records, but they do not override the registry.

## Current Product Definition

Bounded dLLM Agent Lab is an open-source runtime prototype designed around provider-independent contracts. It constrains coding agents with bounded repository context, explicit authority and scope policy, deterministic gates, tamper-evident evidence, controlled apply, validation, and evidence-backed delivery.

It is not currently a finished autonomous software engineering platform or a hosted enterprise service.

## Canonical Runtime Status

| Capability | Status | Current evidence boundary |
| --- | --- | --- |
| Canonical repository intelligence | Implemented | Deterministic fixtures and repository-bound audits |
| Repository intelligence to adaptive context binding | Implemented | Deterministic fixtures |
| Task-to-seed implementation contract | Implemented | Deterministic fixtures |
| Bounded planner proposal contract | Implemented | Deterministic fixtures |
| OpenAI-compatible planner provider | Implemented | Guided live contract validation |
| Preventive minimality contract | Implemented | Deterministic fixtures |
| Combined planner/minimality provider | Implemented | Guided live contract validation |
| Coder mutation and deterministic verifier chain | Implemented prototype | Contract and boundary checks; not semantic correctness proof |
| Disposable apply, validation, rollback, recovery, registry, and delivery primitives | Implemented prototype | Local/self-hosted evidence chain |
| Runtime contract registry, failure taxonomy, and canonical path contract | Implemented | Deterministic fixture and CI validation |
| Single public `runBoundedTask()` coordinator | Implemented prototype | Successful verified-draft, verifier-blocked, and apply-approved E2E fixtures |
| Verifier v2 path/rule engine | Implemented prototype | Canonical path, allowlist, stable-rule, FP/FN, symlink, traversal, and coordinator-integration fixtures |
| Product maintenance contract | Implemented | Node 22, lockfile, `npm ci`, split product suites, clean-clone CI, README, and threat model |
| Distributed multi-host runtime | Not implemented | Explicit post-MVP work |
| Hosted service and dashboard product | Not implemented | Non-goal for current closure |

## Evidence Classes

The canonical claim vocabulary is defined in [`EVIDENCE_CLAIMS.md`](./EVIDENCE_CLAIMS.md). The canonical experiment/evidence status registry is [`evidence/index.json`](../evidence/index.json).

### `deterministic_fixture`

Proves schema, contract, routing, integrity, and fail-closed behavior for controlled inputs. It does not prove live-model quality.

### `guided_live_contract`

Proves that a real provider can return an accepted bounded response and that the adapter, parsing, validation, hashing, and downstream contract chain execute. Expected selections may be visible to the provider, so this class does not prove independent planner quality.

### `unguided_live_selection`

Uses evaluator-only hidden oracle data. It may support independent planner-selection claims when the oracle remains absent from provider-visible context and the evaluation passes.

### `coder_patch_observation`

Observes a generated patch through parse, apply, build, test, acceptance, and rollback behavior. It does not by itself prove comparative advantage.

### `comparative_benchmark`

Compares alternatives on the same tasks, provider, model settings, acceptance rules, and reporting method. This is required for token-saving or relative-quality claims.

### `external_validation`

Uses external repositories, maintainers, users, or independently reviewed tasks. This is required for strong real-world product claims.

## AG.3c Current Status

AG.3c completed a **guided live contract validation** on RunPod with Qwen2.5-Coder-7B.

Observed:

- 2 of 2 guided cases passed.
- 2 total provider attempts were recorded.
- 3,696 provider-reported tokens were recorded.
- OpenAI-compatible adapter execution was observed.
- Exact response-schema parsing was observed.
- Trusted local hashing and evidence verification were observed.
- Proposal validation, implementation graph audit, and preventive minimality evaluation were observed.

Not observed:

- Independent planner-selection quality.
- Coder patch quality.
- Token savings versus a baseline.
- End-to-end latency advantage.
- Infrastructure total cost.
- External repository success.

Reason: the provider-visible `taskContext.requiredOutcome` contained expected seed, symbol, test, and planned-file selections. The committed classification artifact records this answer leakage and limits the allowed claims.

## Current Blocking Gates

### Gate 1 — Claim integrity

Status: **complete**.

- Guided evidence separately classified: complete.
- Answer leakage explicitly recorded: complete.
- Guided results excluded from independent quality metrics: complete.
- Historical/current claim consistency verification: complete.
- Machine-readable evidence index established as the experiment/evidence status source: complete.
- Automated claim-integrity regression and CI workflow: complete.

### Gate 2 — Runtime integrity

Status: **complete for the current prototype boundary**.

- Versioned runtime contract registry: complete.
- Explicit runtime stages and failure taxonomy: complete.
- Canonical repository-relative path contract: complete.
- Public `runBoundedTask()` coordinator: complete.
- Successful verified-draft E2E fixture: complete.
- Verifier-blocked E2E fixture: complete.
- Apply-approved E2E fixture through a typed apply boundary: complete.
- Hash-linked stage and final receipts: complete.

The coordinator currently exposes a provider-independent apply executor boundary. The existing integrated disposable apply implementation remains the canonical concrete apply chain behind that boundary.

### Gate 3 — Verifier reliability

Status: **complete for the current prototype boundary**.

- Async `deterministic-verifier/v2` contract: complete.
- Canonical path normalization for verifier inputs: complete.
- Stable rule IDs, severity, and dispositions: complete.
- Explicit allowlist behavior, including empty-allowlist fail closed: complete.
- Forbidden-file and unsafe-content rejection: complete.
- False-positive approval fixture: complete.
- False-negative rejection and review fixtures: complete.
- Path alias and traversal rejection: complete.
- Symlink path rejection: complete.
- Missing existing-file review route: complete.
- `runBoundedTask()` integration with stable verifier failure codes: complete.

The verifier provides deterministic contract, scope, path, and policy checks. It does not prove semantic correctness or complete vulnerability detection.

### Gate 4 — Product and maintenance

Status: **complete for the current prototype boundary**.

- Node.js 22 maintenance baseline: complete.
- Lockfile-backed `npm ci` install contract: complete.
- Separate product unit, integration, and acceptance commands: complete.
- Local clean-clone validation from a fresh Git checkout: complete.
- Dedicated Gate 4 CI workflow: complete.
- Product-first README opening and quick-start path: complete.
- Current threat model and explicit non-goals: complete.
- Historical research and benchmark commands retained without defining the canonical product surface: complete.

The maintenance contract proves repeatable installation and deterministic prototype validation. It does not establish hosted-service operations, an enterprise SLA, or broad platform compatibility.

### Gate 5 — Comparative product evidence

The machine-readable status of Gate 5 experiments is defined by `evidence/index.json`. Do not infer Gate 5 completion from this narrative section.

## Allowed Current Product Claim

> An open-source agentic-coding runtime prototype that constrains model execution with bounded repository context, explicit scope and authority, deterministic validation gates, controlled apply, and tamper-evident delivery evidence.

## Prohibited Current Claims

The project must not currently claim that it:

- proves bounded or dLLM agents are generally superior;
- proves AG.3c planner-selection quality;
- proves token savings from AG.3c;
- guarantees semantic correctness or security;
- is production-ready, enterprise-grade, distributed, or autonomous end to end;
- has demonstrated external maintainer or customer validation.

## Next Work

Use the machine-readable evidence registry to drive the remaining live comparative evidence work and update experiment status only when durable, verifiable artifacts are committed.
