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
complete the current base and hard suites under the bounded-context orchestration.

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

After the hard and remask suites were added, the audit covered 80 fixtures:

```json
{
  "ok": true,
  "fixtureCount": 80,
  "findingCount": 0,
  "findings": []
}
```

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

## Result 4: Dream-Coder dLLM Worker Hard Benchmark

Command:

```bash
npm run worker:hard-benchmark
```

Reported artifact paths:

```text
reports/2026-06-19T14-56-23-942Z-worker-hard-benchmark.json
reports/2026-06-19T14-56-23-942Z-worker-hard-benchmark.md
reports/2026-06-19T14-56-23-942Z-worker-hard-benchmark.manifest.json
```

Observed summary:

| Metric | Value |
| --- | --- |
| Scenario count | 25 |
| Task success rate | 100% |
| Scope drift rate | 0% |
| Sensitive leakage rate | 0% |
| Evidence coverage | 100% |
| Trace completeness rate | 100% |

Interpretation:

The Dream-Coder worker also completed the 25-case hard behavior suite. This is a
stronger base validation than the first 50-case suite because the hard cases add
distractors, partial evidence, tempting scope, sensitive-summary tension, and
three-way conflicts.

The correct reading is:

```text
Dream-Coder + bounded orchestration passed both base and hard behavior suites.
```

The incorrect reading is still:

```text
dLLMs are proven better than autoregressive LLMs.
```

The hard worker result strengthens the architecture validation, but it does not
replace a real LLM baseline or a real repository patch benchmark.

## Result 5: Controlled Remask-Required Benchmark

Command:

```bash
npm run remask:benchmark
```

Reported artifact paths:

```text
reports/2026-06-19T15-10-01-948Z-remask-comparison.json
reports/2026-06-19T15-10-01-948Z-remask-comparison.md
```

Observed summary:

| Mode | Task | Evidence | Trace |
| --- | --- | --- | --- |
| `single_pass_stale` | 0% | 0% | 0% |
| `remask_recovery` | 100% | 100% | 100% |

Interpretation:

This controlled benchmark isolates the value of targeted remasking. The
single-pass mode writes a stale `final_result` and stops. The recovery mode lets
the verifier mark `final_result` as failed, remasks that region, removes the
stale claim for that region, and writes the corrected result on the second pass.

This is the first suite in the lab that directly tests a refinement-loop
mechanism rather than only bounded context selection or evidence grounding.

The result does not prove that a real dLLM will always recover correctly. It
does show that the lab can now measure the specific condition needed for dLLM
style refinement:

```text
failed region -> targeted remask -> corrected region replacement
```

## Result 6: Qwen2.5-Coder 7B GGUF Autoregressive LLM Hard Baseline

Runtime:

- RunPod GPU pod.
- RTX 3090 24GB VRAM.
- llama.cpp OpenAI-compatible server.
- Model repo: `Qwen/Qwen2.5-Coder-7B-Instruct-GGUF`.
- Model file: `qwen2.5-coder-7b-instruct-q4_k_m.gguf`.
- Model parameters reported by llama.cpp: `7,615,616,512`.
- Quantization: `Q4_K_M`.
- llama.cpp route: `http://127.0.0.1:8000/v1`.
- Lab LLM worker route: `http://127.0.0.1:8775`.

Command:

```bash
npm run worker:llm-hard-benchmark
```

Reported artifact paths:

```text
reports/2026-06-19T16-11-03-087Z-llm-hard-baseline.json
reports/2026-06-19T16-11-03-087Z-llm-hard-baseline.md
reports/2026-06-19T16-11-03-087Z-llm-hard-baseline.manifest.json
```

The run was repeated after model metadata and failure taxonomy reporting were
added:

```text
reports/2026-06-19T16-23-38-717Z-llm-hard-baseline.json
reports/2026-06-19T16-23-38-717Z-llm-hard-baseline.md
reports/2026-06-19T16-23-38-717Z-llm-hard-baseline.manifest.json
```

The repeated run kept the same summary metrics and recorded the model name as
`qwen2.5-coder-7b-instruct-q4_k_m`.

Observed summary:

| Metric | Value |
| --- | --- |
| Scenario count | 25 |
| Task success rate | 64% |
| Scope drift rate | 0% |
| Sensitive leakage rate | 0% |
| Evidence coverage | 96% |
| Trace completeness rate | 96% |

Interpretation:

This is the first real autoregressive LLM baseline in the lab. The same hard
fixture family was used, and evaluator-only oracle fields were not sent to the
model.

