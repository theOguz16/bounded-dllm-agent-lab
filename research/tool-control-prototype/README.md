# Repository-owned read_file control-surface prototype

Status: isolated offline research. No production provider, planner, coder, matrix, or validation routing is changed. No provider/model call was made.

## Local capability audit

Installed `@openai/codex-sdk@0.153.4` wraps `codex exec --experimental-json`. `CodexOptions.config` and `configOverrides` become CLI `--config` arguments. The local CLI accepts `mcp_servers.<name>.command/args` overrides and reports a stdio server with `codex mcp list --json`. The SDK's `McpToolCallItem` type contains `server`, `tool`, structured `arguments`, and the returned `result.content`. Codex can therefore present a repository-owned MCP tool to its coder. A server constructs the result before the CLI feeds it into the next model step. The SDK thread API has no custom execution callback, explicit tool-result submission API, or shell-result replacement hook. `runStreamed` yields observations only. Native shell remains available unless a separate policy constrains it.

The current `CodexAgentAdapter` delegates to an isolated worker. That worker creates `new Codex({ config: { model_reasoning_effort: 'none' } })` and starts one CLI thread. It does not receive per-run MCP configuration. A small research-only worker configuration path is still needed before a real Codex coder could use this server. The current event parser also does not retain MCP tool telemetry. Neither change is implemented here.

## Proof surface

`read-file.mjs` exposes exactly one tool, `read_file`, over a narrow stdio MCP interface. Startup fixes a checkout root, one allowed relative path, and representation mode. It reuses `canonicalizeRepositoryRelativePath`; rejects path escape, unauthorized paths, symlink components, missing or nonregular files, unsupported binary content, large files, and oversized or noncanonical requests. It reads the original text once. The in-memory trusted view holds original text, byte count, and SHA-256. Identity mode sends it unchanged to the coder. Bounded mode sends the first two and last two lines with a deterministic omission marker. The server sends only coder-facing text plus bounded metadata, never the trusted original in `_meta` or a durable file. The prototype does not run shell commands.

Offline tests drive the actual stdio MCP initialize/list/call protocol from a fake coder. They show that the fake coder's next tool message contains the repository-constructed identity or bounded result, while direct trusted execution retains the original. This proves local result construction and protocol wiring. It does **not** prove that an actual model will select the MCP tool or consume its result; that requires a provider call in a later, separately authorized experiment.

Telemetry is prospective and bounded: tool name, sequence, mode, path request metadata, original/coder byte counts, absolute and percentage reduction, source/result hashes, and execution duration. No unrestricted raw content is persisted. Trusted validation remains a separate path; a future research integration would carry original evidence only to trusted runtime when needed.

## Feasibility and experimental design

Verdict **B — supported, but proof requires one small additional integration layer**. Pass the exact stdio MCP server configuration through the isolated research worker for both conditions, bind the approved checkout and path, and collect bounded MCP telemetry and trusted original evidence without changing validation. This is research plumbing, not a production tool framework. No extra model summarization call is needed; MCP results return within the normal coder turn. Local stdio needs no network service, but the final sandbox behavior must be checked in a future controlled run.

Moving a read from native shell to MCP changes the coder's tool choice and result envelope, so a native-shell baseline would confound result representation with tool ownership. The first future A/B should compare **repository-owned identity mode** with **repository-owned bounded mode**, using the same task, model, planner, initial context, MCP tool, native-tool availability, validation, and zero retry/repair/apply policy. Vary only the `read_file` representation. Track Candidate correctness, coder/cached/uncached input, amplification, tool count, elapsed time, original bytes, and coder-visible bytes. Verify actual MCP usage and record any shell bypass; do not treat a bypassed call as evidence of result compaction. No such A/B is run here.

## Prospective response telemetry

The research executor now derives research-mcp-response-trajectory/v1 from its
local Codex session rollout after a completed MCP observation. This is additive
to the existing bounded SDK observation and trajectory v2 model. The collector
keeps only ordered response usage, phase enums, ambient/system/developer block
hashes and byte counts, separate runtime-context hashes, the supplied prompt
hash and byte count, MCP result hashes and byte counts, and a canonical SHA-256
of those metadata fields. An allowlist validator runs before persistence.
Raw prompts, source, MCP result text, provider request bodies, stdout, and
stderr are never copied into the telemetry object.

A response's usage record belongs to the model response that generated its
preceding assistant items. The MCP result may appear in the rollout before the
usage record for the response that requested it. The collector therefore
samples result delivery at the first assistant item of each response. It uses
pre_tool_discovery, tool_call_generation, post_tool_result, and
additional_post_tool_result only when the local record supports the label;
otherwise it uses unknown_pre_tool or unknown_post_tool. Missing usage stays
null. The first post-result response in the completed ABBA runs is response 3.

The ambient identity is SHA-256 of the ordered JSON array of block sequence,
role, type, UTF-8 byte count, and individual SHA-256 hashes. The canonical
trajectory fingerprint hashes an ordered JSON metadata object containing the
ambient identity, runtime-context identity, supplied-prompt identity, normalized
tool configuration identity, MCP-use instruction hash, ordered result metadata,
response-phase usage records, and pre-MCP assistant-activity flag. Checkout
paths are excluded from the normalized tool configuration identity and captured
as hashed runtime context instead. Different runtime paths are flagged as benign;
an ambient identity mismatch in a nominal pair is
AMBIENT_INSTRUCTION_DRIFT, an experiment-confounding flag.

The SDK turn.completed stream itself exposes only final turn usage. Local
rollout token_usage_record entries expose per-model-response usage, but
provider HTTP request bodies, cache keys, segmentation, cached-prefix
boundaries, and token attribution by content component remain unavailable.
This telemetry is observational and does not change MCP result behavior or
authorize another live run. Run the focused test with
node research/tool-control-prototype/rollout-telemetry.test.mjs and the
historical, read-only replay with
node research/tool-control-prototype/rollout-telemetry-preflight.mjs.
