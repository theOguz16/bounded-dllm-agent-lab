"use strict";

const verifier = require("./gate6-verifier-provenance.cjs");
const baseRunner = require("../gate6-live-runner-v3.cjs");
const {
  PROVIDER_FACING_RULE_IDS,
  VALIDATOR_CONTRACT_HASH,
  VALIDATOR_CONTRACT_VERSION
} = require("./gate6-live-validator-contract.cjs");

const PROVIDER_CONTRACT_VERSION = "gate6-live-provider-contract/v1";
const PROVIDER_PROMPT_VERSION = "gate6-live-provider-prompt/v3";

function providerContractRules() {
  return Object.freeze([
    "Return exactly one JSON object and nothing else.",
    "Do not emit markdown fences, prose before or after JSON, comments, analysis, reasoning, result, output, answer, metadata, explanation, or wrapper fields.",
    "Top-level keys MUST be exactly: schemaVersion, selection, proposal.",
    "Use only fields required by outputContract; do not duplicate fields.",
    "Do not repeat repository context.",
    "Keep JSON compact: avoid decorative whitespace, repeated text, copied context, and verbose summaries.",
    "Keep summary concise and factual.",
    "Selection must contain only candidates justified by the public task and resolved context.",
    "candidateFiles means implementation/source files only.",
    "candidateTestFiles means regression/test files only.",
    "candidateFiles and candidateTestFiles MUST be disjoint.",
    "Never place the same path in both arrays.",
    "Do not use candidateFiles as an umbrella list containing every selected file.",
    "If a selected path is a test file, put it only in candidateTestFiles.",
    "If a selected path is an implementation/source file, put it only in candidateFiles.",
    "Both arrays must contain only paths from the public candidate universe.",
    "Do not duplicate entries in any selection array.",
    "Selection file paths must be safe repository-relative paths.",
    "candidateSymbols should identify implementation symbols relevant to candidateFiles.",
    "candidateTestAnchors should identify test anchors relevant to candidateTestFiles.",
    "Use public resolved-context file-kind evidence when deciding whether a path belongs in candidateFiles or candidateTestFiles.",
    "proposal.schemaVersion MUST be gate6-simulated-proposal/v1.",
    "proposal.action MUST be exactly patch or no_change.",
    "proposal.summary MUST be a non-empty string after trimming and MUST be at most 2000 characters.",
    "proposal.edits MUST be an array with at most 32 entries.",
    "For action=patch, proposal.edits MUST contain at least one edit.",
    "For action=no_change, proposal.edits MUST be empty.",
    "Each edit MUST contain exactly path, expectedContentHash, oldText, and newText.",
    "Each edit.path MUST be a safe repository-relative path.",
    "Each edit.path MUST belong to the public candidate universe, MUST match allowedChangePaths, and MUST NOT match forbiddenInspectionPaths.",
    "Each expectedContentHash MUST be the exact sha256:<64 lowercase hex> hash for the public resolved source content being edited.",
    "oldText and newText MUST both be strings; oldText MUST be non-empty; oldText and newText MUST differ; neither may contain a NUL character.",
    "For edits, oldText/newText should contain only the minimal replacement span required for the patch.",
    "Do not emit duplicate edits for the same replacement span.",
    "Edits targeting the same path MUST NOT overlap or conflict.",
    "oldText MUST identify exactly one replacement span in the public resolved source content.",
    "Proposal edits must stay inside the public authority and candidate universe.",
    "Do not invent hidden acceptance criteria or hidden oracle data.",
    "The structuralExample demonstrates shape only; its empty no_change edit list is valid only for action=no_change and MUST NOT override the normative rules above."
  ]);
}

function providerStructuralExample() {
  return Object.freeze({
    schemaVersion: baseRunner.LIVE_MODEL_OUTPUT_VERSION,
    selection: Object.freeze({
      schemaVersion: "gate6-candidate-selection/v1",
      candidateFiles: Object.freeze([]),
      candidateSymbols: Object.freeze([]),
      candidateTestFiles: Object.freeze([]),
      candidateTestAnchors: Object.freeze([])
    }),
    proposal: Object.freeze({
      schemaVersion: "gate6-simulated-proposal/v1",
      action: "no_change",
      edits: Object.freeze([]),
      summary: "No change required."
    })
  });
}

function providerContractDescriptor() {
  return Object.freeze({
    providerContractVersion: PROVIDER_CONTRACT_VERSION,
    providerPromptVersion: PROVIDER_PROMPT_VERSION,
    validatorContractVersion: VALIDATOR_CONTRACT_VERSION,
    validatorContractHash: VALIDATOR_CONTRACT_HASH,
    structuredOutputTransport: Object.freeze({ type: "json_object" }),
    ruleManifest: Object.freeze([...PROVIDER_FACING_RULE_IDS]),
    outputContract: structuredClone(baseRunner.liveOutputJsonSchema().schema),
    rules: providerContractRules(),
    structuralExample: providerStructuralExample()
  });
}

function providerContractHash(descriptor = providerContractDescriptor()) {
  return verifier.hashCanonical(descriptor);
}

const PROVIDER_CONTRACT_HASH = providerContractHash();

module.exports = {
  PROVIDER_CONTRACT_HASH,
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_PROMPT_VERSION,
  providerContractDescriptor,
  providerContractHash,
  providerContractRules,
  providerStructuralExample
};