The useful reading is:

```text
On this bounded hard behavior suite, Dream-Coder dLLM worker scored higher than
the Qwen2.5-Coder 7B GGUF autoregressive LLM baseline on task success.
```

The careful limitation is:

```text
This does not prove that dLLMs are generally better than autoregressive LLMs.
```

Several details matter for scientific interpretation:

- The LLM baseline used a quantized GGUF model, not the full precision checkpoint.
- The LLM baseline was forced through the same bounded JSON decision contract.
- The LLM baseline still achieved 0% scope drift and 0% sensitive leakage, which
  means the worker protocol helped keep the run safe even when task success was
  lower.
- Evidence and trace were high at 96%, but task success was only 64%. This is a
  valuable failure shape: the model often left an auditable process trace, yet
  still selected or summarized the wrong final result in part of the hard suite.
- Failure taxonomy shows that several failed cases were semantically close, so
  strict task success should be interpreted together with failure type, not alone.

This result moves the project from infrastructure validation into comparative
model-family testing.

### Strict vs Taxonomy-Adjusted Interpretation

The official benchmark score remains strict:

```text
Strict task success: 16 / 25 = 64%
```

After failure taxonomy was added, the 9 failed cases were separated into failure
types:

| Failure type | Count | Interpretation |
| --- | ---: | --- |
| `semantic_match_but_keyword_fail` | 3 | The final answer was close to the expected result, but missed exact required wording. |
| `true_task_failure` | 5 | The final answer was not close enough to the expected result under the deterministic heuristic. |
| `missing_evidence_or_trace` | 1 | The answer was near the target, but evidence or trace was incomplete. |
| `leakage_or_scope_violation` | 0 | No failed case was caused by sensitive leakage or scope violation. |
| `boundary_failure` | 0 | No failed case was caused by an incorrect boundary decision. |

This gives a more careful reading:

```text
Strict score: 64%.
Likely semantic-adjusted interpretation: up to 19 / 25 = 76%.
```

The 76% number is not a replacement benchmark score. It is an analysis note. It
means that some failures look like deterministic wording mismatches rather than
clear model failures.

The most important research signal is therefore not only that Qwen2.5-Coder
scored lower than the Dream-Coder worker. It is that the lower score came mostly
from canonical answer alignment and sensitive-boundary wording, not from leakage,
scope drift, or boundary collapse.

This distinction matters because a production agent architecture needs both:

- strict measurable correctness,
- and diagnostic tools that explain why correctness failed.

## Result 7: Qwen2.5-Coder 7B GGUF RAG-Style Hard Baseline

Command:

```bash
npm run worker:llm-rag-hard-benchmark
```

Purpose:

This baseline keeps the same Qwen2.5-Coder 7B GGUF model and the same
OpenAI-compatible LLM worker, but changes the context strategy from plain bounded
packet to RAG-style bounded packet plus deterministic retrieved facts.

The research question is:

```text
Does adding retrieved context improve the same autoregressive LLM, or does it
introduce distractors that reduce bounded reasoning quality?
```

Reported artifact paths:

```text
reports/2026-06-19T16-33-57-564Z-llm-rag-hard-baseline.json
reports/2026-06-19T16-33-57-564Z-llm-rag-hard-baseline.md
reports/2026-06-19T16-33-57-564Z-llm-rag-hard-baseline.manifest.json
```

Observed summary:

| Metric | Plain Qwen2.5 | RAG-style Qwen2.5 |
| --- | ---: | ---: |
| Task success rate | 64% | 68% |
| Scope drift rate | 0% | 0% |
| Sensitive leakage rate | 0% | 0% |
| Evidence coverage | 96% | 84% |
| Trace completeness rate | 96% | 84% |

Interpretation:

The RAG-style baseline slightly improved strict task success, but reduced
evidence coverage and trace completeness. This is a useful trade-off rather than
a simple win or loss.

The short reading is:

```text
RAG-style context helped some final decisions but made the process less cleanly
auditable.
```

Failure taxonomy shows the shape of that trade-off:

| Failure type | Plain Qwen2.5 | RAG-style Qwen2.5 | Interpretation |
| --- | ---: | ---: | --- |
| `semantic_match_but_keyword_fail` | 3 | 2 | RAG reduced some exact wording misses. |
| `true_task_failure` | 5 | 2 | RAG reduced clear task failures. |
| `missing_evidence_or_trace` | 1 | 4 | RAG increased auditability gaps. |
| `leakage_or_scope_violation` | 0 | 0 | RAG did not cause raw leakage or forbidden scope hits in this run. |
| `boundary_failure` | 0 | 0 | RAG did not break boundary decisions in this run. |

