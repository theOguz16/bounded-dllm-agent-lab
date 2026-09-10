#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
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
    const gitInit = spawnSync("git", ["init", "-q"], { cwd: repository, encoding: "utf8" });
    assert.equal(gitInit.status, 0, gitInit.stderr || "git init failed");

    const runtime = await import(pathToFileURL(
      path.join(repoRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
    ).href);
    const store = await import(pathToFileURL(
      path.join(repoRoot, "dist/apps/cli/src/run-artifact-store.js")
    ).href);
    const reportModule = await import(pathToFileURL(
      path.join(repoRoot, "dist/apps/cli/src/commands/report.js")
    ).href);
    const historyModule = await import(pathToFileURL(
      path.join(repoRoot, "dist/apps/cli/src/commands/history.js")
    ).href);

    assert.equal(runtime.BOUNDED_PRODUCT_RUN_ARTIFACT_VERSION, "bounded-product-run/v1");
    assert.equal(typeof runtime.createProductRunArtifact, "function");
    assert.equal(typeof runtime.verifyProductRunArtifact, "function");
    assert.equal(typeof store.storeProductRunArtifact, "function");
    assert.equal(typeof store.readStoredProductRunBundle, "function");
    assert.equal(typeof store.listStoredProductRunArtifacts, "function");
    assert.equal(typeof reportModule.reportCommand, "function");
    assert.equal(typeof historyModule.historyCommand, "function");

    const environmentSecret = "sk-fixture-secret-value-1234567890";
    const explicitSecret = "explicit-fixture-password-value";
    const hardcodedRefreshSecret = "hardcoded-refresh-secret-value";
    const runId = "run-001";
    const receiptHash = `sha256:${"a".repeat(64)}`;

    const stored = await store.storeProductRunArtifact({
      repositoryRoot: repository,
      runId,
      run: {
        command: "codex",
        status: "validated",
        agent: "Codex",
        model: "gpt-fixture",
        task: "Fix refresh token expiry",
        sourceCommit: "abc123fixture",
        commands: ["npm run typecheck", "npm test"],
        repairRounds: 1,
        humanDecision: "approved",
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
        receiptHash,
        password: explicitSecret
      },
      telemetry: {
        inputTokens: 11,
        cachedTokens: 3,
        outputTokens: 7,
        reasoningTokens: 2,
        totalTokens: 20,
        contextExposure: {
          repositoryEligibleFileCount: 20,
          repositoryEligibleBytes: 2000,
          exposedFileCount: 3,
          exposedBytes: 300,
          mutableFileCount: 1,
          mutableBytes: 100
        },
        providerMessage: `credential ${environmentSecret}`
      },
      validation: {
        scope: "PASS",
        typecheck: "PASS",
        tests: "PASS",
        behavior: "PASS",
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
    const bundle = await store.readStoredProductRunBundle(repository, runId);
    assert.equal(bundle.artifact.artifactHash, stored.artifact.artifactHash);
    assert.equal(bundle.telemetry.totalTokens, 20);

    const report = await reportModule.reportCommand(runId, repository);
    assert.equal(report.exitCode, 0);
    assert.equal(report.output.status, "validated");
    assert.equal(report.output.agent, "Codex");
    assert.equal(report.output.model, "gpt-fixture");
    assert.equal(report.output.task, "Fix refresh token expiry");
    assert.equal(report.output.sourceCommit, "abc123fixture");
    assert.deepEqual(report.output.tokens, {
      input: 11,
      cached: 3,
      output: 7,
      reasoning: 2,
      total: 20
    });
    assert.equal(report.output.contextExposure.exposedFileCount, 3);
    assert.deepEqual(report.output.changedFiles, ["src/auth.ts"]);
    assert.deepEqual(report.output.commands, ["npm run typecheck", "npm test"]);
    assert.equal(report.output.validation.typecheck, "PASS");
    assert.equal(report.output.validation.tests, "PASS");
    assert.equal(report.output.repairRounds, 1);
    assert.equal(report.output.humanDecision, "approved");
    assert.equal(report.output.receiptHash, receiptHash);
    assert.equal(report.output.receiptHashSource, "receipt");

    const history = await historyModule.historyCommand(repository);
    assert.equal(history.exitCode, 0);
    assert.equal(history.output.count, 1);
    assert.equal(history.output.runs[0].runId, runId);
    assert.equal(history.output.runs[0].status, "validated");
    assert.equal(history.output.runs[0].model, "gpt-fixture");
    assert.equal(history.output.runs[0].task, "Fix refresh token expiry");

    const cliEntry = path.join(repoRoot, "dist/apps/cli/src/index.js");
    const reportHuman = spawnSync(process.execPath, [cliEntry, "report", runId], {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, OPENAI_API_KEY: "" }
    });
    assert.equal(reportHuman.status, 0, reportHuman.stderr);
    for (const heading of [
      "Status",
      "Agent",
      "Model",
      "Task",
      "Source commit",
      "Tokens",
      "Context exposure",
      "Changed files",
      "Commands",
      "Validation",
      "Repair rounds",
      "Human decision",
      "Receipt hash"
    ]) {
      assert.match(reportHuman.stdout, new RegExp(`${heading}\\n`));
    }
    assert.match(reportHuman.stdout, /Fix refresh token expiry/);
    assert.match(reportHuman.stdout, /src\/auth\.ts/);

    const historyJson = spawnSync(process.execPath, [cliEntry, "history", "--json"], {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, OPENAI_API_KEY: "" }
    });
    assert.equal(historyJson.status, 0, historyJson.stderr);
    const historyJsonOutput = JSON.parse(historyJson.stdout);
    assert.equal(historyJsonOutput.command, "history");
    assert.equal(historyJsonOutput.count, 1);
    assert.equal(historyJsonOutput.runs[0].runId, runId);

    const reportJson = spawnSync(process.execPath, [cliEntry, "report", runId, "--json"], {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, OPENAI_API_KEY: "" }
    });
    assert.equal(reportJson.status, 0, reportJson.stderr);
    const reportJsonOutput = JSON.parse(reportJson.stdout);
    assert.equal(reportJsonOutput.command, "report");
    assert.equal(reportJsonOutput.receiptHash, receiptHash);

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

    const telemetryPath = path.join(stored.directoryPath, "telemetry.json");
    await fs.writeFile(telemetryPath, `${JSON.stringify({ inputTokens: 999 })}\n`, "utf8");
    await assert.rejects(
      () => reportModule.reportCommand(runId, repository),
      /integrity verification/
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
      runsSymlinkRejected: true,
      boundedHistory: true,
      boundedReport: true,
      reportFieldsComplete: true,
      reportArtifactIntegrityVerified: true,
      reportJsonSupported: true,
      historyJsonSupported: true
    }, null, 2)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
