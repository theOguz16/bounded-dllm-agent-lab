#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FAILURE_CODES,
  PROPOSAL_VERSION,
  createGate6SimulatedCodingHarness,
  providerFailure,
  validateProposal
} = require("../../scripts/lib/gate6-simulated-coding-harness.cjs");
const {
  createDisposableWorkspaceFactory,
  sha256
} = require("../../scripts/lib/gate6-simulated-workspace.cjs");

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

const mutationTask = Object.freeze({
  schemaVersion: "gate6-task/v1",
  taskId: "fixture.mutation",
  repositoryId: "fixture/repo",
  commitSha: "a".repeat(40),
  taskClass: "bugfix_with_regression",
  difficulty: "medium",
  objective: "Restore calculate behavior.",
  candidateFiles: ["src/main.js", "src/decoy.js", "test/main.test.js"],
  authority: {
    allowedInspectionPaths: ["src/**", "test/**"],
    forbiddenInspectionPaths: ["src/private/**"],
    allowedChangePaths: ["src/**", "test/**"]
  }
});
const noChangeTask = Object.freeze({ ...mutationTask, taskId: "fixture.no-change", taskClass: "no_change_needed" });

function makeContextResolver() {
  return ({ repositorySnapshot, strategy }) => ({
    strategy,
    context: JSON.stringify({ strategy, files: repositorySnapshot.files.map((file) => file.path) }),
    contextBytes: 100,
    providerContextHash: "sha256:" + "1".repeat(64)
  });
}

function proposal(edits, action = edits.length ? "patch" : "no_change") {
  return {
    schemaVersion: PROPOSAL_VERSION,
    action,
    edits,
    summary: action === "patch" ? "Repair the injected failure." : "No change is needed."
  };
}

function makeMemoryWorkspaceFactory(options = {}) {
  let counter = 0;
  const states = [];
  return {
    states,
    async create({ task }) {
      counter += 1;
      const baseline = task.taskClass === "no_change_needed"
        ? new Map([
            ["src/main.js", "export function calculate(){return 1;}\n"],
            ["src/decoy.js", "export const decoy = true;\n"],
            ["test/main.test.js", "calculate regression\n"]
          ])
        : new Map([
            ["src/main.js", "export function calculate__GATE6_FAULT(){return 1;}\n"],
            ["src/decoy.js", "export const decoy = true;\n"],
            ["test/main.test.js", "calculate regression\n"]
          ]);
      const files = new Map(baseline);
      const baselineChanged = task.taskClass === "no_change_needed" ? [] : ["src/main.js"];
      const state = { workspaceId: `workspace-${counter}`, baseline, files, baselineChanged, disposed: false, rollbackCount: 0 };
      states.push(state);
      return {
        workspaceId: state.workspaceId,
        async read(filePath) {
          if (!files.has(filePath)) throw new Error("ENOENT");
          return files.get(filePath);
        },
        async write(filePath, content) {
          if (options.failWrite) throw new Error("write failed");
          files.set(filePath, content);
        },
        async changedFiles() {
          const names = new Set(baselineChanged);
          for (const [filePath, value] of files) if (baseline.get(filePath) !== value) names.add(filePath);
          for (const filePath of baseline) if (!files.has(filePath)) names.add(filePath);
          return [...names].sort();
        },
        async repositorySnapshot() {
          return {
            schemaVersion: "gate6-repository-snapshot/v1",
            repositoryId: task.repositoryId,
            commitSha: task.commitSha,
            files: task.candidateFiles.map((filePath) => ({ path: filePath, content: files.get(filePath) }))
          };
        },
        async rollback() {
          state.rollbackCount += 1;
          if (options.rollbackFails) return false;
          files.clear();
          for (const [filePath, content] of baseline) files.set(filePath, content);
          return true;
        },
        async assertOriginalRepositoryUnchanged() { return options.sourceMutated ? false : true; },
        async dispose() { state.disposed = true; return true; }
      };
    }
  };
}

function repairEdit() {
  const before = "export function calculate__GATE6_FAULT(){return 1;}\n";
  return {
    path: "src/main.js",
    expectedContentHash: sha256(before),
    oldText: "calculate__GATE6_FAULT",
    newText: "calculate"
  };
}

