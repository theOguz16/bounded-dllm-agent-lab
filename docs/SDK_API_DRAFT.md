# SDK/API Draft

The runtime core is usable without a model provider.

## Core SDK

```ts
import {
  parseUnifiedDiff,
  reviewPatch,
  runMockOrchestration,
  analyzeRepositoryFiles,
  createTeamMetricsReport
} from "@bounded-dllm-agent-lab/product-runtime";
```

Primary entry points:

| Function | Use |
| --- | --- |
| `reviewPatch(input)` | Deterministic task + diff + policy review. |
| `runMockOrchestration(input)` | Multi-step bounded workspace mock flow. |
| `analyzeRepositoryFiles(files)` | Starter repo facts and policy suggestions. |
| `createCostTokenBenchmarkReport(fixtures)` | Compare context/cost flows. |
| `createTeamMetricsReport(artifacts)` | Aggregate review artifacts into team metrics. |

## Adapter Contract

External models should implement `RoleAdapter` for one role:

- `coder`,
- `verifier`,
- `remask`.

Adapter outputs are validated and written back to the workspace as claims or
proposals. The runtime keeps verifier, merge safety and final decision control.

## API Surface Draft

Future HTTP routes can mirror the SDK:

| Route | Body | Result |
| --- | --- | --- |
| `POST /review` | `ReviewInput` | `ReviewOutput` |
| `POST /orchestrate/mock` | `ReviewInput` | `OrchestrationOutput` |
| `POST /repo-intelligence` | `{ files: string[] }` | `RepoIntelligenceReport` |
| `POST /team-metrics` | `TeamMetricArtifact[]` | `TeamMetricsReport` |
