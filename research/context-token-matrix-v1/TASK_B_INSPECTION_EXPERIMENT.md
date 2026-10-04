# Task B coder inspection instruction: prospective design

Status: **not live executed**. Live execution requires separate explicit authorization.

## Question and fixed inputs

For Task B R4 (`sha256:6bdb0008f1333479994b0070bb61a14e0cffa0e28c2cf4eb8452f9deea7ca5e0`), does one coder workflow instruction change tool count, cumulative coder input, uncached input, amplification, or elapsed time while retaining Candidate correctness? This is a descriptive experiment with two observations per condition; it does not support a statistical or causal conclusion.

Every observation uses pinned source `ea6bc88e947e78b7539b9614b4c637dd9b2805a9`, a fresh checkout, the existing Task B `current` selected context, `gpt-5.6-luna` at `medium`, the same planner prompt, timeout, tool capabilities, sandbox/network policy, scope, independent build/typecheck/test/module-load/behavior oracle, and no retry, repair, apply, or context expansion. The original Task B Stage 2 and telemetry plans remain unchanged.

## Conditions and order

The [machine-readable plan](task-b-inspection-plan.json) is SHA-256 `2ef01b65dc466891a8db4a6b59902ec0f96d7bc4c33bc1e2ecc918a172f1072d`. Its four slots are A1 control, B1 instruction, B2 instruction, A2 control. At most four observations and eight planner/coder provider stages may occur. The existing shared matrix executor enforces these ceilings.

Control uses the existing coder prompt byte for byte. Its coder workflow prefix SHA-256 is `4603fac5b703f785b570f75b9e06804f68c5e354fdb2ef6876533024fe7888e2`.

Treatment adds exactly this line immediately before `Bounded coder context follows:`. Its coder workflow prefix SHA-256 is `b71156c3b1667aec4ee44fbec6ba6da83d69a4c25d860bc5a0ad17bc5cd617a7`.

> Minimize redundant repository inspection. When practical, batch related read-only inspections, do not reread files that have not changed since your previous inspection, and begin implementation once you have sufficient evidence to make the required change. Do not skip any required build, typecheck, test, scope, or validation checks.

The authority checks the exact prefix and each slot's condition before provider invocation. It also binds the immutable plan hash, frozen Task B task and source, selected context definition, model, reasoning, prior Stage 1 composition, and per-stage journal identity. The full coder prompt depends on the planner result, so its exact SHA-256 is recorded for each observation when the provider request is made; no missing usage is inferred.

## Evidence and interpretation

Each cell persists its condition and prompt hashes, Candidate and validation outcomes, aggregate and per-stage usage, coder amplification, normalized tool count, trajectory schema, planner/coder durations, elapsed time, context expansion state, and failure classification. Raw provider result persistence remains disabled for prospective matrix cells. End-to-end `turn.completed` usage is the token source. No per-tool usage interval threshold applies.

Report A1, B1, B2, A2 individually before condition ranges and PASS counts. A Candidate failure is valid evidence. Infrastructure failure or ambiguous provider outcome stops remaining cells. A production `agent_timeout` remains product behavior, with no inferred coder usage or replacement authority.

## Offline boundary

Offline tests and preflight use disposable source and journal fixtures while recomposing historical Stage 1 evidence at its canonical paths. They must leave the real journal and historical artifacts unchanged and must not reserve a live session. The plan is prospective only until a separate live authorization is given.
