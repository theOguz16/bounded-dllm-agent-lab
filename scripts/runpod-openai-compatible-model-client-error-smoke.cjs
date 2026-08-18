#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

(async () => {
  const runpod = await import(
    "../dist/packages/integrations/src/runpod-openai-compatible-model-client.js"
  );
  const originalFetch = globalThis.fetch;
  const redactionSentinel = "runpod-redaction-sentinel";
  const credential = { async getCredential() { return redactionSentinel; } };
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
  const configuration = (overrides = {}) => ({
    schemaVersion: runpod.RUNPOD_MODEL_CLIENT_VERSION,
    modelId: "fixture-model",
    endpoint: {
      type: "custom_openai_compatible",
      baseUrl: "https://fixture.invalid/v1"
    },
    structuredOutputMode: "json_schema",
    requestTimeoutMs: 1_000,
    temperature: 0,
    maxOutputTokens: 128,
    ...overrides
  });
  const client = (overrides = {}) => new runpod.RunpodOpenAICompatibleModelClient(
    configuration(overrides), credential
  );

  async function expectCode(fetchImplementation, code, overrides = {}) {
    let calls = 0;
    globalThis.fetch = async (...args) => {
      calls += 1;
      return fetchImplementation(...args);
    };
    let captured;
    try {
      await client(overrides).execute(request, {});
    } catch (error) {
      captured = error;
    }
    assert.ok(captured, `expected ${code}`);
    assert.equal(captured.code, code);
    assert.equal(calls, 1, `${code} must use one provider call`);
    const diagnostic = `${String(captured)}\n${JSON.stringify(captured)}\n${captured.stack ?? ""}`;
    assert.equal(diagnostic.includes(redactionSentinel), false, `${code} exposed the credential`);
    assert.ok(diagnostic.length < 10_000, `${code} diagnostic was unbounded`);
  }

  const jsonError = (status, error) => async () => new Response(
    JSON.stringify({ error }),
    { status, headers: { "content-type": "application/json" } }
  );

  try {
    for (const response of [
      async () => new Response("", { status: 404 }),
      async () => new Response(`<html><body>proxy 404 ${redactionSentinel}</body></html>`, {
        status: 404,
        headers: { "content-type": "text/html" }
      }),
      jsonError(404, { message: "Not Found" }),
      jsonError(404, { message: "Proxy route unavailable" }),
      jsonError(404, { message: "Proxy route for model fixture-model was not found" })
    ]) {
      await expectCode(response, "RUNPOD_ENDPOINT_NOT_FOUND");
    }

    await expectCode(jsonError(404, {
      message: "The requested model fixture-model was not found.",
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found"
    }), "RUNPOD_MODEL_NOT_FOUND");

    for (const [status, code] of [
      [401, "RUNPOD_AUTH_FAILED"],
      [403, "RUNPOD_AUTH_FAILED"],
      [408, "RUNPOD_REQUEST_TIMEOUT"],
      [429, "RUNPOD_RATE_LIMITED"],
      [500, "RUNPOD_UPSTREAM_SERVER_ERROR"],
      [502, "RUNPOD_PROXY_BAD_GATEWAY"],
      [503, "RUNPOD_PROXY_UNAVAILABLE"],
      [504, "RUNPOD_PROXY_TIMEOUT"]
    ]) {
      await expectCode(jsonError(status, { message: `safe fixture ${status}` }), code);
    }

    await expectCode(async () => {
      throw new TypeError(`connect failed ${redactionSentinel}`);
    }, "RUNPOD_NETWORK_ERROR");

    await expectCode((input, init) => new Promise((resolve, reject) => {
      const signal = input instanceof Request ? input.signal : init?.signal;
      assert.ok(signal, "timeout request signal missing");
      signal.addEventListener("abort", () => reject(
        signal.reason ?? new DOMException("request timed out", "AbortError")
      ), { once: true });
    }), "RUNPOD_REQUEST_TIMEOUT", { requestTimeoutMs: 25 });

    let successCalls = 0;
    let successRequest;
    globalThis.fetch = async (input, init) => {
      successCalls += 1;
      successRequest = input instanceof Request ? input : new Request(input, init);
      return new Response(JSON.stringify({
        id: "chatcmpl_fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "{\"ok\":true}" },
          finish_reason: "stop",
          logprobs: null
        }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "request_fixture"
        }
      });
    };
    const result = await client().execute(request, {});
    assert.deepEqual(result, {
      output: { ok: true },
      usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
      providerRequestId: "request_fixture"
    });
    assert.equal(successCalls, 1);
    const body = JSON.parse(await successRequest.clone().text());
    assert.equal(body.model, "fixture-model");
    assert.equal(body.max_tokens, 128);
    assert.equal(body.n, 1);
    assert.equal(body.stream, false);
    assert.equal(body.response_format.type, "json_schema");

    process.stdout.write("runpod provider error classification smoke: PASS\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
})().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
