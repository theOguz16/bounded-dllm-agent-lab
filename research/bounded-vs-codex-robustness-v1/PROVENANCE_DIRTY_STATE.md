# Robustness worktree provenance evidence

Captured: 2026-09-28T20:09:30.160356+00:00

Current HEAD: `3bdd4e9e04e59359fe02fb068592f6733c40d144`

Current status before writing this report:
```text
```
Current `git diff --stat`:
```text
```
The r3 identity record captured this earlier dirty status before the concurrent commit:
```text
M apps/cli/src/commands/codex.ts
 M packages/integrations/src/agent-adapter.ts
 M packages/integrations/src/codex-agent-adapter.ts
?? packages/integrations/src/codex-coder-trajectory.ts
```
The later read-only status also included `research/bounded-vs-codex-robustness-v1/observation-overlay.cjs` as untracked. The exact pre-commit diff and untracked bytes were not contemporaneously saved; the following is reconstructed from the single intervening commit.

Intervening commit: `3bdd4e9e04e59359fe02fb068592f6733c40d144`. Parent: `c5709ec91a421a59556b0519d80a3752733a0bf0`.

Commit diff stat:
```text
 apps/cli/src/commands/codex.ts                     |  11 ++
 package.json                                       |   4 +-
 packages/integrations/src/agent-adapter.ts         |   2 +
 packages/integrations/src/codex-agent-adapter.ts   |   9 +-
 .../integrations/src/codex-coder-trajectory.ts     | 198 +++++++++++++++++++++
 .../OBSERVABILITY.md                               |  11 ++
 .../observation-overlay.cjs                        |  32 ++++
 .../bounded-vs-codex-robustness-v1/preflight.cjs   |   5 +
 .../run-observation.cjs                            |  15 +-
 .../trajectory-analysis.cjs                        | 111 ++++++++++++
 .../trajectory.test.cjs                            | 128 +++++++++++++
 .../smoke/bounded-codex-explicit-scope-smoke.cjs   |   9 +
 12 files changed, 528 insertions(+), 7 deletions(-)
```

## apps/cli/src/commands/codex.ts

```diff
diff --git a/apps/cli/src/commands/codex.ts b/apps/cli/src/commands/codex.ts
index b61cc423..6a2d2845 100644
--- a/apps/cli/src/commands/codex.ts
+++ b/apps/cli/src/commands/codex.ts
@@ -753,6 +753,7 @@ export async function codexCommand(
     result.verifierResult ? "FAIL" : "NOT_RUN";
   const testStatus = validationStatus(tests?.status);
   const actualModel = recordedRuns.at(-1)?.result.modelId ?? model;
+  const expansionSummary = result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.summary;
   const behavior = testStatus === "PASS" && requiredTestFiles.length > 0
     ? "PASS" as const
     : "NOT_DEMONSTRATED" as const;
@@ -786,6 +787,16 @@ export async function codexCommand(
       aggregation: "sum of per-provider-call cumulative thread usage (planner + coder); cached input is a subset",
       tokenObservability: tokenObservability(result, recordedRuns)
     },
+    ...(process.env.ROBUSTNESS_CODER_TRAJECTORY === "1" ? {
+      coderTrajectoryTelemetry: recordedRuns.find(run => run.request.mode === "coder")
+        ?.result.trajectoryTelemetry ?? null,
+      contextExpansionTelemetry: expansionSummary ? {
+        attemptCount: expansionSummary.expansionAttemptCount,
+        requestedFileCount: expansionSummary.requestedFileCount,
+        loadedExpansionFileCount: expansionSummary.loadedExpansionFileCount,
+        contextRequestProviderCallCount: expansionSummary.contextRequestProviderCallCount
+      } : null
+    } : {}),
     candidate: {
       changedFileCount: changedFiles.length,
       files: changedFiles
```

## packages/integrations/src/agent-adapter.ts

```diff
diff --git a/packages/integrations/src/agent-adapter.ts b/packages/integrations/src/agent-adapter.ts
index 89443677..cfde2596 100644
--- a/packages/integrations/src/agent-adapter.ts
+++ b/packages/integrations/src/agent-adapter.ts
@@ -136,6 +136,8 @@ export interface AgentRunResult {
   commands: AgentCommandEvent[];
   fileChanges: AgentFileChangeEvent[];
   diagnostics: AgentDiagnostic[];
+  /** Additive, bounded Codex coder observations; never part of provider control. */
+  trajectoryTelemetry?: import("./codex-coder-trajectory.js").CodexCoderTrajectory | null;
 }

 export interface AgentAdapter {
```

## packages/integrations/src/codex-agent-adapter.ts

