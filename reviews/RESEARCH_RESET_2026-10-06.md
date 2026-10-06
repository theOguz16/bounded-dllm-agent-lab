# Independent research reset — 6 October 2026

## 1. Executive summary

**Recommendation: C — build a small parallel research harness with stronger control, while retaining the existing safety and validation runtime.** Stop the current sequence of Task B prompt, navigation, and context tuning. The strongest next question is whether explicit ownership of each model request and the retained task state improves cost per independently correct change, compared with the native Codex loop.

The repository demonstrates useful governance: scoped isolated candidates, independent execution checks, durable invocation accounting, explicit approval, controlled application, and recovery. It has not demonstrated a generally cheaper or predictably bounded coding agent. Initial context is bounded; the native model trajectory and its effective conversation are only partly controlled.

“Coder amplification” is a useful symptom, but a poor central causal thesis. It divides cumulative input across internal responses by an estimated initial application prompt that excludes substantial native overhead. It can rise when the denominator shrinks, and it can fall while uncached input or correctness worsens. The project should optimize **independently correct outcomes subject to authority and resource constraints**, reporting uncached, cached, output, latency, and failures separately.

The MCP work deserves **secondary investment**. It proves ownership and reduction of an actual tool result, and offers a plausible single-response input reduction. It does not demonstrate repeated carry-forward savings, lower economic cost, or coding efficiency. Its four-run experiment used a read-only answer task; the first control had different ambient instructions. Both bounded runs used more uncached input than their paired controls.

### Audit scope and evidence integrity

Requested research HEAD: `2925d9dbef768e33754f484efa5c3c9df134f5a3`, branch `research/context-token-matrix-v1`. The starting workspace was instead clean at `1671b9626e03f0f41e0632fa88ac348d65ab6cac`, branch `glm/discovery-neighborhood-bounding`. I read the requested revision and its existing research checkout without switching either branch. Later discovery changes on the starting branch are not experimental evidence for this review.

Sources: relevant Git ancestry, canonical runtime and adapter source, frozen protocols and authority reviews, committed normalized results, persisted cell results, the separate robustness benchmark, and local Codex rollouts for the four MCP observations. All 18 primary matrix result-file SHA-256 values matched their normalized provenance records; their aggregate input fields matched the source results. Later instruction/navigation/MCP numbers were read directly from persisted results. MCP response usage sums reconcile to completed-turn usage. This is an evidence audit, not a fresh execution or full security certification: I did not rerun candidate tests, exhaustively authenticate every historical journal record, or verify every early research report against raw provider logs.

No code was changed, no live provider/model call was made, and no experiment or executable experimental plan was created. This report is the sole intended repository addition.

## 2. Current architecture

### The implemented path

1. **Task and authority.** Task intent, acceptance criteria, policy, permitted changes, validation specifications, source snapshot, provider configuration, and deadline are bound into runtime identities. Trusted host configuration supplies authority; a model proposal cannot grant itself access or approval.
2. **Repository analysis and discovery.** Canonical intelligence inventories bounded repository facts, parses TypeScript/JavaScript symbols and imports, computes dependency relationships, and identifies seed/test context. Discovery and the explicit-scope CLI lane differ: the latter starts from nominated existing files. Inventory, snapshots, dependency bounds, and content identities fail closed rather than silently admitting an incomplete repository view.
3. **Context selection.** Selected source contents, hashes, task constraints, and structured facts feed role views. The research selector substitutes initial evidence and composition budgets. Minimal/current select the same files on both matrix tasks; expanded adds dependencies and also raises the hard budget. The composition gate estimates the application context, not the full serialized native conversation.
4. **Planner.** The current Codex bridge runs a separate fresh planner thread in a temporary read-only directory. Its JSON proposal/minimality plan identifies seeds, symbols, tests, and bounded expansion obligations. Host code validates it and constructs hashes. Planner is architecturally replaceable, but the current `runBoundedTask` interface requires its provider callback; optional planning is an alternative research design, not an already measured production feature.
5. **Coder and native tools.** The bridge materializes an isolated disposable Git workspace containing authorized readable files. The coder receives full selected evidence in its prompt and can inspect materialized files again using native tools. It edits existing files directly. The SDK creates a fresh thread and calls `runStreamed` once; the CLI conducts multiple internal responses and tool actions inside that one SDK turn.
6. **Candidate generation.** Host code captures the workspace changes and derives source-bound `text-file-update/v1` claims with full replacement contents. It rejects unauthorized changed files and unsupported operations. This is different from a model emitting a trusted patch or mutation object.
7. **Verification and validation.** Deterministic gates check source identity, mutation schema, policy, allowed scope, paired-file obligations, and unsafe patterns. Candidate code is then materialized and executed through controlled validation. Build/typecheck/tests/module loading and trusted acceptance execution establish only the declared behaviors. A green build or agent self-report does not establish task success.
8. **Independent behavior oracle.** The task-specific checker is outside candidate authority. Task B checks malformed event order and a valid two-turn stream; its oracle must load the built candidate in the same controlled environment that built it. The historical host/container mismatch invalidated runs. The oracle is meaningful for event order, but its valid-stream assertion preserves final usage `9`, rather than testing aggregation of actual SDK per-turn usage. It does not certify the broader usage semantics.
9. **Approval and controlled apply.** A validated draft is not permission to modify source. Trusted candidate/handoff bindings, explicit approval, current-source checks, and a controlled executor precede real application. Separate post-apply validation, manifest checks, receipts, rollback/recovery paths protect delivery. Research cells disabled apply.
10. **Retry, repair, remask, and recovery.** There are explicit conditional repair/replan/review routes and governed import of persisted repair candidates. Provider retry needs a durable decision; ambiguous calls are not automatically replayed. This machinery is not a demonstrated automatic general repair loop. Matrix and MCP experiments used zero retry/repair/apply.
11. **Journal and telemetry.** Parent-owned SQLite invocation authority reserves calls before execution, persists bounded terminal/failure evidence, and prevents crash replay. Durable task/provider replay is distinct from the provider's prompt cache. Usage ledgers separate planner/coder/expansion stages. SDK trajectory v1/v2 observes tools and completed-turn usage; rollout response telemetry adds internal-response usage and instruction/result identities. Neither exposes provider request bodies or cache boundaries.
12. **MCP research path.** A separate read-only harness configures a repository-owned stdio `read_file` server. Path/source/representation are pinned. It changes the result before Codex consumes it, but does not replace the native shell or take ownership of the full model loop. The completed ABBA used a direct SDK client, no planner, empty initial source context, and a final JSON answer as its “Candidate.” It is not the bounded coding pipeline.
13. **Experiment infrastructure.** Calibrations, source/harness identities, ordered cells, prospective manifests, authority checks, external journals, clean-checkout preflight, replacement reviews, retained-prefix composition, and suffix/stage executors govern research consumption and preserve evidence. They improve accounting but do not control latent cache state or native request identity.

