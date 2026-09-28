# Controlled Pilot V2 observed runs

This protocol produces research evidence for the two canonical Controlled Pilot V2 tasks under one source commit and one provider/model/configuration.

The observed suite is intentionally separate from the success-gated release-evidence formats. A pilot result with `status: failed` or `status: cancelled` is still evidence and is published when provenance construction itself remains valid.

## Canonical tasks

The suite runs, in a fixed order:

1. `controlled-real-coding-v2.local-json-schema-error-classification`
2. `controlled-real-coding-v2.worker-request-id-correlation`

The order is part of the experiment configuration. Both tasks use the same concrete model client instance and the same provider configuration.

## What `raw candidate` means

`raw-provider-candidate.json` is the provider's parsed JSON payload captured immediately after the OpenAI-compatible model client accepts the transport response and before bounded-text-edit materialization. It is serialized canonically for storage and hashed by exact artifact bytes.

If the provider fails before returning an accepted JSON payload, `rawCandidateArtifact` and `rawCandidateHash` are `null`. The failed transport still remains in the run provenance with its failure code and measured latency.

If a candidate exists but is rejected by bounded materialization, patch limits, or verification, the candidate is retained and referenced under `rejectedCandidateArtifacts`.

## Run

Start from a clean checkout of the commit that will be recorded as `sourceCommit`, install dependencies, and build once:

```bash
npm install
npm run build
```

Configure one OpenAI-compatible endpoint and model. The ordinary controlled-pilot provider variables are used:

```bash
export LLM_UPSTREAM_URL='https://provider.example/v1/chat/completions'
export LLM_MODEL_ID='qwen2.5-coder-7b'
export LLM_UPSTREAM_API_KEY='...'
```

A loopback OpenAI-compatible server is also supported through `http://127.0.0.1`, `http://localhost`, or `http://[::1]`.

Live execution requires explicit research attestation:

```bash
export CONTROLLED_OBSERVED_RUN_ATTESTATION='I_CONFIRM_REAL_PROVIDER_CALLS'
node scripts/controlled-coding-pilot-v2-observed-run.cjs \
  --execute-provider \
  --confirm-live
```

The command does not require both pilots to succeed. It publishes a verified content-addressed suite when both pilot executions produced structurally valid provenance, including ordinary failed/cancelled pilot outcomes.

## Immutable layout

Evidence is written under:

```text
pilots/controlled-real-coding-v2/observed-runs/
  <source-commit>/
    <experiment-config-hash>/
      <evidence-hash>/
```

Publishing refuses to replace an already existing `<evidence-hash>` directory. Git history provides the repository-level immutable record after the content-addressed evidence directory is committed.

Each run contains the safe provider request, supplied bounded context, raw provider candidate when one exists, the original pilot output tree, and `run-provenance.json`.

## Verify

From a repository containing the recorded `sourceCommit`:

```bash
node scripts/controlled-coding-pilot-observed-evidence-verify.cjs \
  --bundle-dir pilots/controlled-real-coding-v2/observed-runs/<source-commit>/<config-hash>/<evidence-hash> \
  --expected-source-commit <source-commit>
```

Verification checks the content-addressed manifest and every stored file, then independently resolves the task definition and source target blobs from the recorded commit. It reconstructs the exact bounded context from those committed sources and the committed task selectors and requires that reconstructed context to match the stored supplied-context artifact and the provider request.

It also cross-checks model/provider/configuration identity, raw-candidate and materialized-patch hashes, verifier/acceptance outcomes, token counts, latency fields, rejected-candidate preservation, and the original pilot report.

## Research interpretation

A successful evidence verification means the recorded provenance is internally consistent with the specified commit/task/configuration and stored artifacts. It does not mean the model solved the task. `completed`, `failed`, and `cancelled` are observed outcomes and should remain in the dataset.