Several RAG sensitive-boundary failures mixed multiple retrieved summaries into
one final answer. For example, credential policy, repository access, and
deployment access appeared together in a single answer. This was not raw secret
leakage, but it suggests retrieval context mixing:

```text
More retrieved context can reduce task failures while making answers less
focused and less trace-clean.
```

This supports the project's broader motivation: context quantity is not enough.
The architecture must also control what context is allowed to influence a
specific region of the workspace.

## Result 8: Qwen2.5-Coder 7B GGUF Expanded-Context Hard Baseline

Command:

```bash
npm run worker:llm-expanded-hard-benchmark
```

Purpose:

This baseline keeps the same Qwen2.5-Coder 7B GGUF model and the same
OpenAI-compatible LLM worker, but changes the context strategy from selected
retrieval to a broader memory slice. It intentionally adds more facts from
multiple hard-suite families.

The research question is:

```text
Does wider context improve the same autoregressive LLM, or does it introduce
more distractor pressure and context mixing than the RAG-style baseline?
```

Reported artifact paths:

```text
reports/2026-06-19T16-44-37-202Z-llm-expanded-hard-baseline.json
reports/2026-06-19T16-44-37-202Z-llm-expanded-hard-baseline.md
reports/2026-06-19T16-44-37-202Z-llm-expanded-hard-baseline.manifest.json
```

Observed summary:

| Metric | Plain Qwen2.5 | RAG-style Qwen2.5 | Expanded Qwen2.5 |
| --- | ---: | ---: | ---: |
| Task success rate | 64% | 68% | 80% |
| Scope drift rate | 0% | 0% | 0% |
| Sensitive leakage rate | 0% | 0% | 0% |
| Evidence coverage | 96% | 84% | 52% |
| Trace completeness rate | 96% | 84% | 52% |

Interpretation:

Expanded context produced the highest strict task success among the Qwen2.5
baselines, but it also produced the weakest evidence and trace coverage.

The short reading is:

```text
Wider context improved final answer selection, but weakened auditability.
```

Failure taxonomy showed five failures, all categorized as
`missing_evidence_or_trace`. There were no `true_task_failure`,
`semantic_match_but_keyword_fail`, `leakage_or_scope_violation`, or
`boundary_failure` failures.

This is a strong trade-off signal:

```text
More context can help the model answer, but it can also make the answer less
trace-clean and harder to audit.
```

This result supports the core research motivation. Long or broad context alone
is not enough for reliable agentic coding. A useful architecture must preserve
evidence selection, trace quality, and region-specific scope even when more
context is available.

## Result 9: Qwen2.5-Coder 7B GGUF Synthetic-Context Hard Baseline

Command:

```bash
npm run worker:llm-synthetic-hard-benchmark
```

Purpose:

This baseline keeps the same Qwen2.5-Coder 7B GGUF model and the same
OpenAI-compatible LLM worker, but changes the context strategy from more context
to structured synthetic context. It adds a compact synthetic evidence plan
derived only from packet facts, fact kinds, evidence ids, scope rules, and
`mustNotInfer`.

The research question is:

```text
Can narrow bounded context plus synthetic structure improve task success while
preserving evidence and trace better than broad expanded context?
```

Reported artifact paths:

```text
reports/2026-06-19T16-49-55-970Z-llm-synthetic-hard-baseline.json
reports/2026-06-19T16-49-55-970Z-llm-synthetic-hard-baseline.md
reports/2026-06-19T16-49-55-970Z-llm-synthetic-hard-baseline.manifest.json
```

Observed summary:

| Metric | Plain Qwen2.5 | RAG-style Qwen2.5 | Expanded Qwen2.5 | Synthetic Qwen2.5 |
| --- | ---: | ---: | ---: | ---: |
| Task success rate | 64% | 68% | 80% | 68% |
| Scope drift rate | 0% | 0% | 0% | 0% |
| Sensitive leakage rate | 0% | 0% | 0% | 0% |
| Evidence coverage | 96% | 84% | 52% | 96% |
| Trace completeness rate | 96% | 84% | 52% | 96% |

Interpretation:

Synthetic context matched the RAG-style task success improvement while
preserving the same evidence and trace coverage as the plain bounded baseline.

The short reading is:

```text
Synthetic context gave a small task-success gain without the auditability loss
seen in RAG-style and expanded-context runs.
```

