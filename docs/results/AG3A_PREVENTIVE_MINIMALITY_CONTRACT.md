# AG.3a — Preventive Minimality Contract

## Status

AG.3a is complete at primitive and deterministic contract level.

```text
repository-aware dependency inventory   complete
pre-coder minimality decisions           complete
planner/intelligence/policy hash binding complete
post-patch soft-scope baseline           complete
canonical runtime export                 complete
deterministic contract suite             complete — 27 checks
planner-provider integration             pending — AG.3b
live planner/coder comparison             pending — later observed run
```

## Product purpose

The existing AF.2 soft-scope system measures unnecessary files, LOC,
refactors, dependencies and abstractions after a patch exists. AG.3a does not
replace that system. It creates the preventive side of the same product
boundary:

```text
planner proposal
→ preventive minimality declaration
→ repository-aware deterministic gate
→ coder or planner revision / human review
→ post-patch AF.2 soft-scope comparison
```

The gate is designed to reduce wasted coder calls and late verifier rejection,
without turning minimality into an authority that can override safety,
acceptance or correctness requirements.

## Trusted boundary

The model does not generate trusted hashes. A future AG.3b adapter will extend
the existing planner call and convert its declaration into a trusted plan.
AG.3a binds that plan to:

- task ID and objective hash;
- AG.2 planner proposal hash;
- AG.1 repository intelligence hash;
- active minimality policy hash;
- repository dependency inventory hash;
- post-patch comparison baseline hash.

No second provider call is required by the contract.

## Repository-aware checks

The evaluator reads only bounded `package.json` manifests at the repository
root and along ancestor paths of authorized/planned files. It rejects symlink,
oversized and malformed manifests. The resulting dependency inventory is
hash-linked and detects plans that incorrectly classify an installed package as
a new dependency.

The gate evaluates:

- planned-file and new dependency/abstraction budgets;
- files outside allowed scope or inside forbidden scope;
- unjustified new files when existing code is preferred;
- unrequested or unjustified refactors;
- standard-library and native-platform consideration;
- installed dependency alternatives and their insufficiency explanation;
- unrequested dependencies according to operator policy;
- abstraction justification, inline alternative and reuse sites;
- high-risk task routing to human review or policy bypass.

## Decisions

```text
minimality_plan_ready
minimality_justification_required
minimality_replan_required
minimality_human_review_required
minimality_policy_disabled
minimality_plan_invalid
```

Only `minimality_plan_ready` routes directly to the coder. High-risk policy
bypass does not imply approval; it means automatic minimality pressure is not
applied and downstream safety/governance remains authoritative.

## Soft-scope continuity

Every non-invalid evaluation emits a tamper-evident baseline containing:

- expected and allowed/forbidden files;
- requested-refactor state;
- planned dependencies and abstractions;
- task, planner, intelligence, policy and plan hashes.

AG.3b/AG.3c can bind this baseline to the existing observed soft-scope report,
so preventive and post-patch minimality remain one evidence chain rather than
two parallel systems.

## Evidence

Commands:

```bash
npm run test:preventive-minimality-contract
npm run generate:ag3a-evidence
npm run verify:ag3a
```

Artifact:

```text
reports/ag/AG3A_PREVENTIVE_MINIMALITY_CONTRACT.json
```

Expected evidence:

```text
decision=ag3a_preventive_minimality_evidence_ready
checkCount=27
evidenceClass=deterministic_fixture
coderIntegrationCompleted=false
```

This evidence proves deterministic contract behavior, repository dependency
inventory, fail-closed paths and hash integrity. It does not claim observed
model quality, token savings, infrastructure cost or completed coder
integration.
