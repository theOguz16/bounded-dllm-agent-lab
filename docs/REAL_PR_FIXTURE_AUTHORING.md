# Real PR Fixture Authoring Guide

This guide explains how to write reviewer-labeled real PR pilot cases for the
bounded agent runtime.

## Required Fields

Each case should include:

```ts
type RealPrPilotCase = {
  id: string
  family: "expected_pass" | "expected_block" | "expected_repair" | "expected_human_review"
  source: {
    repository: string
    pullRequest: string
    baseRef: string
    headRef: string
    note: string
  }
  task: TaskSpec
  policy: RepoPolicy
  diff: string
  reviewerNotes: string[]
  expectedDecision: ReviewDecision
  expectedFindingCategories: Finding["category"][]
}
```

## Decision Taxonomy

| Decision | Use When |
| --- | --- |
| `approve` | Reviewer expects the patch to pass the configured policy. |
| `refuse` | Missing owner, product, module, platform or compliance authority. |
| `reject` | Forbidden path, generated artifact or sensitive boundary risk. |
| `remask_required` | Local repair is needed but the patch is not globally unsafe. |
| `human_review_required` | Test signal, authority detail or context is insufficient. |

## Finding Categories

Use the smallest useful expected set:

| Category | Meaning |
| --- | --- |
| `scope` | Path is outside allowed scope or inside forbidden scope. |
| `authority` | Required authority phrase is missing. |
| `ownership` | Module owner approval is missing. |
| `module_boundary` | Patch crosses configured module boundary. |
| `sensitive_boundary` | Secret-like or sensitive pattern appears. |
| `paired_file` | Required paired file is missing. |
| `test` | Required test mapping is missing. |
| `verifier_adapter` | Future model-backed verifier finding. |

## Reviewer Notes

Reviewer notes should explain why the expected decision is reasonable. They
should not contain hidden answer keys for the runtime. Good notes look like:

```text
Reviewer expects package-lock.json and jsr.json to stay in sync.
```

Avoid notes like:

```text
The runtime must output remask_required with paired_file.
```

## Anti-Leakage Rule

Do not put expected decisions or expected finding categories inside the task
description. The task should look like something a developer or PR author would
actually provide.

## Practical Pilot Size

For the first external pilot:

- 10-20 reviewer-labeled PRs are enough.
- Cover pass, repair, block and human-review cases.
- Prefer high-quality labels over large volume.
- Keep a few ambiguous cases; they reveal false positives and missed blockers.

## Current Built-In Suite

The built-in NanoID-shaped suite can be run with:

```bash
npm run product:real-pr-pilot -- --suite nanoid --fail-on-regression
npm run product:pilot-insights -- --dir reports/product-runtime --fail-on-missed-blocker
```

## Importing Real GitHub PRs

Use the importer to create a draft JSON file:

```bash
npm run product:github-pr-import -- \
  --repo ai/nanoid \
  --prs 600,586,585 \
  --out examples/product-runtime/real-pr-fixtures/nanoid-github-prs.draft.json
```

The importer does not create scientific ground truth. It creates a draft by
running the current deterministic runtime and marking the labels as
`DRAFT_LABEL` in reviewer notes. A human reviewer must still verify the
expected decision and finding categories.

## Calibrating Imported Fixtures

After importing, run:

```bash
npm run product:pr-calibration -- \
  --input examples/product-runtime/real-pr-fixtures/nanoid-github-prs.draft.json \
  --out-dir reports/product-runtime
```

The calibration report separates three states:

| Status | Meaning |
| --- | --- |
| `needs_human_review` | The fixture is deterministic but still has runtime-draft labels. |
| `runtime_drift` | The expected label no longer matches current runtime behavior. |
| `reviewed_ready` | A human override removed the draft label and the runtime still matches it. |

Use `examples/product-runtime/real-pr-fixtures/reviewer-label-overrides.example.json`
as the shape for human-reviewed labels. Do not copy expected labels into task
descriptions; that would leak the answer into the benchmark.

## Reviewed NanoID External Set

The first committed human-reviewed external label set is:

```text
examples/product-runtime/real-pr-fixtures/nanoid-reviewed-label-overrides.json
```

Run it with:

```bash
npm run product:pr-reviewed-calibration -- \
  --out-dir reports/product-runtime \
  --fail-on-runtime-drift \
  --fail-on-unreviewed

npm run product:pr-label-comparison -- \
  --out-dir reports/product-runtime \
  --fail-on-unreviewed
```

This set is intentionally a positive-control set over merged NanoID PRs. It
does not replace blocker/reject/remask benchmarks; it checks whether the
calibrated external-repo policy creates false blockers on real accepted PRs.

## Reviewed p-limit External Set

MVP-9 adds a second reviewed external set:

```text
examples/product-runtime/real-pr-fixtures/p-limit-github-prs.draft.json
examples/product-runtime/real-pr-fixtures/p-limit-reviewed-label-overrides.json
```

Run it with:

```bash
npm run product:p-limit-reviewed-calibration -- \
  --out-dir reports/product-runtime \
  --fail-on-runtime-drift \
  --fail-on-unreviewed

npm run product:p-limit-label-comparison -- \
  --out-dir reports/product-runtime \
  --fail-on-unreviewed
```

The p-limit set guards against overfitting external validation to NanoID alone.
Both sets can be checked together with:

```bash
npm run product:cross-repo-validation -- \
  --out-dir reports/product-runtime \
  --fail-on-runtime-drift \
  --fail-on-unreviewed
```

## Mixed Positive and Negative External Validation

Positive merged PR fixtures answer:

```text
Does the runtime avoid false blockers on accepted upstream changes?
```

Negative controls answer the opposite:

```text
Does the runtime catch risky PR-shaped diffs before they pass silently?
```

Run both together:

```bash
npm run product:mixed-external-validation -- \
  --out-dir reports/product-runtime \
  --fail-on-false-blocker \
  --fail-on-missed-blocker
```

The negative controls are intentionally PR-shaped rather than random fuzz. They
cover forbidden generated output, missing paired files, missing mapped tests,
ownership mismatch, sensitive token-like content and module boundary expansion.
