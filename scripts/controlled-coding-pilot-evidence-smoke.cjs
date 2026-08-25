#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { hash: pilotHash } = require("./controlled-coding-pilot.cjs");

const root = process.cwd();
const bundler = join(root, "scripts/controlled-coding-pilot-evidence.cjs");
const sourceTarget = join(root, "apps/cli/src/model-worker-runpod-live-smoke.ts");
const temporary = mkdtempSync(join(tmpdir(), "controlled-pilot-evidence-smoke-"));
const redactionSentinel = "evidence-redactionSentinel-must-not-appear";
const head = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root, encoding: "utf8"
}).stdout.trim();
const targetBefore = readFileSync(sourceTarget);
const definitions = {
  "controlled-real-coding-v1.runpod-live-help":
    "pilots/controlled-real-coding-v1/runpod-live-help/task.json",
  "controlled-real-coding-v2.worker-request-id-correlation":
    "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json"
};

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
  const pilotId = overrides.pilotId ?? "controlled-real-coding-v1.runpod-live-help";
  const definition = JSON.parse(readFileSync(join(root, definitions[pilotId]), "utf8"));
  return {
    schemaVersion: "bounded.controlled-coding-pilot-report/v1",
    pilotId,
    status: "completed",
    sourceCommit: head,
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

function writeReportDirectory(name, report = validReport()) {
  const directory = join(temporary, name, "report");
  mkdirSync(join(directory, "nested"), { recursive: true });
  writeFileSync(join(directory, "pilot-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(directory, "generated.patch"), "diff --git a/target b/target\n");
  writeFileSync(join(directory, "nested", "receipt.json"), "{\"ok\":true}\n");
  return directory;
}

function run(reportDir, outDir, expected = head, env = {}, cwd = root) {
  return spawnSync(process.execPath, [
    bundler,
    "--report-dir", reportDir,
    "--out-dir", outDir,
    "--expected-source-commit", expected
  ], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, EVIDENCE_SECRET_SENTINEL: redactionSentinel, ...env },
    timeout: 10_000
  });
}

function v2FixtureRepository(name) {
  const repository = join(temporary, name, "repository");
  const paths = [definitions["controlled-real-coding-v2.worker-request-id-correlation"],
    "packages/worker-contract/src/index.ts", "tests/smoke/contracts.ts"];
  for (const path of paths) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    cpSync(join(root, path), join(repository, path));
  }
  let result = spawnSync("git", ["init", "--quiet"], { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync("git", ["add", "."], { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync("git", ["-c", "user.name=Offline Fixture",
    "-c", "user.email=offline-fixture@example.invalid", "commit", "--quiet", "-m", "fixture"],
  { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repository, encoding: "utf8"
  }).stdout.trim();
  return { repository, commit };
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

  const v2Dir = writeReportDirectory("valid-v2", validReport({
    pilotId: "controlled-real-coding-v2.worker-request-id-correlation",
    patchLineCount: 42
  }));
  const v2Out = join(temporary, "valid-v2", "output");
  const v2 = run(v2Dir, v2Out);
  assert.equal(v2.status, 0, `${v2.stdout}\n${v2.stderr}`);
  assert.match(v2.stdout, /sourceTargetCount=2\n$/);
  const v2Manifest = JSON.parse(readFileSync(join(v2Out, "evidence-manifest.json"), "utf8"));
  assert.equal(v2Manifest.schemaVersion, "bounded.controlled-coding-pilot-evidence/v2");
  assert.deepEqual(v2Manifest.sourceTargets.map((entry) => entry.path), [
    "packages/worker-contract/src/index.ts", "tests/smoke/contracts.ts"
  ]);
  v2Manifest.sourceTargets.forEach((entry) => assert.match(entry.blobHash, /^[0-9a-f]{40,64}$/));
  assert.equal(Object.hasOwn(v2Manifest, "sourceTargetPath"), false);
  assert.equal(Object.hasOwn(v2Manifest, "sourceTargetBlobHash"), false);

  const dirtyTargetFixture = v2FixtureRepository("dirty-v2-target");
  const dirtyTargetPath = join(dirtyTargetFixture.repository,
    "packages/worker-contract/src/index.ts");
  writeFileSync(dirtyTargetPath, `${readFileSync(dirtyTargetPath, "utf8")}\n// dirty fixture\n`);
  const dirtyTargetReport = writeReportDirectory("dirty-v2-target-report", validReport({
    pilotId: "controlled-real-coding-v2.worker-request-id-correlation",
    sourceCommit: dirtyTargetFixture.commit,
    patchLineCount: 42
  }));
  const dirtyTargetOut = join(temporary, "dirty-v2-target-output");
  const dirtyTarget = run(dirtyTargetReport, dirtyTargetOut, dirtyTargetFixture.commit, {},
    dirtyTargetFixture.repository);
  assert.notEqual(dirtyTarget.status, 0);
  assert.match(dirtyTarget.stderr, /errorCode=EVIDENCE_SOURCE_TARGET_COMMIT_MISMATCH/);
  assert.equal(existsSync(dirtyTargetOut), false);

  const dirtyDefinitionFixture = v2FixtureRepository("dirty-v2-definition");
  const dirtyDefinitionPath = join(dirtyDefinitionFixture.repository,
    definitions["controlled-real-coding-v2.worker-request-id-correlation"]);
  writeFileSync(dirtyDefinitionPath,
    `${readFileSync(dirtyDefinitionPath, "utf8")}\n`);
  const dirtyDefinitionReport = writeReportDirectory("dirty-v2-definition-report", validReport({
    pilotId: "controlled-real-coding-v2.worker-request-id-correlation",
    sourceCommit: dirtyDefinitionFixture.commit,
    patchLineCount: 42
  }));
  const dirtyDefinitionOut = join(temporary, "dirty-v2-definition-output");
  const dirtyDefinition = run(dirtyDefinitionReport, dirtyDefinitionOut,
    dirtyDefinitionFixture.commit, {}, dirtyDefinitionFixture.repository);
  assert.notEqual(dirtyDefinition.status, 0);
  assert.match(dirtyDefinition.stderr, /errorCode=EVIDENCE_PILOT_DEFINITION_CHANGED/);
  assert.equal(existsSync(dirtyDefinitionOut), false);

  expectFailure("definition-hash-substitution",
    validReport({ pilotDefinitionHash: `sha256:${"0".repeat(64)}` }),
    "EVIDENCE_PILOT_DEFINITION_MISMATCH");
  expectFailure("unsupported-pilot",
    { ...validReport(), pilotId: "caller-controlled-pilot" },
    "EVIDENCE_PILOT_DEFINITION_UNSUPPORTED");

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