Failure taxonomy showed eight failures:

| Failure type | Count | Interpretation |
| --- | ---: | --- |
| `semantic_match_but_keyword_fail` | 4 | Several failures were close to the expected answer but missed exact wording. |
| `true_task_failure` | 4 | Several failures remained real task-alignment problems. |
| `missing_evidence_or_trace` | 0 | Synthetic context did not create trace or evidence gaps in this run. |
| `leakage_or_scope_violation` | 0 | Synthetic context did not cause raw leakage or forbidden scope hits. |
| `boundary_failure` | 0 | Synthetic context did not break boundary decisions. |

This is the most balanced Qwen2.5 context strategy result so far:

```text
Plain: strong auditability, weaker task success.
RAG: slightly better task success, weaker auditability.
Expanded: strongest task success, weakest auditability.
Synthetic: RAG-level task success, plain-level auditability.
```

This does not prove that synthetic context is always superior. It does support a
narrower and more useful claim:

```text
Structured synthetic context can improve bounded LLM behavior without simply
increasing context size.
```

## Result 10: LLM Context Strategy Comparison Report

Command:

```bash
npm run reports:llm-context
```

Reported artifact paths:

```text
reports/2026-06-19T17-13-22-998Z-llm-context-comparison.json
reports/2026-06-19T17-13-22-998Z-llm-context-comparison.md
```

Observed summary:

| Run | Task | Drift | Leakage | Evidence | Trace | Budget Used |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dream-Coder dLLM bounded | 100% | 0% | 0% | 100% | 100% | 28.1% |
| Qwen2.5 plain bounded | 64% | 0% | 0% | 96% | 96% | 28.1% |
| Qwen2.5 RAG-style | 68% | 0% | 0% | 84% | 84% | 40.6% |
| Qwen2.5 expanded-context | 80% | 0% | 0% | 52% | 52% | 50.3% |
| Qwen2.5 synthetic-context | 68% | 0% | 0% | 96% | 96% | 39.6% |

Failure taxonomy summary:

| Run | Semantic Keyword | True Task | Evidence/Trace Gap | Boundary | Leakage/Scope |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dream-Coder dLLM bounded | 0 | 0 | 0 | 0 | 0 |
| Qwen2.5 plain bounded | 3 | 5 | 1 | 0 | 0 |
| Qwen2.5 RAG-style | 2 | 2 | 4 | 0 | 0 |
| Qwen2.5 expanded-context | 0 | 0 | 5 | 0 | 0 |
| Qwen2.5 synthetic-context | 4 | 4 | 0 | 0 | 0 |

Interpretation:

This comparison closes the current hard behavior benchmark phase. It shows three
important patterns:

- Dream-Coder dLLM bounded orchestration is the strongest result on this suite.
- Expanded context gives Qwen2.5 the highest LLM task success, but sharply
  weakens evidence and trace.
- Synthetic context gives Qwen2.5 the best balance among LLM context strategies:
  it matches RAG task success while preserving plain bounded auditability.

The 0% scope drift and 0% leakage rows should be read carefully. They mean this
suite did not observe forbidden-term or raw-sensitive-output violations. They do
not prove that all forms of scope control are solved. Deeper scope behavior still
requires a real code patch benchmark with file-level allowed and forbidden
changes.

## Result 11: Qwen2.5-Coder 7B GGUF Code Patch Benchmark

Runtime:

- RunPod GPU pod.
- RTX 3090 24GB VRAM.
- llama.cpp OpenAI-compatible server.
- Model: `qwen2.5-coder-7b-instruct-q4_k_m`.
- Benchmark target: `ai/nanoid`.
- Repository commit: `e4b7a9a7323006474ec939112aec68944b0da097`.
- Case count: 50 positive model-facing code patch cases.

Command:

```bash
LLM_API_BASE_URL=http://127.0.0.1:8000/v1 \
LLM_MODEL=qwen2.5-coder-7b-instruct-q4_k_m \
LLM_TEMPERATURE=0 \
LLM_MAX_TOKENS=900 \
npm run code:model-benchmark
```

Reported artifact paths:

```text
reports/2026-06-19T18-35-50-546Z-code-model-patch-benchmark.json
reports/2026-06-19T18-35-50-546Z-code-model-patch-benchmark.md
```

Observed summary after bounded excerpt packaging for long files:

