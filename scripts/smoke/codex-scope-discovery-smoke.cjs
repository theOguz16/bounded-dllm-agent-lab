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
const commandUrl = pathToFileURL(
  path.join(repoRoot, "dist/apps/cli/src/commands/codex-auto-scope.js")
).href;
const contractUrl = pathToFileURL(
  path.join(repoRoot, "dist/packages/integrations/src/scope-discovery-contract.js")
).href;

const sourceOriginal = [
  'import { refreshSkew } from "./helper";',
  "export function refreshExpiry(now) {",
  "  return now + refreshSkew;",
  "}",
  ""
].join("\n");
const sourceChanged = [
  'import { refreshSkew } from "./helper";',
  "export function refreshExpiry(now) {",
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
const hiddenOracle = "export const HIDDEN_ORACLE_MARKER = 'EXPECTED_CHANGED_FILES';\n";
const groundTruth = "export const GROUND_TRUTH_PATCH_MARKER = 'secret patch';\n";

function runCli(cwd, args, environment = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      CI: "",
      CODEX_API_KEY: "",
      OPENAI_API_KEY: "",
      CODEX_MODEL: "",
      ...environment
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
  const repository = path.join(root, "fixture-scope-discovery");
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.mkdir(path.join(repository, "scripts"), { recursive: true });
  await fs.mkdir(path.join(repository, "benchmarks", "gate6", "oracles"), { recursive: true });
  await fs.mkdir(path.join(repository, "benchmarks"), { recursive: true });
  git(repository, ["init", "-q"]);
  await writeJson(path.join(repository, "package.json"), {
    name: "fixture-scope-discovery",
    scripts: {
      test: "node --test",
      build: "node -e \"process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\""
    }
  });
  await fs.writeFile(path.join(repository, "package-lock.json"), "fixture\n", "utf8");
  await fs.writeFile(path.join(repository, "src", "session.ts"), sourceOriginal, "utf8");
  await fs.writeFile(path.join(repository, "src", "helper.ts"), helperSource, "utf8");
  await fs.writeFile(path.join(repository, "scripts", "session-smoke.cjs"), testSource, "utf8");
  await fs.writeFile(
    path.join(repository, "benchmarks", "gate6", "oracles", "hidden-oracle.ts"),
    hiddenOracle,
    "utf8"
  );
  await fs.writeFile(path.join(repository, "benchmarks", "ground-truth-patch.ts"), groundTruth, "utf8");
  git(repository, ["add", "package.json", "package-lock.json", "src", "scripts", "benchmarks"]);
  const init = runCli(repository, ["init", "--json"]);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  return repository;
}

function discoveryProposal() {
  return {
    schemaVersion: "scope-discovery/v1",
    candidateSourceFiles: ["src/session.ts"],
    candidateTestFiles: ["scripts/session-smoke.cjs"],
    candidateSymbols: ["refreshExpiry"],
    reason: "The refresh expiry implementation and its focused regression test are the smallest plausible mutable scope."
  };
}

function fakeDiscoveryAdapter(sourceRepository) {
  const requests = [];
  return {
    agentId: "codex",
    agentVersion: "fake-discovery/v1",
    requests,
    async run(request) {
      requests.push(request);
      assert.equal(request.mode, "discovery");
      assert.equal(request.sandboxMode, "read_only");
      assert.equal(request.networkAllowed, false);
      assert.equal(request.reasoningEffort, "medium");
      assert.notEqual(path.resolve(request.workingDirectory), path.resolve(sourceRepository));
      assert.equal(require("node:fs").existsSync(path.join(request.workingDirectory, "src/session.ts")), true);
      assert.equal(require("node:fs").existsSync(path.join(request.workingDirectory, "src/helper.ts")), true);
      assert.equal(require("node:fs").existsSync(path.join(request.workingDirectory, "scripts/session-smoke.cjs")), true);
      assert.equal(
        require("node:fs").existsSync(
          path.join(request.workingDirectory, "benchmarks/gate6/oracles/hidden-oracle.ts")
        ),
        false
      );
      assert.equal(
        require("node:fs").existsSync(path.join(request.workingDirectory, "benchmarks/ground-truth-patch.ts")),
        false
      );
      assert.equal(request.task.includes("HIDDEN_ORACLE_MARKER"), false);
      assert.equal(request.task.includes("EXPECTED_CHANGED_FILES"), false);
      assert.equal(request.task.includes("GROUND_TRUTH_PATCH_MARKER"), false);
      assert.equal(request.task.includes("hidden-oracle.ts"), false);
      assert.equal(request.task.includes("ground-truth-patch.ts"), false);
      assert.ok(request.outputSchema);
      return {
        status: "completed",
        agentId: "codex",
        agentVersion: "fake-discovery/v1",
        modelId: "fixture-discovery-model-actual",
        durationMs: 4,
        finalMessage: JSON.stringify(discoveryProposal()),
        usage: {
          inputTokens: 90,
          cachedInputTokens: 20,
          outputTokens: 30,
          totalTokens: 120,
          toolCalls: null
        },
        commands: [],
        fileChanges: [],
        diagnostics: []
      };
    }
  };
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
      seedFiles: ["src/session.ts", "scripts/session-smoke.cjs"],
      seedRationales: [
        { path: "src/session.ts", reason: "Approved implementation scope." },
        { path: "scripts/session-smoke.cjs", reason: "Approved regression-test scope." }
      ],
      requiredSymbols: [],
      requiredTestFiles: ["scripts/session-smoke.cjs"],
      maxExpansionAttempts: 1
    },
    minimalityPlan: {
      planVersion: "1",
      riskClass: "low",
      taskExplicitlyRequestsRefactor: false,
      plannedFiles: [
        { path: "src/session.ts", changeKind: "bugfix", requested: true, justification: null }
      ],
      newDependencies: [],
      newAbstractions: []
    }
  };
}

