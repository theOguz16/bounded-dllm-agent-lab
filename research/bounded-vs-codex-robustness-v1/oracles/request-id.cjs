#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { join, resolve } = require("node:path");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function checkRequestIdAcceptance(repository) {
  const moduleUrl = pathToFileURL(join(
    repository,
    "dist/packages/worker-contract/src/index.js"
  ));
  moduleUrl.searchParams.set("pilot", "v2");
  const { createHttpWorkspaceWorkerClient } = await import(moduleUrl.href);
  const client = createHttpWorkspaceWorkerClient({
    baseUrl: "https://offline.invalid"
  });
  const originalFetch = globalThis.fetch;
  let responseRequestId = "matching-request";
  let responseKind = "refine";
  let fetchCalls = 0;

  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith("/health")) {
      return fakeResponse({ ok: true, workerName: "offline-worker", mode: "mock" });
    }
    const common = {
      requestId: responseRequestId,
      engineName: "offline-worker",
      latencyMs: 0
    };
    if (responseKind === "infill") {
      return fakeResponse({ ...common, region: "patch_draft", content: "bounded" });
    }
    if (responseKind === "resolve") {
      return fakeResponse({ ...common, conflictId: "conflict-1", resolution: "bounded" });
    }
    return fakeResponse({ ...common, workspace: {} });
  };

  try {
    const health = await client.health();
    assert.equal(health.ok, true);
    assert.equal(health.mode, "mock");

    responseKind = "refine";
    responseRequestId = "wrong-request";
    await assert.rejects(client.refine({ requestId: "refine-request", workspace: {} }));

    responseKind = "infill";
    responseRequestId = "wrong-request";
    await assert.rejects(client.infill({
      requestId: "infill-request", region: "patch_draft", prompt: "bounded"
    }));

    responseKind = "resolve";
    responseRequestId = "wrong-request";
    await assert.rejects(client.resolveConflict({
      requestId: "resolve-request", conflictId: "conflict-1", workspace: {}
    }));

    responseKind = "refine";
    responseRequestId = "matching-request";
    assert.equal((await client.refine({
      requestId: "matching-request", workspace: {}
    })).requestId, "matching-request");

    responseKind = "infill";
    assert.equal((await client.infill({
      requestId: "matching-request", region: "patch_draft", prompt: "bounded"
    })).requestId, "matching-request");

    responseKind = "resolve";
    assert.equal((await client.resolveConflict({
      requestId: "matching-request", conflictId: "conflict-1", workspace: {}
    })).requestId, "matching-request");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 7);
  return { ok: true, fetchCalls, realNetworkUsed: false };
}

function fakeResponse(value) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(value);
    }
  };
}

module.exports = { checkRequestIdAcceptance };

if (require.main === module) {
  checkRequestIdAcceptance(resolve(argument("--repository") ?? process.cwd()))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.code ?? error.message}\n`);
      process.exitCode = 1;
    });
}
