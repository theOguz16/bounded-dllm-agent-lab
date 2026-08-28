#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { access, mkdtemp, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  V2_DEFINITION,
  V2_TARGETS,
  runControlledCodingPilot,
  validateDefinition
} = require("./controlled-coding-pilot.cjs");

const LOCAL_JSON_DEFINITION =
  "pilots/controlled-real-coding-v2/local-json-schema-error-classification/task.json";
const LOCAL_JSON_TARGETS = [
  "packages/integrations/src/local-openai-compatible-model-client.ts",
  "tests/smoke/contracts.ts"
];

function boundedRequest(request) {
  return JSON.parse(request.instruction);
}

function sourceFor(request, path) {
  const source = boundedRequest(request).workspaceFiles.find((file) => file.path === path);
  assert.ok(source, `missing bounded source: ${path}`);
  return source;
}

function edit(request, path, oldText, newText) {
  const source = sourceFor(request, path);
  return {
    path,
    expectedContentHash: source.sourceContentHash,
    oldText,
    newText
  };
}

function envelope(edits, summary) {
  return {
    schemaVersion: "bounded.controlled-text-edits/v1",
    edits,
    summary
  };
}

function requestIdCorrectOutput(request) {
  const worker = V2_TARGETS[0];
  const contracts = V2_TARGETS[1];
  const edits = [
    edit(request, worker,
      "return assertRefineResponse(body);",
      "return assertRefineResponse(body, input.requestId);"),
    edit(request, worker,
      "return assertInfillResponse(body);",
      "return assertInfillResponse(body, input.requestId);"),
    edit(request, worker,
      "return assertResolveConflictResponse(body);",
      "return assertResolveConflictResponse(body, input.requestId);"),
    edit(request, worker,
      [
        "function assertRefineResponse(value: unknown): DllmWorkerRefineResponse {",
        "  if (",
        "    isJsonObject(value) &&",
        "    typeof value.requestId === \"string\" &&",
        "    value.requestId.length > 0 &&"
      ].join("\n"),
      [
        "function assertRefineResponse(",
        "  value: unknown,",
        "  expectedRequestId: string",
        "): DllmWorkerRefineResponse {",
        "  if (",
        "    isJsonObject(value) &&",
        "    value.requestId === expectedRequestId &&"
      ].join("\n")),
    edit(request, worker,
      [
        "function assertInfillResponse(value: unknown): DllmWorkerInfillResponse {",
        "  if (",
        "    isJsonObject(value) &&",
        "    typeof value.requestId === \"string\" &&",
        "    value.requestId.length > 0 &&"
      ].join("\n"),
      [
        "function assertInfillResponse(",
        "  value: unknown,",
        "  expectedRequestId: string",
        "): DllmWorkerInfillResponse {",
        "  if (",
        "    isJsonObject(value) &&",
        "    value.requestId === expectedRequestId &&"
      ].join("\n")),
    edit(request, worker,
      [
        "function assertResolveConflictResponse(",
        "  value: unknown",
        "): DllmWorkerResolveConflictResponse {",
        "  if (",
        "    isJsonObject(value) &&",
        "    typeof value.requestId === \"string\" &&",
        "    value.requestId.length > 0 &&"
      ].join("\n"),
      [
        "function assertResolveConflictResponse(",
        "  value: unknown,",
        "  expectedRequestId: string",
        "): DllmWorkerResolveConflictResponse {",
        "  if (",
        "    isJsonObject(value) &&",
        "    value.requestId === expectedRequestId &&"
      ].join("\n")),
    edit(request, contracts,
      "const localOpenAiEndpoint = (baseUrl: string) => ({",
      [
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
        "",
        "const localOpenAiEndpoint = (baseUrl: string) => ({"
      ].join("\n"))
  ];
  return envelope(edits, "Correlate worker response request IDs with their requests.");
}

