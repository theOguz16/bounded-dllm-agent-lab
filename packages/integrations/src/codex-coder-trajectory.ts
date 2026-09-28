import { Buffer } from "node:buffer";
import path from "node:path";

/** Bounded observations from Codex JSONL. No prompt, command, or output text is retained. */
export const CODEX_CODER_TRAJECTORY_VERSION = "codex-coder-trajectory/v1" as const;
const MAX_TURNS = 64;
const MAX_TOOLS = 128;
const MAX_PATHS = 8;
const MAX_PATH_LENGTH = 160;
type Nullable = number | null;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): Nullable =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const bytes = (value: unknown): Nullable => typeof value === "string" ? Buffer.byteLength(value, "utf8") : null;
function normalizedPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH ||
      /[\x00-\x1f\x7f\\]/.test(value) || path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  return normalized !== "." && normalized !== ".." &&
    !normalized.startsWith("../") && normalized === value ? normalized : null;
}
function changePaths(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const paths: string[] = [];
  for (const change of value) {
    const p = object(change) ? normalizedPath(change.path) : null;
    if (p === null) return null;
    if (!paths.includes(p) && paths.length < MAX_PATHS) paths.push(p);
  }
  return Object.freeze(paths);
}
export type CodexTrajectoryTool = Readonly<{
  sequence: number; turnIndex: number | null;
  category: "command_execution" | "file_change";
  name: "shell_command" | "file_change";
  countsTowardToolCalls: boolean;
  requestBytes: Nullable; responseBytes: Nullable; responseEstimatedTokens: Nullable;
  responseTokenProvenance: "estimated" | "unavailable";
  referencedPaths: readonly string[] | null; filesReturnedOrRead: Nullable;
  resultRepresentedInNextTurn: null;
  elapsedMs: Nullable;
}>;
export type CodexTrajectoryTurn = Readonly<{
  turnIndex: number;
  cumulativeInputTokens: Nullable; cumulativeCachedInputTokens: Nullable;
  cumulativeUncachedInputTokens: Nullable; cumulativeOutputTokens: Nullable;
  inputDelta: Nullable; cachedDelta: Nullable; uncachedDelta: Nullable; outputDelta: Nullable;
  toolCallsInTurn: number; cumulativeToolCalls: number;
  promptEstimatedTokensBeforeTurn: null;
  selectedContextFileCount: null; selectedContextBytes: null;
  contextExpansionCount: null; contextExpansionBytes: null; contextExpansionTokens: null;
  newToolResultBytesSincePreviousTurn: Nullable;
  priorToolResultsRepresented: null; selectedContextChanged: null;
  provenance: Readonly<{ cumulative: "observed" | "unavailable" | "invalid";
    deltas: "derived" | "unavailable" | "invalid";
    promptEstimate: "unavailable"; carryForward: "unavailable" }>;
}>;
export type CodexCoderTrajectory = Readonly<{
  schemaVersion: typeof CODEX_CODER_TRAJECTORY_VERSION;
  status: "observed" | "partial" | "unavailable" | "invalid";
  turns: readonly CodexTrajectoryTurn[];
  tools: readonly CodexTrajectoryTool[];
  bounded: true;
  truncated: boolean;
}>;

