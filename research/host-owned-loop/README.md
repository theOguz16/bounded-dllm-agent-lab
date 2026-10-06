# Host-owned application loop: offline feasibility

Verdict: **A — `HOST_OWNED_LOOP_PROVEN_OFFLINE`**.

This implements research-reset recommendation C. It proves explicit application-level request and retained-state ownership using a fake provider. It does not measure efficiency or claim complete provider request ownership. Real provider/model calls: **0**. Historical experiment artifacts modified: **0**.

## Architecture and scope

```text
trusted task/acceptance/implementation contract + compiled policy + source snapshot
  -> canonical explicit request (ordered messages, tools, model, reasoning, sequence)
  -> scripted fake response
  -> host validates structured tool arguments and authority
  -> existing bounded source reader / validated private existing-file update
  -> host admits exact result + assistant/call/edit history into immutable state
  -> next canonical explicit request
  -> existing isolated workspace mutation capture
  -> existing canonical mutation-policy evaluation + deterministic verifier v2
  -> optional trusted checker seam into existing container/acceptance boundary
  -> memory-only Candidate; source apply is NOT_RUN
```

Only `research/host-owned-loop/` is new. No production module, package export, package script, historical plan, authority framework, native worker, or telemetry version was changed. The earlier `reviews/RESEARCH_RESET_2026-10-06.md` remains unchanged.

The research path imports the compiled existing modules under `dist/`; build once with `npm run build`. The implementation is one 310-line module and one focused test file, plus this document and bounded replay evidence. It contains no real provider implementation, SDK import, generic provider router, arbitrary shell tool, search tool, network tool, compaction, semantic summarization, adaptive retrieval, duplicate-read suppression, or production integration.

### Trusted authority reuse

The caller supplies existing acceptance and task-to-seed implementation contracts, a compiled canonical policy, and a canonical repository content snapshot. The harness verifies their existing identities before creating an isolated workspace. It uses canonical policy preflight, the existing path canonicalizer and bounded UTF-8 source reader, disposable-workspace materialization, versioned text-update parsing/source validation, host mutation capture, canonical mutation-policy evaluation, and verifier v2. Source currentness is checked before each request/tool and after verification/checker execution.

Read authority is the host's explicit readable-file set; write authority is its change-file subset, intersected with the existing policy gates. Provider output cannot alter those sets or grant authority. Symlink/unsupported-file rules come from existing readers/workspace machinery. The provider never receives a filesystem handle or the trusted checker callback.

No new verification system is introduced. The legacy dry-run/temp-apply helpers accept repair drafts, whereas this Candidate is a coder patch draft. The proof therefore hands the already source-bound isolated coder workspace to the existing container validator; it does not forge a repair finding or duplicate those gates. `checkCandidate` is a trusted caller callback, inaccessible to the fake provider, and runs before the host cleans its workspace. In the test it delegates directly to `runContainerizedWorkspaceExecution`; existing execution-evidence, validation-profile, and acceptance-contract functions assess the result after cleanup.

The returned classification `CANDIDATE_VERIFIED_STRUCTURALLY` means precisely that. `validation` is separate memory-only checker output; a structural approval does not assert behavioral success. A deliberately wrong Candidate remains structurally valid and fails its independent oracle. No CLI persisted handoff or approval/apply integration is implemented.

## Explicit provider boundary

`complete(request)` receives a frozen canonical request:

- version and sequence;
- explicit model ID and reasoning setting;
- ordered system/user/assistant/tool messages;
- exact two tool definitions;
- retained-state hash.

It returns `{ assistant: { text, toolCall }, usage, status, finishReason }`. This milestone admits only providers created by `createScriptedProvider`. The factory privately copies/freezes its script and is branded through a module-private WeakSet; arbitrary callbacks are rejected before invocation. Scripted usage must be `null`; it is never promoted to observed provider tokens. Fake response steps and real model/provider calls are different counters. A future real transport requires a separately authorized change, including real usage/status semantics and durable invocation accounting.

