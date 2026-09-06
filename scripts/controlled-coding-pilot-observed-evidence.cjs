#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} = require("node:fs");
const { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } = require("node:path");
const {
  hash: pilotHash,
  validateDefinition
} = require("./controlled-coding-pilot.cjs");
const {
  resolveContextSelections
} = require("./controlled-coding-pilot-context-selector.cjs");

const OBSERVED_EVIDENCE_SCHEMA_VERSION =
  "bounded.controlled-coding-pilot-observed-evidence/v3";
const OBSERVED_RUN_SCHEMA_VERSION =
  "bounded.controlled-coding-pilot-observed-run/v1";
const EXPERIMENT_CONFIG_SCHEMA_VERSION =
  "bounded.controlled-coding-pilot-observed-config/v1";
const PILOT_DEFINITIONS = Object.freeze({
  "controlled-real-coding-v2.worker-request-id-correlation":
    "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json",
  "controlled-real-coding-v2.local-json-schema-error-classification":
    "pilots/controlled-real-coding-v2/local-json-schema-error-classification/task.json"
});
const REQUIRED_PILOT_IDS = Object.freeze(Object.keys(PILOT_DEFINITIONS).sort());
const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BLOB_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PROVIDER_SENSITIVE_LINE = [
  /bearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /authorization\s*:\s*[^\n]+/i,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*[^\s,;]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i
];

class ObservedEvidenceError extends Error {
  constructor(code, relativePath) {
    super(code);
    this.name = "ObservedEvidenceError";
    this.code = code;
    this.relativePath = relativePath;
  }
}

function fail(code, relativePath) {
  throw new ObservedEvidenceError(code, relativePath);
}

function canonicalJson(value, ancestors = new WeakSet()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("OBSERVED_EVIDENCE_CANONICAL_JSON_INVALID");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    fail("OBSERVED_EVIDENCE_CANONICAL_JSON_INVALID");
  }
  if (ancestors.has(value)) fail("OBSERVED_EVIDENCE_CANONICAL_JSON_INVALID");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("OBSERVED_EVIDENCE_CANONICAL_JSON_INVALID");
    }
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashCanonicalJson(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function git(root, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: options.buffer ? null : "utf8",
      timeout: 5_000,
      maxBuffer: 2_000_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    fail("OBSERVED_EVIDENCE_GIT_VALIDATION_FAILED");
  }
}

function gitText(root, args) {
  return String(git(root, args)).trim();
}

function gitBytes(root, args) {
  const value = git(root, args, { buffer: true });
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function safeRelative(root, absolute) {
  const value = relative(root, absolute).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value) ||
      CONTROL.test(value) || value.includes("\\") || posix.normalize(value) !== value ||
      value.split("/").includes("..")) {
    fail("OBSERVED_EVIDENCE_PATH_INVALID");
  }
  return value;
}

function enumerateFiles(root, { excludeManifest = false } = {}) {
  const files = [];
  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = safeRelative(root, absolute);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) fail("OBSERVED_EVIDENCE_SYMLINK_REJECTED", path);
      if (stats.isDirectory()) visit(absolute);
      else if (stats.isFile()) {
        if (!(excludeManifest && path === "evidence-manifest.json")) {
          const bytes = readFileSync(absolute);
          files.push({
            relativePath: path,
            byteSize: bytes.length,
            sha256: sha256Bytes(bytes)
          });
        }
      } else {
        fail("OBSERVED_EVIDENCE_NON_REGULAR_FILE", path);
      }
    }
  }
  visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function parseJsonFile(path, code) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(code);
  }
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code);
  }
}

function sanitizeRelativeArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 ||
      CONTROL.test(value) || value.includes("\\") || isAbsolute(value) ||
      posix.isAbsolute(value) || posix.normalize(value) !== value || value === "." ||
      value.split("/").includes("..")) {
    fail("OBSERVED_EVIDENCE_ARTIFACT_PATH_INVALID");
  }
  return value;
}

function createProviderSource(content) {
  const lines = content.split("\n");
  return lines.map((line, index) =>
    PROVIDER_SENSITIVE_LINE.some((pattern) => pattern.test(line))
      ? `/* PILOT_REDACTED_LINE_${index} */`
      : line
  ).join("\n");
}

