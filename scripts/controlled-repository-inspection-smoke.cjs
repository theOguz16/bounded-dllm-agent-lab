#!/usr/bin/env node

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: "Controlled Inspector Fixture",
  GIT_AUTHOR_EMAIL: "inspector@example.invalid",
  GIT_COMMITTER_NAME: "Controlled Inspector Fixture",
  GIT_COMMITTER_EMAIL: "inspector@example.invalid"
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: gitEnvironment, encoding: "utf8" }).trim();
}

function write(root, file, content, mode) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (mode !== undefined) fs.chmodSync(target, mode);
}

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "controlled-repository-inspection-"));
  git(root, ["init", "--quiet"]);
  write(root, "src/a.txt", "TRACKED_CONTENT_SENTINEL\n");
  write(root, "bin/tool.sh", "#!/bin/sh\nexit 0\n", 0o755);
  fs.symlinkSync("../src/a.txt", path.join(root, "link-to-a"));
  const nested = path.join(root, "vendor/nested");
  fs.mkdirSync(nested, { recursive: true });
  git(nested, ["init", "--quiet"]);
  write(nested, "nested.txt", "NESTED_REPOSITORY_SENTINEL\n");
  git(nested, ["add", "--", "nested.txt"]);
  git(nested, ["commit", "--quiet", "-m", "nested fixture"]);
  git(root, ["-c", "advice.addEmbeddedRepo=false", "add", "--",
    "src/a.txt", "bin/tool.sh", "link-to-a", "vendor/nested"]);
  git(root, ["commit", "--quiet", "-m", "fixture root"]);
  return root;
}

function snapshot(root) {
  return {
    head: git(root, ["rev-parse", "HEAD"]),
    status: git(root, ["status", "--porcelain=v2", "--untracked-files=all"]),
    tracked: git(root, ["ls-files", "-s"]),
    content: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "src/a.txt"))).digest("hex")
  };
}

function assertFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozen(child, seen);
}

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/index.js");
  const {
    CONTROLLED_REPOSITORY_INSPECTION_VERSION,
    hashCanonicalJson,
    inspectControlledRepository
  } = runtime;
  let checks = 0;
  const check = (name, operation) => {
    operation();
    checks += 1;
    console.log(`[ok] ${name}`);
  };
  const inspect = (repositoryPath, changedFiles, extra = {}) =>
    inspectControlledRepository({ repositoryPath, changedFiles, ...extra });
  const root = createRepository();

  try {
    const before = snapshot(root);
    const input = {
      repositoryPath: root,
      changedFiles: [
        "src/future.txt", "link-to-a", "bin/tool.sh", "src/a.txt", "vendor/nested"
      ]
    };
    const clean = await inspectControlledRepository(input);

    check("clean repository produces a ready read-only inspection", () => {
      assert.equal(CONTROLLED_REPOSITORY_INSPECTION_VERSION, "1");
      assert.equal(clean.decision, "repository_inspection_ready");
      assert.ok(clean.inspection);
      assert.equal(clean.inspection.worktree.clean, true);
      assert.equal(clean.summary.repositoryRecognized, true);
      assert.equal(clean.summary.rollbackManifestBuilt, true);
      assert.equal(clean.summary.repositoryWritePerformed, false);
      assert.equal(clean.summary.gitMutationPerformed, false);
      assert.equal(clean.summary.rollbackMaterialized, false);
      for (const value of Object.values(clean.inspection.target)) {
        assert.match(value, /^sha256:[0-9a-f]{64}$/);
      }
    });

    check("rollback entries preserve tracked, absent, executable, and symlink evidence", () => {
      const entries = Object.fromEntries(clean.inspection.rollbackManifest.files.map((entry) =>
        [entry.filePath, entry]));
      assert.equal(entries["src/a.txt"].baselineState, "tracked_file");
      assert.equal(entries["src/a.txt"].baseMode, "100644");
      assert.match(entries["src/a.txt"].baseObjectId, /^[0-9a-f]{40,64}$/);
      assert.match(entries["src/a.txt"].worktreeContentHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(entries["src/future.txt"].baselineState, "absent");
      assert.equal(entries["src/future.txt"].baseObjectId, null);
      assert.equal(entries["src/future.txt"].existsInWorktree, false);
      assert.equal(entries["bin/tool.sh"].baseMode, "100755");
      assert.equal(entries["link-to-a"].baselineState, "tracked_symlink");
      assert.equal(entries["link-to-a"].worktreeEntryKind, "symlink");
      assert.match(entries["link-to-a"].worktreeContentHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(entries["vendor/nested"].baselineState, "tracked_gitlink");
      assert.equal(entries["vendor/nested"].baseMode, "160000");
      assert.equal(entries["vendor/nested"].worktreeEntryKind, "directory");
      assert.equal(entries["vendor/nested"].worktreeContentHash, null);
      assert.equal("content" in entries["src/a.txt"], false);
      assert.equal("linkTarget" in entries["link-to-a"], false);
    });

    check("manifest and inspection hashes reproduce canonical evidence", () => {
      const manifest = clean.inspection.rollbackManifest;
      const { manifestHash, ...manifestMaterial } = manifest;
      assert.equal(hashCanonicalJson(manifestMaterial), manifestHash);
      const { inspectionHash, ...inspectionMaterial } = clean.inspection;
      assert.equal(hashCanonicalJson(inspectionMaterial), inspectionHash);
    });

    const repeated = await inspect(root, [...input.changedFiles].reverse());
    check("file ordering normalizes and repeated evidence is deterministic", () => {
      assert.deepEqual(repeated.inspection.rollbackManifest.changedFiles,
        ["bin/tool.sh", "link-to-a", "src/a.txt", "src/future.txt", "vendor/nested"]);
      assert.equal(repeated.inspection.rollbackManifest.manifestHash,
        clean.inspection.rollbackManifest.manifestHash);
      assert.equal(repeated.inspection.inspectionHash, clean.inspection.inspectionHash);
      assert.equal(repeated.inspection.target.repositoryIdentityHash,
        clean.inspection.target.repositoryIdentityHash);
    });

    const exactTarget = await inspect(root, input.changedFiles, {
      expectedTarget: { ...clean.inspection.target }
    });
    const mismatchedTarget = await inspect(root, input.changedFiles, {
      expectedTarget: {
        ...clean.inspection.target,
        baseRevisionHash: hashCanonicalJson({ changed: "base" })
      }
    });
    check("expected targets match exactly and mismatches block", () => {
      assert.equal(exactTarget.decision, "repository_inspection_ready");
      assert.equal(exactTarget.summary.expectedTargetMatched, true);
      assert.equal(mismatchedTarget.decision, "repository_inspection_blocked");
      assert.equal(mismatchedTarget.summary.expectedTargetMatched, false);
      assert.ok(mismatchedTarget.issues.some((issue) =>
        issue.code === "repository_base_revision_target_mismatch"));
    });

    check("inspection leaves repository and caller input unchanged", () => {
      assert.deepEqual(snapshot(root), before);
      assert.equal(Object.isFrozen(input), false);
      assert.equal(Object.isFrozen(input.changedFiles), false);
      assertFrozen(clean);
    });

    check("serialized evidence leaks no configured path, content, or symlink target", () => {
      const serialized = JSON.stringify(clean);
      assert.equal(serialized.includes(root), false);
      assert.equal(serialized.includes("TRACKED_CONTENT_SENTINEL"), false);
      assert.equal(serialized.includes("../src/a.txt"), false);
      assert.equal(serialized.includes("stdout"), false);
      assert.equal(serialized.includes("stderr"), false);
    });

    const unsafePaths = [
      "../outside.ts", "/absolute.ts", "C:\\absolute.ts", "\\\\server\\share",
      ".git/config", "folder/.git/config", "folder\\backslash.ts", "folder//double.ts"
    ];
    for (const unsafe of unsafePaths) {
      const result = await inspect(root, [unsafe]);
      check(`unsafe changed path is rejected: ${JSON.stringify(unsafe)}`, () => {
        assert.equal(result.decision, "repository_inspection_invalid");
        assert.ok(result.issues.some((issue) => issue.code === "repository_changed_file_invalid"));
      });
    }

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "controlled-inspection-outside-"));
    fs.symlinkSync(outside, path.join(root, "escape"));
    const symlinkParent = await inspect(root, ["escape/file.txt"]);
    fs.unlinkSync(path.join(root, "escape"));
    fs.rmSync(outside, { recursive: true, force: true });
    check("symlinked parent traversal is rejected without following it", () => {
      assert.equal(symlinkParent.decision, "repository_inspection_invalid");
      assert.ok(symlinkParent.issues.some((issue) =>
        issue.code === "repository_changed_file_symlink_parent"));
    });

    const dirtyCases = [
      {
        name: "unstaged",
        prepare: () => write(root, "src/a.txt", "unstaged\n"),
        restore: () => git(root, ["restore", "--", "src/a.txt"]),
        code: "repository_worktree_dirty"
      },
      {
        name: "staged",
        prepare: () => { write(root, "src/a.txt", "staged\n"); git(root, ["add", "--", "src/a.txt"]); },
        restore: () => git(root, ["reset", "--hard", "HEAD"]),
        code: "repository_worktree_dirty"
      },
      {
        name: "untracked",
        prepare: () => write(root, "untracked.txt", "untracked\n"),
        restore: () => fs.unlinkSync(path.join(root, "untracked.txt")),
        code: "repository_untracked_files_present"
      }
    ];
    for (const fixture of dirtyCases) {
      fixture.prepare();
      const dirtyBefore = snapshot(root);
      const result = await inspect(root, ["src/a.txt"]);
      check(`${fixture.name} worktree blocks and is not cleaned`, () => {
        assert.equal(result.decision, "repository_inspection_blocked");
        assert.ok(result.issues.some((issue) => issue.code === fixture.code));
        assert.deepEqual(snapshot(root), dirtyBefore);
      });
      fixture.restore();
    }

    const gitDirectory = path.join(root, ".git");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
      fs.writeFileSync(path.join(gitDirectory, marker), `${git(root, ["rev-parse", "HEAD"])}\n`);
      const result = await inspect(root, input.changedFiles);
      check(`${marker} operation state blocks inspection`, () => {
        assert.equal(result.decision, "repository_inspection_blocked");
        assert.ok(result.issues.some((issue) => issue.code === "repository_operation_in_progress"));
        assert.notEqual(result.inspection.target.worktreeStateHash,
          clean.inspection.target.worktreeStateHash);
      });
      fs.unlinkSync(path.join(gitDirectory, marker));
    }
    for (const marker of ["rebase-merge", "rebase-apply"]) {
      fs.mkdirSync(path.join(gitDirectory, marker));
      const result = await inspect(root, ["src/a.txt"]);
      check(`${marker} operation state blocks inspection`, () => {
        assert.equal(result.decision, "repository_inspection_blocked");
      });
      fs.rmdirSync(path.join(gitDirectory, marker));
    }

    const partial = await inspectControlledRepository({
      repositoryPath: root,
      changedFiles: ["src/a.txt"],
      consumptionStatus: "not_consumed"
    });
    check("partial handoff verification package is invalid", () => {
      assert.equal(partial.decision, "repository_inspection_invalid");
      assert.ok(partial.issues.some((issue) => issue.code === "repository_handoff_package_incomplete"));
    });

    const malformed = [null, undefined, 1, "value", [], new Date(), new Map(), new Set()];
    for (const value of malformed) {
      const result = await inspectControlledRepository(value);
      check("malformed runtime input returns invalid evidence", () => {
        assert.equal(result.decision, "repository_inspection_invalid");
        assert.equal(result.inspection, null);
      });
    }
    const unknown = await inspectControlledRepository({
      repositoryPath: root, changedFiles: [], extra: true
    });
    const accessor = { repositoryPath: root, changedFiles: [] };
    Object.defineProperty(accessor, "extra", { get() { throw new Error("must not execute"); } });
    const accessorResult = await inspectControlledRepository(accessor);
    check("unknown fields and accessors are rejected without evaluation", () => {
      assert.equal(unknown.issues[0].code, "unknown_repository_inspection_field");
      assert.equal(accessorResult.issues[0].code, "repository_inspection_accessor_property");
    });

    await assert.rejects(
      inspectControlledRepository({ repositoryPath: root, changedFiles: [], timeoutMs: 0 }),
      TypeError
    );
    check("invalid trusted numeric configuration may throw TypeError", () => {});

    const boundedOutput = await inspect(root, [], { maxGitOutputBytes: 1 });
    check("Git output bounds fail closed without partial inspection", () => {
      assert.equal(boundedOutput.decision, "repository_inspection_invalid");
      assert.equal(boundedOutput.inspection, null);
      assert.ok(boundedOutput.issues.some((issue) =>
        issue.code === "repository_git_output_limit_exceeded"));
    });

    const oversizedPath = path.join(root, "oversized.bin");
    fs.closeSync(fs.openSync(oversizedPath, "w"));
    fs.truncateSync(oversizedPath, 20 * 1024 * 1024 + 1);
    const oversized = await inspect(root, ["oversized.bin"]);
    fs.unlinkSync(oversizedPath);
    check("oversized changed files require review and are never partially hashed", () => {
      assert.equal(oversized.decision, "repository_inspection_needs_review");
      assert.equal(oversized.inspection, null);
      assert.ok(oversized.issues.some((issue) =>
        issue.code === "repository_changed_file_too_large"));
    });

    write(root, "revision.txt", "new revision\n");
    git(root, ["add", "--", "revision.txt"]);
    git(root, ["commit", "--quiet", "-m", "advance revision"]);
    const advanced = await inspect(root, input.changedFiles);
    check("a new commit changes base and worktree hashes but not root identity", () => {
      assert.equal(advanced.decision, "repository_inspection_ready");
      assert.notEqual(advanced.inspection.target.baseRevisionHash,
        clean.inspection.target.baseRevisionHash);
      assert.notEqual(advanced.inspection.target.worktreeStateHash,
        clean.inspection.target.worktreeStateHash);
      assert.equal(advanced.inspection.target.repositoryIdentityHash,
        clean.inspection.target.repositoryIdentityHash);
    });

    const originalIdentity = clean.inspection.target.repositoryIdentityHash;
    git(root, ["remote", "add", "origin", "https://user:REMOTE_SECRET@example.com/org/repo.git/"]);
    const remote = await inspect(root, ["src/a.txt"]);
    git(root, ["remote", "set-url", "origin", "https://other:CHANGED_SECRET@EXAMPLE.COM/org/repo"]);
    const normalizedRemote = await inspect(root, ["src/a.txt"]);
    check("remote credentials are stripped and normalized before hashing", () => {
      assert.notEqual(remote.inspection.target.repositoryIdentityHash, originalIdentity);
      assert.equal(remote.inspection.target.repositoryIdentityHash,
        normalizedRemote.inspection.target.repositoryIdentityHash);
      assert.equal(JSON.stringify(remote).includes("REMOTE_SECRET"), false);
      assert.equal(JSON.stringify(remote).includes("example.com/org/repo"), false);
    });

    console.log(`controlled repository inspection smoke passed (${checks} checks)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