The retained state explicitly separates trusted constraints, supplied evidence, ordered assistant responses/tool calls/tool results, and candidate edits. The host copies and freezes state at each admitted transition. Its request builder chooses exactly which fields become messages; providers cannot rewrite retained state. Raw read results and edit content are intentionally retained without compression. Evidence plus history can duplicate content; this milestone proves ownership, not optimization.

The tools are:

1. `read_file({path})`: exact authorized UTF-8 text, source/content hash, and byte count;
2. `update_file({path, expectedContentHash, newContent})`: existing-file update under canonical mutation rules, in the disposable Candidate only. Its result contains status/content hash/byte count. The actual source repository is unchanged.

Argument schemas reject extra fields. Path validation rejects traversal and aliases; readable/change authority rejects unauthorized files. Source hash mismatch, no-op, unsupported operations, unsafe final content, duplicate call IDs, malformed responses, and fabricated usage fail closed.

## Request identity and bounded evidence

`canonicalizeJson` and `hashCanonicalJson` are reused from the runtime. Every admitted fake request records sequence, model, reasoning, whole-request canonical hash/UTF-8 byte count, ordered message hash/bytes, tool-schema hash/bytes, and retained-state hash/bytes. The request hash binds configuration, order, tools, state identity, and actual messages. Reordering object keys preserves identity; changing sequence/model/reasoning/messages/tools changes it.

`replay-evidence.json` stores only allowlisted numeric metadata, hashes, bounded model/reasoning identifiers, tool enums, bounded classifications, and structural/policy decisions. Call IDs, arguments, and tool results are hashed. It does not store raw task/source/prompts/assistant output/tool arguments/tool result text/Candidate contents/validation stdout or stderr. `persistTelemetry` recursively rejects extra fields, validates enums/hash shapes and bounded records, and writes exclusively with mode `0600`. An existing evidence file is never overwritten.

Raw requests, state, Candidate and checker output are returned only to the trusted caller in memory. Temporary source/Candidate fixtures necessarily exist on disk during execution and are cleaned. This is not a policy about future provider-side logging.

## Scripted trajectory and replay proof

The synthetic task changes an existing typed `answer` function from `value + 1` to `value + 2` so that `answer(3) === 5`, with an additional negative-input assertion. It is not Task B.

| Step | Host-visible action | Result |
|---|---|---|
| Fake response 1 | Request approved `src/answer.ts` read | Host creates exact text/hash/bytes tool result |
| Tool 1 | `read_file` | Result and call enter host state and request 2 |
| Fake response 2 | Request source-hash-bound existing-file update | Host checks schema, hash and authority |
| Tool 2 | `update_file` | Private Candidate update; admitted edit/result state enters request 3 |
| Fake response 3 | Finish | Host captures ordinary source-bound `WorkspaceMutation` |
| Existing gates | Policy + deterministic verifier | allow / approve |
| Existing validation | Build, strict typecheck, independent behavior | all pass for correct Candidate; behavior fails for wrong Candidate |

**Three fake response steps; two tool steps; zero real model/provider calls.** Replaying the same scripted responses against the same trusted fixture yields identical entire bounded telemetry objects, covering request sequences/hashes, tool-call sequences/argument-result hashes, retained-state hashes, and Candidate identity. The test reconstructs request 2 from the admitted state and checks that its tool message contains the exact repository-produced result. Provider requests and state are frozen, and mutating the original script after factory creation has no effect.

Saved proof:

| Request | Application request bytes | State bytes before request | Request hash |
|---|---:|---:|---|
| 1 | 2,603 | 1,482 | `538f0f252bd95dfe67f493e02878e5cd07e180aac49a8502d43d92e25dd1e4f1` |
| 2 | 3,240 | 2,216 | `9460fe527590a7432958967581d8eb658d18b84e6d8533a57b750ee3c832cc32` |
| 3 | 4,099 | 3,355 | `39e2c320ad199b696164205f1945e2df7a5b84f11ea8bf8a481306b187ff1281` |

Total serialized application request bytes: **9,942**. Final Candidate hash: `sha256:a3448f87c1f062d617aefdd120b6d01bcaf0bbd3d3231434e00c9802781237ca`. This is a deterministic fake-fixture receipt, not token usage, cost, or a success rate.

## Resource ceilings

