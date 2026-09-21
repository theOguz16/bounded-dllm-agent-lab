#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../..");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
function runInit(repo) {
  const cli = path.join(root, "dist/apps/cli/src/index.js");
  const result = spawnSync(process.execPath, [cli, "init", "--json"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CODEX_API_KEY: "", OPENAI_API_KEY: "" }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function failedResult(code, request) {
  return {
    status: code === "provider_outcome_ambiguous" ? "timed_out" : "failed",
    failureCode: code,
    quotaStatus: "unknown",
    workerLifecycle: {
      deadlineTriggeredAt: 100,
      abortRequestedAt: 101,
      workerExitedAt: code === "worker_termination_failed" ? null : 150,
      exitSignal: code === "worker_termination_failed" ? null : "SIGKILL",
      forcedTermination: true
    },
    agentId: "codex",
    agentVersion: "offline-p7-7-fixture",
    modelId: request.model,
    durationMs: 150,
    finalMessage: "",
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    commands: [],
    fileChanges: [],
    diagnostics: [{ code, severity: "error", message: code, retryable: false }]
  };
}
function baselineFirstTask() {
  for (let i = 0; i < 100; i += 1) {
    const task = `P7.7 worker terminal regression ${i}`;
    const digest = crypto.createHash("sha256").update(task).digest("hex");
    if (Number.parseInt(digest.at(-1), 16) % 2 === 0) return task;
  }
  throw new Error("Unable to generate a baseline-first task");
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p7-7-compare-worker-"));
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  try {
    const repo = path.join(temp, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const packageJson = Buffer.from(JSON.stringify({ name: "p7-7-fixture", version: "1.0.0", private: true }, null, 2) + "\n");
    const packageLock = Buffer.from(JSON.stringify({
      name: "p7-7-fixture", version: "1.0.0", lockfileVersion: 3,
      requires: true, packages: { "": { name: "p7-7-fixture", version: "1.0.0" } }
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(repo, "package.json"), packageJson);
    fs.writeFileSync(path.join(repo, "package-lock.json"), packageLock);
    fs.writeFileSync(path.join(repo, "src/index.js"), "module.exports = 1;\n");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "offline source");
    runInit(repo);

    const dependencyHash = "sha256:" + crypto.createHash("sha256")
      .update("compare-validation-dependencies/v1\n")
      .update(packageJson).update("\n").update(packageLock).digest("hex");
    const cache = path.join(temp, ".cache/bounded-dllm-agent-lab/compare-validation", dependencyHash.slice(7));
    fs.mkdirSync(path.join(cache, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(cache, "bounded-compare-dependencies.json"), JSON.stringify({
      schemaVersion: "compare-validation-dependencies/v1", dependencySnapshotHash: dependencyHash
    }));
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nif [ \"$1\" = info ]; then echo offline-fixture; exit 0; fi\nif [ \"$1\" = image ] && [ \"$2\" = inspect ]; then exit 0; fi\nexit 91\n", { mode: 0o700 });
    process.env.HOME = temp;
    process.env.PATH = bin + path.delimiter + oldPath;

    const { compareCodexCommand } = await import(pathToFileURL(path.join(root, "dist/apps/cli/src/commands/compare.js")).href);
    const { CodexCompareProviderGate } = await import(pathToFileURL(path.join(root, "dist/apps/cli/src/commands/codex-compare-provider-gate.js")).href);
    const { CodexScopeDiscoveryError } = await import(pathToFileURL(path.join(root, "dist/apps/cli/src/providers/codex-scope-discovery.js")).href);
    const task = baselineFirstTask();

    for (const code of ["provider_outcome_ambiguous", "worker_termination_failed"]) {
      let invocations = 0;
      let boundedInvocations = 0;
      const env = {
        BOUNDED_CODEX_ACCOUNT_ALIAS: "account-a",
        BOUNDED_CODEX_AUTH_MODE: "api_key",
        CODEX_API_KEY: "offline-fixture-key",
        BOUNDED_CODEX_MODEL: "fake-model"
      };
      const gate = new CodexCompareProviderGate("fake-model", "medium", () => env);
      const fake = {
        agentId: "codex",
        agentVersion: "offline-p7-7-fixture",
        async run(request) {
          invocations += 1;
          if (request.mode !== "baseline") boundedInvocations += 1;
          return failedResult(code, request);
        }
      };
      const response = await compareCodexCommand({ task }, repo, {
        adapter: fake,
        model: "fake-model",
        providerGate: gate,
        discover: async () => { throw new CodexScopeDiscoveryError("offline discovery skipped"); },
        runTask: async () => { throw new Error("Second arm must never start after P7.7 terminal failure"); }
      });

      assert.equal(response.exitCode, 4);
      assert.equal(response.output.comparable, false);
      assert.equal(response.output.providerFailureCode, null);
      assert.equal(response.output.terminalFailureCode, code);
      assert.equal(response.output.runtime.normal.failureCode, code);
      assert.equal(response.output.runtime.bounded.failureCode, code);
      assert.equal(invocations, 1, `${code}: exactly one fake provider invocation`);
      assert.equal(boundedInvocations, 0, `${code}: opposite arm was not invoked`);
    }

    console.log("P7.7 compare stop PASS: ambiguous provider outcome and worker termination failure both block the opposite arm");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