```text
Trusted task + policy + source snapshot + acceptance contract
              |
      repository analysis / scoped discovery
              |
      selected evidence -> planner -> validated minimality/context binding
              |
      isolated coder workspace + bounded application prompt
              |
      Codex native internal model/tool/conversation loop
              |
      host captures Candidate -> deterministic policy/mutation verifier
              |
      independent candidate execution + behavior oracle
              |
      draft ready / replan / repair / human review / recovery
              |
      explicit approval -> controlled apply -> independent post-apply checks

Host journal / deadlines / receipts surround execution.
Research matrices wrap selected stages; owned MCP controls one result surface.
```

### Status of the components

| Classification | Components | Meaning |
|---|---|---|
| Production-like prototype | Canonical task/policy/context bindings, mutation capture, isolated worker, verifier, controlled validation/apply/recovery, durable journal | Worth preserving; existence and fixtures do not establish production readiness |
| Research-only | Context matrices, trajectory analysis, Task B prompt/cue conditions, owned MCP representation experiment | Experimental mechanisms, not validated product policies |
| Historical/compatibility | Earlier review/PR CLI, shared semantic-workspace/masking/dLLM benchmark families, frozen evaluator/report versions | Reproducibility or compatibility surfaces; not another canonical runtime |
| Experimental scaffolding | Slot hashes, replacement and continuation authorities, preflight, stage/suffix runners, fake workers and fixtures | Admission/accounting/testing machinery; not evidence of model efficiency |

The historical semantic workspace is a motivating design. It should not be mistaken for a demonstrated replacement for native conversational state.

## 3. Research timeline

Dates below are commit dates and recorded session dates, not inferred dates of every provider operation. `n` counts observations, not independent tasks or internal model responses.

