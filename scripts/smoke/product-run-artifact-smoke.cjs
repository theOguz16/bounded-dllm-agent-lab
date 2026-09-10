#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-product-run-smoke-"));
  try {
    const repository = path.join(root, "repository");
    await fs.mkdir(path.join(repository, ".bounded"), { recursive: true });

    const runtime = await import(pathToFileURL(
      path.join(repoRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
    ).href);
    const store = await import(pathToFileURL(
      path.join(repoRoot, "dist/apps/cli/src/run-artifact-store.js")
    ).href);

    assert.equal(runtime.BOUNDED_PRODUCT_RUN_ARTIFACT_VERSION, "bounded-product-run/v1");
    assert.equal(typeof runtime.createProductRunArtifact, "function");
    assert.equal(typeof runtime.verifyProductRunArtifact, "function");
    assert.equal(typeof store.storeProductRunArtifact, "function");

    const environmentSecret = "sk-fixture-secret-value-1234567890";
    const explicitSecret = "explicit-fixture-password-value";
    const hardcodedRefreshSecret = "hardcoded-refresh-secret-value";
    const runId = "run-001";

    const stored = await store.storeProductRunArtifact({
      repositoryRoot: repository,
      runId,
      run: {
        command: "codex",
        taskId: "task-001",
        apiKey: environmentSecret,
        note: `provider=${environmentSecret}`
      },
      candidateDiff: [
        "diff --git a/src/auth.ts b/src/auth.ts",
        "--- a/src/auth.ts",
        "+++ b/src/auth.ts",
        "@@ -1 +1 @@",
        '-const refreshToken = "old";',
        `+const refreshToken = "${hardcodedRefreshSecret}";`,
        ""
      ].join("\n"),
      receipt: {
        outcome: "validated",
        password: explicitSecret
      },
      telemetry: {
        inputTokens: 11,
        outputTokens: 7,
        providerMessage: `credential ${environmentSecret}`
      },
      validation: {
        status: "passed",
        authorization: `Bearer ${environmentSecret}`
      },
      secrets: [explicitSecret],
      environment: { OPENAI_API_KEY: environmentSecret }
    });

    assert.equal(stored.artifact.artifactVersion, "bounded-product-run/v1");
    assert.equal(stored.artifact.runKind, "run");
    assert.equal(stored.artifact.files.comparison, null);
    assert.equal(runtime.verifyProductRunArtifact(stored.artifact), true);

    const directoryStat = await fs.stat(stored.directoryPath);
    assert.equal(directoryStat.mode & 0o777, 0o700);
    const runsStat = await fs.stat(path.join(repository, ".bounded/runs"));
    assert.equal(runsStat.mode & 0o777, 0o700);

    const normalFiles = (await fs.readdir(stored.directoryPath)).sort();
    assert.deepEqual(normalFiles, [
      "candidate.diff",
      "receipt.json",
      "run.json",
      "telemetry.json",
      "validation.json"
    ]);

    const normalContents = [];
    for (const file of normalFiles) {
      const absolute = path.join(stored.directoryPath, file);
      const stat = await fs.stat(absolute);
      assert.equal(stat.mode & 0o777, 0o600);
      normalContents.push(await fs.readFile(absolute, "utf8"));
    }
    const combinedNormal = normalContents.join("\n");
    assert.equal(combinedNormal.includes(environmentSecret), false);
    assert.equal(combinedNormal.includes(explicitSecret), false);
    assert.equal(combinedNormal.includes(hardcodedRefreshSecret), false);
    assert.match(combinedNormal, /\[REDACTED\]/);

    const manifestOnDisk = JSON.parse(await fs.readFile(
      path.join(stored.directoryPath, "run.json"), "utf8"
    ));
    assert.equal(runtime.verifyProductRunArtifact(manifestOnDisk), true);
    assert.equal(manifestOnDisk.run.apiKey, "[REDACTED]");
    assert.equal(manifestOnDisk.files.telemetry.file, "telemetry.json");
    assert.equal(manifestOnDisk.files.validation.file, "validation.json");

    const telemetryOnDisk = JSON.parse(await fs.readFile(
      path.join(stored.directoryPath, "telemetry.json"), "utf8"
    ));
    assert.equal(telemetryOnDisk.inputTokens, 11, "token-count telemetry must not be mistaken for a credential");
    assert.equal(telemetryOnDisk.outputTokens, 7);

    const loaded = await store.readStoredProductRunArtifact(repository, runId);
    assert.equal(loaded.artifactHash, stored.artifact.artifactHash);

    await assert.rejects(
      () => store.storeProductRunArtifact({
        repositoryRoot: repository,
        runId,
        run: {},
        candidateDiff: "",
        receipt: {},
        telemetry: {},
        validation: {}
      }),
      /already exists/
    );
    await assert.rejects(
      () => store.storeProductRunArtifact({
        repositoryRoot: repository,
        runId: "../escape",
        run: {},
        candidateDiff: "",
        receipt: {},
        telemetry: {},
        validation: {}
      }),
      /runId is invalid/
    );

    const compare = await store.storeProductRunArtifact({
      repositoryRoot: repository,
      runId: "compare-001",
      runKind: "compare",
      run: { command: "compare" },
      candidateDiff: "diff --git a/a.ts b/a.ts\n",
      receipt: { outcome: "validated" },
      telemetry: { totalTokens: 12 },
      validation: { status: "passed" },
      comparison: {
        winner: "bounded",
        credential: explicitSecret
      },
      secrets: [explicitSecret],
      environment: {}
    });
    assert.equal(compare.artifact.runKind, "compare");
    assert.equal(compare.artifact.files.comparison.file, "comparison.json");
    assert.deepEqual((await fs.readdir(compare.directoryPath)).sort(), [
      "candidate.diff",
      "comparison.json",
      "receipt.json",
      "run.json",
      "telemetry.json",
      "validation.json"
    ]);
    assert.equal(
      (await fs.readFile(path.join(compare.directoryPath, "comparison.json"), "utf8")).includes(explicitSecret),
      false
    );

    const unsafeRepository = path.join(root, "unsafe-repository");
    const outside = path.join(root, "outside-runs");
    await fs.mkdir(path.join(unsafeRepository, ".bounded"), { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(unsafeRepository, ".bounded/runs"));
    await assert.rejects(
      () => store.storeProductRunArtifact({
        repositoryRoot: unsafeRepository,
        runId: "unsafe-run",
        run: {},
        candidateDiff: "",
        receipt: {},
        telemetry: {},
        validation: {}
      }),
      /must be a real directory/
    );
    assert.deepEqual(await fs.readdir(outside), []);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      artifactVersion: "bounded-product-run/v1",
      pathShape: ".bounded/runs/<run-id>/",
      runJson: true,
      candidateDiff: true,
      receiptJson: true,
      telemetryJson: true,
      validationJson: true,
      comparisonJsonOnlyForCompare: true,
      runDirectoryMode: "0700",
      artifactFileMode: "0600",
      rawEnvironmentSecretWritten: false,
      rawExplicitSecretWritten: false,
      rawDiffSecretWritten: false,
      tokenCountTelemetryPreserved: true,
      existingRunOverwrite: false,
      traversalRunIdRejected: true,
      runsSymlinkRejected: true
    }, null, 2)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
