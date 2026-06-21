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

- every agent sees too many irrelevant tokens,
- role-specific signals become diluted,
- one weak claim can pollute the whole context,
- parallel execution becomes harder.

The target architecture is:

```text
Shared semantic workspace as source of truth.
Role-specific bounded views as model-facing context.
Conflict-aware merge back into the workspace.
```

This keeps token use lower while preserving a shared audit trail.

## Workspace Source Of Truth

The shared workspace stores structured state:

- task intent,
- allowed scope,
- forbidden scope,
- ownership,
- ADR or product policy notes,
- missing authority,
- patch plan,
- verifier decision,
- failed region,
- remask request,
- final result,
- trace.

The workspace is not automatically sent to every model call. Each role receives
a bounded view.

## Role-Specific Views

Planner view:

- task,
- objective,
- constraints,
- risk notes.

Coder view:

- task,
- relevant files,
- allowed files,
- forbidden files,
- patch contract.

Boundary verifier view:

- task,
- ownership,
- ADR/policy,
- missing authority,
- proposed patch,
- forbidden scope.

Remask planner view:

- verifier failure,
- failed region,
- previous patch,
- minimal retry instruction.

## Benchmark Modes

Issue 27 adds these model-facing code benchmark flows:

| Flow | Meaning |
| --- | --- |
| `direct` | Existing one-pass Qwen patch agent. |
| `workspace` | Qwen receives a shared-workspace style bounded role view. |
| `workspace_verifier` | Qwen patch is reviewed by a boundary verifier pass; verifier can approve or force refusal. |
| `workspace_verifier_remask` | Verifier can request a failed-region remask and the coder gets one retry with feedback. |

The comparison question:

```text
Does verifier/remask reduce enterprise-boundary guesses without collapsing patch
pass rate?
```

## Product Thesis

The product should not initially be a full IDE or a Cursor replacement.

The narrower MVP is:

```text
AI patch boundary reviewer for enterprise teams.
```

It reviews AI-generated PRs or patches for:

- scope drift,
- missing authority,
- inferred product/compliance decisions,
- sensitive boundary risk,
- forbidden file/module touches,
- missing tests or required files,
- remask-needed regions.

The system can be model-agnostic. dLLM-style workers remain a research backend
for verifier/remask roles, while the MVP can use strong autoregressive coder
models plus deterministic rules.

## Success Criteria For Phase 2

The phase is promising if:

- enterprise-boundary guesses decrease,
- invalid contracts do not increase sharply,
- patch pass rate does not collapse,
- false refusal remains acceptable,
- allowed-file accuracy remains high,
- result reports remain reproducible.

The phase is weak if:

- boundary errors stay unchanged,
- verifier blocks too many valid patches,
- remask loops increase invalid output,
- token/cost overhead is too high,
- reports cannot explain why the flow changed behavior.