function symbolForPath(filePath) {
  return `symbol:${filePath.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function committedTask(root, sourceCommit, pilotId) {
  const path = PILOT_DEFINITIONS[pilotId];
  if (!path) fail("OBSERVED_EVIDENCE_PILOT_UNSUPPORTED");
  const bytes = gitBytes(root, ["show", `${sourceCommit}:${path}`]);
  let definition;
  try {
    definition = validateDefinition(JSON.parse(bytes.toString("utf8")));
  } catch {
    fail("OBSERVED_EVIDENCE_TASK_DEFINITION_INVALID");
  }
  if (definition.pilotId !== pilotId) fail("OBSERVED_EVIDENCE_TASK_ID_MISMATCH");
  const blobHash = gitText(root, ["rev-parse", `${sourceCommit}:${path}`]);
  if (!BLOB_HASH.test(blobHash)) fail("OBSERVED_EVIDENCE_TASK_BLOB_INVALID");
  return {
    path,
    definition,
    definitionHash: pilotHash(definition),
    fileHash: sha256Bytes(bytes),
    blobHash
  };
}

function reconstructSuppliedContext(root, sourceCommit, definition) {
  const workspaceFiles = definition.allowedMutationPaths.map((path) => {
    const source = gitBytes(root, ["show", `${sourceCommit}:${path}`]).toString("utf8");
    const content = createProviderSource(source);
    return {
      path,
      content,
      contentHash: pilotHash(content),
      language: "TypeScript",
      authority: "change_allowed",
      relatedSymbols: [symbolForPath(path)]
    };
  });
  return resolveContextSelections(workspaceFiles, definition.contextSelections);
}

function sourceTargetRecords(root, sourceCommit, definition) {
  return definition.allowedMutationPaths.map((path) => {
    const blobHash = gitText(root, ["rev-parse", `${sourceCommit}:${path}`]);
    if (!BLOB_HASH.test(blobHash)) fail("OBSERVED_EVIDENCE_SOURCE_TARGET_INVALID");
    return { path, blobHash };
  });
}

function copyDirectoryContents(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const stats = lstatSync(from);
    if (stats.isSymbolicLink()) fail("OBSERVED_EVIDENCE_SYMLINK_REJECTED", entry.name);
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  }
}

function publishObservedEvidence({
  evidenceRoot,
  suiteDirectory,
  sourceCommit,
  experimentConfig,
  runSummaries
}) {
  if (!COMMIT.test(sourceCommit ?? "")) fail("OBSERVED_EVIDENCE_SOURCE_COMMIT_INVALID");
  requirePlainObject(experimentConfig, "OBSERVED_EVIDENCE_CONFIG_INVALID");
  if (experimentConfig.schemaVersion !== EXPERIMENT_CONFIG_SCHEMA_VERSION) {
    fail("OBSERVED_EVIDENCE_CONFIG_INVALID");
  }
  if (!Array.isArray(runSummaries) || runSummaries.length !== REQUIRED_PILOT_IDS.length) {
    fail("OBSERVED_EVIDENCE_RUN_SET_INVALID");
  }
  const pilotIds = runSummaries.map((run) => run.pilotId).sort();
  if (canonicalJson(pilotIds) !== canonicalJson(REQUIRED_PILOT_IDS)) {
    fail("OBSERVED_EVIDENCE_RUN_SET_INVALID");
  }

  const experimentConfigHash = hashCanonicalJson(experimentConfig);
  const configDigest = experimentConfigHash.slice("sha256:".length);
  const destinationParent = resolve(evidenceRoot, sourceCommit, configDigest);
  mkdirSync(destinationParent, { recursive: true });
  const staging = mkdtempSync(join(destinationParent, ".observed-v3.tmp-"));
  let published = false;
  try {
    copyDirectoryContents(realpathSync(suiteDirectory), staging);
    const files = enumerateFiles(staging, { excludeManifest: true });
    const sortedRuns = [...runSummaries].sort((left, right) =>
      left.pilotId.localeCompare(right.pilotId)
    );
    const manifestCore = {
      schemaVersion: OBSERVED_EVIDENCE_SCHEMA_VERSION,
      sourceCommit,
      experimentConfigHash,
      experimentConfig,
      runCount: sortedRuns.length,
      runs: sortedRuns,
      files
    };
    const evidenceHash = hashCanonicalJson(manifestCore);
    const manifest = { ...manifestCore, evidenceHash };
    writeFileSync(
      join(staging, "evidence-manifest.json"),
      `${canonicalJson(manifest)}\n`,
      { flag: "wx" }
    );
    const finalDirectory = join(destinationParent, evidenceHash.slice("sha256:".length));
    if (existsSync(finalDirectory)) fail("OBSERVED_EVIDENCE_IMMUTABLE_COLLISION");
    renameSync(staging, finalDirectory);
    published = true;
    return { finalDirectory, evidenceHash, experimentConfigHash };
  } finally {
    if (!published && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

function validateFileRecord(record) {
  requirePlainObject(record, "OBSERVED_EVIDENCE_FILE_RECORD_INVALID");
  sanitizeRelativeArtifactPath(record.relativePath);
  if (!Number.isSafeInteger(record.byteSize) || record.byteSize < 0 ||
      !HASH.test(record.sha256 ?? "")) {
    fail("OBSERVED_EVIDENCE_FILE_RECORD_INVALID", record.relativePath);
  }
}

function artifactBytes(runRoot, relativePath) {
  const safe = sanitizeRelativeArtifactPath(relativePath);
  const absolute = resolve(runRoot, safe);
  const root = realpathSync(runRoot);
  const lexicalRelative = relative(root, absolute);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`)) {
    fail("OBSERVED_EVIDENCE_ARTIFACT_PATH_INVALID", safe);
  }
  const stats = lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail("OBSERVED_EVIDENCE_ARTIFACT_INVALID", safe);
  }
  return readFileSync(absolute);
}

