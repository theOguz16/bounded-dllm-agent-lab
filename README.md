# Bounded dLLM Agent Lab

Bounded dLLM Agent Lab is an open-source research project and early product runtime for a new agentic coding architecture: agents that work under narrow context, use synthetic context enrichment, reason through shared semantic workspaces, and can be verified or repaired through bounded refinement loops instead of unbounded long-context prompting.

The product direction is not "a PR reviewer with extra safety checks." The product direction is:

```text
Bounded-context shared-workspace agent orchestration runtime for enterprise software teams.
```

PR review, GitHub Actions, and patch validation are the first practical surfaces for that runtime. The core product is the layer that manages context, authority, workspace state, role-specific bounded working memory, verifier feedback, remask requests, merge decisions, trace, and cost signals.

The project is not trying to train a new large language model from scratch. The project is trying to answer a more focused research question:

> Can bounded-context dLLM agents produce more scope-aware, conflict-resistant, and cost-efficient results than long-context autoregressive LLM agents?

## Why This Exists

Current agentic coding tools are useful, but many of them still behave like a switchboard:

- one model plans,
- another model writes code,
- another model reviews,
- an orchestrator passes text between them.

That is helpful, but it is not the same as multiple agents sharing one semantic workspace. The deeper problem is not only model quality. The deeper problem is how context, memory, scope, and collaboration are represented.

Large companies often work with narrow module ownership. A billing team, mobile team, admin team, or platform team may own only a small part of a large system. In that environment, a coding agent must not behave like an over-helpful generalist. It must know where it is allowed to act, what it must not touch, which facts are stale, which decisions are current, and when the available context is insufficient.

This lab explores that problem.

## Core Hypothesis

The central hypothesis is:

> Small, structured, synthetic context packets can help dLLM-style agents reason more reliably under bounded context than long raw prompts given to autoregressive LLM agents.

This means we care about four things:

1. **Bounded context**: the agent receives only the relevant task, constraints, memory, code regions, and verification rules.
2. **Synthetic enrichment**: raw repo or memory data is compressed into structured context packets before model inference.
3. **dLLM-native refinement**: the model fills and repairs masked workspace regions through iterative refinement.
4. **Scope awareness**: the agent must know what it can do, what it cannot do, and when it should stop.

## The Mental Model

Traditional LLM agent flow:

```text
User task
  -> long prompt
  -> left-to-right model generation
  -> tool call
  -> patch or answer
  -> reviewer
```

Bounded dLLM agent flow:

```text
User task
  -> bounded context packet
  -> shared semantic workspace
  -> masking policy
  -> dLLM refinement loop
  -> verifier feedback
  -> remask uncertain regions
  -> final traceable result
```

The important difference is that the agent is not only writing text. It is refining a structured workspace.

## What A Workspace Contains

A workspace is a structured representation of the task and the agent state. It can contain:

- task intent,
- allowed scope,
- forbidden scope,
- relevant facts,
- stale facts,
- sensitive boundaries,
- uncertainties,
- agent claims,
- patch intent,
- conflict records,
- verifier results,
- trace events,
- active agent roles,
- final decision.

The workspace is the shared object. Agents do not merely pass messages to each other. They write structured claims and refinements into the same state.
Every claim, boundary decision, verifier result, mask action, and final result can be traced back to a role. This is the foundation for measuring whether multiple agents collaborate without overwriting each other.

## What "Agent" Means Here

In this project, an agent does not have to mean a separate chat model.

An agent can be a mask view over the same workspace:

- **PlannerMask** fills goal, assumptions, and risk fields.
- **ImplementerMask** fills patch intent or solution fields.
- **ReviewerMask** fills conflict, contradiction, and scope-drift fields.
- **VerifierMask** interprets tests and verification results.
- **BoundaryMask** decides whether the context is sufficient or insufficient.