| Metric | Value |
| --- | ---: |
| Case count | 50 |
| Positive control pass rate | 80% |
| Expected outcome accuracy | 80% |
| Test pass rate | 100% |
| Allowed file accuracy | 100% |
| Expected file coverage | 98% |
| Forbidden file touch rate | 0% |
| Forbidden pattern hit rate | 12% |
| Refusal accuracy | 82% |

Reality breakdown:

| Reality | Cases | Patch pass | Allowed files | Expected files | Refusal | No effect |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `micro_patch` | 30 | 96.7% | 100% | 96.7% | 100% | 3.3% |
| `module_patch` | 10 | 100% | 100% | 100% | 100% | 0% |
| `enterprise_boundary` | 10 | 10% | 100% | 100% | 10% | 0% |

Interpretation:

This is the first real repository patch benchmark result in the lab. It uses a
real open-source repository, applies model-generated patch plans to a fresh repo
copy per case, checks changed files with git, and runs the repository's fast
version check.

The most important finding is not simply the 80% overall pass rate. The value is
in the split by reality level:

```text
Qwen2.5-Coder 7B is strong on micro and module patch work, but weak on
enterprise-boundary refusal.
```

The model preserved file ownership very well:

```text
Allowed file accuracy: 100%
Forbidden file touch rate: 0%
```

This means the model did not drift into forbidden files in this run. It was also
very strong on module patch work:

```text
module_patch: 10 / 10 = 100%
```

The module patch cases were release metadata consistency tasks such as updating
`package.json` and `jsr.json` together while leaving runtime files untouched.
This suggests that the model can handle narrow multi-file consistency work when
the required decision is present.

The micro patch result improved from the earlier run after long README files
were replaced with bounded excerpts:

```text
micro_patch before excerpting: 63.3%
micro_patch after excerpting: 96.7%
```

This is not an oracle shortcut. The model still does not see expected changed
files, scoring criteria, or answer keys. The excerpt only prevents long,
irrelevant file context from causing endpoint/request failures. This supports
the project's context hypothesis:

```text
Better bounded context packaging can improve measured patch behavior without
leaking the answer key.
```

The weakest result is enterprise-boundary behavior:

```text
enterprise_boundary: 1 / 10 = 10%
```

In most enterprise-boundary cases, the model should refuse because the required
product or compliance decision is missing. Instead, it often guessed a new
default ID length such as `20`, `22`, or `24`. This is the strongest code-level
signal so far for the project's core concern:

```text
The model can write scoped code patches, but it often fails to know when it
lacks enough authority or context to make the decision.
```

This result should be reported carefully:

```text
Qwen2.5-Coder 7B performs well on scoped micro/module code edits, but the first
code benchmark shows a clear weakness in insufficient-context refusal and
enterprise boundary reasoning.
```

It should not be reported as:

```text
Qwen2.5-Coder is bad at coding.
```

The model is not bad at coding in this benchmark. The measured weakness is more
specific and more relevant to agentic coding in companies: boundary awareness.

## What These Results Show

These initial results support fifteen early findings:

1. The benchmark input pipeline can avoid answer-key leakage.
2. Bounded context can strongly improve controlled behavior metrics.
3. Grounding and verifier trace are necessary for auditability, even when task
   success is already high.
4. The Dream-Coder worker can pass both base and hard behavior suites under the
   current bounded orchestration.
5. The current base and hard suites are not hard enough to expose the value of
   refinement beyond single-pass grounded output.
6. A controlled remask-required suite can isolate the value of verifier-guided
   region replacement.
7. The first real autoregressive LLM baseline is now measurable on the same hard
   suite, and in this run it underperformed the Dream-Coder bounded dLLM worker
   on task success while remaining scope-safe and leakage-safe.
8. Failure taxonomy can separate strict benchmark failures into likely semantic
   wording misses, true task failures, trace gaps, boundary failures, and safety
   violations.
9. RAG-style context can improve task success while reducing evidence and trace
   quality, showing that extra context introduces an auditability trade-off.
10. Expanded context can further improve task success while sharply reducing
    evidence and trace quality, strengthening the context/auditability trade-off.
11. Synthetic context can match the RAG task-success improvement while preserving
    plain bounded evidence and trace quality in this run.
12. A single comparison report makes the main trade-off visible: task success,
    context budget, evidence, trace, leakage, and failure taxonomy must be read
    together.
13. Real repository code patch scoring is now measurable with allowed files,
    forbidden files, expected file coverage, patch application errors, no-effect
    patches, and refusal behavior.
14. Bounded excerpts for long files can improve micro-patch performance without
    leaking evaluator-only fields.
