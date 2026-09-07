"use strict";

const { createHash } = require("node:crypto");
const { safeRelativePath } = require("./gate6-simulated-workspace.cjs");
const {
  PROPOSAL_VERSION,
  pathMatchesRule,
  validateProposal
} = require("./gate6-simulated-coding-harness.cjs");

const PROPOSAL_VALIDATION_FAILURE_CODES = Object.freeze({
  PROPOSAL_SHAPE_INVALID: "PROPOSAL_SHAPE_INVALID",
  PROPOSAL_SCHEMA_VERSION_INVALID: "PROPOSAL_SCHEMA_VERSION_INVALID",
  PROPOSAL_ACTION_INVALID: "PROPOSAL_ACTION_INVALID",
  PROPOSAL_SUMMARY_INVALID: "PROPOSAL_SUMMARY_INVALID",
  PROPOSAL_EDITS_INVALID: "PROPOSAL_EDITS_INVALID",
  PROPOSAL_ACTION_EDITS_MISMATCH: "PROPOSAL_NO_CHANGE_INVALID",
  PROPOSAL_EDIT_SHAPE_INVALID: "PROPOSAL_EDIT_INVALID",
  PROPOSAL_EDIT_PATH_INVALID: "PROPOSAL_PATH_INVALID",
  PROPOSAL_EDIT_HASH_INVALID: "PROPOSAL_HASH_INVALID",
  PROPOSAL_EDIT_TEXT_INVALID: "PROPOSAL_EDIT_INVALID",
  PROPOSAL_EDIT_INVALID: "PROPOSAL_EDIT_INVALID",
  PROPOSAL_HASH_INVALID: "PROPOSAL_HASH_INVALID",
  PROPOSAL_PATH_INVALID: "PROPOSAL_PATH_INVALID",
  PROPOSAL_PATH_OUTSIDE_CANDIDATE_UNIVERSE: "PROPOSAL_PATH_OUTSIDE_CANDIDATE_UNIVERSE",
  PROPOSAL_AUTHORITY_VIOLATION: "PROPOSAL_AUTHORITY_VIOLATION",
  PROPOSAL_FORBIDDEN_PATH: "PROPOSAL_FORBIDDEN_PATH",
  PROPOSAL_DUPLICATE_EDIT: "PROPOSAL_DUPLICATE_EDIT",
  PROPOSAL_OVERLAPPING_EDIT: "PROPOSAL_OVERLAPPING_EDIT",
  PROPOSAL_CONFLICT_INVALID: "PROPOSAL_CONFLICT_INVALID",
  PROPOSAL_NO_CHANGE_INVALID: "PROPOSAL_NO_CHANGE_INVALID",
  PROPOSAL_VALID: "PROPOSAL_VALID"
});

