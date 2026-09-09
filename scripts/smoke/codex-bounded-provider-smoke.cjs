#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");
const providerModulePath = path.resolve(
  repoRoot,
  "dist/apps/cli/src/providers/codex-bounded-provider.js"
);
const runtimeModulePath = path.resolve(
  repoRoot,
  "dist/packages/product-runtime/src/canonical-runtime.js"
);

const original =
  "export function calculate(value: number): number { return value * 2; }\n";
const changed =
  "export function calculate(value: number): number { return value * 3; }\n";
const policy = [
  'schemaVersion: "1"',
  "allowed_paths:",
  "  - src/**",
  "forbidden_paths: []",
  "paired_files: []",
  "sensitive_patterns: []",
  "sensitive_paths: []",
  "ownership_rules: []",
  ""
].join("\n");

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function snapshotHash(files) {
  return hash(JSON.stringify(Object.entries(files).sort().map(
    ([file, content]) => [file, hash(content)]
  )));
}

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bounded-provider-source-"));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function plannerDraft(context) {
  return {
    proposal: {
      proposalVersion: "1",
      taskId: context.taskId,
      objectiveHash: context.objectiveHash,
      acceptanceContractHash: context.acceptanceContractHash,
      authorityHash: context.authorityHash,
      policyHash: context.policyHash,
      seedFiles: ["src/calculate.ts"],
      seedRationales: [{
        path: "src/calculate.ts",
        reason: "The existing implementation is the smallest authorized change boundary."
      }],
      requiredSymbols: [],
      requiredTestFiles: [],
      maxExpansionAttempts: 1
    },
    minimalityPlan: {
      planVersion: "1",
      riskClass: "low",
      taskExplicitlyRequestsRefactor: false,
      plannedFiles: [{
        path: "src/calculate.ts",
        changeKind: "bugfix",
        requested: true,
        justification: null
      }],
      newDependencies: [],
      newAbstractions: []
    }
  };
}

function fakeAdapter(sourceRoot, { plannerUsageMissing = false } = {}) {
  const requests = [];
  return {
    agentId: "codex",
    agentVersion: "fake-codex/v1",
    requests,
    async run(request) {
      requests.push(request);
      assert.equal(request.agentId, "codex");
      assert.equal(request.networkAllowed, false);
      assert.notEqual(path.resolve(request.workingDirectory), path.resolve(sourceRoot));
      assert.equal(request.abortSignal instanceof AbortSignal, true);

      if (request.mode === "planner") {
        assert.equal(request.sandboxMode, "read_only");
        const context = JSON.parse(request.task.split("\n").at(-1));
        const draft = plannerDraft(context);
        assert.equal(JSON.stringify(draft).includes("proposalHash"), false);
        assert.equal(JSON.stringify(draft).includes("reasonHash"), false);
        return {
          status: "completed",
          agentId: "codex",
          agentVersion: "fake-codex/v1",
          modelId: request.model,
          durationMs: 7,
          finalMessage: JSON.stringify(draft),
          usage: plannerUsageMissing
            ? { inputTokens: null, outputTokens: null, totalTokens: null,
                cachedInputTokens: null, toolCalls: null }
            : { inputTokens: 120, outputTokens: 30, totalTokens: 150,
                cachedInputTokens: 20, toolCalls: null },
          commands: [],
          fileChanges: [],
          diagnostics: []
        };
      }

      assert.equal(request.mode, "coder");
      assert.equal(request.sandboxMode, "workspace_write");
      assert.equal(fs.existsSync(path.join(request.workingDirectory, ".git")), true);
      assert.equal(fs.existsSync(path.join(request.workingDirectory, "src/calculate.ts")), true);
      assert.equal(fs.existsSync(path.join(request.workingDirectory, "src/hidden.ts")), false);
      fs.writeFileSync(path.join(request.workingDirectory, "src/calculate.ts"), changed);
      return {
        status: "completed",
        agentId: "codex",
        agentVersion: "fake-codex/v1",
        modelId: request.model,
        durationMs: 11,
        finalMessage: "Changed the existing implementation file.",
        usage: { inputTokens: null, outputTokens: null, totalTokens: null,
          cachedInputTokens: null, toolCalls: null },
        commands: [],
        fileChanges: [{ sequence: 1, path: "src/calculate.ts", operation: "modify" }],
        diagnostics: []
      };
    }
  };
}

function control(reports) {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    deadlineAt: Date.now() + 60_000,
    reportUsage(report) { reports.push(report); }
  };
}

function minimalityPolicy(runtime) {
  return runtime.createPreventiveMinimalityPolicy({
    policyVersion: "1",
    policyId: "codex-bounded-provider-smoke",
    preferExistingCode: true,
    preferStandardLibrary: true,
    preferNativePlatform: true,
    preferInstalledDependencies: true,
    newDependencyRequiresJustification: true,
    newDependencyRequiresAlternatives: true,
    newAbstractionRequiresJustification: true,
    newAbstractionMinReuseSites: 2,
    unrequestedDependencyBehavior: "human_review",
    unrequestedAbstractionBehavior: "human_review",
    unrequestedRefactorBehavior: "replan",
    highRiskBehavior: "human_review",
    maxPlannedFiles: 1,
    maxNewDependencies: 0,
    maxNewAbstractions: 0
  });
}

