import { spawnSync } from "node:child_process";
import path from "node:path";
import type { PatchDiff, RepoPolicy } from "../../../packages/product-runtime/src/index.js";

export const DETERMINISTIC_AG_ARTIFACT_PATHS = Object.freeze([
  "reports/ag/AG2B_OPENAI_COMPATIBLE_PLANNER_PROVIDER.json",
  "reports/ag/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER.json"
] as const);

export const DETERMINISTIC_AG_SEMANTIC_VERIFIER = "npm run verify:ag3c" as const;
export const DETERMINISTIC_AG_BYTE_VERIFIER = "canonical-json-serialization/v1" as const;
const REPORTS_FORBIDDEN_PATTERN = "reports/**";
const HASH = /^sha256:[0-9a-f]{64}$/;

type ArtifactPath = (typeof DETERMINISTIC_AG_ARTIFACT_PATHS)[number];

export type DeterministicArtifactVerificationReceipt = Readonly<{
  schemaVersion: "bounded-review-deterministic-artifact-verification/v1";
  semanticVerifier: typeof DETERMINISTIC_AG_SEMANTIC_VERIFIER;
  byteVerifier: typeof DETERMINISTIC_AG_BYTE_VERIFIER;
  sourceMutationDetected: false;
  artifacts: readonly Readonly<{ path: ArtifactPath; sha256: string }>[];
}>;

export type DeterministicArtifactMaintenanceResolution = Readonly<{
  policy: RepoPolicy;
  applied: boolean;
  verifiedPaths: readonly ArtifactPath[];
  receipt: DeterministicArtifactVerificationReceipt | null;
}>;

type VerificationRunner = (repositoryPath: string) => DeterministicArtifactVerificationReceipt;

export function resolveDeterministicArtifactMaintenancePolicy(input: Readonly<{
  policy: RepoPolicy;
  diff: PatchDiff;
  repositoryPath?: string;
  verifier?: VerificationRunner;
}>): DeterministicArtifactMaintenanceResolution {
  const reportChanges = [...new Set(input.diff.changedFiles.filter((file) => file.startsWith("reports/")))].sort();
  const exact = new Set<string>(DETERMINISTIC_AG_ARTIFACT_PATHS);
  const verifiedCandidates = reportChanges.filter((file): file is ArtifactPath => exact.has(file));

  if (verifiedCandidates.length === 0 || verifiedCandidates.length !== reportChanges.length) {
    return unchanged(input.policy);
  }
  if (!input.policy.forbidden_paths.includes(REPORTS_FORBIDDEN_PATTERN)) {
    return unchanged(input.policy);
  }
  if (verifiedCandidates.some((file) => !input.policy.allowed_paths.includes(file))) {
    return unchanged(input.policy);
  }

  const verifier = input.verifier ?? runDeterministicArtifactVerifier;
  const receipt = validateDeterministicArtifactVerificationReceipt(
    verifier(path.resolve(input.repositoryPath ?? process.cwd()))
  );

  return {
    policy: {
      ...input.policy,
      allowed_paths: [...input.policy.allowed_paths],
      forbidden_paths: input.policy.forbidden_paths.filter((pattern) => pattern !== REPORTS_FORBIDDEN_PATTERN)
    },
    applied: true,
    verifiedPaths: verifiedCandidates,
    receipt
  };
}

export function validateDeterministicArtifactVerificationReceipt(
  value: unknown
): DeterministicArtifactVerificationReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Deterministic artifact verification receipt must be an object.");
  }
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).sort().join("\0") !== [
    "artifacts", "byteVerifier", "schemaVersion", "semanticVerifier", "sourceMutationDetected"
  ].sort().join("\0") ||
      receipt.schemaVersion !== "bounded-review-deterministic-artifact-verification/v1" ||
      receipt.semanticVerifier !== DETERMINISTIC_AG_SEMANTIC_VERIFIER ||
      receipt.byteVerifier !== DETERMINISTIC_AG_BYTE_VERIFIER ||
      receipt.sourceMutationDetected !== false || !Array.isArray(receipt.artifacts)) {
    throw new Error("Deterministic artifact verification receipt is invalid.");
  }

  const artifacts = receipt.artifacts.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Deterministic artifact receipt entry is invalid.");
    }
    const artifact = raw as Record<string, unknown>;
    if (Object.keys(artifact).sort().join("\0") !== ["path", "sha256"].sort().join("\0") ||
        typeof artifact.path !== "string" || typeof artifact.sha256 !== "string" || !HASH.test(artifact.sha256)) {
      throw new Error("Deterministic artifact receipt entry is invalid.");
    }
    return { path: artifact.path, sha256: artifact.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path, "en"));

  const expectedPaths = [...DETERMINISTIC_AG_ARTIFACT_PATHS].sort((a, b) => a.localeCompare(b, "en"));
  if (artifacts.length !== expectedPaths.length ||
      artifacts.some((artifact, index) => artifact.path !== expectedPaths[index])) {
    throw new Error("Deterministic artifact receipt must cover exactly the AG2B and AG3C maintenance artifacts.");
  }

  return value as DeterministicArtifactVerificationReceipt;
}

function runDeterministicArtifactVerifier(repositoryPath: string): DeterministicArtifactVerificationReceipt {
  const script = path.join(repositoryPath, "scripts", "verify-bounded-review-deterministic-artifacts.cjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: repositoryPath,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    throw new Error("Deterministic AG artifact verification failed closed.");
  }
  try {
    return validateDeterministicArtifactVerificationReceipt(JSON.parse(result.stdout));
  } catch {
    throw new Error("Deterministic AG artifact verifier returned an invalid receipt.");
  }
}

function unchanged(policy: RepoPolicy): DeterministicArtifactMaintenanceResolution {
  return { policy, applied: false, verifiedPaths: [], receipt: null };
}
