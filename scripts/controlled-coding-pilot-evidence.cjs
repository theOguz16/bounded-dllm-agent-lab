#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync
} = require("node:fs");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { hash: pilotHash, validateDefinition } = require("./controlled-coding-pilot.cjs");

const V1_SCHEMA_VERSION = "bounded.controlled-coding-pilot-evidence/v1";
const V2_SCHEMA_VERSION = "bounded.controlled-coding-pilot-evidence/v2";
const REPORT_SCHEMA_VERSION = "bounded.controlled-coding-pilot-report/v1";
const PILOT_DEFINITIONS = {
  "controlled-real-coding-v1.runpod-live-help": {
    path: "pilots/controlled-real-coding-v1/runpod-live-help/task.json",
    evidenceSchemaVersion: V1_SCHEMA_VERSION
  },
  "controlled-real-coding-v2.worker-request-id-correlation": {
    path: "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json",
    evidenceSchemaVersion: V2_SCHEMA_VERSION
  }
};
const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

class EvidenceError extends Error {
  constructor(code, relativePath) {
    super(code);
    this.code = code;
    this.relativePath = relativePath;
  }
}

function fail(code, relativePath) {
  throw new EvidenceError(code, relativePath);
}

function parseArguments(argv) {
  const allowed = new Set([
    "--report-dir", "--out-dir", "--expected-source-commit"
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith("--")) {
      fail("EVIDENCE_ARGUMENT_INVALID");
    }
    if (Object.hasOwn(parsed, name)) fail("EVIDENCE_ARGUMENT_DUPLICATE");
    parsed[name] = value;
  }
  if (argv.length !== 6 || [...allowed].some((name) => !Object.hasOwn(parsed, name))) {
    fail("EVIDENCE_ARGUMENT_MISSING");
  }
  if (!COMMIT.test(parsed["--expected-source-commit"])) {
    fail("EVIDENCE_EXPECTED_COMMIT_INVALID");
  }
  return {
    reportDir: parsed["--report-dir"],
    outDir: parsed["--out-dir"],
    expectedSourceCommit: parsed["--expected-source-commit"]
  };
}

function canonicalJson(value, ancestors = new WeakSet()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("EVIDENCE_CANONICAL_JSON_INVALID");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") fail("EVIDENCE_CANONICAL_JSON_INVALID");
  if (ancestors.has(value)) fail("EVIDENCE_CANONICAL_JSON_INVALID");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("EVIDENCE_CANONICAL_JSON_INVALID");
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

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      maxBuffer: 1_000_000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    fail("EVIDENCE_GIT_VALIDATION_FAILED");
  }
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function safeRelative(root, absolute) {
  const value = relative(root, absolute).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value) ||
      CONTROL.test(value)) {
    fail("EVIDENCE_UNSAFE_RELATIVE_PATH");
  }
  return value;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function enumerateFiles(reportRoot, excludedOutput) {
  const files = [];
  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = safeRelative(reportRoot, absolute);
      let stats;
      try {
        stats = lstatSync(absolute, { bigint: true });
      } catch {
        fail("EVIDENCE_FILE_DISAPPEARED", relativePath);
      }
      if (stats.isSymbolicLink()) fail("EVIDENCE_SYMLINK_REJECTED", relativePath);
      if (excludedOutput && isWithin(excludedOutput, absolute)) {
        if (!stats.isDirectory()) fail("EVIDENCE_OUTPUT_INVALID");
        continue;
      }
      if (stats.isDirectory()) {
        visit(absolute);
      } else if (stats.isFile()) {
        files.push({ absolute, relativePath, stats });
      } else {
        fail("EVIDENCE_NON_REGULAR_FILE_REJECTED", relativePath);
      }
    }
  }
  visit(reportRoot);
  return files.sort((left, right) => left.relativePath < right.relativePath ? -1 : 1);
}

function readStableFile(file) {
  let descriptor;
  try {
    descriptor = openSync(file.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(file.stats, opened)) {
      fail("EVIDENCE_FILE_CHANGED", file.relativePath);
    }
    const bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(opened, afterRead) || afterRead.size !== BigInt(bytes.length)) {
      fail("EVIDENCE_FILE_CHANGED", file.relativePath);
    }
    const current = lstatSync(file.absolute, { bigint: true });
    if (!current.isFile() || !sameIdentity(opened, current)) {
      fail("EVIDENCE_FILE_CHANGED", file.relativePath);
    }
    return {
      bytes,
      byteSize: bytes.length,
      sha256: sha256(bytes)
    };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    fail("EVIDENCE_FILE_DISAPPEARED", file.relativePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseReport(bytes) {
  let report;
  try {
    report = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("EVIDENCE_REPORT_JSON_INVALID", "pilot-report.json");
  }
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    fail("EVIDENCE_REPORT_INVALID", "pilot-report.json");
  }
  return report;
}

function validateReport(report, head, expectedSourceCommit) {
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
    if (report[field] !== expected) fail("EVIDENCE_REPORT_GATE_FAILED", "pilot-report.json");
  }
  if (report.sourceCommit !== head || report.sourceCommit !== expectedSourceCommit ||
      head !== expectedSourceCommit) {
    fail("EVIDENCE_SOURCE_COMMIT_MISMATCH", "pilot-report.json");
  }
  if (!SAFE_ID.test(report.pilotId ?? "") || !HASH.test(report.pilotDefinitionHash ?? "") ||
      !SAFE_ID.test(report.providerKind ?? "") || !MODEL_ID.test(report.modelId ?? "") ||
      !Number.isSafeInteger(report.patchLineCount) || report.patchLineCount < 0) {
    fail("EVIDENCE_REPORT_METADATA_INVALID", "pilot-report.json");
  }
}

