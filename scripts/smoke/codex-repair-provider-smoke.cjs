#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");
const providerModulePath = path.resolve(
  repoRoot,
  "dist/apps/cli/src/providers/codex-repair-provider.js"
);
const runtimeModulePath = path.resolve(
  repoRoot,
  "dist/packages/product-runtime/src/canonical-runtime.js"
);

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const sourceSession = [
  "export function refreshExpiry(now: number): number {",
  "  return now + 60_000;",
  "}",
  ""
].join("\n");
const candidateSession = [
  "export function refreshExpiry(now: number): number {",
  "  return now + 3_600_000;",
  "}",
  ""
].join("\n");
const repairedSession = [
  "export function refreshExpiry(now: number): number {",
  "  return now + 7_200_000;",
  "}",
  ""
].join("\n");
const sourceTest = "assert.equal(refreshExpiry(0), 60_000);\n";
const candidateTest = "assert.equal(refreshExpiry(0), 7_200_000);\n";

function originalCandidate(runtime) {
  return runtime.createWorkspaceMutation({
    role: "coder",
    target: "patchDraft",
    summary: "Initial candidate updates refresh expiry and its regression assertion.",
    claims: [
      {
        claimVersion: "text-file-update/v1",
        type: "patch_draft",
        operation: "update",
        file: "src/auth/session.ts",
        expectedContentHash: hash(sourceSession),
        newContent: candidateSession,
        description: "Update refresh-token expiry behavior."
      },
      {
        claimVersion: "text-file-update/v1",
        type: "patch_draft",
        operation: "update",
        file: "test/auth/session.test.ts",
        expectedContentHash: hash(sourceTest),
        newContent: candidateTest,
        description: "Accepted regression assertion for the intended expiry."
      }
    ],
    touchedFiles: ["src/auth/session.ts", "test/auth/session.test.ts"]
  });
}

function boundary(runtime, candidate) {
  return {
    originalCandidateHash: runtime.hashCanonicalJson(candidate),
    originalCandidateFiles: ["src/auth/session.ts", "test/auth/session.test.ts"],
    policyFiles: [".bounded/policy.yml"],
    acceptanceCriteriaFiles: []
  };
}

function request(runtime, candidate, overrides = {}) {
  return {
    schemaVersion: "targeted-repair-request/v1",
    originalCandidateHash: runtime.hashCanonicalJson(candidate),
    failingFiles: ["src/auth/session.ts"],
    failingChecks: ["refresh_token_expiry assertion failed"],
    verifierIssues: [{
      code: "REFRESH_EXPIRY_MISMATCH",
      message: "Refresh token expiry does not match the accepted assertion.",
      file: "src/auth/session.ts"
    }],
    allowedFiles: ["src/auth/session.ts"],
    preserveFiles: ["test/auth/session.test.ts"],
    repairRound: 1,
    ...overrides
  };
}

function criterion() {
  return {
    id: "refresh_token_expiry",
    description: "Refresh-token expiry must satisfy the regression assertion.",
    required: true,
    evidence: { kind: "test", commandId: "test.auth" }
  };
}

function completedResult(request, fileChanges = []) {
  return {
    status: "completed",
    agentId: "codex",
    agentVersion: "fake-codex/v1",
    modelId: request.model,
    durationMs: 8,
    finalMessage: "Targeted repair completed.",
    usage: {
      inputTokens: 80,
      cachedInputTokens: 20,
      outputTokens: 12,
      totalTokens: 92,
      toolCalls: 1
    },
    commands: [],
    fileChanges,
    diagnostics: []
  };
}

