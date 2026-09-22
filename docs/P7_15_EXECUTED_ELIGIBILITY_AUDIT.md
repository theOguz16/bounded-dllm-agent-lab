# P7.15 — executed eligibility audit

The v2 task set is immutable and separately versioned. The audit executes all 20
P7.14 source/reference/wrong/candidate checks and emits one eligibility record per
task. A record is eligible only when dependency preparation succeeds, the executed
semantic triad is fail/pass/fail, the real candidate passes, the wrong candidate is
caught, and the OS network canary proves validation isolation. File/hash equality is
identity evidence only; it is never behavior evidence.

Dependency preparation and validation are separate executed phases. `npm ci` may use
the configured package cache or registry before validation. Build and assertions run
under `unshare -n` on Linux or a deny-network sandbox on supported macOS hosts, with
a network canary that must observe denial. Clearing proxy variables or declaring a
policy is not accepted as isolation proof.

An unaudited task is never eligible. Missing package/lockfile bytes, a non-`M` diff, incomplete triad, or a wrong implementation that escapes the checker makes the record non-eligible. The historical taskset is not rewritten to make a failing task pass; any future selection change requires a new taskset version and an explicit reason.

On macOS, an unavailable Git toolchain (including an unaccepted Xcode license) is an environment `blocked` condition, not an assertion failure and not eligibility evidence. The canonical execution is the Linux CI artifact attached to the exact candidate SHA.
