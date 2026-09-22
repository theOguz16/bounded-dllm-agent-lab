# P7.14 — executed behavior evidence (v3)

**Status: 20 tasks are executed, but only tasks with an observed source/reference/wrong
`assertion_fail/pass/assertion_fail` triad and a passing candidate are proven. The
suite is `not_pass` while any task is failed, blocked, or unknown.**

## Trust and source of truth

The frozen `product-behavior-evidence/v1`, `product-comparison-evaluation/v2` and existing `dogfood-v2.hidden.json` remain unchanged. The v1 evaluator verifies only syntax and hash *shapes*. Its user-supplied `passed: true` records are **not** an acceptance authority. Existing v2 reports are compatibility reports and must not be promoted to behavior-verified release claims.

The new `trusted-behavior-evidence/v2` verifier accepts a receipt only against **host-owned** task, source commit, actual source/reference/wrong/candidate workspace hashes, catalog hash and complete required criterion/check hash inventory. The caller must obtain that inventory and an HMAC key from outside agent-controlled data. Missing, malformed, missing-criterion, stale, forged, wrong-candidate, wrong-catalog and wrong-check receipts are `behaviorSatisfied: null`. A successfully authenticated triad with a genuinely failed candidate acceptance assertion is `false`. Human acceptance and general suite success never convert null or false into true. The comparison v3 derives product success from trusted behavior and the independent control/test/build/typecheck signals rather than trusting a supplied `taskSucceeded` flag.

The trusted historical checker and catalog live in the evaluator checkout, **outside** the materialized candidate workspaces. It evaluates the complete audited set of behavior-bearing files for each immutable source/reference pair. A wrong fixture restores the source version of one changed file, so multi-file partial implementations fail. The HMAC key is ephemeral in the smoke; a production verifier requires host-managed durable key custody and independently pinned identities.

## Historical execution covered

The v3 catalog executes all 20 dogfood-v2 tasks. Each variant is a full immutable
repository snapshot, dependencies are prepared with `npm ci`, and validation is
run inside an OS network sandbox. The reference file bytes are never used as the
acceptance oracle. Task-specific assertions execute build/runtime behavior; trusted
later regression tests may be overlaid as hidden assertions and are hashed into the
check identity. A reference that does not build or does not exhibit the behavior is
recorded as failed, never promoted because its bytes match a historical patch.

The runner writes 100 raw bounded execution records (five per task) in a host-owned
directory outside candidate workspaces. Each record includes dependency preparation,
OS network-isolation canary, build, assertion, exit status, bounded stdout/stderr and
hashes. Missing, partial, forged, stale, cross-candidate, unisolated and wrong-
implementation cases cannot pass. An unavailable OS sandbox is `blocked`; an
executed behavior mismatch is `assertion_fail`.

## Remaining production integration limits

- Connect the authenticated v3 verifier to the **canonical live dogfood runner/report/release decision**; do not let the legacy v2 evaluator's claimed success count as product success. Ensure fresh candidate hashes are obtained by the trusted workspace snapshotter, not passed through from the model.
- Persist verifiable host-side evidence and key management for auditing beyond this CI run; add candidate/process isolation and replay/nonce policy appropriate to the threat model.

Until those integration items pass and are reviewed, historical 20/20 coverage must not be presented as a release decision.
