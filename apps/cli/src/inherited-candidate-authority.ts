import {
  hashCanonicalJson,
  parseTextFileUpdates,
  VALIDATION_PROFILES,
  type AcceptanceCriteriaContract,
  type DurableBoundedTaskState,
  type RunBoundedTaskResult,
  type TemporaryWorkspaceExecutionSpecification,
  type ValidationProfileId,
  type WorkspaceMutation
} from "../../../packages/product-runtime/src/canonical-runtime.js";
import type { BoundedCandidateHandoff } from "./candidate-handoff.js";
import { CliError } from "./cli-errors.js";

/** Every inherited security-bearing handoff field. Derived fields are listed separately. */
export const INHERITED_HANDOFF_FIELDS = Object.freeze([
  "taskId", "objectiveHash", "sourceSnapshotHash", "planHash", "contextBindingHash",
  "plannerExecutionBindingHash", "compiledPolicyHash", "allowedFiles", "forbiddenFiles",
  "acceptanceCriteriaContract", "validationProfile", "phaseVExecutionSpecification",
  "adaptiveResult", "declaredRiskClass", "candidateFiles"
] as const);
export const DERIVED_HANDOFF_FIELDS = Object.freeze(["coderMutation", "verifierFinding"] as const);

export type InheritedCandidateAuthority = Readonly<{
  taskId: string;
  objectiveHash: string;
  sourceSnapshotHash: string;
  repositoryIdentityHash: string;
  baselineSnapshotHash: string;
  planHash: string;
  contextBindingHash: string;
  plannerExecutionBindingHash: string;
  compiledPolicyHash: string;
  allowedFilesHash: string;
  forbiddenFilesHash: string;
  acceptanceCriteriaContractHash: string;
  validationProfileHash: string;
  phaseVExecutionSpecificationHash: string;
  adaptiveResultInheritedHash: string;
  declaredRiskClass: "low" | "medium" | "high" | "critical";
  candidateFilesHash: string;
}>;

function filesHash(files: readonly string[]): string {
  // Candidate file authority is the sorted path set; replacement content belongs to Candidate B lineage.
  return hashCanonicalJson([...files].sort());
}

function adaptiveResultInheritedHash(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("cli_repair_inherited_authority_invalid", "Inherited adaptive result is missing.", 4);
  }
  const adaptive = value as Record<string, unknown>;
  const coder = adaptive.coderResult;
  if (!coder || typeof coder !== "object" || Array.isArray(coder)) {
    throw new CliError("cli_repair_inherited_authority_invalid", "Inherited coder result is missing.", 4);
  }
  // The entire providerOutput is excluded here. Apply separately checks its complete mutation
  // against Candidate B reconstructed from terminal Candidate A and the bound repair artifact.
  const { providerOutput: _mutation, ...inheritedCoder } = coder as Record<string, unknown>;
  return hashCanonicalJson({ ...adaptive, coderResult: inheritedCoder });
}

function profileHash(profile: ValidationProfileId): string {
  return hashCanonicalJson({ id: profile, definition: VALIDATION_PROFILES[profile] });
}

export function deriveInheritedCandidateAuthority(input: Readonly<{
  state: DurableBoundedTaskState;
  result: RunBoundedTaskResult;
  original: WorkspaceMutation;
  sourceSnapshotHash: string;
  forbiddenFiles: readonly string[];
  acceptanceCriteriaContract: AcceptanceCriteriaContract;
  validationProfile: ValidationProfileId;
  phaseVExecutionSpecification: TemporaryWorkspaceExecutionSpecification;
}>): InheritedCandidateAuthority {
  const planner = input.result.plannerResult;
  const plan = planner?.minimalityResult?.plan;
  const coder = planner?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult;
  const adaptive = planner?.taskSeedResult?.repoResult?.adaptiveResult;
  const risk = plan?.riskClass;
  if (!planner?.implementationContract?.objectiveHash || !plan?.planHash || !coder?.context ||
      !planner.executionBinding?.bindingHash || !adaptive ||
      !["low", "medium", "high", "critical"].includes(String(risk))) {
    throw new CliError("cli_repair_inherited_authority_invalid", "Canonical Candidate A authority is incomplete.", 4);
  }
  const originalFiles = parseTextFileUpdates(input.original).map((claim) => claim.file);
  return {
    taskId: input.state.taskId,
    objectiveHash: planner.implementationContract.objectiveHash,
    sourceSnapshotHash: input.sourceSnapshotHash,
    repositoryIdentityHash: input.state.repositoryIdentityHash,
    baselineSnapshotHash: input.state.baselineSnapshotHash,
    planHash: plan.planHash,
    contextBindingHash: hashCanonicalJson(coder.context),
    plannerExecutionBindingHash: planner.executionBinding.bindingHash,
    compiledPolicyHash: input.state.compiledPolicyHash,
    allowedFilesHash: filesHash(originalFiles),
    forbiddenFilesHash: filesHash(input.forbiddenFiles),
    acceptanceCriteriaContractHash: hashCanonicalJson(input.acceptanceCriteriaContract),
    validationProfileHash: profileHash(input.validationProfile),
    phaseVExecutionSpecificationHash: hashCanonicalJson(input.phaseVExecutionSpecification),
    adaptiveResultInheritedHash: adaptiveResultInheritedHash(adaptive),
    declaredRiskClass: risk as InheritedCandidateAuthority["declaredRiskClass"],
    candidateFilesHash: filesHash(originalFiles)
  };
}

export function projectInheritedHandoffAuthority(
  candidate: BoundedCandidateHandoff
): InheritedCandidateAuthority {
  const provenance = candidate.provenance;
  if (!provenance || provenance.kind !== "derived_repair") {
    throw new CliError("cli_repair_inherited_authority_invalid", "Derived provenance is missing.", 4);
  }
  return {
    taskId: candidate.taskId,
    objectiveHash: candidate.objectiveHash,
    sourceSnapshotHash: candidate.sourceSnapshotHash,
    repositoryIdentityHash: provenance.repositoryIdentityHash,
    baselineSnapshotHash: provenance.baselineSnapshotHash,
    planHash: candidate.planHash,
    contextBindingHash: candidate.contextBindingHash,
    plannerExecutionBindingHash: candidate.plannerExecutionBindingHash,
    compiledPolicyHash: candidate.compiledPolicyHash,
    allowedFilesHash: filesHash(candidate.allowedFiles),
    forbiddenFilesHash: filesHash(candidate.forbiddenFiles),
    acceptanceCriteriaContractHash: hashCanonicalJson(candidate.acceptanceCriteriaContract),
    validationProfileHash: profileHash(candidate.validationProfile),
    phaseVExecutionSpecificationHash: hashCanonicalJson(candidate.phaseVExecutionSpecification),
    adaptiveResultInheritedHash: adaptiveResultInheritedHash(candidate.adaptiveResult),
    declaredRiskClass: candidate.declaredRiskClass,
    candidateFilesHash: filesHash(candidate.candidateFiles)
  };
}

export function inheritedCandidateAuthorityHash(authority: InheritedCandidateAuthority): string {
  return hashCanonicalJson(authority);
}
