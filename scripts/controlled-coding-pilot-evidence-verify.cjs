#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync
} = require("node:fs");
const { isAbsolute, join, posix, relative, resolve, sep } = require("node:path");
const { hash: pilotHash, validateDefinition } = require("./controlled-coding-pilot.cjs");

const V1_SCHEMA_VERSION = "bounded.controlled-coding-pilot-evidence/v1";
const V2_SCHEMA_VERSION = "bounded.controlled-coding-pilot-evidence/v2";
const REPORT_SCHEMA_VERSION = "bounded.controlled-coding-pilot-report/v1";
const V1_SOURCE_TARGET = "apps/cli/src/model-worker-runpod-live-smoke.ts";
const PILOT_DEFINITIONS = {
  "controlled-real-coding-v2.worker-request-id-correlation":
    "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json",
  "controlled-real-coding-v2.local-json-schema-error-classification":
    "pilots/controlled-real-coding-v2/local-json-schema-error-classification/task.json"
};
const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BLOB_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

class VerificationError extends Error {
  constructor(code, relativePath) {
    super(code);
    this.code = code;
    this.relativePath = typeof relativePath === "string" && relativePath.length <= 4096 &&
      !CONTROL.test(relativePath) && !isAbsolute(relativePath) &&
      !/^[A-Za-z]:/.test(relativePath) && !relativePath.includes("\\") &&
      !relativePath.split("/").includes("..") ? relativePath : undefined;
  }
}

function fail(code, relativePath) {
  throw new VerificationError(code, relativePath);
}

function parseArguments(argv) {
  const allowed = new Set(["--bundle-dir", "--expected-source-commit"]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith("--")) {
      fail("EVIDENCE_VERIFY_ARGUMENT_INVALID");
    }
    if (Object.hasOwn(parsed, name)) fail("EVIDENCE_VERIFY_ARGUMENT_DUPLICATE");
    parsed[name] = value;
  }
  if (argv.length !== 4 || [...allowed].some((name) => !Object.hasOwn(parsed, name))) {
    fail("EVIDENCE_VERIFY_ARGUMENT_MISSING");
  }
  if (!COMMIT.test(parsed["--expected-source-commit"])) {
    fail("EVIDENCE_VERIFY_EXPECTED_COMMIT_INVALID");
  }
  return {
    bundleDir: parsed["--bundle-dir"],
    expectedSourceCommit: parsed["--expected-source-commit"]
  };
}

function canonicalJson(value, ancestors = new WeakSet()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("EVIDENCE_VERIFY_CANONICAL_JSON_INVALID");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") fail("EVIDENCE_VERIFY_CANONICAL_JSON_INVALID");
  if (ancestors.has(value)) fail("EVIDENCE_VERIFY_CANONICAL_JSON_INVALID");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("EVIDENCE_VERIFY_CANONICAL_JSON_INVALID");
    }
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashCanonicalJson(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function plainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function stableFile(absolute, relativePath) {
  let descriptor;
  try {
    const before = lstatSync(absolute, { bigint: true });
    if (before.isSymbolicLink()) fail("EVIDENCE_VERIFY_SYMLINK_REJECTED", relativePath);
    if (!before.isFile()) fail("EVIDENCE_VERIFY_NON_REGULAR_FILE", relativePath);
    descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      fail("EVIDENCE_VERIFY_FILE_CHANGED", relativePath);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(absolute, { bigint: true });
    if (!sameIdentity(opened, after) || after.size !== BigInt(bytes.length) ||
        !current.isFile() || !sameIdentity(opened, current)) {
      fail("EVIDENCE_VERIFY_FILE_CHANGED", relativePath);
    }
    return { bytes, byteSize: bytes.length, sha256: sha256(bytes), stats: current };
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    fail("EVIDENCE_VERIFY_FILE_MISSING", relativePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function safeTreeRelative(root, absolute) {
  const value = relative(root, absolute).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value) ||
      CONTROL.test(value)) {
    fail("EVIDENCE_VERIFY_UNSAFE_TREE_PATH");
  }
  return value;
}

function enumerateReport(reportRoot) {
  const files = [];
  function visit(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      fail("EVIDENCE_VERIFY_REPORT_TREE_INVALID");
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = safeTreeRelative(reportRoot, absolute);
      let stats;
      try {
        stats = lstatSync(absolute, { bigint: true });
      } catch {
        fail("EVIDENCE_VERIFY_FILE_MISSING", relativePath);
      }
      if (stats.isSymbolicLink()) fail("EVIDENCE_VERIFY_SYMLINK_REJECTED", relativePath);
      if (stats.isDirectory()) visit(absolute);
      else if (stats.isFile()) files.push({ absolute, relativePath, stats });
      else fail("EVIDENCE_VERIFY_NON_REGULAR_FILE", relativePath);
    }
  }
  visit(reportRoot);
  return files.sort((left, right) => left.relativePath < right.relativePath ? -1 : 1);
}

function parseJson(bytes, code, relativePath) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    plainObject(value, code);
    return value;
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    fail(code, relativePath);
  }
}

