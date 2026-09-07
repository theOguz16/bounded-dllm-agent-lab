#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const runner = require("../../scripts/gate6-live-runner.cjs");
const {
  FAILURE_CODES,
  PROPOSAL_VERSION,
  createGate6SimulatedCodingHarness
} = require("../../scripts/lib/gate6-simulated-coding-harness.cjs");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

const SOURCES = Object.freeze({
  "src/a.js": "abcdef\n",
  "test/a.test.js": "test body\n",
  "forbidden/x.js": "forbidden body\n",
  "other/x.js": "other body\n"
});

function task(taskClass = "bugfix_with_regression") {
  return {
    schemaVersion: "gate6-task/v1",
    taskId: `fixture.${taskClass}`,
    repositoryId: "fixture/repo",
    commitSha: COMMIT,
    taskClass,
    difficulty: "medium",
    objective: "Fixture proposal diagnostics.",
    candidateFiles: ["src/a.js", "test/a.test.js", "forbidden/x.js", "other/x.js"],
    authority: {
      allowedInspectionPaths: ["src/**", "test/**", "forbidden/**", "other/**"],
      forbiddenInspectionPaths: ["forbidden/**"],
      allowedChangePaths: ["src/**", "test/**", "forbidden/**"]
    }
  };
}

function snapshot() {
  return {
    repositoryId: "fixture/repo",
    commitSha: COMMIT,
    files: Object.entries(SOURCES).map(([path, content]) => ({ path, content }))
  };
}

function edit(path = "src/a.js", oldText = "abc", newText = "ABC", expectedContentHash = sha256(SOURCES["src/a.js"])) {
  return { path, expectedContentHash, oldText, newText };
}

function proposal(edits = [edit()], action = "patch") {
  return { schemaVersion: PROPOSAL_VERSION, action, edits, summary: "Fixture proposal." };
}

function workspaceFactory() {
  return {
    async create({ task: currentTask }) {
      const initial = new Map(Object.entries(SOURCES));
      const files = new Map(initial);
      return {
        workspaceId: "fixture-workspace",
        async read(path) {
          if (!files.has(path)) throw new Error("missing");
          return files.get(path);
        },
        async write(path, content) { files.set(path, content); },
        async changedFiles() {
          return [...new Set([...initial.keys(), ...files.keys()])].filter((path) => initial.get(path) !== files.get(path)).sort();
        },
        async repositorySnapshot() {
          return {
            repositoryId: currentTask.repositoryId,
            commitSha: currentTask.commitSha,
            files: [...files].map(([path, content]) => ({ path, content }))
          };
        },
        async contentFingerprint() {
          return {
            files: [...files].map(([path, content]) => ({ path, state: "present", byteLength: Buffer.byteLength(content), contentHash: sha256(content) }))
          };
        },
        async rollback() {
          files.clear();
          for (const [path, content] of initial) files.set(path, content);
          return true;
        },
        async assertOriginalRepositoryUnchanged() { return true; },
        async dispose() { return true; }
      };
    }
  };
}

async function canonicalOutcome(currentTask, rawProposal) {
  const harness = createGate6SimulatedCodingHarness({
    workspaceFactory: workspaceFactory(),
    contextResolver: ({ strategy }) => ({ strategy, context: "{}", contextBytes: 2, providerContextHash: sha256("{}") }),
    modelProposalProvider: async () => structuredClone(rawProposal),
    relevantTestRunner: async () => true,
    acceptanceRunner: async () => true
  });
  return harness({ task: currentTask, freezeDocument: {}, strategy: "E_bounded_workspace_boundary" });
}

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

