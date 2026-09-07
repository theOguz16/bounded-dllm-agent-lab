# Canonical runtime operations runbook

This runbook describes the supported operator actions for the single-machine canonical runtime. It is an operations aid, not a promise of independent review or production readiness.

## Inspecting a task

Use `bounded-agent status --task <task.json>` for the lifecycle state, stop reason, lease, persisted cost snapshot (when present), and the operator's next step. Use `bounded-agent inspect --task <task.json> --json` when hashes, attempts, artifact references, and repository bindings are needed. These commands do not call a provider and do not modify the repository. Their output is metadata and hashes; prompts, source snapshots, provider responses, and secrets are not part of the default operations view.

The state machine is authoritative. Do not edit `state.json`, lease files, or artifact JSON by hand. A terminal state is historical evidence; the current status must still be checked against repository drift before accepting it.

## Error and route handling

| Code/route | Meaning | Operator action |
| --- | --- | --- |
| `bounded_task_invalid` / `invalid_input` | Input, policy, authority, or validation contract is invalid | Correct the declared files or policy; start a new run. |
| `replan_required` | The requested change cannot be completed within the declared scope or minimality policy | Revise scope/plan and invoke `resume` explicitly. Automatic replan loops are not started. |
| `human_review_required` | Policy, risk, or evidence requires a human decision | Record the decision/evidence, then invoke `resume`; do not auto-apply. |
| `recovery_required` | Apply/validation/repository state is ambiguous or drifted | Inspect first, then invoke the supported `recover` path. Never delete user changes or retry an ambiguous provider call. |
| `provider_outcome_ambiguous` | A provider may have received a request but no durable response is present | Do not retry unless the provider's idempotency contract is verified. |
| `bounded_task_already_running` | A live lease owner exists | Wait for that run or contact its owner; takeover is not permitted while live. |
| `bounded_task_terminal_repository_drift` | A historical terminal result no longer matches the repository snapshot | Preserve the working tree and start a new task after review; no automatic rollback is performed. |
| `task_cost_budget_exhausted` | The next invocation cannot be reserved within the task budget | Increase the explicitly approved budget or stop; no provider call is started. |
| `bounded_task_retention_plan_mismatch` | A GC confirmation does not match the reviewed dry-run plan | Recreate and review a fresh dry-run plan. |

## Recovery and retention

Recovery is repeatable: it verifies durable bindings and writes recovery evidence before any repository write. A second invocation observes the first receipt and does not apply or roll back again. Active leases, non-terminal tasks, rollback/recovery/incident artifacts, and invalid records are protected from garbage collection.

Retention uses `planDurableBoundedTaskGarbageCollection` first. The v2 plan is dry-run-only and includes candidates, their durable `stateHash`, protected tasks, and invalid entries. An operator reviews that report, then passes the exact `planHash` to `applyDurableBoundedTaskGarbageCollection`. Apply recalculates the hash from the complete plan content (excluding only the self-hash field), acquires the task's lease-takeover boundary, and rechecks state immediately before deletion; a changed state, live lease, artifact set, or timestamp causes the entry to be skipped. Legacy v1 plans are rejected and must be regenerated rather than reinterpreted. Never run a broad filesystem cleanup against the registry.

## Stop conditions

Stop the pilot immediately for an acceptance-contract violation, unauthorized file or policy change, loss/corruption of durable evidence, user-data loss, an ambiguous provider outcome without idempotency, secret disclosure, or an unreviewed human-approval bypass. Preserve the registry and rollback evidence and open an incident record outside prompt/source logs.
