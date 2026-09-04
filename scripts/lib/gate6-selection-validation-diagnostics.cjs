"use strict";

const path = require("node:path");
const {
  CANDIDATE_SELECTION_VERSION,
  validateCandidateSelection
} = require("./gate6-context-escalation.cjs");

const SELECTION_FIELDS = Object.freeze([
  "schemaVersion",
  "candidateFiles",
  "candidateSymbols",
  "candidateTestFiles",
  "candidateTestAnchors"
]);

const SELECTION_VALIDATION_FAILURE_CODES = Object.freeze({
  SELECTION_SHAPE_INVALID: "SELECTION_SHAPE_INVALID",
  SELECTION_SCHEMA_VERSION_INVALID: "SELECTION_SCHEMA_VERSION_INVALID",
  CANDIDATE_FILES_INVALID: "CANDIDATE_FILES_INVALID",
  CANDIDATE_SYMBOLS_INVALID: "CANDIDATE_SYMBOLS_INVALID",
  CANDIDATE_TEST_FILES_INVALID: "CANDIDATE_TEST_FILES_INVALID",
  CANDIDATE_TEST_ANCHORS_INVALID: "CANDIDATE_TEST_ANCHORS_INVALID",
  CANDIDATE_FILE_OUTSIDE_UNIVERSE: "CANDIDATE_FILE_OUTSIDE_UNIVERSE",
  CANDIDATE_TEST_FILE_OUTSIDE_UNIVERSE: "CANDIDATE_TEST_FILE_OUTSIDE_UNIVERSE",
  IMPLEMENTATION_TEST_FILE_OVERLAP: "IMPLEMENTATION_TEST_FILE_OVERLAP",
  SELECTION_VALIDATOR_REJECTED_UNCLASSIFIED: "SELECTION_VALIDATOR_REJECTED_UNCLASSIFIED",
  SELECTION_VALID: "SELECTION_VALID"
});

const SELECTION_VALIDATION_FAILURE_DETAIL_CODES = Object.freeze({
  NON_ARRAY: "NON_ARRAY",
  TOO_MANY_ITEMS: "TOO_MANY_ITEMS",
  EMPTY_OR_INVALID_STRING: "EMPTY_OR_INVALID_STRING",
  DUPLICATE: "DUPLICATE",
  INVALID_PATH: "INVALID_PATH",
  OUTSIDE_CANDIDATE_UNIVERSE: "OUTSIDE_CANDIDATE_UNIVERSE"
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function validString(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value.length <= 512;
}

// Mirrors path syntax checks from the canonical validator for diagnosis only.
// Acceptance remains owned exclusively by validateCandidateSelection().
function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) return false;
  const segments = value.split("/");
  return !segments.some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

function observedSelectionKeys(value) {
  return Object.freeze(isPlainObject(value) ? Object.keys(value).sort() : []);
}

function arrayCount(value) {
  return Array.isArray(value) ? value.length : null;
}

function duplicateCount(value) {
  if (!Array.isArray(value)) return 0;
  const seen = new Set();
  let count = 0;
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (seen.has(item)) count += 1;
    else seen.add(item);
  }
  return count;
}

function outsideUniverseCount(value, universe) {
  if (!Array.isArray(value)) return 0;
  let count = 0;
  for (const item of value) {
    if (validString(item) && safeRelativePath(item) && !universe.has(item)) count += 1;
  }
  return count;
}

function implementationTestOverlapCount(selection) {
  if (!Array.isArray(selection?.candidateFiles) || !Array.isArray(selection?.candidateTestFiles)) return 0;
  const implementations = new Set(selection.candidateFiles.filter((item) => typeof item === "string"));
  const overlaps = new Set();
  for (const item of selection.candidateTestFiles) {
    if (typeof item === "string" && implementations.has(item)) overlaps.add(item);
  }
  return overlaps.size;
}

function safeSelectionSummary(selection, task) {
  const universe = new Set(Array.isArray(task?.candidateFiles) ? task.candidateFiles : []);
  return Object.freeze({
    observedSelectionKeys: observedSelectionKeys(selection),
    selectionSchemaVersionValid: isPlainObject(selection) && selection.schemaVersion === CANDIDATE_SELECTION_VERSION,
    candidateFileCount: arrayCount(selection?.candidateFiles),
    candidateSymbolCount: arrayCount(selection?.candidateSymbols),
    candidateTestFileCount: arrayCount(selection?.candidateTestFiles),
    candidateTestAnchorCount: arrayCount(selection?.candidateTestAnchors),
    outsideUniverseCount:
      outsideUniverseCount(selection?.candidateFiles, universe) +
      outsideUniverseCount(selection?.candidateTestFiles, universe),
    duplicateCount:
      duplicateCount(selection?.candidateFiles) +
      duplicateCount(selection?.candidateSymbols) +
      duplicateCount(selection?.candidateTestFiles) +
      duplicateCount(selection?.candidateTestAnchors),
    implementationTestOverlapCount: implementationTestOverlapCount(selection)
  });
}