async function main() {
  await test("proposal diagnostics distinguish schema and preflight classes with safe telemetry", async () => {
    const currentTask = task();
    const cases = [
      [proposal(), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_VALID],
      [{ ...proposal(), extra: true }, runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_SHAPE_INVALID],
      [{ ...proposal(), schemaVersion: "wrong" }, runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_SCHEMA_VERSION_INVALID],
      [{ ...proposal(), action: "repair" }, runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_ACTION_INVALID],
      [{ ...proposal(), edits: "bad" }, runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_EDITS_INVALID],
      [proposal([{ ...edit(), extra: true }]), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_EDIT_INVALID],
      [proposal([{ ...edit(), expectedContentHash: "bad" }]), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_HASH_INVALID],
      [proposal([edit("../bad.js")]), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_PATH_INVALID],
      [proposal([edit("src/outside.js", "x", "y", sha256("x"))]), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_PATH_OUTSIDE_CANDIDATE_UNIVERSE],
      [proposal([edit("other/x.js", "other", "OTHER", sha256(SOURCES["other/x.js"]))]), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_AUTHORITY_VIOLATION],
      [proposal([edit("forbidden/x.js", "forbidden", "FORBIDDEN", sha256(SOURCES["forbidden/x.js"]))]), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_FORBIDDEN_PATH],
      [proposal([edit(), edit()]), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_DUPLICATE_EDIT],
      [proposal([edit("src/a.js", "abc", "ABC"), edit("src/a.js", "bc", "BC")]), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_OVERLAPPING_EDIT],
      [proposal([{ ...edit(), expectedContentHash: sha256("wrong") }]), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_CONFLICT_INVALID],
      [proposal([], "no_change"), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_NO_CHANGE_INVALID]
    ];
    for (const [rawProposal, expected] of cases) {
      const diagnostic = runner.classifyProposalDiagnostic(rawProposal, currentTask, snapshot());
      assert.equal(diagnostic.proposalValidationFailureCode, expected, expected);
      const serialized = JSON.stringify(diagnostic);
      assert.equal(serialized.includes("src/a.js"), false);
      assert.equal(serialized.includes("abcdef"), false);
    }
  });

  await test("PROPOSAL_VALID iff canonical proposal plus canonical task/preflight chain accepts", async () => {
    const currentTask = task();
    const cases = [
      proposal(),
      { ...proposal(), extra: true },
      proposal([{ ...edit(), expectedContentHash: "bad" }]),
      proposal([edit("src/outside.js", "x", "y", sha256("x"))]),
      proposal([edit("other/x.js", "other", "OTHER", sha256(SOURCES["other/x.js"]))]),
      proposal([edit("forbidden/x.js", "forbidden", "FORBIDDEN", sha256(SOURCES["forbidden/x.js"]))]),
      proposal([edit(), edit()]),
      proposal([edit("src/a.js", "abc", "ABC"), edit("src/a.js", "bc", "BC")]),
      proposal([{ ...edit(), expectedContentHash: sha256("wrong") }]),
      proposal([], "no_change")
    ];
    for (const rawProposal of cases) {
      const diagnosticValid = runner.classifyProposalDiagnostic(rawProposal, currentTask, snapshot()).proposalValidationFailureCode ===
        runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_VALID;
      const report = await canonicalOutcome(currentTask, rawProposal);
      assert.equal(diagnosticValid, report.status === "accepted", report.failureCode ?? "accepted");
    }
  });

  await test("scope authority forbidden and overlap diagnostics mirror canonical failure domains", async () => {
    const currentTask = task();
    const matrix = [
      [proposal([edit("src/outside.js", "x", "y", sha256("x"))]), FAILURE_CODES.SCOPE_VIOLATION, "policy"],
      [proposal([edit("other/x.js", "other", "OTHER", sha256(SOURCES["other/x.js"]))]), FAILURE_CODES.AUTHORITY_VIOLATION, "policy"],
      [proposal([edit("forbidden/x.js", "forbidden", "FORBIDDEN", sha256(SOURCES["forbidden/x.js"]))]), FAILURE_CODES.AUTHORITY_VIOLATION, "policy"],
      [proposal([edit("src/a.js", "abc", "ABC"), edit("src/a.js", "bc", "BC")]), FAILURE_CODES.MODEL_OUTPUT_INVALID, "model"]
    ];
    for (const [rawProposal, code, domain] of matrix) {
      const report = await canonicalOutcome(currentTask, rawProposal);
      assert.equal(report.failureCode, code);
      assert.equal(report.failureDomain, domain);
    }
  });

  await test("no-change task action compatibility stays diagnostic-only and canonical", async () => {
    const noChangeTask = task("no_change_needed");
    const mutation = proposal();
    const diagnostic = runner.classifyProposalDiagnostic(mutation, noChangeTask, snapshot());
    assert.equal(diagnostic.proposalValidationFailureCode, runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_NO_CHANGE_INVALID);
    const report = await canonicalOutcome(noChangeTask, mutation);
    assert.equal(report.failureCode, FAILURE_CODES.UNNECESSARY_MUTATION);
    assert.equal(report.failureDomain, "model");
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
