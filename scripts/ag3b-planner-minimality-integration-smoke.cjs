const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REPORT_PATH = "reports/ag/AG3B_PLANNER_MINIMALITY_INTEGRATION.json";

async function main() {
  const mode = process.argv.includes("--report")
    ? "report"
    : process.argv.includes("--verify")
      ? "verify"
      : "test";

  const integrationApi = await import(
    "../dist/packages/product-runtime/src/planner-minimality-integration.js"
  );
  const {
    runPlannerMinimalityBoundCoderFlow,
    verifyPlannerMinimalityExecutionBinding
  } = integrationApi;
  const {
    createAcceptanceCriteriaContract
  } = await import(
    "../dist/packages/product-runtime/src/acceptance-criteria-contract.js"
  );
  const {
    createPreventiveMinimalityPolicy
  } = await import(
    "../dist/packages/product-runtime/src/preventive-minimality-contract.js"
  );
  const {
    runTaskToSeedBoundCoderFlow
  } = await import(
    "../dist/packages/product-runtime/src/task-to-seed-implementation-contract.js"
  );
  const {
    hashCanonicalJson
  } = await import(
    "../dist/packages/product-runtime/src/agent-event-ledger.js"
  );
  const canonicalRuntime = await import(
    "../dist/packages/product-runtime/src/canonical-runtime.js"
  );

  const roots = [];
  const checks = [];
  const check = async (name, fn) => {
    process.stdout.write(`[run] ${name}\n`);
    await fn();
    checks.push(name);
    process.stdout.write(`[ok] ${name}\n`);
  };

  const fixture = async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ag3b-integration-"));
    roots.push(root);
    const files = {
      "src/index.ts": [
        'import { compute } from "./service.js";',
        'export { compute } from "./service.js";',
        'export function run(value: Input): number { return compute(value); }',
        'import type { Input } from "./types.js";'
      ].join("\n") + "\n",
      "src/service.ts": [
        'import type { Input } from "./types.js";',
        'export function compute(value: Input): number { return value.amount * 2; }'
      ].join("\n") + "\n",
      "src/types.ts": "export type Input = { amount: number };\n",
      "src/unrelated.ts": "export const unrelated = true;\n",
      "tests/service.test.ts": [
        'import { compute } from "../src/service.js";',
        'void compute({ amount: 2 });'
      ].join("\n") + "\n",
      "package.json": JSON.stringify({
        type: "module",
        dependencies: { zod: "^3.0.0" }
      }, null, 2) + "\n"
    };
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, "utf8");
    }
    return { root, files };
  };

  const evidenceFor = (files, paths) => paths.map((file) => {
    const content = files[file];
    const bytes = Buffer.from(content, "utf8");
    return {
      path: file,
      source: "ag3b_fixture",
      content,
      contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      byteLength: bytes.length,
      estimatedTokens: Math.ceil(content.length / 4),
      matchedSymbols:
        file === "src/index.ts"
          ? ["run"]
          : file === "src/service.ts"
            ? ["compute"]
            : []
    };
  });

  const objectiveHash = hashCanonicalJson({
    task: "Adjust compute through the existing service boundary without widening scope."
  });
  const authorityHash = hashCanonicalJson({ authority: "repository_write" });
  const plannerPolicyHash = hashCanonicalJson({ policy: "bounded_planner_v1" });
  const acceptance = createAcceptanceCriteriaContract({
    taskId: "task.ag3b.fixture",
    objectiveHash,
    criteria: [
      {
        id: "service_test",
        description: "The existing service test must remain valid.",
        required: true,
        evidence: { kind: "test", commandId: "test.service" }
      }
    ]
  });
  const limits = {
    maxSeedFiles: 2,
    maxRequiredSymbols: 4,
    maxRequiredTests: 2,
    maxExpansionAttempts: 1
  };

  const policy = (overrides = {}) => createPreventiveMinimalityPolicy({
    policyVersion: "1",
    policyId: "ag3b.fixture",
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
    highRiskBehavior: "disabled",
    maxPlannedFiles: 4,
    maxNewDependencies: 1,
    maxNewAbstractions: 1,
    ...overrides
  });

  const proposalCore = (overrides = {}) => ({
    proposalVersion: "1",
    taskId: "task.ag3b.fixture",
    objectiveHash,
    acceptanceContractHash: acceptance.contractHash,
    authorityHash,
    policyHash: plannerPolicyHash,
    seedFiles: ["src/index.ts"],
    seedRationales: [
      {
        path: "src/index.ts",
        reasonHash: hashCanonicalJson({ reason: "public service boundary" })
      }
    ],
    requiredSymbols: ["compute", "run"],
    requiredTestFiles: ["tests/service.test.ts"],
    maxExpansionAttempts: 1,
    ...overrides
  });
  const signedProposal = (overrides = {}) => {
    const core = proposalCore(overrides);
    return { ...core, proposalHash: hashCanonicalJson(core) };
  };

  const cleanPlan = (overrides = {}) => ({
    planVersion: "1",
    riskClass: "low",
    taskExplicitlyRequestsRefactor: false,
    plannedFiles: [
      {
        path: "src/service.ts",
        changeKind: "bugfix",
        requested: true,
        justification: "The requested behavior is implemented at the existing service boundary."
      }
    ],
    newDependencies: [],
    newAbstractions: [],
    ...overrides
  });

  const output = (plan = cleanPlan(), proposal = signedProposal()) => ({
    proposal,
    minimalityPlan: plan
  });

  const first = await fixture();
  const initialEvidence = evidenceFor(first.files, [
    "src/index.ts",
    "src/service.ts",
    "src/types.ts",
    "tests/service.test.ts"
  ]);

  const run = async ({
    minimalityPolicy = policy(),
    provider = async () => output(),
    coderProvider = async () => ({ kind: "patch", files: ["src/service.ts"] }),
    authorityPresent = true,
    policyPresent = true,
    forbiddenFiles = [],
    allowedChangeFiles = ["src/service.ts", "tests/service.test.ts"]
  } = {}) => runPlannerMinimalityBoundCoderFlow({
    repositoryPath: first.root,
    taskId: "task.ag3b.fixture",
    objectiveHash,
    acceptanceCriteriaContract: acceptance,
    authorityHash,
    policyHash: plannerPolicyHash,
    proposalLimits: limits,
    minimalityPolicy,
    allowedChangeFiles,
    forbiddenFiles,
    taskContext: { task: "Use the existing compute service." },
    initialEvidence,
    authorityPresent,
    policyPresent,
    hardTotalBudgetTokens: 8192,
    reservedOutputTokens: 512,
    contextRequestProvider: async () => {
      throw new Error("Complete fixture evidence must not request expansion.");
    },
    plannerMinimalityProvider: provider,
    coderProvider
  });

  try {
    await check("canonical runtime exports the planner-minimality integration surface", async () => {
      assert.equal(typeof canonicalRuntime.runPlannerMinimalityBoundCoderFlow, "function");
      assert.equal(typeof canonicalRuntime.verifyPlannerMinimalityExecutionBinding, "function");
    });

    await check("missing authority blocks before the single provider call", async () => {
      let providerCalls = 0;
      const result = await run({
        authorityPresent: false,
        provider: async () => { providerCalls += 1; return output(); }
      });
      assert.equal(result.decision, "planner_minimality_task_invalid");
      assert.equal(providerCalls, 0);
      assert.equal(result.summary.plannerProviderCallCount, 0);
    });

    await check("tampered minimality policy blocks before provider execution", async () => {
      const tampered = JSON.parse(JSON.stringify(policy()));
      tampered.maxPlannedFiles += 1;
      let providerCalls = 0;
      const result = await run({
        minimalityPolicy: tampered,
        provider: async () => { providerCalls += 1; return output(); }
      });
      assert.equal(result.decision, "planner_minimality_task_invalid");
      assert.equal(providerCalls, 0);
    });

    await check("invalid change scope blocks before provider execution", async () => {
      let providerCalls = 0;
      const result = await run({
        forbiddenFiles: ["src/service.ts"],
        allowedChangeFiles: ["src/service.ts"],
        provider: async () => { providerCalls += 1; return output(); }
      });
      assert.equal(result.decision, "planner_minimality_task_invalid");
      assert.equal(providerCalls, 0);
      assert(result.issues.some((entry) => entry.code === "planner_minimality_request_invalid"));
    });

    await check("provider output uses an exact combined proposal and minimality envelope", async () => {
      const result = await run({
        provider: async () => ({ ...output(), extra: true })
      });
      assert.equal(result.decision, "planner_minimality_task_stopped");
      assert(result.issues.some((entry) => entry.code === "planner_minimality_provider_failed"));
    });

    let observedContext = null;
    let providerCalls = 0;
    let coderCalls = 0;
    const ready = await run({
      provider: async (context) => {
        providerCalls += 1;
        assert.equal(context.minimalityPolicy.policyHash, policy().policyHash);
        assert.deepEqual(context.allowedChangeFiles, ["src/service.ts", "tests/service.test.ts"]);
        return output();
      },
      coderProvider: async (context) => {
        coderCalls += 1;
        observedContext = context;
        return { kind: "patch", files: ["src/service.ts"] };
      }
    });

    await check("one combined planner call reaches exactly one coder call", async () => {
      assert.equal(ready.decision, "planner_minimality_task_completed", JSON.stringify(ready));
      assert.equal(ready.route, "coder_executed");
      assert.equal(providerCalls, 1);
      assert.equal(coderCalls, 1);
      assert.equal(ready.summary.plannerProviderCallCount, 1);
      assert.equal(ready.summary.minimalityGateCallCount, 1);
      assert.equal(ready.summary.coderProviderCallCount, 1);
    });

    await check("minimality receipt and baseline are bound into coder context", async () => {
      assert(observedContext);
      const serialized = JSON.stringify(observedContext);
      assert(serialized.includes(ready.minimalityResult.receipt.receiptHash));
      assert(serialized.includes(ready.minimalityResult.baseline.baselineHash));
      assert(serialized.includes(ready.minimalityResult.plan.planHash));
    });

    await check("planner minimality execution binding is complete and tamper evident", async () => {
      assert(ready.executionBinding);
      assert.equal(verifyPlannerMinimalityExecutionBinding(ready.executionBinding), true);
      assert.equal(ready.executionBinding.proposalHash, ready.proposal.proposalHash);
      assert.equal(
        ready.executionBinding.minimalityReceiptHash,
        ready.minimalityResult.receipt.receiptHash
      );
      const tampered = JSON.parse(JSON.stringify(ready.executionBinding));
      tampered.minimalityReceiptHash = `sha256:${"f".repeat(64)}`;
      assert.equal(verifyPlannerMinimalityExecutionBinding(tampered), false);
    });

    await check("missing dependency justification requests planner revision before coder", async () => {
      let coderCalls = 0;
      const result = await run({
        provider: async () => output(cleanPlan({
          newDependencies: [{
            name: "left-pad",
            requested: true,
            purpose: "padding",
            justification: null,
            standardLibraryConsidered: true,
            nativePlatformConsidered: true,
            existingDependenciesConsidered: ["zod"],
            whyExistingInsufficient: "Schema validation does not provide string padding."
          }]
        })),
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.route, "replan_required");
      assert.equal(coderCalls, 0);
      assert(result.issues.some((entry) => entry.code === "minimality_dependency_justification_missing"));
    });

    await check("already installed dependencies are replanned before coder", async () => {
      let coderCalls = 0;
      const result = await run({
        provider: async () => output(cleanPlan({
          newDependencies: [{
            name: "zod",
            requested: true,
            purpose: "validation",
            justification: "Validate the input.",
            standardLibraryConsidered: true,
            nativePlatformConsidered: true,
            existingDependenciesConsidered: ["zod"],
            whyExistingInsufficient: "The declaration incorrectly treats the installed package as new."
          }]
        })),
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.route, "replan_required");
      assert.equal(coderCalls, 0);
      assert(result.issues.some((entry) => entry.code === "minimality_installed_dependency_should_be_reused"));
    });

    await check("complete unrequested dependency plans route to human review", async () => {
      let coderCalls = 0;
      const result = await run({
        provider: async () => output(cleanPlan({
          newDependencies: [{
            name: "left-pad",
            requested: false,
            purpose: "padding",
            justification: "A package is proposed for consistent padding behavior.",
            standardLibraryConsidered: true,
            nativePlatformConsidered: true,
            existingDependenciesConsidered: ["zod"],
            whyExistingInsufficient: "The installed dependency is unrelated to string formatting."
          }]
        })),
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.route, "human_review_required");
      assert.equal(coderCalls, 0);
      assert(result.issues.some((entry) => entry.code === "minimality_unrequested_dependency_human_review_required"));
    });

    await check("unrequested refactors are revised before coder", async () => {
      let coderCalls = 0;
      const result = await run({
        provider: async () => output(cleanPlan({
          plannedFiles: [{
            path: "src/service.ts",
            changeKind: "refactor",
            requested: false,
            justification: "Move logic without changing behavior."
          }]
        })),
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.route, "replan_required");
      assert.equal(coderCalls, 0);
      assert(result.issues.some((entry) => entry.code === "minimality_unrequested_refactor_replan_required"));
    });

    await check("insufficient abstraction reuse evidence requests revision", async () => {
      let coderCalls = 0;
      const result = await run({
        allowedChangeFiles: ["src/service.ts", "src/helper.ts", "tests/service.test.ts"],
        provider: async () => output(cleanPlan({
          plannedFiles: [
            {
              path: "src/service.ts",
              changeKind: "bugfix",
              requested: true,
              justification: "Update the service."
            },
            {
              path: "src/helper.ts",
              changeKind: "feature",
              requested: false,
              justification: "Host a proposed helper."
            }
          ],
          newAbstractions: [{
            abstractionId: "compute-helper",
            filePath: "src/helper.ts",
            requested: false,
            purpose: "Share compute logic.",
            justification: "Extract a helper.",
            reuseSites: ["src/service.ts"],
            whyInlineInsufficient: "The proposal expects reuse."
          }]
        })),
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.route, "replan_required");
      assert.equal(coderCalls, 0);
      assert(result.issues.some((entry) => entry.code === "minimality_abstraction_reuse_case_insufficient"));
    });

    await check("high-risk disabled policy bypasses enforcement but preserves evidence", async () => {
      const result = await run({
        provider: async () => output(cleanPlan({ riskClass: "high" }))
      });
      assert.equal(result.decision, "planner_minimality_task_completed", JSON.stringify(result));
      assert.equal(result.summary.policyBypassed, true);
      assert.equal(result.minimalityResult.decision, "minimality_policy_disabled");
      assert(result.executionBinding);
    });

    await check("high-risk human-review policy stops before coder", async () => {
      let coderCalls = 0;
      const result = await run({
        minimalityPolicy: policy({ highRiskBehavior: "human_review" }),
        provider: async () => output(cleanPlan({ riskClass: "critical" })),
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.route, "human_review_required");
      assert.equal(coderCalls, 0);
      assert(result.issues.some((entry) => entry.code === "minimality_high_risk_human_review_required"));
    });

    await check("forbidden planned files stop before coder", async () => {
      let coderCalls = 0;
      const result = await run({
        forbiddenFiles: ["src/unrelated.ts"],
        allowedChangeFiles: ["src/service.ts", "tests/service.test.ts"],
        provider: async () => output(cleanPlan({
          plannedFiles: [{
            path: "src/unrelated.ts",
            changeKind: "refactor",
            requested: false,
            justification: "Unrelated cleanup."
          }]
        })),
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.route, "replan_required");
      assert.equal(coderCalls, 0);
    });

    await check("graph audit failure blocks the minimality gate and coder", async () => {
      let coderCalls = 0;
      const result = await run({
        provider: async () => output(cleanPlan(), signedProposal({
          requiredSymbols: ["missingSymbol"]
        })),
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.route, "replan_required");
      assert.equal(result.summary.minimalityGateCallCount, 0);
      assert.equal(coderCalls, 0);
      assert(result.issues.some((entry) => entry.code === "implementation_required_symbol_unresolved"));
    });

    await check("provider failure stops before audit minimality and coder", async () => {
      let coderCalls = 0;
      const result = await run({
        provider: async () => { throw new Error("provider unavailable"); },
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.route, "replan_required");
      assert.equal(result.summary.preMinimalityAuditCallCount, 0);
      assert.equal(result.summary.minimalityGateCallCount, 0);
      assert.equal(coderCalls, 0);
    });

    await check("required intelligence snapshot mismatch blocks task-seed coder execution", async () => {
      let coderCalls = 0;
      const result = await runTaskToSeedBoundCoderFlow({
        repositoryPath: first.root,
        contract: ready.implementationContract,
        acceptanceCriteriaContract: acceptance,
        taskContext: {},
        initialEvidence,
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 8192,
        reservedOutputTokens: 512,
        requiredIntelligenceHash: `sha256:${"f".repeat(64)}`,
        contextRequestProvider: async () => ({}),
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.decision, "task_seed_coder_stopped");
      assert.equal(result.route, "replan_required");
      assert.equal(coderCalls, 0);
      assert(result.issues.some((entry) => entry.code === "implementation_required_intelligence_mismatch"));
    });

    await check("integration declares no repository write shell or network side effect", async () => {
      assert.equal(ready.summary.repositoryWritePerformed, false);
      assert.equal(ready.summary.shellExecuted, false);
      assert.equal(ready.summary.networkAccessedByIntegration, false);
    });

    const reportCore = {
      evidenceClass: "deterministic_fixture",
      phase: "AG.3b",
      decision: "ag3b_planner_minimality_integration_evidence_ready",
      checkCount: checks.length,
      checks,
      integration: {
        singleCombinedPlannerProviderCall: true,
        preventiveMinimalityBeforeCoder: true,
        intelligenceSnapshotLockedAcrossGate: true,
        minimalityEvidenceBoundIntoCoderContext: true,
        coderIntegrationCompleted: true,
        openAICombinedAdapterLiveValidationCompleted: false
      },
      claims: {
        observedLiveModelQuality: false,
        observedTokenSavings: false,
        observedLatency: false,
        observedInfrastructureCost: false
      }
    };
    const report = {
      ...reportCore,
      reportHash: hashCanonicalJson(reportCore)
    };

    if (mode === "report") {
      await fsp.mkdir(path.dirname(REPORT_PATH), { recursive: true });
      await fsp.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify({
        decision: "ag3b_planner_minimality_integration_evidence_written",
        path: REPORT_PATH,
        reportHash: report.reportHash,
        checkCount: checks.length,
        coderIntegrationCompleted: true
      }, null, 2)}\n`);
    } else if (mode === "verify") {
      const stored = JSON.parse(await fsp.readFile(REPORT_PATH, "utf8"));
      assert.deepEqual(stored, report);
      process.stdout.write(`${JSON.stringify({
        decision: "ag3b_planner_minimality_integration_evidence_ready",
        reportHash: report.reportHash,
        checkCount: checks.length,
        coderIntegrationCompleted: true,
        openAICombinedAdapterLiveValidationCompleted: false
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`planner minimality integration smoke passed (${checks.length} checks)\n`);
    }
  } finally {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
