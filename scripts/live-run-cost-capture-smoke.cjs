#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  LIVE_ATTESTATION,
  runCapture
} = require(
  "./live-run-cost-capture.cjs"
);

function readJson(request) {
  return new Promise(
    (resolve, reject) => {
      let body = "";
      request.setEncoding("utf8");
      request.on(
        "data",
        (chunk) => {
          body += chunk;
        }
      );
      request.on(
        "end",
        () => {
          try {
            resolve(
              JSON.parse(body)
            );
          } catch (error) {
            reject(error);
          }
        }
      );
      request.on("error", reject);
    }
  );
}

function taskIdFromMessages(messages) {
  const text = messages
    .map((entry) => entry.content)
    .join("\n");
  const match =
    /TASK_ID:\s*([A-Za-z0-9._:-]+)/.exec(
      text
    );
  return match?.[1] ?? "unknown";
}

function roleFromMessages(messages) {
  const text = messages
    .map((entry) => entry.content)
    .join("\n");
  const match =
    /ROLE:\s*(planner|coder|verifier)/.exec(
      text
    );
  return match?.[1] ?? "unknown";
}

function contentFor(role, taskId) {
  if (role === "planner") {
    return JSON.stringify({
      selectedFiles: [
        taskId === "clamp-helper"
          ? "src/math.ts"
          : "src/text.ts"
      ],
      reason: "smallest sufficient context"
    });
  }
  if (role === "coder") {
    if (taskId === "clamp-helper") {
      return JSON.stringify({
        filePath: "src/math.ts",
        replacement: [
          "export function add(left: number, right: number): number {",
          "  return left + right;",
          "}",
          "",
          "export function clamp(value: number, min: number, max: number): number {",
          "  return Math.min(max, Math.max(min, value));",
          "}",
          ""
        ].join("\n")
      });
    }
    return JSON.stringify({
      filePath: "src/text.ts",
      replacement: [
        "export function identity(value: string): string {",
        "  return value;",
        "}",
        "",
        "export function normalizeTitle(value: string): string {",
        "  return value.trim().toLowerCase();",
        "}",
        ""
      ].join("\n")
    });
  }
  return JSON.stringify({
    decision: "approve",
    reason: "candidate matches task and file boundary"
  });
}

async function startServer({
  omitUsage = false
} = {}) {
  let sequence = 0;
  const server = http.createServer(
    async (request, response) => {
      try {
        const body =
          await readJson(request);
        const role =
          roleFromMessages(
            body.messages ?? []
          );
        const taskId =
          taskIdFromMessages(
            body.messages ?? []
          );
        const content =
          contentFor(role, taskId);
        const promptTokens =
          Math.max(
            1,
            Math.ceil(
              JSON.stringify(
                body.messages ?? []
              ).length / 4
            )
          );
        const completionTokens =
          Math.max(
            1,
            Math.ceil(
              content.length / 4
            )
          );
        sequence += 1;
        const payload = {
          id: `mock-${sequence}`,
          model: body.model,
          choices: [
            {
              message: {
                role: "assistant",
                content
              }
            }
          ],
          ...(omitUsage
            ? {}
            : {
                usage: {
                  prompt_tokens:
                    promptTokens,
                  completion_tokens:
                    completionTokens,
                  total_tokens:
                    promptTokens +
                    completionTokens
                }
              })
        };
        response.statusCode = 200;
        response.setHeader(
          "content-type",
          "application/json"
        );
        response.setHeader(
          "x-request-id",
          `mock-${sequence}`
        );
        response.end(
          JSON.stringify(payload)
        );
      } catch (error) {
        response.statusCode = 500;
        response.end(
          JSON.stringify({
            error: String(error)
          })
        );
      }
    }
  );

  await new Promise(
    (resolve) =>
      server.listen(
        0,
        "127.0.0.1",
        resolve
      )
  );
  const address =
    server.address();
  return {
    server,
    url:
      `http://127.0.0.1:${address.port}/v1/chat/completions`
  };
}

function config(url, overrides = {}) {
  return {
    providerUrl: url,
    providerId: "mock-provider",
    modelId: "mock-model",
    apiKey: "",
    temperature: 0,
    topP: 0.95,
    maxTokens: 512,
    timeoutMs: 30_000,
    inputNanoUsdPerToken: 2,
    outputNanoUsdPerToken: 6,
    priceSourceKind:
      "operator_configured",
    priceOperatorLabel:
      "af3b-local-fixture",
    evidenceClass:
      "deterministic_fixture",
    observationSource: "fixture",
    liveRequired: false,
    liveAttestation: "",
    allowReleaseWrite: false,
    capturedAt:
      "2026-07-23T09:00:00.000Z",
    captureId: "af3b-fixture-v1",
    repositoryRoot:
      fs.realpathSync(process.cwd()),
    ...overrides
  };
}

