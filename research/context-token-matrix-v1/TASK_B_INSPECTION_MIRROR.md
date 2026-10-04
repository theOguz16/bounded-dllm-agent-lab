# Task B inspection instruction: final mirrored replication

Status: offline prospective plan and preflight only. This document does not authorize live execution. The mirrored plan is `task-b-inspection-mirror-plan.json`, SHA-256 `b2c358cfbcfca996f9c19a780283bf1b08fb205a6298a48bcb09c190de40285a`. No provider/model invocation belongs to this preparation.

## Frozen design

Run exactly one additional four-cell replication in B1 treatment, A1 control, A2 control, B2 treatment order (BAAB). This mirrors the completed ABBA experiment. Each observation uses a fresh pinned-source checkout and Task B R4 at source `ea6bc88e947e78b7539b9614b4c637dd9b2805a9`, the same `current` selected context (24,668 bytes), planner and planner prompt, `gpt-5.6-luna` at `medium`, timeout, tools, sandbox/network policy, Candidate authority, validation, module-load probe, and independent behavior oracle. Retry, repair, apply, and context expansion remain zero. The shared matrix executor limits the plan to four observations and eight planner/coder provider stages.

The control coder prompt and the treatment instruction are identical to the original experiment. Control prefix SHA-256 is `4603fac5b703f785b570f75b9e06804f68c5e354fdb2ef6876533024fe7888e2`; treatment prefix SHA-256 is `b71156c3b1667aec4ee44fbec6ba6da83d69a4c25d860bc5a0ad17bc5cd617a7`. The plan repeats the original condition definitions byte for byte. The authority pins the new plan hash and exact BAAB order; no new prompt or runner mechanism is introduced.

## Stop and measurement rules

An infrastructure failure, ambiguous provider outcome, or prompt/authority mismatch stops remaining cells. A production timeout remains product behavior without inferred missing usage or replacement authority. Candidate failure is recorded and continuation follows the frozen plan only while infrastructure remains healthy. No retries, repairs, applies, or context expansions are permitted.

Persist per cell: Candidate correctness; scope, build, typecheck, tests, module load, and behavior oracle; aggregate input, cached and uncached input, and output; planner input; coder input, cached and uncached input, and output; coder amplification and normalized tool count; elapsed, planner duration, and coder duration; full coder prompt hash and trajectory version; expansion requests and grants; failure/timeout classification. Missing usage remains unavailable rather than inferred.

## Pre-registered interpretation after a future live run

Report all eight observations individually in their actual orders: original A1, B1, B2, A2 and mirrored B1, A1, A2, B2. Then describe control and treatment ranges across four runs each, Candidate PASS counts, coder input, coder uncached input, amplification, normalized tools, elapsed, and coder duration. Report paired directions, not only condition averages. Do not make statistical or causal claims.

Broader-task testing is supported only if all treatment Candidates preserve correctness, treatment coder input is lower in both mirrored comparisons, treatment does not increase normalized tool count in either mirrored comparison, and no new correctness, timeout, or infrastructure concern appears. This is descriptive support, not causal proof.

Retire further same-task inspection-instruction experiments if paired effects remain opposing or mixed, treatment materially increases coder input or tool count in a mirrored comparison, condition ranges remain dominated by control run-to-run variance, or correctness degrades. If the result is mixed, do not propose a third same-task replicate. The next candidate research lever is the previously identified structured navigation cue. Do not revise the treatment wording after observing results.

## Offline gate

Build and run the mirrored offline fixture, then commit and push before clean-harness preflight. Preflight must verify the local and remote harness HEAD, unused future session identity, frozen Task B/context bindings, all four prospective planner and coder authorities, exact BAAB order, and zero provider calls, journal mutations, and live-session reservations. The prospective live entry remains uninvoked.