function successfulAdapter() {
  const requests = [];
  return {
    agentId: "codex",
    agentVersion: "fake-codex/v1",
    requests,
    async run(runRequest) {
      requests.push(runRequest);
      assert.equal(runRequest.mode, "repair");
      assert.equal(runRequest.networkAllowed, false);
      assert.equal(runRequest.sandboxMode, "workspace_write");
      assert.equal(runRequest.reasoningEffort, "medium");
      assert.equal(fs.existsSync(path.join(runRequest.workingDirectory, ".git")), true);
      assert.equal(fs.existsSync(path.join(runRequest.workingDirectory, "src/auth/session.ts")), true);
      assert.equal(fs.existsSync(path.join(runRequest.workingDirectory, "test/auth/session.test.ts")), true);
      assert.equal(fs.existsSync(path.join(runRequest.workingDirectory, "package.json")), false);
      assert.equal(
        fs.readFileSync(path.join(runRequest.workingDirectory, "src/auth/session.ts"), "utf8"),
        candidateSession
      );
      assert.equal(
        fs.readFileSync(path.join(runRequest.workingDirectory, "test/auth/session.test.ts"), "utf8"),
        candidateTest
      );
      assert.match(runRequest.task, /refresh_token_expiry assertion failed/);
      assert.match(runRequest.task, /Refresh-token expiry must satisfy the regression assertion/);
      assert.match(runRequest.task, /Accepted regression assertion/);
      fs.writeFileSync(path.join(runRequest.workingDirectory, "src/auth/session.ts"), repairedSession);
      assert.equal(
        fs.readFileSync(path.join(runRequest.workingDirectory, "test/auth/session.test.ts"), "utf8"),
        candidateTest
      );
      return completedResult(runRequest, [
        { sequence: 1, path: "src/auth/session.ts", operation: "modify" }
      ]);
    }
  };
}

function noChangeAdapter() {
  const requests = [];
  return {
    agentId: "codex",
    agentVersion: "fake-codex/v1",
    requests,
    async run(runRequest) {
      requests.push(runRequest);
      return completedResult(runRequest);
    }
  };
}

