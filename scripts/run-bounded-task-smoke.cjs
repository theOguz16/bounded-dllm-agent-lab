#!/usr/bin/env node

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/canonical-runtime.js");
  const {
    createAcceptanceCriteriaContract,
    createPreventiveMinimalityPolicy,
    hashCanonicalJson,
    runBoundedTask,
    verifyBoundedTaskReceipt
  } = runtime;

  const roots = [];
  const checks = [];
  const check = async (name, fn) => {
    process.stdout.write(`[run] ${name}\n`);
    await fn();
    checks.push(name);
    process.stdout.write(`[ok] ${name}\n`);
  };

  const write = async (root, file, content) => {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  };

  const contentHash = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

  const fixture = async (mode = "approved") => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-task-"));
    roots.push(root);
    const files = {
      "src/service.ts": "export function compute(value: number): number { return value * 2; }\n",
      "tests/service.test.ts": "import { compute } from '../src/service.js';\nvoid compute(2);\n",
      "package.json": JSON.stringify({ type: "module" }, null, 2) + "\n"
    };
    for (const [file, content] of Object.entries(files)) await write(root, file, content);

    const objectiveHash = hashCanonicalJson({ task: "Update compute safely." });
    const authorityHash = hashCanonicalJson({ authority: "fixture" });
    const policyHash = hashCanonicalJson({ policy: "fixture" });
    const acceptanceCriteriaContract = createAcceptanceCriteriaContract({
      taskId: "task.gate2.fixture",
      objectiveHash,
      criteria: [{
        id: "service_test",
        description: "The service test remains required.",
        required: true,
        evidence: { kind: "test", commandId: "test.service" }
      }]
    });
    const minimalityPolicy = createPreventiveMinimalityPolicy({
      policyVersion: "1",
      policyId: "gate2.default",
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
      maxPlannedFiles: 3,
      maxNewDependencies: 0,
      maxNewAbstractions: 0
    });
    const initialEvidence = Object.entries(files)
      .filter(([file]) => file !== "package.json")
      .map(([file, content]) => ({
        path: file,
        source: "gate2_fixture",
        content,
        contentHash: contentHash(content),
        byteLength: Buffer.byteLength(content),
        estimatedTokens: Math.ceil(content.length / 4),
        matchedSymbols: file === "src/service.ts" ? ["compute"] : []
      }));

    const plannerProposalCore = {
      proposalVersion: "1",
      taskId: "task.gate2.fixture",
      objectiveHash,
      acceptanceContractHash: acceptanceCriteriaContract.contractHash,
      authorityHash,
      policyHash,
      seedFiles: ["src/service.ts"],
      seedRationales: [{
        path: "src/service.ts",
        reasonHash: hashCanonicalJson({ reason: "Existing implementation boundary." })
      }],
      requiredSymbols: ["compute"],
      requiredTestFiles: ["tests/service.test.ts"],
      maxExpansionAttempts: 1
    };
    const plannerProposal = {
      ...plannerProposalCore,
      proposalHash: hashCanonicalJson(plannerProposalCore)
    };

    const input = {
      repositoryPath: root,
      taskId: "task.gate2.fixture",
      objectiveHash,
      acceptanceCriteriaContract,
      authorityHash,
      policyHash,
      proposalLimits: {
        maxSeedFiles: 1,
        maxRequiredSymbols: 1,
        maxRequiredTests: 1,
        maxExpansionAttempts: 1
      },
      minimalityPolicy,
      allowedChangeFiles: ["src/service.ts"],
      forbiddenFiles: ["package.json"],
      taskContext: { task: "Update compute safely." },
      initialEvidence,
      authorityPresent: true,
      policyPresent: true,
      hardTotalBudgetTokens: 4000,
      plannerMinimalityProvider: async () => ({
        proposal: plannerProposal,
        minimalityPlan: {
          planVersion: "1",
          riskClass: "low",
          taskExplicitlyRequestsRefactor: false,
          plannedFiles: [{ path: "src/service.ts", changeKind: "bugfix", requested: true, justification: null }],
          newDependencies: [],
          newAbstractions: []
        }
      }),
      contextRequestProvider: async () => ({ requestedFiles: [], requiredSymbols: [], reason: "unused" }),
      coderProvider: async () => mode === "blocked"
        ? {
            role: "coder",
            target: "patchDraft",
            summary: "Unsafe out-of-scope patch.",
            claims: [{ type: "patch_draft", file: "package.json", description: "Change package metadata.", proposedPatch: "{}" }],
            touchedFiles: ["package.json"],
            confidence: 0.9
          }
        : {
            role: "coder",
            target: "patchDraft",
            summary: "Update compute implementation.",
            claims: [{ type: "patch_draft", file: "src/service.ts", description: "Adjust compute behavior.", proposedPatch: "export function compute(value: number): number { return value * 3; }" }],
            touchedFiles: ["src/service.ts"],
            confidence: 0.9
          }
    };

    if (mode === "applied") {
      input.applyExecutor = async () => ({
        decision: "apply_completed",
        route: "contract_approved",
        receiptHash: hashCanonicalJson({ apply: "approved" })
      });
    }
    return input;
  };

  try {
    await check("canonical runtime exports runBoundedTask", async () => {
      assert.equal(typeof runBoundedTask, "function");
      assert.equal(typeof verifyBoundedTaskReceipt, "function");
    });

    await check("verified draft flow completes through verifier v2 with hash-linked receipt", async () => {
      const result = await runBoundedTask(await fixture("approved"));
      assert.equal(result.decision, "bounded_task_completed", JSON.stringify(result));
      assert.equal(result.route, "verified_draft_ready");
      assert.equal(result.summary.verifierCalled, true);
      assert.equal(result.verifierResult.version, "deterministic-verifier/v2");
      assert.equal(result.summary.applyCalled, false);
      assert.equal(verifyBoundedTaskReceipt(result.receipt), true);
    });

    await check("verifier v2 stable rule blocks forbidden coder mutation", async () => {
      const result = await runBoundedTask(await fixture("blocked"));
      assert.equal(result.decision, "bounded_task_invalid", JSON.stringify(result));
      assert.equal(result.route, "human_review_required");
      assert.equal(result.failure.stage, "verification");
      assert.equal(result.failure.code, "dv2_allowlist_violation");
      assert.equal(result.failure.details.ruleId, "DV2_ALLOWLIST_VIOLATION");
      assert.equal(result.verifierResult.version, "deterministic-verifier/v2");
      assert.equal(result.receipt, null);
    });

    await check("approved apply executor produces applied receipt", async () => {
      const result = await runBoundedTask(await fixture("applied"));
      assert.equal(result.decision, "bounded_task_completed", JSON.stringify(result));
      assert.equal(result.route, "contract_approved");
      assert.equal(result.receipt.outcome, "applied_and_validated");
      assert.equal(result.summary.applyCalled, true);
      assert.equal(result.verifierResult.version, "deterministic-verifier/v2");
      assert.equal(verifyBoundedTaskReceipt(result.receipt), true);
    });

    console.log(JSON.stringify({
      ok: true,
      decision: "run_bounded_task_e2e_ready",
      checkCount: checks.length,
      checks
    }, null, 2));
  } finally {
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
