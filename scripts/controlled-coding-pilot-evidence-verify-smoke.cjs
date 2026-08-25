#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, unlinkSync, writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, relative } = require("node:path");
const { hash: pilotHash } = require("./controlled-coding-pilot.cjs");

const root = process.cwd();
const verifier = join(root, "scripts/controlled-coding-pilot-evidence-verify.cjs");
const bundler = join(root, "scripts/controlled-coding-pilot-evidence.cjs");
const temporary = mkdtempSync(join(tmpdir(), "controlled-pilot-evidence-verify-smoke-"));
const secretSentinel = "verify-secret-sentinel-must-not-appear";
const head = git(["rev-parse", "HEAD"]);
const sourceTarget = "apps/cli/src/model-worker-runpod-live-smoke.ts";
const sourceTargetBlobHash = git(["rev-parse", `${head}:${sourceTarget}`]);
const v2SourceTargets = [
  "packages/worker-contract/src/index.ts", "tests/smoke/contracts.ts"
].map((path) => ({ path, blobHash: git(["rev-parse", `${head}:${path}`]) }));
const definitionPaths = {
  "controlled-real-coding-v1.runpod-live-help":
    "pilots/controlled-real-coding-v1/runpod-live-help/task.json",
  "controlled-real-coding-v2.worker-request-id-correlation":
    "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json"
};

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

