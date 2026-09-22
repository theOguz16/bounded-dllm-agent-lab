#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "../..");
const catalogFile = path.join(__dirname, "evaluator/p7-14-trusted-catalog-v3.json");
const checkerFile = path.join(__dirname, "evaluator/p7-14-independent-behavior-check.cjs");
const sha = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const git = (...args) => cp.execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 20_000, maxBuffer: 20_000_000 }).trim();
const gitBytes = (commit, file) => cp.execFileSync("git", ["show", `${commit}:${file}`], { cwd: root, timeout: 20_000, maxBuffer: 20_000_000 });
function snapshot(workspace) {
  const entries = [];
  const walk = (dir, prefix = "") => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (prefix === "" && (name === "node_modules" || name === "dist" || name === "reports")) continue;
      const full = path.join(dir, name), relative = prefix ? `${prefix}/${name}` : name;
      const info = fs.lstatSync(full);
      if (info.isSymbolicLink()) throw new Error("Candidate symlink is not allowed");
      if (info.isDirectory()) walk(full, relative);
      else { assert.equal(info.isFile(), true); entries.push([relative, sha(fs.readFileSync(full))]); }
    }
  };
  walk(workspace);
  return sha(JSON.stringify(entries));
}
const assertionOverlays = Object.freeze({
  "dogfood.v2.behavior.discovery-cost": [{
    path: "scripts/smoke/bounded-compare-codex-smoke.cjs",
    commit: "351aea5db624ecad05a2fc7b096629f61dd379aa"
  }]
});
function workspace(parent, name, commit, files, override = null, taskId = null) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  const archive = cp.spawnSync("git", ["archive", commit], { cwd: root, maxBuffer: 100_000_000 });
  assert.equal(archive.status, 0, String(archive.stderr));
  const extract = cp.spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout, maxBuffer: 100_000_000 });
  assert.equal(extract.status, 0, String(extract.stderr));
  if (override) fs.writeFileSync(path.join(dir, override.path), override.bytes);
  for (const overlay of assertionOverlays[taskId] || []) {
    fs.writeFileSync(path.join(dir, overlay.path), gitBytes(overlay.commit, overlay.path), { mode: 0o444 });
  }
  return dir;
}
function prepareDependencies(source, peers) {
  const result = cp.spawnSync("npm", ["ci", "--prefer-offline", "--ignore-scripts", "--no-audit"], {
    cwd: source, encoding: "utf8", timeout: 180_000, maxBuffer: 4_000_000,
    env: { ...process.env }
  });
  const record = { status: result.status, signal: result.signal, error: result.error?.message || null,
    stdout: String(result.stdout || "").slice(0, 64 * 1024), stderr: String(result.stderr || "").slice(0, 64 * 1024) };
  assert.equal(result.status, 0, `dependency preparation failed: ${JSON.stringify(record)}`);
  for (const peer of peers) fs.symlinkSync(path.join(source, "node_modules"), path.join(peer, "node_modules"), "dir");
  return record;
}
function seal(unsigned, key) {
  return { ...unsigned, seal: crypto.createHmac("sha256", key).update(JSON.stringify(unsigned)).digest("hex") };
}
function observe(checker, directory, definition, evidenceDir, stem) {
  const result = checker.inspectBehavior(directory, definition);
  const raw = Buffer.from(JSON.stringify(result.output));
  const rawFile = path.join(evidenceDir, `${stem}.json`);
  fs.writeFileSync(rawFile, raw, { mode: 0o600, flag: "wx" });
  assert.equal(sha(fs.readFileSync(rawFile)), result.outputHash);
  const observation = { workspaceHash: snapshot(directory), verdict: result.verdict,
    exitCode: result.exitCode, outputHash: result.outputHash };
  const execution = { ...observation, artifactHash: sha(JSON.stringify(observation)) };
  Object.defineProperty(execution, "networkIsolationVerified", {
    value: result.output.networkIsolation?.verified === true, enumerable: false
  });
  return execution;
}
function comparisonInput(evidence) {
  return {
    correctness: { controlPassed: true, taskSucceeded: true, testsPassed: true, buildPassed: true, typecheckPassed: true },
    behaviorEvidence: evidence,
    control: { scopeViolationCount: 0, forbiddenTouchCount: 0, unsupportedMutationCount: 0,
      changedFiles: [], changedFileNecessityAssessments: [] },
    efficiency: { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null,
      totalTokens: null, exposedFiles: 0, exposedBytes: 0, commandCount: 0, failedCommandCount: 0,
      repairRounds: 0, durationMs: 0 }
  };
}
async function main() {
  const { evaluateTrustedBehaviorEvidence, evaluateTrustedProductComparison } =
    await import(pathToFileURL(path.join(root, "dist/packages/product-runtime/src/canonical-runtime.js")).href);
  const catalogBytes = fs.readFileSync(catalogFile);
  const catalog = JSON.parse(catalogBytes);
  const taskset = JSON.parse(fs.readFileSync(path.join(__dirname, "tasks/dogfood/taskset-v2.json"), "utf8"));
  assert.equal(catalog.schemaVersion, "product-dogfood-trusted-acceptance/v3");
  assert.equal(catalog.providerVisible, false);
  assert.equal(catalog.acceptanceFilesMutableByAgent, false);
  assert.equal(catalog.entries.length, 20);
  assert.equal(new Set(catalog.entries.map((entry) => entry.taskId)).size, 20);
  assert.deepEqual(new Set(catalog.entries.map((entry) => entry.taskId)), new Set(taskset.tasks.map((task) => task.taskId)));
  const trustedStat = fs.statSync(checkerFile);
  assert.equal((trustedStat.mode & 0o022), 0, "Trusted checker cannot be group/world writable");
  const checker = require(checkerFile);
  const key = crypto.randomBytes(32);
  const externalEvidence = process.env.P7_14_EVIDENCE_DIR;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p7-14-all-triads-"));
  const evidenceDir = externalEvidence ? path.resolve(externalEvidence) : path.join(temp, "trusted-artifacts");
  if (externalEvidence) {
    assert.equal(path.isAbsolute(externalEvidence), true);
    assert.equal(path.relative(root, evidenceDir).startsWith(".."), true);
    assert.equal(path.relative(temp, evidenceDir).startsWith(".."), true);
  }
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const records = [];
  try {
    const selectedEntries = process.env.P7_14_ONLY_TASK
      ? catalog.entries.filter((entry) => entry.taskId === process.env.P7_14_ONLY_TASK)
      : catalog.entries;
    assert.ok(selectedEntries.length > 0, "P7_14_ONLY_TASK did not match the catalog");
    for (const [index, entry] of selectedEntries.entries()) {
      process.stderr.write(`P7.14 execute ${index + 1}/20 ${entry.taskId}\n`);
      const task = taskset.tasks.find((item) => item.taskId === entry.taskId);
      assert.ok(task);
      assert.equal(task.commitSha, entry.sourceCommitSha);
      assert.equal(entry.requiredCriteria.length, task.acceptanceCriteria.length);
      assert.equal(git("cat-file", "-t", entry.sourceCommitSha), "commit");
      assert.equal(git("cat-file", "-t", entry.referenceCommitSha), "commit");
      const files = git("diff", "--name-only", "--diff-filter=M", entry.sourceCommitSha, entry.referenceCommitSha).split("\n").filter(Boolean);
      const allChanged = git("diff", "--name-only", entry.sourceCommitSha, entry.referenceCommitSha).split("\n").filter(Boolean);
      assert.ok(files.length > 0, `${entry.taskId}: no behavior-bearing files`);
      assert.deepEqual(files, allChanged, `${entry.taskId}: only existing-file changes are eligible`);
      const criterion = entry.requiredCriteria[0];
      assert.equal(criterion.criterionIndex, 0);
      assert.equal(path.resolve(root, criterion.checkFile), checkerFile);
      const definition = { taskId: entry.taskId, criterionId: criterion.criterionId,
        assertionId: `executed:${criterion.criterionId}`, behaviorCommand: criterion.behaviorCommand };
      const stem = String(index + 1).padStart(2, "0") + "-" + entry.taskId.replace(/[^a-z0-9]+/g, "-");
      const taskDir = path.join(temp, stem);
      const source = workspace(taskDir, "source", entry.sourceCommitSha, files, null, entry.taskId);
      const reference = workspace(taskDir, "reference", entry.referenceCommitSha, files, null, entry.taskId);
      const wrong = workspace(taskDir, "wrong", entry.referenceCommitSha, files,
        { path: files[0], bytes: gitBytes(entry.sourceCommitSha, files[0]) }, entry.taskId);
      const candidate = workspace(taskDir, "candidate", entry.referenceCommitSha, files, null, entry.taskId);
      const preparation = prepareDependencies(source, [reference, wrong, candidate]);
      const sourceResult = observe(checker, source, definition, evidenceDir, `${stem}-source`);
      const referenceResult = observe(checker, reference, definition, evidenceDir, `${stem}-reference`);
      const wrongResult = observe(checker, wrong, definition, evidenceDir, `${stem}-wrong`);
      const candidateResult = observe(checker, candidate, definition, evidenceDir, `${stem}-candidate`);
      const wrongCandidateResult = observe(checker, wrong, definition, evidenceDir, `${stem}-candidate-wrong`);
      const triad = [sourceResult.verdict, referenceResult.verdict, wrongResult.verdict];
      const triadSatisfied = JSON.stringify(triad) === JSON.stringify(["assertion_fail", "pass", "assertion_fail"]);
      const candidateSatisfied = candidateResult.verdict === "pass";
      const checkHash = sha(JSON.stringify([sha(fs.readFileSync(checkerFile)), definition]));
      const common = {
        taskId: task.taskId, taskHash: sha(JSON.stringify(task)), sourceCommitSha: entry.sourceCommitSha,
        sourceTreeHash: snapshot(source), referenceCommitSha: entry.referenceCommitSha,
        referenceTreeHash: snapshot(reference), wrongTreeHash: snapshot(wrong),
        catalogHash: sha(catalogBytes), candidateTreeHash: snapshot(candidate)
      };
      const unsigned = {
        receiptVersion: "trusted-behavior-evidence/v2", ...common, issuedAt: Date.now(),
        nonce: crypto.randomBytes(16).toString("hex"),
        criteria: [{ criterionId: criterion.criterionId, checkHash, source: sourceResult,
          reference: referenceResult, wrong: wrongResult, candidate: candidateResult }]
      };
      const receipt = seal(unsigned, key);
      const expected = { ...common, requiredCriteria: [{ criterionId: criterion.criterionId, checkHash }] };
      const trustedAssessment = evaluateTrustedBehaviorEvidence(receipt, expected, key);
      const trustedComparison = evaluateTrustedProductComparison(comparisonInput(receipt), expected, key);
      if (triadSatisfied && candidateSatisfied) {
        assert.equal(trustedAssessment.behaviorSatisfied, true);
        assert.equal(trustedComparison.correctness.taskSucceeded, true);
      } else {
        assert.notEqual(trustedAssessment.behaviorSatisfied, true);
        assert.notEqual(trustedComparison.correctness.taskSucceeded, true);
      }
      assert.equal(evaluateTrustedBehaviorEvidence(null, expected, key).behaviorSatisfied, null);
      const forged = structuredClone(receipt); forged.criteria[0].source.verdict = "pass";
      assert.equal(evaluateTrustedBehaviorEvidence(forged, expected, key).behaviorSatisfied, null);
      assert.equal(evaluateTrustedBehaviorEvidence(seal({ ...unsigned, criteria: [] }, key), expected, key).behaviorSatisfied, null);
      assert.equal(evaluateTrustedBehaviorEvidence(receipt,
        { ...expected, candidateTreeHash: sha("other-candidate") }, key).behaviorSatisfied, null);
      assert.equal(evaluateTrustedBehaviorEvidence(receipt, expected, key, receipt.issuedAt + 16 * 60_000).behaviorSatisfied, null);
      const wrongUnsigned = { ...unsigned, candidateTreeHash: snapshot(wrong),
        nonce: crypto.randomBytes(16).toString("hex"),
        criteria: [{ ...unsigned.criteria[0], candidate: wrongCandidateResult }] };
      const wrongReceipt = seal(wrongUnsigned, key);
      const wrongExpected = { ...expected, candidateTreeHash: snapshot(wrong) };
      assert.notEqual(evaluateTrustedBehaviorEvidence(wrongReceipt, wrongExpected, key).behaviorSatisfied, true);
      assert.notEqual(evaluateTrustedProductComparison(comparisonInput(wrongReceipt), wrongExpected, key).correctness.taskSucceeded, true);
      records.push({ taskId: task.taskId, sourceCommitSha: entry.sourceCommitSha,
        referenceCommitSha: entry.referenceCommitSha, changedFiles: files, behaviorCommand: criterion.behaviorCommand,
        checkHash, preparation: { ...preparation, outputHash: sha(JSON.stringify(preparation)) }, receipt,
        triad, triadSatisfied, candidateVerdict: candidateResult.verdict, candidateSatisfied,
        trustedBehaviorSatisfied: trustedAssessment.behaviorSatisfied,
        wrongCandidateVerdict: wrongCandidateResult.verdict,
        networkIsolationVerified: [sourceResult, referenceResult, wrongResult, candidateResult, wrongCandidateResult]
          .every((item) => item.networkIsolationVerified === true) });
    }
    const record = { version: "p7-14-triad-execution/v2", catalogHash: sha(catalogBytes),
      coverage: { historicallyExecutedTasks: records.length, suiteTasks: 20,
        passingTriads: records.filter((item) => item.triadSatisfied && item.candidateSatisfied).length,
        r03FullyClosed: records.length === 20 &&
          records.every((item) => item.triadSatisfied && item.candidateSatisfied) && !process.env.P7_14_ONLY_TASK },
      negatives: ["missing", "forged", "partial", "cross-candidate", "stale", "wrong-implementation"], records };
    fs.writeFileSync(path.join(evidenceDir, "receipt.json"), JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ ok: true, coverage: record.coverage, taskIds: records.map((item) => item.taskId),
      evidenceHash: sha(JSON.stringify(record)), artifactCount: records.length * 5 + 1 }));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
