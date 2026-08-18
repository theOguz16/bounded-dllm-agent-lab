#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const root = process.cwd();
const bundler = join(root, "scripts/controlled-coding-pilot-evidence.cjs");
const sourceTarget = join(root, "apps/cli/src/model-worker-runpod-live-smoke.ts");
const temporary = mkdtempSync(join(tmpdir(), "controlled-pilot-evidence-smoke-"));
const redactionSentinel = "evidence-redactionSentinel-must-not-appear";
const head = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root, encoding: "utf8"
}).stdout.trim();
const targetBefore = readFileSync(sourceTarget);

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validReport(overrides = {}) {
  return {
    schemaVersion: "bounded.controlled-coding-pilot-report/v1",
    pilotId: "controlled-real-coding-v1.runpod-live-help",
    status: "completed",
    sourceCommit: head,
    pilotDefinitionHash: `sha256:${"1".repeat(64)}`,
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

function writeReportDirectory(name, report = validReport()) {
  const directory = join(temporary, name, "report");
  mkdirSync(join(directory, "nested"), { recursive: true });
  writeFileSync(join(directory, "pilot-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(directory, "generated.patch"), "diff --git a/target b/target\n");
  writeFileSync(join(directory, "nested", "receipt.json"), "{\"ok\":true}\n");
  return directory;
}

function run(reportDir, outDir, expected = head, env = {}) {
  return spawnSync(process.execPath, [
    bundler,
    "--report-dir", reportDir,
    "--out-dir", outDir,
    "--expected-source-commit", expected
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, EVIDENCE_SECRET_SENTINEL: redactionSentinel, ...env },
    timeout: 10_000
  });
}

function expectFailure(name, report, code = "EVIDENCE_REPORT_GATE_FAILED") {
  const reportDir = writeReportDirectory(name, report);
  const outDir = join(temporary, name, "output");
  const result = run(reportDir, outDir);
  assert.notEqual(result.status, 0, name);
  assert.match(result.stderr, new RegExp(`errorCode=${code}`), name);
  assert.equal(result.stderr.includes(redactionSentinel), false, `${name} exposed redactionSentinel`);
  assert.equal(existsSync(outDir), false, `${name} left partial output`);
}

try {
  const validDir = writeReportDirectory("valid");
  const nestedOut = join(validDir, "bundled-evidence");
  const first = run(validDir, nestedOut);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /^EVIDENCE_BUNDLE=PASS\n/);
  assert.equal(first.stdout.trim().split("\n").length, 6);
  assert.equal(first.stdout.includes(redactionSentinel), false);
  const firstManifestBytes = readFileSync(join(nestedOut, "evidence-manifest.json"));
  const firstManifest = JSON.parse(firstManifestBytes);
  assert.equal(firstManifest.schemaVersion, "bounded.controlled-coding-pilot-evidence/v1");
  assert.equal(firstManifest.sourceCommit, head);
  assert.equal(firstManifest.providerCallCount, 1);
  assert.equal(firstManifest.retryCount, 0);
  assert.equal(firstManifest.patchLineCount, 18);
  assert.equal(firstManifest.sourceTargetPath,
    "apps/cli/src/model-worker-runpod-live-smoke.ts");
  assert.match(firstManifest.sourceTargetBlobHash, /^[0-9a-f]{40,64}$/);
  assert.match(firstManifest.reportHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(firstManifest.evidenceHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(firstManifest.files.map((entry) => entry.relativePath), [
    "generated.patch", "nested/receipt.json", "pilot-report.json"
  ]);
  for (const entry of firstManifest.files) {
    assert.equal(Number.isSafeInteger(entry.byteSize) && entry.byteSize >= 0, true);
    assert.match(entry.sha256, /^sha256:[0-9a-f]{64}$/);
  }
  const { evidenceHash, ...manifestCore } = firstManifest;
  assert.equal(evidenceHash, hash(Buffer.from(canonical(manifestCore), "utf8")));
  const serialized = firstManifestBytes.toString("utf8");
  assert.equal(serialized.includes(temporary), false);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes("bundled-evidence"), false);
  assert.deepEqual(
    readFileSync(join(nestedOut, "report", "generated.patch")),
    readFileSync(join(validDir, "generated.patch"))
  );

  const second = run(validDir, nestedOut);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const secondManifestBytes = readFileSync(join(nestedOut, "evidence-manifest.json"));
  assert.deepEqual(secondManifestBytes, firstManifestBytes);
  assert.equal(JSON.parse(secondManifestBytes).evidenceHash, evidenceHash);

  const malformedDir = writeReportDirectory("malformed");
  writeFileSync(join(malformedDir, "pilot-report.json"), "{not-json\n");
  const malformedOut = join(temporary, "malformed", "output");
  const malformed = run(malformedDir, malformedOut);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /errorCode=EVIDENCE_REPORT_JSON_INVALID/);
  assert.equal(existsSync(malformedOut), false);

  for (const [name, overrides] of [
    ["failed-status", { status: "failed" }],
    ["provider-count", { providerCallCount: 2 }],
    ["retry-count", { retryCount: 1 }],
    ["authority", { authorityPassed: false }],
    ["verifier", { verifierPassed: false }],
    ["artifact-produced", { artifactProduced: false }],
    ["artifact-valid", { artifactValid: false }],
    ["source-mutated", { sourceWorktreeMutated: true }],
    ["github-mutated", { githubMutationObserved: true }],
    ["budget", { budgetExceeded: true }],
    ["cleanup", { cleanupCompleted: false }],
    ["failure-code", { failureCode: "PILOT_VERIFICATION_FAILED" }]
  ]) {
    expectFailure(name, validReport(overrides));
  }

  const expectedMismatchDir = writeReportDirectory("expected-mismatch");
  const expectedMismatchOut = join(temporary, "expected-mismatch", "output");
  const expectedMismatch = run(expectedMismatchDir, expectedMismatchOut, "0".repeat(40));
  assert.notEqual(expectedMismatch.status, 0);
  assert.match(expectedMismatch.stderr, /errorCode=EVIDENCE_EXPECTED_COMMIT_MISMATCH/);
  assert.equal(existsSync(expectedMismatchOut), false);

  expectFailure("report-commit", validReport({ sourceCommit: "0".repeat(40) }),
    "EVIDENCE_SOURCE_COMMIT_MISMATCH");

  const symlinkDir = writeReportDirectory("symlink");
  symlinkSync(join(symlinkDir, "generated.patch"), join(symlinkDir, "linked.patch"));
  const symlinkOut = join(temporary, "symlink", "output");
  const symlink = run(symlinkDir, symlinkOut);
  assert.notEqual(symlink.status, 0);
  assert.match(symlink.stderr, /errorCode=EVIDENCE_SYMLINK_REJECTED/);
  assert.match(symlink.stderr, /relativePath=linked\.patch/);
  assert.equal(existsSync(symlinkOut), false);

  const preservedDir = writeReportDirectory("preserved-output");
  const preservedOut = join(temporary, "preserved-output", "output");
  mkdirSync(preservedOut, { recursive: true });
  writeFileSync(join(preservedOut, "sentinel.txt"), "previous-valid-output\n");
  writeFileSync(join(preservedDir, "pilot-report.json"), "malformed");
  const preserved = run(preservedDir, preservedOut);
  assert.notEqual(preserved.status, 0);
  assert.equal(readFileSync(join(preservedOut, "sentinel.txt"), "utf8"),
    "previous-valid-output\n");

  assert.deepEqual(readFileSync(sourceTarget), targetBefore);
  const policy = readFileSync(join(root, "bounded-agent.policy.yml"), "utf8");
  assert.match(policy, /^  - scripts\/controlled-coding-pilot-evidence\.cjs$/m);
  assert.match(policy, /^  - scripts\/controlled-coding-pilot-evidence-smoke\.cjs$/m);
  assert.doesNotMatch(policy, /^  - scripts\/\*\*$/m);

  process.stdout.write("controlled coding pilot evidence smoke: PASS\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
