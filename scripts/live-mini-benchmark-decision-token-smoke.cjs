#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  buildDecisionTokenMessages,
  parseDecisionToken
} = require("./live-mini-benchmark-decision-token.cjs");

function run(name, fn) {
  try {
    fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[fail] ${name}`);
    throw error;
  }
}

run("parses exact approve token", () => {
  const parsed = parseDecisionToken("approve");
  assert.equal(parsed.decision, "approve");
  assert.equal(parsed.tokenCompliant, true);
  assert.equal(parsed.decisionSource, "exact_token");
});

run("parses exact needs_review token", () => {
  const parsed = parseDecisionToken("needs_review");
  assert.equal(parsed.decision, "needs_review");
  assert.equal(parsed.tokenCompliant, true);
});

run("parses loose labeled decision without token compliance", () => {
  const parsed = parseDecisionToken("decision: reject because it touches infra");
  assert.equal(parsed.decision, "reject");
  assert.equal(parsed.tokenCompliant, false);
  assert.equal(parsed.decisionSource, "labeled_token");
});

run("marks missing decision token as unparseable", () => {
  const parsed = parseDecisionToken("I need to inspect the files first.");
  assert.equal(parsed.decision, null);
  assert.equal(parsed.tokenCompliant, false);
  assert.equal(parsed.decisionSource, "unparseable");
});

run("builds non-json compact decision token prompt", () => {
  const messages = buildDecisionTokenMessages({
    caseId: "token-smoke",
    riskType: "dependency_change",
    expectedDecisions: ["needs_review", "reject"],
    task: "Evaluate token mode.",
    candidate: {
      goal: "Fix helper bug.",
      allowedFiles: ["packages/example/src/index.ts"],
      forbiddenFiles: [".env"],
      proposedTouchedFiles: ["packages/example/src/index.ts", "package.json"],
      unresolvedConflicts: [],
      proposedAddedLines: ["Added dependency outside helper fix."]
    }
  });

  assert.equal(messages.length, 2);
  assert(messages[0].content.includes("Return exactly one token"));
  assert(messages[0].content.includes("Do not return JSON"));
  assert(messages[1].content.includes("CASE_ID: token-smoke"));
  assert(messages[1].content.includes("TOUCHED_FILES: packages/example/src/index.ts, package.json"));
  assert(!messages[1].content.trim().startsWith("{"));
});

console.log("live-mini-benchmark decision-token smoke passed");
