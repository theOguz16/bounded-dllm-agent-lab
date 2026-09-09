import { rm } from "node:fs/promises";

import {
  DISPOSABLE_AGENT_WORKSPACE_VERSION,
  createDisposableAgentWorkspace,
  type DisposableAgentWorkspaceManifest,
  type DisposableAgentWorkspaceManifestFile
} from "./disposable-agent-workspace.js";

export const CONTEXT_EXPOSURE_REPORT_VERSION =
  "context-exposure-report/v1" as const;

export type ContextExposureReport = Readonly<{
  reportVersion: typeof CONTEXT_EXPOSURE_REPORT_VERSION;
  sourceSnapshotHash: string;
  repositoryEligibleFileCount: number;
  repositoryEligibleBytes: number;
  exposedFileCount: number;
  exposedBytes: number;
  mutableFileCount: number;
  mutableBytes: number;
}>;

export type ContextExposureReportInput = Readonly<{
  repositoryPath: string;
  sourceSnapshotHash: string;
  exposedManifest: DisposableAgentWorkspaceManifest;
}>;

export class ContextExposureReportError extends Error {
  readonly code = "context_exposure_report_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ContextExposureReportError";
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function assertManifestEntry(
  entry: DisposableAgentWorkspaceManifestFile,
  label: string
): void {
  if (
    entry === null ||
    typeof entry !== "object" ||
    typeof entry.path !== "string" ||
    entry.path.length === 0 ||
    !SHA256_HEX.test(entry.sourceHash) ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0 ||
    typeof entry.changeAllowed !== "boolean"
  ) {
    throw new ContextExposureReportError(`${label} contains an invalid file entry.`);
  }
}

function validateExposedManifest(
  manifest: DisposableAgentWorkspaceManifest,
  sourceSnapshotHash: string
): void {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.schemaVersion !== DISPOSABLE_AGENT_WORKSPACE_VERSION ||
    manifest.sourceSnapshotHash !== sourceSnapshotHash ||
    !Array.isArray(manifest.files)
  ) {
    throw new ContextExposureReportError(
      "exposedManifest must be a disposable workspace manifest for the same source snapshot."
    );
  }

  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const entry of manifest.files) {
    assertManifestEntry(entry, "exposedManifest");
    if (exact.has(entry.path)) {
      throw new ContextExposureReportError(
        `exposedManifest contains duplicate path: ${entry.path}.`
      );
    }
    const foldedPath = entry.path.toLocaleLowerCase("en-US");
    if (folded.has(foldedPath)) {
      throw new ContextExposureReportError(
        `exposedManifest contains a case-insensitive path collision: ${entry.path}.`
      );
    }
    exact.add(entry.path);
    folded.add(foldedPath);
  }
}

function sumBytes(files: readonly DisposableAgentWorkspaceManifestFile[]): number {
  return files.reduce((total, entry) => {
    const next = total + entry.bytes;
    if (!Number.isSafeInteger(next)) {
      throw new ContextExposureReportError("Context exposure byte total exceeds safe integer range.");
    }
    return next;
  }, 0);
}

function assertExposedSubsetOfEligible(
  exposed: readonly DisposableAgentWorkspaceManifestFile[],
  eligible: readonly DisposableAgentWorkspaceManifestFile[]
): void {
  const eligibleByPath = new Map(eligible.map((entry) => [entry.path, entry]));

  for (const entry of exposed) {
    const baseline = eligibleByPath.get(entry.path);
    if (baseline === undefined) {
      throw new ContextExposureReportError(
        `Exposed path is not repository-eligible: ${entry.path}.`
      );
    }
    if (
      baseline.sourceHash !== entry.sourceHash ||
      baseline.bytes !== entry.bytes
    ) {
      throw new ContextExposureReportError(
        `Exposed file no longer matches the repository-eligible source snapshot: ${entry.path}.`
      );
    }
  }
}

export async function createContextExposureReport(
  input: ContextExposureReportInput
): Promise<ContextExposureReport> {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.repositoryPath !== "string" ||
    input.repositoryPath.length === 0 ||
    typeof input.sourceSnapshotHash !== "string" ||
    input.sourceSnapshotHash.length === 0
  ) {
    throw new ContextExposureReportError(
      "repositoryPath and sourceSnapshotHash are required."
    );
  }

  validateExposedManifest(input.exposedManifest, input.sourceSnapshotHash);

  let baselineWorkspacePath: string | null = null;
  try {
    // Reuse the disposable-workspace baseline selector instead of duplicating its
    // eligibility policy. This keeps telemetry aligned with the exact surface a
    // baseline agent could receive: tracked, regular, strict UTF-8 text files,
    // excluding the workspace primitive's hard-denied paths.
    const baseline = await createDisposableAgentWorkspace({
      repositoryPath: input.repositoryPath,
      sourceSnapshotHash: input.sourceSnapshotHash,
      visibleFiles: [],
      changeAllowedFiles: [],
      forbiddenFiles: [],
      mode: "baseline"
    });
    baselineWorkspacePath = baseline.workspacePath;

    const eligibleFiles = baseline.manifest.files;
    const exposedFiles = input.exposedManifest.files;
    assertExposedSubsetOfEligible(exposedFiles, eligibleFiles);

    const mutableFiles = exposedFiles.filter((entry) => entry.changeAllowed);

    return Object.freeze({
      reportVersion: CONTEXT_EXPOSURE_REPORT_VERSION,
      sourceSnapshotHash: input.sourceSnapshotHash,
      repositoryEligibleFileCount: eligibleFiles.length,
      repositoryEligibleBytes: sumBytes(eligibleFiles),
      exposedFileCount: exposedFiles.length,
      exposedBytes: sumBytes(exposedFiles),
      mutableFileCount: mutableFiles.length,
      mutableBytes: sumBytes(mutableFiles)
    });
  } finally {
    if (baselineWorkspacePath !== null) {
      await rm(baselineWorkspacePath, { recursive: true, force: true });
    }
  }
}
