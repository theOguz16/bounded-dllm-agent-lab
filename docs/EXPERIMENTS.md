# Experiments

## Canonical Benchmark Fixture Schema

Every benchmark case in this project should be easy to compare across different architectures.

That is why each fixture has two parts:

```text
BenchmarkFixture
  -> packet: what the system receives
  -> case: how the evaluator judges the output
```

The important learning point is this:

```text
The packet is the input.
The case is the grading key.
```

If we mix those two ideas, the benchmark becomes unfair. A model should not see the grading key. It should only see the bounded context packet.

### BenchmarkFixture

Top-level fields:

- `id`: unique fixture id.
- `family`: experiment family such as correction override or scope drift.
- `learningGoal`: one-sentence explanation for students and contributors.
- `packet`: the bounded context packet sent to the system.
- `case`: the evaluator oracle used after the system produces output.

### BoundedContextPacket

The packet defines the controlled input.

Fields:

- `id`: unique packet id.
- `task`: what the user is asking.
- `goal`: what success means in plain language.
- `allowedScope`: regions the agent may use or touch.
- `forbiddenScope`: regions the agent must avoid.
- `facts`: current, stale, correction, sensitive, or uncertain context facts.
- `mustNotInfer`: facts the agent must not invent.
- `responseContract`: human-readable description of the allowed response shape.
- `contextBudgetTokens`: deterministic context budget for comparison.

This is where the project tests narrow context. Instead of sending every possible file and memory, the fixture sends a small but meaningful packet.

### ContextFact

Each fact has:

- `id`: unique fact id.
- `kind`: `current`, `stale`, `correction`, `sensitive`, or `uncertain`.
- `content`: the actual fact.
- `evidenceId`: where the fact came from.
- `confidence`: confidence from 0 to 1.

The fact kind matters because the agent must learn boundaries:

- `current` should usually be trusted.
- `correction` should usually override stale information.
- `stale` should usually be rejected.
- `sensitive` should usually stay out of generated output.
- `uncertain` should push the agent toward a careful boundary decision.

### BenchmarkCase

The case defines how the output is graded.

Fields:

- `id`: unique case id.
- `family`: experiment family.
- `title`: short human-readable title.
- `description`: what the case is testing.
- `requiredTerms`: terms that must appear in generated output.
- `forbiddenTerms`: terms that must not appear in generated output.
- `expectedEvidenceIds`: evidence ids that should appear in the generated trace.
- `expectedBoundary`: optional boundary decision such as `insufficient_context`.
- `expectedResult`: exact expected result signal.

This is intentionally simple for the first milestone. We want deterministic scoring before using more subjective judge models.

### Oracle Leakage Audit

The evaluator is allowed to know `expectedResult`, `requiredTerms`, `forbiddenTerms`, and scoring metrics.
The worker is not.

This distinction is important because a high benchmark score is meaningful only
when the model did not receive the grading key. The project therefore includes an
oracle leakage audit:

```bash
npm run build
npm run oracle:audit
```

The audit constructs the same worker refine requests used by the benchmark and
checks whether evaluator-only keys or answer-key text appear outside legitimate
evidence fields. Fact content, task text, scope rules, and `mustNotInfer` are
allowed because they are part of the bounded context packet. Fields such as
`expectedResult`, `requiredTerms`, `forbiddenTerms`, and metric names are not
allowed because they belong to the grader.

This does not prove that a model is generally intelligent. It proves a narrower,
but necessary, condition: the benchmark input was not contaminated by its own
answer key.

### Ablation Benchmark

After oracle leakage is clean, the next question is not only whether the system
passes. The more important research question is which architecture layer caused
the improvement.

Run the controlled ablation benchmark with:

```bash
npm run build
npm run ablation:run
```

The ablation runner executes the same 50 fixtures under several controlled modes:

- `raw_fact_only`: weak baseline that writes the first visible fact.
- `bounded_context`: uses bounded packet selection and boundary decisions.
- `bounded_grounded`: adds evidence claims and verifier trace.
- `bounded_refinement`: runs the bounded grounded behavior through the refinement loop.

This benchmark is not a real model leaderboard. It is an architecture isolation
tool. It helps answer questions such as:

- Did narrow context alone improve task success?
- Did grounding improve evidence coverage and trace completeness?
- Did boundary logic reduce sensitive leakage and insufficient-context guessing?
- Did refinement add value beyond single-pass grounded output?

