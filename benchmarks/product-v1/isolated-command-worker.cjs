#!/usr/bin/env node
"use strict";
const { spawn } = require("node:child_process");
let started = false;
let command = null;
function send(value) {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) return reject(new Error("parent disconnected"));
    process.send(value, (error) => error ? reject(error) : resolve());
  });
}
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "abort") {
    if (command && command.exitCode === null && command.signalCode === null) {
      try { command.kill("SIGTERM"); } catch { /* outer worker group escalates */ }
    }
    return;
  }
  if (message.type !== "start" || started) return;
  started = true;
  void (async () => {
    const payload = message.payload;
    if (!payload || typeof payload.command !== "string" || !Array.isArray(payload.args) ||
        typeof payload.cwd !== "string" || !Number.isSafeInteger(payload.maxBuffer) ||
        payload.maxBuffer < 1 || payload.maxBuffer > 64 * 1024 * 1024) {
      await send({ type: "error", code: "provider_stream_error_unknown" });
      process.exit(1);
    }
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let overflow = false;
    try {
      command = spawn(payload.command, payload.args, {
        cwd: payload.cwd, env: process.env, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"], detached: false
      });
      for (const [stream, append] of [
        [command.stdout, (chunk) => { stdout += chunk; }],
        [command.stderr, (chunk) => { stderr += chunk; }]
      ]) {
        stream.on("data", (chunk) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > payload.maxBuffer) {
            overflow = true;
            try { command.kill("SIGTERM"); } catch { /* supervisor escalates */ }
            return;
          }
          if (!overflow) append(chunk.toString("utf8"));
        });
      }
      command.once("error", async () => {
        try { await send({ type: "error", code: "provider_stream_error_unknown" }); }
        finally { process.exit(1); }
      });
      command.once("close", async (code, signal) => {
        try {
          if (overflow) {
            await send({ type: "error", code: "provider_stream_error_unknown" });
            process.exit(1);
          }
          await send({ type: "event", value: {
            type: "commandResult", status: code, signal, stdout, stderr
          } });
          await send({ type: "done" });
          process.exit(0);
        } catch { process.exit(1); }
      });
    } catch {
      try { await send({ type: "error", code: "provider_stream_error_unknown" }); }
      finally { process.exit(1); }
    }
  })();
});