function validateManifest(manifest) {
  if (manifest.schemaVersion !== V1_SCHEMA_VERSION &&
      manifest.schemaVersion !== V2_SCHEMA_VERSION) {
    fail("EVIDENCE_VERIFY_SCHEMA_UNSUPPORTED");
  }
  if (!HASH.test(manifest.evidenceHash ?? "")) fail("EVIDENCE_VERIFY_HASH_INVALID");
  const { evidenceHash, ...core } = manifest;
  if (hashCanonicalJson(core) !== evidenceHash) fail("EVIDENCE_VERIFY_HASH_MISMATCH");
  if (!SAFE_ID.test(manifest.pilotId ?? "") || !COMMIT.test(manifest.sourceCommit ?? "") ||
      !HASH.test(manifest.pilotDefinitionHash ?? "") || !HASH.test(manifest.reportHash ?? "") ||
      !SAFE_ID.test(manifest.providerKind ?? "") || !MODEL_ID.test(manifest.modelId ?? "") ||
      manifest.providerCallCount !== 1 || manifest.retryCount !== 0 ||
      !Number.isSafeInteger(manifest.patchLineCount) || manifest.patchLineCount < 0) {
    fail("EVIDENCE_VERIFY_MANIFEST_METADATA_INVALID");
  }
  if (manifest.schemaVersion === V1_SCHEMA_VERSION) {
    if (manifest.sourceTargetPath !== V1_SOURCE_TARGET) {
      fail("EVIDENCE_VERIFY_SOURCE_TARGET_PATH_INVALID");
    }
    if (!BLOB_HASH.test(manifest.sourceTargetBlobHash ?? "")) {
      fail("EVIDENCE_VERIFY_SOURCE_TARGET_HASH_INVALID");
    }
  } else {
    if (!Array.isArray(manifest.sourceTargets) || manifest.sourceTargets.length === 0) {
      fail("EVIDENCE_VERIFY_SOURCE_TARGET_LIST_INVALID");
    }
    const paths = new Set();
    for (const target of manifest.sourceTargets) {
      plainObject(target, "EVIDENCE_VERIFY_SOURCE_TARGET_ENTRY_INVALID");
      if (typeof target.path !== "string" || target.path.length === 0 ||
          target.path.length > 4096 || CONTROL.test(target.path) || target.path.includes("\\") ||
          isAbsolute(target.path) || posix.normalize(target.path) !== target.path ||
          target.path === "." || target.path.split("/").includes("..") || paths.has(target.path)) {
        fail("EVIDENCE_VERIFY_SOURCE_TARGET_PATH_INVALID");
      }
      if (!BLOB_HASH.test(target.blobHash ?? "")) {
        fail("EVIDENCE_VERIFY_SOURCE_TARGET_HASH_INVALID");
      }
      paths.add(target.path);
    }
  }
  if (!Array.isArray(manifest.files)) fail("EVIDENCE_VERIFY_FILE_LIST_INVALID");

  const seen = new Set();
  let previous = null;
  for (const entry of manifest.files) {
    plainObject(entry, "EVIDENCE_VERIFY_FILE_ENTRY_INVALID");
    const path = entry.relativePath;
    if (typeof path !== "string" || path.length === 0 || path.length > 4096 ||
        CONTROL.test(path) || path.includes("\\") || isAbsolute(path) ||
        /^[A-Za-z]:/.test(path) || posix.isAbsolute(path) || posix.normalize(path) !== path ||
        path === "." || path.split("/").includes("..")) {
      fail("EVIDENCE_VERIFY_FILE_PATH_INVALID");
    }
    if (seen.has(path)) fail("EVIDENCE_VERIFY_FILE_PATH_DUPLICATE");
    if (previous !== null && previous > path) fail("EVIDENCE_VERIFY_FILE_LIST_UNSORTED");
    seen.add(path);
    previous = path;
    if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0) {
      fail("EVIDENCE_VERIFY_BYTE_SIZE_INVALID", path);
    }
    if (!HASH.test(entry.sha256 ?? "")) fail("EVIDENCE_VERIFY_FILE_HASH_INVALID", path);
  }
}

