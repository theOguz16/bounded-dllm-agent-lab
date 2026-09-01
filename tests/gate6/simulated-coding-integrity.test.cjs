#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FAILURE_CODES,
  PROPOSAL_VERSION,
  createGate6SimulatedCodingHarness
} = require("../../scripts/lib/gate6-simulated-coding-harness.cjs");
const {
  createDisposableWorkspaceFactory,
  sha256
} = require("../../scripts/lib/gate6-simulated-workspace.cjs");

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

const task = Object.freeze({
  schemaVersion: "gate6-task/v1",
  taskId: "fixture.integrity",
  repositoryId: "fixture/repo",
  commitSha: "a".repeat(40),
  taskClass: "bugfix_with_regression",
  difficulty: "medium",
  objective: "Restore calculate behavior.",
  candidateFiles: ["src/main.js", "test/main.test.js"],
  authority: {
    allowedInspectionPaths: ["src/**", "test/**"],
    forbiddenInspectionPaths: [],
    allowedChangePaths: ["src/**"]
  }
});

function proposal() {
  const before = "export function calculate__GATE6_FAULT(){return 1;}\n";
  return {
    schemaVersion: PROPOSAL_VERSION,
    action: "patch",
    edits: [{
      path: "src/main.js",
      expectedContentHash: sha256(before),
      oldText: "calculate__GATE6_FAULT",
      newText: "calculate"
    }],
    summary: "Repair fault."
  };
}

function fingerprint(files) {
  return {
    schemaVersion: "gate6-workspace-content-fingerprint/v1",
    files: [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([filePath, content]) => ({
      path: filePath,
      state: "present",
      byteLength: Buffer.byteLength(content),
      contentHash: sha256(content)
    }))
  };
}

function memoryFactory() {
  return {
    async create() {
      const baseline = new Map([
        ["src/main.js", "export function calculate__GATE6_FAULT(){return 1;}\n"],
        ["test/main.test.js", "calculate regression\n"]
      ]);
      const files = new Map(baseline);
      return {
        workspaceId: "integrity-memory",
        async read(filePath) { return files.get(filePath); },
        async write(filePath, content) { files.set(filePath, content); },
        async changedFiles() {
          const result = ["src/main.js"];
          for (const [filePath, content] of files) {
            if (!baseline.has(filePath) || baseline.get(filePath) !== content) result.push(filePath);
          }
          return [...new Set(result)].sort();
        },
        async contentFingerprint() { return fingerprint(files); },
        async repositorySnapshot() {
          return {
            schemaVersion: "gate6-repository-snapshot/v1",
            repositoryId: task.repositoryId,
            commitSha: task.commitSha,
            files: task.candidateFiles.map((filePath) => ({ path: filePath, content: files.get(filePath) }))
          };
        },
        async rollback() {
          files.clear();
          for (const [filePath, content] of baseline) files.set(filePath, content);
          return true;
        },
        async assertOriginalRepositoryUnchanged() {
          return { measured: false, unchanged: null, beforeHash: null, afterHash: null };
        },
        async dispose() { return true; }
      };
    }
  };
}

function makeHarness(relevantTestRunner, acceptanceRunner = async () => true) {
  return createGate6SimulatedCodingHarness({
    workspaceFactory: memoryFactory(),
    contextResolver: ({ strategy }) => ({
      strategy,
      context: "{}",
      contextBytes: 2,
      providerContextHash: `sha256:${"1".repeat(64)}`
    }),
    modelProposalProvider: async () => proposal(),
    relevantTestRunner,
    acceptanceRunner
  });
}

