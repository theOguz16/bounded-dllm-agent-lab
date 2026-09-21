"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BLOCKED = "P7_14_PROVIDER_INVOCATION_BLOCKED";
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const preload = path.join(__dirname, "p7-14-provider-block.cjs");

/** The same trusted black-box assertion is used for every triad member. */
function inspectFailedResume(workspace) {
  assert.equal(path.isAbsolute(workspace), true);
  const runner = path.join(workspace, "benchmarks/product-v1/dogfood-post-fix-runner.cjs");
  assert.equal(fs.statSync(runner).isFile(), true);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p7-14-check-"));
  fs.chmodSync(temp, 0o755);
  // /home/runner is not traversable by nobody on hosted CI. Stage only the
  // independently hashed preload, never a signer/key/checker, in an immutable
  // evaluator-owned location outside every candidate workspace.
  const readablePreload = path.join(temp, "provider-block.cjs");
  fs.copyFileSync(preload, readablePreload);
  fs.chmodSync(readablePreload, 0o444);
  assert.equal(sha(fs.readFileSync(readablePreload)), sha(fs.readFileSync(preload)));
  const output = path.join(temp, "result.json");
  const checkpoint = `${output}.raw.json.checkpoint.json`;
  const execute = (failed) => {
    if (failed) fs.writeFileSync(checkpoint,
      JSON.stringify({ failedTaskId: "fixture.failed", failure: { code: "expected" } }), { mode: 0o644 });
    else fs.writeFileSync(checkpoint, JSON.stringify({ completedTasks: [] }), { mode: 0o644 });
    const args = ["-n", "-u", "nobody", "--", process.execPath, "--require", readablePreload, runner,
      "--live", "--resume", `--output=${output}`, "--model=fixture-model"];
    const result = spawnSync("sudo", args, {
      cwd: workspace,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/tmp", CODEX_API_KEY: "", OPENAI_API_KEY: "", CODEX_ACCESS_TOKEN: "" },
      encoding: "utf8", timeout: 5_000, maxBuffer: 32 * 1024, windowsHide: true
    });
    const stdout = String(result.stdout || "").slice(0, 8_192);
    const stderr = String(result.stderr || "").slice(0, 8_192);
    return { status: result.status, signal: result.signal, error: result.error?.code || null,
      stdout, stderr, outputHash: sha(JSON.stringify([result.status, result.signal, stdout, stderr])) };
  };
  try {
    const failed = execute(true);
    const healthy = execute(false);
    const healthyReachedBlockedChild = healthy.status === 79 && healthy.stderr.includes(BLOCKED);
    const failedRejectedCorrectly = failed.status === 1 &&
      failed.stderr.includes("cannot resume post-fix regression after failed task fixture.failed") &&
      failed.stderr.includes("retryPolicy=none forbids re-running failed tasks") &&
      !failed.stderr.includes(BLOCKED);
    const failedReachedBlockedChild = failed.status === 79 && failed.stderr.includes(BLOCKED);
    const verdict = healthyReachedBlockedChild && failedRejectedCorrectly ? "pass" :
      healthyReachedBlockedChild && failedReachedBlockedChild ? "assertion_fail" : "infrastructure_fail";
    const rawOutput = { failed, healthy };
    if (verdict === "infrastructure_fail") {
      console.error("P7.14 trusted checker infrastructure diagnosis:", JSON.stringify(rawOutput));
    }
    return { verdict, exitCode: failed.status, outputHash: sha(JSON.stringify(rawOutput)),
      output: rawOutput };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
module.exports = { inspectFailedResume };