const PROPOSAL_FIELDS = Object.freeze(["schemaVersion", "action", "edits", "summary"]);
const EDIT_FIELDS = Object.freeze(["path", "expectedContentHash", "oldText", "newText"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function emptyTelemetry() {
  return {
    editCount: null,
    outsideUniverseCount: 0,
    authorityViolationCount: 0,
    forbiddenPathCount: 0,
    duplicateEditCount: 0,
    overlappingEditCount: 0,
    invalidHashCount: 0,
    invalidPathCount: 0
  };
}

function result(code, telemetry = {}, extra = {}) {
  return Object.freeze({
    proposalValidationFailureCode: code,
    editCount: telemetry.editCount ?? null,
    proposalEditCount: telemetry.editCount ?? null,
    outsideUniverseCount: telemetry.outsideUniverseCount ?? 0,
    authorityViolationCount: telemetry.authorityViolationCount ?? 0,
    forbiddenPathCount: telemetry.forbiddenPathCount ?? 0,
    duplicateEditCount: telemetry.duplicateEditCount ?? 0,
    overlappingEditCount: telemetry.overlappingEditCount ?? 0,
    invalidHashCount: telemetry.invalidHashCount ?? 0,
    invalidPathCount: telemetry.invalidPathCount ?? 0,
    proposalSchemaVersionValid: extra.proposalSchemaVersionValid ?? false,
    proposalAction: extra.proposalAction ?? null,
    proposalSummaryLength: extra.proposalSummaryLength ?? null,
    invalidEditIndex: extra.invalidEditIndex ?? null
  });
}

function snapshotSources(repositorySnapshot) {
  const result = new Map();
  for (const entry of repositorySnapshot?.files ?? []) {
    if (entry && typeof entry.path === "string" && typeof entry.content === "string" && !result.has(entry.path)) {
      result.set(entry.path, entry.content);
    }
  }
  return result;
}

function duplicateEditCount(edits) {
  const seen = new Set();
  let count = 0;
  for (const edit of edits) {
    if (!isPlainObject(edit)) continue;
    const key = JSON.stringify([edit.path, edit.expectedContentHash, edit.oldText, edit.newText]);
    if (seen.has(key)) count += 1;
    else seen.add(key);
  }
  return count;
}

function preflightTelemetry(task, proposal, repositorySnapshot) {
  const telemetry = emptyTelemetry();
  telemetry.editCount = proposal.edits.length;
  const universe = new Set(Array.isArray(task?.candidateFiles) ? task.candidateFiles : []);
  const allowedRules = task?.authority?.allowedChangePaths ?? [];
  const forbiddenRules = task?.authority?.forbiddenInspectionPaths ?? [];
  const sources = snapshotSources(repositorySnapshot);
  const spans = new Map();
  telemetry.duplicateEditCount = duplicateEditCount(proposal.edits);

  for (const edit of proposal.edits) {
    if (!safeRelativePath(edit.path)) telemetry.invalidPathCount += 1;
    if (safeRelativePath(edit.path) && !universe.has(edit.path)) telemetry.outsideUniverseCount += 1;
    const forbidden = safeRelativePath(edit.path) && forbiddenRules.some((rule) => pathMatchesRule(edit.path, rule));
    if (forbidden) telemetry.forbiddenPathCount += 1;
    const allowed = safeRelativePath(edit.path) && allowedRules.some((rule) => pathMatchesRule(edit.path, rule));
    if (!allowed || forbidden) telemetry.authorityViolationCount += 1;
    if (!SHA256.test(edit.expectedContentHash)) telemetry.invalidHashCount += 1;

    const source = sources.get(edit.path);
    if (typeof source !== "string" || typeof edit.oldText !== "string") continue;
    const start = source.indexOf(edit.oldText);
    const unique = start >= 0 && source.indexOf(edit.oldText, start + edit.oldText.length) < 0;
    if (!unique) continue;
    const span = { start, end: start + edit.oldText.length };
    const existing = spans.get(edit.path) ?? [];
    if (existing.some((other) => span.start < other.end && other.start < span.end)) telemetry.overlappingEditCount += 1;
    existing.push(span);
    spans.set(edit.path, existing);
  }
  return { telemetry, sources };
}

function classifyProposalDiagnostic(value, task = null, repositorySnapshot = null) {
  const baseTelemetry = emptyTelemetry();
  if (!sameKeys(value, PROPOSAL_FIELDS)) return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_SHAPE_INVALID, baseTelemetry);
  if (value.schemaVersion !== PROPOSAL_VERSION) {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_SCHEMA_VERSION_INVALID, baseTelemetry);
  }
  const extra = {
    proposalSchemaVersionValid: true,
    proposalAction: typeof value.action === "string" ? value.action : null,
    proposalSummaryLength: typeof value.summary === "string" ? value.summary.length : null,
    invalidEditIndex: null
  };
  if (value.action !== "patch" && value.action !== "no_change") {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_ACTION_INVALID, baseTelemetry, extra);
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0 || value.summary.length > 2000) {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_SUMMARY_INVALID, baseTelemetry, extra);
  }
  if (!Array.isArray(value.edits) || value.edits.length > 32) {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_EDITS_INVALID, baseTelemetry, extra);
  }
  baseTelemetry.editCount = value.edits.length;
  if ((value.action === "no_change" && value.edits.length !== 0) ||
      (value.action === "patch" && value.edits.length === 0)) {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_NO_CHANGE_INVALID, baseTelemetry, extra);
  }
  for (let index = 0; index < value.edits.length; index += 1) {
    const edit = value.edits[index];
    const indexed = { ...extra, invalidEditIndex: index };
    if (!sameKeys(edit, EDIT_FIELDS)) return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_EDIT_INVALID, baseTelemetry, indexed);
    if (!safeRelativePath(edit.path)) {
      baseTelemetry.invalidPathCount += 1;
      return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_PATH_INVALID, baseTelemetry, indexed);
    }
    if (typeof edit.expectedContentHash !== "string" || !SHA256.test(edit.expectedContentHash)) {
      baseTelemetry.invalidHashCount += 1;
      return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_HASH_INVALID, baseTelemetry, indexed);
    }
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string" ||
        edit.oldText.length === 0 || edit.oldText === edit.newText ||
        edit.oldText.includes("\0") || edit.newText.includes("\0")) {
      return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_EDIT_INVALID, baseTelemetry, indexed);
    }
  }
  const normalized = validateProposal(value);
  if (normalized === null) throw new Error("proposal diagnostic drifted from canonical validateProposal");

  if (task === null) return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_VALID, baseTelemetry, extra);
  const { telemetry, sources } = preflightTelemetry(task, normalized, repositorySnapshot);
  if (task.taskClass === "no_change_needed" && normalized.action === "patch") {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_NO_CHANGE_INVALID, telemetry, extra);
  }
  if (task.taskClass !== "no_change_needed" && normalized.action === "no_change") {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_NO_CHANGE_INVALID, telemetry, extra);
  }
  if (telemetry.forbiddenPathCount > 0) return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_FORBIDDEN_PATH, telemetry, extra);
  if (telemetry.authorityViolationCount > 0) return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_AUTHORITY_VIOLATION, telemetry, extra);
  if (telemetry.outsideUniverseCount > 0) return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_PATH_OUTSIDE_CANDIDATE_UNIVERSE, telemetry, extra);
  if (telemetry.duplicateEditCount > 0) return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_DUPLICATE_EDIT, telemetry, extra);
  if (telemetry.overlappingEditCount > 0) return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_OVERLAPPING_EDIT, telemetry, extra);

  if (normalized.action === "patch" && repositorySnapshot !== null) {
    for (const edit of normalized.edits) {
      const source = sources.get(edit.path);
      if (typeof source !== "string") return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_CONFLICT_INVALID, telemetry, extra);
      if (sha256(source) !== edit.expectedContentHash) return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_CONFLICT_INVALID, telemetry, extra);
      const start = source.indexOf(edit.oldText);
      if (start < 0 || source.indexOf(edit.oldText, start + edit.oldText.length) >= 0) {
        return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_CONFLICT_INVALID, telemetry, extra);
      }
    }
  }
  return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_VALID, telemetry, extra);
}

module.exports = {
  PROPOSAL_VALIDATION_FAILURE_CODES,
  classifyProposalDiagnostic,
  preflightTelemetry
};
