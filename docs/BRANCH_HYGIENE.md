# Branch Hygiene

This ledger records branch-retention decisions after verifying pull-request state and current `main` content. It is operational metadata, not an experiment/evidence source.

## Preserve

- `main` — canonical integration branch.
- `research/mode-f-live-validation` — PR #166; active Mode F live C/E/F validation and promotion gate, still pending observed evidence.
- `research/v2-observed-run-evidence` — PR #165; parked Controlled Pilot V2 observed-evidence work, still pending real-provider runs.
- `chore/final-branch-doc-hygiene` — temporary branch for this cleanup PR; delete after merge.

## Safe remote-delete candidates

These branches correspond to merged work already represented on `main`, or to superseded closed research:

### Gate 5 history

- `agent/gate5-ablation-evidence-schema` — PR #135 merged.
- `agent/gate5-hidden-oracle-harness` — PR #134 merged.
- `agent/gate5-external-repository-contract` — PR #136 merged.
- `agent/gate5-external-repository-runner` — PR #137 merged.
- `agent/gate5-live-external-ablation` — PR #138 merged.
- `agent/gate5-real-context-ablation` — PR #139 merged.
- `agent/gate5-benchmark-observability` — PR #140 merged.
- `agent/gate5-multi-external-benchmark` — PR #141 merged.
- `agent/gate5-external-patch-e2e` — PR #142 merged.
- `agent/gate5-adaptive-compressed-boundary` — PR #143 closed unmerged and superseded by PR #166.

### Later merged runtime work

- `experiment/controlled-pilot-v2-bounded-edits` — PR #161 merged.
- `refactor/generic-pilot-context-selection` — PR #162 merged.
- `refactor/declarative-controlled-pilot-registry` — PR #163 merged.
- `ci/controlled-pilot-v2-offline-gate` — PR #164 merged.
- `research/unified-evidence-index` — PR #167 merged.
- `refactor/provider-neutral-execution-errors` — PR #168 merged.
- `refactor/split-controlled-pilot-engine` — superseded PR #169 plus merged replacement PR #170; final tested content is on `main`.

### Earlier merged closure branches

- `agent/update-mvp-roadmap` — PR #125 merged.
- `agent/add-context-sufficiency-roadmap` — PR #126 merged.
- `agent/add-release-blocking-gaps` — PR #127 merged.
- `agent/ag3c-evidence-closure` — PR #128 merged.
- `agent/gate1-claim-integrity` — PR #129 merged.
- `agent/gate2-gate3-contract-foundation` — PR #130 merged.
- `agent/gate2-run-bounded-task` — PR #131 merged.
- `agent/gate3-verifier-reliability` — PR #132 merged.
- `agent/gate4-product-maintenance` — PR #133 merged.

## Ancestry note

Several historical branches appear `diverged` from `main` even after their PR was merged because the repository frequently used squash merges. Literal commit ancestry is therefore insufficient for cleanup decisions. The deletion decision uses both merged PR provenance and confirmation that the current `main` carries the canonical successor implementation.

## Evidence rule

Branch existence does not determine research status. `evidence/index.json` remains authoritative for experiment/evidence status; open research branches must not be treated as observed evidence until durable artifacts are registered.
