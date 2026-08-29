#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { hashCanonical, parseIndex, verifyIndex } = require("./evidence-index.cjs");

const SCHEMA_VERSION = "bounded.evidence-promotion-check/v1";
const CONTROLLED_EXPERIMENT = "controlled-coding-pilot-v2-suite";
const MODE_F_EXPERIMENT = "gate5-mode-f-c-e-f";
const CONTROLLED_MANIFEST_SCHEMA = "bounded.controlled-coding-pilot-observed-evidence/v3";
const CONTROLLED_RUN_SCHEMA = "bounded.controlled-coding-pilot-observed-run/v1";
const MODE_F_SCHEMA = "gate5-mode-f-live-evidence/v1";
const CONTROLLED_RESEARCH_REF = process.env.EVIDENCE_PROMOTE_CONTROLLED_REF ||
  "research/v2-observed-run-evidence";
const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NON_OBSERVED = /(?:fixture|dry[_ -]?run|synthetic)/i;
const MODE_F_MODES = [
  "C_synthetic_context",
  "E_bounded_workspace_boundary",
  "F_adaptive_compressed_boundary"
];

class PromotionError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PromotionError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new PromotionError(code, detail);
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function git(root, args, code = "EVIDENCE_PROMOTION_GIT_FAILED") {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10_000_000
  });
  if (result.status !== 0) fail(code, (result.stderr || "").trim());
  return (result.stdout || "").trim();
}

function parseJsonFile(path, code) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(code, path);
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function assertHash(value, code) {
  if (!HASH.test(value ?? "")) fail(code);
}

function assertCommit(value, code) {
  if (!COMMIT.test(value ?? "")) fail(code);
}

function assertObservedString(value, code) {
  if (typeof value !== "string" || value.length === 0 || NON_OBSERVED.test(value)) fail(code);
}

function normalizeIdentity(entries, kind) {
  if (!Array.isArray(entries)) fail("EVIDENCE_PROMOTION_TASKSET_INVALID");
  if (kind === "controlled_pilot_definitions/v1") {
    return entries.map((entry) => ({ pilotId: entry.pilotId, path: entry.path }))
      .sort((left, right) => left.pilotId.localeCompare(right.pilotId));
  }
  if (kind === "external_repository_tasks/v1") {
    return entries.map((entry) => ({
      taskId: entry.taskId,
      repository: entry.repository,
      commitSha: entry.commitSha
    })).sort((left, right) => left.taskId.localeCompare(right.taskId));
  }
  fail("EVIDENCE_PROMOTION_TASKSET_KIND_UNSUPPORTED", kind);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function repoRelativeArtifact(root, artifactFile) {
  const absolute = resolve(artifactFile);
  const rootAbsolute = resolve(root);
  const value = relative(rootAbsolute, absolute).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    fail("EVIDENCE_PROMOTION_ARTIFACT_OUTSIDE_REPOSITORY");
  }
  return value;
}

function safeChild(root, relativePath, code) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\") ||
      isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    fail(code, String(relativePath));
  }
  const absolute = resolve(root, relativePath);
  const lexical = relative(resolve(root), absolute);
  if (lexical === ".." || lexical.startsWith(`..${sep}`)) fail(code, relativePath);
  return absolute;
}

function experiment(index, id) {
  const found = index.experiments.find((entry) => entry.experimentId === id);
  if (!found) fail("EVIDENCE_PROMOTION_EXPERIMENT_NOT_REGISTERED", id);
  if (found.status !== "pending") fail("EVIDENCE_PROMOTION_EXPERIMENT_NOT_PENDING", id);
  if (found.tasksetHashKind !== "index_taskset_identity_v1" || !plainObject(found.tasksetIdentity) ||
      hashCanonical(found.tasksetIdentity) !== found.tasksetHash) {
    fail("EVIDENCE_PROMOTION_PENDING_TASKSET_INVALID", id);
  }
  return found;
}

function resolveControlledManifest(artifactPath) {
  const absolute = resolve(artifactPath);
  if (!existsSync(absolute)) fail("EVIDENCE_PROMOTION_ARTIFACT_MISSING", artifactPath);
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink()) fail("EVIDENCE_PROMOTION_ARTIFACT_SYMLINK_REJECTED");
  if (stats.isDirectory()) return join(absolute, "evidence-manifest.json");
  if (stats.isFile() && absolute.endsWith("evidence-manifest.json")) return absolute;
  fail("EVIDENCE_PROMOTION_CONTROLLED_ARTIFACT_INVALID");
}

