#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const file = path.resolve(__dirname, "../../scripts/product/adversarial-agent-suite.cjs");
let text = fs.readFileSync(file, "utf8");
const before = `      assert.equal(result.status, "timed_out");\n      assert.equal(result.failureCode, "agent_timeout");\n      assert.equal(aborted, true);\n      return "agent_timeout";`;
const after = `      assert.equal(result.status, "timed_out");\n      assert.equal(result.failureCode, "provider_outcome_ambiguous");\n      assert.equal(result.diagnostics.some((entry) => entry.code === "agent_timeout"), true);\n      assert.equal(aborted, true);\n      return "provider_outcome_ambiguous";`;
if (!text.includes(before)) throw new Error("P7.7 adversarial timeout anchor missing");
if (text.indexOf(before) !== text.lastIndexOf(before)) throw new Error("P7.7 adversarial timeout anchor duplicated");
text = text.replace(before, after);
fs.writeFileSync(file, text);
console.log("P7.7 adversarial timeout expectation updated");
