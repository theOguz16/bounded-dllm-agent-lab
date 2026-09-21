# P7.6 — Codex provider access and comparison identity

This describes the **development dogfood runners**, not an observed live-provider benchmark. R06 and its evidence remain frozen. Do not use this document to assert that a live invocation succeeded.

## Local configuration before a live dogfood run

Set `BOUNDED_CODEX_ACCOUNT_ALIAS` to an operator-chosen, **non-secret**, stable local label such as `personal-a` or `personal-b`. It must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Do **not** use an email address, user ID, token, session value, credential hash or any credential-derived identifier as an alias.

Set `BOUNDED_CODEX_AUTH_MODE` explicitly to `codex_home` (nonempty `auth.json` in `CODEX_HOME` or `~/.codex`) or `api_key` (nonblank `CODEX_API_KEY` or `OPENAI_API_KEY`). Set the intended model using `--model` or `BOUNDED_CODEX_MODEL`. The fixed dogfood suite uses `medium` reasoning. An alias is a human assertion; it **does not cryptographically prove** the account that the provider actually used. Keep accounts in separate `CODEX_HOME` locations and switch only *between* complete pairs, never between Normal and Bounded.

Before launching the real SDK the adapter performs a free local auth-presence check. The dogfood gate also snapshots the active local authentication state *in process memory* and checks it before and after the comparison. Neither a nonempty credential nor a readable auth file verifies validity, remaining quota, or remote account identity. There is no trusted quota endpoint in this workflow: all reports retain `quotaStatus: "unknown"`, **not** `available`.

A usage-limit or 401/auth failure blocks further paid SDK invocations in that adapter and stops subsequent tasks in dogfood runners. Overload has its own terminal code; an ambiguous stream error does **not** schedule a retry. An interrupted, failed, or in-flight checkpoint cannot be resumed as though nothing happened. A changed alias/auth mode/local auth state makes the pair unaccepted and aborts continuation.

## Offline verification (no live Codex SDK requests)

```sh
npm run typecheck
npm run build
node benchmarks/product-v1/provider-access-smoke.cjs
node benchmarks/product-v1/p7-6-codex-provider-smoke.cjs
node benchmarks/product-v1/dogfood-smoke.cjs
node scripts/smoke/agent-output-redaction-smoke.cjs
```

The dedicated P7.6 pull-request workflow uses fake SDKs and does not pass provider credentials. Do not start a live dogfood run or the P7.13 pilot solely because these offline tests pass. Worker cleanup, deadlines, direct-CLI identity binding, and full end-to-end recovery are separately addressed by subsequent roadmap tasks and must not be inferred from this limited gate.
