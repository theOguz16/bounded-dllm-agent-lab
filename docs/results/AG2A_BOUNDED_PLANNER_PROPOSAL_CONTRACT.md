# AG.2a — Bounded Planner Proposal Contract

## Status

AG.2a introduces a bounded planner proposal before AG.1c creates an
implementation contract.

```text
task identity
→ one planner-provider call
→ exact proposal schema
→ authority and policy binding
→ scope-budget validation
→ forbidden-file validation
→ AG.1c implementation contract
→ repository graph audit
→ AG.1b context binding
→ coder
```

## Proposal boundary

A planner proposal binds:

- task id;
- objective hash;
- acceptance-contract hash;
- authority hash;
- policy hash;
- seed files;
- one rationale hash per seed file;
- required symbols;
- required tests;
- maximum adaptive expansion attempts.

The proposal uses canonical JSON hashing and exact-field validation. Unknown
fields, accessors, symbol properties, duplicate paths, path traversal and
tampering are rejected.

## Bounded scope

Operator-provided limits constrain:

- maximum seed-file count;
- maximum required-symbol count;
- maximum required-test count;
- maximum expansion attempts.

The planner cannot increase these limits. Seed or test paths that overlap a
forbidden-file boundary return `replan_required`.

## Provider ordering

Authority and policy must be present before the planner provider is called.
Invalid or blocked proposals stop before AG.1c and before the coder provider.
A valid proposal is converted into the existing AG.1c implementation contract;
AG.2a does not create a parallel implementation-contract system.

## Execution binding

A successful flow hash-links:

- planner proposal hash;
- AG.1c implementation-contract hash;
- AG.1c task-seed execution-binding hash.

The planner proposal hash is also carried into coder base context.

## Evidence

Commands:

```bash
npm run test:bounded-planner-proposal-contract
npm run generate:ag2a-evidence
npm run verify:ag2a
```

Artifact:

```text
reports/ag/AG2A_BOUNDED_PLANNER_PROPOSAL_CONTRACT.json
```

Expected deterministic fixture result:

```text
decision=ag2a_evidence_ready
checkCount=15
```

The report hash is generated deterministically from the 15-check evidence
payload. This is `deterministic_fixture` evidence and does not claim observed
live-model quality, token savings, latency or infrastructure cost.
