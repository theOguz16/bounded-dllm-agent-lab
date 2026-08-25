#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, relative } = require("node:path");
const { hash: pilotHash } = require("./controlled-coding-pilot.cjs");

const root = process.cwd();
const generator = join(root, "scripts/controlled-coding-pilot-acceptance.cjs");
const bundler = join(root, "scripts/controlled-coding-pilot-evidence.cjs");
const temporary = mkdtempSync(join(tmpdir(), "controlled-pilot-acceptance-smoke-"));
const secretSentinel = "acceptance-secret-sentinel-must-not-appear";
const llamaCommit = "52b3df002";
const head = git(["rev-parse", "HEAD"]);

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

function validReport(sourceCommit = head, pilotVersion = 1) {
  const definitionPath = pilotVersion === 1
    ? "pilots/controlled-real-coding-v1/runpod-live-help/task.json"
    : "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json";
  const definition = JSON.parse(readFileSync(join(root, definitionPath), "utf8"));
  return {
    schemaVersion: "bounded.controlled-coding-pilot-report/v1",
    pilotId: definition.pilotId,
    status: "completed",
    sourceCommit,
    pilotDefinitionHash: pilotHash(definition),
    providerKind: "existing-runpod-openai-compatible-model-worker",
    modelId: "qwen2.5-coder-7b",
    providerCallCount: 1,
    retryCount: 0,
    patchLineCount: pilotVersion === 1 ? 18 : 42,
    authorityPassed: true,
    verifierPassed: true,
    artifactProduced: true,
    artifactValid: true,
    sourceWorktreeMutated: false,
    githubMutationObserved: false,
    budgetExceeded: false,
    cleanupCompleted: true,
    failureCode: null,
    lifecycle: ["pilot.started", "pilot.finished"]
  };
}

function writeCanonical(path, value) {
  writeFileSync(path, `${canonicalJson(value)}\n`);
}

function createBundledTemplate(pilotVersion = 1) {
  const reportRoot = join(temporary, `source-report-v${pilotVersion}`);
  const bundle = join(temporary, `template-bundle-v${pilotVersion}`);
  mkdirSync(join(reportRoot, "nested"), { recursive: true });
  writeCanonical(join(reportRoot, "pilot-report.json"), validReport(head, pilotVersion));
  writeFileSync(join(reportRoot, "generated.patch"), "diff --git a/target b/target\n");
  writeFileSync(join(reportRoot, "nested", "receipt.json"), "{\"ok\":true}\n");
  const result = spawnSync(process.execPath, [
    bundler,
    "--report-dir", reportRoot,
    "--out-dir", bundle,
    "--expected-source-commit", head
  ], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return bundle;
}

function cloneBundle(name, template) {
  const bundle = join(temporary, name);
  cpSync(template, bundle, { recursive: true, preserveTimestamps: true });
  return bundle;
}

function run(bundle, output, options = {}) {
  const args = [
    generator,
    "--bundle-dir", bundle,
    "--expected-source-commit", options.expected ?? head,
    "--llama-build", options.build ?? "9754",
    "--llama-commit", options.commit ?? llamaCommit,
    "--out", output,
    ...(options.extraArgs ?? [])
  ];
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ACCEPTANCE_SECRET_SENTINEL: secretSentinel, ...(options.env ?? {}) },
    timeout: 15_000
  });
}

function assertSafeOutput(result, name) {
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(output.includes(secretSentinel), false, `${name}: secret exposed`);
  assert.equal(output.includes(temporary), false, `${name}: temporary path exposed`);
  assert.equal(output.includes(root), false, `${name}: repository path exposed`);
}

function expectFailure(name, bundle, output, code, options = {}) {
  const result = run(bundle, output, options);
  assert.notEqual(result.status, 0, `${name}: unexpectedly passed`);
  assert.match(result.stderr, /^ACCEPTANCE_RECORD=FAIL\n/);
  assert.match(result.stderr, new RegExp(`errorCode=${code}(?:\\n|$)`), name);
  assert.equal(existsSync(output), options.preserveExisting === true, `${name}: partial output state`);
  assertSafeOutput(result, name);
  return result;
}

