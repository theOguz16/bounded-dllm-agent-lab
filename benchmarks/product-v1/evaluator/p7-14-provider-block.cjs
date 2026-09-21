"use strict";
// Trusted preload; the historical runner must never reach a real provider.
// This is loaded from the evaluator checkout, never copied into the candidate.
const childProcess = require("node:child_process");
const SENTINEL = "P7_14_PROVIDER_INVOCATION_BLOCKED";
childProcess.spawnSync = function blockedProvider(command, args) {
  if (typeof command === "string" && Array.isArray(args) &&
      args.some((value) => typeof value === "string" && value.endsWith("dogfood-resumable-runner.cjs"))) {
    return { status: 79, signal: null, error: undefined,
      stdout: "", stderr: `${SENTINEL}\n` };
  }
  throw new Error("P7_14_UNEXPECTED_CHILD_PROCESS_BLOCKED");
};
childProcess.spawn = function blockedAsyncProvider() {
  throw new Error("P7_14_UNEXPECTED_ASYNC_PROCESS_BLOCKED");
};
childProcess.execFile = function blockedExecFileProvider() {
  throw new Error("P7_14_UNEXPECTED_EXEC_FILE_BLOCKED");
};
