import { createHash } from "node:crypto";

import {
  hashCanonicalJson
} from "./agent-event-ledger.js";

export const RUNTIME_GENERATION_BOUNDARY_VERSION = "1" as const;
export const CANONICAL_RUNTIME_PACKAGE_NAME =
  "@bounded-dllm-agent-lab/product-runtime" as const;
export const CANONICAL_RUNTIME_MAIN =
  "src/canonical-runtime.ts" as const;
export const CANONICAL_RUNTIME_EXPORT =
  "./src/canonical-runtime.ts" as const;
export const LEGACY_RUNTIME_ENTRYPOINT =
  "src/index.ts" as const;
export const REPOSITORY_SOURCE_SCAN =
  "repository_source_scan" as const;

export const REQUIRED_CANONICAL_EXPORTS = Object.freeze([
  'export * from "./integrated-disposable-apply-coordinator.js";',
  'export * from "./context-sufficiency-authorization.js";',
  'export * from "./acceptance-criteria-contract.js";',
  'export * from "./controlled-repository-apply.js";',
  'export * from "./controlled-post-apply-validation.js";',
  'export * from "./durable-consumption-registry.js";'
] as const);

export const FORBIDDEN_CANONICAL_SYMBOLS = Object.freeze([
  "createMockOrchestrationFlowDefinition",
  "mock-bounded-workspace-flow-v1",
  "SharedWorkspaceSnapshot",
  "SyntheticWorkspacePacket",
  "reviewPatch("
] as const);

export const REQUIRED_LEGACY_MARKERS = Object.freeze([
  "RESEARCH_ONLY_COMPATIBILITY_ENTRYPOINT",
  "createMockOrchestrationFlowDefinition",
  "mock-bounded-workspace-flow-v1"
] as const);

export type RuntimeGenerationEvidenceClass =
  | "deterministic_fixture"
  | "observed_run";

export type RuntimeGenerationBoundaryInput = {
  packageManifest: unknown;
  canonicalEntrypointSource: string;
  legacyEntrypointSource: string;
  evidenceClass: RuntimeGenerationEvidenceClass;
  observationSource:
    | "fixture_source_scan"
    | typeof REPOSITORY_SOURCE_SCAN;
};

export type RuntimeGenerationBoundaryChecks = {
  packageNameMatched: boolean;
  packageMainCanonical: boolean;
  packageExportsOnlyCanonical: boolean;
  canonicalMetadataPresent: boolean;
  canonicalRequiredExportsPresent: boolean;
  canonicalLegacySymbolsAbsent: boolean;
  legacyResearchMarkerPresent: boolean;
  legacySurfaceNotPubliclyExported: boolean;
};

export type RuntimeGenerationBoundaryDecision =
  | "runtime_generation_boundary_ready"
  | "runtime_generation_boundary_blocked"
  | "runtime_generation_boundary_invalid";

export type RuntimeGenerationBoundaryReport = {
  reportVersion: "1";
  boundaryVersion: "1";
  evidenceClass: RuntimeGenerationEvidenceClass;
  observationSource:
    | "fixture_source_scan"
    | typeof REPOSITORY_SOURCE_SCAN;
  releaseClaimEligible: boolean;
  decision: RuntimeGenerationBoundaryDecision;
  packageName: string | null;
  canonicalEntrypoint: typeof CANONICAL_RUNTIME_MAIN;
  canonicalPackageExport: typeof CANONICAL_RUNTIME_EXPORT;
  legacyEntrypoint: typeof LEGACY_RUNTIME_ENTRYPOINT;
  requiredCanonicalExports: readonly string[];
  forbiddenCanonicalSymbols: readonly string[];
  requiredLegacyMarkers: readonly string[];
  canonicalSourceHash: string;
  legacySourceHash: string;
  packageManifestHash: string;
  checks: RuntimeGenerationBoundaryChecks;
  errors: readonly string[];
  reportHash: string;
};

