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

`dogfood-smoke.cjs` validates the frozen plan without provider calls. `dogfood-runner.cjs --live` performs the real comparisons when Codex authentication and an explicit model id are configured.

The live report is evidence, not a success-only report: failed or non-comparable pairs remain in the output.
