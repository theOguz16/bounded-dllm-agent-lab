# Code Patch Benchmark — Historical Methodology

> This document is retained for reproducibility of earlier code-patch experiments. It is **not** a current-state or evidence-status source. Current experiment status is authoritative only in [`../evidence/index.json`](../evidence/index.json); runtime direction is summarized in [`CURRENT_STATE.md`](./CURRENT_STATE.md).

## Purpose

The historical code-patch benchmark evolved from deterministic Nano ID fixtures into model-facing bounded-context, workspace, verifier, remask, and external-repository comparisons. Its value today is methodological: it records how scope, hidden-oracle separation, patch application, negative controls, and failure taxonomies were tested.

The benchmark must not be used to infer that a historical architecture is canonical, that a fixture is a live observation, or that an old report proves current comparative superiority.

## Core benchmark invariants

Across the retained benchmark runners, the important invariants are:

- evaluator-only expected files and success criteria stay out of provider-visible context;
- allowed and forbidden repository scope is explicit;
- malformed model output, patch-application failure, scope violation, refusal, and test failure remain distinct outcomes;
- negative controls must fail for the expected reason;
- model/provider/config identity must be comparable before relative claims are made;
- durable observed evidence must be registered before a benchmark is called observed.

## Historical benchmark surfaces

The repository still contains commands for the earlier Nano ID and context-strategy experiments, including:

```bash
npm run code:benchmark
npm run code:model-benchmark
npm run code:model-synthetic-benchmark
npm run code:model-expanded-benchmark
npm run code:model-rag-benchmark
npm run code:model-workspace-benchmark
npm run code:model-workspace-verifier-benchmark
npm run code:model-workspace-verifier-remask-benchmark
npm run code:dllm-benchmark
npm run code:failure-taxonomy
```

These are research tools, not the canonical product API.

## Gate 5 relationship

Later Gate 5 work moved comparative evidence to immutable external repositories and explicit A/B/C/D/E and C/E/F experiments. Do not derive Gate 5 completion from this file.

Use:

```bash
node scripts/evidence-index.cjs status gate5
```

The registered state on `main` distinguishes fixture-only Gate 5 A–E from pending Mode F live validation. Mode F resolver promotion is blocked until live evidence satisfies the explicit promotion gate.

## Canonical runtime relationship

The canonical runtime lives under `packages/product-runtime/`, repository intelligence under `packages/repo-intelligence/`, and provider/executor integration under `packages/integrations/`. Historical benchmark architectures may inform those packages only through evidence-backed promotion decisions; research code is not copied into runtime merely because a benchmark harness exists.

## Reproducibility rule

If an older benchmark command or report is used in new research, record the exact source commit, model/provider/config, task identity, and resulting artifact. If the result should affect project claims, register durable evidence in `evidence/index.json` rather than adding a stronger statement to this Markdown file.
