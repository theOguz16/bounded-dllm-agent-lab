import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hashCanonicalJson } from "../../product-runtime/src/agent-event-ledger.js";

export const TASK_B_INVOCATION_VERSION = "task-b-planned-invocation/v1" as const;
export const TASK_B_REVIEW_HASH = "sha256:1d9658a70fe793a0d4aa4eada91a85ad8ed32f0384dd896421b8d1a640d36520" as const;
const DEFINITION_HASH = "sha256:361bfb3fc8f50df2f89eb71435f137eaa3a7dd9bff0acf1958427013688f2d8c";
const SOURCE = "ea6bc88e947e78b7539b9614b4c637dd9b2805a9";
const TASK_HASH = "sha256:6bdb0008f1333479994b0070bb61a14e0cffa0e28c2cf4eb8452f9deea7ca5e0";
const PLANNER_PAYLOAD_HASH = "sha256:3788096e8d83dfd915af9b98faa7fcbca511e675193f1e5f7404d74e259f65de";
const FILES = ["packages/integrations/src/codex-event-parser.ts",
  "scripts/smoke/codex-event-parser-smoke.cjs"];
const ORDER = ["A:minimal", "A:current", "A:expanded",
  "B:current", "B:expanded", "B:minimal"];
const SESSION = /^task-b-stage1-[a-z0-9-]{8,24}$/;
const sha = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function deny(detail: string): never { throw Error(`task_b_invocation_authority_invalid: ${detail}`); }
function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) deny("git identity");
  return result.stdout.trim();
}
export type TaskBReplacement = Readonly<{
  version: "task-b-infrastructure-replacement-review/v1";
  historicalSessionId: "task-b-stage1-20260929-r2";
  historicalObservationId: "task-b-stage1-20260929-r2.1.A.minimal";
  slot: "A:minimal";
  invalidationClassification: "infrastructure_invalidated";
  replacementOrdinal: 1;
  reviewHash: typeof TASK_B_REVIEW_HASH;
  originalSlotHash: string;
  originalObservationHash: string;
  originalPlannerRunId: string;
  originalPlannerRecordHash: string;
  originalCoderRunId: string;
  originalCoderRecordHash: string;
  newSessionId: string;
}>;
export type TaskBInvocationAuthority = Readonly<{
  version: typeof TASK_B_INVOCATION_VERSION;
  experimentId: "codex-event-ordering";
  harnessRoot: string;
  harnessHead: string;
  definitionHash: typeof DEFINITION_HASH;
  taskHash: typeof TASK_HASH;
  plannerPayloadHash: typeof PLANNER_PAYLOAD_HASH;
  sourceHead: typeof SOURCE;
  sessionId: string;
  sessionHash: string;
  observationId: string;
  runtimeIdentity: string;
  position: number;
  replicate: "A" | "B";
  variant: "minimal" | "current" | "expanded";
  slotHash: string;
  observationHash: string;
  stage: "planner" | "coder";
  stageHash: string;
  model: "gpt-5.6-luna";
  reasoning: "medium";
  retry: 0; repair: 0; apply: 0;
  replacement: TaskBReplacement | null;
}>;
export type TaskBReview = Readonly<{
  version: TaskBReplacement["version"];
  experimentId: string; taskHash: string; sourceHead: string; model: string;
  reasoning: string; historicalSessionId: string; historicalObservationId: string;
  slot: string; invalidationClassification: string; defect: string; fixCommit: string;
  evidence: Readonly<{ stage1SummarySha256: string; reservationSha256: string;
    plannerRunId: string; plannerRecordHash: string; coderRunId: string;
    coderRecordHash: string }>;
  replacementOrdinal: number; maximumReplacements: number;
  zeroRowStoppedSessions: readonly Readonly<{
    sessionId: string; stage1SummarySha256: string; reservationSha256: string;
    providerStageInvocations: number; stop: string;
  }> [];
}>;
export function readTaskBReplacementReview(harnessRoot: string): TaskBReview {
  const file = path.join(realpathSync(harnessRoot),
    "research/context-token-matrix-v1/task-b-replacement-review.json");
  const bytes = readFileSync(file);
  if (sha(bytes) !== TASK_B_REVIEW_HASH) deny("review hash");
  const review = JSON.parse(bytes.toString("utf8")) as TaskBReview;
  if (review.version !== "task-b-infrastructure-replacement-review/v1" ||
      review.experimentId !== "codex-event-ordering" || review.taskHash !== TASK_HASH ||
      review.sourceHead !== SOURCE || review.model !== "gpt-5.6-luna" ||
      review.reasoning !== "medium" || review.historicalSessionId !== "task-b-stage1-20260929-r2" ||
      review.historicalObservationId !== "task-b-stage1-20260929-r2.1.A.minimal" ||
      review.slot !== "A:minimal" || review.invalidationClassification !== "infrastructure_invalidated" ||
      review.defect !== "Candidate path alias between /var and canonical /private/var" ||
      review.fixCommit !== "9fb7f41c41ea93701a0244030a339679bf6bcccb" ||
      review.replacementOrdinal !== 1 || review.maximumReplacements !== 1 ||
      !same(review.zeroRowStoppedSessions?.map(item =>
        [item.sessionId, item.providerStageInvocations, item.stop]), [
        ["task-b-stage1-20260929-r1", 0,
          "infrastructure_or_ambiguous: context_matrix_preflight_invalid: run identity"],
        ["task-b-stage1-20260929-r3", 1, "ambiguous_failure"]
      ]))
    deny("review fields");
  return review;
}
export function createTaskBInvocationAuthority(input: Readonly<{
  harnessRoot: string; sourceRepositoryPath: string; sessionId: string;
  position: number; replicate: "A" | "B"; variant: "minimal" | "current" | "expanded";
  stage: "planner" | "coder"; replacement?: boolean;
}>): TaskBInvocationAuthority {
  if (!input || !SESSION.test(input.sessionId) || /--|-$/.test(input.sessionId) ||
      !Number.isInteger(input.position) || input.position < 1 || input.position > 6 ||
      ORDER[input.position - 1] !== `${input.replicate}:${input.variant}` ||
      !["planner", "coder"].includes(input.stage)) deny("frozen slot");
  const harness = realpathSync(input.harnessRoot);
  const source = realpathSync(input.sourceRepositoryPath);
  const harnessHead = git(harness, ["rev-parse", "HEAD"]);
  if (git(harness, ["branch", "--show-current"]) !== "research/context-token-matrix-v1" ||
      git(source, ["rev-parse", "HEAD"]) !== SOURCE) deny("harness or source identity");
  const definitionBytes = readFileSync(path.join(harness,
    "research/context-token-matrix-v1/task-b-definition.json"));
  if (sha(definitionBytes) !== DEFINITION_HASH) deny("definition hash");
  const definition = JSON.parse(definitionBytes.toString("utf8"));
  if (definition.sourceTask?.taskHash !== TASK_HASH ||
      definition.sourceTask?.sourceHead !== SOURCE ||
      definition.sourceTask?.model !== "gpt-5.6-luna" ||
      definition.sourceTask?.reasoning !== "medium" ||
      !same(definition.sourceTask?.allowedFiles, FILES) ||
      !same(definition.sourceTask?.policy &&
        [definition.sourceTask.policy.retry, definition.sourceTask.policy.repair,
          definition.sourceTask.policy.apply], [0, 0, 0])) deny("frozen definition");
  const review = readTaskBReplacementReview(harness);
  git(harness, ["merge-base", "--is-ancestor", review.fixCommit, harnessHead]);
  if ((input.position === 1) !== (input.replacement === true)) deny("replacement slot binding");
  const slotHash = sha(JSON.stringify([TASK_B_INVOCATION_VERSION, TASK_HASH, SOURCE,
    input.position, input.replicate, input.variant, "gpt-5.6-luna", "medium", 0, 0, 0]));
  const historicalSessionHash = sha(JSON.stringify([TASK_B_INVOCATION_VERSION, TASK_HASH, SOURCE,
    review.historicalSessionId, "gpt-5.6-luna", "medium", 0, 0, 0]));
  const replacement: TaskBReplacement | null = input.replacement ? {
    version: "task-b-infrastructure-replacement-review/v1",
    historicalSessionId: "task-b-stage1-20260929-r2",
    historicalObservationId: "task-b-stage1-20260929-r2.1.A.minimal",
    slot: "A:minimal", invalidationClassification: "infrastructure_invalidated",
    replacementOrdinal: 1, reviewHash: TASK_B_REVIEW_HASH,
    originalSlotHash: slotHash,
    originalObservationHash: sha(JSON.stringify([historicalSessionHash, slotHash, null])),
    originalPlannerRunId: review.evidence.plannerRunId,
    originalPlannerRecordHash: review.evidence.plannerRecordHash,
    originalCoderRunId: review.evidence.coderRunId,
    originalCoderRecordHash: review.evidence.coderRecordHash,
    newSessionId: input.sessionId
  } : null;
  const sessionHash = sha(JSON.stringify([TASK_B_INVOCATION_VERSION, TASK_HASH, SOURCE,
    harnessHead, input.sessionId, "gpt-5.6-luna", "medium", 0, 0, 0]));
  const observationId = `${input.sessionId}.${input.position}.${input.replicate}.${input.variant}`;
  const runtimeIdentity = `${input.sessionId}.task-b.${input.position}.${input.replicate.toLowerCase()}.${input.variant}`;
  const observationHash = sha(JSON.stringify([sessionHash, slotHash, replacement]));
  return Object.freeze({
    version: TASK_B_INVOCATION_VERSION, experimentId: "codex-event-ordering",
    harnessRoot: harness, harnessHead, definitionHash: DEFINITION_HASH, taskHash: TASK_HASH,
    plannerPayloadHash: PLANNER_PAYLOAD_HASH, sourceHead: SOURCE,
    sessionId: input.sessionId, sessionHash, observationId, runtimeIdentity,
    position: input.position, replicate: input.replicate, variant: input.variant,
    slotHash, observationHash, stage: input.stage,
    stageHash: sha(JSON.stringify([observationHash, input.stage])),
    model: "gpt-5.6-luna", reasoning: "medium", retry: 0, repair: 0, apply: 0,
    replacement
  });
}
export function validateTaskBInvocationAuthority(authority: TaskBInvocationAuthority,
  request: Readonly<{ sourceRepositoryPath: string; runId: string;
    stage: string; model: string; reasoning: string; task: string; retryDecision?: unknown }>): void {
  if (!authority || request.retryDecision !== undefined ||
      authority.stage !== request.stage || authority.model !== request.model ||
      authority.reasoning !== request.reasoning ||
      !request.runId.startsWith(
        `matrix.${authority.runtimeIdentity}.${authority.stage}.`))
    deny("request binding");
  const expected = createTaskBInvocationAuthority({
    harnessRoot: authority.harnessRoot, sourceRepositoryPath: request.sourceRepositoryPath,
    sessionId: authority.sessionId, position: authority.position,
    replicate: authority.replicate, variant: authority.variant, stage: authority.stage,
    replacement: authority.replacement !== null
  });
  if (!same(authority, expected)) deny("authority differs from frozen plan");
  const definition = JSON.parse(readFileSync(path.join(authority.harnessRoot,
    "research/context-token-matrix-v1/task-b-definition.json"), "utf8"));
  const marker = "\n{";
  const offset = request.task.lastIndexOf(marker);
  if (offset < 0) deny("provider task format");
  const prefix = request.task.slice(0, offset);
  const payloadText = request.task.slice(offset + 1);
  let payload: any;
  try { payload = JSON.parse(payloadText); }
  catch { deny("provider task JSON"); }
  if (JSON.stringify(payload) !== payloadText) deny("provider task serialization");
  const objective = authority.stage === "planner"
    ? payload?.taskContext?.objective
    : payload?.baseContext?.taskContext?.taskContext?.taskContext?.objective;
  if (objective !== definition.sourceTask.providerPrompt) deny("provider task objective");
  if (authority.stage === "planner") {
    if (sha(request.task) !== authority.plannerPayloadHash) deny("planner payload hash");
    if (hashCanonicalJson(prefix.split("\n")) !==
        "sha256:007385e20704a79491500fcaaaf660153ce65f96b3146fa96bdc869a830e8991" ||
        !same(payload.allowedChangeFiles, FILES)) deny("planner scope");
  } else {
    const coderPrefix = [
      "You are the bounded Codex coder inside an isolated disposable Git workspace.",
      "Edit files in the working directory directly. Do not return a patch or WorkspaceMutation JSON.",
      "Only modify existing regular UTF-8 files. Never add, delete, rename, copy, chmod, or create symlinks.",
      `Only these paths may be modified: ${JSON.stringify(FILES)}.`,
      "Do not configure remotes or object alternates. Do not access the source repository.",
      "The runtime will deterministically capture git diff and derive expectedContentHash from its pre-agent manifest.",
      "Bounded coder context follows:"
    ].join("\n");
    if (prefix !== coderPrefix) deny("coder scope");
  }
}
