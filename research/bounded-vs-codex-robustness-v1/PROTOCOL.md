# Bounded versus Normal Codex robustness benchmark V1

This benchmark is independent of `research/context-token-matrix-v1`. Its production source is `ea6bc88e947e78b7539b9614b4c637dd9b2805a9`. The benchmark authority branch contains only this protocol, the frozen manifest, independent oracles, and runner/reporting code. No Candidate is applied to it.

## Frozen design

Five tasks are defined in `benchmark-manifest.json`, with predeclared difficulty and exact order: R1 Normal/Bounded, R2 Bounded/Normal, R3 Normal/Bounded, R4 Bounded/Normal, R5 Normal/Bounded. Task hashes are SHA-256 of each task object excluding `taskHash`, encoded as sorted-key compact UTF-8 JSON. Once the first live provider call begins, task text, scope, validation, ordering, source, model, reasoning, and policies are immutable. Each system receives the same task text and file scope. Normal is a clean Codex CLI agent; Bounded uses the production `bounded codex --task --allow ... --json` path. Both use `gpt-5.6-luna` and `medium` reasoning. Bounded's built-in planner, context policy, and validation run normally. Retry, repair, and apply are zero/disabled for both systems. No context variants are used.

Difficulty describes source breadth, interface reasoning, behavioral complexity, ambiguity, and validation breadth, as recorded before execution in the manifest. Outcomes and token usage cannot change a difficulty label.

## Source and dependencies

Every observation uses a fresh disposable local clone checked out at the source SHA. No source checkout receives an applied Candidate. `npm ci --offline --ignore-scripts --no-audit --no-fund` provisions the pinned lockfile. `npm run build` prepares the Bounded CLI. Local Bounded configuration is generated deterministically from `detectBoundedLocalConfig()` and the unchanged production default policy; this is the same setup in each clone. Normal Codex works only inside its clone. Bounded's generated Candidate handoff is reconstructed in a second disposable clone for shared validation.

## Validation

For both arms, independently inspect changed files against the declared allowed list, then run `npm run build`, `npm run typecheck`, `npm test`, and the task-specific behavioral oracle in the Candidate validation clone. A command fails if it times out or exits nonzero. Benchmark success requires every shared check to pass. Bounded's internal validation is preserved separately and does not substitute for shared validation. A Candidate-free run has validation `NOT_RUN` and benchmark success false. No partial credit is assigned.

The first three behavioral checks are existing offline pilot acceptance programs. R4 and R5 use independent oracles in this directory. These oracles are never included in model prompts. The pre-run calibration checks that each oracle rejects the unchanged source for the targeted behavior while the source passes build, typecheck, and existing tests.

## Observations and failure policy

Each observation has a frozen run identity `{sessionId}/{taskId}/{system}`. A ledger is durably written before invoking a provider. An identity can be consumed once only. Preserve raw stdout/stderr/event streams, normalized JSON, Candidate patch/handoff when available, source status before/after, shared validation results, telemetry, and monotonic elapsed time. Token fields are null when unavailable. Cached input is a subset of cumulative input; derived uncached is `input-cached` only when both are observed. Normal has no artificial planner/coder stages. Bounded stage records remain separate.

Continue after a genuine Candidate failure if infrastructure remains trustworthy. Stop immediately on infrastructure failure or ambiguity. Never repair, retry, tune, replace a task, increase budgets, or add observations after a live result. Maximum task observations: ten. Do not infer a monetary cost from token totals.

## Preflight and reporting

`node preflight.cjs` makes zero provider/model calls. It checks branch and source, all five hashes and orders, offline dependency and validation preparation, Docker, Bounded doctor, Codex login and explicit model/reasoning configuration, the invocation journal path, result root, and unused run identities. If it fails, stop. Push the frozen branch and verify its remote SHA before the first live observation. The final report is descriptive: a five-task paired table, ten-run table, reliability counts, observed tokens including cached and uncached, changed-file counts, scope, elapsed times with one definition, Bounded internals, infrastructure events, future research candidates, exact provider call count, and Git state. No composite score or ranking is used.

Run a single observation with `node run-observation.cjs R1 normal` (or its frozen system/order counterpart) only after preflight and remote SHA verification. The runner reserves the identity before generation and refuses to consume it again. Run observations in the manifest order, stopping on any `infrastructure-event.json` or ambiguous process exit. The persistent result root is `$HOME/.bounded-agent/bounded-dllm-agent-lab/live-runs/bounded-vs-codex-robustness-v1/` unless `ROBUSTNESS_RESULT_ROOT` is set to another persistent non-source, non-temporary directory. No automatic loop or retry is provided so each outcome can be audited before the next call.
