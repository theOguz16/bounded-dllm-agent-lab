import { hashCanonicalJson } from "./agent-event-ledger.js";

export const RELEASE_GAP_CLOSURE_AUDIT_VERSION = "1" as const;

export type V01ReleaseGapId =
  | "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7"
  | "G8" | "G9" | "G10" | "G11" | "G12" | "G13" | "G14";

export type ReleaseGapEvidenceStage =
  | "primitive"
  | "contract_tests"
  | "canonical_integration"
  | "live_or_real_evidence"
  | "release_artifact";

export type ReleaseGapEvidenceReference = {
  stage: ReleaseGapEvidenceStage;
  evidenceId: string;
  artifactKind:
    | "module"
    | "test"
    | "integration"
    | "report"
    | "document"
    | "command";
  locator: string;
  evidenceHash: string;
};

export type ReleaseGapExclusion = {
  scope: "post_v0_1" | "known_limitation";
  rationale: string;
  limitationArtifactHash: string;
  approvalHash: string;
};

export type ReleaseGapDisposition =
  | "closed"
  | "release_excluded"
  | "open";

export type ReleaseGapClosureRecord = {
  id: V01ReleaseGapId;
  title: string;
  v01Blocker: boolean;
  disposition: ReleaseGapDisposition;
  evidence: readonly ReleaseGapEvidenceReference[];
  exclusion?: ReleaseGapExclusion;
};

export type ReleaseArtifactId =
  | "readme_quickstart"
  | "architecture_diagram"
  | "threat_model"
  | "unified_benchmark_report"
  | "context_sufficiency_report"
  | "scope_drift_report"
  | "acceptance_coverage_report"
  | "observed_token_cost_report"
  | "fail_closed_matrix"
  | "gap_closure_matrix"
  | "known_limitations"
  | "v0_1_release_notes";

export type ReleaseArtifactRecord = {
  artifactId: ReleaseArtifactId;
  status: "present" | "missing";
  artifactHash?: string;
};

export type CanonicalCoordinatorDeclaration = {
  exportName: string;
  modulePath: string;
  publicApiVerified: boolean;
  evidenceHash: string;
};

export type V01ReleaseGapClosureAuditInput = {
  matrixVersion: "1";
  releaseVersion: "0.1.0";
  requiredReleaseCommand: "verify:release";
  observedReleaseCommand: "verify:release" | null;
  canonicalCoordinator: CanonicalCoordinatorDeclaration;
  gaps: readonly ReleaseGapClosureRecord[];
  requiredArtifacts: readonly ReleaseArtifactRecord[];
};

export type ReleaseGapAuditDecision =
  | "v01_release_gap_audit_ready"
  | "v01_release_gap_audit_blocked"
  | "v01_release_gap_audit_invalid";

export type ReleaseGapAuditGapResult = {
  id: V01ReleaseGapId;
  v01Blocker: boolean;
  disposition: ReleaseGapDisposition;
  evidenceStages: readonly ReleaseGapEvidenceStage[];
  evidenceComplete: boolean;
  releaseBlocking: boolean;
};

export type V01ReleaseGapClosureAudit = {
  auditVersion: "1";
  releaseVersion: "0.1.0";
  sourceInputHash: string;
  releaseCommandMatched: boolean;
  canonicalCoordinatorVerified: boolean;
  gapResults: readonly ReleaseGapAuditGapResult[];
  closedBlockerIds: readonly V01ReleaseGapId[];
  excludedBlockerIds: readonly V01ReleaseGapId[];
  openBlockerIds: readonly V01ReleaseGapId[];
  openNonBlockerIds: readonly V01ReleaseGapId[];
  missingArtifactIds: readonly ReleaseArtifactId[];
  releaseReady: boolean;
  auditHash: string;
};

export type BuildV01ReleaseGapClosureAuditResult = {
  decision: ReleaseGapAuditDecision;
  audit: V01ReleaseGapClosureAudit | null;
  errors: readonly string[];
  summary: {
    inputValid: boolean;
    exactGapSetPresent: boolean;
    blockerMetadataMatched: boolean;
    evidenceChainsValid: boolean;
    exclusionsValid: boolean;
    releaseCommandMatched: boolean;
    canonicalCoordinatorVerified: boolean;
    requiredArtifactSetPresent: boolean;
    requiredArtifactsComplete: boolean;
    openBlockerCount: number;
    releaseReady: boolean;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessed: false;
  };
};

