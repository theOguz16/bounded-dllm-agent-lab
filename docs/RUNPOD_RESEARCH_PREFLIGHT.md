# RunPod Research Preflight

`npm run preflight:runpod-research` is the provider-free readiness check for the two pending live research tracks:

- Controlled Pilot V2 observed evidence (`research/v2-observed-run-evidence`)
- Gate 5 Mode F C/E/F validation (`research/mode-f-live-validation`)

The preflight never invokes a model/provider. Mode F fixture validation does clone the three pinned public external repositories, so GitHub network access is a local research dependency even when provider credentials are unavailable.

## Readiness states

The command emits one machine-readable JSON document.

- `localReady=true`: repository, Controlled Pilot V2, evidence identity, observed-evidence fixture verification, Mode F fixture/evidence/promotion checks, and output-directory checks all passed.
- `providerReady=true`: the provider configuration shape required for the live research run is complete.
- `runpodReady=true`: both local and provider readiness are true.
- top-level `ready` is identical to `runpodReady`.

Missing provider credentials do **not** make local readiness fail. With no provider configuration, a successful local preflight reports `localReady=true`, `providerReady=false`, and `runpodReady=false`.

## Repository contract

By default the command requires the current branch to be `main`, a completely clean working tree, and captures the exact `HEAD` SHA before research checks run. CI may set `RESEARCH_PREFLIGHT_EXPECTED_BRANCH=HEAD` for a detached checkout.

The preflight resolves the two pending research branches by their remote refs. Override only when intentionally validating another research ref:

```bash
RESEARCH_PREFLIGHT_CONTROLLED_REF=research/v2-observed-run-evidence
RESEARCH_PREFLIGHT_MODE_F_REF=research/mode-f-live-validation
```

The preflight executes their provider-free fixture/verifier tooling in temporary detached worktrees. It does not merge either research branch into the current branch and removes the temporary worktrees afterward.

## Controlled Pilot V2 checks

The preflight verifies:

- both canonical V2 task definitions with the canonical definition validator;
- the canonical taskset identity hash against `evidence/index.json`;
- `scripts/controlled-coding-pilot-offline-gate-smoke.cjs`;
- `scripts/controlled-coding-pilot-text-edits-adversarial-smoke.cjs`;
- PR #165 observed-evidence publish/verify/tamper fixture through `controlled-coding-pilot-observed-evidence-smoke.cjs`;
- writability of `pilots/controlled-real-coding-v2/observed-runs`.

The observed-evidence smoke intentionally blanks provider-related environment variables before it runs.

## Mode F checks

The preflight runs the PR #166 fixture evidence wrapper with three repetitions. That wrapper executes the C/E/F benchmark fixture. It then verifies:

- exactly the C, E, and F definitions are represented;
- exactly three pinned external repositories are represented;
- those repository/task/SHA identities exactly match `evidence/index.json`;
- the evidence wrapper has fixture provenance and an evidence hash;
- the promotion gate rejects fixture evidence with `live_observed_evidence_required`;
- `reports/gate5` is writable.

No Mode F promotion decision is made from fixture evidence.

## Provider configuration shape

The preflight never prints API key values. It reports only whether a key is present, and performs a final serialized-output leak check against any configured key value.

For `providerReady=true`, set the configuration used by the two live tracks:

```bash
export LLM_UPSTREAM_URL='https://.../v1/chat/completions'
export LLM_MODEL_ID='qwen2.5-coder-7b'
export LLM_UPSTREAM_API_KEY='...'

export GATE5_OPENAI_ENDPOINT='https://.../v1/chat/completions'
export GATE5_MODEL='qwen2.5-coder-7b'
export GATE5_API_KEY='...'
export GATE5_MAX_COMPLETION_TOKENS='256'
export RUNPOD_RESEARCH_REPETITIONS='3'
```

`LLM_MODEL_ID` and `GATE5_MODEL` must be identical. Controlled Pilot V2 temperature and max completion tokens are explicit in its committed runtime budget; Mode F temperature is explicitly zero in its evidence wrapper, while `GATE5_MAX_COMPLETION_TOKENS` and research repetitions must be explicit environment values for RunPod readiness.

To state intentionally that no provider is available, either leave all provider fields unset or set:

```bash
export RUNPOD_RESEARCH_PROVIDER='unavailable'
```

This state can still produce `localReady=true`.

## RunPod rule

Run the preflight first and retain its `sourceCommit`. The subsequent live Controlled Pilot V2 and Mode F runs must use that same source commit unless a new preflight is performed. Provider credentials becoming available should require only environment changes: no code change is necessary for the readiness state to move from local-only to full RunPod readiness.
