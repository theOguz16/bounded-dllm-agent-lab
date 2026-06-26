# Product Proof

Bounded Agent Runtime is valuable when it turns agent risk into inspectable
artifacts before a human reviewer spends attention.

The current proof is not a broad production claim. It is a controlled evidence
stack:

## 1. Live Dogfood PR

The repository ran its own bounded review Action on a real pull request:

```text
PR #119: Sprint 17 public pilot readiness dogfood
```

Observed checks:

- bounded review: pass,
- verify: pass,
- GitGuardian: pass.

The first run caught a useful policy issue: a documentation phrase matched the
configured sensitive-pattern policy. The wording was changed and the rerun
passed. That is the point of the product: make scope, authority and boundary
signals visible before merge.

## 2. External Evidence Package

The external evidence command combines NanoID and p-limit pilot fixtures:

```bash
npm run product:external-evidence -- \
  --out-dir /tmp/bounded-agent-external-evidence \
  --fail-on-regression
```

It groups:

- real PR pilot results,
- reviewed cross-repo validation,
- mixed positive/negative controls.

The expected product signal is not "AI says approve." The signal is:

```text
Does the runtime catch policy-relevant blocker patterns without over-blocking reviewed safe PRs?
```

## 3. Consumer Pilot Handoff

The consumer handoff package tells a pilot user how to run artifact-only mode
first:

```bash
npm run product:pilot-manifest -- \
  --dogfood-dir /tmp/bounded-agent-dogfood-validation \
  --external-dir /tmp/bounded-agent-external-evidence \
  --out-dir /tmp/bounded-agent-pilot-handoff \
  --fail-on-missing
```

It produces:

- `pilot-handoff-manifest.json`,
- `pilot-handoff-manifest.md`.

A tiny consumer smoke repository skeleton can be generated with:

```bash
npm run product:consumer-smoke-kit -- \
  --out-dir /tmp/bounded-agent-consumer-smoke-kit
```

The actual GitHub repo/PR step requires GitHub write access. In this environment
the local kit can be generated, while remote repo creation depends on available
GitHub execution quota and credentials.

## 4. Provider Adapter Gate

The provider adapter path is opt-in. The live-test command reports credential
availability without serializing credential values:

```bash
npm run product:provider-live-test
npm run product:provider-live-test -- --live
```

If no provider credential is present, the report says `missing_provider_env`.
It does not fake a live success.

## What This Proves

- The runtime can run in GitHub Actions on a real PR.
- It produces review, comment, metrics and viewer artifacts.
- It has external fixture evidence beyond this repository.
- It has a handoff path for a first consumer pilot.
- Provider-backed model calls are separated from deterministic policy review.

## What It Does Not Prove Yet

- Production-scale organization ownership inference.
- Hosted dashboard readiness.
- Provider quality on private codebases.
- Automatic merge safety without human review.

Those are later pilot and productization questions.
