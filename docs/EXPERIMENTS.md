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
- `expectedOutput`: human-readable description of the desired output type.
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

The command writes two report files under `reports/`:

- a JSON artifact for scripts and future automation,
- a Markdown table for humans, GitHub comments, and research notes.

The JSON and Markdown files come from the same `BenchmarkArtifact`, so they should always describe the same run.

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
