#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { hash: pilotHash } = require("./controlled-coding-pilot.cjs");

const root = process.cwd();
const pilotId = "controlled-real-coding-v2.local-json-schema-error-classification";
const definitionPath =
  "pilots/controlled-real-coding-v2/local-json-schema-error-classification/task.json";
const bundler = join(root, "scripts/controlled-coding-pilot-evidence.cjs");
const verifier = join(root, "scripts/controlled-coding-pilot-evidence-verify.cjs");
const temporary = mkdtempSync(join(tmpdir(), "controlled-pilot-local-json-evidence-"));

function run(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, NODE_OPTIONS: "" }
  });
}

function git(args) {
  const result = run("git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

try {
  const head = git(["rev-parse", "HEAD"]);
  const definition = JSON.parse(readFileSync(join(root, definitionPath), "utf8"));
  assert.equal(definition.pilotId, pilotId);
  assert.equal(definition.limits.providerCallBudget, 1);
  assert.equal(definition.limits.retryBudget, 0);
  assert.deepEqual(definition.authority.allowedMutationPaths, [
    "packages/integrations/src/local-openai-compatible-model-client.ts",
    "tests/smoke/contracts.ts"
  ]);

  const sourceBefore = Object.fromEntries(definition.authority.allowedMutationPaths.map(
    (path) => [path, readFileSync(join(root, path))]
  ));
  const reportDir = join(temporary, "report");
  const bundleDir = join(temporary, "bundle");
  mkdirSync(reportDir, { recursive: true });

  const report = {
    schemaVersion: "bounded.controlled-coding-pilot-report/v1",
    pilotId,
    status: "completed",
    sourceCommit: head,
    pilotDefinitionHash: pilotHash(definition),
    providerKind: "offline-fixture",
    modelId: "fixture-model",
    providerCallCount: 1,
    retryCount: 0,
    patchLineCount: 24,
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
  writeFileSync(join(reportDir, "pilot-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(reportDir, "generated.patch"),
    "diff --git a/local-json b/local-json\n");

  const bundled = run(process.execPath, [
    bundler,
    "--report-dir", reportDir,
    "--out-dir", bundleDir,
    "--expected-source-commit", head
  ]);
  assert.equal(bundled.status, 0, `${bundled.stdout}\n${bundled.stderr}`);
  assert.match(bundled.stdout, /^EVIDENCE_BUNDLE=PASS\n/);
  assert.match(bundled.stdout, /sourceTargetCount=2\n$/);

  const manifest = JSON.parse(readFileSync(join(bundleDir, "evidence-manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, "bounded.controlled-coding-pilot-evidence/v2");
  assert.equal(manifest.pilotId, pilotId);
  assert.deepEqual(manifest.sourceTargets.map((entry) => entry.path),
    definition.authority.allowedMutationPaths);

  const verified = run(process.execPath, [
    verifier,
    "--bundle-dir", bundleDir,
    "--expected-source-commit", head
  ]);
  assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
  assert.match(verified.stdout, /^EVIDENCE_VERIFY=PASS\n/);
  assert.match(verified.stdout, /sourceBlobVerification=verified\n$/);

  for (const path of definition.authority.allowedMutationPaths) {
    assert.deepEqual(readFileSync(join(root, path)), sourceBefore[path]);
  }
  assert.equal(git(["status", "--porcelain"]), "");

  process.stdout.write("controlled local-json evidence smoke: PASS\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
