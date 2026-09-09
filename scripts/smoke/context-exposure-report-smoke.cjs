#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0"
    }
  }).trim();
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

async function main() {
  const workspaceModule = await import(
    pathToFileURL(
      path.resolve(repoRoot, "dist/packages/integrations/src/disposable-agent-workspace.js")
    ).href
  );
  const reportModule = await import(
    pathToFileURL(
      path.resolve(repoRoot, "dist/packages/integrations/src/context-exposure-report.js")
    ).href
  );

  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-exposure-source-"));
  let boundedWorkspacePath = null;

  try {
    write(sourceRoot, "src/a.ts", "export const a = 1;\n");
    write(sourceRoot, "src/b.ts", "export const b = 2;\n");
    write(sourceRoot, "src/c.ts", "export const c = 3;\n");
    write(sourceRoot, "docs/readme.md", "hello telemetry\n");
    write(sourceRoot, "dist/generated.js", "generated\n");
    write(sourceRoot, ".env", "SECRET=nope\n");
    write(sourceRoot, "assets/blob.bin", Buffer.from([0, 1, 2, 3]));

    execFileSync("git", ["init", "-q", sourceRoot]);
    git(sourceRoot, ["add", "-f", "."]);
    git(sourceRoot, [
      "-c", "user.name=Smoke",
      "-c", "user.email=smoke@example.invalid",
      "commit", "-qm", "fixture"
    ]);

    const snapshotHash = sha256("context-exposure-smoke-snapshot");
    const bounded = await workspaceModule.createDisposableAgentWorkspace({
      repositoryPath: sourceRoot,
      sourceSnapshotHash: snapshotHash,
      visibleFiles: ["src/a.ts", "src/b.ts", "docs/readme.md"],
      changeAllowedFiles: ["src/a.ts", "src/b.ts"],
      forbiddenFiles: [],
      mode: "bounded"
    });
    boundedWorkspacePath = bounded.workspacePath;

    const report = await reportModule.createContextExposureReport({
      repositoryPath: sourceRoot,
      sourceSnapshotHash: snapshotHash,
      exposedManifest: bounded.manifest
    });

    const eligibleFiles = [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "docs/readme.md"
    ];
    const eligibleBytes = eligibleFiles.reduce(
      (sum, file) => sum + fs.readFileSync(path.join(sourceRoot, file)).byteLength,
      0
    );
    const exposedFiles = ["src/a.ts", "src/b.ts", "docs/readme.md"];
    const exposedBytes = exposedFiles.reduce(
      (sum, file) => sum + fs.readFileSync(path.join(sourceRoot, file)).byteLength,
      0
    );
    const mutableFiles = ["src/a.ts", "src/b.ts"];
    const mutableBytes = mutableFiles.reduce(
      (sum, file) => sum + fs.readFileSync(path.join(sourceRoot, file)).byteLength,
      0
    );

    assert.equal(report.reportVersion, "context-exposure-report/v1");
    assert.equal(report.sourceSnapshotHash, snapshotHash);
    assert.equal(report.repositoryEligibleFileCount, 4);
    assert.equal(report.repositoryEligibleBytes, eligibleBytes);
    assert.equal(report.exposedFileCount, 3);
    assert.equal(report.exposedBytes, exposedBytes);
    assert.equal(report.mutableFileCount, 2);
    assert.equal(report.mutableBytes, mutableBytes);
    assert.equal(report.exposedFileCount < report.repositoryEligibleFileCount, true);
    assert.equal(report.exposedBytes < report.repositoryEligibleBytes, true);
    assert.equal(report.mutableFileCount <= report.exposedFileCount, true);
    assert.equal(report.mutableBytes <= report.exposedBytes, true);

    const forgedManifest = {
      ...bounded.manifest,
      files: [
        ...bounded.manifest.files,
        {
          path: "dist/generated.js",
          sourceHash: createHash("sha256")
            .update(fs.readFileSync(path.join(sourceRoot, "dist/generated.js")))
            .digest("hex"),
          bytes: fs.readFileSync(path.join(sourceRoot, "dist/generated.js")).byteLength,
          changeAllowed: false
        }
      ]
    };
    await assert.rejects(
      () => reportModule.createContextExposureReport({
        repositoryPath: sourceRoot,
        sourceSnapshotHash: snapshotHash,
        exposedManifest: forgedManifest
      }),
      (error) => error && error.code === "context_exposure_report_invalid"
    );

    await assert.rejects(
      () => reportModule.createContextExposureReport({
        repositoryPath: sourceRoot,
        sourceSnapshotHash: sha256("wrong-snapshot"),
        exposedManifest: bounded.manifest
      }),
      (error) => error && error.code === "context_exposure_report_invalid"
    );

    process.stdout.write(`${JSON.stringify({
      ok: true,
      reportVersion: report.reportVersion,
      repositoryEligibleFileCount: report.repositoryEligibleFileCount,
      repositoryEligibleBytes: report.repositoryEligibleBytes,
      exposedFileCount: report.exposedFileCount,
      exposedBytes: report.exposedBytes,
      mutableFileCount: report.mutableFileCount,
      mutableBytes: report.mutableBytes,
      baselineEligibilityReused: true,
      hardDeniedExcludedFromEligible: true,
      binaryExcludedFromEligible: true,
      exposedSubsetVerified: true,
      sourceSnapshotBound: true
    }, null, 2)}\n`);
  } finally {
    if (boundedWorkspacePath !== null) {
      fs.rmSync(boundedWorkspacePath, { recursive: true, force: true });
    }
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
