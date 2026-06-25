# Product Path

This project starts as research. If the results are strong, it can become a product.

## Research Artifact

The first version proves whether the architecture is worth pursuing.

It includes:

- schemas,
- fixtures,
- evaluators,
- reports,
- mock engines,
- model adapters.

## Developer Tool

The second version can become a CLI for testing agent behavior under bounded context.

Example:

```bash
bounded-agent eval --suite scope-drift
bounded-agent run --case correction-001
```

## Coding Runtime

The third version can become an agent runtime that coding tools use internally.

It would provide:

- context packet compilation,
- scope gates,
- shared workspace state,
- conflict-aware refinement,
- verifier integration.

## Enterprise Product

The product version would target software teams that need safe agentic coding.

Possible positioning:

```text
Bounded-context shared-workspace agent orchestration runtime for software teams.
```

The product would help teams:

- keep agents inside module boundaries,
- reduce unwanted edits,
- audit why a change happened,
- compare model and context strategies,
- enforce sensitive data boundaries,
- measure agent reliability.

## Phase 2 Product Thesis

The first product should not be a full IDE or a Cursor replacement.

It also should not be positioned as only a PR reviewer. The narrow first surface
should be:

```text
AI patch/PR validation surface for a bounded agent orchestration runtime.
```

That surface reviews patches produced by AI coding agents and answers:

- Is this patch inside the requested module scope?
- Did it infer a missing product, platform, compliance, or owner decision?
- Did it touch forbidden files or modules?
- Did it create sensitive logging or secret exposure risk?
- Did it skip required tests, metadata, or paired files?
- Should the patch be approved, refused, or remasked?

The product should be model-agnostic:

```text
Bring your own coder model.
The runtime provides workspace, bounded working memory, policy, verification,
trace, remask and merge-decision control.
```

This keeps the product realistic. The research may continue testing dLLM-style
verifier/remask workers, but the MVP should not depend on dLLM maturity.

## Remask Product Rule

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

The first product surface loop is:

```text
task + patch + policy -> shared workspace -> verifier -> approve | refuse | reject | remask failed region
```

This matters for cost and quality. Always-on remask increases latency and model
spend. Verifier-triggered remask targets the expensive second pass only at cases
where it can repair a specific failed region.

## What The MVP Should Not Do First

The MVP should not try to:

- replace Cursor, Windsurf, Codex, or Claude Code,
- own the whole IDE experience,
- generate large features end to end,
- claim that dLLMs are universally better coders,
- require a specific model provider,
- solve every security or compliance problem.

The MVP surface should do one thing well:

```text
Detect and explain risky AI patch behavior before it reaches merge.
```

The product core behind that surface should do a broader job: manage what each
agent can see, what it can write, which shared state it updates, when verifier
feedback opens local remask, and how the final merge decision is traced.

## Why This Could Matter

Many tools compete on model access and editor experience. This project focuses on a deeper layer:

```text
How should agents share context, know boundaries, and refine work safely?
```

That layer can become valuable even if model providers change.
