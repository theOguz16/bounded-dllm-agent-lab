# Offline deterministic repair import

Run `bounded repair --task-id <persisted-task-id> --repair-draft <absolute-json-file> --json` from the source repository. The command reads the original terminal candidate from canonical durable state. It does not invoke a planner, coder, model, or provider, and it never applies the candidate.

The JSON document uses `bounded-repair-import/v1`:

```json
{
  "schemaVersion": "bounded-repair-import/v1",
  "taskId": "codex.…",
  "originalCandidateHash": "sha256:…",
  "sourceSnapshotHash": "sha256:…",
  "validationFailureHash": "sha256:…",
  "boundaryHash": "sha256:…",
  "request": {
    "schemaVersion": "targeted-repair-request/v1",
    "originalCandidateHash": "sha256:…",
    "failingFiles": ["tests/smoke/contracts.ts"],
    "failingChecks": ["validation.test"],
    "verifierIssues": [],
    "allowedFiles": ["tests/smoke/contracts.ts"],
    "preserveFiles": ["packages/worker-contract/src/index.ts"],
    "repairRound": 1
  },
  "mutation": {
    "role": "remask",
    "target": "repairDraft",
    "summary": "Correct the acceptance stub",
    "claims": [{
      "claimVersion": "text-file-update/v1",
      "type": "repair_draft",
      "operation": "update",
      "file": "tests/smoke/contracts.ts",
      "expectedContentHash": "sha256:…",
      "newContent": "<entire repaired UTF-8 file>",
      "description": "Return schema-valid stub responses with requestId preserved"
    }],
    "touchedFiles": ["tests/smoke/contracts.ts"],
    "confidence": 1
  }
}
```

`originalCandidateHash` is the canonical hash of the persisted coder mutation. `sourceSnapshotHash` and `validationFailureHash` are the original durable state's baseline snapshot and terminal result hashes. `boundaryHash` is the canonical hash of the trusted `TargetedRepairBoundary` containing the original mutation files, policy paths, and acceptance paths. Each repair claim's `expectedContentHash` hashes the corresponding **Candidate A** file content. The importer verifies these bindings against durable state; operator-supplied candidate content is never used as the original.

The importer merges only the authorized new file content into Candidate B, preserving Candidate A's original source hashes and all untouched file content. It runs the repair gate, deterministic verifier, pinned offline container validation commands, the normal validation profile, and the acceptance contract. On full PASS it writes an immutable `bounded-derived-repair/v2` record, including the repair request and mutation, at `.bounded/state/derived-repairs/<derived-candidate-hash>.json` and writes a `bounded-candidate-handoff/v2` handoff. The handoff hash covers explicit repair provenance, including Candidate A, repair artifact, Candidate B, and the record's raw-byte SHA-256 and size. Before approval and again before execution, `bounded apply` rereads the canonical failed task and repair record, checks their identities and hashes, and reconstructs Candidate B from Candidate A and the repair mutation. A missing or altered record stops apply. Normal handoffs use `provenance.kind: "bounded_run"`; existing v1 normal handoffs remain supported when their canonical durable task completed successfully. Human approval remains bound to the handoff hash.
