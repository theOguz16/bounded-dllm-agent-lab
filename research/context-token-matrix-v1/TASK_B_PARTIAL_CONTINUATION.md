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

The existing six-slot live runner is deliberately unchanged and cannot consume this
authority. A separately reviewed suffix executor must validate this authority before
reservation and at each provider stage, bind its own fresh session, and stop immediately
on infrastructure or ambiguous failure. Candidate/model failure may be persisted and
followed by the next suffix slot only while infrastructure remains healthy. No suffix
execution or Stage 2 authorization is part of this preparation.

After authorized suffix execution, a future Stage 1 composition manifest should
reference the original r7 identities and artifact hashes for positions 1–3 and
the new session identities, artifact hashes, and journal evidence for positions
4–6. It must verify all six row references before publication and must not copy
or rewrite historical rows. Its per-row outcome kind must keep Candidate
correctness, no-Candidate production timeout, and infrastructure invalidation
distinct. No composition is produced by this preparation.
