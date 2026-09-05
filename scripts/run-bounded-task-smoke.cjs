#!/usr/bin/env node

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/canonical-runtime.js");
  const {
    adaptVerifiedCoderMutation,
    buildCanonicalFreshnessSnapshot,
    compileCanonicalPolicy,
    createAcceptanceCriteriaContract,
    createPreventiveMinimalityPolicy,
    executeCanonicalGovernedMutation,
    executePreparedCanonicalGovernedMutation,
    hashCanonicalJson,
    prepareCanonicalGovernedMutation,
    resumeBoundedTask,
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
  const compiledPolicyHashFor = (input) => {
    if (input.canonicalPolicy?.compiledPolicy) return input.canonicalPolicy.compiledPolicy.compiledPolicyHash;
    const policyDocument = input.canonicalPolicy?.policyDocument ?? {
      schemaVersion: "1", allowed_paths: input.allowedChangeFiles,
      forbidden_paths: input.forbiddenFiles ?? [], paired_files: [],
      sensitive_patterns: [], sensitive_paths: [], ownership_rules: []
    };
    return compileCanonicalPolicy({ repositoryPath: input.repositoryPath,
      policyDocument }).compiledPolicyHash;
  };

  const fixture = async (mode = "approved") => {
    const root = process.env.BOUNDED_TASK_WORKER_REPO ??
      await fs.mkdtemp(path.join(os.tmpdir(), "bounded-task-"));
    await fs.mkdir(root, { recursive: true });
    roots.push(root);
    const files = {
      "src/service.ts": "export function compute(value: number): number { return value * 2; }\n",
      "tests/service.test.ts": "import { compute } from '../src/service.js';\nvoid compute(2);\n",
      "package.json": JSON.stringify({ type: "module" }, null, 2) + "\n"
    };
    const reuseWorkerRepository = process.env.BOUNDED_TASK_STATE_WORKER === "1" &&
      await fs.access(path.join(root, "package.json")).then(() => true, () => false);
    if (!reuseWorkerRepository) for (const [file, content] of Object.entries(files)) await write(root, file, content);

    if (["governed", "governed_failure", "no_change"].includes(mode)) {
      if (!reuseWorkerRepository) {
        execFileSync("git", ["init", "--quiet"], { cwd: root });
        execFileSync("git", ["config", "user.email", "runtime@example.invalid"], { cwd: root });
        execFileSync("git", ["config", "user.name", "Runtime Smoke"], { cwd: root });
        execFileSync("git", ["add", "."], { cwd: root });
        execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });
      }
    }

    const objectiveText = process.env.BOUNDED_TASK_WORKER_OBJECTIVE ?? "Update compute safely.";
    const objectiveHash = hashCanonicalJson({ task: objectiveText });
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
      canonicalPolicy: { policyDocument: {
        schemaVersion: "1", allowed_paths: ["src/**"], forbidden_paths: ["package.json"],
        paired_files: [], sensitive_patterns: [], sensitive_paths: [], ownership_rules: []
      } },
      taskContext: { task: objectiveText },
      initialEvidence,
      authorityPresent: true,
      policyPresent: true,
      hardTotalBudgetTokens: 4000,
      plannerMinimalityProvider: async (context) => ({
        proposal: (() => {
          const core = { ...plannerProposalCore, policyHash: context?.policyHash ?? plannerProposalCore.policyHash };
          return { ...core, proposalHash: hashCanonicalJson(core) };
        })(),
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
            claims: [{ type: "patch_draft", claimVersion: "text-file-update/v1", operation: "update", file: "package.json", expectedContentHash: contentHash(files["package.json"]), description: "Change package metadata.", newContent: "{}" }],
            touchedFiles: ["package.json"],
            confidence: 0.9
          }
        : {
            role: "coder",
            target: "patchDraft",
            summary: "Update compute implementation.",
            claims: [{ type: "patch_draft", claimVersion: "text-file-update/v1", operation: "update", file: "src/service.ts", expectedContentHash: contentHash(files["src/service.ts"]), description: "Adjust compute behavior.", newContent: mode === "no_change" ? files["src/service.ts"] : "export function compute(value: number): number { return value * 3; }" }],
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
    if (["governed", "governed_failure", "no_change"].includes(mode)) {
      const workerBase = process.env.BOUNDED_TASK_STATE_WORKER === "1"
        ? path.dirname(process.env.BOUNDED_TASK_WORKER_REGISTRY) : null;
      const makeRuntimeDirectory = async (name, prefix) => workerBase
        ? (await fs.mkdir(path.join(workerBase, name), { recursive: true, mode: 0o700 }),
          await fs.realpath(path.join(workerBase, name)))
        : await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
      const registryDirectoryPath = await makeRuntimeDirectory("x4-registry", "bounded-registry-");
      const rollbackBundleParentPath = await makeRuntimeDirectory("rollback", "bounded-rollback-");
      const validationWorkspaceParentPath = await makeRuntimeDirectory("validation", "bounded-validation-");
      roots.push(registryDirectoryPath, rollbackBundleParentPath, validationWorkspaceParentPath);
      input.governedExecution = {
        registryDirectoryPath,
        rollbackBundleParentPath,
        validationWorkspaceParentPath,
        phaseVExecutionSpecification: {
          allowedExecutables: ["node"],
          maxOutputChars: 20_000,
          commands: [{
            id: "service.acceptance",
            executable: "node",
            args: ["-e", (process.env.BOUNDED_TASK_WORKER_VALIDATION_PREFIX ?? "") + (mode === "no_change"
              ? "const fs=require('fs');const value=fs.readFileSync('src/service.ts','utf8');if(!value.includes('value * 2'))process.exit(1)"
              : mode === "governed_failure"
                ? "const fs=require('fs');setTimeout(()=>{const value=fs.readFileSync('src/service.ts','utf8');if(!value.includes('value * 3'))process.exit(1)},1000)"
                : "const fs=require('fs');const value=fs.readFileSync('src/service.ts','utf8');if(!value.includes('value * 3'))process.exit(1)")],
            timeoutMs: 10_000
          }]
        }
      };
    }
    return input;
  };

  if (process.env.BOUNDED_TASK_STATE_WORKER === "1") {
    const input = await fixture(process.env.BOUNDED_TASK_WORKER_MODE ?? "approved");
    const counter = process.env.BOUNDED_TASK_WORKER_COUNTER;
    const count = async (kind) => { if (counter) await fs.appendFile(counter, `${kind}\n`); };
    const planner = input.plannerMinimalityProvider; const coder = input.coderProvider;
    input.plannerMinimalityProvider = async (...args) => {
      await count("planner");
      if (args[1]?.providerIdempotencyKey) await count(`planner-key:${args[1].providerIdempotencyKey}`);
      if (process.env.BOUNDED_TASK_WORKER_FORBID_PLANNER === "1") throw new Error("planner replayed");
      return planner(...args);
    };
    input.coderProvider = async (...args) => {
      await count("coder");
      if (args[1]?.providerIdempotencyKey) await count(`coder-key:${args[1].providerIdempotencyKey}`);
      if (process.env.BOUNDED_TASK_WORKER_FORBID_CODER === "1") throw new Error("coder replayed");
      return coder(...args);
    };
    input.durableTask = { registryRoot: process.env.BOUNDED_TASK_WORKER_REGISTRY,
      idempotencyKey: "cross.process.fixture",
      leaseTimeoutMs: Number(process.env.BOUNDED_TASK_WORKER_LEASE_MS ?? 120000),
      resume: process.env.BOUNDED_TASK_WORKER_RESUME === "1",
      providerIdempotencySupport: process.env.BOUNDED_TASK_WORKER_IDEMPOTENT === "1"
        ? { planner: true, coder: true, context: true } : undefined,
      onProviderCheckpoint: (event) => {
        if (`${event.providerKind}:${event.phase}` === process.env.BOUNDED_TASK_WORKER_CRASH_PROVIDER) {
          process.kill(process.pid, "SIGKILL");
        }
      },
      onCheckpoint: (state) => {
        if (state.currentState === process.env.BOUNDED_TASK_WORKER_CRASH_STATE) {
          process.kill(process.pid, "SIGKILL");
        }
      } };
    const result = process.env.BOUNDED_TASK_WORKER_RESUME === "1"
      ? await runtime.resumeBoundedTask(input) : await runBoundedTask(input);
    if (process.env.BOUNDED_TASK_WORKER_OUTPUT) await fs.writeFile(
      process.env.BOUNDED_TASK_WORKER_OUTPUT, JSON.stringify(result));
    process.exit(result.decision === "bounded_task_completed" ? 0 : 2);
  }

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
      assert.match(result.receipt.compiledPolicyHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(result.plannerResult.executionBinding.policyHash,
        result.receipt.compiledPolicyHash);
    });

    await check("caller scope cannot widen canonical policy", async () => {
      const input = await fixture("blocked");
      input.allowedChangeFiles = ["src/service.ts", "package.json"];
      input.forbiddenFiles = [];
      input.canonicalPolicy = { policyDocument: {
        schemaVersion: "1", allowed_paths: ["src/**"], forbidden_paths: [],
        paired_files: [], sensitive_patterns: [], sensitive_paths: [], ownership_rules: []
      } };
      let applyCalls = 0;
      input.applyExecutor = async () => { applyCalls++; throw new Error("Unexpected apply"); };
      const result = await runBoundedTask(input);
      assert.equal(result.failure.code, "bounded_task_mutation_scope_violation", JSON.stringify(result));
      assert.equal(result.summary.verifierCalled, true);
      assert.equal(applyCalls, 0);
    });

    await check("missing canonical policy source fails before providers and apply", async () => {
      const input = await fixture("applied");
      delete input.canonicalPolicy;
      let plannerCalls = 0; let applyCalls = 0;
      input.plannerMinimalityProvider = async () => { plannerCalls++; return {}; };
      input.applyExecutor = async () => { applyCalls++; return null; };
      const result = await runBoundedTask(input);
      assert.equal(result.failure.code, "canonical_policy_source_required");
      assert.equal(plannerCalls, 0); assert.equal(applyCalls, 0);
    });

    await check("policy snapshot drift after verification blocks governed apply", async () => {
      const input = await fixture("governed");
      let changed = false;
      Object.defineProperty(input.canonicalPolicy, "authority", { enumerable: true, get() {
        if (!changed) { changed = true; fsSync.writeFileSync(path.join(input.repositoryPath,
          "src/policy-drift.ts"), "export {};\n"); }
        return undefined;
      } });
      const result = await runBoundedTask(input);
      assert.equal(result.route, "replan_required", JSON.stringify(result));
      assert.equal(result.failure.code, "bounded_task_policy_changed");
      assert.equal(result.summary.applyCalled, false);
    });

    await check("policy snapshot drift blocks no-change acceptance", async () => {
      const input = await fixture("no_change");
      let changed = false;
      Object.defineProperty(input.canonicalPolicy, "authority", { enumerable: true, get() {
        if (!changed) { changed = true; fsSync.writeFileSync(path.join(input.repositoryPath,
          "src/no-change-policy-drift.ts"), "export {};\n"); }
        return undefined;
      } });
      const result = await runBoundedTask(input);
      assert.equal(result.route, "replan_required", JSON.stringify(result));
      assert.equal(result.failure.code, "bounded_task_policy_changed");
      assert.equal(result.summary.applyCalled, false);
    });

    await check("policy change after planning requires replan before verification or apply", async () => {
      const input = await fixture("approved");
      const policyPath = path.join(input.repositoryPath, "bounded-agent.policy.yml");
      const policy = ["schemaVersion: '1'", "allowed_paths:", "  - src/**",
        "forbidden_paths: []", "paired_files: []", "sensitive_patterns: []",
        "sensitive_paths: []", "ownership_rules: []", ""].join("\n");
      await fs.writeFile(policyPath, policy);
      input.canonicalPolicy = { policyFilePath: "bounded-agent.policy.yml" };
      const original = input.plannerMinimalityProvider;
      input.plannerMinimalityProvider = async (context, control) => {
        const output = await original(context, control);
        await fs.writeFile(policyPath, policy.replace("src/**", "docs/**"));
        return output;
      };
      let applyCalls = 0;
      input.applyExecutor = async () => { applyCalls++; throw new Error("Unexpected apply"); };
      const result = await runBoundedTask(input);
      assert.equal(result.route, "replan_required", JSON.stringify(result));
      assert.equal(result.failure.code, "bounded_task_policy_changed");
      assert.equal(result.summary.verifierCalled, false);
      assert.equal(applyCalls, 0);
    });

    await check("paired, sensitive, and ownership policy gates stop before apply", async () => {
      const cases = [
        [{ paired_files: [{ source: "src/service.ts", requires: "tests/service.test.ts" }] },
          "canonical_policy_paired_file_missing", "replan_required"],
        [{ sensitive_paths: [{ pattern: "src/service.ts", disposition: "deny" }] },
          "canonical_policy_sensitive_path", "human_review_required"],
        [{ ownership_rules: [{ pattern: "src/service.ts", authorities: ["platform"] }] },
          "canonical_policy_ownership_authority_missing", "human_review_required"]
      ];
      for (const [extra, code, route] of cases) {
        const input = await fixture("approved");
        input.canonicalPolicy = { policyDocument: { schemaVersion: "1",
          allowed_paths: ["src/**", "tests/**"], forbidden_paths: [],
          paired_files: [], sensitive_patterns: [], sensitive_paths: [], ownership_rules: [],
          ...extra } };
        let applyCalls = 0;
        input.applyExecutor = async () => { applyCalls++; throw new Error("Unexpected apply"); };
        const result = await runBoundedTask(input);
        assert.equal(result.failure.code, code, JSON.stringify(result));
        assert.equal(result.route, route);
        assert.equal(applyCalls, 0);
      }
    });

    await check("literal credential policy rejects before apply without exposing the value", async () => {
      const input = await fixture("approved");
      const literal = "runtime-secret-should-never-appear";
      input.canonicalPolicy.policyDocument.sensitive_patterns = ["API_KEY"];
      input.coderProvider = async () => ({ role: "coder", target: "patchDraft",
        summary: "Unsafe literal.", claims: [{ type: "patch_draft",
          claimVersion: "text-file-update/v1", operation: "update", file: "src/service.ts",
          expectedContentHash: contentHash("export function compute(value: number): number { return value * 2; }\n"),
          description: "Add configuration.", newContent: `const API_KEY = "${literal}";\n` }],
        touchedFiles: ["src/service.ts"], confidence: 0.9 });
      let applyCalls = 0;
      input.applyExecutor = async () => { applyCalls++; return null; };
      const result = await runBoundedTask(input);
      assert.equal(result.failure.code, "canonical_policy_sensitive_literal", JSON.stringify(result));
      assert.equal(applyCalls, 0);
      assert.equal(JSON.stringify({ failure: result.failure, receipt: result.receipt }).includes(literal), false);
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

    await check("caller-provided receipt hash cannot prove governed completion", async () => {
      const result = await runBoundedTask(await fixture("applied"));
      assert.equal(result.decision, "bounded_task_invalid", JSON.stringify(result));
      assert.equal(result.route, "human_review_required");
      assert.equal(result.failure.code, "bounded_task_unverified_apply_receipt");
      assert.equal(result.receipt, null);
      assert.equal(result.summary.applyCalled, true);
      assert.equal(result.verifierResult.version, "deterministic-verifier/v2");
    });

    await check("12A adapter preserves every mutation payload field", async () => {
      const input = await fixture();
      const mutation = await input.coderProvider();
      const bindingHash = hashCanonicalJson({ binding: "adapter-smoke" });
      const adapted = adaptVerifiedCoderMutation({ taskId: input.taskId,
        objectiveHash: input.objectiveHash, planHash: hashCanonicalJson({ plan: "adapter-smoke" }),
        contextBindingHash: bindingHash, plannerExecutionBindingHash: bindingHash,
        compiledPolicyHash: compiledPolicyHashFor(input),
        coderMutation: mutation, verifierFindingHash: hashCanonicalJson({ verifier: "approved" }) });
      assert.equal(adapted.repairMutation.role, "remask");
      assert.equal(adapted.repairMutation.target, "repairDraft");
      assert.deepEqual(adapted.repairMutation.touchedFiles, mutation.touchedFiles);
      assert.deepEqual(adapted.repairMutation.claims.map(({ type, ...claim }) => claim),
        mutation.claims.map(({ type, ...claim }) => claim));
      assert.equal(adapted.receipt.losslessPayloadHash,
        hashCanonicalJson({ claims: mutation.claims.map(({ type, ...claim }) => claim),
          touchedFiles: mutation.touchedFiles }));
    });

    await check("12A governed adapter rejects a fabricated verifier receipt before Phase V", async () => {
      const input = await fixture();
      const mutation = await input.coderProvider();
      const hash = hashCanonicalJson({ binding: "invalid-verifier-smoke" });
      await assert.rejects(() => executeCanonicalGovernedMutation({ taskId: input.taskId,
        objectiveHash: input.objectiveHash, repositoryPath: input.repositoryPath,
        planHash: hash, contextBindingHash: hash, plannerExecutionBindingHash: hash,
        compiledPolicyHash: compiledPolicyHashFor(input),
        coderMutation: mutation,
        verifierFinding: { role: "verifier", target: "verifierFinding",
          summary: "Fabricated approval.", claims: [], touchedFiles: mutation.touchedFiles,
          confidence: 1 },
        adaptiveResult: {}, allowedFiles: input.allowedChangeFiles, forbiddenFiles: [],
        configuration: { registryDirectoryPath: input.repositoryPath,
          rollbackBundleParentPath: input.repositoryPath,
          validationWorkspaceParentPath: input.repositoryPath,
          phaseVExecutionSpecification: { allowedExecutables: ["node"],
            maxOutputChars: 1000, commands: [] } } }),
      (error) => error?.code === "canonical_coder_verifier_receipt_invalid");
    });

    await check("governed runtime applies and validates in a real Git repository", async () => {
      const input = await fixture("governed");
      const result = await runBoundedTask(input);
      assert.equal(result.decision, "bounded_task_completed", JSON.stringify(result));
      assert.equal(result.route, "contract_approved");
      assert.equal(result.receipt.outcome, "applied_and_validated");
      assert.equal(result.summary.applyCalled, true);
      assert.equal(verifyBoundedTaskReceipt(result.receipt), true);
      assert.match(await fs.readFile(path.join(input.repositoryPath, "src/service.ts"), "utf8"), /value \* 3/);
    });

    await check("12B freshness is derived from verified receipts and rejects artifact drift", async () => {
      const input = await fixture("governed");
      const configuration = input.governedExecution;
      const { governedExecution: _, ...draftInput } = input;
      const draft = await runBoundedTask(draftInput);
      assert.equal(draft.route, "verified_draft_ready", JSON.stringify(draft));
      const plannerResult = draft.plannerResult;
      const adaptiveResult = plannerResult.taskSeedResult.repoResult.adaptiveResult;
      const coderResult = adaptiveResult.coderResult;
      const canonicalInput = { taskId: input.taskId,
        objectiveHash: input.objectiveHash, repositoryPath: input.repositoryPath,
        planHash: plannerResult.minimalityResult.plan.planHash,
        contextBindingHash: hashCanonicalJson(coderResult.context),
        plannerExecutionBindingHash: plannerResult.executionBinding.bindingHash,
        compiledPolicyHash: draft.receipt.compiledPolicyHash,
        coderMutation: coderResult.providerOutput,
        verifierFinding: draft.verifierResult.finding,
        adaptiveResult, allowedFiles: input.allowedChangeFiles,
        forbiddenFiles: input.forbiddenFiles, configuration };
      const prepared = await prepareCanonicalGovernedMutation(canonicalInput);
      const wrongPolicyFinding = structuredClone(canonicalInput.verifierFinding);
      wrongPolicyFinding.claims[0].policyHash = hashCanonicalJson({ policy: "wrong-verifier-policy" });
      await assert.rejects(() => prepareCanonicalGovernedMutation({
        ...canonicalInput, verifierFinding: wrongPolicyFinding
      }), (error) => error?.code === "canonical_coder_verifier_receipt_invalid");
      const snapshot = buildCanonicalFreshnessSnapshot({
        adapterReceipt: prepared.adapterReceipt, repairMutation: prepared.repairMutation,
        receipts: prepared.governanceReceipts
      });
      assert.equal(snapshot.finalLedgerRootHash, prepared.governanceReceipts.finalLedger.rootHash);
      assert.equal(snapshot.finalLedgerEventCount, prepared.governanceReceipts.finalLedger.eventCount);
      assert.equal(snapshot.patchDryRunResultHash,
        hashCanonicalJson(prepared.governanceReceipts.patchDryRun));
      assert.equal(snapshot.temporaryApplyResultHash,
        hashCanonicalJson(prepared.governanceReceipts.temporaryApply));
      assert.equal(snapshot.executionVerificationResultHash,
        prepared.governanceReceipts.phaseVExecutionVerification.verificationResultHash);
      assert.equal(snapshot.governanceHash,
        prepared.governanceReceipts.governanceAssessment.governanceHash);
      assert.equal(snapshot.routeHash,
        prepared.governanceReceipts.approvalRouteAssessment.routeHash);
      const changedPolicyHash = hashCanonicalJson({ policy: "changed-after-prepare" });
      const reboundFinding = structuredClone(canonicalInput.verifierFinding);
      reboundFinding.claims[0].policyHash = changedPolicyHash;
      await assert.rejects(() => executePreparedCanonicalGovernedMutation({ ...canonicalInput,
        compiledPolicyHash: changedPolicyHash, verifierFinding: reboundFinding }, prepared),
      (error) => error?.code === "canonical_prepared_mutation_binding_invalid");
      const drifted = structuredClone(prepared.governanceReceipts);
      drifted.governedArtifact.evidence.finalLedgerRootHash = hashCanonicalJson({ drift: true });
      assert.throws(() => buildCanonicalFreshnessSnapshot({
        adapterReceipt: prepared.adapterReceipt, repairMutation: prepared.repairMutation,
        receipts: drifted
      }), (error) => error?.code === "canonical_freshness_verification_failed");
      const governed = await executePreparedCanonicalGovernedMutation(canonicalInput, prepared);
      assert.equal(governed.integratedResult.route, "contract_approved");
    });

    await check("12C format-valid forged governance hashes cannot start apply", async () => {
      const input = await fixture("governed");
      const configuration = input.governedExecution;
      const { governedExecution: _, ...draftInput } = input;
      const draft = await runBoundedTask(draftInput);
      const plannerResult = draft.plannerResult;
      const adaptiveResult = plannerResult.taskSeedResult.repoResult.adaptiveResult;
      const coderResult = adaptiveResult.coderResult;
      const canonicalInput = { taskId: input.taskId,
        objectiveHash: input.objectiveHash, repositoryPath: input.repositoryPath,
        planHash: plannerResult.minimalityResult.plan.planHash,
        contextBindingHash: hashCanonicalJson(coderResult.context),
        plannerExecutionBindingHash: plannerResult.executionBinding.bindingHash,
        compiledPolicyHash: draft.receipt.compiledPolicyHash,
        coderMutation: coderResult.providerOutput,
        verifierFinding: draft.verifierResult.finding,
        adaptiveResult, allowedFiles: input.allowedChangeFiles,
        forbiddenFiles: input.forbiddenFiles, configuration };
      const prepared = await prepareCanonicalGovernedMutation(canonicalInput);
      const baseline = await fs.readFile(path.join(input.repositoryPath, "src/service.ts"), "utf8");
      const fakeHash = hashCanonicalJson({ forged: "governance-receipt" });
      assert.match(fakeHash, /^sha256:[0-9a-f]{64}$/);
      const forgeries = [
        (receipts) => { receipts.governanceAssessment.governanceHash = fakeHash; },
        (receipts) => { receipts.adminInvocationAssessment.governanceHash = fakeHash; },
        (receipts) => { receipts.approvalRouteAssessment.governanceHash = fakeHash; },
        (receipts) => { receipts.governedArtifact.evidence.governanceHash = fakeHash; }
      ];
      for (const forge of forgeries) {
        const forged = structuredClone(prepared);
        forge(forged.governanceReceipts);
        await assert.rejects(
          () => executePreparedCanonicalGovernedMutation(canonicalInput, forged),
          (error) => ["canonical_freshness_receipts_invalid",
            "canonical_freshness_verification_failed"].includes(error?.code));
        assert.equal(await fs.readFile(path.join(input.repositoryPath, "src/service.ts"), "utf8"), baseline);
        assert.equal(execFileSync("git", ["status", "--porcelain"], {
          cwd: input.repositoryPath, encoding: "utf8" }), "");
        assert.deepEqual(await fs.readdir(configuration.registryDirectoryPath), []);
        assert.deepEqual(await fs.readdir(configuration.rollbackBundleParentPath), []);
        assert.deepEqual(await fs.readdir(configuration.validationWorkspaceParentPath), []);
      }
    });

    await check("governed validation failure restores the Git baseline", async () => {
      const input = await fixture("governed_failure");
      const source = path.join(input.repositoryPath, "src/service.ts");
      const baseline = await fs.readFile(source, "utf8");
      const validationParent = input.governedExecution.validationWorkspaceParentPath;
      const watcher = new Promise((resolve, reject) => {
        const deadline = Date.now() + 20_000;
        const timer = setInterval(async () => {
          try {
            const workspaces = await fs.readdir(validationParent);
            const candidate = workspaces.length === 0 ? null
              : path.join(validationParent, workspaces[0], "src/service.ts");
            const value = candidate === null ? "" : await fs.readFile(candidate, "utf8");
            if (candidate !== null && value.includes("value * 3")) {
              clearInterval(timer);
              await fs.writeFile(candidate, "export const corruptedDuringValidation = true;\n", "utf8");
              resolve(true);
            } else if (Date.now() > deadline) {
              clearInterval(timer);
              reject(new Error("Permanent apply was not observed."));
            }
          } catch (error) {
            if (error && error.code === "ENOENT" && Date.now() <= deadline) return;
            clearInterval(timer);
            reject(error);
          }
        }, 25);
      });
      const [result] = await Promise.all([runBoundedTask(input), watcher]);
      assert.notEqual(result.decision, "bounded_task_completed", JSON.stringify(result));
      assert.equal(result.receipt, null);
      assert.equal(result.summary.applyCalled, true);
      assert.equal(await fs.readFile(source, "utf8"), baseline);
    });

    await check("no-change completion runs real acceptance without applying", async () => {
      const input = await fixture("no_change");
      const baseline = await fs.readFile(path.join(input.repositoryPath, "src/service.ts"), "utf8");
      const result = await runBoundedTask(input);
      assert.equal(result.decision, "bounded_task_completed", JSON.stringify(result));
      assert.equal(result.route, "contract_approved");
      assert.equal(result.receipt.outcome, "validated_no_change");
      assert.equal(result.summary.applyCalled, false);
      assert.equal(await fs.readFile(path.join(input.repositoryPath, "src/service.ts"), "utf8"), baseline);
      assert.equal(verifyBoundedTaskReceipt(result.receipt), true);
    });

    await check("malformed coder outputs stop before verifier and apply", async () => {
      const input = await fixture();
      const valid = await input.coderProvider();
      const { claims, ...missingClaims } = valid;
      const outputs = [
        {}, null, undefined, [], "invalid", missingClaims,
        { ...valid, claims: null },
        { ...valid, touchedFiles: "src/service.ts" },
        { ...valid, touchedFiles: null },
        { ...valid, touchedFiles: [null] },
        { ...valid, touchedFiles: [42] }
      ];
      let applyCalls = 0;
      for (const output of outputs) {
        const result = await runBoundedTask({
          ...input,
          coderProvider: async () => output,
          applyExecutor: async () => { applyCalls++; throw new Error("Unexpected apply"); }
        });
        assert.equal(result.decision, "bounded_task_invalid", JSON.stringify(result));
        assert.equal(result.route, "human_review_required");
        assert.equal(result.failure.stage, "coding");
        assert.equal(result.failure.route, "invalid_input");
        assert.equal(result.failure.code, "bounded_task_coder_output_invalid");
        assert.equal(result.summary.coderCalled, true);
        assert.equal(result.summary.verifierCalled, false);
        assert.equal(result.summary.applyCalled, false);
        assert.equal(result.verifierResult, null);
        assert.equal(result.applyResult, null);
        assert.equal(result.receipt, null);
      }
      assert.equal(applyCalls, 0);
    });

    await check("malformed apply outputs return recovery failure without retrying", async () => {
      const input = await fixture("applied");
      const valid = await input.applyExecutor();
      const outputs = [
        null, undefined, {}, [], "invalid",
        { route: valid.route, receiptHash: valid.receiptHash },
        { decision: valid.decision, receiptHash: valid.receiptHash },
        { decision: valid.decision, route: valid.route },
        { ...valid, decision: "unknown" },
        { ...valid, route: "unknown" },
        { ...valid, receiptHash: 42 },
        { ...valid, receiptHash: "bad-hash" }
      ];
      for (const output of outputs) {
        let applyCalls = 0;
        const result = await runBoundedTask({
          ...input,
          applyExecutor: async () => { applyCalls++; return output; }
        });
        assert.equal(applyCalls, 1);
        assert.equal(result.decision, "bounded_task_stopped", JSON.stringify(result));
        assert.equal(result.route, "recovery_required");
        assert.equal(result.failure.stage, "apply");
        assert.equal(result.failure.route, "recovery_required");
        assert.equal(result.failure.code, "bounded_task_apply_executor_failed");
        assert.equal(result.summary.applyCalled, true);
        assert.equal(result.applyResult, null);
        assert.equal(result.receipt, null);
      }
    });

    await check("valid noncompleted apply results retain failure routing", async () => {
      const input = await fixture();
      for (const [decision, route, expectedDecision] of [
        ["apply_blocked", "replan_required", "bounded_task_stopped"],
        ["apply_invalid", "human_review_required", "bounded_task_invalid"],
        ["apply_recovery_required", "recovery_required", "bounded_task_stopped"],
        ["apply_completed", "contract_approved", "bounded_task_stopped"]
      ]) {
        const result = await runBoundedTask({
          ...input,
          applyExecutor: async () => ({ decision, route, receiptHash: null })
        });
        assert.equal(result.decision, expectedDecision);
        assert.equal(result.route, route === "contract_approved" ? "human_review_required" : route);
        assert.equal(result.failure.code, "bounded_task_apply_not_completed");
        assert.equal(result.receipt, null);
      }
    });

    await check("undefined optional confidence uses the validated mutation", async () => {
      const input = await fixture();
      const output = { ...await input.coderProvider(), confidence: undefined };
      const result = await runBoundedTask({ ...input, coderProvider: async () => output });
      assert.equal(result.decision, "bounded_task_completed");
      assert.equal(result.route, "verified_draft_ready");
      assert.equal(verifyBoundedTaskReceipt(result.receipt), true);
      const { confidence, ...cleaned } = output;
      assert.equal(result.receipt.coderMutationHash, hashCanonicalJson(cleaned));
    });

    await check("unsupported claim values are rejected before verification and apply", async () => {
      const input = await fixture();
      const valid = await input.coderProvider();
      for (const claims of [
        [...valid.claims, undefined],
        [{ ...valid.claims[0], metadata: undefined }],
        ...[NaN, Infinity, -Infinity].map((value) => [{ ...valid.claims[0], metadata: { value } }])
      ]) {
        let applyCalls = 0;
        const result = await runBoundedTask({
          ...input,
          coderProvider: async () => ({ ...valid, claims }),
          applyExecutor: async () => { applyCalls++; throw new Error("Unexpected apply"); }
        });
        assert.equal(result.decision, "bounded_task_invalid");
        assert.equal(result.failure.code, "bounded_task_coder_output_invalid");
        assert.equal(result.failure.details.path, "claims");
        assert.equal(result.summary.verifierCalled, false);
        assert.equal(result.summary.applyCalled, false);
        assert.equal(result.receipt, null);
        assert.equal(applyCalls, 0);
      }
    });

    await check("apply metadata cannot turn a hash-only result into completion", async () => {
      const input = await fixture("applied");
      const valid = await input.applyExecutor();
      let applyCalls = 0;
      const result = await runBoundedTask({
        ...input,
        applyExecutor: async () => {
          applyCalls++;
          return { ...valid, diagnostics: undefined, metrics: { value: Infinity } };
        }
      });
      assert.equal(result.decision, "bounded_task_invalid");
      assert.equal(result.failure.code, "bounded_task_unverified_apply_receipt");
      assert.equal(applyCalls, 1);
      assert.deepEqual(result.applyResult, valid);
      assert.equal(result.receipt, null);
    });

    await check("post-executor metadata does not throw or repeat executor", async () => {
      const input = await fixture("applied");
      const valid = await input.applyExecutor();
      let applyCalls = 0;
      input.applyExecutor = async () => {
        applyCalls++;
        // Inject a non-serializable receipt field after executor entry.
        input.taskId = undefined;
        return valid;
      };
      const result = await runBoundedTask(input);
      assert.equal(result.decision, "bounded_task_invalid");
      assert.equal(result.route, "human_review_required");
      assert.equal(result.failure.code, "bounded_task_unverified_apply_receipt");
      assert.equal(result.summary.applyCalled, true);
      assert.equal(result.receipt, null);
      assert.equal(applyCalls, 1);
    });

    await check("mutation scope requires caller permission, plan and verified context", async () => {
      for (const mode of ["unplanned", "unplanned_allowlisted", "planned_without_context", "context_without_plan"]) {
        const input = await fixture();
        const file = mode === "context_without_plan" ? "tests/service.test.ts" : "src/unrelated.ts";
        if (file === "src/unrelated.ts") {
          await write(input.repositoryPath, file, "export const unrelated = 1;\n");
        }
        if (mode !== "unplanned") input.allowedChangeFiles.push(file);
        if (mode === "planned_without_context") {
          const planner = await input.plannerMinimalityProvider();
          planner.minimalityPlan.plannedFiles.push({
            path: file, changeKind: "bugfix", requested: true, justification: null
          });
          input.plannerMinimalityProvider = async (context) => {
            const proposalCore = { ...planner.proposal, policyHash: context.policyHash };
            delete proposalCore.proposalHash;
            return { ...planner, proposal: { ...proposalCore,
              proposalHash: hashCanonicalJson(proposalCore) } };
          };
        }
        const valid = await input.coderProvider();
        input.coderProvider = async () => ({
          ...valid,
          touchedFiles: [file],
          claims: [{ ...valid.claims[0], file }]
        });
        let applyCalls = 0;
        input.applyExecutor = async () => { applyCalls++; throw new Error("Unexpected apply"); };
        const result = await runBoundedTask(input);
        assert.equal(result.decision, "bounded_task_stopped", `${mode}: ${JSON.stringify(result)}`);
        assert.equal(result.route, "replan_required");
        assert.equal(result.failure.code, "bounded_task_mutation_scope_violation");
        assert.equal(result.failure.details.files, file);
        assert.deepEqual(result.plannerResult.executionBinding.allowedMutationFiles, ["src/service.ts"]);
        assert.equal(result.summary.applyCalled, false);
        assert.equal(applyCalls, 0);
        assert.equal(result.receipt, null);
      }
    });

    await check("source hash must match bound context and current disk bytes", async () => {
      for (const mode of ["missing", "malformed", "wrong", "changed", "changed_and_model_rehashed", "valid"]) {
        const input = await fixture();
        const originalProvider = input.coderProvider;
        input.coderProvider = async (context) => {
          const output = await originalProvider(context);
          const claim = output.claims[0];
          const evidence = context.evidence.find((entry) => entry.path === claim.file);
          assert.equal(claim.expectedContentHash, evidence.contentHash);
          if (mode === "missing") delete claim.expectedContentHash;
          if (mode === "malformed") claim.expectedContentHash = "bad-hash";
          if (mode === "wrong") claim.expectedContentHash = contentHash("wrong");
          if (mode.startsWith("changed")) {
            const changed = "export function compute(value: number): number { return value * 9; }\n";
            await write(input.repositoryPath, claim.file, changed);
            if (mode === "changed_and_model_rehashed") claim.expectedContentHash = contentHash(changed);
          }
          return output;
        };
        let applyCalls = 0;
        input.applyExecutor = async () => {
          applyCalls++;
          return { decision: "apply_completed", route: "contract_approved", receiptHash: hashCanonicalJson({ applied: true }) };
        };
        const result = await runBoundedTask(input);
        if (mode === "valid") {
          assert.equal(result.decision, "bounded_task_invalid", JSON.stringify(result));
          assert.equal(result.failure.code, "bounded_task_unverified_apply_receipt");
          assert.equal(applyCalls, 1);
          assert.equal(result.receipt, null);
        } else {
          assert.equal(result.decision, "bounded_task_stopped", `${mode}: ${JSON.stringify(result)}`);
          assert.equal(result.route, "replan_required");
          assert.equal(result.failure.code, "mutation_source_hash_mismatch");
          assert.equal(result.summary.applyCalled, false);
          assert.equal(applyCalls, 0);
          assert.equal(result.receipt, null);
        }
      }
    });

    await check("never-settling planner and coder providers respect the shared deadline", async () => {
      for (const stage of ["planning", "coding"]) {
        const input = await fixture();
        let control;
        let plannerDeadline;
        const planner = input.plannerMinimalityProvider;
        input.plannerMinimalityProvider = async (context, options) => {
          plannerDeadline = options.deadlineAt;
          if (stage === "planning") { control = options; return new Promise(() => {}); }
          return planner(context);
        };
        if (stage === "coding") input.coderProvider = async (context, options) => {
          control = options;
          return new Promise(() => {});
        };
        input.timeoutMs = 300;
        input.applyExecutor = async () => { throw new Error("Unexpected apply"); };
        const start = Date.now();
        const result = await runBoundedTask(input);
        assert(Date.now() - start < 2000);
        assert.equal(result.failure.code, "bounded_task_deadline_exceeded");
        assert.equal(result.failure.stage, stage);
        assert.equal(result.failure.details.stage, stage);
        assert.equal(result.route, "replan_required");
        assert.equal(result.summary.applyCalled, false);
        assert.equal(control.signal.aborted, true);
        assert.equal(control.deadlineAt, plannerDeadline);
      }
    });

    await check("pre-cancellation and expired deadlines do not call providers", async () => {
      for (const mode of ["cancel", "deadline"]) {
        const input = await fixture();
        const controller = new AbortController();
        if (mode === "cancel") controller.abort();
        const result = await runBoundedTask({ ...input, signal: controller.signal,
          ...(mode === "deadline" ? { deadlineAt: Date.now() - 1 } : {}) });
        assert.equal(result.failure.code, mode === "cancel" ? "bounded_task_cancelled" : "bounded_task_deadline_exceeded");
        assert.equal(result.summary.plannerCalled, false);
        assert.equal(result.summary.coderCalled, false);
        assert.equal(result.summary.applyCalled, false);
      }
    });

    await check("late provider resolution or rejection after cancellation cannot start apply", async () => {
      for (const stage of ["planning", "coding"]) {
        for (const lateReject of [false, true]) {
          const input = await fixture();
          const valid = await (stage === "planning" ? input.plannerMinimalityProvider() : input.coderProvider());
          const controller = new AbortController();
          let release, fail, control, notifyStarted;
          const started = new Promise((resolve) => { notifyStarted = resolve; });
          const provider = async (context, options) => {
            control = options;
            notifyStarted();
            return new Promise((resolve, reject) => { release = resolve; fail = reject; });
          };
          if (stage === "planning") input.plannerMinimalityProvider = provider;
          else input.coderProvider = provider;
          let applyCalls = 0;
          input.applyExecutor = async () => { applyCalls++; throw new Error("Unexpected apply"); };
          const task = runBoundedTask({ ...input, signal: controller.signal });
          await started;
          controller.abort();
          const result = await task;
          assert.equal(result.failure.code, "bounded_task_cancelled");
          assert.equal(result.failure.stage, stage);
          assert.equal(control.signal.aborted, true);
          if (lateReject) fail(new Error("Late provider rejection")); else release(valid);
          await new Promise((resolve) => setTimeout(resolve, 10));
          assert.equal(applyCalls, 0);
          assert.equal(result.summary.applyCalled, false);
        }
      }
    });

    await check("cancellation and deadline do not abandon an executor already applying", async () => {
      const input = await fixture("applied");
      const valid = await input.applyExecutor();
      const controller = new AbortController();
      let release, notifyStarted, applyCalls = 0, settled = false;
      const started = new Promise((resolve) => { notifyStarted = resolve; });
      input.applyExecutor = async () => {
        applyCalls++;
        notifyStarted();
        return new Promise((resolve) => { release = resolve; });
      };
      const task = runBoundedTask({ ...input, timeoutMs: 300, signal: controller.signal });
      task.then(() => { settled = true; });
      await started;
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(settled, false);
      release({ ...valid, decision: "apply_recovery_required", route: "recovery_required", receiptHash: null });
      const result = await task;
      assert.equal(result.route, "recovery_required");
      assert.equal(result.failure.stage, "apply");
      assert.equal(applyCalls, 1);
    });

    await check("no-op mutation requires replan without apply", async () => {
      const input = await fixture();
      const original = input.coderProvider;
      input.coderProvider = async (context) => {
        const output = await original();
        output.claims[0].newContent = context.evidence.find((entry) => entry.path === "src/service.ts").content;
        return output;
      };
      let applyCalls = 0;
      input.applyExecutor = async () => { applyCalls++; throw new Error("Unexpected apply"); };
      const result = await runBoundedTask(input);
      assert.equal(result.route, "replan_required");
      assert.equal(result.failure.code, "mutation_no_change");
      assert.equal(applyCalls, 0);
    });

    await check("durable terminal replay calls no provider and preserves receipt hash", async () => {
      const input = await fixture();
      const registryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-task-state-"));
      roots.push(registryRoot); let plannerCalls = 0; let coderCalls = 0;
      const planner = input.plannerMinimalityProvider; const coder = input.coderProvider;
      input.plannerMinimalityProvider = async (...args) => { plannerCalls++; return planner(...args); };
      input.coderProvider = async (...args) => { coderCalls++; return coder(...args); };
      input.durableTask = { registryRoot, idempotencyKey: "terminal.replay" };
      const first = await runBoundedTask(input);
      const replay = await resumeBoundedTask({ ...input, plannerMinimalityProvider: async () => {
        throw new Error("planner replayed"); }, coderProvider: async () => {
        throw new Error("coder replayed"); } });
      assert.equal(first.decision, "bounded_task_completed");
      assert.equal(replay.receipt.receiptHash, first.receipt.receiptHash);
      assert.equal(plannerCalls, 1); assert.equal(coderCalls, 1);
    });

    await check("concurrent durable call returns already-running without a second provider", async () => {
      const input = await fixture();
      const registryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-task-state-"));
      roots.push(registryRoot); let release; let started; let plannerCalls = 0;
      const entered = new Promise((resolve) => { started = resolve; });
      const original = input.plannerMinimalityProvider;
      input.plannerMinimalityProvider = async (...args) => { plannerCalls++; started();
        await new Promise((resolve) => { release = resolve; }); return original(...args); };
      input.durableTask = { registryRoot, idempotencyKey: "concurrent.task" };
      const active = runBoundedTask(input); await entered;
      const concurrent = await runBoundedTask(input);
      assert.equal(concurrent.failure.code, "bounded_task_already_running");
      assert.equal(plannerCalls, 1); release();
      assert.equal((await active).decision, "bounded_task_completed");
    });

    await check("resume without durable state fails closed before providers", async () => {
      const input = await fixture(); let calls = 0;
      const registryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-task-state-"));
      roots.push(registryRoot); input.durableTask = { registryRoot, idempotencyKey: "missing.task" };
      input.plannerMinimalityProvider = async () => { calls++; return {}; };
      const result = await resumeBoundedTask(input);
      assert.equal(result.failure.code, "bounded_task_state_missing"); assert.equal(calls, 0);
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
