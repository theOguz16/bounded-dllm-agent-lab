# Product Roadmap V1

## Status

This document describes the intended V1 productization target. It is a roadmap, not evidence that every listed capability already exists on `main`.

Current runtime/evidence truth remains owned by code, CI, and `evidence/index.json`. Product development must also follow [`PRODUCT_DEVELOPMENT_RULES.md`](./PRODUCT_DEVELOPMENT_RULES.md) and the existing V1 mutation boundary in [`PRODUCT_SCOPE_V1.md`](./PRODUCT_SCOPE_V1.md).

## Target user experience

The intended end-state is a developer-supervised CLI workflow shaped like:

```bash
npm install -g <package>

cd my-project

bounded init

bounded codex "refresh token expiration bugını düzelt"
```

The exact package name and final CLI command names are productization decisions and must not be inferred from this roadmap before they are implemented and released.

## Target bounded execution flow

```text
task
  ↓
read-only repository discovery
  ↓
scope proposal
  ↓
developer scope approval
  ↓
bounded repository context
  ↓
Codex
  ↓
candidate diff
  ↓
canonical mutation conversion
  ↓
deterministic verifier
  ↓
disposable validation
  ↓
optional targeted repair
  ↓
final diff + token/context report
  ↓
developer approval
  ↓
controlled apply
  ↓
receipt
```

The real repository must never be the agent's directly writable workspace. Agent execution, validation, and any targeted repair happen in disposable workspaces. Only a validated candidate plus the required developer authority may reach controlled apply.

## Compare mode target

The intended comparison command is shaped like:

```bash
bounded compare codex "refresh token expiration bugını düzelt"
```

It should evaluate, from the same source snapshot:

```text
Normal Codex
vs
Bounded Codex
```

Comparison results must distinguish runtime-observed facts from unavailable provider telemetry. If the provider does not expose a trustworthy inspection count, the report may state `filesExposed` while leaving `filesInspected` as `unavailable`.

Compare mode is a product benchmark/reporting surface. It must not modify frozen Gate 5/Gate 6 benchmark semantics or reinterpret historical research evidence.

## V1 supported work

V1 is intentionally narrow. The product target supports:

- a bug fix in an existing function;
- a small bounded behavior change in existing files;
- a regression assertion added to an existing test file;
- updates to existing regular UTF-8 text files that satisfy the current mutation contract.

These scenarios remain subject to explicit scope, repository policy, deterministic verification, scenario-specific behavioral evidence, developer review, and controlled apply.

## V1 unsupported work

V1 does not claim support for:

- creating new files through the runtime mutation contract;
- deleting files;
- renaming files;
- dependency installation required by a feature;
- database/schema migration;
- very large or repository-wide refactors;
- unattended production deployment;
- automatic merge or publish;
- treating a provider/MCP integration as the repository enforcement boundary.

A request that requires one of these capabilities must stop truthfully rather than approximate unsupported behavior.

## Existing contract boundary

`text-file-update/v1` is preserved as-is. Productization must not weaken or silently reinterpret its existing-file-only semantics or its source-hash, UTF-8, canonical-path, symlink, duplicate, size, stale-source, and related checks.

The following existing versioned contracts must likewise retain their current meanings unless a separately versioned successor is introduced:

- `bounded-task-receipt/v3`;
- `canonical-task-input/v4`;
- `canonical-policy-compiler/v2`.

## Product versus research boundary

Canonical product development is centered on:

```text
packages/product-runtime
packages/repo-intelligence
packages/integrations
canonical CLI
```

Research/history includes, at minimum:

```text
Gate 5
Gate 6
C / E / F / CE
frozen benchmark/provider inputs
oracle contracts
dLLM/remask benchmarks
ablation suites
historical Qwen experiments
```

Research results can inform product design, but they do not become product evidence automatically. Gate 5 or Gate 6 success must never be presented as proof that the V1 product is successful.

## Productization phases

### Phase 0 — Product foundation

Goal: make the product boundary explicit before adding user-facing behavior.

#### P0.1 — Product development boundary

Create and maintain:

```text
docs/PRODUCT_DEVELOPMENT_RULES.md
docs/PRODUCT_ROADMAP_V1.md
```

Update:

```text
README.md
docs/CURRENT_STATE.md
```

P0.1 is complete only when a developer can identify, without relying on historical benchmark context:

- where canonical product code belongs;
- which Gate 5/Gate 6 and dLLM/remask surfaces remain research-only;
- that MCP is an integration surface, not an enforcement boundary;
- that existing versioned contracts are not silently reinterpreted;
- that agents do not write directly to the real repository;
- that unknown states fail closed;
- that telemetry is never fabricated;
- that provider failure and runtime-safety success can coexist;
- that a product PR carries at least typecheck, build, and test evidence.

### Later phases

Later productization tasks should extend this roadmap rather than repurpose frozen research milestones. Expected areas include CLI onboarding, Codex integration, scope approval, bounded-context packaging, canonical diff/mutation conversion, validation/repair, comparison reporting, and controlled apply UX.

Each later task should remain small enough for an independent PR and must identify any new contract rather than changing existing schema meaning by implication.

## Product success boundary

V1 product success requires product-specific evidence: the requested behavior is satisfied, the exact authorized candidate passed deterministic controls and validation, the developer can review the final diff, and any real-repository mutation occurs only through controlled apply.

The following are insufficient by themselves:

```text
Gate 5 success
Gate 6 success
green fixture CI
provider returned a patch
typecheck alone
build alone
unrelated passing tests
```

Product behavior success and runtime safety/control evidence must remain separately reportable.