async function main() {
  await test("test runner mutates already-permitted proposal file -> UNAUTHORIZED_FILE_MUTATION", async () => {
    const run = makeHarness(async ({ workspace }) => {
      await workspace.write("src/main.js", "export function calculate(){return 999;}\n");
      return true;
    });
    const report = await run({ task, freezeDocument: {} });
    assert.equal(report.failureCode, FAILURE_CODES.UNAUTHORIZED_FILE_MUTATION);
    assert.equal(report.metrics.unauthorizedFileMutation, true);
    assert.equal(report.metrics.rollbackCompleted, true);
    assert.deepEqual(report.unauthorizedFiles, ["src/main.js"]);
  });

  await test("test runner mutates already-dirty injected baseline file -> UNAUTHORIZED_FILE_MUTATION", async () => {
    const run = makeHarness(async ({ workspace }) => {
      const repaired = await workspace.read("src/main.js");
      await workspace.write("src/main.js", `${repaired}// test-side mutation\n`);
      return true;
    });
    const report = await run({ task, freezeDocument: {} });
    assert.equal(report.failureCode, FAILURE_CODES.UNAUTHORIZED_FILE_MUTATION);
    assert.equal(report.metrics.unauthorizedFileMutation, true);
    assert.equal(report.metrics.rollbackCompleted, true);
    assert.deepEqual(report.unauthorizedFiles, ["src/main.js"]);
  });

  await test("acceptance runner mutation is also rejected by content fingerprint", async () => {
    const run = makeHarness(async () => true, async ({ workspace }) => {
      await workspace.write("src/main.js", "export function calculate(){return 7;}\n");
      return true;
    });
    const report = await run({ task, freezeDocument: {} });
    assert.equal(report.failureCode, FAILURE_CODES.UNAUTHORIZED_FILE_MUTATION);
    assert.equal(report.metrics.unauthorizedFileMutation, true);
    assert.equal(report.metrics.rollbackCompleted, true);
  });

  await test("local clone source mutation metric is actually measured", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate6-source-measurement-"));
    const source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.mkdirSync(path.join(source, "test"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: source });
    execFileSync("git", ["config", "user.email", "gate6@example.invalid"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Gate6"], { cwd: source });
    fs.writeFileSync(path.join(source, "src/main.js"), "export function calculate(){return 1;}\n");
    fs.writeFileSync(path.join(source, "test/main.test.js"), "calculate regression\n");
    execFileSync("git", ["add", "."], { cwd: source });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: source });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
    const blobSha = execFileSync("git", ["rev-parse", "HEAD:src/main.js"], { cwd: source, encoding: "utf8" }).trim();
    const before = fs.readFileSync(path.join(source, "src/main.js"), "utf8");
    const after = before.replace("calculate", "calculate__GATE6_FAULT");
    const injection = {
      type: "rename_primary_required_symbol",
      path: "src/main.js",
      symbol: "calculate",
      replacementSymbol: "calculate__GATE6_FAULT",
      defaultExportRemoved: false,
      beforeBlobSha: blobSha,
      beforeContentHash: sha256(before),
      afterContentHash: sha256(after)
    };
    injection.injectionId = sha256(JSON.stringify({
      commitSha,
      path: injection.path,
      beforeBlobSha: injection.beforeBlobSha,
      beforeContentHash: injection.beforeContentHash,
      afterContentHash: injection.afterContentHash,
      symbol: injection.symbol,
      replacementSymbol: injection.replacementSymbol,
      defaultExportRemoved: injection.defaultExportRemoved
    }));
    const localTask = { ...task, commitSha, taskId: "fixture.local-integrity" };
    const freezeDocument = {
      attestations: [{ results: [{
        taskId: localTask.taskId,
        baselineExpected: "fail",
        baselineObserved: "fail",
        faultInjection: injection
      }] }]
    };
    const workspaceFactory = createDisposableWorkspaceFactory({ cloneSourceResolver: () => source, tempParent: root });
    const workspace = await workspaceFactory.create({ task: localTask, freezeDocument });
    const receipt = await workspace.assertOriginalRepositoryUnchanged();
    assert.equal(receipt.measured, true);
    assert.equal(receipt.unchanged, true);
    assert.match(receipt.beforeHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(receipt.beforeHash, receipt.afterHash);
    fs.writeFileSync(path.join(source, "src/main.js"), "export function calculate(){return 999;}\n");
    const mutatedReceipt = await workspace.assertOriginalRepositoryUnchanged();
    assert.equal(mutatedReceipt.measured, true);
    assert.equal(mutatedReceipt.unchanged, false);
    assert.notEqual(mutatedReceipt.beforeHash, mutatedReceipt.afterHash);
    await workspace.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
