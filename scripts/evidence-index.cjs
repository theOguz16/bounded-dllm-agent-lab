#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const SCHEMA_VERSION = "bounded.evidence-index/v1";
const INDEX_PATH = "evidence/index.json";
const GENERATED_DOC_PATH = "docs/EVIDENCE_INDEX.md";
const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const STATUSES = new Set(["observed", "fixture", "pending", "archived"]);
const RECORD_KEYS = [
  "experimentId", "family", "sourceCommit", "tasksetHash", "tasksetHashKind",
  "tasksetIdentity", "evidenceClass", "provider", "model", "artifactPath",
  "artifactHash", "artifactHashKind", "status", "statusReason"
].sort();

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("EVIDENCE_INDEX_CANONICAL_INVALID");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("EVIDENCE_INDEX_CANONICAL_INVALID");
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`
  ).join(",")}}`;
}

function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function fail(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function parseIndex(root = process.cwd()) {
  const absolute = resolve(root, INDEX_PATH);
  let parsed;
  try { parsed = JSON.parse(readFileSync(absolute, "utf8")); }
  catch { fail("EVIDENCE_INDEX_JSON_INVALID", INDEX_PATH); }
  return parsed;
}

function sameKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function validateNullableString(value, field) {
  if (value !== null && (typeof value !== "string" || value.length === 0)) {
    fail("EVIDENCE_INDEX_FIELD_INVALID", field);
  }
}

function verifyTaskset(record) {
  if (!HASH.test(record.tasksetHash)) fail("EVIDENCE_INDEX_TASKSET_HASH_INVALID", record.experimentId);
  if (record.tasksetHashKind === "index_taskset_identity_v1") {
    if (!record.tasksetIdentity || typeof record.tasksetIdentity !== "object" ||
        Array.isArray(record.tasksetIdentity) ||
        hashCanonical(record.tasksetIdentity) !== record.tasksetHash) {
      fail("EVIDENCE_INDEX_TASKSET_IDENTITY_MISMATCH", record.experimentId);
    }
    return;
  }
  if (record.tasksetIdentity !== null) {
    fail("EVIDENCE_INDEX_TASKSET_IDENTITY_UNEXPECTED", record.experimentId);
  }
  if (!["source_artifact_task_set_hash", "pilot_definition_hash"].includes(record.tasksetHashKind)) {
    fail("EVIDENCE_INDEX_TASKSET_HASH_KIND_INVALID", record.experimentId);
  }
}

function normalizedExternalTasks(tasks) {
  if (!Array.isArray(tasks)) return null;
  return tasks.map((entry) => ({
    taskId: entry?.taskId,
    repository: entry?.repository,
    commitSha: entry?.commitSha
  })).sort((left, right) => String(left.taskId).localeCompare(String(right.taskId)));
}

function verifyPromotedEvidenceArtifact(record, parsed) {
  if (parsed.evidenceHash !== record.artifactHash || parsed.sourceCommit !== record.sourceCommit) {
    fail("EVIDENCE_INDEX_ARTIFACT_HASH_MISMATCH", record.experimentId);
  }

  if (parsed.schemaVersion === "bounded.controlled-coding-pilot-observed-evidence/v3") {
    if (record.experimentId !== "controlled-coding-pilot-v2-suite" ||
        parsed.experimentConfig?.modelId !== record.model ||
        parsed.experimentConfig?.provider?.transport !== record.provider ||
        !Array.isArray(parsed.runs) ||
        parsed.runCount !== parsed.runs.length ||
        record.tasksetIdentity?.kind !== "controlled_pilot_definitions/v1") {
      fail("EVIDENCE_INDEX_PROMOTED_ARTIFACT_INVALID", record.experimentId);
    }
    const expected = record.tasksetIdentity.tasks.map((entry) => entry.pilotId).sort();
    const actual = parsed.runs.map((entry) => entry?.pilotId).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail("EVIDENCE_INDEX_TASKSET_SOURCE_MISMATCH", record.experimentId);
    }
    return;
  }

  if (parsed.schemaVersion === "gate5-mode-f-live-evidence/v1") {
    if (record.experimentId !== "gate5-mode-f-c-e-f" ||
        parsed.researchStatus !== "observed_live_result" ||
        parsed.executionClass !== "live_adaptive_compressed_boundary" ||
        parsed.experimentConfig?.model !== record.model ||
        parsed.experimentConfig?.transport !== record.provider ||
        record.tasksetIdentity?.kind !== "external_repository_tasks/v1") {
      fail("EVIDENCE_INDEX_PROMOTED_ARTIFACT_INVALID", record.experimentId);
    }
    const expected = normalizedExternalTasks(record.tasksetIdentity.tasks);
    const actual = normalizedExternalTasks(parsed.immutableExternalRepositories);
    if (!expected || !actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail("EVIDENCE_INDEX_TASKSET_SOURCE_MISMATCH", record.experimentId);
    }
    return;
  }

  fail("EVIDENCE_INDEX_ARTIFACT_HASH_KIND_INVALID", record.experimentId);
}

