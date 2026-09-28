import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { hashCanonicalJson } from "../../product-runtime/src/agent-event-ledger.js";

export const PLANNED_EXPERIMENT_VERSION = "planned-experiment-invocation/v1" as const;
const MANIFEST_RELATIVE = "research/context-token-matrix-v1/experiment-manifest.json";
const FROZEN_MANIFEST_HASH = "sha256:b40e40acf1a5cce7a879123881a6e3c0336c4a1f091bc2340296826f5a8a1332";
const BASELINE = "5bc84d195a1a896a5022590378b294561accbabe";
const SOURCE = "ea6bc88e947e78b7539b9614b4c637dd9b2805a9";
const VARIANTS = ["minimal", "current", "expanded"] as const;
const SHA = /^sha256:[0-9a-f]{64}$/;
const HEAD = /^[0-9a-f]{40}$/;
const SESSION = /^[a-z0-9][a-z0-9.-]{7,95}$/;
const hash = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonicalHash = (value: unknown): string => hash(JSON.stringify(value));
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function deny(detail: string): never { throw new Error(`planned_experiment_authority_invalid: ${detail}`); }
function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) deny("git identity");
  return result.stdout.trim();
}
function committedManifest(harness: string): Uint8Array {
  const result = spawnSync("git", ["show", `HEAD:${MANIFEST_RELATIVE}`],
    { cwd: harness, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0 || !result.stdout) deny("committed manifest");
  return result.stdout;
}

export type PlannedExperimentAuthority = Readonly<{
  version: typeof PLANNED_EXPERIMENT_VERSION;
  manifestPath: string;
  manifestHash: string;
  protocolVersion: string;
  sessionId: string;
  sessionHash: string;
  harnessHead: string;
  sourceHead: string;
  taskId: string;
  baseTaskHash: string;
  allowedFiles: readonly string[];
  cellId: string;
  variant: "minimal" | "current" | "expanded";
  repetitionIndex: 1;
  planSlotHash: string;
  cellHash: string;
  model: string;
  reasoning: string;
  retryCount: 0;
  repairCount: 0;
  applyCount: 0;
}>;

/** Only the committed, frozen Stage 1 manifest can produce this bounded authority. */
export function createPlannedContextMatrixAuthority(input: Readonly<{
  manifestPath: string; sourceRepositoryPath: string; sessionId: string;
  harnessHead: string; variant: string; repetitionIndex: number;
}>): PlannedExperimentAuthority {
  if (!input || typeof input.manifestPath !== "string" ||
      typeof input.sourceRepositoryPath !== "string" ||
      typeof input.sessionId !== "string" || !SESSION.test(input.sessionId) ||
      typeof input.harnessHead !== "string" || !HEAD.test(input.harnessHead) ||
      !VARIANTS.includes(input.variant as typeof VARIANTS[number]) ||
      input.repetitionIndex !== 1) deny("cell or session fields");
  const manifestPath = realpathSync(input.manifestPath);
  const harness = path.resolve(manifestPath, "../../..");
  if (manifestPath !== path.join(harness, MANIFEST_RELATIVE) ||
      git(harness, ["branch", "--show-current"]) !== "research/context-token-matrix-v1" ||
      git(harness, ["rev-parse", "HEAD"]) !== input.harnessHead ||
      git(harness, ["merge-base", "--is-ancestor", BASELINE, input.harnessHead]) !== "" ||
      git(harness, ["status", "--porcelain=v1", "--untracked-files=no"]) !== "")
    deny("committed harness identity");
  const bytes = readFileSync(manifestPath);
  if (hash(bytes) !== FROZEN_MANIFEST_HASH ||
      hash(committedManifest(harness)) !== FROZEN_MANIFEST_HASH)
    deny("frozen manifest bytes");
  const manifest = JSON.parse(bytes.toString("utf8"));
  const task = manifest.selectedTasks?.[0];
  if (manifest.manifestVersion !== "context-token-matrix-manifest/v1" ||
      manifest.protocolVersion !== "context-token-matrix-protocol/v1" ||
      manifest.sourceHead !== SOURCE || manifest.productionBaselineSha !== SOURCE ||
      manifest.model !== "gpt-5.6-luna" || manifest.reasoning !== "medium" ||
      !same(manifest.variants, VARIANTS) || manifest.selectedTasks.length !== 1 ||
      task?.category !== "A" || task?.eligible !== true || !SHA.test(task.taskHash) ||
      !same(task.allowedFiles, ["packages/worker-contract/src/index.ts", "tests/smoke/contracts.ts"]) ||
      manifest.controlledExecution?.retryCount !== 0 ||
      manifest.controlledExecution?.repairCount !== 0 ||
      manifest.controlledExecution?.applyCount !== 0 ||
      manifest.repetitionPlan?.stage1RepetitionsPerCell !== 1)
    deny("manifest execution plan");
  const source = realpathSync(input.sourceRepositoryPath);
  if (git(source, ["rev-parse", "HEAD"]) !== SOURCE ||
      !["", "?? .bounded/"].includes(git(source, ["status", "--short"])))
    deny("source identity");
  const definition = JSON.parse(readFileSync(path.join(source, task.taskFile), "utf8"));
  if (hash(definition.taskPrompt) !== task.taskHash ||
      !same(definition.allowedMutationPaths, task.allowedFiles)) deny("base coding task");
  const variant = input.variant as PlannedExperimentAuthority["variant"];
  const cellId = `A.1.${variant}`;
  const sessionHash = canonicalHash({ version: PLANNED_EXPERIMENT_VERSION,
    protocolVersion: manifest.protocolVersion, manifestHash: FROZEN_MANIFEST_HASH,
    sessionId: input.sessionId, harnessHead: input.harnessHead, sourceHead: SOURCE });
  const planSlotHash = canonicalHash({ version: PLANNED_EXPERIMENT_VERSION,
    protocolVersion: manifest.protocolVersion, manifestHash: FROZEN_MANIFEST_HASH,
    sourceHead: SOURCE, taskId: task.taskId, baseTaskHash: task.taskHash,
    allowedFiles: task.allowedFiles, cellId, variant, repetitionIndex: 1,
    model: manifest.model, reasoning: manifest.reasoning,
    retryCount: 0, repairCount: 0, applyCount: 0 });
  const cellHash = canonicalHash({ sessionHash, planSlotHash });
  return Object.freeze({ version: PLANNED_EXPERIMENT_VERSION, manifestPath,
    manifestHash: FROZEN_MANIFEST_HASH, protocolVersion: manifest.protocolVersion,
    sessionId: input.sessionId, sessionHash, harnessHead: input.harnessHead,
    sourceHead: SOURCE, taskId: task.taskId, baseTaskHash: task.taskHash,
    allowedFiles: Object.freeze([...task.allowedFiles]), cellId, variant,
    repetitionIndex: 1, planSlotHash, cellHash, model: manifest.model,
    reasoning: manifest.reasoning, retryCount: 0, repairCount: 0, applyCount: 0 });
}

export function validatePlannedContextMatrixAuthority(authority: PlannedExperimentAuthority,
  request: Readonly<{ sourceRepositoryPath: string; model: string; reasoning: string;
    stage: string; task?: string; retryDecision?: unknown }>): void {
  if (!authority || request.retryDecision !== undefined ||
      !["planner", "coder"].includes(request.stage) ||
      authority.model !== request.model || authority.reasoning !== request.reasoning)
    deny("provider operation settings");
  const expected = createPlannedContextMatrixAuthority({
    manifestPath: authority.manifestPath, sourceRepositoryPath: request.sourceRepositoryPath,
    sessionId: authority.sessionId, harnessHead: authority.harnessHead,
    variant: authority.variant, repetitionIndex: authority.repetitionIndex });
  if (!same(authority, expected)) deny("cell authority differs from frozen plan");
  if (request.task === undefined) return;
  const definition = JSON.parse(readFileSync(path.join(request.sourceRepositoryPath,
    "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json"), "utf8"));
  const marker = "\n{";
  const offset = request.task.lastIndexOf(marker);
  if (offset < 0) deny("provider task format");
  const prefix = request.task.slice(0, offset);
  const payloadText = request.task.slice(offset + 1);
  let payload: any;
  try { payload = JSON.parse(payloadText); }
  catch { deny("provider task JSON"); }
  if (JSON.stringify(payload) !== payloadText) deny("provider task serialization");
  const objective = request.stage === "planner"
    ? payload?.taskContext?.objective
    : payload?.baseContext?.taskContext?.taskContext?.objective;
  if (objective !== definition.taskPrompt) deny("provider task objective");
  if (request.stage === "planner") {
    if (hashCanonicalJson(prefix.split("\n")) !==
        "sha256:007385e20704a79491500fcaaaf660153ce65f96b3146fa96bdc869a830e8991" ||
        !same(payload.allowedChangeFiles, authority.allowedFiles))
      deny("planner prompt or allowed files");
  } else {
    const coderPrefix = [
      "You are the bounded Codex coder inside an isolated disposable Git workspace.",
      "Edit files in the working directory directly. Do not return a patch or WorkspaceMutation JSON.",
      "Only modify existing regular UTF-8 files. Never add, delete, rename, copy, chmod, or create symlinks.",
      `Only these paths may be modified: ${JSON.stringify(authority.allowedFiles)}.`,
      "Do not configure remotes or object alternates. Do not access the source repository.",
      "The runtime will deterministically capture git diff and derive expectedContentHash from its pre-agent manifest.",
      "Bounded coder context follows:"
    ].join("\n");
    if (prefix !== coderPrefix) deny("coder prompt or allowed files");
  }
}