function evidenceSnapshot(bundle) {
  const records = [];
  const roots = [join(bundle, "evidence-manifest.json"), join(bundle, "report")];
  function visit(absolute) {
    const stats = statSync(absolute, { bigint: true });
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) visit(join(absolute, entry));
      return;
    }
    records.push({
      path: relative(bundle, absolute).split("\\").join("/"),
      bytes: readFileSync(absolute).toString("base64"),
      mode: stats.mode.toString(),
      mtimeNs: stats.mtimeNs.toString()
    });
  }
  roots.forEach(visit);
  return records;
}

function rebuildBundle(bundle, mutateReport) {
  const reportPath = join(bundle, "report", "pilot-report.json");
  const manifestPath = join(bundle, "evidence-manifest.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  mutateReport(report);
  writeCanonical(reportPath, report);
  const reportBytes = readFileSync(reportPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.sourceCommit = report.sourceCommit;
  manifest.reportHash = canonicalHash(report);
  const record = manifest.files.find((entry) => entry.relativePath === "pilot-report.json");
  record.byteSize = reportBytes.length;
  record.sha256 = sha256(reportBytes);
  delete manifest.evidenceHash;
  manifest.evidenceHash = canonicalHash(manifest);
  writeCanonical(manifestPath, manifest);
}

function addEvidenceFile(bundle) {
  const reportRoot = join(bundle, "report");
  const manifestPath = join(bundle, "evidence-manifest.json");
  const relativePath = "additional-receipt.txt";
  const bytes = Buffer.from("additional verified evidence\n", "utf8");
  writeFileSync(join(reportRoot, relativePath), bytes);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files.push({ relativePath, byteSize: bytes.length, sha256: sha256(bytes) });
  manifest.files.sort((left, right) => left.relativePath < right.relativePath ? -1 : 1);
  delete manifest.evidenceHash;
  manifest.evidenceHash = canonicalHash(manifest);
  writeCanonical(manifestPath, manifest);
}

function acceptanceCore(record) {
  const { acceptanceHash, ...core } = record;
  return core;
}

try {
  const refsBefore = git(["for-each-ref", "--format=%(refname):%(objectname)"]);
  const template = createBundledTemplate();

  const valid = cloneBundle("valid", template);
  const validOutput = join(valid, "acceptance-record.json");
  const bundleBefore = evidenceSnapshot(valid);
  const first = run(valid, validOutput);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /^ACCEPTANCE_RECORD=PASS\n/);
  assert.match(first.stdout, /sourceBlobVerification=verified\n$/);
  assert.equal(first.stdout.trim().split("\n").length, 9);
  assertSafeOutput(first, "valid");
  const firstBytes = readFileSync(validOutput);
  const firstRecord = JSON.parse(firstBytes);
  assert.equal(firstRecord.schemaVersion, "bounded.controlled-coding-pilot-evidence/v1");
  assert.equal(firstRecord.sourceCommit, head);
  assert.equal(firstRecord.runtime.kind, "llama.cpp");
  assert.equal(firstRecord.runtime.build, 9754);
  assert.equal(firstRecord.runtime.commit, llamaCommit);
  assert.deepEqual(firstRecord.verification, {
    evidenceVerified: true,
    sourceBlobVerification: "verified"
  });
  assert.deepEqual(firstRecord.acceptance, { finalGatePassed: true, mergeEligible: true });
  assert.equal(firstRecord.acceptanceHash, canonicalHash(acceptanceCore(firstRecord)));
  const verifiedManifest = JSON.parse(readFileSync(join(valid, "evidence-manifest.json")));
  for (const field of [
    "schemaVersion", "pilotId", "sourceCommit", "pilotDefinitionHash", "reportHash",
    "evidenceHash", "providerKind", "modelId", "providerCallCount", "retryCount",
    "patchLineCount", "sourceTargetPath", "sourceTargetBlobHash"
  ]) {
    assert.deepEqual(firstRecord[field], verifiedManifest[field], `${field} was not evidence-derived`);
  }
  assert.deepEqual(evidenceSnapshot(valid), bundleBefore, "bundle evidence changed");

  const repeated = run(valid, validOutput);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(readFileSync(validOutput), firstBytes, "repeated record bytes changed");
  assert.equal(JSON.parse(readFileSync(validOutput)).acceptanceHash, firstRecord.acceptanceHash);
  assert.deepEqual(evidenceSnapshot(valid), bundleBefore, "repeat changed bundle evidence");

  const v2Template = createBundledTemplate(2);
  const validV2 = cloneBundle("valid-v2", v2Template);
  const validV2Output = join(validV2, "acceptance-record.json");
  const acceptedV2 = run(validV2, validV2Output);
  assert.equal(acceptedV2.status, 0, `${acceptedV2.stdout}\n${acceptedV2.stderr}`);
  const v2Record = JSON.parse(readFileSync(validV2Output, "utf8"));
  assert.equal(v2Record.schemaVersion, "bounded.controlled-coding-pilot-evidence/v2");
  assert.deepEqual(v2Record.sourceTargets.map((entry) => entry.path), [
    "packages/worker-contract/src/index.ts", "tests/smoke/contracts.ts"
  ]);
  assert.equal(Object.hasOwn(v2Record, "sourceTargetPath"), false);
  assert.equal(v2Record.acceptanceHash, canonicalHash(acceptanceCore(v2Record)));

  const verifierFailure = cloneBundle("verifier-failure", template);
  const verifierFailureOutput = join(verifierFailure, "acceptance-record.json");
  writeFileSync(join(verifierFailure, "report", "generated.patch"), "tampered\n");
  expectFailure("verifier failure", verifierFailure, verifierFailureOutput,
    "ACCEPTANCE_EVIDENCE_VERIFICATION_FAILED");

  const wrongCommitBundle = cloneBundle("wrong-expected", template);
  expectFailure("wrong expected source commit", wrongCommitBundle,
    join(wrongCommitBundle, "acceptance-record.json"),
    "ACCEPTANCE_EVIDENCE_VERIFICATION_FAILED", { expected: "0".repeat(40) });

  const tampered = cloneBundle("tampered-evidence", template);
  const tamperedManifest = JSON.parse(readFileSync(join(tampered, "evidence-manifest.json")));
  tamperedManifest.evidenceHash = `sha256:${"0".repeat(64)}`;
  writeCanonical(join(tampered, "evidence-manifest.json"), tamperedManifest);
  expectFailure("tampered evidence", tampered, join(tampered, "acceptance-record.json"),
    "ACCEPTANCE_EVIDENCE_VERIFICATION_FAILED");

  for (const [name, build] of [
    ["non-integer build", "1.5"], ["text build", "abc"], ["zero build", "0"],
    ["negative build", "-1"], ["unsafe integer build", "999999999999999999999"]
  ]) {
    const bundle = cloneBundle(name.replaceAll(" ", "-"), template);
    expectFailure(name, bundle, join(bundle, "acceptance-record.json"),
      "ACCEPTANCE_LLAMA_BUILD_INVALID", { build });
  }

  for (const [name, commit] of [
    ["malformed llama commit", "abc-1234"], ["too-short llama commit", "abcdef"],
    ["too-long llama commit", "a".repeat(41)]
  ]) {
    const bundle = cloneBundle(name.replaceAll(" ", "-"), template);
    expectFailure(name, bundle, join(bundle, "acceptance-record.json"),
      "ACCEPTANCE_LLAMA_COMMIT_INVALID", { commit });
  }

  const overrideBundle = cloneBundle("derived-override", template);
  expectFailure("evidence-derived override", overrideBundle,
    join(overrideBundle, "acceptance-record.json"), "ACCEPTANCE_ARGUMENT_INVALID",
    { extraArgs: ["--model-id", "overridden-model"] });

  const unavailableCommit = head === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40);
  const unavailable = cloneBundle("unavailable", template);
  rebuildBundle(unavailable, (report) => { report.sourceCommit = unavailableCommit; });
  const unavailableOutput = join(unavailable, "acceptance-record.json");
  const unavailableResult = run(unavailable, unavailableOutput, { expected: unavailableCommit });
  assert.equal(unavailableResult.status, 0, unavailableResult.stderr);
  const unavailableRecord = JSON.parse(readFileSync(unavailableOutput));
  assert.equal(unavailableRecord.verification.evidenceVerified, true);
  assert.equal(unavailableRecord.verification.sourceBlobVerification, "unavailable");
  assert.match(unavailableResult.stdout, /sourceBlobVerification=unavailable\n$/);
  assertSafeOutput(unavailableResult, "unavailable");

  const runtimeChanged = cloneBundle("runtime-changed", template);
  const runtimeOutput = join(runtimeChanged, "acceptance-record.json");
  const runtimeResult = run(runtimeChanged, runtimeOutput, { build: "9755", commit: "ABCDEF1" });
  assert.equal(runtimeResult.status, 0, runtimeResult.stderr);
  const runtimeRecord = JSON.parse(readFileSync(runtimeOutput));
  assert.notEqual(runtimeRecord.acceptanceHash, firstRecord.acceptanceHash);
  assert.equal(runtimeRecord.runtime.commit, "ABCDEF1", "llama commit was silently changed");

  const evidenceChanged = cloneBundle("evidence-changed", template);
  addEvidenceFile(evidenceChanged);
  const evidenceChangedOutput = join(evidenceChanged, "acceptance-record.json");
  const evidenceChangedResult = run(evidenceChanged, evidenceChangedOutput);
  assert.equal(evidenceChangedResult.status, 0, evidenceChangedResult.stderr);
  const evidenceChangedRecord = JSON.parse(readFileSync(evidenceChangedOutput));
  assert.equal(evidenceChangedRecord.reportHash, firstRecord.reportHash);
  assert.notEqual(evidenceChangedRecord.evidenceHash, firstRecord.evidenceHash);
  assert.notEqual(evidenceChangedRecord.acceptanceHash, firstRecord.acceptanceHash);

  const manifestOverwrite = cloneBundle("manifest-overwrite", template);
  const manifestPath = join(manifestOverwrite, "evidence-manifest.json");
  const manifestBefore = readFileSync(manifestPath);
  const manifestOverwriteResult = run(manifestOverwrite, manifestPath);
  assert.notEqual(manifestOverwriteResult.status, 0);
  assert.match(manifestOverwriteResult.stderr, /errorCode=ACCEPTANCE_OUTPUT_UNSAFE/);
  assert.deepEqual(readFileSync(manifestPath), manifestBefore);
  assertSafeOutput(manifestOverwriteResult, "manifest overwrite");

  const reportOutput = cloneBundle("report-output", template);
  expectFailure("output under report", reportOutput,
    join(reportOutput, "report", "acceptance-record.json"), "ACCEPTANCE_OUTPUT_UNSAFE");

  const preserved = cloneBundle("preserved-output", template);
  const preservedOutput = join(preserved, "acceptance-record.json");
  writeFileSync(preservedOutput, "previous-record\n");
  writeFileSync(join(preserved, "report", "generated.patch"), "tampered\n");
  expectFailure("existing output preserved", preserved, preservedOutput,
    "ACCEPTANCE_EVIDENCE_VERIFICATION_FAILED", { preserveExisting: true });
  assert.equal(readFileSync(preservedOutput, "utf8"), "previous-record\n");

  const generatorSource = readFileSync(generator, "utf8");
  assert.doesNotMatch(generatorSource, /https?:\/\//);
  assert.doesNotMatch(generatorSource, /\b(?:curl|gh)\b/);
  const refsAfter = git(["for-each-ref", "--format=%(refname):%(objectname)"]);
  assert.equal(refsAfter, refsBefore, "git refs changed during offline smoke tests");

  const policy = readFileSync(join(root, "bounded-agent.policy.yml"), "utf8");
  assert.equal((policy.match(/^  - scripts\/controlled-coding-pilot-acceptance\.cjs$/gm) ?? [])
    .length, 1);
  assert.equal((policy.match(/^  - scripts\/controlled-coding-pilot-acceptance-smoke\.cjs$/gm) ?? [])
    .length, 1);
  assert.doesNotMatch(policy, /^  - scripts\/\*\*$/m);

  process.stdout.write("controlled coding pilot acceptance smoke: PASS\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
