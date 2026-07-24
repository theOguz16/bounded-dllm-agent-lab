# AG.3b — Planner-Minimality Coder Integration

## Status

Canonical deterministic integration is complete when `npm run verify:ag3b` passes.
This phase does not claim live model quality, token savings, latency, or infrastructure cost.

## Purpose

AG.3a introduced a repository-aware preventive minimality contract. AG.3b places that
contract between a single combined planner-provider call and the coder invocation.

```text
task + authority + policies
→ one planner/minimality provider call
→ bounded planner proposal validation
→ task-to-seed graph audit
→ trusted minimality plan binding
→ preventive minimality gate
→ planner revision / human review / policy bypass / coder
→ hash-linked execution binding
```

The provider returns exactly two logical drafts in one response:

- `proposal`: the existing bounded planner proposal draft;
- `minimalityPlan`: planned files, dependencies, abstractions, refactor intent and risk.

The runtime, not the model, binds the raw minimality plan to the task, planner proposal,
repository intelligence snapshot and active minimality policy hashes.

## Guarantees

- Authority and policy are checked before the provider call.
- The minimality policy is verified before the provider call.
- The combined provider is called at most once.
- Proposal validation and graph audit complete before minimality evaluation.
- Minimality revision and human-review routes never call the coder.
- High-risk policy bypass is explicit and still produces evidence.
- A required intelligence hash locks the pre-minimality audit to coder execution.
- Minimality receipt and baseline hashes are included in coder context.
- The final binding links proposal, implementation contract/audit, intelligence,
  minimality policy/plan/receipt/baseline and task-seed execution hashes.
- The integration itself performs no repository writes, shell execution or network access.

## Evidence

- Contract/integration: `packages/product-runtime/src/planner-minimality-integration.ts`
- Regression suite: `scripts/ag3b-planner-minimality-integration-smoke.cjs`
- Deterministic report: `reports/ag/AG3B_PLANNER_MINIMALITY_INTEGRATION.json`
- Verification: `npm run verify:ag3b`

## Claim boundary

The provider surface is transport-agnostic in AG.3b. The current AG.2b OpenAI-compatible
adapter still returns proposal-only responses. A combined OpenAI-compatible response adapter
and RunPod/Qwen live validation remain a later phase. Therefore AG.3b proves canonical
single-call gating and coder integration with deterministic providers, not live-model behavior.
