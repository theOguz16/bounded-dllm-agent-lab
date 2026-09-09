#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = resolve(__dirname, "../..");
const workspaceModulePath = resolve(
  repoRoot,
  "dist/packages/integrations/src/disposable-agent-workspace.js"
);
const captureModulePath = resolve(
  repoRoot,
  "dist/packages/integrations/src/agent-mutation-capture.js"
);
const textContractModulePath = resolve(
  repoRoot,
  "dist/packages/product-runtime/src/text-file-update-contract.js"
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    env: { ...process.env, LC_ALL: "C" }
  });
}

function initSourceRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "bounded-agent-capture-source-"));
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}

async function createFixture(workspaceModule, files) {
  const sourceRoot = initSourceRepo(files);
  const visibleFiles = Object.keys(files).sort();
  const sourceSnapshotHash = sha256(git(sourceRoot, ["rev-parse", "HEAD"]));
  const workspace = await workspaceModule.createDisposableAgentWorkspace({
    repositoryPath: sourceRoot,
    sourceSnapshotHash,
    visibleFiles,
    changeAllowedFiles: visibleFiles,
    forbiddenFiles: [],
    mode: "bounded"
  });
  return { sourceRoot, workspace };
}

function cleanupFixture(fixture) {
  rmSync(fixture.workspace.workspacePath, { recursive: true, force: true });
  rmSync(fixture.sourceRoot, { recursive: true, force: true });
}

async function expectCaptureReject(captureModule, input, code) {
  await assert.rejects(
    () => captureModule.captureAgentMutations(input),
    (error) => {
      assert.equal(error?.code, code);
      return true;
    }
  );
}