function verifyArtifact(root, record) {
  if (record.status !== "observed") {
    if (record.artifactPath !== null || record.artifactHash !== null ||
        record.artifactHashKind !== null) {
      fail("EVIDENCE_INDEX_NON_OBSERVED_ARTIFACT_INVALID", record.experimentId);
    }
    return;
  }
  if (!record.sourceCommit || !COMMIT.test(record.sourceCommit)) {
    fail("EVIDENCE_INDEX_OBSERVED_SOURCE_COMMIT_REQUIRED", record.experimentId);
  }
  if (typeof record.provider !== "string" || record.provider.length === 0 ||
      typeof record.model !== "string" || record.model.length === 0) {
    fail("EVIDENCE_INDEX_OBSERVED_PROVIDER_MODEL_REQUIRED", record.experimentId);
  }
  if (typeof record.artifactPath !== "string" || record.artifactPath.length === 0 ||
      !HASH.test(record.artifactHash ?? "") ||
      typeof record.artifactHashKind !== "string") {
    fail("EVIDENCE_INDEX_OBSERVED_ARTIFACT_REQUIRED", record.experimentId);
  }
  const absolute = resolve(root, record.artifactPath);
  if (!existsSync(absolute)) fail("EVIDENCE_INDEX_ARTIFACT_MISSING", record.artifactPath);
  const content = readFileSync(absolute, "utf8");
  if (record.artifactHashKind === "json_field:reportHash") {
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { fail("EVIDENCE_INDEX_ARTIFACT_JSON_INVALID", record.artifactPath); }
    if (parsed.reportHash !== record.artifactHash) {
      fail("EVIDENCE_INDEX_ARTIFACT_HASH_MISMATCH", record.experimentId);
    }
    if (record.tasksetHashKind === "source_artifact_task_set_hash" &&
        parsed?.sourceArtifacts?.observedTokenCost?.taskSetHash !== record.tasksetHash) {
      fail("EVIDENCE_INDEX_TASKSET_SOURCE_MISMATCH", record.experimentId);
    }
    return;
  }
  if (record.artifactHashKind === "text_field:evidenceHash") {
    const match = content.match(/^evidenceHash:\s*(sha256:[0-9a-f]{64})\s*$/m);
    if (!match || match[1] !== record.artifactHash) {
      fail("EVIDENCE_INDEX_ARTIFACT_HASH_MISMATCH", record.experimentId);
    }
    if (record.tasksetHashKind === "pilot_definition_hash") {
      const definition = content.match(/^pilotDefinitionHash:\s*(sha256:[0-9a-f]{64})\s*$/m);
      if (!definition || definition[1] !== record.tasksetHash) {
        fail("EVIDENCE_INDEX_TASKSET_SOURCE_MISMATCH", record.experimentId);
      }
    }
    return;
  }
  if (record.artifactHashKind === "json_field:evidenceHash") {
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { fail("EVIDENCE_INDEX_ARTIFACT_JSON_INVALID", record.artifactPath); }
    verifyPromotedEvidenceArtifact(record, parsed);
    return;
  }
  fail("EVIDENCE_INDEX_ARTIFACT_HASH_KIND_INVALID", record.experimentId);
}

function verifyIndex(index, root = process.cwd()) {
  if (!index || typeof index !== "object" || Array.isArray(index) ||
      JSON.stringify(Object.keys(index).sort()) !==
        JSON.stringify(["experiments", "indexHash", "schemaVersion"].sort()) ||
      index.schemaVersion !== SCHEMA_VERSION || !Array.isArray(index.experiments) ||
      !HASH.test(index.indexHash ?? "")) {
    fail("EVIDENCE_INDEX_SCHEMA_INVALID");
  }
  const { indexHash, ...core } = index;
  if (hashCanonical(core) !== indexHash) fail("EVIDENCE_INDEX_HASH_MISMATCH");
  const ids = new Set();
  for (const record of index.experiments) {
    if (!sameKeys(record, RECORD_KEYS) || !SAFE_ID.test(record.experimentId ?? "") ||
        !SAFE_ID.test(record.family ?? "") || ids.has(record.experimentId) ||
        !STATUSES.has(record.status) || typeof record.evidenceClass !== "string" ||
        record.evidenceClass.length === 0 || typeof record.statusReason !== "string" ||
        record.statusReason.length === 0) {
      fail("EVIDENCE_INDEX_RECORD_INVALID", record?.experimentId ?? "unknown");
    }
    ids.add(record.experimentId);
    if (record.sourceCommit !== null && !COMMIT.test(record.sourceCommit)) {
      fail("EVIDENCE_INDEX_SOURCE_COMMIT_INVALID", record.experimentId);
    }
    validateNullableString(record.provider, `${record.experimentId}.provider`);
    validateNullableString(record.model, `${record.experimentId}.model`);
    validateNullableString(record.artifactPath, `${record.experimentId}.artifactPath`);
    validateNullableString(record.artifactHash, `${record.experimentId}.artifactHash`);
    validateNullableString(record.artifactHashKind, `${record.experimentId}.artifactHashKind`);
    verifyTaskset(record);
    verifyArtifact(root, record);
  }
  return index;
}

