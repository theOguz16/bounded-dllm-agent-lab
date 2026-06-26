# Hybrid Agent Architecture

## Goal

The second research phase tests a product-facing architecture:

```text
LLM coder + role-specific bounded views + shared semantic workspace +
verifier/remask loop
```

The goal is not to prove that a dLLM should replace an autoregressive coder
model. The goal is to test whether bounded workspace orchestration can reduce
enterprise-boundary failures while preserving code patch quality.

## Key Distinction

The target architecture is not one giant shared raw context window.

That design can be expensive and noisy:

* every agent sees too many irrelevant tokens,
* role-specific signals become diluted,
* one weak claim can pollute the whole context,
* parallel execution becomes harder.

The target architecture is:

```text
Shared semantic workspace as source of truth.
Role-specific bounded views as model-facing context.
Conflict-aware merge back into the workspace.
```

This keeps token use lower while preserving a shared audit trail.

## Workspace Source Of Truth

The shared workspace stores structured state:

* task intent,
* allowed scope,
* forbidden scope,
* ownership,
* ADR or product policy notes,
* missing authority,
* patch plan,
* verifier decision,
* failed region,
* remask request,
* final result,
* trace.

The workspace is not automatically sent to every model call. Each role receives
a bounded view.

This distinction matters because the product is not trying to give every agent
more memory. It is trying to give every agent the minimum sufficient working
memory for its role.

## Role-Specific Views

Planner view:

* task,
* objective,
* constraints,
* risk notes.

Coder view:

* task,
* relevant files,
* allowed files,
* forbidden files,
* patch contract.

Boundary verifier view:

* task,
* ownership,
* ADR/policy,
* missing authority,
* proposed patch,
* forbidden scope.

Remask planner view:

* verifier failure,
* failed region,
* previous patch,
* minimal retry instruction.

## Benchmark Modes

Issue 27 adds these model-facing code benchmark flows:

| Flow                        | Meaning                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `direct`                    | Existing one-pass Qwen patch agent.                                                        |
| `workspace`                 | Qwen receives a shared-workspace style bounded role view.                                  |
| `workspace_verifier`        | Qwen patch is reviewed by a boundary verifier pass; verifier can approve or force refusal. |
| `workspace_verifier_remask` | Verifier can request a failed-region remask and the coder gets one retry with feedback.    |

The comparison question:

```text
Does verifier/remask reduce enterprise-boundary guesses without collapsing patch
pass rate?
```

## Product Boundary

This architecture does not claim that dLLMs should replace autoregressive coder
models.

The near-term product strategy is:

```text
strong coder model or existing AI patch source
  + deterministic workspace/policy runtime
  + verifier-triggered remask
  + conflict-aware merge
```

dLLM-style models remain a research direction for verifier, remask, masked
repair and structured workspace completion roles.

The important product rule is:

```text
Model outputs are proposals or claims.
The runtime keeps authority, verifier, remask, merge and final decision control.
```

## Product Thesis

The product should not initially be a full IDE or a Cursor replacement.

The product should also not be narrowed to a PR reviewer. The target product is:

```text
Bounded-context shared-workspace agent orchestration runtime for enterprise teams.
```

The first practical surface is AI patch and PR validation. That surface reviews
AI-generated PRs or patches for:

* scope drift,
* missing authority,
* inferred product/compliance decisions,
* sensitive boundary risk,
* forbidden file/module touches,
* missing tests or required files,
* remask-needed regions.

This first surface is useful, but it is not the whole product.

The longer-term product is the runtime layer that decides:

* what each role can see,
* what each role can write,
* which workspace fields are locked,
* when verifier feedback should stop the flow,
* when local remask repair is allowed,
* how claims and patch proposals are merged,
* how conflicts are detected,
* how trace and cost reports are produced.

The system can be model-agnostic. dLLM-style workers remain a research backend
for verifier/remask roles, while the MVP can use strong autoregressive coder
models plus deterministic rules. In all cases, model outputs are proposals or
claims written back to the shared workspace; the runtime keeps authority,
verifier, remask and merge control.

## Architecture Loop

The target product loop is:

```text
User Task / Ticket / PR / Issue
  -> Workspace Builder
  -> Shared Semantic Workspace
  -> Context Composer
  -> Role-Specific Bounded Views
      -> Planner
      -> Coder
      -> Boundary Verifier
      -> Tester
      -> Remask Repair
  -> Conflict-Aware Merge
  -> Decision
      approve | refuse | reject | remask_required | human_review_required
  -> Final Patch / Report / Trace / Cost Summary
```

The first MVP does not need to run this whole loop with live model calls. It can
start deterministically with `task + diff + policy`, then grow toward model
adapters after workspace, context, verifier and merge contracts are stable.

## Why Not A Simple Multi-Agent Chat?

A simple multi-agent chat usually passes messages between agents. This project
uses a different mental model.

Agents do not only talk to each other. They write structured claims, findings,
patch plans and repair requests into the same workspace.

That gives the runtime something to verify:

* Did the planner create a claim outside the allowed task?
* Did the coder propose a patch outside the allowed files?
* Did the verifier contradict a coder claim?
* Did remask repair touch more than the failed region?
* Did two agents try to overwrite the same workspace field?
* Did the final decision preserve the policy boundary?

The value is not only better generation. The value is inspectable coordination.

## Success Criteria For Phase 2

The phase is promising if:

* enterprise-boundary guesses decrease,
* invalid contracts do not increase sharply,
* patch pass rate does not collapse,
* false refusal remains acceptable,
* allowed-file accuracy remains high,
* result reports remain reproducible,
* verifier-triggered remask stays local to failed regions,
* trace explains why the flow approved, refused, rejected or requested remask.

The phase is weak if:

* boundary errors stay unchanged,
* verifier blocks too many valid patches,
* remask loops increase invalid output,
* token/cost overhead is too high,
* reports cannot explain why the flow changed behavior,
* models start owning final decisions instead of writing proposals back to the
  runtime.

## Near-Term Implementation Priority

The architecture should be implemented in this order:

1. Keep deterministic PR/diff validation as the first product surface.
2. Promote SharedWorkspace into the central runtime state model.
3. Stabilize role-specific bounded working memory contracts.
4. Make Context Composer a standalone module.
5. Add deterministic mock orchestration over the workspace.
6. Add conflict-aware merge for claims and patch proposals.
7. Add verifier-triggered local remask.
8. Add cost/token comparison against direct large-context flows.
9. Add model adapter contracts.
10. Research dLLM-style verifier/remask roles after the runtime contracts are
    stable.

This order keeps the product independent from one model provider and prevents
the architecture from becoming only a model-router or PR-reviewer.
