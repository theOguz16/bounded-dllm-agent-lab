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
const runnerPath = "benchmarks/product-v1/dogfood-post-fix-runner.cjs";
const catalogFile = path.join(__dirname, "evaluator/p7-14-trusted-catalog-v3.json");
const checkerFile = path.join(__dirname, "evaluator/p7-14-failed-resume-check.cjs");
const shimFile = path.join(__dirname, "evaluator/p7-14-provider-block.cjs");
const sha = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const git = (...args) => cp.execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000 }).trim();
const gitFile = (commit) => cp.execFileSync("git", ["show", `${commit}:${runnerPath}`], {
  cwd: root, timeout: 10_000, maxBuffer: 1_000_000
});
function snapshot(workspace) {
  const entries = [];
  const walk = (dir, prefix = "") => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = fs.lstatSync(full);
      if (info.isSymbolicLink()) throw new Error("Candidate symlink is not allowed");
      if (info.isDirectory()) walk(full, relative);
      else {
        if (!info.isFile()) throw new Error("Candidate special file is not allowed");
        entries.push([relative, sha(fs.readFileSync(full))]);
      }
    }
  };
  walk(workspace);
  return sha(JSON.stringify(entries));
}
function workspace(parent, name, contents, { noopTest = false, spoofCheck = false } = {}) {
  const dir = path.join(parent, name);
  const file = path.join(dir, runnerPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, contents, { mode: 0o444 });
  const stub = path.join(dir, "benchmarks/product-v1/dogfood-resumable-runner.cjs");
  fs.writeFileSync(stub, "'use strict'; throw Error('provider execution must be blocked by the trusted preload');\n", { mode: 0o444 });
  if (noopTest) fs.writeFileSync(path.join(dir, "test.js"), "process.exit(0);\n", { mode: 0o444 });
  if (spoofCheck) {
    const spoof = path.join(dir, "benchmarks/product-v1/evaluator/p7-14-failed-resume-check.cjs");
    fs.mkdirSync(path.dirname(spoof), { recursive: true, mode: 0o755 });
    fs.writeFileSync(spoof, "module.exports={inspectFailedResume:()=>({verdict:'pass'})};\n", { mode: 0o444 });
  }
  return dir;
}
function seal(unsigned, key) {
  return { ...unsigned, seal: crypto.createHmac("sha256", key).update(JSON.stringify(unsigned)).digest("hex") };
}
function observations(checker, directory, evidenceDir, side, expectedHash) {
  const result = checker.inspectFailedResume(directory);
  const raw = JSON.stringify(result.output);
  const rawFile = path.join(evidenceDir, `${side}.json`);
  fs.writeFileSync(rawFile, raw, { mode: 0o600, flag: "wx" });
  assert.equal(sha(fs.readFileSync(rawFile)), result.outputHash,
    "The separately stored execution artifact must match its observed hash");
  const observation = {
    workspaceHash: snapshot(directory), verdict: result.verdict, exitCode: result.exitCode,
    outputHash: result.outputHash
  };
  assert.equal(observation.workspaceHash, expectedHash, "Candidate mutated during execution");
  return { ...observation, artifactHash: sha(JSON.stringify(observation)) };
}
function comparisonInput(evidence, taskSucceeded = true) {
  return {
    correctness: { controlPassed: true, taskSucceeded, testsPassed: true, buildPassed: true, typecheckPassed: true },
    behaviorEvidence: evidence,
    control: { scopeViolationCount: 0, forbiddenTouchCount: 0, unsupportedMutationCount: 0,
      changedFiles: [], changedFileNecessityAssessments: [] },
    efficiency: { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null,
      totalTokens: null, exposedFiles: 0, exposedBytes: 0, commandCount: 0, failedCommandCount: 0,
      repairRounds: 0, durationMs: 0 }
  };
}
async function main() {
  assert.equal(process.platform, "linux", "Historical trust separation requires Linux and sudo/nobody");
  const probe = cp.spawnSync("sudo", ["-n", "-u", "nobody", "--", "id", "-u"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(probe.status, 0, `Unprivileged candidate execution unavailable: ${probe.stderr}`);
  const { evaluateTrustedBehaviorEvidence, evaluateTrustedProductComparison } =
    await import(pathToFileURL(path.join(root, "dist/packages/product-runtime/src/canonical-runtime.js")).href);
  const catalogBytes = fs.readFileSync(catalogFile);
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  const tasks = JSON.parse(fs.readFileSync(path.join(__dirname, "tasks/dogfood/taskset-v2.json"), "utf8"));
  assert.equal(catalog.schemaVersion, "product-dogfood-trusted-acceptance/v3");
  assert.equal(catalog.providerVisible, false);
  assert.equal(catalog.acceptanceFilesMutableByAgent, false);
  assert.equal(catalog.entries.length, 1);
  const entry = catalog.entries[0];
  const task = tasks.tasks.find((item) => item.taskId === entry.taskId);
  assert.ok(task);
  assert.equal(entry.sourceCommitSha, task.commitSha);
  assert.equal(entry.requiredCriteria.length, task.acceptanceCriteria.length);
  assert.deepEqual(entry.requiredCriteria.map((item) => item.criterionIndex), [0]);
  const check = entry.requiredCriteria[0];
  assert.equal(path.resolve(root, check.checkFile), checkerFile);
  assert.equal(path.resolve(root, check.preloadFile), shimFile);
  const unprivilegedUid = Number(probe.stdout.trim());
  for (const file of [checkerFile, shimFile, catalogFile]) {
    const stat = fs.statSync(file);
    assert.equal(stat.isFile(), true);
    assert.notEqual(stat.uid, unprivilegedUid, "Candidate must not own the trusted evaluator");
    assert.equal((stat.mode & 0o022), 0, `Trusted file is writable by the candidate: ${file}`);
  }
  for (const commit of [task.commitSha, entry.referenceCommitSha]) {
    assert.equal(git("cat-file", "-t", commit), "commit");
  }
  const sourceBytes = gitFile(task.commitSha);
  const referenceBytes = gitFile(entry.referenceCommitSha);
  assert.notDeepEqual(sourceBytes, referenceBytes);
  const anchor = "if (args.resume) validateResumeSafety(rawOutput);";
  const reference = referenceBytes.toString("utf8");
  assert.equal(reference.split(anchor).length, 2, "Wrong fixture patch must be unique");
  const wrongBytes = Buffer.from(reference.replace(anchor, "if (args.resume) { /* intentionally incomplete */ }"), "utf8");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p7-14-triad-"));
  fs.chmodSync(temp, 0o755);
  const externalEvidence = process.env.P7_14_EVIDENCE_DIR;
  const evidenceDir = externalEvidence ? path.resolve(externalEvidence) : path.join(temp, "trusted-artifacts");
  if (externalEvidence) {
    assert.equal(path.isAbsolute(externalEvidence), true, "Host artifact path must be absolute");
    assert.equal(path.relative(root, evidenceDir).startsWith(".."), true,
      "Host artifacts cannot be placed inside the repository or candidate workspace");
    assert.equal(path.relative(temp, evidenceDir).startsWith(".."), true,
      "Host artifacts cannot be placed inside candidate workspace parent");
  }
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  fs.chmodSync(evidenceDir, 0o700);
  try {
    const source = workspace(temp, "source", sourceBytes);
    const referenceDir = workspace(temp, "reference", referenceBytes);
    const wrong = workspace(temp, "wrong", wrongBytes);
    const candidate = workspace(temp, "candidate", referenceBytes);
    const wrongCandidate = workspace(temp, "candidate-wrong", wrongBytes, { noopTest: true, spoofCheck: true });
    const checkHash = sha(JSON.stringify([sha(fs.readFileSync(checkerFile)), sha(fs.readFileSync(shimFile))]));
    const common = {
      taskId: task.taskId, taskHash: sha(JSON.stringify(task)), sourceCommitSha: task.commitSha,
      sourceTreeHash: snapshot(source), referenceCommitSha: entry.referenceCommitSha,
      referenceTreeHash: snapshot(referenceDir), wrongTreeHash: snapshot(wrong),
      catalogHash: sha(catalogBytes)
    };
    const requiredCriteria = [{ criterionId: check.criterionId, checkHash }];
    const checker = require(checkerFile);
    const sourceResult = observations(checker, source, evidenceDir, "source", common.sourceTreeHash);
    const referenceResult = observations(checker, referenceDir, evidenceDir, "reference", common.referenceTreeHash);
    const wrongResult = observations(checker, wrong, evidenceDir, "wrong", common.wrongTreeHash);
    const candidateHash = snapshot(candidate);
    const candidateResult = observations(checker, candidate, evidenceDir, "candidate", candidateHash);
    assert.deepEqual([sourceResult.verdict, referenceResult.verdict, wrongResult.verdict],
      ["assertion_fail", "pass", "assertion_fail"], "Triad must EXECUTE fail/pass/fail, not declare expected labels");
    const key = crypto.randomBytes(32); // Remains in the trusted runner; never passed to candidate processes.
    const unsigned = {
      receiptVersion: "trusted-behavior-evidence/v2", ...common, candidateTreeHash: candidateHash,
      issuedAt: Date.now(), nonce: crypto.randomBytes(16).toString("hex"),
      criteria: [{ criterionId: check.criterionId, checkHash, source: sourceResult,
        reference: referenceResult, wrong: wrongResult, candidate: candidateResult }]
    };
    const receipt = seal(unsigned, key);
    const expected = { ...common, candidateTreeHash: candidateHash, requiredCriteria };
    const evaluation = evaluateTrustedBehaviorEvidence(receipt, expected, key);
    assert.equal(evaluation.behaviorSatisfied, true);
    assert.equal(evaluation.criterionCount, 1);
    const success = evaluateTrustedProductComparison(comparisonInput(receipt), expected, key);
    assert.equal(success.correctness.taskSucceeded, true);
    const absent = evaluateTrustedProductComparison(comparisonInput(null), expected, key);
    assert.equal(absent.correctness.behaviorSatisfied, null);
    assert.equal(absent.correctness.taskSucceeded, null, "Human accept cannot promote missing evidence");
    const forged = structuredClone(receipt);
    forged.criteria[0].source.verdict = "pass";
    assert.equal(evaluateTrustedBehaviorEvidence(forged, expected, key).behaviorSatisfied, null);
    const incomplete = seal({ ...unsigned, criteria: [] }, key);
    assert.equal(evaluateTrustedBehaviorEvidence(incomplete, expected, key).behaviorSatisfied, null);
    const otherCandidate = { ...expected, candidateTreeHash: sha("different-candidate") };
    assert.equal(evaluateTrustedBehaviorEvidence(receipt, otherCandidate, key).behaviorSatisfied, null);
    assert.equal(evaluateTrustedBehaviorEvidence(receipt, expected, key, receipt.issuedAt + 16 * 60_000).behaviorSatisfied, null);
    const otherCheck = { ...expected, requiredCriteria: [{ criterionId: check.criterionId, checkHash: sha("changed-acceptance") }] };
    assert.equal(evaluateTrustedBehaviorEvidence(receipt, otherCheck, key).behaviorSatisfied, null);
    const wrongHash = snapshot(wrongCandidate);
    const wrongExecution = observations(checker, wrongCandidate, evidenceDir, "candidate-wrong", wrongHash);
    assert.equal(wrongExecution.verdict, "assertion_fail");
    const genericSuite = cp.spawnSync(process.execPath, [path.join(wrongCandidate, "test.js")], { encoding: "utf8", timeout: 5_000 });
    assert.equal(genericSuite.status, 0, "Generic green suite must NOT establish desired behavior");
    const wrongUnsigned = { ...unsigned, candidateTreeHash: wrongHash,
      criteria: [{ ...unsigned.criteria[0], candidate: wrongExecution }],
      nonce: crypto.randomBytes(16).toString("hex") };
    const wrongReceipt = seal(wrongUnsigned, key);
    const wrongExpected = { ...common, candidateTreeHash: wrongHash, requiredCriteria };
    assert.equal(evaluateTrustedBehaviorEvidence(wrongReceipt, wrongExpected, key).behaviorSatisfied, false);
    const wrongEvaluation = evaluateTrustedProductComparison(comparisonInput(wrongReceipt), wrongExpected, key);
    assert.equal(wrongEvaluation.correctness.testsPassed, true);
    assert.equal(wrongEvaluation.correctness.behaviorSatisfied, false);
    assert.equal(wrongEvaluation.correctness.taskSucceeded, false);
    fs.rmSync(path.join(wrongCandidate, "test.js"));
    const deletedTestHash = snapshot(wrongCandidate);
    assert.notEqual(deletedTestHash, wrongHash, "Deleting a test must change the actual candidate tree hash");
    assert.equal(evaluateTrustedBehaviorEvidence(wrongReceipt,
      { ...wrongExpected, candidateTreeHash: deletedTestHash }, key).behaviorSatisfied, null);
    const record = { version: "p7-14-triad-execution/v1", taskId: task.taskId,
      sourceCommitSha: task.commitSha, referenceCommitSha: entry.referenceCommitSha,
      sourceTreeHash: common.sourceTreeHash, referenceTreeHash: common.referenceTreeHash,
      wrongTreeHash: common.wrongTreeHash, candidateTreeHash: candidateHash,
      catalogHash: common.catalogHash, checkHash, receipt,
      artifactFiles: ["source.json", "reference.json", "wrong.json", "candidate.json", "candidate-wrong.json"],
      coverage: { historicallyExecutedTasks: 1, suiteTasks: 20, r03FullyClosed: false } };
    fs.writeFileSync(path.join(evidenceDir, "receipt.json"), JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ ok: true, taskId: task.taskId,
      triad: [sourceResult.verdict, referenceResult.verdict, wrongResult.verdict],
      actualCandidate: candidateResult.verdict, wrongCandidate: wrongExecution.verdict,
      negatives: ["missing", "forged", "partial", "cross-candidate", "stale", "changed-check", "no-op-test", "deleted-test"],
      evidenceHash: sha(JSON.stringify(record)), coverage: record.coverage }));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