This is different from classical multi-agent orchestration. The roles are not isolated workers in separate context windows. They are structured refinement passes over one shared workspace.
Each mask view has readable, writable, locked, and masked regions. That makes the agent role measurable: we can check whether a role stayed inside its own workspace boundary instead of drifting into unrelated work.

## What We Will Compare

The project will compare several systems on the same benchmark tasks:

1. **Long Context LLM**
   A large prompt with broad context.

2. **RAG LLM**
   Retrieval-selected context passed to an autoregressive model.

3. **Synthetic Context LLM**
   A bounded context packet passed to an autoregressive model.

4. **Bounded Context dLLM**
   A bounded context packet converted into a masked workspace and refined by a dLLM engine.

5. **Bounded Context dLLM with BoundaryMask**
   The same dLLM flow with an explicit insufficient-context decision layer.

## What We Will Measure

The project will not rely on "it feels better" evaluation. It will track measurable outcomes:

- task success rate,
- scope drift rate,
- sensitive leakage rate,
- correction override accuracy,
- insufficient context accuracy,
- conflict resolution accuracy,
- verifier pass rate,
- context token budget,
- latency,
- estimated cost,
- trace completeness.

The first evaluator will be deterministic. It will use schemas, expected fields, forbidden fields, leakage regexes, allowed regions, and known ground truth. LLM-as-judge can be added later, but it will not be the foundation.

## Why dLLM

Autoregressive LLMs generate mostly left to right. That is powerful, but it can be awkward for code and collaborative work, where many regions influence each other.

Diffusion-style language models are interesting because they can treat generation as iterative repair:

```text
masked draft
  -> fill some fields
  -> detect conflict
  -> remask uncertain region
  -> refine again
```

This may fit agentic coding better than a single linear answer, especially for:

- infilling,
- whole-diff repair,
- conflict resolution,
- structured workspace completion,
- scope boundary decisions,
- iterative refinement after verifier feedback.

This project does not assume dLLMs will always win. It tests where they help and where they fail.

## Relationship To Local Personal AI

This research can later connect to a local personal memory project. That project can provide:

- memory graph exports,
- topic documents,
- correction-aware memory,
- sensitive boundaries,
- context composer outputs.

This lab should start separately because research needs controlled experiments. The two projects can converge later through shared context packet formats and benchmark fixtures.

## Repository Structure

```text
apps/
  api/             HTTP API for experiments and dashboards
  cli/             command-line experiment runner
  web/             research dashboard
  dllm-worker/     isolated Python inference worker for open-source dLLMs

packages/
  context-core/    bounded context packet schema
  workspace-core/  shared semantic workspace schema
  masking-policy/  mask selection and remasking rules
  product-runtime/ bounded-context orchestration runtime contracts
  eval-core/       deterministic scoring and benchmark metrics
  providers/       model engine interfaces and adapters
  fixtures/        benchmark cases and synthetic tasks

docs/
  architecture, research plan, experiments, glossary
  initial results
  technical report outline
  CI verification checklist
```

## Current Research Status

The first research milestone is documented in
[`docs/FIRST_RESEARCH_NOTE_TR.md`](docs/FIRST_RESEARCH_NOTE_TR.md) and
[`docs/INITIAL_RESULTS.md`](docs/INITIAL_RESULTS.md). It includes behavior
benchmarks, hard-suite baselines, Qwen2.5-Coder code patch benchmarks,
Dream-Coder dLLM direct patch benchmarks, context strategy comparisons, and code
failure taxonomy.

The current Turkish research report with hypotheses, methodology, result
tables, and charts is available at
[`docs/RESEARCH_REPORT_TR.md`](docs/RESEARCH_REPORT_TR.md).

The Turkish LinkedIn draft and short social figures are available at
[`docs/LINKEDIN_DRAFT_TR.md`](docs/LINKEDIN_DRAFT_TR.md) and
[`docs/results/LINKEDIN_FIGURES_TR.md`](docs/results/LINKEDIN_FIGURES_TR.md).