function localJsonCorrectOutput(request) {
  const clientPath = LOCAL_JSON_TARGETS[0];
  const contracts = LOCAL_JSON_TARGETS[1];
  return envelope([
    edit(request, clientPath,
      "function mapTransportFailure(error: unknown, modelId: string): LocalOpenAIModelClientError {",
      [
        "function isJsonSchemaUnsupportedFailure(error: unknown): boolean {",
        "  const value = error as TransportFailure | null;",
        "  if (value?.status !== 400 || value.error === null ||",
        "      typeof value.error !== \"object\" || Array.isArray(value.error)) {",
        "    return false;",
        "  }",
        "  const body = value.error as Record<string, unknown>;",
        "  const semantics = [body.code, body.type, body.param, body.message]",
        "    .map(boundedSemantic)",
        "    .filter((entry): entry is string => entry !== undefined)",
        "    .join(\" \");",
        "  return /\\bresponse format\\b/.test(semantics) &&",
        "    /\\bjson schema\\b/.test(semantics) &&",
        "    /\\b(?:not supported|unsupported)\\b/.test(semantics);",
        "}",
        "",
        "function mapTransportFailure(error: unknown, modelId: string): LocalOpenAIModelClientError {"
      ].join("\n")),
    edit(request, clientPath,
      [
        "      if (",
        "        this.configuration.structuredOutputMode === \"json_schema\" &&",
        "        (error as { status?: number } | null)?.status === 400",
        "      ) {",
        "        throw new LocalOpenAIModelClientError(\"LOCAL_JSON_SCHEMA_UNSUPPORTED\");",
        "      }"
      ].join("\n"),
      [
        "      if (",
        "        this.configuration.structuredOutputMode === \"json_schema\" &&",
        "        isJsonSchemaUnsupportedFailure(error)",
        "      ) {",
        "        throw new LocalOpenAIModelClientError(\"LOCAL_JSON_SCHEMA_UNSUPPORTED\");",
        "      }"
      ].join("\n")),
    edit(request, contracts,
      "assert.deepEqual(validateFixtures(demoFixtures), []);",
      [
        "assert.equal(",
        "  new LocalOpenAIModelClientError(\"LOCAL_JSON_SCHEMA_UNSUPPORTED\").code,",
        "  \"LOCAL_JSON_SCHEMA_UNSUPPORTED\"",
        ");",
        "",
        "assert.deepEqual(validateFixtures(demoFixtures), []);"
      ].join("\n"))
  ], "Classify only genuine unsupported local json_schema transport failures.");
}

function output(request, mode, definitionPath) {
  if (mode === "malformed") return "not-an-object";
  const definitionIsLocal = definitionPath === LOCAL_JSON_DEFINITION;
  if (mode === "correct") {
    return definitionIsLocal ? localJsonCorrectOutput(request) : requestIdCorrectOutput(request);
  }
  if (definitionIsLocal) throw new Error(`Unknown local-json smoke mode: ${mode}`);

  if (mode === "third-file") {
    return envelope([{
      path: "package.json",
      expectedContentHash: `sha256:${"0".repeat(64)}`,
      oldText: "{}",
      newText: "{\"private\":true}"
    }], "Unauthorized edit fixture.");
  }
  if (mode === "verifier-mutation" || mode === "definition-mutation") {
    return envelope([{
      path: mode === "verifier-mutation"
        ? "scripts/controlled-coding-pilot-request-id-check.cjs"
        : V2_DEFINITION,
      expectedContentHash: `sha256:${"0".repeat(64)}`,
      oldText: "provider",
      newText: "provider controlled"
    }], "Authority violation fixture.");
  }
  if (mode === "over-budget") {
    const worker = V2_TARGETS[0];
    const contracts = V2_TARGETS[1];
    const padding = Array.from({ length: 130 }, (_, index) =>
      `// controlled-over-budget-${index}`).join("\n");
    return envelope([
      edit(request, worker,
        "export type DllmWorkerMode = \"mock\" | \"dllm\" | \"llm\" | string;",
        `export type DllmWorkerMode = \"mock\" | \"dllm\" | \"llm\" | string;\n${padding}`),
      edit(request, contracts,
        "assert.equal(typeof workerClient.health, \"function\");",
        "assert.equal(typeof workerClient.health, \"function\");\n// bounded second-file fixture")
    ], "Over-budget bounded edit fixture.");
  }
  if (mode === "incorrect") {
    return envelope([
      edit(request, V2_TARGETS[0],
        "export type DllmWorkerMode = \"mock\" | \"dllm\" | \"llm\" | string;",
        "export type DllmWorkerMode = \"mock\" | \"dllm\" | \"llm\" | string;\n// incorrect repair fixture"),
      edit(request, V2_TARGETS[1],
        "assert.equal(typeof workerClient.health, \"function\");",
        "assert.equal(typeof workerClient.health, \"function\");\n// incorrect repair fixture")
    ], "Behaviorally incorrect but syntactically valid fixture.");
  }
  throw new Error(`Unknown v2 smoke mode: ${mode}`);
}

