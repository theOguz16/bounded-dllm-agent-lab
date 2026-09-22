const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

function legacyCandidates(from, specifier) {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (joined === ".." || joined.startsWith("../") || path.posix.isAbsolute(joined)) return [];
  const candidates = new Set([joined]);
  const extensionMap = {
    ".js": [".ts", ".tsx", ".js", ".jsx"],
    ".jsx": [".tsx", ".jsx"],
    ".mjs": [".mts", ".mjs"],
    ".cjs": [".cts", ".cjs"]
  };
  const extension = path.posix.extname(joined);
  if (extensionMap[extension]) {
    const stem = joined.slice(0, -extension.length);
    for (const mapped of extensionMap[extension]) candidates.add(`${stem}${mapped}`);
  }
  return [...candidates];
}

function treeDigest(root) {
  const hash = createHash("sha256");
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      hash.update(path.relative(root, absolute).split(path.sep).join("/"));
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(absolute));
      else hash.update(fs.readFileSync(absolute));
    }
  };
  walk(root);
  return hash.digest("hex");
}

function gitBinary() {
  const candidates = [
    process.env.GIT_BINARY,
    "git",
    "/Users/oguzhanuyar/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git"
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("A working Git binary is required to materialize frozen P7.8 fixtures.");
}

function materializeCommit(git, commit, root) {
  const archive = spawnSync(git, ["archive", "--format=tar", commit], {
    cwd: process.cwd(),
    maxBuffer: 128 * 1024 * 1024
  });
  assert.equal(archive.status, 0, archive.stderr?.toString("utf8"));
  const extract = spawnSync("tar", ["-x", "-C", root], {
    input: archive.stdout,
    maxBuffer: 128 * 1024 * 1024
  });
  assert.equal(extract.status, 0, extract.stderr?.toString("utf8"));
}

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, "utf8");
}

async function main() {
  const fixtures = JSON.parse(fs.readFileSync(
    "tests/fixtures/p7-8-relative-imports/cases.json", "utf8"
  ));
  const { analyzeCanonicalRepository } = await import(
    "../../dist/packages/product-runtime/src/canonical-repo-intelligence.js"
  );
  const { validateModelWorkspaceMutation } = await import(
    "../../dist/packages/product-runtime/src/model-mutation-validator.js"
  );
  assert.equal(fixtures.schemaVersion, "p7-8-relative-import-fixtures/v1");
  assert.equal(fixtures.cases.length, 3);
  const git = gitBinary();

  const roots = [];
  try {
    for (const fixture of fixtures.cases) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "p7-8-exact-"));
      roots.push(root);
      materializeCommit(git, fixture.sourceCommit, root);
      const sourceBytes = fs.readFileSync(path.join(root, fixture.sourceFile));
      assert.equal(createHash("sha256").update(sourceBytes).digest("hex"),
        fixture.sourceFileSha256);
      assert(fs.existsSync(path.join(root, fixture.sourceTarget)),
        `checked-in source target is absent: ${fixture.sourceTarget}`);
      const before = treeDigest(root);

      const oldCandidates = legacyCandidates(fixture.sourceFile, fixture.specifier);
      assert(!oldCandidates.includes(fixture.sourceTarget));
      assert.equal(oldCandidates.some((candidate) => fs.existsSync(path.join(root, candidate))), false);
      const oldDiagnosis = {
        sourceCommit: fixture.sourceCommit,
        file: fixture.sourceFile,
        specifier: fixture.specifier,
        candidates: oldCandidates,
        rejectionReason: "target_not_found"
      };
      assert.equal(oldDiagnosis.rejectionReason, "target_not_found");

      const result = await analyzeCanonicalRepository({
        repositoryPath: root,
        seedFiles: [fixture.sourceFile]
      });
      assert.equal(result.decision, "repo_intelligence_ready", JSON.stringify({ fixture, result }));
      assert(result.intelligence.dependencyEdges.some((edge) =>
        edge.from === fixture.sourceFile &&
        edge.specifier === fixture.specifier &&
        edge.to === fixture.sourceTarget
      ));
      assert.equal(treeDigest(root), before, "read-only analysis mutated a fixture");

      const mutation = JSON.stringify({
        role: "coder",
        target: "patchDraft",
        summary: "Attempt to mutate a read-only dependency.",
        claims: [],
        touchedFiles: [fixture.sourceTarget],
        confidence: 1
      });
      const scopeResult = validateModelWorkspaceMutation(mutation, {
        role: "coder",
        allowedFiles: [fixture.sourceFile],
        allowedContextFiles: [fixture.sourceFile, fixture.sourceTarget]
      });
      assert.equal(scopeResult.blocked, true);
      assert(scopeResult.issues.some((issue) => issue.code === "scope_violation"));
      console.log(JSON.stringify({ taskId: fixture.taskId, oldDiagnosis,
        resolvedTarget: fixture.sourceTarget, mutableScopeExpanded: false }));
    }

    const traversalRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "p7-8-traversal-"));
    roots.push(traversalRoot);
    await write(traversalRoot, "src/deep/index.ts", 'import "../../../outside.js";\n');
    const traversal = await analyzeCanonicalRepository({
      repositoryPath: traversalRoot, seedFiles: ["src/deep/index.ts"]
    });
    const traversalIssue = traversal.issues.find((issue) =>
      issue.code === "reachable_relative_import_unresolved"
    );
    assert.equal(traversal.decision, "repo_intelligence_blocked");
    assert.equal(traversalIssue.rejectionReason, "outside_repository");
    assert.deepEqual(traversalIssue.resolverCandidates, []);

    const forbiddenRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "p7-8-forbidden-"));
    roots.push(forbiddenRoot);
    await write(forbiddenRoot, "scripts/check.cjs",
      'void import("../dist/node_modules/private/secret.js");\n');
    await write(forbiddenRoot, "node_modules/private/secret.ts", "export const secret = true;\n");
    const forbidden = await analyzeCanonicalRepository({
      repositoryPath: forbiddenRoot, seedFiles: ["scripts/check.cjs"]
    });
    assert.equal(forbidden.decision, "repo_intelligence_blocked");
    assert(forbidden.issues.some((issue) =>
      issue.rejectionReason === "target_not_found" &&
      issue.resolverCandidates.includes("node_modules/private/secret.ts")
    ));

    const symlinkRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "p7-8-symlink-"));
    const outsideRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "p7-8-outside-"));
    roots.push(symlinkRoot, outsideRoot);
    await write(symlinkRoot, "scripts/check.cjs",
      'void import("../dist/packages/runtime/src/index.js");\n');
    await write(outsideRoot, "index.ts", "export const outside = true;\n");
    await fsp.mkdir(path.join(symlinkRoot, "packages/runtime/src"), { recursive: true });
    await fsp.symlink(path.join(outsideRoot, "index.ts"),
      path.join(symlinkRoot, "packages/runtime/src/index.ts"));
    const symlink = await analyzeCanonicalRepository({
      repositoryPath: symlinkRoot, seedFiles: ["scripts/check.cjs"]
    });
    assert.equal(symlink.decision, "repo_intelligence_blocked");
    assert(symlink.issues.some((issue) => issue.code === "repository_symlink_rejected"));

    console.log("P7.8 exact relative-import fixtures smoke passed");
  } finally {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