function verifyArtifactRecord(runRoot, record) {
  requirePlainObject(record, "OBSERVED_EVIDENCE_ARTIFACT_RECORD_INVALID");
  const bytes = artifactBytes(runRoot, record.relativePath);
  if (!HASH.test(record.sha256 ?? "") || record.sha256 !== sha256Bytes(bytes) ||
      !Number.isSafeInteger(record.byteSize) || record.byteSize !== bytes.length ||
      typeof record.kind !== "string" || record.kind.length === 0) {
    fail("OBSERVED_EVIDENCE_ARTIFACT_RECORD_INVALID", record.relativePath);
  }
}

function validateOutcome(value, code) {
  requirePlainObject(value, code);
  if (!["passed", "failed", "not_run"].includes(value.status) ||
      (value.failedStage !== null && value.failedStage !== undefined &&
        typeof value.failedStage !== "string")) {
    fail(code);
  }
}

function validateTokenCounts(value) {
  requirePlainObject(value, "OBSERVED_EVIDENCE_TOKEN_COUNTS_INVALID");
  const fields = ["inputTokens", "outputTokens", "totalTokens"];
  for (const field of fields) {
    if (value[field] !== null &&
        (!Number.isSafeInteger(value[field]) || value[field] < 0)) {
      fail("OBSERVED_EVIDENCE_TOKEN_COUNTS_INVALID");
    }
  }
  if (fields.every((field) => value[field] !== null) &&
      value.totalTokens !== value.inputTokens + value.outputTokens) {
    fail("OBSERVED_EVIDENCE_TOKEN_COUNTS_INVALID");
  }
}

function validateLatency(value) {
  requirePlainObject(value, "OBSERVED_EVIDENCE_LATENCY_INVALID");
  for (const field of ["providerMs", "totalRunMs"]) {
    if (value[field] !== null &&
        (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0)) {
      fail("OBSERVED_EVIDENCE_LATENCY_INVALID");
    }
  }
}

