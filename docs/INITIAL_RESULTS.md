# Initial Results

This document records the first validated results from the bounded dLLM agent lab.
It is an interim research note, not a final paper result.

The goal of this stage was to answer a narrower question:

```text
Is the lab infrastructure clean enough to produce meaningful first measurements?
```

The current answer is yes for the base behavior suite. The results below show
that the benchmark pipeline can run without oracle leakage, that architecture
layers can be isolated through ablation, and that the Dream-Coder dLLM worker can
complete the current 50-case suite under the bounded-context orchestration.

## Experiment Context

Current benchmark suite:

- 50 deterministic cases.
- 5 benchmark families.
- 10 cases per family.

Families:

- correction override,
- sensitive boundary,
- scope drift,
- insufficient context,
- conflict resolution.

Primary measured signals:

- task success,
- scope drift,
- sensitive leakage,
- evidence coverage,
- trace completeness.

These are behavior and process metrics. They are not yet real repository patch
metrics.

## Result 1: Oracle Leakage Audit

Command:

```bash
npm run oracle:audit
```

Result:

```json
{
  "ok": true,
  "fixtureCount": 50,
  "findingCount": 0,
  "findings": []
}
```

Interpretation:

The worker refine payloads did not contain evaluator-only fields such as
`expectedResult`, `requiredTerms`, `forbiddenTerms`, or scoring metrics.

This matters because a high benchmark score is not scientifically useful if the
answer key leaks into the model input. The audit does not prove that the model is
generally capable. It proves the narrower but necessary condition that the
current benchmark requests are not contaminated by their own grading key.

## Result 2: Controlled Ablation Benchmark

Command:

```bash
npm run ablation:run
```

Observed summary:

| Mode | Task | Drift | Leakage | Evidence | Trace |
| --- | --- | --- | --- | --- | --- |
| `raw_fact_only` | 20% | 0% | 20% | 0% | 0% |
| `bounded_context` | 100% | 0% | 0% | 0% | 0% |
| `bounded_grounded` | 100% | 0% | 0% | 100% | 100% |
| `bounded_refinement` | 100% | 0% | 0% | 100% | 100% |

Interpretation:

The ablation result separates answer correctness from auditability.

The weak raw baseline performs poorly and leaks sensitive content in part of the
suite. This gives the lab a useful lower bound: simply writing the first visible
fact is not enough.

The `bounded_context` mode reaches 100% task success and 0% leakage on this base
suite, but it has 0% evidence coverage and 0% trace completeness. This is a very
important distinction. It shows that narrow context can help produce correct
answers, but correct answers alone are not enough for a reliable agentic system.

The `bounded_grounded` mode keeps the task result while adding evidence and trace
coverage. This supports the architecture claim that grounding and verifier trace
turn a correct answer into an auditable answer.

The `bounded_refinement` mode does not improve over `bounded_grounded` on the
current base suite. This is not a failure. It suggests that the current suite is
too easy to reveal the value of verifier-guided remasking. Harder cases are
needed to test whether refinement helps after partial failure.

## Result 3: Dream-Coder dLLM Worker Base Benchmark

Runtime:

- RunPod GPU pod.
- RTX 3090 24GB VRAM.
- Dream-Coder worker.
- Model: `Dream-org/Dream-Coder-v0-Instruct-7B`.
- Worker route: `http://127.0.0.1:8765`.

Command:

```bash
npm run worker:full-benchmark
```

Reported artifact paths:

```text
reports/2026-06-19T14-24-30-866Z-worker-full-benchmark.json
reports/2026-06-19T14-24-30-866Z-worker-full-benchmark.md
reports/2026-06-19T14-24-30-866Z-worker-full-benchmark.manifest.json
```

Observed summary:

| Metric | Value |
| --- | --- |
| Scenario count | 50 |
| Task success rate | 100% |
| Scope drift rate | 0% |
| Sensitive leakage rate | 0% |
| Evidence coverage | 100% |
| Trace completeness rate | 100% |

