#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { fork } = require("node:child_process");
(async () => {
  const root = path.resolve(__dirname, "../..");
  const workerPath = path.join(__dirname, "p7-7-fake-worker.cjs");
  const direct = fork(workerPath, [], {
    detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: process.env, execArgv: []
  });
  direct.stderr.on("data", (chunk) => console.error("fake-stderr", String(chunk).slice(-1500)));
  direct.on("message", (message) => console.error("fake-message", JSON.stringify(message)));
  direct.on("error", (error) => console.error("fake-error-code", error.code));
  const directExit = new Promise((resolve) => direct.once("exit", (code, signal) => resolve({ code, signal })));
  direct.send({ type: "start", payload: { mode: "exit" } });
  console.log("direct-exit", JSON.stringify(await directExit));
  const { runIsolatedAgentWorker } = await import(pathToFileURL(path.join(root,
    "dist/packages/integrations/src/isolated-agent-worker.js")).href);
  const result = await runIsolatedAgentWorker({
    workerPath, payload: { mode: "exit" }, environment: process.env,
    signal: new AbortController().signal,
    onEvent(event) { console.error("event", JSON.stringify(event)); }
  });
  console.log("supervised-result", JSON.stringify(result));
})().catch((error) => { console.error(error); process.exitCode = 1; });
