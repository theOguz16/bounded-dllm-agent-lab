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

## Live authentication modes

Future P7.6 runs pin `gpt-5.6-luna` with reasoning `none`. The API model page documents `none` as a supported API reasoning value, but that does not prove the installed Codex CLI path or the selected account can use it. Preflight therefore requires the installed path to accept the exact configuration and forbids silent Sol fallback. Local API-key/login state is recorded only as present, never as proof of provider access.

The first provider access attempt requires an explicit workflow approval and has a one-invocation discovery budget. When no reliable free quota query exists, quota remains `unknown`; API pricing is not converted into a Plus allowance. Provider endpoint access is a separate policy from agent and validation network access, which remain disabled. A stable non-secret account alias is pinned for the run.

Provider failures are classified as `auth`, `quota`, `capacity`, or `unknown`. Auth and quota open a terminal circuit: subsequent invocation reservations are zero. Capacity and unknown remain distinguishable and are not mislabeled as quota. Diagnostics persist only bounded codes/hashes and never credentials, sessions, or tokens.

Manual `workflow_dispatch` supports exactly two authentication paths:

- `api_key`: runs on GitHub-hosted `ubuntu-latest` and requires `CODEX_API_KEY` or `OPENAI_API_KEY` in GitHub Actions secrets.
- `codex_home`: runs on a `self-hosted` runner and reuses the runner user's existing Codex/ChatGPT login state through `CODEX_HOME` or the default `~/.codex` directory. API-key environment variables are intentionally blank in this lane.

The benchmark does not require every user to own a separate API key. A self-hosted runner that is already authenticated with Codex can run P7.2 through `auth_mode=codex_home`.

Credential contents are not copied into the repository, Actions secrets, logs, or live evidence artifacts. The self-hosted preflight checks only whether usable local Codex auth state is available and carries forward the resolved Codex home path for the live runner.

The live workflow creates a redacted diagnostic before checkout or dependency preparation. Before any paid agent invocation it then verifies authentication, the exact configured model and provider reachability through `codex doctor`, runner OS/architecture identity, the npm lockfile, `npm ci` output, the built CLI, and the Codex CLI. A failed or skipped agent execution cannot satisfy the live completion gate. Interrupted runs retain a checkpoint: completed task pairs are not replayed, while an in-flight or failed invocation is treated as ambiguous and cannot be silently retried. Failures are recorded separately as `infrastructure`, `agent`, or `acceptance`.

## P7.2 live completion gate

P7.2 is complete only when `dogfood-live-gate.cjs` accepts the real live evidence artifact with all of these invariants:

```text
completedPairCount = 20
expectedAgentRuns  = 40
completedAgentRuns = 40

for every task:
  attempt = 1
  retryCount = 0
  pairCompleted = true
  result.comparable = true
  identityMismatchFields = []
  hiddenHintsInjected = false
  promptMutatedAfterFailure = false
```

A missing artifact, incomplete arm/pair, retry, identity mismatch, hidden hint, or prompt mutation fails the live completion gate. The PR must remain Draft until this gate passes on real evidence.

The live workflow is manually dispatched with an explicit `auth_mode` and exact model id. No PR close/reopen cycle is required.
