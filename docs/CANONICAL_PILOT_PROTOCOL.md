# Canonical supervised pilot protocol

This document freezes the pilot design before any live provider call. It is preparation only: no live pilot was run as part of this change, so it does not establish product-market fit, general quality, or production readiness.

## Scope and cohort

The initial recommendation is **at least 30 real, in-scope tasks across at least three JavaScript/TypeScript repositories** (10 or more tasks per repository). The cohort must be selected before execution and must include the supported scenarios: existing-function bug fixes, limited behavior changes in existing files, and regression tests added to existing test files. Unsupported work (new-file creation, deletion/rename, broad refactors, deployment, secrets, infrastructure, and repositories without a reproducible validation environment) is excluded and reported separately.

For every task freeze: repository URL and commit, task statement, original acceptance contract, policy/configuration hashes, validation profile, provider/model snapshot, and an approved per-task and total budget. Do not replace failed or inconvenient tasks after seeing outcomes; record exclusions with reasons.

## Measures

Each attempt is recorded, including no-change, rejection, timeout, recovery, and failure outcomes. Required measures are:

* setup time (task accepted to first planner checkpoint);
* operator intervention time and intervention reason;
* accepted-change rate (human-accepted patch / all eligible attempts);
* behavior success (all mandatory acceptance evidence, not merely structural or syntax checks);
* policy/scope compliance and safe-stop rate;
* observed, estimated, and unavailable token usage, provider calls, model price snapshot, and infrastructure cost separately;
* recovery outcome, duplicate-apply/rollback count, and data-loss incidents.

Reports show the full denominator and distinguish deterministic/offline fixtures from live provider evidence. A successful check is not equivalent to the user's requested behavior, and a high score on fewer than the frozen cohort cannot be generalized.

## Stop and decision rules

Stop the pilot for any acceptance-contract violation, unauthorized mutation, data loss, secret leak, missing/forged evidence, unsafe recovery, or attempted automatic continuation through a required human review. Pause for repeated provider ambiguity, budget accounting uncertainty, or unavailable validation tooling until an operator resolves it.

At the end, publish the complete attempt table, exclusions, incidents, costs, and confidence intervals chosen before analysis. “Product ready” is not an allowed conclusion without measured user benefit and explicit human sign-off; absent a real pilot, the only valid conclusion is “operations tooling and pilot preparation complete.”

## Operator workflow

1. Freeze the cohort and configuration, then obtain budget and reviewer approval.
2. Run each task in an isolated checkout using the canonical CLI in draft mode first.
3. Inspect status/receipt and validation evidence; apply only after the governed route and human decision permit it.
4. Record user acceptance and behavior outcome, not just tool completion.
5. Use the recovery runbook for crashes or drift; use retention dry-run reports before any deletion.