function acceptance(runtime, taskId, objectiveHash) {
  return runtime.createAcceptanceCriteriaContract({
    taskId,
    objectiveHash,
    criteria: [{
      id: "calculate_behavior",
      description: "Calculation behavior must be corrected.",
      required: true,
      evidence: { kind: "test", commandId: "test.calculate" }
    }]
  });
}

function evidence() {
  return {
    path: "src/calculate.ts",
    source: "initial_context",
    content: original,
    contentHash: hash(original),
    byteLength: Buffer.byteLength(original),
    estimatedTokens: Math.ceil(original.length / 4),
    matchedSymbols: []
  };
}

async function main() {
  const providerModule = await import(pathToFileURL(providerModulePath).href);
  const runtime = await import(pathToFileURL(runtimeModulePath).href);
  assert.equal(typeof providerModule.createCodexBoundedProvider, "function");

  const files = {
    "src/calculate.ts": original,
    "src/hidden.ts": "export const hidden = true;\n",
    "bounded-agent.policy.yml": policy
  };
  const sourceRoot = makeRepo(files);
  const sourceSnapshotHash = snapshotHash(files);

  try {
    const taskId = "task.codex.bridge.direct";
    const objectiveHash = runtime.hashCanonicalJson({ objective: "Fix calculate safely." });
    const acceptanceContract = acceptance(runtime, taskId, objectiveHash);
    const authorityHash = runtime.hashCanonicalJson({ authority: "fixture" });
    const policyHash = runtime.hashCanonicalJson({ policy: "fixture" });
    const adapter = fakeAdapter(sourceRoot);
    const bridge = providerModule.createCodexBoundedProvider({
      repositoryPath: sourceRoot,
      sourceSnapshotHash,
      allowedChangeFiles: ["src/calculate.ts"],
      forbiddenFiles: [],
      model: "fixture-model",
      adapter,
      providerTimeoutMs: 30_000
    });

    const plannerReports = [];
    const plannerOutput = await bridge.plannerMinimalityProvider({
      version: "1",
      taskId,
      objectiveHash,
      acceptanceContractHash: acceptanceContract.contractHash,
      authorityHash,
      policyHash,
      limits: { maxSeedFiles: 1, maxRequiredSymbols: 0,
        maxRequiredTests: 0, maxExpansionAttempts: 1 },
      allowedChangeFiles: ["src/calculate.ts"],
      forbiddenFiles: [],
      minimalityPolicy: minimalityPolicy(runtime),
      taskContext: { objective: "Fix calculate safely.", seedFiles: ["src/calculate.ts"] }
    }, control(plannerReports));
    assert.equal(plannerReports[0].status, "observed");
    assert.equal(plannerReports[0].totalTokens, 150);
    assert.match(plannerOutput.proposal.proposalHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(plannerOutput.proposal.seedRationales[0].reasonHash, /^sha256:[0-9a-f]{64}$/);

    const coderReports = [];
    const mutation = await bridge.coderProvider({
      version: "1",
      baseContext: { taskId },
      evidence: [{ ...evidence(), origin: "initial_context" }],
      provenance: [{ path: "src/calculate.ts", origin: "initial_context",
        contentHash: hash(original), source: "initial_context" }],
      budget: { estimatedInputTokens: 100, reservedOutputTokens: 100,
        hardTotalBudgetTokens: 1000, remainingTokens: 800 }
    }, control(coderReports));
    assert.equal(coderReports[0].status, "unavailable");
    assert.equal(coderReports[0].reason, "provider_usage_missing");
    assert.equal(Object.hasOwn(coderReports[0], "estimatedTokens"), false);
    assert.equal(mutation.claims[0].claimVersion, "text-file-update/v1");
    assert.equal(mutation.claims[0].expectedContentHash, hash(original));
    assert.equal(fs.readFileSync(path.join(sourceRoot, "src/calculate.ts"), "utf8"), original);

    const runtimeTaskId = "task.codex.bridge.runtime";
    const runtimeObjectiveHash = runtime.hashCanonicalJson({ objective: "Fix calculate safely." });
    const runtimeAdapter = fakeAdapter(sourceRoot);
    const runtimeBridge = providerModule.createCodexBoundedProvider({
      repositoryPath: sourceRoot,
      sourceSnapshotHash,
      allowedChangeFiles: ["src/calculate.ts"],
      forbiddenFiles: [],
      model: "fixture-model",
      adapter: runtimeAdapter,
      providerTimeoutMs: 30_000
    });
    const runtimeAcceptance = acceptance(runtime, runtimeTaskId, runtimeObjectiveHash);
    const result = await runtime.runBoundedTask({
      repositoryPath: sourceRoot,
      taskId: runtimeTaskId,
      objectiveHash: runtimeObjectiveHash,
      acceptanceCriteriaContract: runtimeAcceptance,
      authorityHash: runtime.hashCanonicalJson({ authority: "runtime-fixture" }),
      policyHash: runtime.hashCanonicalJson({ policy: "runtime-fixture" }),
      proposalLimits: { maxSeedFiles: 1, maxRequiredSymbols: 0,
        maxRequiredTests: 0, maxExpansionAttempts: 1 },
      minimalityPolicy: minimalityPolicy(runtime),
      allowedChangeFiles: ["src/calculate.ts"],
      forbiddenFiles: [],
      taskContext: { objective: "Fix calculate safely.", seedFiles: ["src/calculate.ts"],
        requiredSymbols: [], requiredTestFiles: [] },
      initialEvidence: [evidence()],
      authorityPresent: true,
      policyPresent: true,
      hardTotalBudgetTokens: 4096,
      reservedOutputTokens: 512,
      timeoutMs: 60_000,
      plannerMinimalityProvider: runtimeBridge.plannerMinimalityProvider,
      coderProvider: runtimeBridge.coderProvider,
      contextRequestProvider: async () => ({ requestedFiles: [], requiredSymbols: [],
        reason: "No context expansion is needed for the deterministic fixture." }),
      costBudget: { maxProviderCalls: 2, maxEstimatedTokens: 20_000,
        providerId: "codex", modelId: "fixture-model", reservedOutputTokens: 512 }
    });

    assert.equal(result.decision, "bounded_task_completed", JSON.stringify({
      decision: result.decision,
      route: result.route,
      failure: result.failure,
      plannerIssues: result.plannerResult?.issues,
      verifierIssues: result.verifierResult?.issues
    }));
    assert.equal(result.route, "structurally_verified_draft");
    assert.equal(result.receipt?.outcome, "structurally_verified_draft");
    assert.equal(result.summary.plannerCalled, true);
    assert.equal(result.summary.coderCalled, true);
    assert.equal(result.summary.verifierCalled, true);
    assert.equal(result.summary.applyCalled, false);
    assert.equal(runtimeAdapter.requests.length, 2);
    assert.deepEqual(runtimeAdapter.requests.map((request) => request.mode), ["planner", "coder"]);
    assert.equal(result.summary.costBudget.reservations.length, 2);
    assert.equal(result.summary.costBudget.reconciliations.length, 2);
    const statuses = result.summary.costBudget.reconciliations.map((item) => item.usage.status).sort();
    assert.deepEqual(statuses, ["observed", "unavailable"]);
    assert.equal(result.summary.costBudget.reconciliations.some(
      (item) => item.usage.status === "estimated"), false);
    const unavailable = result.summary.costBudget.reconciliations.find(
      (item) => item.usage.status === "unavailable");
    assert.equal(unavailable.usage.reason, "provider_usage_missing");
    assert.equal(fs.readFileSync(path.join(sourceRoot, "src/calculate.ts"), "utf8"), original);

    const noUsageAdapter = fakeAdapter(sourceRoot, { plannerUsageMissing: true });
    const noUsageBridge = providerModule.createCodexBoundedProvider({
      repositoryPath: sourceRoot,
      sourceSnapshotHash,
      allowedChangeFiles: ["src/calculate.ts"],
      forbiddenFiles: [],
      model: "fixture-model",
      adapter: noUsageAdapter
    });
    const noUsageReports = [];
    await noUsageBridge.plannerMinimalityProvider({
      version: "1", taskId, objectiveHash,
      acceptanceContractHash: acceptanceContract.contractHash,
      authorityHash, policyHash,
      limits: { maxSeedFiles: 1, maxRequiredSymbols: 0,
        maxRequiredTests: 0, maxExpansionAttempts: 1 },
      allowedChangeFiles: ["src/calculate.ts"], forbiddenFiles: [],
      minimalityPolicy: minimalityPolicy(runtime),
      taskContext: { objective: "Fix calculate safely." }
    }, control(noUsageReports));
    assert.equal(noUsageReports[0].status, "unavailable");
    assert.equal(noUsageReports[0].reason, "provider_usage_missing");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      bridgeVersion: "codex-bounded-provider/v1",
      existingRunBoundedTaskCoordinatorUsed: true,
      plannerMinimalityProviderBound: true,
      coderProviderBound: true,
      disposableWorkspaceUsed: true,
      sourceRepositoryMutated: false,
      diffCapturedAsWorkspaceMutation: true,
      expectedContentHashFromPreAgentManifest: true,
      observedUsageReported: true,
      missingUsageReportedUnavailable: true,
      estimatedUsageFabricated: false,
      costBudgetReconciled: true,
      realCodexCalls: false,
      fakeAdapterOnly: true
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
