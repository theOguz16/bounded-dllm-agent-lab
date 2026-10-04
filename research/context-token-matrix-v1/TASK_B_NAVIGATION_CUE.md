# Task B symbol navigation cue: prospective offline preparation

Status: **not live executed**. This design does not authorize provider/model calls. The immutable four-cell plan is `task-b-navigation-plan.json`, SHA-256 `fe8383016b01e9005515564c0a236ea442fc82451220f2b30d60652b3333da0d`. It uses Task B R4 at pinned source `ea6bc88e947e78b7539b9614b4c637dd9b2805a9`, `current` context in all cells, ABBA order (control, navigation cue, navigation cue, control), four observations and eight planner/coder stages maximum. Retry, repair, apply, and context expansion are zero. The shared matrix executor is unchanged.

## Frozen cue and provenance

The exact UTF-8 block, with LF between its two lines, no trailing newline, `JSON.stringify` compact object serialization, and property/array order as shown, is:

```text
Navigation cue (symbols only):
{"symbolsByFile":{"packages/integrations/src/codex-event-parser.ts":["parseCodexJsonl"],"scripts/smoke/codex-event-parser-smoke.cjs":["main"]}}
```

It is 174 bytes; the repository's four-character offline estimate is 44 tokens. SHA-256 is `bb8d818d86dafa932ed304f957ccaa7aa698b9ced91999d851acdbf0ab2f5b88`. It is inserted as one block immediately before `Bounded coder context follows:`. The preceding line, block, following line, and serialized runtime context are joined by one LF each. Control has no block. Control prefix SHA-256 remains `4603fac5b703f785b570f75b9e06804f68c5e354fdb2ef6876533024fe7888e2`; navigation prefix SHA-256 is `f2a29076eb17300362ce044a2002cea35f2e50f8bb59b9b2fe1e990fe21d9b14`.

The context selector already calls `analyzeCanonicalRepository` for both conditions. The prospective selection retains that **same in-memory result** as runtime-only metadata; it is not added to model context or persisted as raw source. The projection rule `task-b-selected-seed-sole-function/v1` verifies the canonical analyzer artifact and selected file facts, then selects the sole exported function in the parser file and the sole top-level function in the smoke file. It performs no filesystem access, search, analyzer call, or model call. The pinned analyzer artifact hash is `9f9dd6ac6b83045163508cf5c7ffe1959afee5ecc88fd1d337740f71adfe1670`. The selected-context fact-list hash is `1380c7fe3080ffd7557cd6747fc66952879a2622cb23fe7a892e6b370edc6bc2`; the files and source hashes are embedded in the plan. Both conditions derive and verify the cue from the same analyzer pathway, but only treatment serializes it into the coder prompt. The existing Task B execution callback retains its historical second context-consistency selection in both conditions; the cue adds no analyzer invocation to either path.

No source snippets, line ranges, implementation instructions, test instructions, planner symbols, allowed paths, budgets, or tool restrictions are added. The planner prompt is unchanged. The exact full coder prompt hash will be recorded separately for each future observation because its runtime context may differ normally.

## Evidence and decision rule

Future per-cell evidence retains Candidate correctness, scope/build/typecheck/test/module-load/oracle results, aggregate and per-stage exact usage, coder amplification, normalized tool count, elapsed/planner/coder duration, trajectory version, full coder prompt hash, expansion request/grant, and failure classification. Navigation cells also record cue hash, bytes, offline token estimate, analyzer hash, context hash, and projection rule. The prospective artifact writer still excludes raw product and bounded results.

Compare the cue's actual prompt-token overhead with the change in **cumulative coder input**, including cached and uncached input. A tool-count decrease accompanied by greater total coder input is not a net input-efficiency win. Describe the two pairs and ranges without a causal or statistical claim. Infrastructure or ambiguous outcomes stop; Candidate failures remain evidence under the frozen continuation policy. No retry, repair, apply, or replacement authority follows.

Existing bounded trajectory telemetry retains `command_execution` and `file_change`, command request/response byte counts, and timing, but no command identity. It cannot reliably distinguish source inspection, search/listing, build/test/typecheck, and Git. Those subcategories remain unavailable; no command-content telemetry was added.

The offline fairness fixture checks exact serialization, analyzer and selected-context hashes, no post-selection source access, prompt placement, all four planner/coder authorities, original-plan compatibility, and zero provider calls or real-journal mutation. A clean-harness preflight after commit and push must still pass before any separate live authorization.