| Period / evidence | Question, intervention and control | Task/sample and correctness | Tokens / efficiency | Confounds, decision and independent assessment |
|---|---|---|---|---|
| Early lab and July release | Role views, verifier/remask, fixed/adaptive bounded context versus direct context | Initial 50-case behavior fixtures later expanded; release token evidence describes two TypeScript tasks and 18 provider calls | Reported direct/fixed/adaptive totals 2,474/1,650/1,626; configured rates yield 33.3%/34.3% normalized savings | Different model/API/task regime, toy/process measures, configured price not TCO. Historical feasibility; cannot validate current Codex efficiency. I did not reauthenticate the early raw run bundle |
| P7.7/P7.14/P7.15 and 23 Sep recovery | Isolated lifecycle, crash-safe reservations, trusted fail/pass/fail behavior triads, eligibility, reconstructed host CLI/apply | Twenty-task eligibility infrastructure is offline evidence; one recorded live paired task completes candidate, independent behavior, approval, apply, post-apply | Bounded input 51,113, cached 27,904, uncached 23,209; normal 47,733/41,984/5,749. Both satisfy the independent criterion | Safety plumbing justified; one live pair supports capability, not savings. Bounded uncached input was substantially higher. Recovery commits reconstruct functionality; they are not fresh experiments |
| 24–27 Sep hardening; source `ea6bc88e` | Bound discovery/context, fit coder context, preserve usage on stops, validation output/dependency fixes | Baseline preparation, not comparative samples | Composition became measurable and executable | Necessary readiness work; should not be counted as efficiency evidence |
| 27–28 Sep Task A matrix | Minimal/current/expanded initial selection; control is production selection | Worker request-ID task, three Stage 1 plus three Stage 2 cells; 5/6 validation PASS | 51,881 versus 62,183 bytes; input 123,994–496,891; uncached 30,900–58,619 | Minimal=current. Expanded also doubles hard budget. Fixed order, tiny n, dependencies and authority replacement history. Justifies rejecting a stable context ranking; does not isolate byte-size causality |
| 28 Sep trajectory v1 | Can SDK events localize coder input growth? Add bounded tool/turn metadata | Future cells only; no historical trajectory fabricated | Final coder usage and tools observable | Useful session accounting, insufficient per-response attribution. “One turn” is not one model call |
| 29 Sep robustness r10, separate branch evidence | Bounded workspace/planner/governance versus normal native coding | Five tasks × two arms, 10 runs: bounded 4/5 fully valid, normal 3/5; hard task stops before bounded coder | Normal input total 3,193,631 versus bounded 641,624; uncached 268,575 versus 135,512; output 29,573 versus 13,970 | Bundled treatment and one pair/task. Cheap hard failure inflates savings; normal scope failures include edits to `.bounded`. Supports a promising bounded-workspace effect and a difficulty ceiling, not stable superiority. 129 internal responses were observed despite only 10 primary runs |
| 29–30 Sep Task B matrix and recovery | Repeat context comparison on event-order parser | Six composed Stage 1 plus six Stage 2 rows: 11 PASS, one genuine timeout without Candidate | 24,668 versus 33,962 bytes; complete input 138,893–291,989; uncached 21,901–74,459 | Initial identity/path failures and an oracle host/container defect invalidated earlier evidence. Valid r7 prefix plus later suffix is a composed sequence, not uninterrupted randomization. Timeout correctly retained; next expanded run passed |
| 2 Oct combined analysis `984367ad` | Does context size or coder trajectory dominate? Offline normalize 18 rows | 16/18 PASS; one syntax failure, one timeout; 17 complete usage records | Coder input 90.0%–97.5% of total; amplification 7.76–32.60×; tools/input Pearson r≈0.61 | Expanded input higher in all ten pairwise comparisons, but only five complete expanded observations reused against two controls. Decision to inspect trajectory reasonable; declaring tool carry-forward the mechanism would exceed evidence |
| 2–4 Oct trajectory v2 validation | Are per-tool usage intervals observable? Three prospective Task B cells | 3/3 PASS | Coder input 208,472/233,330/260,212; 26 trajectory tool events, zero usable individual intervals | Only final SDK usage; normalized commands total 23, a different count. Correct conclusion: do not repeat interval-measurement runs on the same surface |
| 4 Oct inspection instruction, ABBA | One instruction to batch/read less versus unchanged prefix | Four Task B runs, all PASS | Coder input treatment/control effects −29.2%, +43.7%; tools −2, +5 | Strong control variance; planner outputs and full effective prompts not fixed. One mirrored replicate was defensible; improvement not established |
| 4 Oct mirror, BAAB | Replicate identical instruction in opposite order | Four more Task B runs, all PASS | Effects −21.5%, +83.7%; uncached +14.9%, +26.9%; tools +1, +2 | Fails its prospective promotion criteria and meets retirement criteria. Retire same-task wording work; correctness preservation alone does not make an optimization |
| 4 Oct navigation cue | 174-byte structured function/path cue versus no cue | Four Task B ABBA runs, all PASS | Coder effects −12.8%, +10.0%; uncached +39.0%, +116.1%; tools +1, +2 | Prepared versus bare analyzer identities required a separate correction. Cue answer highly task-specific; no consistent benefit. No further tuning justified |
| 4 Oct MCP feasibility/integration | Can repository own a read result before native consumption? Offline protocol plus smoke | Actual model consumption eventually demonstrated; default/instructed routing feasibility distinct from coding quality | One approved path; identity source 18,225 bytes | Local capability and actual tool-use proof are justified. Historical README “offline/not implemented” passages are stale when read as current execution status |
| 4 Oct identity/bounded ABBA | Same owned read, change only representation to edge-lines-128 | Four read-only answer runs, 4/4 exact oracle PASS; no code/build/test validation | Bounded 7,154 bytes, 60.75% smaller; input −11.7% and −6.8%; uncached +238.0% and +24.8% | First pair has ambient drift; second has matched recorded developer blocks. No repeated post-result trajectory. Supports one-step input association and controlled result construction, not economic or coding claims |
| 4–6 Oct cache/rollout forensics | What produced input/cache differences? Read existing rollouts | Four original observations, not extra replicates | Three responses per run; substantial input occurs before result; first control has larger developer instructions | Clarifies hidden overhead and cache confounding. Effective request identity is still unavailable. Reverse-engineering cache keys is not justified |
| 6 Oct response telemetry v2 `2925d9d` | Correct result-delivery recognition and phase assignment | Offline replay plus one persisted identity-only live revalidation; identity oracle PASS | Revalidation input 39,403/cached 25,856/uncached 13,547; response sums match; result before response 3 | A prior identity smoke had unavailable telemetry due to wrapped result shape. V2 recognizes direct/wrapped results and preserves old artifacts. Measurement repair is justified; no new representation comparison follows |

The progression is from safety and executable correctness to initial-context comparisons, then to a trajectory thesis, then increasingly elaborate measurement and single-task interventions. The last steps contain more evidence about integration observability than about efficient coding.

## 4. What we actually know

### Established observations

- The primary matrix has 18 provenance-linked rows with 17 complete usage records. It produced 17 Candidates and 16 validation PASS outcomes. Missing timeout usage remains missing.
- Identical selected source bytes do not imply identical cumulative input. Within matrix groups, spreads were 43,187–177,022 tokens, or 29.8%–81.5% of the smaller run.
- Larger selected context was associated with larger aggregate input in every complete expanded/control comparison. It did not improve observed success: expanded 5/6 PASS, controls 11/12.
- Coder input dominates aggregate **input volume** in completed coding cells. It does not follow that coder dominates monetary cost in the same proportions.
- All completed observed coding stages expose one SDK coder turn even when they contain many native responses/tools. Fresh SDK threads are already used; stale application threads are not an established cause.
- The inspection and navigation changes preserved the tested Task B behavior but did not yield consistent efficiency gains.
- Repository-owned MCP construction changes actual delivered text. No shell bypass or reread was recorded in the four answer-task observations.
- MCP developer instructions differed in the first control despite identical supplied-prompt hashes. Cache allocation also differed substantially.
- The safety wrapper can reduce scope failures on some tasks, while restricted context/planning can stop a harder task before generation.

### Quantified primary matrix

These are min/median/max across the 17 complete observations, not a population distribution.

