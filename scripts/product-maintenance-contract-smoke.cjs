#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");

const nodeMajor = Number(process.versions.node.split(".")[0]);
assert.equal(nodeMajor, 22, `Node 22 is required; received ${process.versions.node}`);
assert.equal(fs.readFileSync(".nvmrc", "utf8").trim(), "22");

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
assert.equal(typeof lock.lockfileVersion, "number");
assert(lock.lockfileVersion >= 3, "package-lock.json must use lockfileVersion >= 3");

for (const file of [
  "scripts/product-unit-smoke.cjs",
  "scripts/product-integration-smoke.cjs",
  "scripts/product-acceptance-smoke.cjs",
  "scripts/product-clean-clone.sh",
  "docs/THREAT_MODEL.md"
]) {
  assert(fs.existsSync(file), `Missing Gate 4 contract file: ${file}`);
}

console.log(JSON.stringify({
  ok: true,
  decision: "product_maintenance_contract_ready",
  nodeMajor,
  lockfileVersion: lock.lockfileVersion
}, null, 2));
