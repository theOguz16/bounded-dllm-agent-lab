#!/usr/bin/env node
"use strict";

/*
 * Canonical benchmark adapter.  Gate6's simulated harness remains available
 * for research comparisons; this adapter is deliberately a separate report
 * format and invokes the public runBoundedTask API for every sample.
 */
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const runtime = require("../dist/packages/product-runtime/src/canonical-runtime.js");
const { TaskProviderInterruption } = require("../dist/packages/product-runtime/src/task-provider-deadline.js");

const VERSION = "canonical-runtime-benchmark/v2";
const ORACLE_SENTINEL = "CANONICAL_BENCHMARK_HIDDEN_ORACLE_SENTINEL";

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function jsonHash(value) { return runtime.hashCanonicalJson(value); }

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

function minimalityPolicy() {
  return runtime.createPreventiveMinimalityPolicy({
    policyVersion: "1", policyId: "canonical-runtime-benchmark.v1",
    preferExistingCode: true, preferStandardLibrary: true, preferNativePlatform: true,
    preferInstalledDependencies: true, newDependencyRequiresJustification: true,
    newDependencyRequiresAlternatives: true, newAbstractionRequiresJustification: true,
    newAbstractionMinReuseSites: 2, unrequestedDependencyBehavior: "human_review",
    unrequestedAbstractionBehavior: "human_review", unrequestedRefactorBehavior: "replan",
    highRiskBehavior: "human_review", maxPlannedFiles: 1, maxNewDependencies: 0,
    maxNewAbstractions: 0
  });
}

async function createFixture() {
  const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-runtime-benchmark-"));
  const source = "export function compute(value: number): number { return value * 2; }\n";
  const test = "import { compute } from '../src/service.js';\nvoid compute(2);\n";
  await write(path.join(repositoryPath, "src/service.ts"), source);
  await write(path.join(repositoryPath, "tests/service.test.ts"), test);
  await write(path.join(repositoryPath, "package.json"), { type: "module" });
  git(repositoryPath, ["init", "--quiet"]);
  git(repositoryPath, ["config", "user.email", "canonical-benchmark@example.invalid"]);
  git(repositoryPath, ["config", "user.name", "Canonical Benchmark"]);
  git(repositoryPath, ["add", "."]);
  git(repositoryPath, ["commit", "--quiet", "-m", "baseline"]);
  const objectiveHash = jsonHash({ objective: "Fix compute multiplication." });
  const acceptance = runtime.createAcceptanceCriteriaContract({
    taskId: "canonical-benchmark.compute", objectiveHash,
    criteria: [{ id: "service_behavior", description: "compute returns the corrected value.", required: true,
      evidence: { kind: "test", commandId: "test.service" } }]
  });
  const policy = runtime.compileCanonicalPolicy({ repositoryPath,
    policyDocument: { schemaVersion: "1", allowed_paths: ["src/**"], forbidden_paths: ["package.json"],
      paired_files: [], sensitive_patterns: [], sensitive_paths: [], ownership_rules: [] } });
  const files = [{ path: "src/service.ts", source: "canonical-benchmark", content: source,
    contentHash: hash(source), byteLength: Buffer.byteLength(source), estimatedTokens: Math.ceil(source.length / 4),
    matchedSymbols: ["compute"] }, { path: "tests/service.test.ts", source: "canonical-benchmark", content: test,
    contentHash: hash(test), byteLength: Buffer.byteLength(test), estimatedTokens: Math.ceil(test.length / 4),
    matchedSymbols: [] }];
  return { repositoryPath, source, objectiveHash, acceptance, policy, files,
    baselineCommit: git(repositoryPath, ["rev-parse", "HEAD"]) };
}

