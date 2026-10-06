# Real transport milestone — 6 October 2026

## Delivery status

Phase 1 is frozen and pushed in commit `100f3e05df3bb76a6a5ea47dfbbe17a28dd47913`. The four offline harness files and the research-reset review were the only included files. The initial 14/14 tests passed, including correct-Candidate acceptance and deliberate wrong-Candidate oracle rejection. Local/remote HEADs matched and the worktree was clean before Phase 2 implementation.

Phase 2 supplies a direct OpenAI transport and a fixed one-session smoke entrypoint. **The live smoke has not run: no OpenAI API credential is configured in the process.** Codex's existing login is ChatGPT OAuth, not an API key. The implementation does not repurpose those OAuth tokens as API credentials. The live attempt remains unconsumed; real provider/model calls so far are **0**. No A/B/C/D live verdict is justified before a live attempt. In particular, absence of credentials is not evidence that the adapter is incompatible.

This document supplements the frozen offline README. It does not revise historical plans or the retained replay evidence.

## Small transport boundary

`transport.mjs` implements `complete(request)` using one non-streaming POST to `https://api.openai.com/v1/chat/completions`. It has no SDK agent loop, native shell/filesystem/network tool, MCP, conversation ID, provider-managed previous-response chain, retrieval, compression, routing, prompt optimization, or retry.

