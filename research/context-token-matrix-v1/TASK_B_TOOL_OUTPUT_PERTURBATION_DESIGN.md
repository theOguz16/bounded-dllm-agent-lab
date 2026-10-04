# Task B tool-output perturbation: offline design

Status: **frozen proposal, no live execution authority**. The machine-readable proposal is [`fixtures/task-b-tool-output-perturbation-proposal.json`](fixtures/task-b-tool-output-perturbation-proposal.json), SHA-256 `ec88530fa8f6e11cd37a06e91620777cecc6752a91eded472a769776c91ab7d1`. This design neither changes the frozen Task B protocol nor implements a tool-output transform.

## Question and measurement boundary

With the Task B task, model, reasoning, initial selected context, planner behavior, validation, timeout, and command opportunities fixed, does reducing content carried from an eligible command result into the coder session coincide with repeatable changes in total coder input, uncached input, elapsed time, amplification, or correctness? The installed Codex SDK exposes exact usage at `turn.completed`; each observed coder invocation had one completed turn. It exposes no exact usage between individual tools. Report only end-to-end associations. Do not assign token deltas or causal costs to individual tools.

Use R4 Codex event ordering at pinned source `ea6bc88e947e78b7539b9614b4c637dd9b2805a9`, model `gpt-5.6-luna`, reasoning `medium`, and **current** context for every cell. Current selects the parser and parser smoke test, 24,668 bytes. Both authoritative Stage 1 current cells, both Stage 2 current cells, and the completed telemetry current cell produced Candidate PASS. Each new observation would require a fresh pinned-source checkout, identical allowed files, independent scope/build/typecheck/tests/module-load/behavior-oracle validation, and no retry, repair, apply, context expansion, or timeout override.

| Position | Replicate | Condition | Initial context |
|---:|---|---|---|
| 1 | A | control | current |
| 2 | A | compact-medium | current |
| 3 | A | compact-strong | current |
| 4 | B | compact-strong | current |
| 5 | B | compact-medium | current |
| 6 | B | control | current |

This ABCCBA order counterbalances first/last position and gives two observations per condition. All conditions offer the same commands; a model may still choose different actual tool sequences, which must be recorded and treated as a limitation. Six observations permit at most two provider stages each, planner then coder: **12 provider/model calls maximum**. Any planner context request stops that cell because the proposal permits no expansion stage.

## Output eligibility and transformation

The only *conditional* candidates are stdout from a coder-initiated, exploratory `npm run build`, `npm run typecheck`, or `npm test` command with an exact command match, exit code zero, empty stderr, and a verified clean-success output format. This must be distinct from the independent validator's later commands. No output is eligible merely because its command succeeded. If error identity, failure or warning text, failing test names, file/line references needed for diagnosis, ANSI control sequences, or an unrecognized output shape appears, preserve it in full. In particular, the current SDK's `aggregated_output` does not separate stdout and stderr; a prospective intervention must prove that separation at the pre-model execution boundary or fail closed.

| Category | Proposed treatment | Reason |
|---|---|---|
| Source and file reads | Untouched | Truncation can hide code needed for a correct Candidate. |
| Search and listing output | Untouched | Missing matches or paths can change the coder's search and edit choices. |
| Successful exploratory build/test/typecheck stdout | Conditionally eligible | Only if the exact command, exit status, empty stderr, and clean-success format are proven before model carry-forward. |
| Failed build/test/typecheck output and all errors | Untouched | Preserve error identity, failing names, and diagnostic locations. |
| Git status and diff output | Untouched | Preserve file state and patch context. |
| Validation and oracle output | Untouched | Trusted correctness evidence must remain independent and exact. |
| Security, source, Candidate, journal, and authority data | Untouched | Required for integrity and replay protection. |

For a proven eligible payload, `control` is byte-for-byte identity. `compact-medium` preserves up to 4,096 UTF-8-safe bytes from each end; `compact-strong` preserves up to 1,024 from each end. The omitted middle is replaced with a fixed-format marker containing original byte count and SHA-256. If the payload does not exceed the retained ends plus marker, leave it unchanged. Preserve command identity, exit code, and all original bytes only transiently at the trusted execution boundary. The independent validator runs against the unmodified Candidate checkout and receives its own unmodified outputs. The transform must never act on those outputs.

Before live authorization, an offline fixture must prove that the eligible format really has no diagnostic or semantic content lost by either condition. If it cannot, the condition has no eligible payload and the experiment must not run. The completed v2 telemetry shows 33,300 command-result bytes in one current cell, including a 23,533-byte result, but the bounded trajectory does not record command identity or content. That large result cannot be declared eligible from its byte count.

## Feasibility and authority audit

`CodexAgentAdapter` and its isolated worker call `thread.runStreamed(...)` once, then observe the SDK's JSONL events. A `command_execution` item reports `aggregated_output` **after** the Codex CLI has executed the command and advanced its agent loop. Rewriting the event seen by the adapter would alter research telemetry, not the text the coder model saw. The installed SDK typings offer no tool-execution interception or replacement callback. A real pre-model command-result boundary must therefore be identified or added inside the CLI/tool execution path and demonstrated with fake events before this proposal can become executable. No such mechanism is implemented here.

The shared `executeOrderedMatrix` loop can schedule six positions with a fixed `current` variant and the ABCCBA condition sequence; no new bespoke loop is needed. The existing Task B plan reader, specialized preflight, and prospective invocation authority accept only hash-pinned historical plans and fixed orders. They do **not** authorize this proposal. A future additive authority version must bind the condition, transformation version and parameters, six-slot order, source/context/task hashes, intervention proof, and 12-call ceiling to each slot and journal record. Merely adding `condition` to a slot or changing the plan file is insufficient.

The research journal records invocation authority and usage, not raw command results. Future research artifacts should retain only original and carried byte counts, reduction, eligibility/rejection reason codes, transform version, and payload hashes, with no original prompt/source/tool text. The SDK/CLI can persist its own session data outside these research artifacts; that storage and its retention must be audited before any live authorization. Trusted validation and oracle evidence must continue to use original, unmodified output and the existing independent validation path.

## Required observations and stop policy

For each observation persist condition and replicate; Candidate presence; scope, build, typecheck, tests, module load, and independent oracle results; exact coder input, cached input, derived uncached input, and output; planner input separately; aggregate input; coder amplification against the same initial prompt estimate; total elapsed, planner duration, coder duration; tool count; original and coder-carried command-result bytes; absolute and percentage reduction; context expansion request/grant counts; timeout/failure classification; and bounded per-command eligibility metadata. Missing exact usage stays null. Do not infer tokens from bytes.

A compact observation establishes its manipulation only if it removes at least 1,024 bytes **and** at least 10% of all coder command-result bytes. Otherwise stop as `perturbation_not_established` before the next slot and report the partial result. Stop on missing exact usage, ambiguous transformation or intervention, Candidate correctness failure, missing independent evidence, infrastructure/journal/authority failure, or ambiguous provider outcome. A production `agent_timeout` remains product behavior and is reported as such; it cannot create a replacement entitlement. No automatic retry, repair, apply, or extra stage is permitted.

The experiment is informative only if the intervention is proved coder-facing, compact cells achieve the declared byte reduction, exact end-to-end usage is present, validation remains independent, and all six cells share identical initial context. Compare each condition's two runs descriptively, including run-to-run spread and tool-sequence differences. No per-tool token attribution, causal claim, context policy recommendation, or production compaction policy follows from six observations. No live run is justified until the interception, eligibility, SDK retention, and new authority gates pass offline.
