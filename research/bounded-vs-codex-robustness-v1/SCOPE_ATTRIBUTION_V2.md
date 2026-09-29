# Scope attribution v2 (future protocol design)

`robustness-scope-attribution/v2` separates four facts that v1 combined:

1. `preparedWorkspace`: the hash-only delta from the pinned checkout to the exact pre-agent state. Every entry is attributed to benchmark preparation.
2. `agentWorkspaceMutations`: the hash-only delta from that pre-agent state to the post-agent, pre-validation state. Created, modified, and deleted files are distinct. This includes an agent deleting a prepared file.
3. `candidatePatch`: created, modified, and deleted paths from a persisted Git patch or a derived Candidate workspace/artifact. A Bounded mutation handoff must be reconstructed into equivalent before/after Candidate manifests, or supply explicit mutation operations. Final generation-workspace status alone is not Candidate evidence.
4. `validationRuntimeMutations`: separate post-handoff deltas for validation, runtime, telemetry, and generated-output handling. Each needs phase-boundary manifests; absent evidence is `null`, never a fabricated empty delta.

All paths are normalized repository-relative paths. Hashes are SHA-256. The schema contains paths, hashes, operations, and bounded provenance only; it never emits raw file contents. No `.bounded/**` exemption exists. The same attribution and grading functions apply to Normal and Bounded.

`candidatePatchScopePass`, `agentWorkspaceMutationScopePass`, and `validationWorkspaceScopePass` are independent `true`/`false`/`null` fields. A missing Candidate artifact produces `candidatePatchScopePass: null` and `candidateEvidenceState: "unknown"`; primary benchmark scope fails closed. Validation scope is `null` without post-handoff phase evidence. An explicit validation-output allowlist is separate from the coding-task allowlist.

For a future coding-Candidate comparison, `benchmarkV2PrimaryScopePass` follows **Candidate patch scope**. The benchmark claims to compare the quality and allowed-file scope of produced coding Candidates. Agent workspace mutation scope remains a separately reported safety and behavior measure. This choice applies prospectively and does not alter frozen robustness-v1 results. If a later benchmark claims to grade all agent filesystem behavior as primary, it must say so in its own frozen protocol.

The deterministic fixture with a prepared `.bounded/config.json`, its agent-directed deletion, and an allowed implementation patch yields Candidate scope PASS, agent workspace mutation scope FAIL, and unaffected validation scope PASS. It records the deletion instead of suppressing it. The framework is not wired into the frozen v1 runner; a future runner must persist its phase manifests and Candidate evidence before using this schema for live grading.
