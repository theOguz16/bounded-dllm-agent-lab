# Coder trajectory telemetry

`codex-coder-trajectory/v1` is an additive, bounded observation of Codex JSONL for the coder stage. The adapter derives it after normal event parsing and returns it separately from canonical usage, commands, file changes, diagnostics, and status. The research runner writes `coder-trajectory.json` for future cells. Historical Stage 1 and Stage 2 cells stay untouched; their trajectory is unavailable.

Each turn records cumulative input, cached input, uncached input, and output tokens, plus deltas derived from the cumulative counters. The first turn uses the new SDK thread's zero baseline. Decreasing counters, cached input above input, or cached growth above input growth invalidate the affected derivation. Missing usage and incomplete turns retain null values. Tool counts refer to completed command executions. `newToolResultBytesSincePreviousTurn` is the size of completed command output after the previous turn and before this turn; it does not establish whether the SDK included that output in the next prompt.

Each completed command or file-change item records only allowlisted metadata: sequence, category, byte counts, elapsed time if observed, and bounded normalized paths for file changes. The output token estimate uses `ceil(UTF-8 bytes / 4)` and is explicitly marked estimated. Command text, output text, prompts, source contents, stderr, and arbitrary provider text are never copied into this schema. The collector caps records at 64 turns and 128 tools, with at most 8 paths of 160 characters per file-change item. `truncated` signals record-limit truncation.

The runner adds the existing initial coder prompt estimate and selected context file count/bytes to turn 1 only. The SDK does not expose later model-facing prompt serialization, context expansion within its turns, whether old tool results remain represented, or whether selected repository context changes. Those fields remain null. Runtime-only authority data is not read by the collector. The telemetry callback and file write are isolated from the provider and cell outcome.

For a future cell, run `npm run research:context-token-matrix:trajectory -- path/to/coder-trajectory.json` to print a per-turn table and descriptive amplification ratios. Ratios do not establish causality. Nulls remain unavailable in the report.

## Prospective tool-interval telemetry

`codex-coder-trajectory/v2` is emitted by the adapter for future runs. The analysis helper accepts both v1 and v2; historical v1 artifacts are unchanged. The frozen experiment manifests and context policy are unchanged. V2 adds allowlisted numeric fields to each tool event. `provider*BeforeToolEvent` is the **last observed completed-turn cumulative usage before the event**, and `provider*AfterToolEvent` is the **first observed completed-turn cumulative usage after it**. These are SDK turn-boundary observations, not usage snapshots at the exact instant of a tool call. Exact event-time cumulative usage is unavailable from this stream and remains null.

`inputDeltaAfterToolEvent`, and its cached, uncached, and output counterparts, are derived only when one tool event lies between two valid, monotonic usage observations. If multiple tools share an interval, their surrounding observations are retained but individual deltas remain null. Missing or inconsistent provider usage also leaves deltas null. `observationIntervalToolCount` shows how many tool events shared the interval. Even a single-tool interval can include other model or session processing, so its delta is observational and must not be called that tool's cost. Tool request/result bytes are never converted to provider token usage. The existing `responseEstimatedTokens` field remains a separately labeled legacy byte-based estimate.

The compact v2 table prints `tool seq | category | result bytes | input before | input after | input delta after event`. A fake offline fixture in `scripts/smoke/codex-coder-trajectory-smoke.cjs` produces:

| Tool seq | Category | Result bytes | Input before | Input after | Interval delta |
|---:|---|---:|---:|---:|---:|
| 1 | command_execution | 1 | 100 | 180 | 80 |
| 2 | command_execution | 130 | 180 | 330 | 150 |

Only bounded category, counts, timings, normalized paths, and byte sizes are retained. Raw prompts, command text, command output, source content, and arbitrary provider text remain excluded.

## Observed provider boundary and prospective controls

The completed three-slot v2 validation observed 26 coder tool events and zero usable tool intervals. Each coder invocation supplied one `turn.completed` usage snapshot after its tools. The installed SDK event union carries exact input, cached input, cache-write input, output, and reasoning-output counts on `turn.completed` only; its type describes usage *during that turn*. `turn.started` and `item.started`/`item.updated`/`item.completed` carry no usage. The current integration uses a fresh SDK thread for each invocation and calls `runStreamed` once, so the finest exact coder boundary observed is the completed coder turn, effectively the coder-session aggregate for these runs. The collector did not miss an intermediate SDK usage event. A final snapshot cannot assign usage to individual preceding tools, and byte counts cannot supply that missing measurement. The v2 collector treats multiple completed-turn values as cumulative, but that multi-turn interpretation is unverified against this SDK contract and was not exercised by the one-turn live observations.

A future separately authorized plan may declare `telemetryValidity` with a schema version, a minimum fraction of tool events with usable intervals, and required numeric fields. The matrix executor evaluates it after persisting each observation and stops before reserving the next slot with `telemetry_unusable` when unmet. Plans without this declaration retain their existing behavior. The frozen Stage 2 and completed v2 validation plan bytes are unchanged; neither retroactively gains this condition.

Prospective matrix cells now retain the bounded normalized experiment result, trajectory, Candidate and oracle evidence, and summary without writing `raw-product-result.json` or `raw-bounded-result.json`. Those raw files are not needed by prospective journal admission or later cells. Historical Stage 1 files remain unchanged because their hashes and composition bindings require them.

With only a final exact coder usage snapshot, a further per-tool interval run under the same provider surface is not informative. The smallest next measurement is a separately approved controlled tool-output-size perturbation with fixed task, model, and initial context, measured by end-to-end exact tokens and correctness. It would estimate a run-level association, not individual tool carry-forward or causal cost.
