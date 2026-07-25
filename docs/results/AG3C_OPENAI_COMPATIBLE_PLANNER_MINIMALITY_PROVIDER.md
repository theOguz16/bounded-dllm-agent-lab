# AG.3c — OpenAI-Compatible Combined Planner-Minimality Provider

AG.3c connects the AG.3b single-call planner/minimality provider surface to an
OpenAI-compatible chat-completions endpoint.

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

The model is never trusted to generate cryptographic hashes. It supplies plain
rationale and minimality declaration fields; the adapter validates the exact
schema and creates canonical hashes locally.

## Guarantees

- Exactly one combined model request per attempt.
- At most two bounded attempts.
- Malformed JSON and exact-schema failures receive at most one corrective retry.
- Timeout, network, HTTP, response-size and task-context-size failures are
  represented in hash-linked attempt/run evidence.
- Provider-reported token usage is captured without fabricating missing usage.
- Pricing is comparison-only and exists only when the operator configures rates.
- Model-provided proposal, rationale, plan, receipt or baseline hashes are rejected.
- The deterministic suite verifies integration with AG.3b and confirms that a
  repository-installed dependency is stopped before coder execution.
- The deterministic fixture does not claim live model quality, coder patch quality,
  token savings, latency, or infrastructure cost.

## Commands

```text
npm run verify:ag3c
npm run validate:ag3c-live
```

## Evidence

- `reports/ag/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER.json`
- `scripts/ag3c-openai-compatible-planner-minimality-provider-smoke.cjs`
- `scripts/ag3c-openai-compatible-planner-minimality-provider-live.cjs`

The live script writes a separate `observed_run` artifact. Until that artifact is
executed on RunPod and committed, AG.3c must not claim observed Qwen quality.
