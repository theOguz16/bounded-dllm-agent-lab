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

## 3. Run The Real PR Pilot

Use built-in samples:

```bash
npm run product:real-pr-pilot -- \
  --out-dir reports/product-runtime \
  --fail-on-regression
```

Use your own fixture JSON:

```bash
npm run product:real-pr-pilot -- \
  --input real-pr-cases.json \
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

## 5. Interpret Readiness

Readiness combines:

- decision accuracy,
- missed blocker rate,
- false positive rate,
- expected finding coverage,
- policy quality score.

This is not a security guarantee. It is a pilot-health signal.

## 6. Promote Carefully

Recommended rollout:

1. Artifact-only mode.
2. PR comment mode.
3. Warning-only branch protection.
4. Required check only after repeated low missed-blocker and acceptable
   false-positive rates.

The product goal is not to replace human review. It is to make scope,
authority, missing tests and repair needs visible before merge.
