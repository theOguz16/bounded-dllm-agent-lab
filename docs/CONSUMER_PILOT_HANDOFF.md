# Consumer Pilot Handoff

This is the handoff package for a team that wants to try the bounded agent
runtime on one real repository.

## Who This Is For

Use this handoff when the pilot team has:

- one repository with active pull requests,
- a maintainer who can edit `.github/workflows`,
- a reviewer who understands ownership and module boundaries,
- a small first PR that can run in artifact-only mode.

Do not use this as an automatic merge gate on day one.

## Pilot Setup

1. Read `docs/CONSUMER_SETUP.md`.
2. Copy or create `bounded-agent.policy.yml`.
3. Add the GitHub Action from `examples/github-actions/bounded-agent-review.yml`.
4. Run artifact-only mode on a low-risk PR.
5. Download the `bounded-agent-review` artifact.
6. Inspect:
   - `*-product-review.json`,
   - `*-product-review.md`,
   - `pr-comment.md`,
   - `product-report-index.md`,
   - `team-metrics.md`,
   - `index.html`.

To generate a tiny standalone consumer smoke repository skeleton:

```bash
npm run product:consumer-smoke-kit -- \
  --out-dir /tmp/bounded-agent-consumer-smoke-kit
```

The generated `consumer-smoke-kit.json` includes the GitHub commands for
creating a private smoke repo, opening a small docs PR and triggering the
bounded review Action.

The generated smoke workflow uses `fail-on: never` on purpose. The first
consumer run is an artifact/comment verification, not a merge gate. After the
team tunes `bounded-agent.policy.yml`, change it to `high` or `medium`.

## Evidence To Share Back

Ask the pilot user to share:

- the policy file with private paths redacted if needed,
- the decision and risk level from the first PR,
- whether the reviewer agreed with the finding,
- one false blocker example if any,
- one missed blocker example if any,
- whether `index.html` was readable enough for a reviewer.

## Handoff Manifest

Before the pilot kickoff, generate a local handoff manifest:

```bash
npm run product:dogfood-validation -- \
  --out-dir /tmp/bounded-agent-dogfood-validation

npm run product:external-evidence -- \
  --out-dir /tmp/bounded-agent-external-evidence

npm run product:pilot-manifest -- \
  --dogfood-dir /tmp/bounded-agent-dogfood-validation \
  --external-dir /tmp/bounded-agent-external-evidence \
  --out-dir /tmp/bounded-agent-pilot-handoff \
  --fail-on-missing
```

The manifest writes:

- `pilot-handoff-manifest.json`,
- `pilot-handoff-manifest.md`.

The product proof narrative is available in `docs/PRODUCT_PROOF.md`.

## First PR Recommendation

Start with a documentation or package metadata PR. Avoid a security, billing,
auth or deployment PR for the first run.

The first run should answer:

```text
Did the runtime produce a useful, inspectable artifact before human review?
```

It does not need to block or approve the PR automatically.

## Optional PR Comment

Keep PR comment posting off until the reviewer accepts the artifact quality.

Enable it later with:

```text
BOUNDED_REVIEW_POST_COMMENT=true
```

This updates one marker-based comment instead of creating a new comment on each
run.

## Provider Calls

Provider-backed adapters are optional. Run the deterministic policy flow first.
Only enable live provider calls after:

- policy paths are tuned,
- artifact-only review is understood,
- credential handling is approved by the pilot owner.

Live provider calls must stay opt-in with `dryRun: false`.

Use this command before enabling a real provider in a pilot:

```bash
npm run product:provider-live-test -- \
  --out-dir /tmp/bounded-agent-provider-test
```

Run with `--live` only after the pilot owner has provided credentials through
environment variables.

## Pilot Exit Criteria

A pilot can move to a broader trial when:

- three to five PRs ran in artifact-only mode,
- reviewers can read the HTML viewer without help,
- no credential value appears in artifacts,
- false blockers are understood and documented,
- missed blockers are investigated before widening scope.
