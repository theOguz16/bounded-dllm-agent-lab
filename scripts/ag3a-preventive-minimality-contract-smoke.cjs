const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const api = await import(
    "../dist/packages/product-runtime/src/preventive-minimality-contract.js"
  );
  const canonical = await import(
    "../dist/packages/product-runtime/src/canonical-runtime.js"
  );
  const ledger = await import(
    "../dist/packages/product-runtime/src/agent-event-ledger.js"
  );
  const {
    createPreventiveMinimalityPolicy,
    verifyPreventiveMinimalityPolicy,
    createPreventiveMinimalityPlan,
    verifyPreventiveMinimalityPlan,
    evaluatePreventiveMinimalityPlan,
    verifyRepositoryDependencyInventory,
    verifyPreventiveMinimalityBaseline,
    verifyPreventiveMinimalityReceipt
  } = api;
  const { hashCanonicalJson } = ledger;

  const checks = [];
  async function run(name, fn) {
    process.stdout.write(`[run] ${name}\n`);
    await fn();
    checks.push({ name, passed: true });
    process.stdout.write(`[ok] ${name}\n`);
  }

  const hash = (value) => hashCanonicalJson(value);
  const identity = {
    taskId: "task.ag3a.preventive-minimality",
    objectiveHash: hash({ objective: "prevent unnecessary structural work" }),
    plannerProposalHash: hash({ proposal: "ag2b-planner-proposal" }),
    intelligenceHash: hash({ intelligence: "ag1-repository-snapshot" })
  };

  const basePolicyDraft = {
    policyVersion: "1",
    policyId: "policy.ag3a.default",
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
    maxNewDependencies: 1,
    maxNewAbstractions: 2
  };

  function makePolicy(overrides = {}) {
    return createPreventiveMinimalityPolicy({
      ...basePolicyDraft,
      ...overrides,
      policyId: overrides.policyId ?? basePolicyDraft.policyId
    });
  }

  function baseRawPlan(overrides = {}) {
    return {
      planVersion: "1",
      riskClass: "low",
      taskExplicitlyRequestsRefactor: false,
      plannedFiles: [
        {
          path: "src/service.ts",
          changeKind: "bugfix",
          requested: true,
          justification: "The task directly targets the existing service implementation."
        },
        {
          path: "test/service.test.ts",
          changeKind: "test",
          requested: true,
          justification: "Regression coverage is required by the task contract."
        }
      ],
      newDependencies: [],
      newAbstractions: [],
      ...overrides
    };
  }

  function makePlan(policy, rawPlan = baseRawPlan(), identityOverrides = {}) {
    return createPreventiveMinimalityPlan({
      rawPlan,
      ...identity,
      ...identityOverrides,
      policyHash: policy.policyHash
    });
  }

  async function createRepo(options = {}) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ag3a-minimality-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.mkdir(path.join(root, "test"), { recursive: true });
    await fsp.mkdir(path.join(root, "packages/core/src"), { recursive: true });
    await fsp.writeFile(path.join(root, "src/service.ts"), "export const service = 1;\n");
    await fsp.writeFile(path.join(root, "test/service.test.ts"), "export const test = 1;\n");
    await fsp.writeFile(path.join(root, "packages/core/src/index.ts"), "export const core = 1;\n");
    await fsp.writeFile(
      path.join(root, "package.json"),
      options.rootManifest ?? JSON.stringify({
        name: "fixture-root",
        dependencies: { zod: "1.0.0" },
        devDependencies: { typescript: "5.6.3" }
      }, null, 2) + "\n"
    );
    if (options.workspaceManifestSymlink) {
      await fsp.symlink(
        path.join(root, "package.json"),
        path.join(root, "packages/core/package.json")
      );
    } else {
      await fsp.writeFile(
        path.join(root, "packages/core/package.json"),
        options.workspaceManifest ?? JSON.stringify({
          name: "fixture-core",
          dependencies: { undici: "6.0.0" }
        }, null, 2) + "\n"
      );
    }
    return root;
  }

  async function snapshot(root) {
    const entries = [];
    async function walk(current) {
      const names = await fsp.readdir(current, { withFileTypes: true });
      names.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of names) {
        const absolute = path.join(current, entry.name);
        const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isSymbolicLink()) {
          entries.push({ path: relative, kind: "symlink", target: await fsp.readlink(absolute) });
        } else {
          const bytes = await fsp.readFile(absolute);
          entries.push({
            path: relative,
            kind: "file",
            hash: crypto.createHash("sha256").update(bytes).digest("hex")
          });
        }
      }
    }
    await walk(root);
    return entries;
  }

  async function evaluate(root, policy, plan, overrides = {}) {
    return evaluatePreventiveMinimalityPlan({
      repositoryPath: root,
      expectedTaskId: identity.taskId,
      expectedObjectiveHash: identity.objectiveHash,
      expectedPlannerProposalHash: identity.plannerProposalHash,
      expectedIntelligenceHash: identity.intelligenceHash,
      policy,
      plan,
      allowedFiles: [
        "src/service.ts",
        "test/service.test.ts",
        "packages/core/src/index.ts",
        "src/new-helper.ts"
      ],
      forbiddenFiles: ["package-lock.json"],
      ...overrides
    });
  }

  await run("canonical runtime exports the preventive minimality surface", async () => {
    assert.equal(typeof canonical.createPreventiveMinimalityPolicy, "function");
    assert.equal(typeof canonical.evaluatePreventiveMinimalityPlan, "function");
  });

  await run("policy hashing is deterministic and tamper evident", async () => {
    const left = makePolicy();
    const right = makePolicy();
    assert.equal(left.policyHash, right.policyHash);
    assert.equal(verifyPreventiveMinimalityPolicy(left), true);
    assert.equal(verifyPreventiveMinimalityPolicy({ ...left, maxPlannedFiles: 99 }), false);
  });

  await run("plan hashing is deterministic and tamper evident", async () => {
    const policy = makePolicy();
    const left = makePlan(policy);
    const right = makePlan(policy);
    assert.equal(left.planHash, right.planHash);
    assert.equal(verifyPreventiveMinimalityPlan(left), true);
    assert.equal(verifyPreventiveMinimalityPlan({ ...left, riskClass: "medium" }), false);
  });

  await run("a surgical existing-code plan continues to coder", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy();
      const result = await evaluate(root, policy, makePlan(policy));
      assert.equal(result.decision, "minimality_plan_ready");
      assert.equal(result.route, "continue_to_coder");
      assert.equal(result.issues.length, 0);
      assert.equal(verifyPreventiveMinimalityBaseline(result.baseline), true);
      assert.equal(verifyPreventiveMinimalityReceipt(result.receipt), true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("dependency inventory binds root and workspace manifests", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy();
      const result = await evaluate(root, policy, makePlan(policy));
      assert.equal(verifyRepositoryDependencyInventory(result.dependencyInventory), true);
      assert.deepEqual(result.dependencyInventory.installedDependencies, [
        "typescript",
        "undici",
        "zod"
      ]);
      assert.deepEqual(result.dependencyInventory.manifestFiles.map((entry) => entry.path), [
        "package.json",
        "packages/core/package.json"
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("an already installed dependency requires replanning", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy();
      const plan = makePlan(policy, baseRawPlan({
        newDependencies: [{
          name: "zod",
          requested: true,
          purpose: "Validate input",
          justification: "Schema validation is required.",
          standardLibraryConsidered: true,
          nativePlatformConsidered: true,
          existingDependenciesConsidered: ["zod"],
          whyExistingInsufficient: "The planner incorrectly classified it as new."
        }]
      }));
      const result = await evaluate(root, policy, plan);
      assert.equal(result.decision, "minimality_replan_required");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_installed_dependency_should_be_reused"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("missing dependency justification requests planner revision", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy({ unrequestedDependencyBehavior: "allow_with_justification" });
      const plan = makePlan(policy, baseRawPlan({
        newDependencies: [{
          name: "nanoid",
          requested: true,
          purpose: "Generate identifiers",
          justification: null,
          standardLibraryConsidered: true,
          nativePlatformConsidered: true,
          existingDependenciesConsidered: ["zod"],
          whyExistingInsufficient: "zod does not generate identifiers."
        }]
      }));
      const result = await evaluate(root, policy, plan);
      assert.equal(result.decision, "minimality_justification_required");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_dependency_justification_missing"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("installed alternatives must be considered before a new dependency", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy({ unrequestedDependencyBehavior: "allow_with_justification" });
      const plan = makePlan(policy, baseRawPlan({
        newDependencies: [{
          name: "nanoid",
          requested: true,
          purpose: "Generate identifiers",
          justification: "The task requires compact identifiers.",
          standardLibraryConsidered: true,
          nativePlatformConsidered: true,
          existingDependenciesConsidered: [],
          whyExistingInsufficient: null
        }]
      }));
      const result = await evaluate(root, policy, plan);
      assert.equal(result.decision, "minimality_justification_required");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_installed_alternatives_not_considered"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("a complete unrequested dependency plan routes to human review", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy();
      const plan = makePlan(policy, baseRawPlan({
        newDependencies: [{
          name: "nanoid",
          requested: false,
          purpose: "Generate identifiers",
          justification: "The required identifiers must be compact and URL safe.",
          standardLibraryConsidered: true,
          nativePlatformConsidered: true,
          existingDependenciesConsidered: ["zod"],
          whyExistingInsufficient: "zod validates data but does not generate identifiers."
        }]
      }));
      const result = await evaluate(root, policy, plan);
      assert.equal(result.decision, "minimality_human_review_required");
      assert.equal(result.route, "human_review");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("policy can allow a justified unrequested dependency", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy({
        policyId: "policy.ag3a.allow-dependency",
        unrequestedDependencyBehavior: "allow_with_justification"
      });
      const plan = makePlan(policy, baseRawPlan({
        newDependencies: [{
          name: "nanoid",
          requested: false,
          purpose: "Generate identifiers",
          justification: "The required identifiers must be compact and URL safe.",
          standardLibraryConsidered: true,
          nativePlatformConsidered: true,
          existingDependenciesConsidered: ["zod"],
          whyExistingInsufficient: "zod validates data but does not generate identifiers."
        }]
      }));
      const result = await evaluate(root, policy, plan);
      assert.equal(result.decision, "minimality_plan_ready");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("an unrequested refactor can require replanning", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy();
      const plan = makePlan(policy, baseRawPlan({
        plannedFiles: [{
          path: "src/service.ts",
          changeKind: "refactor",
          requested: false,
          justification: "Move code without changing behavior."
        }]
      }));
      const result = await evaluate(root, policy, plan, {
        allowedFiles: ["src/service.ts"]
      });
      assert.equal(result.decision, "minimality_replan_required");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_unrequested_refactor_replan_required"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("an explicitly requested justified refactor can continue", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy();
      const plan = makePlan(policy, baseRawPlan({
        taskExplicitlyRequestsRefactor: true,
        plannedFiles: [{
          path: "src/service.ts",
          changeKind: "refactor",
          requested: true,
          justification: "The task explicitly requires extracting the validation branch."
        }]
      }));
      const result = await evaluate(root, policy, plan, {
        allowedFiles: ["src/service.ts"]
      });
      assert.equal(result.decision, "minimality_plan_ready");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("a new unrequested file requires justification", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy();
      const plan = makePlan(policy, baseRawPlan({
        plannedFiles: [{
          path: "src/new-helper.ts",
          changeKind: "feature",
          requested: false,
          justification: null
        }]
      }));
      const result = await evaluate(root, policy, plan, {
        allowedFiles: ["src/new-helper.ts"]
      });
      assert.equal(result.decision, "minimality_justification_required");
      assert.equal(result.summary.newPlannedFileCount, 1);
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_new_file_justification_missing"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("an abstraction without enough reuse evidence requests revision", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy({ unrequestedAbstractionBehavior: "allow_with_justification" });
      const plan = makePlan(policy, baseRawPlan({
        newAbstractions: [{
          abstractionId: "service-adapter",
          filePath: "src/service.ts",
          requested: true,
          purpose: "Share service translation",
          justification: "A shared interface is proposed.",
          reuseSites: ["src/service.ts#primary"],
          whyInlineInsufficient: "The behavior is expected in multiple call sites."
        }]
      }));
      const result = await evaluate(root, policy, plan);
      assert.equal(result.decision, "minimality_justification_required");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_abstraction_reuse_case_insufficient"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("a justified abstraction with reuse evidence can continue", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy({
        policyId: "policy.ag3a.allow-abstraction",
        unrequestedAbstractionBehavior: "allow_with_justification"
      });
      const plan = makePlan(policy, baseRawPlan({
        newAbstractions: [{
          abstractionId: "service-adapter",
          filePath: "src/service.ts",
          requested: false,
          purpose: "Share service translation",
          justification: "Two existing call sites require the same contract.",
          reuseSites: ["src/service.ts#primary", "src/service.ts#fallback"],
          whyInlineInsufficient: "Duplicating the contract would create divergent behavior."
        }]
      }));
      const result = await evaluate(root, policy, plan);
      assert.equal(result.decision, "minimality_plan_ready");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("an abstraction target must be a planned file", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy({ unrequestedAbstractionBehavior: "allow_with_justification" });
      const plan = makePlan(policy, baseRawPlan({
        newAbstractions: [{
          abstractionId: "core-adapter",
          filePath: "packages/core/src/index.ts",
          requested: true,
          purpose: "Share translation",
          justification: "A shared interface is required.",
          reuseSites: ["src/service.ts#primary", "src/service.ts#fallback"],
          whyInlineInsufficient: "The behavior is reused."
        }]
      }));
      const result = await evaluate(root, policy, plan);
      assert.equal(result.decision, "minimality_replan_required");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_abstraction_target_not_planned"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("high-risk tasks can bypass automatic minimality policy", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy({
        policyId: "policy.ag3a.high-risk-disabled",
        highRiskBehavior: "disabled"
      });
      const plan = makePlan(policy, baseRawPlan({
        riskClass: "critical",
        plannedFiles: [{
          path: "src/new-helper.ts",
          changeKind: "refactor",
          requested: false,
          justification: null
        }]
      }));
      const result = await evaluate(root, policy, plan, {
        allowedFiles: ["src/new-helper.ts"]
      });
      assert.equal(result.decision, "minimality_policy_disabled");
      assert.equal(result.route, "policy_bypassed");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("high-risk tasks can route to human review", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy();
      const plan = makePlan(policy, baseRawPlan({ riskClass: "high" }));
      const result = await evaluate(root, policy, plan);
      assert.equal(result.decision, "minimality_human_review_required");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_high_risk_human_review_required"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("out-of-scope and forbidden planned files require replanning", async () => {
    const root = await createRepo();
    try {
      await fsp.writeFile(path.join(root, "package-lock.json"), "{}\n");
      const policy = makePolicy();
      const plan = makePlan(policy, baseRawPlan({
        plannedFiles: [{
          path: "package-lock.json",
          changeKind: "dependency",
          requested: false,
          justification: "Update lock state."
        }]
      }));
      const result = await evaluate(root, policy, plan, {
        allowedFiles: ["src/service.ts"],
        forbiddenFiles: ["package-lock.json"]
      });
      assert.equal(result.decision, "minimality_replan_required");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_forbidden_file_planned"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("identity and repository snapshot drift fail closed", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy();
      const plan = makePlan(policy);
      const result = await evaluate(root, policy, plan, {
        expectedIntelligenceHash: hash({ stale: true })
      });
      assert.equal(result.decision, "minimality_plan_invalid");
      assert.equal(result.route, "stop_invalid");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_intelligence_mismatch"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("policy binding mismatch fails before repository evaluation", async () => {
    const root = await createRepo();
    try {
      const firstPolicy = makePolicy();
      const secondPolicy = makePolicy({ policyId: "policy.ag3a.other" });
      const result = await evaluate(root, secondPolicy, makePlan(firstPolicy));
      assert.equal(result.decision, "minimality_plan_invalid");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_policy_binding_mismatch"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("manifest symlinks fail closed", async () => {
    const root = await createRepo({ workspaceManifestSymlink: true });
    try {
      const policy = makePolicy();
      const result = await evaluate(root, policy, makePlan(policy));
      assert.equal(result.decision, "minimality_plan_invalid");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_manifest_symlink"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("malformed dependency manifests fail closed", async () => {
    const root = await createRepo({ workspaceManifest: "{ invalid json\n" });
    try {
      const policy = makePolicy();
      const result = await evaluate(root, policy, makePlan(policy));
      assert.equal(result.decision, "minimality_plan_invalid");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_manifest_json_invalid"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("policy budgets route oversized plans to replanning", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy({
        policyId: "policy.ag3a.tight",
        maxPlannedFiles: 1
      });
      const result = await evaluate(root, policy, makePlan(policy));
      assert.equal(result.decision, "minimality_replan_required");
      assert.ok(result.issues.some((entry) =>
        entry.code === "minimality_planned_file_budget_exceeded"
      ));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("baseline and receipt hashes are tamper evident", async () => {
    const root = await createRepo();
    try {
      const policy = makePolicy();
      const result = await evaluate(root, policy, makePlan(policy));
      assert.equal(verifyPreventiveMinimalityBaseline(result.baseline), true);
      assert.equal(verifyPreventiveMinimalityReceipt(result.receipt), true);
      assert.equal(verifyPreventiveMinimalityBaseline({
        ...result.baseline,
        requestedRefactor: true
      }), false);
      assert.equal(verifyPreventiveMinimalityReceipt({
        ...result.receipt,
        decision: "minimality_human_review_required"
      }), false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("evaluation is read only and declares no shell or network use", async () => {
    const root = await createRepo();
    try {
      const before = await snapshot(root);
      const policy = makePolicy();
      const result = await evaluate(root, policy, makePlan(policy));
      const after = await snapshot(root);
      assert.deepEqual(after, before);
      assert.equal(result.summary.repositoryWritePerformed, false);
      assert.equal(result.summary.shellExecuted, false);
      assert.equal(result.summary.networkAccessed, false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  await run("unknown plan fields fail exact schema validation", async () => {
    const policy = makePolicy();
    assert.throws(() => makePlan(policy, {
      ...baseRawPlan(),
      unexpected: true
    }), /unknown or accessor field/);
  });

  const reportCore = {
    evidenceVersion: "1",
    phase: "AG.3a",
    evidenceClass: "deterministic_fixture",
    decision: "ag3a_preventive_minimality_evidence_ready",
    checkCount: checks.length,
    checks,
    guarantees: {
      samePlannerCallExtensionPlanned: true,
      secondProviderCallRequired: false,
      repositoryDependencyInventoryBound: true,
      preCoderDecisionProduced: true,
      postPatchSoftScopeBaselineProduced: true,
      repositoryWritePerformed: false,
      shellExecuted: false,
      networkAccessed: false
    },
    claimBoundary: {
      liveModelQualityObserved: false,
      liveTokenUsageObserved: false,
      infrastructureCostObserved: false,
      coderIntegrationCompleted: false
    }
  };
  const report = {
    ...reportCore,
    reportHash: hashCanonicalJson(reportCore)
  };
  const reportPath = path.resolve(
    process.cwd(),
    "reports/ag/AG3A_PREVENTIVE_MINIMALITY_CONTRACT.json"
  );
  if (process.argv.includes("--report")) {
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (process.argv.includes("--verify")) {
    const existing = JSON.parse(await fsp.readFile(reportPath, "utf8"));
    assert.deepEqual(existing, report);
  }
  console.log(JSON.stringify({
    decision: report.decision,
    reportHash: report.reportHash,
    checkCount: report.checkCount,
    coderIntegrationCompleted: false
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