function fakeExplicitAdapter(sourceRepository) {
  const requests = [];
  return {
    agentId: "codex",
    agentVersion: "fake-explicit/v1",
    requests,
    async run(request) {
      requests.push(request);
      assert.notEqual(path.resolve(request.workingDirectory), path.resolve(sourceRepository));
      if (request.mode === "planner") {
        const context = JSON.parse(request.task.split("\n").at(-1));
        return {
          status: "completed",
          agentId: "codex",
          agentVersion: "fake-explicit/v1",
          modelId: "fixture-explicit-model-actual",
          durationMs: 4,
          finalMessage: JSON.stringify(plannerDraft(context)),
          usage: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 40, totalTokens: 140, toolCalls: null },
          commands: [],
          fileChanges: [],
          diagnostics: []
        };
      }
      assert.equal(request.mode, "coder");
      await fs.writeFile(path.join(request.workingDirectory, "src/session.ts"), sourceChanged, "utf8");
      return {
        status: "completed",
        agentId: "codex",
        agentVersion: "fake-explicit/v1",
        modelId: "fixture-explicit-model-actual",
        durationMs: 5,
        finalMessage: "Changed only the approved disposable-workspace source file.",
        usage: { inputTokens: 150, cachedInputTokens: 20, outputTokens: 50, totalTokens: 200, toolCalls: null },
        commands: [],
        fileChanges: [{ sequence: 1, path: "src/session.ts", operation: "modify" }],
        diagnostics: []
      };
    }
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-scope-discovery-smoke-"));
  const originalCi = process.env.CI;
  process.env.CI = "";
  try {
    const repository = await createRepository(root);
    const commandModule = await import(commandUrl);
    const contract = await import(contractUrl);
    const original = await fs.readFile(path.join(repository, "src/session.ts"), "utf8");
    const statusBefore = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);

    const parsed = contract.parseScopeDiscoveryProposal(discoveryProposal());
    assert.deepEqual(parsed.candidateSourceFiles, ["src/session.ts"]);
    await assert.rejects(
      async () => contract.parseScopeDiscoveryProposal({ ...discoveryProposal(), unexpected: true }),
      /exact contract fields/
    );

    const nonInteractiveDiscovery = fakeDiscoveryAdapter(repository);
    const nonInteractive = await commandModule.codexAutoScopeCommand(
      { task: "Fix refresh token expiry", nonInteractive: true },
      repository,
      {
        discoveryAdapter: nonInteractiveDiscovery,
        discoveryModel: "fixture-discovery-model-configured",
        approveScope: async () => {
          throw new Error("approval callback must not run in non-interactive mode");
        }
      }
    );
    assert.equal(nonInteractive.exitCode, 3);
    assert.equal(nonInteractive.output.phase, "scope_discovery");
    assert.equal(nonInteractive.output.decision, "approval_required");
    assert.equal(nonInteractive.output.approvalRequired, true);
    assert.equal(nonInteractive.output.mutationStarted, false);
    assert.deepEqual(nonInteractive.output.suggestedMutableScope, ["src/session.ts", "scripts/session-smoke.cjs"]);
    assert.equal(nonInteractiveDiscovery.requests.length, 1);

    const declinedDiscovery = fakeDiscoveryAdapter(repository);
    let declinedApprovalCalls = 0;
    const declined = await commandModule.codexAutoScopeCommand(
      { task: "Fix refresh token expiry" },
      repository,
      {
        discoveryAdapter: declinedDiscovery,
        discoveryModel: "fixture-discovery-model-configured",
        approveScope: async (proposal) => {
          declinedApprovalCalls += 1;
          assert.deepEqual(proposal.candidateSymbols, ["refreshExpiry"]);
          return false;
        }
      }
    );
    assert.equal(declined.exitCode, 0);
    assert.equal(declined.output.decision, "approval_declined");
    assert.equal(declined.output.mutationStarted, false);
    assert.equal(declinedApprovalCalls, 1);

    const approvedDiscovery = fakeDiscoveryAdapter(repository);
    const explicitAdapter = fakeExplicitAdapter(repository);
    let approvedCalls = 0;
    const approved = await commandModule.codexAutoScopeCommand(
      { task: "Fix refresh token expiry" },
      repository,
      {
        discoveryAdapter: approvedDiscovery,
        discoveryModel: "fixture-discovery-model-configured",
        approveScope: async () => {
          approvedCalls += 1;
          return true;
        },
        explicit: {
          adapter: explicitAdapter,
          model: "fixture-explicit-model-configured",
          validationProfile: "structural_draft"
        }
      }
    );
    assert.equal(approvedCalls, 1);
    assert.equal(approved.exitCode, 0, JSON.stringify(approved.output));
    assert.equal(approved.output.command, "codex");
    assert.equal(approved.output.validation.scope, "PASS");
    assert.equal(approvedDiscovery.requests.length, 1);
    assert.deepEqual(explicitAdapter.requests.map((request) => request.mode), ["planner", "coder"]);

    assert.equal(await fs.readFile(path.join(repository, "src/session.ts"), "utf8"), original);
    assert.equal(
      git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
      statusBefore,
      "discovery and approved bounded execution must leave the source repository unchanged"
    );

    const emptyCodexHome = path.join(root, "empty-codex-home");
    await fs.mkdir(emptyCodexHome);
    const positional = runCli(repository, ["codex", "Fix refresh token expiry", "--json"], {
      CODEX_HOME: emptyCodexHome
    });
    assert.equal(positional.status, 5, positional.stderr || positional.stdout);
    assert.equal(JSON.parse(positional.stdout).code, "cli_codex_model_missing");

    const explicitMissingScope = runCli(repository, ["codex", "--task", "Fix refresh token expiry", "--json"]);
    assert.equal(explicitMissingScope.status, 2, explicitMissingScope.stderr || explicitMissingScope.stdout);
    assert.equal(JSON.parse(explicitMissingScope.stdout).code, "cli_codex_scope_missing");

    const commandSource = await fs.readFile(
      path.join(repoRoot, "apps", "cli", "src", "commands", "codex-auto-scope.ts"),
      "utf8"
    );
    assert.match(commandSource, /Suggested mutable scope:/);
    assert.match(commandSource, /\[x\] \$\{file\}/);
    assert.match(commandSource, /Approve\? Y\/n/);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      contractVersion: "scope-discovery/v1",
      canonicalRepositoryIntelligenceFirst: true,
      codexDiscoveryReadOnly: true,
      discoveryNetworkDisabled: true,
      hiddenBenchmarkOracleExposed: false,
      groundTruthPatchExposed: false,
      expectedChangedFilesExposed: false,
      candidateFilesGrounded: true,
      candidateSymbolsGrounded: true,
      developerConfirmationRequired: true,
      nonInteractiveMutationStarted: false,
      declinedMutationStarted: false,
      approvedScopeFeedsExistingExplicitExecutor: true,
      sourceRepositoryUnchanged: true,
      positionalCodexTaskAccepted: true,
      explicitScopeCompatibilityPreserved: true,
      realCodexCalls: false
    }, null, 2)}\n`);
  } finally {
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
