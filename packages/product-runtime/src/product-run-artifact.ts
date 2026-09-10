import { hashCanonicalJson } from "./agent-event-ledger.js";

export const BOUNDED_PRODUCT_RUN_ARTIFACT_VERSION = "bounded-product-run/v1" as const;

export const PRODUCT_RUN_ARTIFACT_FILES = Object.freeze({
  run: "run.json",
  candidateDiff: "candidate.diff",
  receipt: "receipt.json",
  telemetry: "telemetry.json",
  validation: "validation.json",
  comparison: "comparison.json"
} as const);

export type ProductRunKind = "run" | "compare";

export type ProductRunStoredFile = Readonly<{
  file: string;
  sha256: string;
  bytes: number;
}>;

export type ProductRunArtifact = Readonly<{
  artifactVersion: typeof BOUNDED_PRODUCT_RUN_ARTIFACT_VERSION;
  runId: string;
  runKind: ProductRunKind;
  run: Readonly<Record<string, unknown>>;
  files: Readonly<{
    candidateDiff: ProductRunStoredFile;
    receipt: ProductRunStoredFile;
    telemetry: ProductRunStoredFile;
    validation: ProductRunStoredFile;
    comparison: ProductRunStoredFile | null;
  }>;
  artifactHash: string;
}>;

export type CreateProductRunArtifactInput = Readonly<{
  runId: string;
  runKind: ProductRunKind;
  run: Readonly<Record<string, unknown>>;
  files: ProductRunArtifact["files"];
}>;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateStoredFile(
  value: ProductRunStoredFile,
  expectedFile: string,
  field: string
): void {
  if (
    !isPlainObject(value) ||
    value.file !== expectedFile ||
    typeof value.sha256 !== "string" ||
    !HASH.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0
  ) {
    throw new TypeError(`Product run artifact ${field} metadata is invalid.`);
  }
}

function artifactMaterial(
  value: Omit<ProductRunArtifact, "artifactHash">
): unknown {
  return value;
}

export function createProductRunArtifact(
  input: CreateProductRunArtifactInput
): ProductRunArtifact {
  if (!RUN_ID.test(input.runId)) {
    throw new TypeError("Product run artifact runId is invalid.");
  }
  if (input.runKind !== "run" && input.runKind !== "compare") {
    throw new TypeError("Product run artifact runKind is invalid.");
  }
  if (!isPlainObject(input.run)) {
    throw new TypeError("Product run artifact run metadata must be an object.");
  }

  validateStoredFile(input.files.candidateDiff, PRODUCT_RUN_ARTIFACT_FILES.candidateDiff, "candidateDiff");
  validateStoredFile(input.files.receipt, PRODUCT_RUN_ARTIFACT_FILES.receipt, "receipt");
  validateStoredFile(input.files.telemetry, PRODUCT_RUN_ARTIFACT_FILES.telemetry, "telemetry");
  validateStoredFile(input.files.validation, PRODUCT_RUN_ARTIFACT_FILES.validation, "validation");

  if (input.runKind === "compare") {
    if (input.files.comparison === null) {
      throw new TypeError("Compare product run artifacts require comparison.json.");
    }
    validateStoredFile(input.files.comparison, PRODUCT_RUN_ARTIFACT_FILES.comparison, "comparison");
  } else if (input.files.comparison !== null) {
    throw new TypeError("Non-compare product run artifacts must not include comparison.json.");
  }

  const withoutHash: Omit<ProductRunArtifact, "artifactHash"> = {
    artifactVersion: BOUNDED_PRODUCT_RUN_ARTIFACT_VERSION,
    runId: input.runId,
    runKind: input.runKind,
    run: input.run,
    files: Object.freeze({
      candidateDiff: Object.freeze({ ...input.files.candidateDiff }),
      receipt: Object.freeze({ ...input.files.receipt }),
      telemetry: Object.freeze({ ...input.files.telemetry }),
      validation: Object.freeze({ ...input.files.validation }),
      comparison: input.files.comparison === null
        ? null
        : Object.freeze({ ...input.files.comparison })
    })
  };
  const artifactHash = hashCanonicalJson(artifactMaterial(withoutHash));
  return Object.freeze({ ...withoutHash, artifactHash });
}

export function verifyProductRunArtifact(value: unknown): value is ProductRunArtifact {
  try {
    if (!isPlainObject(value)) return false;
    const fields = ["artifactVersion", "runId", "runKind", "run", "files", "artifactHash"];
    if (Object.keys(value).sort().join("\u0000") !== fields.sort().join("\u0000")) return false;
    if (value.artifactVersion !== BOUNDED_PRODUCT_RUN_ARTIFACT_VERSION) return false;
    if (typeof value.runId !== "string" || !RUN_ID.test(value.runId)) return false;
    if (value.runKind !== "run" && value.runKind !== "compare") return false;
    if (!isPlainObject(value.run) || !isPlainObject(value.files)) return false;
    if (typeof value.artifactHash !== "string" || !HASH.test(value.artifactHash)) return false;

    const fileFields = ["candidateDiff", "receipt", "telemetry", "validation", "comparison"];
    if (Object.keys(value.files).sort().join("\u0000") !== fileFields.sort().join("\u0000")) return false;
    const files = value.files as ProductRunArtifact["files"];
    validateStoredFile(files.candidateDiff, PRODUCT_RUN_ARTIFACT_FILES.candidateDiff, "candidateDiff");
    validateStoredFile(files.receipt, PRODUCT_RUN_ARTIFACT_FILES.receipt, "receipt");
    validateStoredFile(files.telemetry, PRODUCT_RUN_ARTIFACT_FILES.telemetry, "telemetry");
    validateStoredFile(files.validation, PRODUCT_RUN_ARTIFACT_FILES.validation, "validation");
    if (value.runKind === "compare") {
      if (files.comparison === null) return false;
      validateStoredFile(files.comparison, PRODUCT_RUN_ARTIFACT_FILES.comparison, "comparison");
    } else if (files.comparison !== null) {
      return false;
    }

    const { artifactHash, ...withoutHash } = value as ProductRunArtifact;
    return hashCanonicalJson(artifactMaterial(withoutHash)) === artifactHash;
  } catch {
    return false;
  }
}
