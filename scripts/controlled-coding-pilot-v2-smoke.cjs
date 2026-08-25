#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  V2_DEFINITION,
  V2_TARGETS,
  runControlledCodingPilot,
  validateDefinition
} = require("./controlled-coding-pilot.cjs");

function output(request, mode) {
  if (mode === "malformed") return "not-an-object";
  const bounded = JSON.parse(request.instruction);
  const mutation = (file, newContent = file.content) => ({
    path: file.path,
    operation: "replace",
    expectedContentHash: file.contentHash,
    newContent,
    relatedPlanStepIds: ["step-1"],
    relatedSymbolIds: file.relatedSymbols
  });
  const envelope = (mutations) => ({
    schemaVersion: "bounded.executor-model-output/v1",
    mutations,
    summary: "Bounded requestId correlation repair.",
    assumptions: [],
    unresolvedQuestions: []
  });

  if (mode === "authority-escalation") {
    return { ...envelope(bounded.workspaceFiles.map(mutation)), authority: ["scripts"] };
  }
  if (mode === "third-file") {
    return envelope([{
      path: "package.json",
      operation: "replace",
      expectedContentHash: `sha256:${"0".repeat(64)}`,
      newContent: "{}\n",
      relatedPlanStepIds: ["step-1"],
      relatedSymbolIds: []
    }]);
  }
  if (mode === "verifier-mutation" || mode === "definition-mutation") {
    const path = mode === "verifier-mutation"
      ? "scripts/controlled-coding-pilot-request-id-check.cjs"
      : V2_DEFINITION;
    return envelope([{
      path,
      operation: "replace",
      expectedContentHash: `sha256:${"0".repeat(64)}`,
      newContent: "provider controlled\n",
      relatedPlanStepIds: ["step-1"],
      relatedSymbolIds: []
    }]);
  }
  if (mode === "over-budget") {
    return envelope(bounded.workspaceFiles.map((file, index) => mutation(
      file,
      index === 0
        ? `${file.content}\n${Array.from({ length: 61 }, (_, line) =>
            `// over-budget-${line}`).join("\n")}\n`
        : `${file.content}\n// second authorized file\n`
    )));
  }
  if (mode === "incorrect") {
    return envelope(bounded.workspaceFiles.map((file) => mutation(
      file,
      `${file.content}\n// controlled pilot incorrect repair fixture\n`
    )));
  }
  if (mode !== "correct") throw new Error(`Unknown v2 smoke mode: ${mode}`);

  return envelope(bounded.workspaceFiles.map((file) => mutation(
    file,
    file.path === V2_TARGETS[0]
      ? repairWorkerContract(file.content)
      : addRegression(file.content)
  )));
}

function repairWorkerContract(content) {
  const replacements = [
    ["return assertRefineResponse(body);", "return assertRefineResponse(body, input.requestId);"],
    ["return assertInfillResponse(body);", "return assertInfillResponse(body, input.requestId);"],
    ["return assertResolveConflictResponse(body);", "return assertResolveConflictResponse(body, input.requestId);"],
    ["function assertRefineResponse(value: unknown): DllmWorkerRefineResponse {",
      "function assertRefineResponse(value: unknown, expectedRequestId: string): DllmWorkerRefineResponse {"],
    ["function assertInfillResponse(value: unknown): DllmWorkerInfillResponse {",
      "function assertInfillResponse(value: unknown, expectedRequestId: string): DllmWorkerInfillResponse {"],
    ["  value: unknown\n): DllmWorkerResolveConflictResponse {",
      "  value: unknown,\n  expectedRequestId: string\n): DllmWorkerResolveConflictResponse {"]
  ];
  let repaired = content;
  for (const [before, after] of replacements) {
    assert.equal(repaired.includes(before), true, `missing repair anchor: ${before}`);
    repaired = repaired.replace(before, after);
  }
  let replacedChecks = 0;
  repaired = repaired.replace(
    /typeof value\.requestId === "string" &&\n\s+value\.requestId\.length > 0 &&/g,
    () => {
      replacedChecks += 1;
      return "value.requestId === expectedRequestId &&";
    }
  );
  assert.equal(replacedChecks, 3);
  return repaired;
}

function addRegression(content) {
  const anchor = "console.log(JSON.stringify({ ok: true, checked:";
  assert.equal(content.includes(anchor), true, "missing contracts smoke anchor");
  const regression = [
    "const originalWorkerContractFetch = globalThis.fetch;",
    "let workerContractResponseId = \"wrong-request\";",
    "globalThis.fetch = async () => new Response(JSON.stringify({",
    "  requestId: workerContractResponseId, workspace: {},",
    "  engineName: \"smoke-worker\", latencyMs: 0",
    "}));",
    "try {",
    "  await assert.rejects(workerClient.refine({",
    "    requestId: \"expected-request\", workspace: {} as never",
    "  }));",
    "  workerContractResponseId = \"matching-request\";",
    "  assert.equal((await workerClient.refine({",
    "    requestId: \"matching-request\", workspace: {} as never",
    "  })).requestId, \"matching-request\");",
    "} finally {",
    "  globalThis.fetch = originalWorkerContractFetch;",
    "}",
    ""
  ].join("\n");
  return content.replace(anchor, `${regression}${anchor}`);
}

function client(mode, counter) {
  return {
    async execute(request) {
      counter.calls += 1;
      counter.lastRequest = request;
      return { output: output(request, mode), providerRequestId: "pilot_v2_fake" };
    }
  };
}

async function execute(root, temporary, mode, label = mode) {
  const counter = { calls: 0 };
  const report = await runControlledCodingPilot({
    sourceRoot: root,
    definitionPath: V2_DEFINITION,
    output: join(temporary, label),
    executeProvider: true,
    confirmLive: true,
    modelClient: client(mode, counter),
    modelId: "fake-qwen2.5-coder-7b"
  });
  return { report, counter };
}