function verifyCanonicalHash(object, field, code) {
  const claimed = object[field];
  assertHash(claimed, code);
  const core = { ...object };
  delete core[field];
  if (hashCanonical(core) !== claimed) fail(code);
}

function resolveResearchRef(root, branch) {
  const remoteRef = `refs/remotes/origin/${branch}`;
  let sha = "";
  const probe = spawnSync("git", ["rev-parse", "--verify", remoteRef], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (probe.status === 0) sha = (probe.stdout || "").trim();
  if (!COMMIT.test(sha)) {
    git(root, ["fetch", "--quiet", "origin", `refs/heads/${branch}:${remoteRef}`],
      "EVIDENCE_PROMOTION_CONTROLLED_VERIFIER_FETCH_FAILED");
    sha = git(root, ["rev-parse", "--verify", remoteRef]);
  }
  assertCommit(sha, "EVIDENCE_PROMOTION_CONTROLLED_VERIFIER_REF_INVALID");
  return sha;
}

function withResearchWorktree(root, sha, callback) {
  const holder = mkdtempSync(join(tmpdir(), "evidence-promotion-verifier-"));
  const worktree = join(holder, "repo");
  git(root, ["worktree", "add", "--quiet", "--detach", worktree, sha],
    "EVIDENCE_PROMOTION_CONTROLLED_VERIFIER_WORKTREE_FAILED");
  const linked = [];
  try {
    for (const name of ["node_modules", "dist"]) {
      const source = join(root, name);
      const target = join(worktree, name);
      if (existsSync(source) && !existsSync(target)) {
        symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
        linked.push(target);
      }
    }
    return callback(worktree);
  } finally {
    for (const target of linked.reverse()) {
      try {
        if (existsSync(target) || readlinkSync(target)) unlinkSync(target);
      } catch {}
    }
    try { git(root, ["worktree", "remove", "--force", worktree]); } catch {}
    rmSync(holder, { recursive: true, force: true });
  }
}

function runControlledCanonicalVerifier(root, bundleDir, sourceCommit) {
  const localVerifier = join(root, "scripts/controlled-coding-pilot-observed-evidence-verify.cjs");
  const run = (cwd, verifier) => {
    const result = spawnSync(process.execPath, [
      verifier,
      "--bundle-dir", bundleDir,
      "--expected-source-commit", sourceCommit
    ], {
      cwd,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20_000_000
    });
    if (result.status !== 0 || !(result.stdout || "").includes("OBSERVED_EVIDENCE_VERIFY=PASS")) {
      fail("EVIDENCE_PROMOTION_CONTROLLED_CANONICAL_VERIFY_FAILED",
        (result.stderr || result.stdout || "").trim());
    }
  };
  if (existsSync(localVerifier)) {
    run(root, localVerifier);
    return;
  }
  const sha = resolveResearchRef(root, CONTROLLED_RESEARCH_REF);
  withResearchWorktree(root, sha, (worktree) => run(
    worktree,
    join(worktree, "scripts/controlled-coding-pilot-observed-evidence-verify.cjs")
  ));
}

function verifyControlledArtifact({ root, artifactPath, pending, deepVerify = true }) {
  const manifestPath = resolveControlledManifest(artifactPath);
  if (!existsSync(manifestPath)) fail("EVIDENCE_PROMOTION_CONTROLLED_MANIFEST_MISSING");
  const bundleDir = dirname(manifestPath);
  const manifest = parseJsonFile(manifestPath, "EVIDENCE_PROMOTION_CONTROLLED_MANIFEST_JSON_INVALID");
  if (manifest.schemaVersion !== CONTROLLED_MANIFEST_SCHEMA || !plainObject(manifest.experimentConfig) ||
      !Array.isArray(manifest.runs) || manifest.runCount !== manifest.runs.length) {
    fail("EVIDENCE_PROMOTION_CONTROLLED_MANIFEST_INVALID");
  }
  verifyCanonicalHash(manifest, "evidenceHash", "EVIDENCE_PROMOTION_ARTIFACT_HASH_INVALID");
  assertCommit(manifest.sourceCommit, "EVIDENCE_PROMOTION_SOURCE_COMMIT_MISSING");
  const config = manifest.experimentConfig;
  assertObservedString(config.modelId, "EVIDENCE_PROMOTION_MODEL_MISSING");
  if (!plainObject(config.provider)) fail("EVIDENCE_PROMOTION_PROVIDER_MISSING");
  assertObservedString(config.provider.transport, "EVIDENCE_PROMOTION_PROVIDER_INVALID");
  if (hashCanonical(config) !== manifest.experimentConfigHash) {
    fail("EVIDENCE_PROMOTION_CONTROLLED_CONFIG_HASH_INVALID");
  }

  const expected = normalizeIdentity(pending.tasksetIdentity.tasks, pending.tasksetIdentity.kind);
  const actualIds = manifest.runs.map((run) => run.pilotId).sort();
  if (!sameJson(actualIds, expected.map((entry) => entry.pilotId).sort())) {
    fail("EVIDENCE_PROMOTION_TASKSET_MISMATCH");
  }

  const represented = [];
  for (const summary of manifest.runs) {
    if (!plainObject(summary) || !["completed", "failed", "cancelled"].includes(summary.status) ||
        typeof summary.relativePath !== "string") {
      fail("EVIDENCE_PROMOTION_CONTROLLED_RUN_SUMMARY_INVALID");
    }
    const provenancePath = safeChild(bundleDir, summary.relativePath,
      "EVIDENCE_PROMOTION_CONTROLLED_RUN_PATH_INVALID");
    const runRoot = dirname(provenancePath);
    const provenance = parseJsonFile(provenancePath,
      "EVIDENCE_PROMOTION_CONTROLLED_RUN_JSON_INVALID");
    if (provenance.schemaVersion !== CONTROLLED_RUN_SCHEMA || provenance.pilotId !== summary.pilotId ||
        provenance.status !== summary.status || provenance.sourceCommit !== manifest.sourceCommit ||
        provenance.experimentConfigHash !== manifest.experimentConfigHash ||
        provenance.modelId !== config.modelId || !plainObject(provenance.provider) ||
        provenance.provider.transport !== config.provider.transport ||
        hashCanonical(provenance) !== summary.runProvenanceHash) {
      fail("EVIDENCE_PROMOTION_CONTROLLED_RUN_BINDING_INVALID", summary.pilotId);
    }
    const expectedTask = expected.find((entry) => entry.pilotId === summary.pilotId);
    if (!expectedTask || provenance.taskDefinition?.path !== expectedTask.path) {
      fail("EVIDENCE_PROMOTION_TASKSET_MISMATCH", summary.pilotId);
    }
    represented.push({ pilotId: summary.pilotId, path: provenance.taskDefinition.path });

    const pilotReportPath = safeChild(runRoot, provenance.pilotReportArtifact,
      "EVIDENCE_PROMOTION_CONTROLLED_PILOT_REPORT_PATH_INVALID");
    const pilotReport = parseJsonFile(pilotReportPath,
      "EVIDENCE_PROMOTION_CONTROLLED_PILOT_REPORT_JSON_INVALID");
    if (pilotReport.pilotId !== summary.pilotId || pilotReport.status !== summary.status ||
        pilotReport.sourceCommit !== manifest.sourceCommit) {
      fail("EVIDENCE_PROMOTION_CONTROLLED_PILOT_REPORT_BINDING_INVALID", summary.pilotId);
    }
    assertObservedString(pilotReport.providerKind,
      "EVIDENCE_PROMOTION_NON_OBSERVED_ARTIFACT_REJECTED");

    if (summary.status !== "completed") {
      const retained = new Set((provenance.rejectedCandidateArtifacts || [])
        .map((record) => record?.relativePath));
      for (const candidate of [provenance.rawCandidateArtifact, provenance.materializedPatchArtifact]) {
        if (candidate && !retained.has(candidate)) {
          fail("EVIDENCE_PROMOTION_FAILURE_ARTIFACT_NOT_RETAINED", summary.pilotId);
        }
      }
    }
  }
  if (!sameJson(normalizeIdentity(represented, pending.tasksetIdentity.kind), expected)) {
    fail("EVIDENCE_PROMOTION_TASKSET_MISMATCH");
  }
  if (deepVerify) runControlledCanonicalVerifier(root, bundleDir, manifest.sourceCommit);

  return {
    sourceCommit: manifest.sourceCommit,
    provider: config.provider.transport,
    model: config.modelId,
    artifactFile: manifestPath,
    artifactHash: manifest.evidenceHash,
    evidenceClass: "controlled_coding_pilot_v2_observed",
    statusReason:
      "Verified observed Controlled Pilot V2 bundle represents every registered task under one provider/model/config and retains required failure evidence."
  };
}

function verifySourceCommitExists(root, sourceCommit) {
  git(root, ["cat-file", "-e", `${sourceCommit}^{commit}`],
    "EVIDENCE_PROMOTION_SOURCE_COMMIT_UNAVAILABLE");
}

function verifyModeFArtifact({ root, artifactPath, pending }) {
  const artifactFile = resolve(artifactPath);
  if (!existsSync(artifactFile) || !lstatSync(artifactFile).isFile() ||
      lstatSync(artifactFile).isSymbolicLink()) {
    fail("EVIDENCE_PROMOTION_MODE_F_ARTIFACT_INVALID");
  }
  const evidence = parseJsonFile(artifactFile, "EVIDENCE_PROMOTION_MODE_F_JSON_INVALID");
  if (evidence.schemaVersion !== MODE_F_SCHEMA || evidence.researchStatus !== "observed_live_result" ||
      evidence.executionClass !== "live_adaptive_compressed_boundary" ||
      !plainObject(evidence.experimentConfig)) {
    fail("EVIDENCE_PROMOTION_NON_OBSERVED_ARTIFACT_REJECTED");
  }
  verifyCanonicalHash(evidence, "evidenceHash", "EVIDENCE_PROMOTION_ARTIFACT_HASH_INVALID");
  assertCommit(evidence.sourceCommit, "EVIDENCE_PROMOTION_SOURCE_COMMIT_MISSING");
  verifySourceCommitExists(root, evidence.sourceCommit);
  const config = evidence.experimentConfig;
  assertObservedString(config.model, "EVIDENCE_PROMOTION_MODEL_MISSING");
  assertObservedString(config.transport, "EVIDENCE_PROMOTION_PROVIDER_INVALID");
  if (!plainObject(config.endpoint) || hashCanonical(config) !== evidence.experimentConfigHash) {
    fail("EVIDENCE_PROMOTION_MODE_F_CONFIG_INVALID");
  }

  const expected = normalizeIdentity(pending.tasksetIdentity.tasks, pending.tasksetIdentity.kind);
  const actual = normalizeIdentity(evidence.immutableExternalRepositories,
    pending.tasksetIdentity.kind);
  if (!sameJson(actual, expected)) fail("EVIDENCE_PROMOTION_TASKSET_MISMATCH");

  if (typeof evidence.benchmarkPath !== "string" || evidence.benchmarkPath.includes("..") ||
      evidence.benchmarkPath.includes("\\") || !evidence.benchmarkPath) {
    fail("EVIDENCE_PROMOTION_MODE_F_BENCHMARK_PATH_INVALID");
  }
  const benchmarkBytes = Buffer.from(git(root, ["show",
    `${evidence.sourceCommit}:${evidence.benchmarkPath}`]));
  if (sha256Bytes(benchmarkBytes) !== evidence.benchmarkFileHash ||
      git(root, ["rev-parse", `${evidence.sourceCommit}:${evidence.benchmarkPath}`]) !==
        evidence.benchmarkGitBlob) {
    fail("EVIDENCE_PROMOTION_SOURCE_COMMIT_BINDING_INVALID");
  }

  const rawPath = safeChild(dirname(artifactFile), evidence.rawReportPath,
    "EVIDENCE_PROMOTION_MODE_F_RAW_PATH_INVALID");
  const rawBytes = readFileSync(rawPath);
  if (sha256Bytes(rawBytes) !== evidence.rawReportByteHash) {
    fail("EVIDENCE_PROMOTION_MODE_F_RAW_HASH_INVALID");
  }
  const raw = parseJsonFile(rawPath, "EVIDENCE_PROMOTION_MODE_F_RAW_JSON_INVALID");
  if (raw.reportHash !== evidence.rawReportHash || raw.executionClass !== evidence.executionClass ||
      raw.taskCount !== expected.length || raw.modeCount !== MODE_F_MODES.length ||
      raw.sampleCount !== evidence.sampleCount || !Array.isArray(raw.tasks) ||
      !Array.isArray(raw.results) || !Array.isArray(raw.aggregates)) {
    fail("EVIDENCE_PROMOTION_MODE_F_RAW_BINDING_INVALID");
  }
  const rawTasks = normalizeIdentity(raw.tasks, pending.tasksetIdentity.kind);
  if (!sameJson(rawTasks, expected)) fail("EVIDENCE_PROMOTION_TASKSET_MISMATCH");
  const modes = raw.aggregates.map((entry) => entry?.mode).sort();
  if (!sameJson(modes, [...MODE_F_MODES].sort())) {
    fail("EVIDENCE_PROMOTION_MODE_F_MODES_INVALID");
  }
  const representedTaskIds = [...new Set(raw.results.map((entry) => entry?.taskId))].sort();
  if (!sameJson(representedTaskIds, expected.map((entry) => entry.taskId).sort())) {
    fail("EVIDENCE_PROMOTION_TASKSET_MISMATCH");
  }

  return {
    sourceCommit: evidence.sourceCommit,
    provider: config.transport,
    model: config.model,
    artifactFile,
    artifactHash: evidence.evidenceHash,
    evidenceClass: "gate5_mode_f_observed_live_evidence",
    statusReason:
      "Verified live C/E/F evidence is registered without making or implying a Mode F promotion decision."
  };
}

function proposedEntry(root, pending, verified) {
  return {
    experimentId: pending.experimentId,
    family: pending.family,
    sourceCommit: verified.sourceCommit,
    tasksetHash: pending.tasksetHash,
    tasksetHashKind: pending.tasksetHashKind,
    tasksetIdentity: pending.tasksetIdentity,
    evidenceClass: verified.evidenceClass,
    provider: verified.provider,
    model: verified.model,
    artifactPath: repoRelativeArtifact(root, verified.artifactFile),
    artifactHash: verified.artifactHash,
    artifactHashKind: "json_field:evidenceHash",
    status: "observed",
    statusReason: verified.statusReason
  };
}

function deriveObservedEntry({ root = process.cwd(), experimentId, artifactPath, deepVerify = true }) {
  const repositoryRoot = git(root, ["rev-parse", "--show-toplevel"]);
  const index = verifyIndex(parseIndex(repositoryRoot), repositoryRoot);
  const pending = experiment(index, experimentId);
  let verified;
  if (experimentId === CONTROLLED_EXPERIMENT) {
    verified = verifyControlledArtifact({
      root: repositoryRoot,
      artifactPath,
      pending,
      deepVerify
    });
  } else if (experimentId === MODE_F_EXPERIMENT) {
    verified = verifyModeFArtifact({ root: repositoryRoot, artifactPath, pending });
  } else {
    fail("EVIDENCE_PROMOTION_EXPERIMENT_UNSUPPORTED", experimentId);
  }
  return proposedEntry(repositoryRoot, pending, verified);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail("EVIDENCE_PROMOTION_ARGUMENT_INVALID", name);
  return value;
}

function main() {
  const experimentId = argument("--experiment");
  const artifactPath = argument("--artifact");
  const check = process.argv.includes("--check");
  const printEntry = process.argv.includes("--print-entry");
  if (!experimentId || !artifactPath || check === printEntry) {
    fail("EVIDENCE_PROMOTION_USAGE_INVALID",
      "require --experiment, --artifact, and exactly one of --check or --print-entry");
  }
  const entry = deriveObservedEntry({ root: process.cwd(), experimentId, artifactPath });
  if (printEntry) {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    experimentId: entry.experimentId,
    sourceCommit: entry.sourceCommit,
    artifactHash: entry.artifactHash,
    proposedEntryHash: hashCanonical(entry)
  }, null, 2)}\n`);
}

module.exports = {
  CONTROLLED_EXPERIMENT,
  MODE_F_EXPERIMENT,
  PromotionError,
  deriveObservedEntry,
  verifyControlledArtifact,
  verifyModeFArtifact
};

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error?.code || "EVIDENCE_PROMOTION_INTERNAL_ERROR"}: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
