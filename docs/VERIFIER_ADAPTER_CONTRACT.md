# Verifier Adapter Contract

This document describes the product-runtime contract for future LLM/dLLM-style
verifier adapters.

The MVP-3 runtime remains deterministic by default. A verifier adapter is an
optional layer that can add findings to the deterministic review result without
owning the final decision alone.

## Goal

The adapter should answer product/runtime questions such as:

- Is the patch guessing beyond available authority?
- Did the patch cross a module boundary?
- Is a human decision required?
- Is a local remask repair safer than a full retry?
- Did the deterministic policy miss an ambiguous risk?

## Input

```ts
type VerifierAdapterInput = {
  task: TaskSpec
  diff: PatchDiff
  policy: RepoPolicy
  workspace: SharedWorkspaceSnapshot
  deterministicFindings: Finding[]
}
```

The adapter receives a bounded workspace and the deterministic findings. It
does not receive unlimited repo context by default.

## Output

```ts
type VerifierAdapterOutput = {
  adapterName: string
  mode: "llm" | "dllm" | "deterministic" | "mock"
  findings: VerifierAdapterFinding[]
  confidence: number
  summary: string
}
```

Adapter findings are merged into the normal finding pipeline. Therefore an
adapter can request:

- `approve`
- `refuse`
- `reject`
- `remask_required`
- `human_review_required`

## Product Rule

The adapter is advisory in MVP-3. It may add findings, but the runtime still
uses the same deterministic decision priority:

```text
reject
refuse
remask_required
human_review_required
approve
```

This keeps the product auditable. A future model-backed verifier can improve
coverage, but it should not become an untraceable hidden judge.

## Why This Matters

This keeps the project aligned with the product philosophy:

```text
model orchestration değil;
context + authority + workspace orchestration.
```

The model can help verify, but scope, authority and trace remain explicit
runtime objects.
