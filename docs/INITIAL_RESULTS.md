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

## Result 12: Dream-Coder dLLM Direct Code Patch Benchmark

Runtime:

- RunPod GPU pod.
- RTX 3090 24GB VRAM.
- Dream-Coder worker through the dLLM `/infill` endpoint.
- Model worker: `dream-coder-dllm-worker`.
- Benchmark target: `ai/nanoid`.
- Repository commit: `e4b7a9a7323006474ec939112aec68944b0da097`.
- Case count: 50 positive model-facing code patch cases.

Command:

```bash
DLLM_WORKER_URL=http://127.0.0.1:8765 \
npm run code:dllm-benchmark
```

Reported artifact paths:

```text
reports/2026-06-19T20-24-14-904Z-code-dllm-patch-benchmark.json
reports/2026-06-19T20-24-14-904Z-code-dllm-patch-benchmark.md
```

Observed summary after separating invalid model output from true refusal:

| Metric | Value |
| --- | ---: |
| Case count | 50 |
| Positive control pass rate | 12% |
| Expected outcome accuracy | 12% |
| Test pass rate | 100% |
| Allowed file accuracy | 100% |
| Expected file coverage | 32% |
| Forbidden file touch rate | 0% |
| Forbidden pattern hit rate | 0% |
| Refusal accuracy | 80% |

Reality breakdown:

| Reality | Cases | Patch pass | Allowed files | Expected files | Refusal | No effect |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `micro_patch` | 30 | 20% | 100% | 20% | 100% | 0% |
| `module_patch` | 10 | 0% | 100% | 0% | 100% | 0% |
| `enterprise_boundary` | 10 | 0% | 100% | 100% | 0% | 0% |

Interpretation:

This run tested Dream-Coder as a direct code patch writer using the same Nano ID
fixture set used by the Qwen2.5-Coder baseline. The result is intentionally
strict: malformed JSON is not counted as a correct refusal. Invalid model output
is recorded separately as `invalid_model_output`.

The central finding is:

```text
Dream-Coder dLLM was scope-safe but weak as a direct code patch implementer.
```

The strongest positive signal is file boundary behavior:

```text
Allowed file accuracy: 100%
Forbidden file touch rate: 0%
Forbidden pattern hit rate: 0%
```

The strongest negative signal is patch production:

```text
Positive control pass rate: 12%
module_patch: 0 / 10 = 0%
enterprise_boundary: 0 / 10 = 0%
```

Most failed cases did not fail because the model edited forbidden files. They
failed because the worker often returned prose such as "To address the task..."
or malformed JSON instead of a valid patch plan. This matters because code patch
agents require not only local reasoning but also contract-following behavior:
the model must produce a machine-applicable change, not merely describe one.

The enterprise-boundary result is especially important. In the earlier raw run,
malformed output was accidentally counted as refusal. After fixing the scorer,
those cases correctly became failures:

```text
Malformed JSON is not a correct insufficient-context refusal.
```

The comparison with Qwen2.5-Coder is therefore more precise:

| Model / worker | Direct patch writing | File boundary behavior | Missing-context refusal |
| --- | ---: | ---: | ---: |
| Qwen2.5-Coder 7B GGUF | strong | strong | weak |
| Dream-Coder dLLM worker | weak | strong | weak / format-limited |

This does not mean Dream-Coder is useless for the research. It means the current
Dream-Coder worker should not be treated as the primary implementation agent for
code patches. A more plausible architecture is role-specialized:

```text
Autoregressive coder model: implementation agent.
dLLM worker: candidate verifier, boundary checker, remask planner, or
conflict-check agent.
Shared workspace: coordinates these roles under one bounded context state.
```

This result narrows the product/research direction. The next dLLM experiment
should not ask "Can Dream-Coder directly write all patches better than Qwen?"
It should ask:

```text
Can a dLLM worker improve safety, refusal, critique, verifier, or remask
decisions around a stronger autoregressive patch writer?
```

## Result 13: Qwen2.5-Coder Code Context Strategy Comparison

Runtime:

- RunPod GPU pod.
- RTX 3090 24GB VRAM.
- Qwen2.5-Coder 7B Instruct GGUF through llama.cpp.
- Model file: `qwen2.5-coder-7b-instruct-q4_k_m.gguf`.
- Benchmark target: `ai/nanoid`.
- Repository commit: `e4b7a9a7323006474ec939112aec68944b0da097`.
- Case count: 50 positive model-facing code patch cases per strategy.

This experiment keeps the model and code benchmark fixed, then changes only the
context packaging strategy:

| Strategy | Artifact |
| --- | --- |
| Plain bounded | `reports/2026-06-19T21-51-47-466Z-code-model-patch-benchmark.json` |
| Synthetic context | `reports/2026-06-19T21-53-51-365Z-code-model-synthetic-patch-benchmark.json` |
| Expanded context | `reports/2026-06-19T21-55-52-025Z-code-model-expanded-patch-benchmark.json` |
| RAG-style context | `reports/2026-06-19T21-58-00-370Z-code-model-rag-patch-benchmark.json` |

