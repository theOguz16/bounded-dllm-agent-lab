# Current State

> This document is a narrative projection of the repository. **Experiment and evidence status is authoritative only in [`evidence/index.json`](../evidence/index.json).** Runtime truth comes from code and CI on `main`; this file does not own experiment status. [`EVIDENCE_INDEX.md`](./EVIDENCE_INDEX.md) is generated from the machine-readable registry.

## Product definition

Bounded dLLM Agent Lab is a provider-independent agentic-coding runtime prototype built around bounded authority. It combines repository intelligence, task-owned bounded context, planner/minimality contracts, controlled coding, deterministic verification, disposable apply/validation, governance, delivery, and tamper-evident evidence.

Earlier dLLM, remask, shared-workspace, synthetic-context, and benchmark implementations remain useful research inputs. They are not the canonical runtime definition.

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

## Documentation rule

Documentation follows code and evidence; it does not override them.

- benchmark documents describe methodology and historical runs;
- runbooks describe reproducible procedures;
- `CURRENT_STATE.md` summarizes canonical runtime direction;
- `evidence/index.json` owns experiment status;
- generated evidence docs must remain reproducible from the registry.

When code or evidence changes, update narrative docs to reflect that state rather than preserving obsolete milestone language.