export type VerifyV01ReleaseGapClosureAuditResult = {
  decision:
    | "v01_release_gap_audit_current"
    | "v01_release_gap_audit_invalid";
  auditIntegrityVerified: boolean;
  sourceInputMatched: boolean;
  releaseReady: boolean;
  errors: readonly string[];
  repositoryWritePerformed: false;
  shellExecuted: false;
  networkAccessed: false;
};

type PlainRecord = Record<string, unknown>;

const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/;
const SAFE_EXPORT = /^[A-Za-z_$][A-Za-z0-9_$]{0,159}$/;
const SAFE_PATH =
  /^(?!\/)(?!.*(?:\\|\u0000|\r|\n))(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,4096}$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;

const EVIDENCE_STAGES: readonly ReleaseGapEvidenceStage[] = [
  "primitive",
  "contract_tests",
  "canonical_integration",
  "live_or_real_evidence",
  "release_artifact"
];

const GAP_DEFINITIONS = [
  ["G1", "Coder receives real repository source context", true],
  ["G2", "Context budget is hard-enforced", true],
  ["G3", "Semantic context sufficiency and adaptive expansion", true],
  ["G4", "Repository intelligence claim boundary", false],
  ["G5", "Hard and soft scope drift are measured separately", true],
  ["G6", "Deterministic verifier claim boundary is explicit", true],
  ["G7", "Acceptance criteria map to criterion evidence", true],
  ["G8", "Observed token and cost ledger is unified", true],
  ["G9", "Provider failure is fail-closed on canonical paths", true],
  ["G10", "Evidence references are referentially verified", true],
  ["G11", "Tamper evidence is not authenticated", false],
  ["G12", "Registry is not distributed", false],
  ["G13", "Legacy and canonical runtime generations are separated", true],
  ["G14", "A single canonical public coordinator API exists", true]
] as const;

const ARTIFACT_IDS: readonly ReleaseArtifactId[] = [
  "readme_quickstart",
  "architecture_diagram",
  "threat_model",
  "unified_benchmark_report",
  "context_sufficiency_report",
  "scope_drift_report",
  "acceptance_coverage_report",
  "observed_token_cost_report",
  "fail_closed_matrix",
  "gap_closure_matrix",
  "known_limitations",
  "v0_1_release_notes"
];

const GAP_IDS = GAP_DEFINITIONS.map((entry) => entry[0]);
const GAP_MAP = new Map(
  GAP_DEFINITIONS.map(([id, title, blocker]) => [
    id,
    { title, blocker }
  ])
);
const INPUT_FIELDS = new Set([
  "matrixVersion",
  "releaseVersion",
  "requiredReleaseCommand",
  "observedReleaseCommand",
  "canonicalCoordinator",
  "gaps",
  "requiredArtifacts"
]);
const COORDINATOR_FIELDS = new Set([
  "exportName",
  "modulePath",
  "publicApiVerified",
  "evidenceHash"
]);
const GAP_FIELDS = new Set([
  "id",
  "title",
  "v01Blocker",
  "disposition",
  "evidence",
  "exclusion"
]);
const EVIDENCE_FIELDS = new Set([
  "stage",
  "evidenceId",
  "artifactKind",
  "locator",
  "evidenceHash"
]);
const EXCLUSION_FIELDS = new Set([
  "scope",
  "rationale",
  "limitationArtifactHash",
  "approvalHash"
]);
const ARTIFACT_FIELDS = new Set([
  "artifactId",
  "status",
  "artifactHash"
]);

class AuditFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function sortedUnique<T extends string>(
  values: readonly T[]
): T[] {
  return [...new Set(values)].sort(
    (left, right) => left.localeCompare(right)
  );
}

function exactRecord(
  value: unknown,
  fields: ReadonlySet<string>,
  label: string
): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new AuditFailure(
      "release_gap_audit_structure_invalid",
      `${label} must be a plain object.`
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !fields.has(key) ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new AuditFailure(
        "release_gap_audit_structure_invalid",
        `${label} contains an unknown or accessor field.`
      );
    }
  }
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) {
      throw new AuditFailure(
        "release_gap_audit_structure_invalid",
        `${label} contains an unknown field.`
      );
    }
  }
  return value as PlainRecord;
}

