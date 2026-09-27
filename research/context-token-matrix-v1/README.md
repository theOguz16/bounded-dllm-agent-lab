# Context × token matrix V1 (offline harness)

This is a research-only policy boundary and result format. It does not call a provider, change the production `bounded codex` command, retry, repair, validate, or apply a candidate. The first target is `pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json`, bound by `pilot-target.json` to the task-prompt hash and two allowed files; no experiment was run while building this harness.

The frozen experiment protocol is [PROTOCOL.md](PROTOCOL.md). [calibration.json](calibration.json) records offline measurements for the three existing pilots at source HEAD `09c22b1afeb18e7d6702d8449b667d525f233103`. Only the worker request-ID task passes the current eligibility checks. [experiment-manifest.json](experiment-manifest.json) therefore plans one task, three Stage 1 cells, and three conditional repeats. Its research branch SHA is the immutable prior harness commit used as the source checkout; it cannot refer to its own future commit. The pilot files provide task text and allowed files for the explicit-scope Codex lane, whose compiled policy remains authoritative.

## Context policy

Create a configuration with `createResearchConfig`, then call `selectResearchContext` with the existing production initial evidence, seed files, and required test files. Pass its result to `prepareResearchTaskInput` before an explicitly authorized future task run. The function only substitutes `initialEvidence`, `hardTotalBudgetTokens`, and `reservedOutputTokens`. The binding flow and coder gate still verify file hashes, runtime readable authority, and the hard budget. Task identity, Candidate authority, validation specification, generated-output roots, network policy, durable state, retry, repair, and apply inputs are passed through unchanged. A future runner must assign distinct authorized task/run identities to independent executions; this offline harness does not create or run them.

- `minimal`: retain full evidence for seed and required test files; discard optional initial evidence. Hard total 16,384, reserved output 2,048.
- `current`: return the exact production task input and initial evidence, with the same 16,384/2,048 budget. This is the control.
- `expanded`: preserve current evidence and add at most four verified direct dependency files, sorted by path and capped at 12,288 additional bytes. Hard total 32,768, reserved output 2,048. The existing coder gate still rejects an over-budget composition before a provider call.

The system hard maximum is 32,768 total tokens. Expansion policy remains `existing-bounded-request/v1`; this harness introduces no adaptive routing. For the request-ID task, both initially selected files are required, so `minimal` and `current` select the same 51,881 source bytes at this baseline. `expanded` selects additional authorized direct dependencies. This equality is recorded, not hidden or treated as a conclusion.

The research configuration records experiment ID, variant, model, reasoning, source HEAD, task hash, allowed files, effective budget, additional-evidence bound, and expansion policy. Invalid variants and modified effective policies fail closed. Model output cannot set these values.

## Result records

`createExperimentResult` projects an existing task result into `context-token-matrix/v1`. Supply an explicit run ID, selected context receipt, validation profile/specification hash and syntax detail when available, observed expansion and provider-call counts when available, and trustworthy timing when available. Missing values remain `null`; observed zero remains zero. It stores no task prompt or provider free-form response. Each record keeps initial prompt estimates apart from cumulative planner/coder/provider-session usage, and marks derived uncached and comparison metrics. The record does not itself prove that a future provider invocation used the selection; the future runner must bind the selector receipt to that invocation.

When all provider operations are present, aggregate usage includes context-expansion calls and is marked as a derived sum of observed operations. Otherwise, available task-output totals retain their stated aggregation semantics; missing metrics are not invented.

`historical-references.json` is labeled `historical_non_paired`. It is not execution policy or experimental truth.

## Offline verification and comparison

```sh
npm run test:context-token-matrix-v1
npm run test:context-token-matrix-protocol
npm run research:context-token-matrix:dry-run
npm run research:context-token-matrix:dry-run -- --format json
npm run research:context-token-matrix:calibrate -- /path/to/checkout-at-09c22b1a
node research/context-token-matrix-v1/compare.mjs --format table minimal.json current.json expanded.json
node research/context-token-matrix-v1/compare.mjs --format csv minimal.json current.json expanded.json
node research/context-token-matrix-v1/compare.mjs --format json --historical minimal.json current.json expanded.json
```

The comparison command requires the same task hash, source HEAD, model, and reasoning across result files. It reports outcomes, validation, selected context, cumulative usage, turns, tools, expansion, and changed files. Percent change and shares are labeled derived; it makes no ranking or significance claim.
