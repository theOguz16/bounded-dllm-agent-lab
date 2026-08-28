#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) =>
    error ? reject(error) : resolve()
  ));
}

(async () => {
  let observedRequest = null;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        observedRequest = {
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          idempotencyKey: request.headers["idempotency-key"],
          body
        };
        const output = {
          schemaVersion: "bounded.loopback-smoke-output/v1",
          accepted: true
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "chatcmpl_loopback_fixture",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: JSON.stringify(output) },
            finish_reason: "stop",
            logprobs: null
          }],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 }
        }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
  });

  try {
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const local = await import(
      "../dist/packages/integrations/src/local-openai-compatible-model-client.js"
    );
    const modelId = "controlled-pilot-loopback-fixture";
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const credentialProvider = {
      async getCredential() {
        return "loopback-fixture-credential";
      }
    };
    const client = new local.LocalOpenAICompatibleModelClient({
      schemaVersion: local.LOCAL_OPENAI_MODEL_CLIENT_VERSION,
      modelId,
      endpoint: { type: "custom_openai_compatible", baseUrl },
      structuredOutputMode: "json_schema",
      requestTimeoutMs: 5_000,
      temperature: 0,
      maxOutputTokens: 128
    }, credentialProvider);

    const outputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "accepted"],
      properties: {
        schemaVersion: {
          type: "string",
          const: "bounded.loopback-smoke-output/v1"
        },
        accepted: { type: "boolean" }
      }
    };
    const instruction = JSON.stringify({ task: "offline-loopback-transport-smoke" });
    const requestKey = hash("controlled-pilot-loopback-request");
    const result = await client.execute({
      modelId,
      instruction,
      instructionHash: hash(instruction),
      requestKey,
      outputSchema,
      outputTokenLimit: 256,
      maxOutputBytes: 4_096,
      remainingRuntimeMs: 10_000
    }, {});

    assert.deepEqual(result.output, {
      schemaVersion: "bounded.loopback-smoke-output/v1",
      accepted: true
    });
    assert.deepEqual(result.usage, {
      inputTokens: 7,
      outputTokens: 5,
      totalTokens: 12
    });
    assert.equal(result.providerRequestId, "chatcmpl_loopback_fixture");
    assert.ok(observedRequest, "loopback server must receive one request");
    assert.equal(observedRequest.method, "POST");
    assert.equal(observedRequest.url, "/v1/chat/completions");
    assert.equal(observedRequest.authorization, "Bearer loopback-fixture-credential");
    assert.equal(observedRequest.idempotencyKey, requestKey);
    assert.equal(observedRequest.body.model, modelId);
    assert.equal(observedRequest.body.stream, false);
    assert.equal(observedRequest.body.n, 1);
    assert.equal(observedRequest.body.temperature, 0);
    assert.equal(observedRequest.body.max_tokens, 128);
    assert.equal(observedRequest.body.response_format.type, "json_schema");
    assert.deepEqual(
      observedRequest.body.response_format.json_schema.schema,
      outputSchema
    );
    assert.equal(
      observedRequest.body.messages.at(-1).content,
      instruction
    );

    process.stdout.write("controlled pilot loopback transport smoke: PASS\n");
  } finally {
    await close(server);
  }
})().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
