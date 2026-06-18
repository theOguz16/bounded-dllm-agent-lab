# Architecture

This document explains the architecture as if you are learning the system from the beginning.

## The Problem

Most current coding agents use a linear model:

```text
prompt -> answer -> patch -> verify -> retry
```

This works for many tasks, but it has three weaknesses:

1. The agent can over-generate and modify things outside the requested scope.
2. The agent may not understand the whole program because it sees a text window, not a structured program state.
3. Multiple agents can overwrite or contradict each other because they do not share a precise semantic workspace.

The architecture in this repo is designed around those three weaknesses.

## The Main Idea

The system does not send a huge prompt directly to a model.

It first builds a bounded context packet:

```text
raw task + raw memory + raw code facts
  -> filtering
  -> compression
  -> scope rules
  -> synthetic context packet
```

Then it creates a shared workspace:

```text
bounded context packet
  -> structured workspace
  -> masked regions
  -> model refinement
  -> verifier feedback
```

The workspace is the center of the system.

## Bounded Context Packet

A bounded context packet is the smallest useful context for a task.

It should include:

- what the task asks,
- what is allowed,
- what is forbidden,
- which facts are current,
- which facts are stale,
- what is sensitive,
- which uncertainties remain,
- what output shape is expected.

This packet is intentionally small. The point is not to hide information from the model. The point is to avoid giving the model irrelevant information that can cause scope drift.

## Shared Semantic Workspace

A shared semantic workspace is a structured state object.

It is not a chat transcript. It is closer to a task board, scratchpad, diff plan, and verification record in one object.

The workspace includes:

- context packet,
- active agent roles,
- agent claims,
- masked regions,
- proposed refinements,
- conflicts,
- boundary decisions,
- verifier results,
- trace events.

Every refinement should be traceable to a region of the workspace.

Issue #5 turns this idea into a concrete workspace contract. The project does
not model agents as separate chat windows that pass text to each other. It
models them as roles writing into one shared semantic object:

```text
planner / implementer / reviewer / verifier / boundary
  -> claims
  -> conflicts
  -> boundary decisions
  -> verifier results
  -> trace events
  -> final result
```

This matters because a collaborative coding agent must answer questions that a
chat transcript cannot answer reliably:

- which role created this claim,
- which evidence supports it,
- which region was masked or regenerated,
- whether a verifier accepted or warned about it,
- whether two claims conflict,
- which final result was produced from the shared state.

In other words, the workspace is the coordination layer. The model can change
later, but the research needs this state object first so every architecture can
be compared under the same rules.

## Masking Policy

The masking policy decides which workspace fields should be hidden and regenerated.

For example:

```text
Keep task fixed.
Keep allowed scope fixed.
Mask patch intent.
Mask risk analysis.
Mask boundary decision.
```

After a verifier fails, the policy can remask only the uncertain region instead of rebuilding the whole answer.

This is why dLLM-style refinement is interesting here.

## dLLM Engine

The dLLM engine is treated as a refinement engine.

It receives a masked workspace and returns a refined workspace.

The project should not depend on a single model. The TypeScript side uses a provider interface. A Python worker can run open-source dLLMs later.

The first implementation uses a mock engine so the benchmark and schemas can be developed without waiting for model infrastructure.

## BoundaryMask

BoundaryMask is a key part of the research.

Many agents fail because they answer confidently when the context is incomplete. BoundaryMask exists to produce one of these decisions:

- sufficient context,
- insufficient context,
- unsafe because sensitive information is involved,
- blocked because the requested change is outside allowed scope.

The correct behavior is sometimes to refuse to infer.

## Evaluator

The evaluator turns outputs into measurements.

It checks:

- whether required facts appear,
- whether forbidden facts appear,
- whether sensitive values leaked,
- whether stale facts were rejected,
- whether the agent respected allowed scope,
- whether the output followed the schema.

This makes the project a research artifact rather than a demo.

## Future Product Shape

If the research succeeds, it can become a product layer for coding tools:

```text
scope-safe agent runtime for software teams
```

The product would not only write code. It would manage safe software changes under context, ownership, memory, and verification constraints.
