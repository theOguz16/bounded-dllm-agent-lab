# Phase T Patch Dry-Run Results

## Objective

Phase T adds a deterministic patch application dry-run layer after
`repairDraft` verification. The system still does not write to disk. The goal
is to check whether an approved `repairDraft` is safe and ready to apply before
any future filesystem mutation.

This phase closes the gap between deterministic repair approval and actual
patch application. The output is still report-only: Phase T produces a bounded
preview and readiness decision, not a workspace write.

## Implemented Components

- Patch application dry-run gate.
- Patch application dry-run fixture suite.
- Orchestrator patch dry-run integration.
- phase-t patch dry-run suite report.
- Live forced-remask RunPod validation.

Together, these components cover the local dry-run contract, the fixture-level
ready_to_apply / needs_review / reject behavior, and the worker-backed
orchestrator path that runs dry-run only after deterministic repair approval.

## Local Validation

The local Phase T validation passed the following checks:

- `npm run test:phase-t-patch-dry-run-suite`
- `npm run test:patch-application-dry-run-fixture-suite`
- `npm run test:patch-application-dry-run-gate`
- `npm run test:phase-s-repair-verification-suite`
- `npm run test:repair-draft-verifier-negative-fixture-suite`
- `npm run test:repair-draft-verifier-gate`
- `npm run test:worker-backed-remask-smoke`
- `npm run test:remask-request-builder`
- `npm run test:worker-backed-orchestrator-smoke`
- `npm run test:phase-r-remask-suite`
- `npm run test:phase-q-verifier-suite`
- `npm run test:verifier-negative-fixture-suite`
- `npm run test:deterministic-verifier-gate`
- `npm run test:model-mutation-validator`
- `npm run test:workspace-mutation-contract`
- `npm run typecheck`
- `npm run build`
- `npm test`

These checks cover the Phase T suite, the dry-run gate and fixtures, the
orchestrator integration, the Phase S repair verification path, the Phase R
remask path, the Phase Q verifier path, and the shared workspace mutation
contracts.

## Live RunPod Validation

Phase T was validated live on RunPod with required mode enabled and forced
remask mode active. The live run reached `patch_ready_to_apply` after remask,
deterministic repair verification, and deterministic patch application dry-run.

```json
{
  "ok": true,
  "status": "completed",
  "suiteName": "phase-t-patch-dry-run-suite-report",
  "required": true,
  "forceRemask": true,
  "configured": true,
  "finalDecision": "patch_ready_to_apply",
  "verifierDecision": "needs_review",
  "verifierIssueCount": 1,
  "remaskRequested": true,
  "repairVerifierCalled": true,
  "repairVerifierDecision": "approve",
  "patchDryRunCalled": true,
  "patchDryRunDecision": "ready_to_apply",
  "patchDryRunIssueCount": 0,
  "patchDryRunChangedFiles": 1,
  "readyForRunPodLiveValidation": true
}
```

Additional live summary values:

- patch dry-run gate passed: `true`
- patch dry-run fixture suite passed: `true`
- patch dry-run fixture decisions observed: `true`
- Fixture ready_to_apply cases: `1`
- Fixture needs_review cases: `11`
- Fixture reject cases: `6`
- Planner validation passed: `true`
- Coder validation passed: `true`
- Verifier called: `true`
- Artifact: `/tmp/phase-t-live-patch-dry-run-artifacts.tar.gz`

## End-to-End Patch Dry-Run Path

The forced remask live validation exercised this path:

```text
planner
-> coder patchDraft
-> forced needs_review verifierFinding
-> remaskRequest
-> remask repairDraft
-> deterministic repairDraft verifier
-> deterministic patch application dry-run
-> patch_ready_to_apply
```

The important change from Phase S is the final dry-run readiness step. Phase S
could report `repair_approved_by_deterministic_verifier` after deterministic
repair verification. Phase T adds another deterministic gate after that point,
so the orchestrator can now distinguish:

- `patch_ready_to_apply`
- `patch_dry_run_needs_review`
- `patch_dry_run_rejected`

## Safety Boundaries

Phase T keeps patch readiness bounded by explicit safety constraints:

- No patch is applied to disk.
- No real repo files are modified.
- No uncontrolled filesystem mutation exists.
- Patch dry-run only compares `proposedPatch` against provided `fileContents`.
- `allowedFiles` and `forbiddenFiles` still apply.
- Unsafe `proposedPatch` content is rejected.
- Missing original file content routes to `needs_review`.
- No-op patches route to `needs_review`.
- Patch size is bounded.
- Diff preview is report-only.
- Model outputs still pass strict `WorkspaceMutation` validation.
- No JSON repair or extraction is used for model outputs.

The dry-run gate treats the repair draft as structured data. It does not
execute, apply, or rewrite the proposed patch.

## Architectural Interpretation

Phase T separates three concerns that should not collapse into one action:

- Repair generation.
- Repair verification.
- Patch dry-run readiness.

The orchestrator no longer stops at
`repair_approved_by_deterministic_verifier`. It now verifies whether the
approved `repairDraft` can produce a safe deterministic patch preview before
any future apply step.

This gives the runtime a clearer staged contract. A model may generate a repair,
and a deterministic verifier may approve that repair, but the system still asks
one more deterministic question: would this repair produce an acceptable patch
preview against known original file contents?

## Limitations

- No real patch application exists yet.
- No temporary workspace apply exists yet.
- No filesystem mutation gate exists yet.
- No rollback exists yet.
- No tests are executed against a patched workspace yet.
- The current dry-run treats `proposedPatch` as full replacement or proposed
  content preview.
- Forced remask mode is a smoke/live validation fixture.
- Qwen succeeded in the T.5 live validation, but other models may behave
  differently.

Phase T proves deterministic patch readiness reporting. It does not yet prove
that patches should be applied automatically.

## Next Phase

Phase U should add safe temporary workspace application:

- Apply only to a temp workspace.
- Never mutate the real repo.
- Verify allowed and forbidden files before and after apply.
- Produce a real diff artifact.
- Optionally run deterministic tests or checks against the temp workspace.
- Produce an apply/no-apply report.
- Keep rollback trivial by deleting the temp workspace.

Phase U should preserve the Phase T boundary: deterministic dry-run readiness
must remain separate from any future filesystem mutation.
