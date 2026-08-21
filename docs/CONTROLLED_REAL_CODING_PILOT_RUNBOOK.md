# Controlled Real Coding Pilot V1 Runbook

This is the authoritative operational runbook for the controlled real coding pilot v1. The pilot demonstrated one bounded coding task under governed execution. It did not demonstrate arbitrary autonomous coding.

## Canonical lifecycle

```text
source/PR SHA
→ Runpod runtime provenance validation
→ controlled live pilot
→ FINAL_GATE=PASS
→ evidence bundle
→ independent evidence verification
→ acceptance record
→ merge authorization
→ merge
→ go/no-go archival record
```

Run live execution and evidence production on Runpod. Use the MAC operator environment to inspect CI, authorize and perform the merge, maintain this runbook, and archive the final go/no-go metadata.

## Critical ordering rule

Generate the evidence bundle **while the Runpod repository is still checked out at the exact live-tested source commit**. Do not merge the PR, switch branches, or move `HEAD` first.

The evidence bundler fails closed unless its expected source commit equals repository `HEAD` and the report source commit. It snapshots the working target blob, records its hash, and fails if the source or report inputs change during bundling. The independent verifier requires the expected commit to match the manifest and report and, when that historical commit exists locally, fails if its target blob disagrees. Moving `HEAD` before bundling therefore breaks the commit binding instead of producing portable evidence for the tested run.

## MAC: select and approve the source

Inspect the PR, its exact head SHA, reviews, and required checks:

```bash
gh pr view <pr-number> --json headRefOid,mergeable,reviewDecision,statusCheckRollup
gh pr checks <pr-number> --required
```

Record `headRefOid` as `TESTED_SOURCE_COMMIT`. Do not authorize a merge until the Runpod workflow below has produced a verified evidence bundle and acceptance record for that exact SHA.

After all go criteria pass, merge the approved PR from the MAC operator environment:

```bash
gh pr merge <pr-number> --merge --match-head-commit "$TESTED_SOURCE_COMMIT"
```

The pilot and acceptance artifact do not call GitHub APIs, change Git refs, or perform this merge.

## RUNPOD: checkout the exact source

Use a clean checkout containing the merged pilot, provenance, evidence, verifier, and acceptance scripts:

```bash
export TESTED_SOURCE_COMMIT=<exact-40-character-source-sha>
git fetch origin
git checkout --detach "$TESTED_SOURCE_COMMIT"
test "$(git rev-parse HEAD)" = "$TESTED_SOURCE_COMMIT"
```

Configure provider credentials only through the Runpod process environment or the existing `/workspace/load-env.sh`. Never put credentials in commands, reports, or artifacts.

## RUNPOD: validate runtime provenance and run the pilot

The default required llama.cpp provenance is:

```bash
LLAMA_EXPECTED_BUILD=9754
LLAMA_EXPECTED_COMMIT_PREFIX=52b3df002
```

The build check is mandatory. Commit-prefix validation is enabled by default. Setting `LLAMA_EXPECTED_COMMIT_PREFIX` to an explicit empty string disables only the prefix check; it does not disable build validation. Any provenance mismatch fails before provider execution.

The canonical invocation uses the checked-out commit directly:

```bash
EXPECTED_SOURCE_COMMIT="$(git rev-parse HEAD)" bash scripts/runpod-controlled-pilot-bootstrap.sh
```

The bootstrap validates runtime provenance, starts the configured local llama.cpp server and proxy, runs the controlled pilot with its one-call budget and zero transport retries, validates the report, and prints the final gate.

### Required live success invariants

The report and bootstrap output must establish all of the following:

```text
status=completed
providerCallCount=1
retryCount=0
authorityPassed=true
verifierPassed=true
artifactProduced=true
artifactValid=true
sourceWorktreeMutated=false
githubMutationObserved=false
budgetExceeded=false
cleanupCompleted=true
failureCode=null
FINAL_GATE=PASS
```

Any missing or different value is a failed run.

## RUNPOD: bundle, verify, and accept evidence

Remain on `TESTED_SOURCE_COMMIT`. The bootstrap's default report directory is `reports/controlled-coding-pilot`.

### 1. Create the evidence bundle

```bash
node scripts/controlled-coding-pilot-evidence.cjs \
  --report-dir reports/controlled-coding-pilot \
  --out-dir reports/controlled-coding-evidence \
  --expected-source-commit "$TESTED_SOURCE_COMMIT"
```

Require `EVIDENCE_BUNDLE=PASS`.

### 2. Verify the evidence independently

```bash
node scripts/controlled-coding-pilot-evidence-verify.cjs \
  --bundle-dir reports/controlled-coding-evidence \
  --expected-source-commit "$TESTED_SOURCE_COMMIT"
```

Require `EVIDENCE_VERIFY=PASS`. The verifier checks:

- the exact regular-file inventory under `report/`;
- every listed file's byte size and SHA-256;
- canonical `evidenceHash` and canonical `reportHash` semantics;
- governed report success constraints;
- report/manifest metadata agreement;
- the expected source commit;
- normalized relative paths, rejecting absolute paths and traversal;
- symlinks, special files, missing files, and unexpected files;
- the historical target blob when the source commit is available in the local Git repository.

`sourceBlobVerification=verified` means the local historical commit and target blob matched. `sourceBlobVerification=unavailable` means that commit was not available in the verifier's local repository; this state alone does not fail an otherwise valid evidence bundle. If the commit is available and the blob differs, verification fails.

