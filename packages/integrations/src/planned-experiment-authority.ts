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
const REVIEW_RELATIVE = "research/context-token-matrix-v1/replacement-review.json";
const REVIEW_HASH = "sha256:3646457c942383b63f1972df73901f4ec453df81cb407d3c3618507855274361";
const FINAL_REVIEW_RELATIVE = "research/context-token-matrix-v1/final-replacement-review.json";
const FINAL_REVIEW_HASH = "sha256:1211d532c36464ce5d615b4795b7a9c0df03c945ac899f77e0c98413e8d5fe23";
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
  replacementAttemptIndex?: 2 | 3;
  replacesSessionId?: string;
  replacementReviewHash?: string;
}>;

export type PlannedReplacementReview = Readonly<{
  version: "context-token-matrix-replacement-review/v1";
  protocolVersion: string;
  manifestHash: string;
  sourceHead: string;
  failedSessionId: string;
  failedHarnessHead: string;
  failedCellId: string;
  failedCellHash: string;
  failedPlannerRunId: string;
  terminalClassification: "infrastructure_invalidated";
  defect: string;
  fixCommit: string;
  evidence: Readonly<Record<string, string>>;
  replacementAttemptIndex: 2;
  maximumReplacementAttempts: 1;
}>;

export type PlannedFinalReplacementReview = Readonly<{
  version: "context-token-matrix-final-replacement-review/v1";
  protocolVersion: string; manifestHash: string; sourceHead: string;
  taskId: string; plannedCells: readonly string[]; model: string; reasoning: string;
  retryCount: 0; repairCount: 0; applyCount: 0;
  priorSessionId: string; priorAttemptIndex: 2; priorHarnessHead: string;
  priorCellHash: string; priorSessionHash: string;
  priorPlannerRunId: string; priorCoderRunId: string;
  terminalClassification: "infrastructure_invalidated";
  defect: string; syntaxCommand: string; syntaxExitCode: 127;
  syntaxEvidenceHash: string; fixCommit: string;
  fixReproducedAndAuditedOffline: true;
  evidence: Readonly<Record<string, string>>;
  finalAttemptIndex: 3; terminalForStage1Recovery: true;
}>;

