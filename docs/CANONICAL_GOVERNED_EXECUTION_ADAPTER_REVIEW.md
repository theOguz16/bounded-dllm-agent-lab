# Canonical Governed Execution Adapter Technical Review

Status: implemented for review as three independent surfaces (12A, 12B, 12C).

## 12A — Lossless conversion and real governance receipts

The adapter accepts only a validated `coder/patchDraft` mutation using `text-file-update/v1`. It produces a `remask/repairDraft` mutation. Every claim retains `claimVersion`, `operation`, `file`, `expectedContentHash`, `newContent`, and `description`; only the claim discriminator changes. Claim order and `touchedFiles` order are retained. A round-trip comparison, excluding the three required discriminators, is mandatory.

The adapter receipt binds task ID, objective hash, minimality plan hash, coder-context binding hash, planner execution binding hash, coder mutation hash, verifier finding hash, repair mutation hash, and a lossless payload hash.

The adapter no longer has an `artifactFor()` shortcut and does not substitute kind-name hashes for stage evidence. It runs the repair verifier, patch dry run, temporary apply, and containerized Phase V verifier, then records their actual receipt hashes in the accountability ledger. Planner and coder ledger events are also bound to their real execution-binding, plan, context, and mutation hashes.

The returned `governanceReceipts` package carries the validated coder verifier finding, repair-verifier finding, patch dry-run result, temporary-apply result, Phase V execution verification, final ledger, pre-Shadow trace, Shadow observation, deterministic governance assessment, Admin invocation-policy assessment, approval-route assessment, and the governed artifact produced by `buildGovernedChangeArtifact()`. The apply handoff consumes that same governed artifact.

## 12B — Governed execution

The execution layer creates real Phase V candidate evidence, then performs current repository inspection, governed artifact construction, handoff, rollback bundle materialization, execution authorization, context-to-apply binding, X.4 apply, and containerized X.5 validation. X.4 rechecks the authorized baseline after its permanent claim and before its first write. X.5 uses the existing sealed rollback and recovery path.

The apply freshness snapshot is rebuilt from independently validated sources rather than copied from the governed artifact. Mutation and changed-file fields come from the verified repair mutation; dry-run, temporary-apply, and execution fields come from their receipts; trace, observation, policy, route, and ledger fields come from their corresponding receipt objects. Those sources must reproduce the same governed artifact through `buildGovernedChangeArtifact()`, and `verifyGovernedChangeArtifactFreshness()` must classify the derived snapshot as current before handoff.

## 12C — Completion

Canonical completion requires the integrated coordinator’s finalized decision, current X.5 final receipt verification, approved final acceptance receipt, current repository state, and real X.4/X.5 receipts. A caller-provided hash is not completion evidence. No-change completion executes the same containerized acceptance specification against a read-only copy and verifies that repository inspection is unchanged.

Preparation and permanent execution are exposed as separately bound operations so a prepared receipt set can be revalidated immediately before apply. The negative E2E suite replaces governance hashes in the governance assessment, Admin invocation assessment, approval-route assessment, and governed artifact with well-formed SHA-256 values. Every variant is rejected before a rollback bundle, consumption-registry entry, validation workspace, or repository write is created.

## Review focus

Reviewers should confirm the discriminator-only mutation conversion, the receipt-to-ledger bindings, and that the governed artifact and apply handoff consume the same receipt objects returned by the adapter.
