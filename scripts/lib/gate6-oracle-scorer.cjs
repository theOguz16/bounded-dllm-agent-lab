"use strict";

const path = require("node:path");
const { validateGate6Oracle } = require("./gate6-oracle.cjs");

const SCORER_VERSION = "gate6-oracle-scorer/v1";
const SELECTION_EVIDENCE_VERSION = "gate6-oracle-selection-evidence/v1";
const SELECTION_EVIDENCE_FIELDS = Object.freeze([
  "schemaVersion",
  "selectedFiles",
  "selectedSymbols",
  "selectedTestFiles",
  "selectedTestAnchors"
]);
const GLOB_META = /[*?\[\]{}!]/;

class Gate6OracleScorerError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6OracleScorerError";
    this.code = code;
  }
}
function fail(code, detail) { throw new Gate6OracleScorerError(code, detail); }
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function sameKeys(value, expected) {
  return isPlainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function assertPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || GLOB_META.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) fail("GATE6_ORACLE_SELECTION_PATH_INVALID", label);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) fail("GATE6_ORACLE_SELECTION_PATH_INVALID", label);
}
function assertUniqueStringArray(value, field, pathValues = false) {
  if (!Array.isArray(value)) fail("GATE6_ORACLE_SELECTION_FIELD_INVALID", field);
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.trim().length === 0) fail("GATE6_ORACLE_SELECTION_FIELD_INVALID", `${field}[${index}]`);
    if (pathValues) assertPath(item, `${field}[${index}]`);
    if (seen.has(item)) fail("GATE6_ORACLE_SELECTION_DUPLICATE", `${field}:${item}`);
    seen.add(item);
  }
}
function normalizeSelectionEvidence(value) {
  if (!sameKeys(value, SELECTION_EVIDENCE_FIELDS)) fail("GATE6_ORACLE_SELECTION_EVIDENCE_INVALID");
  if (value.schemaVersion !== SELECTION_EVIDENCE_VERSION) fail("GATE6_ORACLE_SELECTION_EVIDENCE_SCHEMA_UNSUPPORTED", String(value.schemaVersion));
  assertUniqueStringArray(value.selectedFiles, "selectedFiles", true);
  assertUniqueStringArray(value.selectedSymbols, "selectedSymbols");
  assertUniqueStringArray(value.selectedTestFiles, "selectedTestFiles", true);
  assertUniqueStringArray(value.selectedTestAnchors, "selectedTestAnchors");
  return Object.freeze({
    schemaVersion: SELECTION_EVIDENCE_VERSION,
    selectedFiles: Object.freeze([...value.selectedFiles].sort()),
    selectedSymbols: Object.freeze([...value.selectedSymbols].sort()),
    selectedTestFiles: Object.freeze([...value.selectedTestFiles].sort()),
    selectedTestAnchors: Object.freeze([...value.selectedTestAnchors].sort())
  });
}
function intersectionCount(left, rightSet) {
  let total = 0;
  for (const value of left) if (rightSet.has(value)) total += 1;
  return total;
}
function containsAll(selectedSet, required) { return required.every((value) => selectedSet.has(value)); }
function setEqual(selectedSet, required) { return selectedSet.size === required.length && containsAll(selectedSet, required); }
function scoreGate6SelectionEvidence({ task, oracle, selectionEvidence }) {
  validateGate6Oracle(oracle, task);
  const normalized = normalizeSelectionEvidence(selectionEvidence);
  const selectedFiles = new Set(normalized.selectedFiles);
  const selectedSymbols = new Set(normalized.selectedSymbols);
  const selectedTestFiles = new Set(normalized.selectedTestFiles);
  const selectedTestAnchors = new Set(normalized.selectedTestAnchors);
  const allowedTouched = new Set(oracle.allowedTouchedFiles);
  const forbidden = new Set(oracle.forbiddenFiles);
  const allSelectedFiles = [...selectedFiles, ...selectedTestFiles];
  const fileScopeSuccess = allSelectedFiles.every((filePath) => allowedTouched.has(filePath) && !forbidden.has(filePath));
  const symbolTruePositiveCount = intersectionCount(normalized.selectedSymbols, new Set(oracle.requiredSymbols));
  const symbolPredictedCount = normalized.selectedSymbols.length;
  const symbolRequiredCount = oracle.requiredSymbols.length;
  const exactSymbolSuccess = setEqual(selectedSymbols, oracle.requiredSymbols);
  const criticalImplementationCoveredCount = intersectionCount(oracle.requiredImplementationFiles, selectedFiles);
  const criticalImplementationRequiredCount = oracle.requiredImplementationFiles.length;
  const criticalTestAnchorCoveredCount = intersectionCount(oracle.requiredTestAnchors, selectedTestAnchors);
  const criticalTestAnchorRequiredCount = oracle.requiredTestAnchors.length;
  const strictOracleSuccess =
    fileScopeSuccess &&
    containsAll(selectedFiles, oracle.requiredImplementationFiles) &&
    containsAll(selectedTestFiles, oracle.requiredTestFiles) &&
    exactSymbolSuccess &&
    containsAll(selectedTestAnchors, oracle.requiredTestAnchors);
  return Object.freeze({
    fileScopeSuccess,
    strictOracleSuccess,
    exactSymbolSuccess,
    symbolTruePositiveCount,
    symbolPredictedCount,
    symbolRequiredCount,
    criticalImplementationCoveredCount,
    criticalImplementationRequiredCount,
    criticalTestAnchorCoveredCount,
    criticalTestAnchorRequiredCount
  });
}

module.exports = {
  Gate6OracleScorerError,
  SCORER_VERSION,
  SELECTION_EVIDENCE_FIELDS,
  SELECTION_EVIDENCE_VERSION,
  normalizeSelectionEvidence,
  scoreGate6SelectionEvidence
};