#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  PILOT_EXECUTION_RUNTIME_MS,
  PILOT_EXECUTOR_OUTPUT_TOKEN_LIMIT,
  PILOT_MAX_INSERTION_LINES,
  PILOT_MODEL_CONTEXT_TOKEN_LIMIT,
  PILOT_PROVIDER_MAX_OUTPUT_TOKENS,
  PILOT_PROVIDER_TIMEOUT_MS,
  TARGET,
  classifyVerifierFailure,
  controlledInsertionInstruction,
  controlledInsertionOutputSchema,
  deriveExecutorMutationLineBudget,
  enforceSemanticPatchLimit,
  materializeControlledInsertion,
  pilotProviderClientConfiguration,
  renderControlledHelpInsertion,
  resolveControlledInsertionAuthority,
  runControlledCodingPilot,
  validateRenderedInsertion,
  validateDefinition
} = require("./controlled-coding-pilot.cjs");

function contentHash(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function outputFor(request, mode = "valid") {
  if (mode === "malformed") return "not-an-object";
  if (mode === "code-fenced") return "```json\n{}\n```";
  const output = {
    schemaVersion: "bounded.controlled-help-copy-output/v1",
    descriptions: {
      help: "Show this help message.",
      llmUpstreamUrl: "OpenAI-compatible LLM upstream URL.",
      dllmUpstreamUrl: "OpenAI-compatible DLLM upstream URL.",
      llmModelId: "LLM model identifier.",
      dllmModelId: "DLLM model identifier.",
      runpodLiveRequired: "Require live Runpod acceptance."
    }
  };
  if (mode === "path-selection") output.path = "docs/unauthorized.md";
  if (mode === "operation-selection") output.operation = "delete";
  if (mode === "hash-selection") output.expectedContentHash = `sha256:${"0".repeat(64)}`;
  if (mode === "anchor-selection") output.anchor = "model-selected-anchor";
  if (mode === "description-newline") output.descriptions.help = "invalid\ncopy";
  if (mode === "description-empty") output.descriptions.help = "  ";
  if (mode === "description-overlength") output.descriptions.help = "x".repeat(121);
  if (mode === "description-extra") output.descriptions.extra = "not allowed";
  return output;
}

function client(mode, counter) {
  return {
    async execute(request) {
      counter.calls += 1;
      counter.lastRequest = request;
      return { output: outputFor(request, mode), providerRequestId: "pilot_fake_request" };
    }
  };
}

(async () => {
  const root = process.cwd();
  const temporary = await mkdtemp(join(tmpdir(), "controlled-pilot-smoke-"));
  const sourceBefore = await readFile(join(root, TARGET), "utf8");
  const anchor = "const reportName = \"model-worker-runpod-live-smoke-v1\";";
  const canonicalRequest = (content = sourceBefore, overrides = {}) => ({
    instruction: JSON.stringify({
      existingPlan: { steps: [{ stepId: "step-1" }] },
      workspaceFiles: [{
        path: TARGET,
        content,
        contentHash: contentHash(content),
        authority: "change_allowed",
        relatedSymbols: ["symbol:main"]
      }],
      authorityRules: {
        allowedChangePaths: [TARGET],
        forbiddenPaths: []
      },
      ...overrides
    })
  });
  const validInsertion = outputFor({}, "valid");
  const materialized = materializeControlledInsertion(canonicalRequest(), validInsertion);
  const mutation = materialized.output.mutations[0];
  assert.equal(mutation.path, TARGET);
  assert.equal(mutation.operation, "replace");
  assert.equal(mutation.expectedContentHash, contentHash(sourceBefore));
  assert.equal(materialized.output.summary, "Added bounded early help handling.");
  assert.deepEqual(materialized.output.assumptions, []);
  assert.deepEqual(materialized.output.unresolvedQuestions, []);
  assert.equal(materialized.sourceContent.slice(0, materialized.anchorOffset),
    sourceBefore.slice(0, sourceBefore.indexOf(anchor)));
  assert.equal(mutation.newContent.slice(0, materialized.anchorOffset),
    sourceBefore.slice(0, sourceBefore.indexOf(anchor)));
  assert.equal(mutation.newContent.slice(
    materialized.anchorOffset + materialized.insertionContent.length
  ), sourceBefore.slice(sourceBefore.indexOf(anchor)));
  for (const declaration of ["type LiveSmokeStatus", "type LiveSmokeReport"]) {
    const start = sourceBefore.indexOf(declaration);
    const end = sourceBefore.indexOf("\n};", start) + 3;
    assert.ok(start >= 0 && end > start);
    assert.ok(mutation.newContent.includes(sourceBefore.slice(start, end)));
  }
  assert.throws(
    () => materializeControlledInsertion(canonicalRequest(sourceBefore.replace(anchor, "")),
      validInsertion),
    (error) => error.pilotCode === "PILOT_AUTHORITY_VIOLATION"
  );
  assert.throws(
    () => materializeControlledInsertion(canonicalRequest(`${sourceBefore}\n${anchor}\n`),
      validInsertion),
    (error) => error.pilotCode === "PILOT_AUTHORITY_VIOLATION"
  );
  assert.throws(
    () => materializeControlledInsertion(canonicalRequest(sourceBefore, {
      authorityRules: { allowedChangePaths: [TARGET], forbiddenPaths: [TARGET] }
    }), validInsertion),
    (error) => error.pilotCode === "PILOT_AUTHORITY_VIOLATION"
  );
  assert.throws(
    () => materializeControlledInsertion(canonicalRequest(sourceBefore, {
      workspaceFiles: [{
        path: TARGET,
        content: sourceBefore,
        contentHash: contentHash("different"),
        authority: "change_allowed",
        relatedSymbols: ["symbol:main"]
      }]
    }), validInsertion),
    (error) => error.pilotCode === "PILOT_AUTHORITY_VIOLATION"
  );
  assert.throws(
    () => controlledInsertionInstruction(canonicalRequest(sourceBefore, {
      workspaceFiles: [{
        path: "apps/cli/src/not-authorized.ts",
        content: sourceBefore,
        contentHash: contentHash(sourceBefore),
        authority: "change_allowed",
        relatedSymbols: []
      }]
    })),
    (error) => error.pilotCode === "PILOT_AUTHORITY_VIOLATION"
  );
  const missingDescription = structuredClone(validInsertion);
  delete missingDescription.descriptions.help;
  const unexpectedDescription = structuredClone(validInsertion);
  unexpectedDescription.descriptions.extra = "not allowed";
  for (const invalidInsertion of [
    { content: "const value = true;" },
    { schemaVersion: "bounded.controlled-help-copy-output/v1" },
    { ...validInsertion, extra: true },
    missingDescription,
    unexpectedDescription,
    outputFor({}, "description-empty"),
    outputFor({}, "description-newline"),
    { ...structuredClone(validInsertion), descriptions: {
      ...validInsertion.descriptions, help: "invalid\rcopy"
    } },
    { ...structuredClone(validInsertion), descriptions: {
      ...validInsertion.descriptions, help: "invalid\u0000copy"
    } },
    outputFor({}, "description-overlength"),
    { ...structuredClone(validInsertion), descriptions: {
      ...validInsertion.descriptions, help: "```invalid```"
    } }
  ]) {
    assert.throws(
      () => materializeControlledInsertion(canonicalRequest(), invalidInsertion),
      (error) => error.code === "RUNPOD_RESPONSE_SCHEMA_INVALID"
    );
  }
  assert.throws(
    () => validateRenderedInsertion(Array.from(
      { length: PILOT_MAX_INSERTION_LINES + 1 }, () => "line"
    ).join("\n")),
    (error) => error.pilotCode === "PILOT_PATCH_LIMIT_EXCEEDED"
  );
  assert.throws(
    () => validateRenderedInsertion("x".repeat(20_001)),
    (error) => error.pilotCode === "PILOT_PATCH_LIMIT_EXCEEDED"
  );
  const escapedInsertion = renderControlledHelpInsertion({
    ...structuredClone(validInsertion),
    descriptions: {
      ...validInsertion.descriptions,
      help: "Show a \"quoted\" path \\ safely."
    }
  });
  assert.ok(escapedInsertion.includes(JSON.stringify(
    "  --help, -h               Show a \"quoted\" path \\ safely."
  )));
  const renderedInsertion = renderControlledHelpInsertion(validInsertion);
  for (const literal of [
    "process.argv.includes(\"--help\")", "process.argv.includes(\"-h\")",
    "console.log", "process.exit(0)", "model-worker-runpod-live-smoke",
    "--help", "-h", "LLM_UPSTREAM_URL", "DLLM_UPSTREAM_URL", "LLM_MODEL_ID",
    "DLLM_MODEL_ID", "RUNPOD_LIVE_REQUIRED", "127.0.0.1:8790"
  ]) assert.ok(renderedInsertion.includes(literal), literal);
  assert.throws(() => enforceSemanticPatchLimit(121, 120),
    (error) => error.pilotCode === "PILOT_PATCH_LIMIT_EXCEEDED");
  assert.doesNotThrow(() => enforceSemanticPatchLimit(120, 120));
  const insertionSchema = controlledInsertionOutputSchema();
  assert.equal(insertionSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(insertionSchema.properties).sort(), [
    "descriptions", "schemaVersion"
  ]);
  assert.deepEqual(insertionSchema.required, ["schemaVersion", "descriptions"]);
  assert.equal(insertionSchema.properties.schemaVersion.const,
    "bounded.controlled-help-copy-output/v1");
  const descriptionsSchema = insertionSchema.properties.descriptions;
  assert.equal(descriptionsSchema.additionalProperties, false);
  assert.deepEqual(descriptionsSchema.required, [
    "help", "llmUpstreamUrl", "dllmUpstreamUrl", "llmModelId",
    "dllmModelId", "runpodLiveRequired"
  ]);
  assert.deepEqual(Object.keys(descriptionsSchema.properties).sort(), [
    "dllmModelId", "dllmUpstreamUrl", "help", "llmModelId",
    "llmUpstreamUrl", "runpodLiveRequired"
  ]);
  assert.equal("content" in insertionSchema.properties, false);
  assert.equal("path" in insertionSchema.properties, false);
  assert.equal("operation" in insertionSchema.properties, false);
  assert.equal("expectedContentHash" in insertionSchema.properties, false);
  assert.equal("anchor" in insertionSchema.properties, false);
  assert.equal("summary" in insertionSchema.properties, false);
  assert.equal("assumptions" in insertionSchema.properties, false);
  assert.equal("unresolvedQuestions" in insertionSchema.properties, false);
  const authorityContext = resolveControlledInsertionAuthority(canonicalRequest());
  const insertionInstruction = controlledInsertionInstruction(canonicalRequest());
  const parsedInsertionInstruction = JSON.parse(insertionInstruction);
  assert.equal(insertionInstruction.includes(sourceBefore), false);
  const sourceLines = sourceBefore.split(/\r?\n/);
  const anchorLine = sourceBefore.slice(0, sourceBefore.indexOf(anchor)).split(/\r?\n/).length - 1;
  assert.equal(authorityContext.excerpt,
    sourceLines.slice(Math.max(0, anchorLine - 8), anchorLine + 5).join("\n"));
  assert.ok(authorityContext.excerpt.split(/\r?\n/).length <= 13);
  assert.ok(authorityContext.excerpt.length < sourceBefore.length);
  assert.deepEqual(Object.keys(parsedInsertionInstruction).sort(), [
    "fields", "requirements", "role"
  ]);
  assert.equal(parsedInsertionInstruction.role,
    "Return only bounded help-copy descriptions matching the strict schema.");
  const requirements = parsedInsertionInstruction.requirements.join(" ");
  for (const phrase of [
    "Do not return TypeScript or control flow",
    "Do not return flags, paths, anchors, mutations, hashes, operations, or source text",
    "short human-readable single-line description",
    "non-empty", "no control characters or markdown fences", "at most 120 UTF-8 bytes"
  ]) {
    assert.ok(requirements.includes(phrase), phrase);
  }
  assert.deepEqual(Object.keys(parsedInsertionInstruction.fields).sort(), [
    "dllmModelId", "dllmUpstreamUrl", "help", "llmModelId",
    "llmUpstreamUrl", "runpodLiveRequired"
  ]);
  const definition = validateDefinition(JSON.parse(await readFile(join(
    root, "pilots/controlled-real-coding-v1/runpod-live-help/task.json"
  ), "utf8")));
  for (const requiredPromptText of [
    "LiveSmokeStatus", "LiveSmokeReport", "smallest additive change",
    "Do not delete, rename, reorder, or rewrite unrelated declarations or functions",
    "Do not refactor or reformat unrelated code",
    "Do not remove existing behavior merely to reduce output size"
  ]) {
    assert.ok(definition.taskPrompt.includes(requiredPromptText), requiredPromptText);
  }
  for (const stage of [
    "typecheck", "help_acceptance", "normal_missing_env", "runpod_proxy_smoke"
  ]) {
    const unsafeError = Object.assign(new Error("secret verifier output"), {
      code: 2,
      stdout: "prompt and source contents",
      stderr: "authorization header"
    });
    const classified = classifyVerifierFailure(stage, unsafeError);
    assert.equal(classified.pilotCode, "PILOT_VERIFICATION_FAILED");
    assert.deepEqual(classified.verifierDiagnostic, {
      verifierStage: stage,
      verifierExitCode: 2,
      verifierCode: "COMMAND_FAILED"
    });
    assert.deepEqual(Object.keys(classified.verifierDiagnostic).sort(), [
      "verifierCode", "verifierExitCode", "verifierStage"
    ]);
  }
  assert.equal(PILOT_EXECUTOR_OUTPUT_TOKEN_LIMIT, 6_144);
  assert.equal(PILOT_MAX_INSERTION_LINES, 60);
  assert.equal(PILOT_PROVIDER_MAX_OUTPUT_TOKENS, 1_024);
  assert.equal(PILOT_MODEL_CONTEXT_TOKEN_LIMIT, 16_384);
  assert.ok(PILOT_PROVIDER_TIMEOUT_MS <= PILOT_EXECUTION_RUNTIME_MS);
  assert.ok(PILOT_PROVIDER_MAX_OUTPUT_TOKENS <= PILOT_EXECUTOR_OUTPUT_TOKEN_LIMIT);
  assert.equal(deriveExecutorMutationLineBudget({
    sourceFiles: [
      { path: TARGET, content: "one\ntwo\nthree" },
      { path: "apps/cli/src/read-only.ts", content: "ignored\n".repeat(500) },
      { path: "apps/cli/src/forbidden.ts", content: "ignored\n".repeat(500) }
    ],
    allowedMutationPaths: [TARGET, "apps/cli/src/forbidden.ts"],
    forbiddenPaths: ["apps/cli/src/forbidden.ts"],
    maxPatchLines: 120
  }), 126);
  const coding = await import(
    "../dist/packages/integrations/src/coding-executor.js"
  );
  const runpod = await import(
    "../dist/packages/integrations/src/runpod-openai-compatible-model-client.js"
  );
  assert.equal(typeof coding.ProductionCodingExecutorAdapter, "function");
  assert.equal(coding.CODING_EXECUTOR_REQUEST_VERSION,
    "bounded.coding-executor-request/v1");
  const credential = { async getCredential() { return "fixture-value"; } };
  const modelRequest = {
    modelId: "budget-fixture",
    instruction: "{}",
    instructionHash: `sha256:${"1".repeat(64)}`,
    requestKey: `sha256:${"2".repeat(64)}`,
    outputSchema: {},
    outputTokenLimit: PILOT_EXECUTOR_OUTPUT_TOKEN_LIMIT,
    maxOutputBytes: 10_000,
    remainingRuntimeMs: PILOT_EXECUTION_RUNTIME_MS
  };
  const clientConfiguration = (overrides = {}) => ({
    schemaVersion: runpod.RUNPOD_MODEL_CLIENT_VERSION,
    modelId: "budget-fixture",
    endpoint: { type: "serverless", endpointId: "offline_budget" },
    structuredOutputMode: "json_schema",
    requestTimeoutMs: PILOT_PROVIDER_TIMEOUT_MS,
    temperature: 0,
    maxOutputTokens: PILOT_PROVIDER_MAX_OUTPUT_TOKENS,
    ...overrides
  });
  assert.deepEqual(pilotProviderClientConfiguration(
    runpod.RUNPOD_MODEL_CLIENT_VERSION,
    {
      modelId: "budget-fixture",
      baseUrl: "https://fixture.invalid/v1"
    }
  ), {
    schemaVersion: runpod.RUNPOD_MODEL_CLIENT_VERSION,
    modelId: "budget-fixture",
    endpoint: {
      type: "custom_openai_compatible",
      baseUrl: "https://fixture.invalid/v1"
    },
    structuredOutputMode: "json_schema",
    requestTimeoutMs: PILOT_PROVIDER_TIMEOUT_MS,
    temperature: 0,
    maxOutputTokens: PILOT_PROVIDER_MAX_OUTPUT_TOKENS
  });
  await assert.rejects(
    new runpod.RunpodOpenAICompatibleModelClient(
      clientConfiguration({ requestTimeoutMs: PILOT_EXECUTION_RUNTIME_MS + 1 }),
      credential
    ).execute(modelRequest, {}),
    (error) => error.code === "REQUEST_REJECTED"
  );
  await assert.rejects(
    new runpod.RunpodOpenAICompatibleModelClient(
      clientConfiguration({ maxOutputTokens: PILOT_EXECUTOR_OUTPUT_TOKEN_LIMIT + 1 }),
      credential
    ).execute(modelRequest, {}),
    (error) => error.code === "REQUEST_REJECTED"
  );
  const originalFetch = globalThis.fetch;
  let providerRequestBody;
  globalThis.fetch = async (url, init) => {
    const request = url instanceof Request ? url : new Request(url, init);
    providerRequestBody = JSON.parse(await request.text());
    return new Response(JSON.stringify({
      id: "chatcmpl_truncated",
      object: "chat.completion",
      created: 1,
      model: "budget-fixture",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "{\"schemaVersion\":" },
        finish_reason: "length",
        logprobs: null
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: PILOT_PROVIDER_MAX_OUTPUT_TOKENS,
        total_tokens: 10 + PILOT_PROVIDER_MAX_OUTPUT_TOKENS
      }
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(
      new runpod.RunpodOpenAICompatibleModelClient(
        clientConfiguration(), credential
      ).execute(modelRequest, {}),
      (error) => error.code === "MODEL_RESPONSE_INVALID"
    );
    assert.equal(providerRequestBody.max_tokens, 1_024);
    assert.equal(providerRequestBody.response_format.type, "json_schema");
    assert.deepEqual(
      providerRequestBody.response_format.json_schema.schema,
      modelRequest.outputSchema
    );
    await assert.rejects(
      new runpod.RunpodOpenAICompatibleModelClient(
        clientConfiguration({ structuredOutputMode: "json_object" }), credential
      ).execute(modelRequest, {}),
      (error) => error.code === "MODEL_RESPONSE_INVALID"
    );
    assert.deepEqual(providerRequestBody.response_format, { type: "json_object" });
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: "schema unsupported" }
    }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
    await assert.rejects(
      new runpod.RunpodOpenAICompatibleModelClient(
        clientConfiguration(), credential
      ).execute(modelRequest, {}),
      (error) => error.code === "STRUCTURED_OUTPUT_UNSUPPORTED"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const validOnly = process.env.CONTROLLED_PILOT_VALID_ONLY === "1";
  if (!validOnly) {
  const noCalls = { calls: 0 };
  const dry = await runControlledCodingPilot({
    sourceRoot: root,
    output: join(temporary, "dry"),
    modelClient: client("valid", noCalls)
  });
  assert.equal(dry.status, "dry_run");
  assert.equal(noCalls.calls, 0);
  assert.equal(dry.providerCallCount, 0);

  for (const [name, executeProvider, confirmLive] of [
    ["missing-execute", false, true],
    ["missing-confirm", true, false]
  ]) {
    const guarded = await runControlledCodingPilot({
      sourceRoot: root,
      output: join(temporary, name),
      executeProvider,
      confirmLive,
      modelClient: client("valid", { calls: 0 })
    });
    assert.equal(guarded.failureCode, "PILOT_CONFIRMATION_REQUIRED");
    assert.equal(guarded.providerCallCount, 0);
  }

  const missingProvider = await runControlledCodingPilot({
    sourceRoot: root,
    output: join(temporary, "missing-provider"),
    executeProvider: true,
    confirmLive: true,
    environment: {}
  });
  assert.equal(missingProvider.failureCode, "PILOT_PROVIDER_CONFIGURATION_MISSING");

  const truncatedCounter = { calls: 0 };
  const truncatedPilot = await runControlledCodingPilot({
    sourceRoot: root,
    output: join(temporary, "truncated-provider"),
    executeProvider: true,
    confirmLive: true,
    modelId: "fake-qwen2.5-coder-7b",
    modelClient: {
      async execute() {
        truncatedCounter.calls += 1;
        const error = new Error("truncated content must not be accepted");
        error.code = "MODEL_RESPONSE_INVALID";
        throw error;
      }
    }
  });
  assert.equal(truncatedCounter.calls, 1);
  assert.equal(truncatedPilot.failureCode, "PILOT_MODEL_RESPONSE_INVALID");
  assert.equal(
    truncatedPilot.providerDiagnostic.executorDiagnosticCode,
    "EXECUTOR_PROVIDER_RESPONSE_INVALID"
  );

  for (const [mode, expected] of [
    ["path-selection", "PILOT_MODEL_RESPONSE_INVALID"],
    ["operation-selection", "PILOT_MODEL_RESPONSE_INVALID"],
    ["hash-selection", "PILOT_MODEL_RESPONSE_INVALID"],
    ["anchor-selection", "PILOT_MODEL_RESPONSE_INVALID"],
    ["description-newline", "PILOT_MODEL_RESPONSE_INVALID"],
    ["description-empty", "PILOT_MODEL_RESPONSE_INVALID"],
    ["description-overlength", "PILOT_MODEL_RESPONSE_INVALID"],
    ["description-extra", "PILOT_MODEL_RESPONSE_INVALID"],
    ["malformed", "PILOT_MODEL_RESPONSE_INVALID"],
    ["code-fenced", "PILOT_MODEL_RESPONSE_INVALID"]
  ]) {
    const counter = { calls: 0 };
    const failed = await runControlledCodingPilot({
      sourceRoot: root,
      output: join(temporary, mode),
      executeProvider: true,
      confirmLive: true,
      modelClient: client(mode, counter),
      modelId: "fake-qwen2.5-coder-7b"
    });
    assert.equal(failed.status, "failed", `${mode}: ${JSON.stringify(failed)}`);
    assert.equal(failed.failureCode, expected, mode);
    assert.equal(counter.calls, 1);
    assert.equal(failed.artifactValid, false);
    assert.equal(failed.cleanupCompleted, true);
    assert.equal(failed.githubMutationObserved, false);
  }

  const cancelledController = new AbortController();
  cancelledController.abort();
  const cancelled = await runControlledCodingPilot({
    sourceRoot: root,
    output: join(temporary, "cancelled"),
    executeProvider: true,
    confirmLive: true,
    modelClient: client("valid", { calls: 0 }),
    abortSignal: cancelledController.signal
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cleanupCompleted, true);

  assert.throws(
    () => validateDefinition({ schemaVersion: "invalid" }),
    (error) => error.pilotCode === "PILOT_DEFINITION_INVALID"
  );
  }

  const validCounter = { calls: 0 };
  const valid = await runControlledCodingPilot({
    sourceRoot: root,
    output: join(temporary, "valid"),
    executeProvider: true,
    confirmLive: true,
    modelClient: client("valid", validCounter),
    modelId: "fake-qwen2.5-coder-7b"
  });
  assert.equal(valid.status, "completed", JSON.stringify(valid));
  assert.equal(validCounter.calls, 1);
  assert.equal(valid.providerCallCount, 1);
  assert.equal(valid.retryCount, 0);
  assert.equal(validCounter.lastRequest.remainingRuntimeMs, PILOT_EXECUTION_RUNTIME_MS);
  assert.equal(
    validCounter.lastRequest.outputTokenLimit,
    PILOT_EXECUTOR_OUTPUT_TOKEN_LIMIT
  );
  assert.deepEqual(validCounter.lastRequest.outputSchema.required, [
    "schemaVersion", "descriptions"
  ]);
  assert.equal(
    validCounter.lastRequest.outputSchema.properties.schemaVersion.const,
    "bounded.controlled-help-copy-output/v1"
  );
  assert.equal("mutations" in validCounter.lastRequest.outputSchema.properties, false);
  assert.deepEqual(Object.keys(validCounter.lastRequest.outputSchema.properties).sort(), [
    "descriptions", "schemaVersion"
  ]);
  assert.equal(validCounter.lastRequest.outputSchema.properties.descriptions
    .additionalProperties, false);
  assert.equal(validCounter.lastRequest.instruction.includes(sourceBefore), false);
  const liveInsertionInstruction = JSON.parse(validCounter.lastRequest.instruction);
  assert.equal(liveInsertionInstruction.role,
    "Return only bounded help-copy descriptions matching the strict schema.");
  assert.ok(PILOT_PROVIDER_TIMEOUT_MS <= validCounter.lastRequest.remainingRuntimeMs);
  assert.ok(
    PILOT_PROVIDER_MAX_OUTPUT_TOKENS <= validCounter.lastRequest.outputTokenLimit
  );
  assert.deepEqual(valid.changedFiles, [TARGET]);
  assert.ok(valid.patchLineCount > 0 && valid.patchLineCount <= 60);
  const targetSourceLines = sourceBefore.split(/\r?\n/).length;
  const expectedMaterializationBudget = 2 * targetSourceLines + 120;
  assert.equal(expectedMaterializationBudget, 820);
  assert.deepEqual(valid.providerDiagnostic, {
    proposedPatchLines: valid.patchLineCount,
    maxPatchLines: 120,
    executorMutationLineBudget: expectedMaterializationBudget,
    perFilePatchLines: {
      [TARGET]: valid.patchLineCount
    },
    boundedEditCounts: null,
    boundedEdits: null,
    rejectedCandidateArtifacts: {
      patch: "rejected-candidate.patch",
      providerOutput: null
    }
  });
  assert.equal(valid.authorityPassed, true);
  assert.equal(valid.verifierPassed, true);
  assert.equal(valid.artifactProduced, true);
  assert.equal(valid.artifactValid, true);
  assert.equal(valid.sourceWorktreeMutated, false);
  assert.equal(valid.githubMutationObserved, false);
  assert.equal(valid.budgetExceeded, false);
  assert.equal(valid.cleanupCompleted, true);
  const reportText = await readFile(join(temporary, "valid", "pilot-report.json"), "utf8");
  assert.equal(reportText.includes("acceptance-secret-not-for-report"), false);
  assert.equal(reportText.includes("fixture-value"), false);
  assert.equal(await readFile(join(root, TARGET), "utf8"), sourceBefore);

  const previousDebug = process.env.CONTROLLED_PILOT_DEBUG;
  process.env.CONTROLLED_PILOT_DEBUG = "1";
  let debugOutput = "";
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk) => {
    debugOutput += String(chunk);
    return true;
  });
  const rejected = await runControlledCodingPilot({
    sourceRoot: root,
    output: join(temporary, "provider-rejected"),
    executeProvider: true,
    confirmLive: true,
    modelId: "fake-qwen2.5-coder-7b",
    modelClient: {
      async execute() {
        const error = new Error("sensitive detail must not be reported");
        error.code = "REQUEST_REJECTED";
        throw error;
      }
    }
  });
  process.stderr.write = originalStderrWrite;
  if (previousDebug === undefined) delete process.env.CONTROLLED_PILOT_DEBUG;
  else process.env.CONTROLLED_PILOT_DEBUG = previousDebug;
  assert.equal(rejected.failureCode, "PILOT_PROVIDER_CALL_FAILED");
  assert.deepEqual(rejected.providerDiagnostic, {
    executorMutationLineBudget: 2 * sourceBefore.split(/\r?\n/).length + 120,
    executorDiagnosticCode: "EXECUTOR_PROVIDER_REJECTED"
  });
  const parsedDebug = JSON.parse(debugOutput.trim().split("\n").at(-1));
  assert.deepEqual(parsedDebug, rejected.providerDiagnostic);
  assert.equal(debugOutput.includes("fixture-value"), false);
  assert.equal(debugOutput.includes("sensitive detail must not be reported"), false);

  const equivalent = await runControlledCodingPilot({
    sourceRoot: root,
    output: join(temporary, "equivalent"),
    executeProvider: true,
    confirmLive: true,
    modelClient: client("valid", { calls: 0 }),
    modelId: "fake-qwen2.5-coder-7b"
  });
  assert.equal(equivalent.status, "completed");
  assert.equal(equivalent.reportHash, valid.reportHash);

  const { runPilotV2Smoke } = require("./controlled-coding-pilot-v2-smoke.cjs");
  const pilotV2 = await runPilotV2Smoke(root, { validOnly });
  assert.equal(pilotV2.ok, true);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "dry-run-zero-provider-calls",
      "provider-budget-fail-closed",
      "truncated-provider-response-rejected",
      "canonical-json-schema-forwarded",
      "json-schema-unsupported-fail-closed",
      "explicit-json-object-supported",
      "pilot-provider-budget-compatible",
      "derived-full-file-materialization-budget",
      "read-only-forbidden-lines-excluded",
      "bounded-help-copy-provider-schema",
      "provider-cannot-select-path-operation-hash-or-anchor",
      "unique-authorized-anchor",
      "deterministic-canonical-materialization",
      "declarations-byte-preserved",
      "max-insertion-lines-60",
      "semantic-121-lines-rejected",
      "safe-provider-debug-diagnostic",
      "precise-minimal-additive-task-prompt",
      "verifier-stage-failure-classification",
      "safe-verifier-diagnostic",
      "two-flag-guard",
      "provider-configuration",
      "disposable-current-head-checkout",
      "source-worktree-immutable",
      "authority-rejection",
      "patch-limit",
      "dependency-rejection",
      "strict-model-output",
      "deterministic-help-renderer-safe-escaping",
      "verifier-gate",
      "cleanup-failure-and-cancellation",
      "credential-redaction",
      "github-immutable",
      "valid-governed-artifact",
      "deterministic-report-hash",
      "help-side-effect-acceptance",
      ...pilotV2.checks
    ]
  }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
