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

function contentHash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sourceSnapshotHash(files) {
  return contentHash(
    JSON.stringify(
      Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([file, content]) => [file, contentHash(content)])
    )
  );
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
      seedRationales: [
        {
          path: "src/calculate.ts",
          reason: "The existing implementation is the smallest authorized change boundary."
        }
      ],
      requiredSymbols: [],
      requiredTestFiles: [],
      maxExpansionAttempts: 1
    },
    minimalityPlan: {
      planVersion: "1",
      riskClass: "low",
      taskExplicitlyRequestsRefactor: false,
      plannedFiles: [
        {
          path: "src/calculate.ts",
          changeKind: "bugfix",
          requested: true,
          justification: null
        }
      ],
      newDependencies: [],
      newAbstractions: []
    }
  };
}

function parsePlannerContext(task) {
  const line = task.split("\n").at(-1);
  return JSON.parse(line);
}

function createFakeAdapter(sourceRoot, options = {}) {
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
        const context = parsePlannerContext(request.task);
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
          usage: options.plannerUsageMissing
            ? {
                inputTokens: null,
                outputTokens: null,
                totalTokens: null,
                cachedInputTokens: null,
                toolCalls: null
              }
            : {
                inputTokens: 120,
                outputTokens: 30,
                totalTokens: 150,
                cachedInputTokens: 20,
                toolCalls: null
              },
          commands: [],
          fileChanges: [],
          diagnostics: []
        };
      }

      assert.equal(request.mode, "coder");
      assert.equal(request.sandboxMode, "workspace_write");
      const target = path.join(request.workingDirectory, "src/calculate.ts");
      assert.equal(fs.existsSync(path.join(request.workingDirectory, ".git")), true);
      assert.equal(fs.existsSync(target), true);
      assert.equal(fs.existsSync(path.join(request.workingDirectory, "src/hidden.ts")), false);
      fs.writeFileSync(
        target,
        "export function calculate(value: number): number { return value * 3; }\n"
      );
      return {
        status: "completed",
        agentId: "codex",
        agentVersion: "fake-codex/v1",
        modelId: request.model,
        durationMs: 11,
        finalMessage: "Changed the existing implementation file.",
        usage: {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          cachedInputTokens: null,
          toolCalls: null
        },
        commands: [],
        fileChanges: [
          {
            sequence: 1,
            path: "src/calculate.ts",
            operation: "modify"
          }
        ],
        diagnostics: []
      };
    }
  };
}

function providerControl(reports) {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    deadlineAt: Date.now() + 60_000,
    reportUsage(report) {
      reports.push(report);
    }
  };
}

