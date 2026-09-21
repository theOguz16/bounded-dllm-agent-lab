# P7.7 — Deadline, abort and confirmed worker termination

P7.7 hardens worker lifecycle behavior observed during R06. It does not change or reinterpret frozen R06 evidence and it does not assert a successful live Codex invocation.

## Lifecycle contract

An isolated live Codex execution records distinct lifecycle observations:

- `deadlineTriggeredAt`: the process budget deadline fired.
- `abortRequestedAt`: cancellation was requested.
- `workerExitedAt`: the isolated worker emitted an exit event.
- `exitSignal`: the observed exit signal when one exists.
- `forcedTermination`: graceful shutdown exceeded the bounded grace period and forced termination was attempted.

A timeout is not treated as proof that the worker stopped. The supervisor waits for worker exit. On Linux and macOS the worker is created as its own detached process group. After the deadline requests abort, the supervisor sends `SIGTERM` only to that process group, waits 1500 ms, then sends `SIGKILL` to the same group if it is still running. It waits another bounded 1500 ms for exit confirmation. It never scans for or kills unrelated repository processes.

If a timed-out worker is confirmed stopped, the provider result is still not assumed known: the run fails closed as `provider_outcome_ambiguous`. If exit cannot be confirmed after forced termination, the stronger terminal failure is `worker_termination_failed`. The comparison loop and dogfood orchestration do not start another arm or task after either terminal result.

## Budget policy

P7.7 does not raise model budgets to make tests pass. Existing product comparison budgets remain unchanged: discovery is 180 seconds and each Normal/Bounded agent arm is 300 seconds. Normal and Bounded continue to use the same agent budget. The 1500 ms termination grace periods are cleanup windows after the execution deadline, not additional model execution budget.

The dogfood runners retain their coarse one-hour outer child-process envelope as a last-resort harness boundary; it is not the Normal/Bounded model budget and does not replace the 180/300 second phase deadlines.

## Offline verification

The P7.7 workflow runs without provider credentials and never invokes real Codex. Linux and macOS both run an intentionally hanging local Node worker that ignores `SIGTERM`. Tests verify deadline and exit timestamps are distinct, escalation reaches `SIGKILL`, the PID no longer exists after confirmed exit, and an injected unclosable worker is reported as `worker_termination_failed` rather than success.

A separate Codex-adapter fake-hang test exercises the adapter's isolated-worker path without loading the real Codex worker entrypoint. A command-level comparison test verifies both `provider_outcome_ambiguous` and `worker_termination_failed` stop the opposite arm before another provider invocation.

Windows is not part of the P7.7 process-group acceptance matrix. The worker supervisor has a direct-child fallback there, while process-group termination semantics in this task are explicitly verified on Linux and macOS.