function assertAcyclic(
  value: unknown,
  active = new WeakSet<object>(),
  visited = new WeakSet<object>()
): void {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return;
  }
  if (active.has(value)) {
    throw new AuditFailure(
      "release_gap_audit_cycle_detected",
      "Release audit input must be acyclic."
    );
  }
  if (visited.has(value)) {
    return;
  }
  active.add(value);
  for (const child of Object.values(value)) {
    assertAcyclic(child, active, visited);
  }
  active.delete(value);
  visited.add(value);
}

function requireString(
  value: unknown,
  label: string,
  maximum = 4096
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    ASCII_CONTROL.test(value)
  ) {
    throw new AuditFailure(
      "release_gap_audit_value_invalid",
      `${label} is invalid.`
    );
  }
  return value;
}

function requireHash(
  value: unknown,
  label: string
): string {
  if (
    typeof value !== "string" ||
    !HASH.test(value)
  ) {
    throw new AuditFailure(
      "release_gap_audit_value_invalid",
      `${label} must be a SHA-256 evidence hash.`
    );
  }
  return value;
}

function validateCoordinator(
  value: unknown
): CanonicalCoordinatorDeclaration {
  const record = exactRecord(
    value,
    COORDINATOR_FIELDS,
    "canonicalCoordinator"
  );
  const exportName = requireString(
    record.exportName,
    "canonicalCoordinator.exportName",
    160
  );
  const modulePath = requireString(
    record.modulePath,
    "canonicalCoordinator.modulePath"
  );
  if (
    !SAFE_EXPORT.test(exportName) ||
    !SAFE_PATH.test(modulePath) ||
    typeof record.publicApiVerified !== "boolean"
  ) {
    throw new AuditFailure(
      "release_gap_audit_coordinator_invalid",
      "Canonical coordinator declaration is invalid."
    );
  }
  return {
    exportName,
    modulePath,
    publicApiVerified: record.publicApiVerified,
    evidenceHash: requireHash(
      record.evidenceHash,
      "canonicalCoordinator.evidenceHash"
    )
  };
}

function validateEvidence(
  value: unknown,
  gapId: V01ReleaseGapId
): ReleaseGapEvidenceReference {
  const record = exactRecord(
    value,
    EVIDENCE_FIELDS,
    `gap ${gapId} evidence`
  );
  if (
    !EVIDENCE_STAGES.includes(
      record.stage as ReleaseGapEvidenceStage
    ) ||
    typeof record.evidenceId !== "string" ||
    !SAFE_ID.test(record.evidenceId) ||
    ![
      "module",
      "test",
      "integration",
      "report",
      "document",
      "command"
    ].includes(record.artifactKind as string)
  ) {
    throw new AuditFailure(
      "release_gap_audit_evidence_invalid",
      `Gap ${gapId} evidence is invalid.`
    );
  }
  return {
    stage: record.stage as ReleaseGapEvidenceStage,
    evidenceId: record.evidenceId,
    artifactKind:
      record.artifactKind as ReleaseGapEvidenceReference["artifactKind"],
    locator: requireString(
      record.locator,
      `gap ${gapId} evidence locator`
    ),
    evidenceHash: requireHash(
      record.evidenceHash,
      `gap ${gapId} evidence hash`
    )
  };
}

function validateExclusion(
  value: unknown,
  gapId: V01ReleaseGapId
): ReleaseGapExclusion {
  const record = exactRecord(
    value,
    EXCLUSION_FIELDS,
    `gap ${gapId} exclusion`
  );
  if (
    record.scope !== "post_v0_1" &&
    record.scope !== "known_limitation"
  ) {
    throw new AuditFailure(
      "release_gap_audit_exclusion_invalid",
      `Gap ${gapId} exclusion scope is invalid.`
    );
  }
  return {
    scope: record.scope,
    rationale: requireString(
      record.rationale,
      `gap ${gapId} exclusion rationale`,
      2000
    ),
    limitationArtifactHash: requireHash(
      record.limitationArtifactHash,
      `gap ${gapId} limitation artifact hash`
    ),
    approvalHash: requireHash(
      record.approvalHash,
      `gap ${gapId} exclusion approval hash`
    )
  };
}