function invalid(code, detailCode, summary) {
  return Object.freeze({
    ...summary,
    selectionValidationFailureCode: code,
    selectionValidationFailureDetailCode: detailCode
  });
}

function classifyArray(value, {
  maxItems,
  pathLike = false,
  universe = null,
  invalidCode,
  outsideUniverseCode = null
}) {
  if (!Array.isArray(value)) {
    return { code: invalidCode, detailCode: SELECTION_VALIDATION_FAILURE_DETAIL_CODES.NON_ARRAY };
  }
  if (value.length > maxItems) {
    return { code: invalidCode, detailCode: SELECTION_VALIDATION_FAILURE_DETAIL_CODES.TOO_MANY_ITEMS };
  }
  const seen = new Set();
  for (const item of value) {
    if (!validString(item)) {
      return { code: invalidCode, detailCode: SELECTION_VALIDATION_FAILURE_DETAIL_CODES.EMPTY_OR_INVALID_STRING };
    }
    if (pathLike && !safeRelativePath(item)) {
      return { code: invalidCode, detailCode: SELECTION_VALIDATION_FAILURE_DETAIL_CODES.INVALID_PATH };
    }
    if (universe !== null && !universe.has(item)) {
      return {
        code: outsideUniverseCode ?? invalidCode,
        detailCode: SELECTION_VALIDATION_FAILURE_DETAIL_CODES.OUTSIDE_CANDIDATE_UNIVERSE
      };
    }
    if (seen.has(item)) {
      return { code: invalidCode, detailCode: SELECTION_VALIDATION_FAILURE_DETAIL_CODES.DUPLICATE };
    }
    seen.add(item);
  }
  return null;
}

function classifyCandidateSelectionDiagnostic(selection, task) {
  const summary = safeSelectionSummary(selection, task);
  const normativeAccepted = validateCandidateSelection(selection, task) !== null;
  if (normativeAccepted) {
    return Object.freeze({
      ...summary,
      selectionValidationFailureCode: SELECTION_VALIDATION_FAILURE_CODES.SELECTION_VALID,
      selectionValidationFailureDetailCode: null
    });
  }

  if (!sameKeys(selection, SELECTION_FIELDS)) {
    return invalid(SELECTION_VALIDATION_FAILURE_CODES.SELECTION_SHAPE_INVALID, null, summary);
  }
  if (selection.schemaVersion !== CANDIDATE_SELECTION_VERSION) {
    return invalid(SELECTION_VALIDATION_FAILURE_CODES.SELECTION_SCHEMA_VERSION_INVALID, null, summary);
  }

  const universe = new Set(task.candidateFiles);
  const checks = [
    classifyArray(selection.candidateFiles, {
      maxItems: 32,
      pathLike: true,
      universe,
      invalidCode: SELECTION_VALIDATION_FAILURE_CODES.CANDIDATE_FILES_INVALID,
      outsideUniverseCode: SELECTION_VALIDATION_FAILURE_CODES.CANDIDATE_FILE_OUTSIDE_UNIVERSE
    }),
    classifyArray(selection.candidateSymbols, {
      maxItems: 64,
      invalidCode: SELECTION_VALIDATION_FAILURE_CODES.CANDIDATE_SYMBOLS_INVALID
    }),
    classifyArray(selection.candidateTestFiles, {
      maxItems: 32,
      pathLike: true,
      universe,
      invalidCode: SELECTION_VALIDATION_FAILURE_CODES.CANDIDATE_TEST_FILES_INVALID,
      outsideUniverseCode: SELECTION_VALIDATION_FAILURE_CODES.CANDIDATE_TEST_FILE_OUTSIDE_UNIVERSE
    }),
    classifyArray(selection.candidateTestAnchors, {
      maxItems: 64,
      invalidCode: SELECTION_VALIDATION_FAILURE_CODES.CANDIDATE_TEST_ANCHORS_INVALID
    })
  ];
  for (const check of checks) {
    if (check !== null) return invalid(check.code, check.detailCode, summary);
  }

  if (summary.implementationTestOverlapCount > 0) {
    return invalid(SELECTION_VALIDATION_FAILURE_CODES.IMPLEMENTATION_TEST_FILE_OVERLAP, null, summary);
  }

  // A future canonical rule must never be silently classified as valid. This
  // fallback preserves the VALID iff normative-accepts invariant without
  // changing or relaxing the canonical validator.
  return invalid(SELECTION_VALIDATION_FAILURE_CODES.SELECTION_VALIDATOR_REJECTED_UNCLASSIFIED, null, summary);
}

module.exports = {
  SELECTION_VALIDATION_FAILURE_CODES,
  SELECTION_VALIDATION_FAILURE_DETAIL_CODES,
  classifyCandidateSelectionDiagnostic,
  observedSelectionKeys,
  safeSelectionSummary
};
