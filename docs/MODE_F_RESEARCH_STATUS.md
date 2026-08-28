# Mode F research status

Status: **ACTIVE — live C/E/F validation pending**.

Mode F (`F_adaptive_compressed_boundary`) is not abandoned and is not the same experiment as Controlled Pilot V2 bounded text edits.

Controlled Pilot V2 currently uses task-owned bounded context selections to test a governed coding path. Mode F asks a different research question: whether a synthetic candidate stage followed by deterministic evidence resolution can compress an E-style bounded workspace while preserving exact scope, authority, critical symbol/test evidence, and success rate at lower token cost.

The original implementation lived in draft PR #143. That PR became stale against the current runtime and is archived in favor of the continuation branch/PR based on current `main`.

## Fixed live benchmark

The live comparison keeps the original three immutable external repository commits:

- `sindresorhus/p-limit@df476048d023ff868cd45b35ee47f5fb0ca2b25a`
- `lukeed/clsx@925494cf31bcd97d3337aacd34e659e80cae7fe2`
- `sindresorhus/yocto-queue@b07eac099753833b29d06c614149904445739776`

Modes C, E, and F must be executed with the same provider/model configuration and the same repetition count. The default is three repetitions per repository/mode.

## Required evidence before completion

A live result is complete only when `scripts/gate5-mode-f-live-evidence.cjs` records and hashes:

- lab source commit SHA,
- Mode F benchmark Git blob and file hash,
- model ID,
- sanitized provider transport/endpoint identity,
- temperature and max completion tokens,
- repetition count,
- the three immutable external repository commit SHAs,
- the raw C/E/F report byte hash and internal report hash,
- aggregate quality/cost metrics,
- an evidence hash over the provenance record.

The live run command is:

```bash
export GATE5_OPENAI_ENDPOINT='https://.../v1/chat/completions'
export GATE5_MODEL='qwen2.5-coder-7b'
export GATE5_API_KEY='...'
export GATE5_MAX_COMPLETION_TOKENS='256'

node scripts/gate5-mode-f-live-evidence.cjs \
  --live \
  --repetitions=3 \
  --output=reports/gate5/mode-f-live-evidence.json
```

The resulting evidence JSON and its `.raw.json` report should be committed together. Live failures are research results and should not be silently replaced by fixture output.

## Decision after live validation

After one reproducible live C/E/F run, compare strict success, file-scope success, symbol precision/recall/F1, critical implementation/test-anchor coverage, scope drift, tokens per success, latency, and context bytes.

If F does not provide a meaningful quality/cost advantage over E, archive the experiment with that negative result. If it does, use the evidence to decide whether its candidate-to-resolver compression should inform the newer adaptive-context/runtime path.