```diff
diff --git a/packages/integrations/src/codex-agent-adapter.ts b/packages/integrations/src/codex-agent-adapter.ts
index 898bbcc0..263afc54 100644
--- a/packages/integrations/src/codex-agent-adapter.ts
+++ b/packages/integrations/src/codex-agent-adapter.ts
@@ -58,6 +58,7 @@ import {
   type CodexEventParserResult,
   type CodexNormalizedCommandEvent
 } from "./codex-event-parser.js";
+import { deriveCodexCoderTrajectory } from "./codex-coder-trajectory.js";

 export const CODEX_AGENT_ID = "codex" as const;
 export const CODEX_SDK_VERSION = "0.153.4" as const;
@@ -520,6 +521,11 @@ export class CodexAgentAdapter implements AgentAdapter {
     const parsed = parseCodexJsonl(lines.join("\n"), {
       processAborted: finalTermination !== "none", durationMs
     });
+    let trajectoryTelemetry: ReturnType<typeof deriveCodexCoderTrajectory> | null = null;
+    if (request.mode === "coder") {
+      try { trajectoryTelemetry = deriveCodexCoderTrajectory(lines.join("\n"), commandTimings); }
+      catch { trajectoryTelemetry = null; }
+    }
     const workerDiagnostic = workerResult !== null &&
       (workerResult.exitCode !== 0 || parsed.status !== "completed")
       ? createWorkerFailureDiagnostic({
@@ -659,7 +665,8 @@ export class CodexAgentAdapter implements AgentAdapter {
       },
       commands,
       fileChanges: mapFileChanges(parsed),
-      diagnostics
+      diagnostics,
+      ...(request.mode === "coder" ? { trajectoryTelemetry } : {})
     };
   }
 }
```

## packages/integrations/src/codex-coder-trajectory.ts

Current committed SHA-256: `2c6f440d22ac0c68a41bebd0126e4bc16aea9b7631f31191f1adc6a64034da80`; bytes: 10475.

## research/bounded-vs-codex-robustness-v1/observation-overlay.cjs

Current committed SHA-256: `0a5777b898ea98ed16e000a4124ac2bfcb2375941bd84fdf77694a054e366bc4`; bytes: 1502.
## Provenance classification and audit

The five paths that were dirty at the r3 stop all entered the robustness branch in commit `3bdd4e9e04e59359fe02fb068592f6733c40d144`. No path remains unknown.

| Path | Classification | Provenance |
| --- | --- | --- |
| `packages/integrations/src/codex-coder-trajectory.ts` | intended audited telemetry integration | Git blob `eaa6a9fc98836785525ed999de197b68f801ec4a` is byte-identical to context-research commit `55e8767d641bbe093dc0af8dd78ed459718d0929`. |
| `packages/integrations/src/agent-adapter.ts` | intended audited telemetry integration | The added type-only trajectory field is text-identical to the audited commit's added lines. |
| `packages/integrations/src/codex-agent-adapter.ts` | intended audited telemetry integration | The added import, post-parse derivation, and optional result field are text-identical to the audited commit's added lines; surrounding line numbers differ. |
| `apps/cli/src/commands/codex.ts` | intended robustness harness integration | Robustness-only environment flag conditionally adds trajectory and context-expansion fields to returned JSON, after task execution. It was not present in `55e8767d` and was added by `3bdd4e9e`. |
| `research/bounded-vs-codex-robustness-v1/observation-overlay.cjs` | intended robustness harness integration | Created by `3bdd4e9e`; copies exactly three compiled observational modules into ignored `dist/` of a disposable pinned-source Bounded checkout, checking pinned HEAD and tracked cleanliness. It neither invokes a provider nor changes tracked source. |

The overlay is a runtime telemetry integration, not merely a report normalizer. The three overlaid source modules differ from the pinned source only by the observational additions above: the trajectory collector parses already-captured JSONL after canonical parsing, the adapter adds its result field after stream completion, and the CLI adds output fields after the Bounded result exists. The collector is pure over JSONL and command timings, and its errors are caught to null. The Bounded-only flag does not alter prompt construction, SDK invocation, tool handling, Candidate construction, routing, or validation. Normal checkouts do not receive the overlay. The fixture asserts one fake provider invocation, unchanged prompt, model, usage, and command order. This is code/fixture evidence, not a claim that a live run has been observed.

`benchmark-manifest.json` differs from the freeze commit only in historical session metadata (`sessionId` was changed to `robustness-v1-2026-09-28-r2` before this task). `tasks[]`, all task hashes, task wording, difficulty, allowed files, task oracles, pair order, source SHA, model/reasoning, and retry/repair/apply policy are byte-identical to the frozen entries. `PROTOCOL.md` and all five oracle files are unchanged from freeze. The trajectory fixture recomputed all five task hashes and checked the ten-position pairing.

Offline audit results at `3bdd4e9e`: `npm run product:v1-check` PASS (typecheck, build, Product V1); `node research/bounded-vs-codex-robustness-v1/trajectory.test.cjs` PASS; `node research/bounded-vs-codex-robustness-v1/preflight-support.test.cjs` PASS; `node research/bounded-vs-codex-robustness-v1/telemetry.test.cjs` PASS; `node scripts/smoke/codex-token-observability-smoke.cjs` PASS; `npm run test:run-cost-ledger` PASS (21 checks); `ROBUSTNESS_CODER_TRAJECTORY=1 node scripts/smoke/bounded-codex-explicit-scope-smoke.cjs` PASS. All fixtures used fake/local data; real provider/model calls: **0**. The committed tree had no whitespace errors (`git diff --check`). No benchmark session or observation was started in this task.
