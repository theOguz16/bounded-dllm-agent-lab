#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync
} = require("node:fs");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");

const VERIFIER = join(__dirname, "controlled-coding-pilot-evidence-verify.cjs");
const MANIFEST_NAME = "evidence-manifest.json";
const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const V1_EVIDENCE_SCHEMA = "bounded.controlled-coding-pilot-evidence/v1";
const V2_EVIDENCE_SCHEMA = "bounded.controlled-coding-pilot-evidence/v2";
const LLAMA_COMMIT = /^[0-9A-Fa-f]{7,40}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

class AcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new AcceptanceError(code);
}

function parseArguments(argv) {
  const allowed = new Set([
    "--bundle-dir", "--expected-source-commit", "--llama-build", "--llama-commit", "--out"
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith("--")) {
      fail("ACCEPTANCE_ARGUMENT_INVALID");
    }
    if (Object.hasOwn(parsed, name)) fail("ACCEPTANCE_ARGUMENT_DUPLICATE");
    parsed[name] = value;
  }
  if (argv.length !== 10 || [...allowed].some((name) => !Object.hasOwn(parsed, name))) {
    fail("ACCEPTANCE_ARGUMENT_MISSING");
  }
  if (!COMMIT.test(parsed["--expected-source-commit"])) {
    fail("ACCEPTANCE_EXPECTED_COMMIT_INVALID");
  }
  if (!/^[1-9][0-9]*$/.test(parsed["--llama-build"])) {
    fail("ACCEPTANCE_LLAMA_BUILD_INVALID");
  }
  const llamaBuild = Number(parsed["--llama-build"]);
  if (!Number.isSafeInteger(llamaBuild)) fail("ACCEPTANCE_LLAMA_BUILD_INVALID");
  if (!LLAMA_COMMIT.test(parsed["--llama-commit"])) {
    fail("ACCEPTANCE_LLAMA_COMMIT_INVALID");
  }
  return {
    bundleDir: parsed["--bundle-dir"],
    expectedSourceCommit: parsed["--expected-source-commit"],
    llamaBuild,
    llamaCommit: parsed["--llama-commit"],
    out: parsed["--out"]
  };
}

