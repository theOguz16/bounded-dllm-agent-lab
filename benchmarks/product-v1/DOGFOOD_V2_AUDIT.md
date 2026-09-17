# Product V1 dogfood v2 scope audit

The original `product-v1-first-20-real-dogfood` files are retained unchanged for historical reproducibility. The v2 suite is a new selection constrained to Product V1's existing-file update boundary.

Selection rules:

- source and reference are immutable 40-character commits;
- every reference diff contains only `M` operations against paths already present at source;
- dependency additions, file creation/deletion/rename and broad feature scaffolding are excluded;
- each public criterion has exactly one separately stored hidden evidence check;
- hidden checks are not included in provider input or mutable candidate scope;
- each check records the audited triad: source fails for the expected missing behavior, reference passes, and incomplete/wrong behavior fails;
- validation uses Node 22, `npm ci`, and disabled network.

Fifteen original tasks require at least one added file and are listed in `unsupported-v1.json`. They remain valid historical research tasks, but are not Product V1 success candidates.

The v2 main set contains exactly five small bug fixes, five existing-file behavior changes, five changes to existing regression files, and five small multi-file existing-file changes.

## Original 20 task decisions

Each decision below was derived from the immutable source/reference diff in the v1 task and evaluator catalogs. `Supported` means every changed path already exists at the source commit and every operation is `M`. `Unsupported` means the reference solution contains at least one `A` operation, which is outside the Product V1 existing-file-only contract.

| Original task | Decision | Recorded reason |
| --- | --- | --- |
| `dogfood.bugfix.timestamp-leakage-false-positive` | Supported | Only modifies the existing oracle audit and contract smoke files. |
| `dogfood.bugfix.runpod-error-classification` | Unsupported | Adds `scripts/runpod-openai-compatible-model-client-error-smoke.cjs`. |
| `dogfood.bugfix.runpod-bootstrap-review-sentinels` | Supported | Only modifies the existing RunPod bootstrap smoke. |
| `dogfood.bugfix.bounded-review-policy-precision` | Supported | Only modifies existing fixture, policy, runtime, and contract files. |
| `dogfood.bugfix.gate5-distinct-contexts` | Supported | Only modifies the existing Gate 5 ablation runner. |
| `dogfood.behavior.bounded-init-local-config` | Unsupported | Adds init, doctor, product-config, and smoke files and introduces broad command scaffolding. |
| `dogfood.behavior.bounded-doctor-diagnostics` | Supported | Only modifies existing doctor, output, and smoke files. |
| `dogfood.behavior.codex-explicit-scope` | Unsupported | Adds the Codex command and a new explicit-scope smoke. |
| `dogfood.behavior.codex-scope-discovery` | Unsupported | Adds command, provider, contract, and smoke files. |
| `dogfood.behavior.human-approved-apply` | Unsupported | Adds candidate handoff, apply command, and apply smoke files. |
| `dogfood.regression.acceptance-chain-smoke` | Unsupported | Adds the acceptance-chain smoke file. |
| `dogfood.regression.gate5-live-ablation-contract` | Unsupported | Adds a workflow and the Gate 5 runner. |
| `dogfood.regression.external-repository-runner` | Unsupported | Adds a workflow and external-repository runner. |
| `dogfood.regression.hidden-oracle-harness` | Unsupported | Adds a workflow and hidden-oracle harness. |
| `dogfood.regression.gate6-task-schema` | Unsupported | Adds the Gate 6 schema library and its test. |
| `dogfood.multifile.local-run-artifact-format` | Unsupported | Adds artifact-store runtime and smoke files, crossing into new subsystem scaffolding. |
| `dogfood.multifile.report-history` | Unsupported | Adds history and report commands. |
| `dogfood.multifile.agent-comparison-contract` | Unsupported | Adds the comparison contract and its smoke. |
| `dogfood.multifile.twin-workspace-comparison-runner` | Unsupported | Adds the comparative runner and its smoke. |
| `dogfood.multifile.product-comparison-evaluator` | Unsupported | Adds the product comparison evaluator and its smoke. |

The five supported historical tasks are retained in v1 for reproducibility, but v2 is a separately versioned, balanced selection rather than an in-place rewrite of v1. This avoids silently changing historical benchmark identities while meeting the required `5/5/5/5` Product V1 distribution.
