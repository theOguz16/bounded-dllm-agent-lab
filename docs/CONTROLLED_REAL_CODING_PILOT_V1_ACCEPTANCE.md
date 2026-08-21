# Controlled Real Coding Pilot v1 — Final Acceptance Record

## Decision

```text
Decision: GO
Scope: bounded real coding pilot v1 only
```

This decision certifies one bounded, governed real coding task under the documented pilot constraints. It does not certify arbitrary autonomous coding.

## Tested source

```text
testedSourceCommit: e23e5fc58ec6107a459993ed172256d256045736
sourceTargetPath: apps/cli/src/model-worker-runpod-live-smoke.ts
sourceTargetBlobHash: e3b973ff81543207de4ba5953818f076f9a55951
```

## Runtime provenance

```text
modelId: qwen2.5-coder-7b
llamaBuild: 9754
llamaCommit: 52b3df002
provenanceVerifiedBeforeProviderExecution: true
```

## Governed execution result

```text
status=completed
providerCallCount=1
retryCount=0
patchLineCount=18
authorityPassed=true
verifierPassed=true
artifactProduced=true
artifactValid=true
sourceWorktreeMutated=false
githubMutationObserved=false
budgetExceeded=false
cleanupCompleted=true
failureCode=null
FINAL_GATE=PASS
sourceBlobVerification=verified
```

## Evidence chain

```text
live pilot report
→ evidence bundle
→ independent verification
→ deterministic acceptance record
→ archived checksum
```

```text
pilotDefinitionHash: sha256:27272d8f3194319e06e233e0da240dcde3fef6d4192e2aa4c9a846a7cc4b4118
reportHash: sha256:e74190ba3414945709f58c3e47086f6822ebbf5c64df7b8a0efc347880b01b2e
evidenceHash: sha256:ef8061acd86f60e6bea5ee387c0b0388426f45806d14d079a443e1cf90b5bbc9
acceptanceHash: sha256:cc7a383608f0d57e775f4971bf9fd50a45ba39a326eb6633c466769be57f29ff
archiveSha256: 2bad2499d515941fbc6218d45d4052febdd2c6c3321645e31ebd4d00a2dda588
```

## Merge provenance

```text
runtimeProvenanceMergeCommit: 360fd6392efc623b8fb016cc146aa420d21a05a9
finalRunbookMergeCommit: ecc5201
acceptanceRecordInitialMergeCommit: 94b36b81eb83f80ae690502221d365d2c19d7a9f
```

`acceptanceRecordInitialMergeCommit` records the immutable merge commit that originally introduced this acceptance record.

## Acceptance criteria

| Criterion | Result |
| --- | --- |
| CI green | PASS |
| Exact source SHA tested | PASS |
| Runtime provenance verified | PASS |
| `FINAL_GATE=PASS` | PASS |
| `providerCallCount == 1` | PASS |
| `retryCount == 0` | PASS |
| Verifier passed | PASS |
| Source worktree immutable | PASS |
| GitHub not mutated by agent | PASS |
| Evidence bundle verified | PASS |
| Source blob verification verified | PASS |
| Acceptance record generated | PASS |
| `acceptanceHash` recorded | PASS |
| Archive checksum recorded | PASS |
| **Overall** | **GO** |

## Limitations

- One bounded coding task was demonstrated.
- One model and runtime configuration was live-tested.
- This does not demonstrate general autonomous software engineering capability.
- Future task classes require their own governed evaluation.

## Relationship to the runbook

Operational procedures are maintained in [`CONTROLLED_REAL_CODING_PILOT_RUNBOOK.md`](./CONTROLLED_REAL_CODING_PILOT_RUNBOOK.md). This file is the immutable archival acceptance record for the accepted pilot v1 run.