function verifyRun({ repositoryRoot, bundleRoot, manifest, summary }) {
  requirePlainObject(summary, "OBSERVED_EVIDENCE_RUN_SUMMARY_INVALID");
  if (!REQUIRED_PILOT_IDS.includes(summary.pilotId) ||
      !HASH.test(summary.runProvenanceHash ?? "") ||
      !["completed", "failed", "cancelled"].includes(summary.status) ||
      (summary.failureCode !== null && typeof summary.failureCode !== "string")) {
    fail("OBSERVED_EVIDENCE_RUN_SUMMARY_INVALID");
  }
  const provenancePath = sanitizeRelativeArtifactPath(summary.relativePath);
  const provenanceAbsolute = resolve(bundleRoot, provenancePath);
  const bundleRelative = relative(bundleRoot, provenanceAbsolute);
  if (bundleRelative === ".." || bundleRelative.startsWith(`..${sep}`)) {
    fail("OBSERVED_EVIDENCE_RUN_SUMMARY_INVALID");
  }
  const provenance = parseJsonFile(provenanceAbsolute, "OBSERVED_EVIDENCE_RUN_PROVENANCE_INVALID");
  requirePlainObject(provenance, "OBSERVED_EVIDENCE_RUN_PROVENANCE_INVALID");
  if (hashCanonicalJson(provenance) !== summary.runProvenanceHash) {
    fail("OBSERVED_EVIDENCE_RUN_PROVENANCE_HASH_MISMATCH");
  }
  if (provenance.schemaVersion !== OBSERVED_RUN_SCHEMA_VERSION ||
      provenance.pilotId !== summary.pilotId ||
      provenance.sourceCommit !== manifest.sourceCommit ||
      provenance.experimentConfigHash !== manifest.experimentConfigHash ||
      provenance.status !== summary.status ||
      provenance.failureCode !== summary.failureCode ||
      provenance.providerCallCount !== 1 || provenance.retryCount !== 0 ||
      typeof provenance.sourceWorktreeMutated !== "boolean" ||
      typeof provenance.cleanupCompleted !== "boolean") {
    fail("OBSERVED_EVIDENCE_RUN_PROVENANCE_INVALID");
  }

  const task = committedTask(repositoryRoot, manifest.sourceCommit, provenance.pilotId);
  requirePlainObject(provenance.taskDefinition, "OBSERVED_EVIDENCE_TASK_PROVENANCE_INVALID");
  if (provenance.taskDefinition.path !== task.path ||
      provenance.taskDefinition.definitionHash !== task.definitionHash ||
      provenance.taskDefinition.fileHash !== task.fileHash ||
      provenance.taskDefinition.gitBlobHash !== task.blobHash) {
    fail("OBSERVED_EVIDENCE_TASK_PROVENANCE_INVALID");
  }
  const expectedTargets = sourceTargetRecords(repositoryRoot, manifest.sourceCommit, task.definition);
  if (canonicalJson(provenance.sourceTargets) !== canonicalJson(expectedTargets)) {
    fail("OBSERVED_EVIDENCE_SOURCE_TARGET_MISMATCH");
  }

  if (provenance.modelId !== manifest.experimentConfig.modelId ||
      canonicalJson(provenance.provider) !== canonicalJson(manifest.experimentConfig.provider) ||
      canonicalJson(provenance.modelParameters) !==
        canonicalJson(manifest.experimentConfig.modelParameters) ||
      canonicalJson(provenance.runtimeBudget) !==
        canonicalJson(manifest.experimentConfig.runtimeBudget)) {
    fail("OBSERVED_EVIDENCE_CONFIG_MISMATCH");
  }

  const runRoot = dirname(provenanceAbsolute);
  if (!HASH.test(provenance.suppliedContextHash ?? "") ||
      !HASH.test(provenance.providerInstructionHash ?? "")) {
    fail("OBSERVED_EVIDENCE_CONTEXT_PROVENANCE_INVALID");
  }
  const contextBytes = artifactBytes(runRoot, provenance.suppliedContextArtifact);
  let suppliedContext;
  try { suppliedContext = JSON.parse(contextBytes.toString("utf8")); }
  catch { fail("OBSERVED_EVIDENCE_CONTEXT_PROVENANCE_INVALID"); }
  if (hashCanonicalJson(suppliedContext) !== provenance.suppliedContextHash) {
    fail("OBSERVED_EVIDENCE_CONTEXT_HASH_MISMATCH");
  }
  const request = parseJsonFile(
    resolve(runRoot, sanitizeRelativeArtifactPath(provenance.providerRequestArtifact)),
    "OBSERVED_EVIDENCE_PROVIDER_REQUEST_INVALID"
  );
  requirePlainObject(request, "OBSERVED_EVIDENCE_PROVIDER_REQUEST_INVALID");
  if (typeof request.instruction !== "string" ||
      pilotHash(request.instruction) !== request.instructionHash ||
      request.instructionHash !== provenance.providerInstructionHash ||
      request.modelId !== provenance.modelId) {
    fail("OBSERVED_EVIDENCE_PROVIDER_REQUEST_INVALID");
  }
  let instruction;
  try { instruction = JSON.parse(request.instruction); }
  catch { fail("OBSERVED_EVIDENCE_PROVIDER_REQUEST_INVALID"); }
  if (canonicalJson(instruction.workspaceFiles) !== canonicalJson(suppliedContext)) {
    fail("OBSERVED_EVIDENCE_CONTEXT_REQUEST_MISMATCH");
  }
  const reconstructedContext = reconstructSuppliedContext(
    repositoryRoot, manifest.sourceCommit, task.definition
  );
  if (canonicalJson(reconstructedContext) !== canonicalJson(suppliedContext)) {
    fail("OBSERVED_EVIDENCE_CONTEXT_SOURCE_MISMATCH");
  }

  if (provenance.rawCandidateHash !== null) {
    if (!HASH.test(provenance.rawCandidateHash ?? "") ||
        typeof provenance.rawCandidateArtifact !== "string") {
      fail("OBSERVED_EVIDENCE_RAW_CANDIDATE_INVALID");
    }
    const candidate = artifactBytes(runRoot, provenance.rawCandidateArtifact);
    if (sha256Bytes(candidate) !== provenance.rawCandidateHash) {
      fail("OBSERVED_EVIDENCE_RAW_CANDIDATE_HASH_MISMATCH");
    }
  } else if (provenance.rawCandidateArtifact !== null) {
    fail("OBSERVED_EVIDENCE_RAW_CANDIDATE_INVALID");
  }

  if (provenance.materializedPatchHash !== null) {
    if (!HASH.test(provenance.materializedPatchHash ?? "") ||
        typeof provenance.materializedPatchArtifact !== "string") {
      fail("OBSERVED_EVIDENCE_PATCH_INVALID");
    }
    const patch = artifactBytes(runRoot, provenance.materializedPatchArtifact);
    if (sha256Bytes(patch) !== provenance.materializedPatchHash) {
      fail("OBSERVED_EVIDENCE_PATCH_HASH_MISMATCH");
    }
  } else if (provenance.materializedPatchArtifact !== null) {
    fail("OBSERVED_EVIDENCE_PATCH_INVALID");
  }

  validateOutcome(provenance.verifierOutcome, "OBSERVED_EVIDENCE_VERIFIER_OUTCOME_INVALID");
  validateOutcome(provenance.acceptanceOutcome, "OBSERVED_EVIDENCE_ACCEPTANCE_OUTCOME_INVALID");
  if (typeof provenance.acceptanceOutcome.stage !== "string" ||
      provenance.acceptanceOutcome.stage !== task.definition.verificationProfile.at(-1)) {
    fail("OBSERVED_EVIDENCE_ACCEPTANCE_OUTCOME_INVALID");
  }
  if (provenance.status === "completed" &&
      (provenance.verifierOutcome.status !== "passed" ||
       provenance.acceptanceOutcome.status !== "passed" ||
       provenance.failureCode !== null)) {
    fail("OBSERVED_EVIDENCE_OUTCOME_INCONSISTENT");
  }
  if (provenance.status !== "completed" && provenance.failureCode === null) {
    fail("OBSERVED_EVIDENCE_OUTCOME_INCONSISTENT");
  }

  validateTokenCounts(provenance.tokenCounts);
  validateLatency(provenance.latencyMs);
  if (!Array.isArray(provenance.rejectedCandidateArtifacts)) {
    fail("OBSERVED_EVIDENCE_REJECTED_ARTIFACTS_INVALID");
  }
  const rejectedPaths = new Set();
  for (const record of provenance.rejectedCandidateArtifacts) {
    verifyArtifactRecord(runRoot, record);
    if (rejectedPaths.has(record.relativePath)) {
      fail("OBSERVED_EVIDENCE_REJECTED_ARTIFACTS_INVALID");
    }
    rejectedPaths.add(record.relativePath);
  }
  if (provenance.status !== "completed" && provenance.rawCandidateArtifact !== null &&
      !rejectedPaths.has(provenance.rawCandidateArtifact)) {
    fail("OBSERVED_EVIDENCE_REJECTED_CANDIDATE_NOT_PRESERVED");
  }
  if (provenance.status !== "completed" && provenance.materializedPatchArtifact !== null &&
      !rejectedPaths.has(provenance.materializedPatchArtifact)) {
    fail("OBSERVED_EVIDENCE_REJECTED_PATCH_NOT_PRESERVED");
  }

  if (!HASH.test(provenance.pilotReportHash ?? "") ||
      typeof provenance.pilotReportArtifact !== "string") {
    fail("OBSERVED_EVIDENCE_PILOT_REPORT_INVALID");
  }
  const pilotReportBytes = artifactBytes(runRoot, provenance.pilotReportArtifact);
  if (sha256Bytes(pilotReportBytes) !== provenance.pilotReportHash) {
    fail("OBSERVED_EVIDENCE_PILOT_REPORT_HASH_MISMATCH");
  }
  let pilotReport;
  try { pilotReport = JSON.parse(pilotReportBytes.toString("utf8")); }
  catch { fail("OBSERVED_EVIDENCE_PILOT_REPORT_INVALID"); }
  if (pilotReport.pilotId !== provenance.pilotId ||
      pilotReport.sourceCommit !== provenance.sourceCommit ||
      pilotReport.status !== provenance.status ||
      pilotReport.failureCode !== provenance.failureCode ||
      pilotReport.providerCallCount !== provenance.providerCallCount ||
      pilotReport.retryCount !== provenance.retryCount) {
    fail("OBSERVED_EVIDENCE_PILOT_REPORT_MISMATCH");
  }
}

