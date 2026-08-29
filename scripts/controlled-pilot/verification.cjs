"use strict";

const { runVerificationProfile } = require("../controlled-coding-pilot-verification.cjs");
const { VERIFICATION_STAGES } = require("./profiles.cjs");
const { invalidDefinition } = require("./definition.cjs");

const FAILURE_CODES = new Set([
  "PILOT_DEFINITION_INVALID", "PILOT_CONFIRMATION_REQUIRED",
  "PILOT_PROVIDER_CONFIGURATION_MISSING", "PILOT_PROVIDER_CALL_FAILED",
  "PILOT_MODEL_RESPONSE_INVALID", "PILOT_AUTHORITY_VIOLATION",
  "PILOT_PATCH_LIMIT_EXCEEDED", "PILOT_VERIFICATION_FAILED",
  "PILOT_ARTIFACT_INVALID", "PILOT_SOURCE_WORKTREE_MUTATED",
  "PILOT_CLEANUP_FAILED", "PILOT_CANCELLED"
]);
const VERIFIER_STAGES = new Set(VERIFICATION_STAGES);

function classifyVerifierFailure(stage, error) {
  if (FAILURE_CODES.has(error?.pilotCode)) return error;
  if (!VERIFIER_STAGES.has(stage)) invalidDefinition();
  const verifierExitCode = Number.isSafeInteger(error?.code) ? error.code : null;
  const verifierCode = ["ETIMEDOUT", "ABORT_ERR"].includes(error?.code)
    ? "COMMAND_TIMEOUT" : "COMMAND_FAILED";
  return Object.assign(new Error("PILOT_VERIFICATION_FAILED"), {
    pilotCode: "PILOT_VERIFICATION_FAILED",
    verifierDiagnostic: { verifierStage: stage, verifierExitCode, verifierCode }
  });
}

function mapFailure(error) {
  if (FAILURE_CODES.has(error?.pilotCode)) return error.pilotCode;
  const code = error?.code ?? error?.message ?? "";
  if (String(code).includes("ABORT")) return "PILOT_CANCELLED";
  if (String(code).includes("AUTHORITY") || String(code).includes("FORBIDDEN") ||
      String(code).includes("UNAUTHORIZED")) return "PILOT_AUTHORITY_VIOLATION";
  if (String(code).includes("BUDGET")) return "PILOT_PATCH_LIMIT_EXCEEDED";
  if (String(code).includes("OUTPUT") || String(code).includes("RESPONSE") ||
      String(code).includes("JSON")) return "PILOT_MODEL_RESPONSE_INVALID";
  if (String(code).includes("VERIFICATION") || String(code).includes("ARTIFACT_UNAVAILABLE")) {
    return "PILOT_VERIFICATION_FAILED";
  }
  if (String(code).includes("ARTIFACT")) return "PILOT_ARTIFACT_INVALID";
  return "PILOT_PROVIDER_CALL_FAILED";
}

module.exports = {
  FAILURE_CODES,
  classifyVerifierFailure,
  mapFailure,
  runVerificationProfile
};
