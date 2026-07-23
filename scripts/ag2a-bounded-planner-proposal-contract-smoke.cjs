const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REPORT_PATH = "reports/ag/AG2A_BOUNDED_PLANNER_PROPOSAL_CONTRACT.json";

async function main() {
  const mode = process.argv.includes("--report")
    ? "report"
    : process.argv.includes("--verify")
      ? "verify"
      : "test";

  const plannerApi = await import(
    "../dist/packages/product-runtime/src/bounded-planner-proposal-contract.js"
  );
  const {
    createBoundedPlannerProposal,
    verifyBoundedPlannerProposal,
    validateBoundedPlannerProposal,
    runBoundedPlannerTaskFlow,
    verifyBoundedPlannerExecutionBinding
  } = plannerApi;
  const {
    createAcceptanceCriteriaContract
  } = await import(
    "../dist/packages/product-runtime/src/acceptance-criteria-contract.js"
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
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ag2a-planner-"));
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
      "package.json": '{"type":"module"}\n'
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
      source: "ag2a_fixture",
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
    task: "Use compute through the existing service boundary."
  });
  const authorityHash = hashCanonicalJson({ authority: "repository_write" });
  const policyHash = hashCanonicalJson({ policy: "bounded_context_v1" });
  const acceptance = createAcceptanceCriteriaContract({
    taskId: "task.ag2a.fixture",
    objectiveHash,
    criteria: [
      {
        id: "service_test",
        description: "The existing service test must pass.",
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

  const proposalCore = (overrides = {}) => ({
    proposalVersion: "1",
    taskId: "task.ag2a.fixture",
    objectiveHash,
    acceptanceContractHash: acceptance.contractHash,
    authorityHash,
    policyHash,
    seedFiles: ["src/index.ts"],
    seedRationales: [
      {
        path: "src/index.ts",
        reasonHash: hashCanonicalJson({ reason: "public entrypoint for compute" })
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
  const validate = (rawProposal, overrides = {}) => validateBoundedPlannerProposal({
    rawProposal,
    taskId: "task.ag2a.fixture",
    objectiveHash,
    acceptanceCriteriaContract: acceptance,
    authorityHash,
    policyHash,
    limits,
    ...overrides
  });

  const first = await fixture();

  try {
    await check("canonical runtime exports the bounded planner surface", async () => {
      assert.equal(typeof canonicalRuntime.createBoundedPlannerProposal, "function");
      assert.equal(typeof canonicalRuntime.validateBoundedPlannerProposal, "function");
      assert.equal(typeof canonicalRuntime.runBoundedPlannerTaskFlow, "function");
    });

    await check("planner proposal is deterministic and tamper evident", async () => {
      const raw = signedProposal();
      const firstProposal = createBoundedPlannerProposal({
        rawProposal: raw,
        expectedTaskId: "task.ag2a.fixture",
        expectedObjectiveHash: objectiveHash,
        expectedAcceptanceContractHash: acceptance.contractHash,
        expectedAuthorityHash: authorityHash,
        expectedPolicyHash: policyHash,
        limits
      });
      const secondProposal = createBoundedPlannerProposal({
        rawProposal: signedProposal(),
        expectedTaskId: "task.ag2a.fixture",
        expectedObjectiveHash: objectiveHash,
        expectedAcceptanceContractHash: acceptance.contractHash,
        expectedAuthorityHash: authorityHash,
        expectedPolicyHash: policyHash,
        limits
      });
      assert.equal(firstProposal.proposalHash, secondProposal.proposalHash);
      assert.equal(verifyBoundedPlannerProposal(firstProposal), true);
      const tampered = JSON.parse(JSON.stringify(firstProposal));
      tampered.requiredSymbols.push("unrelated");
      assert.equal(verifyBoundedPlannerProposal(tampered), false);
    });

    await check("unknown planner fields fail exact schema validation", async () => {
      const core = proposalCore({ extraField: true });
      const result = validate({ ...core, proposalHash: hashCanonicalJson(core) });
      assert.equal(result.decision, "planner_proposal_invalid");
      assert(result.issues.some((entry) => entry.code === "planner_proposal_unknown_field"));
    });

    await check("task objective and acceptance identity must match", async () => {
      const result = validate(signedProposal({ taskId: "task.other" }));
      assert.equal(result.decision, "planner_proposal_invalid");
      assert(result.issues.some((entry) => entry.code === "planner_proposal_identity_mismatch"));
    });

    await check("authority and policy hashes must match", async () => {
      const result = validate(signedProposal({ authorityHash: hashCanonicalJson({ authority: "other" }) }));
      assert.equal(result.decision, "planner_proposal_invalid");
      assert(result.issues.some((entry) => entry.code === "planner_proposal_authority_mismatch"));
    });

    await check("repository path escape is rejected", async () => {
      const result = validate(signedProposal({
        seedFiles: ["../secret.ts"],
        seedRationales: [{
          path: "../secret.ts",
          reasonHash: hashCanonicalJson({ reason: "invalid" })
        }]
      }));
      assert.equal(result.decision, "planner_proposal_invalid");
      assert(result.issues.some((entry) => entry.code === "planner_proposal_path_escape"));
    });

    await check("planner scope cannot exceed configured limits", async () => {
      const result = validate(signedProposal({
        seedFiles: ["src/index.ts", "src/service.ts", "src/types.ts"],
        seedRationales: ["src/index.ts", "src/service.ts", "src/types.ts"].map((file) => ({
          path: file,
          reasonHash: hashCanonicalJson({ file })
        }))
      }));
      assert.equal(result.decision, "planner_proposal_invalid");
      assert(result.issues.some((entry) => entry.code === "planner_proposal_path_count_invalid"));
    });

    await check("seed rationales must cover seed files exactly", async () => {
      const result = validate(signedProposal({ seedRationales: [] }));
      assert.equal(result.decision, "planner_proposal_invalid");
      assert(result.issues.some((entry) => entry.code === "planner_proposal_seed_rationale_count_invalid"));
    });

    await check("forbidden path conflicts require replanning", async () => {
      const result = validate(signedProposal(), { forbiddenFiles: ["src/index.ts"] });
      assert.equal(result.decision, "planner_proposal_blocked");
      assert(result.issues.some((entry) => entry.code === "planner_proposal_forbidden_file_conflict"));
      assert.equal(result.implementationContract, null);
    });

    await check("missing authority blocks before planner provider", async () => {
      let plannerCalls = 0;
      const result = await runBoundedPlannerTaskFlow({
        repositoryPath: first.root,
        taskId: "task.ag2a.fixture",
        objectiveHash,
        acceptanceCriteriaContract: acceptance,
        authorityHash,
        policyHash,
        proposalLimits: limits,
        taskContext: {},
        authorityPresent: false,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        plannerProvider: async () => { plannerCalls += 1; return signedProposal(); },
        contextRequestProvider: async () => ({}),
        coderProvider: async () => ({})
      });
      assert.equal(result.decision, "planner_task_invalid");
      assert.equal(plannerCalls, 0);
      assert.equal(result.summary.plannerProviderCallCount, 0);
    });

    await check("planner provider failure stops before implementation flow", async () => {
      const result = await runBoundedPlannerTaskFlow({
        repositoryPath: first.root,
        taskId: "task.ag2a.fixture",
        objectiveHash,
        acceptanceCriteriaContract: acceptance,
        authorityHash,
        policyHash,
        proposalLimits: limits,
        taskContext: {},
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        plannerProvider: async () => { throw new Error("planner unavailable"); },
        contextRequestProvider: async () => ({}),
        coderProvider: async () => ({})
      });
      assert.equal(result.decision, "planner_task_stopped");
      assert.equal(result.summary.taskSeedFlowCallCount, 0);
      assert(result.issues.some((entry) => entry.code === "planner_provider_failed"));
    });

    await check("graph audit blocks unresolved planner symbols before coder", async () => {
      let coderCalls = 0;
      const result = await runBoundedPlannerTaskFlow({
        repositoryPath: first.root,
        taskId: "task.ag2a.fixture",
        objectiveHash,
        acceptanceCriteriaContract: acceptance,
        authorityHash,
        policyHash,
        proposalLimits: limits,
        taskContext: {},
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        plannerProvider: async () => signedProposal({ requiredSymbols: ["missingSymbol"] }),
        contextRequestProvider: async () => ({}),
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.decision, "planner_task_stopped");
      assert.equal(result.route, "replan_required");
      assert(result.issues.some((entry) => entry.code === "implementation_required_symbol_unresolved"));
      assert.equal(coderCalls, 0);
    });

    let observedContext = null;
    let plannerCalls = 0;
    let coderCalls = 0;
    let requestCalls = 0;
    const readyResult = await runBoundedPlannerTaskFlow({
      repositoryPath: first.root,
      taskId: "task.ag2a.fixture",
      objectiveHash,
      acceptanceCriteriaContract: acceptance,
      authorityHash,
      policyHash,
      proposalLimits: limits,
      taskContext: { task: "Use the existing compute service." },
      initialEvidence: evidenceFor(first.files, [
        "src/index.ts",
        "src/service.ts",
        "src/types.ts",
        "tests/service.test.ts"
      ]),
      authorityPresent: true,
      policyPresent: true,
      hardTotalBudgetTokens: 8192,
      reservedOutputTokens: 512,
      plannerProvider: async () => { plannerCalls += 1; return signedProposal(); },
      contextRequestProvider: async () => {
        requestCalls += 1;
        throw new Error("Complete evidence must not request expansion.");
      },
      coderProvider: async (context) => {
        coderCalls += 1;
        observedContext = context;
        return { kind: "patch", files: ["src/service.ts"] };
      }
    });

    await check("valid proposal reaches exactly one planner and coder call", async () => {
      assert.equal(readyResult.decision, "planner_task_completed", JSON.stringify(readyResult));
      assert.equal(readyResult.route, "coder_executed");
      assert.equal(plannerCalls, 1);
      assert.equal(coderCalls, 1);
      assert.equal(requestCalls, 0);
      assert.equal(readyResult.summary.plannerProviderCallCount, 1);
      assert.equal(readyResult.summary.taskSeedFlowCallCount, 1);
      assert.equal(readyResult.summary.coderProviderCallCount, 1);
    });

    await check("coder context is bound to the planner proposal hash", async () => {
      assert(observedContext);
      assert(readyResult.proposal);
      const taskSeedContext = observedContext.baseContext.taskContext;
      assert.equal(
        taskSeedContext.taskContext.plannerProposalHash,
        readyResult.proposal.proposalHash
      );
      assert.equal(
        taskSeedContext.implementationContract.contractHash,
        readyResult.implementationContract.contractHash
      );
    });

    await check("planner execution binding is hash linked and tamper evident", async () => {
      assert(readyResult.executionBinding);
      assert.equal(verifyBoundedPlannerExecutionBinding(readyResult.executionBinding), true);
      assert.equal(
        readyResult.executionBinding.proposalHash,
        readyResult.proposal.proposalHash
      );
      assert.equal(
        readyResult.executionBinding.implementationContractHash,
        readyResult.implementationContract.contractHash
      );
      const tampered = JSON.parse(JSON.stringify(readyResult.executionBinding));
      tampered.proposalHash = `sha256:${"f".repeat(64)}`;
      assert.equal(verifyBoundedPlannerExecutionBinding(tampered), false);
    });

    const reportCore = {
      evidenceClass: "deterministic_fixture",
      phase: "AG.2a",
      decision: "ag2a_evidence_ready",
      checkCount: checks.length,
      checks,
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
        decision: "ag2a_evidence_written",
        path: REPORT_PATH,
        reportHash: report.reportHash,
        checkCount: checks.length
      }, null, 2)}\n`);
    } else if (mode === "verify") {
      const stored = JSON.parse(await fsp.readFile(REPORT_PATH, "utf8"));
      assert.deepEqual(stored, report);
      process.stdout.write(`${JSON.stringify({
        decision: "ag2a_evidence_ready",
        reportHash: report.reportHash,
        checkCount: checks.length
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`bounded planner proposal contract smoke passed (${checks.length} checks)\n`);
    }
  } finally {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
