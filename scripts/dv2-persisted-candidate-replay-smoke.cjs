#!/usr/bin/env node
"use strict";

// Replays the deterministic verifier (v2) against the EXACT persisted candidate
// from the recorded unsafe-patch incident (task codex.3d8511bb...), without
// regenerating or mutating anything, and then validates the candidate in an
// isolated disposable clone: typecheck + build + the touched contracts test.
// The source checkout is never modified. Zero provider calls.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const TASK_DIR = process.env.BOUNDED_REPLAY_TASK_DIR ??
  "/private/tmp/.bounded-durable/40b224fee3fd47794e317beebf03b8d6/tasks/741ed116dd20ce3e3a7a95d3870bc4aa2b6b4fda34dec24e7d199f7abc7dcfea";

function main() {
  const mutationPath = path.join(TASK_DIR, "artifacts", "validated-mutation-9fc7756b0af9d970.json");
  const terminalPath = path.join(TASK_DIR, "artifacts", "terminal-result-9f23c1a22c268f8c.json");
  if (!existsSync(mutationPath) || !existsSync(terminalPath)) {
    console.log("persisted incident artifacts are not available on this machine; replay skipped");
    return;
  }

  const mutation = JSON.parse(readFileSync(mutationPath, "utf8"));
  const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
  const coderResult = terminal.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult;
  assert.ok(coderResult?.runtimeContext, "persisted terminal result must carry runtimeContext");
  const boundContextFiles = coderResult.runtimeContext.evidence
    .map(({ path: p, contentHash }) => ({ path: p, contentHash }));
  const allowedFiles = [...mutation.touchedFiles].sort();
  const policyHash = terminal.verifierResult?.finding?.claims?.[0]?.policyHash;

  // 1. Verifier replay against the exact persisted mutation (source repo is read-only here).
  const run = async () => {
    const module = await import(pathToFileURL(path.join(repoRoot,
      "dist/packages/product-runtime/src/deterministic-verifier-v2.js")).href);
    const result = await module.verifyPatchDraftMutationV2({
      repositoryPath: repoRoot,
      mutation,
      allowedFiles,
      forbiddenFiles: [],
      boundContextFiles,
      ...(policyHash ? { policyHash } : {}),
      requireExistingTouchedFiles: true
    });
    return result;
  };

  const beforeStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  run().then((result) => {
    const unsafeIssues = result.issues.filter((entry) => entry.ruleId === "DV2_UNSAFE_PATCH");
    console.log(`replay decision: ${result.decision}`);
    console.log(`DV2_UNSAFE_PATCH issues after fix: ${unsafeIssues.length}`);
    assert.equal(unsafeIssues.length, 0, "the persisted candidate must no longer trigger DV2_UNSAFE_PATCH");
    assert.equal(result.decision, "approve", JSON.stringify(result.issues));

    // 2. Isolated candidate validation in a disposable clone (source checkout untouched).
    const work = mkdtempSync(path.join(tmpdir(), "dv2-candidate-replay-"));
    const clonePath = path.join(work, "repo");
    try {
      execFileSync("git", ["clone", "--quiet", "--local", repoRoot, clonePath]);
      for (const claim of mutation.claims) {
        writeFileSync(path.join(clonePath, claim.file), claim.newContent);
      }
      symlinkSync(path.join(repoRoot, "node_modules"), path.join(clonePath, "node_modules"), "dir");
      const runIn = (file, args) => execFileSync(file, args, { cwd: clonePath, encoding: "utf8" });
      runIn("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
      console.log("isolated typecheck+build: PASS");

      let testStatus = "PASS";
      let testOutput = "";
      try {
        testOutput = execFileSync("node", ["dist/tests/smoke/contracts.js"], {
          cwd: clonePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        testStatus = "FAIL";
        testOutput = String(error.stderr ?? error.stdout ?? error.message).split("\n").slice(-6).join("\n");
      }
      console.log(`isolated contracts test: ${testStatus}`);
      if (testStatus === "FAIL") console.log(testOutput);

      const statusAfter = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
      assert.equal(statusAfter, beforeStatus, "source checkout must remain untouched by the replay");
      console.log("dv2-persisted-candidate-replay-smoke: PASS");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

main();
