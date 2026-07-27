# Current State

> This file is the single current-state source for product claims, implementation status, evidence boundaries, and blocking gates. Historical research and release documents remain evidence records, but they must not override this file.

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
| Single public `runBoundedTask()` coordinator | Not implemented | Gate 2 blocker |
| Verifier v2 path/rule engine | Not implemented | Gate 3 blocker |
| Distributed multi-host runtime | Not implemented | Explicit post-MVP work |
| Hosted service and dashboard product | Not implemented | Non-goal for current closure |

## Evidence Classes

The canonical claim vocabulary is defined in [`EVIDENCE_CLAIMS.md`](./EVIDENCE_CLAIMS.md).

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
- This file established as the single current-state source: complete.
- Automated claim-integrity regression and CI workflow: complete.

### Gate 2 — Runtime integrity

Requires a public `runBoundedTask()` coordinator, explicit schema versions and failure states, successful and blocked E2E flows, and a fully linked artifact/receipt chain.

### Gate 3 — Verifier reliability

Requires canonical path normalization, rule IDs/severity/allowlists, FP/FN fixtures, symlink/path-traversal tests, and fail-closed behavior.

### Gate 4 — Product and maintenance

Requires one Node LTS baseline, `npm ci`, separated unit/integration/acceptance commands, clean-clone validation, a product-first README opening, and current threat-model/non-goal documentation.

### Gate 5 — Comparative product evidence

Requires unguided hidden-oracle planner validation followed by A/B/C/D/E ablation and external repository tasks.

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

Establish shared runtime/verifier contracts, then implement the public `runBoundedTask()` coordinator for Gate 2.