| Quantity | Minimum | Median | Maximum |
|---|---:|---:|---:|
| Selected source bytes | 24,668 | 33,962 | 62,183 |
| Initial coder application estimate | 7,281 | 9,773 | 17,118 |
| Aggregate input | 123,994 | 213,919 | 496,891 |
| Coder input | 111,587 | 201,245 | 484,573 |
| Aggregate cached input | 83,968 | 172,288 | 438,272 |
| Aggregate uncached input | 21,901 | 44,526 | 74,459 |
| Aggregate output | 1,836 | 3,464 | 4,714 |
| Normalized tools | 1 | 6 | 10 |
| Observation elapsed seconds | 77.343 | 165.558 | 200.647 |
| Coder duration seconds, journal derived | 37.203 | 68.793 | 97.826 |
| Coder input / initial estimate | 7.76× | 22.51× | 32.60× |

Aggregate cache share ranges 64.1%–88.8%, median 80.6%. Task A input spans 123,994–496,891, versus uncached 30,900–58,619. Task B complete input spans 138,893–291,989, versus uncached 21,901–74,459. These contrasting spreads preclude treating total input as a cost proxy without prices.

Task A selected minimal/current context is 51,881 bytes, expanded 62,183; Task B 24,668 versus 33,962. The initial estimate includes application framing, so source bytes/4 is not the denominator used in amplification. Expansion was not granted in Task A; its request count is unavailable. Task B requests/grants are recorded as zero. This measures an initial-selection intervention, not adaptive expansion benefits. Native rereads are not runtime expansion requests.

### Later Task B interventions: all individual observations

`U` and `C` below are coder uncached/cached input. All 12 Candidates passed their declared validation and behavior checks; all used 24,668 selected source bytes.

| Session / ordered cell | Condition | Coder input | C | U | Tools | Coder s | Total s |
|---|---|---:|---:|---:|---:|---:|---:|
| Inspection A1 | control | 243,439 | 206,848 | 36,591 | 8 | 112.985 | 213.352 |
| Inspection B1 | instruction | 172,334 | 142,592 | 29,742 | 6 | 63.077 | 169.658 |
| Inspection B2 | instruction | 152,283 | 123,392 | 28,891 | 8 | 60.571 | 164.965 |
| Inspection A2 | control | 106,008 | 88,832 | 17,176 | 3 | 22.855 | 117.057 |
| Mirror B1 | instruction | 186,450 | 152,064 | 34,386 | 7 | 73.331 | 178.343 |
| Mirror A1 | control | 237,553 | 207,616 | 29,937 | 6 | 89.557 | 190.288 |
| Mirror A2 | control | 153,732 | 125,440 | 28,292 | 7 | 62.240 | 175.277 |
| Mirror B2 | instruction | 282,421 | 246,528 | 35,893 | 9 | 74.542 | 174.073 |
| Navigation A1 | control | 250,691 | 226,816 | 23,875 | 7 | 34.462 | 134.821 |
| Navigation B1 | cue | 218,522 | 185,344 | 33,178 | 8 | 67.498 | 171.286 |
| Navigation B2 | cue | 234,818 | 180,480 | 54,338 | 10 | 75.402 | 183.215 |
| Navigation A2 | control | 213,558 | 188,416 | 25,142 | 8 | 77.968 | 193.557 |

Across inspection plus mirror, control coder input ranges 106,008–243,439; treatment 152,283–282,421. Control tools 3–8, treatment 6–9. Amplification ranges approximately 14.56–33.43× control and 20.68–38.35× treatment. Opposing paired directions, overlapping ranges, and worse mirrored tool counts outweigh any favorable average from the first ABBA.

## 5. What we do not know

### Plausible hypotheses

- Repeated native request overhead and conversation replay account for substantial coder input. Response count and the MCP pre-result floor support this mechanism, but component attribution remains unavailable.
- Prompt-injected source plus materialized files encourages redundant inspection. Both channels exist in code; no isolated duplication-removal experiment demonstrates its cost or correctness effect.
- Selective workspaces reduce exploratory loops and scope errors. The five-task benchmark is consistent with this, but bundles workspace restriction, prompts, planning, and governance.
- Planner separation adds a repeated native session cost and may exclude solvable tasks. Planner input and the hard-task stop make this worth testing; neither proves that removing it helps overall.
- Tool-result selection can reduce later response input. The matched MCP pair supports a local effect; repeated carry-forward and omission-sensitive coding remain untested.

### Unsupported assumptions to remove from the narrative

- The application's hard context budget bounds actual native inference input or total token expenditure.
- An amplification ratio measures waste, or specifically measures replay of tool results.
- Tool count is a sufficient measure of exploration or model response count.
- A smaller delivered result means cheaper execution or lower uncached input.
- Full application prompt hashes establish effective request equivalence.
- Zero expansion requests establish that context was sufficient on difficult or unfamiliar tasks.
- Passing Task B generalizes to real repository coding, safety, or product reliability.
- The historical shared semantic workspace already provides the persistent semantic state proposed by the research vision.
- Durably consumed slots or plan hashes remove cache, order, ambient, or model-stochasticity confounds.

### Central amplification thesis

Let `I = Σ input_r` across internal responses and `P̂` be the estimated application prompt. Amplification is `I/P̂`. It conflates response count, native overhead, prompt replay, tool text, reasoning trajectory, and estimation error. The ratio is descriptive, not a causal intervention. Comparing ratios across different initial contexts is especially problematic: reducing `P̂` can make the ratio look worse despite lower absolute input.

Cumulative input is useful for computational exposure and accounting; it is insufficient as the sole optimization objective. A sensible report contains correctness, policy compliance, cumulative input, uncached input, cached input, output, response count, and wall time. Economic cost per successful task must include failed attempts and any repair/validation overhead. Tail behavior and timeout/no-candidate frequency matter more than a favorable pooled mean.

