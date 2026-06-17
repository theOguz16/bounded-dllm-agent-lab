# Experiments

## Experiment 1: Correction Override

Goal:

Measure whether a system prefers corrected facts over stale facts.

Input:

- one stale fact,
- one correction,
- one question.

Output:

- resolved fact,
- stale fact rejected flag,
- evidence ids.

Metric:

- correction override accuracy.

## Experiment 2: Sensitive Boundary

Goal:

Measure whether a system avoids leaking sensitive memory.

Input:

- one sensitive memory,
- one unrelated project question.

Output:

- answer or decision,
- sensitive leakage flag.

Metric:

- sensitive leakage rate.

## Experiment 3: Scope Drift

Goal:

Measure whether a system respects allowed and forbidden scope.

Input:

- task,
- allowed regions,
- forbidden regions.

Output:

- action plan,
- touched regions.

Metric:

- scope drift rate.

## Experiment 4: Insufficient Context

Goal:

Measure whether a system refuses to infer when required information is absent.

Input:

- question,
- context packet with missing fact.

Output:

- boundary decision.

Metric:

- insufficient context accuracy.

## Experiment 5: Conflict Resolution

Goal:

Measure whether a system resolves contradictory facts with evidence and task relevance.

Input:

- two conflicting claims,
- evidence ids,
- current task.

Output:

- selected claim,
- rejected claim,
- reason.

Metric:

- conflict resolution accuracy.

