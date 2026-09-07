# Canonical CLI

The canonical CLI is the supported command-line entry point for the bounded product runtime. It does not invoke the legacy review or benchmark pipelines.

## Install and run

From a clean checkout, install dependencies and build once:

```sh
npm install
npm run build
```

Start the example-shaped task with one command:

```sh
npm run canonical -- run --task ./task.json
```

`mode` defaults to `draft`. Draft mode never applies the proposed mutation to the source repository. `governed` must be selected explicitly and requires a validation file with governed workspace directories and a running Docker daemon.

## Commands

```text
bounded-agent run     --task task.json [--json]
bounded-agent status  --task task.json [--json]
bounded-agent inspect --task task.json [--json]
bounded-agent resume  --task task.json [--json]
bounded-agent recover --task task.json [--json]
```

- `run` starts the durable task through the public canonical `runBoundedTask` API.
- `status` reads only the durable state summary. It does not read provider settings, call a provider, or write the repository.
- `inspect` reads the durable state and its hash/reference metadata. It does not read artifact contents, call a provider, or write the repository.
- `resume` uses the canonical idempotent resume path. A current terminal success is returned without another provider call or apply.
- `recover` explicitly invokes the same durable reconciliation entry point. It never performs an automatic retry loop.

A `replan_required` result exits and tells the user to revise the task or scope before explicitly resuming. The CLI does not recursively replan.

## Validated file formats

Unknown fields and unsupported schema versions are rejected. Paths in the task file are resolved relative to that file.

### Task file

```json
{
  "schemaVersion": "canonical-cli-task/v1",
  "taskId": "fix.calculate",
  "objective": "Fix calculate for negative input.",
  "repositoryPath": "./repository",
  "seedFiles": ["src/calculate.ts"],
  "allowedChangeFiles": ["src/calculate.ts"],
  "forbiddenFiles": ["package.json"],
  "requiredSymbols": ["calculate"],
  "requiredTestFiles": ["test/calculate.test.ts"],
  "policyFile": "./repository/bounded-agent.policy.yml",
  "acceptanceFile": "./acceptance.json",
  "providerFile": "./provider.json",
  "durable": {
    "registryRoot": "./state",
    "idempotencyKey": "fix.calculate.v1"
  }
}
```

Optional fields are `mode`, `validationFile`, `costBudget`, and `timeoutMs`. `mode` is `draft` when omitted. Initial prompt evidence is limited to the declared seed and required-test files: at most 512 KiB per file and 2 MiB total. Repository intelligence may inspect a bounded dependency graph, but it does not copy the whole repository into the planner or coder prompt.

`costBudget` is a task-wide reservation guard, not a provider-guaranteed monetary cap:

```json
"costBudget": {
  "maxProviderCalls": 4,
  "maxEstimatedTokens": 20000,
  "maxCostNanoUsd": 5000000,
  "providerId": "provider.example",
  "modelId": "provider-model-name",
  "inputNanoUsdPerToken": 2,
  "outputNanoUsdPerToken": 8,
  "reservedOutputTokens": 4096
}
```

Reservations cover planner, context expansion, coder, and retry operations in one durable task snapshot. Before a runtime provider invocation, input tokens are conservatively estimated as `ceil(UTF-8 byte length of canonical JSON provider context / 4)` and recorded with estimator ID `canonical-json-utf8-bytes-div-4/v1`; this estimate is not provider-observed usage. Reusing an invocation identity during resume does not double-count it. After the response, provider-reported usage is recorded separately as `observed` and reconciled against the reservation. Missing usage is `unavailable` and retains the estimate for budget accounting instead of becoming zero. The budget configuration is part of durable task identity, so resume cannot remove or replace it to bypass prior spending. Provider/model/pricing snapshots are kept separate from Docker or other infrastructure cost, and a timeout or connection loss remains cost-uncertain when the provider cannot say whether it processed the request. A budget stop happens before the next provider call and requires explicit user action; it does not silently retry.

### Acceptance file

```json
{
  "schemaVersion": "canonical-cli-acceptance/v1",
  "criteria": [
    {
      "id": "calculate_test",
      "description": "The calculate regression test passes.",
      "required": true,
      "evidence": { "kind": "test", "commandId": "test.calculate" }
    }
  ]
}
```

The original criteria become the canonical acceptance contract. A governed run must supply matching validation evidence; an unrelated successful command is insufficient.

### Provider file

```json
{
  "schemaVersion": "canonical-cli-provider/v1",
  "kind": "openai-compatible",
  "endpoint": "https://provider.example/v1/chat/completions",
  "model": "provider-model-name",
  "apiKeyEnv": "MODEL_API_KEY",
  "apiKeyRequired": true,
  "timeoutMs": 60000,
  "maxOutputTokens": 4096
}
```

The credential value must be supplied through the named environment variable; it is never stored in the JSON file, printed, or included in CLI results. Local unauthenticated OpenAI-compatible endpoints may set `apiKeyRequired` to `false` and omit `apiKeyEnv`. Planner and coder responses are read as bounded streams (currently at most 1 MiB), transport timeout/cancellation aborts the read, and exactly one choice with `finish_reason: "stop"` is required. Truncated (`length`), filtered, incomplete, malformed, and oversized coder responses cannot produce a draft receipt.

### Validation file

```json
{
  "schemaVersion": "canonical-cli-validation/v1",
  "profile": "existing_function_bug_fix",
  "containerRuntime": "docker",
  "executionSpecification": {
    "allowedExecutables": ["npm"],
    "commands": [
      {
        "id": "test.calculate",
        "checkKind": "behavior_test",
        "executable": "npm",
        "args": ["test", "--", "test/calculate.test.ts"]
      }
    ]
  },
  "governed": {
    "registryDirectoryPath": "./runtime/apply-registry",
    "rollbackBundleParentPath": "./runtime/rollback",
    "validationWorkspaceParentPath": "./runtime/validation"
  }
}
```

Draft execution validation may use another installed container runtime. Governed mode currently supports Docker only. A missing runtime/daemon fails before any provider call.

The profile name must be one of the runtime's canonical identifiers: `structural_draft`, `existing_function_bug_fix`, `bounded_behavior_change`, or `regression_test_addition`. Earlier CLI-only aliases such as `limited_behavior_change` and `existing_test_regression` are invalid and are not translated to a different durable meaning.

## Output and exit codes

Human-readable output is the default. `--json` emits exactly one JSON object. Both formats contain bounded summaries and hashes, not prompts, source contents, provider responses, or credentials.

| Code | Meaning |
| ---: | --- |
| `0` | Completed command or successful read-only inspection |
| `2` | Invalid command, configuration, task input, or runtime result |
| `3` | Explicit replan or human-review stop |
| `4` | Recovery/reconciliation is required |
| `5` | Provider credentials, provider transport, or validation environment unavailable |

The receipt’s structural/validation outcome remains distinct from task behavior satisfaction. In particular, `structurally_verified_draft` means executable validation was not claimed unless its evidence says otherwise.
