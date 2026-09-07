#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const text = fs.readFileSync("action.yml", "utf8");
const lines = text.split(/\r?\n/);
let inRun = false;
for (const line of lines) {
  if (/^\s+run:\s*\|\s*$/.test(line)) { inRun = true; continue; }
  if (inRun && /^\s{4}\S/.test(line)) inRun = false;
  if (inRun) assert.equal(/\$\{\{\s*inputs\./.test(line), false,
    `user input expression appears inside shell run block: ${line.trim()}`);
}
assert.equal(text.includes("eval "), false);
process.stdout.write("action input safety smoke: PASS\n");
