# Issue Plan

This plan turns the research vision into GitHub issues.

## Phase 1: Make The Benchmark Real

The first phase creates the measurement foundation. Without this phase, the project would only be an idea.

Issues:

1. Define the benchmark fixture schema.
2. Expand deterministic evaluator metrics.
3. Add at least 50 bounded-context benchmark cases.
4. Generate JSON and Markdown reports from benchmark runs.

## Phase 2: Make The Workspace Real

The second phase turns agent reasoning into a structured workspace instead of a chat transcript.

Issues:

1. Extend shared workspace state with claims, conflicts, traces, and verification results.
2. Implement mask views for planner, implementer, reviewer, verifier, and boundary roles.
3. Implement a refinement loop that can remask failed regions.

## Phase 3: Compare Architectures

The third phase creates fair baselines.

Issues:

1. Add long-context LLM baseline interface.
2. Add RAG LLM baseline interface.
3. Add synthetic-context LLM baseline interface.
4. Add bounded-context dLLM interface.

## Phase 4: Connect A Real dLLM

The fourth phase connects an open-source dLLM through an isolated worker.

Issues:

1. Design the worker HTTP contract.
2. Implement worker health and mock endpoints.
3. Add GPU deployment notes.
4. Test an open-source dLLM candidate.

## Phase 5: Publish Research Artifact

The fifth phase turns results into a public artifact.

Issues:

1. Add dashboard or report viewer.
2. Write the first technical report.
3. Prepare a reproducible release.

## Phase 6: Validate The Hybrid Product Thesis

The sixth phase connects the research result to a realistic product direction.
It does not start with a full IDE. It tests whether a scoped verification layer
can improve AI-generated patches.

Issues:

26. Define the hybrid workspace architecture.
    - Shared semantic workspace as source of truth.
    - Role-specific bounded views instead of one shared raw context window.
    - Planner, coder, boundary verifier, and remask planner roles.
    - Product thesis: AI patch boundary reviewer for enterprise teams.

27. Add LLM mask/remask workspace benchmark mode.
    - `direct` one-pass patch baseline.
    - `workspace` bounded shared-workspace view.
    - `workspace_verifier` second-pass boundary verifier.
    - `workspace_verifier_remask` verifier-guided failed-region retry.

28. Add enterprise boundary PR context.
    - Ticket-like context.
    - Ownership notes.
    - ADR/policy notes.
    - Missing authority records.
    - Explicit rule that allowed files do not imply decision authority.

29. Add hybrid comparison report.
    - Compare direct/workspace/verifier/remask runs.
    - Track patch pass, refusal, boundary guesses, invalid contracts, and allowed files.
    - Use the report to decide whether the product thesis is supported.

30. Write the product thesis.
    - Define the initial user.
    - Define the narrow MVP.
    - Define what the product intentionally will not do first.
    - Keep dLLM as research backend, not as a required first product dependency.
