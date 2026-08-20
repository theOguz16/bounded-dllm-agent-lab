#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join, relative } = require("node:path");

const root = process.cwd();
const bundler = join(root, "scripts/controlled-coding-pilot-evidence.cjs");
const verifier = join(root, "scripts/controlled-coding-pilot-evidence-verify.cjs");
const acceptance = join(root, "scripts/controlled-coding-pilot-acceptance.cjs");
const temporary = mkdtempSync(join(tmpdir(), "controlled-pilot-acceptance-chain-"));
const redactionSentinel = "chain-redaction-sentinel-must-not-appear";
const llamaBuild = "9754";
const llamaCommit = "52b3df002";
const protectedProductionFiles = [
  "scripts/controlled-coding-pilot-evidence.cjs",
  "scripts/controlled-coding-pilot-evidence-smoke.cjs",
  "scripts/controlled-coding-pilot-evidence-verify.cjs",
  "scripts/controlled-coding-pilot-evidence-verify-smoke.cjs",
  "scripts/controlled-coding-pilot-acceptance.cjs",
  "scripts/controlled-coding-pilot-acceptance-smoke.cjs",
  "scripts/runpod-controlled-pilot-bootstrap.sh",
  "scripts/runpod-controlled-pilot-bootstrap-smoke.cjs",
  "scripts/controlled-coding-pilot.cjs"
];

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertSafeDiagnostics(result, label) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(output.includes(redactionSentinel), false, `${label}: redaction sentinel exposed`);
  assert.equal(output.includes(temporary), false, `${label}: temporary path exposed`);
  assert.equal(output.includes(root), false, `${label}: repository path exposed`);
}

function command(file, args, cwd = root, extraEnvironment = {}) {
  assert.equal(file === process.execPath || file === "git", true, "unexpected executable");
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CHAIN_REDACTION_SENTINEL: redactionSentinel,
      ...extraEnvironment
    },
    timeout: 20_000,
    maxBuffer: 1_000_000
  });
  assertSafeDiagnostics(result, `${basename(file)} invocation`);
  return result;
}

function git(cwd, args, extraEnvironment = {}) {
  return command("git", args, cwd, extraEnvironment);
}

