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
    cwd: repo, encoding: "utf8", env: { ...process.env, CODEX_API_KEY: "", OPENAI_API_KEY: "" }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function fakeResult(code, request) {
  return {
    status: "failed", failureCode: code, quotaStatus: "unknown", agentId: "codex",
    agentVersion: "offline-fixture", modelId: request.model, durationMs: 0,
    finalMessage: "", usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    commands: [], fileChanges: [], diagnostics: [{ code, severity: "error", message: code, retryable: false }]
  };
}
function baselineFirstTask() {
  for (let i = 0; i < 100; i += 1) {
    const task = `P7.6 fake-provider regression ${i}`;
    const digest = crypto.createHash("sha256").update(task).digest("hex");
    if (Number.parseInt(digest.at(-1), 16) % 2 === 0) return task;
  }
  throw new Error("Unable to generate a baseline-first task");
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p7-6-compare-command-"));
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  try {
    const repo = path.join(temp, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const packageJson = Buffer.from(JSON.stringify({ name: "p7-6-compare-fixture", version: "1.0.0", private: true }, null, 2) + "\n");
    const packageLock = Buffer.from(JSON.stringify({
      name: "p7-6-compare-fixture", version: "1.0.0", lockfileVersion: 3,
      requires: true, packages: { "": { name: "p7-6-compare-fixture", version: "1.0.0" } }
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
    const shim = path.join(bin, "docker");
    fs.writeFileSync(shim, "#!/bin/sh\nif [ \"$1\" = info ]; then echo offline-fixture; exit 0; fi\nif [ \"$1\" = image ] && [ \"$2\" = inspect ]; then exit 0; fi\necho 'Unexpected Docker operation in P7.6 offline test' >&2\nexit 91\n", { mode: 0o700 });
    process.env.HOME = temp;
    process.env.PATH = bin + path.delimiter + oldPath;

    const { compareCodexCommand } = await import(pathToFileURL(path.join(root, "dist/apps/cli/src/commands/compare.js")).href);
    const { CodexCompareProviderGate } = await import(pathToFileURL(path.join(root, "dist/apps/cli/src/commands/codex-compare-provider-gate.js")).href);
    const { CodexScopeDiscoveryError } = await import(pathToFileURL(path.join(root, "dist/apps/cli/src/providers/codex-scope-discovery.js")).href);
    const task = baselineFirstTask();
    for (const code of ["usage_limit_exceeded", "authentication_failed", "provider_overloaded", "provider_stream_error_unknown"]) {
      let paid = 0;
      let boundedInvocations = 0;
      const env = {
        BOUNDED_CODEX_ACCOUNT_ALIAS: "account-a", BOUNDED_CODEX_AUTH_MODE: "api_key",
        CODEX_API_KEY: "fixture-key-never-saved", BOUNDED_CODEX_MODEL: "fake-model"
      };
      const gate = new CodexCompareProviderGate("fake-model", "medium", () => env);
      const fake = {
        agentId: "codex", agentVersion: "offline-fixture",
        async run(request) {
          paid += 1;
          if (request.mode !== "baseline") boundedInvocations += 1;
          return fakeResult(code, request);
        }
      };
      const response = await compareCodexCommand({ task }, repo, {
        adapter: fake, model: "fake-model", providerGate: gate,
        discover: async () => { throw new CodexScopeDiscoveryError("offline discovery skipped"); },
        runTask: async () => { throw new Error("Bounded arm must never start after provider failure"); }
      });
      assert.equal(response.exitCode, 4);
      assert.equal(response.output.comparable, false);
      assert.equal(response.output.providerFailureCode, code);
      assert.equal(response.output.quotaStatus, "unknown");
      assert.equal(response.output.providerComparison.schemaVersion, "agent-comparison/v2");
      assert.equal(response.output.providerComparison.arms.baseline.accountAlias, "account-a");
      assert.equal(response.output.runtime.bounded.failureCode, code);
      assert.equal(paid, 1, `Exactly one fake invocation for ${code}`);
      assert.equal(boundedInvocations, 0, `No second arm for ${code}`);
      assert.equal(JSON.stringify(response.output).includes("fixture-key-never-saved"), false);
    }
    console.log("P7.6 actual compareCodexCommand offline PASS: four first-arm terminal errors, zero second-arm invocations, v2 identity, unknown quota, no credentials, no real Codex or Docker calls");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