The output includes one benchmark report per mode and one comparison table. If a
mode improves task success but has weak evidence or trace metrics, that is useful
information: it means the architecture may answer correctly but still be hard to
audit.

The ablation runner also writes an analysis artifact beside the comparison
table. The analysis highlights metric deltas and warnings such as:

- task success improved but evidence did not,
- grounding improved traceability without changing task success,
- refinement did not improve over grounded output in the current suite.

### Hard Benchmark Suite

The base suite checks whether the lab can measure core behaviors under controlled
conditions. The hard suite checks whether those behaviors survive more adversarial
bounded-context packets.

Run the hard single-mode benchmark with:

```bash
npm run build
npm run hard:benchmark
```

Run the hard ablation comparison with:

```bash
npm run build
npm run hard:ablation
```

The hard suite currently contains 25 deterministic cases:

- 5 hard correction override cases with distractor facts.
- 5 hard sensitive boundary cases where a useful summary is requested but raw
  secrets must stay hidden.
- 5 hard scope drift cases with tempting adjacent work.
- 5 hard insufficient-context cases with partial evidence that is not enough to
  answer the exact question.
- 5 hard conflict-resolution cases with stale, uncertain, and current facts.

The hard suite is intentionally still deterministic. Its purpose is not random
stress testing. Its purpose is to isolate failure modes that the base suite may
hide: distractor selection, overconfident inference from partial evidence,
scope temptation, sensitive-summary tension, and three-way conflict handling.

This suite is still not a real code patch benchmark. It is the bridge between
base behavior validation and future repository-level patch experiments.

### Remask-Required Benchmark

The base and hard suites can show that bounded context and grounding work, but
they do not isolate the value of verifier-guided remasking. The remask-required
benchmark is a controlled recovery test for that specific mechanism.

Run it with:

```bash
npm run build
npm run remask:benchmark
```

It compares two controlled modes:

- `single_pass_stale`: writes the stale first-pass result and stops.
- `remask_recovery`: lets the verifier fail `final_result`, remasks that region,
  and then writes the corrected result on the second pass.

This benchmark is not a real model leaderboard. It is a mechanism test. It asks:

```text
Can targeted remasking change a failed final_result into a verified corrected result?
```

### Autoregressive LLM Hard Baseline

After the dLLM worker passes the base and hard behavior suites, the next fair
comparison is an autoregressive LLM baseline on the same fixtures.

Start an OpenAI-compatible chat-completions endpoint worker with:

```bash
npm run build
LLM_API_BASE_URL=http://127.0.0.1:8000/v1 \
LLM_API_KEY=optional-key \
LLM_MODEL=your-model-name \
npm run worker:llm-openai
```

Then run the hard baseline from another terminal:

```bash
npm run worker:llm-hard-benchmark
```

The worker expects an endpoint compatible with:

```text
POST /chat/completions
```

This can be a hosted API, a local vLLM server, an OpenAI-compatible router, or a
small local model server. The important rule is that the same fixture packet is
sent and the evaluator oracle is not sent.

The LLM baseline worker intentionally does not canonicalize the final answer to
the best fact after generation. It asks the model for a JSON decision and writes
the model's `finalResult`, `boundaryStatus`, and `evidenceIds` into the shared
workspace. This makes the baseline more honest: if the autoregressive model
chooses stale evidence, leaks sensitive content, or omits evidence ids, the
normal benchmark metrics should show it.

### Why Evidence IDs Matter

The benchmark should not only ask whether the final answer is right. It should also ask whether the system left a trace.

Example:

```text
Answer: The backend will be TypeScript Fastify.
Evidence id: memory-correction.
```

If the answer is right but the evidence is missing, the system may still be hard to audit. This is why issue #2 adds `expectedEvidenceIds`.

## Experiment 1: Correction Override

Goal:

Measure whether a system prefers corrected facts over stale facts.

Input:

- one stale fact,
- one correction,
- one question.

Output:

- resolved fact,
- stale fact rejected flag,
- evidence ids.

Metric:

- correction override accuracy.

## Experiment 2: Sensitive Boundary

Goal:

Measure whether a system avoids leaking sensitive memory.

Input:

- one sensitive memory,
- one unrelated project question.

Output:

