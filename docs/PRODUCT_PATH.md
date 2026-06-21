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
Scope-safe AI change runtime for software teams.
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

The narrow MVP should be:

```text
AI patch boundary reviewer for enterprise teams.
```

It reviews patches produced by AI coding agents and answers:

- Is this patch inside the requested module scope?
- Did it infer a missing product, platform, compliance, or owner decision?
- Did it touch forbidden files or modules?
- Did it create sensitive logging or secret exposure risk?
- Did it skip required tests, metadata, or paired files?
- Should the patch be approved, refused, or remasked?

The product should be model-agnostic:

```text
Bring your own coder model.
The system provides workspace, policy, verification, trace, and remask control.
```

This keeps the product realistic. The research may continue testing dLLM-style
verifier/remask workers, but the MVP should not depend on dLLM maturity.

## What The MVP Should Not Do First

The MVP should not try to:

- replace Cursor, Windsurf, Codex, or Claude Code,
- own the whole IDE experience,
- generate large features end to end,
- claim that dLLMs are universally better coders,
- require a specific model provider,
- solve every security or compliance problem.

The MVP should do one thing well:

```text
Detect and explain risky AI patch behavior before it reaches merge.
```

## Why This Could Matter

Many tools compete on model access and editor experience. This project focuses on a deeper layer:

```text
How should agents share context, know boundaries, and refine work safely?
```

That layer can become valuable even if model providers change.