function canonicalHash(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function validReport(sourceCommit = head, overrides = {}) {
  const pilotId = overrides.pilotId ?? "controlled-real-coding-v1.runpod-live-help";
  const definition = JSON.parse(readFileSync(join(root, definitionPaths[pilotId]), "utf8"));
  return {
    schemaVersion: "bounded.controlled-coding-pilot-report/v1",
    pilotId,
    status: "completed",
    sourceCommit,
    pilotDefinitionHash: pilotHash(definition),
    providerKind: "existing-runpod-openai-compatible-model-worker",
    modelId: "qwen2.5-coder-7b",
    providerCallCount: 1,
    retryCount: 0,
    patchLineCount: 18,
    authorityPassed: true,
    verifierPassed: true,
    artifactProduced: true,
    artifactValid: true,
    sourceWorktreeMutated: false,
    githubMutationObserved: false,
    budgetExceeded: false,
    cleanupCompleted: true,
    failureCode: null,
    lifecycle: ["pilot.started", "pilot.finished"],
    ...overrides
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${canonicalJson(value)}\n`);
}

function fileRecord(reportRoot, relativePath) {
  const bytes = readFileSync(join(reportRoot, ...relativePath.split("/")));
  return { relativePath, byteSize: bytes.length, sha256: sha256(bytes) };
}

function writeManifest(bundle, manifest) {
  const { evidenceHash: ignored, ...core } = manifest;
  writeJson(join(bundle, "evidence-manifest.json"), {
    ...core,
    evidenceHash: canonicalHash(core)
  });
}

function makeBundle(name, {
  sourceCommit = head, blobHash = sourceTargetBlobHash, pilotVersion = 1
} = {}) {
  const bundle = join(temporary, name);
  const reportRoot = join(bundle, "report");
  mkdirSync(join(reportRoot, "nested"), { recursive: true });
  const report = validReport(sourceCommit, pilotVersion === 2 ? {
    pilotId: "controlled-real-coding-v2.worker-request-id-correlation",
    patchLineCount: 42
  } : {});
  writeJson(join(reportRoot, "pilot-report.json"), report);
  writeFileSync(join(reportRoot, "generated.patch"), "diff --git a/target b/target\n");
  writeFileSync(join(reportRoot, "nested", "receipt.json"), "{\"ok\":true}\n");
  const files = ["generated.patch", "nested/receipt.json", "pilot-report.json"]
    .map((path) => fileRecord(reportRoot, path));
  const manifest = {
    schemaVersion: pilotVersion === 1
      ? "bounded.controlled-coding-pilot-evidence/v1"
      : "bounded.controlled-coding-pilot-evidence/v2",
    pilotId: report.pilotId,
    sourceCommit: report.sourceCommit,
    pilotDefinitionHash: report.pilotDefinitionHash,
    reportHash: canonicalHash(report),
    providerKind: report.providerKind,
    modelId: report.modelId,
    providerCallCount: report.providerCallCount,
    retryCount: report.retryCount,
    patchLineCount: report.patchLineCount,
    ...(pilotVersion === 1
      ? { sourceTargetPath: sourceTarget, sourceTargetBlobHash: blobHash }
      : { sourceTargets: v2SourceTargets.map((target) => ({ ...target })) }),
    files
  };
  writeManifest(bundle, manifest);
  return bundle;
}

function cloneBundle(name, source) {
  const destination = join(temporary, name);
  cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  return destination;
}

function readManifest(bundle) {
  return JSON.parse(readFileSync(join(bundle, "evidence-manifest.json"), "utf8"));
}

function mutateManifest(bundle, mutation, rehash = true) {
  const manifest = readManifest(bundle);
  mutation(manifest);
  if (rehash) writeManifest(bundle, manifest);
  else writeJson(join(bundle, "evidence-manifest.json"), manifest);
}

function replaceReport(bundle, mutation, { syncManifestHash = true } = {}) {
  const reportPath = join(bundle, "report", "pilot-report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  mutation(report);
  writeJson(reportPath, report);
  mutateManifest(bundle, (manifest) => {
    const index = manifest.files.findIndex((entry) => entry.relativePath === "pilot-report.json");
    manifest.files[index] = fileRecord(join(bundle, "report"), "pilot-report.json");
    if (syncManifestHash) {
      const { reportHash, ...core } = report;
      manifest.reportHash = reportHash === undefined ? canonicalHash(report) : canonicalHash(core);
    }
  });
}

function run(bundle, expectedSourceCommit = head) {
  return spawnSync(process.execPath, [
    verifier,
    "--bundle-dir", bundle,
    "--expected-source-commit", expectedSourceCommit
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, EVIDENCE_VERIFY_SECRET: secretSentinel },
    timeout: 10_000
  });
}

function assertSafeOutput(result, name) {
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(output.includes(secretSentinel), false, `${name}: secret exposed`);
  assert.equal(output.includes(temporary), false, `${name}: temporary path exposed`);
  assert.equal(output.includes(root), false, `${name}: repository path exposed`);
}

function expectFailure(name, bundle, code, expectedSourceCommit = head) {
  const result = run(bundle, expectedSourceCommit);
  assert.notEqual(result.status, 0, `${name}: unexpectedly passed`);
  assert.match(result.stderr, /^EVIDENCE_VERIFY=FAIL\n/);
  assert.match(result.stderr, new RegExp(`errorCode=${code}(?:\\n|$)`), name);
  assertSafeOutput(result, name);
}

function snapshotTree(rootPath) {
  const snapshot = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const path = relative(rootPath, absolute).split("\\").join("/");
      const stats = statSync(absolute, { bigint: true });
      if (entry.isDirectory()) visit(absolute);
      else snapshot.push({
        path,
        bytes: readFileSync(absolute).toString("base64"),
        mode: stats.mode.toString(),
        mtimeNs: stats.mtimeNs.toString()
      });
    }
  }
  visit(rootPath);
  return snapshot;
}

try {
  const valid = makeBundle("valid");
  const before = snapshotTree(valid);
  const first = run(valid);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /^EVIDENCE_VERIFY=PASS\n/);
  assert.match(first.stdout, new RegExp(`sourceCommit=${head}\\n`));
  assert.match(first.stdout, /sourceBlobVerification=verified\n$/);
  assert.equal(first.stdout.trim().split("\n").length, 7);
  assertSafeOutput(first, "valid");
  const second = run(valid);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout, "repeated verification was not deterministic");
  assert.deepEqual(snapshotTree(valid), before, "verifier mutated the bundle");

  const legacyV1 = cloneBundle("legacy-v1-pilot-id", valid);
  replaceReport(legacyV1, (report) => { report.pilotId = "historical-v1-fixture"; });
  mutateManifest(legacyV1, (manifest) => { manifest.pilotId = "historical-v1-fixture"; });
  const legacyV1Result = run(legacyV1);
  assert.equal(legacyV1Result.status, 0, legacyV1Result.stderr);
  assert.match(legacyV1Result.stdout, /sourceTargetBlobHash=/);

  const validV2 = makeBundle("valid-v2", { pilotVersion: 2 });
  const validV2Result = run(validV2);
  assert.equal(validV2Result.status, 0, `${validV2Result.stdout}\n${validV2Result.stderr}`);
  assert.match(validV2Result.stdout, /sourceTargetsHash=sha256:[0-9a-f]{64}\n/);
  assert.match(validV2Result.stdout, /sourceBlobVerification=verified\n$/);
  expectFailure("v2 expected source mismatch", validV2,
    "EVIDENCE_VERIFY_SOURCE_COMMIT_MISMATCH", "0".repeat(40));

  const bundlerOutput = join(temporary, "bundler-produced");
  const bundled = spawnSync(process.execPath, [
    bundler,
    "--report-dir", join(valid, "report"),
    "--out-dir", bundlerOutput,
    "--expected-source-commit", head
  ], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(bundled.status, 0, `${bundled.stdout}\n${bundled.stderr}`);
  const bundledVerification = run(bundlerOutput);
  assert.equal(bundledVerification.status, 0,
    `${bundledVerification.stdout}\n${bundledVerification.stderr}`);
  assert.match(bundledVerification.stdout, /sourceBlobVerification=verified\n$/);
  assertSafeOutput(bundledVerification, "bundler-produced bundle");

  expectFailure("missing bundle", join(temporary, "absent"),
    "EVIDENCE_VERIFY_BUNDLE_MISSING");

  const missingManifest = cloneBundle("missing-manifest", valid);
  unlinkSync(join(missingManifest, "evidence-manifest.json"));
  expectFailure("missing manifest", missingManifest, "EVIDENCE_VERIFY_FILE_MISSING");

  const malformedManifest = cloneBundle("malformed-manifest", valid);
  writeFileSync(join(malformedManifest, "evidence-manifest.json"), "{not-json\n");
  expectFailure("malformed manifest", malformedManifest,
    "EVIDENCE_VERIFY_MANIFEST_JSON_INVALID");

  const unsupportedSchema = cloneBundle("unsupported-schema", valid);
  mutateManifest(unsupportedSchema, (manifest) => { manifest.schemaVersion = "unsupported/v2"; });
  expectFailure("unsupported schema", unsupportedSchema, "EVIDENCE_VERIFY_SCHEMA_UNSUPPORTED");

  const tamperedManifest = cloneBundle("tampered-manifest", valid);
  mutateManifest(tamperedManifest, (manifest) => { manifest.pilotId = "tampered"; }, false);
  expectFailure("tampered manifest", tamperedManifest, "EVIDENCE_VERIFY_HASH_MISMATCH");

  const tamperedEvidenceHash = cloneBundle("tampered-evidence-hash", valid);
  mutateManifest(tamperedEvidenceHash,
    (manifest) => { manifest.evidenceHash = `sha256:${"0".repeat(64)}`; }, false);
  expectFailure("tampered evidence hash", tamperedEvidenceHash,
    "EVIDENCE_VERIFY_HASH_MISMATCH");

  const tamperedReport = cloneBundle("tampered-report", valid);
  writeFileSync(join(tamperedReport, "report", "pilot-report.json"), "tampered\n");
  expectFailure("tampered report", tamperedReport, "EVIDENCE_VERIFY_BYTE_SIZE_MISMATCH");

  const changedSize = cloneBundle("changed-size", valid);
  mutateManifest(changedSize, (manifest) => { manifest.files[0].byteSize += 1; });
  expectFailure("changed byteSize", changedSize, "EVIDENCE_VERIFY_BYTE_SIZE_MISMATCH");

  const changedHash = cloneBundle("changed-hash", valid);
  mutateManifest(changedHash,
    (manifest) => { manifest.files[0].sha256 = `sha256:${"0".repeat(64)}`; });
  expectFailure("changed sha256", changedHash, "EVIDENCE_VERIFY_FILE_HASH_MISMATCH");

  const missingFile = cloneBundle("missing-file", valid);
  unlinkSync(join(missingFile, "report", "generated.patch"));
  expectFailure("missing file", missingFile, "EVIDENCE_VERIFY_FILE_SET_MISMATCH");

  const extraFile = cloneBundle("extra-file", valid);
  writeFileSync(join(extraFile, "report", "extra.txt"), "unexpected\n");
  expectFailure("extra file", extraFile, "EVIDENCE_VERIFY_FILE_SET_MISMATCH");

  const duplicatePath = cloneBundle("duplicate-path", valid);
  mutateManifest(duplicatePath, (manifest) => { manifest.files.push({ ...manifest.files[2] }); });
  expectFailure("duplicate path", duplicatePath, "EVIDENCE_VERIFY_FILE_PATH_DUPLICATE");

  const unsortedPaths = cloneBundle("unsorted-paths", valid);
  mutateManifest(unsortedPaths, (manifest) => { manifest.files.reverse(); });
  expectFailure("unsorted paths", unsortedPaths, "EVIDENCE_VERIFY_FILE_LIST_UNSORTED");

  const absolutePath = cloneBundle("absolute-path", valid);
  mutateManifest(absolutePath, (manifest) => { manifest.files[0].relativePath = "/etc/passwd"; });
  expectFailure("absolute path", absolutePath, "EVIDENCE_VERIFY_FILE_PATH_INVALID");

  const traversalPath = cloneBundle("traversal-path", valid);
  mutateManifest(traversalPath,
    (manifest) => { manifest.files[0].relativePath = "../generated.patch"; });
  expectFailure("traversal path", traversalPath, "EVIDENCE_VERIFY_FILE_PATH_INVALID");

  const symlink = cloneBundle("symlink", valid);
  symlinkSync("generated.patch", join(symlink, "report", "linked.patch"));
  expectFailure("symlink", symlink, "EVIDENCE_VERIFY_SYMLINK_REJECTED");

  const malformedReport = cloneBundle("malformed-report", valid);
  writeFileSync(join(malformedReport, "report", "pilot-report.json"), "{not-json\n");
  mutateManifest(malformedReport, (manifest) => {
    const index = manifest.files.findIndex((entry) => entry.relativePath === "pilot-report.json");
    manifest.files[index] = fileRecord(join(malformedReport, "report"), "pilot-report.json");
  });
  expectFailure("malformed report", malformedReport, "EVIDENCE_VERIFY_REPORT_JSON_INVALID");

  const failedPilot = cloneBundle("failed-pilot", valid);
  replaceReport(failedPilot, (report) => { report.status = "failed"; });
  expectFailure("failed pilot", failedPilot, "EVIDENCE_VERIFY_REPORT_GATE_FAILED");

  const metadataMismatch = cloneBundle("metadata-mismatch", valid);
  replaceReport(metadataMismatch, (report) => { report.pilotId = "different-pilot"; });
  expectFailure("metadata mismatch", metadataMismatch,
    "EVIDENCE_VERIFY_REPORT_MANIFEST_MISMATCH");

  expectFailure("expected source mismatch", valid, "EVIDENCE_VERIFY_SOURCE_COMMIT_MISMATCH",
    "0".repeat(40));

  const wrongReportHash = cloneBundle("wrong-report-hash", valid);
  replaceReport(wrongReportHash, (report) => {
    report.reportHash = `sha256:${"0".repeat(64)}`;
  }, { syncManifestHash: false });
  expectFailure("wrong reportHash", wrongReportHash, "EVIDENCE_VERIFY_REPORT_HASH_INVALID");

  const wrongTargetPath = cloneBundle("wrong-target-path", valid);
  mutateManifest(wrongTargetPath, (manifest) => { manifest.sourceTargetPath = "apps/other.ts"; });
  expectFailure("wrong source target path", wrongTargetPath,
    "EVIDENCE_VERIFY_SOURCE_TARGET_PATH_INVALID");

  const malformedBlobHash = cloneBundle("malformed-blob-hash", valid);
  mutateManifest(malformedBlobHash, (manifest) => { manifest.sourceTargetBlobHash = "not-a-hash"; });
  expectFailure("malformed source target blob hash", malformedBlobHash,
    "EVIDENCE_VERIFY_SOURCE_TARGET_HASH_INVALID");

  const unavailableCommit = "f".repeat(40) === head ? "e".repeat(40) : "f".repeat(40);
  const unavailable = makeBundle("unavailable", { sourceCommit: unavailableCommit });
  const unavailableResult = run(unavailable, unavailableCommit);
  assert.equal(unavailableResult.status, 0, unavailableResult.stderr);
  assert.match(unavailableResult.stdout, /sourceBlobVerification=unavailable\n$/);
  assertSafeOutput(unavailableResult, "unavailable commit");

  const wrongLocalBlob = makeBundle("wrong-local-blob", { blobHash: "0".repeat(40) });
  expectFailure("local blob mismatch", wrongLocalBlob,
    "EVIDENCE_VERIFY_SOURCE_BLOB_MISMATCH");

  for (let index = 0; index < v2SourceTargets.length; index += 1) {
    const mismatch = cloneBundle(`v2-target-${index}-mismatch`, validV2);
    mutateManifest(mismatch, (manifest) => {
      manifest.sourceTargets[index].blobHash = "0".repeat(40);
    });
    expectFailure(`v2 target ${index} mismatch`, mismatch,
      "EVIDENCE_VERIFY_SOURCE_BLOB_MISMATCH");
  }

  const substitutedV2Path = cloneBundle("v2-substituted-path", validV2);
  mutateManifest(substitutedV2Path, (manifest) => {
    manifest.sourceTargets[0].path = "apps/cli/src/model-worker-runpod-live-smoke.ts";
  });
  expectFailure("v2 substituted path", substitutedV2Path,
    "EVIDENCE_VERIFY_SOURCE_TARGET_PATH_INVALID");

  const wrongV2DefinitionHash = cloneBundle("v2-definition-hash", validV2);
  replaceReport(wrongV2DefinitionHash, (report) => {
    report.pilotDefinitionHash = `sha256:${"0".repeat(64)}`;
  });
  mutateManifest(wrongV2DefinitionHash, (manifest) => {
    manifest.pilotDefinitionHash = `sha256:${"0".repeat(64)}`;
  });
  expectFailure("v2 definition hash mismatch", wrongV2DefinitionHash,
    "EVIDENCE_VERIFY_PILOT_DEFINITION_MISMATCH");

  const policy = readFileSync(join(root, "bounded-agent.policy.yml"), "utf8");
  assert.equal((policy.match(/^  - scripts\/controlled-coding-pilot-evidence-verify\.cjs$/gm) ?? [])
    .length, 1);
  assert.equal((policy.match(/^  - scripts\/controlled-coding-pilot-evidence-verify-smoke\.cjs$/gm) ?? [])
    .length, 1);
  assert.doesNotMatch(policy, /^  - scripts\/\*\*$/m);

  process.stdout.write("controlled coding pilot evidence verifier smoke: PASS\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