function validateGap(
  value: unknown
): ReleaseGapClosureRecord {
  const record = exactRecord(
    value,
    GAP_FIELDS,
    "gap record"
  );
  if (
    typeof record.id !== "string" ||
    !GAP_MAP.has(record.id as V01ReleaseGapId)
  ) {
    throw new AuditFailure(
      "release_gap_audit_gap_unknown",
      "Release gap ID is unknown."
    );
  }
  const id = record.id as V01ReleaseGapId;
  const definition = GAP_MAP.get(id)!;
  if (
    record.title !== definition.title ||
    record.v01Blocker !== definition.blocker ||
    ![
      "closed",
      "release_excluded",
      "open"
    ].includes(record.disposition as string) ||
    !Array.isArray(record.evidence)
  ) {
    throw new AuditFailure(
      "release_gap_audit_gap_metadata_mismatch",
      `Gap ${id} metadata does not match the v0.1 registry.`
    );
  }
  const evidence = record.evidence.map(
    (entry) => validateEvidence(entry, id)
  );
  const evidenceIds = evidence.map(
    (entry) => entry.evidenceId
  );
  const stages = evidence.map(
    (entry) => entry.stage
  );
  if (
    new Set(evidenceIds).size !== evidenceIds.length ||
    new Set(stages).size !== stages.length
  ) {
    throw new AuditFailure(
      "release_gap_audit_evidence_duplicate",
      `Gap ${id} contains duplicate evidence.`
    );
  }

  const disposition =
    record.disposition as ReleaseGapDisposition;
  let exclusion: ReleaseGapExclusion | undefined;
  if (disposition === "release_excluded") {
    if (!Object.hasOwn(record, "exclusion")) {
      throw new AuditFailure(
        "release_gap_audit_exclusion_missing",
        `Gap ${id} requires exclusion evidence.`
      );
    }
    exclusion = validateExclusion(record.exclusion, id);
  } else if (
    Object.hasOwn(record, "exclusion") &&
    record.exclusion !== undefined
  ) {
    throw new AuditFailure(
      "release_gap_audit_exclusion_unexpected",
      `Gap ${id} must not include exclusion evidence.`
    );
  }

  if (
    disposition === "closed" &&
    (
      evidence.length !== EVIDENCE_STAGES.length ||
      EVIDENCE_STAGES.some(
        (stage) => !stages.includes(stage)
      )
    )
  ) {
    throw new AuditFailure(
      "release_gap_audit_evidence_chain_incomplete",
      `Closed gap ${id} requires the complete five-stage evidence chain.`
    );
  }

  return {
    id,
    title: definition.title,
    v01Blocker: definition.blocker,
    disposition,
    evidence: evidence
      .slice()
      .sort(
        (left, right) =>
          EVIDENCE_STAGES.indexOf(left.stage) -
          EVIDENCE_STAGES.indexOf(right.stage)
      ),
    ...(exclusion === undefined ? {} : { exclusion })
  };
}

function validateArtifact(
  value: unknown
): ReleaseArtifactRecord {
  const record = exactRecord(
    value,
    ARTIFACT_FIELDS,
    "release artifact"
  );
  if (
    typeof record.artifactId !== "string" ||
    !ARTIFACT_IDS.includes(
      record.artifactId as ReleaseArtifactId
    ) ||
    (
      record.status !== "present" &&
      record.status !== "missing"
    )
  ) {
    throw new AuditFailure(
      "release_gap_audit_artifact_invalid",
      "Release artifact record is invalid."
    );
  }
  if (record.status === "present") {
    return {
      artifactId:
        record.artifactId as ReleaseArtifactId,
      status: "present",
      artifactHash: requireHash(
        record.artifactHash,
        `release artifact ${record.artifactId}`
      )
    };
  }
  if (
    Object.hasOwn(record, "artifactHash") &&
    record.artifactHash !== undefined
  ) {
    throw new AuditFailure(
      "release_gap_audit_artifact_invalid",
      "Missing release artifacts cannot carry a hash."
    );
  }
  return {
    artifactId:
      record.artifactId as ReleaseArtifactId,
    status: "missing"
  };
}

