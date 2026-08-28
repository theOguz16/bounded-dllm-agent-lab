#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

async function checkLocalJsonSchemaAcceptance(repository = process.cwd()) {
  const mod = await import(pathToFileURL(resolve(
    repository,
    "dist/packages/integrations/src/local-openai-compatible-model-client.js"
  )).href);

  const credential = {
    async getCredential() {
      return "local-fixture-key";
    }
  };

  const request = {
    modelId: "fixture-model",
    instruction: "{}",
    instructionHash: `sha256:${"1".repeat(64)}`,
    requestKey: `sha256:${"2".repeat(64)}`,
    outputSchema: { type: "object" },
    outputTokenLimit: 128,
    maxOutputBytes: 10_000,
    remainingRuntimeMs: 2_000
  };

  const originalFetch = globalThis.fetch;

  async function expect400(errorBody, expectedCode, mode = "json_schema") {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: errorBody }),
      {
        status: 400,
        headers: { "content-type": "application/json" }
      }
    );

    let captured;
    try {
      const client = new mod.LocalOpenAICompatibleModelClient({
        schemaVersion: mod.LOCAL_OPENAI_MODEL_CLIENT_VERSION,
        modelId: "fixture-model",
        endpoint: {
          type: "custom_openai_compatible",
          baseUrl: "http://127.0.0.1:8000/v1"
        },
        structuredOutputMode: mode,
        requestTimeoutMs: 1_000,
        temperature: 0,
        maxOutputTokens: 128
      }, credential);

      await client.execute(request, {});
    } catch (error) {
      captured = error;
    }

    assert.ok(captured, `expected ${expectedCode}`);
    assert.equal(captured.code, expectedCode);
    assert.equal(
      /^LOCAL_|^RUNPOD_/.test(String(captured.code)),
      false,
      "provider-specific error codes must not cross the model-client execution boundary"
    );
  }

  try {
    await expect400({
      message: "response_format type json_schema is not supported by this server",
      type: "invalid_request_error",
      param: "response_format",
      code: "unsupported_value"
    }, "STRUCTURED_OUTPUT_UNSUPPORTED");

    await expect400({
      message: "Invalid request: messages is required",
      type: "invalid_request_error",
      param: "messages",
      code: "invalid_request_error"
    }, "REQUEST_REJECTED");

    await expect400({
      message: "Invalid schema for response_format bounded_coding_executor_output: expected object schema",
      type: "invalid_request_error",
      param: "response_format",
      code: "invalid_json_schema"
    }, "REQUEST_REJECTED");

    await expect400({
      message: "response_format type json_schema is not supported by this server",
      type: "invalid_request_error",
      param: "response_format",
      code: "unsupported_value"
    }, "REQUEST_REJECTED", "json_object");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

module.exports = { checkLocalJsonSchemaAcceptance };

if (require.main === module) {
  const index = process.argv.indexOf("--repository");
  const repository = index >= 0 ? process.argv[index + 1] : process.cwd();

  checkLocalJsonSchemaAcceptance(repository).then(() => {
    process.stdout.write("local json-schema error classification: PASS\n");
  }).catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
