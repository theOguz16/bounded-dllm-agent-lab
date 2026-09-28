#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, readdirSync } = require("node:fs");
const { createServer } = require("node:http");
const { join, resolve } = require("node:path");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function tree(root) {
  if (!existsSync(root)) return [];
  const walk = (directory, prefix = "") => readdirSync(directory, {
    withFileTypes: true
  }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? [relative, ...walk(join(directory, entry.name), relative)]
      : [relative];
  });
  return walk(root).sort();
}

async function listen(server, port = 0) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function portAvailable() {
  const server = createServer();
  try {
    await listen(server, 8790);
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await close(server);
  }
}

async function checkHelpAcceptance(repository) {
  const executable = join(
    repository,
    "dist/apps/cli/src/model-worker-runpod-live-smoke.js"
  );
  const reportDirectory = join(repository, "reports");
  const beforeReports = tree(reportDirectory);
  assert.equal(await portAvailable(), true, "port 8790 must be free before acceptance");

  let upstreamRequestCount = 0;
  const sentinel = () => createServer((request, response) => {
    upstreamRequestCount += 1;
    request.resume();
    response.writeHead(503, { "content-type": "application/json" });
    response.end("{}");
  });
  const llm = sentinel();
  const dllm = sentinel();
  const llmPort = await listen(llm);
  const dllmPort = await listen(dllm);
  const environment = {
    ...process.env,
    LLM_UPSTREAM_URL: `http://127.0.0.1:${llmPort}/v1/chat/completions`,
    DLLM_UPSTREAM_URL: `http://127.0.0.1:${dllmPort}/v1/chat/completions`,
    LLM_MODEL_ID: "acceptance-llm",
    DLLM_MODEL_ID: "acceptance-dllm",
    LLM_UPSTREAM_API_KEY: "acceptance-secret-not-for-report",
    DLLM_UPSTREAM_API_KEY: "acceptance-secret-not-for-report",
    RUNPOD_LIVE_REQUIRED: "1",
    MODEL_WORKER_PROXY_HOST: "127.0.0.1",
    MODEL_WORKER_PROXY_PORT: "8790"
  };
  const required = [
    "model-worker-runpod-live-smoke", "--help", "-h",
    "LLM_UPSTREAM_URL", "DLLM_UPSTREAM_URL", "LLM_MODEL_ID",
    "DLLM_MODEL_ID", "RUNPOD_LIVE_REQUIRED", "127.0.0.1", "8790"
  ];
  try {
    for (const flag of ["--help", "-h"]) {
      const result = spawnSync(process.execPath, [executable, flag], {
        cwd: repository,
        encoding: "utf8",
        env: environment,
        timeout: 10_000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `${flag} must exit zero`);
      for (const token of required) {
        assert.ok(result.stdout.includes(token), `${flag} help is missing ${token}`);
      }
    }
  } finally {
    await close(llm);
    await close(dllm);
  }
  assert.equal(upstreamRequestCount, 0, "help must not contact upstreams");
  assert.deepEqual(tree(reportDirectory), beforeReports, "help must not create reports");
  assert.equal(await portAvailable(), true, "help must not leave port 8790 bound");
  return {
    ok: true,
    upstreamRequestCount,
    helpFlags: ["--help", "-h"],
    reportsChanged: false,
    proxyPortReleased: true
  };
}

module.exports = { checkHelpAcceptance, portAvailable, tree };

if (require.main === module) {
  checkHelpAcceptance(resolve(argument("--repository") ?? process.cwd()))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.code ?? error.message}\n`);
      process.exitCode = 1;
    });
}