### 3. Produce the acceptance record

Use the actual runtime provenance reported by the bootstrap:

```bash
node scripts/controlled-coding-pilot-acceptance.cjs \
  --bundle-dir reports/controlled-coding-evidence \
  --expected-source-commit "$TESTED_SOURCE_COMMIT" \
  --llama-build 9754 \
  --llama-commit 52b3df002 \
  --out reports/controlled-coding-evidence/acceptance-record.json
```

Require `ACCEPTANCE_RECORD=PASS`. The generator invokes the independent verifier first, propagates its actual `sourceBlobVerification` state, copies protected evidence fields from the verified manifest, records llama.cpp provenance, and computes a deterministic `acceptanceHash`. It emits `finalGatePassed=true` and `mergeEligible=true` only after successful verification.

The acceptance record is a merge-authorization artifact. It does not merge a PR or mutate GitHub.

## MAC: merge authorization and archival record

Transfer the complete evidence bundle and acceptance record from Runpod through the approved artifact channel. Before merging:

1. Re-run the independent verifier where practical with the exact tested source commit.
2. Confirm the acceptance record matches the reviewed PR SHA and runtime provenance.
3. Record `reportHash`, `evidenceHash`, `acceptanceHash`, `sourceTargetBlobHash`, and `sourceBlobVerification`.
4. Confirm required CI remains green and authorize the merge only if every go criterion below passes.

After merge, record the resulting merge commit and preserve the final evidence archive in the release/go-no-go record. Verify a received archive without extracting it:

```bash
shasum -a 256 <acceptance-archive>
```

Store the checksum alongside the tested source commit, merge commit, runtime provenance, evidence hashes, acceptance hash, and final GO/NO-GO decision.

## Pilot v1 accepted reference run

```text
testedSourceCommit: e23e5fc58ec6107a459993ed172256d256045736
runtimeProvenanceMergeCommit: 360fd6392efc623b8fb016cc146aa420d21a05a9
modelId: qwen2.5-coder-7b
llamaBuild: 9754
llamaCommit: 52b3df002
providerCallCount: 1
retryCount: 0
patchLineCount: 18
reportHash: sha256:e74190ba3414945709f58c3e47086f6822ebbf5c64df7b8a0efc347880b01b2e
evidenceHash: sha256:ef8061acd86f60e6bea5ee387c0b0388426f45806d14d079a443e1cf90b5bbc9
acceptanceHash: sha256:cc7a383608f0d57e775f4971bf9fd50a45ba39a326eb6633c466769be57f29ff
sourceTargetBlobHash: e3b973ff81543207de4ba5953818f076f9a55951
archiveSha256: 2bad2499d515941fbc6218d45d4052febdd2c6c3321645e31ebd4d00a2dda588
result: PASS
```

This reference establishes acceptance for that bounded task, source commit, model, and runtime only.

## Troubleshooting

### Runtime provenance mismatch

Confirm `llama-server --version` reports build `9754` and a commit beginning with `52b3df002`, or set approved expected values explicitly. A mismatch is a pre-provider failure; do not continue using a report from that attempt.

### Local model unavailable

Confirm `LLAMA_MODEL_PATH` points to the intended readable GGUF and `LLAMA_SERVER_BIN` is executable. Do not substitute a different model silently; record and approve any provenance change before rerunning.

### Runpod proxy unavailable

Confirm the local llama.cpp server is healthy, the configured ports are free, and Runpod exposes the intended HTTP port. Retry only after the local server and proxy health checks pass.

### Exact source SHA mismatch

Stop. Checkout the recorded `TESTED_SOURCE_COMMIT`, confirm `git rev-parse HEAD`, and rerun the live pilot. Do not rewrite report or manifest commit fields.

### Evidence verification failure

Treat the run as NO-GO. Preserve diagnostics, restore the original evidence from the producer, and rerun from the exact source commit. Do not edit hashes, file lists, or reports to make verification pass.

### `sourceBlobVerification=unavailable`

This means the verifier's current Git repository does not contain the historical commit. Fetch the commit through an approved source and rerun verification when historical blob attestation is required. Do not relabel `unavailable` as `verified`. Availability alone is not evidence corruption.

## Historical and deprecated procedures

The temporary `/tmp` script-extraction workflow used for the original PR #149 acceptance was a one-time compatibility measure because that tested branch predated the merged evidence tooling. It is historical and is not the canonical flow.

Direct lower-level pilot invocation and manually assembled evidence are also non-canonical for final acceptance. Use the bootstrap followed by the repository bundler, verifier, and acceptance scripts in the order documented above.

## Final go/no-go checklist

The decision is **GO** only when all items are true:

- [ ] Required CI is green.
- [ ] The exact source commit was tested.
- [ ] llama.cpp runtime provenance was verified.
- [ ] `FINAL_GATE=PASS`.
- [ ] `providerCallCount == 1`.
- [ ] `retryCount == 0`.
- [ ] The governed verifier passed.
- [ ] The source worktree was not mutated.
- [ ] GitHub was not mutated by the agent.
- [ ] The evidence bundle passed independent verification.
- [ ] The source blob was verified when the historical commit was locally available.
- [ ] An acceptance record was produced.
- [ ] The `acceptanceHash` was recorded.
- [ ] The evidence archive checksum was recorded.

If any item is false or unresolved, the decision is **NO-GO**.
