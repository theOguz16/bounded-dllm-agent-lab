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
