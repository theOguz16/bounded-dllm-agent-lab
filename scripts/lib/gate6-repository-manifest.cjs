"use strict";

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const SCHEMA_VERSION = "gate6-repository-manifest/v1";
const SUPPORTED_LANGUAGES = Object.freeze([
  "javascript",
  "typescript",
  "python",
  "go",
  "rust",
  "java"
]);
const MANIFEST_FIELDS = Object.freeze(["schemaVersion", "repositories"]);
const REPOSITORY_FIELDS = Object.freeze(["id", "commitSha", "language", "license"]);
const SHA40 = /^[0-9a-f]{40}$/;
const REPOSITORY_ID = /^[^/\s]+\/[^/\s]+$/;

class Gate6RepositoryManifestError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6RepositoryManifestError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Gate6RepositoryManifestError(code, detail);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateRepository(entry, index) {
  const label = `repositories[${index}]`;
  if (!sameKeys(entry, REPOSITORY_FIELDS)) {
    fail("GATE6_REPOSITORY_ENTRY_INVALID", label);
  }
  if (typeof entry.id !== "string" || !REPOSITORY_ID.test(entry.id)) {
    fail("GATE6_REPOSITORY_ID_INVALID", label);
  }
  if (typeof entry.commitSha !== "string" || !SHA40.test(entry.commitSha)) {
    fail("GATE6_REPOSITORY_COMMIT_SHA_INVALID", `${label}.commitSha`);
  }
  if (typeof entry.language !== "string" || !SUPPORTED_LANGUAGES.includes(entry.language)) {
    fail("GATE6_REPOSITORY_LANGUAGE_UNSUPPORTED", String(entry.language));
  }
  if (typeof entry.license !== "string" || entry.license.trim().length === 0) {
    fail("GATE6_REPOSITORY_LICENSE_INVALID", label);
  }
}

function validateGate6RepositoryManifest(manifest) {
  if (!sameKeys(manifest, MANIFEST_FIELDS)) {
    fail("GATE6_REPOSITORY_MANIFEST_INVALID");
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    fail("GATE6_REPOSITORY_MANIFEST_SCHEMA_UNSUPPORTED", String(manifest.schemaVersion));
  }
  if (!Array.isArray(manifest.repositories) || manifest.repositories.length === 0) {
    fail("GATE6_REPOSITORY_MANIFEST_EMPTY");
  }

  const seenIds = new Set();
  const seenPairs = new Set();
  for (let index = 0; index < manifest.repositories.length; index += 1) {
    const entry = manifest.repositories[index];
    validateRepository(entry, index);
    const pair = `${entry.id}\0${entry.commitSha}`;
    if (seenPairs.has(pair)) {
      fail("GATE6_REPOSITORY_DUPLICATE_ENTRY", entry.id);
    }
    if (seenIds.has(entry.id)) {
      fail("GATE6_REPOSITORY_DUPLICATE_ID", entry.id);
    }
    seenPairs.add(pair);
    seenIds.add(entry.id);
  }

  return manifest;
}

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("GATE6_REPOSITORY_CANONICAL_INVALID");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isPlainObject(value)) fail("GATE6_REPOSITORY_CANONICAL_INVALID");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`
  ).join(",")}}`;
}

function canonicalizeGate6RepositoryManifest(manifest) {
  validateGate6RepositoryManifest(manifest);
  const repositories = manifest.repositories
    .map((entry) => Object.freeze({ ...entry }))
    .sort((left, right) => compareStrings(left.id, right.id) || compareStrings(left.commitSha, right.commitSha));
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    repositories: Object.freeze(repositories)
  });
}

function hashGate6RepositoryManifest(manifest) {
  const normalized = canonicalizeGate6RepositoryManifest(manifest);
  return `sha256:${createHash("sha256").update(canonical(normalized)).digest("hex")}`;
}

function parseGate6RepositoryManifest(text) {
  if (typeof text !== "string") fail("GATE6_REPOSITORY_MANIFEST_JSON_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("GATE6_REPOSITORY_MANIFEST_JSON_INVALID");
  }
  return canonicalizeGate6RepositoryManifest(parsed);
}

function loadGate6RepositoryManifest(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    fail("GATE6_REPOSITORY_MANIFEST_READ_FAILED", String(filePath));
  }
  return parseGate6RepositoryManifest(text);
}

function getRepositoryEntry(manifest, repositoryId) {
  const normalized = canonicalizeGate6RepositoryManifest(manifest);
  const entry = normalized.repositories.find((repository) => repository.id === repositoryId);
  if (!entry) fail("GATE6_RUNTIME_REPOSITORY_NOT_IN_MANIFEST", String(repositoryId));
  return entry;
}

function gitHead(repositoryPath) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: resolve(repositoryPath),
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    fail("GATE6_RUNTIME_REPOSITORY_GIT_FAILED", String(repositoryPath));
  }
  const head = String(result.stdout || "").trim();
  if (!SHA40.test(head)) fail("GATE6_RUNTIME_REPOSITORY_HEAD_INVALID", head);
  return head;
}

function verifyRuntimeRepository({ manifest, repositoryId, repositoryPath }) {
  const entry = getRepositoryEntry(manifest, repositoryId);
  const actualCommitSha = gitHead(repositoryPath);
  if (actualCommitSha !== entry.commitSha) {
    fail(
      "GATE6_RUNTIME_REPOSITORY_SHA_MISMATCH",
      `${repositoryId}: expected ${entry.commitSha}, got ${actualCommitSha}`
    );
  }
  return Object.freeze({
    repositoryId,
    expectedCommitSha: entry.commitSha,
    actualCommitSha
  });
}

module.exports = {
  Gate6RepositoryManifestError,
  MANIFEST_FIELDS,
  REPOSITORY_FIELDS,
  SCHEMA_VERSION,
  SUPPORTED_LANGUAGES,
  canonicalizeGate6RepositoryManifest,
  getRepositoryEntry,
  hashGate6RepositoryManifest,
  loadGate6RepositoryManifest,
  parseGate6RepositoryManifest,
  validateGate6RepositoryManifest,
  verifyRuntimeRepository
};
