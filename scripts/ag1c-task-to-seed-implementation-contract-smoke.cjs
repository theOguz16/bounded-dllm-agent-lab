const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REPORT_PATH = "reports/ag/AG1C_TASK_TO_SEED_IMPLEMENTATION_CONTRACT.json";

async function main() {
  const mode = process.argv.includes("--report")
    ? "report"
    : process.argv.includes("--verify")
      ? "verify"
      : "test";

  const contractApi = await import(
    "../dist/packages/product-runtime/src/task-to-seed-implementation-contract.js"
  );
  const {
    createTaskToSeedImplementationContract,
    verifyTaskToSeedImplementationContract,
    auditTaskToSeedImplementationContract,
    verifyTaskToSeedImplementationAudit,
    runTaskToSeedBoundCoderFlow,
    verifyTaskToSeedExecutionBinding
  } = contractApi;
  const {
    createAcceptanceCriteriaContract
  } = await import(
    "../dist/packages/product-runtime/src/acceptance-criteria-contract.js"
  );
  const {
    runRepoIntelligenceBoundCoderFlow
  } = await import(
    "../dist/packages/product-runtime/src/repo-intelligence-context-binding.js"
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

  const fixture = async (overrides = {}) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ag1c-contract-"));
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
      "package.json": '{"type":"module"}\n',
      ...overrides
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
      source: "ag1c_fixture",
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
  const acceptance = createAcceptanceCriteriaContract({
    taskId: "task.ag1c.fixture",
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
  const makeContract = (overrides = {}) => createTaskToSeedImplementationContract({
    taskId: "task.ag1c.fixture",
    objectiveHash,
    seedFiles: ["src/index.ts"],
    requiredSymbols: ["compute", "run"],
    requiredTestFiles: ["tests/service.test.ts"],
    acceptanceCriteriaContract: acceptance,
    ...overrides
  });

  const first = await fixture();
  const contract = makeContract();
  const before = treeDigest(first.root);
  let observedContext = null;
  let coderCalls = 0;
  let requestCalls = 0;
  const readyResult = await runTaskToSeedBoundCoderFlow({
    repositoryPath: first.root,
    contract,
    acceptanceCriteriaContract: acceptance,
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

  try {
    await check("canonical runtime exports the task-to-seed contract surface", async () => {
      assert.equal(canonicalRuntime.CANONICAL_PRODUCT_RUNTIME_ENTRYPOINT, "canonical-product-runtime/v0.2-dev");
      assert.equal(typeof canonicalRuntime.createTaskToSeedImplementationContract, "function");
      assert.equal(typeof canonicalRuntime.auditTaskToSeedImplementationContract, "function");
      assert.equal(typeof canonicalRuntime.runTaskToSeedBoundCoderFlow, "function");
    });

    await check("implementation contract is deterministic and tamper evident", async () => {
      const second = makeContract();
      assert.equal(second.contractHash, contract.contractHash);
      assert.equal(verifyTaskToSeedImplementationContract(contract, acceptance), true);
      const tampered = JSON.parse(JSON.stringify(contract));
      tampered.seedFiles.push("src/unrelated.ts");
      assert.equal(verifyTaskToSeedImplementationContract(tampered, acceptance), false);
    });

    await check("acceptance criteria must bind to the same task and objective", async () => {
      const mismatched = createAcceptanceCriteriaContract({
        taskId: "task.other",
        objectiveHash,
        criteria: acceptance.criteria
      });
      assert.throws(() => createTaskToSeedImplementationContract({
        taskId: "task.ag1c.fixture",
        objectiveHash,
        seedFiles: ["src/index.ts"],
        acceptanceCriteriaContract: mismatched
      }));
    });

    const auditResult = await auditTaskToSeedImplementationContract({
      repositoryPath: first.root,
      contract,
      acceptanceCriteriaContract: acceptance
    });

    await check("repository graph audit resolves seeds symbols tests and acceptance", async () => {
      assert.equal(auditResult.decision, "implementation_contract_ready", JSON.stringify(auditResult));
      assert(auditResult.audit);
      assert.equal(auditResult.summary.contractVerified, true);
      assert.equal(auditResult.summary.acceptanceContractVerified, true);
      assert.equal(auditResult.summary.resolvedSymbolCount, 2);
      assert.equal(auditResult.summary.resolvedTestCount, 1);
      assert.deepEqual(auditResult.audit.dependencyClosure, [
        "src/index.ts",
        "src/service.ts",
        "src/types.ts"
      ]);
    });

    await check("implementation audit receipt is deterministic and tamper evident", async () => {
      assert.equal(verifyTaskToSeedImplementationAudit(auditResult.audit), true);
      const second = await auditTaskToSeedImplementationContract({
        repositoryPath: first.root,
        contract,
        acceptanceCriteriaContract: acceptance
      });
      assert.equal(second.audit.auditHash, auditResult.audit.auditHash);
      const tampered = JSON.parse(JSON.stringify(auditResult.audit));
      tampered.dependencyClosure.push("src/unrelated.ts");
      assert.equal(verifyTaskToSeedImplementationAudit(tampered), false);
    });

    await check("missing seed blocks before context and coder providers", async () => {
      const missing = makeContract({ seedFiles: ["src/missing.ts"] });
      let requests = 0;
      let coders = 0;
      const result = await runTaskToSeedBoundCoderFlow({
        repositoryPath: first.root,
        contract: missing,
        acceptanceCriteriaContract: acceptance,
        taskContext: {},
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        contextRequestProvider: async () => { requests += 1; return {}; },
        coderProvider: async () => { coders += 1; return {}; }
      });
      assert.equal(result.decision, "task_seed_coder_stopped");
      assert.equal(result.summary.repoFlowCallCount, 0);
      assert.equal(requests, 0);
      assert.equal(coders, 0);
    });

    await check("unresolved required symbols block before coder execution", async () => {
      const missingSymbol = makeContract({ requiredSymbols: ["missingSymbol"] });
      let coders = 0;
      const result = await runTaskToSeedBoundCoderFlow({
        repositoryPath: first.root,
        contract: missingSymbol,
        acceptanceCriteriaContract: acceptance,
        taskContext: {},
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        contextRequestProvider: async () => ({}),
        coderProvider: async () => { coders += 1; return {}; }
      });
      assert.equal(result.decision, "task_seed_coder_stopped");
      assert(result.issues.some((entry) => entry.code === "implementation_required_symbol_unresolved"));
      assert.equal(coders, 0);
    });

    await check("missing required tests block before coder execution", async () => {
      const missingTest = makeContract({ requiredTestFiles: ["tests/missing.test.ts"] });
      let coders = 0;
      const result = await runTaskToSeedBoundCoderFlow({
        repositoryPath: first.root,
        contract: missingTest,
        acceptanceCriteriaContract: acceptance,
        taskContext: {},
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        contextRequestProvider: async () => ({}),
        coderProvider: async () => { coders += 1; return {}; }
      });
      assert.equal(result.decision, "task_seed_coder_stopped");
      assert(result.issues.some((entry) => entry.code === "implementation_required_test_missing"));
      assert.equal(coders, 0);
    });

    await check("audited contract reaches exactly one coder call", async () => {
      assert.equal(readyResult.decision, "task_seed_coder_completed", JSON.stringify(readyResult));
      assert.equal(readyResult.route, "coder_executed");
      assert.equal(coderCalls, 1);
      assert.equal(requestCalls, 0);
      assert.equal(readyResult.summary.repoFlowCallCount, 1);
      assert.equal(readyResult.summary.coderProviderCallCount, 1);
    });

    await check("coder context contains contract audit and bounded graph hashes", async () => {
      assert(observedContext);
      const bound = observedContext.baseContext;
      assert.equal(bound.taskContext.implementationContract.contractHash, contract.contractHash);
      assert.equal(bound.taskContext.implementationContract.auditHash, readyResult.audit.auditHash);
      assert.equal(bound.repositoryIntelligence.intelligenceHash, readyResult.audit.intelligenceHash);
      assert.deepEqual(
        observedContext.evidence.map((entry) => entry.path).sort(),
        ["src/index.ts", "src/service.ts", "src/types.ts", "tests/service.test.ts"]
      );
    });

    await check("AG.1b enforces the audited intelligence snapshot before providers", async () => {
      let requests = 0;
      let coders = 0;
      const result = await runRepoIntelligenceBoundCoderFlow({
        repositoryPath: first.root,
        seedFiles: ["src/index.ts"],
        requiredIntelligenceHash: `sha256:${"0".repeat(64)}`,
        baseContext: {},
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        contextRequestProvider: async () => { requests += 1; return {}; },
        coderProvider: async () => { coders += 1; return {}; }
      });
      assert.equal(result.decision, "repo_context_binding_stopped");
      assert.equal(result.route, "replan_required");
      assert(result.issues.some((entry) => entry.code === "repo_context_intelligence_snapshot_mismatch"));
      assert.equal(requests, 0);
      assert.equal(coders, 0);
    });

    await check("tampered implementation contract is rejected before intelligence execution", async () => {
      const tampered = JSON.parse(JSON.stringify(contract));
      tampered.requiredSymbols.push("unrelated");
      let coders = 0;
      const result = await runTaskToSeedBoundCoderFlow({
        repositoryPath: first.root,
        contract: tampered,
        acceptanceCriteriaContract: acceptance,
        taskContext: {},
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        contextRequestProvider: async () => ({}),
        coderProvider: async () => { coders += 1; return {}; }
      });
      assert.equal(result.decision, "task_seed_coder_invalid");
      assert.equal(result.summary.repoFlowCallCount, 0);
      assert.equal(coders, 0);
    });

    await check("execution binding receipt is hash linked and tamper evident", async () => {
      assert(readyResult.executionBinding);
      assert.equal(verifyTaskToSeedExecutionBinding(readyResult.executionBinding), true);
      assert.equal(readyResult.executionBinding.contractHash, contract.contractHash);
      assert.equal(readyResult.executionBinding.auditHash, readyResult.audit.auditHash);
      assert.equal(readyResult.executionBinding.repoContextBindingHash, readyResult.repoResult.binding.bindingHash);
      const tampered = JSON.parse(JSON.stringify(readyResult.executionBinding));
      tampered.coderContextHash = `sha256:${"f".repeat(64)}`;
      assert.equal(verifyTaskToSeedExecutionBinding(tampered), false);
    });

    await check("contract audit and execution are read only and declare no shell or network", async () => {
      assert.equal(treeDigest(first.root), before);
      assert.equal(auditResult.summary.repositoryWritePerformed, false);
      assert.equal(auditResult.summary.shellExecuted, false);
      assert.equal(auditResult.summary.networkAccessed, false);
      assert.equal(readyResult.repoResult.summary.repositoryWritePerformed, false);
      assert.equal(readyResult.repoResult.summary.shellExecuted, false);
      assert.equal(readyResult.repoResult.summary.networkAccessed, false);
    });

    assert.equal(checks.length, 14);
    const reportCore = {
      artifactVersion: "1",
      artifactType: "ag1c_task_to_seed_implementation_contract",
      evidenceClass: "deterministic_fixture",
      decision: "ag1c_evidence_ready",
      scope: {
        liveModelTaskQualityMeasured: false,
        tokenSavingsMeasured: false,
        latencyMeasured: false,
        infrastructureCostMeasured: false
      },
      summary: {
        checkCount: checks.length,
        contractVerified: true,
        acceptanceIdentityBound: true,
        graphAuditReady: true,
        snapshotMismatchBlockedBeforeProvider: true,
        executionBindingVerified: true,
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      },
      checks
    };
    const report = {
      ...reportCore,
      reportHash: hashCanonicalJson(reportCore)
    };

    if (mode === "report") {
      await fsp.mkdir(path.dirname(REPORT_PATH), { recursive: true });
      await fsp.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({
        decision: "ag1c_evidence_written",
        path: REPORT_PATH,
        reportHash: report.reportHash
      }, null, 2));
    } else if (mode === "verify") {
      const existing = JSON.parse(await fsp.readFile(REPORT_PATH, "utf8"));
      assert.deepEqual(existing, report);
      console.log(JSON.stringify({
        decision: "ag1c_evidence_ready",
        reportHash: report.reportHash,
        checkCount: checks.length
      }, null, 2));
    } else {
      console.log(`task-to-seed implementation contract smoke passed (${checks.length} checks)`);
    }
  } finally {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  }
}

function treeDigest(root) {
  const entries = [];
  walk(root, "", entries);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function walk(root, relative, entries) {
  const absolute = path.join(root, relative);
  for (const name of fs.readdirSync(absolute).sort()) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const childAbsolute = path.join(root, childRelative);
    const stat = fs.lstatSync(childAbsolute);
    if (stat.isDirectory()) {
      entries.push([childRelative, "dir"]);
      walk(root, childRelative, entries);
    } else if (stat.isSymbolicLink()) {
      entries.push([childRelative, "symlink", fs.readlinkSync(childAbsolute)]);
    } else {
      entries.push([
        childRelative,
        "file",
        stat.mode & 0o777,
        createHash("sha256").update(fs.readFileSync(childAbsolute)).digest("hex")
      ]);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