The first milestone figures are available at
[`docs/results/FIRST_MILESTONE_FIGURES.md`](docs/results/FIRST_MILESTONE_FIGURES.md).

## Product Runtime Status

The research lab is now being translated into a bounded agent orchestration
runtime. The current MVP surface is not a replacement for Cursor, Codex, or
Windsurf, and it is not the whole product. It is the first integration surface
for a policy-bound shared-workspace runtime over task + diff + policy flows:

```text
task + diff + policy
  -> SharedWorkspace v1
  -> Context Composer v1
  -> bounded role views with included/excluded facts and token budget reports
  -> Agent Orchestrator v1 mock flow
  -> verifier findings
  -> verifier-triggered remask request when needed
  -> merge decision
  -> approve / refuse / reject / remask_required / human_review_required
  -> JSON + Markdown + PR comment artifact
```

The product MVP documentation is available at:

- [`docs/MVP_USAGE.md`](docs/MVP_USAGE.md)
- [`docs/MVP_READINESS.md`](docs/MVP_READINESS.md)
- [`docs/DEMO_PACKAGE.md`](docs/DEMO_PACKAGE.md)
- [`docs/VERIFIER_ADAPTER_CONTRACT.md`](docs/VERIFIER_ADAPTER_CONTRACT.md)
- [`docs/EXTERNAL_REPO_ADOPTION.md`](docs/EXTERNAL_REPO_ADOPTION.md)
- [`docs/REAL_PR_FIXTURE_AUTHORING.md`](docs/REAL_PR_FIXTURE_AUTHORING.md)
- [`docs/PRODUCT_ARTIFACT_SCHEMA.md`](docs/PRODUCT_ARTIFACT_SCHEMA.md)
- [`docs/SDK_API_DRAFT.md`](docs/SDK_API_DRAFT.md)
- [`docs/PUBLIC_PILOT_READINESS.md`](docs/PUBLIC_PILOT_READINESS.md)
- [`docs/CONSUMER_PILOT_HANDOFF.md`](docs/CONSUMER_PILOT_HANDOFF.md)
- [`docs/PRODUCT_PROOF.md`](docs/PRODUCT_PROOF.md)

Useful product checks:

```bash
npm run product:action-smoke
npm run product:pilot -- --out-dir /tmp/bounded-mvp1-pilot --fail-on-regression
npm run product:pilot-v2 -- --out-dir /tmp/bounded-mvp2-pilot --fail-on-regression
npm run product:pilot-v3 -- --out-dir /tmp/bounded-mvp3-pilot --fail-on-regression
npm run product:real-pr-pilot -- --out-dir /tmp/bounded-real-pr-pilot --fail-on-regression
npm run product:team-metrics -- --dir reports/product-runtime
npm run product:dogfood-validation -- --out-dir /tmp/bounded-agent-dogfood-validation --fail-on-error
npm run product:external-evidence -- --out-dir /tmp/bounded-agent-external-evidence --fail-on-regression
npm run product:pilot-manifest -- --dogfood-dir /tmp/bounded-agent-dogfood-validation --external-dir /tmp/bounded-agent-external-evidence --out-dir /tmp/bounded-agent-pilot-handoff --fail-on-missing
npm run product:provider-live-test -- --out-dir /tmp/bounded-agent-provider-test
npm run product:consumer-smoke-kit -- --out-dir /tmp/bounded-agent-consumer-smoke-kit
```

The second phase hybrid architecture is documented in
[`docs/HYBRID_AGENT_ARCHITECTURE.md`](docs/HYBRID_AGENT_ARCHITECTURE.md).

The product runtime direction is documented in
[`docs/ORCHESTRATION_RUNTIME.md`](docs/ORCHESTRATION_RUNTIME.md). It adds the
first deterministic CLI surface for reviewing task + diff + policy inputs:

```bash
npm run product:review -- --task task.md --diff patch.diff --policy policy.yml
```

