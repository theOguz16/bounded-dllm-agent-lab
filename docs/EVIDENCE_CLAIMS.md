# Evidence Claims

This document defines which claims each evidence class may support. `docs/CURRENT_STATE.md` remains the single current-state source.

## Evidence hierarchy

| Class | May support | Must not support by itself |
| --- | --- | --- |
| `deterministic_fixture` | Contract validity, routing, schema checks, integrity checks, fail-closed behavior | Live-model quality, token savings, real-world product quality |
| `guided_live_contract` | Provider connectivity, response conformance, adapter/runtime chain execution, observed token usage | Independent planner selection, patch quality, token savings, comparative advantage |
| `unguided_live_selection` | Independent selection quality against a hidden oracle, when leakage checks pass | Patch quality, token savings, external validity |
| `coder_patch_observation` | Patch parse/apply/build/test/acceptance results for observed tasks | General superiority, token savings without baseline, external product validity |
| `comparative_benchmark` | Relative token, scope, quality, latency, and cost findings under controlled comparable conditions | General real-world superiority outside the measured benchmark |
| `external_validation` | External repository/user/maintainer outcomes for the observed sample | Universal product guarantees |

## AG.3c classification

The committed AG.3c RunPod result is `guided_live_contract`.

Provider-visible context included expected:

- seed files;
- required symbols;
- required test files;
- planned files.

Therefore the run may support contract-conformance claims but must not be counted as independent planner-selection quality.

## Required fields for evidence-bearing reports

New evidence reports should state:

- `evidenceClass`;
- whether expected outcomes were visible to the provider;
- whether a hidden oracle was used;
- observed provider/model identity;
- observed versus inferred token/cost values;
- allowed claims;
- explicitly unobserved claims;
- a canonical integrity hash.

## Integrity and comparison rules

`evidence-index.cjs verify` recomputes the artifact's content hash. For JSON
reports, the self-referential `reportHash` field is removed first and the
remaining object is canonicalized recursively (object keys sorted, arrays kept
in order, JSON primitives encoded without whitespace). The index hash is
computed the same way after removing `indexHash`. Text artifacts use
`text_field:contentHash_placeholder_v1`: the exact UTF-8 bytes are hashed after
replacing the single 64-hex digest on the `contentHash:` line with 64 ASCII
zeroes. Line endings, whitespace, and all other bytes remain significant. The
older `text_field:evidenceHash` kind is also recomputed with that placeholder
rule and therefore fails closed for historical records whose field only named
an external evidence bundle; such records must be explicitly migrated rather
than silently accepted. A matching hash is an
integrity check only: it does not prove who authored the artifact or that the
recorded run actually occurred. Source commit, task-set identity, provider,
model, and artifact provenance must also agree with the index record.

Comparative claims require aligned task/repetition pairs. Missing or duplicate
pairs fail closed instead of being silently dropped. `compareGate6Strategies`
uses repository-clustered percentile bootstrap confidence intervals with a
recorded seed and method. Non-inferiority uses the pre-declared margin and the
lower confidence bound, not a point estimate alone. Reports expose accepted,
failed, and interrupted denominators. Token savings are reported together with
acceptance and uncertainty. At least three aligned repetitions per task and
three independent repositories are required in addition to the paired-task
minimum. Smaller or pseudo-replicated samples produce `insufficient_data` and
`costAdvantage: false`. Gate 6 promotion consumes this same clustered result;
insufficient data or a confidence bound outside the predeclared margin is a
`NO_GO`, even when point estimates look favorable.

The promotion evidence shape is versioned as `gate6-evidence/v4` with
`gate6-verifier/v4`. Older evidence remains historical input and is not
silently reinterpreted under the clustered decision rule; verification against
the current benchmark also requires the current frozen benchmark-semantics
hash.

## Claim wording

Preferred:

> The guided live run verified OpenAI-compatible provider conformance and the downstream bounded validation chain.

Prohibited:

> AG.3c proved the planner independently selected the best minimal implementation plan.

Preferred:

> Provider-reported token usage was observed.

Prohibited:

> AG.3c proved token savings.

Preferred:

> The deterministic verifier enforces configured contract and boundary rules.

Prohibited:

> The deterministic verifier proves code is secure and behaviorally correct.
