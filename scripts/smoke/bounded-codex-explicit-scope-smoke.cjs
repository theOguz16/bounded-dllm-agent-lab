#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist/apps/cli/src/index.js");
const codexModuleUrl = pathToFileURL(
  path.join(repoRoot, "dist/apps/cli/src/commands/codex.js")
).href;
const outputModuleUrl = pathToFileURL(
  path.join(repoRoot, "dist/apps/cli/src/cli-output.js")
).href;
const runtimeModuleUrl = pathToFileURL(
  path.join(repoRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
).href;

const sourceOriginal = [
  'import { refreshSkew } from "./helper";',
  "export function refreshExpiry(now: number): number {",
  "  return now + refreshSkew;",
  "}",
  ""
].join("\n");
const sourceChanged = [
  'import { refreshSkew } from "./helper";',
  "export function refreshExpiry(now: number): number {",
  "  return now + refreshSkew + 1;",
  "}",
  ""
].join("\n");
const helperSource = "export const refreshSkew = 60;\n";
const testSource = [
  'import { refreshExpiry } from "../src/session";',
  "void refreshExpiry;",
  ""
].join("\n");

function runCli(cwd, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      CODEX_API_KEY: "",
      OPENAI_API_KEY: "",
      CODEX_MODEL: ""
    }
  });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createRepository(root) {
  const repository = path.join(root, "fixture-codex-v0");
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.mkdir(path.join(repository, "test"), { recursive: true });
  git(repository, ["init", "-q"]);
  await writeJson(path.join(repository, "package.json"), {
    name: "fixture-codex-v0",
    scripts: {
      test: "node --test",
      build: "tsc -p tsconfig.json",
      typecheck: "tsc -p tsconfig.json --noEmit"
    },
    devDependencies: { typescript: "^5.6.3" }
  });
  await fs.writeFile(path.join(repository, "package-lock.json"), "fixture\n", "utf8");
  await writeJson(path.join(repository, "tsconfig.json"), {
    compilerOptions: { strict: true }
  });
  await fs.writeFile(path.join(repository, "src/session.ts"), sourceOriginal, "utf8");
  await fs.writeFile(path.join(repository, "src/helper.ts"), helperSource, "utf8");
  await fs.writeFile(path.join(repository, "test/session.test.ts"), testSource, "utf8");

  const init = runCli(repository, ["init", "--json"]);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.equal(JSON.parse(init.stdout).ok, true);
  return repository;
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
      seedFiles: ["src/session.ts", "test/session.test.ts"],
      seedRationales: [
        {
          path: "src/session.ts",
          reason: "The implementation file is explicitly authorized for the requested bug fix."
        },
        {
          path: "test/session.test.ts",
          reason: "The explicit regression test file anchors bounded behavior evidence."
        }
      ],
      requiredSymbols: [],
      requiredTestFiles: ["test/session.test.ts"],
      maxExpansionAttempts: 1
    },
    minimalityPlan: {
      planVersion: "1",
      riskClass: "low",
      taskExplicitlyRequestsRefactor: false,
      plannedFiles: [
        {
          path: "src/session.ts",
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

function fakeAdapter(sourceRepository) {
  const requests = [];
  return {
    agentId: "codex",
    agentVersion: "fake-codex/v0",
    requests,
    async run(request) {
      requests.push(request);
      assert.equal(request.agentId, "codex");
      assert.equal(request.reasoningEffort, "medium");
      assert.equal(request.networkAllowed, false);
      assert.notEqual(path.resolve(request.workingDirectory), path.resolve(sourceRepository));

      if (request.mode === "planner") {
        assert.equal(request.sandboxMode, "read_only");
        const context = JSON.parse(request.task.split("\n").at(-1));
        return {
          status: "completed",
          agentId: "codex",
          agentVersion: "fake-codex/v0",
          modelId: "fixture-model-actual",
          durationMs: 5,
          finalMessage: JSON.stringify(plannerDraft(context)),
          usage: {
            inputTokens: 100,
            cachedInputTokens: 25,
            outputTokens: 40,
            totalTokens: 140,
            toolCalls: null
          },
          commands: [],
          fileChanges: [],
          diagnostics: []
        };
      }

      assert.equal(request.mode, "coder");
      assert.equal(request.sandboxMode, "workspace_write");
      assert.equal(awaitExists(path.join(request.workingDirectory, "src/session.ts")), true);
      assert.equal(awaitExists(path.join(request.workingDirectory, "test/session.test.ts")), true);
      assert.equal(
        awaitExists(path.join(request.workingDirectory, "src/helper.ts")),
        true,
        "repository-intelligence dependency must be loaded read-only into bounded context"
      );
      await fs.writeFile(path.join(request.workingDirectory, "src/session.ts"), sourceChanged, "utf8");
      return {
        status: "completed",
        agentId: "codex",
        agentVersion: "fake-codex/v0",
        modelId: "fixture-model-actual",
        durationMs: 8,
        finalMessage: "Updated refresh expiry in the disposable workspace.",
        usage: {
          inputTokens: 200,
          cachedInputTokens: 50,
          outputTokens: 60,
          totalTokens: 260,
          toolCalls: null
        },
        commands: [],
        fileChanges: [
          { sequence: 1, path: "src/session.ts", operation: "modify" }
        ],
        diagnostics: []
      };
    }
  };
}

function awaitExists(file) {
  try {
    require("node:fs").accessSync(file);
    return true;
  } catch {
    return false;
  }
}

async function renderHuman(outputModule, value) {
  let rendered = "";
  const original = process.stdout.write;
  process.stdout.write = function write(chunk) {
    rendered += String(chunk);
    return true;
  };
  try {
    outputModule.emitCliOutput(value, false, []);
  } finally {
    process.stdout.write = original;
  }
  return rendered;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-codex-v0-smoke-"));
  try {
    const repository = await createRepository(root);
    const sourceBefore = await fs.readFile(path.join(repository, "src/session.ts"), "utf8");
    const statusBefore = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);

    const codexModule = await import(codexModuleUrl);
    const outputModule = await import(outputModuleUrl);
    const runtime = await import(runtimeModuleUrl);
    const adapter = fakeAdapter(repository);
    let capturedInput = null;

    const command = await codexModule.codexCommand(
      {
        task: "Fix refresh token expiry",
        allowFiles: ["src/session.ts", "test/session.test.ts"]
      },
      repository,
      {
        adapter,
        model: "fixture-model-configured",
        validationProfile: "structural_draft",
        runTask: async (input) => {
          capturedInput = input;
          return runtime.runBoundedTask(input);
        }
      }
    );

    assert.equal(command.exitCode, 0, JSON.stringify(command.output));
    assert.equal(command.output.ok, true);
    assert.equal(command.output.command, "codex");
    assert.equal(command.output.explicitScopeVersion, "bounded-codex-explicit-scope/v0");
    assert.equal(command.output.agent, "Codex");
    assert.equal(command.output.model, "fixture-model-actual");
    assert.equal(command.output.reasoning, "medium");
    assert.equal(command.output.context.fileCount, 3);
    assert.equal(command.output.context.bytes > 0, true);
    assert.deepEqual(command.output.tokens, {
      input: 300,
      cached: 75,
      output: 100,
      reasoning: null,
      total: 400
    });
    assert.equal(command.output.candidate.changedFileCount, 1);
    assert.deepEqual(command.output.candidate.files, ["src/session.ts"]);
    assert.equal(command.output.validation.scope, "PASS");
    assert.equal(command.output.validation.typecheck, "NOT_RUN");
    assert.equal(command.output.validation.tests, "NOT_RUN");
    assert.equal(command.output.validation.behavior, "NOT_DEMONSTRATED");
    assert.equal(command.output.apply, "NOT_RUN");
    assert.equal(command.output.sourceRepositoryUnchanged, true);
    assert.equal(command.output.route, "structurally_verified_draft");

    assert.ok(capturedInput);
    assert.equal(Object.hasOwn(capturedInput, "applyExecutor"), false);
    assert.equal(Object.hasOwn(capturedInput, "governedExecution"), false);
    assert.equal(Object.hasOwn(capturedInput, "durableTask"), false);
    assert.deepEqual(capturedInput.allowedChangeFiles, ["src/session.ts", "test/session.test.ts"]);
    assert.equal(capturedInput.validationProfile, "structural_draft");
    assert.equal(adapter.requests.length, 2);
    assert.deepEqual(adapter.requests.map((request) => request.mode), ["planner", "coder"]);
    assert.deepEqual(adapter.requests.map((request) => request.reasoningEffort), ["medium", "medium"]);

    assert.equal(await fs.readFile(path.join(repository, "src/session.ts"), "utf8"), sourceBefore);
    assert.equal(
      git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
      statusBefore,
      "bounded codex must leave the real repository byte/status state unchanged"
    );

    const rendered = await renderHuman(outputModule, {
      ...command.output,
      validation: {
        scope: "PASS",
        typecheck: "PASS",
        tests: "PASS",
        behavior: "PASS"
      }
    });
    assert.match(rendered, /^Agent\nCodex\n/m);
    assert.match(rendered, /Model\nfixture-model-actual\n/);
    assert.match(rendered, /Reasoning\nmedium\n/);
    assert.match(rendered, /Context\n3 files \/ /);
    assert.match(rendered, /Tokens\ninput 300\ncached 75\noutput 100\nreasoning unavailable\ntotal 400\n/);
    assert.match(rendered, /Candidate\n1 file changed\n/);
    assert.match(rendered, /Validation\nscope PASS\ntypecheck PASS\ntests PASS\nbehavior PASS\n/);
    assert.match(rendered, /Apply\nNOT_RUN\n/);

    const missingAllow = runCli(repository, ["codex", "--task", "Fix refresh token expiry", "--json"]);
    assert.equal(missingAllow.status, 2, missingAllow.stderr || missingAllow.stdout);
    assert.equal(JSON.parse(missingAllow.stdout).code, "cli_codex_scope_missing");

    const missingTask = runCli(repository, ["codex", "--allow", "src/session.ts", "--json"]);
    assert.equal(missingTask.status, 2, missingTask.stderr || missingTask.stdout);
    assert.equal(JSON.parse(missingTask.stdout).code, "cli_codex_task_missing");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      commandVersion: "bounded-codex-explicit-scope/v0",
      existingRunBoundedTaskCoordinatorUsed: true,
      explicitMutationScope: true,
      intelligenceDependencyLoadedReadOnly: true,
      plannerAndCoderReasoning: "medium",
      actualModelReported: true,
      tokenFieldsReported: true,
      candidateDiffReported: true,
      scopeVerified: true,
      productionValidationProfile: "existing_function_bug_fix",
      smokeValidationProfile: "structural_draft",
      applyCalled: false,
      sourceRepositoryUnchanged: true,
      routerArgumentsValidated: true,
      humanOutputContractRendered: true,
      realCodexCalls: false
    }, null, 2)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
