# Product Scope V1

## Status and hypothesis labels

This document is the product boundary for V1. It narrows the product goal; it
does not add runtime capability.

- **Verified repository finding:** the canonical runtime already represents
  bounded planning, model mutation validation, deterministic verification,
  controlled apply/validation, explicit stop routes, and versioned receipts.
- **Verified repository finding:** `text-file-update/v1` accepts updates to
  existing files and rejects create, delete, rename, mode-change, symlink, and
  binary operations.
- **Untested product hypothesis:** a developer maintaining a JavaScript or
  TypeScript repository will benefit from one local tool that plans, verifies,
  and, only under explicit authority, applies a small change while keeping the
  developer in control.
- **Not a validated market claim:** user demand, time saved, defect reduction,
  and willingness to pay have not been established by the repository evidence.

## Product hypothesis

V1 is a single-machine, developer-supervised tool for bounded changes in
JavaScript and TypeScript repositories. The developer supplies the task,
acceptance criteria, allowed existing files, repository policy, and verification
commands. The tool may plan and prepare an update, run deterministic gates, and
apply it only through the configured controlled-apply path. The developer owns
the final review and acceptance decision.

The intended value is narrower than “general coding agent”: make a small,
reviewable repository change with explicit scope, reproducible checks, and a
receipt that explains why execution completed or stopped. That value statement
is an **untested product hypothesis**, not an observed product outcome.

## Common task contract

Every supported scenario requires all of the following:

1. a local JavaScript or TypeScript repository that the runtime can inspect;
2. a concrete objective and observable acceptance criteria;
3. an allowlist of existing repository-relative files and applicable policy;
4. sufficient source and test context, or an explicit context-expansion route;
5. deterministic verification commands selected before apply; and
6. developer authority for any mutation and a developer review after delivery.

A task is bounded only when each proposed file is both existing and authorized,
the requested behavior can be expressed without an unsupported filesystem
operation, and the verification plan can distinguish the requested behavior
from an unrelated green build.

## Supported scenario 1: bug fix in an existing function

### Required inputs

- The existing implementation file and function or symbol that exhibits the
  defect.
- A reproducible failing example or an existing/newly expressible assertion
  that distinguishes the faulty and desired behavior.
- Expected behavior, allowed existing files, repository policy, and relevant
  typecheck/test commands.

### Allowed changes

- Update the smallest authorized region of the existing implementation file.
- Update an existing test file when the regression needs an executable proof.
- Do not add a file, rename an API, or broaden adjacent behavior unless that is
  separately authorized and still fits another supported scenario.

### Mandatory checks

- The original reproduction fails against the pre-change behavior or the
  equivalent defect is evidenced from the supplied code and assertion.
- Mutation schema, source hash, path, scope, policy, and deterministic verifier
  gates approve the exact update.
- Typecheck/build required by the repository and the targeted regression test
  pass after the candidate is applied in the controlled validation workspace.
- The regression assertion exercises the stated defect, not only module loading
  or process exit status.

### User delivery and measurable acceptance

Deliver the bounded plan, exact changed-file diff, verifier/apply receipt when
produced, commands and results, behavioral evidence, and any stop reason. The
scenario is accepted only when: the authorized diff contains no unrelated file;
the targeted reproduction passes after the change; all mandatory checks pass;
and the developer can review the change. A green typecheck or test suite without
the targeted behavioral proof is **checks passed, behavior unproven**, not
scenario success.

## Supported scenario 2: bounded behavior change in existing files

### Required inputs

- A before/after behavior statement with at least one observable example.
- The existing implementation files allowed to change and any existing tests or
  public contracts that constrain the behavior.
- Compatibility expectations, repository policy, and required verification
  commands.

### Allowed changes

- Update only authorized existing UTF-8 text files needed for the stated
  behavior.
- Preserve public API and stored-data meaning unless the task explicitly
  authorizes a compatible change that can be implemented with existing-file
  updates.
- Do not silently reinterpret existing durable records or receipts.

### Mandatory checks

- The plan maps every requested behavior to an authorized file and an observable
  acceptance criterion; ambiguity routes to replan or human review.
- Mutation, source-hash, scope, policy, deterministic verifier, and controlled
  validation gates approve the exact update.
