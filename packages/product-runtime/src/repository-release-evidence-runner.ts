import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  buildV01ReleaseGapClosureAudit,
  type ReleaseArtifactId,
  type ReleaseGapEvidenceReference,
  type V01ReleaseGapClosureAudit,
  type V01ReleaseGapClosureAuditInput
} from "./release-gap-closure-audit.js";

export const REPOSITORY_RELEASE_EVIDENCE_RUNNER_VERSION = "1" as const;

export const V01_RELEASE_ARTIFACT_PATHS:
Readonly<Record<ReleaseArtifactId, string>> = Object.freeze({
  readme_quickstart: "docs/release/README_QUICKSTART.md",
  architecture_diagram: "docs/release/ARCHITECTURE.md",
  threat_model: "docs/release/THREAT_MODEL.md",
  unified_benchmark_report: "reports/release/UNIFIED_BENCHMARK.json",
  context_sufficiency_report: "reports/release/CONTEXT_SUFFICIENCY.json",
  scope_drift_report: "reports/release/SCOPE_DRIFT.json",
  acceptance_coverage_report: "reports/release/ACCEPTANCE_COVERAGE.json",
  observed_token_cost_report: "reports/release/OBSERVED_TOKEN_COST.json",
  fail_closed_matrix: "docs/release/FAIL_CLOSED_MATRIX.md",
  gap_closure_matrix: "docs/release/GAP_CLOSURE_AUDIT.md",
  known_limitations: "docs/release/KNOWN_LIMITATIONS.md",
  v0_1_release_notes: "docs/release/V0_1_RELEASE_NOTES.md"
});

export const REPOSITORY_VERIFY_RELEASE_COMMAND =
  "npm run typecheck && npm run build && node scripts/repository-release-evidence-runner.cjs --verify";

export type RepositoryEvidenceObservation = {
  evidenceId: string;
  locator: string;
  artifactKind: ReleaseGapEvidenceReference["artifactKind"];
  observedHash: string;
  matched: boolean;
};

export type RepositoryReleaseArtifactObservation = {
  artifactId: ReleaseArtifactId;
  path: string;
  observedStatus: "present" | "missing";
  observedHash: string | null;
  declarationMatched: boolean;
};

export type RepositoryReleaseEvidenceDecision =
  | "repository_release_evidence_ready"
  | "repository_release_evidence_blocked"
  | "repository_release_evidence_invalid";

export type RepositoryReleaseEvidenceReport = {
  reportVersion: "1";
  releaseVersion: "0.1.0";
  sourceMatrixHash: string;
  releaseCommandVerified: boolean;
  canonicalCoordinatorVerified: boolean;
  evidenceObservations: readonly RepositoryEvidenceObservation[];
  artifactObservations: readonly RepositoryReleaseArtifactObservation[];
  gapAudit: V01ReleaseGapClosureAudit;
  releaseReady: boolean;
  reportHash: string;
};

