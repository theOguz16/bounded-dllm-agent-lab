# Observed Evidence Promotion Helper

`evidence/index.json` remains the canonical evidence registry. Observed research artifacts must not be hand-promoted from `pending` to `observed` without verifying their provenance first.

Use:

```bash
node scripts/evidence-promote-observed.cjs \
  --experiment controlled-coding-pilot-v2-suite \
  --artifact pilots/controlled-real-coding-v2/observed-runs/<source>/<config>/<evidence> \
  --check
```

or print the deterministic proposed registry entry:

```bash
node scripts/evidence-promote-observed.cjs \
  --experiment controlled-coding-pilot-v2-suite \
  --artifact pilots/controlled-real-coding-v2/observed-runs/<source>/<config>/<evidence> \
  --print-entry
```

For Mode F, pass the live evidence JSON:

```bash
node scripts/evidence-promote-observed.cjs \
  --experiment gate5-mode-f-c-e-f \
  --artifact reports/gate5/mode-f-live-evidence.json \
  --print-entry
```

The helper never edits `evidence/index.json`. Review the printed entry, replace the matching pending record manually, recompute the index hash with the existing evidence-index tooling, and run the canonical verifier.

## Fail-closed checks

The helper rejects promotion unless the artifact is structurally valid, its top-level evidence hash is valid, its source commit is bound, its taskset matches the pending registry identity, provider and model provenance are present, and all expected tasks are represented.

Controlled Pilot V2 additionally checks per-run provenance bindings, requires failure/cancelled runs to retain rejected candidate artifacts when such candidates exist, and delegates final bundle verification to the canonical observed-evidence verifier from the research tooling.

Mode F additionally verifies the immutable external repository identity, raw report hash/binding, C/E/F mode coverage, source-bound benchmark blob/file identity, and the explicit `observed_live_result` / `live_adaptive_compressed_boundary` markers.

The following are never promotable as observed evidence:

- fixture artifacts
- dry-run artifacts
- synthetic artifacts
- artifacts without a valid source commit
- artifacts without model/provider provenance
- artifacts whose taskset differs from the pending registry entry
- artifacts whose evidence hash does not verify

## Important boundary

This helper **does not make a Mode F research decision** and does not invoke the Mode F promotion gate. It only answers whether an already-produced live evidence artifact is safe to register as observed evidence. The separate Mode F promotion gate remains the authority for the F-versus-E research criteria.