The prospective model is **`gpt-5.6-luna` at `medium`**, matching the native research model identifier/reasoning. Official documentation lists that model and supports Chat Completions, function calling, and medium reasoning. Account availability remains unverified until authenticated use. There is no silent model fallback. Even if the identifier matches, the native Codex endpoint, framing, tools and system instructions differ, so this would not establish complete model/backend parity. [Official model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

The wire encoder preserves host message order and contents. It maps the host assistant call/tool-result fields into API function-call messages and maps the exact two supplied tool schemas into function definitions. It disables parallel calls, streaming and storage, sets one choice and a 4,096 completion-token ceiling, and binds application-request/state hashes and sequence in metadata. It records a separate canonical wire-body hash/byte count. Those explicit transport options do not alter the host's retained-state policy. [Chat Completions API reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

Only one structured call is accepted per response; multiple calls, malformed arguments, unsupported tools, refusal, or incomplete output stops the session. The adapter never executes a tool. Accepted output is exactly `{assistant: {text, toolCall}, usage, status, finishReason}`. Credentials, raw responses/error bodies and HTTP headers are never put in receipts or journal diagnostics.

### Necessary admission/accounting seam

The frozen implementation admitted only factory-branded scripted providers and explicitly rejected non-null usage. `loop.mjs` now exposes two admission paths sharing the same execution algorithm:

- `runOfflineLoop` still admits only branded scripts, still rejects fabricated usage, and retains the original offline telemetry shape;
- `runTransportLoop` admits only the branded direct/mock HTTP transport and validates its numeric usage receipts.

Request construction, tool definitions, state updates, path/source authority, tool execution, mutation capture, verifier, and default ceilings are unchanged. The exact fake replay telemetry was compared with frozen `replay-evidence.json` after the seam change and matched in full. The old artifact was not rewritten. Only optional transport-response accounting is added to research telemetry; no production package or runtime was changed.

## Durable admission and failure behavior

The adapter imports the existing `createDurableInvocationJournal` and journal-location guard. It does not create another journal implementation. The live entrypoint uses the existing external journal at `~/.bounded-agent/bounded-dllm-agent-lab/provider-invocations.sqlite`.

Before HTTP execution, each request is reserved and marked started with a fixed session/response run ID, coder stage, model/reasoning, deadline and complete canonical application/wire request material. The journal persists that material's hash, not raw prompts/source/body text. After success it records completed. HTTP rejection is terminal failed; uncertain network, malformed or incomplete outcomes remain consumed as outcome_unknown. Same-session and new-session replay of the same request is rejected by existing journal semantics. No retry/recovery authorization is created or consumed.

The adapter enforces monotonic sequence 1–3, a 60-second per-request timeout, a 180-second session deadline and a 256-KiB response-body bound. Redirects are forbidden. These complement the existing host ceilings of 3 responses, 2 tools, 262,144 cumulative application request bytes and 65,536 retained-state bytes. Application byte ceilings are not provider token limits or exact wire-byte ceilings.

A fixed smoke output directory is created exclusively before execution and blocks reruns even if a prior session fails. Missing credentials are checked before directory creation, reservations or dispatch, so they do not consume a live session.

## Usage and bounded evidence

Each transport response retains these separate fields:

| Field | API source / interpretation |
|---|---|
| input | `usage.prompt_tokens` |
| cachedInput | `usage.prompt_tokens_details.cached_tokens` |
| uncachedInput | input minus cachedInput, only when both are available |
| output | `usage.completion_tokens`, including exposed reasoning output |
| reasoningOutput | `usage.completion_tokens_details.reasoning_tokens`, if present |
| cacheWriteInput | `usage.prompt_tokens_details.cache_write_tokens`, if present |

Unavailable fields stay null. Zero stays zero. Request/state bytes are never converted into usage. Reasoning output is a subset of output and is not added a second time. Totals remain null for a field if any response lacks it. Exact available usage is retained even if assistant/status parsing later rejects the response.

Bounded transport receipts contain sequence, application/wire/state identities and byte counts, requested/observed bounded model IDs, response hash, HTTP status, finish/status enums, usage, journal key/state and classification. `fixture` usage from mocked HTTP is explicitly distinguished from `provider_observed` usage from actual network execution. Persistence recursively validates receipts and rejects extra raw fields. No unrestricted task/source/prompt/tool-result/assistant/error/validation output is persisted.

## Single live smoke, prepared but not executed

The fixed task is a synthetic existing-file TypeScript change: change `answer(value)` from `value + 1` to `value + 2`, preserving its signature. The trusted task requests a read, source-hash-bound update, then finish. This is an integration smoke, not a repository-quality benchmark or Task B repetition.

The source is created in a temporary independent fixture. The host creates the usual isolated Candidate, captures its ordinary source-bound mutation, and uses existing policy/verifier gates. Existing network-disabled container validation compiles it, performs strict typechecking, and executes trusted behavior assertions for `answer(3) === 5` and `answer(-2) === 0`. The model cannot edit or execute those checker commands. Source application is always zero.

After the adapter is committed, pushed and clean, the entrypoint requires local/remote HEAD equality and the already installed validation image/daemon. It performs exactly one session, no retries/repairs/apply and no prompt patch/rerun. External files are `session-start.json`, `loop-evidence.json` and `report.json` under the fixed smoke directory. Returned report fields include request/result/state binding checks, Candidate/verifier/acceptance outcomes, per-check results, counts, available usage totals, ceiling status and source currentness. Failure is retained and stops execution.

The report emits A (`HOST_OWNED_LOOP_PROVEN_LIVE`) only for actual live transport with observed input/output usage, preserved control, correct two-tool sequence, verified Candidate and independent acceptance. B indicates completed transport responses without the required task proof. C indicates transport compatibility was not demonstrated by the attempted session. D indicates a measured identity/source/ceiling control breach. Mock execution reports `OFFLINE_FIXTURE_ONLY`, never A.

### Credentials and invocation

The entrypoint reads `OPENAI_API_KEY` from its process environment, or an explicitly supplied absolute `HOST_LOOP_API_KEY_FILE` containing only the key. A key file must be regular, non-symlink, at most 8 KiB and owner-only readable. The key is never logged or committed. Do not paste it into chat.

Once credentials are configured for this execution process and the clean/pushed gate is met:

```sh
node research/host-owned-loop/smoke.mjs --live
```

This task already authorizes that one smoke; it does not authorize a second attempt or heterogeneous comparison. Until the credential is available, do not run the entrypoint or substitute another provider/native agent loop.

## Offline validation results

```sh
HOST_LOOP_CONTAINER_TEST=1 node --test research/host-owned-loop/loop.test.mjs research/host-owned-loop/transport.test.mjs
```

Observed **22/22 tests passed, zero skipped**: all 14 original harness checks plus 8 adapter tests. Tests cover deterministic ordered wire encoding; exact tool definitions and no hidden conversation; usage/null semantics; existing journal reservation and cross-session replay refusal; rejection of truncation, malformed/multiple/unauthorized calls and refusal; HTTP terminal failure without raw persistence; credential/config/sequence/journal-location admission; full mock-HTTP Candidate production; and the fixed smoke's real container/oracle handoff with zero model calls.

The fixed smoke via mocked HTTP passed build/typecheck/independent acceptance, all request/state/exact-read-result binding checks, and ceilings. It deliberately reported `OFFLINE_FIXTURE_ONLY`. This is not live evidence.

Additional existing checks passed: repository typecheck, deterministic verifier v2 (20 checks), and temporary-workspace execution verifier (32 checks). Frozen Phase 1 fake replay matched the original evidence exactly. Production source and historical review/plan/result artifacts are unchanged.

## Files and decision

Phase 2 changes are confined to `research/host-owned-loop/`:

- `loop.mjs`: provider admission and response-accounting seam only;
- `transport.mjs`: one API transport with existing durable admission;
- `transport.test.mjs`: scripted HTTP and existing validation tests;
- `smoke.mjs`: one fixed clean/pushed live smoke entrypoint;
- `TRANSPORT.md`: this report.

No benchmark was run or executable heterogeneous plan created. No production integration or journal framework was added. Historical artifacts modified: **0**. Source apply: **0**. Real provider/model calls: **0** as of this report.

**Recommendation:** keep the tested adapter frozen and run the already-authorized single smoke when its API credential is available. Preparing the heterogeneous comparison remains unjustified until the live smoke returns A. The requested live A/B/C/D verdict is pending credential access, rather than inferred from offline success.