Interpretation:

The real Dream-Coder dLLM worker completed the base 50-case benchmark under the
bounded-context, grounding, and shared-workspace orchestration. On this suite it
produced scope-safe, leakage-free, evidence-backed, and traceable outputs.

The correct reading is:

```text
Dream-Coder + bounded orchestration passed the current base behavior suite.
```

The incorrect reading would be:

```text
dLLMs are now proven better than LLMs.
```

That stronger claim is not supported yet because no real autoregressive LLM
baseline has been run on the same suite, and the current suite is controlled and
relatively simple.

## What These Results Show

These initial results support four early findings:

1. The benchmark input pipeline can avoid answer-key leakage.
2. Bounded context can strongly improve controlled behavior metrics.
3. Grounding and verifier trace are necessary for auditability, even when task
   success is already high.
4. The current base suite is not hard enough to expose the value of refinement
   beyond single-pass grounded output.

This is useful because it clarifies the research direction. The project is not
only testing whether a model can answer correctly. It is testing whether an
agentic architecture can answer correctly while staying scoped, avoiding leakage,
and leaving a trace that a human or evaluator can inspect.

## What These Results Do Not Show Yet

These results do not yet prove:

- that dLLMs outperform autoregressive LLMs,
- that the architecture works on real code patches,
- that the current benchmark is difficult enough,
- that keyword-based scoring catches every semantic failure,
- that refinement adds value under hard failure conditions,
- that the system is ready for production use.

The current result is best described as base-suite validation.

## Threats To Validity

The main risks are:

- The 50-case benchmark is controlled and may be too easy.
- Deterministic scoring may miss semantically wrong but keyword-matching outputs.
- The Dream-Coder worker includes orchestration support around grounding and
  boundary behavior, so the result measures the system, not the raw model alone.
- The ablation modes are controlled architecture simulations, not independent
  real model baselines.
- There is no latency, cost, or throughput analysis yet.
- There is no real repository patch benchmark yet.

These limitations are expected at this stage. They define the next experiments.

## Next Research Phase

The next phase should make the benchmark harder and add real baselines.

Planned steps:

1. Add a hard benchmark suite with misleading scope, partial evidence, multi-fact
   conflict, sensitive-summary tension, and remasking-required cases.
2. Run hard ablation to test whether refinement adds value beyond grounding.
3. Add an autoregressive LLM baseline on the same fixtures.
4. Add a real repository patch benchmark with allowed files, forbidden files,
   expected diffs, and test outcomes.
5. Add latency and cost measurement for each architecture.

The current milestone is therefore not the end of the research. It is the point
where the lab becomes credible enough to run harder experiments.

## Update: Hard Suite Added

The first hard behavior suite has been added after the base-suite validation.

Current hard suite:

- 25 deterministic cases.
- 5 hard cases per benchmark family.
- Distractor facts, partial evidence, tempting adjacent scope, sensitive-summary
  tension, and three-way conflicts.

Initial controlled hard ablation:

| Mode | Task | Drift | Leakage | Evidence | Trace |
| --- | --- | --- | --- | --- | --- |
| `raw_fact_only` | 20% | 0% | 20% | 0% | 0% |
| `bounded_context` | 100% | 0% | 0% | 0% | 0% |
| `bounded_grounded` | 100% | 0% | 0% | 100% | 100% |
| `bounded_refinement` | 100% | 0% | 0% | 100% | 100% |

Interpretation:

The hard suite is now available, deterministic, and covered by oracle leakage
audit. In the controlled ablation runner, the same architectural pattern remains:
raw fact selection is weak, bounded context improves task success, and grounding
adds auditability.

However, the current hard suite still does not expose a measurable advantage for
the refinement loop over single-pass grounding. This is an important limitation,
not a result to hide. The next hard-suite iteration should include cases where a
first pass can fail, verifier feedback marks a specific region, and remasking
that region changes the final score. That is the condition needed to test the
specific value of dLLM-style refinement rather than only bounded selection.
