import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hashCanonicalJson } from "../../product-runtime/src/agent-event-ledger.js";

export const TASK_B_STAGE2_PLAN_HASH = "sha256:62ea975ceac53992dbd30b578099d152958d99704606267aa668a7bf10e1a7b1";
export const TASK_B_TRAJECTORY_V2_PLAN_HASH = "sha256:581395330b7d77c49b1645013894eb39fe883275977f5a218123825e2a42590a";
export const TASK_B_INSPECTION_PLAN_HASH = "sha256:2ef01b65dc466891a8db4a6b59902ec0f96d7bc4c33bc1e2ecc918a172f1072d";
const SOURCE = "ea6bc88e947e78b7539b9614b4c637dd9b2805a9";
const TASK = "sha256:6bdb0008f1333479994b0070bb61a14e0cffa0e28c2cf4eb8452f9deea7ca5e0";
const ORDER = ["A:minimal", "A:current", "A:expanded", "B:current", "B:expanded", "B:minimal"];
const SESSION_STAGE2 = /^task-b-stage2-[a-z0-9-]{8,24}$/;
const SESSION_TRAJECTORY = /^task-b-telemetry-[a-z0-9-]{8,24}$/;
const SESSION_INSPECTION = /^task-b-inspection-[a-z0-9-]{8,24}$/;
const TELEMETRY_ORDER = ["A:current", "A:minimal", "B:expanded"];
const INSPECTION_INSTRUCTION = "Minimize redundant repository inspection. When practical, batch related read-only inspections, do not reread files that have not changed since your previous inspection, and begin implementation once you have sufficient evidence to make the required change. Do not skip any required build, typecheck, test, scope, or validation checks.";
const CONTROL_PREFIX_HASH = "sha256:4603fac5b703f785b570f75b9e06804f68c5e354fdb2ef6876533024fe7888e2";
const TREATMENT_PREFIX_HASH = "sha256:b71156c3b1667aec4ee44fbec6ba6da83d69a4c25d860bc5a0ad17bc5cd617a7";
const PLANNER_HASH = "sha256:3788096e8d83dfd915af9b98faa7fcbca511e675193f1e5f7404d74e259f65de";
const FILES = ["packages/integrations/src/codex-event-parser.ts",
  "scripts/smoke/codex-event-parser-smoke.cjs"];
const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function gate(ok: unknown, reason: string): asserts ok { if (!ok) throw Error(`prospective_matrix_authority_invalid: ${reason}`); }
function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
  gate(result.status === 0, "git identity");
  return result.stdout.trim();
}
export type MatrixSlot = Readonly<{ position: number; replicate: "A" | "B"; variant: "minimal" | "current" | "expanded";
  condition?: "control" | "inspection-instruction" }>;
