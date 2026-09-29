# Prospective Task B: Codex event ordering

Status: **offline frozen proposal**. The completed context-matrix v1 Task A manifest and its past sessions remain unchanged. This addendum is not wired to `run-live.mjs`; it does not authorize a live matrix. A future live authorization must bind a new runner/manifest to this proposal and pass a fresh zero-call preflight. The source-under-test remains `ea6bc88e947e78b7539b9614b4c637dd9b2805a9`.

## Question and identity

Does additional **initial** repository context improve Candidate correctness or reduce coder trajectory/tool-loop amplification for Codex event ordering, or does it mainly increase token traffic? No variant is ranked in advance.

Task B is the exact robustness `R4` Medium C task object in `task-b-definition.json`. Its canonical sorted-key SHA-256 task hash (excluding `taskHash`) is `sha256:6bdb0008f1333479994b0070bb61a14e0cffa0e28c2cf4eb8452f9deea7ca5e0`. The task wording and provider prompt are copied exactly. Allowed mutation files are **only** `packages/integrations/src/codex-event-parser.ts` and `scripts/smoke/codex-event-parser-smoke.cjs`. The original oracle expression is `node {benchmark}/oracles/event-order.cjs {candidate}`. This branch carries a byte-identical copy at `research/context-token-matrix-v1/oracles/event-order.cjs`, SHA-256 `dfdaa7e7a48ee28f86854d53c729bbddf3d9bb5cfca1c74892847c3177af1a85`.

Every Candidate must be reconstructed in a fresh pinned-source validation checkout. Independently check allowed-file scope, `npm run build`, `npm run typecheck`, `npm test`, and the copied behavioral oracle. All five must pass for Candidate correctness. The unchanged pinned source must fail the behavioral oracle while build/typecheck/tests pass. No network, repair, retry, or apply is permitted.

## Initial context selection

The existing `selectResearchContext` policy is the selection authority. `minimal` retains seed and required-test evidence; `current` is the production initial evidence by identity; `expanded` adds verified direct dependencies within the existing four-file/12,288-byte addition cap. The current production baseline for Task B has only the two required files, so minimal and current coincide. That equality is a design fact, not a positive result. The expanded budget is the existing 32,768 total/2,048 reserved-output setting; minimal/current retain 16,384/2,048. Offline gate estimates below use the frozen Task B prompt envelope and are **not observed provider usage**.

| Variant | Exact initial context files | Bytes | Estimated input tokens |
| --- | --- | ---: | ---: |
| minimal | `packages/integrations/src/codex-event-parser.ts`; `scripts/smoke/codex-event-parser-smoke.cjs` | 24,668 | 6,944 |
| current | same two files | 24,668 | 6,944 |
| expanded | those two, plus `packages/integrations/src/agent-adapter.ts` and `packages/integrations/src/agent-telemetry.ts` | 33,962 | 9,435 |

`agent-adapter.ts` is a direct import of the parser and defines its diagnostic contract. `agent-telemetry.ts` is another direct parser import and defines cumulative usage and telemetry validation, which the frozen task explicitly requires preserving. Their combined 9,294 bytes fit the existing addition cap. `task-b-calibration.json` records exact file hashes, direct `import` edges, byte counts, gate decisions, and estimates. The r10 Bounded trajectory independently observed the same two current files and 24,668 selected bytes, with a 7,281-token prompt estimate, one coder turn, seven counted tools, and no context expansion. The r10 Normal trace inspected downstream adapter smoke/fixtures and `codex-agent-adapter.ts`; those are useful trajectory context, but the latter is 28,498 bytes and is not a bounded direct dependency addition under this selector. Historical r10 is motivation, not paired evidence.

## Execution, budget, and stopping

Model `gpt-5.6-luna`; reasoning `medium`; planner/coder policies unchanged; retry `0`, repair `0`, apply `0`. Start every observation from a fresh disposable checkout of the pinned source. Keep an immutable per-cell identity containing new session ID, task hash, variant, and replicate; never reuse a historical context-matrix or robustness session. Stage 1 order is A `minimal → current → expanded`, then B `current → expanded → minimal`. Stage 2 repeats that order only after explicit validity review and separate authorization. It uses distinct identities and new checkouts. Maximum: six Stage 1 observations and six conditional Stage 2 observations. The planning ceiling is three provider-stage invocations per observation (planner, coder, at most one context request), 18 in Stage 1 and 36 across both stages; actual journal/provider counts must be recorded, not inferred from the ceiling. No live call occurs in this preparation.

Persist a Candidate/model failure and continue only while infrastructure remains trustworthy. Stop immediately on infrastructure failure, ambiguous outcome, source/identity drift, missing Candidate authority, missing oracle evidence, journal ambiguity, or telemetry that prevents the planned comparison. No automatic retry, repair, substitution, or budget change. An explicit product policy stop is an observed outcome, not a reason to manufacture a Candidate.

## Metrics and interpretation

For every cell record Candidate presence and correctness, scope/build/typecheck/test/behavior separately, changed files, selected context paths/bytes/hashes, offline and live initial prompt estimates separately, planner/coder input/cached/derived uncached/output tokens, total usage, provider calls/turns/tools, elapsed generation time, expansion attempts, and `codex-coder-trajectory/v1` with per-turn deltas and bounded tool metadata. Keep unavailable values null. Report coder amplification (cumulative coder input divided by initial coder prompt estimate), coder share, tool calls and tool-result bytes, and cache-sensitive total versus uncached traffic. Compare variants within Task B and describe Task A separately; minimal/current equality means their contrast tests run-order/cache variation rather than context quantity. No composite ranking or causal claim from a single replicate.

Offline freeze inputs are `task-b-definition.json`, `task-b-calibration.json`, `task-b-prospective-manifest.json`, and the copied oracle. The five frozen task hashes, original context-matrix v1 manifest, and robustness r10 artifacts are not changed.