How much coding variance occurs before versus after tools remains unknown: original SDK trajectories do not provide that partition. MCP rollouts provide it only for a three-response read-only task. Cache can explain variation in cached/uncached allocation, not by itself the amount of total input; total input differences also reflect request/trajectory differences. Ambient drift is directly observed for MCP A1, not retrospectively quantified for all coding cells. Stochasticity is plausible but not separable from these factors. There is no evidence that tool-result carry-forward is the dominant coding contributor. Task A and the robustness tasks prevent saying the entire phenomenon is unique to Task B, but nearly all later attempted optimizations are overfit to Task B.

## 6. Strongest evidence

### Safety and task diversity

The recorded paired apply task proves a full governed path can work on a real small change. The robustness r10 observations give the best available broader warning and opportunity: four bounded successes, two normal scope violations, and a harder task solved only by normal. Bounded input savings on the four Candidate-producing pairs are potentially meaningful; the cheap bounded hard failure must never count as an efficiency win. There is only one run per arm/task, and the treatment is bundled.

### What the owned MCP experiment establishes

| Ordered slot | Result bytes | Input | Cached | Uncached | Output | Elapsed s | Oracle |
|---|---:|---:|---:|---:|---:|---:|---|
| A1 identity | 18,225 | 39,318 | 32,000 | 7,318 | 177 | 16.270 | PASS |
| B1 bounded | 7,154 | 34,719 | 9,984 | 24,735 | 172 | 11.592 | PASS |
| B2 bounded | 7,154 | 34,756 | 17,920 | 16,836 | 195 | 12.965 | PASS |
| A2 identity | 18,225 | 37,298 | 23,808 | 13,490 | 217 | 8.576 | PASS |

The transformation removed 11,071 bytes, 60.75%. It retained 128 leading and trailing lines with an omission marker. The older feasibility README describes a different default edge selection; the actual ABBA plan/result version is authoritative.

Each run had one owned MCP call, no recorded bypass, zero planner, and no source change. All answered the first and fifth `KNOWN_EVENTS` strings correctly. Required information was deliberately in retained content. This tests preservation for that answer, not ability to reason about omitted code.

### Response partition reconstructed from local rollouts

| Slot | Response 1 input | Response 2 input | Response 3 input, after result | Pre-result total | Total |
|---|---:|---:|---:|---:|---:|
| A1 | 11,604 | 11,759 | 15,955 | 23,363 | 39,318 |
| B1 | 10,907 | 11,061 | 12,751 | 21,968 | 34,719 |
| B2 | 10,907 | 11,079 | 12,770 | 21,986 | 34,756 |
| A2 | 10,905 | 11,099 | 15,294 | 22,004 | 37,298 |

The result is delivered before response 3. Approximately 59.0%–63.3% of total input occurs before delivery. A1 contains a leading developer block of 8,274 bytes; B1/B2/A2 contain 5,311 bytes with a different hash. Including the other three developer blocks, recorded ambient totals are 10,275 versus 7,312 bytes. The supplied 312-byte prompt hash is identical. This directly falsifies using that hash as full request identity.

For B1 versus A1, the input reduction is 4,599: 1,395 before delivery and 3,204 afterward. It cannot all be attributed to compaction. For B2 versus A2, the reduction is 2,542: just 18 before delivery and 2,524 afterward. Recorded ambient blocks match in this second pair, making it the stronger single-step observation.

Response-3 input minus response-2 input is 4,196/4,195 for identity and 1,690/1,691 for bounded. These differences strongly fit a local result-size effect, but also include serialization and assistant activity. They are not exact token counts of the result. There is **one** response after result delivery, so repeated carry-forward is unobserved.

### Economic interpretation

Mean bounded-minus-identity differences are input −3,570.5, cached −13,304.5, uncached **+10,381.5**, output −13.5. With uncached/cached/output token rates `p_u`, `p_c`, `p_o`, the observed mean token-price difference is:

`Δcost = 10,381.5 p_u − 13,304.5 p_c − 13.5 p_o`.

No invoice or applicable rate snapshot establishes monetary savings. Ignoring the small output difference, this sample would cost more whenever cached input costs less than approximately 78.0% of uncached input. This is a conditional calculation, not a claim about current provider prices. For subscription access, this is still not a billing estimate.

| Claim | Verdict |
|---|---|
| Tool-result construction/compaction works | Established on one approved read |
| One-step context/input reduction | Supported locally, strongest in the matched second pair |
| Repeated carry-forward reduction | Untested |
| Lower economic cost | Not demonstrated; conditional calculation can point the other way |
| Lower uncached input | Contradicted descriptively by both pairs |
| Broader agent/coding efficiency | Untested |

**Investment verdict: yes, but secondary.** Keep owned-result construction as a controlled lever in a better harness. Do not expand it into a general compaction framework based on these four answers.

## 7. Weak or misleading evidence