type PlainRecord = Record<string, unknown>;

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }
  return Object.values(
    Object.getOwnPropertyDescriptors(value)
  ).every(
    (descriptor) =>
      Object.hasOwn(descriptor, "value") &&
      descriptor.get === undefined &&
      descriptor.set === undefined
  );
}

function exactRootExport(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === 1 &&
    keys[0] === "." &&
    value["."] === CANONICAL_RUNTIME_EXPORT
  );
}

function validSource(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2_000_000 &&
    !value.includes("\u0000")
  );
}

function reportCore(
  report: RuntimeGenerationBoundaryReport
): Omit<RuntimeGenerationBoundaryReport, "reportHash"> {
  const { reportHash: _, ...core } = report;
  return core;
}

export function buildRuntimeGenerationBoundaryReport(
  input: RuntimeGenerationBoundaryInput
): RuntimeGenerationBoundaryReport {
  const errors: string[] = [];

  if (
    !isPlainRecord(input) ||
    !validSource(input.canonicalEntrypointSource) ||
    !validSource(input.legacyEntrypointSource) ||
    !(
      input.evidenceClass === "deterministic_fixture" ||
      input.evidenceClass === "observed_run"
    ) ||
    !(
      input.observationSource === "fixture_source_scan" ||
      input.observationSource === REPOSITORY_SOURCE_SCAN
    )
  ) {
    const invalidMaterial = {
      reportVersion: "1" as const,
      boundaryVersion: RUNTIME_GENERATION_BOUNDARY_VERSION,
      evidenceClass:
        input?.evidenceClass === "observed_run"
          ? "observed_run" as const
          : "deterministic_fixture" as const,
      observationSource:
        input?.observationSource === REPOSITORY_SOURCE_SCAN
          ? REPOSITORY_SOURCE_SCAN
          : "fixture_source_scan" as const,
      releaseClaimEligible: false,
      decision:
        "runtime_generation_boundary_invalid" as const,
      packageName: null,
      canonicalEntrypoint: CANONICAL_RUNTIME_MAIN,
      canonicalPackageExport: CANONICAL_RUNTIME_EXPORT,
      legacyEntrypoint: LEGACY_RUNTIME_ENTRYPOINT,
      requiredCanonicalExports:
        [...REQUIRED_CANONICAL_EXPORTS],
      forbiddenCanonicalSymbols:
        [...FORBIDDEN_CANONICAL_SYMBOLS],
      requiredLegacyMarkers:
        [...REQUIRED_LEGACY_MARKERS],
      canonicalSourceHash:
        sha256Text(
          typeof input?.canonicalEntrypointSource === "string"
            ? input.canonicalEntrypointSource
            : ""
        ),
      legacySourceHash:
        sha256Text(
          typeof input?.legacyEntrypointSource === "string"
            ? input.legacyEntrypointSource
            : ""
        ),
      packageManifestHash:
        hashCanonicalJson(
          isPlainRecord(input?.packageManifest)
            ? input.packageManifest
            : {}
        ),
      checks: {
        packageNameMatched: false,
        packageMainCanonical: false,
        packageExportsOnlyCanonical: false,
        canonicalMetadataPresent: false,
        canonicalRequiredExportsPresent: false,
        canonicalLegacySymbolsAbsent: false,
        legacyResearchMarkerPresent: false,
        legacySurfaceNotPubliclyExported: false
      },
      errors: ["runtime_generation_boundary_input_invalid"]
    };
    return Object.freeze({
      ...invalidMaterial,
      reportHash: hashCanonicalJson(invalidMaterial)
    });
  }

  const manifest = isPlainRecord(input.packageManifest)
    ? input.packageManifest
    : {};
  const packageName =
    typeof manifest.name === "string"
      ? manifest.name
      : null;

  const packageNameMatched =
    packageName === CANONICAL_RUNTIME_PACKAGE_NAME;
  const packageMainCanonical =
    manifest.main === CANONICAL_RUNTIME_MAIN;
  const packageExportsOnlyCanonical =
    exactRootExport(manifest.exports);
  const canonicalMetadataPresent =
    input.canonicalEntrypointSource.includes(
      "CANONICAL_PRODUCT_RUNTIME_ENTRYPOINT"
    );
  const canonicalRequiredExportsPresent =
    REQUIRED_CANONICAL_EXPORTS.every(
      (entry) =>
        input.canonicalEntrypointSource.includes(entry)
    );
  const canonicalLegacySymbolsAbsent =
    FORBIDDEN_CANONICAL_SYMBOLS.every(
      (entry) =>
        !input.canonicalEntrypointSource.includes(entry)
    );
  const legacyResearchMarkerPresent =
    REQUIRED_LEGACY_MARKERS.every(
      (entry) =>
        input.legacyEntrypointSource.includes(entry)
    );
  const legacySurfaceNotPubliclyExported =
    packageExportsOnlyCanonical &&
    !JSON.stringify(manifest.exports).includes(
      LEGACY_RUNTIME_ENTRYPOINT
    );

  const checks: RuntimeGenerationBoundaryChecks = {
    packageNameMatched,
    packageMainCanonical,
    packageExportsOnlyCanonical,
    canonicalMetadataPresent,
    canonicalRequiredExportsPresent,
    canonicalLegacySymbolsAbsent,
    legacyResearchMarkerPresent,
    legacySurfaceNotPubliclyExported
  };

  for (const [name, passed] of Object.entries(checks)) {
    if (!passed) {
      errors.push(
        `runtime_generation_boundary_check_failed:${name}`
      );
    }
  }

  const boundaryReady =
    Object.values(checks).every(Boolean);
  const releaseClaimEligible =
    boundaryReady &&
    input.evidenceClass === "observed_run" &&
    input.observationSource === REPOSITORY_SOURCE_SCAN;

  const material = {
    reportVersion: "1" as const,
    boundaryVersion: RUNTIME_GENERATION_BOUNDARY_VERSION,
    evidenceClass: input.evidenceClass,
    observationSource: input.observationSource,
    releaseClaimEligible,
    decision: boundaryReady
      ? "runtime_generation_boundary_ready" as const
      : "runtime_generation_boundary_blocked" as const,
    packageName,
    canonicalEntrypoint: CANONICAL_RUNTIME_MAIN,
    canonicalPackageExport: CANONICAL_RUNTIME_EXPORT,
    legacyEntrypoint: LEGACY_RUNTIME_ENTRYPOINT,
    requiredCanonicalExports:
      [...REQUIRED_CANONICAL_EXPORTS],
    forbiddenCanonicalSymbols:
      [...FORBIDDEN_CANONICAL_SYMBOLS],
    requiredLegacyMarkers:
      [...REQUIRED_LEGACY_MARKERS],
    canonicalSourceHash:
      sha256Text(input.canonicalEntrypointSource),
    legacySourceHash:
      sha256Text(input.legacyEntrypointSource),
    packageManifestHash:
      hashCanonicalJson(manifest),
    checks,
    errors: [...errors].sort()
  };

  return Object.freeze({
    ...material,
    reportHash: hashCanonicalJson(material)
  });
}

export function verifyRuntimeGenerationBoundaryReport(
  report: RuntimeGenerationBoundaryReport
): boolean {
  return (
    isPlainRecord(report) &&
    report.reportVersion === "1" &&
    report.boundaryVersion ===
      RUNTIME_GENERATION_BOUNDARY_VERSION &&
    /^sha256:[0-9a-f]{64}$/.test(report.reportHash) &&
    report.reportHash ===
      hashCanonicalJson(reportCore(report)) &&
    (
      report.releaseClaimEligible === false ||
      (
        report.decision ===
          "runtime_generation_boundary_ready" &&
        report.evidenceClass === "observed_run" &&
        report.observationSource ===
          REPOSITORY_SOURCE_SCAN &&
        Object.values(report.checks).every(Boolean) &&
        report.errors.length === 0
      )
    )
  );
}
