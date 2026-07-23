# v0.1 Fail-Closed Matrix

| Failure condition | Required outcome | Canonical evidence |
| --- | --- | --- |
| Context input malformed | No provider call | `context-sufficiency-contract.ts` |
| Hard context budget exceeded | Recompose or stop | `context-sufficiency-authorization.ts` |
| Expansion limit or repeated request | No patch or handoff | `adaptive-context-orchestrator.ts` |
| Provider timeout or invalid output | Fail closed | `coder-context-execution-gate.ts` |
| Mutation or scope contract invalid | Reject mutation | `model-mutation-validator.ts` |
| Deterministic verifier rejects | No controlled apply | `deterministic-verifier-gate.ts` |
| Acceptance criterion missing or failed | Task not accepted | `acceptance-criteria-contract.ts` |
| Repository drift before apply | Block or human review | `controlled-repository-apply.ts` |
| Post-apply validation fails | Rollback to exact baseline | `controlled-post-apply-validation.ts` |
| Crash during apply or validation | Cross-process recovery | `controlled-transaction-recovery.ts` |
| Handoff replay | Second consumption rejected | `durable-consumption-registry.ts` |
| Evidence hash mismatch | Release invalid | `repository-release-evidence-runner.ts` |
| Legacy research API exposed publicly | Release invalid | `runtime-generation-boundary.ts` |

## Claim boundary

This matrix records enforced outcomes and evidence locators. It does not claim that every possible production failure mode has been enumerated.
