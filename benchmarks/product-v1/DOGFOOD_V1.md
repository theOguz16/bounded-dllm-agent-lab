# Product Dogfood V1 — First 20 Real Tasks

This suite replays twenty merged, real tasks from this repository against the exact commit immediately before each change.

Distribution:

- 5 bug fixes
- 5 behavior changes
- 5 regression-test additions
- 5 small multi-file changes

Each public task is a `product-task/v1` object stored in `tasks/dogfood/taskset.json`. Reference PR/head information is evaluator-only in `evaluator/dogfood-v1.hidden.json` and is never included in provider input.

For each task, one comparison invocation creates one fresh Normal workspace and one fresh Bounded workspace. Both arms use the same canonical task text, source commit, model, reasoning effort, validation configuration, timeout, and network policy.

Failure policy is fixed before execution:

- no arm retry;
- no prompt rewrite after a failure;
- no hidden evaluator hint;
- no oracle/reference patch in provider input;
- a failed task is recorded and execution continues to the next task.

`dogfood-smoke.cjs` validates the frozen plan without provider calls. `dogfood-runner.cjs --live` performs the real comparisons when live authentication and an explicit model id are configured.

The live report is evidence, not a success-only report: failed or non-comparable pairs remain in the output.

## P7.2 live completion gate

P7.2 is complete only when `dogfood-live-gate.cjs` accepts the real live evidence artifact with all of these invariants:

```text
completedPairCount = 20
expectedAgentRuns  = 40

for every task:
  attempt = 1
  retryCount = 0
  pairCompleted = true
  result.comparable = true
  identityMismatchFields = []
  hiddenHintsInjected = false
  promptMutatedAfterFailure = false
```

A missing artifact, incomplete pair, retry, identity mismatch, hidden hint, or prompt mutation fails the live completion gate. The PR must remain Draft until this gate passes on real evidence.

The live workflow supports manual dispatch. After the Actions environment has live authentication, supply the exact model as the dispatch input; no PR close/reopen cycle is required.
