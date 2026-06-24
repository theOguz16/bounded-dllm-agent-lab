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