Summary:

| Strategy | Patch pass | Expected outcome | Expected files | Forbidden patterns | Refusal |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plain bounded | 78% | 78% | 98% | 14% | 80% |
| Synthetic context | 78% | 78% | 98% | 14% | 80% |
| Expanded context | 84% | 84% | 98% | 8% | 86% |
| RAG-style context | 80% | 80% | 98% | 12% | 82% |

Reality breakdown:

| Strategy | Micro patch | Module patch | Enterprise boundary |
| --- | ---: | ---: | ---: |
| Plain bounded | 96.7% | 100% | 0% |
| Synthetic context | 96.7% | 100% | 0% |
| Expanded context | 96.7% | 100% | 30% |
| RAG-style context | 96.7% | 100% | 10% |

Interpretation:

This result shows that Qwen2.5-Coder's main code-patch bottleneck is not basic
implementation ability. Across all four context strategies, micro-patch and
module-patch performance remained very strong:

```text
micro_patch: 96.7%
module_patch: 100%
allowed files: 100%
expected files: 98%
```

The meaningful difference appears in enterprise-boundary cases, where the model
must decide whether enough authority or product context exists to make a change.
Plain bounded and synthetic context did not improve that behavior:

```text
plain enterprise_boundary: 0 / 10 = 0%
synthetic enterprise_boundary: 0 / 10 = 0%
```

RAG-style context helped slightly:

```text
rag enterprise_boundary: 1 / 10 = 10%
```

Expanded context helped the most in this code benchmark:

```text
expanded enterprise_boundary: 3 / 10 = 30%
```

This is an important contrast with the earlier hard behavior benchmark. In that
benchmark, expanded context improved task success but reduced evidence and trace
quality. In the code patch benchmark, expanded context improved boundary/refusal
behavior while preserving file-scope safety.

The current reading is:

```text
Context strategy is task-dependent.
```

For small and module-level code edits, Qwen2.5-Coder already has enough local
information. Extra context does not materially improve the patch-writing part.
For enterprise-boundary cases, extra operational context can help, but the
improvement is still limited.

The synthetic context result is also useful because it is negative:

```text
The current synthetic packet did not improve enterprise-boundary reasoning.
```

This means the synthetic packet should not merely summarize nearby information.
The next version should behave more like a decision policy: when to refuse,
when to request missing authority, when to avoid guessing product defaults, and
when a patch is allowed.

The strongest practical conclusion from Result 13 is:

```text
Qwen2.5-Coder is a strong scoped implementation agent, but enterprise-grade
agentic coding needs a separate boundary/refusal mechanism.
```

This supports the next research direction: use the autoregressive coder model
for implementation, then add a specialized verifier, boundary checker, remask
planner, or dLLM-style reviewer around it.

## Result 14: Code Patch Failure Taxonomy

Runtime:

- RunPod GPU pod.
- RTX 3090 24GB VRAM.
- Taxonomy command: `npm run code:failure-taxonomy`.
- Input reports: latest available Qwen2.5 code context reports and the
  Dream-Coder dLLM direct patch report.

Reported artifact paths:

```text
reports/2026-06-19T22-16-54-830Z-code-failure-taxonomy.json
reports/2026-06-19T22-16-54-830Z-code-failure-taxonomy.md
```

Summary:

| Run | Patch pass | Refusal | Boundary guess | Invalid contract |
| --- | ---: | ---: | ---: | ---: |
| Qwen2.5 plain | 78% | 80% | 10 | 0 |
| Qwen2.5 synthetic | 78% | 80% | 10 | 0 |
| Qwen2.5 expanded | 84% | 86% | 7 | 0 |
| Qwen2.5 RAG | 80% | 82% | 9 | 0 |
| Dream-Coder dLLM | 12% | 80% | 0 | 42 |

Interpretation:

This taxonomy run explains the failed code-patch cases instead of only reporting
whether they passed. The most important split is that Qwen2.5-Coder and
Dream-Coder failed for different reasons.

Qwen2.5-Coder did not usually fail because it broke the machine-readable patch
contract:

```text
Qwen invalid contract count: 0
```

It produced parseable `file_edit` plans. The main failure was enterprise-boundary
reasoning. In missing-authority cases, the correct behavior was to refuse. Qwen
often guessed values such as `20`, `22`, or `24` and attempted to edit runtime or
type files anyway:

```text
plain boundary guess: 10 / 10
synthetic boundary guess: 10 / 10
expanded boundary guess: 7 / 10
rag boundary guess: 9 / 10
```

This makes the Qwen result more precise:

```text
Qwen2.5-Coder is a capable scoped implementation model, but it is weak at
knowing when a missing product, compliance, or governance decision should stop
the edit.
```

The expanded-context result is meaningful but not decisive. Expanded context
reduced boundary guesses from 10 to 7 and improved patch pass rate from 78% to
84%. That shows extra operational context can help, but it did not solve the
enterprise-boundary problem:

