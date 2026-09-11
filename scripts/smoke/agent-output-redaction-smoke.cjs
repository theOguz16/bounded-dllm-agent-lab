#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");
const REDACTED = "[REDACTED]";

function request(overrides = {}) {
  return {
    runId: "redaction-run",
    agentId: "codex",
    workingDirectory: "/tmp/bounded-redaction-workspace",
    task: "Exercise output redaction.",
    model: "gpt-5.6-codex",
    reasoningEffort: "medium",
    mode: "coder",
    timeoutMs: 10_000,
    networkAllowed: false,
    sandboxMode: "workspace_write",
    ...overrides
  };
}

function fakeClient(events) {
  return {
    startThread() {
      return {
        async runStreamed() {
          return {
            events: (async function* () {
              for (const event of events) yield event;
            })()
          };
        }
      };
    }
  };
}

async function main() {
  const integrationsUrl = pathToFileURL(
    path.join(repoRoot, "dist/packages/integrations/src/index.js")
  ).href;
  const storeUrl = pathToFileURL(
    path.join(repoRoot, "dist/apps/cli/src/run-artifact-store.js")
  ).href;
  const integrations = await import(integrationsUrl);
  const store = await import(storeUrl);

  assert.equal(integrations.AGENT_OUTPUT_REDACTION_VERSION, "agent-output-redaction/v1");
  assert.equal(typeof integrations.createAgentOutputRedactor, "function");

  const knownEnvSecret = "fixture-known-credential-value-abc123";
  const explicitSecret = "fixture-explicit-secret-value-xyz789";
  const openAiKey = "sk-proj-abcdefghijklmnopqrstuvwx1234567890";
  const githubKey = "github_pat_abcdefghijklmnopqrstuvwx1234567890";
  const bearer = "bearer.token.value.abcdefghijklmnop";
  const privateKey = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "ZmFrZS1wcml2YXRlLWtleS1tYXRlcmlhbA==",
    "-----END RSA PRIVATE KEY-----"
  ].join("\n");

  const redactor = integrations.createAgentOutputRedactor({
    environment: {
      DATABASE_PASSWORD: knownEnvSecret,
      SAFE_LABEL: "keep-me"
    },
    secrets: [explicitSecret]
  });

  const rawText = [
    `known=${knownEnvSecret}`,
    `explicit=${explicitSecret}`,
    `api_key=${openAiKey}`,
    `github=${githubKey}`,
    `Bearer ${bearer}`,
    `Authorization: Bearer ${bearer}`,
    privateKey,
    "safe=keep-me"
  ].join("\n");
  const redactedText = redactor.redactText(rawText);
  for (const secret of [knownEnvSecret, explicitSecret, openAiKey, githubKey, bearer]) {
    assert.equal(redactedText.includes(secret), false, `secret remained in redacted text: ${secret}`);
  }
  assert.equal(redactedText.includes("BEGIN RSA PRIVATE KEY"), false);
  assert.equal(redactedText.includes("keep-me"), true);
  assert.match(redactedText, /\[REDACTED\]/);
  assert.equal(redactor.containsKnownCredentialValue(rawText), true);
  assert.equal(redactor.containsKnownCredentialValue(redactedText), false);

  const rawObject = {
    message: knownEnvSecret,
    authorization: `Bearer ${bearer}`,
    nested: { apiKey: openAiKey, safe: "visible" }
  };
  const redactedObject = redactor.redactValue(rawObject);
  assert.equal(rawObject.message, knownEnvSecret, "redaction must not mutate raw input before hashing/evidence use");
  assert.equal(redactedObject.message, REDACTED);
  assert.equal(redactedObject.authorization, REDACTED);
  assert.equal(redactedObject.nested.apiKey, REDACTED);
  assert.equal(redactedObject.nested.safe, "visible");

  // Raw semantic hashing remains a caller concern and happens before the
  // boundary redactor. This guard catches accidental in-place mutation/order changes.
  const rawHashBeforeRedaction = createHash("sha256").update(rawText).digest("hex");
  redactor.redactText(rawText);
  const rawHashAfterRedactionCall = createHash("sha256").update(rawText).digest("hex");
  assert.equal(rawHashAfterRedactionCall, rawHashBeforeRedaction);
  assert.notEqual(
    createHash("sha256").update(redactedText).digest("hex"),
    rawHashBeforeRedaction
  );

  const events = [
    { type: "thread.started", thread_id: "thread-redaction" },
    { type: "turn.started" },
    {
      type: "item.started",
      item: {
        id: "cmd-secret",
        type: "command_execution",
        command: `printf '${knownEnvSecret}'`,
        aggregated_output: "",
        status: "in_progress"
      }
    },
    {
      type: "item.completed",
      item: {
        id: "cmd-secret",
        type: "command_execution",
        command: `printf '${knownEnvSecret}'`,
        aggregated_output: `stderr Authorization: Bearer ${bearer}\n${openAiKey}\n${knownEnvSecret}`,
        exit_code: 0,
        status: "completed"
      }
    },
    {
      type: "item.completed",
      item: {
        id: "msg-secret",
        type: "agent_message",
        text: `Completed with ${knownEnvSecret} and Bearer ${bearer}`
      }
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 }
    }
  ];
  let clock = 1000;
  const adapter = new integrations.CodexAgentAdapter({
    environment: { OPENAI_API_KEY: knownEnvSecret },
    clientFactory: () => fakeClient(events),
    now: () => (clock += 5)
  });
  const adapterResult = await adapter.run(request());
  assert.equal(adapterResult.status, "completed");
  assert.equal(adapterResult.finalMessage.includes(knownEnvSecret), false);
  assert.equal(adapterResult.finalMessage.includes(bearer), false);
  assert.match(adapterResult.finalMessage, /\[REDACTED\]/);
  assert.equal(adapterResult.commands.length, 1);
  assert.equal(adapterResult.commands[0].command.includes(knownEnvSecret), false);
  assert.equal(adapterResult.commands[0].output.includes(knownEnvSecret), false);
  assert.equal(adapterResult.commands[0].output.includes(openAiKey), false);
  assert.equal(adapterResult.commands[0].output.includes(bearer), false);

  const errorAdapter = new integrations.CodexAgentAdapter({
    environment: { CODEX_ACCESS_TOKEN: knownEnvSecret },
    clientFactory: () => ({
      startThread() {
        return {
          async runStreamed() {
            throw new Error(`provider stderr: Authorization: Bearer ${bearer}; credential=${knownEnvSecret}`);
          }
        };
      }
    }),
    now: () => 2000
  });
  const errorResult = await errorAdapter.run(request({ runId: "redaction-error" }));
  const diagnosticText = errorResult.diagnostics.map((entry) => entry.message).join("\n");
  assert.equal(diagnosticText.includes(knownEnvSecret), false);
  assert.equal(diagnosticText.includes(bearer), false);
  assert.match(diagnosticText, /\[REDACTED\]/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-redaction-artifact-"));
  try {
    const repository = path.join(root, "repository");
    await fs.mkdir(path.join(repository, ".bounded"), { recursive: true });
    const artifactInput = {
      repositoryRoot: repository,
      runId: "redaction-artifact",
      run: {
        command: "codex",
        message: knownEnvSecret,
        agentMessage: `Bearer ${bearer}`
      },
      candidateDiff: [
        `+const key = "${openAiKey}";`,
        `+const auth = "Authorization: Bearer ${bearer}";`,
        `+const pem = ${JSON.stringify(privateKey)};`
      ].join("\n"),
      receipt: { authorization: `Bearer ${bearer}`, note: explicitSecret },
      telemetry: { stderr: `credential=${knownEnvSecret}`, inputTokens: 42 },
      validation: { diagnostic: `api_key=${githubKey}` },
      secrets: [explicitSecret],
      environment: {
        OPENAI_API_KEY: knownEnvSecret,
        DATABASE_PASSWORD: "another-known-password-123456"
      }
    };
    const stored = await store.storeProductRunArtifact(artifactInput);
    assert.equal(artifactInput.run.message, knownEnvSecret, "artifact redaction must not mutate caller input");

    const files = await fs.readdir(stored.directoryPath);
    const persisted = (await Promise.all(
      files.map((file) => fs.readFile(path.join(stored.directoryPath, file), "utf8"))
    )).join("\n");
    for (const secret of [knownEnvSecret, explicitSecret, openAiKey, githubKey, bearer]) {
      assert.equal(persisted.includes(secret), false, `raw secret reached artifact path: ${secret}`);
    }
    assert.equal(persisted.includes("BEGIN RSA PRIVATE KEY"), false);
    assert.match(persisted, /\[REDACTED\]/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: integrations.AGENT_OUTPUT_REDACTION_VERSION,
    apiKeysRedacted: true,
    bearerTokensRedacted: true,
    authorizationHeadersRedacted: true,
    privateKeysRedacted: true,
    knownCredentialEnvironmentValuesRedacted: true,
    agentMessagesRedacted: true,
    commandOutputRedacted: true,
    diagnosticsAndStderrRedacted: true,
    runArtifactsRedacted: true,
    rawInputsNotMutatedBeforeHashing: true
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
