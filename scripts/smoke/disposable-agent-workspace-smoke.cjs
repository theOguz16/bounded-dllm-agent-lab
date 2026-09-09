#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, relative, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = resolve(__dirname, "../..");
const builtModule = resolve(
  repoRoot,
  "dist/packages/integrations/src/disposable-agent-workspace.js"
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(root, path, content, mode) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  if (mode !== undefined) chmodSync(target, mode);
}

function listTree(root, { excludeGit = false } = {}) {
  const output = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excludeGit && directory === root && entry.name === ".git") continue;
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split("\\").join("/");
      output.push(rel);
      if (entry.isDirectory()) visit(absolute);
    }
  }
  visit(root);
  return output.sort();
}

function snapshotSourceTree(root) {
  const result = {};
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split("\\").join("/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        result[rel] = `symlink:${readlinkSync(absolute)}`;
      } else if (stat.isDirectory()) {
        visit(absolute);
      } else if (stat.isFile()) {
        result[rel] = `file:${stat.mode & 0o777}:${sha256(readFileSync(absolute))}`;
      }
    }
  }
  visit(root);
  return result;
}

function initFixtureRepo(root) {
  write(root, "src/allowed.txt", "alpha\n");
  write(root, "src/context.txt", "context\n");
  write(root, "src/other.txt", "other\n");
  write(root, "test/allowed.test.txt", "test\n");
  write(root, ".env", "SECRET=do-not-copy\n");
  write(root, ".env.local", "SECRET=do-not-copy-either\n");
  write(root, "credentials.json", '{"token":"nope"}\n');
  write(root, "config/secrets.json", '{"apiKey":"nope"}\n');
  write(root, ".bounded/runs/run-1/state.json", '{}\n');
  write(root, "node_modules/pkg/index.js", "module.exports = 1;\n");
  write(root, "dist/output.js", "compiled\n");
  write(root, "build/output.js", "compiled\n");
  write(root, "assets/binary.bin", Buffer.from([0x00, 0xff, 0x01, 0x02]));
  write(root, "untracked.txt", "must not appear in baseline\n");

  const symlinkTarget = join(root, "src/allowed.txt");
  const symlinkPath = join(root, "src/link.txt");
  symlinkSync(symlinkTarget, symlinkPath);

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync(
    "git",
    [
      "add",
      "src/allowed.txt",
      "src/context.txt",
      "src/other.txt",
      "src/link.txt",
      "test/allowed.test.txt",
      ".env",
      ".env.local",
      "credentials.json",
      "config/secrets.json",
      ".bounded/runs/run-1/state.json",
      "node_modules/pkg/index.js",
      "dist/output.js",
      "build/output.js",
      "assets/binary.bin"
    ],
    { cwd: root }
  );
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
}

function git(cwd, args, env = process.env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env
  }).trim();
}

function assertIndependentGitBaseline(workspacePath, sourceRepoPath) {
  const workspaceGitDir = resolve(git(workspacePath, ["rev-parse", "--absolute-git-dir"]));
  const sourceGitDir = resolve(git(sourceRepoPath, ["rev-parse", "--absolute-git-dir"]));

  assert.equal(workspaceGitDir, resolve(workspacePath, ".git"));
  assert.notEqual(workspaceGitDir, sourceGitDir);
  assert.equal(workspaceGitDir.startsWith(`${sourceGitDir}/`), false);
  assert.equal(sourceGitDir.startsWith(`${workspaceGitDir}/`), false);
  assert.equal(lstatSync(workspaceGitDir).isDirectory(), true);
  assert.equal(lstatSync(workspaceGitDir).isSymbolicLink(), false);

  const commonDir = git(workspacePath, ["rev-parse", "--git-common-dir"]);
  assert.equal(resolve(workspacePath, commonDir), workspaceGitDir);
  assert.equal(git(workspacePath, ["remote"]), "");
  assert.equal(git(workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.equal(existsSync(join(workspaceGitDir, "objects", "info", "alternates")), false);

  const headParentCount = git(workspacePath, ["rev-list", "--parents", "-n", "1", "HEAD"])
    .split(/\s+/)
    .length;
  assert.equal(headParentCount, 1, "workspace baseline must be an independent root commit");
}

async function expectReject(action, pattern) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.code, "disposable_agent_workspace_invalid");
    assert.match(String(error?.message), pattern);
    return true;
  });
}

