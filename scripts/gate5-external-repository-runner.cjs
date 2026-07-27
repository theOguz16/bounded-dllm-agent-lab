#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REPOSITORY = "sindresorhus/p-limit";
const COMMIT_SHA = "df476048d023ff868cd45b35ee47f5fb0ca2b25a";
const REMOTE_URL = `https://github.com/${REPOSITORY}.git`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}.${stderr}`);
  }
  return (result.stdout ?? "").trim();
}

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/canonical-runtime.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gate5-external-repo-"));
  const checkout = path.join(root, "repo");

  try {
    run("git", ["clone", "--filter=blob:none", "--no-checkout", REMOTE_URL, checkout]);
    run("git", ["fetch", "--depth", "1", "origin", COMMIT_SHA], { cwd: checkout });
    run("git", ["checkout", "--detach", COMMIT_SHA], { cwd: checkout });

    const actualCommit = run("git", ["rev-parse", "HEAD"], { cwd: checkout, capture: true });
    assert.equal(actualCommit, COMMIT_SHA);

    const providerVisibleContext = {
      task: "Inspect the p-limit implementation boundary without modifying the repository.",
      candidateFiles: ["index.js", "test.js"],
      repository: REPOSITORY,
      commitSha: COMMIT_SHA
    };
    const evaluatorOracle = {
      expectedFiles: ["index.js", "test.js"],
      forbiddenFiles: ["package.json"],
      acceptanceCommands: ["node --check index.js", "node --check test.js"]
    };

    const manifest = runtime.createExternalRepositoryTaskManifest({
      repository: { owner: "sindresorhus", name: "p-limit", commitSha: COMMIT_SHA },
      taskId: "gate5.p-limit.snapshot",
      taskDescription: "Validate an immutable external repository snapshot and its bounded inspection scope.",
      providerVisibleContextHash: runtime.hashCanonicalJson(providerVisibleContext),
      evaluatorOracleHash: runtime.hashCanonicalJson(evaluatorOracle),
      acceptanceCommands: evaluatorOracle.acceptanceCommands,
      allowedChangeFiles: evaluatorOracle.expectedFiles,
      forbiddenFiles: evaluatorOracle.forbiddenFiles
    });

    assert.equal(runtime.validateExternalRepositoryTaskManifest(manifest).ok, true);
    assert.equal(await fs.stat(path.join(checkout, "index.js")).then((entry) => entry.isFile()), true);
    assert.equal(await fs.stat(path.join(checkout, "test.js")).then((entry) => entry.isFile()), true);
    assert.equal(await fs.stat(path.join(checkout, "package.json")).then((entry) => entry.isFile()), true);

    run(process.execPath, ["--check", "index.js"], { cwd: checkout });
    run(process.execPath, ["--check", "test.js"], { cwd: checkout });

    const status = run("git", ["status", "--porcelain"], { cwd: checkout, capture: true });
    assert.equal(status, "");

    console.log(JSON.stringify({
      ok: true,
      decision: "gate5_external_repository_runner_ready",
      repository: REPOSITORY,
      commitSha: COMMIT_SHA,
      immutableCheckout: true,
      manifestValid: true,
      acceptancePassed: true,
      repositoryUnmodified: true,
      evidenceClass: "external_validation_fixture"
    }, null, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
