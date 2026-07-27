#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const result = spawnSync(process.execPath, ["scripts/run-bounded-task-smoke.cjs"], {
  stdio: "inherit"
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(JSON.stringify({
  ok: true,
  decision: "product_acceptance_ready",
  suiteCount: 1
}, null, 2));
