# Context × token matrix V1 (offline harness)

This is a research-only policy boundary and result format. It does not call a provider, change the production `bounded codex` command, retry, repair, validate, or apply a candidate. The first target is `pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json`, bound by `pilot-target.json` to the task-prompt hash and two allowed files; no experiment was run while building this harness.

The frozen experiment protocol is [PROTOCOL.md](PROTOCOL.md). [calibration.json](calibration.json) records offline measurements for the three existing pilots at source HEAD `ea6bc88e947e78b7539b9614b4c637dd9b2805a9`. Only the worker request-ID task passes the current eligibility checks. [experiment-manifest.json](experiment-manifest.json) therefore plans one task, three Stage 1 cells, and three conditional repeats. It pins the source-under-test HEAD separately from the research harness baseline SHA; each run records its actual harness HEAD. The pilot files provide task text and allowed files for the explicit-scope Codex lane, whose compiled policy remains authoritative.

## Context policy

The research runner calls `selectResearchContext` with the production initial evidence, seed files, and required test files, then passes its result to `prepareResearchTaskInput` at the real bounded task boundary. The function only substitutes `initialEvidence`, `hardTotalBudgetTokens`, and `reservedOutputTokens`. The binding flow and coder gate still verify file hashes, runtime readable authority, and the hard budget. Task identity, Candidate authority, validation specification, generated-output roots, network policy, durable state, retry, repair, and apply inputs are passed through unchanged. The runner scopes journal run IDs by session and variant. Building and testing this interface makes no provider call.

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
npm run research:context-token-matrix:calibrate -- /path/to/checkout-at-ea6bc88e
node research/context-token-matrix-v1/compare.mjs --format table minimal.json current.json expanded.json
node research/context-token-matrix-v1/compare.mjs --format csv minimal.json current.json expanded.json
node research/context-token-matrix-v1/compare.mjs --format json --historical minimal.json current.json expanded.json
```

The comparison command requires the same task hash, source HEAD, model, and reasoning across result files. It reports outcomes, validation, selected context, cumulative usage, turns, tools, expansion, and changed files. Percent change and shares are labeled derived; it makes no ranking or significance claim.

The research-only live interface is:

```sh
npm run research:context-token-matrix:preflight
BOUNDED_CODEX_INVOCATION_JOURNAL_PATH="$HOME/.bounded-agent/bounded-dllm-agent-lab/provider-invocations.sqlite" BOUNDED_CODEX_MODEL="gpt-5.6-luna" npm run research:context-token-matrix:live -- --stage 1
```

The first command uses a disposable checkout at the production source SHA and makes no model call. The second requires separate explicit authorization and writes each future cell outside `/tmp` under `$HOME/.bounded-agent/bounded-dllm-agent-lab/live-runs/context-token-matrix-v1/`.

The first partial Stage 1 session, `stage1-sea2Yp`, remains immutable and outside the new primary matrix. [historical-stage1-sea2Yp-interpretation.json](historical-stage1-sea2Yp-interpretation.json) records its original runner classification and the audited interpretation of its Candidate compile failure. The research runner now requires a product failed-check receipt and a bounded local Candidate diagnostic before treating fail-fast `NOT_RUN` checks as a Candidate validation failure. Missing tools, missing execution evidence, source drift, and ambiguous diagnostics stop the stage; product validation results are unchanged.

## Task B runner preparation

Task B, Codex event ordering, has a separate explicit route. Its prospective definition, calibration, oracle, and protocol remain frozen. `run-live.mjs preflight --task B --session-id <fresh-id>` checks those frozen bytes, recomputes the context calibration at the pinned source, verifies the local validation container, and makes zero provider calls. The session ID must begin with `task-b-stage1-` and be supplied by the future operator; preflight does not create its result directory. `run-live.mjs live --task B --stage 1 --session-id <same-id>` is the future Stage 1 entry. This preparation does not invoke it.

The six slots are `A:minimal`, `A:current`, `A:expanded`, `B:current`, `B:expanded`, `B:minimal`. Here A and B name Task B replicates. Minimal and current both select the parser and parser smoke (24,668 bytes, offline estimate 6,944 tokens). Expanded adds only `agent-adapter.ts` and `agent-telemetry.ts` (33,962 bytes, offline estimate 9,435 tokens). The runner reserves each identity before an observation, checks the persistent journal for reuse, and caps Stage 1 at six observations and eighteen provider-stage invocations. Each observation uses a fresh checkout of `ea6bc88e947e78b7539b9614b4c637dd9b2805a9`. The existing Task A command remains available with its historical authority.

Offline wiring fixtures: `npm run test:context-token-matrix-task-b-live`. They use no live provider.
