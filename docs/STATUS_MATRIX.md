# Product Runtime Status Matrix

This document separates implemented, scaffolded, planned and research-only parts
of the bounded agent orchestration runtime.

The goal is to keep the product claim honest: the repository is not only a PR
reviewer, but the full bounded-context shared-workspace orchestration runtime is
still being built in phases.

<!--
Maintainer note:
Keep this document factual. If a module has a doc or type contract but no
end-to-end runtime behavior yet, mark it as "scaffolded", not "implemented".
-->

## Maturity Legend

| Status          | Meaning                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `implemented`   | Works through the current CLI/runtime path and produces artifacts.                                              |
| `scaffolded`    | Schema, contract, command, or partial behavior exists, but the module is not yet a complete product capability. |
| `planned`       | Roadmap item. Not expected to work as a current product capability.                                             |
| `research-only` | Used for experiments, benchmark design, or future model exploration.                                            |

## Core Runtime

| Module                      | Status        | Current Evidence                                                                         | Next Step                                                             |
| --------------------------- | ------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Task + diff + policy review | implemented   | `reviewPatch(input)` and product review CLI                                              | Keep as first integration surface, not the whole product.             |
| Policy engine               | implemented   | allowed paths, forbidden paths, paired files, sensitive patterns, ownership/module rules | Add stronger schema validation and clearer policy diagnostics.        |
| Deterministic verifier      | implemented   | Produces approve/refuse/reject/remask/human-review decisions                             | Keep verifier as runtime control layer.                               |
| SharedWorkspace v1          | scaffolded    | Workspace snapshot/events are produced in review artifacts                               | Promote workspace into the central mutable runtime state model.       |
| Bounded role views          | scaffolded    | Role-specific view artifacts exist                                                       | Stabilize planner/coder/verifier/tester/remask view contracts.        |
| Context Composer v1         | scaffolded    | Included/excluded facts and budget-style reports exist                                   | Make context selection a standalone deterministic module.             |
| Agent Orchestrator v1       | scaffolded    | Mock orchestration path exists                                                           | Define flow contracts, step permissions, and workspace writes.        |
| Conflict-aware merge        | scaffolded    | Merge/conflict records exist                                                             | Add explicit conflict ownership and unsafe overwrite tests.           |
| Remask engine               | scaffolded    | Verifier can request remask regions                                                      | Restrict repair to verifier-triggered failed regions.                 |
| Cost/token controller       | scaffolded    | Cost/token benchmark reports exist                                                       | Compare direct large-context vs bounded workspace flows consistently. |
| Repo intelligence           | scaffolded    | Repo file analysis and policy suggestions exist                                          | Turn this into starter policy generation for new repos.               |
| Model adapter layer         | scaffolded    | Provider-backed role adapter contracts exist                                             | Stabilize RoleAdapter output validation and workspace write contract. |
| dLLM-style verifier/remask  | research-only | Synthetic workspace packet experiments                                                   | Test whether masked repair helps verifier/remask roles.               |

## Product Surfaces

| Surface                | Status      | Current Evidence                                 | Next Step                                      |
| ---------------------- | ----------- | ------------------------------------------------ | ---------------------------------------------- |
| CLI                    | implemented | product review, policy, pilot, artifact commands | Simplify consumer-facing command flow.         |
| GitHub Action          | implemented | Action produces review/comment/index artifacts   | Keep artifact-only as safe default.            |
| PR comment publishing  | implemented | Marker-based comment update behavior             | Keep opt-in via repository variable.           |
| Static artifact viewer | implemented | `index.html` viewer output                       | Use as early dashboard foundation.             |
| SDK/API draft          | scaffolded  | SDK/API contract document exists                 | Separate stable SDK from experimental entries. |
| Hosted API             | planned     | Route draft only                                 | Build after core runtime contracts stabilize.  |
| Dashboard              | planned     | Team metrics artifacts exist                     | Build only after artifact schema stabilizes.   |
| IDE adapter            | planned     | Long-term surface                                | Do not prioritize before SDK/API.              |

## Research / Evidence Layer

| Area                               | Status        | Current Evidence                  | Next Step                                          |
| ---------------------------------- | ------------- | --------------------------------- | -------------------------------------------------- |
| Synthetic product pilots           | implemented   | Product pilot reports             | Keep as regression suite.                          |
| Real PR fixtures                   | implemented   | NanoID and p-limit style fixtures | Expand to more repos gradually.                    |
| Mixed positive/negative validation | implemented   | External evidence package         | Track false blocker and missed blocker separately. |
| dLLM direct patch benchmark        | research-only | Research reports                  | Do not make it a product dependency yet.           |
| dLLM-style remask benchmark        | planned       | Roadmap item                      | Evaluate only after remask contract is stable.     |

## Product Claim Boundary

Current safe claim:

```text
The runtime can deterministically review task + diff + policy inputs, produce
bounded workspace artifacts, detect policy/scope/authority risks, request local
remask regions, and generate CI/PR artifacts.
```

Claim to avoid for now:

```text
The runtime is a complete autonomous coding agent platform.
```

Target claim after the next core phases:

```text
The runtime orchestrates role-specific agents over a shared semantic workspace,
with bounded working memory, verifier-triggered remask, conflict-aware merge,
trace, and cost/token reporting.
```