function makeHarness(overrides = {}) {
  const workspaceFactory = overrides.workspaceFactory ?? makeMemoryWorkspaceFactory();
  return {
    workspaceFactory,
    run: createGate6SimulatedCodingHarness({
      workspaceFactory,
      contextResolver: overrides.contextResolver ?? makeContextResolver(),
      modelProposalProvider: overrides.modelProposalProvider ?? (async () => proposal([repairEdit()])),
      relevantTestRunner: overrides.relevantTestRunner ?? (async ({ workspace }) => ({
        passed: (await workspace.read("src/main.js")).includes("function calculate()")
      })),
      acceptanceRunner: overrides.acceptanceRunner ?? (async ({ workspace }) => ({
        passed: (await workspace.read("src/main.js")).includes("function calculate()")
      }))
    })
  };
}

async function main() {
  await test("strict proposal schema accepts patch and no-change forms", () => {
    assert.equal(validateProposal(proposal([repairEdit()])).action, "patch");
    assert.equal(validateProposal(proposal([], "no_change")).action, "no_change");
    assert.equal(validateProposal({ ...proposal([]), extra: true }), null);
    assert.equal(validateProposal(proposal([], "patch")), null);
  });

  await test("successful mutation reaches verifier apply tests acceptance and finalize", async () => {
    const harness = makeHarness();
    const report = await harness.run({ task: mutationTask, freezeDocument: {} });
    assert.equal(report.status, "accepted");
    assert.equal(report.failureCode, null);
    assert.deepEqual(report.metrics, {
      proposalGenerated: true,
      verifierReached: true,
      verifierAccepted: true,
      verifierRejected: false,
      patchApplied: true,
      relevantTestsExecuted: true,
      testsPassed: true,
      acceptancePassed: true,
      rollbackRequired: false,
      rollbackCompleted: false,
      scopeViolation: false,
      unauthorizedFileMutation: false,
      humanIntervention: false,
      noChangeAccepted: false
    });
    assert.equal(report.workspaceDisposed, true);
    assert.equal(report.originalRepositoryMutated, false);
  });

  await test("each sample receives a separate disposable workspace", async () => {
    const harness = makeHarness();
    const first = await harness.run({ task: mutationTask, freezeDocument: {} });
    const second = await harness.run({ task: mutationTask, freezeDocument: {} });
    assert.notEqual(first.workspaceId, second.workspaceId);
    assert.equal(harness.workspaceFactory.states.every((state) => state.disposed), true);
  });

  await test("no-change task succeeds only with genuine zero-mutation proposal", async () => {
    const harness = makeHarness({
      modelProposalProvider: async () => proposal([], "no_change"),
      relevantTestRunner: async () => true,
      acceptanceRunner: async () => true
    });
    const report = await harness.run({ task: noChangeTask, freezeDocument: {} });
    assert.equal(report.status, "accepted");
    assert.equal(report.metrics.noChangeAccepted, true);
    assert.equal(report.metrics.patchApplied, false);
    assert.equal(report.metrics.relevantTestsExecuted, true);
    assert.equal(report.metrics.acceptancePassed, true);
  });

  await test("unnecessary mutation on no-change task fails before apply", async () => {
    const edit = {
      path: "src/main.js",
      expectedContentHash: sha256("export function calculate(){return 1;}\n"),
      oldText: "return 1",
      newText: "return 2"
    };
    const harness = makeHarness({ modelProposalProvider: async () => proposal([edit]) });
    const report = await harness.run({ task: noChangeTask, freezeDocument: {} });
    assert.equal(report.failureCode, FAILURE_CODES.UNNECESSARY_MUTATION);
    assert.equal(report.metrics.verifierRejected, true);
    assert.equal(report.metrics.patchApplied, false);
    assert.equal(report.metrics.rollbackRequired, false);
    assert.equal(report.modelCapabilityFailure, true);
  });

  await test("mutation task no-change proposal is a distinct model failure", async () => {
    const harness = makeHarness({ modelProposalProvider: async () => proposal([], "no_change") });
    const report = await harness.run({ task: mutationTask, freezeDocument: {} });
    assert.equal(report.failureCode, FAILURE_CODES.REQUIRED_MUTATION_MISSING);
    assert.equal(report.modelCapabilityFailure, true);
    assert.equal(report.metrics.verifierRejected, true);
  });

  await test("invalid model output stays model capability failure", async () => {
    const harness = makeHarness({ modelProposalProvider: async () => ({ nope: true }) });
    const report = await harness.run({ task: mutationTask, freezeDocument: {} });
    assert.equal(report.failureCode, FAILURE_CODES.MODEL_OUTPUT_INVALID);
    assert.equal(report.failureDomain, "model");
    assert.equal(report.modelCapabilityFailure, true);
    assert.equal(report.metrics.proposalGenerated, false);
  });

  await test("provider and network errors never become model capability failures", async () => {
    const harness = makeHarness({
      modelProposalProvider: async () => { throw providerFailure("NETWORK_TIMEOUT", "upstream timed out"); }
    });
    const report = await harness.run({ task: mutationTask, freezeDocument: {} });
    assert.equal(report.failureCode, FAILURE_CODES.PROVIDER_FAILURE);
    assert.equal(report.failureDomain, "provider");
    assert.equal(report.providerFailureCode, "NETWORK_TIMEOUT");
    assert.equal(report.modelCapabilityFailure, false);
  });

  await test("context resolution failure is isolated before model proposal", async () => {
    let providerCalled = false;
    const harness = makeHarness({
      contextResolver: () => { throw new Error("bad context"); },
      modelProposalProvider: async () => { providerCalled = true; return proposal([repairEdit()]); }
    });
    const report = await harness.run({ task: mutationTask, freezeDocument: {} });
    assert.equal(report.failureCode, FAILURE_CODES.CONTEXT_RESOLUTION_FAILURE);
    assert.equal(providerCalled, false);
  });

  await test("scope violation is separate from authority violation", async () => {
    const decoy = "export const decoy = true;\n";
    const scopeHarness = makeHarness({
      modelProposalProvider: async () => proposal([{
        path: "src/decoy.js",
        expectedContentHash: sha256(decoy),
        oldText: "true",
        newText: "false"
      }])
    });
    const scopedTask = { ...mutationTask, candidateFiles: ["src/main.js", "test/main.test.js"] };
    const scopeReport = await scopeHarness.run({ task: scopedTask, freezeDocument: {} });
    assert.equal(scopeReport.failureCode, FAILURE_CODES.SCOPE_VIOLATION);
    assert.equal(scopeReport.metrics.scopeViolation, true);

    const authorityHarness = makeHarness({
      modelProposalProvider: async () => proposal([{
        path: "src/private/secret.js",
        expectedContentHash: "sha256:" + "0".repeat(64),
        oldText: "x",
        newText: "y"
      }])
    });
    const authorityTask = { ...mutationTask, candidateFiles: [...mutationTask.candidateFiles, "src/private/secret.js"] };
    const authorityReport = await authorityHarness.run({ task: authorityTask, freezeDocument: {} });
    assert.equal(authorityReport.failureCode, FAILURE_CODES.AUTHORITY_VIOLATION);
    assert.equal(authorityReport.metrics.verifierRejected, true);
  });

  await test("patch apply failure triggers rollback", async () => {
    const workspaceFactory = makeMemoryWorkspaceFactory({ failWrite: true });
    const harness = makeHarness({ workspaceFactory });
    const report = await harness.run({ task: mutationTask, freezeDocument: {} });
    assert.equal(report.failureCode, FAILURE_CODES.PATCH_APPLY_FAILED);
    assert.equal(report.metrics.rollbackRequired, true);
    assert.equal(report.metrics.rollbackCompleted, true);
    assert.equal(workspaceFactory.states[0].rollbackCount, 1);
  });

  await test("test failure and acceptance failure both roll back applied patch", async () => {
    const testHarness = makeHarness({ relevantTestRunner: async () => ({ passed: false, detail: "regression failed" }) });
    const testReport = await testHarness.run({ task: mutationTask, freezeDocument: {} });
    assert.equal(testReport.failureCode, FAILURE_CODES.TEST_FAILURE);
    assert.equal(testReport.metrics.rollbackCompleted, true);

    const acceptanceHarness = makeHarness({ acceptanceRunner: async () => ({ passed: false, detail: "oracle failed" }) });
    const acceptanceReport = await acceptanceHarness.run({ task: mutationTask, freezeDocument: {} });
    assert.equal(acceptanceReport.failureCode, FAILURE_CODES.ACCEPTANCE_FAILURE);
    assert.equal(acceptanceReport.metrics.testsPassed, true);
    assert.equal(acceptanceReport.metrics.rollbackCompleted, true);
  });

  await test("unauthorized side mutation from tests is detected and rolled back", async () => {
    const harness = makeHarness({
      relevantTestRunner: async ({ workspace }) => {
        await workspace.write("src/side-effect.js", "unauthorized\n");
        return true;
      }
    });
    const report = await harness.run({ task: mutationTask, freezeDocument: {} });
    assert.equal(report.failureCode, FAILURE_CODES.UNAUTHORIZED_FILE_MUTATION);
    assert.equal(report.metrics.unauthorizedFileMutation, true);
    assert.equal(report.metrics.rollbackCompleted, true);
  });

  await test("rollback failure marks human intervention", async () => {
    const harness = makeHarness({
      workspaceFactory: makeMemoryWorkspaceFactory({ rollbackFails: true }),
      relevantTestRunner: async () => false
    });
    const report = await harness.run({ task: mutationTask, freezeDocument: {} });
    assert.equal(report.failureCode, FAILURE_CODES.ROLLBACK_FAILED);
    assert.equal(report.metrics.humanIntervention, true);
  });

  await test("filesystem workspace clones disposable checkout and preserves original source", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate6-sim-workspace-test-"));
    const source = path.join(root, "source");
    fs.mkdirSync(source, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: source });
    execFileSync("git", ["config", "user.email", "gate6@example.invalid"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Gate6"], { cwd: source });
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.writeFileSync(path.join(source, "src/main.js"), "export function calculate(){return 1;}\n");
    fs.writeFileSync(path.join(source, "src/decoy.js"), "export const decoy=true;\n");
    fs.mkdirSync(path.join(source, "test"), { recursive: true });
    fs.writeFileSync(path.join(source, "test/main.test.js"), "calculate regression\n");
    execFileSync("git", ["add", "."], { cwd: source });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: source });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
    const blobSha = execFileSync("git", ["rev-parse", "HEAD:src/main.js"], { cwd: source, encoding: "utf8" }).trim();
    const original = fs.readFileSync(path.join(source, "src/main.js"), "utf8");
    const mutated = original.replace("calculate", "calculate__GATE6_FAULT");
    const fault = {
      type: "rename_primary_required_symbol",
      path: "src/main.js",
      symbol: "calculate",
      replacementSymbol: "calculate__GATE6_FAULT",
      defaultExportRemoved: false,
      beforeBlobSha: blobSha,
      beforeContentHash: sha256(original),
      afterContentHash: sha256(mutated)
    };
    fault.injectionId = sha256(JSON.stringify({
      commitSha,
      path: fault.path,
      beforeBlobSha: fault.beforeBlobSha,
      beforeContentHash: fault.beforeContentHash,
      afterContentHash: fault.afterContentHash,
      symbol: fault.symbol,
      replacementSymbol: fault.replacementSymbol,
      defaultExportRemoved: fault.defaultExportRemoved
    }));
    const task = { ...mutationTask, commitSha };
    const freezeDocument = { attestations: [{ results: [{
      taskId: task.taskId,
      baselineExpected: "fail",
      baselineObserved: "fail",
      faultInjection: fault
    }] }] };
    const factory = createDisposableWorkspaceFactory({
      cloneSourceResolver: () => source,
      tempParent: root
    });
    const workspace = await factory.create({ task, freezeDocument });
    assert.notEqual(workspace.root, source);
    assert.equal((await workspace.read("src/main.js")).includes("calculate__GATE6_FAULT"), true);
    assert.deepEqual(await workspace.changedFiles(), ["src/main.js"]);
    assert.equal(fs.readFileSync(path.join(source, "src/main.js"), "utf8"), original);
    assert.equal(await workspace.rollback(), true);
    assert.equal(await workspace.dispose(), true);
    assert.equal(fs.readFileSync(path.join(source, "src/main.js"), "utf8"), original);
    fs.rmSync(root, { recursive: true, force: true });
  });

  process.stdout.write("Gate 6 simulated coding harness PASS\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