async function main() {
  const providerModule = await import(pathToFileURL(providerModulePath).href);
  const runtime = await import(pathToFileURL(runtimeModulePath).href);

  assert.equal(typeof providerModule.createCodexBoundedProvider, "function");
  assert.equal(providerModule.CODEX_BOUNDED_PROVIDER_VERSION, "codex-bounded-provider/v1");

  const original =
    "export function calculate(value: number): number { return value * 2; }\n";
  const files = {
    "src/calculate.ts": original,
    "src/hidden.ts": "export const hidden = true;\n"
  };
  const sourceRoot = makeRepo(files);
  const snapshotHash = sourceSnapshotHash(files);

  try {
    const directAdapter = createFakeAdapter(sourceRoot);
    const direct = providerModule.createCodexBoundedProvider({
      repositoryPath: sourceRoot,
      sourceSnapshotHash: snapshotHash,
      allowedChangeFiles: ["src/calculate.ts"],
      forbiddenFiles: [],
      model: "fixture-model",
      adapter: directAdapter,
      providerTimeoutMs: 30_000
    });

    const objectiveHash = runtime.hashCanonicalJson({ objective: "Fix calculate safely." });
    const acceptance = runtime.createAcceptanceCriteriaContract({
      taskId: "task.codex.bridge.direct",
      objectiveHash,
      criteria: [
        {
          id: "calculate_behavior",
          description: "Calculation behavior must be corrected.",
          required: true,
          evidence: { kind: "test", commandId: "test.calculate" }
        }
      ]
    });
    const authorityHash = runtime.hashCanonicalJson({ authority: "fixture" });
    const policyHash = runtime.hashCanonicalJson({ policy: "fixture" });
    const minimalityPolicy = runtime.createPreventiveMinimalityPolicy({
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
    const plannerContext = {
      version: "1",
      taskId: "task.codex.bridge.direct",
      objectiveHash,
      acceptanceContractHash: acceptance.contractHash,
      authorityHash,
      policyHash,
      limits: {
        maxSeedFiles: 1,
        maxRequiredSymbols: 0,
        maxRequiredTests: 0,
        maxExpansionAttempts: 1
      },
      allowedChangeFiles: ["src/calculate.ts"],
      forbiddenFiles: [],
      minimalityPolicy,
      taskContext: {
        objective: "Fix calculate safely.",
        seedFiles: ["src/calculate.ts"]
      }
    };

    const plannerReports = [];
    const plannerOutput = await direct.plannerMinimalityProvider(
      plannerContext,
      providerControl(plannerReports)
    );
    assert.equal(plannerReports.length, 1);
    assert.equal(plannerReports[0].status, "observed");
    assert.equal(plannerReports[0].totalTokens, 150);
    assert.match(plannerOutput.proposal.proposalHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(plannerOutput.proposal.seedRationales[0].reasonHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(
      directAdapter.requests[0].finalMessage,
      undefined,
      "adapter requests must not carry model-computed hashes"
    );

    const coderContext = {
      version: "1",
      baseContext: { taskId: "task.codex.bridge.direct" },
      evidence: [
        {
          path: "src/calculate.ts",
          source: "initial_context",
          content: original,
          contentHash: contentHash(original),
          byteLength: Buffer.byteLength(original),
          estimatedTokens: Math.ceil(original.length / 4),
          matchedSymbols: [],
          origin: "initial_context"
        }
      ],
      provenance: [
        {
          path: "src/calculate.ts",
          origin: "initial_context",
          contentHash: contentHash(original),
          source: "initial_context"
        }
      ],
      budget: {
        estimatedInputTokens: 100,
        reservedOutputTokens: 100,
        hardTotalBudgetTokens: 1000,
        remainingTokens: 800
      }
    };
    const coderReports = [];
    const mutation = await direct.coderProvider(coderContext, providerControl(coderReports));
    assert.equal(coderReports.length, 1);
    assert.equal(coderReports[0].status, "unavailable");
    assert.equal(coderReports[0].reason, "provider_usage_missing");
    assert.equal(Object.hasOwn(coderReports[0], "inputTokens"), false);
    assert.equal(Object.hasOwn(coderReports[0], "estimatedTokens"), false);
    assert.equal(mutation.role, "coder");
    assert.equal(mutation.target, "patchDraft");
    assert.deepEqual(mutation.touchedFiles, ["src/calculate.ts"]);
    assert.equal(mutation.claims[0].claimVersion, "text-file-update/v1");
    assert.equal(mutation.claims[0].expectedContentHash, contentHash(original));
    assert.equal(
      fs.readFileSync(path.join(sourceRoot, "src/calculate.ts"), "utf8"),
      original,
      "Codex bridge must never mutate the source repository"
    );

    const endToEndAdapter = createFakeAdapter(sourceRoot);
    const endToEnd = providerModule.createCodexBoundedProvider({
      repositoryPath: sourceRoot,
      sourceSnapshotHash: snapshotHash,
      allowedChangeFiles: ["src/calculate.ts"],
      forbiddenFiles: [],
      model: "fixture-model",
      adapter: endToEndAdapter,
      providerTimeoutMs: 30_000
    });
    const taskId = "task.codex.bridge.runtime";
    const e2eObjectiveHash = runtime.hashCanonicalJson({ objective: "Fix calculate safely." });
    const e2eAcceptance = runtime.createAcceptanceCriteriaContract({
      taskId,
      objectiveHash: e2eObjectiveHash,
      criteria: [
        {
          id: "calculate_behavior",
          description: "Calculation behavior must be corrected.",
          required: true,
          evidence: { kind: "test", commandId: "test.calculate" }
        }
      ]
    });
    const e2eAuthorityHash = runtime.hashCanonicalJson({
      authority: "codex-bounded-provider-smoke",
      allowedChangeFiles: ["src/calculate.ts"]
    });
    const e2ePolicyHash = runtime.hashCanonicalJson({ policy: "codex-bounded-provider-smoke" });
    const e2eMinimalityPolicy = runtime.createPreventiveMinimalityPolicy({
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
    const evidence = {
      path: "src/calculate.ts",
      source: "initial_context",
      content: original,
      contentHash: contentHash(original),
      byteLength: Buffer.byteLength(original),
      estimatedTokens: Math.ceil(original.length / 4),
      matchedSymbols: []
    };

    const result = await runtime.runBoundedTask({
      repositoryPath: sourceRoot,
      taskId,
      objectiveHash: e2eObjectiveHash,
      acceptanceCriteriaContract: e2eAcceptance,
      authorityHash: e2eAuthorityHash,
      policyHash: e2ePolicyHash,
      proposalLimits: {
        maxSeedFiles: 1,
        maxRequiredSymbols: 0,
        maxRequiredTests: 0,
        maxExpansionAttempts: 1
      },
      minimalityPolicy: e2eMinimalityPolicy,
      allowedChangeFiles: ["src/calculate.ts"],
      forbiddenFiles: [],
      taskContext: {
        objective: "Fix calculate safely.",
        seedFiles: ["src/calculate.ts"],
        requiredSymbols: [],
        requiredTestFiles: []
      },
      initialEvidence: [evidence],
      authorityPresent: true,
      policyPresent: true,
      hardTotalBudgetTokens: 4096,
      reservedOutputTokens: 512,
      timeoutMs: 60_000,
      plannerMinimalityProvider: endToEnd.plannerMinimalityProvider,
      coderProvider: endToEnd.coderProvider,
      contextRequestProvider: async () => ({
        requestedFiles: [],
        requiredSymbols: [],
        reason: "No context expansion is needed for the deterministic fixture."
      }),
      costBudget: {
        maxProviderCalls: 2,
        maxEstimatedTokens: 20_000,
        providerId: "codex",
        modelId: "fixture-model",
        reservedOutputTokens: 512
      }
    });

    assert.equal(result.decision, "bounded_task_completed");
    assert.equal(result.route, "structurally_verified_draft");
    assert.equal(result.receipt?.outcome, "structurally_verified_draft");
    assert.equal(result.summary.plannerCalled, true);
    assert.equal(result.summary.coderCalled, true);
    assert.equal(result.summary.verifierCalled, true);
    assert.equal(result.summary.applyCalled, false);
    assert.equal(endToEndAdapter.requests.length, 2);
    assert.equal(endToEndAdapter.requests[0].mode, "planner");
    assert.equal(endToEndAdapter.requests[1].mode, "coder");
    assert.equal(result.summary.costBudget.reservations.length, 2);
    assert.equal(result.summary.costBudget.reconciliations.length, 2);
    const usageStatuses = result.summary.costBudget.reconciliations.map(
      (entry) => entry.usage.status
    );
    assert.deepEqual(usageStatuses.sort(), ["observed", "unavailable"]);
    const unavailable = result.summary.costBudget.reconciliations.find(
      (entry) => entry.usage.status === "unavailable"
    );
    assert.equal(unavailable.usage.reason, "provider_usage_missing");
    assert.equal(
      result.summary.costBudget.reconciliations.some(
        (entry) => entry.usage.status === "estimated"
      ),
      false
    );
    assert.equal(
      fs.readFileSync(path.join(sourceRoot, "src/calculate.ts"), "utf8"),
      original
    );

    const missingUsageAdapter = createFakeAdapter(sourceRoot, { plannerUsageMissing: true });
    const missingUsage = providerModule.createCodexBoundedProvider({
      repositoryPath: sourceRoot,
      sourceSnapshotHash: snapshotHash,
      allowedChangeFiles: ["src/calculate.ts"],
      forbiddenFiles: [],
      model: "fixture-model",
      adapter: missingUsageAdapter
    });
    const missingReports = [];
    await missingUsage.plannerMinimalityProvider(
      plannerContext,
      providerControl(missingReports)
    );
    assert.equal(missingReports[0].status, "unavailable");
    assert.equal(missingReports[0].reason, "provider_usage_missing");

    process.stdout.write(
      `${JSON.stringify(
        {
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
        },
        null,
        2
      )}\n`
    );
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
