# Evidence Index

> GENERATED FILE — source of truth: `evidence/index.json`.
> Do not edit experiment status in Markdown; update and verify the machine-readable index instead.

Index schema: `bounded.evidence-index/v1`  
Index hash: `sha256:429da3d6693a9ad9b0696c5f8a324c01c47cd75e39d0020cf7b009a64bda7688`

| Experiment | Family | Status | Evidence class | Provider | Model | Artifact |
| --- | --- | --- | --- | --- | --- | --- |
| `legacy-unified-release-v0.1` | `legacy_unified_benchmark` | **observed** | `mixed_observed_release_evidence` | runpod-llama-cpp | qwen2.5-coder-7b | `reports/release/UNIFIED_BENCHMARK.json`<br>`sha256:b74fba212cee0f98c77c8d4505e6fed78a372f2b07c30e08086a6fadea6001bd` |
| `gate5-a-e-external-ablation` | `gate5` | **fixture** | `deterministic_fixture_contract` | — | — | — |
| `gate5-mode-f-c-e-f` | `gate5` | **pending** | `live_validation_pending` | — | — | — |
| `controlled-coding-pilot-v1-runpod-live-help` | `controlled_coding_pilot_v1` | **observed** | `controlled_coding_pilot_observed` | runpod | qwen2.5-coder-7b | `docs/CONTROLLED_REAL_CODING_PILOT_V1_ACCEPTANCE.md`<br>`sha256:ef8061acd86f60e6bea5ee387c0b0388426f45806d14d079a443e1cf90b5bbc9` |
| `controlled-coding-pilot-v2-suite` | `controlled_coding_pilot_v2` | **pending** | `observed_run_pending` | — | — | — |

## Status reasons

- `legacy-unified-release-v0.1`: Durable release synthesis is committed and its internal report hash is verifiable.
- `gate5-a-e-external-ablation`: A-E harness and fixture contract exist, but no durable live A-E result artifact is registered in the repository.
- `gate5-mode-f-c-e-f`: Mode F continuation is active in PR #166; live C/E/F evidence is pending while the RunPod provider is unavailable.
- `controlled-coding-pilot-v1-runpod-live-help`: Final acceptance record binds the tested source, model provenance, report, evidence bundle, acceptance hash, and archive checksum.
- `controlled-coding-pilot-v2-suite`: Two V2 tasks and immutable observed-evidence tooling exist; real provider runs are deferred while RunPod is unavailable.

## Programmatic queries

```bash
node scripts/evidence-index.cjs verify
node scripts/evidence-index.cjs status gate5
node scripts/evidence-index.cjs status controlled_coding_pilot_v2
node scripts/evidence-index.cjs generate --check
```
