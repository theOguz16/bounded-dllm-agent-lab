# Task B Stage 1 retained-prefix authority

This additive authority records the stopped `task-b-stage1-20260930-r7` session as a
retained prefix. It does not reopen r7, reserve an observation, or authorize a model call.
The committed `task-b-r7-retained-prefix-review.json` is the expected evidence snapshot;
`verifyR7RetainedPrefix()` compares it with the original files and durable journal.

Positions 1 and 2 remain clean Candidate PASS observations. Position 3 retains its
original `ambiguous_failure` runner classification and its subsequently reviewed
`production_product_timeout` interpretation. Its coder journal state is
`outcome_unknown` with `agent_timeout`; no Candidate exists and replacement is forbidden.
The review binds the frozen Task B files, r7 summary, reservations, every retained cell
artifact, selected context, normalized outcomes, and both journal invocation IDs,
record hashes, and terminal states per position.

`authorizeTaskBContinuation(freshSessionId)` is read-only prospective authority. It
requires the committed review to match, rechecks that r7 positions 4–6 have no
reservation, cell directory, or journal row, and rejects reuse of a continuation
session or B suffix. Its output names only positions 4–6 in their frozen order:
`B:current`, `B:expanded`, `B:minimal`. They remain original Stage 1 planned
positions, not r7 retries, r7 replacements, or extra replicates. The r4 historical
replacement lineage remains in its own records; this authority makes no new
invalidation or replacement claim about r7. The suffix budget is three observations,
three planned provider stages per observation, and nine stages total. Retry, repair,
and apply remain zero. `createTaskBContinuationBudget()` enforces those ceilings.

The existing six-slot live runner retains its behavior. The thin suffix executor uses
the same Task B preflight, Candidate validation, telemetry, and journal stage authority.
It checks this review before the first reservation and again before each suffix slot.
The historical r4 infrastructure replacement lineage remains in the provider-stage
journal authority; the new session does not replace or rerun any r7 A result.
It stops immediately on infrastructure or ambiguous failure. Candidate/model failure
may be persisted and followed by the next suffix slot only while infrastructure remains
healthy. Stage 2 is not authorized here.

Future explicit commands (do not run during offline preparation):

```sh
node research/context-token-matrix-v1/run-task-b-suffix.mjs preflight --session-id ID
node research/context-token-matrix-v1/run-task-b-suffix.mjs live --session-id ID
```

The `live` command requires the frozen journal and model environment, completes all
zero-call checks before creating a session directory, and reserves only positions 4–6.
Its maximum is three observations and nine planned provider stages.

After all three suffix observations complete without an infrastructure or ambiguous
stop, the executor writes `stage1-composition.json`. Its six rows directly reference
original r7 identities and artifact hashes for positions 1–3 and the new session
identities, artifact hashes, and journal evidence for positions 4–6. It verifies these
references before writing and never copies or rewrites historical rows. Its per-row
outcome kind keeps Candidate correctness and the no-Candidate production timeout
distinct. No composition is produced by this offline implementation task.
