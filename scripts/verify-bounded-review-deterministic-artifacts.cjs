const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DETERMINISTIC_ARTIFACTS = Object.freeze([
  "reports/ag/AG2B_OPENAI_COMPATIBLE_PLANNER_PROVIDER.json",
  "reports/ag/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER.json"
]);
const SEMANTIC_VERIFIER = "npm run verify:ag3c";
const BYTE_VERIFIER = "canonical-json-serialization/v1";

function verifyDeterministicArtifacts(repositoryPath = process.cwd()) {
  const root = fs.realpathSync(repositoryPath);
  const before = new Map(DETERMINISTIC_ARTIFACTS.map((relative) => [
    relative,
    fs.readFileSync(path.join(root, relative))
  ]));

  run(root, npmCommand(), ["run", "verify:ag3c"]);

  const artifacts = DETERMINISTIC_ARTIFACTS.map((relative) => {
    const absolute = path.join(root, relative);
    const current = fs.readFileSync(absolute);
    const original = before.get(relative);
    if (!original || !current.equals(original)) {
      throw new Error(`Semantic verifier mutated deterministic artifact: ${relative}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(current.toString("utf8"));
    } catch {
      throw new Error(`Deterministic artifact is not valid JSON: ${relative}`);
    }
    const canonicalBytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    if (!current.equals(canonicalBytes)) {
      throw new Error(`Deterministic artifact bytes are not canonical: ${relative}`);
    }

    return {
      path: relative,
      sha256: `sha256:${createHash("sha256").update(current).digest("hex")}`
    };
  });

  return {
    schemaVersion: "bounded-review-deterministic-artifact-verification/v1",
    semanticVerifier: SEMANTIC_VERIFIER,
    byteVerifier: BYTE_VERIFIER,
    sourceMutationDetected: false,
    artifacts
  };
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Deterministic artifact semantic verification failed with status ${String(result.status)}.`);
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(verifyDeterministicArtifacts(), null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  BYTE_VERIFIER,
  DETERMINISTIC_ARTIFACTS,
  SEMANTIC_VERIFIER,
  verifyDeterministicArtifacts
};