| Ceiling | Default | Enforcement |
|---|---:|---|
| Model-response steps | 3 | Before dispatch; `MODEL_RESPONSE_CEILING` |
| Tool calls | 2 | Before execution; `TOOL_CALL_CEILING` |
| Cumulative canonical application request bytes | 262,144 | Before dispatch of a request exceeding the sum; `REQUEST_BYTES_CEILING` |
| Canonical retained-state bytes | 65,536 | Initial and every transition, before admitting tool results or writing an update; `STATE_BYTES_CEILING` |

Overrides must be positive safe integers within absolute research caps: 100 responses, 100 tools, 4 MiB cumulative requests, 1 MiB retained state. Ceilings are included in trusted state/request identity. A failure produces a bounded classification and no downstream valid Candidate. Tests cover first-request blocking and later cumulative blocking, initial-state blocking and oversized-update blocking, and stopping before the next response/tool mutation. These are logical application limits, not a heap-allocation guarantee or provider token ceilings. No offline estimate is reported as observed usage.

## What is controlled

| Surface | Native Codex path at reviewed HEAD | Host-owned research harness |
|---|---|---|
| Application request construction | Supplied prompt known; effective native assembly partly opaque | Exact canonical application envelope and ordered messages |
| Retained state | Native conversation management inside SDK turn | Repository-owned immutable state and history |
| Tool schemas | Native/CLI runtime configuration; limited MCP configuration | Exact two repository-owned schemas |
| Tool execution/result | Native shell loop; owned MCP only on configured reads | Host executes approved operations and constructs exact result |
| Next-request composition | Native loop; observed afterward | Host request builder consumes admitted state |
| Request sequence | SDK turns; internal responses inferred from local rollout | Direct pre-dispatch application sequence |
| Application resource ceiling | Composition/event/command/deadline bounds; no exact native cumulative request-byte bound | Deterministic response/tool/request-byte/state-byte bounds |
| Candidate verification | Existing host scope/source/mutation gates | Same imported gates, not a replacement |
| Independent execution | Existing validation/oracle boundary | Same runner/contract functions through a trusted checker seam |
| Approval/apply | Explicit trusted host flow | Not entered; no source application capability |

The repository still does **not** control provider-hidden/system framing, tokenization, server transformations, cache keys/segments, server logging, actual transport serialization, or native runtime overhead in the baseline. There is no real provider in this task, so those behaviors were neither observed nor eliminated. Explicit application identity must not be called full provider request identity.

## Tests and observed results

Commands:

```sh
npm run build
npm run typecheck
node --test research/host-owned-loop/loop.test.mjs
HOST_LOOP_CONTAINER_TEST=1 node --test research/host-owned-loop/loop.test.mjs
```

The ordinary run deliberately skips the Docker handoff test. The full acceptance command requires access to the already installed Docker daemon and the existing pinned validation image; it never pulls an image. It uses the existing network-disabled, resource-limited container runner, a read-only authoritative Candidate mount, and explicitly declared generated build outputs. The TypeScript compiler is copied from local dependencies, with no registry access. Trusted command arguments contain the independent oracle; the Candidate cannot edit it. The host prepares the runtime's reserved empty `.validation-output` directory before validation.

Observed:

- **14/14 harness tests passed, zero skipped**, including actual container build/typecheck/oracle execution and wrong-Candidate rejection.
- Replay and request-2 exact-result assertions passed; source remained unchanged.
- Build and repository TypeScript typecheck passed.
- Existing deterministic verifier v2 smoke: **20/20 checks passed**.
- Existing model mutation validator smoke: **15 checks passed**.
- Existing temporary-workspace execution verifier smoke: **32 checks passed**.
- Existing fake-provider core safety E2E: passed, `liveProviderCalls: 0`, including required approval, blocked unauthorized apply, blocked stale approval, and synthetic controlled apply/post-apply validation. This regression test's ephemeral fixture apply is separate from the research harness, which never applies to source.
- The initial sandboxed core E2E lacked Docker socket access and stopped at Phase V infrastructure. It passed when rerun with Docker access. No safety source was changed to make it pass.