async function main() {
  const providerModule = await import(pathToFileURL(providerModulePath).href);
  const runtime = await import(pathToFileURL(runtimeModulePath).href);
  assert.equal(providerModule.MAX_REPAIR_ROUNDS, 1);
  assert.equal(typeof providerModule.createCodexRepairProvider, "function");

  const candidate = originalCandidate(runtime);
  const trustedBoundary = boundary(runtime, candidate);
  const validRequest = request(runtime, candidate);
  runtime.parseTargetedRepairRequest(validRequest, trustedBoundary);

  const adapter = successfulAdapter();
  const provider = providerModule.createCodexRepairProvider({
    model: "fixture-model",
    adapter
  });
  const result = await provider.repair({
    request: validRequest,
    boundary: trustedBoundary,
    originalCandidate: candidate,
    acceptanceCriterion: criterion()
  });
  assert.equal(result.decision, "repair_candidate_ready", JSON.stringify(result));
  assert.equal(result.route, "continue");
  assert.equal(result.repairRound, 1);
  assert.equal(result.modelCalled, true);
  assert.equal(result.modelId, "fixture-model");
  assert.equal(result.context.wholeRepositoryProvided, false);
  assert.deepEqual(result.context.failingFiles, ["src/auth/session.ts"]);
  assert.deepEqual(result.context.preserveFiles, ["test/auth/session.test.ts"]);
  assert.equal(result.context.visibleFileCount, 2);
  assert.equal(adapter.requests.length, 1);
  assert.equal(result.repairMutation.role, "remask");
  assert.equal(result.repairMutation.target, "repairDraft");
  assert.deepEqual(result.repairMutation.touchedFiles, ["src/auth/session.ts"]);
  assert.equal(result.repairMutation.claims[0].type, "repair_draft");
  assert.equal(result.repairMutation.claims[0].expectedContentHash, hash(candidateSession));
  assert.equal(result.repairMutation.claims[0].newContent, repairedSession);

  const roundAdapter = successfulAdapter();
  const roundProvider = providerModule.createCodexRepairProvider({
    model: "fixture-model",
    adapter: roundAdapter
  });
  const roundStop = await roundProvider.repair({
    request: request(runtime, candidate, { repairRound: 2 }),
    boundary: trustedBoundary,
    originalCandidate: candidate,
    acceptanceCriterion: criterion()
  });
  assert.equal(roundStop.decision, "repair_stopped");
  assert.equal(roundStop.route, "human_review_required");
  assert.equal(roundStop.reasonCode, "repair_round_limit_exhausted");
  assert.equal(roundStop.modelCalled, false);
  assert.equal(roundAdapter.requests.length, 0);

  const broadAdapter = successfulAdapter();
  const broadProvider = providerModule.createCodexRepairProvider({
    model: "fixture-model",
    adapter: broadAdapter
  });
  const broadStop = await broadProvider.repair({
    request: request(runtime, candidate, {
      allowedFiles: ["src/auth/session.ts", "test/auth/session.test.ts"],
      preserveFiles: []
    }),
    boundary: trustedBoundary,
    originalCandidate: candidate,
    acceptanceCriterion: criterion()
  });
  assert.equal(broadStop.decision, "repair_stopped");
  assert.equal(broadStop.route, "replan_required");
  assert.equal(broadStop.reasonCode, "repair_scope_not_targeted");
  assert.equal(broadStop.modelCalled, false);
  assert.equal(broadAdapter.requests.length, 0);

  const ambiguousAdapter = successfulAdapter();
  const ambiguousProvider = providerModule.createCodexRepairProvider({
    model: "fixture-model",
    adapter: ambiguousAdapter
  });
  const ambiguousStop = await ambiguousProvider.repair({
    request: request(runtime, candidate, {
      failingFiles: ["src/auth/session.ts", "test/auth/session.test.ts"],
      allowedFiles: ["src/auth/session.ts", "test/auth/session.test.ts"],
      preserveFiles: [],
      verifierIssues: []
    }),
    boundary: trustedBoundary,
    originalCandidate: candidate,
    acceptanceCriterion: criterion()
  });
  assert.equal(ambiguousStop.decision, "repair_stopped");
  assert.equal(ambiguousStop.route, "human_review_required");
  assert.equal(ambiguousStop.reasonCode, "repair_multi_file_failure_ambiguous");
  assert.equal(ambiguousStop.modelCalled, false);
  assert.equal(ambiguousAdapter.requests.length, 0);

  const noOpAdapter = noChangeAdapter();
  const noOpProvider = providerModule.createCodexRepairProvider({
    model: "fixture-model",
    adapter: noOpAdapter
  });
  const noOpStop = await noOpProvider.repair({
    request: validRequest,
    boundary: trustedBoundary,
    originalCandidate: candidate,
    acceptanceCriterion: criterion()
  });
  assert.equal(noOpStop.decision, "repair_stopped");
  assert.equal(noOpStop.route, "human_review_required");
  assert.equal(noOpStop.reasonCode, "repair_model_made_no_change");
  assert.equal(noOpStop.modelCalled, true);
  assert.equal(noOpAdapter.requests.length, 1);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    providerVersion: providerModule.CODEX_REPAIR_PROVIDER_VERSION,
    maxRepairRounds: providerModule.MAX_REPAIR_ROUNDS,
    modelIndependentRequestContract: "targeted-repair-request/v1",
    realRepositoryPathAcceptedByProvider: false,
    wholeRepositoryProvided: result.context.wholeRepositoryProvided,
    failingFilesOnlyMutable: true,
    preserveAcceptedEditVisibleAndUnchanged: true,
    testAndVerifierFailureProvided: true,
    singleAcceptanceCriterionProvided: true,
    repairMode: adapter.requests[0].mode,
    repairNetworkAllowed: adapter.requests[0].networkAllowed,
    repairSandbox: adapter.requests[0].sandboxMode,
    candidateRelativeExpectedHash: true,
    maxRoundStopsBeforeModel: roundAdapter.requests.length === 0,
    broadScopeStopsBeforeModel: broadAdapter.requests.length === 0,
    ambiguousLocalizationStopsBeforeModel: ambiguousAdapter.requests.length === 0,
    noOpBlindRetry: noOpAdapter.requests.length === 1,
    realCodexCalls: false
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
