#!/usr/bin/env node
"use strict";

// Offline regression fixture for the explicit-scope coder context budget fix.
//
// Reproduces the exact incident shape (allowed mutable files
// packages/worker-contract/src/index.ts + tests/smoke/contracts.ts, hard budget
// 16384/2048) through the real repo-intelligence binding + adaptive context
// flow. Before the fix the composed coder context estimated 102,042 tokens and
// the gate blocked before any provider call. After the fix the composition must
// fit the existing budget, keep binding integrity authoritative, keep closure
// metadata runtime-side, and keep bounded read-only expansion available.
//
// Zero real provider calls: the coder provider is a local spy; the context
// request provider is a local stub. All analysis is local filesystem work.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");
const ALLOWED_FILES = [
  "packages/worker-contract/src/index.ts",
  "tests/smoke/contracts.ts"
];
const REQUIRED_TEST_FILES = ["tests/smoke/contracts.ts"];
const INCIDENT_OBJECTIVE_CHARS = 1268;
const BEFORE_ESTIMATE = 102042; // persisted incident gate summary
const HARD_TOTAL_BUDGET_TOKENS = 16384;
const RESERVED_OUTPUT_TOKENS = 2048;
const AVAILABLE_INPUT_TOKENS = HARD_TOTAL_BUDGET_TOKENS - RESERVED_OUTPUT_TOKENS;

const incidentArtifact = "/private/tmp/.bounded-durable/40b224fee3fd47794e317beebf03b8d6/tasks/750741ff20ccb79e6c42204aad57621daac8913fa0038afecfa8e1a8e2137ec7/artifacts/terminal-result-481b6fc36907e268.json";

function gitStatusSnapshot() {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot, encoding: "utf8"
  }).split("\n").filter((line) => line.trim().length > 0).sort().join("\n");
}

function loadIncidentEstimate() {
  try {
    const artifact = JSON.parse(fs.readFileSync(incidentArtifact, "utf8"));
    return artifact.plannerResult.taskSeedResult.repoResult.adaptiveResult.coderResult.summary.estimatedInputTokens;
  } catch {
    return BEFORE_ESTIMATE; // incident artifacts are machine-local; CI asserts the documented baseline
  }
}

function evidenceFor(root, files) {
  return files.map((file) => {
    const bytes = fs.readFileSync(path.join(root, file));
    const content = bytes.toString("utf8");
    return {
      path: file,
      source: "fixture",
      content,
      contentHash: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
      estimatedTokens: Math.ceil(content.length / 4),
      matchedSymbols: []
    };
  });
}

