# Combined Task A + Task B context-token-matrix analysis

Offline descriptive analysis of 18 frozen observations. No provider/model calls were made for this analysis. Usage values are cumulative provider-session telemetry; cached input is included in input. Expanded comparisons within a group share one expanded observation, so the two pair rows are not independent replicates.

## Evidence and normalization

- Task A: 6 observations from `stage1-63ffc26412212dc72f5e2971` and `stage2-5c41e2532d3bd1637f97dd2e`, bound to the Stage 2 review. Task B: 6 composed Stage 1 rows and 6 Stage 2 rows.
- Complete aggregate usage: 17/18. Candidate produced: 17/18; validation PASS: 16/18; Candidate validation failure: 1; product timeout: 1.
- Task A expansion request counts are unavailable in its result records. The frozen finding says no expansion was granted; grant is recorded as zero. Task B records request/grant as zero.
- Planner and coder stage durations come from durable-journal `terminalAt - startedAt`; observation elapsed comes from each experiment result. The timeout keeps null aggregate/coder usage.
- The normalized JSON and CSV retain selected file lists, telemetry, outcomes, provenance hashes, and nulls.

## Same-context variance

Minimal and current select exactly the same files and bytes within each group. Candidate production was 12/12; validation PASS was 11/12 because Task A Stage 2 minimal produced a Candidate that failed syntax validation.

| Group | Selected bytes | Input | Uncached | Output | Elapsed s | Amplification | Tools | Input spread (% of lower) | Candidate PASS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A Stage 1 | 51,881 | 217,142–394,164 | 44,854–50,100 | 2,388–4,089 | 105.987–152.294 | 14.24–26.57× | 4–8 | 81.5% | 2/2 |
| A Stage 2 | 51,881 | 123,994–185,780 | 30,900–40,026 | 1,836–2,183 | 77.343–105.848 | 7.76–12.07× | 1–4 | 49.8% | 1/2 |
| B Stage 1 A | 24,668 | 169,793–249,592 | 33,601–36,088 | 3,412–3,954 | 169.931–181.339 | 21.58–32.60× | 6–9 | 47.0% | 2/2 |
| B Stage 1 B | 24,668 | 165,473–245,389 | 32,097–40,077 | 3,464–4,033 | 166.272–187.403 | 20.99–32.02× | 4–8 | 48.3% | 2/2 |
| B Stage 2 A | 24,668 | 138,893–190,194 | 21,901–46,066 | 3,107–3,225 | 158.929–176.478 | 17.39–24.38× | 5–5 | 36.9% | 2/2 |
| B Stage 2 B | 24,668 | 144,961–188,148 | 52,033–58,100 | 3,330–3,393 | 165.245–165.558 | 18.22–24.10× | 5–5 | 29.8% | 2/2 |

Within identical selected context, aggregate input spreads ranged from 43,187 to 177,022 tokens (29.8%–81.5% of the lower run). This is run-to-run variation; the two variants may still differ in effective budget/prompt policy, and order and cache state are not controlled away.

## Expanded versus same-context controls

The expanded input selection added 10,302 bytes for Task A (51,881 → 62,183) and 9,294 bytes for Task B (24,668 → 33,962). Each expanded row is compared separately with its group’s minimal and current rows. Differences are expanded minus control. The Task B Stage 1 A timeout has no numeric aggregate usage comparison.

| Group | Control | Input Δ | Input Δ % | Uncached Δ | Elapsed Δ s | Amplification Δ | Tools Δ | Expanded / control outcome |
|---|---|---:|---:|---:|---:|---:|---:|---|
| A Stage 1 | minimal | 279,749 | +128.8% | 13,765 | 48.911 | 14.06 | 4 | PASS / PASS |
| A Stage 1 | current | 102,727 | +26.1% | 8,519 | 2.604 | 1.74 | 0 | PASS / PASS |
| A Stage 2 | minimal | 273,812 | +220.8% | 4,500 | 78.712 | 14.75 | 5 | PASS / FAIL |
| A Stage 2 | current | 212,026 | +114.1% | 13,626 | 50.207 | 10.44 | 2 | PASS / PASS |
| B Stage 1 A | minimal | — | — | — | -28.684 | — | — | timeout/no Candidate / PASS |
| B Stage 1 A | current | — | — | — | -40.092 | — | — | timeout/no Candidate / PASS |
| B Stage 1 B | minimal | 25,678 | +10.5% | 34,382 | 13.007 | -5.58 | -2 | PASS / PASS |
| B Stage 1 B | current | 105,594 | +63.8% | 42,362 | 34.138 | 5.45 | 2 | PASS / PASS |
| B Stage 2 A | minimal | 23,725 | +12.5% | -15,443 | -8.570 | -3.79 | 2 | PASS / PASS |
| B Stage 2 A | current | 75,026 | +54.0% | 8,722 | 8.979 | 3.20 | 2 | PASS / PASS |
| B Stage 2 B | minimal | 103,841 | +55.2% | 8,097 | 35.089 | 4.48 | 5 | PASS / PASS |
| B Stage 2 B | current | 147,028 | +101.4% | 14,164 | 35.402 | 10.36 | 5 | PASS / PASS |

