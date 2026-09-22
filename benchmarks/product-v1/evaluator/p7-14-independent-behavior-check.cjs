"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const hash = (bytes) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;

/** Trusted, candidate-external check over the audited behavior-bearing files. */
function inspectBehavior(workspace, definition) {
  const observations = [];
  let pass = true;
  for (const expected of definition.files) {
    const target = path.resolve(workspace, expected.path);
    if (!target.startsWith(`${path.resolve(workspace)}${path.sep}`) || !fs.existsSync(target) ||
        !fs.statSync(target).isFile()) {
      observations.push({ path: expected.path, observedHash: null, expectedHash: expected.referenceHash });
      pass = false;
      continue;
    }
    const observedHash = hash(fs.readFileSync(target));
    observations.push({ path: expected.path, observedHash, expectedHash: expected.referenceHash });
    if (observedHash !== expected.referenceHash) pass = false;
  }
  const output = {
    taskId: definition.taskId,
    criterionId: definition.criterionId,
    behaviorCommand: definition.behaviorCommand,
    observations,
    result: pass ? "pass" : "assertion_fail"
  };
  return { verdict: output.result, exitCode: pass ? 0 : 1, output,
    outputHash: hash(JSON.stringify(output)) };
}

module.exports = { inspectBehavior };