function verifyObservedEvidence({ bundleDir, expectedSourceCommit, repositoryRoot }) {
  if (!COMMIT.test(expectedSourceCommit ?? "")) {
    fail("OBSERVED_EVIDENCE_EXPECTED_COMMIT_INVALID");
  }
  const root = realpathSync(resolve(bundleDir));
  const repo = repositoryRoot
    ? realpathSync(repositoryRoot)
    : realpathSync(gitText(process.cwd(), ["rev-parse", "--show-toplevel"]));
  const manifestPath = join(root, "evidence-manifest.json");
  const manifest = parseJsonFile(manifestPath, "OBSERVED_EVIDENCE_MANIFEST_INVALID");
  requirePlainObject(manifest, "OBSERVED_EVIDENCE_MANIFEST_INVALID");
  if (manifest.schemaVersion !== OBSERVED_EVIDENCE_SCHEMA_VERSION ||
      manifest.sourceCommit !== expectedSourceCommit ||
      !HASH.test(manifest.experimentConfigHash ?? "") ||
      !HASH.test(manifest.evidenceHash ?? "")) {
    fail("OBSERVED_EVIDENCE_MANIFEST_INVALID");
  }
  const { evidenceHash, ...manifestCore } = manifest;
  if (hashCanonicalJson(manifestCore) !== evidenceHash) {
    fail("OBSERVED_EVIDENCE_MANIFEST_HASH_MISMATCH");
  }
  requirePlainObject(manifest.experimentConfig, "OBSERVED_EVIDENCE_CONFIG_INVALID");
  if (manifest.experimentConfig.schemaVersion !== EXPERIMENT_CONFIG_SCHEMA_VERSION ||
      hashCanonicalJson(manifest.experimentConfig) !== manifest.experimentConfigHash ||
      !SAFE_ID.test(manifest.experimentConfig.modelId ?? "")) {
    fail("OBSERVED_EVIDENCE_CONFIG_INVALID");
  }
  gitText(repo, ["cat-file", "-e", `${manifest.sourceCommit}^{commit}`]);

  if (!Array.isArray(manifest.files)) fail("OBSERVED_EVIDENCE_FILE_SET_INVALID");
  manifest.files.forEach(validateFileRecord);
  const actualFiles = enumerateFiles(root, { excludeManifest: true });
  if (canonicalJson(actualFiles) !== canonicalJson(manifest.files)) {
    fail("OBSERVED_EVIDENCE_FILE_SET_MISMATCH");
  }

  if (!Array.isArray(manifest.runs) || manifest.runCount !== REQUIRED_PILOT_IDS.length ||
      manifest.runs.length !== REQUIRED_PILOT_IDS.length) {
    fail("OBSERVED_EVIDENCE_RUN_SET_INVALID");
  }
  const ids = manifest.runs.map((run) => run.pilotId).sort();
  if (canonicalJson(ids) !== canonicalJson(REQUIRED_PILOT_IDS)) {
    fail("OBSERVED_EVIDENCE_RUN_SET_INVALID");
  }
  for (const summary of manifest.runs) {
    verifyRun({ repositoryRoot: repo, bundleRoot: root, manifest, summary });
  }

  return {
    schemaVersion: manifest.schemaVersion,
    sourceCommit: manifest.sourceCommit,
    experimentConfigHash: manifest.experimentConfigHash,
    evidenceHash: manifest.evidenceHash,
    runCount: manifest.runCount,
    outcomes: Object.fromEntries(manifest.runs.map((run) => [run.pilotId, run.status]))
  };
}

module.exports = {
  EXPERIMENT_CONFIG_SCHEMA_VERSION,
  OBSERVED_EVIDENCE_SCHEMA_VERSION,
  OBSERVED_RUN_SCHEMA_VERSION,
  PILOT_DEFINITIONS,
  REQUIRED_PILOT_IDS,
  ObservedEvidenceError,
  canonicalJson,
  committedTask,
  hashCanonicalJson,
  publishObservedEvidence,
  reconstructSuppliedContext,
  sha256Bytes,
  sourceTargetRecords,
  verifyObservedEvidence
};