- Targeted tests cover the changed behavior and a relevant unchanged behavior;
  repository-required typecheck/build/test commands pass.
- Any affected public API, durable state, or receipt format has an explicit
  compatibility decision and migration/versioning plan. If it cannot be made
  safely within V1, the task stops.

### User delivery and measurable acceptance

Deliver the bounded plan, exact diff, compatibility decision, check results,
behavioral evidence, receipt when produced, and review instructions. The
scenario is accepted only when every stated before/after example is covered by
passing evidence, one relevant non-target behavior remains passing, all changed
files are authorized and pre-existing, mandatory checks pass, and developer
review is possible. “No checks failed” does not itself prove the requested
behavior.

## Supported scenario 3: regression test in an existing test file

### Required inputs

- The defect or invariant to encode and the existing test file allowed to
  change.
- The system under test, expected assertion, repository policy, and the targeted
  test command.
- An explanation of how the test would fail for the known faulty behavior.

### Allowed changes

- Update the authorized existing test file only.
- Update an existing fixture file only when explicitly authorized and when the
  test cannot express the regression without it.
- Do not create a new test or fixture file under `text-file-update/v1`.

### Mandatory checks

- The new assertion is executed by the targeted test command and fails against
  the known faulty behavior, a reverted candidate, or a behaviorally equivalent
  negative fixture.
- Mutation, source-hash, scope, policy, and deterministic verifier gates approve
  the exact test-file update.
- The targeted test and repository-required typecheck/build checks pass with the
  intended implementation.
- The test is deterministic and asserts behavior rather than snapshots of
  incidental formatting, unless formatting is the contract under test.

### User delivery and measurable acceptance

Deliver the exact test diff, negative-proof method/result, commands and results,
receipt when produced, and review notes. The scenario is accepted only when the
assertion demonstrably detects the regression, passes with the intended
behavior, changes only authorized existing files, and all mandatory checks
pass. A test that passes both before and after without a justified negative
fixture does not meet this scenario.

## `text-file-update/v1` mutation boundary

The current mutation contract is replacement of the complete content of an
existing regular UTF-8 text file, guarded by its expected SHA-256 source hash.
The contract currently allows at most 32 files, 1 MiB per source or replacement,
and 4 MiB total. Identical replacement content is rejected as a no-op.

V1 does **not** support creating, deleting, or renaming files. It also rejects
mode changes, symlinks or symlink traversal, binary content, non-canonical paths,
duplicate file claims, and stale source hashes. Product copy and scenario
acceptance must not imply those capabilities. Creating this documentation file
is a repository maintenance action by a developer, not evidence that the
runtime can create files.

## Runtime and pipeline boundaries

### Canonical product runtime

`packages/product-runtime/src/canonical-runtime.ts`, its exported contracts, and
`runBoundedTask()` define the product runtime surface. Canonical repository
intelligence lives in `packages/repo-intelligence/`; provider and executor
adapters live in `packages/integrations/`. The canonical path owns bounded
planning, mutation validation, deterministic verification, controlled
apply/validation, governance routes, and versioned evidence/receipts. A
component existing in this path does not by itself prove end-to-end product
quality or production readiness.

### Legacy review pipeline

The `apps/cli` product review, PR calibration, artifact, comment, and historical
pilot commands are compatibility and evaluation surfaces from the earlier
patch/PR-review direction. They may consume or exercise repository artifacts,
but they are not the V1 runtime definition and are not an independent reviewer
that certifies a canonical run. V1 does not promise automatic independent review.

### Research and benchmark pipeline

Masking, dLLM/remask experiments, workers, fixtures, ablations, benchmark
reports, and evidence tools test research questions. Their status is governed by
`evidence/index.json`. Fixture or mock success is not observed provider evidence,
and research code is not a product capability until deliberately promoted into
the canonical runtime with compatible contracts and verification.

These three paths may share repository primitives, but their claims and
evidence must remain separate. Do not infer a product guarantee from a legacy
review decision or a benchmark result.

## Product meaning of outcomes

The runtime's existing route and receipt values retain their current contract
meaning; this document does not rename or reinterpret old durable records.

