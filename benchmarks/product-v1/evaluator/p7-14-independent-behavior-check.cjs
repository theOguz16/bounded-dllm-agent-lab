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
  // sudo is needed only to create the network namespace. Drop back to the
  // runner identity before exec so validation cannot leave root-owned output.
  return run("sudo", ["-n", "unshare", "-n", `--setuid=${process.getuid()}`,
    `--setgid=${process.getgid()}`, "--", file, ...argv], workspace, env, timeout);
}
function verifyNetworkIsolation(workspace, env) {
  const port = 20_000 + (process.pid % 20_000);
  const server = cp.spawn(process.execPath, ["-e",
    "const n=require('node:net');const s=n.createServer(x=>x.end());s.listen(+process.argv[1],'127.0.0.1');setTimeout(()=>{},60000)",
    String(port)], { cwd: workspace, env, stdio: "ignore" });
  const probe = ["-e",
    "const n=require('node:net');const p=+process.argv[1];let i=0;function go(){const s=n.connect(p,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>{if(++i<40)setTimeout(go,25);else process.exit(22)})}go();setTimeout(()=>process.exit(24),3000)",
    String(port)];
  try {
    const positiveControl = run(process.execPath, probe, workspace, env, 5_000);
    const isolated = positiveControl.status === 0
      ? isolatedRun(process.execPath, probe, workspace, env, 5_000)
      : { status: null, signal: null, error: "network_canary_control_failed", stdout: "", stderr: "" };
    return { verified: positiveControl.status === 0 && isolated.status === 22,
      positiveControl, isolated };
  } finally { server.kill("SIGKILL"); }
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
  const predicates = {
    "dogfood.v2.bugfix.macos-temp-realpath": () => json?.ok === true && json?.controlledRuntimeDirectoriesOutsideRepository === true,
    "dogfood.v2.bugfix.failed-resume": () => json?.failed?.status === 1 && json?.healthy?.status === 79 &&
      /retryPolicy=none forbids re-running failed tasks/.test(json?.failed?.stderr || "") &&
      /P7_14_PROVIDER_INVOCATION_BLOCKED/.test(json?.healthy?.stderr || ""),
    "dogfood.v2.bugfix.compare-failure-typing": () => json?.ok === true && json?.runtimeVersion === "canonical-bounded-compare/v1",
    "dogfood.v2.bugfix.non-tty-smoke-typing": () => json?.nonTtyWithoutInjectedDecision === "approval_required" && json?.nonTtyMutationStarted === false,
    "dogfood.v2.bugfix.report-validation": () => json?.failClosedMutationsChecked === 7 && json?.optionalCompletedAgentPairsAccepted === true,
    "dogfood.v2.behavior.discovery-cost": () => json?.discoveryBudgetMs === 180000 && json?.inputDelta === "-52.7%",
    "dogfood.v2.behavior.non-tty-evidence": () => json?.nonTtyWithoutInjectedDecision === "approval_required" && json?.nonTtyDecisionArtifactCreated === false,
    "dogfood.v2.behavior.blank-decision": () => json?.decisions?.includes("declined") && json?.nonTtyMutationStarted === false,
    "dogfood.v2.behavior.human-decision-capture": () => json?.candidateBound === true && json?.tamperRejected === true,
    "dogfood.v2.behavior.provider-neutral-requirement": () => json?.plannerRepositoryRequirementNone === true && json?.coderRepositoryRequirementDefault === true,
    "dogfood.v2.regression.failed-resume-smoke": () => json?.postFixResumeAfterFailedTask === "forbidden" && json?.retriesOnFailure === 0,
    "dogfood.v2.regression.discovery-budget-smoke": () => json?.discoveryBudgetMs === 180000,
    "dogfood.v2.regression.compare-contract-smoke": () => json?.runtimeVersion === "canonical-bounded-compare/v1" && json?.humanTable === true,
    "dogfood.v2.regression.non-tty-decision-smoke": () => json?.nonTtyMutationStarted === false && json?.nonTtyDecisionArtifactCreated === false,
    "dogfood.v2.regression.auth-home-smoke": () => json?.codexHomeDefaultDirectoryPasses === true && json?.codexHomePropagatesWithoutLoggingPath === true,
    "dogfood.v2.multifile.timeout-budgets": () => json?.liveCompletionGate?.failClosed === true && json?.liveCompletionGate?.expectedAgentRuns === 40,
    "dogfood.v2.multifile.ag1b-artifact": () => /repository intelligence context binding smoke passed/i.test(assertion.stdout),
    "dogfood.v2.multifile.scope-live-compat": () => json?.invalidJsonFailureCodePreserved === true && json?.discoveryFailureTelemetryPreserved === true,
    "dogfood.v2.multifile.crash-recovery": () => json?.canonicalResumeReusedTerminalState === true && json?.canonicalStatusReadable === true,
    "dogfood.v2.multifile.comparison-order": () => json?.baselineFirstCovered === true && json?.boundedFirstCovered === true && json?.executionOrderRecorded === true
  };
  return Object.hasOwn(predicates, taskId) && predicates[taskId]();
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
  const networkIsolation = verifyNetworkIsolation(workspace, env);
  const isolationVerified = networkIsolation.verified;
  const build = isolationVerified
    ? isolatedRun("npm", ["run", "build"], workspace, env)
    : { status: null, signal: null, error: "network_isolation_unavailable", stdout: "", stderr: "" };
  const attackCommand = definition.attack === "noop" ? [process.execPath, ["-e", "process.exit(0)"]] :
    definition.attack === "generic_green" ? [process.execPath, ["-e", "process.stdout.write(JSON.stringify({ok:true}))"]] : null;
  const assertion = build.status === 0
    ? attackCommand
      ? isolatedRun(attackCommand[0], attackCommand[1], workspace, env)
      : definition.taskId === "dogfood.v2.bugfix.failed-resume"
      ? failedResumeAssertion(workspace, env)
      : isolatedRun(selected[0], selected[1], workspace, env)
    : { status: null, signal: null, error: "build_failed", stdout: "", stderr: "" };
  const passed = build.status === 0 && semanticSatisfied(definition.taskId, assertion);
  const buildIsCriterion = definition.taskId === "dogfood.v2.bugfix.compare-failure-typing" ||
    definition.taskId === "dogfood.v2.bugfix.non-tty-smoke-typing";
  if (build.status === 0 && assertion.status === 0 && !passed) {
    process.stderr.write(`P7.14 semantic assertion rejected output for ${definition.taskId}: ${assertion.stdout}\n`);
  }
  if (cleanup) cleanup();
  const output = {
    taskId: definition.taskId, criterionId: definition.criterionId,
    assertionId: definition.assertionId, behaviorCommand: definition.behaviorCommand,
    networkPolicy: "disabled", networkIsolation, build, assertion,
    result: passed ? "pass" : (build.error || build.status === null || (build.status !== 0 && !buildIsCriterion))
      ? "blocked" : "assertion_fail"
  };
  return { verdict: output.result, exitCode: assertion.status,
    output, outputHash: hash(JSON.stringify(output)) };
}
module.exports = { inspectBehavior };
