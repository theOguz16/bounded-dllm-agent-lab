#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const cli = path.join(process.cwd(), "dist/apps/cli/src/index.js");
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function execute(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-cli-"));
  const repository = path.join(root, "repository");
  const state = path.join(root, "state");
  const source = "export function calculate(value: number): number { return value * 2; }\n";
  const test = "import { calculate } from '../src/calculate.js';\nvoid calculate(2);\n";
  await write(path.join(repository, "src/calculate.ts"), source);
  await write(path.join(repository, "test/calculate.test.ts"), test);
  await write(path.join(repository, "package.json"), { type: "module" });
  await write(path.join(repository, "bounded-agent.policy.yml"), [
    'schemaVersion: "1"', "allowed_paths:", "  - src/**", "  - test/**",
    "forbidden_paths:", "  - package.json", "paired_files: []", "sensitive_patterns: []",
    "sensitive_paths: []", "ownership_rules: []", ""
  ].join("\n"));
  await fs.mkdir(state, { recursive: true });

  let providerCalls = 0;
  let coderFinishReason = "stop";
  let oversizedCoderResponse = false;
  const secret = "task08-super-secret-value";
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      providerCalls += 1;
      assert.equal(request.headers.authorization, `Bearer ${secret}`);
      const payload = JSON.parse(body);
      const system = payload.messages[0].content;
      let content;
      if (system.includes("bounded repository planner")) {
        const context = JSON.parse(payload.messages[1].content);
        const replan = context.taskId === "task.cli.replan";
        content = { proposal: { proposalVersion: "1", taskId: context.taskId,
          objectiveHash: context.objectiveHash, acceptanceContractHash: context.acceptanceContractHash,
          authorityHash: context.authorityHash, policyHash: context.policyHash,
          seedFiles: ["src/calculate.ts"], seedRationales: [{ path: "src/calculate.ts",
            reason: "Existing implementation boundary." }], requiredSymbols: ["calculate"],
          requiredTestFiles: ["test/calculate.test.ts"], maxExpansionAttempts: 1 },
          minimalityPlan: { planVersion: "1", riskClass: "low", taskExplicitlyRequestsRefactor: false,
            plannedFiles: [{ path: "src/calculate.ts", changeKind: replan ? "refactor" : "bugfix", requested: !replan,
              justification: null }], newDependencies: [], newAbstractions: [] } };
      } else {
        content = { role: "coder", target: "patchDraft", summary: "Fix calculate.",
          claims: [{ type: "patch_draft", claimVersion: "text-file-update/v1", operation: "update",
            file: "src/calculate.ts", expectedContentHash: hash(source),
            description: "Correct calculation behavior.",
            newContent: "export function calculate(value: number): number { return value * 3; }\n" }],
          touchedFiles: ["src/calculate.ts"], confidence: 0.9 };
      }
      response.writeHead(200, { "content-type": "application/json" });
      const plannerResponse = system.includes("bounded repository planner");
      response.end(JSON.stringify({ choices: [{ finish_reason: plannerResponse ? "stop" : coderFinishReason,
        message: { content: oversizedCoderResponse && !plannerResponse
          ? "x".repeat(1024 * 1024 + 1) : JSON.stringify(content) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  const acceptance = path.join(root, "acceptance.json");
  const provider = path.join(root, "provider.json");
  const taskFile = path.join(root, "task.json");
  await write(acceptance, { schemaVersion: "canonical-cli-acceptance/v1", criteria: [{
    id: "calculate_test", description: "Calculate regression remains required.", required: true,
    evidence: { kind: "test", commandId: "test.calculate" }
  }] });
  await write(provider, { schemaVersion: "canonical-cli-provider/v1", kind: "openai-compatible",
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, model: "fixture-model",
    apiKeyEnv: "CANONICAL_CLI_TEST_KEY", apiKeyRequired: true, timeoutMs: 5000, maxOutputTokens: 1024 });
  await write(taskFile, { schemaVersion: "canonical-cli-task/v1", taskId: "task.cli.fixture",
    objective: "Fix calculate safely.", repositoryPath: "./repository",
    seedFiles: ["src/calculate.ts"], allowedChangeFiles: ["src/calculate.ts"],
    forbiddenFiles: ["package.json"], requiredSymbols: ["calculate"],
    requiredTestFiles: ["test/calculate.test.ts"], policyFile: "./repository/bounded-agent.policy.yml",
    acceptanceFile: "./acceptance.json", providerFile: "./provider.json",
    durable: { registryRoot: "./state", idempotencyKey: "task.cli.fixture.v1" } });

  try {
    const run = await execute(["run", "--task", taskFile, "--json"], { CANONICAL_CLI_TEST_KEY: secret });
    assert.equal(run.code, 0, run.stderr || run.stdout);
    const runJson = JSON.parse(run.stdout);
    assert.equal(runJson.command, "run");
    assert.equal(runJson.mode, "draft");
    assert.equal(runJson.decision, "bounded_task_completed");
    assert.equal(runJson.outcome, "structurally_verified_draft");
    assert.equal(runJson.costBudget, null);
    assert.equal(runJson.validation.checks.find((item) => item.kind === "syntax").status, "not_run");
    assert.equal(run.stdout.includes(secret), false);
    assert.equal(await fs.readFile(path.join(repository, "src/calculate.ts"), "utf8"), source);
    assert.equal(providerCalls, 2, "run must call the real planner and coder path exactly once each");

    for (const command of ["status", "inspect"]) {
      const before = await fs.readFile(path.join(repository, "src/calculate.ts"), "utf8");
      const result = await execute([command, "--task", taskFile, "--json"], { CANONICAL_CLI_TEST_KEY: "" });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).command, command);
      assert.equal(providerCalls, 2, `${command} must not call provider`);
      assert.equal(await fs.readFile(path.join(repository, "src/calculate.ts"), "utf8"), before);
      assert.equal(result.stdout.includes(secret), false);
    }

    const resume = await execute(["resume", "--task", taskFile, "--json"], {
      CANONICAL_CLI_TEST_KEY: secret
    });
    assert.equal(resume.code, 0, resume.stderr || resume.stdout);
    assert.equal(JSON.parse(resume.stdout).costBudget, null,
      "budgetless CLI resume must preserve the optional budget as absent/null output");
    assert.equal(JSON.parse(resume.stdout).terminalCacheValidation.status, "current");
    assert.equal(providerCalls, 2, "resume of terminal success must not call provider or apply");
    assert.equal(await fs.readFile(path.join(repository, "src/calculate.ts"), "utf8"), source);

    const recover = await execute(["recover", "--task", taskFile, "--json"], {
      CANONICAL_CLI_TEST_KEY: secret
    });
    assert.equal(recover.code, 0, recover.stderr || recover.stdout);
    assert.equal(JSON.parse(recover.stdout).terminalCacheValidation.status, "current");
    assert.equal(providerCalls, 2, "recover of reconciled terminal success must not call provider or apply");

    const humanStatus = await execute(["status", "--task", taskFile], { CANONICAL_CLI_TEST_KEY: "" });
    assert.equal(humanStatus.code, 0);
    assert.match(humanStatus.stdout, /^OK: status task\.cli\.fixture/m);
    assert.equal(providerCalls, 2);

    const missingCredential = await execute(["run", "--task", taskFile, "--json"], {
      CANONICAL_CLI_TEST_KEY: ""
    });
    assert.equal(missingCredential.code, 5);
    assert.equal(JSON.parse(missingCredential.stdout).code, "cli_provider_credentials_missing");
    assert.equal(missingCredential.stdout.includes(secret), false);

    const validation = path.join(root, "validation.json");
    await write(validation, { schemaVersion: "canonical-cli-validation/v1", profile: "existing_function_bug_fix",
      containerRuntime: "definitely-missing-runtime-task08", executionSpecification: {
        allowedExecutables: ["node"], commands: [{ id: "test.calculate", checkKind: "behavior_test",
          executable: "node", args: ["test/calculate.test.ts"] }] } });
    const validatedTask = { ...JSON.parse(await fs.readFile(taskFile, "utf8")),
      taskId: "task.cli.validation", validationFile: "./validation.json",
      durable: { registryRoot: "./state", idempotencyKey: "task.cli.validation.v1" } };
    const validatedTaskFile = path.join(root, "task-validation.json");
    await write(validatedTaskFile, validatedTask);
    const missingRuntime = await execute(["run", "--task", validatedTaskFile, "--json"], {
      CANONICAL_CLI_TEST_KEY: secret
    });
    assert.equal(missingRuntime.code, 5);
    assert.equal(JSON.parse(missingRuntime.stdout).code, "cli_validation_environment_missing");
    assert.equal(providerCalls, 2, "validation preflight must fail before provider calls");

    for (const profile of ["bounded_behavior_change", "regression_test_addition"]) {
      await write(validation, { schemaVersion: "canonical-cli-validation/v1", profile,
        containerRuntime: "definitely-missing-runtime-task08", executionSpecification: {
          allowedExecutables: ["node"], commands: [{ id: "test.calculate", checkKind: "behavior_test",
            executable: "node", args: ["test/calculate.test.ts"] }] } });
      const profileTaskFile = path.join(root, `task-${profile}.json`);
      await write(profileTaskFile, { ...validatedTask, taskId: `task.cli.${profile}`,
        durable: { registryRoot: "./state", idempotencyKey: `task.cli.${profile}.v1` } });
      const profileResult = await execute(["run", "--task", profileTaskFile, "--json"], {
        CANONICAL_CLI_TEST_KEY: secret
      });
      assert.equal(profileResult.code, 5, profileResult.stderr || profileResult.stdout);
      assert.equal(JSON.parse(profileResult.stdout).code, "cli_validation_environment_missing",
        `${profile} must pass parsing and reach validation environment preflight`);
    }
    await write(validation, { schemaVersion: "canonical-cli-validation/v1",
      profile: "limited_behavior_change", containerRuntime: "definitely-missing-runtime-task08",
      executionSpecification: { allowedExecutables: ["node"], commands: [{ id: "test.calculate",
        checkKind: "behavior_test", executable: "node", args: ["test/calculate.test.ts"] }] } });
    const legacyProfile = await execute(["run", "--task", validatedTaskFile, "--json"], {
      CANONICAL_CLI_TEST_KEY: secret
    });
    assert.equal(legacyProfile.code, 2);
    assert.equal(JSON.parse(legacyProfile.stdout).code, "cli_validation_profile_invalid");
    assert.equal(providerCalls, 2, "profile validation must not call providers");

    const replanTaskFile = path.join(root, "task-replan.json");
    await write(replanTaskFile, { ...JSON.parse(await fs.readFile(taskFile, "utf8")),
      taskId: "task.cli.replan", durable: { registryRoot: "./state", idempotencyKey: "task.cli.replan.v1" } });
    const beforeReplanCalls = providerCalls;
    const replan = await execute(["run", "--task", replanTaskFile, "--json"], {
      CANONICAL_CLI_TEST_KEY: secret
    });
    assert.equal(replan.code, 3, replan.stderr || replan.stdout);
    const replanJson = JSON.parse(replan.stdout);
    assert.equal(replanJson.route, "replan_required");
    assert.match(replanJson.nextStep, /no automatic replan was started/);
    assert.equal(providerCalls, beforeReplanCalls + 1, "replan must stop after one planner call");

    const traversalTaskFile = path.join(root, "task-traversal.json");
    await write(traversalTaskFile, { ...JSON.parse(await fs.readFile(taskFile, "utf8")),
      taskId: "task.cli.traversal", seedFiles: ["../acceptance.json"],
      durable: { registryRoot: "./state", idempotencyKey: "task.cli.traversal.v1" } });
    const traversal = await execute(["run", "--task", traversalTaskFile, "--json"], {
      CANONICAL_CLI_TEST_KEY: secret
    });
    assert.equal(traversal.code, 2);
    assert.equal(JSON.parse(traversal.stdout).code, "cli_repository_path_invalid");
    assert.equal(providerCalls, beforeReplanCalls + 1, "unsafe paths must fail before provider calls");

    const truncatedTaskFile = path.join(root, "task-truncated.json");
    await write(truncatedTaskFile, { ...JSON.parse(await fs.readFile(taskFile, "utf8")),
      taskId: "task.cli.truncated", durable: {
        registryRoot: "./state", idempotencyKey: "task.cli.truncated.v1" } });
    coderFinishReason = "length";
    const truncated = await execute(["run", "--task", truncatedTaskFile, "--json"], {
      CANONICAL_CLI_TEST_KEY: secret
    });
    coderFinishReason = "stop";
    assert.notEqual(truncated.code, 0, truncated.stderr || truncated.stdout);
    assert.notEqual(JSON.parse(truncated.stdout).decision, "bounded_task_completed");
    assert.equal(JSON.parse(truncated.stdout).receiptHash, null);
    assert.equal(await fs.readFile(path.join(repository, "src/calculate.ts"), "utf8"), source);

    const oversizedTaskFile = path.join(root, "task-oversized.json");
    await write(oversizedTaskFile, { ...JSON.parse(await fs.readFile(taskFile, "utf8")),
      taskId: "task.cli.oversized", durable: {
        registryRoot: "./state", idempotencyKey: "task.cli.oversized.v1" } });
    oversizedCoderResponse = true;
    const oversized = await execute(["run", "--task", oversizedTaskFile, "--json"], {
      CANONICAL_CLI_TEST_KEY: secret
    });
    oversizedCoderResponse = false;
    assert.notEqual(oversized.code, 0, oversized.stderr || oversized.stdout);
    assert.notEqual(JSON.parse(oversized.stdout).decision, "bounded_task_completed");
    assert.equal(JSON.parse(oversized.stdout).receiptHash, null);
    assert.equal(await fs.readFile(path.join(repository, "src/calculate.ts"), "utf8"), source);
    assert.equal(providerCalls, beforeReplanCalls + 5,
      "truncated and oversized coder responses each stop after one planner and coder call");

    const budgetedTaskFile = path.join(root, "task-budget-without-prices.json");
    await write(budgetedTaskFile, { ...JSON.parse(await fs.readFile(taskFile, "utf8")),
      taskId: `task.cli.${secret}`,
      costBudget: { maxProviderCalls: 2, maxEstimatedTokens: 1_000_000,
        providerId: "fixture-provider", modelId: "fixture-model", reservedOutputTokens: 2048 },
      durable: { registryRoot: "./state", idempotencyKey: "task.cli.budget-without-prices.v1" } });
    const beforeBudgetCalls = providerCalls;
    const budgeted = await execute(["run", "--task", budgetedTaskFile, "--json"], {
      CANONICAL_CLI_TEST_KEY: secret
    });
    assert.equal(budgeted.code, 0, budgeted.stderr || budgeted.stdout);
    const budgetedJson = JSON.parse(budgeted.stdout);
    assert.equal(budgetedJson.decision, "bounded_task_completed");
    assert.equal(budgeted.stdout.includes(secret), false);
    assert.equal(budgetedJson.taskId, "task.cli.[REDACTED]",
      "known credential values must be redacted even inside otherwise public strings");
    assert.equal(budgetedJson.costBudget.budget.maxCostNanoUsd, null);
    assert.equal(budgetedJson.costBudget.budget.inputNanoUsdPerToken, null);
    assert.equal(budgetedJson.costBudget.budget.outputNanoUsdPerToken, null);
    assert.equal(typeof budgetedJson.costBudget.budget.maxEstimatedTokens, "number");
    assert.equal(typeof budgetedJson.costBudget.reservations[0].estimatedInputTokens, "number");
    assert.equal(typeof budgetedJson.costBudget.accountedTokens, "number");
    assert.equal(typeof budgetedJson.costBudget.remainingEstimatedTokens, "number");
    assert.equal(providerCalls, beforeBudgetCalls + 2);

    const budgetedResume = await execute(["resume", "--task", budgetedTaskFile, "--json"], {
      CANONICAL_CLI_TEST_KEY: secret
    });
    assert.equal(budgetedResume.code, 0, budgetedResume.stderr || budgetedResume.stdout);
    assert.equal(JSON.parse(budgetedResume.stdout).terminalCacheValidation.status, "current");
    assert.equal(providerCalls, beforeBudgetCalls + 2,
      "price-free budget resume must reuse the terminal result without provider calls");

    console.log("canonical CLI smoke passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
