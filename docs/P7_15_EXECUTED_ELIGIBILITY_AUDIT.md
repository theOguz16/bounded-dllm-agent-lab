# P7.15 — executed eligibility audit

The v2 task set is immutable and separately versioned. The audit executes all 20 P7.14 source/reference/wrong triads and emits one eligibility record per task. It requires the audited 5/5/5/5 distribution, immutable commit objects, modified-existing-file-only diffs, package and lockfile identities, task-specific target behavior, the independent checker hash, and a wrong implementation that is observed to fail.

Dependency preparation and validation are separate phases. `npm ci` may use the configured package cache or registry before validation. The validation process clears proxy variables, declares network disabled, makes no provider calls, and records that policy rather than treating local authentication as reachability. The workflow pins Node 22.14.0 and records the GitHub Ubuntu 24.04 image label; the produced audit also records Node, npm, platform, taskset, catalog, triad artifact, package and lockfile hashes.

An unaudited task is never eligible. Missing package/lockfile bytes, a non-`M` diff, incomplete triad, or a wrong implementation that escapes the checker makes the record non-eligible. The historical taskset is not rewritten to make a failing task pass; any future selection change requires a new taskset version and an explicit reason.

On macOS, an unavailable Git toolchain (including an unaccepted Xcode license) is an environment `blocked` condition, not an assertion failure and not eligibility evidence. The canonical execution is the Linux CI artifact attached to the exact candidate SHA.
