# Product Development Rules

## Purpose

This document is the canonical development boundary for product work in this repository. It exists to prevent productization changes from silently modifying research semantics, benchmark inputs, or legacy evidence.

Documentation does not create product capability. Runtime behavior remains defined by code and CI on `main`, and experiment/evidence status remains defined by `evidence/index.json`.

## Canonical product development surface

New product work belongs in the following surfaces unless a task explicitly documents a compatible promotion path:

- `packages/product-runtime/` — canonical runtime contracts, orchestration, deterministic verification, governed execution, outcomes, and receipts;
- `packages/repo-intelligence/` — canonical repository discovery and bounded repository-intelligence primitives;
- `packages/integrations/` — provider, executor, and external integration adapters;
- the **canonical CLI** documented in [`CANONICAL_CLI.md`](./CANONICAL_CLI.md) and the code required to implement those commands.

The current repository contains canonical CLI wiring under `apps/cli`, but the entire `apps/cli` tree is not therefore a product surface. Historical review, benchmark, calibration, report, and experiment commands in that tree remain legacy/evaluation surfaces unless deliberately promoted.

Product code may consume stable, explicitly exported primitives from elsewhere in the repository. That does not make the source area canonical product code.

## Research and historical surfaces

The following remain research or historical evaluation surfaces and are not to be rewritten as part of product implementation:

- Gate 5;
- Gate 6;
- Gate 6 C / E / F / CE strategies and escalation experiments;
- frozen benchmark/provider inputs;
- oracle contracts;
- historical Qwen experiments;
- dLLM and remask benchmarks/workers;
- masking, ablation, synthetic-context, shared-workspace, and comparative research suites;
- historical benchmark reports and retained observed artifacts.

Research code can motivate product work, but research success is not product success. In particular:

```text
Gate 5 success != product success
Gate 6 success != product success
fixture success != observed product behavior
benchmark advantage != product capability
```

A research primitive may enter the product surface only through an explicit product change with its own contract, compatibility decision, deterministic verification, and product acceptance evidence. Do not achieve productization by changing frozen research semantics in place.

## MCP and integration boundaries

MCP is an integration surface, not an enforcement boundary.

An MCP server, plugin, provider adapter, or other external integration may expose capabilities to the runtime, but it must not be trusted to enforce repository authority. Product safety properties must be enforced by canonical runtime contracts and deterministic controls owned by the bounded runtime.

An integration must not gain direct write authority to the developer's real repository merely because it can read, call tools, or return a candidate mutation.

## Contract compatibility

Existing versioned contracts must not be silently reinterpreted or broken for product convenience. This includes, at minimum:

- `text-file-update/v1`;
- `bounded-task-receipt/v3`;
- `canonical-task-input/v4`;
- `canonical-policy-compiler/v2`.

If a new product requirement cannot be represented without changing the meaning or shape of an existing version, create a new versioned contract and define the compatibility/migration behavior explicitly.

Historical durable records retain the meaning of the schema version under which they were created.

## Repository write boundary

No agent receives the real repository as a directly writable workspace.

The intended product path is:

```text
read-only repository discovery
-> bounded scope/context
-> agent execution in a disposable workspace
-> candidate mutation
-> canonical mutation conversion
-> deterministic verification
-> disposable validation
-> developer review/approval
-> controlled apply to the real repository
-> receipt
```

A provider, coding agent, MCP integration, validation runner, or repair step may operate only inside the authority given to its disposable workspace. Real-repository mutation must pass through the canonical controlled-apply path after the exact candidate has been validated and the developer has granted the required authority.

## Existing-file V1 mutation boundary

`text-file-update/v1` remains unchanged. V1 product work must preserve its existing-file-only boundary and its source-hash, canonical-path, UTF-8, symlink, duplicate, size, stale-source, and related checks.

V1 product documentation and code must not imply support for file creation, deletion, rename, dependency installation, migration, or other unsupported mutation classes through this contract.

## Fail-closed rule

Unknown or insufficiently evidenced states do not become guesses, inferred success, or silent retries. Product flows must terminate or route explicitly through one of the applicable canonical outcomes, including:

```text
replan_required
human_review_required
recovery_required
candidate_rejected
```

Do not invent a success route merely to keep an agent loop moving.

## Telemetry truthfulness

Report only telemetry that the runtime can actually observe or derive under a named deterministic estimator.

For example, if a provider does not reliably disclose which files it inspected, report:

```text
filesExposed: 17
filesInspected: unavailable
```

Do not report fabricated inspection counts, token counts, costs, model actions, or validation results. Estimated and provider-observed values must remain distinguishable.

## Provider outcome versus runtime safety

Provider failure and runtime safety are separate dimensions.

If an agent produces an invalid, unsafe, out-of-scope, or nonsensical candidate and the runtime rejects it correctly, report the distinction rather than collapsing both into one failure:

```text
agent outcome = failed
runtime safety = passed
```

A rejected candidate is not a product behavior success, but correct rejection is evidence that a runtime safety control worked as designed.

## PR and validation discipline

Product development should be reviewable in small, independent pull requests. Each task should be small enough to be understood and reverted without unrelated changes.

Before merge, the minimum repository checks are:

```bash
npm run typecheck
npm run build
npm test
```

Task-specific deterministic smoke tests or documentation guards must be added when the change introduces a new invariant that the existing suite does not protect.

A provider/live experiment is not required merely to merge a deterministic product-maintenance change unless the task specifically changes a provider-facing behavior that requires such evidence.

## Developer checklist

Before changing a file for product work, verify:

1. Is this file part of the canonical product surface, or is there an explicit promotion reason?
2. Does the change preserve frozen Gate 5/Gate 6 research semantics and historical provider/oracle inputs?
3. Does it preserve existing schema meaning, or introduce a new versioned contract instead?
4. Can every agent mutation occur in a disposable workspace rather than the real repository?
5. Are unknown states routed fail-closed?
6. Is every reported metric observable, derived, or explicitly unavailable?
7. Are provider quality and runtime safety reported separately?
8. Can the change be reviewed as one bounded PR with typecheck, build, and test evidence?

If any answer is unclear, stop product implementation and require `replan_required` or `human_review_required` rather than modifying the research boundary by assumption.