async function runPilotV2Smoke(root, options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "controlled-pilot-v2-smoke-"));
  const definition = validateDefinition(JSON.parse(await readFile(
    join(root, V2_DEFINITION),
    "utf8"
  )));
  assert.equal(definition.pilotId,
    "controlled-real-coding-v2.worker-request-id-correlation");
  assert.deepEqual(definition.allowedMutationPaths, V2_TARGETS);
  assert.equal(definition.maxPatchLines, 60);
  assert.equal(definition.providerCallBudget, 1);
  assert.equal(definition.retryBudget, 0);
  for (const forbidden of [
    "package.json", "package-lock.json", "dist", ".github", "docs",
    "pilots", "scripts", "apps", "bounded-agent.policy.yml"
  ]) assert.equal(definition.forbiddenPaths.includes(forbidden), true, forbidden);
  for (const leakedSolution of [
    "assertRefineResponse(body, input.requestId)",
    "expectedRequestId: string",
    "value.requestId === expectedRequestId"
  ]) assert.equal(definition.taskPrompt.includes(leakedSolution), false);

  const sourceBefore = Object.fromEntries(await Promise.all(V2_TARGETS.map(
    async (path) => [path, await readFile(join(root, path), "utf8")]
  )));
  const dryCounter = { calls: 0 };
  const dry = await runControlledCodingPilot({
    sourceRoot: root,
    definitionPath: V2_DEFINITION,
    output: join(temporary, "dry"),
    modelClient: client("correct", dryCounter)
  });
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.providerCallCount, 0);
  assert.equal(dryCounter.calls, 0);

  if (!options.validOnly) {
    for (const [mode, failureCode] of [
      ["third-file", "PILOT_AUTHORITY_VIOLATION"],
      ["over-budget", "PILOT_PATCH_LIMIT_EXCEEDED"],
      ["malformed", "PILOT_MODEL_RESPONSE_INVALID"],
      ["authority-escalation", "PILOT_AUTHORITY_VIOLATION"],
      ["verifier-mutation", "PILOT_AUTHORITY_VIOLATION"],
      ["definition-mutation", "PILOT_AUTHORITY_VIOLATION"]
    ]) {
      const { report, counter } = await execute(root, temporary, mode);
      assert.equal(report.status, "failed", `${mode}: ${JSON.stringify(report)}`);
      assert.equal(report.failureCode, failureCode, mode);
      assert.equal(counter.calls, 1, mode);
      assert.equal(report.providerCallCount, 1, mode);
      assert.equal(report.retryCount, 0, mode);
      assert.equal(report.artifactValid, false, mode);
      assert.equal(report.sourceWorktreeMutated, false, mode);
      assert.equal(report.githubMutationObserved, false, mode);
      assert.equal(report.cleanupCompleted, true, mode);
    }

    const incorrect = await execute(root, temporary, "incorrect");
    assert.equal(incorrect.report.status, "failed");
    assert.equal(incorrect.report.failureCode, "PILOT_VERIFICATION_FAILED");
    assert.equal(incorrect.report.verifierDiagnostic.verifierStage,
      "request_id_acceptance");
  }

  const valid = await execute(root, temporary, "correct");
  assert.equal(valid.report.status, "completed", JSON.stringify(valid.report));
  assert.equal(valid.counter.calls, 1);
  assert.equal(valid.report.providerCallCount, 1);
  assert.equal(valid.report.retryCount, 0);
  assert.deepEqual(valid.report.changedFiles, [...V2_TARGETS].sort());
  assert.ok(valid.report.patchLineCount > 0 && valid.report.patchLineCount <= 60);
  assert.equal(valid.report.authorityPassed, true);
  assert.equal(valid.report.verifierPassed, true);
  assert.equal(valid.report.artifactValid, true);
  assert.equal(valid.report.sourceWorktreeMutated, false);
  assert.equal(valid.report.githubMutationObserved, false);
  assert.equal(valid.report.cleanupCompleted, true);
  assert.equal(valid.counter.lastRequest.instruction.includes(
    "expectedRequestId: string"
  ), false);
  assert.deepEqual(valid.counter.lastRequest.outputSchema.required, [
    "schemaVersion", "mutations", "summary", "assumptions", "unresolvedQuestions"
  ]);

  const equivalent = await execute(root, temporary, "correct", "equivalent");
  assert.equal(equivalent.report.status, "completed", JSON.stringify(equivalent.report));
  assert.equal(equivalent.report.reportHash, valid.report.reportHash);
  assert.equal(
    JSON.parse(await readFile(join(
      temporary, "equivalent", "governed-change-artifact.json"
    ), "utf8")).artifactId,
    JSON.parse(await readFile(join(
      temporary, "correct", "governed-change-artifact.json"
    ), "utf8")).artifactId
  );

  for (const path of V2_TARGETS) {
    assert.equal(await readFile(join(root, path), "utf8"), sourceBefore[path]);
  }

  return {
    ok: true,
    checks: [
      "v2-definition-and-authority",
      "v2-dry-run-zero-provider-calls",
      "v2-one-call-zero-retry-budget",
      "v2-third-file-and-budget-rejection",
      "v2-malformed-provider-output-rejection",
      "v2-provider-cannot-alter-authority-verifier-or-definition",
      "v2-defective-repair-fails-behavioral-verifier",
      "v2-correct-fake-repair-passes",
      "v2-source-and-github-immutable",
      "v2-cleanup-and-deterministic-hashes"
    ]
  };
}

module.exports = { runPilotV2Smoke };
