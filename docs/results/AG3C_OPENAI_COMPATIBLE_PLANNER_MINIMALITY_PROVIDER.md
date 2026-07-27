# AG.3c — OpenAI-Compatible Combined Planner-Minimality Provider

> Current product and evidence status is defined by [`docs/CURRENT_STATE.md`](../CURRENT_STATE.md). Claim rules are defined by [`docs/EVIDENCE_CLAIMS.md`](../EVIDENCE_CLAIMS.md).

AG.3c connects the AG.3b single-call planner/minimality provider surface to an OpenAI-compatible chat-completions endpoint.

## Runtime path

```text
bounded task + policy + allowed change scope
→ one OpenAI-compatible provider request
→ exact { proposal, minimalityPlan } JSON draft
→ trusted rationale/proposal hashing
→ AG.2a proposal validation
→ AG.1c repository graph audit
→ AG.3a preventive minimality evaluation
→ coder only when the minimality route permits it
```

The model is never trusted to generate cryptographic hashes. It supplies plain rationale and minimality declaration fields; the adapter validates the exact schema and creates canonical hashes locally.

## Guarantees

- Exactly one combined model request per attempt.
- At most two bounded attempts.
- Malformed JSON and exact-schema failures receive at most one corrective retry.
- Timeout, network, HTTP, response-size and task-context-size failures are represented in hash-linked attempt/run evidence.
- Provider-reported token usage is captured without fabricating missing usage.
- Pricing is comparison-only and exists only when the operator configures rates.
- Model-provided proposal, rationale, plan, receipt or baseline hashes are rejected.
- The deterministic suite verifies integration with AG.3b and confirms that a repository-installed dependency is stopped before coder execution.
- The deterministic fixture does not claim live-model quality, coder patch quality, token savings, latency, or infrastructure cost.

## Commands

```text
npm run verify:ag3c
npm run validate:ag3c-live
```

## Evidence

- `reports/ag/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER.json`
- `reports/ag/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER_LIVE.json`
- `reports/ag/AG3C_LIVE_EVIDENCE_CLASSIFICATION.json`
- `scripts/ag3c-openai-compatible-planner-minimality-provider-smoke.cjs`
- `scripts/ag3c-openai-compatible-planner-minimality-provider-live.cjs`
- `scripts/ag3c-live-evidence-classification-smoke.cjs`

## Observed RunPod validation

The canonical Qwen2.5-Coder-7B RunPod validation completed successfully:

- Decision: `ag3c_live_combined_planner_minimality_validation_passed`
- Raw evidence class: `observed_run`
- Canonical classification: `guided_contract_conformance`
- Expected outcome visible to provider: `true`
- Cases passed: `2/2`
- Total attempts: `2`
- Provider-reported total tokens: `3,696`
- Pricing source: `not_configured`
- Raw report hash: `sha256:b7f8817bfffe26dc97447478c8088e84911f8a750df88b7b766b830968222940`

The provider-visible `taskContext.requiredOutcome` contained expected seed-file, symbol, test-file, and planned-file selections. Therefore this run validates provider conformance, exact-schema handling, trusted hashing, bounded proposal validation, graph audit, preventive minimality execution, and evidence integrity. It does **not** observe independent planner-selection quality, coder patch quality, token savings, latency advantage, infrastructure total cost, or external repository success.

An unguided hidden-oracle run is required before planner-selection quality may be reported.