function validateInput(
  value: unknown
): V01ReleaseGapClosureAuditInput {
  assertAcyclic(value);
  const record = exactRecord(
    value,
    INPUT_FIELDS,
    "release gap audit input"
  );
  if (
    record.matrixVersion !== "1" ||
    record.releaseVersion !== "0.1.0" ||
    record.requiredReleaseCommand !== "verify:release" ||
    (
      record.observedReleaseCommand !== null &&
      record.observedReleaseCommand !== "verify:release"
    ) ||
    !Array.isArray(record.gaps) ||
    !Array.isArray(record.requiredArtifacts)
  ) {
    throw new AuditFailure(
      "release_gap_audit_input_invalid",
      "Release gap audit input metadata is invalid."
    );
  }
  const gaps = record.gaps.map(validateGap);
  const gapIds = gaps.map((gap) => gap.id);
  if (
    gaps.length !== GAP_IDS.length ||
    new Set(gapIds).size !== GAP_IDS.length ||
    GAP_IDS.some((id) => !gapIds.includes(id))
  ) {
    throw new AuditFailure(
      "release_gap_audit_gap_set_invalid",
      "Release audit must contain the exact G1-G14 gap set."
    );
  }

  const requiredArtifacts =
    record.requiredArtifacts.map(validateArtifact);
  const artifactIds = requiredArtifacts.map(
    (artifact) => artifact.artifactId
  );
  if (
    requiredArtifacts.length !== ARTIFACT_IDS.length ||
    new Set(artifactIds).size !== ARTIFACT_IDS.length ||
    ARTIFACT_IDS.some(
      (id) => !artifactIds.includes(id)
    )
  ) {
    throw new AuditFailure(
      "release_gap_audit_artifact_set_invalid",
      "Release audit must contain the exact required artifact set."
    );
  }

  return {
    matrixVersion: "1",
    releaseVersion: "0.1.0",
    requiredReleaseCommand: "verify:release",
    observedReleaseCommand:
      record.observedReleaseCommand as "verify:release" | null,
    canonicalCoordinator:
      validateCoordinator(record.canonicalCoordinator),
    gaps: gaps
      .slice()
      .sort(
        (left, right) =>
          Number(left.id.slice(1)) -
          Number(right.id.slice(1))
      ),
    requiredArtifacts:
      requiredArtifacts
        .slice()
        .sort(
          (left, right) =>
            ARTIFACT_IDS.indexOf(left.artifactId) -
            ARTIFACT_IDS.indexOf(right.artifactId)
        )
  };
}

function initialSummary():
BuildV01ReleaseGapClosureAuditResult["summary"] {
  return {
    inputValid: false,
    exactGapSetPresent: false,
    blockerMetadataMatched: false,
    evidenceChainsValid: false,
    exclusionsValid: false,
    releaseCommandMatched: false,
    canonicalCoordinatorVerified: false,
    requiredArtifactSetPresent: false,
    requiredArtifactsComplete: false,
    openBlockerCount: 0,
    releaseReady: false,
    repositoryWritePerformed: false,
    shellExecuted: false,
    networkAccessed: false
  };
}

function auditCore(
  audit: V01ReleaseGapClosureAudit
): Omit<V01ReleaseGapClosureAudit, "auditHash"> {
  const { auditHash: _, ...core } = audit;
  return core;
}

