# Technical Report Outline

## Working Title

Bounded-Context dLLM Agentic Coding: A Shared Workspace Approach for Scope-Safe Software Change

## Abstract

This section will summarize the research question, benchmark design, compared architectures, main metrics, and key findings after real experiments are completed.

## 1. Motivation

Modern coding agents often rely on broad prompts, long context windows, and linear answer generation. This can create scope drift, sensitive leakage, stale fact usage, and high context cost.

The project studies whether narrow context packets, role-based mask views, verifier-guided refinement, and dLLM-style masked inference can create more reliable agentic coding flows.

## 2. Research Question

Can bounded-context, synthetic-context-enriched, mask-view-based agent flows produce more scope-safe and traceable coding outputs than long-context or retrieval-first LLM baselines?

## 3. Hypotheses

1. Bounded-context agents reduce scope drift compared with broad-context agents.
2. Verifier-guided remasking improves trace completeness and evidence coverage.
3. Role-based mask views reduce destructive interference between agent roles.
4. dLLM-style masked refinement is a better fit for workspace-region repair than left-to-right full-answer generation.

## 4. System Architecture

Describe:

- bounded context packets,
- shared semantic workspace,
- role-based mask views,
- verifier results,
- failed region remasking,
- TypeScript orchestrator,
- Python dLLM worker boundary.

## 5. Benchmark Design

Current benchmark families:

- correction override,
- sensitive boundary,
- scope drift,
- insufficient context,
- conflict resolution.

Each case includes task, facts, allowed scope, forbidden scope, expected evidence, boundary expectations, and expected result.

## 6. Compared Architectures

Initial architecture registry:

- bounded dLLM refinement loop,
- long-context LLM mock baseline,
- RAG LLM mock baseline,
- synthetic-context LLM mock baseline.

Future real baselines should replace mock runners while preserving the same fixture and scoring pipeline.

## 7. Metrics

Primary metrics:

- task success rate,
- required term coverage,
- forbidden term hit rate,
- scope drift rate,
- sensitive leakage rate,
- boundary accuracy,
- evidence coverage,
- trace completeness rate,
- context budget utilization.

Family-level breakdowns should be reported to avoid hiding weaknesses behind averages.

## 8. Experiment Protocol

Every run must produce:

- JSON report,
- Markdown report,
- run manifest,
- optional comparison index,
- optional failure review.

The manifest records architecture, model, worker URL, seed, git commit, hardware, mask policy version, and report paths.

## 9. Failure Analysis

Use deterministic metrics first. Use human review only when semantic interpretation is required.

Failure categories:

- scope drift,
- sensitive leakage,
- stale fact use,
- insufficient context miss,
- weak evidence,
- trace gap,
- conflict unresolved.

## 10. Threats To Validity

Potential limitations:

- deterministic fixtures may be too controlled,
- mock baselines do not prove real model performance,
- keyword-based metrics may miss semantic failures,
- real dLLM candidates may differ from the ideal masked-refinement assumption,
- hardware and model version changes can affect latency and quality.

## 11. Expected Contributions

The project aims to contribute:

- a reproducible benchmark lab,
- a role-based shared workspace schema,
- a mask-view and remasking architecture,
- a TS/Python worker boundary for dLLM inference,
- a comparison methodology for agentic coding architectures.

## 12. Result Tables

To be filled after real experiments:

- architecture comparison table,
- family breakdown table,
- ablation table,
- latency and cost table,
- failure category table.

## 13. Conclusion

To be written after real model experiments and ablations.