/** Exact reviewed final authority. A caller-supplied attempt index is insufficient. */
export function readPlannedFinalReplacementReview(manifestPath: string): PlannedFinalReplacementReview {
  const harness = path.resolve(realpathSync(manifestPath), "../../..");
  const bytes = readFileSync(path.join(harness, FINAL_REVIEW_RELATIVE));
  const committed = spawnSync("git", ["show", `HEAD:${FINAL_REVIEW_RELATIVE}`],
    { cwd: harness, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  if (committed.status !== 0 || hash(bytes) !== FINAL_REVIEW_HASH ||
      hash(committed.stdout) !== FINAL_REVIEW_HASH) deny("reviewed final replacement record");
  const review = JSON.parse(bytes.toString("utf8")) as PlannedFinalReplacementReview;
  if (review.version !== "context-token-matrix-final-replacement-review/v1" ||
      review.protocolVersion !== "context-token-matrix-protocol/v1" ||
      review.manifestHash !== FROZEN_MANIFEST_HASH || review.sourceHead !== SOURCE ||
      review.taskId !== "controlled-real-coding-v2.worker-request-id-correlation" ||
      !same(review.plannedCells, ["A.1.minimal", "A.1.current", "A.1.expanded"]) ||
      review.model !== "gpt-5.6-luna" || review.reasoning !== "medium" ||
      review.retryCount !== 0 || review.repairCount !== 0 || review.applyCount !== 0 ||
      review.priorSessionId !== "stage1-6dd625d066c365928d93bd1f" ||
      review.priorAttemptIndex !== 2 ||
      review.priorHarnessHead !== "09028271e391c7f723fcf6cb1fca6a9bd0a4a3b1" ||
      review.priorCellHash !== "sha256:fd0fdff890726f6c39abbb0758930d70374e8d5f87b3a4a4a1f61d7270eeb1b0" ||
      review.priorSessionHash !== "sha256:1cb4ecaed8f242fb9adcdc46b6e2b1eb443f73f966f1d8ed04014dfb4659e4d7" ||
      review.priorPlannerRunId !== "matrix.9a6ddddfae8629a0.minimal.planner.codex.3905526266859afa1a06d66471a09a87" ||
      review.priorCoderRunId !== "matrix.9a6ddddfae8629a0.minimal.coder.f84482474cc035f8b54046aa1c7bdf79" ||
      review.terminalClassification !== "infrastructure_invalidated" ||
      review.defect !== "missing-pinned-source-dependencies-in-configured-validation" ||
      review.syntaxCommand !== "npm run build" || review.syntaxExitCode !== 127 ||
      review.syntaxEvidenceHash !== "sha256:d0b1fafb9eed74d4fcc114e9eb8a8f44f0479ef9047766a40be6a6f73c49e787" ||
      review.fixCommit !== "01727bef45cd53ad5978ccd754889abf7e411bee" ||
      review.fixReproducedAndAuditedOffline !== true || review.finalAttemptIndex !== 3 ||
      review.terminalForStage1Recovery !== true ||
      review.evidence?.rawBoundedSha256 !== "sha256:379e3e21503ac48287173be457d3e96c84e09faeb834392a6550ab4dec1d6b59" ||
      review.evidence?.rawProductSha256 !== "sha256:5762dcc9530c9c875f9a01648e5c9fba2780366c72faf0edb8c9853e24653e7f" ||
      review.evidence?.experimentResultSha256 !== "sha256:71244d2f120bdcb22fbb1bbfb5ae7475cc3efa9533ca01d78b19bed983b91ad1" ||
      review.evidence?.cellSummarySha256 !== "sha256:63c7da6def2ce99dc73f45fb9fb062c3f355830fbdd8113532568728a7770492" ||
      review.evidence?.stage1SummarySha256 !== "sha256:0e05028b180d474b70c6771aff132c6fae79fffabe33f16be7fc0e44bc05ca33")
    deny("final replacement review fields");
  return review;
}

/** Reviewed, committed evidence for the one V1 infrastructure replacement. */
export function readPlannedReplacementReview(manifestPath: string): PlannedReplacementReview {
  const harness = path.resolve(realpathSync(manifestPath), "../../..");
  const file = path.join(harness, REVIEW_RELATIVE);
  const bytes = readFileSync(file);
  const committed = spawnSync("git", ["show", `HEAD:${REVIEW_RELATIVE}`],
    { cwd: harness, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  if (committed.status !== 0 || hash(bytes) !== REVIEW_HASH ||
      hash(committed.stdout) !== REVIEW_HASH) deny("reviewed replacement record");
  const review = JSON.parse(bytes.toString("utf8")) as PlannedReplacementReview;
  if (review.version !== "context-token-matrix-replacement-review/v1" ||
      review.protocolVersion !== "context-token-matrix-protocol/v1" ||
      review.manifestHash !== FROZEN_MANIFEST_HASH || review.sourceHead !== SOURCE ||
      review.failedSessionId !== "stage1-70a2d3b048822c4ab11b779d" ||
      review.failedHarnessHead !== "d1bf4fef8614fa9adcad5fe18715cfda8b63edeb" ||
      review.failedCellId !== "A.1.minimal" ||
      review.terminalClassification !== "infrastructure_invalidated" ||
      review.fixCommit !== "d0e31ad73d7279839f0746b8e4f16fa30186b5c6" ||
      review.replacementAttemptIndex !== 2 || review.maximumReplacementAttempts !== 1)
    deny("replacement review fields");
  return review;
}

/** Only the committed, frozen Stage 1 manifest can produce this bounded authority. */
export function createPlannedContextMatrixAuthority(input: Readonly<{
  manifestPath: string; sourceRepositoryPath: string; sessionId: string;
  harnessHead: string; variant: string; repetitionIndex: number;
  replacementAttemptIndex?: 2 | 3; replacesSessionId?: string;
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
  const replacement = input.replacementAttemptIndex === 2 ? readPlannedReplacementReview(manifestPath) :
    input.replacementAttemptIndex === 3 ? readPlannedFinalReplacementReview(manifestPath) : null;
  const replacesSessionId = input.replacementAttemptIndex === 2
    ? (replacement as PlannedReplacementReview).failedSessionId :
    input.replacementAttemptIndex === 3 ? (replacement as PlannedFinalReplacementReview).priorSessionId : null;
  if ((replacement === null && (input.replacesSessionId !== undefined ||
        input.replacementAttemptIndex !== undefined)) ||
      (replacement !== null && (input.replacesSessionId !== replacesSessionId ||
        input.sessionId === replacesSessionId ||
        git(harness, ["merge-base", "--is-ancestor", replacement.fixCommit,
          input.harnessHead]) !== ""))) deny("replacement attempt authority");
  const reviewHash = input.replacementAttemptIndex === 2 ? REVIEW_HASH : FINAL_REVIEW_HASH;
  const sessionHash = canonicalHash({ version: PLANNED_EXPERIMENT_VERSION,
    protocolVersion: manifest.protocolVersion, manifestHash: FROZEN_MANIFEST_HASH,
    sessionId: input.sessionId, harnessHead: input.harnessHead, sourceHead: SOURCE,
    ...(replacement === null ? {} : { replacementAttemptIndex: input.replacementAttemptIndex,
      replacesSessionId, replacementReviewHash: reviewHash }) });
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
    reasoning: manifest.reasoning, retryCount: 0, repairCount: 0, applyCount: 0,
    ...(replacement === null ? {} : { replacementAttemptIndex: input.replacementAttemptIndex,
      replacesSessionId: replacesSessionId!, replacementReviewHash: reviewHash }) });
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
    variant: authority.variant, repetitionIndex: authority.repetitionIndex,
    replacementAttemptIndex: authority.replacementAttemptIndex,
    replacesSessionId: authority.replacesSessionId });
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
    : payload?.baseContext?.taskContext?.taskContext?.taskContext?.objective;
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
