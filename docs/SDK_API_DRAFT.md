# SDK/API Draft

The runtime core is usable without a model provider.

## Stability Notes

The SDK surface is split into three maturity levels:

| Level | Meaning |
| --- | --- |
| `stable` | Safe for consumer setup and artifact-based workflows. |
| `experimental` | Available for local experiments, but the contract can change. |
| `planned` | API shape is documented, but no hosted route is guaranteed yet. |

Current stable SDK entries:

- `reviewPatch(input)`
- `parseUnifiedDiff(input)`
- `createTeamMetricsReport(artifacts)`
- `createProductRuntimeArtifactV1(review)`

Current experimental SDK entries:

- `runMockOrchestration(input)`
- `analyzeRepositoryFiles(files)`
- `createCostTokenBenchmarkReport(fixtures)`
- `createProviderBackedRoleAdapter(config)`
- `executeOpenAiCompatibleRoleAdapter(config, input, fetchImpl?)`

Planned HTTP routes should mirror the SDK only after the runtime contracts are
stable.

## Core SDK



```ts
import {
  parseUnifiedDiff,
  reviewPatch,
  runMockOrchestration,
  analyzeRepositoryFiles,
  createTeamMetricsReport,
  createProviderBackedRoleAdapter,
  createSecretSafeProviderConfigSummary,
  createProviderAdapterChatRequest,
  executeOpenAiCompatibleRoleAdapter
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
| `createProviderBackedRoleAdapter(config)` | Create a provider-backed role adapter with validated output and safe fallback behavior. |
| `createSecretSafeProviderConfigSummary(config)` | Document provider config without leaking API keys or credentials. |
| `createProviderAdapterChatRequest(config, input)` | Build the OpenAI-compatible request body without serializing API keys. |
| `executeOpenAiCompatibleRoleAdapter(config, input, fetchImpl?)` | Execute an opt-in live provider call and return validated output or safe fallback. |

## Adapter Contract

External models should implement `RoleAdapter` for one role:

- `coder`,
- `verifier`,
- `remask`.

Adapter outputs are validated and written back to the workspace as claims or
proposals. The runtime keeps verifier, merge safety and final decision control.

Provider-backed adapters must keep secrets outside artifacts. Config summaries
store the env var name, model and redacted base URL, but never the API key value.
The runtime validates `RoleAdapterOutput` before claims, patch plans, verifier
findings or remask regions are written back to the workspace.

Live calls are opt-in with `dryRun: false`. The default path stays deterministic
so CI, smoke tests and artifact generation remain reproducible without provider
credentials.

## CLI Surface

| Command | Use |
| --- | --- |
| `npm run product:demo-package` | Generate a complete local demo package. |
| `npm run product:artifact-viewer` | Render review/index/team metrics artifacts to static HTML. |
| `npm run product:action-smoke` | Validate the GitHub Action artifact contract locally. |
| `npm run product:dogfood-validation` | Validate the repository dogfood workflow and action artifact contract. |
| `npm run product:external-evidence` | Build a combined NanoID/p-limit external evidence package. |

## API Surface Draft

Future HTTP routes can mirror the SDK:

| Route | Body | Result |
| --- | --- | --- |
| `POST /review` | `ReviewInput` | `ReviewOutput` |
| `POST /orchestrate/mock` | `ReviewInput` | `OrchestrationOutput` |
| `POST /repo-intelligence` | `{ files: string[] }` | `RepoIntelligenceReport` |
| `POST /team-metrics` | `TeamMetricArtifact[]` | `TeamMetricsReport` |
| `POST /adapter/provider/dry-run` | `ProviderBackedRoleAdapterConfig` | `SecretSafeProviderConfigSummary` |
