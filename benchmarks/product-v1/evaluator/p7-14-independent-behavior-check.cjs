"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const hash = (bytes) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const commands = Object.freeze({
  "node scripts/smoke/bounded-apply-smoke.cjs": ["node", ["scripts/smoke/bounded-apply-smoke.cjs"]],
  "node benchmarks/product-v1/dogfood-post-fix-runner.cjs": ["node", ["benchmarks/product-v1/dogfood-post-fix-runner.cjs"]],
  "node scripts/smoke/bounded-compare-codex-smoke.cjs": ["node", ["scripts/smoke/bounded-compare-codex-smoke.cjs"]],
  "node dist/apps/cli/src/human-decision-smoke.js": ["node", ["dist/apps/cli/src/human-decision-smoke.js"]],
  "node scripts/product/build-dogfood-report.cjs --self-test": ["node", ["scripts/product/build-dogfood-report.cjs", "--self-test"]],
  "node scripts/smoke/codex-bounded-provider-smoke.cjs": ["node", ["scripts/smoke/codex-bounded-provider-smoke.cjs"]],
  "node benchmarks/product-v1/dogfood-smoke.cjs": ["node", ["benchmarks/product-v1/dogfood-smoke.cjs"]],
  "node benchmarks/product-v1/dogfood-auth-preflight-smoke.cjs": ["node", ["benchmarks/product-v1/dogfood-auth-preflight-smoke.cjs"]],
  "npm run verify:ag1b": ["npm", ["run", "verify:ag1b"]],
  "node scripts/smoke/codex-scope-discovery-smoke.cjs": ["node", ["scripts/smoke/codex-scope-discovery-smoke.cjs"]],
  "node scripts/smoke/bounded-codex-explicit-scope-smoke.cjs": ["node", ["scripts/smoke/bounded-codex-explicit-scope-smoke.cjs"]],
  "node scripts/smoke/comparative-agent-runner-smoke.cjs": ["node", ["scripts/smoke/comparative-agent-runner-smoke.cjs"]]
});
function bounded(value) { return String(value || "").slice(0, 64 * 1024); }
function run(file, argv, workspace, env, timeout = 120_000) {
  const result = cp.spawnSync(file, argv, { cwd: workspace, encoding: "utf8", timeout,
    maxBuffer: 2 * 1024 * 1024, env });
  return { status: result.status, signal: result.signal, error: result.error?.message || null,
    stdout: bounded(result.stdout), stderr: bounded(result.stderr) };
}
function isolatedRun(file, argv, workspace, env, timeout = 120_000) {
  if (process.platform === "darwin") {
    return run("/usr/bin/sandbox-exec", ["-p", "(version 1)(deny network*)", file, ...argv], workspace, env, timeout);
  }
  return run("sudo", ["-n", "unshare", "-n", "--", file, ...argv], workspace, env, timeout);
}
function failedResumeAssertion(workspace, env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p7-14-resume-"));
  const output = path.join(temp, "result.json");
  const checkpoint = `${output}.raw.json.checkpoint.json`;
  const runner = path.join(workspace, "benchmarks/product-v1/dogfood-post-fix-runner.cjs");
  const preload = path.join(__dirname, "p7-14-provider-block.cjs");
  const execute = (failed) => {
    fs.writeFileSync(checkpoint, JSON.stringify(failed
      ? { failedTaskId: "fixture.failed", failure: { code: "expected" } }
      : { completedTasks: [] }));
    return isolatedRun(process.execPath, ["--require", preload, runner, "--live", "--resume",
      `--output=${output}`, "--model=fixture-model"], workspace, env, 10_000);
  };
  try {
    const failed = execute(true), healthy = execute(false);
    const pass = healthy.status === 79 && healthy.stderr.includes("P7_14_PROVIDER_INVOCATION_BLOCKED") &&
      failed.status === 1 && failed.stderr.includes("cannot resume post-fix regression after failed task fixture.failed") &&
      !failed.stderr.includes("P7_14_PROVIDER_INVOCATION_BLOCKED");
    return { status: pass ? 0 : 1, signal: null, error: null,
      stdout: JSON.stringify({ failed, healthy }), stderr: pass ? "" : "resume assertion failed" };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
function semanticSatisfied(taskId, assertion) {
  if (assertion.status !== 0) return false;
  let json = null;
  try { json = JSON.parse(assertion.stdout); } catch { /* output need not be JSON */ }
  if (taskId === "dogfood.v2.bugfix.report-validation") {
    return json?.failClosedMutationsChecked === 7 && json?.optionalCompletedAgentPairsAccepted === true;
  }
  if (taskId === "dogfood.v2.behavior.non-tty-evidence" ||
      taskId === "dogfood.v2.regression.non-tty-decision-smoke") {
    return json?.nonTtyWithoutInjectedDecision === "approval_required" &&
      json?.nonTtyMutationStarted === false && json?.nonTtyDecisionArtifactCreated === false;
  }
  return true;
}
/** Executes the behavior assertion. Reference bytes are never an oracle. */
function inspectBehavior(workspace, definition) {
  const selected = commands[definition.behaviorCommand];
  if (!selected) throw new Error(`Unapproved behavior assertion: ${definition.behaviorCommand}`);
  const env = { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
    NO_PROXY: "*", P7_14_NETWORK_DISABLED: "1" };
  delete env.CI;
  let cleanup = null;
  if (definition.taskId === "dogfood.v2.bugfix.macos-temp-realpath") {
    const physical = fs.mkdtempSync(path.join(os.tmpdir(), "p7-14-physical-"));
    const alias = `${physical}-alias`;
    fs.symlinkSync(physical, alias, "dir");
    env.TMPDIR = alias;
    cleanup = () => { fs.rmSync(alias, { force: true }); fs.rmSync(physical, { recursive: true, force: true }); };
  }
  const isolationProbe = isolatedRun(process.execPath,
    ["-e", "require('node:net').connect(9,'203.0.113.1').on('error',()=>process.exit(23));setTimeout(()=>process.exit(24),500)"],
    workspace, env, 5_000);
  const isolationVerified = isolationProbe.status === 23;
  const build = isolationVerified
    ? isolatedRun("npm", ["run", "build"], workspace, env)
    : { status: null, signal: null, error: "network_isolation_unavailable", stdout: "", stderr: "" };
  const assertion = build.status === 0
    ? definition.taskId === "dogfood.v2.bugfix.failed-resume"
      ? failedResumeAssertion(workspace, env)
      : isolatedRun(selected[0], selected[1], workspace, env)
    : { status: null, signal: null, error: "build_failed", stdout: "", stderr: "" };
  const passed = build.status === 0 && semanticSatisfied(definition.taskId, assertion);
  if (build.status === 0 && assertion.status === 0 && !passed) {
    process.stderr.write(`P7.14 semantic assertion rejected output for ${definition.taskId}: ${assertion.stdout}\n`);
  }
  if (cleanup) cleanup();
  const output = {
    taskId: definition.taskId, criterionId: definition.criterionId,
    assertionId: definition.assertionId, behaviorCommand: definition.behaviorCommand,
    networkPolicy: "disabled", networkIsolation: { verified: isolationVerified, probe: isolationProbe }, build, assertion,
    result: passed ? "pass" : (build.error || build.status === null) ? "infrastructure_fail" : "assertion_fail"
  };
  return { verdict: output.result, exitCode: assertion.status,
    output, outputHash: hash(JSON.stringify(output)) };
}
module.exports = { inspectBehavior };
