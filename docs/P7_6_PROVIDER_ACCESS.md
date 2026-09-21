# P7.6 — Codex provider access and comparison identity

This describes **offline-verified safeguards** for the development dogfood runners and standalone `bounded compare codex`, not a successful live-provider benchmark. R06 and its evidence remain frozen.

## Local configuration for a real Codex invocation

Set `BOUNDED_CODEX_ACCOUNT_ALIAS` to an operator-chosen, **non-secret**, stable local label such as `personal-a` or `personal-b`. It must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Do **not** use an email, user ID, token, session value, credential hash or credential-derived identifier as an alias. Set `BOUNDED_CODEX_AUTH_MODE` explicitly to `codex_home` (nonempty `auth.json` in `CODEX_HOME` or `~/.codex`) or `api_key` (nonblank `CODEX_API_KEY` or `OPENAI_API_KEY`); do not mix authentication modes or ambiguous keys. Set the intended model using `--model` or `BOUNDED_CODEX_MODEL`. Compare and dogfood use fixed `medium` reasoning. An alias is an operator assertion and **does not cryptographically prove** the account the provider used; keep accounts in separate `CODEX_HOME` directories and switch only between complete pairs.

The adapter performs a free local auth-presence check before the SDK; the dogfood and standalone compare gates additionally check identity and local authentication state before invocation. The standalone compare uses **one shared gate** for scope discovery, Normal and Bounded and checks changes before and after an arm. Auth-file metadata or API-key equality is compared only *in process memory*, never persisted or hashed. A nonempty credential/auth file does not prove validity, remote identity or remaining quota. There is no trusted quota endpoint: `quotaStatus: "unknown"` must remain unknown, never `available`.

`usage_limit_exceeded`, `authentication_failed`, `provider_overloaded` and `provider_stream_error_unknown` are distinct terminal error codes. If an arm hits any of them, standalone compare does **not** start the opposite arm; its output records `providerFailureCode` and `comparable: false`. In particular, no second paid invocation follows an auth or usage-limit error within the pair. Ambiguous streams are not retried automatically. If local alias/auth mode/auth state changes, compare rejects continuation as `provider_identity_changed` and reports the pair as non-comparable.

## Versioned comparison contract

Legacy `agent-comparison/v1` identities and callers remain supported for offline or explicitly injected adapters. The real standalone CLI uses the provider-pinned `agent-comparison/v2` contract with `providerId`, `accountAlias` and `authMode` on **both** arms, alongside task, snapshot, commit, agent, model, reasoning, validation, network and timeout identity. A partial/mixed v1–v2 identity is invalid; a provider identity mismatch is non-comparable. In-process tests that inject a fake `adapter` but no `providerGate` intentionally exercise v1; live CLI constructs its own gate. An account alias is not an authenticated proof of the provider's actual account.

Dogfood runners also persist the nonsecret alias and auth mode in results/checkpoints; they stop subsequent tasks on auth/limit errors and refuse failed or in-flight resume. P7.7 worker cleanup, deadline behavior and P7.12 full offline end-to-end recovery are separate work and are **not** claimed here.

## Offline verification (no real Codex requests)

```sh
npm run typecheck
npm run build
node benchmarks/product-v1/provider-access-smoke.cjs
node benchmarks/product-v1/p7-6-codex-provider-smoke.cjs
node benchmarks/product-v1/p7-6-compare-provider-smoke.cjs
node benchmarks/product-v1/p7-6-compare-command-smoke.cjs
node scripts/smoke/agent-comparison-contract-smoke.cjs
node benchmarks/product-v1/dogfood-smoke.cjs
node scripts/smoke/agent-output-redaction-smoke.cjs
```

The command-level smoke executes **the actual `compareCodexCommand`** with an injected fake provider, a local Git fixture and a fake Docker executable that only simulates availability and refuses any other Docker operation. It verifies all four provider failure codes, an unstarted second arm, v2 identity, unknown quota and absence of credential values in the output. The actual command smoke covers **Normal-first** terminal failures; other fake-gate tests check both first-arm orders, local account-alias and key switches and mixed-version identity rejection. The P7.6 pull-request workflow uses fake SDKs with provider credentials unset. Offline success is not evidence of live-provider quota, account ownership, or successful real Codex execution.
