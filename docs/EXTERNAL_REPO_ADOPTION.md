# External Repository Adoption Guide

This guide explains how to test the bounded agent runtime on another
repository without turning it into a black-box AI reviewer.

## 1. Start With Policy

Create a policy file in the target repository:

```bash
npm run product:policy -- --init --out bounded-agent.policy.yml
```

Then edit:

- `allowed_paths`
- `forbidden_paths`
- `ownership`
- `owner_aliases`
- `paired_files`
- `required_test_mappings`
- `module_boundaries`
- `sensitive_patterns`

The policy is the runtime's authority boundary. A weak policy gives weak
signals.

## 2. Collect Reviewer-Labeled PR Diffs

For each PR sample, capture:

- task or ticket text,
- raw PR diff,
- expected reviewer decision,
- expected finding categories,
- short reviewer notes.

The first pilot does not need many samples. Ten to twenty high-quality PR diffs
are more useful than hundreds of unlabeled examples.

You can create a draft fixture from GitHub PRs:

```bash
npm run product:github-pr-import -- \
  --repo ai/nanoid \
  --prs 600,586,585 \
  --out examples/product-runtime/real-pr-fixtures/nanoid-github-prs.draft.json
```

The importer preserves real PR metadata and raw diffs. Its default labels are
`runtime-draft` labels, not human ground truth. Before using the fixture as
external validation, a reviewer should inspect and correct:

- `expectedDecision`
- `expectedFindingCategories`
- `reviewerNotes`

## 3. Run The Real PR Pilot

Use built-in samples:

```bash
npm run product:real-pr-pilot -- \
  --suite nanoid \
  --out-dir reports/product-runtime \
  --fail-on-regression
```

Use your own fixture JSON:

```bash
npm run product:real-pr-pilot -- \
  --input examples/product-runtime/real-pr-fixtures/nanoid-github-prs.draft.json \
  --out-dir reports/product-runtime \
  --fail-on-regression
```

## 4. Generate Pilot Insights

```bash
npm run product:pilot-insights -- \
  --dir reports/product-runtime \
  --fail-on-missed-blocker
```

Read this as:

- caught blockers: useful review signal,
- false positives: over-warning,
- missed blockers: unsafe under-warning,
- finding gaps: right decision but incomplete explanation.

## 5. Calibrate Imported Labels

Before treating imported PRs as external validation, run calibration:

```bash
npm run product:pr-calibration -- \
  --input examples/product-runtime/real-pr-fixtures/nanoid-github-prs.draft.json \
  --out-dir reports/product-runtime \
  --fail-on-runtime-drift
```

Read this as:

- `needs_human_review`: runtime-draft label still needs a human reviewer,
- `runtime_drift`: expected label no longer matches runtime output,
- `reviewed_ready`: label has been human-reviewed and still matches runtime output.

For human-reviewed cases, create an override file:

```bash
npm run product:pr-calibration -- \
  --overrides examples/product-runtime/real-pr-fixtures/reviewer-label-overrides.example.json \
  --out-dir reports/product-runtime
```

For the committed NanoID external validation set:

```bash
npm run product:pr-reviewed-calibration -- \
  --out-dir reports/product-runtime \
  --fail-on-runtime-drift \
  --fail-on-unreviewed

npm run product:pr-label-comparison -- \
  --out-dir reports/product-runtime \
  --fail-on-unreviewed
```

The reviewed NanoID set should be interpreted as a positive-control external
set: these are real merged upstream PRs, so the calibrated policy should avoid
false blockers. Synthetic and built-in pilot suites still cover blocker and
repair cases.

## 6. Interpret Readiness

Readiness combines:

- decision accuracy,
- missed blocker rate,
- false positive rate,
- expected finding coverage,
- policy quality score.

This is not a security guarantee. It is a pilot-health signal.

## 7. Promote Carefully

Recommended rollout:

1. Artifact-only mode.
2. PR comment mode.
3. Warning-only branch protection.
4. Required check only after repeated low missed-blocker and acceptable
   false-positive rates.

The product goal is not to replace human review. It is to make scope,
authority, missing tests and repair needs visible before merge.