function canonicalReportHash(report) {
  if (!Object.hasOwn(report, "reportHash")) return hashCanonicalJson(report);
  const { reportHash, ...core } = report;
  const computed = hashCanonicalJson(core);
  if (!HASH.test(reportHash) || reportHash !== computed) {
    fail("EVIDENCE_REPORT_HASH_INVALID", "pilot-report.json");
  }
  return reportHash;
}

function committedBlobHash(root, sourceCommit, path) {
  const hash = git(root, ["rev-parse", `${sourceCommit}:${path}`]);
  if (!/^[0-9a-f]{40,64}$/.test(hash)) fail("EVIDENCE_SOURCE_TARGET_HASH_INVALID");
  return hash;
}

function requireWorkingTreeBlob(root, path, committedHash, mismatchCode) {
  if (sourceTargetBlobHash(root, path) !== committedHash) fail(mismatchCode);
}

function validatedPilot(root, report) {
  const trusted = PILOT_DEFINITIONS[report.pilotId];
  if (!trusted) fail("EVIDENCE_PILOT_DEFINITION_UNSUPPORTED");
  let definition;
  try {
    const definitionBytes = trusted.evidenceSchemaVersion === V2_SCHEMA_VERSION
      ? git(root, ["show", `${report.sourceCommit}:${trusted.path}`])
      : readFileSync(join(root, trusted.path), "utf8");
    definition = validateDefinition(JSON.parse(definitionBytes));
  } catch {
    fail("EVIDENCE_PILOT_DEFINITION_INVALID");
  }
  if (trusted.evidenceSchemaVersion === V2_SCHEMA_VERSION) {
    const definitionBlobHash = committedBlobHash(root, report.sourceCommit, trusted.path);
    requireWorkingTreeBlob(root, trusted.path, definitionBlobHash,
      "EVIDENCE_PILOT_DEFINITION_CHANGED");
  }
  if (definition.pilotId !== report.pilotId || pilotHash(definition) !== report.pilotDefinitionHash) {
    fail("EVIDENCE_PILOT_DEFINITION_MISMATCH");
  }
  return { ...trusted, definition };
}

function sourceTargetBlobHash(root, sourceTarget) {
  const target = join(root, sourceTarget);
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    fail("EVIDENCE_SOURCE_TARGET_MISSING");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) fail("EVIDENCE_SOURCE_TARGET_INVALID");
  const hash = git(root, ["hash-object", "--", sourceTarget]);
  if (!/^[0-9a-f]{40,64}$/.test(hash)) fail("EVIDENCE_SOURCE_TARGET_HASH_INVALID");
  return hash;
}

function validateOutputLocation(repositoryRoot, reportRoot, requestedOutDir) {
  const lexical = resolve(repositoryRoot, requestedOutDir);
  mkdirSync(dirname(lexical), { recursive: true });
  const parent = realpathSync(dirname(lexical));
  const output = join(parent, basename(lexical));
  if (output === parent || isWithin(output, repositoryRoot) || isWithin(output, reportRoot)) {
    fail("EVIDENCE_OUTPUT_LOCATION_UNSAFE");
  }
  if (existsSync(output)) {
    const stats = lstatSync(output);
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail("EVIDENCE_OUTPUT_INVALID");
  }
  return output;
}

function sourceTargetRecords(root, sourceCommit, pilot) {
  return pilot.definition.allowedMutationPaths.map((path) => {
    if (pilot.evidenceSchemaVersion === V1_SCHEMA_VERSION) {
      return { path, blobHash: sourceTargetBlobHash(root, path) };
    }
    const blobHash = committedBlobHash(root, sourceCommit, path);
    requireWorkingTreeBlob(root, path, blobHash, "EVIDENCE_SOURCE_TARGET_COMMIT_MISMATCH");
    return { path, blobHash };
  });
}

function verifyInputs(root, head, pilot, sourceTargets, files, records) {
  if (git(root, ["rev-parse", "HEAD"]) !== head) fail("EVIDENCE_SOURCE_HEAD_CHANGED");
  if (pilot.evidenceSchemaVersion === V2_SCHEMA_VERSION) {
    const definitionBlobHash = committedBlobHash(root, head, pilot.path);
    requireWorkingTreeBlob(root, pilot.path, definitionBlobHash,
      "EVIDENCE_PILOT_DEFINITION_CHANGED");
  }
  for (const target of sourceTargets) {
    if (sourceTargetBlobHash(root, target.path) !== target.blobHash) {
      fail("EVIDENCE_SOURCE_TARGET_CHANGED");
    }
  }
  for (let index = 0; index < files.length; index += 1) {
    const current = readStableFile(files[index]);
    if (current.byteSize !== records[index].byteSize ||
        current.sha256 !== records[index].sha256) {
      fail("EVIDENCE_FILE_CHANGED", files[index].relativePath);
    }
  }
}