export type RunRepositoryReleaseEvidenceInput = {
  repositoryPath: string;
  matrix: V01ReleaseGapClosureAuditInput;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

export type RunRepositoryReleaseEvidenceResult = {
  decision: RepositoryReleaseEvidenceDecision;
  report: RepositoryReleaseEvidenceReport | null;
  errors: readonly string[];
  summary: {
    inputValid: boolean;
    repositoryPathValid: boolean;
    packageJsonValid: boolean;
    releaseCommandVerified: boolean;
    canonicalCoordinatorVerified: boolean;
    evidenceLocatorCount: number;
    evidenceMatchedCount: number;
    releaseArtifactCount: number;
    releaseArtifactDeclarationsMatched: boolean;
    gapAuditBuilt: boolean;
    openBlockerCount: number;
    missingArtifactCount: number;
    releaseReady: boolean;
    bytesRead: number;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessed: false;
  };
};

type PlainRecord = Record<string, unknown>;
type ReadBudget = {
  maxFileBytes: number;
  maxTotalBytes: number;
  bytesRead: number;
};

const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_PATH =
  /^(?!\/)(?!.*(?:\\|\u0000|\r|\n))(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,4096}$/;
const SAFE_SCRIPT = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

class RunnerFailure extends Error {
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

function sha256Bytes(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256Parts(parts: readonly (Uint8Array | string)[]): string {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return `sha256:${digest.digest("hex")}`;
}

function numericLimit(
  value: unknown,
  fallback: number,
  maximum: number,
  field: string
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > maximum
  ) {
    throw new TypeError(`Invalid repository release evidence limit: ${field}.`);
  }
  return value as number;
}

function initialSummary(): RunRepositoryReleaseEvidenceResult["summary"] {
  return {
    inputValid: false,
    repositoryPathValid: false,
    packageJsonValid: false,
    releaseCommandVerified: false,
    canonicalCoordinatorVerified: false,
    evidenceLocatorCount: 0,
    evidenceMatchedCount: 0,
    releaseArtifactCount: 0,
    releaseArtifactDeclarationsMatched: false,
    gapAuditBuilt: false,
    openBlockerCount: 0,
    missingArtifactCount: 0,
    releaseReady: false,
    bytesRead: 0,
    repositoryWritePerformed: false,
    shellExecuted: false,
    networkAccessed: false
  };
}

function finish(
  decision: RepositoryReleaseEvidenceDecision,
  report: RepositoryReleaseEvidenceReport | null,
  errors: readonly string[],
  summary: RunRepositoryReleaseEvidenceResult["summary"]
): RunRepositoryReleaseEvidenceResult {
  return deepFreeze({
    decision,
    report,
    errors: [...new Set(errors)].sort(),
    summary
  });
}

function validateInput(input: RunRepositoryReleaseEvidenceInput): {
  repositoryPath: string;
  matrix: V01ReleaseGapClosureAuditInput;
  budget: ReadBudget;
} {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    typeof input.repositoryPath !== "string" ||
    input.repositoryPath.length === 0 ||
    input.matrix === null ||
    typeof input.matrix !== "object" ||
    Array.isArray(input.matrix)
  ) {
    throw new RunnerFailure(
      "repository_release_evidence_input_invalid",
      "Repository release evidence input is invalid."
    );
  }
  return {
    repositoryPath: input.repositoryPath,
    matrix: input.matrix,
    budget: {
      maxFileBytes: numericLimit(
        input.maxFileBytes,
        DEFAULT_MAX_FILE_BYTES,
        MAX_MAX_FILE_BYTES,
        "maxFileBytes"
      ),
      maxTotalBytes: numericLimit(
        input.maxTotalBytes,
        DEFAULT_MAX_TOTAL_BYTES,
        MAX_MAX_TOTAL_BYTES,
        "maxTotalBytes"
      ),
      bytesRead: 0
    }
  };
}

async function noSymlinkSegments(configured: string): Promise<void> {
  const absolute = path.resolve(configured);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (
    const segment of absolute
      .slice(parsed.root.length)
      .split(path.sep)
      .filter(Boolean)
  ) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new RunnerFailure(
        "repository_release_evidence_symlink_detected",
        "A release evidence path contains a symbolic link."
      );
    }
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

async function resolveRepositoryRoot(configured: string): Promise<string> {
  await noSymlinkSegments(configured);
  const root = await realpath(configured);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RunnerFailure(
      "repository_release_evidence_repository_invalid",
      "Repository release evidence root is invalid."
    );
  }
  return root;
}

