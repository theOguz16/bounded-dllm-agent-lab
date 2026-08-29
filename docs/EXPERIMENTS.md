# Experiments — Historical Research Guide

> This file documents benchmark design patterns and retained historical experiments. It is **not** the authority for whether an experiment is complete, observed, or promotable. Query [`../evidence/index.json`](../evidence/index.json) for status and use [`CURRENT_STATE.md`](./CURRENT_STATE.md) only as a narrative runtime summary.

## Benchmark contract

The durable methodological rule is separation between provider-visible input and evaluator-only truth:

```text
BenchmarkFixture
  -> packet: provider-visible task/context
  -> case: evaluator-only grading oracle
```

Expected answers, expected changed files, success criteria, and metric-specific oracle values must not leak into the packet. Scope, task text, permitted evidence, and explicit authority may be provider-visible when they are part of the real task contract.

## What the retained experiments test

Historical suites in this repository cover:

- correction/stale-fact handling;
- sensitive-boundary and scope-drift behavior;
- insufficient-context refusal;
- deterministic ablation of context/grounding/refinement layers;
- autoregressive, RAG-style, expanded, synthetic, workspace, verifier, and remask variants;
- code-patch and external-repository tasks;
- Gate 5 comparative evidence contracts;
- controlled-coding pilots with bounded authority and deterministic verification.

Those experiments are inputs to architecture decisions, not alternate definitions of the current runtime.

## Evidence rule

A benchmark may have several materially different states:

- a deterministic fixture/harness exists;
- a live provider was invoked;
- an observed artifact was durably committed and verified;
- the result was registered as evidence;
- a research result justified promotion into canonical runtime code.

These states must not be collapsed into one "done" label.

Use the machine-readable registry:

```bash
node scripts/evidence-index.cjs verify
node scripts/evidence-index.cjs status gate5
node scripts/evidence-index.cjs status controlled_coding_pilot_v2
```

## Current comparative research boundary

Gate 5 A–E is registered as fixture evidence, not durable live observed evidence. Mode F C/E/F remains pending live validation. Controlled Coding Pilot V2 observed runs also remain pending even though its offline runtime and CI gates exist.

Mode F's narrow JavaScript/TypeScript evidence resolver remains research-only. It can move into canonical repository intelligence only after live evidence demonstrates same-or-better strict success, less context, and no additional scope drift.

## Historical commands

The repository intentionally retains earlier research commands such as:

```bash
npm run ablation:run
npm run hard:ablation
npm run remask:benchmark
npm run worker:llm-hard-benchmark
npm run worker:llm-rag-hard-benchmark
npm run worker:llm-expanded-hard-benchmark
npm run worker:llm-synthetic-hard-benchmark
npm run reports:llm-context
```

They are reproducibility tools. Their outputs do not override the evidence registry or canonical runtime contracts.

## Documentation discipline

When a research run changes the project state:

1. preserve the raw/durable artifact and provenance;
2. verify it;
3. update the machine-readable evidence registry;
4. promote runtime code only if the evidence-backed decision requires it;
5. then update narrative docs as a consequence.

Markdown should explain code and evidence, never outvote them.