function statusFor(index, query) {
  if (typeof query !== "string" || query.length === 0) fail("EVIDENCE_INDEX_QUERY_REQUIRED");
  const needle = query.toLowerCase();
  const experiments = index.experiments.filter((record) =>
    record.experimentId.toLowerCase().includes(needle) ||
    record.family.toLowerCase().includes(needle)
  );
  if (experiments.length === 0) fail("EVIDENCE_INDEX_QUERY_NOT_FOUND", query);
  const counts = Object.fromEntries([...STATUSES].map((status) => [
    status, experiments.filter((record) => record.status === status).length
  ]));
  return {
    query,
    matchedExperimentCount: experiments.length,
    fullyObserved: experiments.every((record) => record.status === "observed"),
    anyObserved: experiments.some((record) => record.status === "observed"),
    counts,
    experiments: experiments.map((record) => ({
      experimentId: record.experimentId,
      status: record.status,
      evidenceClass: record.evidenceClass,
      sourceCommit: record.sourceCommit,
      artifactHash: record.artifactHash,
      statusReason: record.statusReason
    }))
  };
}

function renderMarkdown(index) {
  const lines = [
    "# Evidence Index",
    "",
    "> GENERATED FILE — source of truth: `evidence/index.json`.",
    "> Do not edit experiment status in Markdown; update and verify the machine-readable index instead.",
    "",
    `Index schema: \`${index.schemaVersion}\`  `,
    `Index hash: \`${index.indexHash}\``,
    "",
    "| Experiment | Family | Status | Evidence class | Provider | Model | Artifact |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const record of index.experiments) {
    const artifact = record.artifactPath
      ? `\`${record.artifactPath}\`<br>\`${record.artifactHash}\``
      : "—";
    lines.push(
      `| \`${record.experimentId}\` | \`${record.family}\` | **${record.status}** | ` +
      `\`${record.evidenceClass}\` | ${record.provider ?? "—"} | ${record.model ?? "—"} | ${artifact} |`
    );
  }
  lines.push("", "## Status reasons", "");
  for (const record of index.experiments) {
    lines.push(`- \`${record.experimentId}\`: ${record.statusReason}`);
  }
  lines.push("", "## Programmatic queries", "", "```bash",
    "node scripts/evidence-index.cjs verify",
    "node scripts/evidence-index.cjs status gate5",
    "node scripts/evidence-index.cjs status controlled_coding_pilot_v2",
    "node scripts/evidence-index.cjs generate --check",
    "```", "");
  return lines.join("\n");
}

function main() {
  const command = process.argv[2] ?? "verify";
  const root = process.cwd();
  const index = verifyIndex(parseIndex(root), root);
  if (command === "verify") {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schemaVersion: index.schemaVersion,
      indexHash: index.indexHash,
      experimentCount: index.experiments.length,
      observedCount: index.experiments.filter((entry) => entry.status === "observed").length
    }, null, 2)}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(statusFor(index, process.argv[3]), null, 2)}\n`);
    return;
  }
  if (command === "generate") {
    const rendered = renderMarkdown(index);
    const target = resolve(root, GENERATED_DOC_PATH);
    if (process.argv.includes("--check")) {
      if (!existsSync(target) || readFileSync(target, "utf8") !== rendered) {
        fail("EVIDENCE_INDEX_GENERATED_DOC_OUT_OF_DATE", GENERATED_DOC_PATH);
      }
      process.stdout.write(`${JSON.stringify({ ok: true, generatedDoc: GENERATED_DOC_PATH })}\n`);
      return;
    }
    require("node:fs").writeFileSync(target, rendered, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, generatedDoc: GENERATED_DOC_PATH })}\n`);
    return;
  }
  fail("EVIDENCE_INDEX_COMMAND_INVALID", command);
}

module.exports = {
  GENERATED_DOC_PATH,
  INDEX_PATH,
  SCHEMA_VERSION,
  hashCanonical,
  parseIndex,
  renderMarkdown,
  statusFor,
  verifyIndex
};

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