function canonicalJson(value, ancestors = new WeakSet()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("ACCEPTANCE_CANONICAL_JSON_INVALID");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") fail("ACCEPTANCE_CANONICAL_JSON_INVALID");
  if (ancestors.has(value)) fail("ACCEPTANCE_CANONICAL_JSON_INVALID");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("ACCEPTANCE_CANONICAL_JSON_INVALID");
    }
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashCanonicalJson(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function isWithin(parent, candidate) {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function stableFile(absolute) {
  let descriptor;
  try {
    const before = lstatSync(absolute, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) fail("ACCEPTANCE_BUNDLE_FILE_INVALID");
    descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) fail("ACCEPTANCE_BUNDLE_CHANGED");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(absolute, { bigint: true });
    if (!sameIdentity(opened, after) || after.size !== BigInt(bytes.length) ||
        !current.isFile() || !sameIdentity(opened, current)) {
      fail("ACCEPTANCE_BUNDLE_CHANGED");
    }
    return { bytes, byteSize: bytes.length, sha256: sha256(bytes), stats: current };
  } catch (error) {
    if (error instanceof AcceptanceError) throw error;
    fail("ACCEPTANCE_BUNDLE_FILE_MISSING");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function snapshotBundle(bundleRoot, excludedOutput) {
  const records = [];
  function visit(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      fail("ACCEPTANCE_BUNDLE_TREE_INVALID");
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (excludedOutput && absolute === excludedOutput) continue;
      const path = relative(bundleRoot, absolute).split(sep).join("/");
      if (!path || path === ".." || path.startsWith("../") || isAbsolute(path) ||
          path.length > 4096 || CONTROL.test(path)) {
        fail("ACCEPTANCE_BUNDLE_PATH_INVALID");
      }
      let stats;
      try {
        stats = lstatSync(absolute, { bigint: true });
      } catch {
        fail("ACCEPTANCE_BUNDLE_CHANGED");
      }
      if (stats.isSymbolicLink()) fail("ACCEPTANCE_BUNDLE_SYMLINK_REJECTED");
      if (stats.isDirectory()) visit(absolute);
      else if (stats.isFile()) {
        const snapshot = stableFile(absolute);
        records.push({
          path,
          byteSize: snapshot.byteSize,
          sha256: snapshot.sha256,
          dev: snapshot.stats.dev.toString(),
          ino: snapshot.stats.ino.toString(),
          mode: snapshot.stats.mode.toString()
        });
      } else {
        fail("ACCEPTANCE_BUNDLE_FILE_INVALID");
      }
    }
  }
  visit(bundleRoot);
  return records.sort((left, right) => left.path < right.path ? -1 : 1);
}

function snapshotsEqual(left, right) {
  return left.length === right.length && left.every((record, index) => {
    const other = right[index];
    return record.path === other.path && record.byteSize === other.byteSize &&
      record.sha256 === other.sha256 && record.dev === other.dev &&
      record.ino === other.ino && record.mode === other.mode;
  });
}

function resolveBundle(requested) {
  const lexical = resolve(process.cwd(), requested);
  let stats;
  try {
    stats = lstatSync(lexical);
  } catch {
    fail("ACCEPTANCE_BUNDLE_MISSING");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("ACCEPTANCE_BUNDLE_INVALID");
  try {
    return realpathSync(lexical);
  } catch {
    fail("ACCEPTANCE_BUNDLE_INVALID");
  }
}

function resolveOutput(requested, bundleRoot, beforeSnapshot) {
  const lexical = resolve(process.cwd(), requested);
  let parent;
  try {
    const parentStats = lstatSync(dirname(lexical));
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      fail("ACCEPTANCE_OUTPUT_PARENT_INVALID");
    }
    parent = realpathSync(dirname(lexical));
  } catch (error) {
    if (error instanceof AcceptanceError) throw error;
    fail("ACCEPTANCE_OUTPUT_PARENT_INVALID");
  }
  const output = join(parent, basename(lexical));
  const reportRoot = join(bundleRoot, "report");
  const manifestPath = join(bundleRoot, MANIFEST_NAME);
  if (output === manifestPath || isWithin(reportRoot, output)) {
    fail("ACCEPTANCE_OUTPUT_UNSAFE");
  }
  try {
    const stats = lstatSync(output, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) fail("ACCEPTANCE_OUTPUT_INVALID");
    if (beforeSnapshot.some((entry) =>
      join(bundleRoot, ...entry.path.split("/")) !== output &&
      entry.dev === stats.dev.toString() && entry.ino === stats.ino.toString())) {
      fail("ACCEPTANCE_OUTPUT_UNSAFE");
    }
  } catch (error) {
    if (error instanceof AcceptanceError) throw error;
    if (error?.code !== "ENOENT") fail("ACCEPTANCE_OUTPUT_INVALID");
  }
  return output;
}

function runVerifier(bundleRoot, expectedSourceCommit) {
  const result = spawnSync(process.execPath, [
    VERIFIER,
    "--bundle-dir", bundleRoot,
    "--expected-source-commit", expectedSourceCommit
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    timeout: 10_000,
    maxBuffer: 64_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) fail("ACCEPTANCE_EVIDENCE_VERIFICATION_FAILED");
  const lines = result.stdout.trimEnd().split("\n");
  if (lines.length !== 7 || lines[0] !== "EVIDENCE_VERIFY=PASS") {
    fail("ACCEPTANCE_VERIFIER_OUTPUT_INVALID");
  }
  const provenanceKey = lines[5]?.startsWith("sourceTargetBlobHash=")
    ? "sourceTargetBlobHash"
    : lines[5]?.startsWith("sourceTargetsHash=") ? "sourceTargetsHash" : undefined;
  if (!provenanceKey) fail("ACCEPTANCE_VERIFIER_OUTPUT_INVALID");
  const expectedKeys = [
    "sourceCommit", "reportHash", "evidenceHash", "fileCount",
    provenanceKey, "sourceBlobVerification"
  ];
  const values = {};
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const prefix = `${expectedKeys[index]}=`;
    if (!lines[index + 1].startsWith(prefix)) fail("ACCEPTANCE_VERIFIER_OUTPUT_INVALID");
    values[expectedKeys[index]] = lines[index + 1].slice(prefix.length);
  }
  if (values.sourceCommit !== expectedSourceCommit || !HASH.test(values.reportHash) ||
      !HASH.test(values.evidenceHash) || !/^[0-9]+$/.test(values.fileCount) ||
      (provenanceKey === "sourceTargetBlobHash"
        ? !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(values[provenanceKey])
        : !HASH.test(values[provenanceKey])) ||
      !/^(?:verified|unavailable)$/.test(values.sourceBlobVerification)) {
    fail("ACCEPTANCE_VERIFIER_OUTPUT_INVALID");
  }
  return { ...values, provenanceKey };
}

function readManifest(bundleRoot) {
  const snapshot = stableFile(join(bundleRoot, MANIFEST_NAME));
  let manifest;
  try {
    manifest = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    fail("ACCEPTANCE_MANIFEST_INVALID");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("ACCEPTANCE_MANIFEST_INVALID");
  }
  return manifest;
}

function buildRecord(manifest, verifierResult, args) {
  if (manifest.sourceCommit !== verifierResult.sourceCommit ||
      manifest.reportHash !== verifierResult.reportHash ||
      manifest.evidenceHash !== verifierResult.evidenceHash) {
    fail("ACCEPTANCE_VERIFIED_MANIFEST_MISMATCH");
  }
  let provenanceFields;
  if (manifest.schemaVersion === V1_EVIDENCE_SCHEMA &&
      verifierResult.provenanceKey === "sourceTargetBlobHash" &&
      manifest.sourceTargetBlobHash === verifierResult.sourceTargetBlobHash) {
    provenanceFields = ["sourceTargetPath", "sourceTargetBlobHash"];
  } else if (manifest.schemaVersion === V2_EVIDENCE_SCHEMA &&
      verifierResult.provenanceKey === "sourceTargetsHash" &&
      hashCanonicalJson(manifest.sourceTargets) === verifierResult.sourceTargetsHash) {
    provenanceFields = ["sourceTargets"];
  } else {
    fail("ACCEPTANCE_VERIFIED_MANIFEST_MISMATCH");
  }
  const evidenceFields = [
    "schemaVersion", "pilotId", "sourceCommit", "pilotDefinitionHash", "reportHash",
    "evidenceHash", "providerKind", "modelId", "providerCallCount", "retryCount",
    "patchLineCount", ...provenanceFields
  ];
  const core = {};
  for (const field of evidenceFields) {
    if (!Object.hasOwn(manifest, field)) fail("ACCEPTANCE_MANIFEST_INVALID");
    core[field] = manifest[field];
  }
  core.runtime = { kind: "llama.cpp", build: args.llamaBuild, commit: args.llamaCommit };
  core.verification = {
    evidenceVerified: true,
    sourceBlobVerification: verifierResult.sourceBlobVerification
  };
  core.acceptance = { finalGatePassed: true, mergeEligible: true };
  return { ...core, acceptanceHash: hashCanonicalJson(core) };
}

function writeAtomic(output, bytes) {
  let temporary;
  let descriptor;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(dirname(output), `.${basename(output)}.tmp-${process.pid}-${attempt}`);
    try {
      descriptor = openSync(candidate,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600);
      temporary = candidate;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") fail("ACCEPTANCE_OUTPUT_WRITE_FAILED");
    }
  }
  if (descriptor === undefined) fail("ACCEPTANCE_OUTPUT_WRITE_FAILED");
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, output);
    temporary = undefined;
  } catch {
    fail("ACCEPTANCE_OUTPUT_WRITE_FAILED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporary !== undefined) {
      try { unlinkSync(temporary); } catch { /* bounded best-effort cleanup */ }
    }
  }
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const bundleRoot = resolveBundle(args.bundleDir);
  const preliminarySnapshot = snapshotBundle(bundleRoot);
  const output = resolveOutput(args.out, bundleRoot, preliminarySnapshot);
  const excludedOutput = isWithin(bundleRoot, output) ? output : undefined;
  const beforeSnapshot = snapshotBundle(bundleRoot, excludedOutput);
  const verifierResult = runVerifier(bundleRoot, args.expectedSourceCommit);
  const manifest = readManifest(bundleRoot);
  const record = buildRecord(manifest, verifierResult, args);
  const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
  const afterSnapshot = snapshotBundle(bundleRoot, excludedOutput);
  if (!snapshotsEqual(beforeSnapshot, afterSnapshot)) fail("ACCEPTANCE_BUNDLE_CHANGED");
  writeAtomic(output, bytes);

  process.stdout.write([
    "ACCEPTANCE_RECORD=PASS",
    `sourceCommit=${record.sourceCommit}`,
    `modelId=${record.modelId}`,
    `llamaBuild=${record.runtime.build}`,
    `llamaCommit=${record.runtime.commit}`,
    `reportHash=${record.reportHash}`,
    `evidenceHash=${record.evidenceHash}`,
    `acceptanceHash=${record.acceptanceHash}`,
    `sourceBlobVerification=${record.verification.sourceBlobVerification}`
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  const code = error instanceof AcceptanceError ? error.code : "ACCEPTANCE_INTERNAL_ERROR";
  process.stderr.write(`ACCEPTANCE_RECORD=FAIL\nerrorCode=${code}\n`);
  process.exitCode = 1;
}