function commitOutput(output, stagingRoot, stagedBundle, verify) {
  const backup = join(stagingRoot, "previous-output");
  let previousMoved = false;
  let newInstalled = false;
  try {
    if (existsSync(output)) {
      renameSync(output, backup);
      previousMoved = true;
    }
    renameSync(stagedBundle, output);
    newInstalled = true;
    verify();
    if (previousMoved) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (newInstalled) rmSync(output, { recursive: true, force: true });
    if (previousMoved && existsSync(backup)) renameSync(backup, output);
    throw error;
  }
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const repositoryRoot = realpathSync(git(process.cwd(), ["rev-parse", "--show-toplevel"]));
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (head !== args.expectedSourceCommit) fail("EVIDENCE_EXPECTED_COMMIT_MISMATCH");

  const requestedReport = resolve(repositoryRoot, args.reportDir);
  let reportStats;
  try {
    reportStats = lstatSync(requestedReport);
  } catch {
    fail("EVIDENCE_REPORT_DIRECTORY_MISSING");
  }
  if (!reportStats.isDirectory() || reportStats.isSymbolicLink()) {
    fail("EVIDENCE_REPORT_DIRECTORY_INVALID");
  }
  const reportRoot = realpathSync(requestedReport);
  const output = validateOutputLocation(repositoryRoot, reportRoot, args.outDir);
  const excludedOutput = isWithin(reportRoot, output) ? output : undefined;
  const files = enumerateFiles(reportRoot, excludedOutput);
  const reportIndex = files.findIndex((file) => file.relativePath === "pilot-report.json");
  if (reportIndex < 0) fail("EVIDENCE_PILOT_REPORT_MISSING");

  const snapshots = files.map(readStableFile);
  const report = parseReport(snapshots[reportIndex].bytes);
  validateReport(report, head, args.expectedSourceCommit);
  const pilot = validatedPilot(repositoryRoot, report);
  const sourceTargets = sourceTargetRecords(repositoryRoot, head, pilot);
  const reportHash = canonicalReportHash(report);

  const stagingRoot = mkdtempSync(join(dirname(output), `.${basename(output)}.tmp-`));
  const stagedBundle = join(stagingRoot, "bundle");
  let committed = false;
  try {
    mkdirSync(join(stagedBundle, "report"), { recursive: true });
    const records = files.map((file, index) => {
      const destination = join(stagedBundle, "report", ...file.relativePath.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, snapshots[index].bytes);
      return {
        relativePath: file.relativePath,
        byteSize: snapshots[index].byteSize,
        sha256: snapshots[index].sha256
      };
    });
    const manifestCore = {
      schemaVersion: pilot.evidenceSchemaVersion,
      pilotId: report.pilotId,
      sourceCommit: report.sourceCommit,
      pilotDefinitionHash: report.pilotDefinitionHash,
      reportHash,
      providerKind: report.providerKind,
      modelId: report.modelId,
      providerCallCount: report.providerCallCount,
      retryCount: report.retryCount,
      patchLineCount: report.patchLineCount,
      ...(pilot.evidenceSchemaVersion === V1_SCHEMA_VERSION ? {
        sourceTargetPath: sourceTargets[0].path,
        sourceTargetBlobHash: sourceTargets[0].blobHash
      } : { sourceTargets }),
      files: records
    };
    const evidenceHash = hashCanonicalJson(manifestCore);
    const manifest = { ...manifestCore, evidenceHash };
    writeFileSync(join(stagedBundle, "evidence-manifest.json"), `${canonicalJson(manifest)}\n`);

    const verify = () => verifyInputs(repositoryRoot, head, pilot, sourceTargets, files, records);
    verify();
    commitOutput(output, stagingRoot, stagedBundle, verify);
    committed = true;
    rmSync(stagingRoot, { recursive: true, force: true });
    process.stdout.write([
      "EVIDENCE_BUNDLE=PASS",
      `sourceCommit=${head}`,
      `reportHash=${reportHash}`,
      `evidenceHash=${evidenceHash}`,
      `fileCount=${records.length}`,
      ...(pilot.evidenceSchemaVersion === V1_SCHEMA_VERSION
        ? [`sourceTargetBlobHash=${sourceTargets[0].blobHash}`]
        : [`sourceTargetCount=${sourceTargets.length}`])
    ].join("\n") + "\n");
  } finally {
    if (!committed) rmSync(stagingRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const code = error instanceof EvidenceError ? error.code : "EVIDENCE_INTERNAL_ERROR";
  process.stderr.write(`EVIDENCE_BUNDLE=FAIL\nerrorCode=${code}\n`);
  if (error instanceof EvidenceError && error.relativePath) {
    process.stderr.write(`relativePath=${error.relativePath}\n`);
  }
  process.exitCode = 1;
}
