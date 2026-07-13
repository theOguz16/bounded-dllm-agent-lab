# Phase V Temporary Workspace Execution Verification Results

## Objective

Phase V verifies whether an approved patch actually survives trusted validation
commands after being applied inside an isolated temporary workspace. It extends
the pipeline beyond structural patch review: the proposed change must be safely
applied away from the real repository, execute within bounded validation
constraints, produce an explicit validation decision, and then be cleaned up.

The three execution decisions are:

- `temp_validation_passed`
- `temp_validation_failed`
- `temp_validation_needs_review`

## Implemented Components

Phase V consists of the following components:

- A bounded temporary workspace execution verifier.
- A deterministic fixture suite covering successful, failed, timed-out, unsafe,
  invalid, and output-truncation cases.
- Worker-backed orchestrator integration after temporary workspace apply.
- Guaranteed temporary workspace cleanup after execution verification.
- A Phase V suite report combining the verifier smoke test, fixture suite, and
  orchestrator result.
- Portable outside-temp-root fixtures that remain valid when a repository is
  checked out beneath `os.tmpdir()`.

The portable fixture correction was recorded in commit `239e3d5` (`test: make
outside temp workspace fixtures portable`).

## Local Validation

The local Phase V validation passed these checks:

- `npm run test:phase-v-temporary-workspace-execution-suite`
- `npm run test:temporary-workspace-execution-verifier-fixture-suite`
- `npm run test:temporary-workspace-execution-verifier`
- `npm run typecheck`
- `npm run build`
- `npm test`

The deterministic fixture suite contains 24 passing fixtures:

- `temp_validation_passed`: 3 cases
- `temp_validation_failed`: 3 cases
- `temp_validation_needs_review`: 18 cases
- Failed fixtures: 0
- All expected execution decisions observed: `true`

The fixtures cover command success, expected and unexpected exit codes,
timeouts, launch failures, command and environment safety, workspace
validation, bounded output, and cleanup. The outside-temp-root fixtures create
a genuinely external disposable workspace and do not assume the repository
checkout itself is outside `os.tmpdir()`.

## Live RunPod Validation

Phase V was validated live on RunPod in required mode with forced remask active.
The run completed the repair, dry-run, temporary apply, execution verification,
and cleanup path. The trusted validation command passed and the final decision
was `temp_validation_passed`.

```json
{
  "ok": true,
  "status": "completed",
  "suiteName": "phase-v-temporary-workspace-execution-suite-report",
  "required": true,
  "configured": true,
  "forceRemask": true,
  "finalDecision": "temp_validation_passed",
  "verifierDecision": "needs_review",
  "remaskRequested": true,
  "repairVerifierCalled": true,
  "repairVerifierDecision": "approve",
  "patchDryRunCalled": true,
  "patchDryRunDecision": "ready_to_apply",
  "tempWorkspaceApplyCalled": true,
  "tempWorkspaceApplyDecision": "temp_apply_ready",
  "tempWorkspaceExecutionCalled": true,
  "tempWorkspaceExecutionDecision": "temp_validation_passed",
  "tempWorkspaceExecutionIssueCount": 0,
  "tempWorkspaceExecutionCommandCount": 1,
  "tempWorkspaceExecutionPassedCommands": 1,
  "tempWorkspaceExecutionFailedCommands": 0,
  "tempWorkspaceExecutionTimedOutCommands": 0,
  "tempWorkspaceExecutionCleanupPerformed": true,
  "readyForRunPodLiveValidation": true
}
```

Additional live evidence:

- Duration: `4157` ms
- Execution verifier passed: `true`
- Execution fixture suite passed: `true`
- All fixture decisions observed: `true`
- Fixture total: `24`
- Fixture passed: `24`
- Fixture failed: `0`
- Planner validation passed: `true`
- Coder validation passed: `true`
- Temporary workspace changed files: `1`
- Artifact: `/tmp/phase-v-live-execution-verification-artifacts.tar.gz`

## End-to-End Execution Path

