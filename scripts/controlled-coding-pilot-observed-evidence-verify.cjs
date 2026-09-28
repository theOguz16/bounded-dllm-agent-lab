#!/usr/bin/env node
"use strict";

const { verifyObservedEvidence } = require("./controlled-coding-pilot-observed-evidence.cjs");

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    const error = new Error("OBSERVED_EVIDENCE_VERIFY_ARGUMENT_INVALID");
    error.code = "OBSERVED_EVIDENCE_VERIFY_ARGUMENT_INVALID";
    throw error;
  }
  return value;
}

try {
  const bundleDir = argument("--bundle-dir");
  const expectedSourceCommit = argument("--expected-source-commit");
  const verified = verifyObservedEvidence({ bundleDir, expectedSourceCommit });
  process.stdout.write([
    "OBSERVED_EVIDENCE_VERIFY=PASS",
    `sourceCommit=${verified.sourceCommit}`,
    `experimentConfigHash=${verified.experimentConfigHash}`,
    `evidenceHash=${verified.evidenceHash}`,
    `runCount=${verified.runCount}`,
    ...Object.entries(verified.outcomes).map(([pilotId, status]) => `${pilotId}=${status}`)
  ].join("\n") + "\n");
} catch (error) {
  process.stderr.write([
    "OBSERVED_EVIDENCE_VERIFY=FAIL",
    `errorCode=${typeof error?.code === "string"
      ? error.code : "OBSERVED_EVIDENCE_VERIFY_INTERNAL_ERROR"}`,
    ...(typeof error?.relativePath === "string" ? [`relativePath=${error.relativePath}`] : [])
  ].join("\n") + "\n");
  process.exitCode = 1;
}