function createInput(fixture, scenario) {
  const newContent = scenario === "behavior_failure"
    ? "export function compute(value: number): number { return value * ; }\n"
    : scenario === "behavior_wrong_result"
      ? "export function compute(value: number): number { return value * 999; }\n"
      : "export function compute(value: number): number { return value * 3; }\n";
  const plannerCore = { proposalVersion: "1", taskId: "canonical-benchmark.compute",
    objectiveHash: fixture.objectiveHash, acceptanceContractHash: fixture.acceptance.contractHash,
    authorityHash: jsonHash({ authority: "canonical-benchmark/v1" }), policyHash: fixture.policy.compiledPolicyHash,
    seedFiles: ["src/service.ts"], seedRationales: [{ path: "src/service.ts", reasonHash: jsonHash({ reason: "implementation" }) }],
    requiredSymbols: ["compute"], requiredTestFiles: ["tests/service.test.ts"], maxExpansionAttempts: 1 };
  const noChange = scenario === "no_change";
  return {
    repositoryPath: fixture.repositoryPath, taskId: "canonical-benchmark.compute", objectiveHash: fixture.objectiveHash,
    acceptanceCriteriaContract: fixture.acceptance, authorityHash: plannerCore.authorityHash,
    policyHash: fixture.policy.compiledPolicyHash,
    proposalLimits: { maxSeedFiles: 1, maxRequiredSymbols: 1, maxRequiredTests: 1, maxExpansionAttempts: 1 },
    minimalityPolicy: minimalityPolicy(), allowedChangeFiles: ["src/service.ts"], forbiddenFiles: ["package.json"],
    canonicalPolicy: { compiledPolicy: fixture.policy }, taskContext: { objective: "Fix compute multiplication." },
    initialEvidence: fixture.files, authorityPresent: true, policyPresent: true, hardTotalBudgetTokens: 4000,
    validationProfile: "structural_draft",
    costBudget: { maxProviderCalls: 3, maxEstimatedTokens: 20_000, providerId: "offline-fixture",
      modelId: "offline-fixture-v1", reservedOutputTokens: 256 },
    plannerMinimalityProvider: async (context) => {
      if (JSON.stringify(context).includes(ORACLE_SENTINEL)) throw new Error("oracle data leaked to planner");
      return ({ proposal: { ...plannerCore,
      policyHash: context.policyHash, proposalHash: jsonHash(plannerCore) },
      minimalityPlan: { planVersion: "1", riskClass: "low", taskExplicitlyRequestsRefactor: false,
        plannedFiles: [{ path: "src/service.ts", changeKind: "bugfix", requested: true, justification: null }],
        newDependencies: [], newAbstractions: [] } });
    },
    contextRequestProvider: async () => ({ requestedFiles: ["src/service.ts"], requestedSymbols: [],
      requestedTests: [], evidenceKinds: ["target_file"], reason: "Confirm implementation boundary.",
      scopeExpansionRequested: false, maxAdditionalTokens: 512 }),
    coderProvider: async (context) => ({
      ...(JSON.stringify(context).includes(ORACLE_SENTINEL) ? (() => { throw new Error("oracle data leaked to coder"); })() : {}),
      role: "coder", target: "patchDraft", summary: noChange ? "No change required." : "Update compute.",
      claims: noChange ? [] : [{ type: "patch_draft", claimVersion: "text-file-update/v1", operation: "update", file: "src/service.ts",
        expectedContentHash: hash(fixture.source), description: "Correct multiplication.", newContent }],
      touchedFiles: noChange ? [] : ["src/service.ts"], confidence: 0.9 })
  };
}

function mutationFromResult(result) {
  return result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.providerOutput ?? null;
}

async function executeBehaviorAssertion(fixture, result) {
  const mutation = mutationFromResult(result);
  if (mutation === null) return Object.freeze({ status: "not_run", reason: "candidate_mutation_unavailable",
    exitCode: null, assertionHash: null });
  let claims;
  try { claims = runtime.parseTextFileUpdates(mutation); }
  catch { return Object.freeze({ status: "not_run", reason: "candidate_mutation_invalid",
    exitCode: null, assertionHash: null }); }
  if (claims.length === 0) return Object.freeze({ status: "not_run", reason: "candidate_has_no_changes",
    exitCode: null, assertionHash: null });
  const candidate = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-runtime-behavior-"));
  const assertion = [
    "import { compute } from '../src/service.ts';",
    "const cases = [[2, 6], [-1, -3], [0, 0]];",
    "for (const [input, expected] of cases) {",
    "  if (compute(input) !== expected) process.exit(1);",
    "}"
  ].join("\n");
  const assertionHash = hash(assertion);
  try {
    await fs.cp(fixture.repositoryPath, candidate, { recursive: true,
      filter: (source) => path.basename(source) !== ".git" });
    for (const claim of claims) {
      const target = path.resolve(candidate, claim.file);
      if (!target.startsWith(`${candidate}${path.sep}`)) return Object.freeze({ status: "not_run",
        reason: "candidate_path_invalid", exitCode: null, assertionHash });
      await fs.writeFile(target, claim.newContent, "utf8");
    }
    const assertionFile = path.join(candidate, ".benchmark-oracle", "behavior.mjs");
    await write(assertionFile, `${assertion}\n`);
    const execution = spawnSync(process.execPath,
      ["--no-warnings", "--experimental-strip-types", assertionFile], {
        cwd: candidate, shell: false, encoding: "utf8", timeout: 5_000,
        maxBuffer: 64 * 1024, env: { PATH: process.env.PATH ?? "" }
      });
    if (execution.error) return Object.freeze({ status: execution.error.code === "ETIMEDOUT" ? "failed" : "not_run",
      reason: execution.error.code === "ETIMEDOUT" ? "behavior_assertion_timeout" : "behavior_runner_unavailable",
      exitCode: null, assertionHash });
    return Object.freeze({ status: execution.status === 0 ? "passed" : "failed",
      reason: execution.status === 0 ? null : "behavior_assertion_failed",
      exitCode: execution.status, assertionHash });
  } finally { await fs.rm(candidate, { recursive: true, force: true }); }
}