- **ABBA/BAAB:** improve symmetry against simple linear order drift, but do not randomize cache state, remove treatment carryover, or equalize native instructions. Mirroring strengthens the conclusion that the instruction effect is inconsistent; it does not provide a causal estimate.
- **Tiny samples:** two runs/condition cannot characterize tails or reliable success rates. Eight runs on one task are still one-task evidence.
- **Pseudo-replication:** the ten expanded/control pair comparisons reuse five complete expanded runs. “10/10” is not ten independent replications.
- **Bundled context treatment:** expanded selection changes both evidence and budget. Minimal/current equivalence means the matrix has effectively two selected-context levels, not three independent context policies.
- **Identity checks:** application prompt/source hashes prevent accidental drift in those bytes. They do not cover native system instructions, tool schemas, runtime paths, server-side identity, or cache state.
- **Cache interpretation:** uncached is correctly derived as input minus cached when both exist. A high cache rate is not proof of redundant reads; cache allocation and conversation growth are different mechanisms.
- **Correctness strength:** independent execution is substantially stronger than self-report. Task B's small oracle and coder-modifiable smoke tests do not prove comprehensive parser semantics. The read-only MCP oracle is exact but extremely narrow. Usage-semantics coverage remains a separate gap.
- **Invalidated runs:** missing pinned dependencies and the host/container oracle import defect justify exclusions. Ambiguous classification and historical replacements should remain visible in provenance and operational-cost accounting. Genuine syntax failures/timeouts cannot be replaced into successes.
- **Selection and stop bias:** composed stages and eligibility filter out many problematic tasks/environments. Report results conditional on that selection; do not use accepted-cell counts as overall success rates.
- **Preregistration:** frozen protocols and prospective stop rules are strengths. The pivot from context size to amplification and subsequent explanation of mechanisms are post-hoc hypotheses. Plan hashes bind a decision; they do not prove the decision was scientifically appropriate.
- **Telemetry semantics:** SDK completed-turn usage is per turn according to the installed contract; v1/v2 multi-turn cumulative-counter interpretation is unverified. One-turn observations used here are unaffected, but fabricated multi-turn fixtures cannot settle provider semantics.
- **Temporal labeling:** several research documents remain “not live executed” despite external run artifacts. Research status is fragmented between committed notes, external records, and a global evidence index that does not enumerate these newer experiments.

## 8. Main architectural bottlenecks

**The current integration limits experimental control, but does not prove efficient coding is impossible.** It owns task admission, selected source, workspace access, execution ceilings, and delivery. Codex owns effective request assembly, native instructions/tool schemas, internal conversation replay, response scheduling, and provider cache interaction.

Direct repository evidence for this ceiling:

- The worker creates a new native thread for every invocation, so another blanket “fresh thread” policy targets behavior already present.
- One `runStreamed` invocation can hide many internal responses. The robustness benchmark counted 129 internal model responses across 10 primary runs.
- A 312-byte MCP supplied prompt incurs approximately 10,900–11,600 input tokens on its first response. Recorded developer/runtime blocks explain some overhead; unavailable system/tool serialization prevents an exact allocation.
- The production coder serializes selected source in its prompt and provides readable copies in a workspace. Native rereads can reintroduce the same material.
- MCP allows construction of one tool result. The SDK has no repository-owned callback to submit or replace arbitrary native shell results or rewrite every next request.
- Application composition ceilings cannot enforce an exact per-response or cumulative native token ceiling. Event/command/deadline ceilings are useful but different bounds.

Neglected alternatives deserve attention in this order: explicit request/state construction; the cost and benefit of planner separation; source representation and duplication; response/tool-loop policy; semantic checkpoints with provenance and uncertainty; repository indexing that improves missing-context recall; model/API architecture choices. Thread reuse is not established as a problem. Tool-schema size, repeated native instructions, and effective system overhead are plausible but unallocated. Model choice is a major potential interaction, but changing it before request control would bundle confounds again.

A small direct model/tool loop would own serialized messages, tool schemas, approved reads, state retention, and request ceilings. It could replay identical supplied histories and vary one representation without changing native ambient instructions. Provider-side caching/stochasticity would still require separate reporting. This is a research-control argument for a parallel harness, not proof that a rewrite is necessary or that a direct API will automatically be cheaper.

## 9. Research infrastructure debt

Between pinned baseline `ea6bc88e` and requested HEAD, Git records **101 changed files, 13,695 added lines, 10 removed**. Breakdown of additions:

| Category | Files | Added lines |
|---|---:|---:|
| Runtime/integration/application changes | 10 | 1,984 |
| Research executable code and tests | 41 | 6,620 |
| Research documents/data | 38 | 3,642 |
| Research smoke tests | 11 | 1,430 |
| Package configuration | 1 | 19 |

These are source-diff counts, not a measure of hours. They show substantial research-specific surface, including roughly 1,984 lines inside runtime/integration/application areas. The journal gained matrix-specific authority; Task B condition/cue behavior reached the coder bridge. A generalized executor coexists with original live, stage2, suffix, continuation, and task-specific authority machinery. Repeated preflight/replacement fixes are visible in both history and rejected sessions.

**Is infrastructure consuming more effort than the agent problem?** The history strongly suggests it now consumes a disproportionate share of effort; no time records allow a numerical labor claim. Three v2 telemetry runs yielded zero usable per-tool intervals. Later elaborate provenance work produced mixed prompt effects and one narrow read-only compaction observation. More machinery alone is unlikely to change this information yield.

Later cleanup priorities, without deleting anything now:

- Freeze completed plans, results, replacement reviews, and historical telemetry semantics as read-only evidence.
- Archive old Task A/Task B stage/suffix executors once they are no longer live research entrypoints; keep the ability to read their records.
- Consolidate future admission into one generic experiment manifest/ledger rather than adding task-specific production authority.
- Remove inspection/navigation conditions from the active product bridge in a separate compatibility-reviewed change when retired.
- Freeze SDK interval telemetry; reuse corrected rollout metadata where needed instead of adding another version for the same unavailable boundary.
- Keep isolated execution, source/currentness bindings, trusted oracles, durable at-most-once authority, and controlled apply. These solve real governance problems.
- Keep legacy evidence readers where compatibility requires them, but quarantine legacy benchmark/product exports and eliminate duplicated writers later.
- Make one research inventory point to external artifacts and mark planned/executed/replayed status explicitly. Do not rebuild a large registry merely to achieve this.

## 10. Revised research question