export function buildV01ReleaseGapClosureAudit(
  rawInput: V01ReleaseGapClosureAuditInput
): BuildV01ReleaseGapClosureAuditResult {
  const summary = initialSummary();
  try {
    const input = validateInput(rawInput);
    summary.inputValid = true;
    summary.exactGapSetPresent = true;
    summary.blockerMetadataMatched = true;
    summary.evidenceChainsValid = true;
    summary.exclusionsValid = true;
    summary.requiredArtifactSetPresent = true;

    const releaseCommandMatched =
      input.observedReleaseCommand ===
      input.requiredReleaseCommand;
    summary.releaseCommandMatched =
      releaseCommandMatched;

    const canonicalCoordinatorVerified =
      input.canonicalCoordinator.publicApiVerified;
    summary.canonicalCoordinatorVerified =
      canonicalCoordinatorVerified;

    const gapResults: ReleaseGapAuditGapResult[] =
      input.gaps.map((gap) => {
        const evidenceStages = gap.evidence.map(
          (entry) => entry.stage
        );
        const evidenceComplete =
          EVIDENCE_STAGES.every(
            (stage) => evidenceStages.includes(stage)
          );
        return {
          id: gap.id,
          v01Blocker: gap.v01Blocker,
          disposition: gap.disposition,
          evidenceStages,
          evidenceComplete,
          releaseBlocking:
            gap.v01Blocker &&
            gap.disposition === "open"
        };
      });

    const closedBlockerIds = gapResults
      .filter(
        (gap) =>
          gap.v01Blocker &&
          gap.disposition === "closed"
      )
      .map((gap) => gap.id);
    const excludedBlockerIds = gapResults
      .filter(
        (gap) =>
          gap.v01Blocker &&
          gap.disposition === "release_excluded"
      )
      .map((gap) => gap.id);
    const openBlockerIds = gapResults
      .filter((gap) => gap.releaseBlocking)
      .map((gap) => gap.id);
    const openNonBlockerIds = gapResults
      .filter(
        (gap) =>
          !gap.v01Blocker &&
          gap.disposition === "open"
      )
      .map((gap) => gap.id);
    const missingArtifactIds =
      input.requiredArtifacts
        .filter(
          (artifact) => artifact.status === "missing"
        )
        .map((artifact) => artifact.artifactId);

    const requiredArtifactsComplete =
      missingArtifactIds.length === 0;
    summary.requiredArtifactsComplete =
      requiredArtifactsComplete;
    summary.openBlockerCount =
      openBlockerIds.length;

    const releaseReady =
      releaseCommandMatched &&
      canonicalCoordinatorVerified &&
      openBlockerIds.length === 0 &&
      requiredArtifactsComplete;
    summary.releaseReady = releaseReady;

    const material = {
      auditVersion: "1" as const,
      releaseVersion: "0.1.0" as const,
      sourceInputHash: hashCanonicalJson(input),
      releaseCommandMatched,
      canonicalCoordinatorVerified,
      gapResults,
      closedBlockerIds,
      excludedBlockerIds,
      openBlockerIds,
      openNonBlockerIds,
      missingArtifactIds,
      releaseReady
    };
    const audit: V01ReleaseGapClosureAudit = {
      ...material,
      auditHash: hashCanonicalJson(material)
    };

    return deepFreeze({
      decision: releaseReady
        ? "v01_release_gap_audit_ready"
        : "v01_release_gap_audit_blocked",
      audit,
      errors: [],
      summary
    });
  } catch (error) {
    const failure =
      error instanceof AuditFailure
        ? error
        : new AuditFailure(
            "release_gap_audit_exception",
            "Release gap audit failed closed."
          );
    return deepFreeze({
      decision: "v01_release_gap_audit_invalid",
      audit: null,
      errors: [failure.code],
      summary
    });
  }
}

export function verifyV01ReleaseGapClosureAudit(
  input: V01ReleaseGapClosureAuditInput,
  audit: V01ReleaseGapClosureAudit
): VerifyV01ReleaseGapClosureAuditResult {
  try {
    const rebuilt =
      buildV01ReleaseGapClosureAudit(input);
    if (
      rebuilt.audit === null ||
      !HASH.test(audit.auditHash) ||
      audit.auditHash !==
        hashCanonicalJson(auditCore(audit)) ||
      audit.sourceInputHash !==
        rebuilt.audit.sourceInputHash ||
      audit.auditHash !== rebuilt.audit.auditHash
    ) {
      return deepFreeze({
        decision:
          "v01_release_gap_audit_invalid",
        auditIntegrityVerified: false,
        sourceInputMatched: false,
        releaseReady: false,
        errors: [
          "release_gap_audit_verification_mismatch"
        ],
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      });
    }
    return deepFreeze({
      decision: "v01_release_gap_audit_current",
      auditIntegrityVerified: true,
      sourceInputMatched: true,
      releaseReady: audit.releaseReady,
      errors: [],
      repositoryWritePerformed: false,
      shellExecuted: false,
      networkAccessed: false
    });
  } catch {
    return deepFreeze({
      decision: "v01_release_gap_audit_invalid",
      auditIntegrityVerified: false,
      sourceInputMatched: false,
      releaseReady: false,
      errors: [
        "release_gap_audit_verification_exception"
      ],
      repositoryWritePerformed: false,
      shellExecuted: false,
      networkAccessed: false
    });
  }
}