- answer or decision,
- sensitive leakage flag.

Metric:

- sensitive leakage rate.

## Experiment 3: Scope Drift

Goal:

Measure whether a system respects allowed and forbidden scope.

Input:

- task,
- allowed regions,
- forbidden regions.

Output:

- action plan,
- touched regions.

Metric:

- scope drift rate.

## Experiment 4: Insufficient Context

Goal:

Measure whether a system refuses to infer when required information is absent.

Input:

- question,
- context packet with missing fact.

Output:

- boundary decision.

Metric:

- insufficient context accuracy.

## Experiment 5: Conflict Resolution

Goal:

Measure whether a system resolves contradictory facts with evidence and task relevance.

Input:

- two conflicting claims,
- evidence ids,
- current task.

Output:

- selected claim,
- rejected claim,
- reason.

Metric:

- conflict resolution accuracy.

## Current Demo Fixtures

Issue #3 expands the benchmark to 50 deterministic cases:

- 10 correction override cases,
- 10 sensitive boundary cases,
- 10 scope drift cases,
- 10 insufficient context cases,
- 10 conflict resolution cases.

The first fixture in each family is still small enough to inspect by hand:

1. `correction-override-001`
   Tests whether TypeScript Fastify beats an older Python Flask fact.

2. `sensitive-boundary-001`
   Tests whether a raw token stays out of generated output.

3. `scope-drift-001`
   Tests whether the system stays inside a billing test assertion task.

4. `insufficient-context-001`
   Tests whether the system says `insufficient_context` instead of inventing a server IP.

5. `conflict-resolution-001`
   Tests whether the system resolves a local-only assumption in favor of a GPU dLLM worker decision.

The fixture file uses compact spec lists and builder functions. This keeps the dataset readable while still producing enough cases to detect patterns.

You can run the current demo with:

```bash
npm run build
npm run eval:demo
```

Issue #12 adds architecture selection:

```bash
npm run eval:demo -- --architecture bounded-dllm-refinement-loop
npm run eval:demo -- --architecture long-context-llm-mock
npm run eval:demo -- --architecture rag-llm-mock
npm run eval:demo -- --architecture synthetic-context-llm-mock
```

The placeholder baselines are deterministic mocks. They do not claim real model
quality. Their purpose is to make every future architecture use the same
fixture, workspace, scoring, report, and manifest path.

Issue #18 adds ablation settings. The first practical ablation is refinement
attempt count:

```bash
npm run eval:demo -- --max-attempts 1
npm run eval:demo -- --max-attempts 2
```

The manifest also records whether mask policy, verifier, and synthetic context
are enabled. In the current mock lab these flags mostly document the condition;
future real runners can attach behavior to the same config without changing the
report format.

The command writes two report files under `reports/`:

- a JSON artifact for scripts and future automation,
- a Markdown table for humans, GitHub comments, and research notes.

The JSON and Markdown files come from the same `BenchmarkArtifact`, so they should always describe the same run.

Issue #17 adds a family breakdown table to each report. This matters because a
single global average can hide architecture weaknesses. A system can be strong
on correction override but weak on sensitive boundary, or strong on insufficient
context but weak on scope drift.

Issue #11 adds a third file beside those reports:

- a `.manifest.json` file for experiment conditions.

The manifest is not another score report. It records how the score was produced:

- `runId`,
- `suiteName`,
- `architectureName`,
- `engineName`,
- `modelName`,
- `modelVersion`,
- `workerUrl`,
- `seed`,
- `maxAttempts`,
- `maskPolicyVersion`,
- `gitCommit`,
- `hardware`,
- `createdAt`,
- `reportPaths`,
- summary metrics.

This distinction matters for research reliability. The JSON/Markdown report says
what happened. The manifest says under which conditions it happened.

## Comparing Runs

Issue #15 adds a comparison command:

```bash
npm run build
npm run reports:compare
```

The command scans `reports/*.manifest.json` and writes:

- `reports/comparison-index.json`,
- `reports/comparison-index.md`.

This comparison artifact lets us read architecture-level results side by side
instead of opening each run report manually.

## Failure Review

Issue #16 adds a human review rubric in `docs/FAILURE_REVIEW.md`.

Human review is used only when deterministic metrics are not expressive enough
to explain a semantic failure. It complements benchmark metrics; it does not
replace them.
