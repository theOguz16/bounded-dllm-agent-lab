# Roadmap

## M1: Bounded Context Benchmark

Goal:

Create a reproducible benchmark for narrow-context agent behavior.

Deliverables:

- benchmark fixture format,
- deterministic evaluator,
- demo cases,
- JSON report output,
- README quick start.

## M2: Shared Semantic Workspace

Goal:

Represent agent state as a structured workspace instead of a transcript.

Deliverables:

- workspace schema,
- claim schema,
- conflict schema,
- boundary decision schema,
- run trace format.

## M3: Masking Policy

Goal:

Define how the system chooses which workspace fields to regenerate.

Deliverables:

- PlannerMask,
- ImplementerMask,
- ReviewerMask,
- VerifierMask,
- BoundaryMask.

## M4: dLLM Worker

Goal:

Connect an open-source dLLM through an isolated inference worker.

Deliverables:

- Python worker API,
- TypeScript provider adapter,
- health endpoint,
- local mock mode,
- GPU deployment notes.

## M5: LLM vs dLLM Comparison

Goal:

Compare long-context LLM, RAG LLM, synthetic-context LLM, and bounded-context dLLM systems.

Deliverables:

- baseline adapters,
- experiment runner,
- aggregate reports,
- charts,
- first technical report.

## M6: Hybrid Agent Product Validation

Goal:

Test whether the research can become a practical enterprise product direction.

Deliverables:

- hybrid workspace architecture,
- role-specific bounded views,
- LLM mask/remask benchmark mode,
- enterprise boundary PR context,
- hybrid comparison report,
- product thesis for an AI patch boundary reviewer.

Primary question:

```text
Can a workspace/verifier/remask flow reduce enterprise-boundary guesses without
destroying scoped implementation quality?
```
