# P7.14 — executed behavior evidence (v3 work in progress)

**Status: partial implementation, not R03 closure, not a product release PASS.** Do not interpret a green schema test or a successful historical triad as evidence for all twenty dogfood tasks.

## Trust and source of truth

The frozen `product-behavior-evidence/v1`, `product-comparison-evaluation/v2` and existing `dogfood-v2.hidden.json` remain unchanged. The v1 evaluator verifies only syntax and hash *shapes*. Its user-supplied `passed: true` records are **not** an acceptance authority. Existing v2 reports are compatibility reports and must not be promoted to behavior-verified release claims.

The new `trusted-behavior-evidence/v2` verifier accepts a receipt only against **host-owned** task, source commit, actual source/reference/wrong/candidate workspace hashes, catalog hash and complete required criterion/check hash inventory. The caller must obtain that inventory and an HMAC key from outside agent-controlled data. Missing, malformed, missing-criterion, stale, forged, wrong-candidate, wrong-catalog and wrong-check receipts are `behaviorSatisfied: null`. A successfully authenticated triad with a genuinely failed candidate acceptance assertion is `false`. Human acceptance and general suite success never convert null or false into true. The comparison v3 derives product success from trusted behavior and the independent control/test/build/typecheck signals rather than trusting a supplied `taskSucceeded` flag.

The trusted historical check and its provider-blocking preload live in the evaluator checkout, **outside** the materialized candidate workspaces; only the program under test is materialized inside them. The Linux CI harness requires passwordless `sudo -u nobody` and executes the candidate without provider credentials; candidate files are runner-owned, non-writable by `nobody`. Any loss of this separation must fail closed rather than falling back to same-UID execution. `sudo` and this local isolation are **not** proof of network containment or defense against a compromised CI runner/host administrator. The HMAC key is ephemeral in the smoke; a production verifier requires host-managed durable key custody and independently pinned identities.

## Historical execution currently covered

The v3 demonstration catalog covers **1/20** supported dogfood tasks: `dogfood.v2.bugfix.failed-resume` at actual source `351aea5db624ecad05a2fc7b096629f61dd379aa` and reference `a83cf3618a87d8305db1424885acf704fff44a23`. A separate, deterministic wrong version removes the resume guard. One identical black-box checker exercises a failed checkpoint and a healthy checkpoint in source/reference/wrong/candidate workspaces. The expected historical failure is the **observed unsafe continuation to a blocked provider child**, not a missing dependency, non-zero exit alone or a declared `baseline: fail` field. The healthy checkpoint must reach the blocked child, proving the check is not a blanket refusal. The preload prevents real provider execution; no paid/live model call is authorized.

The runner writes raw, bounded execution records in a host-owned directory outside candidate workspaces and hashes their bytes into each criterion observation. The evidence receipt includes the real source/reference/wrong/candidate workspace content hashes, task hash, source/reference commit SHAs, catalog and check hashes, all required criterion identities, an issue time and a host-held HMAC. The offline test attempts missing evidence, missing criterion, forged result, stale receipt, different candidate, modified check, a no-op general suite, a deleted test and a spoof acceptance file in a candidate. Its per-criterion receipt is an execution artifact, not just a schema fixture.

## Not yet satisfied for R03 closure

- Execute and independently author behavior-specific checks for **every required criterion in all 20 tasks** (not the existing broad smoke commands), with real fail/pass/fail and per-criterion artifacts; drop or mark unsupported any historical source that already satisfies the asserted behavior.
- Connect the authenticated v3 verifier to the **canonical live dogfood runner/report/release decision**; do not let the legacy v2 evaluator's claimed success count as product success. Ensure fresh candidate hashes are obtained by the trusted workspace snapshotter, not passed through from the model.
- Persist verifiable host-side evidence and key management for auditing beyond this CI run; add candidate/process isolation and replay/nonce policy appropriate to the threat model.

Until those items pass and are reviewed, **P7.14/R03 remains BLOCKED**, regardless of whether the one-task smoke passes.