function validateReport(report) {
  const exact = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "completed",
    providerCallCount: 1,
    retryCount: 0,
    authorityPassed: true,
    verifierPassed: true,
    artifactProduced: true,
    artifactValid: true,
    sourceWorktreeMutated: false,
    githubMutationObserved: false,
    budgetExceeded: false,
    cleanupCompleted: true,
    failureCode: null
  };
  for (const [field, expected] of Object.entries(exact)) {
    if (report[field] !== expected) fail("EVIDENCE_VERIFY_REPORT_GATE_FAILED", "pilot-report.json");
  }
  if (!SAFE_ID.test(report.pilotId ?? "") || !COMMIT.test(report.sourceCommit ?? "") ||
      !HASH.test(report.pilotDefinitionHash ?? "") || !SAFE_ID.test(report.providerKind ?? "") ||
      !MODEL_ID.test(report.modelId ?? "") || !Number.isSafeInteger(report.patchLineCount) ||
      report.patchLineCount < 0) {
    fail("EVIDENCE_VERIFY_REPORT_METADATA_INVALID", "pilot-report.json");
  }
}

function canonicalReportHash(report) {
  if (!Object.hasOwn(report, "reportHash")) return hashCanonicalJson(report);
  const { reportHash, ...core } = report;
  const computed = hashCanonicalJson(core);
  if (!HASH.test(reportHash) || reportHash !== computed) {
    fail("EVIDENCE_VERIFY_REPORT_HASH_INVALID", "pilot-report.json");
  }
  return reportHash;
}

function crossCheck(manifest, report, reportHash, expectedSourceCommit) {
  if (manifest.sourceCommit !== expectedSourceCommit || report.sourceCommit !== expectedSourceCommit) {
    fail("EVIDENCE_VERIFY_SOURCE_COMMIT_MISMATCH");
  }
  const fields = [
    "pilotId", "sourceCommit", "pilotDefinitionHash", "providerKind", "modelId",
    "providerCallCount", "retryCount", "patchLineCount"
  ];
  if (fields.some((field) => manifest[field] !== report[field]) ||
      manifest.reportHash !== reportHash) {
    fail("EVIDENCE_VERIFY_REPORT_MANIFEST_MISMATCH");
  }
}

function localRepositoryRoot(sourceCommit) {
  let repositoryRoot;
  try {
    repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 2_000, maxBuffer: 64_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    execFileSync("git", ["cat-file", "-e", `${sourceCommit}^{commit}`], {
      cwd: repositoryRoot, timeout: 2_000, maxBuffer: 64_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "ignore", "ignore"]
    });
  } catch {
    return undefined;
  }
  return repositoryRoot;
}

