#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");
(async () => {
  const root = path.resolve(__dirname, "../..");
  const { runIsolatedAgentWorker } = await import(pathToFileURL(path.join(root,
    "dist/packages/integrations/src/isolated-agent-worker.js")).href);
  const result = await runIsolatedAgentWorker({
    workerPath: path.join(__dirname, "p7-7-fake-worker.cjs"),
    payload: { mode: "exit" }, environment: process.env,
    signal: new AbortController().signal,
    onEvent(event) { console.error("event", JSON.stringify(event)); }
  });
  console.log(JSON.stringify(result));
})().catch((error) => { console.error(error); process.exitCode = 1; });
