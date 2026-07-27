#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const commands = [
  ["scripts/runtime-contract-foundation-smoke.cjs"],
  ["scripts/deterministic-verifier-v2-smoke.cjs"]
];

for (const [script] of commands) {
  const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(JSON.stringify({
  ok: true,
  decision: "product_integration_ready",
  suiteCount: commands.length
}, null, 2));