function gitValue(cwd, args) {
  const result = git(cwd, args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function invoke(script, args, cwd = root) {
  return command(process.execPath, [script, ...args], cwd);
}

function expectPass(result, marker, label) {
  assert.equal(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`^${marker}=PASS\\n`), label);
}

function expectFailure(result, marker, label) {
  assert.notEqual(result.status, 0, `${label}: unexpectedly passed`);
  assert.match(result.stderr, new RegExp(`^${marker}=FAIL\\nerrorCode=`), label);
}

function outputFields(stdout) {
  return Object.fromEntries(stdout.trim().split("\n").slice(1).map((line) => {
    const separator = line.indexOf("=");
    assert.notEqual(separator, -1, `invalid production output line: ${line}`);
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function validReport(sourceCommit, overrides = {}) {
  return {
    schemaVersion: "bounded.controlled-coding-pilot-report/v1",
    pilotId: "controlled-pilot-acceptance-chain",
    status: "completed",
    sourceCommit,
    pilotDefinitionHash: `sha256:${"1".repeat(64)}`,
    providerKind: "offline-chain-fixture",
    modelId: "fixture-model-1",
    providerCallCount: 1,
    retryCount: 0,
    patchLineCount: 3,
    authorityPassed: true,
    verifierPassed: true,
    artifactProduced: true,
    artifactValid: true,
    sourceWorktreeMutated: false,
    githubMutationObserved: false,
    budgetExceeded: false,
    cleanupCompleted: true,
    failureCode: null,
    ...overrides
  };
}

function writeReportDirectory(base, sourceCommit, overrides = {}) {
  const reportRoot = join(base, "source-report");
  mkdirSync(reportRoot, { recursive: true });
  writeFileSync(join(reportRoot, "pilot-report.json"),
    `${JSON.stringify(validReport(sourceCommit, overrides), null, 2)}\n`);
  writeFileSync(join(reportRoot, "artifact.txt"), "bounded offline fixture\n");
  return reportRoot;
}

function runBundler(reportRoot, bundle, expectedSourceCommit, cwd = root) {
  return invoke(bundler, [
    "--report-dir", reportRoot,
    "--out-dir", bundle,
    "--expected-source-commit", expectedSourceCommit
  ], cwd);
}

function runVerifier(bundle, expectedSourceCommit, cwd = root) {
  return invoke(verifier, [
    "--bundle-dir", bundle,
    "--expected-source-commit", expectedSourceCommit
  ], cwd);
}

function runAcceptance(bundle, output, expectedSourceCommit, options = {}) {
  return invoke(acceptance, [
    "--bundle-dir", bundle,
    "--expected-source-commit", expectedSourceCommit,
    "--llama-build", options.build ?? llamaBuild,
    "--llama-commit", options.commit ?? llamaCommit,
    "--out", output
  ], options.cwd ?? root);
}

function snapshotTree(treeRoot, excludedOutput) {
  const records = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const absolute = join(directory, entry.name);
      if (absolute === excludedOutput) continue;
      const path = relative(treeRoot, absolute).split("\\").join("/");
      const stats = lstatSync(absolute, { bigint: true });
      if (stats.isDirectory()) {
        visit(absolute);
      } else if (stats.isSymbolicLink()) {
        records.push({ path, kind: "symlink", target: readlinkSync(absolute) });
      } else {
        const bytes = readFileSync(absolute);
        records.push({
          path,
          kind: "file",
          byteSize: bytes.length,
          sha256: sha256(bytes),
          mode: stats.mode.toString()
        });
      }
    }
  }
  visit(treeRoot);
  return records;
}

function temporarySiblings(output) {
  const prefix = `.${basename(output)}.tmp-`;
  return readdirSync(dirname(output)).filter((name) => name.startsWith(prefix)).sort();
}

function cloneEvidenceBundle(name, source) {
  const destination = join(temporary, name);
  cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  const priorAcceptance = join(destination, "acceptance-record.json");
  if (existsSync(priorAcceptance)) unlinkSync(priorAcceptance);
  return destination;
}

function assertAcceptanceFailure(label, bundle, expectedSourceCommit, options = {}) {
  const output = join(bundle, options.outputName ?? "negative-acceptance.json");
  assert.equal(existsSync(output), false, `${label}: output existed before failure`);
  const before = snapshotTree(bundle, output);
  const result = runAcceptance(bundle, output, expectedSourceCommit, options);
  expectFailure(result, "ACCEPTANCE_RECORD", label);
  assert.equal(existsSync(output), false, `${label}: output remained after failure`);
  assert.deepEqual(temporarySiblings(output), [], `${label}: temporary sibling remained`);
  assert.deepEqual(snapshotTree(bundle, output), before, `${label}: evidence inputs changed`);
  return result;
}

function buildFullChain(name, sourceCommit, cwd = root) {
  const base = join(temporary, name);
  const reportRoot = writeReportDirectory(base, sourceCommit);
  const bundle = join(base, "bundle");
  const bundled = runBundler(reportRoot, bundle, sourceCommit, cwd);
  expectPass(bundled, "EVIDENCE_BUNDLE", `${name}: bundler`);
  const verified = runVerifier(bundle, sourceCommit, root);
  expectPass(verified, "EVIDENCE_VERIFY", `${name}: verifier`);
  const acceptanceOutput = join(bundle, "acceptance-record.json");
  const beforeAcceptance = snapshotTree(bundle, acceptanceOutput);
  const accepted = runAcceptance(bundle, acceptanceOutput, sourceCommit, { cwd: root });
  expectPass(accepted, "ACCEPTANCE_RECORD", `${name}: acceptance`);
  assert.deepEqual(snapshotTree(bundle, acceptanceOutput), beforeAcceptance,
    `${name}: acceptance mutated evidence inputs`);
  assert.deepEqual(temporarySiblings(acceptanceOutput), [], `${name}: temporary sibling remained`);
  return {
    reportRoot,
    bundle,
    bundled,
    verified,
    accepted,
    report: JSON.parse(readFileSync(join(bundle, "report", "pilot-report.json"), "utf8")),
    manifestBytes: readFileSync(join(bundle, "evidence-manifest.json")),
    manifest: JSON.parse(readFileSync(join(bundle, "evidence-manifest.json"), "utf8")),
    acceptanceBytes: readFileSync(acceptanceOutput),
    record: JSON.parse(readFileSync(acceptanceOutput, "utf8"))
  };
}

function createUnavailableBundle() {
  const repository = join(temporary, "historical-repository");
  mkdirSync(join(repository, "apps/cli/src"), { recursive: true });
  const initialized = git(repository, ["init", "--quiet"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  writeFileSync(join(repository, "apps/cli/src/model-worker-runpod-live-smoke.ts"),
    "export const historicalFixture = true;\n");
  assert.equal(git(repository, ["add", "apps/cli/src/model-worker-runpod-live-smoke.ts"]).status, 0);
  const committed = git(repository, [
    "-c", "user.name=Offline Fixture",
    "-c", "user.email=offline-fixture@example.invalid",
    "commit", "--quiet", "-m", "offline historical fixture"
  ], {
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
  });
  assert.equal(committed.status, 0, committed.stderr);
  const sourceCommit = gitValue(repository, ["rev-parse", "HEAD"]);
  const reportRoot = writeReportDirectory(repository, sourceCommit);
  const bundle = join(repository, "bundle");
  const bundled = runBundler(reportRoot, bundle, sourceCommit, repository);
  expectPass(bundled, "EVIDENCE_BUNDLE", "unavailable: bundler");
  return { bundle, sourceCommit };
}

function productionHashes() {
  return Object.fromEntries(protectedProductionFiles.map((path) => [
    path,
    sha256(readFileSync(join(root, path)))
  ]));
}

let symlinkResult = "PASS";

try {
  const head = gitValue(root, ["rev-parse", "HEAD"]);
  const refsBefore = gitValue(root, ["for-each-ref", "--format=%(refname):%(objectname)"]);
  const statusBefore = gitValue(root, ["status", "--short"]);
  const productionBefore = productionHashes();

  const first = buildFullChain("happy-first", head);
  const second = buildFullChain("happy-second", head);
  assert.deepEqual(second.manifest, first.manifest, "evidence manifest semantics changed");
  assert.deepEqual(second.manifestBytes, first.manifestBytes, "evidence manifest bytes changed");
  assert.equal(second.manifest.evidenceHash, first.manifest.evidenceHash);
  assert.deepEqual(second.acceptanceBytes, first.acceptanceBytes,
    "acceptance record bytes changed across equivalent chains");
  assert.equal(second.record.acceptanceHash, first.record.acceptanceHash);

  const bundlerFields = outputFields(first.bundled.stdout);
  const verifierFields = outputFields(first.verified.stdout);
  const acceptanceFields = outputFields(first.accepted.stdout);
  assert.equal(bundlerFields.evidenceHash, first.manifest.evidenceHash);
  assert.equal(bundlerFields.reportHash, first.manifest.reportHash);
  assert.equal(verifierFields.evidenceHash, first.manifest.evidenceHash);
  assert.equal(verifierFields.reportHash, first.manifest.reportHash);
  assert.equal(acceptanceFields.acceptanceHash, first.record.acceptanceHash);
  for (const field of [
    "sourceCommit", "pilotId", "pilotDefinitionHash", "reportHash", "evidenceHash",
    "providerKind", "modelId", "providerCallCount", "retryCount", "patchLineCount",
    "sourceTargetPath", "sourceTargetBlobHash"
  ]) {
    assert.deepEqual(first.record[field], first.manifest[field], `${field}: acceptance mismatch`);
  }
  for (const field of [
    "sourceCommit", "pilotId", "pilotDefinitionHash", "providerKind", "modelId",
    "providerCallCount", "retryCount", "patchLineCount"
  ]) {
    assert.deepEqual(first.manifest[field], first.report[field], `${field}: report mismatch`);
  }
  assert.equal(first.record.verification.evidenceVerified, true);
  assert.equal(first.record.verification.sourceBlobVerification, "verified");
  assert.equal(first.record.acceptance.finalGatePassed, true);
  assert.equal(first.record.acceptance.mergeEligible, true);
  assert.equal(first.record.runtime.kind, "llama.cpp");
  assert.equal(first.record.runtime.build, Number(llamaBuild));
  assert.equal(first.record.runtime.commit, llamaCommit);
  for (const bytes of [first.manifestBytes, first.acceptanceBytes]) {
    const text = bytes.toString("utf8");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(text.includes(temporary), false);
    assert.equal(text.includes(root), false);
  }

  const actualAcceptanceSource = readFileSync(acceptance, "utf8");
  const argumentSection = actualAcceptanceSource.slice(
    actualAcceptanceSource.indexOf("function parseArguments"),
    actualAcceptanceSource.indexOf("function canonicalJson")
  );
  const actualFlags = [...new Set([...argumentSection.matchAll(/"(--[a-z-]+)"/g)]
    .map((match) => match[1]))].sort();
  assert.deepEqual(actualFlags, [
    "--bundle-dir", "--expected-source-commit", "--llama-build", "--llama-commit", "--out"
  ]);

  const wrongCommit = "0".repeat(40) === head ? "f".repeat(40) : "0".repeat(40);
  const wrongBundle = cloneEvidenceBundle("wrong-commit", first.bundle);
  expectFailure(runVerifier(wrongBundle, wrongCommit), "EVIDENCE_VERIFY",
    "wrong expected commit verifier");
  assertAcceptanceFailure("wrong expected commit acceptance", wrongBundle, wrongCommit);

  const reportTamper = cloneEvidenceBundle("report-tamper", first.bundle);
  writeFileSync(join(reportTamper, "report", "pilot-report.json"), "tampered report\n");
  expectFailure(runVerifier(reportTamper, head), "EVIDENCE_VERIFY", "report tamper verifier");
  assertAcceptanceFailure("report tamper acceptance", reportTamper, head);

  const manifestTamper = cloneEvidenceBundle("manifest-tamper", first.bundle);
  const manifestPath = join(manifestTamper, "evidence-manifest.json");
  const changedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  changedManifest.pilotId = "tampered-pilot-id";
  writeFileSync(manifestPath, `${JSON.stringify(changedManifest)}\n`);
  expectFailure(runVerifier(manifestTamper, head), "EVIDENCE_VERIFY", "manifest tamper verifier");
  assertAcceptanceFailure("manifest tamper acceptance", manifestTamper, head);

  const listedTamper = cloneEvidenceBundle("listed-file-tamper", first.bundle);
  writeFileSync(join(listedTamper, "report", "artifact.txt"), "changed listed evidence\n");
  expectFailure(runVerifier(listedTamper, head), "EVIDENCE_VERIFY", "listed file tamper verifier");
  assertAcceptanceFailure("listed file tamper acceptance", listedTamper, head);

  const missingFile = cloneEvidenceBundle("missing-file", first.bundle);
  unlinkSync(join(missingFile, "report", "artifact.txt"));
  expectFailure(runVerifier(missingFile, head), "EVIDENCE_VERIFY", "missing file verifier");
  assertAcceptanceFailure("missing file acceptance", missingFile, head);

  const extraFile = cloneEvidenceBundle("extra-file", first.bundle);
  writeFileSync(join(extraFile, "report", "unexpected.txt"), "unexpected evidence\n");
  expectFailure(runVerifier(extraFile, head), "EVIDENCE_VERIFY", "extra file verifier");
  assertAcceptanceFailure("extra file acceptance", extraFile, head);

  const symlinkBundle = cloneEvidenceBundle("symlink-boundary", first.bundle);
  try {
    symlinkSync("artifact.txt", join(symlinkBundle, "report", "linked-artifact.txt"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      symlinkResult = `SKIP(${error.code})`;
    } else {
      throw error;
    }
  }
  if (symlinkResult === "PASS") {
    expectFailure(runVerifier(symlinkBundle, head), "EVIDENCE_VERIFY", "symlink verifier");
    assertAcceptanceFailure("symlink acceptance", symlinkBundle, head);
  }

  const failedBase = join(temporary, "failed-governed-report");
  const failedReportRoot = writeReportDirectory(failedBase, head, { verifierPassed: false });
  const failedBundle = join(failedBase, "bundle");
  expectFailure(runBundler(failedReportRoot, failedBundle, head), "EVIDENCE_BUNDLE",
    "failed governed report bundler");
  assert.equal(existsSync(failedBundle), false);
  assert.equal(existsSync(join(failedBundle, "acceptance-record.json")), false);

  for (const [label, options] of [
    ["llama build zero", { build: "0" }],
    ["llama build negative", { build: "-1" }],
    ["llama build non-integer", { build: "1.5" }],
    ["llama commit too short", { commit: "abcdef" }],
    ["llama commit non-hex", { commit: "abc-xyz" }]
  ]) {
    const provenanceBundle = cloneEvidenceBundle(label.replaceAll(" ", "-"), first.bundle);
    assertAcceptanceFailure(label, provenanceBundle, head, options);
  }

  const historical = createUnavailableBundle();
  const unavailableVerifier = runVerifier(historical.bundle, historical.sourceCommit, root);
  expectPass(unavailableVerifier, "EVIDENCE_VERIFY", "unavailable verifier");
  assert.equal(outputFields(unavailableVerifier.stdout).sourceBlobVerification, "unavailable");
  const unavailableOutput = join(historical.bundle, "acceptance-record.json");
  const unavailableBefore = snapshotTree(historical.bundle, unavailableOutput);
  const unavailableAcceptance = runAcceptance(
    historical.bundle, unavailableOutput, historical.sourceCommit, { cwd: root }
  );
  expectPass(unavailableAcceptance, "ACCEPTANCE_RECORD", "unavailable acceptance");
  const unavailableRecord = JSON.parse(readFileSync(unavailableOutput, "utf8"));
  assert.equal(unavailableRecord.verification.evidenceVerified, true);
  assert.equal(unavailableRecord.verification.sourceBlobVerification, "unavailable");
  assert.deepEqual(snapshotTree(historical.bundle, unavailableOutput), unavailableBefore);
  assert.deepEqual(temporarySiblings(unavailableOutput), []);

  assert.deepEqual(productionHashes(), productionBefore, "production scripts changed during smoke");
  assert.equal(gitValue(root, ["for-each-ref", "--format=%(refname):%(objectname)"]), refsBefore,
    "real git refs changed");
  assert.equal(gitValue(root, ["status", "--short"]), statusBefore,
    "real repository worktree changed during smoke");

  const policy = readFileSync(join(root, "bounded-agent.policy.yml"), "utf8");
  assert.equal((policy.match(
    /^  - scripts\/controlled-coding-pilot-acceptance-chain-smoke\.cjs$/gm
  ) ?? []).length, 1);
  assert.doesNotMatch(policy, /^  - scripts\/\*\*$/m);

  process.stdout.write([
    "controlled coding pilot acceptance chain smoke: PASS",
    "happyChains=2",
    "deterministicComposition=PASS",
    "bundleImmutability=PASS",
    "sourceBlobVerification=verified,unavailable",
    `symlinkBoundary=${symlinkResult}`,
    "safeDiagnostics=PASS",
    "externalEffects=NONE"
  ].join("\n") + "\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
