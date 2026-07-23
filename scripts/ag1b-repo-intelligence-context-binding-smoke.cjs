const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REPORT_PATH = "reports/ag/AG1B_REPO_INTELLIGENCE_CONTEXT_BINDING.json";

async function main() {
  const mode = process.argv.includes("--report")
    ? "report"
    : process.argv.includes("--verify")
      ? "verify"
      : "test";

  const {
    runRepoIntelligenceBoundCoderFlow,
    verifyRepoIntelligenceContextBinding
  } = await import(
    "../dist/packages/product-runtime/src/repo-intelligence-context-binding.js"
  );
  const {
    analyzeCanonicalRepository
  } = await import(
    "../dist/packages/product-runtime/src/canonical-repo-intelligence.js"
  );
  const {
    hashCanonicalJson
  } = await import(
    "../dist/packages/product-runtime/src/agent-event-ledger.js"
  );
  const canonicalRuntime = await import(
    "../dist/packages/product-runtime/src/canonical-runtime.js"
  );

  const roots = [];
  const checks = [];
  const check = async (name, fn) => {
    process.stdout.write(`[run] ${name}\n`);
    await fn();
    checks.push(name);
    process.stdout.write(`[ok] ${name}\n`);
  };

  const fixture = async (overrides = {}) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ag1b-binding-"));
    roots.push(root);
    const files = {
      "src/index.ts": [
        'import { compute } from "./service.js";',
        'export { compute } from "./service.js";',
        'export const run = (value: Input) => compute(value);',
        'import type { Input } from "./types.js";'
      ].join("\n") + "\n",
      "src/service.ts": [
        'import type { Input } from "./types.js";',
        'export function compute(value: Input): number { return value.amount * 2; }'
      ].join("\n") + "\n",
      "src/types.ts": "export type Input = { amount: number };\n",
      "src/unrelated.ts": "export const unrelated = true;\n",
      "tests/service.test.ts": [
        'import { compute } from "../src/service.js";',
        'void compute({ amount: 2 });'
      ].join("\n") + "\n",
      "package.json": '{"type":"module"}\n',
      ...overrides
    };
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, "utf8");
    }
    return { root, files };
  };

  const evidenceFor = (files, paths) => paths.map((file) => {
    const content = files[file];
    const bytes = Buffer.from(content, "utf8");
    return {
      path: file,
      source: "ag1b_fixture",
      content,
      contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      byteLength: bytes.length,
      estimatedTokens: Math.ceil(content.length / 4),
      matchedSymbols: file === "src/service.ts" ? ["compute"] : []
    };
  });

  const runReady = async (root, files) => {
    let coderCalls = 0;
    let requestCalls = 0;
    let observedContext = null;
    const result = await runRepoIntelligenceBoundCoderFlow({
      repositoryPath: root,
      seedFiles: ["src/index.ts"],
      baseContext: { task: "Double an input amount." },
      initialEvidence: evidenceFor(files, [
        "src/index.ts",
        "src/service.ts",
        "src/types.ts",
        "tests/service.test.ts"
      ]),
      requiredTestFiles: ["tests/service.test.ts"],
      requiredSymbols: ["compute"],
      authorityPresent: true,
      policyPresent: true,
      hardTotalBudgetTokens: 8192,
      reservedOutputTokens: 512,
      contextRequestProvider: async () => {
        requestCalls += 1;
        throw new Error("Context request provider must not be called for complete evidence.");
      },
      coderProvider: async (context) => {
        coderCalls += 1;
        observedContext = context;
        return {
          kind: "patch",
          files: ["src/service.ts"]
        };
      }
    });
    return { result, coderCalls, requestCalls, observedContext };
  };

  let readyCase;
  try {
    const firstFixture = await fixture();
    const before = treeDigest(firstFixture.root);
    readyCase = await runReady(firstFixture.root, firstFixture.files);

    await check("canonical v0.2-dev entrypoint exports intelligence binding", async () => {
      assert.equal(
        canonicalRuntime.CANONICAL_PRODUCT_RUNTIME_ENTRYPOINT,
        "canonical-product-runtime/v0.2-dev"
      );
      assert.equal(typeof canonicalRuntime.analyzeCanonicalRepository, "function");
      assert.equal(typeof canonicalRuntime.runRepoIntelligenceBoundCoderFlow, "function");
      assert.equal(typeof canonicalRuntime.verifyRepoIntelligenceContextBinding, "function");
    });

    await check("intelligence binding completes before exactly one coder call", async () => {
      assert.equal(readyCase.result.decision, "repo_context_binding_completed", JSON.stringify(readyCase.result));
      assert.equal(readyCase.result.route, "coder_executed");
      assert.equal(readyCase.coderCalls, 1);
      assert.equal(readyCase.requestCalls, 0);
      assert.equal(readyCase.result.summary.intelligenceCallCount, 1);
      assert.equal(readyCase.result.summary.adaptiveFlowCallCount, 1);
    });

    await check("dependency closure becomes required and allowed context", async () => {
      assert(readyCase.result.binding);
      assert.deepEqual(readyCase.result.binding.requiredSourceFiles, [
        "src/index.ts",
        "src/service.ts",
        "src/types.ts"
      ]);
      assert.deepEqual(readyCase.result.binding.requiredTestFiles, [
        "tests/service.test.ts"
      ]);
      assert.deepEqual(readyCase.result.binding.allowedContextFiles, [
        "src/index.ts",
        "src/service.ts",
        "src/types.ts",
        "tests/service.test.ts"
      ]);
    });

    await check("coder receives hash-bound graph context and repository evidence", async () => {
      assert(readyCase.observedContext);
      const base = readyCase.observedContext.baseContext;
      assert.equal(base.version, "1");
      assert.equal(base.repositoryIntelligence.bindingHash, readyCase.result.binding.bindingHash);
      assert.deepEqual(base.repositoryIntelligence.dependencyClosure, readyCase.result.binding.requiredSourceFiles);
      assert(base.repositoryIntelligence.dependencyEdges.some(
        (edge) => edge.from === "src/index.ts" && edge.to === "src/service.ts"
      ));
      assert.deepEqual(
        readyCase.observedContext.evidence.map((entry) => entry.path).sort(),
        readyCase.result.binding.allowedContextFiles
      );
    });

    await check("binding receipt is deterministic and tamper evident", async () => {
      assert.equal(verifyRepoIntelligenceContextBinding(readyCase.result.binding), true);
      const tampered = JSON.parse(JSON.stringify(readyCase.result.binding));
      tampered.allowedContextFiles.push("src/unrelated.ts");
      assert.equal(verifyRepoIntelligenceContextBinding(tampered), false);
    });

    await check("repository identity and intelligence hash are clone-path independent", async () => {
      const secondFixture = await fixture();
      const left = await analyzeCanonicalRepository({
        repositoryPath: firstFixture.root,
        seedFiles: ["src/index.ts"]
      });
      const right = await analyzeCanonicalRepository({
        repositoryPath: secondFixture.root,
        seedFiles: ["src/index.ts"]
      });
      assert.equal(left.decision, "repo_intelligence_ready");
      assert.equal(right.decision, "repo_intelligence_ready");
      assert.equal(left.intelligence.repositoryIdentityHash, right.intelligence.repositoryIdentityHash);
      assert.equal(left.intelligence.intelligenceHash, right.intelligence.intelligenceHash);
    });

    await check("missing seed blocks before context and coder providers", async () => {
      let requests = 0;
      let coders = 0;
      const result = await runRepoIntelligenceBoundCoderFlow({
        repositoryPath: firstFixture.root,
        seedFiles: ["src/missing.ts"],
        baseContext: {},
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        contextRequestProvider: async () => { requests += 1; return {}; },
        coderProvider: async () => { coders += 1; return {}; }
      });
      assert.equal(result.decision, "repo_context_binding_stopped");
      assert.equal(result.summary.adaptiveFlowCallCount, 0);
      assert.equal(requests, 0);
      assert.equal(coders, 0);
    });

    await check("evidence outside the intelligence boundary is rejected", async () => {
      let coders = 0;
      const result = await runRepoIntelligenceBoundCoderFlow({
        repositoryPath: firstFixture.root,
        seedFiles: ["src/index.ts"],
        baseContext: {},
        initialEvidence: evidenceFor(firstFixture.files, ["src/unrelated.ts"]),
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        contextRequestProvider: async () => ({}),
        coderProvider: async () => { coders += 1; return {}; }
      });
      assert.equal(result.decision, "repo_context_binding_invalid");
      assert(result.issues.some((entry) => entry.code === "repo_context_evidence_outside_intelligence"));
      assert.equal(result.summary.adaptiveFlowCallCount, 0);
      assert.equal(coders, 0);
    });

    await check("stale or tampered evidence bytes are rejected", async () => {
      const evidence = evidenceFor(firstFixture.files, ["src/index.ts"]);
      evidence[0].content += "// stale\n";
      const result = await runRepoIntelligenceBoundCoderFlow({
        repositoryPath: firstFixture.root,
        seedFiles: ["src/index.ts"],
        baseContext: {},
        initialEvidence: evidence,
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        contextRequestProvider: async () => ({}),
        coderProvider: async () => ({})
      });
      assert.equal(result.decision, "repo_context_binding_invalid");
      assert(result.issues.some((entry) => entry.code === "repo_context_evidence_content_mismatch"));
    });

    await check("required tests must exist in the intelligence snapshot", async () => {
      const result = await runRepoIntelligenceBoundCoderFlow({
        repositoryPath: firstFixture.root,
        seedFiles: ["src/index.ts"],
        baseContext: {},
        requiredTestFiles: ["tests/missing.test.ts"],
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        contextRequestProvider: async () => ({}),
        coderProvider: async () => ({})
      });
      assert.equal(result.decision, "repo_context_binding_stopped");
      assert(result.issues.some((entry) => entry.code === "required_test_not_in_intelligence"));
      assert.equal(result.summary.adaptiveFlowCallCount, 0);
    });

    await check("allowed and forbidden context overlap is invalid", async () => {
      const result = await runRepoIntelligenceBoundCoderFlow({
        repositoryPath: firstFixture.root,
        seedFiles: ["src/index.ts"],
        baseContext: {},
        forbiddenFiles: ["src/service.ts"],
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        contextRequestProvider: async () => ({}),
        coderProvider: async () => ({})
      });
      assert.equal(result.decision, "repo_context_binding_invalid");
      assert(result.issues.some((entry) => entry.code === "repo_context_allowed_forbidden_conflict"));
      assert.equal(result.summary.adaptiveFlowCallCount, 0);
    });

    await check("required context-request provider failure stops before coder", async () => {
      let coders = 0;
      const result = await runRepoIntelligenceBoundCoderFlow({
        repositoryPath: firstFixture.root,
        seedFiles: ["src/index.ts"],
        baseContext: {},
        initialEvidence: evidenceFor(firstFixture.files, ["src/index.ts"]),
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 4096,
        contextRequestProvider: async () => { throw new Error("provider down"); },
        coderProvider: async () => { coders += 1; return {}; }
      });
      assert.notEqual(result.decision, "repo_context_binding_completed");
      assert.equal(coders, 0);
    });

    await check("integration is read-only and declares no shell or network use", async () => {
      assert.equal(treeDigest(firstFixture.root), before);
      assert.equal(readyCase.result.summary.repositoryWritePerformed, false);
      assert.equal(readyCase.result.summary.shellExecuted, false);
      assert.equal(readyCase.result.summary.networkAccessed, false);
    });

    const reportCore = {
      reportVersion: "1",
      phase: "AG.1b",
      evidenceClass: "deterministic_fixture",
      decision: "ag1b_repo_intelligence_context_binding_verified",
      claimBoundary: "This report verifies deterministic integration and fail-closed fixtures. It is not live-model task-quality or token-savings evidence.",
      fixture: {
        seedFiles: readyCase.result.binding.seedFiles,
        requiredSourceFiles: readyCase.result.binding.requiredSourceFiles,
        requiredTestFiles: readyCase.result.binding.requiredTestFiles,
        allowedContextFiles: readyCase.result.binding.allowedContextFiles,
        repositoryIdentityHash: readyCase.result.binding.repositoryIdentityHash,
        intelligenceHash: readyCase.result.binding.intelligenceHash,
        bindingHash: readyCase.result.binding.bindingHash,
        coderProviderCallCount: readyCase.result.summary.coderProviderCallCount,
        contextRequestProviderCallCount: readyCase.result.summary.contextRequestProviderCallCount
      },
      checks,
      summary: {
        checkCount: checks.length,
        intelligenceReady: readyCase.result.summary.intelligenceReady,
        intelligenceVerified: readyCase.result.summary.intelligenceVerified,
        bindingVerified: readyCase.result.summary.bindingVerified,
        adaptiveFlowCallCount: readyCase.result.summary.adaptiveFlowCallCount,
        coderProviderCallCount: readyCase.result.summary.coderProviderCallCount,
        repositoryWritePerformed: readyCase.result.summary.repositoryWritePerformed,
        shellExecuted: readyCase.result.summary.shellExecuted,
        networkAccessed: readyCase.result.summary.networkAccessed
      }
    };
    const report = {
      ...reportCore,
      reportHash: hashCanonicalJson(reportCore)
    };

    if (mode === "report") {
      const target = path.resolve(REPORT_PATH);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ decision: "ag1b_evidence_written", path: REPORT_PATH, reportHash: report.reportHash }, null, 2));
    } else if (mode === "verify") {
      const current = JSON.parse(await fsp.readFile(path.resolve(REPORT_PATH), "utf8"));
      assert.deepEqual(current, report);
      console.log(JSON.stringify({ decision: "ag1b_evidence_ready", reportHash: report.reportHash, checkCount: checks.length }, null, 2));
    } else {
      console.log(`repo intelligence context binding smoke passed (${checks.length} checks)`);
    }
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
