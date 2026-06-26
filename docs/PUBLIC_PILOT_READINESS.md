# Public Pilot Readiness

This document is the public pilot gate for the bounded agent product runtime.
It answers one question:

```text
Can a small team try this runtime on a real PR flow and understand the evidence?
```

## Current Status

The runtime is ready for a controlled public pilot, not a production rollout.

Ready:

- local bounded review artifacts,
- composite GitHub Action artifact contract,
- static artifact viewer,
- dogfood workflow validation,
- NanoID and p-limit external evidence package,
- provider adapter dry-run and opt-in OpenAI-compatible live-call path.
- consumer pilot handoff manifest.

Still manual:

- real GitHub-hosted PR action observation,
- consumer repo policy tuning,
- provider credential selection,
- human review of first pilot findings.

## Pilot Evidence Commands

Run the local gate:

```bash
npm run typecheck
npm run build
npm run test:smoke
```

Run the dogfood action contract:

```bash
npm run product:dogfood-validation -- \
  --out-dir /tmp/bounded-agent-dogfood-validation
```

This checks that the repository workflow and composite action agree on:

- review JSON/Markdown artifacts,
- PR comment artifact,
- report index,
- team metrics,
- static HTML viewer.

Run the external evidence package:

```bash
npm run product:external-evidence -- \
  --out-dir /tmp/bounded-agent-external-evidence
```

This combines:

- NanoID real PR pilot,
- p-limit real PR pilot,
- cross-repo reviewed validation,
- mixed external validation with negative controls.

Generate the consumer pilot handoff manifest:

```bash
npm run product:pilot-manifest -- \
  --dogfood-dir /tmp/bounded-agent-dogfood-validation \
  --external-dir /tmp/bounded-agent-external-evidence \
  --out-dir /tmp/bounded-agent-pilot-handoff \
  --fail-on-missing
```

## Live Dogfood PR Gate

A live dogfood PR should be small and documentation-first. The goal is not to
test a risky code path; the goal is to prove that GitHub-hosted PR review runs
and produces inspectable artifacts.

Expected PR checks:

```bash
gh pr checks <number> --repo theOguz16/bounded-dllm-agent-lab
```

Expected artifacts from the bounded review action:

- `*-product-review.json`,
- `*-product-review.md`,
- `pr-comment.md`,
- `product-report-index.json`,
- `product-report-index.md`,
- `team-metrics.json`,
- `team-metrics.md`,
- `index.html`.

PR comment posting is intentionally gated by:

```text
BOUNDED_REVIEW_POST_COMMENT=true
```

If the variable is not enabled, artifact-only mode is still considered a valid
pilot result.

## Provider Adapter Pilot Rule

Provider calls are opt-in.

Default:

```text
dryRun !== false
```

Live OpenAI-compatible call:

```text
dryRun: false
```

The live path must preserve these rules:

- credential values are never serialized into artifacts,
- request bodies include bounded task/diff/policy/workspace fields,
- provider JSON is validated before workspace mutation,
- HTTP errors, timeouts and malformed JSON return safe fallback output.

## Pilot Success Criteria

A public pilot is considered ready when:

- local typecheck, build and smoke pass,
- dogfood validation passes,
- external evidence package passes,
- pilot handoff manifest passes,
- live dogfood PR check status is recorded,
- consumer setup docs explain artifact-only and optional PR comment modes,
- provider live-call path stays opt-in and credential-safe.

## Pilot Narrative

The product is not trying to replace human review. It gives teams a bounded,
traceable layer for context, authority, ownership, remask repair and merge-risk
signals before a human reviewer spends attention.