export type MatrixPlan = Readonly<{
  schemaVersion: "context-matrix-execution-plan/v1";
  experimentId: string; taskId: string; taskHash: string; stage: "stage2"; sourceHead: string;
  orderedSlots: readonly MatrixSlot[];
  conditionDefinitions?: Readonly<{ control: Readonly<{ instruction: null; coderPrefixHash: string }>;
    "inspection-instruction": Readonly<{ instruction: string; coderPrefixHash: string }> }>;
  contextDefinition: Readonly<{ selector: string; definitionPath: string; definitionHash: string;
    calibrationPath: string; calibrationHash: string }>;
  model: string; reasoning: string;
  timeoutPolicy: Readonly<{ provider: string; override: boolean; agentTimeout: string }>;
  limits: Readonly<{ maxObservations: number; maxProviderStages: number; maxProviderStagesPerObservation: number }>;
  policy: Readonly<{ retry: number; repair: number; apply: number }>;
  stopPolicy: Readonly<{ candidateOrModelFailure: string; infrastructureOrAmbiguousFailure: string }>;
  telemetryValidity?: Readonly<{ schemaVersion: string; minimumUsableIntervalFraction: number;
    requiredFields: readonly string[] }>;
  priorStage: Readonly<{ compositionSessionId: string; compositionPath: string;
    compositionHash: string; retainedPrefixReviewHash: string }>;
}>;
export type ProspectiveMatrixAuthority = Readonly<{
  version: "prospective-matrix-stage/v1" | "prospective-matrix-stage/v2";
  experimentKind?: "trajectory-v2-validation" | "inspection-instruction-validation";
  planSchemaVersion?: MatrixPlan["schemaVersion"]; taskId?: string;
  contextDefinition?: MatrixPlan["contextDefinition"];
  limits?: MatrixPlan["limits"]; timeoutPolicy?: MatrixPlan["timeoutPolicy"];
  stopPolicy?: MatrixPlan["stopPolicy"]; priorStage?: MatrixPlan["priorStage"];
  trajectoryTelemetry?: "codex-coder-trajectory/v2";
  contextExpansion?: "none";
  condition?: MatrixSlot["condition"];
  coderPrefixHash?: string;
  planHash: string; experimentId: string;
  harnessRoot: string; planPath: string; priorCompositionPath: string;
  taskHash: string; sourceHead: string; stage: "stage2"; sessionId: string;
  position: number; replicate: MatrixSlot["replicate"]; variant: MatrixSlot["variant"];
  providerStage: "planner" | "coder"; priorCompositionHash: string;
  observationId: string; runtimeIdentity: string; sessionHash: string;
  slotHash: string; stageHash: string; model: string; reasoning: string;
  retry: 0; repair: 0; apply: 0; replacement: false;
}>;
export function hashMatrixPlanBytes(bytes: Uint8Array): string { return sha(bytes); }
/** Structural validation shared by future ordered context-matrix plans. */
export function validateMatrixPlan(value: unknown): MatrixPlan {
  gate(value !== null && typeof value === "object" && !Array.isArray(value), "plan object");
  const plan = value as MatrixPlan;
  gate(plan.schemaVersion === "context-matrix-execution-plan/v1" &&
    typeof plan.experimentId === "string" && typeof plan.taskId === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(plan.taskHash) &&
    /^[0-9a-f]{40}$/.test(plan.sourceHead) &&
    ["stage1", "stage2"].includes(plan.stage) &&
    typeof plan.model === "string" && typeof plan.reasoning === "string", "plan identity");
  gate(Array.isArray(plan.orderedSlots) && plan.orderedSlots.length > 0 &&
    plan.orderedSlots.every((slot, index) => slot.position === index + 1 &&
      ["A", "B"].includes(slot.replicate) &&
      ["minimal", "current", "expanded"].includes(slot.variant)), "ordered positions");
  gate(plan.limits?.maxObservations === plan.orderedSlots.length &&
    Number.isSafeInteger(plan.limits.maxProviderStages) &&
    Number.isSafeInteger(plan.limits.maxProviderStagesPerObservation) &&
    plan.limits.maxProviderStagesPerObservation > 0 &&
    plan.limits.maxProviderStages <= plan.limits.maxObservations *
      plan.limits.maxProviderStagesPerObservation, "ceilings");
  gate(plan.policy?.retry === 0 && plan.policy.repair === 0 &&
    plan.policy.apply === 0 && plan.timeoutPolicy?.override === false &&
    typeof plan.contextDefinition?.selector === "string" &&
    typeof plan.priorStage?.compositionHash === "string", "policy or references");
  if (plan.telemetryValidity !== undefined) {
    const requirement = plan.telemetryValidity;
    gate(typeof requirement.schemaVersion === "string" && requirement.schemaVersion.length > 0 &&
      typeof requirement.minimumUsableIntervalFraction === "number" &&
      Number.isFinite(requirement.minimumUsableIntervalFraction) &&
      requirement.minimumUsableIntervalFraction >= 0 &&
      requirement.minimumUsableIntervalFraction <= 1 &&
      Array.isArray(requirement.requiredFields) &&
      requirement.requiredFields.every(field => typeof field === "string" &&
        /^[A-Za-z][A-Za-z0-9]*$/.test(field)) &&
      new Set(requirement.requiredFields).size === requirement.requiredFields.length,
    "telemetry validity requirement");
  }
  return plan;
}
/** Frozen first consumer: generic shape plus exact Task B Stage 2 constants. */
export function validateFrozenTaskBStage2Plan(value: unknown): MatrixPlan {
  const plan = validateMatrixPlan(value);
  gate(plan.experimentId === "codex-event-ordering" && plan.taskId === "R4" &&
    plan.taskHash === TASK && plan.stage === "stage2" && plan.sourceHead === SOURCE &&
    plan.model === "gpt-5.6-luna" && plan.reasoning === "medium", "Task B identity");
  gate(plan.orderedSlots.length === 6 &&
    same(plan.orderedSlots.map((slot, index) => [slot.position, `${slot.replicate}:${slot.variant}`]),
      ORDER.map((value, index) => [index + 1, value])), "Task B order");
  gate(same(plan.limits, { maxObservations: 6, maxProviderStages: 18,
    maxProviderStagesPerObservation: 3 }) &&
    same(plan.policy, { retry: 0, repair: 0, apply: 0 }) &&
    same(plan.timeoutPolicy, { provider: "existing-production-default", override: false,
      agentTimeout: "product_behavior_no_automatic_replacement" }) &&
    same(plan.stopPolicy, { candidateOrModelFailure: "persist_and_continue_if_infrastructure_healthy",
      infrastructureOrAmbiguousFailure: "stop_immediately" }), "Task B policy");
  return plan;
}
/** A separate, hash-pinned experiment kind. The existing plan bytes remain immutable. */
export function validateTaskBTrajectoryV2Plan(value: unknown, harnessRoot: string): MatrixPlan {
  const plan = validateMatrixPlan(value);
  const frozenPath = path.join(realpathSync(harnessRoot),
    "research/context-token-matrix-v1/task-b-stage2-plan.json");
  const frozenBytes = readFileSync(frozenPath);
  gate(sha(frozenBytes) === TASK_B_STAGE2_PLAN_HASH, "frozen Task B Stage 2 provenance");
  const frozen = validateFrozenTaskBStage2Plan(JSON.parse(frozenBytes.toString("utf8")));
  const expected = { ...frozen,
    orderedSlots: TELEMETRY_ORDER.map((item, index) => ({ position: index + 1,
      replicate: item[0], variant: item.slice(2) })),
    limits: { maxObservations: 3, maxProviderStages: 6,
      maxProviderStagesPerObservation: 2 } };
  gate(same(plan, expected), "trajectory-v2 plan identity or policy");
  return plan;
}
/** The prompt experiment is a separate exact plan; historical plan bytes remain untouched. */
export function validateTaskBInspectionPlan(value: unknown, harnessRoot: string): MatrixPlan {
  const plan = validateMatrixPlan(value);
  const frozenBytes = readFileSync(path.join(realpathSync(harnessRoot),
    "research/context-token-matrix-v1/task-b-stage2-plan.json"));
  gate(sha(frozenBytes) === TASK_B_STAGE2_PLAN_HASH, "frozen Task B Stage 2 provenance");
  const frozen = validateFrozenTaskBStage2Plan(JSON.parse(frozenBytes.toString("utf8")));
  const orderedSlots: MatrixSlot[] = ["control", "inspection-instruction",
    "inspection-instruction", "control"].map((condition, index) => ({
      position: index + 1, replicate: condition === "control" ? "A" : "B",
      variant: "current", condition: condition as MatrixSlot["condition"] }));
  const expected = { ...frozen,
    experimentId: "codex-event-ordering-inspection-instruction", orderedSlots,
    conditionDefinitions: { control: { instruction: null, coderPrefixHash: CONTROL_PREFIX_HASH },
      "inspection-instruction": { instruction: INSPECTION_INSTRUCTION,
        coderPrefixHash: TREATMENT_PREFIX_HASH } },
    limits: { maxObservations: 4, maxProviderStages: 8,
      maxProviderStagesPerObservation: 2 } };
  gate(hashCanonicalJson(plan) === hashCanonicalJson(expected), "inspection plan identity or policy");
  return plan;
}
export function readProspectiveMatrixPlan(harnessRoot: string, planPath: string,
  priorCompositionPath: string): Readonly<{ plan: MatrixPlan; planHash: string;
    experimentKind: "context-matrix-stage2" | "trajectory-v2-validation" | "inspection-instruction-validation";
    trajectoryTelemetry: "codex-coder-trajectory/v1" | "codex-coder-trajectory/v2";
    contextExpansion: "existing-bounded-request" | "none" }> {
  const harness = realpathSync(harnessRoot);
  const file = lstatSync(planPath);
  gate(file.isFile() && !file.isSymbolicLink() && file.size <= 16_384,
    "safe regular plan file");
  const planBytes = readFileSync(planPath);
  const planHash = sha(planBytes);
  gate([TASK_B_STAGE2_PLAN_HASH, TASK_B_TRAJECTORY_V2_PLAN_HASH,
    TASK_B_INSPECTION_PLAN_HASH].includes(planHash),
    "approved plan hash");
  const trajectory = planHash === TASK_B_TRAJECTORY_V2_PLAN_HASH;
  const inspection = planHash === TASK_B_INSPECTION_PLAN_HASH;
  const plan = trajectory ? validateTaskBTrajectoryV2Plan(
    JSON.parse(planBytes.toString("utf8")), harness) : inspection ? validateTaskBInspectionPlan(
    JSON.parse(planBytes.toString("utf8")), harness) :
    validateFrozenTaskBStage2Plan(JSON.parse(planBytes.toString("utf8")));
  for (const [file, hash] of [[plan.contextDefinition.definitionPath,
      plan.contextDefinition.definitionHash], [plan.contextDefinition.calibrationPath,
      plan.contextDefinition.calibrationHash]] as const) {
    gate(sha(readFileSync(path.join(harness, file))) === hash, "context artifact hash");
  }
  gate(plan.contextDefinition.selector === "selectTaskBContext/v1" &&
    plan.priorStage.compositionSessionId === "task-b-stage1-20260930-suffix-r1" &&
    plan.priorStage.compositionPath === "stage1-composition.json" &&
    sha(readFileSync(priorCompositionPath)) === plan.priorStage.compositionHash,
  "prior composition hash");
  const composition = JSON.parse(readFileSync(priorCompositionPath, "utf8"));
  gate(composition.schemaVersion === "task-b-stage1-composition/v1" &&
    composition.retainedPrefixReviewHash === plan.priorStage.retainedPrefixReviewHash &&
    same(composition.rows?.map((row: MatrixSlot) =>
      [row.position, `${row.replicate}:${row.variant}`]),
      ORDER.map((value, index) => [index + 1, value])) &&
    composition.rows[2].classification === "production_product_timeout" &&
    composition.rows[2].replacementEligible !== true, "prior composition evidence");
  return { plan, planHash,
    experimentKind: trajectory ? "trajectory-v2-validation" : inspection ?
      "inspection-instruction-validation" : "context-matrix-stage2",
    trajectoryTelemetry: trajectory || inspection ? "codex-coder-trajectory/v2" : "codex-coder-trajectory/v1",
    contextExpansion: trajectory || inspection ? "none" : "existing-bounded-request" };
}
export function createProspectiveMatrixAuthority(input: Readonly<{
  harnessRoot: string; sourceRepositoryPath: string; planPath: string;
  priorCompositionPath: string; sessionId: string; slot: MatrixSlot;
  providerStage: "planner" | "coder";
}>): ProspectiveMatrixAuthority {
  const { plan, planHash, experimentKind } = readProspectiveMatrixPlan(input.harnessRoot,
    input.planPath, input.priorCompositionPath);
  gate((experimentKind === "trajectory-v2-validation" ? SESSION_TRAJECTORY :
    experimentKind === "inspection-instruction-validation" ? SESSION_INSPECTION : SESSION_STAGE2)
    .test(input.sessionId) && !/--|-$/.test(input.sessionId), "matrix session identity");
  gate(git(input.harnessRoot, ["branch", "--show-current"]) === "research/context-token-matrix-v1" &&
    git(input.sourceRepositoryPath, ["rev-parse", "HEAD"]) === SOURCE, "checkout identity");
  const slot = plan.orderedSlots[input.slot.position - 1];
  gate(slot !== undefined && same(slot, input.slot) &&
    ["planner", "coder"].includes(input.providerStage), "slot identity");
  const observationId = `${input.sessionId}.${slot.position}.${slot.replicate}.${slot.variant}`;
  const runtimeIdentity = `${input.sessionId}.task-b.stage2.${slot.position}.${slot.replicate.toLowerCase()}.${slot.variant}`;
  const sessionHash = sha(JSON.stringify([planHash, plan.taskHash, plan.stage, input.sessionId,
    plan.priorStage.compositionHash]));
  const slotHash = sha(JSON.stringify([sessionHash, slot]));
  return Object.freeze({ version: experimentKind !== "context-matrix-stage2" ?
      "prospective-matrix-stage/v2" : "prospective-matrix-stage/v1",
    ...(experimentKind !== "context-matrix-stage2" ? {
      experimentKind, planSchemaVersion: plan.schemaVersion, taskId: plan.taskId,
      contextDefinition: plan.contextDefinition, limits: plan.limits,
      timeoutPolicy: plan.timeoutPolicy, stopPolicy: plan.stopPolicy,
      priorStage: plan.priorStage, trajectoryTelemetry: "codex-coder-trajectory/v2",
      contextExpansion: "none"
    } : {}), planHash,
    ...(experimentKind === "inspection-instruction-validation" ? {
      condition: slot.condition,
      coderPrefixHash: plan.conditionDefinitions?.[slot.condition ?? "control"].coderPrefixHash
    } : {}),
    harnessRoot: realpathSync(input.harnessRoot), planPath: realpathSync(input.planPath),
    priorCompositionPath: realpathSync(input.priorCompositionPath),
    experimentId: plan.experimentId, taskHash: plan.taskHash, sourceHead: plan.sourceHead,
    stage: plan.stage, sessionId: input.sessionId, position: slot.position,
    replicate: slot.replicate, variant: slot.variant, providerStage: input.providerStage,
    priorCompositionHash: plan.priorStage.compositionHash, observationId,
    runtimeIdentity, sessionHash, slotHash,
    stageHash: sha(JSON.stringify([slotHash, input.providerStage])),
    model: plan.model, reasoning: plan.reasoning,
    retry: 0, repair: 0, apply: 0, replacement: false });
}
export function validateProspectiveMatrixAuthority(authority: ProspectiveMatrixAuthority,
  input: Readonly<{ harnessRoot: string; sourceRepositoryPath: string; planPath: string;
    priorCompositionPath: string; runId: string; stage: string;
    model: string; reasoning: string; task?: string; retryDecision?: unknown }>): void {
  gate(["prospective-matrix-stage/v1", "prospective-matrix-stage/v2"]
    .includes(authority?.version) &&
    authority.stage === "stage2" && authority.replacement === false &&
    input.retryDecision === undefined && authority.providerStage === input.stage &&
    authority.model === input.model && authority.reasoning === input.reasoning &&
    input.runId.startsWith(`matrix.${authority.runtimeIdentity}.${authority.providerStage}.`),
  "provider request binding");
  gate(authority.harnessRoot === realpathSync(input.harnessRoot) &&
    authority.planPath === realpathSync(input.planPath) &&
    authority.priorCompositionPath === realpathSync(input.priorCompositionPath), "authority paths");
  if (input.task !== undefined) {
    const definition = JSON.parse(readFileSync(path.join(input.harnessRoot,
      "research/context-token-matrix-v1/task-b-definition.json"), "utf8"));
    const offset = input.task.lastIndexOf("\n{");
    gate(offset >= 0, "provider task format");
    const prefix = input.task.slice(0, offset);
    const payloadText = input.task.slice(offset + 1);
    let payload: any;
    try { payload = JSON.parse(payloadText); } catch { gate(false, "provider task JSON"); }
    gate(JSON.stringify(payload) === payloadText, "provider task serialization");
    const objective = authority.providerStage === "planner" ? payload?.taskContext?.objective :
      payload?.baseContext?.taskContext?.taskContext?.taskContext?.objective;
    gate(objective === definition.sourceTask.providerPrompt, "provider task objective");
    if (authority.providerStage === "planner") {
      gate(sha(input.task) === PLANNER_HASH &&
        hashCanonicalJson(prefix.split("\n")) ===
          "sha256:007385e20704a79491500fcaaaf660153ce65f96b3146fa96bdc869a830e8991" &&
        same(payload.allowedChangeFiles, FILES), "planner payload binding");
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
      if (authority.experimentKind === "inspection-instruction-validation") {
        const condition = authority.condition;
        gate(condition === "control" || condition === "inspection-instruction",
          "inspection condition");
        const treatmentPrefix = coderPrefix.replace("Bounded coder context follows:",
          `${INSPECTION_INSTRUCTION}\nBounded coder context follows:`);
        const expectedPrefix = condition === "control" ? coderPrefix : treatmentPrefix;
        gate(prefix === expectedPrefix && sha(prefix) === authority.coderPrefixHash,
          "inspection coder prompt binding");
      } else gate(prefix === coderPrefix, "coder payload binding");
    }
  }
  const expected = createProspectiveMatrixAuthority({ harnessRoot: input.harnessRoot,
    sourceRepositoryPath: input.sourceRepositoryPath, planPath: input.planPath,
    priorCompositionPath: input.priorCompositionPath, sessionId: authority.sessionId,
    slot: { position: authority.position, replicate: authority.replicate,
      variant: authority.variant,
      ...(authority.experimentKind === "inspection-instruction-validation" ?
        { condition: authority.condition } : {}) }, providerStage: authority.providerStage });
  gate(same(authority, expected), "authority differs from plan");
}