async function readBoundedFile(
  root: string,
  relativePath: string,
  budget: ReadBudget
): Promise<Buffer> {
  if (!SAFE_PATH.test(relativePath)) {
    throw new RunnerFailure(
      "repository_release_evidence_locator_invalid",
      "A release evidence locator is invalid."
    );
  }

  const absolute = path.resolve(root, ...relativePath.split("/"));
  if (!inside(root, absolute)) {
    throw new RunnerFailure(
      "repository_release_evidence_locator_invalid",
      "A release evidence locator escapes the repository."
    );
  }

  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RunnerFailure(
          "repository_release_evidence_file_missing",
          "A declared release evidence file is missing."
        );
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new RunnerFailure(
        "repository_release_evidence_symlink_detected",
        "A release evidence locator traverses a symbolic link."
      );
    }
  }

  let handle;
  try {
    handle = await open(
      absolute,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new RunnerFailure(
        "repository_release_evidence_file_invalid",
        "Release evidence must be a regular file."
      );
    }
    if (
      metadata.size > budget.maxFileBytes ||
      budget.bytesRead + metadata.size > budget.maxTotalBytes
    ) {
      throw new RunnerFailure(
        "repository_release_evidence_byte_limit",
        "Release evidence exceeds configured byte limits."
      );
    }
    const bytes = await handle.readFile();
    if (
      bytes.length > budget.maxFileBytes ||
      budget.bytesRead + bytes.length > budget.maxTotalBytes
    ) {
      throw new RunnerFailure(
        "repository_release_evidence_byte_limit",
        "Release evidence exceeds configured byte limits."
      );
    }
    budget.bytesRead += bytes.length;
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parsePackageJson(bytes: Buffer): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RunnerFailure(
      "repository_release_evidence_package_invalid",
      "package.json is invalid JSON."
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RunnerFailure(
      "repository_release_evidence_package_invalid",
      "package.json is invalid."
    );
  }
  const scriptsRaw = (value as PlainRecord).scripts;
  if (
    scriptsRaw === null ||
    typeof scriptsRaw !== "object" ||
    Array.isArray(scriptsRaw)
  ) {
    throw new RunnerFailure(
      "repository_release_evidence_package_invalid",
      "package.json scripts are invalid."
    );
  }

  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(scriptsRaw as PlainRecord)) {
    if (
      !SAFE_SCRIPT.test(name) ||
      typeof command !== "string" ||
      command.length === 0 ||
      command.length > 10_000 ||
      /[\u0000\r\n]/.test(command)
    ) {
      throw new RunnerFailure(
        "repository_release_evidence_package_invalid",
        "package.json contains an invalid script."
      );
    }
    scripts[name] = command;
  }
  return scripts;
}

function commandEvidenceHash(scriptName: string, command: string): string {
  return sha256Parts(["npm-script\0", scriptName, "\0", command]);
}

function coordinatorEvidenceHash(
  exportName: string,
  modulePath: string,
  moduleBytes: Buffer,
  indexBytes: Buffer
): string {
  return sha256Parts([
    "canonical-coordinator\0",
    exportName,
    "\0",
    modulePath,
    "\0",
    sha256Bytes(moduleBytes),
    "\0",
    sha256Bytes(indexBytes)
  ]);
}

async function observeEvidence(
  root: string,
  evidence: ReleaseGapEvidenceReference,
  scripts: Record<string, string>,
  budget: ReadBudget
): Promise<RepositoryEvidenceObservation> {
  let observedHash: string;

  if (evidence.artifactKind === "command") {
    if (!evidence.locator.startsWith("npm-script:")) {
      throw new RunnerFailure(
        "repository_release_evidence_command_locator_invalid",
        "Command evidence must use an npm-script locator."
      );
    }
    const scriptName = evidence.locator.slice("npm-script:".length);
    if (!SAFE_SCRIPT.test(scriptName)) {
      throw new RunnerFailure(
        "repository_release_evidence_command_locator_invalid",
        "Command evidence script name is invalid."
      );
    }
    const command = scripts[scriptName];
    if (command === undefined) {
      throw new RunnerFailure(
        "repository_release_evidence_command_missing",
        "A declared release evidence command is missing."
      );
    }
    observedHash = commandEvidenceHash(scriptName, command);
  } else {
    observedHash = sha256Bytes(
      await readBoundedFile(root, evidence.locator, budget)
    );
  }

  return {
    evidenceId: evidence.evidenceId,
    locator: evidence.locator,
    artifactKind: evidence.artifactKind,
    observedHash,
    matched: observedHash === evidence.evidenceHash
  };
}

