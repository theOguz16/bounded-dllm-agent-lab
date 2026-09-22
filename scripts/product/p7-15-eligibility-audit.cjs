#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const sha = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const git = (...args) => cp.execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 20_000, maxBuffer: 20_000_000 }).trim();
const gitMaybe = (commit, file) => {
  const result = cp.spawnSync("git", ["show", `${commit}:${file}`], { cwd: root, maxBuffer: 20_000_000 });
  return result.status === 0 ? result.stdout : null;
};
function args(argv) {
  const output = argv.find((item) => item.startsWith("--output="));
  return { output: output ? path.resolve(output.slice(9)) : null };
}
function main() {
  const options = args(process.argv.slice(2));
  const tasksetPath = path.join(root, "benchmarks/product-v1/tasks/dogfood/taskset-v2.json");
  const catalogPath = path.join(root, "benchmarks/product-v1/evaluator/p7-14-trusted-catalog-v3.json");
  const tasksetBytes = fs.readFileSync(tasksetPath);
  const catalogBytes = fs.readFileSync(catalogPath);
  const taskset = JSON.parse(tasksetBytes), catalog = JSON.parse(catalogBytes);
  assert.equal(taskset.tasks.length, 20);
  assert.equal(catalog.entries.length, 20);
  const triadDir = fs.mkdtempSync(path.join(os.tmpdir(), "p7-15-triads-"));
  try {
    const run = cp.spawnSync(process.execPath, [path.join(root, "benchmarks/product-v1/p7-14-trusted-triad-smoke.cjs")], {
      // The trusted suite prepares and executes five isolated variants for each
      // of 20 historical tasks. A short child timeout turns a slow, valid audit
      // into a null exit status before an evidence file can be written.
      cwd: root, encoding: "utf8", timeout: 28 * 60_000, maxBuffer: 20_000_000,
      env: { ...process.env, P7_14_EVIDENCE_DIR: triadDir,
        HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "*" }
    });
    assert.equal(run.status, 0,
      JSON.stringify({ status: run.status, signal: run.signal, error: run.error?.message || null,
        stderr: String(run.stderr || "").slice(-64 * 1024) }));
    const triadReceiptBytes = fs.readFileSync(path.join(triadDir, "receipt.json"));
    const triad = JSON.parse(triadReceiptBytes);
    const evaluatedCheckoutCommit = git("rev-parse", "HEAD");
    const candidateCommitSha = process.env.P7_CANDIDATE_COMMIT || evaluatedCheckoutCommit;
    assert.equal(triad.candidateCommitSha, candidateCommitSha);
    assert.equal(triad.evaluatedCheckoutCommit, evaluatedCheckoutCommit);
    assert.equal(triad.coverage.historicallyExecutedTasks, 20);
    assert.equal(triad.coverage.suiteTasks, 20);
    const familyCounts = {};
    const records = taskset.tasks.map((task) => {
      const entry = catalog.entries.find((item) => item.taskId === task.taskId);
      const evidence = triad.records.find((item) => item.taskId === task.taskId);
      assert.ok(entry && evidence);
      const changedFiles = git("diff", "--name-only", task.commitSha, entry.referenceCommitSha).split("\n").filter(Boolean);
      const status = git("diff", "--name-status", task.commitSha, entry.referenceCommitSha).split("\n").filter(Boolean);
      const onlyExistingFiles = status.length > 0 && status.every((line) => line.startsWith("M\t"));
      const wrongCaught = evidence.wrongCandidateVerdict !== "pass";
      const behaviorProven = evidence.triadSatisfied === true && evidence.candidateSatisfied === true;
      const assertionAttacksCaught = evidence.assertionAttacksCaught === true;
      const preparationSucceeded = evidence.preparation?.status === 0;
      const networkIsolationVerified = evidence.networkIsolationVerified === true;
      const auditClass = task.taskId.includes(".multifile.") ? "small_multifile_change" : task.family;
      familyCounts[auditClass] = (familyCounts[auditClass] || 0) + 1;
      const sourceLock = gitMaybe(task.commitSha, "package-lock.json");
      const referenceLock = gitMaybe(entry.referenceCommitSha, "package-lock.json");
      const sourcePackage = gitMaybe(task.commitSha, "package.json");
      return {
        taskId: task.taskId, family: task.family, auditClass, sourceCommit: task.commitSha,
        referenceCommit: entry.referenceCommitSha, sourceFiles: changedFiles,
        allowedChanges: changedFiles, dependencyArchitectureNeeds: {
          packageManifestChanged: changedFiles.includes("package.json"),
          lockfileChanged: changedFiles.includes("package-lock.json"),
          crossSubsystem: new Set(changedFiles.map((file) => file.split("/")[0])).size > 1
        },
        targetBehavior: task.acceptanceCriteria,
        independentChecker: { checkHash: evidence.checkHash, behaviorCommand: evidence.behaviorCommand },
        preparation: {
          status: sourceLock && referenceLock && sourcePackage && preparationSucceeded ? "pass" :
            preparationSucceeded ? "unknown" : "blocked",
          installNetworkPolicy: "preparation_only_cache_or_registry_allowed",
          sourcePackageHash: sourcePackage ? sha(sourcePackage) : null,
          sourceLockfileHash: sourceLock ? sha(sourceLock) : null,
          referenceLockfileHash: referenceLock ? sha(referenceLock) : null
        },
        validation: {
          status: onlyExistingFiles && wrongCaught && behaviorProven && assertionAttacksCaught && networkIsolationVerified ? "pass" :
            networkIsolationVerified ? "fail" : "blocked",
          networkPolicy: networkIsolationVerified ? "disabled_verified" : "disabled_unverified",
          changedFilesOnlyExisting: onlyExistingFiles,
          triad: evidence.triad,
          executions: evidence.receipt?.criteria?.[0] ? {
            source: evidence.receipt.criteria[0].source,
            reference: evidence.receipt.criteria[0].reference,
            wrong: evidence.receipt.criteria[0].wrong,
            candidate: evidence.receipt.criteria[0].candidate
          } : null,
          executionReasons: evidence.executionReasons || null,
          wrongImplementationCaught: wrongCaught,
          behaviorProven, assertionAttacksCaught, assertionAttacks: evidence.assertionAttacks,
          networkIsolationVerified, evidenceCheckHash: evidence.checkHash
        },
        reasons: [
          !preparationSucceeded ? "dependency_preparation_blocked" : null,
          !onlyExistingFiles ? "change_scope_ineligible" : null,
          !networkIsolationVerified ? "os_network_isolation_unverified" : null,
          !behaviorProven ? "source_reference_wrong_candidate_behavior_not_proven" : null,
          !assertionAttacksCaught ? "noop_or_generic_green_assertion_attack_not_caught" : null,
          !wrongCaught ? "wrong_candidate_not_caught" : null
        ].filter(Boolean),
        eligible: Boolean(sourceLock && referenceLock && sourcePackage && preparationSucceeded &&
          onlyExistingFiles && wrongCaught && behaviorProven && assertionAttacksCaught && networkIsolationVerified)
      };
    });
    const expectedFamilies = {
      existing_function_bug_fix: 5, bounded_behavior_change: 5,
      regression_test_addition: 5, small_multifile_change: 5
    };
    assert.deepEqual(familyCounts, expectedFamilies);
    const audit = {
      schemaVersion: "product-dogfood-eligibility-audit/v1",
      suiteId: taskset.suiteId, sourceCommit: candidateCommitSha, evaluatedCheckoutCommit,
      identities: {
        tasksetHash: sha(tasksetBytes), trustedCatalogHash: sha(catalogBytes),
        triadEvidenceHash: sha(triadReceiptBytes), node: process.version,
        npm: cp.execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
        platform: `${process.platform}-${process.arch}`,
        imageIdentity: process.env.P7_15_IMAGE_ID || sha(JSON.stringify({
          platform: process.platform, arch: process.arch, release: os.release(), node: process.version
        }))
      },
      policy: {
        dependencyPreparationNetwork: "cache_or_registry_allowed_before_validation",
        validationNetwork: "disabled",
        unauditedTasksEligible: false,
        tasksetMutationAllowed: false
      },
      distribution: familyCounts, eligibleTaskCount: records.filter((record) => record.eligible).length,
      decision: records.every((record) => record.eligible) ? "pass" : "not_pass",
      allEligible: records.every((record) => record.eligible), records
    };
    const canonical = JSON.stringify(audit);
    const envelope = { ...audit, auditHash: sha(canonical) };
    assert.equal(envelope.records.length, 20);
    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.writeFileSync(options.output, JSON.stringify(envelope, null, 2) + "\n", { mode: 0o600 });
    }
    process.stdout.write(JSON.stringify({ ok: true, tasks: 20, distribution: familyCounts,
      auditHash: envelope.auditHash, triadEvidenceHash: envelope.identities.triadEvidenceHash }) + "\n");
  } finally {
    fs.rmSync(triadDir, { recursive: true, force: true });
  }
}
main();
