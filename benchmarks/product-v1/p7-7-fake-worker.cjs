#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { spawn } = require("node:child_process");
let started = false;
process.on("message", (message) => {
  if (!message || message.type !== "start" || started) return;
  started = true;
  const { mode, grandchildFile } = message.payload || {};
  if (mode === "exit") {
    process.send({ type: "done" }, () => process.exit(0));
    return;
  }
  if (mode !== "hang" || typeof grandchildFile !== "string") process.exit(2);
  // This descendant and the parent both ignore cooperative SIGTERM.
  const descendant = spawn(process.execPath, ["-e",
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"
  ], { stdio: "ignore", detached: false });
  fs.writeFileSync(grandchildFile, String(descendant.pid));
  process.on("SIGTERM", () => {});
  process.send({ type: "event", value: { type: "ready", workerPid: process.pid, descendantPid: descendant.pid } });
  setInterval(() => {}, 1000);
});
