# AG.3c Live Evidence Classification

## Why this classification exists

The committed AG.3c RunPod report is a real observed provider run, but its task context exposes the expected `seedFiles`, `requiredSymbols`, `requiredTestFiles`, and `plannedFiles` to the provider through `taskContext.requiredOutcome`.

That makes the run a **guided contract-conformance validation**, not an independent planner-selection benchmark.

## Source evidence

- Source report: `reports/ag/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER_LIVE.json`
- Source report hash: `sha256:b7f8817bfffe26dc97447478c8088e84911f8a750df88b7b766b830968222940`
- Classification artifact: `reports/ag/AG3C_LIVE_EVIDENCE_CLASSIFICATION.json`
- Evaluation mode: `guided_contract_conformance`
- Expected outcome visible to provider: `true`

## What the run demonstrates

- Qwen2.5-Coder-7B completed 2/2 declared guided cases.
- The OpenAI-compatible adapter accepted and parsed the combined response.
- Exact schema validation, trusted local hashing, proposal validation, graph audit, preventive minimality evaluation, and evidence integrity checks completed.
- Provider-reported token usage was captured.

## What the run does not demonstrate

- Independent selection of the correct minimum repository scope.
- General planner or model quality.
- Coder patch quality.
- Token savings against a direct or alternative baseline.
- Infrastructure cost or latency superiority.

The previous raw field `combinedPlannerMinimalityQualityObserved=true` must not be interpreted as independent planner quality. The classification artifact is the authoritative claim boundary for this observed run.

## Regression rule

When an expected outcome is visible to the provider:

```text
plannerSelectionIndependenceObserved = false
plannerSelectionQualityObserved = false
contractConformanceObserved = source run passed
```

The regression is implemented in:

```text
scripts/ag3c-live-evidence-classification-smoke.cjs
```

## Next evidence

Create an unguided hidden-oracle evaluation where the provider receives only the task, bounded repository facts, candidate scope, policy, and limits. Expected seed files, symbols, tests, and planned files must remain evaluator-only data.
