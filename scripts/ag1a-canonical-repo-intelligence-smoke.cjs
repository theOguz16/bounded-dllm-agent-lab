const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const {
    analyzeCanonicalRepository,
    verifyCanonicalRepoIntelligence
  } = await import(
    "../dist/packages/product-runtime/src/canonical-repo-intelligence.js"
  );

  const checks = [];
  const roots = [];
  const check = async (name, fn) => {
    process.stdout.write(`[run] ${name}\n`);
    await fn();
    checks.push(name);
    process.stdout.write(`[ok] ${name}\n`);
  };

  const fixture = async (overrides = {}) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ag1a-ri-"));
    roots.push(root);
    const files = {
      "src/index.ts": [
        'import { service } from "./service.js";',
        'import "node:fs";',
        'export { service } from "./service.js";',
        'export const loadLazy = () => import("./lazy.js");'
      ].join("\n"),
      "src/service.ts": [
        'import { value } from "./util";',
        'export function service(): number { return value; }'
      ].join("\n"),
      "src/util.ts": "export const value = 7;\n",
      "src/lazy.ts": "export class LazyFeature {}\n",
      "src/unrelated.ts": "export interface Unrelated {}\n",
      "package.json": '{"type":"module"}\n',
      ...overrides
    };
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, "utf8");
    }
    return root;
  };

  try {
    const root = await fixture();
    const before = treeDigest(root);
    const baseInput = { repositoryPath: root, seedFiles: ["src/index.ts"] };
    const first = await analyzeCanonicalRepository(baseInput);

    await check("AST graph resolves NodeNext .js imports to TypeScript sources", async () => {
      assert.equal(first.decision, "repo_intelligence_ready", JSON.stringify(first));
      assert(first.intelligence);
      assert(first.intelligence.dependencyEdges.some(
        (edge) => edge.from === "src/index.ts" && edge.to === "src/service.ts"
      ));
      assert(first.intelligence.dependencyEdges.some(
        (edge) => edge.from === "src/index.ts" && edge.to === "src/lazy.ts" && edge.kind === "dynamic_import"
      ));
    });

    await check("seed dependency closure is deterministic and bounded", async () => {
      assert.deepEqual(first.intelligence.dependencyClosure, [
        "src/index.ts",
        "src/lazy.ts",
        "src/service.ts",
        "src/util.ts"
      ]);
      const second = await analyzeCanonicalRepository(baseInput);
      assert.equal(second.decision, "repo_intelligence_ready");
      assert.equal(second.intelligence.intelligenceHash, first.intelligence.intelligenceHash);
    });

    await check("top-level symbols exports and external dependencies are inventoried", async () => {
      const service = first.intelligence.scannedFiles.find((file) => file.path === "src/service.ts");
      const entry = first.intelligence.scannedFiles.find((file) => file.path === "src/index.ts");
      assert(service.symbols.some((symbol) => symbol.name === "service" && symbol.kind === "function" && symbol.exported));
      assert(entry.externalDependencies.includes("node:fs"));
      assert(entry.exports.includes("service"));
      assert(entry.exports.includes("loadLazy"));
    });

    await check("intelligence hash is tamper evident", async () => {
      assert.equal(verifyCanonicalRepoIntelligence(first.intelligence), true);
      const tampered = JSON.parse(JSON.stringify(first.intelligence));
      tampered.dependencyClosure.push("src/unrelated.ts");
      assert.equal(verifyCanonicalRepoIntelligence(tampered), false);
    });

    await check("analysis performs no repository writes shell or network access", async () => {
      assert.equal(treeDigest(root), before);
      assert.equal(first.summary.repositoryWritePerformed, false);
      assert.equal(first.summary.shellExecuted, false);
      assert.equal(first.summary.networkAccessed, false);
    });

    await check("missing seed files fail closed", async () => {
      const result = await analyzeCanonicalRepository({
        repositoryPath: root,
        seedFiles: ["src/missing.ts"]
      });
      assert.equal(result.decision, "repo_intelligence_blocked");
      assert(result.issues.some((issue) => issue.code === "seed_file_not_found"));
    });

    await check("repository-relative seed traversal is invalid", async () => {
      const result = await analyzeCanonicalRepository({
        repositoryPath: root,
        seedFiles: ["../outside.ts"]
      });
      assert.equal(result.decision, "repo_intelligence_invalid");
      assert(result.issues.some((issue) => issue.code === "seed_file_outside_repository"));
    });

    await check("reachable unresolved relative imports block readiness", async () => {
      const unresolvedRoot = await fixture({
        "src/index.ts": 'import "./missing.js"; export const value = 1;\n'
      });
      const result = await analyzeCanonicalRepository({
        repositoryPath: unresolvedRoot,
        seedFiles: ["src/index.ts"]
      });
      assert.equal(result.decision, "repo_intelligence_blocked");
      assert(result.intelligence);
      assert(result.issues.some((issue) => issue.code === "reachable_relative_import_unresolved"));
    });

    await check("file byte and total byte budgets fail closed", async () => {
      const fileBound = await analyzeCanonicalRepository({
        ...baseInput,
        maxFileBytes: 8
      });
      assert.equal(fileBound.decision, "repo_intelligence_blocked");
      assert.equal(fileBound.summary.byteLimitReached, true);

      const totalBound = await analyzeCanonicalRepository({
        ...baseInput,
        maxFileBytes: 1024,
        maxTotalBytes: 32
      });
      assert.equal(totalBound.decision, "repo_intelligence_blocked");
      assert.equal(totalBound.summary.byteLimitReached, true);
    });

    await check("file and edge budgets fail closed", async () => {
      const fileBound = await analyzeCanonicalRepository({
        ...baseInput,
        maxFiles: 1
      });
      assert.equal(fileBound.decision, "repo_intelligence_blocked");
      assert.equal(fileBound.summary.fileLimitReached, true);

      const edgeBound = await analyzeCanonicalRepository({
        ...baseInput,
        maxEdges: 1
      });
      assert.equal(edgeBound.decision, "repo_intelligence_blocked");
      assert.equal(edgeBound.summary.edgeLimitReached, true);
    });

    await check("dependency depth budget fails before incomplete closure is accepted", async () => {
      const result = await analyzeCanonicalRepository({
        ...baseInput,
        maxDependencyDepth: 0
      });
      assert.equal(result.decision, "repo_intelligence_blocked");
      assert.equal(result.summary.dependencyDepthLimitReached, true);
    });

    await check("symlink repository entries are rejected without following them", async () => {
      const symlinkRoot = await fixture();
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "ag1a-outside-"));
      roots.push(outside);
      await fsp.writeFile(path.join(outside, "secret.ts"), "export const secret = true;\n");
      try {
        await fsp.symlink(path.join(outside, "secret.ts"), path.join(symlinkRoot, "src", "linked.ts"));
      } catch (error) {
        if (error && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return;
        throw error;
      }
      const result = await analyzeCanonicalRepository({
        repositoryPath: symlinkRoot,
        seedFiles: ["src/index.ts"]
      });
      assert.equal(result.decision, "repo_intelligence_blocked");
      assert.equal(result.summary.symlinkEncountered, true);
    });

    console.log(`canonical repo intelligence smoke passed (${checks.length} checks)`);
  } finally {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  }
}

function treeDigest(root) {
  const hash = createHash("sha256");
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      hash.update(relative);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(absolute));
      else hash.update(fs.readFileSync(absolute));
    }
  };
  walk(root);
  return hash.digest("hex");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