async function observeArtifact(
  root: string,
  declaration: V01ReleaseGapClosureAuditInput["requiredArtifacts"][number],
  budget: ReadBudget
): Promise<RepositoryReleaseArtifactObservation> {
  const artifactPath = V01_RELEASE_ARTIFACT_PATHS[declaration.artifactId];
  try {
    const bytes = await readBoundedFile(root, artifactPath, budget);
    const observedHash = sha256Bytes(bytes);
    return {
      artifactId: declaration.artifactId,
      path: artifactPath,
      observedStatus: "present",
      observedHash,
      declarationMatched:
        declaration.status === "present" &&
        declaration.artifactHash === observedHash
    };
  } catch (error) {
    if (
      error instanceof RunnerFailure &&
      error.code === "repository_release_evidence_file_missing"
    ) {
      return {
        artifactId: declaration.artifactId,
        path: artifactPath,
        observedStatus: "missing",
        observedHash: null,
        declarationMatched: declaration.status === "missing"
      };
    }
    throw error;
  }
}

function reportCore(
  report: RepositoryReleaseEvidenceReport
): Omit<RepositoryReleaseEvidenceReport, "reportHash"> {
  const { reportHash: _, ...core } = report;
  return core;
}

export async function runRepositoryReleaseEvidence(
  rawInput: RunRepositoryReleaseEvidenceInput
): Promise<RunRepositoryReleaseEvidenceResult> {
  const summary = initialSummary();

  try {
    const validated = validateInput(rawInput);
    summary.inputValid = true;

    const root = await resolveRepositoryRoot(validated.repositoryPath);
    summary.repositoryPathValid = true;

    const packageBytes = await readBoundedFile(
      root,
      "package.json",
      validated.budget
    );
    const scripts = parsePackageJson(packageBytes);
    summary.packageJsonValid = true;

    const releaseCommandVerified =
      scripts["verify:release"] === REPOSITORY_VERIFY_RELEASE_COMMAND &&
      validated.matrix.observedReleaseCommand === "verify:release";
    summary.releaseCommandVerified = releaseCommandVerified;
    if (!releaseCommandVerified) {
      throw new RunnerFailure(
        "repository_release_evidence_release_command_mismatch",
        "The repository-bound verify:release command does not match."
      );
    }

    const coordinator = validated.matrix.canonicalCoordinator;
    const moduleBytes = await readBoundedFile(
      root,
      coordinator.modulePath,
      validated.budget
    );
    const indexBytes = await readBoundedFile(
      root,
      "packages/product-runtime/src/index.ts",
      validated.budget
    );
    const moduleText = moduleBytes.toString("utf8");
    const indexText = indexBytes.toString("utf8");
    const exportPattern = new RegExp(
      `export\\s+async\\s+function\\s+${coordinator.exportName}\\s*\\(`
    );
    const moduleExport = coordinator.modulePath
      .replace(/^packages\/product-runtime\/src\//, "")
      .replace(/\.ts$/, ".js");
    const indexExportLine = `export * from "./${moduleExport}";`;
    const observedCoordinatorHash = coordinatorEvidenceHash(
      coordinator.exportName,
      coordinator.modulePath,
      moduleBytes,
      indexBytes
    );
    const canonicalCoordinatorVerified =
      coordinator.publicApiVerified === true &&
      exportPattern.test(moduleText) &&
      indexText.includes(indexExportLine) &&
      coordinator.evidenceHash === observedCoordinatorHash;

    summary.canonicalCoordinatorVerified = canonicalCoordinatorVerified;
    if (!canonicalCoordinatorVerified) {
      throw new RunnerFailure(
        "repository_release_evidence_coordinator_mismatch",
        "Canonical coordinator declaration does not match repository bytes."
      );
    }

    const evidenceObservations: RepositoryEvidenceObservation[] = [];
    for (const gap of validated.matrix.gaps) {
      for (const evidence of gap.evidence) {
        evidenceObservations.push(
          await observeEvidence(root, evidence, scripts, validated.budget)
        );
      }
    }
    evidenceObservations.sort((left, right) =>
      left.evidenceId.localeCompare(right.evidenceId)
    );
    summary.evidenceLocatorCount = evidenceObservations.length;
    summary.evidenceMatchedCount = evidenceObservations.filter(
      (entry) => entry.matched
    ).length;
    if (evidenceObservations.some((entry) => !entry.matched)) {
      throw new RunnerFailure(
        "repository_release_evidence_hash_mismatch",
        "One or more release evidence hashes do not match repository bytes."
      );
    }

    const artifactObservations: RepositoryReleaseArtifactObservation[] = [];
    for (const artifact of validated.matrix.requiredArtifacts) {
      artifactObservations.push(
        await observeArtifact(root, artifact, validated.budget)
      );
    }
    artifactObservations.sort((left, right) =>
      left.artifactId.localeCompare(right.artifactId)
    );
    summary.releaseArtifactCount = artifactObservations.length;
    summary.releaseArtifactDeclarationsMatched = artifactObservations.every(
      (entry) => entry.declarationMatched
    );
    if (!summary.releaseArtifactDeclarationsMatched) {
      throw new RunnerFailure(
        "repository_release_evidence_artifact_declaration_mismatch",
        "Release artifact declarations do not match repository state."
      );
    }

    const auditResult = buildV01ReleaseGapClosureAudit(validated.matrix);
    if (
      auditResult.audit === null ||
      auditResult.decision === "v01_release_gap_audit_invalid"
    ) {
      throw new RunnerFailure(
        "repository_release_evidence_gap_audit_invalid",
        "The v0.1 gap closure audit is invalid."
      );
    }
    summary.gapAuditBuilt = true;
    summary.openBlockerCount = auditResult.audit.openBlockerIds.length;
    summary.missingArtifactCount = auditResult.audit.missingArtifactIds.length;

    const material = {
      reportVersion: "1" as const,
      releaseVersion: "0.1.0" as const,
      sourceMatrixHash: auditResult.audit.sourceInputHash,
      releaseCommandVerified,
      canonicalCoordinatorVerified,
      evidenceObservations,
      artifactObservations,
      gapAudit: auditResult.audit,
      releaseReady: auditResult.audit.releaseReady
    };
    const report: RepositoryReleaseEvidenceReport = {
      ...material,
      reportHash: sha256Bytes(JSON.stringify(material))
    };

    summary.releaseReady = report.releaseReady;
    summary.bytesRead = validated.budget.bytesRead;

    return finish(
      report.releaseReady
        ? "repository_release_evidence_ready"
        : "repository_release_evidence_blocked",
      report,
      [],
      summary
    );
  } catch (error) {
    if (error instanceof TypeError && !(error instanceof RunnerFailure)) {
      throw error;
    }
    const failure =
      error instanceof RunnerFailure
        ? error
        : new RunnerFailure(
            "repository_release_evidence_exception",
            "Repository release evidence inspection failed closed."
          );
    return finish(
      "repository_release_evidence_invalid",
      null,
      [failure.code],
      summary
    );
  }
}

export function verifyRepositoryReleaseEvidenceReport(
  report: RepositoryReleaseEvidenceReport
): boolean {
  return (
    report.reportVersion === "1" &&
    report.releaseVersion === "0.1.0" &&
    HASH.test(report.sourceMatrixHash) &&
    HASH.test(report.reportHash) &&
    report.reportHash === sha256Bytes(JSON.stringify(reportCore(report)))
  );
}
