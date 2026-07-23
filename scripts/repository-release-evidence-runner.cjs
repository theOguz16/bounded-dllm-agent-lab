#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const mode = process.argv[2];
  if (mode !== "--report" && mode !== "--verify") {
    console.error(
      "usage: repository-release-evidence-runner.cjs --report|--verify"
    );
    process.exitCode = 2;
    return;
  }

  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );
  const matrix = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "docs/release/V0_1_GAP_CLOSURE_MATRIX.json"
      ),
      "utf8"
    )
  );
  const result =
    await runtime.runRepositoryReleaseEvidence({
      repositoryPath: process.cwd(),
      matrix
    });

  console.log(JSON.stringify(result, null, 2));

  if (mode === "--report") {
    process.exitCode =
      result.decision ===
        "repository_release_evidence_invalid"
        ? 2
        : 0;
    return;
  }

  process.exitCode =
    result.decision ===
      "repository_release_evidence_ready"
      ? 0
      : result.decision ===
          "repository_release_evidence_blocked"
        ? 1
        : 2;
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        decision:
          "repository_release_evidence_invalid",
        errors: [
          error instanceof Error
            ? error.message
            : "unknown_error"
        ]
      },
      null,
      2
    )
  );
  process.exitCode = 2;
});
