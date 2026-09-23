#!/usr/bin/env node

// Offline regression for the planner forbidden-scope boundary.
//
// A compiled canonical policy expands forbidden path patterns against the
// repository inventory, so the effective forbidden set can reach thousands of
// concrete files. The planner request used to carry that set as one flat
// forbiddenFiles array and dropped the task with planner_minimality_request_invalid
// on the 1,000-entry bound before any provider call. The planner now receives a
// bounded forbiddenScope summary while every offline gate keeps enforcing the
// full forbidden set. No real provider is contacted in this smoke.

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const FORBIDDEN_FILE_COUNT = 3_683;

async function main() {
  const integrationApi = await import(
    "../dist/packages/product-runtime/src/planner-minimality-integration.js"
  );
  const adapterApi = await import(
    "../dist/packages/product-runtime/src/openai-compatible-planner-minimality-provider.js"
  );
  const minimalityApi = await import(
    "../dist/packages/product-runtime/src/preventive-minimality-contract.js"
  );
  const acceptanceApi = await import(
    "../dist/packages/product-runtime/src/acceptance-criteria-contract.js"
  );
  const ledgerApi = await import(
    "../dist/packages/product-runtime/src/agent-event-ledger.js"
  );
  const canonicalRuntime = await import(
    "../dist/packages/product-runtime/src/canonical-runtime.js"
  );
  const { runBoundedTask, compileCanonicalPolicy, verifyBoundedTaskReceipt } = canonicalRuntime;

  const {
    runPlannerMinimalityBoundCoderFlow,
    summarizeForbiddenScope,
    PLANNER_FORBIDDEN_FILES_LIMIT,
    PLANNER_FORBIDDEN_FULL_ENUMERATION_LIMIT
  } = integrationApi;
  const { createOpenAICompatiblePlannerMinimalityProvider } = adapterApi;
  const { createPreventiveMinimalityPolicy } = minimalityApi;
  const { createAcceptanceCriteriaContract } = acceptanceApi;
  const { hashCanonicalJson } = ledgerApi;

  const roots = [];
  const checks = [];
  const check = async (name, fn) => {
    process.stdout.write(`[run] ${name}\n`);
    await fn();
    checks.push(name);
    process.stdout.write(`[ok] ${name}\n`);
  };

  const fixtureFiles = {
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

  const fixture = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forbidden-scope-"));
    roots.push(root);
    for (const [relative, content] of Object.entries(fixtureFiles)) {
      const target = path.join(root, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    }
    return root;
  };

  const evidenceFor = (paths) => paths.map((file) => {
    const content = fixtureFiles[file];
    const bytes = Buffer.from(content, "utf8");
    return {
      path: file,
      source: "forbidden_scope_fixture",
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

  const objectiveHash = hashCanonicalJson({ task: "Change compute through the existing service boundary." });
  const authorityHash = hashCanonicalJson({ authority: "forbidden-scope-fixture" });
  const policyHash = hashCanonicalJson({ policy: "forbidden-scope-fixture" });
  const taskId = "task.forbidden.scope.fixture";
  const acceptance = createAcceptanceCriteriaContract({
    taskId,
    objectiveHash,
    criteria: [{
      id: "service_test",
      description: "The existing service test must pass.",
      required: true,
      evidence: { kind: "test", commandId: "test.service" }
    }]
  });
  const limits = {
    maxSeedFiles: 2,
    maxRequiredSymbols: 3,
    maxRequiredTests: 1,
    maxExpansionAttempts: 1
  };
  const minimalityPolicy = createPreventiveMinimalityPolicy({
    policyVersion: "1",
    policyId: "forbidden.scope.default",
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
    maxPlannedFiles: 4,
    maxNewDependencies: 0,
    maxNewAbstractions: 0
  });
  const allowedChangeFiles = ["src/service.ts", "tests/service.test.ts"];

  const forbiddenPath = (index) => `generated/forbidden-${String(index).padStart(5, "0")}.js`;
  const forbiddenList = Array.from(
    { length: FORBIDDEN_FILE_COUNT },
    (_, index) => forbiddenPath(index)
  );
  const neverEnumerated = forbiddenPath(1_700);

  const proposalDraft = (seedFiles, { withHash = true, policyHash: policyHashOverride } = {}) => {
    const core = {
      proposalVersion: "1",
      taskId,
      objectiveHash,
      acceptanceContractHash: acceptance.contractHash,
      authorityHash,
      policyHash: policyHashOverride ?? policyHash,
      seedFiles,
      seedRationales: seedFiles.map((file) => ({
        path: file,
        // The adapter draft path carries the raw reason; the canonical
        // integration path carries its hash instead.
        ...(withHash
          ? { reasonHash: hashCanonicalJson({
              artifactType: "bounded_planner_seed_rationale",
              path: file,
              reason: "Existing compute implementation boundary."
            }) }
          : { reason: "Existing compute implementation boundary." })
      })),
      requiredSymbols: ["compute", "run"],
      requiredTestFiles: ["tests/service.test.ts"],
      maxExpansionAttempts: 1
    };
    return withHash ? { ...core, proposalHash: hashCanonicalJson(core) } : core;
  };
  const planDraft = (plannedPath) => ({
    planVersion: "1",
    riskClass: "low",
    taskExplicitlyRequestsRefactor: false,
    plannedFiles: [{
      path: plannedPath,
      changeKind: "bugfix",
      requested: true,
      justification: null
    }],
    newDependencies: [],
    newAbstractions: []
  });
  // The OpenAI-compatible adapter parses model drafts without hash fields and
  // computes the canonical proposal hash itself.
  const combinedDraft = (seedFiles, plannedPath) => JSON.stringify({
    proposal: proposalDraft(seedFiles, { withHash: false }),
    minimalityPlan: planDraft(plannedPath ?? seedFiles[0])
  });

  const runFlow = async ({
    forbiddenFiles,
    plannerMinimalityProvider,
    coderProvider = async () => ({ kind: "patch", files: ["src/service.ts"] })
  }) => runPlannerMinimalityBoundCoderFlow({
    repositoryPath: await fixture(),
    taskId,
    objectiveHash,
    acceptanceCriteriaContract: acceptance,
    authorityHash,
    policyHash,
    proposalLimits: limits,
    minimalityPolicy,
    allowedChangeFiles,
    forbiddenFiles,
    taskContext: { task: "Change compute through the existing service boundary." },
    initialEvidence: evidenceFor(
      ["src/index.ts", "src/service.ts", "src/types.ts", "tests/service.test.ts"]
    ),
    authorityPresent: true,
    policyPresent: true,
    hardTotalBudgetTokens: 8_192,
    reservedOutputTokens: 512,
    plannerMinimalityProvider,
    contextRequestProvider: async () => {
      throw new Error("Complete fixture evidence must not request expansion.");
    },
    coderProvider
  });

  try {
    await check("bounded forbidden scope summary is deterministic and hash bound", async () => {
      const summary = summarizeForbiddenScope(forbiddenList);
      assert.equal(summary.summaryVersion, "1");
      assert.equal(summary.totalForbiddenFiles, FORBIDDEN_FILE_COUNT);
      assert.deepEqual(summary.enumeratedForbiddenFiles, null);
      assert.deepEqual(summary.forbiddenRoots, ["generated"]);
      assert.deepEqual(summary.sampleForbiddenFiles, forbiddenList.slice(0, 8).sort());
      assert.equal(summary.forbiddenFilesHash, hashCanonicalJson([...forbiddenList].sort()));
      const small = summarizeForbiddenScope(["b/second.ts", "a/first.ts"]);
      assert.deepEqual(small.enumeratedForbiddenFiles, ["a/first.ts", "b/second.ts"]);
      assert.deepEqual(small.forbiddenRoots, ["a", "b"]);
      assert.deepEqual(small.sampleForbiddenFiles, ["a/first.ts", "b/second.ts"]);
      assert.equal(PLANNER_FORBIDDEN_FILES_LIMIT, 20_000);
      assert.equal(PLANNER_FORBIDDEN_FULL_ENUMERATION_LIMIT, 1_000);
    });

    let capturedPayload = null;
    let capturedUserBytes = 0;
    await check("live-scale forbidden policy builds the planner request and completes", async () => {
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture-model",
        maxAttempts: 1,
          fetchImpl: async (_url, init) => {
          capturedPayload = JSON.parse(init.body);
          const user = capturedPayload.messages[1].content;
          capturedUserBytes = Buffer.byteLength(user, "utf8");
          return new Response(JSON.stringify({
            choices: [{ message: { content: combinedDraft(["src/index.ts"], "src/service.ts") }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
      });
      const result = await runFlow({
        forbiddenFiles: forbiddenList,
        plannerMinimalityProvider: adapter.plannerMinimalityProvider
      });
      assert.equal(
        result.decision,
        "planner_minimality_task_completed",
        JSON.stringify(result.issues)
      );
      assert.equal(result.route, "coder_executed");
      assert.equal(result.summary.plannerProviderCallCount, 1);

      const payload = capturedPayload.messages[1] && JSON.parse(capturedPayload.messages[1].content);
      assert.equal(payload.forbiddenFiles, undefined);
      assert.equal(payload.forbiddenScope.totalForbiddenFiles, FORBIDDEN_FILE_COUNT);
      assert.equal(payload.forbiddenScope.enumeratedForbiddenFiles, null);
      assert.equal(payload.forbiddenScope.forbiddenFilesHash,
        hashCanonicalJson([...forbiddenList].sort()));
      assert(payload.forbiddenScope.forbiddenRoots.includes("generated"));
      assert.equal(payload.forbiddenScope.sampleForbiddenFiles.length, 8);
      assert.equal(capturedUserBytes < 8_000, true,
        `planner request must stay bounded, got ${capturedUserBytes} bytes`);
    });

    await check("planner-proposed forbidden file is rejected even when never enumerated", async () => {
      let providerCalls = 0;
      let coderCalls = 0;
      const result = await runFlow({
        forbiddenFiles: forbiddenList,
        coderProvider: async () => { coderCalls += 1; return {}; },
        plannerMinimalityProvider: async (context) => {
          providerCalls += 1;
          assert.equal(context.forbiddenScope.totalForbiddenFiles, FORBIDDEN_FILE_COUNT);
          assert.equal(context.forbiddenScope.enumeratedForbiddenFiles, null);
          const visible = JSON.stringify(context);
          assert.equal(visible.includes(neverEnumerated), false,
            "the enforced path must not be handed to the model");
          return {
            proposal: proposalDraft([neverEnumerated]),
            minimalityPlan: planDraft(neverEnumerated)
          };
        }
      });
      assert.equal(providerCalls, 1);
      assert.equal(result.decision, "planner_minimality_task_stopped", JSON.stringify(result));
      assert.equal(result.route, "replan_required");
      assert.equal(coderCalls, 0);
      assert(result.issues.some((entry) =>
        entry.code === "planner_proposal_forbidden_file_conflict" &&
        entry.filePath === neverEnumerated));
    });

    await check("small forbidden policy still enumerates the complete list", async () => {
      const smallList = ["a/first.ts", "b/second.ts"];
      let observedScope = null;
      const result = await runFlow({
        forbiddenFiles: smallList,
        plannerMinimalityProvider: async (context) => {
          observedScope = context.forbiddenScope;
          return {
            proposal: proposalDraft(["src/index.ts"]),
            minimalityPlan: planDraft("src/service.ts")
          };
        }
      });
      assert.equal(result.decision, "planner_minimality_task_completed", JSON.stringify(result.issues));
      assert.deepEqual(observedScope.enumeratedForbiddenFiles, [...smallList].sort());
      assert.equal(observedScope.totalForbiddenFiles, 2);
      assert.deepEqual(observedScope.forbiddenRoots, ["a", "b"]);
      assert.equal(observedScope.forbiddenFilesHash, hashCanonicalJson([...smallList].sort()));
    });

    await check("oversized forbidden requests still fail closed before the provider", async () => {
      let providerCalls = 0;
      const oversized = Array.from(
        { length: PLANNER_FORBIDDEN_FILES_LIMIT + 1 },
        (_, index) => `generated/overflow-${String(index).padStart(6, "0")}.js`
      );
      const result = await runFlow({
        forbiddenFiles: oversized,
        plannerMinimalityProvider: async () => { providerCalls += 1; return {}; }
      });
      assert.equal(result.decision, "planner_minimality_task_invalid");
      assert.equal(result.summary.plannerProviderCallCount, 0);
      assert.equal(providerCalls, 0);
      assert(result.issues.some((entry) =>
        entry.code === "planner_minimality_request_invalid"));
    });

    await check("allowed scope inside a large forbidden set still fails closed on overlap", async () => {
      let providerCalls = 0;
      const result = await runFlow({
        forbiddenFiles: [...forbiddenList, "src/service.ts"],
        plannerMinimalityProvider: async () => { providerCalls += 1; return {}; }
      });
      assert.equal(result.decision, "planner_minimality_task_invalid");
      assert.equal(result.summary.plannerProviderCallCount, 0);
      assert.equal(providerCalls, 0);
      assert(result.issues.some((entry) =>
        entry.code === "planner_minimality_request_invalid" &&
        /overlap/.test(entry.message)));
    });

    await check("compiled policy with 3,683 forbidden paths completes through runBoundedTask", async () => {
      const root = await fixture();
      await fs.mkdir(path.join(root, "generated"), { recursive: true });
      for (const forbidden of forbiddenList) {
        await fs.writeFile(path.join(root, forbidden), "// forbidden\n", "utf8");
      }
      const policyDocument = {
        schemaVersion: "1",
        allowed_paths: ["src/**", "tests/**", "package.json"],
        forbidden_paths: ["generated/**"],
        paired_files: [],
        sensitive_patterns: [],
        sensitive_paths: [],
        ownership_rules: []
      };
      const compiled = compileCanonicalPolicy({ repositoryPath: root, policyDocument });
      assert.equal(compiled.forbiddenPaths.length, FORBIDDEN_FILE_COUNT,
        "the fixture policy must expand to the live-run forbidden scale");
      let observedContext = null;
      let plannerCalls = 0;
      const result = await runBoundedTask({
        repositoryPath: root,
        taskId,
        objectiveHash,
        acceptanceCriteriaContract: acceptance,
        authorityHash,
        policyHash: compiled.compiledPolicyHash,
        proposalLimits: limits,
        minimalityPolicy,
        allowedChangeFiles,
        forbiddenFiles: [],
        canonicalPolicy: { compiledPolicy: compiled },
        taskContext: { task: "Change compute through the existing service boundary." },
        initialEvidence: evidenceFor(
          ["src/index.ts", "src/service.ts", "src/types.ts", "tests/service.test.ts"]
        ),
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 8_192,
        plannerMinimalityProvider: async (context) => {
          plannerCalls += 1;
          observedContext = context;
          // The coordinator hands the request its own compiled policy identity;
          // the planner draft must echo it back exactly.
          return {
            proposal: proposalDraft(["src/index.ts"], { policyHash: context.policyHash }),
            minimalityPlan: planDraft("src/service.ts")
          };
        },
        contextRequestProvider: async () => {
          throw new Error("Complete fixture evidence must not request expansion.");
        },
        coderProvider: async () => ({
          role: "coder",
          target: "patchDraft",
          summary: "Update compute implementation.",
          claims: [{
            type: "patch_draft",
            claimVersion: "text-file-update/v1",
            operation: "update",
            file: "src/service.ts",
            expectedContentHash: `sha256:${createHash("sha256")
              .update(fixtureFiles["src/service.ts"]).digest("hex")}`,
            description: "Adjust compute behavior.",
            newContent: "export function compute(value: Input): number { return value.amount * 3; }\n"
          }],
          touchedFiles: ["src/service.ts"],
          confidence: 0.9
        })
      });
      assert.equal(plannerCalls, 1);
      assert.equal(observedContext.forbiddenScope.totalForbiddenFiles, FORBIDDEN_FILE_COUNT);
      assert.equal(observedContext.forbiddenScope.enumeratedForbiddenFiles, null);
      assert.deepEqual(observedContext.forbiddenScope.forbiddenRoots, ["generated"]);
      assert.equal(JSON.stringify(observedContext).includes(forbiddenPath(1_000)), false,
        "the policy-expanded forbidden set must not travel to the provider verbatim");
      assert.equal(result.decision, "bounded_task_completed", JSON.stringify(result.failure ?? result));
      assert.equal(result.route, "structurally_verified_draft");
      assert.equal(verifyBoundedTaskReceipt(result.receipt), true);
    });

    const oldRepresentationBytes = Buffer.byteLength(
      JSON.stringify([...forbiddenList].sort()), "utf8");    process.stdout.write(`[report] old model-facing forbidden representation: ` +
      `${FORBIDDEN_FILE_COUNT} paths, ${oldRepresentationBytes} bytes of raw JSON array\n`);
    process.stdout.write(`[report] new model-facing forbidden representation: ` +
      `summary JSON, planner request ${capturedUserBytes} bytes total\n`);
    assert(capturedUserBytes < oldRepresentationBytes / 10,
      "the bounded summary must be an order of magnitude smaller than the flat list");

    process.stdout.write(`[done] ${checks.length} checks passed\n`);
  } finally {
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
