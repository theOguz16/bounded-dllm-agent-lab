# Context × token matrix protocol V1

Protocol version: `context-token-matrix-protocol/v1`. This protocol is frozen before any live run. The companion manifest is preparation data, not authorization to execute. Live provider/model calls in this preparation phase: **0**.

## Question and controlled variables

Measure how initial model-facing context quantity relates to task completion, cumulative and uncached token usage, provider turns/tool calls, validation, and scope behavior. For every variant of a task, pin the same source HEAD, exact task text hash, allowed files, model `gpt-5.6-luna`, reasoning `medium`, planner behavior, coder behavior apart from initial context selection, validation specification/hash, retry count `0`, repair count `0`, apply count `0`, provider authentication path, invocation journal policy, task policy, and security authority. Use a distinct run identity per attempted cell. The only independent variable is `minimal`, `current`, or `expanded` as implemented by `policy.mjs`. No task definition or variant semantic may be changed to manufacture separation.

`current` returns the original production task input by identity. The other variants may override only initial evidence and the coder context gate's hard total and reserved-output budgets. The system hard maximum is 32,768 total tokens. The existing runtime still owns repository integrity, Candidate authority, validation, retry, repair, apply, generated-output authorization, network policy, and durable state. No model output may choose a budget. Keep the same provider authentication path and invocation journal policy for all cells; record their exact versions/identities before a future live run.

## Eligibility and offline calibration

`calibration.json` pins the source HEAD and records the three existing repository pilots. Its measurements come from committed source bytes and the deterministic context selector and coder gate with an in-process stub. The stub is not a provider. The estimated initial tokens are *offline gate estimates using a fixed task-context envelope*, not observed provider prompt or cumulative usage. A future runner must record its actual initial prompt estimate separately and verify source/task/validation bindings before execution.

A task is eligible only when the source HEAD and task/allowed-file definitions are fixed; full validation and deterministic behavior checks exist; no external network or apply is required; all three context variants pass the security/context gate; and at least one pair is materially different. A pair is materially different if selected files differ, selected bytes differ by at least 1,024, or the estimated initial tokens differ by about 256. These are research design heuristics, never production policy. Prefer `minimal < current < expanded` where an existing task naturally permits it.

For Task A, use the same existing CLI build/typecheck/test specification in every cell and the existing mocked-fetch request-ID acceptance checker on each candidate workspace as a separate behavior observation. Bind its output and the exact validation specification to each future result; a missing check is unavailable evidence, never a pass.

The experiment lane is the existing `bounded codex` explicit-scope CLI. Pilot definitions supply task text, allowed mutation files, and known behavior checks; the pilot runner's separate read-root and forbidden-path rules are not silently substituted into this CLI lane. The CLI's compiled canonical policy and repository-intelligence binding remain authoritative for every variant. A future runner must verify that lane and the candidate validation specification before provider use.

At the pinned source HEAD, the worker request-ID pilot is the sole eligible task in this lane. Its `minimal` and `current` initial context are identical, while `expanded` adds two verified direct dependencies from the CLI's repository-intelligence closure. The local JSON-schema pilot is excluded because `minimal` and `current` exceed their effective input limit. The RunPod help pilot is excluded because all three variants select identical context. Existing synthetic smoke fixtures and external dogfood tasks lack a supported, comparable real coding task definition at this HEAD. Task B (dependency-sensitive) and Task C (broader/multi-file) remain **unselected**; do not claim a three-task matrix or run them until separately calibrated and versioned.

## Primary records and interpretation

Per run, record completed/stopped/failed, decision/route, full validation and behavior, selected file paths/count/bytes, initial prompt estimated tokens, planner and coder cumulative input/cached/derived uncached/output/turns/tools, expansion requested/granted and usage where present, aggregate input/cached/derived uncached/output/total/provider calls/turns/tools, changed files, scope violations, sourceRepositoryUnchanged, and trustworthy elapsed timing. Missing observations remain `null`; observed zero remains zero. Record effective configuration and provenance with each result using `context-token-matrix/v1`.

Initial prompt estimate is **not** cumulative provider-thread input. Cached input is a subset of total input. Derive uncached input only from valid observed input and cached values. The 14,336 effective input-token ceiling of the current 16,384/2,048 budget is an operational V1 limit, not an experimentally proven optimum. A single run is not statistically conclusive. Historical Normal Codex, Earlier Bounded, and Successful Bounded observations are analysis references only and are not clean paired A/B evidence or execution policy.

Report total cumulative input and uncached input together. Total input alone is not a cost proxy, and uncached input alone is not a quality proxy. Provider-side cache state may depend on run order and time. It cannot be reset or guaranteed independent here; preserve run order, timestamps if trustworthy, and cached/uncached observations for interpretation.

## Sampling and order

Stage 1 is one run for each eligible task/variant cell. Inspect source binding, validation, telemetry completeness, and infrastructure health before Stage 2. Stage 2 permits one additional repetition per valid cell; it is conditional, not automatic. The currently eligible one-task plan is **3 Stage 1 runs plus up to 3 Stage 2 runs, at most 6**. A future three-task expansion would be 9 plus up to 9, at most 18, only after a new manifest and calibration. This staged plan avoids committing to 18 provider calls when only one task is eligible.

Use fixed task order A, then B, then C when those categories exist. Rotate variant order: A `minimal → current → expanded`; B `current → expanded → minimal`; C `expanded → minimal → current`. For repetition 2, continue the same recorded order; no randomness. This counterbalances simple order effects across future tasks but does not eliminate cache effects within the present one-task plan.

If a cell stops because of deterministic infrastructure failure, stop the stage, diagnose offline, do not count it as model-quality evidence, and do not immediately rerun it. Never trigger automatic retries or repairs. Keep failed attempt identities and outputs distinct from a later explicitly authorized attempt.

## Execution preparation boundary

`experiment-manifest.json` pins the task, policy, sequence, output paths, and required metrics. `dry-run.mjs` validates it against `calibration.json` and prints every potential cell without importing an agent/provider or writing a live result. A future live runner must bind the exact selector receipt, source HEAD, task hash, validation specification, auth path, and journal policy to each provider invocation; the present manifest and dry run do not establish that live binding. No live experiment is authorized by this protocol file.
