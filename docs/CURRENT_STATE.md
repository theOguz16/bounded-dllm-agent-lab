# Current State

> This document is a narrative projection of the repository. **Experiment and evidence status is authoritative only in [`evidence/index.json`](../evidence/index.json).** Runtime truth comes from code and CI on `main`; this file does not own experiment status. [`EVIDENCE_INDEX.md`](./EVIDENCE_INDEX.md) is generated from the machine-readable registry.

## Product definition

Bounded dLLM Agent Lab is a provider-independent agentic-coding runtime prototype built around bounded authority. It combines repository intelligence, task-owned bounded context, planner/minimality contracts, controlled coding, deterministic verification, disposable apply/validation, governance, delivery, and tamper-evident evidence.

Earlier dLLM, remask, shared-workspace, synthetic-context, and benchmark implementations remain useful research inputs. They are not the canonical runtime definition.

The V1 product target is narrower than the runtime's possible uses. As defined
in [`PRODUCT_SCOPE_V1.md`](./PRODUCT_SCOPE_V1.md), it is an **untested product
hypothesis** for a developer-supervised, single-machine tool that handles small
updates to existing files in JavaScript/TypeScript repositories. The supported
starting scenarios are an existing-function bug fix, a bounded behavior change
in existing files, and a regression assertion added to an existing test file.
Repository evidence verifies implementation boundaries; it does not yet verify
market demand or user benefit.

## Canonical runtime surface

```text
repository intelligence
→ planner + preventive minimality
→ bounded coder
→ deterministic verifier
→ disposable apply + validation
→ governance + delivery
→ durable evidence / receipts
```

Current canonical boundaries include:

- `packages/product-runtime/` — versioned runtime contracts and `runBoundedTask()` coordinator;
- `packages/repo-intelligence/` — canonical repository-intelligence primitives;
- `packages/integrations/` — provider/executor adapters with provider-neutral execution failures;
- `scripts/controlled-pilot/` — decomposed controlled-pilot definition, context, provider, verification, evidence, and runner modules;
- task-owned Controlled Pilot V2 context selections and declarative profiles/verification stages;
- deterministic verifier and controlled/disposable apply paths;
- machine-readable experiment/evidence indexing.

The canonical runtime must be distinguished from two other repository paths:

- the older `apps/cli` patch/PR review, calibration, artifact, and pilot commands
  are legacy compatibility/evaluation surfaces, not an independent reviewer of
  canonical runs;
- masking, dLLM/remask workers, fixtures, ablations, and benchmark reports are a
  research pipeline whose claims remain governed by `evidence/index.json`.

Fixture success in either path does not create a canonical product capability.

## Current mutation and outcome boundary

`text-file-update/v1` updates the complete contents of existing regular UTF-8
text files with an expected source hash. It does not create, delete, or rename
files, and it rejects mode, symlink, binary, non-canonical-path, duplicate,
oversize, stale-source, and identical-content mutations. Product documentation
must not imply those unsupported operations.

V1 reports control success separately from behavioral success. Passing schema,
hash, scope, policy, typecheck, build, and selected-test gates means **controls
passed**. Scenario-specific evidence must independently establish that the
requested behavior is satisfied. Only both together constitute product success.

The existing runtime outcomes retain their code-defined meanings:

- `validated_no_change` means acceptance was demonstrably already satisfied;
- `human_review_required` stops for developer judgment or missing authority;
- `replan_required` requires a new bounded plan or context/candidate;
- `recovery_required` stops mutation until incomplete state is safely restored.

Governed runs preserve the caller's original acceptance contract through
preflight, apply, validation, and recovery. New results use
`bounded-task-receipt/v3`: structural, syntax, typecheck, and behavior-test
evidence is reported separately as `passed`, `failed`, or `not_run`. Draft-only
results are named `structurally_verified_draft`; they do not imply executable
validation. Exact historical v1 and v2 receipts retain their old shapes and
meanings. Durable task state schema `4` uses `canonical-task-input/v4` and binds
trusted task/configuration inputs plus separate starting and expected-terminal
repository content snapshots. Terminal replay reports current cache validity
separately from its historical receipt; drift preserves user content and stops
with `recovery_required`. Schema 3 and older records are rejected rather than
reinterpreted under these stronger currentness semantics.

Canonical policy compiler v2 retains declared paired-file patterns and their
resolved matches as separate fields. A required pattern with no existing match
is a compile error because file creation is outside `text-file-update/v1`.
Static scope, sensitive-path, unconditional pairing, and signed ownership checks
run before planner/coder providers. Mutation-dependent pairing and sensitive
content checks remain enforced immediately before apply.

## Evidence status

Do not infer experiment completion from this document. Query the registry:

```bash
node scripts/evidence-index.cjs verify
node scripts/evidence-index.cjs status gate5
node scripts/evidence-index.cjs status controlled_coding_pilot_v2
```

As registered on `main`:

| Experiment family | Registered status | Meaning |
| --- | --- | --- |
| Legacy unified release benchmark | `observed` | Durable repository-verifiable observed artifact exists. |
| Gate 5 A–E external ablation | `fixture` | Deterministic harness/fixture exists; no durable live artifact is registered. |
| Gate 5 Mode F C/E/F | `pending` | Live validation is still required before any resolver promotion decision. |
| Controlled Coding Pilot V1 | `observed` | Durable controlled-pilot acceptance evidence is registered. |
| Controlled Coding Pilot V2 | `pending` | Offline runtime/gates exist; two real-provider observed runs are still required. |

A green fixture workflow is not equivalent to `observed`.

## Mode F boundary

Mode F remains research-only until its live C/E/F evidence satisfies the promotion gate: same or better strict success than E, less context, and no additional scope drift. Until then, its narrow JavaScript/TypeScript resolver must not be promoted into canonical repository intelligence.

If the gate eventually passes, promotion should happen through a canonical language-evidence resolver abstraction consumed by both research and runtime code, not by copy-pasting research implementation.

## Controlled Pilot V2 boundary

The V2 runtime protocol, bounded text-edit machinery, task-owned context, declarative registry, offline CI gate, provider-neutral failure taxonomy, and split pilot engine are implemented on `main`.

The evidence registry still marks V2 as pending because durable observed runs for both canonical V2 tasks have not yet been captured against one real provider/model/config. Pending observed evidence must remain separate from fixture or loopback success.

## Current claim boundary

The project may be described as:

> An open-source, provider-independent agentic-coding runtime prototype that constrains repository changes with bounded context, explicit authority, deterministic verification, controlled apply, and tamper-evident evidence.

It must not currently claim that it:

- proves bounded/dLLM agents are generally superior;
- proves Gate 5 or Mode F live comparative advantage before registered live evidence exists;
- proves Controlled Pilot V2 observed behavior before its real runs are committed and verified;
- guarantees semantic correctness or complete security;
- is a finished autonomous, distributed, enterprise-grade software engineering platform.
- automatically repairs every failed change, supplies independent review
  certification, or is ready for production use;
- supports file creation, deletion, or rename through `text-file-update/v1`;
- has validated developer demand, productivity gains, or defect reduction.

## Documentation rule

Documentation follows code and evidence; it does not override them.

- benchmark documents describe methodology and historical runs;
- runbooks describe reproducible procedures;
- `CURRENT_STATE.md` summarizes canonical runtime direction;
- `evidence/index.json` owns experiment status;
- generated evidence docs must remain reproducible from the registry.

When code or evidence changes, update narrative docs to reflect that state rather than preserving obsolete milestone language.
