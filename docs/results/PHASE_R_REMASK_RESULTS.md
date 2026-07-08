# Phase R Remask Results

## Objective

Phase R adds a bounded remask repair flow to the orchestrator path:

```text
verifier needs_review -> remaskRequest -> remask worker -> repairDraft
```

The goal is not to run a second model pass after every patch. The goal is to
allow a verifier to reopen only a narrow, repairable region after a coder
mutation is valid enough to inspect but still has a local issue that can be
repaired safely.

## Implemented Components

- Remask request builder.
- Worker-backed remask smoke.
- Orchestrator remask integration.
- Phase R remask suite report.
- Forced remask orchestrator fixture.

Together, these components cover the local request-building contract, the live
worker-backed repair path, and the suite-level readiness signal used for RunPod
validation.

## Local Validation

The local Phase R validation passed the following commands:

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

This validates the remask-specific path and the adjacent verifier and workspace
mutation contracts that constrain it.

## Live RunPod Validation

Phase R was also validated live on RunPod with required mode enabled and the
forced remask fixture active.

The live run recorded:

- Remask request builder passed: `true`
- Remask worker validation passed: `true`
- Remask worker repairDraft checks passed: `true`
- Planner validation passed: `true`
- Coder validation passed: `true`
- Verifier called: `true`
- Artifact: `/tmp/phase-r-forced-remask-live-artifacts.tar.gz`

```json
{
  "ok": true,
  "status": "completed",
  "suiteName": "phase-r-remask-suite-report",
  "required": true,
  "forceRemask": true,
  "configured": true,
  "finalDecision": "repair_draft_ready",
  "verifierDecision": "needs_review",
  "verifierIssueCount": 1,
  "remaskRequested": true,
  "remaskRepairability": "repairable",
  "remaskValidationOk": true,
  "repairDraftChecksOk": true,
  "readyForRunPodLiveValidation": true
}
```

The live artifact was captured at:

```text
/tmp/phase-r-forced-remask-live-artifacts.tar.gz
```

## Normal Path Result

In the normal orchestrator path, the deterministic verifier remains the gate.
When the verifier approves a coder patch draft, no remask request is needed. If
the verifier returns `needs_review` for a repairable issue, the orchestrator can
build a `remaskRequest` and route it to the remask worker.

This keeps remask conditional. It is available for bounded repair, but it does
not become a default retry mechanism for every patch.

## Forced Remask Path Result

The forced remask fixture proves the repair path without depending on a live
model naturally producing a specific verifier failure. After planner and coder
validation pass, the fixture injects a repairable verifier finding:

- verifier decision: `needs_review`
- issue code: `missing_proposed_patch`
- remask repairability: `repairable`
- final decision after successful repair validation: `repair_draft_ready`

The R.7 live RunPod run reached `repair_draft_ready` with remask requested,
remask validation passing, and repair draft checks passing.

## Safety Boundaries

Phase R keeps the repair loop bounded by several explicit checks:

- Remask starts only after planner and coder validation pass.
- The verifier must produce a repairable `needs_review` finding.
- The remask request is built from the verifier finding and coder mutation,
  rather than from an unconstrained free-form retry.
- Repair output must validate as a `repairDraft` workspace mutation.
- Repair draft checks must pass before the suite reports the repair as ready.
- Forbidden files, unsafe patch content, invalid mutation shapes, and
  non-repairable verifier findings remain blocked by the existing gates.

## Architectural Interpretation

Phase R turns remask into a verifier-triggered repair primitive.

The architecture now has a clearer separation of responsibilities:

- The planner proposes bounded intent.
- The coder proposes a patch draft.
- The verifier decides whether the patch is acceptable, blocked, or locally
  repairable.
- The remask worker attempts a narrow repair only when the verifier marks the
  issue as repairable.

This is an important distinction from a generic self-correction loop. Remask is
not an always-on second attempt; it is a constrained follow-up action produced
by a verifier-controlled workflow.

## Limitations

- The live R.7 run validates the forced repair path, not every possible natural
  verifier failure mode.
- The forced fixture intentionally injects a known repairable issue, so it
  should be interpreted as path validation rather than broad model-quality
  evidence.
- The current result does not prove remask improves all patch tasks. It proves
  that a repairable verifier finding can be converted into a bounded repair
  request and a validated repair draft.
- Broader evidence still requires more real repo fixtures, repeated live runs,
  and additional repair categories such as schema, type, test, and API contract
  gaps.

## Next Phase

The next phase should expand from path validation to broader evaluation:

- Add more natural verifier-triggered remask fixtures.
- Measure remask request rate, repair success rate, and repair failure reasons.
- Separate repairable `needs_review` findings from non-repairable reject cases
  in reporting.
- Run repeated live suites to observe variance across model responses.
- Connect remask artifacts to PR or pilot-facing review surfaces so repair
  drafts can be inspected before adoption.
