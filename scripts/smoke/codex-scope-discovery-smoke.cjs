#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { pathToFileURL } = require("node:url");

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist/apps/cli/src/index.js");
const commandUrl = pathToFileURL(
  path.join(repoRoot, "dist/apps/cli/src/commands/codex-auto-scope.js")
).href;
const contractUrl = pathToFileURL(
  path.join(repoRoot, "dist/packages/integrations/src/scope-discovery-contract.js")
).href;
const discoveryUrl = pathToFileURL(
  path.join(repoRoot, "dist/apps/cli/src/providers/codex-scope-discovery.js")
).href;
const runtimeUrl = pathToFileURL(
  path.join(repoRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
).href;
const adapterUrl = pathToFileURL(
  path.join(repoRoot, "dist/packages/integrations/src/codex-agent-adapter.js")
).href;
const outputUrl = pathToFileURL(
  path.join(repoRoot, "dist/apps/cli/src/cli-output.js")
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
      const inventory = JSON.parse(request.task.slice(request.task.indexOf("{"))).canonicalRepository;
      assert.equal(inventory.files.length, 3);
      assert.deepEqual(Object.keys(inventory.files[0]).sort(), ["path", "symbols"]);
      assert.equal(request.task.includes(sourceOriginal), false);
      assert.equal(request.task.includes(helperSource), false);
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

function fakeInvalidJsonDiscoveryAdapter(sourceRepository) {
  const base = fakeDiscoveryAdapter(sourceRepository);
  return {
    ...base,
    async run(request) {
      const result = await base.run(request);
      return {
        ...result,
        finalMessage: "not-json"
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
    const discoveryModule = await import(discoveryUrl);
    assert.equal(discoveryModule.CODEX_SCOPE_DISCOVERY_VERSION, "codex-scope-discovery/v2");
    const runtime = await import(runtimeUrl);
    const { CodexAgentAdapter } = await import(adapterUrl);
    const { emitCliError } = await import(outputUrl);
    const original = await fs.readFile(path.join(repository, "src/session.ts"), "utf8");
    const statusBefore = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);

    const parsed = contract.parseScopeDiscoveryProposal(discoveryProposal());
    assert.deepEqual(parsed.candidateSourceFiles, ["src/session.ts"]);
    const fact = (filePath, symbols = []) => ({
      path: filePath,
      language: "typescript",
      bytes: 100,
      contentHash: "offline-fixture",
      imports: [],
      externalDependencies: [],
      exports: symbols,
      symbols: symbols.map((name) => ({ name, kind: "function", exported: true }))
    });
    const fixtureFacts = [
      fact("packages/alpha/src/request.ts", ["resolveConflict"]),
      fact("packages/beta/src/request.ts", ["resolveConflict"]),
      fact("packages/core/src/workspace.ts"),
      fact("tests/smoke/request.ts"),
      fact("scripts/unrelated.ts", ["unrelated"])
    ];
    const fixtureEdges = [
      { from: "packages/alpha/src/request.ts", to: "packages/core/src/workspace.ts", kind: "import", specifier: "core" },
      { from: "tests/smoke/request.ts", to: "packages/alpha/src/request.ts", kind: "import", specifier: "alpha" }
    ];
    const selected = discoveryModule.prefilterCodexDiscoveryFacts(
      "Ensure resolveConflict rejects a crossed response", fixtureFacts, fixtureEdges
    ).map((entry) => entry.path);
    assert.equal(selected.includes("packages/alpha/src/request.ts"), true);
    assert.equal(selected.includes("packages/beta/src/request.ts"), true);
    assert.equal(selected.includes("packages/core/src/workspace.ts"), true);
    assert.equal(selected.includes("tests/smoke/request.ts"), false);
    assert.equal(selected.includes("scripts/unrelated.ts"), false);
    assert.throws(
      () => discoveryModule.prefilterCodexDiscoveryFacts("Fix the bug", fixtureFacts, fixtureEdges),
      (error) => error.failureCode === "codex_scope_discovery_no_trusted_candidates"
    );
    const direct = discoveryModule.prefilterCodexDiscoveryFacts(
      "Correct resolveConflict behavior", fixtureFacts, []
    ).map((entry) => entry.path);
    assert.deepEqual(direct, ["packages/alpha/src/request.ts", "packages/beta/src/request.ts"]);
    const broadNeighbors = Array.from({ length: 70 }, (_, index) =>
      fact(`packages/core/src/dependent-${index}.ts`));
    const broadEdges = broadNeighbors.map((entry) => ({ from: entry.path, to: fixtureFacts[0].path,
      kind: "import", specifier: "alpha" }));
    assert.deepEqual(discoveryModule.prefilterCodexDiscoveryFacts(
      "Correct resolveConflict", [fixtureFacts[0], ...broadNeighbors], broadEdges
    ).map((entry) => entry.path), [fixtureFacts[0].path]);
    const relevantImporters = Array.from({ length: 70 }, (_, index) =>
      fact(`tests/relevant-${String(index).padStart(2, "0")}.ts`, ["resolveConflict"]));
    const relevantEdges = relevantImporters.map((entry) => ({ from: entry.path,
      to: "src/worker.ts", kind: "import", specifier: "../src/worker.js" }));
    const worker = fact("src/worker.ts", ["resolveConflict"]);
    const relevantTask = "Fix src/worker.ts resolveConflict";
    assert.throws(
      () => discoveryModule.prefilterCodexDiscoveryFacts(relevantTask,
        [worker, ...relevantImporters], relevantEdges),
      (error) => error.failureCode === "codex_scope_discovery_candidates_ambiguous"
    );
    const boundaryFacts = [worker, ...relevantImporters.slice(0, 63)];
    const boundaryEdges = relevantEdges.slice(0, 63);
    const atBoundary = discoveryModule.prefilterCodexDiscoveryFacts(
      relevantTask, boundaryFacts, boundaryEdges
    ).map((entry) => entry.path);
    assert.equal(atBoundary.length, 64);
    assert.throws(
      () => discoveryModule.prefilterCodexDiscoveryFacts(relevantTask,
        [worker, ...relevantImporters.slice(0, 64)], relevantEdges.slice(0, 64)),
      (error) => error.failureCode === "codex_scope_discovery_candidates_ambiguous"
    );
    assert.deepEqual(discoveryModule.prefilterCodexDiscoveryFacts(relevantTask,
      [...boundaryFacts].reverse(), [...boundaryEdges].reverse()).map((entry) => entry.path), atBoundary);
    const independent = discoveryModule.prefilterCodexDiscoveryFacts(
      "Fix src/worker.ts refine and add a focused regression test",
      [fact("src/worker.ts", ["refine"]), fact("tests/worker.test.ts", ["refine"])], []
    ).map((entry) => entry.path);
    assert.deepEqual(independent, ["src/worker.ts", "tests/worker.test.ts"]);
    const requestFacts = [
      fact("packages/worker-contract/src/index.ts", ["assertInfillResponse", "assertResolveConflictResponse"]),
      fact("packages/providers/src/index.ts", ["createWorkerRequestId"]),
      fact("packages/workspace-core/src/index.ts"),
      fact("tests/smoke/contracts.ts", ["resolveConflict"]),
      fact("scripts/controlled-coding-pilot-request-id-check.cjs", ["checkRequestIdAcceptance"])
    ];
    const requestEdges = [
      { from: "packages/providers/src/index.ts", to: "packages/worker-contract/src/index.ts", kind: "import", specifier: "worker-contract" },
      { from: "packages/worker-contract/src/index.ts", to: "packages/workspace-core/src/index.ts", kind: "import", specifier: "workspace-core" },
      { from: "tests/smoke/contracts.ts", to: "packages/worker-contract/src/index.ts", kind: "import", specifier: "worker-contract" }
    ];
    const requestCandidates = discoveryModule.prefilterCodexDiscoveryFacts(
      "Ensure refine, infill, and resolveConflict reject crossed worker responses with mismatched requestId while health continues to work",
      requestFacts, requestEdges
    ).map((entry) => entry.path);
    for (const required of ["packages/worker-contract/src/index.ts", "packages/providers/src/index.ts",
      "packages/workspace-core/src/index.ts", "tests/smoke/contracts.ts"]) {
      assert.equal(requestCandidates.includes(required), true, required);
    }
    const pilotTask = JSON.parse(await fs.readFile(path.join(repoRoot,
      "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json"), "utf8")).taskPrompt;
    const pilotSnapshot = runtime.createCanonicalRepositoryContentSnapshot(repoRoot);
    const offlineStop = new Error("OFFLINE_STOP");
    let pilotRequest = null;
    await assert.rejects(() => discoveryModule.discoverCodexScope({
      repositoryPath: repoRoot,
      sourceSnapshotHash: pilotSnapshot.snapshotHash,
      task: pilotTask,
      model: "offline-fixture",
      adapter: {
        agentId: "offline-fixture",
        agentVersion: "offline-fixture/v1",
        async run(request) { pilotRequest = request; throw offlineStop; }
      }
    }), (error) => error === offlineStop);
    assert.ok(pilotRequest);
    const pilotPrompt = pilotRequest.task;
    const pilotEvidence = JSON.parse(pilotPrompt.split("\n").at(-1));
    const pilotCandidates = pilotEvidence.canonicalRepository.files.map((entry) => entry.path);
    assert.equal(pilotEvidence.discoveryVersion, "codex-scope-discovery/v2");
    assert.equal(pilotCandidates.length <= 64, true);
    const trackedJsTsCount = git(repoRoot, ["ls-files", "-z", "--cached"])
      .split("\u0000").filter((entry) => /\.(?:[cm]?[jt]sx?)$/i.test(entry)).length;
    assert.equal(pilotCandidates.length < trackedJsTsCount, true, "no full inventory fallback");
    assert.equal(Buffer.byteLength(pilotPrompt, "utf8") <= 128 * 1024, true);
    for (const required of ["packages/worker-contract/src/index.ts", "packages/providers/src/index.ts",
      "packages/workspace-core/src/index.ts", "tests/smoke/contracts.ts"]) {
      assert.equal(pilotCandidates.includes(required), true, required);
    }
    await assert.rejects(
      async () => contract.parseScopeDiscoveryProposal({ ...discoveryProposal(), unexpected: true }),
      /exact contract fields/
    );

    const invalidJsonDiscovery = fakeInvalidJsonDiscoveryAdapter(repository);
    const repositorySnapshot =
      runtime.createCanonicalRepositoryContentSnapshot(repository);
    const noCandidateAdapter = fakeDiscoveryAdapter(repository);
    await assert.rejects(
      () => discoveryModule.discoverCodexScope({
        repositoryPath: repository,
        sourceSnapshotHash: repositorySnapshot.snapshotHash,
        task: "Fix the bug",
        model: "fixture-discovery-model-configured",
        adapter: noCandidateAdapter
      }),
      (error) => error.failureCode === "codex_scope_discovery_no_trusted_candidates"
    );
    assert.equal(noCandidateAdapter.requests.length, 0);

    await assert.rejects(
      () => discoveryModule.discoverCodexScope({
        repositoryPath: repository,
        sourceSnapshotHash: repositorySnapshot.snapshotHash,
        task: "Fix refresh token expiry in src/session.ts and scripts/session-smoke.cjs",
        model: "fixture-discovery-model-configured",
        adapter: invalidJsonDiscovery,
        reasoningEffort: "medium",
        timeoutMs: 10_000
      }),
      (error) => {
        assert.equal(
          error instanceof discoveryModule.CodexScopeDiscoveryError,
          true
        );
        assert.equal(
          error.failureCode,
          "codex_scope_discovery_invalid_json"
        );
        assert.equal(
          error.message,
          "Codex scope discovery returned invalid JSON."
        );
        assert.ok(error.observation);
        assert.equal(
          error.observation.modelId,
          "fixture-discovery-model-actual"
        );
        assert.deepEqual(error.observation.usage, {
          inputTokens: 90,
          cachedInputTokens: 20,
          outputTokens: 30,
          totalTokens: 120,
          toolCalls: null
        });
        assert.equal(error.observation.visibleFileCount > 0, true);
        assert.equal(error.observation.visibleBytes > 0, true);
        return true;
      }
    );
    assert.equal(invalidJsonDiscovery.requests.length, 1);

    // Exercise the real adapter, journal, discovery command, and CLI error
    // renderer with disposable workers. None of these workers imports Codex.
    const canary = "SECRET_CANARY_ABC123";
    const failures = [
      { name: "auth", error: { status: 401, code: "authentication_failed", message: `Unauthorized ${canary}` }, expected: "auth", state: "failed" },
      { name: "quota", error: { status: 429, code: "rate_limit_exceeded", message: `Rate limit exceeded ${canary}` }, expected: "quota", state: "failed" },
      { name: "model", error: { status: 400, code: "model_not_found", message: `Model not found ${canary}` }, expected: "model_unsupported", state: "outcome_unknown" },
      { name: "context", error: { status: 413, code: "context_length_exceeded", message: `Input too large ${canary}` }, expected: "context_input_too_large", state: "outcome_unknown" },
      { name: "overload", error: { status: 503, code: "server_overloaded", message: `Server overloaded ${canary}` }, expected: "capacity_overload", state: "outcome_unknown" },
      { name: "timeout", expected: "timeout", state: "outcome_unknown" },
      { name: "crash", expected: "worker_process_failure", state: "outcome_unknown" },
      { name: "partial", expected: "partial_stream", state: "outcome_unknown" },
      { name: "unknown", error: { status: 400, code: "mystery", message: `Unclassified failure ${canary}` }, expected: "unknown", state: "outcome_unknown" }
    ];
    for (const failure of failures) {
      const workerPath = path.join(root, `fake-worker-${failure.name}.cjs`);
      const body = failure.name === "timeout" ? "setInterval(() => {}, 1000);" :
        failure.name === "partial" ?
          'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"fixture"})+"\\n");process.stdout.write(JSON.stringify({type:"turn.started"})+"\\n");' :
          failure.name === "crash" ? "process.exitCode=2;" :
            `process.stderr.write(${JSON.stringify(`warning before error\n${JSON.stringify(failure.error)}\n`)});process.exitCode=2;`;
      await fs.writeFile(workerPath, `process.stdin.on("data",()=>{});process.stdin.on("end",()=>{${body}});\n`, "utf8");
      const journalPath = path.join(root, `journal-${failure.name}.sqlite`);
      const adapter = new CodexAgentAdapter({
        workerEntrypoint: workerPath,
        invocationJournalPath: journalPath,
        authCheck: async () => true,
        workerGraceMs: 50,
        workerForceGraceMs: 50
      });
      const discoveryAdapter = failure.name === "timeout" ? {
        agentId: "codex",
        agentVersion: "offline-timeout-fixture/v1",
        run: (request) => adapter.run({ ...request, timeoutMs: 250 })
      } : adapter;
      let cliError;
      await assert.rejects(
        () => commandModule.codexAutoScopeCommand(
          { task: `Fix refresh token expiry in src/session.ts and scripts/session-smoke.cjs ${failure.name}`, nonInteractive: true },
          repository,
          { discoveryAdapter, discoveryModel: "fixture-offline-model" }
        ),
        (error) => {
          cliError = error;
          return error.code === "cli_codex_scope_discovery_failed";
        }
      );
      assert.equal(cliError.exitCode, 3);
      assert.equal(cliError.details.stage, "discovery");
      assert.equal(cliError.details.providerFailureClass, failure.expected);
      assert.equal(cliError.details.providerHttpStatus, failure.error?.status ?? null);
      assert.equal(cliError.details.invocationOccurred, null);
      assert.equal(cliError.details.outcomeKnown, failure.state === "outcome_unknown" ? false : true);
      assert.equal(cliError.details.terminalTurnObserved, false);
      assert.equal(cliError.details.workerOutcome, failure.name === "timeout" ? "signaled" :
        failure.name === "partial" ? "exited_zero" : "exited_nonzero");
      assert.equal(cliError.message.includes(canary), false);
      const db = new DatabaseSync(journalPath, { readOnly: true });
      const row = db.prepare("SELECT record_json FROM provider_invocations WHERE stage = 'discovery'").get();
      db.close();
      const journal = JSON.parse(row.record_json);
      assert.equal(journal.state, failure.state);
      assert.equal(journal.providerFailureClass, cliError.details.providerFailureClass);
      assert.equal(journal.workerOutcome, cliError.details.workerOutcome);
      assert.equal(journal.terminalTurnObserved, cliError.details.terminalTurnObserved);
      assert.equal(journal.invocationOccurred, cliError.details.invocationOccurred);
      assert.equal(JSON.stringify(journal).includes(canary), false);
      let rendered = "";
      const originalWrite = process.stdout.write;
      process.stdout.write = (chunk) => { rendered += String(chunk); return true; };
      try {
        emitCliError({ ok: false, code: cliError.code, message: cliError.message, ...cliError.details }, true, []);
      } finally {
        process.stdout.write = originalWrite;
      }
      const json = JSON.parse(rendered);
      assert.equal(json.providerFailureClass, journal.providerFailureClass);
      assert.equal(json.stage, "discovery");
      assert.equal(json.ok, false);
      assert.equal(rendered.includes(canary), false);
      let human = "";
      const originalErrorWrite = process.stderr.write;
      process.stderr.write = (chunk) => { human += String(chunk); return true; };
      try {
        emitCliError({ ok: false, code: cliError.code, message: cliError.message, ...cliError.details }, false, []);
      } finally {
        process.stderr.write = originalErrorWrite;
      }
      assert.equal(human.includes(canary), false);
      assert.equal(human.includes("cli_codex_scope_discovery_failed"), true);
      if (failure.expected === "unknown") assert.equal(cliError.message.includes("Provider failure:"), false);
      else assert.equal(cliError.message.includes(`Provider failure: ${failure.expected}.`), true);
    }

    const nonInteractiveDiscovery = fakeDiscoveryAdapter(repository);
    const nonInteractive = await commandModule.codexAutoScopeCommand(
      { task: "Fix refresh token expiry in src/session.ts and scripts/session-smoke.cjs", nonInteractive: true },
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
      { task: "Fix refresh token expiry in src/session.ts and scripts/session-smoke.cjs" },
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
      { task: "Fix refresh token expiry in src/session.ts and scripts/session-smoke.cjs" },
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
    const positional = runCli(repository, ["codex", "Fix refresh token expiry in src/session.ts and scripts/session-smoke.cjs", "--json"], {
      CODEX_HOME: emptyCodexHome
    });
    assert.equal(positional.status, 5, positional.stderr || positional.stdout);
    assert.equal(JSON.parse(positional.stdout).code, "cli_codex_model_missing");

    const explicitMissingScope = runCli(repository, ["codex", "--task", "Fix refresh token expiry in src/session.ts and scripts/session-smoke.cjs", "--json"]);
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
      invalidJsonFailureCodePreserved: true,
      discoveryFailureTelemetryPreserved: true,
      providerFailureInjectionCases: failures.map((failure) => failure.name),
      journalCliFailureConsistent: true,
      providerSecretsExcluded: true,
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