async function main() {
  const bindingModule = await import(pathToFileURL(path.join(repoRoot,
    "dist/packages/product-runtime/src/repo-intelligence-context-binding.js")).href);
  const { runRepoIntelligenceBoundCoderFlow, verifyRepoIntelligenceContextBinding } = bindingModule;

  const beforeEstimate = loadIncidentEstimate();
  const gitStatusBefore = gitStatusSnapshot();

  const evidence = ALLOWED_FILES.map((file) => {
    const bytes = fs.readFileSync(path.join(repoRoot, file));
    const content = bytes.toString("utf8");
    return {
      path: file,
      source: "bounded_codex_explicit_scope_v0",
      content,
      contentHash: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
      estimatedTokens: Math.ceil(content.length / 4),
      matchedSymbols: []
    };
  });

  const baseInput = {
    repositoryPath: repoRoot,
    seedFiles: ALLOWED_FILES,
    baseContext: {
      version: "1",
      taskContext: {
        objective: "x".repeat(INCIDENT_OBJECTIVE_CHARS),
        seedFiles: ALLOWED_FILES,
        requiredSymbols: [],
        requiredTestFiles: REQUIRED_TEST_FILES,
        explicitScopeVersion: "bounded-codex-explicit-scope/v0"
      }
    },
    initialEvidence: evidence,
    requiredTestFiles: REQUIRED_TEST_FILES,
    requiredSymbols: [],
    forbiddenFiles: [],
    authorityPresent: true,
    policyPresent: true,
    hardTotalBudgetTokens: HARD_TOTAL_BUDGET_TOKENS,
    reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
    maxExpansionAttempts: 1,
    maxContextFileBytes: 1024 * 1024,
    maxContextTotalBytes: 4 * 1024 * 1024,
    intelligenceLimits: {}
  };

  // ---------- 1. Happy path: composition fits, coder provider is reached ----------
  let coderCalls = 0;
  let requestCalls = 0;
  let capturedContext = null;
  let capturedRuntime = null;
  const happy = await runRepoIntelligenceBoundCoderFlow({
    ...baseInput,
    contextRequestProvider: async () => {
      requestCalls += 1;
      throw new Error("Context expansion must not be needed when all required evidence is present.");
    },
    coderProvider: async (context, runtime) => {
      coderCalls += 1;
      capturedContext = context;
      capturedRuntime = runtime;
      return { patch: "ok" };
    }
  });

  assert.equal(happy.decision, "repo_context_binding_completed",
    "binding flow must complete under the existing budget: " + JSON.stringify(happy.decision) + " " + JSON.stringify(happy.issues));
  assert.equal(happy.route, "coder_executed");
  assert.equal(coderCalls, 1, "fake coder provider must be reached exactly once");
  assert.equal(requestCalls, 0, "no expansion may be requested on the happy path");

  const afterEstimate = happy.adaptiveResult.coderResult.summary.estimatedInputTokens;
  console.log(`before estimate: ${beforeEstimate} tokens (incident gate summary)`);
  console.log(`after estimate:  ${afterEstimate} tokens`);
  assert.ok(afterEstimate <= AVAILABLE_INPUT_TOKENS,
    `composed context ${afterEstimate} must fit the ${AVAILABLE_INPUT_TOKENS}-token input budget`);
  assert.ok(afterEstimate > 0);

  // ---------- 2. Binding integrity and scope invariants ----------
  const binding = happy.result ? happy.result.binding : happy.binding;
  assert.ok(binding, "binding receipt must be returned");
  assert.equal(verifyRepoIntelligenceContextBinding(binding), true, "binding receipt must verify");
  assert.deepEqual(binding.requiredSourceFiles, ALLOWED_FILES, "mutable scope stays exactly the two planned files");
  assert.deepEqual(binding.seedFiles, ALLOWED_FILES, "seed identity stays exactly the two planned files");
  assert.deepEqual(binding.requiredTestFiles, REQUIRED_TEST_FILES);
  assert.equal(binding.allowedContextFiles.length > ALLOWED_FILES.length, true,
    "read-only dependency closure remains the runtime readable boundary");
  // The current repository intelligence legitimately differs from the incident
  // snapshot (the fix itself edits tracked sources); integrity is asserted by
  // the binding receipt, not by pinning a historical analysis hash.

  // ---------- 3. Model-facing context shape ----------
  const base = capturedContext.baseContext;
  assert.equal(base.version, "2");
  const ri = base.repositoryIntelligence;
  assert.equal(ri.bindingHash, binding.bindingHash, "bindingHash remains the model-visible integrity pointer");
  assert.equal(ri.intelligenceHash, happy.intelligence.intelligenceHash);
  assert.equal(ri.repositoryIdentityHash, happy.intelligence.repositoryIdentityHash);
  // Closure-wide metadata must NOT be eagerly serialized (Parts A/B).
  assert.equal(ri.files, undefined, "closure file metadata must not be serialized");
  assert.equal(ri.dependencyClosure, undefined, "closure path list must not be serialized");
  assert.equal(ri.dependencyEdges, undefined, "closure-wide edges must not be serialized");
  assert.equal(base.implementationContract, undefined, "contract hashes stay runtime-side");

  // No eager dependency graph at all (Part B): import statements are visible
  // in the evidence contents, the workspace exposes the readable boundary
  // read-only, and dependency files load on demand through bounded expansion
  // (proven by the expansion case below).
  assert.equal(ri.directDependencyImports, undefined,
    "model-facing dependency edges must not be eagerly serialized");

  // No closure-only file's symbol payload may leak into the composed context:
  // compare against a closure-only file's symbol list from runtime intelligence.
  const evidencePaths = new Set(capturedContext.evidence.map((entry) => entry.path));
  const closureOnlyFile = happy.intelligence.scannedFiles.find((file) =>
    !evidencePaths.has(file.path) && binding.allowedContextFiles.includes(file.path) &&
    Array.isArray(file.symbols) && file.symbols.length > 0
  );
  if (closureOnlyFile !== undefined) {
    const serialized = JSON.stringify(capturedContext);
    const leak = closureOnlyFile.symbols.find((symbol) =>
      typeof symbol === "string" && symbol.length > 8 && !ALLOWED_FILES.some((f) => {
        const content = capturedContext.evidence.find((e) => e.path === f)?.content ?? "";
        return content.includes(symbol);
      })
    );
    if (leak !== undefined) {
      assert.equal(serialized.includes(leak), false,
        `closure-only symbol payload must not appear in the composed context: ${closureOnlyFile.path} ${leak}`);
    }
  }

  // ---------- 4. Evidence and runtime authorization channel ----------
  assert.deepEqual(capturedContext.evidence.map((entry) => entry.path).sort(), ALLOWED_FILES,
    "exactly the two allowed files may be exposed as evidence");
  const contractsEvidence = capturedContext.evidence.find((entry) => entry.path === "tests/smoke/contracts.ts");
  assert.ok(contractsEvidence.content.includes("import "), "required test evidence content is present");
  assert.deepEqual(capturedRuntime.readableFiles, binding.allowedContextFiles,
    "readable boundary reaches the provider runtime-side, not through the prompt");
  assert.equal("readableFiles" in capturedContext, false,
    "runtime authorization list must not be serialized into the model-facing context");
  assert.equal("provenance" in capturedContext, false,
    "duplicate provenance list must not be serialized into the model-facing context");

  // ---------- 5. Budget-block telemetry (Part E gate surface) ----------
  let blockedCoderCalls = 0;
  const blocked = await runRepoIntelligenceBoundCoderFlow({
    ...baseInput,
    hardTotalBudgetTokens: 4096,
    contextRequestProvider: async () => ({ requestedFiles: [], requestedSymbols: [], requestedTests: [] }),
    coderProvider: async () => { blockedCoderCalls += 1; return { patch: "ok" }; }
  });
  assert.equal(blocked.decision, "repo_context_binding_stopped");
  assert.equal(blockedCoderCalls, 0, "budget block must stop before the coder provider");
  const blockedIssues = blocked.adaptiveResult?.coderResult?.issues ?? [];
  const budgetIssue = blockedIssues.find((entry) => entry.code === "coder_context_hard_budget_exceeded");
  assert.ok(budgetIssue, "budget block must surface the stable failure code");
  assert.equal(budgetIssue.composedContextEstimatedTokens > 0, true);
  assert.equal(budgetIssue.hardTotalBudgetTokens, 4096);
  assert.equal(budgetIssue.reservedOutputTokens, RESERVED_OUTPUT_TOKENS);
  assert.equal(budgetIssue.availableInputTokens, 4096 - RESERVED_OUTPUT_TOKENS);
  assert.equal(budgetIssue.visibleFileCount, 2);

  // ---------- 6. Adaptive read-only expansion remains available ----------
  // Proven on a bounded synthetic repository: the incident repo's required
  // test file exceeds the expansion contract's own per-request token cap
  // (maxAdditionalTokens <= 8192, fail-closed by design), so the mechanism is
  // exercised where the loaded file fits it. Mutable scope semantics are
  // identical to the incident flow.
  {
    const os = require("node:os");
    const fs = require("node:fs");
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "expansion-fixture-"));
    try {
      fs.mkdirSync(path.join(fixtureRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(fixtureRoot, "tests"), { recursive: true });
      fs.mkdirSync(path.join(fixtureRoot, ".git"), { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, "src", "index.ts"), 'import { compute } from "./service.js";\nexport function run(input: number): number {\n  return compute(input);\n}\n');
      fs.writeFileSync(path.join(fixtureRoot, "src", "service.ts"), "export function compute(input: number): number {\n  return input * 2;\n}\n");
      fs.writeFileSync(path.join(fixtureRoot, "tests", "service.test.ts"), 'import { compute } from "../src/service.js";\nif (compute(2) !== 4) throw new Error("fixture");\n\nexport {};\n');
      const digestBefore = ["src/index.ts", "src/service.ts", "tests/service.test.ts"]
        .map((f) => f + ":" + createHash("sha256").update(fs.readFileSync(path.join(fixtureRoot, f))).digest("hex"))
        .join("|");
      let expansionRequests = 0;
      let expansionCoderCalls = 0;
      let expansionEvidencePaths = null;
      let expansionRuntimePaths = null;
      const expanded = await runRepoIntelligenceBoundCoderFlow({
        repositoryPath: fixtureRoot,
        seedFiles: ["src/index.ts", "tests/service.test.ts"],
        baseContext: { version: "1", taskContext: { objective: "Extend the fixture service.", seedFiles: ["src/index.ts", "tests/service.test.ts"], requiredSymbols: [], requiredTestFiles: ["tests/service.test.ts"] } },
        initialEvidence: evidenceFor(fixtureRoot, ["src/index.ts"]),
        requiredTestFiles: ["tests/service.test.ts"],
        requiredSymbols: [],
        forbiddenFiles: [],
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: HARD_TOTAL_BUDGET_TOKENS,
        reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
        maxExpansionAttempts: 1,
        maxContextFileBytes: 1024 * 1024,
        maxContextTotalBytes: 4 * 1024 * 1024,
        intelligenceLimits: {},
        contextRequestProvider: async (state) => {
          expansionRequests += 1;
          assert.equal(state.requiredTestFiles.includes("tests/service.test.ts"), true);
          return {
            requestedFiles: [],
            requestedSymbols: [],
            requestedTests: ["tests/service.test.ts"],
            evidenceKinds: ["required_test"],
            reason: "Fixture: required test evidence is missing and must be loaded read-only.",
            scopeExpansionRequested: false,
            maxAdditionalTokens: 8192
          };
        },
        coderProvider: async (context, runtime) => {
          expansionCoderCalls += 1;
          expansionEvidencePaths = context.evidence.map((entry) => entry.path).sort();
          expansionRuntimePaths = runtime.readableFiles;
          return { patch: "ok" };
        }
      });
      assert.equal(expanded.decision, "repo_context_binding_completed", JSON.stringify(expanded.issues));
      assert.equal(expansionRequests, 1, "the bounded expansion request must be exercised");
      assert.equal(expansionCoderCalls, 1, "the coder must run after read-only expansion");
      assert.deepEqual(expansionEvidencePaths, ["src/index.ts", "tests/service.test.ts"],
        "expansion loads exactly the requested required-test file");
      assert.deepEqual(expansionRuntimePaths, expanded.binding.allowedContextFiles,
        "expansion does not change the runtime readable boundary");
      const digestAfter = ["src/index.ts", "src/service.ts", "tests/service.test.ts"]
        .map((f) => f + ":" + createHash("sha256").update(fs.readFileSync(path.join(fixtureRoot, f))).digest("hex"))
        .join("|");
      assert.equal(digestAfter, digestBefore, "expansion must be read-only");
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }

  // ---------- 7. The offline run leaves the repository untouched ----------
  assert.equal(gitStatusSnapshot(), gitStatusBefore,
    "the offline fixture run must not modify the repository");

  assert.ok(afterEstimate < beforeEstimate, "the composition must be strictly smaller than the incident baseline");
  console.log("explicit-scope-coder-context-fixture: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