15. Qwen2.5-Coder 7B shows a clear split: strong scoped patch ability, strong
    module metadata consistency, and weak enterprise-boundary refusal.

This is useful because it clarifies the research direction. The project is not
only testing whether a model can answer correctly. It is testing whether an
agentic architecture can answer correctly while staying scoped, avoiding leakage,
and leaving a trace that a human or evaluator can inspect.

## What These Results Do Not Show Yet

These results do not yet prove:

- that dLLMs outperform autoregressive LLMs,
- that dLLMs outperform autoregressive LLMs on real code patches,
- that the current benchmark is difficult enough,
- that keyword-based scoring catches every semantic failure,
- that one quantized Qwen2.5-Coder GGUF run represents all autoregressive LLM
  baselines,
- that refinement adds value inside real model generations under hard failure
  conditions,
- that the system is ready for production use.

The current result is best described as the first behavior-and-code benchmark
milestone, not a final superiority claim.

## Threats To Validity

The main risks are:

- The 50-case base benchmark and 25-case hard benchmark are controlled and may
  still be too easy.
- Deterministic scoring may miss semantically wrong but keyword-matching outputs.
- The Dream-Coder worker includes orchestration support around grounding and
  boundary behavior, so the result measures the system, not the raw model alone.
- The Qwen2.5-Coder baseline used GGUF quantization and llama.cpp serving, so it
  should not be treated as a full precision upper bound for that model family.
- The LLM baseline prompt and JSON contract can affect success rate; future runs
  should compare prompt variants while keeping oracle fields hidden.
- The RAG-style baseline uses a small deterministic retrieval heuristic, not a
  production-grade vector database or learned retriever.
- The RAG result may depend on the number and kind of retrieved facts; future
  runs should vary retrieval breadth.
- The expanded-context result uses a deterministic broad memory slice; different
  broad-context construction policies may produce different trade-offs.
- The taxonomy-adjusted interpretation is a diagnostic aid, not an official
  replacement for strict task success.
- The ablation modes are controlled architecture simulations, while the
  Dream-Coder and Qwen2.5-Coder runs are real worker baselines.
- There is no latency, cost, or throughput analysis yet.
- The first real repository patch benchmark uses one small OSS repository; it
  does not yet prove generality across larger repos or multiple languages.
- The current hard suite still does not isolate verifier-guided remasking value;
  that is why the separate remask-required mechanism suite exists.

These limitations are expected at this stage. They define the next experiments.

## Next Research Phase

The next phase should compare real code patch behavior across architectures and
then increase repository realism.

Planned steps:

1. Run the same 50-case code patch benchmark with Dream-Coder/dLLM-style patch
   generation.
2. Compare Qwen2.5-Coder autoregressive LLM and Dream-Coder dLLM code-patch
   behavior under the same fixture set.
3. Add a second OSS repository with more realistic implementation + test patch
   tasks.
4. Expand enterprise-boundary code cases with missing decision, missing
   authority, sensitive logging, and cross-module ownership constraints.
5. Add latency and cost measurement for each architecture.
6. Add stronger or larger LLM baselines when hardware budget allows.
7. Add human failure-review notes for cases where deterministic metrics are too
   coarse.

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

## Update: LLM Baseline Prepared And First Run Completed

The next implementation step adds an OpenAI-compatible autoregressive LLM worker
and a hard-suite baseline runner.

The baseline is intentionally conservative:

- it uses the same hard fixture packets,
- it does not send `expectedResult`, `requiredTerms`, `forbiddenTerms`, or
  scoring fields to the model,
- it asks the model for a JSON decision,
- it writes the model's own `finalResult`, `boundaryStatus`, and `evidenceIds`
  into the shared workspace,
- it does not rewrite the answer to the canonical correction fact after
  generation.

This matters because the research question now becomes comparative:

```text
Given the same bounded packet, does a bounded dLLM worker behave differently
from an autoregressive LLM baseline on task success, leakage, evidence, and trace?
```

The first baseline command sequence is:

```bash
npm run build
LLM_API_BASE_URL=http://127.0.0.1:8000/v1 \
LLM_API_KEY=optional-key \
LLM_MODEL=your-model-name \
npm run worker:llm-openai
```

Then, in another terminal:

```bash
npm run worker:llm-hard-benchmark
```

The first RunPod baseline used Qwen2.5-Coder 7B Instruct GGUF through llama.cpp
and produced the Result 6 measurement above. Future baseline runs should keep
the same reporting discipline: model repo, model file, quantization, endpoint,
artifact paths, and summary metrics must all be recorded.