function sourceBlobAtCommit(repositoryRoot, sourceCommit, targetPath) {
  try {
    return execFileSync("git", ["rev-parse", `${sourceCommit}:${targetPath}`], {
      cwd: repositoryRoot, encoding: "utf8", timeout: 2_000, maxBuffer: 64_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    fail("EVIDENCE_VERIFY_SOURCE_BLOB_MISMATCH");
  }
}

function verifyV1LocalSourceBlob(sourceCommit, expectedBlobHash) {
  const repositoryRoot = localRepositoryRoot(sourceCommit);
  if (!repositoryRoot) return "unavailable";
  if (sourceBlobAtCommit(repositoryRoot, sourceCommit, V1_SOURCE_TARGET) !== expectedBlobHash) {
    fail("EVIDENCE_VERIFY_SOURCE_BLOB_MISMATCH");
  }
  return "verified";
}

function verifyV2SourceTargets(manifest) {
  const definitionPath = PILOT_DEFINITIONS[manifest.pilotId];
  if (!definitionPath) fail("EVIDENCE_VERIFY_PILOT_DEFINITION_UNSUPPORTED");
  const repositoryRoot = localRepositoryRoot(manifest.sourceCommit);
  if (!repositoryRoot) fail("EVIDENCE_VERIFY_SOURCE_COMMIT_UNAVAILABLE");
  let definition;
  try {
    const bytes = execFileSync("git", ["show", `${manifest.sourceCommit}:${definitionPath}`], {
      cwd: repositoryRoot, encoding: "utf8", timeout: 2_000, maxBuffer: 128_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "ignore"]
    });
    definition = validateDefinition(JSON.parse(bytes));
  } catch {
    fail("EVIDENCE_VERIFY_PILOT_DEFINITION_INVALID");
  }
  if (definition.pilotId !== manifest.pilotId ||
      pilotHash(definition) !== manifest.pilotDefinitionHash) {
    fail("EVIDENCE_VERIFY_PILOT_DEFINITION_MISMATCH");
  }
  if (definition.allowedMutationPaths.length !== manifest.sourceTargets.length ||
      definition.allowedMutationPaths.some(
        (path, index) => path !== manifest.sourceTargets[index].path
      )) {
    fail("EVIDENCE_VERIFY_SOURCE_TARGET_PATH_INVALID");
  }
  for (const target of manifest.sourceTargets) {
    if (sourceBlobAtCommit(repositoryRoot, manifest.sourceCommit, target.path) !== target.blobHash) {
      fail("EVIDENCE_VERIFY_SOURCE_BLOB_MISMATCH");
    }
  }
  return "verified";
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const requestedBundle = resolve(process.cwd(), args.bundleDir);
  let bundleStats;
  try {
    bundleStats = lstatSync(requestedBundle);
  } catch {
    fail("EVIDENCE_VERIFY_BUNDLE_MISSING");
  }
  if (!bundleStats.isDirectory() || bundleStats.isSymbolicLink()) {
    fail("EVIDENCE_VERIFY_BUNDLE_INVALID");
  }
  const bundleRoot = realpathSync(requestedBundle);
  const manifestPath = join(bundleRoot, "evidence-manifest.json");
  const reportPath = join(bundleRoot, "report");
  let reportStats;
  try {
    reportStats = lstatSync(reportPath);
  } catch {
    fail("EVIDENCE_VERIFY_REPORT_DIRECTORY_MISSING");
  }
  if (!reportStats.isDirectory() || reportStats.isSymbolicLink()) {
    fail("EVIDENCE_VERIFY_REPORT_DIRECTORY_INVALID");
  }

  const manifestSnapshot = stableFile(manifestPath, "evidence-manifest.json");
  const manifest = parseJson(manifestSnapshot.bytes, "EVIDENCE_VERIFY_MANIFEST_JSON_INVALID",
    "evidence-manifest.json");
  validateManifest(manifest);

  const reportRoot = realpathSync(reportPath);
  const actualFiles = enumerateReport(reportRoot);
  const actualPaths = actualFiles.map((file) => file.relativePath);
  const listedPaths = manifest.files.map((entry) => entry.relativePath);
  if (actualPaths.length !== listedPaths.length ||
      actualPaths.some((path, index) => path !== listedPaths[index])) {
    fail("EVIDENCE_VERIFY_FILE_SET_MISMATCH");
  }

  const snapshots = actualFiles.map((file) => stableFile(file.absolute, file.relativePath));
  for (let index = 0; index < manifest.files.length; index += 1) {
    const expected = manifest.files[index];
    const actual = snapshots[index];
    if (actual.byteSize !== expected.byteSize) {
      fail("EVIDENCE_VERIFY_BYTE_SIZE_MISMATCH", expected.relativePath);
    }
    if (actual.sha256 !== expected.sha256) {
      fail("EVIDENCE_VERIFY_FILE_HASH_MISMATCH", expected.relativePath);
    }
  }

  const reportIndex = actualPaths.indexOf("pilot-report.json");
  if (reportIndex < 0) fail("EVIDENCE_VERIFY_PILOT_REPORT_MISSING");
  const report = parseJson(snapshots[reportIndex].bytes, "EVIDENCE_VERIFY_REPORT_JSON_INVALID",
    "pilot-report.json");
  validateReport(report);
  const reportHash = canonicalReportHash(report);
  crossCheck(manifest, report, reportHash, args.expectedSourceCommit);

  const finalFiles = enumerateReport(reportRoot);
  if (finalFiles.length !== actualFiles.length || finalFiles.some((file, index) =>
    file.relativePath !== actualFiles[index].relativePath ||
    !sameIdentity(file.stats, actualFiles[index].stats))) {
    fail("EVIDENCE_VERIFY_REPORT_TREE_CHANGED");
  }
  for (let index = 0; index < finalFiles.length; index += 1) {
    const finalSnapshot = stableFile(finalFiles[index].absolute, finalFiles[index].relativePath);
    if (finalSnapshot.byteSize !== snapshots[index].byteSize ||
        finalSnapshot.sha256 !== snapshots[index].sha256) {
      fail("EVIDENCE_VERIFY_REPORT_TREE_CHANGED");
    }
  }
  const finalManifest = stableFile(manifestPath, "evidence-manifest.json");
  if (!sameIdentity(finalManifest.stats, manifestSnapshot.stats) ||
      finalManifest.byteSize !== manifestSnapshot.byteSize ||
      finalManifest.sha256 !== manifestSnapshot.sha256) {
    fail("EVIDENCE_VERIFY_MANIFEST_CHANGED");
  }
  const sourceBlobVerification = manifest.schemaVersion === V1_SCHEMA_VERSION
    ? verifyV1LocalSourceBlob(manifest.sourceCommit, manifest.sourceTargetBlobHash)
    : verifyV2SourceTargets(manifest);

  process.stdout.write([
    "EVIDENCE_VERIFY=PASS",
    `sourceCommit=${manifest.sourceCommit}`,
    `reportHash=${manifest.reportHash}`,
    `evidenceHash=${manifest.evidenceHash}`,
    `fileCount=${manifest.files.length}`,
    ...(manifest.schemaVersion === V1_SCHEMA_VERSION
      ? [`sourceTargetBlobHash=${manifest.sourceTargetBlobHash}`]
      : [`sourceTargetsHash=${hashCanonicalJson(manifest.sourceTargets)}`]),
    `sourceBlobVerification=${sourceBlobVerification}`
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  const code = error instanceof VerificationError ? error.code : "EVIDENCE_VERIFY_INTERNAL_ERROR";
  process.stderr.write(`EVIDENCE_VERIFY=FAIL\nerrorCode=${code}\n`);
  if (error instanceof VerificationError && error.relativePath) {
    process.stderr.write(`relativePath=${error.relativePath}\n`);
  }
  process.exitCode = 1;
}