The 14 test cases collectively cover all requested focused checks: deterministic request/hash/state construction; exact next-request tool result; owned tools; traversal and unauthorized reads; response/request/tool/state ceilings; scripted replay; existing Candidate verifier/independent oracle handoff; raw-free persistence; zero real providers; and unchanged safety/validation regressions. Additional cases cover symlinks, source/acceptance drift, wrong hashes, no-op/create, unsafe Candidate content, invalid response status, fabricated usage, and non-scripted provider rejection.

To save a new bounded proof without modifying the retained artifact, set `HOST_LOOP_EVIDENCE_PATH` to a new absolute path when running tests. The replay test writes only validated telemetry with exclusive creation. No runtime package script or production command was added.

## Future heterogeneous comparison — design only

A small comparison is justified **after** a separately authorized real transport/usage/status adapter and an audit of model availability and arm parity. Offline control does not justify a claim of efficiency, and this task authorizes no live calls. Do not resume Task B repetitions.

Four candidate task families, based on existing frozen source `ea6bc88e947e78b7539b9614b4c637dd9b2805a9` and the separate robustness evidence:

| Candidate | Purpose | Shared independent acceptance |
|---|---|---|
| R1 early CLI `--help`/`-h` | Simple explicit-scope, one-file change | Help output/exits, early ordering, absence of upstream/proxy side effects |
| R2 worker request-ID correlation plus existing regression | Multi-file implementation/test obligation | Matching IDs accepted; mismatch rejected for correlation across methods |
| R3 local JSON-schema error classification | Dependency/interface reasoning with positive and negative controls | Unsupported classification only for specific upstream semantics; generic 400 stays rejected |
| R5 PR/diff path-boundary hardening | Cross-adapter dependency following and prior bounded difficulty/failure case | Absolute/traversal/NUL/escaping symlink rejected; safe paths, spaces and rename behavior preserved |

Use the existing source/tasks/oracles as candidates for an eligibility review, not automatically eligible live slots. Explicitly confirm that R3/R5 readable dependency sets exercise dependency following; if not, substitute one independently validated dependency-chain task before freezing a comparison. Do not modify historical benchmark manifests.

Within each pair share source commit, task text, explicit readable/change scope, initial source facts, model identity/reasoning where available, independent checker, build/typecheck/test commands and environment, zero retry/repair/apply policy, and the same decision rules. Keep planning fixed outside the coder comparison; this task does not introduce planner optimization. Match tool capabilities where possible. If native shell or system framing cannot be matched, label it an architecture-stack comparison, not a pure retention intervention. Different endpoints/models cannot establish a loop-only causal effect.

Use balanced order with independently documented ambient/config identity and retain all failure/no-Candidate outcomes. The primary outcome is **independently correct and authorized completion**. Report success/failure/no-Candidate, policy/scope violations, uncached/cached/output/cumulative input separately, actual internal response and tool counts, generation latency and validation latency. Freeze an applicable rate snapshot before any price-weighted cost analysis. Include failed attempts; never score a cheap no-Candidate as an efficiency win. Amplification is optional descriptive metadata, not the primary endpoint.

No executable benchmark plan, live provider adapter, new task-specific authority, or live comparison was created here.

## Repository delivery state

Implementation branch: `codex/host-owned-loop-offline`, created from the audited research HEAD. Prior workspace branch was `glm/discovery-neighborhood-bounding`; its committed contents were not modified. New files remain uncommitted for review.

- Local HEAD: `2925d9dbef768e33754f484efa5c3c9df134f5a3`.
- Remote research HEAD, queried via `git ls-remote`: `2925d9dbef768e33754f484efa5c3c9df134f5a3`.
- Remote implementation branch: absent; nothing pushed.
- Implementation commit SHA: **not committed**.
- Changed/new implementation files: `loop.mjs`, `loop.test.mjs`, `replay-evidence.json`, `README.md`, all under `research/host-owned-loop/`.
- Existing tracked safety/validation files changed: **0**.
- Historical artifacts modified: **0**.
- Real provider/model calls: **0**.

Final `git status --short`:

```text
?? research/host-owned-loop/
?? reviews/
```

The `reviews/` entry was already present before this implementation task.