/** Called after canonical parsing; any malformed trajectory stays observational. */
export function deriveCodexCoderTrajectory(jsonl: string,
  timings: ReadonlyMap<string, Readonly<{ startedAtMs: number | null;
    completedAtMs: number | null }>> = new Map()): CodexCoderTrajectory {
  const turns: CodexTrajectoryTurn[] = [];
  const tools: CodexTrajectoryTool[] = [];
  const seen = new Set<string>();
  let turnIndex = 0, toolCalls = 0, callsInTurn = 0;
  let pendingResultBytes: Nullable = 0;
  let nextResultBytes: Nullable = 0;
  // The adapter starts a new SDK thread for each run, so its first cumulative sample
  // has a known zero baseline. Later gaps deliberately break delta derivation.
  let prior: { input: Nullable; cached: Nullable; output: Nullable } | null =
    { input: 0, cached: 0, output: 0 };
  let invalid = false, truncated = false;
  const recordIncomplete = () => {
    if (turnIndex === 0 || turns.at(-1)?.turnIndex === turnIndex) return;
    turns.push(Object.freeze({ turnIndex,
      cumulativeInputTokens: null, cumulativeCachedInputTokens: null,
      cumulativeUncachedInputTokens: null, cumulativeOutputTokens: null,
      inputDelta: null, cachedDelta: null, uncachedDelta: null, outputDelta: null,
      toolCallsInTurn: callsInTurn, cumulativeToolCalls: toolCalls,
      promptEstimatedTokensBeforeTurn: null,
      selectedContextFileCount: null, selectedContextBytes: null,
      contextExpansionCount: null, contextExpansionBytes: null, contextExpansionTokens: null,
      newToolResultBytesSincePreviousTurn: turnIndex === 1 ? 0 : pendingResultBytes,
      priorToolResultsRepresented: null, selectedContextChanged: null,
      provenance: Object.freeze({ cumulative: "unavailable", deltas: "unavailable",
        promptEstimate: "unavailable", carryForward: "unavailable" }) }));
    prior = null;
  };
  for (const line of jsonl.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { invalid = true; break; }
    if (!object(event)) continue;
    if (event.type === "turn.started") {
      recordIncomplete();
      turnIndex++;
      callsInTurn = 0;
      pendingResultBytes = nextResultBytes;
      nextResultBytes = 0;
      if (turnIndex > MAX_TURNS) { truncated = true; break; }
      continue;
    }
    if (event.type === "item.completed" && object(event.item) &&
        typeof event.item.id === "string" && !seen.has(event.item.id)) {
      const item = event.item;
      const itemId = item.id as string;
      if (item.type !== "command_execution" && item.type !== "file_change") continue;
      if (tools.length >= MAX_TOOLS) { truncated = true; break; }
      seen.add(itemId);
      const command = item.type === "command_execution";
      const responseBytes = command ? bytes(item.aggregated_output) : null;
      const timing = timings.get(itemId);
      const elapsedMs = timing?.startedAtMs !== null && timing?.completedAtMs !== null &&
        timing?.startedAtMs !== undefined && timing?.completedAtMs !== undefined &&
        timing.completedAtMs >= timing.startedAtMs ?
          timing.completedAtMs - timing.startedAtMs : null;
      if (command) {
        callsInTurn++;
        toolCalls++;
        nextResultBytes = nextResultBytes === null || responseBytes === null ? null :
          nextResultBytes + responseBytes;
      }
      const paths = command ? null : changePaths(item.changes);
      tools.push(Object.freeze({ sequence: tools.length + 1,
        turnIndex: turnIndex > 0 ? turnIndex : null,
        category: command ? "command_execution" : "file_change",
        name: command ? "shell_command" : "file_change",
        countsTowardToolCalls: command, requestBytes: command ? bytes(item.command) : null,
        responseBytes, responseEstimatedTokens: responseBytes === null ? null :
          Math.ceil(responseBytes / 4),
        responseTokenProvenance: responseBytes === null ? "unavailable" : "estimated",
        referencedPaths: paths,
        filesReturnedOrRead: null,
        resultRepresentedInNextTurn: null, elapsedMs }));
      continue;
    }
    if (event.type !== "turn.completed") continue;
    if (turnIndex === 0 || turns.length >= MAX_TURNS ||
        turns.at(-1)?.turnIndex === turnIndex) { invalid = true; break; }
    const usage = object(event.usage) ? event.usage : null;
    const input = count(usage?.input_tokens);
    const cached = count(usage?.cached_input_tokens);
    const output = count(usage?.output_tokens);
    const valid = input !== null && cached !== null && output !== null && cached <= input;
    const monotonic: boolean = valid && (prior === null || prior.input === null ||
      prior.cached === null || prior.output === null ||
      input! >= prior.input && cached! >= prior.cached && output! >= prior.output);
    if (!monotonic && usage !== null &&
        (input !== null || cached !== null || output !== null)) invalid = true;
    const previousInput = prior?.input ?? null;
    const previousCached = prior?.cached ?? null;
    const previousOutput = prior?.output ?? null;
    const deltaKnown = monotonic && previousInput !== null &&
      previousCached !== null && previousOutput !== null;
    const validDelta = deltaKnown && cached! - previousCached <= input! - previousInput;
    if (deltaKnown && !validDelta) invalid = true;
    const deltaProvenance = usage !== null && (!valid || !monotonic ||
      deltaKnown && !validDelta) ? "invalid" : validDelta ? "derived" : "unavailable";
    const inputDelta = validDelta ? input! - previousInput : null;
    const cachedDelta = validDelta ? cached! - previousCached : null;
    const outputDelta = validDelta ? output! - previousOutput : null;
    const uncachedDelta = validDelta ? inputDelta! - cachedDelta! : null;
    turns.push(Object.freeze({ turnIndex,
      cumulativeInputTokens: valid ? input : null,
      cumulativeCachedInputTokens: valid ? cached : null,
      cumulativeUncachedInputTokens: valid ? input - cached : null,
      cumulativeOutputTokens: valid ? output : null,
      inputDelta, cachedDelta, uncachedDelta, outputDelta,
      toolCallsInTurn: callsInTurn, cumulativeToolCalls: toolCalls,
      promptEstimatedTokensBeforeTurn: null,
      selectedContextFileCount: null, selectedContextBytes: null,
      contextExpansionCount: null, contextExpansionBytes: null, contextExpansionTokens: null,
      newToolResultBytesSincePreviousTurn: turnIndex === 1 ? 0 : pendingResultBytes,
      priorToolResultsRepresented: null, selectedContextChanged: null,
      provenance: Object.freeze({ cumulative: valid ? "observed" :
        usage === null ? "unavailable" : "invalid",
      deltas: deltaProvenance, promptEstimate: "unavailable",
      carryForward: "unavailable" }) }));
    prior = monotonic ? { input, cached, output } : null;
    callsInTurn = 0;
  }
  if (!truncated) recordIncomplete();
  return Object.freeze({ schemaVersion: CODEX_CODER_TRAJECTORY_VERSION,
    status: invalid ? "invalid" : turns.length === 0 ? "unavailable" :
      turns.some(turn => turn.cumulativeInputTokens === null) || truncated ? "partial" : "observed",
    turns: Object.freeze(turns), tools: Object.freeze(tools), bounded: true, truncated });
}