The MVP usage guide, example inputs, and GitHub Action workflow are documented in
[`docs/MVP_USAGE.md`](docs/MVP_USAGE.md).

The consumer repository setup guide is available at
[`docs/CONSUMER_SETUP.md`](docs/CONSUMER_SETUP.md).

The MVP demo/readiness checklist is available at
[`docs/MVP_READINESS.md`](docs/MVP_READINESS.md).

The MVP-1 pilot report is available at
[`docs/MVP1_PILOT_REPORT.md`](docs/MVP1_PILOT_REPORT.md).

Generate visual benchmark figures with:

```bash
npm run reports:research-figures
```

## Development Philosophy

The first goal is not a polished product. The first goal is a reproducible research artifact.

The project should remain:

- measurable,
- modular,
- easy to inspect,
- honest about uncertainty,
- independent from one model provider,
- useful for students and researchers.

## First Milestone

The first milestone is **M1: Bounded Context Benchmark**.

It will create a small benchmark suite with these case families:

- correction override,
- sensitive boundary,
- scope drift,
- insufficient context,
- conflict resolution.

Each system will receive the same task family and produce a structured result. The evaluator will produce a JSON report with comparable metrics.

## Quick Start

### Product MVP

The current product MVP is a deterministic bounded-agent orchestration runtime
surface. It does not call a model. It builds a shared workspace from
`task + diff + policy`, composes bounded role views, verifies configured
boundaries, records verifier/remask/merge events, and returns one of:

```text
approve | refuse | reject | remask_required | human_review_required
```

Run the MVP locally:

```bash
npm install
npm run build
npm run product:policy -- --init --out /tmp/bounded-agent.policy.yml
npm run product:policy -- --validate --policy /tmp/bounded-agent.policy.yml
npm run product:review -- \
  --task examples/product-runtime/tasks/repo-dogfood.md \
  --diff examples/product-runtime/diffs/repo-package-remask.diff \
  --policy bounded-agent.policy.yml \
  --format both
npm run product:pilot
```

Generate a PR-comment-ready artifact from a review JSON:

```bash
npm run product:comment -- \
  --review reports/product-runtime/2026-...-product-review.json \
  --out reports/product-runtime/pr-comment.md \
  --marker "<!-- bounded-agent-review -->"
```

Create an index for product runtime artifacts:

```bash
npm run product:report-index -- \
  --dir reports/product-runtime \
  --out-dir reports/product-runtime
```

The GitHub Action surface is documented in
[`docs/MVP_USAGE.md`](docs/MVP_USAGE.md). The action produces JSON, Markdown,
PR-comment-ready, and report-index artifacts. PR comment posting is disabled by
default in the dogfood workflow and can be enabled intentionally with:

```text
BOUNDED_REVIEW_POST_COMMENT=true
```

### Research Lab

```bash
npm install
npm run typecheck
npm run build
npm run eval:demo
```

The first demo uses a deterministic mock engine. Real dLLM inference will be added as a separate worker after the workspace and benchmark contracts are stable.

## Local Lab Checks

These commands mirror the CI gate:

```bash
npm run typecheck
npm run build
npm run test:smoke
npm run eval:demo
python3 -m py_compile apps/dllm-worker/worker.py
```

For worker smoke testing, run the worker in one terminal:

```bash
python3 apps/dllm-worker/worker.py
```

Then run:

```bash
npm run worker:smoke
```

## Status

This repository now contains two connected tracks:

- a reproducible research lab for bounded-context/dLLM-style agent experiments,
- a first product MVP for deterministic bounded-agent orchestration over task +
  diff + policy inputs.

The MVP is not a full IDE, not a Cursor/Codex replacement, and not a claim that
dLLMs are universally better. PR review is only the first surface. The durable
product core is the architecture validated in the research phase: context,
authority, shared workspace, role-specific bounded working memory, verifier,
remask, merge decision, trace and policy orchestration.
