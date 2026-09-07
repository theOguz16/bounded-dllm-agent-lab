# Canonical runtime benchmark

`scripts/canonical-runtime-benchmark.cjs` is the product-facing benchmark adapter. Each sample creates an isolated repository, records its baseline Git commit, and invokes the public `runBoundedTask` entry point. Its report keeps structural file selection, behavior-test status, policy compliance, safe-stop/recovery state, duration, cost reservations, and runtime evidence separate. The offline fixture materializes the returned mutation in a separate candidate workspace and runs hidden assertions against that candidate; scenario names and structural verifier success never determine behavior status. If no candidate or runner is available, the check is `not_run`, never `passed`.

The report schema is `canonical-runtime-benchmark/v2`. Version 1 offline reports did not prove that behavior assertions ran and must not be reinterpreted as v2 evidence; regenerate them with the current adapter.

The existing Gate6 live runner and simulated coding harness remain research artifacts. Their observations are not relabeled as canonical-runtime results. The canonical adapter reports `executionClass: canonical_runtime_offline_fixture` and `liveModelEvidence: false` for its deterministic fixture run.

Hidden oracle data is verifier-only. The benchmark never places oracle fields, acceptance probe answers, or fault-injection evidence in planner/coder input. A solution that selects the right file but produces broken behavior has `fileScopeSuccess: true` and `endToEndAccepted: false`; safe rejection, no-change, timeout, and recovery-required outcomes are reported separately rather than counted as task success.

The frozen Gate6 taskset and `benchmarks/gate6/benchmark-semantics.json` remain the source of truth for live comparative runs. A live benchmark must use the same task commit, acceptance contract, validation profile, and documented cost budget for every baseline comparison. No live model or paid-provider claim is made by the offline adapter.
