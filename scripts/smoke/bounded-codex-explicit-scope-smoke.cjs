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
const runtimeModuleUrl = pathToFileURL(
  path.join(repoRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
).href;
const storeModuleUrl = pathToFileURL(
  path.join(repoRoot, "dist/apps/cli/src/run-artifact-store.js")
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

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createRepository(root) {
  const repository = path.join(root, "fixture-codex-p65");
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.mkdir(path.join(repository, "test"), { recursive: true });
  git(repository, ["init", "-q"]);
  await writeJson(path.join(repository, "package.json"), {
    name: "fixture-codex-p65",
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

  const init = spawnSync(process.execPath, [cliPath, "init", "--json"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, OPENAI_API_KEY: "", CODEX_API_KEY: "" }
  });
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
          reason: "The regression test anchors bounded behavior evidence."
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

function fakeAdapter(repository, options = {}) {
  const calls = [];
  return {
    agentId: "codex",
    agentVersion: "fake-codex/p6.5",
    calls,
    async run(request) {
      calls.push(request.mode);
      if (options.forbidCalls) {
        throw new Error(`resume unexpectedly called Codex adapter in mode=${request.mode}`);
      }
      assert.notEqual(path.resolve(request.workingDirectory), path.resolve(repository));
      assert.equal(request.networkAllowed, false);
      if (request.mode === "planner") {
        assert.equal(request.sandboxMode, "read_only");
        const context = JSON.parse(request.task.split("\n").at(-1));
        return {
          status: "completed",
          agentId: "codex",
          agentVersion: "fake-codex/p6.5",
          modelId: "fixture-model",
          durationMs: 5,
          finalMessage: JSON.stringify(plannerDraft(context)),
          usage: {
            inputTokens: 100,
            cachedInputTokens: 20,
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
      await fs.writeFile(path.join(request.workingDirectory, "src/session.ts"), sourceChanged, "utf8");
      return {
        status: "completed",
        agentId: "codex",
        agentVersion: "fake-codex/p6.5",
        modelId: "fixture-model",
        durationMs: 8,
        finalMessage: "Updated the bounded disposable workspace.",
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

async function childCrash() {
  const repository = process.env.P65_REPOSITORY;
  const registryRoot = process.env.P65_REGISTRY;
  assert.ok(repository);
  assert.ok(registryRoot);
  const codex = await import(codexModuleUrl);
  const adapter = fakeAdapter(repository);
  await codex.codexCommand(
    {
      task: "Fix refresh token expiry",
      allowFiles: ["src/session.ts", "test/session.test.ts"]
    },
    repository,
    {
      adapter,
      model: "fixture-model",
      validationProfile: "structural_draft",
      durableRegistryRoot: registryRoot,
      durableLeaseTimeoutMs: 50,
      checkpointObserver(checkpoint) {
        const event = checkpoint.events.at(-1);
        if (
          event?.point === "after_agent_call" &&
          event.source.providerKind === "coder" &&
          event.source.providerPhase === "completed"
        ) {
          process.exit(73);
        }
      }
    }
  );
  throw new Error("simulated crash checkpoint was not reached");
}

async function parentMain() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-codex-p65-smoke-"));
  try {
    const repository = await createRepository(root);
    const registryRoot = path.join(root, "durable-registry");
    const sourceBefore = await fs.readFile(path.join(repository, "src/session.ts"), "utf8");
    const statusBefore = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);

    const crashed = spawnSync(process.execPath, [__filename], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        P65_CHILD: "1",
        P65_REPOSITORY: repository,
        P65_REGISTRY: registryRoot,
        OPENAI_API_KEY: "",
        CODEX_API_KEY: ""
      }
    });
    assert.equal(crashed.status, 73, crashed.stderr || crashed.stdout);

    const runtime = await import(runtimeModuleUrl);
    const store = await import(storeModuleUrl);
    const checkpointFiles = await fs.readdir(path.join(registryRoot, "product-checkpoints"));
    assert.equal(checkpointFiles.length, 1);
    assert.match(checkpointFiles[0], /^codex\.[0-9a-f]{32}\.json$/);
    const productRunId = checkpointFiles[0].slice(0, -5);
    const crashedCheckpoint = store.readProductRunCheckpoint(registryRoot, productRunId);
    assert.equal(crashedCheckpoint.authority, "canonical_durable_task_state");
    assert.equal(crashedCheckpoint.latestPoint, "after_agent_call");
    const crashPoints = crashedCheckpoint.events.map((event) => event.point);
    assert.deepEqual(crashPoints, [
      "before_agent_call",
      "after_agent_call",
      "before_agent_call",
      "after_agent_call"
    ]);
    assert.equal(crashedCheckpoint.events.at(-1).source.providerKind, "coder");

    const crashedState = runtime.readDurableBoundedTaskState({
      registryRoot,
      taskId: crashedCheckpoint.taskId,
      idempotencyKey: crashedCheckpoint.idempotencyKey
    });
    assert.equal(crashedState.currentState, "coding_started");
    assert.equal(crashedState.providerIntent.providerKind, "coder");
    assert.equal(crashedState.providerIntent.status, "completed");
    assert.ok(Object.keys(crashedState.artifacts).some((name) => name.startsWith("provider-coder-")));

    const statusSummary = runtime.summarizeDurableBoundedTask({
      registryRoot,
      taskId: crashedCheckpoint.taskId,
      idempotencyKey: crashedCheckpoint.idempotencyKey
    });
    assert.equal(statusSummary.state, "coding_started");
    assert.equal(statusSummary.stopReason, "in_progress");
    assert.equal(statusSummary.protected, true);

    await new Promise((resolve) => setTimeout(resolve, 120));
    const codex = await import(codexModuleUrl);
    const resumeAdapter = fakeAdapter(repository, { forbidCalls: true });
    let resumeCalls = 0;
    const resumed = await codex.codexCommand(
      {
        task: "Fix refresh token expiry",
        allowFiles: ["src/session.ts", "test/session.test.ts"]
      },
      repository,
      {
        adapter: resumeAdapter,
        model: "fixture-model",
        validationProfile: "structural_draft",
        durableRegistryRoot: registryRoot,
        durableLeaseTimeoutMs: 50,
        resumeTask: async (input) => {
          resumeCalls += 1;
          return runtime.resumeBoundedTask(input);
        }
      }
    );

    assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.output));
    assert.equal(resumeCalls, 1, "existing Codex durable state must use canonical resumeBoundedTask semantics");
    assert.deepEqual(resumeAdapter.calls, [], "durably completed planner/coder calls must not be replayed");
    assert.equal(resumed.output.ok, true);
    assert.equal(resumed.output.apply, "NOT_RUN");
    assert.equal(resumed.output.sourceRepositoryUnchanged, true);
    assert.equal(resumed.output.durable.version, "bounded-codex-durable/v1");
    assert.equal(resumed.output.durable.recoveryAuthority, "canonical_durable_task_state");
    assert.equal(resumed.output.durable.resumed, true);
    assert.equal(resumed.output.durable.state, "finalized");
    assert.equal(resumed.output.durable.productCheckpointRunId, productRunId);

    const finalState = runtime.readDurableBoundedTaskState({
      registryRoot,
      taskId: crashedCheckpoint.taskId,
      idempotencyKey: crashedCheckpoint.idempotencyKey
    });
    assert.equal(finalState.currentState, "finalized");
    const finalCheckpoint = store.readProductRunCheckpoint(registryRoot, productRunId);
    const finalPoints = finalCheckpoint.events.map((event) => event.point);
    for (const point of [
      "before_agent_call",
      "after_agent_call",
      "after_mutation_capture",
      "after_verification",
      "after_validation"
    ]) {
      assert.equal(finalPoints.includes(point), true, `missing persist point ${point}`);
    }
    assert.equal(finalCheckpoint.latestPoint, "after_validation");
    assert.equal(finalCheckpoint.latestCanonicalStateHash, finalState.stateHash);

    const compiledCodex = await fs.readFile(
      path.join(repoRoot, "dist/apps/cli/src/commands/codex.js"),
      "utf8"
    );
    assert.match(compiledCodex, /governed_apply_prepared/);
    assert.match(compiledCodex, /before_apply/);
    assert.match(compiledCodex, /x4_committed/);
    assert.match(compiledCodex, /after_apply/);

    assert.equal(await fs.readFile(path.join(repository, "src/session.ts"), "utf8"), sourceBefore);
    assert.equal(
      git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
      statusBefore,
      "durable recovery/checkpoint metadata must stay outside the source repository"
    );

    process.stdout.write(`${JSON.stringify({
      ok: true,
      commandVersion: codex.BOUNDED_CODEX_EXPLICIT_SCOPE_VERSION,
      durableVersion: codex.BOUNDED_CODEX_DURABLE_VERSION,
      recoveryAuthority: "canonical_durable_task_state",
      simulatedCrashAfterCoderCall: true,
      statusUsesCanonicalDurableSummary: true,
      recoverUsesCanonicalResumeBoundedTask: true,
      providerCallsReplayedAfterResume: false,
      sourceRepositoryUnchanged: true,
      persistPointsObserved: finalPoints,
      applyPersistPointsMappedToCanonicalStates: true,
      realCodexCalls: false
    }, null, 2)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.env.P65_CHILD === "1") {
  childCrash().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
} else {
  parentMain().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
