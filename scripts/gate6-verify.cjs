#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Gate6VerifierError, assertCleanGitTree, createPreflightRecord, gitHead, verifyEvidenceDirectory, writeEvidencePackage } = require("./lib/gate6-verifier-provenance.cjs");

const ROOT = path.resolve(__dirname, "..");
function parseArgs(argv) {
  const args = { evidenceDir: null, rawReport: null, runtimeIdentity: null, outputDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--evidence-dir", "--raw-report", "--runtime-identity", "--output-dir"].includes(key)) throw new Error(`unknown argument: ${key}`);
    const value = argv[index + 1]; if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`); index += 1;
    if (key === "--evidence-dir") args.evidenceDir = value;
    if (key === "--raw-report") args.rawReport = value;
    if (key === "--runtime-identity") args.runtimeIdentity = value;
    if (key === "--output-dir") args.outputDir = value;
  }
  const packagingCount = [args.rawReport, args.runtimeIdentity, args.outputDir].filter(Boolean).length;
  if (packagingCount !== 0 && packagingCount !== 3) throw new Error("--raw-report, --runtime-identity and --output-dir must be supplied together");
  if (args.evidenceDir && packagingCount !== 0) throw new Error("--evidence-dir cannot be combined with packaging arguments");
  return args;
}
function runCheck(relativePath) {
  const result = spawnSync(process.execPath, [path.join(ROOT, relativePath)], { cwd: ROOT, encoding: "utf8", env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`preflight check failed: ${relativePath}`);
}
function runRegressionPreflight() {
  for (const check of ["tests/gate6/repository-manifest.test.cjs", "tests/gate6/taskset.test.cjs", "tests/gate6/precondition-freeze.test.cjs", "tests/gate6/oracle-separation.test.cjs", "tests/gate6/context-strategies.test.cjs", "tests/gate6/context-escalation.test.cjs", "tests/gate6/simulated-coding-harness.test.cjs", "tests/gate6/simulated-coding-integrity.test.cjs", "tests/gate6/comparative-report.test.cjs", "tests/gate6/verifier.test.cjs"]) runCheck(check);
}
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
function main() {
  const args = parseArgs(process.argv.slice(2)); assertCleanGitTree(ROOT); const sourceSha = gitHead(ROOT); runRegressionPreflight();
  if (args.evidenceDir) {
    const verified = verifyEvidenceDirectory({ rootPath: ROOT, evidenceDir: path.resolve(args.evidenceDir), expectedSourceSha: sourceSha });
    process.stdout.write("GATE6_EVIDENCE=VERIFIED\n");
    for (const [strategy, decision] of Object.entries(verified.evidence.goNoGo.promotion.decisions)) process.stdout.write(`GATE6_PROMOTION_${strategy}=${decision.status}\n`);
  } else if (args.rawReport) {
    const rawReport = readJson(path.resolve(args.rawReport)); const runtimeIdentity = fs.readFileSync(path.resolve(args.runtimeIdentity), "utf8");
    if (rawReport.experimentConfig?.sourceSha !== sourceSha) throw new Error(`raw report source SHA ${rawReport.experimentConfig?.sourceSha} does not match ${sourceSha}`);
    const preflight = createPreflightRecord({ rootPath: ROOT, sourceSha, mode: "runtime_checkout" });
    const result = writeEvidencePackage({ rootPath: ROOT, outputDir: path.resolve(args.outputDir), rawReport, runtimeIdentity, preflight });
    verifyEvidenceDirectory({ rootPath: ROOT, evidenceDir: result.outputDir, expectedSourceSha: sourceSha });
    process.stdout.write(`GATE6_EVIDENCE_DIR=${result.outputDir}\nGATE6_EVIDENCE=VERIFIED\n`);
  } else {
    const preflight = createPreflightRecord({ rootPath: ROOT, sourceSha, mode: "frozen_attestation" });
    process.stdout.write(`GATE6_SOURCE_SHA=${sourceSha}\nGATE6_TASKSET_VERSION=${preflight.tasksetVersion}\nGATE6_TASKSET_HASH=${preflight.tasksetHash}\nGATE6_REPOSITORY_MANIFEST=${preflight.repositoryManifest}\nGATE6_EXTERNAL_REPOSITORY_SHAS=${preflight.externalRepositoryShas}\nGATE6_ORACLE_VALIDATION=${preflight.oracleValidation}\nGATE6_ORACLE_LEAK_TESTS=${preflight.oracleLeakTests}\nGATE6_CONTEXT_STRATEGY_TESTS=${preflight.contextStrategyTests}\nGATE6_OFFLINE_FIXTURE=${preflight.offlineFixture}\nGATE6_RECEIPT_PROVENANCE=PASS\n`);
  }
  process.stdout.write("GATE6_VERIFY=PASS\n");
}
try { main(); } catch (error) { const code = error instanceof Gate6VerifierError ? error.code : "GATE6_VERIFY_FAILED"; process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