**Can a host-controlled coding loop with explicit, bounded task state reduce price-weighted token expenditure and tail latency per independently correct, authorized repository change compared with a native conversational coding loop, without increasing no-candidate or correctness failures? Which part of that difference comes from request/state construction rather than initial file selection or tool-result size?**

## 11. Three ranked next directions

These are research recommendations, not executable plans or authorization to run providers.

### 1. Explicit request/state ownership versus native trajectory

**Hypothesis:** owning request assembly and retention removes substantial native overhead/replay and permits meaningful resource ceilings while preserving small-task correctness.

**Why it matters:** it addresses the structural uncertainty underlying all current amplification measurements. A negative result prevents a costly reset; a positive result identifies a controllable subsystem.

**Smallest decisive experiment:** a paired comparison on a small set of distinct, independently checked repository changes that includes dependency-following and a case where bounded planning previously stopped. Hold model identity where available, task/source, readable scope, acceptance checks, and source facts fixed. Compare the native coder with a minimal host-owned loop; report every outcome and price-weighted cached/uncached/output usage, response counts, and generation/validation latency. A deterministic request replay/control case should demonstrate what the new harness actually holds fixed before efficiency claims.

**Necessary architecture work:** a thin provider boundary, explicit request builder, allowlisted read/edit tools, canonical bounded state, request/response budget enforcement, and reuse of candidate capture/oracles. No product rewrite, general tool platform, or new apply path.

**Expected information gain:** highest; decides whether native integration is the relevant efficiency ceiling.

**Main confounds:** native model endpoint may be unavailable outside Codex, native system instruction differences, tool competence, cache rates, state omissions. If the same model is unavailable, label this an architecture-stack comparison rather than a pure loop ablation.

**Stop condition:** stop expansion if exact request control cannot be established, if correctness falls on essential tasks, or if no consistent advantage remains after including failures and price sensitivity. Do not compensate by weeks of prompt tuning.

### 2. Planner necessity and evidence sufficiency across task types

**Hypothesis:** separate model planning is useful mainly when it resolves uncertainty; deterministic selection and direct coding may suffice for explicit-scope tasks, while overly narrow planning can exclude solvable tasks.

**Why it matters:** the planner costs roughly a native session per task and the harder robustness case failed before coder invocation. This tests a neglected architectural tradeoff rather than another instruction sentence.

**Smallest decisive experiment:** compare the existing planner with a deterministic, authority-preserving selection path on a few heterogeneous tasks with validated dependency requirements, including an explicit-scope simple case and an ambiguity/dependency case. Keep the coder request/tools/model fixed. Test both success and correct refusal; missing-context cases must not be scored as cheap wins.

**Necessary architecture work:** an injectable plan/selection seam that creates the same trusted context and policy receipts without a planner model call. Reuse discovery and oracle machinery; do not broaden permissions to rescue a result.

**Expected information gain:** high; distinguishes unnecessary stage overhead from useful search/recall.

**Main confounds:** deterministic selector quality, model-generated plan content changing coder prompts, different readable scope, source/test leakage.

**Stop condition:** retain planning where removing it reduces independently correct completion or authority handling; retire it for the tested explicit-scope lane if its cost buys no observed benefit. Do not generalize a task-lane result to all tasks.

### 3. Sufficient persistent state versus raw conversational evidence

**Hypothesis:** a source-bound state representation with uncertainty and targeted retrieval can reduce repeated evidence replay without losing information needed for code changes.

**Why it matters:** it tests the historical semantic-workspace vision directly. Owned MCP is one useful result-construction mechanism, but crude edge truncation is not semantic working memory.

**Smallest decisive experiment:** in the controlled harness from direction 1, compare raw accumulated evidence with bounded structured state on tasks requiring several dependent reads and an actual code edit. Include necessary information outside the retained edges of a large file, and independently verify resulting behavior. Use the same trusted source and tools, and inspect per-response input so first-use reduction and repeated retention reduction remain distinct.

**Necessary architecture work:** a small typed state/checkpoint format with source hashes, relevant symbols, unresolved questions, and explicit retrieval fallback. Start with deterministic state construction; charge any model summary call to the treatment if later introduced.

**Expected information gain:** medium-to-high after request control; answers whether compaction helps coding rather than just easy extraction.

**Main confounds:** semantic omission, summary errors, extra retrieval, task decomposition, warm cache, changed response count.

**Stop condition:** stop compaction tuning if missing facts cause extra reads/incorrect edits or if price-weighted savings disappear after recovery and checkpoint cost. No promotion based only on byte reduction.

## 12. Experiments and research paths to retire

| Path | Recommendation and reason |
|---|---|
| Further Task B same-task repetitions | Retire as the default program. The task has already revealed variance; another small batch will not isolate causes or establish generality |
| Inspection wording optimization | Retire. Mirrored results meet the recorded stopping criteria; changing wording after seeing them invites local overfitting |
| Navigation hints on Task B | Retire. Paired effects oppose, and uncached/tools worsen in both pairs |
| Arbitrary context-size sweeps | Retire until request control and broader tasks exist. Current sweeps bundle budgets, source selection, and trajectory changes |
| More SDK per-tool interval telemetry | Stop. The live surface supplied zero usable intervals; instrumentation cannot invent intermediate usage |
| General telemetry expansion | Freeze, allowing only a concrete correctness defect repair or data required for a named decision. Corrected response telemetry is enough to motivate the reset |
| Edge-line/compaction parameter tuning | Pause. One easy answer task does not justify a production optimizer. Resume only as direction 3 with omission-sensitive code tasks |
| Cache-key reverse-engineering | Stop as a standalone research path. Keys/request bodies are unavailable; report cache effects and rate sensitivity rather than infer invisible segmentation |
| Routing/product optimization | Defer. It cannot resolve whether the underlying execution loop is controllable or efficient |
| More authority variants/preflight systems | Stop adding task-specific mechanisms. Reuse one generic admission boundary and preserve historical evidence |