function evaluateScenario(result, behaviorTest) {
  const mutation = result.verifierResult?.canonicalClaimFiles ?? [];
  const behaviorPassed = behaviorTest.status === "passed";
  return {
    decision: result.decision, route: result.route, fileScopeSuccess: mutation.length === 1,
    endToEndAccepted: result.decision === "bounded_task_completed" && behaviorPassed && mutation.length === 1,
    behaviorTest,
    policyCompliant: result.route !== "human_review_required" || result.failure?.code !== "canonical_policy_preflight_rejected",
    safeStop: result.decision === "bounded_task_stopped", recoveryRequired: result.route === "recovery_required",
    durationMs: null, costBudget: result.summary.costBudget ?? null,
    runtimeEvidenceHash: jsonHash({ decision: result.decision, route: result.route,
      validationEvidence: result.verifierResult?.validationEvidence ?? null,
      plannerDecision: result.plannerResult?.decision ?? null }),
    receiptHash: result.receipt?.receiptHash ?? null
  };
}

async function runCanonicalRuntimeBenchmark(options = {}) {
  const scenarios = options.scenarios ?? ["behavior_success", "behavior_failure", "no_change", "timeout"];
  const observations = [];
  for (const scenario of scenarios) {
    const fixture = await createFixture();
    const started = Date.now();
    let input = createInput(fixture, scenario);
    if (scenario === "timeout") {
      input = { ...input, timeoutMs: 1000,
        plannerMinimalityProvider: async (_context, control) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          control.signal.throwIfAborted?.();
          throw new TaskProviderInterruption("bounded_task_deadline_exceeded", "planning");
        } };
    }
    const result = await runtime.runBoundedTask(input);
    const behaviorTest = await executeBehaviorAssertion(fixture, result);
    const observation = evaluateScenario(result, behaviorTest);
    observation.durationMs = Date.now() - started;
    observations.push(Object.freeze({ scenario, sourceCommit: fixture.baselineCommit, ...observation }));
    await fs.rm(fixture.repositoryPath, { recursive: true, force: true });
  }
  const reportCore = { schemaVersion: VERSION, executionClass: "canonical_runtime_offline_fixture",
    liveModelEvidence: false, oracleVisibility: "verifier_only", hiddenOracleSentinel: null,
    benchmarkSemantics: "benchmarks/gate6/benchmark-semantics.json", observations };
  const report = { ...reportCore, reportHash: jsonHash(reportCore) };
  if (options.output) await write(options.output, report);
  return Object.freeze(report);
}

async function main() {
  const report = await runCanonicalRuntimeBenchmark();
  process.stdout.write(`${JSON.stringify({ ok: true, schemaVersion: report.schemaVersion,
    executionClass: report.executionClass, liveModelEvidence: report.liveModelEvidence,
    sampleCount: report.observations.length, reportHash: report.reportHash })}\n`);
}

module.exports = { ORACLE_SENTINEL, VERSION, createFixture, createInput, runCanonicalRuntimeBenchmark };
if (require.main === module) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? "CANONICAL_BENCHMARK_FAILURE", message: error.message })}\n`);
  process.exitCode = 1;
});