The forced-remask live validation exercised this path:

```text
planner
-> coder patchDraft
-> deterministic verifier needs_review
-> remaskRequest
-> remask repairDraft
-> deterministic repair verifier approve
-> patch dry-run ready_to_apply
-> temporary workspace apply
-> trusted validation command
-> temp_validation_passed
-> guaranteed temporary workspace cleanup
```

This path proves more than patch shape or apply readiness. It demonstrates that
an approved repair can be applied in isolation, validated by trusted execution,
and disposed of without changing the real repository.

## Execution Safety Boundaries

Phase V keeps execution inside explicit deterministic boundaries:

- Commands come only from trusted configuration.
- Model-generated commands are never executed.
- Executables must be explicitly allowlisted.
- `shell: true` is never used.
- `exec` and `execSync` are never used.
- Command arguments remain literal process arguments.
- The execution working directory is the temporary workspace.
- Execution outside the OS temporary root is rejected.
- Command count is bounded.
- Command timeouts are bounded.
- Captured stdout and stderr are bounded.
- Secret-like environment keys are rejected.
- Expected exit codes are explicit.
- Process launch failures fail safely.
- The real repository remains untouched.

These restrictions keep model generation separate from process authority. The
model can propose a patch, but it cannot choose the executable, arguments,
timeout, environment, or expected exit codes used for validation.

## Cleanup Guarantees

Temporary workspace cleanup is a required finalization step, not an optional
success-path convenience. Tests cover cleanup after:

- Successful validation.
- Normal command failure.
- Command timeout.
- Execution verifier exception.

If cleanup itself fails, the result is downgraded to
`temp_validation_needs_review`; the orchestrator cannot report
`temp_validation_passed` as the final safe outcome. Cleanup status is included
in both the orchestrator report and the Phase V suite report. The live RunPod
result recorded `tempWorkspaceExecutionCleanupPerformed: true`.

## Architectural Interpretation

Phase V preserves a staged architecture in which each component has a distinct
authority and responsibility:

- **Model generation:** planner and coder produce structured proposals.
- **Deterministic mutation verification:** the initial patch draft is checked
  without granting execution or filesystem authority.
- **Repair generation:** remask produces a bounded repair draft for repairable
  findings.
- **Deterministic repair verification:** the repair is approved, rejected, or
  routed to review independently of the model.
- **Patch dry-run:** the approved repair is compared with known file content and
  evaluated before any write.
- **Isolated temporary application:** the patch is written only to a disposable
  temporary workspace.
- **Bounded execution verification:** trusted allowlisted commands validate the
  applied workspace with bounded time, output, environment, and command count.
- **Guaranteed cleanup:** the temporary workspace is removed regardless of the
  execution outcome.

The separation prevents a single model response from becoming an unchecked
filesystem mutation or process execution. Each transition is represented by a
deterministic result that the next stage can verify.

## Limitations

- Live validation currently uses a harmless trusted Node command.
- It does not yet reconstruct an entire external repository.
- Project-specific build and test command selection is static.
- Dependencies are not installed inside each temporary workspace.
- There is no container-level sandbox beyond the existing process and path
  restrictions.
- Real-repository application remains disabled.
- No human approval gate exists yet.
- Live validation is Qwen-only; other model families have not been validated on
  this path.

Phase V proves bounded execution verification for an isolated applied patch. It
does not authorize deployment, real-repository mutation, or automatic approval.

## Next Phase

Phase W should introduce controlled approval and verified-change handoff while
keeping real application disabled until every approval check passes.

Possible Phase W goals:

- Create a signed or hashed validation artifact.
- Bind the patch, verifier result, temporary apply result, and execution result
  into one approval subject.
- Require explicit human approval.
- Prevent stale approval after any patch or validation-result change.
- Prepare a controlled real-repository application plan.
- Keep real apply disabled until all approval checks pass.

Phase W should preserve the Phase V separation of generation, deterministic
verification, isolated execution, and cleanup. Approval should authorize one
specific verified change, not grant general mutation or command authority.
