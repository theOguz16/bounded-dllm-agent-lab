# AG.2b — OpenAI-Compatible Planner Provider Adapter

## Current status

The provider adapter and deterministic contract suite are ready.

```text
adapter implementation                 complete
deterministic contract tests           complete — 16 checks
canonical runtime export               complete
RunPod / Qwen live proposal validation pending
```

AG.2b is not complete until the live validation report passes.

## Provider boundary

The adapter connects the AG.2a planner-provider function to an
OpenAI-compatible `/v1/chat/completions` endpoint.

It provides:

- bounded endpoint, timeout, response-size and task-context limits;
- one or two provider attempts;
- retry handling for timeout, network, HTTP 429 and HTTP 5xx failures;
- immediate stop for non-retryable HTTP failures;
- one corrective retry for malformed JSON or invalid draft schema;
- strict JSON-object and exact-field validation;
- provider-reported input/output/total token capture;
- optional operator-configured token-rate comparison;
- hash-linked attempt and run evidence.

## Trusted hashing boundary

The model does not generate trusted hashes.

The model returns:

```text
seed files
seed rationale text
required symbols
required tests
max expansion attempts
```

The adapter computes:

```text
reason hashes
proposal hash
attempt hashes
run hash
```

The finalized proposal is then revalidated by the existing AG.2a contract.

## Cost claim boundary

When token rates are configured, the adapter reports
`operator_configured_rates`.

This is a comparison-cost snapshot. It is not observed RunPod infrastructure
cost or total cost of ownership.

Missing provider usage remains explicit. The adapter does not fabricate token
or cost values.

## Deterministic evidence

Commands:

```bash
npm run test:openai-compatible-planner-provider
npm run generate:ag2b-evidence
npm run verify:ag2b
```

Artifact:

```text
reports/ag/AG2B_OPENAI_COMPATIBLE_PLANNER_PROVIDER.json
```

Expected result:

```text
decision=ag2b_adapter_evidence_ready
checkCount=16
reportHash=sha256:e73ca39af33209c4639f2f5985c37d50f987d357813048838316be4e97003968
readyForRunPodLiveValidation=true
```

This artifact is `deterministic_fixture` evidence. It does not claim live-model
quality, live token usage or infrastructure cost.

## Live validation

Command:

```bash
npm run validate:ag2b-live
```

Required or commonly used environment variables:

```text
AG2B_PLANNER_ENDPOINT
AG2B_PLANNER_MODEL
AG2B_PLANNER_API_KEY
AG2B_RESPONSE_FORMAT
AG2B_TIMEOUT_MS
AG2B_MAX_ATTEMPTS
AG2B_INPUT_USD_PER_MILLION
AG2B_OUTPUT_USD_PER_MILLION
AG2B_LIVE_REPORT_PATH
```

Default endpoint and model:

```text
http://127.0.0.1:8000/v1/chat/completions
qwen2.5-coder-7b
```

Live artifact:

```text
reports/ag/AG2B_OPENAI_COMPATIBLE_PLANNER_PROVIDER_LIVE.json
```

A passing live run must contain two accepted cases and
`decision=ag2b_live_planner_validation_passed`.
