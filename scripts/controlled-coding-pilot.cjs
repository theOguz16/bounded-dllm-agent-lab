#!/usr/bin/env node
"use strict";

const {
  DEFINITION,
  V1_RUNTIME_BUDGET,
  V2_DEFINITION,
  V2_TARGETS,
  V2_RUNTIME_BUDGET,
  validateDefinition
} = require("./controlled-pilot/definition.cjs");
const {
  hash,
  patchLines,
  deriveExecutorMutationLineBudget,
  enforceSemanticPatchLimit
} = require("./controlled-pilot/context.cjs");
const {
  executorModelIdForProvider,
  liveProviderConfiguration,
  pilotProviderClientConfiguration
} = require("./controlled-pilot/provider.cjs");
const {
  TARGET,
  PILOT_MAX_INSERTION_LINES,
  boundedTextEditInstruction,
  boundedTextEditOutputSchema,
  materializeBoundedTextEdits,
  controlledInsertionInstruction,
  controlledInsertionOutputSchema,
  materializeControlledInsertion,
  renderControlledHelpInsertion,
  resolveControlledInsertionAuthority,
  validateRenderedInsertion
} = require("./controlled-pilot/text-edits.cjs");
const { REPORT_VERSION, reportBase } = require("./controlled-pilot/evidence.cjs");
const { classifyVerifierFailure } = require("./controlled-pilot/verification.cjs");
const { runControlledCodingPilot } = require("./controlled-pilot/runner.cjs");

const PILOT_MODEL_CONTEXT_TOKEN_LIMIT = V1_RUNTIME_BUDGET.modelContextTokenLimit;
const PILOT_EXECUTION_RUNTIME_MS = V1_RUNTIME_BUDGET.executionRuntimeMs;
const PILOT_EXECUTOR_OUTPUT_TOKEN_LIMIT = V1_RUNTIME_BUDGET.executorOutputTokenLimit;
const PILOT_PROVIDER_TIMEOUT_MS = V1_RUNTIME_BUDGET.providerTimeoutMs;
const PILOT_PROVIDER_MAX_OUTPUT_TOKENS = V1_RUNTIME_BUDGET.providerMaxOutputTokens;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

module.exports = {
  DEFINITION,
  PILOT_EXECUTION_RUNTIME_MS,
  PILOT_EXECUTOR_OUTPUT_TOKEN_LIMIT,
  PILOT_MAX_INSERTION_LINES,
  PILOT_MODEL_CONTEXT_TOKEN_LIMIT,
  PILOT_PROVIDER_MAX_OUTPUT_TOKENS,
  PILOT_PROVIDER_TIMEOUT_MS,
  REPORT_VERSION,
  TARGET,
  V2_DEFINITION,
  V2_TARGETS,
  V1_RUNTIME_BUDGET,
  V2_RUNTIME_BUDGET,
  hash,
  patchLines,
  boundedTextEditInstruction,
  boundedTextEditOutputSchema,
  materializeBoundedTextEdits,
  controlledInsertionInstruction,
  controlledInsertionOutputSchema,
  enforceSemanticPatchLimit,
  executorModelIdForProvider,
  classifyVerifierFailure,
  deriveExecutorMutationLineBudget,
  materializeControlledInsertion,
  liveProviderConfiguration,
  pilotProviderClientConfiguration,
  renderControlledHelpInsertion,
  resolveControlledInsertionAuthority,
  runControlledCodingPilot,
  validateRenderedInsertion,
  validateDefinition
};

if (require.main === module) {
  runControlledCodingPilot({
    sourceRoot: process.cwd(),
    output: argument("--output"),
    definitionPath: argument("--definition"),
    executeProvider: process.argv.includes("--execute-provider"),
    confirmLive: process.argv.includes("--confirm-live")
  }).then((report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status === "failed" || report.status === "cancelled") process.exitCode = 1;
  }).catch(() => {
    process.stdout.write(`${JSON.stringify(reportBase({
      status: "failed", failureCode: "PILOT_PROVIDER_CALL_FAILED", cleanupCompleted: false
    }))}\n`);
    process.exitCode = 1;
  });
}