async function main() {
  let checks = 0;
  const check = async (
    name,
    callback
  ) => {
    console.log(`[run] ${name}`);
    await callback();
    checks += 1;
    console.log(`[ok] ${name}`);
  };

  await check(
    "fixture HTTP round-trip covers A B C with 18 observed invocations",
    async () => {
      const { server, url } =
        await startServer();
      try {
        const result =
          await runCapture(
            config(url)
          );
        assert.equal(
          result.decision,
          "live_run_cost_capture_ready"
        );
        assert.equal(
          result.summary.strategyCount,
          3
        );
        assert.equal(
          result.summary.taskCount,
          2
        );
        assert.equal(
          result.summary.invocationCount,
          18
        );
        assert.equal(
          result.summary
            .everyTaskAccepted,
          true
        );
      } finally {
        await new Promise(
          (resolve) =>
            server.close(resolve)
        );
      }
    }
  );

  await check(
    "deterministic fixture never becomes release claim evidence",
    async () => {
      const { server, url } =
        await startServer();
      try {
        const result =
          await runCapture(
            config(url)
          );
        assert.equal(
          result.evidenceClass,
          "deterministic_fixture"
        );
        assert.equal(
          result.releaseClaimEligible,
          false
        );
        assert.equal(
          result.releaseFiles,
          null
        );
      } finally {
        await new Promise(
          (resolve) =>
            server.close(resolve)
        );
      }
    }
  );

  await check(
    "direct context consumes more observed tokens than bounded strategies",
    async () => {
      const { server, url } =
        await startServer();
      try {
        const result =
          await runCapture(
            config(url)
          );
        const byStrategy =
          Object.fromEntries(
            result.report
              .strategyAggregates
              .map(
                (entry) => [
                  entry.strategy,
                  entry.observed
                    .totalTokens
                ]
              )
          );
        assert.ok(
          byStrategy
            .direct_large_context >
            byStrategy
              .fixed_bounded_context
        );
        assert.ok(
          byStrategy
            .direct_large_context >
            byStrategy
              .adaptive_bounded_context
        );
      } finally {
        await new Promise(
          (resolve) =>
            server.close(resolve)
        );
      }
    }
  );

  await check(
    "same provider model price and task set remain comparable",
    async () => {
      const { server, url } =
        await startServer();
      try {
        const result =
          await runCapture(
            config(url)
          );
        assert.equal(
          result.summary
            .sameProviderModelSet,
          true
        );
        assert.equal(
          result.summary
            .samePricingSnapshotSet,
          true
        );
        assert.equal(
          result.summary
            .allStrategiesPresent,
          true
        );
      } finally {
        await new Promise(
          (resolve) =>
            server.close(resolve)
        );
      }
    }
  );

  await check(
    "missing provider usage cannot become release eligible",
    async () => {
      const { server, url } =
        await startServer({
          omitUsage: true
        });
      try {
        const result =
          await runCapture(
            config(url)
          );
        assert.equal(
          result.releaseClaimEligible,
          false
        );
        assert.ok(
          result.report.ledgers.some(
            (ledger) =>
              ledger.totals
                .unavailableInvocationCount >
              0
          )
        );
      } finally {
        await new Promise(
          (resolve) =>
            server.close(resolve)
        );
      }
    }
  );

  await check(
    "live mode rejects missing operator attestation",
    async () => {
      const { server, url } =
        await startServer();
      try {
        await assert.rejects(
          () =>
            runCapture(
              config(url, {
                evidenceClass:
                  "observed_run",
                observationSource:
                  "live_provider_call",
                liveRequired: true,
                liveAttestation: ""
              })
            ),
          /attestation/
        );
      } finally {
        await new Promise(
          (resolve) =>
            server.close(resolve)
        );
      }
    }
  );

  await check(
    "live mode rejects zero price snapshot",
    async () => {
      const { server, url } =
        await startServer();
      try {
        await assert.rejects(
          () =>
            runCapture(
              config(url, {
                evidenceClass:
                  "observed_run",
                observationSource:
                  "live_provider_call",
                liveRequired: true,
                liveAttestation:
                  LIVE_ATTESTATION,
                inputNanoUsdPerToken: 0,
                outputNanoUsdPerToken: 0
              })
            ),
          /non-zero/
        );
      } finally {
        await new Promise(
          (resolve) =>
            server.close(resolve)
        );
      }
    }
  );

  await check(
    "fixture mode performs no release repository writes",
    async () => {
      const temporary =
        fs.realpathSync(
          fs.mkdtempSync(
            path.join(
              os.tmpdir(),
              "af3b-no-write-"
            )
          )
        );
      const { server, url } =
        await startServer();
      try {
        const before =
          fs.readdirSync(temporary);
        await runCapture(
          config(url, {
            repositoryRoot:
              temporary
          })
        );
        assert.deepEqual(
          fs.readdirSync(temporary),
          before
        );
      } finally {
        await new Promise(
          (resolve) =>
            server.close(resolve)
        );
        fs.rmSync(
          temporary,
          {
            recursive: true,
            force: true
          }
        );
      }
    }
  );

  await check(
    "runner source has no shell or Git mutation primitive",
    () => {
      const source =
        fs.readFileSync(
          path.resolve(
            "scripts/live-run-cost-capture.cjs"
          ),
          "utf8"
        );
      assert.equal(
        /node:child_process|execFile|execSync|spawn\s*\(|shell\s*:\s*true|git\s+(?:add|commit|push|update-ref)/i
          .test(source),
        false
      );
    }
  );

  console.log(
    `live run cost capture smoke passed (${checks} checks)`
  );
}

main().catch((error) => {
  console.error(
    error?.stack ?? String(error)
  );
  process.exitCode = 1;
});