function client(mode, counter, definitionPath) {
  return {
    async execute(request) {
      counter.calls += 1;
      counter.lastRequest = request;
      return {
        output: output(request, mode, definitionPath),
        providerRequestId: "pilot_v2_fake"
      };
    }
  };
}

async function execute(root, temporary, definitionPath, mode, label = mode) {
  const counter = { calls: 0 };
  const report = await runControlledCodingPilot({
    sourceRoot: root,
    definitionPath,
    output: join(temporary, label),
    executeProvider: true,
    confirmLive: true,
    modelClient: client(mode, counter, definitionPath),
    modelId: "fake-qwen2.5-coder-7b"
  });
  return { report, counter, outputDir: join(temporary, label) };
}

async function assertDefinition(root, definitionPath, expectedId, expectedTargets) {
  const definition = validateDefinition(JSON.parse(await readFile(
    join(root, definitionPath), "utf8"
  )));
  assert.equal(definition.pilotId, expectedId);
  assert.deepEqual(definition.allowedMutationPaths, expectedTargets);
  assert.equal(definition.maxPatchLines, 120);
  assert.equal(definition.providerCallBudget, 1);
  assert.equal(definition.retryBudget, 0);
  return definition;
}

async function runPilotV2Smoke(root, options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "controlled-pilot-v2-smoke-"));
  const requestIdDefinition = await assertDefinition(
    root,
    V2_DEFINITION,
    "controlled-real-coding-v2.worker-request-id-correlation",
    V2_TARGETS
  );
  await assertDefinition(
    root,
    LOCAL_JSON_DEFINITION,
    "controlled-real-coding-v2.local-json-schema-error-classification",
    LOCAL_JSON_TARGETS
  );

  for (const forbidden of [
    "package.json", "package-lock.json", "dist", ".github", "docs",
    "pilots", "scripts", "apps", "bounded-agent.policy.yml"
  ]) assert.equal(requestIdDefinition.forbiddenPaths.includes(forbidden), true, forbidden);

  const allTargets = [...new Set([...V2_TARGETS, ...LOCAL_JSON_TARGETS])];
  const sourceBefore = Object.fromEntries(await Promise.all(allTargets.map(
    async (path) => [path, await readFile(join(root, path), "utf8")]
  )));

  const dryCounter = { calls: 0 };
  const dry = await runControlledCodingPilot({
    sourceRoot: root,
    definitionPath: V2_DEFINITION,
    output: join(temporary, "dry"),
    modelClient: client("correct", dryCounter, V2_DEFINITION)
  });
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.providerCallCount, 0);
  assert.equal(dryCounter.calls, 0);

  if (!options.validOnly) {
    for (const [mode, failureCode] of [
      ["third-file", "PILOT_AUTHORITY_VIOLATION"],
      ["over-budget", "PILOT_PATCH_LIMIT_EXCEEDED"],
      ["malformed", "PILOT_MODEL_RESPONSE_INVALID"],
      ["verifier-mutation", "PILOT_AUTHORITY_VIOLATION"],
      ["definition-mutation", "PILOT_AUTHORITY_VIOLATION"]
    ]) {
      const result = await execute(root, temporary, V2_DEFINITION, mode);
      assert.equal(result.report.status, "failed", `${mode}: ${JSON.stringify(result.report)}`);
      assert.equal(result.report.failureCode, failureCode, mode);
      assert.equal(result.counter.calls, 1, mode);
      assert.equal(result.report.providerCallCount, 1, mode);
      assert.equal(result.report.retryCount, 0, mode);
      assert.equal(result.report.sourceWorktreeMutated, false, mode);
      assert.equal(result.report.githubMutationObserved, false, mode);
      assert.equal(result.report.cleanupCompleted, true, mode);
      if (mode === "over-budget") {
        assert.equal(result.report.providerDiagnostic.rejectedCandidateArtifacts.patch,
          "rejected-candidate.patch");
        assert.equal(result.report.providerDiagnostic.rejectedCandidateArtifacts.providerOutput,
          "rejected-provider-output.json");
        await access(join(result.outputDir, "rejected-candidate.patch"));
        await access(join(result.outputDir, "rejected-provider-output.json"));
      }
    }

    const incorrect = await execute(root, temporary, V2_DEFINITION, "incorrect");
    assert.equal(incorrect.report.status, "failed");
    assert.equal(incorrect.report.failureCode, "PILOT_VERIFICATION_FAILED");
    assert.equal(incorrect.report.verifierDiagnostic.verifierStage,
      "request_id_acceptance");
    assert.equal(incorrect.report.verifierDiagnostic.rejectedCandidateArtifact,
      "rejected-candidate.patch");
    await access(join(incorrect.outputDir, "rejected-candidate.patch"));
    await access(join(incorrect.outputDir, "verifier-error.json"));
  }

  const requestId = await execute(root, temporary, V2_DEFINITION, "correct", "request-id-correct");
  assert.equal(requestId.report.status, "completed", JSON.stringify(requestId.report));
  assert.equal(requestId.counter.calls, 1);
  assert.equal(requestId.report.providerCallCount, 1);
  assert.equal(requestId.report.retryCount, 0);
  assert.deepEqual(requestId.report.changedFiles, [...V2_TARGETS].sort());
  assert.ok(requestId.report.patchLineCount > 0 && requestId.report.patchLineCount <= 120);
  assert.equal(requestId.report.authorityPassed, true);
  assert.equal(requestId.report.verifierPassed, true);
  assert.equal(requestId.report.artifactValid, true);
  assert.equal(requestId.report.sourceWorktreeMutated, false);
  assert.equal(requestId.report.githubMutationObserved, false);
  assert.equal(requestId.report.cleanupCompleted, true);
  assert.deepEqual(requestId.counter.lastRequest.outputSchema.required, [
    "schemaVersion", "edits", "summary"
  ]);

  const localJson = await execute(
    root,
    temporary,
    LOCAL_JSON_DEFINITION,
    "correct",
    "local-json-correct"
  );
  assert.equal(localJson.report.status, "completed", JSON.stringify(localJson.report));
  assert.equal(localJson.counter.calls, 1);
  assert.equal(localJson.report.providerCallCount, 1);
  assert.equal(localJson.report.retryCount, 0);
  assert.deepEqual(localJson.report.changedFiles, [...LOCAL_JSON_TARGETS].sort());
  assert.ok(localJson.report.patchLineCount > 0 && localJson.report.patchLineCount <= 120);
  assert.equal(localJson.report.authorityPassed, true);
  assert.equal(localJson.report.verifierPassed, true);
  assert.equal(localJson.report.artifactValid, true);
  assert.equal(localJson.report.sourceWorktreeMutated, false);
  assert.equal(localJson.report.githubMutationObserved, false);
  assert.equal(localJson.report.cleanupCompleted, true);

  for (const path of allTargets) {
    assert.equal(await readFile(join(root, path), "utf8"), sourceBefore[path]);
  }

  return {
    ok: true,
    checks: [
      "v2-definition-and-authority",
      "v2-dry-run-zero-provider-calls",
      "v2-one-call-zero-retry-budget",
      "v2-request-id-real-offline-acceptance",
      "v2-local-json-real-offline-acceptance",
      "v2-third-file-and-budget-rejection",
      "v2-malformed-provider-output-rejection",
      "v2-provider-cannot-alter-verifier-or-definition",
      "v2-rejected-candidate-artifacts-preserved",
      "v2-source-and-github-immutable"
    ]
  };
}

module.exports = { runPilotV2Smoke };

if (require.main === module) {
  runPilotV2Smoke(process.cwd()).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