```text
expanded still guessed in 7 / 10 enterprise-boundary cases.
```

The synthetic-context result is an important negative result:

```text
synthetic boundary guess: 10 / 10
```

The current synthetic packet did not improve refusal behavior. This suggests
that the next synthetic packet should be stronger and more policy-like. It
should not merely summarize allowed files and task discipline. It should encode
explicit decision rules for missing authority, product approval, compliance
approval, and unsafe inference.

Dream-Coder dLLM failed in a different way:

```text
Dream-Coder invalid contract count: 42 / 50
```

Most Dream-Coder failures were not ordinary patch mistakes. The worker often
returned explanation text, malformed JSON, or an invalid patch/refusal envelope
instead of a machine-applicable patch plan. This is a contract-following failure:

```text
The dLLM direct patch worker often reasoned about the task but did not emit the
required machine-readable artifact.
```

This taxonomy therefore supports a role-specialized architecture rather than a
single-model replacement story:

```text
Qwen2.5-Coder: strong candidate implementation agent.
Dream-Coder dLLM: not ready as a direct patch writer in this setup.
Next dLLM role to test: verifier, boundary checker, critique agent, or remask
planner around a stronger implementation model.
```

The key research value is not that one model "wins." The value is that the
failure taxonomy separates model capability from orchestration capability:

- implementation strength,
- machine-readable contract following,
- missing-authority refusal,
- enterprise boundary reasoning,
- scope safety.

This is exactly the level of detail needed for agentic coding research. A single
task-success metric would hide the important difference between "can write code"
and "knows when not to write code."

## What These Results Show

These initial results support twenty-five early findings:

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
16. Dream-Coder dLLM direct patch writing is weak on the current Nano ID code
    benchmark, especially for module patch work and machine-readable JSON patch
    contracts.
17. Dream-Coder still preserved file boundaries in the direct patch benchmark,
    suggesting that the useful dLLM role may be safety, verification, boundary,
    or remask reasoning rather than direct implementation.
18. Invalid model output must be separated from true refusal; otherwise
    malformed JSON can falsely inflate insufficient-context performance.
19. Qwen2.5-Coder context strategy changes did not materially affect micro or
    module code patch performance, suggesting those cases are mostly local
    implementation tasks rather than context-packaging tasks.
20. Expanded context improved enterprise-boundary code behavior in the Qwen2.5
    run, while synthetic context did not, showing that context enrichment quality
    matters more than simply adding a synthetic summary.
21. Code benchmark and behavior benchmark results can diverge: expanded context
    weakened auditability in the behavior suite but improved refusal/boundary
    outcomes in the code patch suite.
22. Code failure taxonomy shows that Qwen2.5-Coder failures are mostly
    enterprise-boundary guesses, not invalid patch contracts.
23. Code failure taxonomy shows that Dream-Coder direct patch failures are mostly
    invalid machine-readable contracts, not forbidden-file edits.
24. Expanded context reduced Qwen2.5 enterprise-boundary guesses from 10 to 7 in
    this run, but did not solve missing-authority refusal.
25. The next architecture should test role specialization: autoregressive coder
    for implementation, plus a verifier/boundary/remask role that targets the
    failure modes exposed by taxonomy.

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
- that one Dream-Coder worker prompt represents all dLLM code-patch designs,
- that dLLMs are unsuitable for all coding-agent roles,
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
- The Dream-Coder direct patch result is sensitive to the current JSON patch
  contract and worker prompt. A different dLLM prompt, decoding setup, or
  parser contract may change patch-format success.
- Dream-Coder behavior-suite results and Dream-Coder direct patch results are
  not the same experiment. The former uses bounded workspace refinement and
  grounding; the latter asks the worker to directly produce a machine-applicable
  patch plan.
- Invalid model output is now separated from refusal, but deterministic scoring
  still cannot fully judge whether prose contained a semantically useful plan.
- The current hard suite still does not isolate verifier-guided remasking value;
  that is why the separate remask-required mechanism suite exists.

These limitations are expected at this stage. They define the next experiments.

## Next Research Phase

The next phase should test role-specialized model collaboration rather than only
direct patch writing.

Planned steps:

1. Add a verifier/boundary benchmark where Dream-Coder reviews Qwen2.5-Coder
   patch plans instead of writing patches directly.
2. Measure whether the dLLM worker can detect missing authority, invalid patch
   contracts, forbidden file risk, and remask-needed regions.
3. Add a hybrid run: Qwen2.5-Coder writes the patch, Dream-Coder evaluates or
   requests remasking, and the shared workspace records both roles.
4. Add a second OSS repository with more realistic implementation + test patch
   tasks.
5. Expand enterprise-boundary code cases with missing decision, missing
   authority, sensitive logging, and cross-module ownership constraints.
6. Add latency and cost measurement for each architecture.
7. Add stronger or larger LLM baselines when hardware budget allows.
8. Add human failure-review notes for cases where deterministic metrics are too
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