For the timeout row, elapsed is observed but its difference is descriptive only; no coder usage or amplification is inferred.

## Expanded consistency

- Aggregate input increased in 10/10 comparable pair comparisons; uncached input increased in 9/10.
- Elapsed increased in 9/10 comparable complete-usage pairs. Tool count increased in 8/10, decreased in 1/10, and was equal in 1/10.
- Expanded produced 5/6 Candidates with 5/6 PASS outcomes. Same-context controls produced 12/12 Candidates with 11/12 PASS outcomes. This does not establish an improvement in success.
- Task B Stage 1 A:expanded timed out in production; Task B Stage 2 A:expanded passed, so the timeout did not recur.

## Coder dominance and trajectory

- Across 17 complete-usage observations, coder input share was 90.0%–97.5% (median 94.1%).
- Coder input / initial coder estimate was 7.76×–32.60× (median 22.51×). The initial estimate is therefore much smaller than cumulative coder input in every complete observation.
- Normalized tools ranged 1–10. Exploratory Pearson correlation between tool count and cumulative coder input is 0.61 across 17 observations. This small, mixed-task sample does not support a causal estimate.
- Provider telemetry reports one coder turn per completed observation, even when multiple tools were used; no reduction in observed coder turn count is identifiable. Per-turn trajectory analysis is limited to one cumulative delta per observation. Tool event metadata and counts provide the more useful within-session detail in Task B.

## Task A versus Task B

- Both tasks show large total-input variation with identical selected files and bytes. Task A’s context is roughly twice Task B’s, while observed total input overlaps substantially; task content and trajectory differ, so totals should not be pooled into a context-size effect estimate.
- Task A Stage 2 minimal is a Candidate validation failure with complete usage. Task B Stage 1 A:expanded is a production `agent_timeout` with no Candidate and unavailable coder/aggregate usage. Neither is an infrastructure-invalidated observation.
- Expanded selection had higher aggregate input in every complete comparison, while the direction and size of uncached input, elapsed time, and tools varied across tasks and replicates. No expansion was granted during execution.

## Timeout interpretation

The composed Task B Stage 1 A:expanded row is genuine product behavior: production `agent_timeout`, no Candidate, no inferred coder usage, not infrastructure-invalidated, and not replacement-eligible. Its planner usage, elapsed time, and observed tools remain usable as labeled. Stage 2 A:expanded passed, weakening a deterministic interpretation that expanded selection causes timeout.

## Research conclusion and next experiment

Larger initial context can be associated with higher token cost: all ten complete expanded-versus-control comparisons show higher aggregate input. The pattern is not consistent enough here to set a production context policy, particularly with same-context input spreads and one timeout. Cumulative coder input accounts for most aggregate input, and its amplification over the initial estimate is large in every complete observation. These findings point to session trajectory and tool-loop amplification as the next research target, rather than changing context budgets now.

The existing aggregate planner/coder usage, normalized tool counts, Task B tool-event metadata, and per-turn cumulative deltas are sufficient to locate high-amplification observations. Before designing an optimization, the smallest useful added measurement is a per-tool-event snapshot of cumulative provider input immediately before and after the event (or an equivalent provider-turn breakdown), linked to tool-result bytes. Current completed records generally expose one coder turn, so they cannot attribute cumulative input growth to individual tool results. This is a measurement proposal only.

Uncertainty remains from the small number of replicates, different tasks, run order/cache state, estimated initial prompts, and the unavailable coder usage on the timed-out run. No causal claim, context ranking, or production budget change follows from this dataset.

## Reproduction and source authority

- `normalized-observations.json` contains all 18 source-linked rows; `normalized-observations.csv` is its flat export; `comparisons.json` contains pairwise calculations and counts.
- Task A Stage 1 result hashes were checked against `stage2-review.json`; composed Task B Stage 1 artifact hashes were checked against `stage1-composition.json`. Stage 2 and journal records were read without mutation.