async function main() {
  const module = await import(pathToFileURL(builtModule).href);
  assert.equal(typeof module.createDisposableAgentWorkspace, "function");
  assert.equal(
    module.DISPOSABLE_AGENT_WORKSPACE_VERSION,
    "disposable-agent-workspace/v1"
  );

  const fixtureRoot = mkdtempSync(join(tmpdir(), "bounded-agent-source-fixture-"));
  const workspaces = [];

  try {
    initFixtureRepo(fixtureRoot);
    const sourceBefore = snapshotSourceTree(fixtureRoot);
    const sourceGitBefore = snapshotSourceTree(join(fixtureRoot, ".git"));
    const sourceSnapshotHash = sha256(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixtureRoot })
    );

    const hostileEnv = {
      ...process.env,
      GIT_DIR: join(fixtureRoot, ".git"),
      GIT_WORK_TREE: fixtureRoot,
      GIT_OBJECT_DIRECTORY: join(fixtureRoot, ".git", "objects")
    };
    const originalGitDir = process.env.GIT_DIR;
    const originalGitWorkTree = process.env.GIT_WORK_TREE;
    const originalGitObjectDirectory = process.env.GIT_OBJECT_DIRECTORY;
    process.env.GIT_DIR = hostileEnv.GIT_DIR;
    process.env.GIT_WORK_TREE = hostileEnv.GIT_WORK_TREE;
    process.env.GIT_OBJECT_DIRECTORY = hostileEnv.GIT_OBJECT_DIRECTORY;

    let bounded;
    try {
      bounded = await module.createDisposableAgentWorkspace({
        repositoryPath: fixtureRoot,
        sourceSnapshotHash,
        visibleFiles: ["src/allowed.txt", "src/context.txt", "test/allowed.test.txt"],
        changeAllowedFiles: ["src/allowed.txt", "test/allowed.test.txt"],
        forbiddenFiles: ["src/other.txt"],
        mode: "bounded"
      });
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = originalGitDir;
      if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = originalGitWorkTree;
      if (originalGitObjectDirectory === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
      else process.env.GIT_OBJECT_DIRECTORY = originalGitObjectDirectory;
    }
    workspaces.push(bounded.workspacePath);

    assert.notEqual(resolve(bounded.workspacePath), resolve(fixtureRoot));
    assert.equal(
      resolve(bounded.workspacePath).startsWith(`${resolve(fixtureRoot)}/`),
      false,
      "workspace must not be inside original repository"
    );
    assert.deepEqual(
      bounded.manifest.files.map((entry) => entry.path),
      ["src/allowed.txt", "src/context.txt", "test/allowed.test.txt"]
    );
    assert.equal(bounded.exposedFileCount, 3);
    assert.equal(
      bounded.exposedBytes,
      Buffer.byteLength("alpha\n") + Buffer.byteLength("context\n") + Buffer.byteLength("test\n")
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(bounded.manifest, "originalRepositoryPath"),
      false
    );
    assert.equal(JSON.stringify(bounded.manifest).includes(fixtureRoot), false);
    assert.equal(
      bounded.manifest.files.find((entry) => entry.path === "src/context.txt")
        .changeAllowed,
      false
    );
    assert.equal(
      bounded.manifest.files.find((entry) => entry.path === "src/allowed.txt")
        .changeAllowed,
      true
    );
    assert.equal(
      bounded.manifestHash,
      sha256(JSON.stringify(bounded.manifest)),
      "manifest hash must be deterministic over canonical manifest JSON"
    );

    assertIndependentGitBaseline(bounded.workspacePath, fixtureRoot);
    assert.deepEqual(snapshotSourceTree(join(fixtureRoot, ".git")), sourceGitBefore);

    writeFileSync(join(bounded.workspacePath, "src/allowed.txt"), "agent destroyed this\n");
    writeFileSync(join(bounded.workspacePath, "src/context.txt"), "agent changed context\n");

    const diff = git(bounded.workspacePath, ["diff", "--", "src/allowed.txt"]);
    assert.match(diff, /-alpha/);
    assert.match(diff, /\+agent destroyed this/);
    assert.equal(
      git(bounded.workspacePath, ["diff", "--name-status"]),
      "M\tsrc/allowed.txt\nM\tsrc/context.txt"
    );

    assert.deepEqual(
      snapshotSourceTree(fixtureRoot),
      sourceBefore,
      "mutating disposable workspace must leave source repo byte-for-byte unchanged"
    );
    assert.deepEqual(
      snapshotSourceTree(join(fixtureRoot, ".git")),
      sourceGitBefore,
      "workspace git activity must never write into source .git"
    );
    assert.equal(readFileSync(join(fixtureRoot, "src/allowed.txt"), "utf8"), "alpha\n");

    const baseline = await module.createDisposableAgentWorkspace({
      repositoryPath: fixtureRoot,
      sourceSnapshotHash,
      visibleFiles: [],
      changeAllowedFiles: ["src/allowed.txt", "test/allowed.test.txt"],
      forbiddenFiles: ["src/other.txt"],
      mode: "baseline"
    });
    workspaces.push(baseline.workspacePath);
    assertIndependentGitBaseline(baseline.workspacePath, fixtureRoot);

    const baselinePaths = baseline.manifest.files.map((entry) => entry.path);
    assert.deepEqual(baselinePaths, [
      "src/allowed.txt",
      "src/context.txt",
      "test/allowed.test.txt"
    ]);
    const baselineTree = listTree(baseline.workspacePath, { excludeGit: true });
    for (const forbidden of [
      ".env",
      ".env.local",
      "credentials.json",
      "config/secrets.json",
      ".bounded/runs",
      "node_modules",
      "dist",
      "build",
      "assets/binary.bin",
      "src/link.txt",
      "src/other.txt",
      "untracked.txt"
    ]) {
      assert.equal(
        baselineTree.some((path) => path === forbidden || path.startsWith(`${forbidden}/`)),
        false,
        `baseline workspace must not expose ${forbidden}`
      );
    }

    await expectReject(
      () =>
        module.createDisposableAgentWorkspace({
          repositoryPath: fixtureRoot,
          sourceSnapshotHash,
          visibleFiles: [".env"],
          changeAllowedFiles: [],
          forbiddenFiles: [],
          mode: "bounded"
        }),
      /forbidden file \.env/i
    );

    await expectReject(
      () =>
        module.createDisposableAgentWorkspace({
          repositoryPath: fixtureRoot,
          sourceSnapshotHash,
          visibleFiles: ["src/link.txt"],
          changeAllowedFiles: [],
          forbiddenFiles: [],
          mode: "bounded"
        }),
      /ineligible symlink path/i
    );

    await expectReject(
      () =>
        module.createDisposableAgentWorkspace({
          repositoryPath: fixtureRoot,
          sourceSnapshotHash,
          visibleFiles: ["assets/binary.bin"],
          changeAllowedFiles: [],
          forbiddenFiles: [],
          mode: "bounded"
        }),
      /ineligible binary path/i
    );

    await expectReject(
      () =>
        module.createDisposableAgentWorkspace({
          repositoryPath: fixtureRoot,
          sourceSnapshotHash,
          visibleFiles: ["src/allowed.txt"],
          changeAllowedFiles: ["src/other.txt"],
          forbiddenFiles: [],
          mode: "bounded"
        }),
      /not exposed to the agent/i
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          schemaVersion: module.DISPOSABLE_AGENT_WORKSPACE_VERSION,
          boundedSelectedOnly: true,
          baselineTrackedEligibleTextOnly: true,
          independentGitBaseline: true,
          workspaceRemoteConfigured: false,
          sourceGitWriteConnection: false,
          gitDiffDetectsAgentChanges: true,
          gitNameStatusDetectsAgentChanges: true,
          originalRepositoryMutated: false,
          hardDeniedSecretsExcluded: true,
          binaryExcluded: true,
          symlinkExcluded: true
        },
        null,
        2
      )}\n`
    );
  } finally {
    for (const workspace of workspaces) {
      rmSync(workspace, { recursive: true, force: true });
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