async function main() {
  const workspaceModule = await import(pathToFileURL(workspaceModulePath).href);
  const captureModule = await import(pathToFileURL(captureModulePath).href);
  const textContract = await import(pathToFileURL(textContractModulePath).href);

  assert.equal(typeof captureModule.captureAgentMutations, "function");
  assert.equal(textContract.TEXT_FILE_UPDATE_VERSION, "text-file-update/v1");

  const fixtures = [];
  try {
    const happy = await createFixture(workspaceModule, {
      "src/alpha.txt": "alpha\n",
      "src/beta.txt": "beta\n"
    });
    fixtures.push(happy);

    const alphaManifest = happy.workspace.manifest.files.find(
      (entry) => entry.path === "src/alpha.txt"
    );
    assert.ok(alphaManifest);
    writeFileSync(join(happy.workspace.workspacePath, "src/alpha.txt"), "agent changed alpha\n");

    git(happy.workspace.workspacePath, ["config", "user.email", "agent@example.invalid"]);
    git(happy.workspace.workspacePath, ["config", "user.name", "Agent"]);
    git(happy.workspace.workspacePath, ["add", "src/alpha.txt"]);
    git(happy.workspace.workspacePath, ["commit", "-qm", "agent commit"]);

    const fakeAgentHash = `sha256:${"f".repeat(64)}`;
    const captureInput = {
      workspacePath: happy.workspace.workspacePath,
      sourceManifest: happy.workspace.manifest,
      expectedContentHash: fakeAgentHash,
      agentClaim: {
        expectedContentHash: fakeAgentHash
      }
    };
    const result = await captureModule.captureAgentMutations(captureInput);

    assert.deepEqual(result.changedFiles, ["src/alpha.txt"]);
    assert.equal(result.claims.length, 1);
    const claim = result.claims[0];
    assert.equal(claim.claimVersion, "text-file-update/v1");
    assert.equal(claim.type, "patch_draft");
    assert.equal(claim.operation, "update");
    assert.equal(claim.file, "src/alpha.txt");
    assert.equal(claim.newContent, "agent changed alpha\n");
    assert.equal(claim.expectedContentHash, `sha256:${alphaManifest.sourceHash}`);
    assert.notEqual(claim.expectedContentHash, fakeAgentHash);
    assert.equal(
      claim.expectedContentHash,
      `sha256:${sha256(Buffer.from("alpha\n"))}`
    );
    assert.deepEqual(textContract.parseTextFileUpdates(result.mutation), result.claims);

    const added = await createFixture(workspaceModule, { "src/a.txt": "a\n" });
    fixtures.push(added);
    writeFileSync(join(added.workspace.workspacePath, "src/new.txt"), "new\n");
    await expectCaptureReject(
      captureModule,
      {
        workspacePath: added.workspace.workspacePath,
        sourceManifest: added.workspace.manifest
      },
      "agent_mutation_added_unsupported"
    );

    const deleted = await createFixture(workspaceModule, { "src/a.txt": "a\n" });
    fixtures.push(deleted);
    unlinkSync(join(deleted.workspace.workspacePath, "src/a.txt"));
    await expectCaptureReject(
      captureModule,
      {
        workspacePath: deleted.workspace.workspacePath,
        sourceManifest: deleted.workspace.manifest
      },
      "agent_mutation_deleted_unsupported"
    );

    const renamed = await createFixture(workspaceModule, { "src/a.txt": "rename me\n" });
    fixtures.push(renamed);
    git(renamed.workspace.workspacePath, ["mv", "src/a.txt", "src/b.txt"]);
    await expectCaptureReject(
      captureModule,
      {
        workspacePath: renamed.workspace.workspacePath,
        sourceManifest: renamed.workspace.manifest
      },
      "agent_mutation_renamed_unsupported"
    );

    const copied = await createFixture(workspaceModule, { "src/a.txt": "copy me exactly\n" });
    fixtures.push(copied);
    writeFileSync(join(copied.workspace.workspacePath, "src/b.txt"), "copy me exactly\n");
    git(copied.workspace.workspacePath, ["add", "src/b.txt"]);
    git(copied.workspace.workspacePath, ["config", "user.email", "agent@example.invalid"]);
    git(copied.workspace.workspacePath, ["config", "user.name", "Agent"]);
    git(copied.workspace.workspacePath, ["commit", "-qm", "copy file"]);
    await assert.rejects(
      () =>
        captureModule.captureAgentMutations({
          workspacePath: copied.workspace.workspacePath,
          sourceManifest: copied.workspace.manifest
        }),
      (error) => {
        assert.ok(
          error?.code === "agent_mutation_copied_unsupported" ||
            error?.code === "agent_mutation_added_unsupported"
        );
        return true;
      }
    );

    const mode = await createFixture(workspaceModule, { "src/a.txt": "mode\n" });
    fixtures.push(mode);
    chmodSync(join(mode.workspace.workspacePath, "src/a.txt"), 0o755);
    await expectCaptureReject(
      captureModule,
      {
        workspacePath: mode.workspace.workspacePath,
        sourceManifest: mode.workspace.manifest
      },
      "agent_mutation_mode_change_unsupported"
    );

    const symlink = await createFixture(workspaceModule, {
      "src/a.txt": "target\n",
      "src/b.txt": "replace\n"
    });
    fixtures.push(symlink);
    unlinkSync(join(symlink.workspace.workspacePath, "src/b.txt"));
    symlinkSync("a.txt", join(symlink.workspace.workspacePath, "src/b.txt"));
    await expectCaptureReject(
      captureModule,
      {
        workspacePath: symlink.workspace.workspacePath,
        sourceManifest: symlink.workspace.manifest
      },
      "agent_mutation_symlink_unsupported"
    );

    const binary = await createFixture(workspaceModule, { "src/a.txt": "text\n" });
    fixtures.push(binary);
    writeFileSync(join(binary.workspace.workspacePath, "src/a.txt"), Buffer.from([0x00, 0xff, 0x01]));
    await expectCaptureReject(
      captureModule,
      {
        workspacePath: binary.workspace.workspacePath,
        sourceManifest: binary.workspace.manifest
      },
      "agent_mutation_binary_unsupported"
    );

    const oversized = await createFixture(workspaceModule, { "src/a.txt": "small\n" });
    fixtures.push(oversized);
    writeFileSync(
      join(oversized.workspace.workspacePath, "src/a.txt"),
      "x".repeat(textContract.MUTATION_LIMITS.maxFileBytes + 1)
    );
    await expectCaptureReject(
      captureModule,
      {
        workspacePath: oversized.workspace.workspacePath,
        sourceManifest: oversized.workspace.manifest
      },
      "agent_mutation_file_limit_exceeded"
    );

    const totalFiles = {};
    for (let index = 0; index < 5; index += 1) {
      totalFiles[`src/f${index}.txt`] = `before-${index}\n`;
    }
    const total = await createFixture(workspaceModule, totalFiles);
    fixtures.push(total);
    const perFile = Math.floor(textContract.MUTATION_LIMITS.maxTotalBytes / 5) + 1;
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(
        join(total.workspace.workspacePath, `src/f${index}.txt`),
        String(index).repeat(perFile)
      );
    }
    await expectCaptureReject(
      captureModule,
      {
        workspacePath: total.workspace.workspacePath,
        sourceManifest: total.workspace.manifest
      },
      "agent_mutation_total_limit_exceeded"
    );

    const tamperedManifest = await createFixture(workspaceModule, { "src/a.txt": "manifest\n" });
    fixtures.push(tamperedManifest);
    writeFileSync(join(tamperedManifest.workspace.workspacePath, "src/a.txt"), "changed\n");
    const forgedManifest = {
      ...tamperedManifest.workspace.manifest,
      files: tamperedManifest.workspace.manifest.files.map((entry) => ({
        ...entry,
        sourceHash: "0".repeat(64)
      }))
    };
    await expectCaptureReject(
      captureModule,
      {
        workspacePath: tamperedManifest.workspace.workspacePath,
        sourceManifest: forgedManifest
      },
      "agent_mutation_source_manifest_mismatch"
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          bridge: "agent-diff-to-text-file-update/v1",
          modifiedExistingUtf8Only: true,
          preAgentManifestHashAuthoritative: true,
          fakeAgentHashIgnored: true,
          agentCommitsDoNotHideChanges: true,
          canonicalParserRoundTrip: true,
          addedRejected: true,
          deletedRejected: true,
          renamedRejected: true,
          copiedRejected: true,
          modeChangeRejected: true,
          symlinkRejected: true,
          binaryRejected: true,
          fileLimitRejected: true,
          totalLimitRejected: true,
          forgedManifestRejected: true
        },
        null,
        2
      )}\n`
    );
  } finally {
    for (const fixture of fixtures.reverse()) cleanupFixture(fixture);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
