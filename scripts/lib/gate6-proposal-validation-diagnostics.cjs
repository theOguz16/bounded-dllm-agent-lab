"use strict";

const { safeRelativePath } = require("./gate6-simulated-workspace.cjs");
const { PROPOSAL_VERSION, validateProposal } = require("./gate6-simulated-coding-harness.cjs");

const PROPOSAL_VALIDATION_FAILURE_CODES = Object.freeze({
  PROPOSAL_VALID: "PROPOSAL_VALID",
  PROPOSAL_SHAPE_INVALID: "PROPOSAL_SHAPE_INVALID",
  PROPOSAL_SCHEMA_VERSION_INVALID: "PROPOSAL_SCHEMA_VERSION_INVALID",
  PROPOSAL_ACTION_INVALID: "PROPOSAL_ACTION_INVALID",
  PROPOSAL_SUMMARY_INVALID: "PROPOSAL_SUMMARY_INVALID",
  PROPOSAL_EDITS_INVALID: "PROPOSAL_EDITS_INVALID",
  PROPOSAL_ACTION_EDITS_MISMATCH: "PROPOSAL_ACTION_EDITS_MISMATCH",
  PROPOSAL_EDIT_SHAPE_INVALID: "PROPOSAL_EDIT_SHAPE_INVALID",
  PROPOSAL_EDIT_PATH_INVALID: "PROPOSAL_EDIT_PATH_INVALID",
  PROPOSAL_EDIT_HASH_INVALID: "PROPOSAL_EDIT_HASH_INVALID",
  PROPOSAL_EDIT_TEXT_INVALID: "PROPOSAL_EDIT_TEXT_INVALID"
});

const PROPOSAL_FIELDS = Object.freeze(["schemaVersion", "action", "edits", "summary"]);
const EDIT_FIELDS = Object.freeze(["path", "expectedContentHash", "oldText", "newText"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function result(code, extra = {}) {
  return Object.freeze({
    proposalValidationFailureCode: code,
    proposalSchemaVersionValid: extra.proposalSchemaVersionValid ?? false,
    proposalAction: extra.proposalAction ?? null,
    proposalEditCount: extra.proposalEditCount ?? null,
    proposalSummaryLength: extra.proposalSummaryLength ?? null,
    invalidEditIndex: extra.invalidEditIndex ?? null
  });
}

function classifyProposalDiagnostic(value) {
  if (!sameKeys(value, PROPOSAL_FIELDS)) return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_SHAPE_INVALID);
  if (value.schemaVersion !== PROPOSAL_VERSION) {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_SCHEMA_VERSION_INVALID);
  }
  const common = {
    proposalSchemaVersionValid: true,
    proposalAction: typeof value.action === "string" ? value.action : null,
    proposalEditCount: Array.isArray(value.edits) ? value.edits.length : null,
    proposalSummaryLength: typeof value.summary === "string" ? value.summary.length : null
  };
  if (value.action !== "patch" && value.action !== "no_change") {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_ACTION_INVALID, common);
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0 || value.summary.length > 2000) {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_SUMMARY_INVALID, common);
  }
  if (!Array.isArray(value.edits) || value.edits.length > 32) {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_EDITS_INVALID, common);
  }
  if ((value.action === "no_change" && value.edits.length !== 0) ||
      (value.action === "patch" && value.edits.length === 0)) {
    return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_ACTION_EDITS_MISMATCH, common);
  }
  for (let index = 0; index < value.edits.length; index += 1) {
    const edit = value.edits[index];
    if (!sameKeys(edit, EDIT_FIELDS)) {
      return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_EDIT_SHAPE_INVALID, { ...common, invalidEditIndex: index });
    }
    if (!safeRelativePath(edit.path)) {
      return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_EDIT_PATH_INVALID, { ...common, invalidEditIndex: index });
    }
    if (typeof edit.expectedContentHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(edit.expectedContentHash)) {
      return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_EDIT_HASH_INVALID, { ...common, invalidEditIndex: index });
    }
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string" ||
        edit.oldText.length === 0 || edit.oldText === edit.newText ||
        edit.oldText.includes("\0") || edit.newText.includes("\0")) {
      return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_EDIT_TEXT_INVALID, { ...common, invalidEditIndex: index });
    }
  }
  if (validateProposal(value) === null) {
    throw new Error("proposal diagnostic drifted from canonical validateProposal");
  }
  return result(PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_VALID, common);
}

module.exports = {
  PROPOSAL_VALIDATION_FAILURE_CODES,
  classifyProposalDiagnostic
};
