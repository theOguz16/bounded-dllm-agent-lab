#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  Gate6RepositoryManifestError,
  SCHEMA_VERSION,
  SUPPORTED_LANGUAGES,
  canonicalizeGate6RepositoryManifest,
  hashGate6RepositoryManifest,
  parseGate6RepositoryManifest,
  validateGate6RepositoryManifest,
  verifyRuntimeRepository
} = require("../../scripts/lib/gate6-repository-manifest.cjs");

function test(name, fn) {
  fn();
  process.stdout.write(`PASS ${name}\n`);
}

function expectReject(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof Gate6RepositoryManifestError && error.code === code,
    `expected rejection ${code}`
  );
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFixtureRepository(root, name, index) {
  const repositoryPath = join(root, name);
  require("node:fs").mkdirSync(repositoryPath, { recursive: true });
  git(repositoryPath, ["init", "-q"]);
  writeFileSync(join(repositoryPath, "index.js"), `module.exports = ${index};\n`, "utf8");
  git(repositoryPath, ["add", "index.js"]);
  git(repositoryPath, [
    "-c", "user.name=Gate6 Fixture",
    "-c", "user.email=gate6@example.invalid",
    "commit", "-q", "-m", `fixture ${index}`
  ]);
  return {
    id: `fixture/repo-${index}`,
    repositoryPath,
    commitSha: git(repositoryPath, ["rev-parse", "HEAD"]),
    language: index === 3 ? "typescript" : "javascript",
    license: "MIT"
  };
}

function manifestFrom(fixtures) {
  return {
    schemaVersion: SCHEMA_VERSION,
    repositories: fixtures.map(({ id, commitSha, language, license }) => ({
      id, commitSha, language, license
    }))
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function main() {
  const root = mkdtempSync(join(tmpdir(), "gate6-repository-manifest-"));
  try {
    const fixtures = [1, 2, 3].map((index) => createFixtureRepository(root, `repo-${index}`, index));
    const manifest = manifestFrom(fixtures);

    test("valid manifest with three fixture repositories is accepted", () => {
      assert.equal(validateGate6RepositoryManifest(manifest), manifest);
      assert.equal(manifest.repositories.length, 3);
    });

    test("exact 40-char SHA is enforced", () => {
      const invalid = clone(manifest);
      invalid.repositories[0].commitSha = "abc123";
      expectReject(() => validateGate6RepositoryManifest(invalid), "GATE6_REPOSITORY_COMMIT_SHA_INVALID");
    });

    test("floating refs are rejected", () => {
      for (const floatingRef of ["main", "master", "v1.0.0", "refs/heads/main"]) {
        const invalid = clone(manifest);
        invalid.repositories[0].commitSha = floatingRef;
        expectReject(() => validateGate6RepositoryManifest(invalid), "GATE6_REPOSITORY_COMMIT_SHA_INVALID");
      }
    });

    test("duplicate repository + SHA entry is rejected", () => {
      const invalid = clone(manifest);
      invalid.repositories.push(clone(invalid.repositories[0]));
      expectReject(() => validateGate6RepositoryManifest(invalid), "GATE6_REPOSITORY_DUPLICATE_ENTRY");
    });

    test("duplicate repository id with another SHA is rejected", () => {
      const invalid = clone(manifest);
      invalid.repositories[1].id = invalid.repositories[0].id;
      expectReject(() => validateGate6RepositoryManifest(invalid), "GATE6_REPOSITORY_DUPLICATE_ID");
    });

    test("unsupported language is rejected", () => {
      const invalid = clone(manifest);
      invalid.repositories[0].language = "brainfuck";
      expectReject(() => validateGate6RepositoryManifest(invalid), "GATE6_REPOSITORY_LANGUAGE_UNSUPPORTED");
      assert.deepEqual(SUPPORTED_LANGUAGES, ["javascript", "typescript", "python", "go", "rust", "java"]);
    });

    test("missing repository id is rejected", () => {
      const invalid = clone(manifest);
      delete invalid.repositories[0].id;
      expectReject(() => validateGate6RepositoryManifest(invalid), "GATE6_REPOSITORY_ENTRY_INVALID");
    });

    test("empty manifest is rejected", () => {
      expectReject(
        () => validateGate6RepositoryManifest({ schemaVersion: SCHEMA_VERSION, repositories: [] }),
        "GATE6_REPOSITORY_MANIFEST_EMPTY"
      );
    });

    test("manifest parse is deterministic and canonical output is immutable", () => {
      const text = JSON.stringify(manifest);
      const first = parseGate6RepositoryManifest(text);
      const second = parseGate6RepositoryManifest(text);
      assert.deepEqual(first, second);
      assert.equal(Object.isFrozen(first), true);
      assert.equal(Object.isFrozen(first.repositories), true);
      assert.equal(Object.isFrozen(first.repositories[0]), true);
    });

    test("repository ordering does not change canonical hash", () => {
      const reversed = { ...clone(manifest), repositories: clone(manifest.repositories).reverse() };
      assert.equal(hashGate6RepositoryManifest(manifest), hashGate6RepositoryManifest(reversed));
      assert.deepEqual(
        canonicalizeGate6RepositoryManifest(reversed).repositories.map((entry) => entry.id),
        canonicalizeGate6RepositoryManifest(manifest).repositories.map((entry) => entry.id)
      );
    });

    test("runtime HEAD matches exact manifest SHA for all three fixture repos", () => {
      for (const fixture of fixtures) {
        const result = verifyRuntimeRepository({
          manifest,
          repositoryId: fixture.id,
          repositoryPath: fixture.repositoryPath
        });
        assert.equal(result.expectedCommitSha, fixture.commitSha);
        assert.equal(result.actualCommitSha, fixture.commitSha);
      }
    });

    test("runtime SHA mismatch fails before benchmark execution", () => {
      const invalid = clone(manifest);
      invalid.repositories[0].commitSha = "0".repeat(40);
      expectReject(
        () => verifyRuntimeRepository({
          manifest: invalid,
          repositoryId: fixtures[0].id,
          repositoryPath: fixtures[0].repositoryPath
        }),
        "GATE6_RUNTIME_REPOSITORY_SHA_MISMATCH"
      );
    });

    test("runtime repository id mismatch fails closed", () => {
      expectReject(
        () => verifyRuntimeRepository({
          manifest,
          repositoryId: "fixture/not-registered",
          repositoryPath: fixtures[0].repositoryPath
        }),
        "GATE6_RUNTIME_REPOSITORY_NOT_IN_MANIFEST"
      );
    });

    test("runtime verification does not mutate repository", () => {
      const fixture = fixtures[1];
      writeFileSync(join(fixture.repositoryPath, "untracked.txt"), "do not touch\n", "utf8");
      const beforeHead = git(fixture.repositoryPath, ["rev-parse", "HEAD"]);
      const beforeStatus = git(fixture.repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
      verifyRuntimeRepository({
        manifest,
        repositoryId: fixture.id,
        repositoryPath: fixture.repositoryPath
      });
      const afterHead = git(fixture.repositoryPath, ["rev-parse", "HEAD"]);
      const afterStatus = git(fixture.repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
      assert.equal(afterHead, beforeHead);
      assert.equal(afterStatus, beforeStatus);
    });

    process.stdout.write("Gate 6 repository manifest validation PASS\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