| Product state | Product meaning | Required next action |
| --- | --- | --- |
| Success | The exact authorized candidate passed contract/policy gates, required checks, and scenario-specific behavioral acceptance. Apply success, when requested, is bound to the validated candidate. | Deliver evidence for developer review; do not claim production readiness. |
| Validated no change | The acceptance criteria are demonstrably already satisfied and the no-change acceptance path records that fact. It is not a mutation success and cannot be inferred merely from identical content. | Deliver the evidence and explain why no repository change is required. |
| Human review required | Missing authority, ambiguous risk, policy rejection, or insufficient deterministic evidence prevents safe automatic continuation. | Preserve artifacts and ask the developer for a decision; do not present this as independent review completed. |
| Replan required | The objective, context, scope, acceptance mapping, or candidate must change before another attempt. | Produce a new bounded plan from current evidence; do not apply the rejected candidate. |
| Recovery required | Execution may have left an incomplete transaction or state that needs deterministic recovery. | Stop new mutation, preserve evidence, run the controlled recovery path, and require review if restoration cannot be proven. |

Two decisions are reported independently for every completion candidate:

1. **Control result:** whether schema, hash, scope, policy, typecheck, build, and
   selected tests passed.
2. **Behavior result:** whether scenario-specific evidence proves the user's
   requested behavior.

Only `control result = passed` together with `behavior result = satisfied` is
V1 scenario success. Either result may be `failed` or `not demonstrated`, and a
successful control result must never overwrite that distinction.

## Unsupported work and environments

V1 does not claim support for:

- greenfield features that need new files, file deletion/rename, generated
  assets, dependency installation, database/schema migration, or repository-wide
  refactoring;
- ambiguous “improve this repository” requests, large end-to-end features,
  autonomous backlog selection, or multiple concurrent writers;
- changes whose safe implementation requires a new public API version, silent
  durable-state reinterpretation, or an unapproved receipt-format migration;
- non-JavaScript/TypeScript repositories as a supported product promise, even
  if generic text machinery happens to read their files;
- distributed or multi-machine execution, unattended production operation,
  IDE/UI ownership, deployment, publish, merge, or production incident response;
- Docker-dependent, remote-provider, network, privileged, or paid live checks
  unless the developer explicitly supplies that environment and authority; and
- guaranteed semantic correctness, complete security, automatic repair of every
  failed candidate, independent review certification, or production readiness.

When a request crosses one of these boundaries, V1 must stop with a truthful
route and limitation rather than approximate unsupported behavior.

## Compatibility decision

The validation profiles `existing_function_bug_fix`,
`bounded_behavior_change`, and `regression_test_addition` require structural,
syntax, typecheck, and behavior-test evidence. Their commands run against a
disposable copy containing the candidate mutation. Missing configuration,
missing tools, or an interrupted command leaves the corresponding check
`not_run` and prevents a validated result.

The original acceptance contract is now preserved through governed apply and
recovery. New final receipts use `bounded-task-receipt/v3`, bind the original
acceptance contract/evaluation/specification hashes, and report structural,
syntax, typecheck, and behavior-test status independently. A check that was not
executed is `not_run`, never `passed`; draft-only success is explicitly
`structurally_verified_draft`. Exact historical `bounded-task-receipt/v1` and
`bounded-task-receipt/v2` records retain their old shapes and meanings.

Durable bounded-task state uses schema `4` with `canonical-task-input/v4`.
It binds trusted task/configuration inputs and stores starting and terminal
repository content snapshots separately. A terminal cache hit is reported as a
current validity assessment; if repository content drifts, the historical
receipt is retained separately and the runtime does not reapply or roll back.
Schema 3 and older task-input versions are explicitly rejected rather than
silently resumed under the stronger currentness semantics. `text-file-update/v1`
and the outcome/route names
`validated_no_change`, `replan_required`, `human_review_required`, and
`recovery_required` keep their code-defined meaning.

Canonical compiled policy artifacts now use `canonical-policy-compiler/v2`.
Version 1 compiled artifacts are rejected and must be recompiled from their
original policy source; they are not reinterpreted with v2 paired-file or
provider-preflight semantics. The bounded-task receipt schema remains v3, while
new receipts naturally bind the newly compiled policy hash. Existing durable
records remain schema 4, but a record bound to a v1 compiled-policy/task-input
hash fails the existing resume-binding check instead of being replayed.