## 13. Architecture recommendation

**C — build a small parallel research harness with stronger control.**

Keep the canonical governance runtime and native Codex path as the baseline. Replace neither wholesale at this stage. The new research harness should take ownership of model requests and retained state, then feed its Candidate into the existing verifier and independent checker. This isolates the subsystem under suspicion while preserving the strongest accumulated work.

A is too weak because current observations cannot attribute the mechanism targeted by the research. B would prematurely commit production to an unproven replacement. D is unjustified because isolated mutation, authority, journal, validation, and controlled apply solve independently valuable problems and have stronger evidence than the efficiency thesis.

The uncomfortable answer is therefore qualified: native integration imposes a structural ceiling on **control and causal measurement** today. It may also impose an efficiency floor, as the tiny MCP prompt demonstrates, but the repository has not proved efficiency impossible. Test that boundary before recommending a rewrite.

## 14. Concrete next milestone

The next milestone is **one reviewable decision about request ownership**, not another Task B experiment or telemetry version.

After separately authorizing implementation, produce a minimal parallel harness that can demonstrate deterministic request construction and use the existing independent validation boundary. Then obtain a small heterogeneous paired evidence set with all failures retained. The resulting decision should be one of: native integration is adequate; a host-owned loop is materially better for a defined task lane; or request control offers no benefit worth the added complexity.

Acceptance for the milestone: observable request/state identity, explicit response/tool budgets, independently validated code changes, cached/uncached/output accounting, tail and failure reporting, and no new product delivery stack. If these cannot be demonstrated, do not move on to compaction optimization.

**What the project should do next:** freeze the current Task B sequence, preserve its evidence, and investigate request/state ownership in a small parallel harness. This offers more information than another prompt or byte-budget adjustment and avoids discarding the safety runtime before its replacement has earned that decision.

## Evidence navigation

Repository sources below refer to the existing checkout at requested HEAD. External artifacts are intentionally outside the repository; their continued availability is a reproducibility dependency.

- [Canonical architecture](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/docs/ARCHITECTURE.md)
- [Product path and capability limits](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/docs/PRODUCT_PATH.md)
- [Canonical bounded task coordinator](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/packages/product-runtime/src/run-bounded-task.ts)
- [Codex planner/coder bridge](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/apps/cli/src/providers/codex-bounded-provider.ts)
- [Isolated native worker](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/packages/integrations/src/codex-agent-worker.ts)
- [Recovered paired live evidence](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/evidence/live/codex-v1-luna-planner-v2-paired.json)
- [Primary matrix source-linked rows](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/research/context-token-matrix-v1/combined-analysis/normalized-observations.json)
- [Combined analysis, compared independently here](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/research/context-token-matrix-v1/combined-analysis/REPORT.md)
- [Context protocol](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/research/context-token-matrix-v1/PROTOCOL.md)
- [Task B oracle](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/research/context-token-matrix-v1/oracles/event-order.cjs)
- [Oracle infrastructure replacement review](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/research/context-token-matrix-v1/task-b-oracle-replacement-review.json)
- [Inspection mirror stop/promotion criteria](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/research/context-token-matrix-v1/TASK_B_INSPECTION_MIRROR.md)
- [Trajectory semantics and v2 limitations](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/research/context-token-matrix-v1/TRAJECTORY.md)
- [MCP plan and actual answer task](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/research/tool-control-prototype/identity-bounded-plan.json)
- [MCP response telemetry and parser](/Users/oguzhanuyar/.codex/worktrees/context-token-matrix-task-b/bounded-dllm-agent-lab/research/tool-control-prototype/rollout-telemetry.mjs)
- [Five-task robustness report](/Users/oguzhanuyar/.bounded-agent/bounded-dllm-agent-lab/live-runs/bounded-vs-codex-robustness-v1/robustness-v1-2026-09-29-r10/REPORT.md)
- [Inspection ABBA results](/Users/oguzhanuyar/.bounded-agent/bounded-dllm-agent-lab/live-runs/context-token-matrix-v1/task-b-inspection-20261004-r1/stage2-summary.json)
- [Inspection BAAB results](/Users/oguzhanuyar/.bounded-agent/bounded-dllm-agent-lab/live-runs/context-token-matrix-v1/task-b-inspection-mirror-20261004-r2/stage2-summary.json)
- [Navigation results](/Users/oguzhanuyar/.bounded-agent/bounded-dllm-agent-lab/live-runs/context-token-matrix-v1/task-b-navigation-live-20261004-r1/stage2-summary.json)
- [MCP ABBA summary](/Users/oguzhanuyar/.bounded-agent/bounded-dllm-agent-lab/live-runs/tool-control-abba-20261004-r1/summary.json)
- [MCP usage/session identities](/Users/oguzhanuyar/.bounded-agent/bounded-dllm-agent-lab/live-runs/tool-control-abba-20261004-r1/usage-supplement.json)
- [Identity response telemetry v2 revalidation](/Users/oguzhanuyar/.bounded-agent/bounded-dllm-agent-lab/live-runs/identity-telemetry-v2-smoke-BOsEZI/observation.json)

The original MCP session IDs used for read-only rollout reconstruction are A1 `01a1087d-213d-7d41-b010-d3f149a37b61`, B1 `01a1087d-5d5f-77b3-8bee-6966f6befde5`, B2 `01a1087d-8b5b-7fe1-908c-95a431d2aa1c`, A2 `01a1087d-beb8-7390-8e41-3818791cc893`. Only usage numbers and instruction block hashes/byte counts were extracted for this report; raw prompt/source/tool content was not copied.
