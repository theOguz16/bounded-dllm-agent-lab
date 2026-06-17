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

## Why This Could Matter

Many tools compete on model access and editor experience. This project focuses on a deeper layer:

```text
How should agents share context, know boundaries, and refine work safely?
```

That layer can become valuable even if model providers change.

