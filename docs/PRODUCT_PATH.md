# Product Path

The current V1 direction is defined in
[`PRODUCT_SCOPE_V1.md`](./PRODUCT_SCOPE_V1.md). It replaces the earlier broad
“general coding agent” and patch/PR-review positioning with one testable product
hypothesis:

> **Untested product hypothesis:** a developer supervising a single local
> JavaScript or TypeScript repository benefits from a tool that plans, verifies,
> and controllably applies small updates to existing files.

This is not a validated market claim. Repository evidence establishes contract
and fixture behavior, not demand, productivity improvement, semantic
correctness, or production readiness.

## Research artifact

Schemas, fixtures, evaluators, reports, mock engines, model adapters, and
benchmark commands test whether the architecture is worth pursuing and how
agent behavior changes under bounded context.

Example:

```bash
bounded-agent eval --suite scope-drift
bounded-agent run --case correction-001
```

They do not define the product runtime and mock/fixture results are not live
product evidence. Experiment status remains owned by `evidence/index.json`.

## Canonical product runtime

The canonical runtime is the post-v0.1 surface exported by
`packages/product-runtime/src/canonical-runtime.ts`, with canonical repository
intelligence and integration packages.

It currently provides contracts and paths for:

- bounded repository context and planning,
- versioned existing-text-file mutation claims,
- deterministic scope/policy/verification gates,
- controlled apply and validation,
- explicit replan, human-review, and recovery routes, and
- versioned receipts and evidence bindings.

The runtime is a prototype. The presence of these paths does not establish
automatic repair, independent review, or production readiness.

## Legacy review pipeline

Earlier `apps/cli` review, PR calibration, comment, artifact, and pilot commands
remain compatibility/evaluation surfaces. They are not the canonical runtime,
and a legacy review decision does not independently certify a V1 task.

## V1 supervised tool

The first product is not a full IDE, Cursor replacement, autonomous software
engineer, or generic PR reviewer. It supports three bounded scenarios:

1. fix a bug in an existing function;
2. make a limited behavior change in existing files; and
3. add a regression assertion to an existing test file.

Each scenario has measurable inputs, allowed changes, mandatory controls,
behavioral proof, and delivery artifacts in `PRODUCT_SCOPE_V1.md`. The product
remains model-agnostic:

```text
Bring your own coder model.
The runtime provides workspace, bounded working memory, policy, verification,
trace, remask and merge-decision control.
```

This keeps the product realistic. The research may continue testing dLLM-style
verifier/remask workers, but the MVP should not depend on dLLM maturity.

## Repair and remask boundary

Remask should not be a default second pass for every AI patch.

The product should call remask only when the verifier finds a safe, repairable
partial failure:

| Verifier finding | Product action |
| --- | --- |
| Patch is complete and in scope | Approve |
| Product, owner, platform, or compliance decision is missing | Refuse |
| Patch touches forbidden files or unsafe scope | Reject |
| Patch is in scope but misses a required paired file, type, schema, test, or metadata region | Remask |
| Patch output contract is invalid | Retry or fail closed, depending on policy |

The canonical product loop is:

```text
task + policy + bounded context -> plan -> candidate update -> deterministic verification -> controlled validation -> deliver | replan | human review | recovery
```

Remask remains conditional research/runtime machinery, not a promise that the
tool automatically repairs every failed candidate.

## What The MVP Should Not Do First

The MVP should not try to:

- replace Cursor, Windsurf, Codex, or Claude Code,
- own the whole IDE experience,
- generate large features end to end,
- claim that dLLMs are universally better coders,
- require a specific model provider,
- solve every security or compliance problem.

The V1 surface should do one thing well:

```text
Prepare and verify a small, authorized existing-file change for developer review.
```

Success requires two distinct results: required controls passed, and the user's
requested behavior was demonstrated. A green build without scenario-specific
evidence is not product success. A validated no-change result, human-review
route, replan route, or recovery route is a truthful product outcome, not a
failed attempt to disguise as success.

## Why This Could Matter

Many tools compete on model access and editor experience. This project focuses on a deeper layer:

```text
How should agents share context, know boundaries, and refine work safely?
```

That layer can become valuable even if model providers change.
